import fs from "node:fs";
import path from "node:path";
import { query } from "../db/pool";
import { withTransaction } from "../db/pool";
import { getConfig } from "../app";
import { chatStream, EMPTY_ANSWER_HINT, fetchModels, type ChatMessage } from "./llm";
import { emit, failRun, finishRun, type Run } from "./runs";
import { parseStructured } from "./parse";
import { verifyOutline } from "../story/verify";
import { getOwnedStory, listChaptersForStory } from "../story/story";
import { seedPromptsForUser } from "../db/prompts";

/**
 * AI actions (backend doc §4). Each handler:
 *   (1) assembles the prompt, (2) calls the streaming endpoint,
 *   (3) forwards deltas to the SSE stream, (4) persists the result.
 * The local model is slow (NFR-02) — everything streams; silence while a
 * stream is alive is not a hang.
 *
 * Every chatStream call gets `run.abort.signal` — the AI Monitor's red Stop
 * button (FR-6) aborts it and the error below fails the run.
 */

export const SECTION_OPEN = "<<<SECTION:";
export const SECTION_CLOSE = "<<<END:";

function section(name: string, body: string): string {
  return `${SECTION_OPEN}${name}>>>\n${body}\n${SECTION_CLOSE}${name}>>>`;
}

// forward the model's thinking tokens (llama.cpp reasoning_content) to the
// SSE stream so the UI can show "the model is thinking" (FR-7). Thinking
// only exists when the llama.cpp server is run with reasoning extraction
// (e.g. --reasoning-format deepseek); otherwise these callbacks never fire.
function thinkingOf(run: Run) {
  return (t: string) => emit(run, { type: "thought", text: t });
}

async function getSystemPrompt(userId: number, action: string): Promise<string> {
  await seedPromptsForUser(userId);
  const { rows } = await query<{ text_md: string }>(
    `SELECT text_md FROM system_prompt WHERE user_id = $1 AND action = $2`,
    [userId, action],
  );
  return rows[0]?.text_md ?? "";
}

interface LoadedModel {
  id: string;
  multimodal: boolean;
  ctx?: number;
}

async function requireLoadedModel(): Promise<LoadedModel> {
  const { reachable, models } = await fetchModels(true);
  if (!reachable) throw new Error("model server unreachable");
  const loaded = models.find((m) => m.status === "loaded");
  if (!loaded) throw new Error("no model loaded — Load one from the AI Monitor");
  return { id: loaded.id, multimodal: loaded.multimodal, ctx: loaded.ctx };
}

/** All lore (title + body) for the user's universes, with ownership flags. */
async function userLore(userId: number) {
  const { rows } = await query<{
    id: number;
    title: string;
    body_md: string;
    universe_id: number;
    universe: string;
  }>(
    `SELECT e.id, e.title, e.body_md, e.universe_id, u.name AS universe
     FROM lore_entry e
     JOIN universe u ON u.id = e.universe_id
     JOIN universe_user uu ON uu.universe_id = u.id
     WHERE uu.user_id = $1
     ORDER BY u.name, lower(e.title)`,
    [userId],
  );
  return rows;
}

function countWords(s: string): number {
  return (s.match(/\S+/g) ?? []).length;
}

/**
 * ~60% of the context window (backend doc §4), word-based estimate
 * (~4 chars/token). If the combined lore exceeds it, drop lowest-priority
 * entries first (borrowed matched links > primary-universe > nothing else).
 */
function truncateLore(
  budgetWords: number,
  sections: { title: string; body: string; priority: number }[],
): string {
  const ordered = [...sections].sort((a, b) => b.priority - a.priority);
  const kept: string[] = [];
  let used = 0;
  for (const s of ordered) {
    const words = countWords(s.body);
    if (used + words > budgetWords && kept.length > 0) continue;
    kept.push(section(`LORE:${s.title}`, s.body));
    used += words;
  }
  return kept.join("\n\n") || section("LORE", "(none)");
}

// ---------------------------------------------------------------- generate

