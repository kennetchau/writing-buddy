import { query } from "../db/pool";

export interface AdminUserRow {
  id: number;
  username: string;
  is_admin: boolean;
  created_at: Date;
}

/** All users (admin page + universe-assignment dropdowns). */
export async function listAllUsers(): Promise<AdminUserRow[]> {
  const { rows } = await query<AdminUserRow>(
    `SELECT id, username, is_admin, created_at FROM "user" ORDER BY lower(username)`,
  );
  return rows;
}
