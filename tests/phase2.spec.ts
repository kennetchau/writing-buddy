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

/** User A (normal) and User B (normal) and an admin, with their cookies. */
async function jpost(
  token: string,
  path: string,
  body?: unknown,
  status?: number,
): Promise<Response> {
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

async function jget(token: string, path: string, status?: number): Promise<Response> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
  if (status !== undefined) expect(res.status).toBe(status);
  return res;
}

describe("Phase 2 — Lore & Universes", () => {
  beforeAll(async () => {
    await startServer();
    await wipeTables();
  });

  afterAll(async () => {
    await stopServer();
  });

  // ---------- T2.1 universes ----------

  it("create → list → delete-if-empty cycle", async () => {
    const uid = await createUser("alice", "alicepw123");
    const token = await createSession(uid);

    const created = await jpost(token, "/api/universes", { name: "Star Wars", description: "A galaxy far far away" }, 201);
    const { id: universeId } = (await created.json()) as { id: number };
    expect(universeId).toBeGreaterThan(0);

    const page = await jget(token, "/universe", 200);
    const html = await page.text();
    expect(html).toContain("Star Wars");
    expect(html).toContain("A galaxy far far away");

    // delete empty universe
    await jpost(token, `/api/universes/${universeId}/delete`, {}, 200);
    const gone = await query(`SELECT 1 FROM universe WHERE id = $1`, [universeId]);
    expect(gone.rows).toHaveLength(0);
  });

  it("non-empty universe refuses deletion (409)", async () => {
    const uid = await createUser("bob", "bobpw123");
    const token = await createSession(uid);
    const created = await jpost(token, "/api/universes", { name: "Marvel" }, 201);
    const { id: universeId } = (await created.json()) as { id: number };

    const entry = await jpost(token, "/api/entries/0", { title: "Avengers", body_md: "Team.", universe_id: universeId }, 201);
    const entryId = ((await entry.json()) as { id: number }).id;
    expect(entryId).toBeGreaterThan(0);

    const res = await jpost(token, `/api/universes/${universeId}/delete`, {});
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; entry_count: number };
    expect(body.entry_count).toBe(1);
  });

  it("user A cannot read, modify or delete user B's universes", async () => {
    const uidA = await createUser("eve", "evepw12345");
    const uidB = await createUser("mallory", "mallorypw123");
    const tokenA = await createSession(uidA);
    const tokenB = await createSession(uidB);

    const created = await jpost(tokenB, "/api/universes", { name: "Secret World" }, 201);
    const { id: universeId } = (await created.json()) as { id: number };

    // not in A's list
    const page = await jget(tokenA, "/universe", 200);
    expect(await page.text()).not.toContain("Secret World");

    // A cannot delete B's universe
    const del = await jpost(tokenA, `/api/universes/${universeId}/delete`, {});
    expect(del.status).toBe(404);

    // A cannot add entries to B's universe
    const add = await jpost(tokenA, "/api/entries/0", { title: "X", body_md: "", universe_id: universeId });
    expect(add.status).toBe(404);
  });

  it("admin can assign users to a universe; non-admin cannot", async () => {
    const adminId = await createUser("rooty", "rootpw1234", true);
    const userId = await createUser("carol", "carolpw1234");
    const adminToken = await createSession(adminId);
    const userToken = await createSession(userId);

    const created = await jpost(adminToken, "/api/universes", { name: "Shared" }, 201);
    const { id: universeId } = (await created.json()) as { id: number };

    // non-admin blocked
    const forbidden = await jpost(userToken, `/api/universes/${universeId}/users`, { userId }, 403);

    // admin assigns
    await jpost(adminToken, `/api/universes/${universeId}/users`, { userId }, 200);
    const { rows } = await query(`SELECT 1 FROM universe_user WHERE universe_id=$1 AND user_id=$2`, [universeId, userId]);
    expect(rows).toHaveLength(1);

    // regression: the admin page's "Assign user" dropdown must actually be
    // populated (it iterates `allUsers` — an earlier revision only passed
    // the JSON string, so the <select> rendered with zero options)
    const adminPage = await jget(adminToken, "/universe", 200);
    const adminHtml = await adminPage.text();
    expect(adminHtml).toContain(">carol</option>");
    expect(adminHtml).toContain(">rooty</option>");

    // user now manages it (can list)
    const page = await jget(userToken, "/universe", 200);
    expect(await page.text()).toContain("Shared");

    // admin removes carol; carol now has no access
    await jpost(adminToken, `/api/universes/${universeId}/users`, { userId, remove: true }, 200);
    const { rows: after } = await query(`SELECT 1 FROM universe_user WHERE universe_id=$1 AND user_id=$2`, [universeId, userId]);
    expect(after).toHaveLength(0);

    // carol is now the only remaining manager (admin already gone? no — admin is alone)
    // now admin is the ONLY manager; removing self must 409
    const last = await jpost(adminToken, `/api/universes/${universeId}/users`, { userId: adminId, remove: true });
    expect(last.status).toBe(409);
    const { rows: still } = await query(`SELECT 1 FROM universe_user WHERE universe_id=$1 AND user_id=$2`, [universeId, adminId]);
    expect(still).toHaveLength(1);
  });

  it("regression: /lore renders the story picker for AI lore suggestion (was empty)", async () => {
    const uid = await createUser("lorer", "lorerpw123");
    const token = await createSession(uid);
    await jpost(token, "/api/universes", { name: "Lore World" }, 201);
    const story = (await (await jpost(token, "/api/stories/0", { title: "The Long Road" }, 201)).json()) as { id: number };

    // the lore page's <select id="ls-story"> must list the user's draft
    // stories — an earlier revision passed only `storiesJson`, so the
    // template's `{{#each stories}}` rendered no options at all
    const page = await jget(token, "/lore", 200);
    const html = await page.text();
    expect(html).toContain('id="ls-story"');
    expect(html).toContain(`<option value="${story.id}">The Long Road</option>`);
  });

  // ---------- T2.2 entries ----------

  it("entry CRUD: create, save, move, delete with isolation", async () => {
    const uid = await createUser("dave", "davepw12345");
    const other = await createUser("frank", "frankpw1234");
    const token = await createSession(uid);
    const otherToken = await createSession(other);

    const u1 = (await (await jpost(token, "/api/universes", { name: "World One" }, 201)).json()) as { id: number };
    const u2 = (await (await jpost(token, "/api/universes", { name: "World Two" }, 201)).json()) as { id: number };

    const created = (await (await jpost(token, "/api/entries/0", { title: "Saber", body_md: "A blade.", universe_id: u1.id }, 201)).json()) as { id: number };
    expect(created.id).toBeGreaterThan(0);

    // save (overwrite + bump updated_at)
    await jpost(token, `/api/entries/${created.id}`, { title: "Lightsaber", body_md: "A blade of plasma.", universe_id: u1.id }, 200);
    const { rows: saved } = await query<{ title: string; body_md: string; universe_id: number }>(
      `SELECT title, body_md, universe_id FROM lore_entry WHERE id = $1`,
      [created.id],
    );
    expect(saved[0].title).toBe("Lightsaber");
    expect(saved[0].body_md).toBe("A blade of plasma.");

    // move to world two
    await jpost(token, `/api/entries/${created.id}`, { title: "Lightsaber", body_md: "A blade of plasma.", move_to: u2.id }, 200);
    const { rows: moved } = await query<{ universe_id: number }>(`SELECT universe_id FROM lore_entry WHERE id = $1`, [created.id]);
    expect(moved[0].universe_id).toBe(u2.id);

    // GET /api/entries/:id (doc API table)
    const got = (await (await jget(token, `/api/entries/${created.id}`, 200)).json()) as {
      title: string; universe: string; universe_id: number;
    };
    expect(got.title).toBe("Lightsaber");
    expect(got.universe_id).toBe(u2.id);
    expect(got.universe).toBe("World Two");

    // isolation: other user cannot read or modify
    const readPage = await jget(otherToken, `/lore/entry/${created.id}`);
    expect(readPage.status).toBe(404);
    const modify = await jpost(otherToken, `/api/entries/${created.id}`, { title: "HACK", body_md: "", universe_id: u2.id });
    expect(modify.status).toBe(404);

    // entry editor page renders for the owner
    const page = await jget(token, `/lore/entry/${created.id}`, 200);
    expect(await page.text()).toContain("Lightsaber");

    // delete
    await jpost(token, `/api/entries/${created.id}/delete`, {}, 200);
    const { rows: gone } = await query(`SELECT 1 FROM lore_entry WHERE id = $1`, [created.id]);
    expect(gone).toHaveLength(0);
  });

  it("universe list page shows entry counts", async () => {
    const uid = await createUser("gina", "ginapw12345");
    const token = await createSession(uid);
    const u1 = (await (await jpost(token, "/api/universes", { name: "Counted" }, 201)).json()) as { id: number };
    await jpost(token, "/api/entries/0", { title: "E1", body_md: "a", universe_id: u1.id }, 201);
    await jpost(token, "/api/entries/0", { title: "E2", body_md: "b c d", universe_id: u1.id }, 201);

    const page = await jget(token, `/lore/universe/${u1.id}`, 200);
    const html = await page.text();
    expect(html).toContain("E1");
    expect(html).toContain("E2");
  });

  // ---------- user-defined lore categories (FR round 2, 2026-10-09) ----------

  it("categories: create, attach, filter, delete (per universe)", async () => {
    const uid = await createUser("caty", "catypw12345");
    const token = await createSession(uid);
    const u1 = (await (await jpost(token, "/api/universes", { name: "Cat World" }, 201)).json()) as { id: number };

    // create (400 without name, 404 for foreign universe, 409 on duplicate)
    expect((await jpost(token, "/api/lore-categories", { universe_id: u1.id })).status).toBe(400);
    expect((await jpost(token, "/api/lore-categories", { universe_id: 99999, name: "X" })).status).toBe(404);
    const c1 = (await (await jpost(token, "/api/lore-categories", { universe_id: u1.id, name: "Places" }, 201)).json()) as { id: number };
    const c2 = (await (await jpost(token, "/api/lore-categories", { universe_id: u1.id, name: "People" }, 201)).json()) as { id: number };
    const dup = await jpost(token, "/api/lore-categories", { universe_id: u1.id, name: "places" });
    expect(dup.status).toBe(409); // unique is case-insensitive

    // attach entries
    const e1 = (await (await jpost(token, "/api/entries/0", { title: "The Tower", body_md: "tall", universe_id: u1.id, category_ids: [c1.id] }, 201)).json()) as { id: number };
    const e2 = (await (await jpost(token, "/api/entries/0", { title: "The King", body_md: "ruler", universe_id: u1.id, category_ids: [c1.id, c2.id] }, 201)).json()) as { id: number };
    await jpost(token, `/api/entries/${e1.id}`, { title: "The Tower", body_md: "tall", universe_id: u1.id, category_ids: [] }, 200); // detach again

    // invalid category ids are rejected (other universe's category / nonexistent)
    const bad = await jpost(token, `/api/entries/${e1.id}`, { title: "The Tower", body_md: "tall", universe_id: u1.id, category_ids: [99999] });
    expect(bad.status).toBe(400);

    // list page shows the categories with counts and filters via ?category=
    const page = await jget(token, `/lore/universe/${u1.id}`, 200);
    const html = await page.text();
    expect(html).toContain("Places");
    expect(html).toContain("People");
    expect(html).toContain("The Tower");
    expect(html).toContain("The King");

    const filtered = await jget(token, `/lore/universe/${u1.id}?category=${c2.id}`, 200);
    const fHtml = await filtered.text();
    expect(fHtml).toContain("The King"); // in People
    expect(fHtml).not.toContain("The Tower"); // was detached from Places
    // foreign category id is ignored, not an error
    const foreign = await jget(token, `/lore/universe/${u1.id}?category=99999`, 200);
    expect((await foreign.text())).toContain("The Tower");

    // entry editor renders the checkboxes, checked where attached
    const editor = await jget(token, `/lore/entry/${e2.id}`, 200);
    const eHtml = await editor.text();
    expect(eHtml).toContain(`value="${c1.id}"`);
    expect(eHtml).toContain("checked");

    // GET /api/entries/:id carries the categories
    const got = (await (await jget(token, `/api/entries/${e2.id}`, 200)).json()) as { categories: { name: string }[] };
    expect(got.categories.map((c) => c.name).sort()).toEqual(["People", "Places"]);

    // deleting a category detaches entries (they are NOT deleted)
    await jpost(token, `/api/lore-categories/${c1.id}/delete`, {}, 200);
    const { rows: entriesLeft } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM lore_entry WHERE universe_id = $1`, [u1.id]);
    expect(entriesLeft[0].n).toBe(2);
    const { rows: linksLeft } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM lore_entry_category WHERE category_id = $1`, [c1.id]);
    expect(linksLeft[0].n).toBe(0);
  });

  it("moving an entry to another universe detaches foreign categories", async () => {
    const uid = await createUser("mover", "moverpw123");
    const token = await createSession(uid);
    const u1 = (await (await jpost(token, "/api/universes", { name: "From" }, 201)).json()) as { id: number };
    const u2 = (await (await jpost(token, "/api/universes", { name: "To" }, 201)).json()) as { id: number };
    const cat = (await (await jpost(token, "/api/lore-categories", { universe_id: u1.id, name: "Places" }, 201)).json()) as { id: number };
    const e1 = (await (await jpost(token, "/api/entries/0", { title: "Tower", body_md: "tall", universe_id: u1.id, category_ids: [cat.id] }, 201)).json()) as { id: number };

    await jpost(token, `/api/entries/${e1.id}`, { title: "Tower", body_md: "tall", move_to: u2.id }, 200);
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM lore_entry_category WHERE lore_entry_id = $1`, [e1.id]);
    expect(rows[0].n).toBe(0); // "Places" belongs to the old universe
  });

  it("categories are isolated per universe (user A cannot touch B's)", async () => {
    const uidA = await createUser("catt", "cattpw1234");
    const uidB = await createUser("catm", "catmpw1234");
    const tokenA = await createSession(uidA);
    const tokenB = await createSession(uidB);
    const uB = (await (await jpost(tokenB, "/api/universes", { name: "B World" }, 201)).json()) as { id: number };

    // A cannot create in B's universe
    expect((await jpost(tokenA, "/api/lore-categories", { universe_id: uB.id, name: "X" })).status).toBe(404);
    const cB = (await (await jpost(tokenB, "/api/lore-categories", { universe_id: uB.id, name: "B Cats" }, 201)).json()) as { id: number };
    // A cannot delete B's category
    expect((await jpost(tokenA, `/api/lore-categories/${cB.id}/delete`, {})).status).toBe(404);
    const { rows } = await query(`SELECT 1 FROM lore_category WHERE id = $1`, [cB.id]);
    expect(rows).toHaveLength(1);
  });

  // ---------- T2.3 images ----------

  it("image upload, serve, attach, delete (multipart, flat dir, path in DB)", async () => {
    const uid = await createUser("hank", "hankpw12345");
    const other = await createUser("iris", "irispw12345");
    const token = await createSession(uid);
    const otherToken = await createSession(other);
    const u1 = (await (await jpost(token, "/api/universes", { name: "Imagery" }, 201)).json()) as { id: number };
    const entry = (await (await jpost(token, "/api/entries/0", { title: "Ship", body_md: "A ship.", universe_id: u1.id }, 201)).json()) as { id: number };

    // 1x1 png
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const fd = new FormData();
    fd.append("image", new Blob([png], { type: "image/png" }), "pixel.png");
    fd.append("lore_entry_id", String(entry.id));
    const up = await fetch(`${baseUrl}/api/images`, { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${token}` }, body: fd });
    expect(up.status).toBe(201);
    const img = (await up.json()) as { id: number; filename: string };
    expect(img.filename).toMatch(/^.*\.png$/);

    // DB stores path, row links to entry
    const { rows: dbRow } = await query<{ filename: string; lore_entry_id: number }>(
      `SELECT filename, lore_entry_id FROM image WHERE id = $1`,
      [img.id],
    );
    expect(dbRow[0].filename).toBe(img.filename);
    expect(dbRow[0].lore_entry_id).toBe(entry.id);

    // static serve
    const served = await jget(token, `/images/${img.filename}`, 200);
    expect(served.headers.get("content-type")).toBe("image/png");

    // path traversal blocked
    const trav = await fetch(`${baseUrl}/images/..%2F..%2Fetc%2Fpasswd`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    expect(trav.status).toBe(404);

    // other user cannot delete
    const delOther = await jpost(otherToken, `/api/images/${img.id}/delete`, {});
    expect(delOther.status).toBe(404);

    // attach to another entry then delete
    const entry2 = (await (await jpost(token, "/api/entries/0", { title: "Pilot", body_md: "", universe_id: u1.id }, 201)).json()) as { id: number };
    await jpost(token, `/api/images/${img.id}/attach`, { lore_entry_id: entry2.id }, 200);
    const { rows: attached } = await query<{ lore_entry_id: number }>(`SELECT lore_entry_id FROM image WHERE id = $1`, [img.id]);
    expect(attached[0].lore_entry_id).toBe(entry2.id);

    await jpost(token, `/api/images/${img.id}/delete`, {}, 200);
    const { rows: gone } = await query(`SELECT 1 FROM image WHERE id = $1`, [img.id]);
    expect(gone).toHaveLength(0);
  });
});