export async function runGenerate(run: Run): Promise<void> {
  const storyId = Number(run.target.story_id);
  const story = await getOwnedStory(storyId, run.userId);
  if (!story) throw new Error("story not found");

  // optional target: "Generate this chapter" regenerates an existing draft
  const targetSeq = run.target.chapter_seq != null ? Number(run.target.chapter_seq) : null;
  let targetChapter: { id: number; seq: number; title: string; body_md: string } | null = null;
  if (targetSeq !== null) {
    const { rows } = await query<{ id: number; seq: number; status: string; title: string; body_md: string }>(
      `SELECT id, seq, status, title, body_md FROM chapter WHERE story_id = $1 AND seq = $2`,
      [storyId, targetSeq],
    );
    if (rows.length === 0) throw new Error(`chapter ${targetSeq} not found`);
    if (rows[0].status === "final") throw new Error(`chapter ${targetSeq} is final — unfinalize is not supported`);
    targetChapter = rows[0];
  }

  const model = await requireLoadedModel();
  // "Generate this chapter" (rewrite in place) uses its own editable prompt
  // (FR-8); "generate next" keeps the original one.
  const systemPrompt = await getSystemPrompt(run.userId, targetSeq !== null ? "generate_this" : "generate");
  const chapters = await listChaptersForStory(storyId);

  // primary-universe lore + matched-link entries (backend doc §4)
  const verified = await verifyOutline(story, run.userId);
  const matchedEntryIds = new Set<number>();
  for (const v of verified) if (v.matched?.entry_id) matchedEntryIds.add(v.matched.entry_id);

  const lore = await userLore(run.userId);
  const primaryLore = story.universe_id
    ? lore.filter((e) => e.universe_id === story.universe_id)
    : [];
  const borrowedLore = lore.filter((e) => matchedEntryIds.has(e.id));

  const budgetWords = Math.floor(((model.ctx ?? 8192) * 0.6) / 4);
  const loreSection = truncateLore(
    budgetWords,
    [
      ...borrowedLore.map((e) => ({ title: e.title, body: e.body_md, priority: 3 })),
      ...primaryLore.map((e) => ({ title: e.title, body: e.body_md, priority: 2 })),
    ],
  );

  const summaries = chapters
    .filter((c) => c.summary_md)
    .map((c) => `### Ch ${c.seq} — ${c.title}\n${c.summary_md}`)
    .join("\n\n");
  const lastTwo = chapters.slice(-2);
  const lastChapters = lastTwo
    .map((c) => `### Ch ${c.seq} — ${c.title}\n${c.body_md}`)
    .join("\n\n") || "(no chapters yet)";

  const sections = [
    section("OUTLINE", story.outline_md || "(empty)"),
    loreSection,
    section("SUMMARIES", summaries || "(none yet)"),
    section("LAST_CHAPTERS", lastChapters),
  ].join("\n\n");

  // "Generate this chapter" = rewrite THAT chapter, so tell the model which
  // chapter it is and show it the existing draft (which may be the author's
  // own notes) — otherwise the prompt is identical to "next chapter" and the
  // current text is not even in the context (unless it happens to be in the
  // last two chapters).
  const userContent = targetChapter
    ? sections +
      `\n\n${section("CURRENT_CHAPTER", `# Ch ${targetChapter.seq} — ${targetChapter.title}\n${targetChapter.body_md || "(empty)"}`)}\n\nRewrite chapter ${targetChapter.seq} now, keeping continuity with the story so far.`
    : sections + "\n\nWrite the next chapter now.";

  // optional word-count hint (FR-2): a type hint only — the user picks a
  // range in the chapter pane; it is injected into the generate system
  // prompt. No verification is done (BRD: "no real wc verificatio is needed").
  const wordHint = run.target.word_hint != null ? String(run.target.word_hint) : "";
  // optional writing style ("skill", FR round 2): the user's own text on HOW
  // to write, appended to whichever generate system prompt is in use.
  const styleId = run.target.style_id != null ? Number(run.target.style_id) : null;
  let styleText = "";
  if (styleId !== null) {
    const { rows } = await query<{ name: string; text_md: string }>(
      `SELECT name, text_md FROM style_prompt WHERE id = $1 AND user_id = $2`,
      [styleId, run.userId],
    );
    styleText = rows[0]?.text_md ?? "";
  }
  let system = systemPrompt;
  if (wordHint) {
    system += `\nTarget chapter length: ${wordHint} words (a rough hint — aim for it, do not count words).`;
  }
  if (styleText) {
    system +=
      `\n\nWriting style (a user-defined "skill" — how the author wants this written; follow it):` +
      `\n---\n${styleText}\n---`;
  }

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: userContent },
  ];

  emit(run, { type: "thinking", message: "model is writing the chapter…" });
  const text = await chatStream({
    model: model.id,
    messages,
    signal: run.abort.signal,
    onDelta: (d) => emit(run, { type: "delta", text: d }),
    onThinking: thinkingOf(run),
  });

  const body = text.trim();
  if (!body) throw new Error(`model returned an empty chapter — ${EMPTY_ANSWER_HINT}`);
  if (targetChapter) {
    // regenerate this draft chapter in place (same seq, summary cleared).
    // Keep the EXISTING title: the prompt tells the model not to emit a
    // title line, so body[0] is prose — deriving a title from it would
    // clobber the author's title with the chapter's first line.
    await withTransaction(async (q) => {
      await q(
        `UPDATE chapter SET body_md = $1, summary_md = NULL, status = 'draft',
                  updated_at = now() WHERE id = $2`,
        [body, targetChapter.id],
      );
      await q(`UPDATE story SET updated_at = now() WHERE id = $1`, [storyId]);
    });
    await finishRun(run, { chapter_id: targetChapter.id, seq: targetChapter.seq, title: targetChapter.title });
    return;
  }
  // next chapter: max(seq)+1 (robust against seq gaps), title falls back to
  // the model's first line (no other source — the model may ignore "no
  // title line" and that is a decent title when it does)
  const seq = chapters.reduce((m, c) => Math.max(m, c.seq), 0) + 1;
  const title = body.split("\n")[0].replace(/^#+\s*/, "").slice(0, 120);
  const newChapterId = await withTransaction(async (q) => {
    const r = await q<{ id: number }>(
      `INSERT INTO chapter (story_id, seq, title, body_md, status)
       VALUES ($1, $2, $3, $4, 'draft') RETURNING id`,
      [storyId, seq, title || `Chapter ${seq}`, body],
    );
    await q(`UPDATE story SET updated_at = now() WHERE id = $1`, [storyId]);
    return r.rows[0].id;
  });
  await finishRun(run, { chapter_id: newChapterId, seq, title });
}

