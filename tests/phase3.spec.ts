import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

async function jpost(token: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE}=${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function jget(token: string, path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
}
/** POST asserting an exact status, returning parsed JSON. */
async function post(
  token: string,
  path: string,
  body?: unknown,
  status = 200,
): Promise<Record<string, unknown>> {
  const r = await jpost(token, path, body);
  expect(r.status).toBe(status);
  return (await r.json()) as Record<string, unknown>;
}

describe("Phase 3 — Story core", () => {
  beforeAll(async () => {
    await startServer();
    await wipeTables();
  });
  afterAll(async () => {
    await stopServer();
  });

  it("T3.1 create story (primary universe nullable) + list + save outline", async () => {
    const uid = await createUser("author", "authorpw123");
    const token = await createSession(uid);
    const u1 = (await post(token, "/api/universes", { name: "Star Wars" }, 201)) as unknown as { id: number };

    // story with primary universe
    const s1 = (await post(token, "/api/stories/0", { title: "Rebels", universe_id: u1.id }, 201)) as unknown as { id: number };
    // story with original world (null)
    const s2 = (await post(token, "/api/stories/0", { title: "Original" }, 201)) as unknown as { id: number };

    const { rows } = await query<{ title: string; universe_id: number | null }>(
      `SELECT title, universe_id FROM story WHERE id = $1`,
      [s2.id],
    );
    expect(rows[0].universe_id).toBeNull();

    // save outline
    await post(token, `/api/stories/${s1.id}`, { outline_md: "A farm boy meets a wizard." });
    const { rows: saved } = await query<{ outline_md: string }>(`SELECT outline_md FROM story WHERE id=$1`, [s1.id]);
    expect(saved[0].outline_md).toBe("A farm boy meets a wizard.");

    // list page shows both
    const page = await jget(token, "/story");
    const html = await page.text();
    expect(html).toContain("Rebels");
    expect(html).toContain("Original");
    expect(html).toContain("Star Wars");
    expect(html).toContain("original world");
  });

  it("T3.2 verify: outline links → per-link result (hand-computed)", async () => {
    const uid = await createUser("verifyer", "verifyer123");
    const token = await createSession(uid);

    // build two universes with known entries
    const u1 = (await post(token, "/api/universes", { name: "Marvel" }, 201)) as unknown as { id: number };
    const u2 = (await post(token, "/api/universes", { name: "Tolkien" }, 201)) as unknown as { id: number };
    await post(token, "/api/entries/0", { title: "Infinity Gauntlet", body_md: "Glove.", universe_id: u1.id }, 201);
    await post(token, "/api/entries/0", { title: "One Ring", body_md: "Ring.", universe_id: u2.id }, 201);
    // a universe with NO matching entry (only the universe name matches)
    await post(token, "/api/universes", { name: "D&D" }, 201);

    const s = (await post(token, "/api/stories/0", { title: "Crossover" }, 201)) as unknown as { id: number };
    // outline mixing matched entry, matched universe-name, unmatched, and an http link (ignored)
    const outline =
      "Iron Man wields the [Infinity Gauntlet](infinity gauntlet). " +
      "He crosses into [D&D](d&d) realms. " +
      "A [Mystery Thing](totally-unknown) appears. " +
      "See [docs](https://example.com/x) for more.";
    await post(token, `/api/stories/${s.id}`, { outline_md: outline });

    const res = await post(token, `/api/stories/${s.id}/verify`, {});
    const results = (res.results as { target: string; matched: { title: string; universe: string } | null }[]);

    expect(results).toHaveLength(3); // http link excluded
    const byTarget: Record<string, { matched: { title: string; universe: string } | null }> = {};
    for (const r of results) byTarget[r.target] = r;

    // case-insensitive entry title match
    expect(byTarget["infinity gauntlet"].matched?.title).toBe("Infinity Gauntlet");
    expect(byTarget["infinity gauntlet"].matched?.universe).toBe("Marvel");
    // universe-name match (no entry)
    expect(byTarget["d&d"].matched?.title).toBe("D&D");
    expect(byTarget["d&d"].matched?.universe).toBe("D&D");
    // not found
    expect(byTarget["totally-unknown"].matched).toBeNull();
  });

  it("T3.2 verify isolation: user A cannot verify user B's story", async () => {
    const uidA = await createUser("va", "vapw123456");
    const uidB = await createUser("vb", "vbpw123456");
    const tA = await createSession(uidA);
    const tB = await createSession(uidB);
    const s = (await post(tB, "/api/stories/0", { title: "B's story" }, 201)) as unknown as { id: number };
    const res = await jpost(tA, `/api/stories/${s.id}/verify`, {});
    expect(res.status).toBe(404);
  });

  it("T3.3 chapter CRUD + finalize story → readable on Shelf", async () => {
    const uid = await createUser("shelver", "shelver1234");
    const token = await createSession(uid);
    const s = (await post(token, "/api/stories/0", { title: "Book One" }, 201)) as unknown as { id: number };

    // create chapters 1 and 2 (seq 0 = append)
    const c1 = (await post(token, `/api/stories/${s.id}/chapters/0`, { title: "Ch 1", body_md: "Start." }, 201)) as unknown as { seq: number };
    const c2 = (await post(token, `/api/stories/${s.id}/chapters/0`, { title: "Ch 2", body_md: "Middle." }, 201)) as unknown as { seq: number };
    expect(c1.seq).toBe(1);
    expect(c2.seq).toBe(2);

    // save (overwrite) chapter 1
    await post(token, `/api/stories/${s.id}/chapters/1`, { title: "Ch 1", body_md: "Start (revised)." });
    const { rows } = await query<{ body_md: string }>(`SELECT body_md FROM chapter WHERE story_id=$1 AND seq=1`, [s.id]);
    expect(rows[0].body_md).toBe("Start (revised).");

    // load a chapter
    const load = await jget(token, `/api/stories/${s.id}/chapters/2`);
    expect(load.status).toBe(200);
    expect(((await load.json()) as { title: string }).title).toBe("Ch 2");

    // story page lists chapters
    const page = await jget(token, `/story/${s.id}`);
    const html = await page.text();
    expect(html).toContain("Ch 1");
    expect(html).toContain("Ch 2");

    // story not yet on shelf
    const shelfBefore = await jget(token, "/shelf");
    expect(await shelfBefore.text()).not.toContain("Book One");

    // finalize story
    await post(token, `/api/stories/${s.id}/finalize`, {});
    const { rows: st } = await query<{ status: string }>(`SELECT status FROM story WHERE id=$1`, [s.id]);
    expect(st[0].status).toBe("finalized");
    const { rows: chs } = await query<{ status: string }>(`SELECT status FROM chapter WHERE story_id=$1`, [s.id]);
    expect(chs.every((c) => c.status === "final")).toBe(true);

    // shelf now lists it + reader renders markdown
    const shelf = await jget(token, "/shelf");
    expect(await shelf.text()).toContain("Book One");
    const reader = await jget(token, `/shelf/${s.id}`);
    const rhtml = await reader.text();
    expect(rhtml).toContain("Ch 1");
    expect(rhtml).toContain("<p>Start (revised).</p>");
  });

  it("T3.3 finalize chapter individually; shelf excludes unfinalized story", async () => {
    const uid = await createUser("part", "partpw1234");
    const token = await createSession(uid);
    const s = (await post(token, "/api/stories/0", { title: "Partial" }, 201)) as unknown as { id: number };
    await post(token, `/api/stories/${s.id}/chapters/0`, { title: "C1", body_md: "x" }, 201);

    // finalize just chapter 1
    await post(token, `/api/stories/${s.id}/chapters/1/finalize`, {});
    const { rows } = await query<{ status: string }>(`SELECT status FROM chapter WHERE story_id=$1 AND seq=1`, [s.id]);
    expect(rows[0].status).toBe("final");

    // story still draft → not on shelf
    const shelf = await jget(token, "/shelf");
    expect(await shelf.text()).not.toContain("Partial");
  });

  it("T3.3 chapter isolation: user B cannot read/touch user A's chapters", async () => {
    const uidA = await createUser("ca", "capw123456");
    const uidB = await createUser("cb", "cbpw123456");
    const tA = await createSession(uidA);
    const tB = await createSession(uidB);
    const s = (await post(tA, "/api/stories/0", { title: "Secret" }, 201)) as unknown as { id: number };
    await post(tA, `/api/stories/${s.id}/chapters/0`, { title: "C1", body_md: "x" }, 201);

    expect((await jget(tB, `/api/stories/${s.id}/chapters/1`)).status).toBe(404);
    expect((await jpost(tB, `/api/stories/${s.id}/chapters/1`, { title: "HACK", body_md: "" })).status).toBe(404);
    expect((await jget(tB, `/story/${s.id}`)).status).toBe(404);
  });

  it("FR-3 chapter preview: renders the UNsaved pane text Shelf-style; ownership kept", async () => {
    const uidA = await createUser("preview", "previewpw1");
    const tA = await createSession(uidA);
    const s = (await post(tA, "/api/stories/0", { title: "Preview" }, 201)) as unknown as { id: number };
    // a SAVED chapter, but the preview must reflect the (different) pane text
    await post(tA, `/api/stories/${s.id}/chapters/0`, { title: "C1", body_md: "saved body" }, 201);

    const res = await post(tA, `/api/stories/${s.id}/preview-chapter`, {
      title: "C1",
      body_md: "## Draft heading\n\n**bold** draft text",
    });
    expect(res.html).toContain("<h2>Draft heading</h2>");
    expect(res.html).toContain("<strong>bold</strong>");
    expect(res.html).toContain("draft text");
    expect(res.html).not.toContain("saved body");
    // "## Draft heading" (3) + "**bold** draft text" (3) = 6 words
    expect(res.word_count).toBe(6);

    // title required
    expect((await jpost(tA, `/api/stories/${s.id}/preview-chapter`, { body_md: "x" })).status).toBe(400);
    // other user's story → 404
    const uidB = await createUser("previewb", "previewb12");
    const tB = await createSession(uidB);
    expect((await jpost(tB, `/api/stories/${s.id}/preview-chapter`, { title: "C1", body_md: "x" })).status).toBe(404);
  });

  it("FR-4 chapter list API: GET /api/stories/:id/chapters feeds the no-reload save", async () => {
    const uid = await createUser("lister", "listpw1234");
    const token = await createSession(uid);
    const s = (await post(token, "/api/stories/0", { title: "Listed" }, 201)) as unknown as { id: number };
    await post(token, `/api/stories/${s.id}/chapters/0`, { title: "C1", body_md: "a" }, 201);
    await post(token, `/api/stories/${s.id}/chapters/0`, { title: "C2", body_md: "b" }, 201);

    const list = (await (await jget(token, `/api/stories/${s.id}/chapters`)).json()) as {
      chapters: { seq: number; title: string; status: string }[];
    };
    expect(list.chapters).toHaveLength(2);
    expect(list.chapters.map((c) => c.seq)).toEqual([1, 2]);
    expect(list.chapters[0].title).toBe("C1");

    // save (no-reload flow: pane stays open, list refreshes) — then the list
    // shows the updated title, proving the endpoint is save-refreshable
    await post(token, `/api/stories/${s.id}/chapters/1`, { title: "C1 renamed", body_md: "a2" });
    const list2 = (await (await jget(token, `/api/stories/${s.id}/chapters`)).json()) as {
      chapters: { title: string }[];
    };
    expect(list2.chapters[0].title).toBe("C1 renamed");

    // wrong user → 404
    const uidB = await createUser("listerb", "listerb123");
    const tB = await createSession(uidB);
    expect((await jget(tB, `/api/stories/${s.id}/chapters`)).status).toBe(404);
  });
});
