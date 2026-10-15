import { Router, type Request, type Response } from "express";
import { query } from "../db/pool";
import { requireAuth } from "../auth/middleware";

export const shelfRouter = Router();

shelfRouter.use(requireAuth);

// GET /api/shelf — finalized stories of the user
shelfRouter.get("/api/shelf", async (req: Request, res: Response, next) => {
  try {
    const { rows } = await query<{ id: number; title: string; chapter_count: number; updated_at: Date }>(
      `SELECT s.id, s.title,
              (SELECT count(*)::int FROM chapter c WHERE c.story_id = s.id) AS chapter_count,
              s.updated_at
       FROM story s
       WHERE s.user_id = $1 AND s.status = 'finalized'
       ORDER BY s.updated_at DESC`,
      [req.user!.id],
    );
    res.json({ stories: rows });
  } catch (err) {
    next(err);
  }
});

// GET /shelf — grid of finalized stories (frontend doc §3.5)
shelfRouter.get("/shelf", async (req: Request, res: Response, next) => {
  try {
    const { rows } = await query<{ id: number; title: string; chapter_count: number }>(
      `SELECT s.id, s.title,
              (SELECT count(*)::int FROM chapter c WHERE c.story_id = s.id) AS chapter_count
       FROM story s
       WHERE s.user_id = $1 AND s.status = 'finalized'
       ORDER BY s.updated_at DESC`,
      [req.user!.id],
    );
    res.render("shelf", { activeNav: "shelf", stories: rows, message: req.query.message });
  } catch (err) {
    next(err);
  }
});

// GET /shelf/:id — read-only reader; chapter body rendered markdown→HTML server-side
shelfRouter.get("/shelf/:id", async (req: Request, res: Response, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const { rows: storyRows } = await query<{
      id: number; title: string; status: string; universe_name: string | null;
    }>(
      `SELECT s.id, s.title, s.status, u.name AS universe_name
       FROM story s LEFT JOIN universe u ON u.id = s.universe_id
       WHERE s.id = $1 AND s.user_id = $2`,
      [id, req.user!.id],
    );
    const story = storyRows[0];
    if (!story || story.status !== "finalized") {
      res.status(404).send("not found");
      return;
    }
    const { rows: chapters } = await query<{ seq: number; title: string; body_md: string }>(
      `SELECT seq, title, body_md FROM chapter WHERE story_id = $1 ORDER BY seq`,
      [id],
    );
    const selectedSeq = req.query.chapter ? Number.parseInt(String(req.query.chapter), 10) : chapters[0]?.seq ?? 0;
    const selected = chapters.find((c) => c.seq === selectedSeq) ?? chapters[0] ?? null;
    // prev/next chapter navigation (FR-5): the chapter next to the selected
    // one in seq order (null at the ends of the story)
    let prev = null;
    let next = null;
    if (selected) {
      const i = chapters.findIndex((c) => c.seq === selected.seq);
      prev = chapters[i - 1] ?? null;
      next = chapters[i + 1] ?? null;
    }
    const { renderMarkdown } = await import("../markdown");
    res.render("shelf_reader", {
      activeNav: "shelf",
      story,
      chapters,
      selected,
      selectedHtml: selected ? renderMarkdown(selected.body_md) : "",
      selectedSeq: selected?.seq ?? null,
      prevSeq: prev ? prev.seq : null,
      prevTitle: prev ? prev.title : null,
      nextSeq: next ? next.seq : null,
      nextTitle: next ? next.title : null,
    });
  } catch (err) {
    next(err);
  }
});
