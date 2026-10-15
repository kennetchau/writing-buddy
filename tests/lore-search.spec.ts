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

/**
 * CR round 3 (FR-13): GET /api/lore/search — the live `/keyword` lore
 * search behind the outline editor's autocomplete.
 */
async function jpost(token: string, path: string, body?: unknown, status?: number): Promise<Response> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (status !== undefined) expect(res.status).toBe(status);
  return res;
}

interface SearchResp {
  q: string;
  results: { id: number; title: string; universe: string; universe_id: number; snippet: string }[];
}

async function search(token: string, q: string, limit?: number): Promise<SearchResp> {
  const res = await fetch(
    `${baseUrl}/api/lore/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ""}`,
    { headers: { cookie: `${SESSION_COOKIE}=${token}` } },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as SearchResp;
}

describe("CR-3 /api/lore/search (outline `/keyword` autocomplete)", () => {
  let alice: string;
  let bob: string;
  let swUniverse: number;
  let marvelUniverse: number;

  beforeAll(async () => {
    await startServer();
    await wipeTables();

    const aliceId = await createUser("alice", "alicepw123");
    alice = await createSession(aliceId);
    const bobId = await createUser("bob", "bobpw123");
    bob = await createSession(bobId);

    const sw = await jpost(alice, "/api/universes", { name: "Star Wars" }, 201);
    swUniverse = ((await sw.json()) as { id: number }).id;
    await jpost(
      alice,
      "/api/entries/0",
      {
        title: "Star Destroyer",
        body_md: "A capital warship of the Imperial Navy. Wedge-shaped, fearsome, lots of turbolaser turrets.",
        universe_id: swUniverse,
      },
      201,
    );
    await jpost(
      alice,
      "/api/entries/0",
      {
        title: "X-wing Starfighter",
        body_md: "A Rebel starfighter. The R2 unit keeps the starboard deflector shield up.",
        universe_id: swUniverse,
      },
      201,
    );
    await jpost(
      alice,
      "/api/entries/0",
      {
        title: "Lightsaber",
        body_md: "A focused plasma blade contained in a magnetic field.",
        universe_id: swUniverse,
      },
      201,
    );

    const mv = await jpost(bob, "/api/universes", { name: "Marvel" }, 201);
    marvelUniverse = ((await mv.json()) as { id: number }).id;
    await jpost(
      bob,
      "/api/entries/0",
      {
        title: "Avengers",
        body_md: "Earth's mightiest heroes. Assembled when the threat is big enough.",
        universe_id: marvelUniverse,
      },
      201,
    );
  });

  afterAll(async () => {
    await stopServer();
  });

  it("prefix match: /star finds every entry with star- words, multi-token narrows", async () => {
    const one = await search(alice, "star");
    const titles = one.results.map((r) => r.title);
    expect(titles).toContain("Star Destroyer");
    expect(titles).toContain("X-wing Starfighter");
    expect(titles).not.toContain("Lightsaber");
    // title hit ranks above body-only hits
    expect(one.results[0].title).toBe("Star Destroyer");

    const two = await search(alice, "star destroyer");
    expect(two.results.map((r) => r.title)).toEqual(["Star Destroyer"]);
  });

  it("substring fallback: a fragment INSIDE a token still matches (venge → Avengers)", async () => {
    const r = await search(bob, "venge");
    expect(r.results.map((x) => x.title)).toContain("Avengers");
    // and a snippet is provided from the body
    expect(r.results[0].snippet.length).toBeGreaterThan(0);
  });

  it("body-text match: searching a word from the body surfaces the entry", async () => {
    const r = await search(alice, "turbolaser");
    expect(r.results.map((x) => x.title)).toContain("Star Destroyer");
    expect(r.results[0].snippet.toLowerCase()).toContain("turbolaser");
  });

  it("empty q = browse by title; limit honored and clamped to 20", async () => {
    const two = await search(alice, "", 2);
    expect(two.results).toHaveLength(2);
    expect(two.results.map((r) => r.title)).toEqual(["Lightsaber", "Star Destroyer"]);

    const many = await search(alice, "", 999);
    expect(many.results.length).toBeLessThanOrEqual(20);
  });

  it("isolation: neither user sees the other's lore", async () => {
    const aliceSees = await search(alice, "avenger");
    expect(aliceSees.results).toHaveLength(0);
    const bobSees = await search(bob, "star");
    expect(bobSees.results).toHaveLength(0);
    // …and the universe name on results is the entry's own universe
    const sw = await search(alice, "lightsaber");
    expect(sw.results[0].universe).toBe("Star Wars");
    expect(sw.results[0].universe_id).toBe(swUniverse);
  });

  it("requires a session (401)", async () => {
    const res = await fetch(`${baseUrl}/api/lore/search?q=star`);
    expect(res.status).toBe(401);
  });

  it("wildcard-ish queries are escaped, not errors", async () => {
    const r = await search(alice, "%_100%");
    expect(r.results).toHaveLength(0);
    // a query that would break to_tsquery syntax is sanitized away
    const r2 = await search(alice, 'a"b & c | !');
    expect(Array.isArray(r2.results)).toBe(true);
  });

  // the endpoint is what the client bundle calls — sanity-check the row
  // shape once at the DB level too (id/title/universe_id/snippet keys only)
  it("returns only the dropdown's fields (no body_md leak)", async () => {
    const res = await fetch(`${baseUrl}/api/lore/search?q=star`, {
      headers: { cookie: `${SESSION_COOKIE}=${alice}` },
    });
    const j = (await res.json()) as { results: Record<string, unknown>[] };
    for (const row of j.results) {
      expect(Object.keys(row).sort()).toEqual(["id", "snippet", "title", "universe", "universe_id"]);
    }
    // and the raw table is untouched by searches
    const { rows } = await query(`SELECT count(*)::int AS n FROM lore_entry`);
    expect(rows[0].n).toBe(4);
    expect(marvelUniverse).toBeGreaterThan(0);
  });
});
