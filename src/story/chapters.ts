import { Router, type Request, type Response } from "express";
import { query } from "../db/pool";
import { requireAuth } from "../auth/middleware";
import { getOwnedChapter, getOwnedStory, listChaptersForStory } from "./story";

export const chapterRouter = Router();

chapterRouter.use(requireAuth);

// GET /api/stories/:id/chapters — the chapter list (FR-4: after saving, the
// story page refreshes just this list instead of reloading the whole page,
// so the open chapter pane — and "Generate this chapter" — stay in place)
chapterRouter.get("/api/stories/:id/chapters", async (req: Request, res: Response, next) => {
  try {
    const storyId = Number.parseInt(req.params.id, 10);
    if (!(await getOwnedStory(storyId, req.user!.id))) {
      res.status(404).json({ error: "story not found" });
      return;
    }
    res.json({ chapters: await listChaptersForStory(storyId) });
  } catch (err) {
    next(err);
  }
});

// GET/POST /api/stories/:id/chapters/:n — :n = seq (1-based)
chapterRouter.get("/api/stories/:id/chapters/:n", async (req: Request, res: Response, next) => {
  try {
    const storyId = Number.parseInt(req.params.id, 10);
    const seq = Number.parseInt(req.params.n, 10);
    if (!(await getOwnedStory(storyId, req.user!.id))) {
      res.status(404).json({ error: "story not found" });
      return;
    }
    const ch = await getOwnedChapter(storyId, seq, req.user!.id);
    if (!ch) {
      res.status(404).json({ error: "chapter not found" });
      return;
    }
    res.json(ch);
  } catch (err) {
    next(err);
  }
});

chapterRouter.post("/api/stories/:id/chapters/:n", async (req: Request, res: Response, next) => {
  try {
    const storyId = Number.parseInt(req.params.id, 10);
    const seq = Number.parseInt(req.params.n, 10);
    const story = await getOwnedStory(storyId, req.user!.id);
    if (!story) {
      res.status(404).json({ error: "story not found" });
      return;
    }
    const title = String(req.body?.title ?? "").trim();
    const body_md = String(req.body?.body_md ?? "");
    if (!title) {
      res.status(400).json({ error: "title is required" });
      return;
    }
    const existing = await getOwnedChapter(storyId, seq, req.user!.id);
    if (existing) {
      await query(
        `UPDATE chapter SET title = $1, body_md = $2, updated_at = now() WHERE id = $3`,
        [title, body_md, existing.id],
      );
      res.json({ id: existing.id, seq });
      return;
    }
    // new: seq must be either max+1 (append) or not already taken
    const { rows } = await query<{ seq: number }>(
      `SELECT max(seq)::int AS seq FROM chapter WHERE story_id = $1`,
      [storyId],
    );
    const nextSeq = (rows[0]?.seq ?? 0) + 1;
    if (seq !== nextSeq && seq !== 0) {
      res.status(409).json({ error: `seq must be ${nextSeq} (next) — got ${seq}` });
      return;
    }
    const { rows: inserted } = await query<{ id: number }>(
      `INSERT INTO chapter (story_id, seq, title, body_md) VALUES ($1, $2, $3, $4) RETURNING id`,
      [storyId, nextSeq, title, body_md],
    );
    res.status(201).json({ id: inserted[0].id, seq: nextSeq });
  } catch (err) {
    next(err);
  }
});

// POST /api/stories/:id/chapters/:n/delete
chapterRouter.post("/api/stories/:id/chapters/:n/delete", async (req: Request, res: Response, next) => {
  try {
    const storyId = Number.parseInt(req.params.id, 10);
    const seq = Number.parseInt(req.params.n, 10);
    const story = await getOwnedStory(storyId, req.user!.id);
    if (!story) {
      res.status(404).json({ error: "story not found" });
      return;
    }
    const ch = await getOwnedChapter(storyId, seq, req.user!.id);
    if (!ch) {
      res.status(404).json({ error: "chapter not found" });
      return;
    }
    if (ch.status === "final") {
      res.status(409).json({ error: "cannot delete a finalized chapter" });
      return;
    }
    await query(`DELETE FROM chapter WHERE id = $1`, [ch.id]);
    // renumber to keep seq contiguous
    await query(
      `UPDATE chapter c SET seq = x.new_seq FROM (
         SELECT id, row_number() OVER (ORDER BY seq) AS new_seq
         FROM chapter WHERE story_id = $1
       ) x WHERE c.id = x.id AND c.story_id = $1`,
      [storyId],
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/stories/:id/chapters/:n/finalize — chapter → final (FR-24)
chapterRouter.post("/api/stories/:id/chapters/:n/finalize", async (req: Request, res: Response, next) => {
  try {
    const storyId = Number.parseInt(req.params.id, 10);
    const seq = Number.parseInt(req.params.n, 10);
    const story = await getOwnedStory(storyId, req.user!.id);
    if (!story) {
      res.status(404).json({ error: "story not found" });
      return;
    }
    const ch = await getOwnedChapter(storyId, seq, req.user!.id);
    if (!ch) {
      res.status(404).json({ error: "chapter not found" });
      return;
    }
    await query(`UPDATE chapter SET status = 'final', updated_at = now() WHERE id = $1`, [ch.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/stories/:id/preview-chapter — render the chapter currently in
// the editing pane (unsaved text from the form) as Shelf-style reading HTML
// (FR-3). Ownership: any chapter of the user's own story (or none yet for
// an unsaved new chapter).
chapterRouter.post("/api/stories/:id/preview-chapter", async (req: Request, res: Response, next) => {
  try {
    const storyId = Number.parseInt(req.params.id, 10);
    const story = await getOwnedStory(storyId, req.user!.id);
    if (!story) {
      res.status(404).json({ error: "story not found" });
      return;
    }
    const title = String(req.body?.title ?? "").trim();
    const body_md = String(req.body?.body_md ?? "");
    if (!title) {
      res.status(400).json({ error: "title is required" });
      return;
    }
    const { renderMarkdown } = await import("../markdown");
    res.json({
      title,
      html: renderMarkdown(body_md),
      word_count: (body_md.match(/\S+/g) ?? []).length,
    });
  } catch (err) {
    next(err);
  }
});
