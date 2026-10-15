import { Router, type Request, type Response } from "express";
import { query } from "../db/pool";
import { requireAuth } from "../auth/middleware";
import { isUniverseMember, selectOptionsForUser } from "../lore/ownership";

export const loreRouter = Router();

loreRouter.use(requireAuth);

// ---- pages (frontend doc §3.2) ----

// /lore → universe list (same as Universe page list; Lore focuses on entries)
loreRouter.get("/lore", async (req: Request, res: Response, next) => {
  try {
    const universes = await (await import("../lore/ownership")).listUniversesForUser(req.user!.id);
    // stories for the "AI lore suggestion (from a story)" panel (FR-15:
    // reachable from the Lore page too)
    const { rows: stories } = await query<{ id: number; title: string }>(
      `SELECT id, title FROM story WHERE user_id = $1 AND status = 'draft'
       ORDER BY updated_at DESC LIMIT 50`,
      [req.user!.id],
    );
    res.render("lore", {
      activeNav: "lore",
      universes,
      // the template iterates `stories` to render the <select> options
      // (a previous revision only passed the JSON-serialized copy, so the
      // dropdown rendered empty)
      stories,
      message: req.query.message,
      error: req.query.error,
    });
  } catch (err) {
    next(err);
  }
});

// /lore/universe/:id → entry list for that universe
// (?category=<id> filters the list to one user-defined category)
loreRouter.get("/lore/universe/:id", async (req: Request, res: Response, next) => {
  try {
    const uid = Number.parseInt(req.params.id, 10);
    if (!(await isUniverseMember(uid, req.user!.id))) {
      res.status(404).send("not found");
      return;
    }
    const { rows: uni } = await query<{ id: number; name: string; description: string | null }>(
      `SELECT id, name, description FROM universe WHERE id = $1`,
      [uid],
    );
    // active category filter (ignore ids that don't belong to this universe)
    const catFilter = Number.parseInt(String(req.query.category ?? ""), 10);
    let activeCatId: number | null = null;
    if (Number.isInteger(catFilter) && catFilter > 0) {
      const { rows: chk } = await query<{ id: number }>(
        `SELECT id FROM lore_category WHERE id = $1 AND universe_id = $2`,
        [catFilter, uid],
      );
      if (chk.length > 0) activeCatId = catFilter;
    }
    const { rows: entries } = await query<{
      id: number;
      title: string;
      word_count: number;
      image_count: number;
    }>(
      `SELECT e.id, e.title,
              (select count(*)::int from image i where i.lore_entry_id = e.id) as image_count,
              case when trim(e.body_md) = '' then 0
                   else (select count(*)::int from regexp_matches(e.body_md, '\\S+')) end as word_count
       FROM lore_entry e
       WHERE e.universe_id = $1
         AND ($2::int IS NULL OR e.id IN (SELECT lore_entry_id FROM lore_entry_category WHERE category_id = $2))
       ORDER BY lower(e.title)`,
      [uid, activeCatId],
    );
    const categories = await listCategories(uid, req.user!.id);
    // thumbnails (frontend doc §3.2: title, word count, image thumbnails)
    const ids = entries.map((e) => e.id);
    const { rows: thumbs } = ids.length
      ? await query<{ lore_entry_id: number; filename: string }>(
          `SELECT lore_entry_id, filename FROM image WHERE lore_entry_id = ANY($1) ORDER BY id`,
          [ids],
        )
      : { rows: [] as { lore_entry_id: number; filename: string }[] };
    const thumbsByEntry = new Map<number, string[]>();
    for (const t of thumbs) {
      const arr = thumbsByEntry.get(t.lore_entry_id) ?? [];
      arr.push(t.filename);
      thumbsByEntry.set(t.lore_entry_id, arr);
    }
    const entriesWithThumbs = entries.map((e) => ({
      ...e,
      thumbnails: (thumbsByEntry.get(e.id) ?? []).slice(0, 4),
    }));
    res.render("lore_universe", {
      activeNav: "lore",
      universe: uni[0],
      entries: entriesWithThumbs,
      categories,
      activeCategoryId: activeCatId,
      message: req.query.message,
    });
  } catch (err) {
    next(err);
  }
});

/** Categories of a universe the user manages, with entry counts. */
async function listCategories(
  universeId: number,
  userId: number,
): Promise<{ id: number; name: string; entry_count: number }[]> {
  if (!(await isUniverseMember(universeId, userId))) return [];
  const { rows } = await query<{ id: number; name: string; entry_count: number }>(
    `SELECT c.id, c.name, count(lc.lore_entry_id)::int AS entry_count
     FROM lore_category c
     LEFT JOIN lore_entry_category lc ON lc.category_id = c.id
     WHERE c.universe_id = $1
     GROUP BY c.id
     ORDER BY lower(c.name)`,
    [universeId],
  );
  return rows;
}

