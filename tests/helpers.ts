import { app } from "../src/app";
import { applySchema } from "../src/db/init";
import { createSession, SESSION_COOKIE } from "../src/auth/session";
import { query } from "../src/db/pool";
import { hashPassword } from "../src/auth/bootstrap";

/**
 * Test harness: real Postgres (harness_postgres). Tables are truncated per
 * describe block so re-runs are clean.
 */
let server: import("node:http").Server;
let baseUrl: string;

export async function startServer(): Promise<void> {
  await applySchema(); // idempotent
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

export async function stopServer(): Promise<void> {
  server?.close();
  const { getPool } = await import("../src/db/pool");
  await getPool().end();
}

/** Wipe all rows (CASCADE handles FK order) to start a block clean. */
export async function wipeTables(): Promise<void> {
  await query(
    `TRUNCATE ai_run, system_prompt, style_prompt, user_setting, chapter, story, image,
             lore_entry_category, lore_category, lore_entry,
             universe_user, universe, session, "user" RESTART IDENTITY CASCADE`,
  );
}

export async function createUser(
  username: string,
  password: string,
  isAdmin = false,
): Promise<number> {
  const pw_hash = await hashPassword(password);
  const { rows } = await query<{ id: number }>(
    `INSERT INTO "user" (username, pw_hash, is_admin) VALUES ($1, $2, $3) RETURNING id`,
    [username, pw_hash, isAdmin],
  );
  return rows[0].id;
}

export { baseUrl, query, createSession, SESSION_COOKIE };
