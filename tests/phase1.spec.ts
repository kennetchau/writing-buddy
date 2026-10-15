import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession, SESSION_COOKIE, wipeTables, baseUrl, startServer, stopServer } from "./helpers";
import { query } from "../src/db/pool";
import { ensureFirstAdmin } from "../src/auth/bootstrap";

// Dev-only bootstrap credentials for the throwaway test DB (the suite
// TRUNCATEs the user table per run). Injected env wins; no real credentials
// are stored in the repo.
const TEST_ADMIN_USER = process.env.ADMIN_USERNAME ?? "testadmin";
const TEST_ADMIN_PW = process.env.ADMIN_PASSWORD ?? "testpw-dev-only";

async function get(path: string, cookie?: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    headers: cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {},
    redirect: "manual",
  });
}

describe("Phase 1 skeleton + auth", () => {
  beforeAll(async () => {
    await startServer();
    await wipeTables();
    // bootstrap runs "if no users exist" — empty table guarantees it fires
    await ensureFirstAdmin({ ...process.env, ADMIN_USERNAME: TEST_ADMIN_USER, ADMIN_PASSWORD: TEST_ADMIN_PW });
    // boot() would seed prompts after ensureFirstAdmin; do the same here
    const { seedDefaultPrompts } = await import("../src/db/prompts");
    await seedDefaultPrompts();
  });

  afterAll(async () => {
    await stopServer();
  });

  it("health endpoint is public and ok", async () => {
    const res = await get("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("login page renders without a session", async () => {
    const res = await get("/login");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Username");
    expect(body).toContain("/login");
  });

  it("unauthenticated page request redirects to /login", async () => {
    const res = await get("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("unauthenticated /api request gets 401 JSON", async () => {
    const res = await get("/api/me");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not authenticated");
  });

  it("401 bodies carry a diagnostic reason (issue-autologout)", async () => {
    // no cookie at all -> missing
    const missing = (await (await get("/api/me")).json()) as { reason?: string };
    expect(missing.reason).toBe("missing");
    // unknown token -> unknown
    const unknown = (await (
      await get("/api/me", "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")
    ).json()) as { reason?: string };
    expect(unknown.reason).toBe("unknown");
    // expired token -> expired (and the template-local lookup must NOT
    // have deleted the row before the route reported "expired")
    const token = "000000000000000000000000000000000000000000000000000000000000dead";
    await query(`INSERT INTO session (token, user_id, expires_at) VALUES ($1, 1, now() - interval '1 minute')`, [
      token,
    ]);
    const expiredRes = await get("/api/me", token);
    expect(expiredRes.status).toBe(401);
    const expired = (await expiredRes.json()) as { reason?: string };
    expect(expired.reason).toBe("expired");
    // page redirects preserve the origin path via ?next=
    const page = await get("/story");
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/login?next=%2Fstory");
  });

  it("login form honors ?next= and redirects back to it", async () => {
    const res = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `username=${TEST_ADMIN_USER}&password=${TEST_ADMIN_PW}&next=%2Fstory`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/story");
  });

  it("POST /api/login with wrong password is rejected", async () => {
    const res = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "testadmin", password: "wrong" }),
    });
    expect(res.status).toBe(401);
  });

  it("first-admin bootstrap created testadmin with is_admin", async () => {
    const { rows } = await query<{ username: string; is_admin: boolean }>(
      `SELECT username, is_admin FROM "user" WHERE username = 'testadmin'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].is_admin).toBe(true);
  });

  it("login form renders the remember-me checkbox", async () => {
    const res = await get("/login");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('name="remember"');
    expect(body).toContain("Remember me");
  });

  it("login form POST sets a SESSION cookie (no Max-Age) without remember", async () => {
    const res = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `username=${TEST_ADMIN_USER}&password=${TEST_ADMIN_PW}`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    // No "remember me" → a browser SESSION cookie (no Max-Age, no Expires):
    // the browser drops it when it closes → "logout when close".
    expect(/Max-Age=/.test(setCookie)).toBe(false);
    expect(/Expires=/.test(setCookie)).toBe(false);
    const token = /session=([a-f0-9]+)/.exec(setCookie)?.[1];
    const { rows } = await query<{ remember: boolean }>(`SELECT remember FROM session WHERE token = $1`, [token!]);
    expect(rows[0].remember).toBe(false);
  });

  it("remember-me login sets a 30-day persistent cookie (remember=true)", async () => {
    const res = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `username=${TEST_ADMIN_USER}&password=${TEST_ADMIN_PW}&remember=on`,
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const setCookie = res.headers.get("set-cookie") ?? "";
    // 30 days in SECONDS on the wire (Express maxAge takes ms — the old
    // force-logout was exactly this units bug, see issue-autologout.md)
    const maxAge = Number(/Max-Age=(\d+)/.exec(setCookie)?.[1]);
    expect(maxAge).toBe(30 * 24 * 3600);
    const token = /session=([a-f0-9]+)/.exec(setCookie)?.[1];
    const { rows } = await query<{ remember: boolean }>(`SELECT remember FROM session WHERE token = $1`, [token!]);
    expect(rows[0].remember).toBe(true);

    // JSON login accepts a boolean remember
    const api = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: TEST_ADMIN_USER, password: TEST_ADMIN_PW, remember: true }),
    });
    expect(api.status).toBe(200);
    expect(/Max-Age=(\d+)/.exec(api.headers.get("set-cookie") ?? "")?.[1]).toBe(String(30 * 24 * 3600));
  });

  it("API login + /api/me round-trip", async () => {
    const login = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: TEST_ADMIN_USER, password: TEST_ADMIN_PW }),
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie") ?? "";
    const token = /session=([a-f0-9]+)/.exec(setCookie)?.[1];
    expect(token).toBeTruthy();

    const me = await get("/api/me", token!);
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user: { username: string; is_admin: boolean } };
    expect(body.user.username).toBe("testadmin");
    expect(body.user.is_admin).toBe(true);
  });

  it("/api/logout destroys the session", async () => {
    const login = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: TEST_ADMIN_USER, password: TEST_ADMIN_PW }),
    });
    const token = /session=([a-f0-9]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1];
    expect(token).toBeTruthy();

    const out = await fetch(`${baseUrl}/api/logout`, {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(out.status).toBe(200);

    const me = await get("/api/me", token!);
    expect(me.status).toBe(401);
  });

  it("system prompts are seeded for the new admin (one per action)", async () => {
    const { rows } = await query<{ action: string }>(
      `SELECT action FROM system_prompt ORDER BY action`,
    );
    expect(rows.map((r) => r.action).sort()).toEqual([
      "generate",
      "generate_this",
      "image_desc",
      "lore_suggest",
      "style_extract", // change request 2026-10-13: style extraction
      "summarize",
    ]);
  });
});