// ---------------------------------------------------------------- summarize

export async function runSummarize(run: Run): Promise<void> {
  const storyId = Number(run.target.story_id);
  const story = await getOwnedStory(storyId, run.userId);
  if (!story) throw new Error("story not found");

  const model = await requireLoadedModel();
  const systemPrompt = await getSystemPrompt(run.userId, "summarize");
  const chapters = await listChaptersForStory(storyId).then((cs) =>
    cs.filter((c) => !c.summary_md),
  );
  if (chapters.length === 0) {
    throw new Error("all chapters already have summaries");
  }

  const done: { seq: number; title: string }[] = [];
  // sequential, one LLM call each (backend doc §4); the thinking marker
  // shows per-chapter progress (k of M) — the story page's stream pane
  // renders it, so "summarize all" visibly loops over EVERY chapter
  // (user feedback 2026-10-13: without it the run looked like one chapter)
  for (const ch of chapters) {
    // a cancel between calls (the red Stop button) ends the action now
    if (run.abort.signal.aborted) throw new Error("cancelled by user");
    emit(run, {
      type: "thinking",
      message: `summarizing ch ${ch.seq} — ${ch.title} (${done.length + 1} of ${chapters.length})…`,
    });
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: section("chapter", ch.body_md) },
    ];
    const callModel = () =>
      chatStream({
        model: model.id,
        messages,
        // 40k (user instruction 2026-10-14, was 600): on a llama.cpp server
        // run with reasoning extraction, reasoning_content tokens count
        // against max_tokens — at 600 a chatty thinker spent the whole
        // budget on thinking and left `content` empty (→ the empty-retry →
        // "summarize dies at ch 1" failures). The server clamps to the
        // remaining context if this exceeds it.
        maxTokens: 40000,
        signal: run.abort.signal,
        onDelta: (d) => emit(run, { type: "delta", chapter: ch.seq, text: d }),
        onThinking: thinkingOf(run),
      });
    // local models occasionally answer with reasoning-only (empty) output —
    // retry ONCE before failing (defensive parsing, backend doc §4)
    let summary = (await callModel()).trim();
    if (!summary) {
      emit(run, { type: "thinking", message: `ch ${ch.seq} came back empty — retrying once…` });
      summary = (await callModel()).trim();
    }
    if (!summary) {
      // be specific about WHERE the multi-chapter run died: which chapter
      // failed and what already survived (the page reloads when the run
      // ends — this text is what the user is left with, so it must explain
      // why only some chapters got summaries — user report 2026-10-13)
      throw new Error(
        `empty summary for ch ${ch.seq} — the model returned no text even after a retry. ` +
          `${EMPTY_ANSWER_HINT}. ` +
          `Chapters ${done.map((d) => d.seq).join(", ") || "(none)"} were summarized and saved — click Summarize again to do the rest.`,
      );
    }
    await query(`UPDATE chapter SET summary_md = $2, updated_at = now() WHERE id = $1`, [
      ch.id,
      summary,
    ]);
    done.push({ seq: ch.seq, title: ch.title });
  }
  await finishRun(run, { summaries: done });
}

