import { query } from "../db/pool";
import type { SessionUser } from "../auth/session";

/**
 * Row-level ownership via universe_user (backend doc §2/§5):
 * a user may manage a universe iff a (universe_id, user_id) row exists.
 */
export async function isUniverseMember(universeId: number, userId: number): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM universe_user WHERE universe_id = $1 AND user_id = $2`,
    [universeId, userId],
  );
  return rows.length > 0;
}

export interface UniverseRow {
  id: number;
  name: string;
  description: string | null;
  entry_count: number;
}

export interface UniverseWithUsers extends UniverseRow {
  users: { id: number; username: string }[];
}

/** All universes the user may manage, with entry counts. */
export async function listUniversesForUser(userId: number): Promise<UniverseWithUsers[]> {
  const { rows } = await query<UniverseRow>(
    `SELECT u.id, u.name, u.description, count(le.id)::int AS entry_count
     FROM universe u
     JOIN universe_user uu ON uu.universe_id = u.id
     LEFT JOIN lore_entry le ON le.universe_id = u.id
     WHERE uu.user_id = $1
     GROUP BY u.id
     ORDER BY lower(u.name)`,
    [userId],
  );
  const ids = rows.map((r) => r.id);
  const users: UniverseWithUsers[] = rows.map((r) => ({ ...r, users: [] }));
  if (ids.length > 0) {
    const { rows: links } = await query<{ universe_id: number; id: number; username: string }>(
      `SELECT uu.universe_id, uu.user_id AS id, u.username
       FROM universe_user uu JOIN "user" u ON u.id = uu.user_id
       WHERE uu.universe_id = ANY($1)
       ORDER BY u.username`,
      [ids],
    );
    const byUniverse = new Map<number, UniverseWithUsers>();
    users.forEach((u) => byUniverse.set(u.id, u));
    for (const l of links) {
      byUniverse.get(l.universe_id)?.users.push({ id: l.id, username: l.username });
    }
  }
  return users;
}

/** The user's universes as a flat select list (story primary-universe picker). */
export async function selectOptionsForUser(
  userId: number,
): Promise<{ id: number; name: string }[]> {
  const { rows } = await query<{ id: number; name: string }>(
    `SELECT u.id, u.name
     FROM universe u JOIN universe_user uu ON uu.universe_id = u.id
     WHERE uu.user_id = $1
     ORDER BY lower(u.name)`,
    [userId],
  );
  return rows;
}

/** Fetch one universe if the user may manage it, else null. */
export async function getOwnedUniverse(
  id: number,
  user: SessionUser,
): Promise<UniverseRow | null> {
  if (!(await isUniverseMember(id, user.id))) return null;
  const { rows } = await query<UniverseRow>(
    `SELECT u.id, u.name, u.description, count(le.id)::int AS entry_count
     FROM universe u
     LEFT JOIN lore_entry le ON le.universe_id = u.id
     WHERE u.id = $1
     GROUP BY u.id`,
    [id],
  );
  return rows[0] ?? null;
}
