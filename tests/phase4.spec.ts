import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  baseUrl,
  createSession,
  createUser,
  query,
  SESSION_COOKIE,
  startServer,
  stopServer,
  wipeTables,
} from "./helpers";
import { startFakeLlm, type FakeLlm } from "./fake-llm";

let fakeLlm: FakeLlm;

async function jpost(token: string, p: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function jget(token: string, p: string): Promise<Response> {
  return fetch(`${baseUrl}${p}`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
}
async function post(token: string, p: string, body?: unknown, status = 200) {
  const r = await jpost(token, p, body);
  expect(r.status).toBe(status);
  return (await r.json()) as Record<string, unknown>;
}

/** Read an SSE stream to completion; returns parsed events. */
async function readSse(token: string, url: string): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${baseUrl}${url}`, {
    headers: { accept: "text/event-stream", cookie: `${SESSION_COOKIE}=${token}` },
  });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: Record<string, unknown>[] = [];
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const evt = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = evt.split("\n").find((l) => l.startsWith("data:"));
      if (line) events.push(JSON.parse(line.slice(5)));
    }
  }
  return events;
}

async function aiAction(
  token: string,
  kind: string,
  body: unknown,
): Promise<{ events: Record<string, unknown>[]; status: number }> {
  const start = await jpost(token, `/api/ai/${kind}`, body);
  const status = start.status;
  if (status !== 202) return { events: [], status };
  const { run } = (await start.json()) as { run: { id: number } };
  const events = await readSse(token, `/api/ai/runs/${run.id}/stream`);
  return { events, status };
}

async function waitForRun(runId: number, timeoutMs = 15_000): Promise<{ status: string; error: string | null }> {
  const t0 = Date.now();
  for (;;) {
    const { rows } = await query<{ status: string; error: string | null }>(
      `SELECT status, error FROM ai_run WHERE id = $1`,
      [runId],
    );
    if (rows[0] && rows[0].status !== "running") return rows[0];
    if (Date.now() - t0 > timeoutMs) throw new Error("run did not finish in time");
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function waitModelLoaded(token: string, timeoutMs = 15_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const { models } = (await (await jget(token, "/api/model")).json()) as {
      models: { status: string }[];
    };
    if (models.some((m) => m.status === "loaded")) return;
    if (Date.now() - t0 > timeoutMs) throw new Error("model did not load in time");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("Phase 4 — AI (fake LLM)", () => {
  beforeAll(async () => {
    fakeLlm = startFakeLlm({ loadDelayMs: 100 });
    await fakeLlm.whenReady();
    await startServer();
    await wipeTables();
  });

  afterAll(async () => {
    await stopServer();
    await fakeLlm.close();
  });

  it("T4.2 model status/load/unload proxy", async () => {
    const uid = await createUser("aiuser", "aipw123456");
    const token = await createSession(uid);

    let m = (await (await jget(token, "/api/model")).json()) as {
      reachable: boolean;
      models: { status: string; multimodal: boolean }[];
      loaded: { id: string } | null;
    };
    expect(m.reachable).toBe(true);
    expect(m.models[0].status).toBe("unloaded");

    const load = await jpost(token, "/api/model/load", { model: fakeLlm.model });
    expect(load.status).toBe(200);
    await waitModelLoaded(token);
    m = (await (await jget(token, "/api/model")).json()) as typeof m;
    expect(m.models[0].status).toBe("loaded");
    expect(m.loaded?.id).toBe(fakeLlm.model);
    expect(m.models[0].multimodal).toBe(true);

    await jpost(token, "/api/model/unload", { model: fakeLlm.model });
    await new Promise((r) => setTimeout(r, 30));
    m = (await (await jget(token, "/api/model")).json()) as typeof m;
    expect(m.models[0].status).toBe("unloaded");
  });

  it("T4.3 one action per user → 409 while running", async () => {
    const uid = await createUser("busy", "busypw1234");
    const token = await createSession(uid);
    const s = (await post(token, "/api/stories/0", { title: "S" }, 201)) as { id: number };

    // model must be loaded, else the first run fails instantly and frees the slot
    await jpost(token, "/api/model/load", { model: fakeLlm.model });
    await waitModelLoaded(token);

    // make the fake stream slowly so the run stays active (holds the slot)
    fakeLlm.reset(); // no leftover canned responses from earlier tests
    fakeLlm.respondWith({ text: "slow chapter", chunks: 4, delayPerChunkMs: 200 });
    const first = await jpost(token, "/api/ai/generate", { story_id: s.id });
    expect(first.status).toBe(202);
    const firstRun = (await first.json()) as { run: { id: number } };

    const second = await jpost(token, "/api/ai/generate", { story_id: s.id });
    expect(second.status).toBe(409);

    // wait it out and check the ai_run row reaches done
    await waitForRun(firstRun.run.id);
  });

  it("T4.5 generate: prompt assembly + stream + persist draft chapter", async () => {
    const uid = await createUser("gen", "genpw123456");
    const token = await createSession(uid);
    const u1 = (await post(token, "/api/universes", { name: "Primary" }, 201)) as { id: number };
    const u2 = (await post(token, "/api/universes", { name: "Borrowed" }, 201)) as { id: number };
    await post(token, "/api/entries/0", { title: "Sword", body_md: "A blade.", universe_id: u1.id }, 201);
    await post(token, "/api/entries/0", { title: "Gauntlet", body_md: "A glove.", universe_id: u2.id }, 201);

    const s = (await post(token, "/api/stories/0", { title: "G", universe_id: u1.id }, 201)) as { id: number };
    await post(token, `/api/stories/${s.id}`, { outline_md: "The hero takes the [Gauntlet](gauntlet)." });
    // one existing chapter (summary + last-2-chapters feed the prompt)
    const c1 = (await post(token, `/api/stories/${s.id}/chapters/0`, { title: "Ch 1", body_md: "Opening." }, 201)) as { id: number };
    await query(`UPDATE chapter SET summary_md = 'The story opens.' WHERE id = $1`, [c1.id]);

    await jpost(token, "/api/model/load", { model: fakeLlm.model });
    await waitModelLoaded(token);

    fakeLlm.reset(); // no leftover canned responses from earlier tests
    fakeLlm.respondWith({ text: "Chapter 2\n\nThe hero fights on.", chunks: 3 });
    const { events, status } = await aiAction(token, "generate", { story_id: s.id });
    expect(status).toBe(202);
    // every action sends at least the 20k thinking-model floor for
    // max_tokens (llm.ts DEFAULT_MAX_TOKENS; summarize overrides with 40k)
    expect(fakeLlm.calls.at(-1)?.maxTokens).toBe(20000);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("start");
    expect(types).toContain("delta");
    expect(types[types.length - 1]).toBe("done");
    const done = events[events.length - 1] as { chapter_id: number; seq: number };
    expect(done.seq).toBe(2);

    // persisted as a draft chapter
    const { rows } = await query<{ seq: number; status: string; body_md: string; title: string }>(
      `SELECT seq, status, body_md, title FROM chapter WHERE story_id = $1 AND seq = 2`,
      [s.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("draft");
    expect(rows[0].body_md).toBe("Chapter 2\n\nThe hero fights on.");
    expect(rows[0].title).toBe("Chapter 2");
  });

  it("T4.5 generate with NO model loaded → error event, run=error", async () => {
    const uid = await createUser("nolm", "nolmpw1234");
    const token = await createSession(uid);
    await jpost(token, "/api/model/unload", { model: fakeLlm.model });
    await new Promise((r) => setTimeout(r, 30));

    const s = (await post(token, "/api/stories/0", { title: "N" }, 201)) as { id: number };
    const start = await jpost(token, "/api/ai/generate", { story_id: s.id });
    expect(start.status).toBe(202);
    const { run } = (await start.json()) as { run: { id: number } };
    const events = await readSse(token, `/api/ai/runs/${run.id}/stream`);
    const last = events[events.length - 1] as { type: string; message: string };
    expect(last.type).toBe("error");
    expect(last.message).toMatch(/no model loaded/i);
    const state = await waitForRun(run.id);
    expect(state.status).toBe("error");
  });

  it("T4.6 summarize: sequential per-chapter calls → summary_md", async () => {
    const uid = await createUser("sum", "sumpw123456");
    const token = await createSession(uid);
    const s = (await post(token, "/api/stories/0", { title: "Sum" }, 201)) as { id: number };
    await post(token, `/api/stories/${s.id}/chapters/0`, { title: "C1", body_md: "one" }, 201);
    await post(token, `/api/stories/${s.id}/chapters/0`, { title: "C2", body_md: "two" }, 201);

    await jpost(token, "/api/model/load", { model: fakeLlm.model });
    await waitModelLoaded(token);

    fakeLlm.reset(); // no leftover canned responses from earlier tests
    fakeLlm.respondWith({ text: "A tight summary.", chunks: 1 });
    const { events, status } = await aiAction(token, "summarize", { story_id: s.id });
    expect(status).toBe(202);
    expect(events[events.length - 1].type).toBe("done");
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM chapter WHERE story_id = $1 AND summary_md IS NOT NULL`,
      [s.id],
    );
    expect(rows[0].n).toBe(2);
    // one LLM call per unsummarized chapter (sequential)
    expect(fakeLlm.calls.length).toBeGreaterThanOrEqual(2);
    // AND the run announces every chapter with a progress marker (the story
    // page renders these — without them the all-chapters run looked like it
    // was summarizing a single chapter, user feedback 2026-10-13)
    const thinking = events.filter((e) => e.type === "thinking");
    expect(thinking).toHaveLength(2);
    expect(String(thinking[0].message)).toMatch(/1 of 2/);
    expect(String(thinking[1].message)).toMatch(/2 of 2/);
  });

  it("summarize: empty model answer is retried once before failing", async () => {
    const uid = await createUser("sumretry", "sumrtpw123");
    const token = await createSession(uid);
    const s = (await post(token, "/api/stories/0", { title: "RetrySum" }, 201)) as { id: number };
    await post(token, `/api/stories/${s.id}/chapters/0`, { title: "C1", body_md: "one" }, 201);

    await jpost(token, "/api/model/load", { model: fakeLlm.model });
    await waitModelLoaded(token);

    // first call comes back empty (reasoning-only model output), retry succeeds
    fakeLlm.reset();
    fakeLlm.respondWith({ fail: "empty" });
    fakeLlm.respondWith({ text: "A tight summary.", chunks: 1 });
    const { events, status } = await aiAction(token, "summarize", { story_id: s.id });
    expect(status).toBe(202);
    expect(events[events.length - 1].type).toBe("done");
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM chapter WHERE story_id = $1 AND summary_md IS NOT NULL`,
      [s.id],
    );
    expect(rows[0].n).toBe(1);
    const thinking = events.filter((e) => e.type === "thinking").map((e) => String(e.message));
    expect(thinking.some((m) => /retrying once/i.test(m))).toBe(true);
  });

  it("summarize: dying at ch 2 leaves ch 1 saved and a SPECIFIC error (the 'only the first chapter' report)", async () => {
    const uid = await createUser("sumfail", "sumfpw1234");
    const token = await createSession(uid);
    const s = (await post(token, "/api/stories/0", { title: "FailSum" }, 201)) as { id: number };
    await post(token, `/api/stories/${s.id}/chapters/0`, { title: "C1", body_md: "one" }, 201);
    await post(token, `/api/stories/${s.id}/chapters/0`, { title: "C2", body_md: "two" }, 201);
    await post(token, `/api/stories/${s.id}/chapters/0`, { title: "C3", body_md: "three" }, 201);

    await jpost(token, "/api/model/load", { model: fakeLlm.model });
    await waitModelLoaded(token);

    // ch1 summarizes fine; ch2 answers empty TWICE (call + retry) → run dies
    fakeLlm.reset();
    fakeLlm.respondWith({ text: "S1.", chunks: 1 });
    fakeLlm.respondWith({ fail: "empty" });
    fakeLlm.respondWith({ fail: "empty" });
    const { events, status } = await aiAction(token, "summarize", { story_id: s.id });
    expect(status).toBe(202);
    const last = events[events.length - 1] as { type: string; message: string };
    expect(last.type).toBe("error");
    // the error names the failed chapter AND what survived — this is what
    // the story page shows after its post-run reload
    expect(last.message).toMatch(/ch 2/);
    expect(last.message).toMatch(/Chapters 1/);
    expect(last.message).toMatch(/saved/i);
    const { rows } = await query<{ n: number; minseq: number }>(
      `SELECT count(*)::int AS n, coalesce(min(seq), 0) AS minseq
       FROM chapter WHERE story_id = $1 AND summary_md IS NOT NULL`,
      [s.id],
    );
    expect(rows[0].n).toBe(1); // only ch1 survived
    expect(rows[0].minseq).toBe(1);
  });

  it("story page failed-run banner: /api/ai/last-run surfaces the exact error (round 5: 'no banner at all')", async () => {
    const uid = await createUser("sumlr", "sumlrpw123");
    const token = await createSession(uid);
    const s = (await post(token, "/api/stories/0", { title: "LR" }, 201)) as { id: number };
    const other = (await post(token, "/api/stories/0", { title: "LR other" }, 201)) as { id: number };
    await post(token, `/api/stories/${s.id}/chapters/0`, { title: "C1", body_md: "one" }, 201);
    await jpost(token, "/api/model/load", { model: fakeLlm.model });
    await waitModelLoaded(token);

    const lastRun = async () =>
      ((await (await jget(token, `/api/ai/last-run?story_id=${s.id}`)).json()) as {
        run: { id: number; kind: string; status: string; error: string | null } | null;
      }).run;

    // no runs yet → null (banner stays away)
    expect(await lastRun()).toBeNull();

    // a run that dies AT ch 1 (empty answer twice) → its exact error is
    // queryable afterwards — no matter which page the user is on
    fakeLlm.reset();
    const callCountBefore = fakeLlm.calls.length;
    fakeLlm.respondWith({ fail: "empty" });
    fakeLlm.respondWith({ fail: "empty" });
    const { events, status } = await aiAction(token, "summarize", { story_id: s.id });
    expect(status).toBe(202);
    expect(events[events.length - 1].type).toBe("error");
    // the summarize requests carry the 40k token budget (user instruction
    // 2026-10-14 — 600 was small enough for a reasoning model to exhaust on
    // reasoning_content alone → empty summaries → mid-run deaths)
    const summarizeCalls = fakeLlm.calls.slice(callCountBefore);
    expect(summarizeCalls.length).toBe(2); // call + retry
    expect(summarizeCalls.every((c) => c.maxTokens === 40000)).toBe(true);
    let run = await lastRun();
    expect(run?.status).toBe("error");
    expect(run?.kind).toBe("summarize");
    expect(run?.error).toMatch(/empty summary for ch 1/);
    // the run belongs to THIS story only — the sibling story stays clean
    const otherRun = (
      await (await jget(token, `/api/ai/last-run?story_id=${other.id}`)).json()
    ) as { run: unknown };
    expect(otherRun.run).toBeNull();

    // a LATER successful run replaces the failure → no banner on reload
    fakeLlm.reset();
    fakeLlm.respondWith({ text: "S1.", chunks: 1 });
    const ok = await aiAction(token, "summarize", { story_id: s.id });
    expect(ok.events[ok.events.length - 1].type).toBe("done");
    run = await lastRun();
    expect(run?.status).toBe("done");
    expect(run?.error).toBeNull();

    // the story page itself fetches the endpoint (banner source)
    const page = await (await jget(token, `/story/${s.id}`)).text();
    expect(page).toContain("/api/ai/last-run?story_id=");
  });

  it("T4.8 lore-suggest: defensive JSON parse; adds apply; deletes need confirm", async () => {
    const uid = await createUser("sugg", "suggpw1234");
    const token = await createSession(uid);
    const u1 = (await post(token, "/api/universes", { name: "World" }, 201)) as { id: number };
    await post(token, "/api/entries/0", { title: "Old Thing", body_md: "x", universe_id: u1.id }, 201);
    const s = (await post(token, "/api/stories/0", { title: "Lore" }, 201)) as { id: number };
    await post(token, `/api/stories/${s.id}/chapters/0`, { title: "C1", body_md: "story" }, 201);

    await jpost(token, "/api/model/load", { model: fakeLlm.model });
    await waitModelLoaded(token);

    // messy JSON: code fence + surrounding prose
    const messy =
      "Here are my suggestions:\n```json\n" +
      JSON.stringify([
        { type: "add", universe: "World", title: "New Sword", body_md: "A new blade.", reason: "appears in ch1" },
        { type: "delete", universe: "World", title: "Old Thing", body_md: "", reason: "retired" },
      ]) +
      "\n```\nHope that helps!";
    fakeLlm.reset(); // no leftover canned responses from earlier tests
    fakeLlm.respondWith({ text: messy, chunks: 1 });
    const { events } = await aiAction(token, "lore-suggest", { story_id: s.id });
    const done = events[events.length - 1] as {
      type: string;
      suggestions: { type: string; title: string; universe: string }[];
    };
    expect(done.type).toBe("done");
    expect(done.suggestions).toHaveLength(2);
    expect(done.suggestions[0].title).toBe("New Sword");
    expect(done.suggestions[1].title).toBe("Old Thing");

    // apply an ADD directly (no confirm — additions apply, BRD FR-15)
    const addRes = (await post(token, "/api/ai/lore-suggest/apply", {
      type: "add",
      universe: "World",
      title: "New Sword",
      body_md: "A new blade.",
    })) as { ok: boolean };
    expect(addRes.ok).toBe(true);
    const { rows: added } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM lore_entry WHERE title = 'New Sword' AND universe_id = $1`,
      [u1.id],
    );
    expect(added[0].n).toBe(1);

    // DELETE without confirm → rejected (backend never deletes on its own)
    const noConfirm = (await post(token, "/api/ai/lore-suggest/apply", {
      type: "delete",
      universe: "World",
      title: "Old Thing",
    })) as { ok: boolean; error: string };
    expect(noConfirm.ok).toBe(false);
    expect(noConfirm.error).toMatch(/confirm/i);
    const { rows: stillThere } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM lore_entry WHERE title = 'Old Thing'`,
    );
    expect(stillThere[0].n).toBe(1);

    // DELETE with confirm → deletes
    const confirmed = (await post(token, "/api/ai/lore-suggest/apply", {
      type: "delete",
      universe: "World",
      title: "Old Thing",
      confirmed: true,
    })) as { ok: boolean };
    expect(confirmed.ok).toBe(true);
    const { rows: goneNow } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM lore_entry WHERE title = 'Old Thing'`,
    );
    expect(goneNow[0].n).toBe(0);
  });

  it("T4.7 image-desc: base64 image parts round-trip, free-text result", async () => {
    const uid = await createUser("img", "imgpw12345");
    const token = await createSession(uid);
    const u1 = (await post(token, "/api/universes", { name: "Im" }, 201)) as { id: number };
    const entry = (await post(token, "/api/entries/0", { title: "Pic", body_md: "", universe_id: u1.id }, 201)) as { id: number };

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const fd = new FormData();
    fd.append("image", new Blob([png], { type: "image/png" }), "p.png");
    fd.append("lore_entry_id", String(entry.id));
    const up = await fetch(`${baseUrl}/api/images`, {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
      body: fd,
    });
    expect(up.status).toBe(201);
    const img = (await up.json()) as { id: number; filename: string };

    await jpost(token, "/api/model/load", { model: fakeLlm.model });
    await waitModelLoaded(token);

    const callsBefore = fakeLlm.calls.length;
    fakeLlm.reset(); // no leftover canned responses from earlier tests
    fakeLlm.respondWith({ text: "A small red dot on white.", imageEcho: true, chunks: 1 });
    const { events } = await aiAction(token, "image-desc", { image_id: img.id });
    expect(events[events.length - 1].type).toBe("done");
    // proves the fake received the image_url part (client round-tripped base64)
    expect(fakeLlm.calls.slice(callsBefore).some((c) => c.hadImage)).toBe(true);

    const { rows } = await query<{ filename: string }>(`SELECT filename FROM image WHERE id = $1`, [img.id]);
    expect(fs.existsSync(path.join(process.env.IMAGES_DIR ?? "/tmp", rows[0].filename))).toBe(true);
  });

  it("generate with chapter_seq regenerates the existing draft in place (no new chapter)", async () => {
    const uid = await createUser("regen", "regenpw123");
    const token = await createSession(uid);
    const s = (await post(token, "/api/stories/0", { title: "Regen" }, 201)) as { id: number };
    const c1 = (await post(token, `/api/stories/${s.id}/chapters/0`, { title: "Ch 1", body_md: "Original text." }, 201)) as { id: number };
    await query(`UPDATE chapter SET summary_md = 'Old summary.' WHERE id = $1`, [c1.id]);

    await jpost(token, "/api/model/load", { model: fakeLlm.model });
    await waitModelLoaded(token);

    fakeLlm.reset(); // no leftover canned responses from earlier tests
    fakeLlm.respondWith({ text: "Ch 1 (again)\n\nNew text.", chunks: 2 });
    const callsBefore = fakeLlm.calls.length;
    const { events, status } = await aiAction(token, "generate", { story_id: s.id, chapter_seq: 1 });
    expect(status).toBe(202);
    // the prompt must target THIS chapter: the existing draft is included and
    // the model is asked to rewrite it (not "write the next chapter")
    const prompt = fakeLlm.calls.slice(callsBefore).map((c) => c.userText).join("\n");
    expect(prompt).toContain("CURRENT_CHAPTER");
    expect(prompt).toContain("Original text.");
    expect(prompt).toMatch(/rewrite chapter 1/i);
    expect(prompt).not.toContain("Write the next chapter now.");
    const done = events[events.length - 1] as { chapter_id: number; seq: number };
    expect(done.seq).toBe(1);
    expect(done.chapter_id).toBe(c1.id); // same row, not a new one

    const { rows } = await query<{ id: number; seq: number; status: string; body_md: string; title: string; summary_md: string | null }>(
      `SELECT id, seq, status, body_md, title, summary_md FROM chapter WHERE story_id = $1`,
      [s.id],
    );
    expect(rows).toHaveLength(1); // still exactly one chapter
    expect(rows[0].body_md).toBe("Ch 1 (again)\n\nNew text.");
    // the rewrite keeps the EXISTING title — the prompt tells the model not
    // to emit a title line, so the body's first line is prose, not a title
    // (the old code overwrote the author's title with it)
    expect(rows[0].title).toBe("Ch 1");
    expect(rows[0].summary_md).toBeNull(); // stale summary cleared
  });

  it("generate with a final chapter_seq → error run (no in-place overwrite of final)", async () => {
    const uid = await createUser("regenf", "regenfpw12");
    const token = await createSession(uid);
    const s = (await post(token, "/api/stories/0", { title: "RegenF" }, 201)) as { id: number };
    const c1 = (await post(token, `/api/stories/${s.id}/chapters/0`, { title: "Final ch", body_md: "Done." }, 201)) as { id: number };
    await query(`UPDATE chapter SET status = 'final' WHERE id = $1`, [c1.id]);

    await jpost(token, "/api/model/load", { model: fakeLlm.model });
    await waitModelLoaded(token);

    fakeLlm.reset(); // no leftover canned responses from earlier tests
    fakeLlm.respondWith({ text: "Overwrite?", chunks: 1 });
    const { events } = await aiAction(token, "generate", { story_id: s.id, chapter_seq: 1 });
    const last = events[events.length - 1] as { type: string; message: string };
    expect(last.type).toBe("error");
    expect(last.message).toMatch(/final/i);
    const { rows } = await query<{ body_md: string }>(`SELECT body_md FROM chapter WHERE id = $1`, [c1.id]);
    expect(rows[0].body_md).toBe("Done."); // untouched
  });

  it("generate with a word_hint: injected into the generate system prompt (FR-2)", async () => {
    const uid = await createUser("hint", "hintpw1234");
    const token = await createSession(uid);
    const s = (await post(token, "/api/stories/0", { title: "Hinted" }, 201)) as { id: number };

    await jpost(token, "/api/model/load", { model: fakeLlm.model });
    await waitModelLoaded(token);

    fakeLlm.reset();
    fakeLlm.respondWith({ text: "A short chapter.", chunks: 1 });
    const callsBefore = fakeLlm.calls.length;
    const { events, status } = await aiAction(token, "generate", {
      story_id: s.id,
      word_hint: "under 1000 words",
    });
    expect(status).toBe(202);
    expect(events[events.length - 1].type).toBe("done");
    const sys = fakeLlm.calls.slice(callsBefore).map((c) => c.systemText).join("\n");
    expect(sys).toMatch(/under 1000 words/);

    // the hint is a whitelisted type hint — free-form text is rejected
    const bad = await jpost(token, "/api/ai/generate", { story_id: s.id, word_hint: "make it long" });
    expect(bad.status).toBe(400);
  });

  it("generate with chapter_seq uses the SEPARATE generate_this prompt (FR-8)", async () => {
    const uid = await createUser("genp", "genppw1234");
    const token = await createSession(uid);
    const s = (await post(token, "/api/stories/0", { title: "PromptSplit" }, 201)) as { id: number };
    await post(token, `/api/stories/${s.id}/chapters/0`, { title: "Ch 1", body_md: "Old draft." }, 201);

    // customize the two generate prompts so the test can tell them apart
    await post(token, "/api/prompts", { action: "generate", text_md: "NEXT_CHAPTER_SENTINEL" });
    await post(token, "/api/prompts", { action: "generate_this", text_md: "THIS_CHAPTER_SENTINEL" });

    await jpost(token, "/api/model/load", { model: fakeLlm.model });
    await waitModelLoaded(token);

    // regenerate in place → uses generate_this
    fakeLlm.reset();
    fakeLlm.respondWith({ text: "Rewritten.", chunks: 1 });
    const callsBefore = fakeLlm.calls.length;
    const { events } = await aiAction(token, "generate", { story_id: s.id, chapter_seq: 1 });
    expect(events[events.length - 1].type).toBe("done");
    let sys = fakeLlm.calls.slice(callsBefore).map((c) => c.systemText).join("\n");
    expect(sys).toContain("THIS_CHAPTER_SENTINEL");
    expect(sys).not.toContain("NEXT_CHAPTER_SENTINEL");

    // next-chapter mode → uses the original generate prompt
    fakeLlm.reset();
    fakeLlm.respondWith({ text: "Next one.", chunks: 1 });
    const callsBefore2 = fakeLlm.calls.length;
    const { events: e2 } = await aiAction(token, "generate", { story_id: s.id });
    expect(e2[e2.length - 1].type).toBe("done");
    sys = fakeLlm.calls.slice(callsBefore2).map((c) => c.systemText).join("\n");
    expect(sys).toContain("NEXT_CHAPTER_SENTINEL");
    expect(sys).not.toContain("THIS_CHAPTER_SENTINEL");
  });

  it("generate with a style prompt: injected into the system prompt (FR round 2)", async () => {
    const uid = await createUser("styler", "stylerpw12");
    const token = await createSession(uid);
    const s = (await post(token, "/api/stories/0", { title: "Styled" }, 201)) as { id: number };

    // CRUD: create (list, duplicate-name 409), save, delete
    const st1 = (await post(token, "/api/style-prompts/0", {
      name: "Noir",
      text_md: "STYLE_SENTINEL Noir: short punchy sentences, rain, cynicism.",
    }, 201)) as { id: number };
    const dup = await jpost(token, "/api/style-prompts/0", { name: "noir", text_md: "dup" });
    expect(dup.status).toBe(409);
    const list = (await (await jget(token, "/api/style-prompts")).json()) as {
      styles: { id: number; name: string; text_md: string }[];
    };
    expect(list.styles).toHaveLength(1);
    expect(list.styles[0].name).toBe("Noir");
    // another user's style is invisible and untouchable
    const otherUid = await createUser("stylother", "stylotherp");
    const otherToken = await createSession(otherUid);
    const theirList = (await (await jget(otherToken, "/api/style-prompts")).json()) as {
      styles: unknown[];
    };
    expect(theirList.styles).toHaveLength(0);
    expect((await jpost(otherToken, `/api/style-prompts/${st1.id}/delete`, {})).status).toBe(404);

    await jpost(token, "/api/model/load", { model: fakeLlm.model });
    await waitModelLoaded(token);

    fakeLlm.reset();
    fakeLlm.respondWith({ text: "A styled chapter.", chunks: 1 });
    const callsBefore = fakeLlm.calls.length;
    const { events, status } = await aiAction(token, "generate", { story_id: s.id, style_id: st1.id });
    expect(status).toBe(202);
    expect(events[events.length - 1].type).toBe("done");
    const sys = fakeLlm.calls.slice(callsBefore).map((c) => c.systemText).join("\n");
    expect(sys).toContain("STYLE_SENTINEL");
    expect(sys).toContain("Writing style");

    // works in "generate this chapter" mode too (appended to generate_this)
    await post(token, `/api/stories/${s.id}/chapters/0`, { title: "Ch 1", body_md: "old" }, 201);
    await post(token, "/api/prompts", { action: "generate_this", text_md: "THIS_MODE" });
    fakeLlm.reset();
    fakeLlm.respondWith({ text: "Restyled.", chunks: 1 });
    const callsBefore2 = fakeLlm.calls.length;
    const { events: e2 } = await aiAction(token, "generate", { story_id: s.id, chapter_seq: 1, style_id: st1.id });
    expect(e2[e2.length - 1].type).toBe("done");
    const sys2 = fakeLlm.calls.slice(callsBefore2).map((c) => c.systemText).join("\n");
    expect(sys2).toContain("THIS_MODE");
    expect(sys2).toContain("STYLE_SENTINEL");

    // a style that is not the user's is rejected before the run starts
    const bad = await jpost(token, "/api/ai/generate", { story_id: s.id, style_id: 99999 });
    expect(bad.status).toBe(400);

    // save + delete
    await post(token, `/api/style-prompts/${st1.id}`, { name: "Noir 2", text_md: "updated" });
    const list2 = (await (await jget(token, "/api/style-prompts")).json()) as {
      styles: { id: number; name: string; text_md: string }[];
    };
    expect(list2.styles[0].name).toBe("Noir 2");
    expect(list2.styles[0].text_md).toBe("updated");
    await post(token, `/api/style-prompts/${st1.id}/delete`, {}, 200);
    const list3 = (await (await jget(token, "/api/style-prompts")).json()) as {
      styles: unknown[];
    };
    expect(list3.styles).toHaveLength(0);
  });

  it("thinking tokens stream as 'thought' events, kept out of the saved text (FR-7)", async () => {
    const uid = await createUser("thinker", "thinkpw123");
    const token = await createSession(uid);
    const s = (await post(token, "/api/stories/0", { title: "Thinking" }, 201)) as { id: number };

    await jpost(token, "/api/model/load", { model: fakeLlm.model });
    await waitModelLoaded(token);

    fakeLlm.reset();
    fakeLlm.respondWith({
      text: "The actual chapter body.",
      reasoning: "Let me think about how this scene should go…",
      chunks: 1,
    });
    const { events } = await aiAction(token, "generate", { story_id: s.id });
    const thoughts = events.filter((e) => e.type === "thought");
    expect(thoughts.length).toBeGreaterThan(0);
    expect(thoughts.map((t) => t.text).join("")).toContain("Let me think");
    const done = events[events.length - 1] as { type: string };
    expect(done.type).toBe("done");
    // reasoning is display-only — the saved chapter must be the answer only
    const { rows } = await query<{ body_md: string }>(`SELECT body_md FROM chapter WHERE story_id = $1`, [s.id]);
    expect(rows[0].body_md).toBe("The actual chapter body.");
    expect(rows[0].body_md).not.toContain("Let me think");
  });

  it("POST /api/ai/runs/:id/cancel stops a running action (FR-6)", async () => {
    const uid = await createUser("canceller", "cancelpw123");
    const token = await createSession(uid);
    const s = (await post(token, "/api/stories/0", { title: "Cancelled" }, 201)) as { id: number };

    await jpost(token, "/api/model/load", { model: fakeLlm.model });
    await waitModelLoaded(token);

    // stream slowly enough that the cancel lands mid-stream
    fakeLlm.reset();
    fakeLlm.respondWith({ text: "x".repeat(4000), chunks: 80, delayPerChunkMs: 25 });
    const start = await jpost(token, "/api/ai/generate", { story_id: s.id });
    expect(start.status).toBe(202);
    const { run } = (await start.json()) as { run: { id: number } };

    // the cancel endpoint must reject someone else's run (404)
    const otherUid = await createUser("cancelforeign", "foreignpw12");
    const otherToken = await createSession(otherUid);
    expect((await jpost(otherToken, `/api/ai/runs/${run.id}/cancel`)).status).toBe(404);

    const cancel = await jpost(token, `/api/ai/runs/${run.id}/cancel`);
    expect(cancel.status).toBe(200);
    // cancelling a finished run → 409
    const state = await waitForRun(run.id);
    expect(state.status).toBe("error");
    expect(state.error).toMatch(/cancelled/i);
    expect((await jpost(token, `/api/ai/runs/${run.id}/cancel`)).status).toBe(409);

    // nothing was persisted — the chapter is gone
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM chapter WHERE story_id = $1`,
      [s.id],
    );
    expect(rows[0].n).toBe(0);
    // the user's slot is free again
    const cur = (await (await jget(token, "/api/ai/current")).json()) as { run: unknown };
    expect(cur.run).toBeNull();
  });

  it("GET /api/ai/current names the story (badge shows WHICH story is being written)", async () => {
    const uid = await createUser("badge", "badgepw123");
    const token = await createSession(uid);
    const s = (await post(token, "/api/stories/0", { title: "Badge Story" }, 201)) as { id: number };

    await jpost(token, "/api/model/load", { model: fakeLlm.model });
    await waitModelLoaded(token);

    // drain the fake's response queue — an earlier test's run can leave a
    // queued response behind when it fails BEFORE its chat call (e.g. the
    // final-chapter error above), and the next run would consume it and
    // finish in ms, before this poll could ever catch it
    fakeLlm.reset();
    // spread the chunks so the run stays visibly active (several seconds)
    // even under the load of a full test file — the badge poll (5s in the UI)
    // only has to see it once
    fakeLlm.respondWith({ text: "a chapter", chunks: 12, delayPerChunkMs: 500 });
    const start = await jpost(token, "/api/ai/generate", { story_id: s.id });
    expect(start.status).toBe(202);
    const { run } = (await start.json()) as { run: { id: number } };

    // poll /api/ai/current until the run shows active
    type Cur = { run: { id: number; kind: string; title: string; target: { story_id: number } } | null };
    let cur: Cur = { run: null };
    const t0 = Date.now();
    for (;;) {
      cur = (await (await jget(token, "/api/ai/current")).json()) as Cur;
      if (cur.run) break;
      if (Date.now() - t0 > 10_000) throw new Error("run never appeared in /api/ai/current");
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(cur.run?.id).toBe(run.id);
    expect(cur.run?.kind).toBe("generate");
    expect(cur.run?.target.story_id).toBe(s.id);
    expect(cur.run?.title).toBe("Badge Story");

    await waitForRun(run.id);

    // after finishing: run is null, but `last` (from ai_run) carries the
    // OUTCOME — the AI Monitor flips to "✓ finished" instead of "idle"
    // and keeps showing it after a reload (change request 2026-10-15)
    const after = (await (await jget(token, "/api/ai/current")).json()) as {
      run: unknown;
      last: { id: number; kind: string; status: string; error: string | null; title: string } | null;
    };
    expect(after.run).toBeNull();
    expect(after.last).toMatchObject({
      id: run.id,
      kind: "generate",
      status: "done",
      error: null,
      title: "Badge Story",
    });
  });

  it("T4.4 system prompts: seeded per user×action, editable, persisted", async () => {
    const uid = await createUser("prompter", "promptpw12");
    const token = await createSession(uid);

    let { prompts } = (await (await jget(token, "/api/prompts")).json()) as {
      prompts: { action: string; text_md: string }[];
    };
    expect(prompts.map((p) => p.action).sort()).toEqual([
      "generate",
      "generate_this", // FR-8: second editable prompt for "generate this chapter"
      "image_desc",
      "lore_suggest",
      "style_extract", // change request 2026-10-13: style extraction
      "summarize",
    ]);

    await post(token, "/api/prompts", { action: "summarize", text_md: "Custom summary instructions." });
    const second = (await (await jget(token, "/api/prompts")).json()) as {
      prompts: { action: string; text_md: string }[];
    };
    const summarize = second.prompts.find((p) => p.action === "summarize")!;
    expect(summarize.text_md).toBe("Custom summary instructions.");

    // invalid action rejected
    expect((await jpost(token, "/api/prompts", { action: "nope", text_md: "x" })).status).toBe(400);
  });

  // ---------- change request 2026-10-13: extract style + summarize hint ----------

  it("style-extract: reads the last chapters, streams the style description (done.text)", async () => {
    const uid = await createUser("stylex", "stylepw123");
    const token = await createSession(uid);
    const s = (await post(token, "/api/stories/0", { title: "Stylish" }, 201)) as { id: number };
    await post(token, `/api/stories/${s.id}/chapters/0`, { title: "C1", body_md: "one one" }, 201);
    await post(token, `/api/stories/${s.id}/chapters/0`, { title: "C2", body_md: "two two" }, 201);

    await jpost(token, "/api/model/load", { model: fakeLlm.model });
    await waitModelLoaded(token);

    fakeLlm.reset(); // no leftover canned responses from earlier tests
    fakeLlm.respondWith({ text: "Short, spare sentences. Dark, dry tone.", chunks: 2 });
    const callsBefore = fakeLlm.calls.length;
    const { events, status } = await aiAction(token, "style-extract", { story_id: s.id });
    expect(status).toBe(202);
    expect(fakeLlm.calls.at(-1)?.maxTokens).toBe(20000); // thinking-model floor
    const last = events[events.length - 1] as { type: string; text: string; style?: { id: number; name: string } };
    expect(last.type).toBe("done");
    expect(last.text).toBe("Short, spare sentences. Dark, dry tone.");
    // the prompt carried the chapter bodies, and the seeded style prompt
    const prompt = fakeLlm.calls.slice(callsBefore).map((c) => c.userText).join("\n");
    expect(prompt).toContain("one one");
    expect(prompt).toContain("two two");
    expect(prompt).toContain("CHAPTERS");
    const sys = fakeLlm.calls.slice(callsBefore).map((c) => c.systemText).join("\n");
    expect(sys).toMatch(/writing style/i);
    // the result is auto-saved as a style prompt (must survive navigating
    // away from the story page); the done payload carries the saved id/name
    expect(last.style).toMatchObject({ name: "Stylish's style" });
    let { rows } = await query<{ name: string; text_md: string }>(
      `SELECT name, text_md FROM style_prompt WHERE user_id = $1`,
      [uid],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe("Stylish's style");
    expect(rows[0].text_md).toBe("Short, spare sentences. Dark, dry tone.");
    expect(last.style!.id).toBeGreaterThan(0);

    // re-extracting UPDATES the same row instead of piling up duplicates
    fakeLlm.reset();
    fakeLlm.respondWith({ text: "Updated: drier still.", chunks: 1 });
    const again = await aiAction(token, "style-extract", { story_id: s.id });
    const againLast = again.events[again.events.length - 1] as { type: string; style?: { id: number } };
    expect(againLast.type).toBe("done");
    expect(againLast.style!.id).toBe(last.style!.id);
    ({ rows } = await query<{ name: string; text_md: string }>(
      `SELECT name, text_md FROM style_prompt WHERE user_id = $1`,
      [uid],
    ));
    expect(rows.length).toBe(1);
    expect(rows[0].text_md).toBe("Updated: drier still.");
  });

  it("style-extract with many chapters reads only the LAST three", async () => {
    const uid = await createUser("stylex3", "style3pw12");
    const token = await createSession(uid);
    const s = (await post(token, "/api/stories/0", { title: "LastThree" }, 201)) as { id: number };
    for (const [title, body] of [
      ["C1", "alpha body"],
      ["C2", "beta body"],
      ["C3", "gamma body"],
      ["C4", "delta body"],
      ["C5", "epsilon body"],
    ] as const) {
      await post(token, `/api/stories/${s.id}/chapters/0`, { title, body_md: body }, 201);
    }

    await jpost(token, "/api/model/load", { model: fakeLlm.model });
    await waitModelLoaded(token);

    fakeLlm.reset();
    fakeLlm.respondWith({ text: "A style.", chunks: 1 });
    const callsBefore = fakeLlm.calls.length;
    const { events } = await aiAction(token, "style-extract", { story_id: s.id });
    expect(events[events.length - 1].type).toBe("done");
    const prompt = fakeLlm.calls.slice(callsBefore).map((c) => c.userText).join("\n");
    for (const body of ["gamma body", "delta body", "epsilon body"]) expect(prompt).toContain(body);
    expect(prompt).not.toContain("alpha body");
    expect(prompt).not.toContain("beta body");
  });

  it("style-extract with no chapters → error run", async () => {
    const uid = await createUser("stylex0", "style0pw12");
    const token = await createSession(uid);
    const s = (await post(token, "/api/stories/0", { title: "Empty" }, 201)) as { id: number };

    fakeLlm.reset();
    fakeLlm.respondWith({ text: "unused — no chat call should happen", chunks: 1 });
    const { events } = await aiAction(token, "style-extract", { story_id: s.id });
    const last = events[events.length - 1] as { type: string; message: string };
    expect(last.type).toBe("error");
    expect(last.message).toMatch(/no chapters/i);
  });

  it("thinking model that runs dry (reasoning-only answer) → error says why + where to fix", async () => {
    const uid = await createUser("thinkdry", "thinkpw12");
    const token = await createSession(uid);
    const s = (await post(token, "/api/stories/0", { title: "ThinkDry" }, 201)) as { id: number };
    await post(token, `/api/stories/${s.id}/chapters/0`, { title: "C1", body_md: "a body" }, 201);

    await jpost(token, "/api/model/load", { model: fakeLlm.model });
    await waitModelLoaded(token);

    fakeLlm.reset();
    // the model "thinks" a lot and exhausts its budget before any content
    fakeLlm.respondWith({ reasoning: "pondering… pondering… pondering…", chunks: 1 });
    const { events } = await aiAction(token, "style-extract", { story_id: s.id });
    const last = events[events.length - 1] as { type: string; message: string };
    expect(last.type).toBe("error");
    expect(last.message).toMatch(/thinking/i);
    expect(last.message).toMatch(/context size/i);
    // and nothing was auto-saved
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM style_prompt WHERE user_id = $1`,
      [uid],
    );
    expect(rows[0].n).toBe(0);
    // the monitor's outcome state: /api/ai/current `last` carries the failure
    const after = (await (await jget(token, "/api/ai/current")).json()) as {
      run: unknown;
      last: { status: string; error: string } | null;
    };
    expect(after.run).toBeNull();
    expect(after.last?.status).toBe("error");
    expect(after.last?.error).toMatch(/thinking/i);
  });

  it("user settings: defaults, save, whitelist validation (FR-23a)", async () => {
    const uid = await createUser("cfguser", "cfgpw1234");
    const token = await createSession(uid);

    let { settings } = (await (await jget(token, "/api/settings")).json()) as {
      settings: Record<string, string>;
    };
    expect(settings.summarize_hint).toBe("on");
    expect(settings.summarize_hint_chapters).toBe("3");

    expect((await jpost(token, "/api/settings", { key: "summarize_hint", value: "off" })).status).toBe(200);
    expect((await jpost(token, "/api/settings", { key: "summarize_hint_chapters", value: "4" })).status).toBe(200);
    // validation: unknown key / bad values
    expect((await jpost(token, "/api/settings", { key: "nope", value: "1" })).status).toBe(400);
    expect((await jpost(token, "/api/settings", { key: "summarize_hint", value: "maybe" })).status).toBe(400);
    expect((await jpost(token, "/api/settings", { key: "summarize_hint_chapters", value: "0" })).status).toBe(400);
    expect((await jpost(token, "/api/settings", { key: "summarize_hint_chapters", value: "99" })).status).toBe(400);

    ({ settings } = (await (await jget(token, "/api/settings")).json()) as {
      settings: Record<string, string>;
    });
    expect(settings.summarize_hint).toBe("off");
    expect(settings.summarize_hint_chapters).toBe("4");

    // settings are per user
    const otherUid = await createUser("cfgother", "cfgotherpw12");
    const otherToken = await createSession(otherUid);
    const other = (await (await jget(otherToken, "/api/settings")).json()) as {
      settings: Record<string, string>;
    };
    expect(other.settings.summarize_hint).toBe("on");
    expect(other.settings.summarize_hint_chapters).toBe("3");
  });

  it("story page inline script: JSON locals must NOT be HTML-escaped (bug 2026-10-13)", async () => {
    // `storyTitleJson` was rendered with {{…}} (hbs HTML-escapes it), so the
    // page shipped `const STORY_TITLE = &quot;…&quot;` — a SyntaxError that
    // killed the WHOLE inline script, making every button on the page
    // (incl. the hint banner's "Summarize now") silently do nothing.
    const uid = await createUser("escuser", "escpw12345");
    const token = await createSession(uid);
    const s = (await post(token, "/api/stories/0", { title: 'He said "hi" & left' }, 201)) as { id: number };
    const html = await (
      await fetch(`${baseUrl}/story/${s.id}`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } })
    ).text();
    // the JSON must land in the script verbatim (triple-brace local). If
    // hbs HTML-escaped it ({{…}} instead of {{{…}}}) this line would read
    // `const STORY_TITLE = &quot;…&quot;` — a SyntaxError that kills the
    // whole page script. (No blanket "no entities in script" check: the
    // esc() helper legitimately contains "&amp;"-style strings.)
    expect(html).toContain(String.raw`const STORY_TITLE = "He said \"hi\" & left";`);
    expect(html).not.toContain(String.raw`const STORY_TITLE = &quot;`);
  });

  it("story page shows the summarize hint at the threshold, respects the setting (FR-23a)", async () => {
    const uid = await createUser("hintuser", "hintpw1234");
    const token = await createSession(uid);
    const s = (await post(token, "/api/stories/0", { title: "Hinted" }, 201)) as { id: number };

    const page = async () =>
      (await (await fetch(`${baseUrl}/story/${s.id}`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } })).text());
    // anchor on the banner's element id — the phrase also appears in a JS
    // comment in the inline script, so a plain text match would be wrong
    const hasHint = (html: string) => html.includes('id="summarize-hint"');

    // 2 unsummarized chapters < default threshold 3 → no hint yet
    await post(token, `/api/stories/${s.id}/chapters/0`, { title: "C1", body_md: "a" }, 201);
    await post(token, `/api/stories/${s.id}/chapters/0`, { title: "C2", body_md: "b" }, 201);
    expect(hasHint(await page())).toBe(false);

    // third unsummarized chapter reaches the threshold → hint with a button
    await post(token, `/api/stories/${s.id}/chapters/0`, { title: "C3", body_md: "c" }, 201);
    const html = await page();
    expect(hasHint(html)).toBe(true);
    expect(html).toContain("Summarize now");
    // the offer must be unambiguous: ONE run summarizes ALL of them
    expect(html).toContain("summarize them all now?");
    // bug fix 2026-10-13: "Summarize now" must use the guarded banner
    // handler (model/busy checks + banner dismissal), not the raw toolbar one
    expect(html).toContain('onclick="summarizeFromHint()"');
    // and the stream pane must be PAGE-level, not nested in the chapter
    // pane — the banner streams with no chapter open, and a nested pane
    // rendered the whole run invisible ("clicking did nothing"). The
    // placeholder sits right after the chapter pane's closing tag, so a
    // page-level stream pane comes after it.
    const paneIdx = html.indexOf('id="stream-pane"');
    const placeholderIdx = html.indexOf('id="chapter-placeholder"');
    expect(placeholderIdx).toBeGreaterThanOrEqual(0);
    expect(paneIdx).toBeGreaterThan(placeholderIdx);

    // disabled in settings → no hint
    await post(token, "/api/settings", { key: "summarize_hint", value: "off" });
    expect(hasHint(await page())).toBe(false);

    // re-enabled with a higher threshold than the unsummarized count → no hint
    await post(token, "/api/settings", { key: "summarize_hint", value: "on" });
    await post(token, "/api/settings", { key: "summarize_hint_chapters", value: "10" });
    expect(hasHint(await page())).toBe(false);

    // once the chapters ARE summarized the hint goes away even at threshold 1
    await post(token, "/api/settings", { key: "summarize_hint_chapters", value: "1" });
    expect(hasHint(await page())).toBe(true);
    await query(`UPDATE chapter SET summary_md = 's' WHERE story_id = $1`, [s.id]);
    expect(hasHint(await page())).toBe(false);
  });

  it("story page marks which chapters are already summarized (list badge + pane status)", async () => {
    const uid = await createUser("sumind", "sumindpw12");
    const token = await createSession(uid);
    const s = (await post(token, "/api/stories/0", { title: "Ind" }, 201)) as { id: number };
    await post(token, `/api/stories/${s.id}/chapters/0`, { title: "C1", body_md: "a" }, 201);
    await post(token, `/api/stories/${s.id}/chapters/0`, { title: "C2", body_md: "b" }, 201);

    const page = async () =>
      (await (await fetch(`${baseUrl}/story/${s.id}`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } })).text());

    // nothing summarized yet → no summary badges on any chapter <li>
    // (the inline chapterListHtml JS contains the class string, so check
    // the rendered list items, not the raw page)
    const badgeOn = (html: string, seq: number) => {
      const part = html.split(`<li data-seq="${seq}">`)[1]?.split("</li>")[0];
      return part ? part.includes("badge summary") : false;
    };
    {
      const html = await page();
      expect(badgeOn(html, 1)).toBe(false);
      expect(badgeOn(html, 2)).toBe(false);
    }

    // summarize ch1 → the list shows a badge for exactly that chapter
    await query(`UPDATE chapter SET summary_md = 's' WHERE story_id = $1 AND seq = 1`, [s.id]);
    const html = await page();
    expect(html).toContain("✓ summarized");
    // C1's <li> carries the badge, C2's does not
    expect(badgeOn(html, 1)).toBe(true);
    expect(badgeOn(html, 2)).toBe(false);

    // the open-chapter pane must be able to show the same state
    // (server renders the element; loadChapter fills it from has_summary)
    expect(html).toContain('id="summary-status"');
    expect(html).toContain("function setSummaryStatus(has)");
    const ch1 = (await (await fetch(`${baseUrl}/api/stories/${s.id}/chapters/1`, {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    })).json()) as { has_summary: boolean };
    const ch2 = (await (await fetch(`${baseUrl}/api/stories/${s.id}/chapters/2`, {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    })).json()) as { has_summary: boolean };
    expect(ch1.has_summary).toBe(true);
    expect(ch2.has_summary).toBe(false);
  });
});