// ---------------------------------------------------------------- lore_suggest

export interface LoreSuggestion {
  type: "add" | "delete";
  universe: string;
  title: string;
  body_md: string;
  reason: string;
}

export async function runLoreSuggest(run: Run): Promise<void> {
  const storyId = Number(run.target.story_id);
  const story = await getOwnedStory(storyId, run.userId);
  if (!story) throw new Error("story not found");

  const model = await requireLoadedModel();
  const systemPrompt = await getSystemPrompt(run.userId, "lore_suggest");
  const chapters = await listChaptersForStory(storyId);
  const summaries = chapters
    .filter((c) => c.summary_md)
    .map((c) => `### Ch ${c.seq} — ${c.title}\n${c.summary_md}`)
    .join("\n\n") || "(none yet)";
  const lastTwo = chapters
    .slice(-2)
    .map((c) => `### Ch ${c.seq} — ${c.title}\n${c.body_md}`)
    .join("\n\n") || "(no chapters yet)";

  const sections = [
    section("OUTLINE", story.outline_md || "(empty)"),
    section("SUMMARIES", summaries),
    section("LAST_CHAPTERS", lastTwo),
  ].join("\n\n");

  emit(run, { type: "thinking", message: "model is reviewing the story…" });
  const text = await chatStream({
    model: model.id,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: sections + "\n\nRespond with the JSON array now." },
    ],
    signal: run.abort.signal,
    onDelta: (d) => emit(run, { type: "delta", text: d }),
    onThinking: thinkingOf(run),
  });

  // parse defensively — local models emit messy JSON (backend doc §4)
  if (!text.trim()) throw new Error(`model returned an empty answer — ${EMPTY_ANSWER_HINT}`);
  const parsed = parseStructured<LoreSuggestion[]>(text, "array");
  if (!parsed.ok) throw new Error(`could not parse suggestion JSON: ${parsed.error}`);

  const suggestions: LoreSuggestion[] = parsed.value
    .filter((s) => s && typeof s === "object" && (s.type === "add" || s.type === "delete"))
    .slice(0, 10)
    .map((s) => ({
      type: s.type,
      universe: String(s.universe ?? ""),
      title: String(s.title ?? ""),
      body_md: String(s.body_md ?? ""),
      reason: String(s.reason ?? ""),
    }));

  await finishRun(run, { suggestions });
}

// ---------------------------------------------------------------- style_extract

/**
 * "Extract style" (change request 2026-10-13): the model reads the story's
 * last few chapters and writes a description of the author's writing style.
 * The result is AUTO-SAVED as one of the user's style prompts ("skills") —
 * navigating away from the story page must never lose it. Same name
 * (`<story title>'s style`) → re-extracting UPDATES the existing row
 * instead of piling up duplicates. The `done` payload carries the style's
 * id + name so the story page offers rename/delete via the existing
 * style-prompt API.
 */
