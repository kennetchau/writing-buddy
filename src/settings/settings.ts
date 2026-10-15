import { query } from "../db/pool";

/**
 * Per-user settings (change request 2026-10-13): a tiny key/value store
 * (`user_setting` table). Keys are whitelisted HERE — the client can never
 * create arbitrary rows — and GET merges stored values over the defaults so
 * callers always see a complete map.
 */

export const SETTING_DEFAULTS: Record<string, string> = {
  // "on" | "off" — story page offers a "do you want to summarize now?" hint
  // once a story accumulates unsummarized chapters (FR-23a)
  summarize_hint: "on",
  // how many unsummarized chapters trigger the hint (integer 1..20)
  summarize_hint_chapters: "3",
};

/** Return an error message, or null when (key, value) is acceptable. */
export function validateSetting(key: string, value: string): string | null {
  if (key === "summarize_hint") {
    return value === "on" || value === "off" ? null : "value must be 'on' or 'off'";
  }
  if (key === "summarize_hint_chapters") {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 && n <= 20 ? null : "value must be an integer 1..20";
  }
  return `unknown setting: ${key}`;
}

/** The user's settings merged over the defaults (always a complete map). */
export async function getUserSettings(userId: number): Promise<Record<string, string>> {
  const { rows } = await query<{ setting_key: string; value: string }>(
    `SELECT setting_key, value FROM user_setting WHERE user_id = $1`,
    [userId],
  );
  const settings: Record<string, string> = { ...SETTING_DEFAULTS };
  for (const r of rows) {
    if (r.setting_key in settings) settings[r.setting_key] = r.value;
  }
  return settings;
}

/** Upsert one whitelisted setting. Throws on invalid key/value (400 upstream). */
export async function setUserSetting(userId: number, key: string, value: string): Promise<void> {
  const err = validateSetting(key, value);
  if (err) throw new Error(err);
  await query(
    `INSERT INTO user_setting (user_id, setting_key, value) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, setting_key) DO UPDATE SET value = $3, updated_at = now()`,
    [userId, key, value],
  );
}
