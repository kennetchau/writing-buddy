import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import { query } from "../db/pool";

/**
 * First-admin bootstrap (T1.3): if no users exist, create the admin from
 * ADMIN_USERNAME / ADMIN_PASSWORD.
 */
export async function ensureFirstAdmin(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { rows: countRows } = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM "user"`,
  );
  if (countRows[0]?.n > 0) return;

  const username = env.ADMIN_USERNAME;
  const password = env.ADMIN_PASSWORD;
  if (!username || !password) return;

  const pw_hash = await argon2Hash(password);
  await query(
    `INSERT INTO "user" (username, pw_hash, is_admin) VALUES ($1, $2, true)
     ON CONFLICT (username) DO NOTHING`,
    [username, pw_hash],
  );
  console.log(`[auth] created initial admin user "${username}"`);
}

export async function hashPassword(password: string): Promise<string> {
  return argon2Hash(password);
}

export async function verifyPassword(pwHash: string, password: string): Promise<boolean> {
  try {
    return await argon2Verify(pwHash, password);
  } catch {
    return false;
  }
}

export async function findUserByName(username: string) {
  const { rows } = await query<{
    id: number;
    username: string;
    pw_hash: string;
    is_admin: boolean;
  }>(`SELECT id, username, pw_hash, is_admin FROM "user" WHERE username = $1`, [username]);
  return rows[0] ?? null;
}