/** The entry's category ids (for the editor's checkboxes). */
async function entryCategoryIds(entryId: number): Promise<number[]> {
  const { rows } = await query<{ category_id: number }>(
    `SELECT category_id FROM lore_entry_category WHERE lore_entry_id = $1 ORDER BY category_id`,
    [entryId],
  );
  return rows.map((r) => r.category_id);
}

/**
 * Replace an entry's category links. `categoryIds` must be a (possibly empty)
 * array; every id must exist in the entry's universe. Returns an error string
 * or null on success.
 */
async function setEntryCategories(
  entryId: number,
  universeId: number,
  categoryIds: unknown,
): Promise<string | null> {
  if (categoryIds === undefined) return null; // field absent → don't touch
  if (!Array.isArray(categoryIds)) return "category_ids must be an array";
  const ids = [...new Set(categoryIds.map((v) => Number(v)).filter(Number.isInteger))];
  if (ids.length > 0) {
    const { rows } = await query<{ id: number }>(
      `SELECT id FROM lore_category WHERE id = ANY($1) AND universe_id = $2`,
      [ids, universeId],
    );
    const valid = new Set(rows.map((r) => r.id));
    if (ids.some((id) => !valid.has(id))) {
      return "category not found in this universe";
    }
  }
  await query(`DELETE FROM lore_entry_category WHERE lore_entry_id = $1`, [entryId]);
  for (const id of ids) {
    await query(`INSERT INTO lore_entry_category (lore_entry_id, category_id) VALUES ($1, $2)`, [
      entryId,
      id,
    ]);
  }
  return null;
}

// /lore/universe/:id/new → empty entry editor
loreRouter.get("/lore/universe/:id/new", async (req: Request, res: Response, next) => {
  try {
    const uid = Number.parseInt(req.params.id, 10);
    if (!(await isUniverseMember(uid, req.user!.id))) {
      res.status(404).send("not found");
      return;
    }
    const { rows: uni } = await query<{ id: number; name: string }>(
      `SELECT id, name FROM universe WHERE id = $1`,
      [uid],
    );
    if (uni.length === 0) {
      res.status(404).send("not found");
      return;
    }
    const universes = await selectOptionsForUser(req.user!.id);
    const categories = await listCategories(uid, req.user!.id);
    res.render("lore_entry", {
      activeNav: "lore",
      entry: null,
      universeId: uid,
      universeName: uni[0].name,
      universes,
      categories,
      entryCategoryIds: [],
      images: [],
      message: req.query.message,
    });
  } catch (err) {
    next(err);
  }
});

// /lore/entry/:id → entry editor
loreRouter.get("/lore/entry/:id", async (req: Request, res: Response, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const entry = await getOwnedEntry(id, req.user!.id);
    if (!entry) {
      res.status(404).send("not found");
      return;
    }
    const universes = await selectOptionsForUser(req.user!.id);
    const categories = await listCategories(entry.universe_id, req.user!.id);
    const entryCats = await entryCategoryIds(id);
    const { rows: images } = await query<{ id: number; filename: string }>(
      `SELECT id, filename FROM image WHERE lore_entry_id = $1 ORDER BY id`,
      [id],
    );
    res.render("lore_entry", {
      activeNav: "lore",
      entry,
      universeId: entry.universe_id,
      universeName: entry.universe_name,
      universes,
      categories,
      entryCategoryIds: entryCats,
      images,
      message: req.query.message,
      error: req.query.error,
    });
  } catch (err) {
    next(err);
  }
});

// ---- API ----

