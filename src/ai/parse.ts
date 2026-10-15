/**
 * Defensive structured-JSON extraction (backend doc §4 — "local models emit
 * messy JSON; parse defensively", see reference/story_creator/app/llm/verdict.py
 * for the failure modes this ports):
 *   - prefer a fenced ```json … ``` block
 *   - fall back to a bare {…} / […] in the text
 *   - tolerate surrounding prose
 * Malformed output is DATA, not a crash: returns null with a reason so the
 * caller can retry or surface an error.
 */

const FENCE_OBJ = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
const FENCE_ARR = /```(?:json)?\s*(\[[\s\S]*?\])\s*```/g;
const BARE_OBJ = /(\{[\s\S]*\})/;
const BARE_ARR = /(\[[\s\S]*\])/;

export function extractJsonBlock(text: string): string | null {
  if (!text || !text.trim()) return null;
  const tries: string[] = [];
  for (const re of [FENCE_OBJ, FENCE_ARR]) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m) tries.push(m[1]);
  }
  if (text.includes("[")) {
    const m = BARE_ARR.exec(text);
    if (m) tries.push(m[1]);
  }
  const mo = BARE_OBJ.exec(text);
  if (mo) tries.push(mo[1]);
  for (const blob of tries) {
    try {
      JSON.parse(blob);
      return blob;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Parse a strict-JSON request into an object or array.
 * Returns { ok: true, value } or { ok: false, error } — never throws.
 */
export function parseStructured<T = unknown>(
  text: string,
  expect: "object" | "array",
): { ok: true; value: T } | { ok: false; error: string } {
  const blob = extractJsonBlock(text);
  if (!blob) return { ok: false, error: "no JSON block found in response" };
  let data: unknown;
  try {
    data = JSON.parse(blob);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const isArr = Array.isArray(data);
  if (expect === "array" && !isArr) return { ok: false, error: "expected a JSON array" };
  if (expect === "object" && !isArr && typeof data !== "object")
    return { ok: false, error: "expected a JSON object" };
  return { ok: true, value: data as T };
}
