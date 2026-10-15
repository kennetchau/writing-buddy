import { query } from "../db/pool";

export interface OwnedStory {
  id: number;
  title: string;
  outline_md: string;
  user_id: number;
  universe_id: number | null;
  universe_name: string | null;
  status: "draft" | "finalized";
  updated_at: Date;
}

/** Fetch a story owned by the user (or null). */
export async function getOwnedStory(id: number, userId: number): Promise<OwnedStory | null> {
  const { rows } = await query<OwnedStory>(
    `SELECT s.id, s.title, s.outline_md, s.user_id, s.universe_id, u.name AS universe_name,
            s.status, s.updated_at
     FROM story s LEFT JOIN universe u ON u.id = s.universe_id
     WHERE s.id = $1 AND s.user_id = $2`,
    [id, userId],
  );
  return rows[0] ?? null;
}

export interface ChapterRow {
  id: number;
  seq: number;
  title: string;
  body_md: string;
  summary_md: string | null;
  status: "draft" | "final";
  updated_at: Date;
  has_summary: boolean;
}

export async function listChaptersForStory(storyId: number): Promise<ChapterRow[]> {
  const { rows } = await query<ChapterRow>(
    `SELECT id, seq, title, body_md, summary_md, status, updated_at,
            (summary_md IS NOT NULL) AS has_summary
     FROM chapter WHERE story_id = $1 ORDER BY seq`,
    [storyId],
  );
  return rows;
}

export async function getOwnedChapter(
  storyId: number,
  seq: number,
  userId: number,
): Promise<ChapterRow | null> {
  const { rows } = await query<ChapterRow>(
    `SELECT c.id, c.seq, c.title, c.body_md, c.summary_md, c.status, c.updated_at,
            (c.summary_md IS NOT NULL) AS has_summary
     FROM chapter c JOIN story s ON s.id = c.story_id
     WHERE c.story_id = $1 AND c.seq = $2 AND s.user_id = $3`,
    [storyId, seq, userId],
  );
  return rows[0] ?? null;
}
