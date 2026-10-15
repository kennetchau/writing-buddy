import { query } from "../db/pool";
import { isUniverseMember } from "../lore/ownership";

/**
 * T4.8 — lore suggestion apply.
 * - "add": applied directly (author can edit/delete afterwards) — no confirm.
 * - "delete": the ONLY confirmation step in the app; the client sends
 *   `confirmed: true` after the user confirms the typed/visible title.
 * The backend NEVER deletes lore on its own — a delete request without
 * `confirmed` is rejected (409).
 */
export interface ApplyResult {
  ok: boolean;
  error?: string;
  entry_id?: number;
}

export async function applySuggestion(
  userId: number,
  body: {
    type?: string;
    universe?: string;
    title?: string;
    body_md?: string;
    confirmed?: boolean;
  },
): Promise<ApplyResult> {
  const universe = String(body.universe ?? "").trim();
  const title = String(body.title ?? "").trim();
  if (!universe || !title) {
    return { ok: false, error: "universe and title are required" };
  }
  // find the universe by name the user manages
  const { rows: uniRows } = await query<{ id: number; name: string }>(
    `SELECT u.id, u.name FROM universe u
     JOIN universe_user uu ON uu.universe_id = u.id
     WHERE lower(u.name) = lower($1) AND uu.user_id = $2`,
    [universe, userId],
  );
  const universeRow = uniRows[0];
  if (!universeRow) {
    return { ok: false, error: `no managed universe named "${universe}"` };
  }
  if (!(await isUniverseMember(universeRow.id, userId))) {
    return { ok: false, error: "you do not manage that universe" };
  }

  if (body.type === "add") {
    const { rows } = await query<{ id: number }>(
      `INSERT INTO lore_entry (title, body_md, universe_id) VALUES ($1, $2, $3) RETURNING id`,
      [title, String(body.body_md ?? ""), universeRow.id],
    );
    return { ok: true, entry_id: rows[0].id };
  }

  if (body.type === "delete") {
    if (!body.confirmed) {
      return { ok: false, error: "delete requires confirmation" };
    }
    // delete the entry that matches the title in that universe
    const { rows: target } = await query<{ id: number }>(
      `SELECT id FROM lore_entry WHERE universe_id = $1 AND lower(title) = lower($2)`,
      [universeRow.id, title],
    );
    if (target.length === 0) {
      return { ok: false, error: `no entry titled "${title}" in ${universeRow.name}` };
    }
    await query(`DELETE FROM lore_entry WHERE id = $1`, [target[0].id]);
    return { ok: true, entry_id: target[0].id };
  }

  return { ok: false, error: "type must be 'add' or 'delete'" };
}
