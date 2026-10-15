import crypto from "node:crypto";
import cookie from "cookie";
import { query } from "../db/pool";

/**
 * Cookie sessions in Postgres (backend doc §2/§5):
 * random 32-byte token as session PK; httpOnly + SameSite=Lax cookie;
 * 12h sliding expiry — or a longer-lived "remember me" session (FR round 2,
 * 2026-10-09): the login checkbox sets `remember`, stored on the session row
 * so the sliding window always extends by the RIGHT ttl (a normal login must
 * still die at 12h even if the cookie lived longer).
 *
 * Cookie lifetime: remember → Max-Age (persistent, 30d); not remembered →
 * NO Max-Age (a browser session cookie: it vanishes when the browser closes,
 * which is the "logout when close" behavior the user asked for).
 */
export const SESSION_COOKIE = "session";
// 12h sliding session (backend doc §5).
const SESSION_TTL_MS = 12 * 3600_000;
// "remember me" session: 30 days (sliding, like the 12h one).
const REMEMBER_TTL_MS = 30 * 24 * 3600_000;

export interface SessionUser {
  id: number;
  username: string;
  is_admin: boolean;
}

function expiryFromNow(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

export async function createSession(userId: number, remember = false): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  await query(
    `INSERT INTO session (token, user_id, expires_at, remember) VALUES ($1, $2, $3, $4)`,
    [token, userId, expiryFromNow(remember ? REMEMBER_TTL_MS : SESSION_TTL_MS), remember],
  );
  return token;
}

/**
 * Options for res.cookie.
 *
 * ⚠️ Express `maxAge` is in **MILLISECONDS**. (A prior build passed the
 * 12h value in *seconds*, so Express emitted `Max-Age=43` → the browser
 * discarded the session cookie after ~43 s — the "force logout".)
 *
 * `remember = false` → NO maxAge at all: Express then emits a session cookie
 * (no Max-Age/Expires) that the browser drops when it closes.
 */
export function sessionCookieOptions(
  secure: boolean,
  remember = false,
): cookie.CookieSerializeOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    ...(remember ? { maxAge: REMEMBER_TTL_MS } : {}), // ms — NOT seconds
  };
}

/** The stored remember flag of a session row (for cookie re-issue paths). */
export async function sessionRememberFlag(token: string): Promise<boolean> {
  const { rows } = await query<{ remember: boolean }>(
    `SELECT remember FROM session WHERE token = $1`,
    [token],
  );
  return rows[0]?.remember ?? false;
}

export interface SessionResult {
  user: SessionUser | null;
  /** why the session is not valid, for diagnostics ("missing" = no cookie) */
  reason: "valid" | "expired" | "unknown" | "missing";
}

export interface SessionLookupOptions {
  /**
   * Delete the row when it is expired (default true). The template-local
   * user lookup passes false so it cannot consume an expired session before
   * the auth route/middleware reports "expired".
   */
  deleteExpired?: boolean;
}

/**
 * Sliding window: extend expiry while active. Returns {user, reason} —
 * reason is "valid" when user is non-null. Expired sessions are deleted
 * (the ONLY code path besides destroySession that removes rows) unless
 * deleteExpired is false.
 */
export async function getSessionUser(
  token: string | undefined,
  opts: SessionLookupOptions = {},
): Promise<SessionResult> {
  if (!token) return { user: null, reason: "missing" };
  const { rows } = await query<{
    id: number;
    username: string;
    is_admin: boolean;
    expires_at: Date;
    remember: boolean;
  }>(
    `SELECT u.id, u.username, u.is_admin, s.expires_at, s.remember
     FROM session s JOIN "user" u ON u.id = s.user_id
     WHERE s.token = $1`,
    [token],
  );
  const row = rows[0];
  if (!row) return { user: null, reason: "unknown" };
  if (row.expires_at.getTime() <= Date.now()) {
    if (opts.deleteExpired !== false) {
      await query(`DELETE FROM session WHERE token = $1`, [token]);
    }
    return { user: null, reason: "expired" };
  }
  // sliding window extended by THIS session's ttl (remember-me sessions
  // slide by 30d, normal ones by 12h)
  await query(`UPDATE session SET expires_at = $2 WHERE token = $1`, [
    token,
    expiryFromNow(row.remember ? REMEMBER_TTL_MS : SESSION_TTL_MS),
  ]);
  return { user: { id: row.id, username: row.username, is_admin: row.is_admin }, reason: "valid" };
}

export async function destroySession(token: string): Promise<void> {
  await query(`DELETE FROM session WHERE token = $1`, [token]);
}

export function tokenFromReq(req: import("express").Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  const parsed = cookie.parse(header);
  return parsed[SESSION_COOKIE];
}
