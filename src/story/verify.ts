import { query } from "../db/pool";
import type { OwnedStory } from "./story";

/**
 * Verify (FR-21a, backend doc §3): scan the saved outline for all markdown
 * links `[text](target)` and match each target case-insensitively against
 * lore entry titles the user can access, then universe names.
 * Pure string matching — no AI. Instant, changes nothing.
 */

export interface VerifyLinkResult {
  text: string;
  target: string;
  /** entry_id is null when the link matched a whole universe (not a specific entry). */
  matched: { entry_id: number | null; title: string; universe_id: number; universe: string } | null;
}

export const MD_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

export function extractOutlineLinks(outlineMd: string): { text: string; target: string }[] {
  const links: { text: string; target: string }[] = [];
  for (const m of outlineMd.matchAll(MD_LINK_RE)) {
    const target = m[2].trim();
    // skip external URLs — only bare names are lore links (FR-21)
    if (/^[a-z]+:\/\//i.test(target) || target.startsWith("mailto:")) continue;
    links.push({ text: m[1].trim(), target });
  }
  return links;
}

export async function verifyOutline(
  story: Pick<OwnedStory, "outline_md" | "universe_id">,
  userId: number,
): Promise<VerifyLinkResult[]> {
  const links = extractOutlineLinks(story.outline_md);
  if (links.length === 0) return [];

  // all lore entries the user can manage (via universe_user)
  const { rows: entries } = await query<{ id: number; title: string; universe_id: number; universe: string }>(
    `SELECT e.id, e.title, e.universe_id, u.name AS universe
     FROM lore_entry e
     JOIN universe u ON u.id = e.universe_id
     JOIN universe_user uu ON uu.universe_id = u.id
     WHERE uu.user_id = $1`,
    [userId],
  );
  const { rows: universes } = await query<{ id: number; name: string }>(
    `SELECT u.id, u.name FROM universe u
     JOIN universe_user uu ON uu.universe_id = u.id
     WHERE uu.user_id = $1`,
    [userId],
  );

  const entryByTitle = new Map<string, { id: number; title: string; universe_id: number; universe: string }>();
  for (const e of entries) entryByTitle.set(e.title.toLowerCase(), e);
  const universeByName = new Map<string, { id: number; name: string }>();
  for (const u of universes) universeByName.set(u.name.toLowerCase(), u);

  return links.map(({ text, target }) => {
    const key = target.toLowerCase();
    const entry = entryByTitle.get(key);
    if (entry) {
      return { text, target, matched: { entry_id: entry.id, title: entry.title, universe_id: entry.universe_id, universe: entry.universe } };
    }
    const universe = universeByName.get(key);
    if (universe) {
      // matched a whole universe — no specific entry
      return { text, target, matched: { entry_id: null, title: universe.name, universe_id: universe.id, universe: universe.name } };
    }
    return { text, target, matched: null };
  });
}
