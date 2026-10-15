import { Router, type Request, type Response } from "express";
import { query } from "../db/pool";
import { requireAuth } from "../auth/middleware";
import {
  AI_KINDS,
  cancelRun,
  emit,
  failRun,
  finishRun,
  getActiveRunForUser,
  getRun,
  startRun,
  subscribe,
} from "./runs";
import {
  fetchModels,
  loadModel,
  unloadModel,
  type LlmModel,
} from "./llm";
import {
  runGenerate,
  runSummarize,
  runLoreSuggest,
  runImageDesc,
  runStyleExtract,
} from "./actions";
import { applySuggestion } from "./suggestions";

export const aiRouter = Router();

aiRouter.use(requireAuth);

// ---- SSE stream (T4.3): re-subscribable, replays then live ----
aiRouter.get("/api/ai/runs/:id/stream", async (req: Request, res: Response, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const run = getRun(id);
    if (!run || run.userId !== req.user!.id) {
      res.status(404).send("run not found");
      return;
    }
    res.status(200);
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders?.();

    const write = (ev: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(keepalive);
      unsubscribe();
      res.end();
    };
    const unsubscribe = subscribe(run, write);
    const keepalive = setInterval(() => res.write(": keepalive\n\n"), 15_000);
    // close the stream as soon as the run reaches a terminal state
    (run.status === "running" ? run.finished : Promise.resolve()).then(finish);
    req.on("close", () => {
      clearInterval(keepalive);
      unsubscribe();
      finished = true;
    });
  } catch (err) {
    next(err);
  }
});

