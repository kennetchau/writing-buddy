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

describe("Phase 5 — T5.1 Admin user management", () => {
  beforeAll(async () => {
    await startServer();
    await wipeTables();
  });
  afterAll(async () => {
    await stopServer();
  });

  it("non-admin gets 403 on admin API + page", async () => {
    const uid = await createUser("pleb", "plebpw1234");
    const token = await createSession(uid);
    const adminId = await createUser("boss", "bosspw1234", true);
    const adminTok = await createSession(adminId);

    expect((await jpost(token, "/api/admin/users", { username: "x1", password: "123456" })).status).toBe(403);
    expect((await jget(token, "/admin/users")).status).toBe(403);
    // admin can reach the page
    const page = await jget(adminTok, "/admin/users");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("boss");
  });

  it("non-admin home and unknown pages are NOT gated by the admin router", async () => {
    // regression: adminRouter.use(requireAdmin) (unscoped) ran for EVERY
    // request passing through the "/"-mounted router, so a non-admin GET /
    // 403'd "admin only" instead of redirecting to /story.
    const uid = await createUser("pleb2", "plebpw1234");
    const token = await createSession(uid);
    const home = await fetch(`${baseUrl}/`, { headers: { cookie: `${SESSION_COOKIE}=${token}` }, redirect: "manual" });
    expect(home.status).toBe(302);
    expect(home.headers.get("location")).toBe("/story");
    // unknown pages fall through to the 404 view, not "admin only"
    const missing = await jget(token, "/definitely-not-a-page");
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain("admin only");
  });

  it("add user with temp password (validates + uniqueness)", async () => {
    const adminId = await createUser("root2", "rootpw1234", true);
    const token = await createSession(adminId);

    const created = await post(token, "/api/admin/users", { username: "tempie", password: "temp123" }, 201);
    expect(created.id).toBeGreaterThan(0);

    // the new user can log in with the temp password
    const login = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "tempie", password: "temp123" }),
    });
    expect(login.status).toBe(200);

    // duplicate → 409
    expect((await jpost(token, "/api/admin/users", { username: "tempie", password: "temp123" })).status).toBe(409);
    // bad username → 400
    expect((await jpost(token, "/api/admin/users", { username: "x", password: "temp123" })).status).toBe(400);
    // short password → 400
    expect((await jpost(token, "/api/admin/users", { username: "ok_name", password: "123" })).status).toBe(400);
  });

  it("reset password works for the target user", async () => {
    const adminId = await createUser("root3", "rootpw1234", true);
    const uid = await createUser("pwuser", "oldpw12345");
    const token = await createSession(adminId);

    await post(token, `/api/admin/users/${uid}/reset-password`, { password: "newpw12345" });

    const bad = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "pwuser", password: "oldpw12345" }),
    });
    expect(bad.status).toBe(401);
    const good = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "pwuser", password: "newpw12345" }),
    });
    expect(good.status).toBe(200);
  });

  it("toggle admin flag (not on self)", async () => {
    const adminId = await createUser("root4", "rootpw1234", true);
    const uid = await createUser("tog", "togpw12345");
    const token = await createSession(adminId);

    const res = (await post(token, `/api/admin/users/${uid}/toggle-admin`, {})) as { is_admin: boolean };
    expect(res.is_admin).toBe(true);
    const res2 = (await post(token, `/api/admin/users/${uid}/toggle-admin`, {})) as { is_admin: boolean };
    expect(res2.is_admin).toBe(false);

    // self-toggle blocked
    expect((await jpost(token, `/api/admin/users/${adminId}/toggle-admin`, {})).status).toBe(409);
  });

  it("delete user cascades their content + typed-confirm gate", async () => {
    const adminId = await createUser("root5", "rootpw1234", true);
    const victim = await createUser("doomed", "doom123456");
    const token = await createSession(adminId);
    const vToken = await createSession(victim);

    // victim builds content: a story w/ chapters (cascades via user_id FK)
    // and a universe+lore entry (owned via universe_user — survives, loses manager)
    const u1 = (await post(vToken, "/api/universes", { name: "VWorld" }, 201)) as { id: number };
    await post(vToken, "/api/entries/0", { title: "VE", body_md: "x", universe_id: u1.id }, 201);
    const s = (await post(vToken, "/api/stories/0", { title: "VS" }, 201)) as { id: number };
    await post(vToken, `/api/stories/${s.id}/chapters/0`, { title: "C", body_md: "y" }, 201);

    // delete without confirm → 409, nothing deleted
    expect((await jpost(token, `/api/admin/users/${victim}/delete`, {})).status).toBe(409);
    expect((await jpost(token, `/api/admin/users/${victim}/delete`, { confirm: "wrong" })).status).toBe(409);
    const { rows: stillUser } = await query(`SELECT 1 FROM "user" WHERE id = $1`, [victim]);
    expect(stillUser).toHaveLength(1);

    // correct typed confirm → user + user-scoped content cascades
    await post(token, `/api/admin/users/${victim}/delete`, { confirm: "doomed" });
    const userGone = await query(`SELECT 1 FROM "user" WHERE id = $1`, [victim]);
    const storyGone = await query(`SELECT 1 FROM story WHERE id = $1`, [s.id]);
    const chapterGone = await query(`SELECT 1 FROM chapter WHERE story_id = $1`, [s.id]);
    expect(userGone.rows).toHaveLength(0);
    expect(storyGone.rows).toHaveLength(0);
    expect(chapterGone.rows).toHaveLength(0);
    // universes/lore are owned via universe_user (not a user FK) — they
    // survive deletion and simply lose this manager (no orphan data loss).
    const universeRow = await query(`SELECT 1 FROM universe WHERE id = $1`, [u1.id]);
    expect(universeRow.rows).toHaveLength(1);

    // admin cannot delete self
    expect((await jpost(token, `/api/admin/users/${adminId}/delete`, { confirm: "root5" })).status).toBe(409);
  });

  it("change my own password (self-service, current pw required)", async () => {
    const uid = await createUser("selfpw", "oldpw12345");
    const token = await createSession(uid);

    // no auth → 401
    const anon = await fetch(`${baseUrl}/api/auth/change-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ current: "oldpw12345", next: "newpw12345" }),
    });
    expect(anon.status).toBe(401);

    // wrong current password → 401, old password still works
    expect((await jpost(token, "/api/auth/change-password", { current: "nope12345", next: "newpw12345" })).status).toBe(401);
    const stillOld = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "selfpw", password: "oldpw12345" }),
    });
    expect(stillOld.status).toBe(200);

    // short new password → 400
    expect((await jpost(token, "/api/auth/change-password", { current: "oldpw12345", next: "123" })).status).toBe(400);

    // success → old pw dead, new pw works, session cookie re-issued
    const changed = await jpost(token, "/api/auth/change-password", { current: "oldpw12345", next: "newpw12345" });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=`);
    const oldGone = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "selfpw", password: "oldpw12345" }),
    });
    expect(oldGone.status).toBe(401);
    const newWorks = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "selfpw", password: "newpw12345" }),
    });
    expect(newWorks.status).toBe(200);
  });
});