export async function runStyleExtract(run: Run): Promise<void> {
  const storyId = Number(run.target.story_id);
  const story = await getOwnedStory(storyId, run.userId);
  if (!story) throw new Error("story not found");

  const chapters = await listChaptersForStory(storyId);
  if (chapters.length === 0) {
    throw new Error("no chapters to read yet — write or generate a chapter first");
  }

  const model = await requireLoadedModel();
  const systemPrompt = await getSystemPrompt(run.userId, "style_extract");

  // the last up-to-3 chapters; if they would blow the context budget drop
  // the OLDEST ones (never the newest — recency is the whole point)
  const budgetWords = Math.floor(((model.ctx ?? 8192) * 0.6) / 4);
  let recent = chapters.slice(-3);
  while (recent.length > 1 && countWords(recent.map((c) => c.body_md).join(" ")) > budgetWords) {
    recent = recent.slice(1);
  }
  const chaptersSection =
    recent.map((c) => `### Ch ${c.seq} — ${c.title}\n${c.body_md}`).join("\n\n") || "(empty)";

  emit(run, { type: "thinking", message: `model is reading the last ${recent.length} chapter(s)…` });
  const text = await chatStream({
    model: model.id,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: section("CHAPTERS", chaptersSection) + "\n\nDescribe the author's writing style now." },
    ],
    signal: run.abort.signal,
    onDelta: (d) => emit(run, { type: "delta", text: d }),
    onThinking: thinkingOf(run),
  });
  const style = text.trim();
  if (!style) throw new Error(`model returned an empty style description — ${EMPTY_ANSWER_HINT}`);

  // auto-save as a style prompt (change request 2026-10-15): the result
  // must survive navigating away from the story page
  const name = (story.title.trim() || "Extracted") + "'s style";
  const existing = await query<{ id: number }>(
    `SELECT id FROM style_prompt WHERE user_id = $1 AND lower(name) = lower($2)`,
    [run.userId, name],
  );
  let styleId: number;
  if (existing.rows[0]) {
    styleId = existing.rows[0].id;
    await query(`UPDATE style_prompt SET text_md = $1, updated_at = now() WHERE id = $2`, [
      style,
      styleId,
    ]);
  } else {
    const ins = await query<{ id: number }>(
      `INSERT INTO style_prompt (user_id, name, text_md) VALUES ($1, $2, $3) RETURNING id`,
      [run.userId, name, style],
    );
    styleId = ins.rows[0].id;
  }
  await finishRun(run, { text: style, chapters: recent.map((c) => c.seq), style: { id: styleId, name } });
}

// ---------------------------------------------------------------- image_desc

export async function runImageDesc(run: Run): Promise<void> {
  const imageId = Number(run.target.image_id);
  const { rows: img } = await query<{ filename: string }>(
    `SELECT filename FROM image WHERE id = $1 AND user_id = $2`,
    [imageId, run.userId],
  );
  if (img.length === 0) throw new Error("image not found");

  const model = await requireLoadedModel();
  if (!model.multimodal) throw new Error("the loaded model has no vision (mmproj) support");
  const systemPrompt = await getSystemPrompt(run.userId, "image_desc");

  const full = path.join(getConfig().imagesDir, img[0].filename);
  if (!fs.existsSync(full)) throw new Error("image file missing on disk");
  const buf = fs.readFileSync(full);
  const ext = path.extname(full).toLowerCase();
  const mime =
    ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : ext === ".gif"
        ? "image/gif"
        : ext === ".webp"
          ? "image/webp"
          : "image/png";
  const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;

  emit(run, { type: "thinking", message: "model is looking at the image…" });
  const text = await chatStream({
    model: model.id,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUrl } },
          { type: "text", text: "Describe this image as a lore reference note." },
        ],
      },
    ],
    signal: run.abort.signal,
    onDelta: (d) => emit(run, { type: "delta", text: d }),
    onThinking: thinkingOf(run),
  });
  const description = text.trim();
  if (!description) throw new Error(`model returned an empty description — ${EMPTY_ANSWER_HINT}`);
  // user copies it into the entry — nothing auto-written (BRD FR-14/OI-5)
  await finishRun(run, { text: description });
}