// GET /api/lore/search?q=&limit= — live lore search for the outline
// editor's `/keyword` autocomplete (CR round 3, 2026-10-11). Over entries
// in universes the user can access: FTS prefix match (title weighted over
// body) with a substring fallback, so `/star` finds "Star Destroyer" and
// `/venge` still finds it mid-word. Empty q = browse (top entries by
// title). Pure SQL — no AI.
loreRouter.get("/api/lore/search", async (req: Request, res: Response, next) => {
  try {
    const q = String(req.query.q ?? "").trim().slice(0, 80);
    const rawLimit = Number.parseInt(String(req.query.limit ?? "8"), 10);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 8, 1), 20);

    // FTS leg: one prefix token per whitespace word, reduced to [a-z0-9]
    // (injection-proof for to_tsquery) + `*` so partial words match. The
    // `simple` config keeps words intact (no stemming — private LAN,
    // predictable matches).
    const tokens = q
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.replace(/[^a-z0-9]/g, ""))
      .filter(Boolean);
    const tsquery: string | null = tokens.length ? tokens.map((t) => `${t}*`).join(" & ") : null;
    // substring leg: escape ILIKE wildcards in the raw query
    const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;

    const { rows } = await query<{
      id: number;
      title: string;
      universe_id: number;
      universe: string;
      body_md: string;
      rank: number;
    }>(
      `SELECT e.id, e.title, e.universe_id, u.name AS universe, e.body_md,
              CASE WHEN $2::tsquery IS NULL THEN 0
                   ELSE ts_rank_cd(
                          setweight(to_tsvector('simple', e.title), 'A')
                            || setweight(to_tsvector('simple', e.body_md), 'B'),
                          $2::tsquery)
              END AS rank
       FROM lore_entry e
       JOIN universe u ON u.id = e.universe_id
       JOIN universe_user uu ON uu.universe_id = u.id
       WHERE uu.user_id = $1
         AND (
               $2::tsquery IS NULL
               OR (setweight(to_tsvector('simple', e.title), 'A')
                   || setweight(to_tsvector('simple', e.body_md), 'B')) @@ $2::tsquery
               OR e.title ILIKE $3 ESCAPE '\\'
               OR e.body_md ILIKE $3 ESCAPE '\\'
             )
       ORDER BY rank DESC,
                (e.title ILIKE $3 ESCAPE '\\') DESC,
                lower(e.title)
       LIMIT $4`,
      [req.user!.id, tsquery, like, limit],
    );

    res.json({
      q,
      results: rows.map((r) => ({
        id: r.id,
        title: r.title,
        universe: r.universe,
        universe_id: r.universe_id,
        snippet: snippetOf(r.body_md, q),
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** One-line preview of a lore body for the autocomplete dropdown. */
function snippetOf(body: string, q: string): string {
  const flat = (body ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const idx = q ? flat.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (idx < 0) return flat.slice(0, 120) + (flat.length > 120 ? "…" : "");
  const start = Math.max(0, idx - 30);
  const end = Math.min(flat.length, idx + q.length + 90);
  return (start > 0 ? "…" : "") + flat.slice(start, end) + (end < flat.length ? "…" : "");
}

// GET /api/entries/:id — entry detail (doc API table: GET/POST /api/entries/:id)
loreRouter.get("/api/entries/:id", async (req: Request, res: Response, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const entry = await getOwnedEntry(id, req.user!.id);
    if (!entry) {
      res.status(404).json({ error: "entry not found" });
      return;
    }
    const { rows: images } = await query<{ id: number; filename: string; created_at: string }>(
      `SELECT id, filename, created_at FROM image WHERE lore_entry_id = $1 ORDER BY created_at`,
      [id],
    );
    const { rows: categories } = await query<{ id: number; name: string }>(
      `SELECT c.id, c.name FROM lore_category c
       JOIN lore_entry_category lc ON lc.category_id = c.id
       WHERE lc.lore_entry_id = $1
       ORDER BY lower(c.name)`,
      [id],
    );
    res.json({
      id: entry.id,
      title: entry.title,
      body_md: entry.body_md,
      universe_id: entry.universe_id,
      universe: entry.universe_name,
      created_at: entry.created_at,
      updated_at: entry.updated_at,
      images,
      categories,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/entries/:id — :id=0 creates; else save. body: {title, body_md, universe_id, move_to?}
loreRouter.post("/api/entries/:id", async (req: Request, res: Response, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const title = String(req.body?.title ?? "").trim();
    const body_md = String(req.body?.body_md ?? "");
    if (!title) {
      res.status(400).json({ error: "title is required" });
      return;
    }
    let universeId: number;
    if (id === 0) {
      universeId = Number.parseInt(String(req.body?.universe_id), 10);
      if (!Number.isInteger(universeId) || !(await isUniverseMember(universeId, req.user!.id))) {
        res.status(404).json({ error: "universe not found" });
        return;
      }
      const { rows } = await query<{ id: number }>(
        `INSERT INTO lore_entry (title, body_md, universe_id) VALUES ($1, $2, $3) RETURNING id`,
        [title, body_md, universeId],
      );
      const newId = rows[0].id;
      const catErr = await setEntryCategories(newId, universeId, req.body?.category_ids);
      if (catErr) {
        // roll the half-created entry back so a bad category list leaves no row
        await query(`DELETE FROM lore_entry WHERE id = $1`, [newId]);
        res.status(400).json({ error: catErr });
        return;
      }
      res.status(201).json({ id: newId });
      return;
    }
    // save existing
    const existing = await getOwnedEntry(id, req.user!.id);
    if (!existing) {
      res.status(404).json({ error: "entry not found" });
      return;
    }
    universeId = existing.universe_id;
    if (req.body?.move_to) {
      const moveId = Number.parseInt(String(req.body.move_to), 10);
      if (!Number.isInteger(moveId) || !(await isUniverseMember(moveId, req.user!.id))) {
        res.status(404).json({ error: "target universe not found" });
        return;
      }
      universeId = moveId;
    }
    await query(
      `UPDATE lore_entry SET title = $1, body_md = $2, universe_id = $3, updated_at = now() WHERE id = $4`,
      [title, body_md, universeId, id],
    );
    // if the entry moved universes: detach category links that belong to a
    // different universe (categories are universe-scoped)
    await query(
      `DELETE FROM lore_entry_category
       WHERE lore_entry_id = $1
         AND category_id NOT IN (SELECT id FROM lore_category WHERE universe_id = $2)`,
      [id, universeId],
    );
    // explicit category list from the editor → replace the links
    if (req.body?.category_ids !== undefined) {
      const catErr = await setEntryCategories(id, universeId, req.body.category_ids);
      if (catErr) {
        res.status(400).json({ error: catErr });
        return;
      }
    }
    res.json({ id });
  } catch (err) {
    next(err);
  }
});

// POST /api/entries/:id/delete
loreRouter.post("/api/entries/:id/delete", async (req: Request, res: Response, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const existing = await getOwnedEntry(id, req.user!.id);
    if (!existing) {
      res.status(404).json({ error: "entry not found" });
      return;
    }
    await query(`DELETE FROM lore_entry WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---- user-defined categories (FR round 2, 2026-10-09) ----

// POST /api/lore-categories {universe_id, name} → create (409 on duplicate)
loreRouter.post("/api/lore-categories", async (req: Request, res: Response, next) => {
  try {
    const universeId = Number.parseInt(String(req.body?.universe_id), 10);
    const name = String(req.body?.name ?? "").trim();
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (!Number.isInteger(universeId) || !(await isUniverseMember(universeId, req.user!.id))) {
      res.status(404).json({ error: "universe not found" });
      return;
    }
    try {
      const { rows } = await query<{ id: number }>(
        `INSERT INTO lore_category (universe_id, name) VALUES ($1, $2) RETURNING id`,
        [universeId, name],
      );
      res.status(201).json({ id: rows[0].id });
    } catch (e) {
      if (e instanceof Error && e.message.includes('duplicate key value')) {
        res.status(409).json({ error: `a category named "${name}" already exists` });
        return;
      }
      throw e;
    }
  } catch (err) {
    next(err);
  }
});

// POST /api/lore-categories/:id/delete → delete (attached entries are
// detached, never deleted)
loreRouter.post("/api/lore-categories/:id/delete", async (req: Request, res: Response, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const { rows: cat } = await query<{ id: number; universe_id: number; entry_count: number }>(
      `SELECT c.id, c.universe_id, count(lc.lore_entry_id)::int AS entry_count
       FROM lore_category c
       LEFT JOIN lore_entry_category lc ON lc.category_id = c.id
       WHERE c.id = $1
       GROUP BY c.id`,
      [id],
    );
    const row = cat[0];
    if (!row || !(await isUniverseMember(row.universe_id, req.user!.id))) {
      res.status(404).json({ error: "category not found" });
      return;
    }
    await query(`DELETE FROM lore_category WHERE id = $1`, [id]);
    res.json({ ok: true, detached: row.entry_count });
  } catch (err) {
    next(err);
  }
});

/** Fetch an entry the user's universe can manage; returns entry + universe. */
async function getOwnedEntry(id: number, userId: number) {
  const { rows } = await query<{
    id: number;
    title: string;
    body_md: string;
    universe_id: number;
    universe_name: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT e.id, e.title, e.body_md, e.universe_id, u.name AS universe_name,
            e.created_at, e.updated_at
     FROM lore_entry e
     JOIN universe u ON u.id = e.universe_id
     WHERE e.id = $1`,
    [id],
  );
  const entry = rows[0];
  if (!entry) return null;
  if (!(await isUniverseMember(entry.universe_id, userId))) return null;
  return entry;
}
