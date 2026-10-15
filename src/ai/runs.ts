import { query } from "../db/pool";
import type { AiAction } from "../db/prompts";

/**
 * T4.3 — ai_run lifecycle (backend doc §2/§3).
 * - one action per user at a time (in-process check; one Node process)
 * - SSE stream with start/delta/done/error vocabulary, re-subscribable
 *   (replays in-memory state on connect, then live deltas)
 * - `ai_run` row persisted for the navbar badge (GET /api/ai/current)
 */

export type AiKind = AiAction;
// kinds the client can start (generate_this is a mode of "generate", not its
// own endpoint) + style_extract (change request 2026-10-13)
export const AI_KINDS: AiKind[] = ["generate", "summarize", "lore_suggest", "image_desc", "style_extract"];

/** Finished runs keep at most this long in memory (for re-subscribable
 *  SSE replays of recent runs); older ones are evicted so the map — which
 *  holds full chapter text per run — cannot grow unbounded. */
const FINISHED_RUN_TTL_MS = 60 * 60 * 1000;

export interface SseEvent {
  type: "start" | "thinking" | "thought" | "delta" | "done" | "error";
  [key: string]: unknown;
}

export interface Run {
  id: number;
  userId: number;
  kind: AiKind;
  target: Record<string, unknown>;
  status: "running" | "done" | "error";
  error: string | null;
  events: SseEvent[];
  startedAt: Date;
  /** set when the run reaches a terminal state (for in-memory eviction) */
  endedAt: Date | null;
  /** resolves when the run reaches a terminal state */
  finished: Promise<void>;
  /** live SSE subscribers (set of write callbacks) */
  listeners: Set<(ev: SseEvent) => void>;
  /**
   * Emergency stop (AI Monitor red button): aborting this controller drops
   * the in-flight llama.cpp HTTP stream; the action handler fails the run
   * with a "cancelled" error.
   */
  abort: AbortController;
}

/** userId -> currently running Run (at most one per user) */
const activeByUser = new Map<number, Run>();
const runs = new Map<number, Run>();

let finishResolvers = new Map<number, () => void>();

/** Drop finished runs older than FINISHED_RUN_TTL_MS (memory hygiene). */
function evictOldRuns(): void {
  const cutoff = Date.now() - FINISHED_RUN_TTL_MS;
  for (const [id, run] of runs) {
    if (run.status !== "running" && run.endedAt && run.endedAt.getTime() < cutoff) {
      runs.delete(id);
      finishResolvers.delete(id);
    }
  }
}

export function getRun(id: number): Run | undefined {
  return runs.get(id);
}

export function getActiveRunForUser(userId: number): Run | undefined {
  return activeByUser.get(userId);
}

/**
 * Emergency stop: abort the run's in-flight LLM call. The action handler's
 * chatStream rejects with an AbortError and the run fails with
 * "cancelled by user". Returns false if the run is not (any more) running.
 */
export function cancelRun(run: Run): boolean {
  if (run.status !== "running") return false;
  run.abort.abort(new Error("cancelled by user"));
  return true;
}

export async function startRun(
  userId: number,
  kind: AiKind,
  target: Record<string, unknown>,
): Promise<Run> {
  if (activeByUser.has(userId)) {
    const err = new Error("an AI action is already running for this user") as Error & { status: number };
    err.status = 409;
    throw err;
  }
  evictOldRuns();
  const { rows } = await query<{ id: number }>(
    `INSERT INTO ai_run (user_id, kind, target_jsonb) VALUES ($1, $2, $3) RETURNING id`,
    [userId, kind, JSON.stringify(target)],
  );
  const id = rows[0].id;
  let resolveFinish: () => void;
  const finished = new Promise<void>((r) => (resolveFinish = r));
  finishResolvers.set(id, () => resolveFinish!());

  const run: Run = {
    id,
    userId,
    kind,
    target,
    status: "running",
    error: null,
    events: [{ type: "start", kind, target }],
    startedAt: new Date(),
    endedAt: null,
    finished,
    listeners: new Set(),
    abort: new AbortController(),
  };
  runs.set(id, run);
  activeByUser.set(userId, run);
  return run;
}

export function emit(run: Run, event: SseEvent): void {
  if (run.status !== "running" && event.type === "delta") return;
  run.events.push(event);
  for (const listener of run.listeners) {
    try {
      listener(event);
    } catch {
      run.listeners.delete(listener);
    }
  }
}
/**
 * Subscribe to a run's SSE stream: immediately replays all events so far,
 * then streams live events until the run finishes.
 */
export function subscribe(run: Run, onEvent: (ev: SseEvent) => void): () => void {
  // replay history
  for (const ev of run.events) onEvent(ev);
  if (run.status !== "running") return () => {};
  run.listeners.add(onEvent);
  return () => run.listeners.delete(onEvent);
}

export async function finishRun(run: Run, payload: Record<string, unknown>): Promise<void> {
  if (run.status !== "running") return;
  run.status = "done";
  run.endedAt = new Date();
  // broadcast the terminal event to live SSE subscribers (and record it)
  run.events.push({ type: "done", ...payload });
  for (const listener of run.listeners) {
    try {
      listener(run.events[run.events.length - 1]);
    } catch {
      /* drop broken subscriber */
    }
  }
  activeByUser.delete(run.userId);
  await query(
    `UPDATE ai_run SET status = 'done', target_jsonb = target_jsonb || $2::jsonb, ended_at = now() WHERE id = $1`,
    [run.id, JSON.stringify({ result: payload })],
  );
  finishResolvers.get(run.id)?.();
  finishResolvers.delete(run.id);
}

export async function failRun(run: Run, message: string): Promise<void> {
  if (run.status !== "running") return;
  run.status = "error";
  run.error = message;
  run.endedAt = new Date();
  const ev: SseEvent = { type: "error", message };
  run.events.push(ev);
  for (const listener of run.listeners) {
    try {
      listener(ev);
    } catch {
      /* drop broken subscriber */
    }
  }
  activeByUser.delete(run.userId);
  await query(
    `UPDATE ai_run SET status = 'error', error = $2, ended_at = now() WHERE id = $1`,
    [run.id, message],
  );
  finishResolvers.get(run.id)?.();
  finishResolvers.delete(run.id);
}
