import { Router, type Request, type Response } from "express";
import { query } from "../db/pool";
import { requireAuth } from "../auth/middleware";
import { selectOptionsForUser } from "../lore/ownership";
import { verifyOutline } from "./verify";
import { listChaptersForStory, getOwnedStory } from "./story";
import { getUserSettings } from "../settings/settings";

export const storyRouter = Router();

storyRouter.use(requireAuth);

// ---- pages (frontend doc §3.1) ----

// /story → list of the user's stories
storyRouter.get("/story", async (req: Request, res: Response, next) => {
  try {
    const { rows: stories } = await query<{
      id: number;
      title: string;
      status: string;
      updated_at: Date;
      universe_name: string | null;
      chapter_count: number;
    }>(
      `SELECT s.id, s.title, s.status, s.updated_at, u.name AS universe_name,
              (SELECT count(*)::int FROM chapter c WHERE c.story_id = s.id) AS chapter_count
       FROM story s
       LEFT JOIN universe u ON u.id = s.universe_id
       WHERE s.user_id = $1
       ORDER BY s.updated_at DESC`,
      [req.user!.id],
    );
    const universes = await selectOptionsForUser(req.user!.id);
    res.render("story", {
      activeNav: "story",
      stories,
      universes,
      message: req.query.message,
    });
  } catch (err) {
    next(err);
  }
});

// /story/:id → main work area
storyRouter.get("/story/:id", async (req: Request, res: Response, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const story = await getOwnedStory(id, req.user!.id);
    if (!story) {
      res.status(404).send("not found");
      return;
    }
    const universes = await selectOptionsForUser(req.user!.id);
    const chapters = await listChaptersForStory(story.id);
    const borrowed = await verifyOutline(story, req.user!.id);
    // the user's writing-style prompts ("skills") for the generate dropdown
    const { rows: styles } = await query<{ id: number; name: string }>(
      `SELECT id, name FROM style_prompt WHERE user_id = $1 ORDER BY lower(name)`,
      [req.user!.id],
    );
    // summarize hint (change request 2026-10-13, FR-23a): nudge the author
    // toward summaries once a story accumulates unsummarized chapters —
    // the summaries ARE the AI's memory. User-toggleable in the page's
    // Settings (per-user setting, threshold default 3).
    const settings = await getUserSettings(req.user!.id);
    const hintEnabled = settings.summarize_hint !== "off";
    const hintThreshold = Math.min(20, Math.max(1, Number(settings.summarize_hint_chapters) || 3));
    const unsummarized = chapters.filter((c) => !c.has_summary).length;
    const summarizeHint =
      hintEnabled && unsummarized >= hintThreshold ? { count: unsummarized } : null;
    res.render("story_detail", {
      activeNav: "story",
      story,
      universes,
      chapters,
      borrowed,
      borrowedJson: JSON.stringify(borrowed),
      styles,
      summarizeHint,
      summarizeHintEnabled: hintEnabled,
      summarizeHintCount: hintThreshold,
      storyTitleJson: JSON.stringify(story.title),
      message: req.query.message,
      error: req.query.error,
    });
  } catch (err) {
    next(err);
  }
});

// ---- API (backend doc §3) ----

// GET/POST /api/stories/:id — :id=0 creates
storyRouter.post("/api/stories/:id", async (req: Request, res: Response, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (id === 0) {
      const title = String(req.body?.title ?? "").trim();
      if (!title) {
        res.status(400).json({ error: "title is required" });
        return;
      }
      const universeId = req.body?.universe_id ? Number.parseInt(String(req.body.universe_id), 10) : null;
      if (universeId !== null &&
          (!Number.isInteger(universeId) || !(await ownedUniverseExists(universeId, req.user!.id)))) {
        res.status(404).json({ error: "universe not found" });
        return;
      }
      const { rows } = await query<{ id: number }>(
        `INSERT INTO story (title, outline_md, user_id, universe_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [title, String(req.body?.outline_md ?? ""), req.user!.id, universeId],
      );
      res.status(201).json({ id: rows[0].id });
      return;
    }
    // save existing
    const story = await getOwnedStory(id, req.user!.id);
    if (!story) {
      res.status(404).json({ error: "story not found" });
      return;
    }
    const title = req.body?.title != null ? String(req.body.title).trim() : story.title;
    if (!title) {
      res.status(400).json({ error: "title is required" });
      return;
    }
    const outline_md = req.body?.outline_md != null ? String(req.body.outline_md) : story.outline_md;
    const universeId = req.body?.universe_id !== undefined
      ? (req.body.universe_id ? Number.parseInt(String(req.body.universe_id), 10) : null)
      : story.universe_id;
    if (universeId !== null &&
        (!Number.isInteger(universeId) || !(await ownedUniverseExists(universeId, req.user!.id)))) {
      res.status(404).json({ error: "universe not found" });
      return;
    }
    await query(
      `UPDATE story SET title = $1, outline_md = $2, universe_id = $3, updated_at = now() WHERE id = $4`,
      [title, outline_md, universeId, id],
    );
    res.json({ id });
  } catch (err) {
    next(err);
  }
});

// POST /api/stories/:id/delete
storyRouter.post("/api/stories/:id/delete", async (req: Request, res: Response, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const story = await getOwnedStory(id, req.user!.id);
    if (!story) {
      res.status(404).json({ error: "story not found" });
      return;
    }
    await query(`DELETE FROM story WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/stories/:id/verify — pure string match, no AI (FR-21a)
storyRouter.post("/api/stories/:id/verify", async (req: Request, res: Response, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const story = await getOwnedStory(id, req.user!.id);
    if (!story) {
      res.status(404).json({ error: "story not found" });
      return;
    }
    const results = await verifyOutline(story, req.user!.id);
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

// POST /api/stories/:id/finalize — all chapters final, story finalized (FR-24)
storyRouter.post("/api/stories/:id/finalize", async (req: Request, res: Response, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const story = await getOwnedStory(id, req.user!.id);
    if (!story) {
      res.status(404).json({ error: "story not found" });
      return;
    }
    const { rows: chs } = await query(
      `UPDATE chapter SET status = 'final' WHERE story_id = $1 RETURNING id`,
      [id],
    );
    await query(`UPDATE story SET status = 'finalized', updated_at = now() WHERE id = $1`, [id]);
    res.json({ ok: true, chapters: chs.length });
  } catch (err) {
    next(err);
  }
});

async function ownedUniverseExists(universeId: number, userId: number): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM universe u JOIN universe_user uu ON uu.universe_id = u.id
     WHERE u.id = $1 AND uu.user_id = $2`,
    [universeId, userId],
  );
  return rows.length > 0;
}