// ---- emergency stop (FR-6): cancel the user's running AI action ----
// Aborts the in-flight llama.cpp HTTP stream; the action handler's
// chatStream rejects and failsRun records "cancelled by user".
aiRouter.post("/api/ai/runs/:id/cancel", async (req: Request, res: Response, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const run = getRun(id);
    if (!run || run.userId !== req.user!.id) {
      res.status(404).json({ error: "run not found" });
      return;
    }
    if (run.status !== "running") {
      res.status(409).json({ error: "run is not running" });
      return;
    }
    cancelRun(run);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---- badge poll (frontend doc §2, 5s) ----
/**
 * Resolve the target of an active run to something displayable (the badge
 * must say *which* story is being written, not just "AI working…").
 */
async function describeTarget(
  run: { userId: number; kind: string; target: Record<string, unknown> },
): Promise<string> {
  if (
    run.kind === "generate" ||
    run.kind === "summarize" ||
    run.kind === "lore_suggest" ||
    run.kind === "style_extract"
  ) {
    const storyId = Number(run.target.story_id);
    if (Number.isInteger(storyId) && storyId > 0) {
      const { rows } = await query<{ title: string }>(
        `SELECT title FROM story WHERE id = $1 AND user_id = $2`,
        [storyId, run.userId],
      );
      if (rows.length > 0) return rows[0].title;
    }
  }
  if (run.kind === "image_desc") {
    const imageId = Number(run.target.image_id);
    if (Number.isInteger(imageId) && imageId > 0) {
      const { rows } = await query<{ title: string | null }>(
        `SELECT e.title FROM image i LEFT JOIN lore_entry e ON e.id = i.lore_entry_id
         WHERE i.id = $1 AND i.user_id = $2`,
        [imageId, run.userId],
      );
      if (rows.length > 0 && rows[0].title) return `image · ${rows[0].title}`;
      if (rows.length > 0) return "image";
    }
  }
  return "";
}

// The last RUN for a story (any status) — the story page's failed-run
// banner reads this (round 5 fix, 2026-10-14): the earlier sessionStorage
// banner only appeared if the page that started the run was still open
// when the run ENDED — the user had navigated away, so "no banner at
// all". DB-backed, the failure is reported on the next visit; starting a
// newer run (success or not) replaces "the last run", so the banner never
// lingers over a fresh run.
aiRouter.get("/api/ai/last-run", async (req: Request, res: Response, next) => {
  try {
    const storyId = Number(req.query.story_id);
    if (!Number.isInteger(storyId)) return res.status(400).json({ error: "story_id is required" });
    const { rows } = await query<{
      id: number;
      kind: string;
      status: string;
      error: string | null;
      ended_at: string;
    }>(
      `SELECT id, kind, status, error, ended_at
       FROM ai_run
       WHERE user_id = $1 AND target_jsonb->>'story_id' = $2
       ORDER BY id DESC LIMIT 1`,
      [req.user!.id, String(storyId)],
    );
    res.json({ run: rows[0] ?? null });
  } catch (err) {
    next(err);
  }
});

aiRouter.get("/api/ai/current", async (req: Request, res: Response, next) => {
  try {
    const run = getActiveRunForUser(req.user!.id);
    // The user's most recent run of ANY status (persisted in ai_run). The
    // AI Monitor's "Active action" card uses it to show the OUTCOME once a
    // run finishes (run goes null → the card used to snap back to "idle"
    // and hide the stream, so success/failure was invisible) — and it
    // survives a page reload (change request 2026-10-15).
    const { rows: lastRows } = await query<{
      id: number;
      kind: string;
      status: string;
      error: string | null;
      started_at: Date;
      ended_at: Date | null;
      target_jsonb: Record<string, unknown>;
    }>(
      `SELECT id, kind, status, error, started_at, ended_at, target_jsonb
       FROM ai_run WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
      [req.user!.id],
    );
    const last = lastRows[0]
      ? {
          id: lastRows[0].id,
          kind: lastRows[0].kind,
          status: lastRows[0].status,
          error: lastRows[0].error,
          started_at: lastRows[0].started_at,
          ended_at: lastRows[0].ended_at,
          title: await describeTarget({
            userId: req.user!.id,
            kind: lastRows[0].kind,
            target: lastRows[0].target_jsonb ?? {},
          }),
        }
      : null;
    if (!run) {
      res.json({ run: null, last });
      return;
    }
    const lastDelta = [...run.events].reverse().find((e) => e.type === "delta");
    res.json({
      run: {
        id: run.id,
        kind: run.kind,
        target: run.target,
        title: await describeTarget(run),
        started_at: run.startedAt,
        last_delta: lastDelta?.text,
      },
      last,
    });
  } catch (err) {
    next(err);
  }
});

// ---- AI actions: POST /api/ai/<kind> → { run } ----

async function beginAction(
  req: Request,
  res: Response,
  kind: (typeof AI_KINDS)[number],
  target: Record<string, unknown>,
): Promise<void> {
  const run = await startRun(req.user!.id, kind, target);
  // fire the action; the handler streams deltas and finishes the run
  const fn =
    kind === "generate" ? runGenerate
    : kind === "summarize" ? runSummarize
    : kind === "lore_suggest" ? runLoreSuggest
    : kind === "style_extract" ? runStyleExtract
    : runImageDesc;
  fn(run).catch(async (err) => {
    await failRun(run, err instanceof Error ? err.message : String(err));
  });
  res.status(202).json({ run: { id: run.id, kind: run.kind } });
}

// word-count hint (FR-2): a type hint injected into the generate system
// prompt. Whitelisted — the client can only ever send one of these labels.
const WORD_HINTS = new Set([
  "under 1000 words",
  "1000-3000 words",
  "3000-6000 words",
  "6000-9000 words",
  "9000+ words",
]);

aiRouter.post("/api/ai/generate", async (req, res, next) => {
  try {
    const storyId = Number(req.body?.story_id);
    if (!Number.isInteger(storyId)) return res.status(400).json({ error: "story_id is required" });
    const target: Record<string, unknown> = { story_id: storyId };
    // optional: regenerate an existing draft chapter in place
    if (req.body?.chapter_seq != null) {
      const chapterSeq = Number(req.body.chapter_seq);
      if (!Number.isInteger(chapterSeq) || chapterSeq <= 0) {
        return res.status(400).json({ error: "chapter_seq must be a positive integer" });
      }
      target.chapter_seq = chapterSeq;
    }
    if (req.body?.word_hint != null && req.body?.word_hint !== "") {
      const hint = String(req.body.word_hint);
      if (!WORD_HINTS.has(hint)) {
        return res.status(400).json({ error: "word_hint must be one of the provided ranges" });
      }
      target.word_hint = hint;
    }
    // optional writing style ("skill", FR round 2): id of one of the user's
    // style_prompt rows; runGenerate appends its text to the system prompt
    if (req.body?.style_id != null && req.body?.style_id !== "") {
      const styleId = Number(req.body.style_id);
      if (!Number.isInteger(styleId) || !(await getUserStyle(req.user!.id, styleId))) {
        return res.status(400).json({ error: "style_id is not one of your style prompts" });
      }
      target.style_id = styleId;
    }
    beginAction(req, res, "generate", target).catch(next);
  } catch (err) {
    next(err);
  }
});

aiRouter.post("/api/ai/summarize", (req, res, next) => {
  const storyId = Number(req.body?.story_id);
  if (!Number.isInteger(storyId)) return res.status(400).json({ error: "story_id is required" });
  beginAction(req, res, "summarize", { story_id: storyId }).catch(next);
});

aiRouter.post("/api/ai/lore-suggest", (req, res, next) => {
  const storyId = Number(req.body?.story_id);
  if (!Number.isInteger(storyId)) return res.status(400).json({ error: "story_id is required" });
  beginAction(req, res, "lore_suggest", { story_id: storyId }).catch(next);
});

aiRouter.post("/api/ai/image-desc", (req, res, next) => {
  const imageId = Number(req.body?.image_id);
  if (!Number.isInteger(imageId)) return res.status(400).json({ error: "image_id is required" });
  beginAction(req, res, "image_desc", { image_id: imageId }).catch(next);
});

// "Extract style" (change request 2026-10-13): AI reads the story's last
// few chapters and streams a description of the author's writing style;
// the result is auto-saved as a style prompt ("skill") and the story page
// offers to rename or delete it.
aiRouter.post("/api/ai/style-extract", (req, res, next) => {
  const storyId = Number(req.body?.story_id);
  if (!Number.isInteger(storyId)) return res.status(400).json({ error: "story_id is required" });
  beginAction(req, res, "style_extract", { story_id: storyId }).catch(next);
});

// ---- lore suggestion apply (T4.8): adds apply; deletes only via confirm ----
aiRouter.post("/api/ai/lore-suggest/apply", async (req: Request, res: Response, next) => {
  try {
    const result = await applySuggestion(req.user!.id, req.body ?? {});
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---- model management (T4.2) ----
aiRouter.get("/api/model", async (_req: Request, res: Response, next) => {
  try {
    const { reachable, models } = await fetchModels();
    const loaded = models.find((m) => m.status === "loaded");
    res.json({
      reachable,
      models,
      loaded: loaded ? { id: loaded.id, multimodal: loaded.multimodal, ctx: loaded.ctx } : null,
    });
  } catch (err) {
    next(err);
  }
});

aiRouter.post("/api/model/load", async (req: Request, res: Response, next) => {
  try {
    const model = String(req.body?.model ?? "");
    if (!model) {
      res.status(400).json({ error: "model is required" });
      return;
    }
    // loading is slow — return immediately, UI polls /api/model
    loadModel(model).catch(() => {});
    res.json({ ok: true, loading: model });
  } catch (err) {
    next(err);
  }
});

aiRouter.post("/api/model/unload", async (req: Request, res: Response, next) => {
  try {
    const model = String(req.body?.model ?? "");
    if (!model) {
      res.status(400).json({ error: "model is required" });
      return;
    }
    unloadModel(model).catch(() => {});
    res.json({ ok: true, unloading: model });
  } catch (err) {
    next(err);
  }
});

// ---- system prompts (T4.4) ----
aiRouter.get("/api/prompts", async (req: Request, res: Response, next) => {
  try {
    const { seedPromptsForUser } = await import("../db/prompts");
    await seedPromptsForUser(req.user!.id); // idempotent ON CONFLICT DO NOTHING
    const { rows: prompts } = await query<{ action: string; text_md: string }>(
      `SELECT action, text_md FROM system_prompt WHERE user_id = $1 ORDER BY action`,
      [req.user!.id],
    );
    res.json({ prompts });
  } catch (err) {
    next(err);
  }
});

aiRouter.post("/api/prompts", async (req: Request, res: Response, next) => {
  try {
    const action = String(req.body?.action ?? "");
    const text_md = String(req.body?.text_md ?? "");
    // validate against ALL prompt actions (AI_ACTIONS, which includes
    // generate_this — a prompt that has no direct POST /api/ai/<kind> route)
    const { AI_ACTIONS } = await import("../db/prompts");
    if (!(AI_ACTIONS as readonly string[]).includes(action)) {
      res.status(400).json({ error: `action must be one of ${AI_ACTIONS.join(", ")}` });
      return;
    }
    if (!text_md.trim()) {
      res.status(400).json({ error: "text_md is required" });
      return;
    }
    await query(
      `INSERT INTO system_prompt (user_id, action, text_md) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, action) DO UPDATE SET text_md = $3`,
      [req.user!.id, action, text_md],
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---- style prompts ("skills", FR round 2, 2026-10-09) ----
// User-defined writing styles: multiple per user, managed here, picked
// per generate run from the story page and appended to the generate
// system prompt. NOT a system prompt (those are one-per-action) — a
// separate, freely-addable set.

aiRouter.get("/api/style-prompts", async (req: Request, res: Response, next) => {
  try {
    const { rows } = await query<{ id: number; name: string; text_md: string }>(
      `SELECT id, name, text_md FROM style_prompt WHERE user_id = $1 ORDER BY lower(name)`,
      [req.user!.id],
    );
    res.json({ styles: rows });
  } catch (err) {
    next(err);
  }
});

// GET/POST /api/style-prompts/:id — :id=0 creates; else save (name/text)
aiRouter.post("/api/style-prompts/:id", async (req: Request, res: Response, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const name = String(req.body?.name ?? "").trim();
    const text_md = String(req.body?.text_md ?? "");
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (!text_md.trim()) {
      res.status(400).json({ error: "text_md is required" });
      return;
    }
    if (id === 0) {
      try {
        const { rows } = await query<{ id: number }>(
          `INSERT INTO style_prompt (user_id, name, text_md) VALUES ($1, $2, $3) RETURNING id`,
          [req.user!.id, name, text_md],
        );
        res.status(201).json({ id: rows[0].id });
      } catch (e) {
        if (e instanceof Error && e.message.includes("duplicate key value")) {
          res.status(409).json({ error: `a style named "${name}" already exists` });
          return;
        }
        throw e;
      }
      return;
    }
    const { rows: existing } = await query<{ id: number }>(
      `SELECT id FROM style_prompt WHERE id = $1 AND user_id = $2`,
      [id, req.user!.id],
    );
    if (existing.length === 0) {
      res.status(404).json({ error: "style not found" });
      return;
    }
    try {
      await query(
        `UPDATE style_prompt SET name = $1, text_md = $2, updated_at = now() WHERE id = $3`,
        [name, text_md, id],
      );
    } catch (e) {
      if (e instanceof Error && e.message.includes("duplicate key value")) {
        res.status(409).json({ error: `a style named "${name}" already exists` });
        return;
      }
      throw e;
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

aiRouter.post("/api/style-prompts/:id/delete", async (req: Request, res: Response, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const { rows } = await query<{ id: number }>(
      `DELETE FROM style_prompt WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, req.user!.id],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "style not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Fetch one of the user's styles by id, or null. */
async function getUserStyle(userId: number, id: number) {
  const { rows } = await query<{ id: number; name: string; text_md: string }>(
    `SELECT id, name, text_md FROM style_prompt WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0] ?? null;
}

// ---- AI Monitor page (frontend doc §3.4) ----
aiRouter.get("/ai", async (req: Request, res: Response, next) => {
  try {
    const { reachable, models } = await fetchModels();
    const active = getActiveRunForUser(req.user!.id) ?? null;
    const { seedPromptsForUser } = await import("../db/prompts");
    await seedPromptsForUser(req.user!.id); // idempotent — all actions present
    const { rows: prompts } = await query<{ action: string; text_md: string }>(
      `SELECT action, text_md FROM system_prompt WHERE user_id = $1 ORDER BY action`,
      [req.user!.id],
    );
    const loadedModel = models.find((m) => m.status === "loaded")?.id ?? null;
    // style prompts ("skills") — managed on this page, picked per run
    const { rows: styles } = await query<{ id: number; name: string; text_md: string }>(
      `SELECT id, name, text_md FROM style_prompt WHERE user_id = $1 ORDER BY lower(name)`,
      [req.user!.id],
    );
    res.render("ai_monitor", {
      activeNav: "ai",
      reachable,
      models: models as LlmModel[],
      loadedId: loadedModel,
      active,
      prompts,
      promptsJson: JSON.stringify(prompts),
      promptAction: prompts[0]?.action ?? "generate",
      promptText: prompts[0]?.text_md ?? "",
      styles,
    });
  } catch (err) {
    next(err);
  }
});
