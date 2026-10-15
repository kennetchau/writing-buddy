import { getConfig } from "../app";

/**
 * T4.1 — llama.cpp client (backend doc §4).
 * Talks only to the existing llama.cpp router HTTP API:
 *   GET  /v1/models          (status loaded/unloaded, multimodal capability)
 *   POST /models/load        {"model": name}  — async, UI polls status
 *   POST /models/unload      {"model": name}
 *   POST /v1/chat/completions — OpenAI-compatible, stream:true, model in body
 *
 * The local model is SLOW (NFR-02): read timeout 900s by default, silence
 * while the stream is alive is NOT a hang.
 */

export interface LlmModel {
  id: string;
  status: string; // "loaded" | "unloaded" | "loading" | "unloading" | ...
  multimodal: boolean;
  /** context window in tokens, if the router reports it (meta.n_ctx_train) */
  ctx?: number;
}

interface ModelsCache {
  at: number;
  reachable: boolean;
  models: LlmModel[];
}

let modelCache: ModelsCache | null = null;
const MODEL_CACHE_MS = 3000; // "app caches for a few seconds" (backend doc §4)

export function invalidateModelCache(): void {
  modelCache = null;
}

function v1Base(): string {
  return getConfig().llamaUrl.replace(/\/+$/, "");
}
/** Router control endpoints live at the server root (no /v1). */
function routerBase(): string {
  return v1Base().replace(/\/v1$/, "");
}

function normalizeModel(m: Record<string, unknown>): LlmModel {
  const id = String(m.id ?? m.name ?? "unknown");
  let status = "unknown";
  const s = m.status;
  if (typeof s === "string") status = s;
  else if (s && typeof s === "object") status = String((s as { value?: unknown }).value ?? "unknown");
  let multimodal = m.multimodal === true;
  const arch = m.architecture as { input_modalities?: string[] } | undefined;
  if (arch?.input_modalities?.includes("image")) multimodal = true;
  const meta = m.meta as { n_ctx_train?: number } | null;
  const ctx = meta && typeof meta.n_ctx_train === "number" ? meta.n_ctx_train : undefined;
  return { id, status, multimodal, ctx };
}

export async function fetchModels(force = false): Promise<{ reachable: boolean; models: LlmModel[] }> {
  if (!force && modelCache && Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new Error("llama unreachable")), 10_000);
    let result: ModelsCache;
    try {
      const res = await fetch(`${v1Base()}/models`, { signal: ac.signal });
      if (!res.ok) throw new Error(`llama responded ${res.status}`);
      const body = (await res.json()) as { data?: Record<string, unknown>[] };
      result = { at: Date.now(), reachable: true, models: (body.data ?? []).map(normalizeModel) };
    } finally {
      clearTimeout(t);
    }
    modelCache = result;
  } catch {
    // llama.cpp down — app still boots; UI shows "model server unreachable"
    modelCache = { at: Date.now(), reachable: false, models: [] };
  }
  return modelCache;
}

async function routerPost(path: string, model: string): Promise<Record<string, unknown>> {
  invalidateModelCache();
  const res = await fetch(`${routerBase()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model }),
  });
  if (!res.ok) throw new Error(`llama ${path} failed: ${res.status}`);
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

export function loadModel(model: string): Promise<Record<string, unknown>> {
  return routerPost("/models/load", model);
}
export function unloadModel(model: string): Promise<Record<string, unknown>> {
  return routerPost("/models/unload", model);
}

// ---- chat completions (streaming) ----

export type ChatPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ChatPart[];
}

export const DEFAULT_MAX_TOKENS = 20000;

/**
 * Hint appended to every "empty answer" error. On a llama.cpp server run
 * with reasoning extraction the model's thinking tokens count against the
 * output budget / context window — when they exhaust it, `content` comes
 * back empty. The fix is host-side (bigger server context), so the failed
 * run's banner (story page / AI Monitor) must say so.
 */
export const EMPTY_ANSWER_HINT =
  "the model likely spent its token budget 'thinking' (reasoning) before the answer — increase the llama server's context size (e.g. -c 32768) so reasoning + answer both fit, or use a server config without reasoning extraction";

export interface ChatStreamOptions {
  model: string;
  messages: ChatMessage[];
  /** called for each content delta as it arrives */
  onDelta: (text: string) => void;
  /**
   * called for each reasoning/thinking delta (llama.cpp `reasoning_content`,
   * DeepSeek-style — the model "thinking" before the answer, reference/
   * llama.cpp/tools/server/README.md §reasoning support). Absent unless the
   * server extracts reasoning (server-side `--reasoning-format`).
   */
  onThinking?: (text: string) => void;
  /** caller-supplied abort (the AI Monitor "stop" button); default idle timeout still applies */
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
}

/**
 * POST /v1/chat/completions with stream:true. Resolves with the full text
 * (thinking tokens are NOT included — only the answer).
 * Idle timeout = cfg.llmReadTimeout (default 900s): silence longer than that
 * aborts; any delta resets the clock. `signal` lets a user emergency-stop an
 * action; aborting the fetch drops the HTTP connection, so llama.cpp stops
 * serving the completion.
 */
export async function chatStream(opts: ChatStreamOptions): Promise<string> {
  const cfg = getConfig();
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(new Error("cancelled by user"));
  if (opts.signal) {
    if (opts.signal.aborted) onOuterAbort();
    else opts.signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  let idle: NodeJS.Timeout | null = null;
  const armIdle = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(
      () => controller.abort(new Error(`LLM read timeout after ${cfg.llmReadTimeout}s`)),
      cfg.llmReadTimeout * 1000,
    );
  };
  armIdle();
  try {
    const res = await fetch(`${v1Base()}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        stream: true,
        temperature: opts.temperature ?? 0.8,
        max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`LLM error ${res.status}: ${text.slice(0, 300)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let full = "";
    for (;;) {
      const { done, value } = await reader.read();
      armIdle(); // any bytes = still alive
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const j = JSON.parse(data) as {
            choices?: { delta?: { content?: string; reasoning_content?: string } }[];
          };
          const delta = j.choices?.[0]?.delta;
          // thinking tokens (llama.cpp reasoning support) arrive as
          // reasoning_content BEFORE the answer; they are displayed, not
          // part of the chapter/summary text
          if (delta?.reasoning_content) opts.onThinking?.(delta.reasoning_content);
          if (delta?.content) {
            full += delta.content;
            opts.onDelta(delta.content);
          }
        } catch {
          // keepalives / partials — ignore
        }
      }
    }
    // NOTE: an empty answer is returned as "" (not thrown) — every action
    // decides its own empty handling (summarize retries once per chapter);
    // they should all fail with EMPTY_ANSWER_HINT in the message.
    return full;
  } finally {
    if (idle) clearTimeout(idle);
    if (opts.signal) opts.signal.removeEventListener("abort", onOuterAbort);
  }
}
