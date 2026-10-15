import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * T4.1 fake-LLM (pattern proven in reference/story_creator/tests/fakes).
 * A scriptable, OpenAI-compatible fake llama.cpp router:
 *   GET  /v1/models          -> {"data":[...]}
 *   POST /models/load        -> {"success":true} (status -> "loading",
 *                                then "loaded" after loadDelayMs)
 *   POST /models/unload      -> {"success":true} (-> "unloaded")
 *   POST /v1/chat/completions -> SSE stream of content deltas
 *
 * Tests queue canned chat responses via `respondWith(...)`; the last queued
 * response repeats once the queue drains (multi-call scripts like summarize
 * work with one entry). `imageEcho` prepends "I saw <n> image(s)." so tests
 * prove the client round-tripped the image_url parts.
 *
 * startFakeLlm is SYNCHRONOUS (listens on a fixed port) so the spec can call
 * it from vi.hoisted before src/app imports config; the spec's beforeAll
 * polls until the fake answers /v1/models (readiness, as in fakes/run.py).
 */

export interface FakeChatResponse {
  /** text to stream (split into `chunks` SSE deltas); omit with fail:"empty" */
  text?: string;
  chunks?: number;
  /** ms to wait between chunks — lets a test hold a run "active" */
  delayPerChunkMs?: number;
  /** when true, prepend `I saw <n> image(s).` — proves image parts arrived */
  imageEcho?: boolean;
  /**
   * reasoning/thinking text streamed as `reasoning_content` deltas BEFORE
   * the content deltas (llama.cpp reasoning support) — proves the client
   * forwards thinking tokens as `thought` SSE events (FR-7)
   */
  reasoning?: string;
  /** HTTP error injection: "500" | "empty" */
  fail?: "500" | "empty";
}

export interface FakeLlm {
  baseUrl: string; // .../v1
  model: string;
  vision: boolean;
  respondWith(resp: FakeChatResponse): void;
  /** drop queued responses (a run that fails BEFORE its chat call leaves
   *  its queued response behind, which the next test's run would consume) */
  reset(): void;
  /** chat/completions calls received (hadImage = request carried image parts) */
  calls: { n: number; hadImage: boolean; userText: string; systemText: string; maxTokens: number | null }[];
  loadStatus: () => string;
  /** resolves when GET /v1/models answers 200 */
  whenReady(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export function startFakeLlm(
  opts: { model?: string; vision?: boolean; loadDelayMs?: number; port?: number } = {},
): FakeLlm {
  const model = opts.model ?? "gemma-4-31B";
  const vision = opts.vision ?? true;
  const loadDelayMs = opts.loadDelayMs ?? 50;
  const port = opts.port ?? Number(process.env.FAKE_LLAMA_PORT ?? 45123);

  let status: "unloaded" | "loading" | "loaded" = "unloaded";
  let loadTimer: NodeJS.Timeout | null = null;
  const queue: FakeChatResponse[] = [];
  let last: FakeChatResponse | null = null;
  const calls: { n: number; hadImage: boolean; userText: string; systemText: string; maxTokens: number | null }[] = [];

  const app = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (code: number, body: string, type = "application/json") => {
      res.writeHead(code, { "content-type": type });
      res.end(body);
    };

    if (req.method === "GET" && url.pathname === "/v1/models") {
      return send(
        200,
        JSON.stringify({
          data: [
            {
              id: model,
              status: { value: status },
              multimodal: vision,
              architecture: { input_modalities: vision ? ["text", "image"] : ["text"] },
              meta: { n_ctx_train: 131072 },
            },
          ],
        }),
      );
    }

    if (req.method === "POST" && url.pathname === "/models/load") {
      if (loadTimer) clearTimeout(loadTimer);
      status = "loading";
      loadTimer = setTimeout(() => {
        status = "loaded";
        loadTimer = null;
      }, loadDelayMs);
      return send(200, JSON.stringify({ success: true }));
    }

    if (req.method === "POST" && url.pathname === "/models/unload") {
      if (loadTimer) clearTimeout(loadTimer);
      status = "unloaded";
      return send(200, JSON.stringify({ success: true }));
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", async () => {
        let body: { messages?: { role?: string; content: unknown }[]; max_tokens?: number } = {};
        try {
          body = JSON.parse(raw);
        } catch {
          return send(400, JSON.stringify({ error: "bad json" }));
        }
        // count image parts across messages
        let hadImage = false;
        for (const m of body.messages ?? []) {
          if (
            Array.isArray(m.content) &&
            m.content.some((p) => (p as { type?: string }).type === "image_url")
          ) {
            hadImage = true;
          }
        }
        // the last queued response repeats once the queue drains (so a
        // multi-call script like summarize works with a single entry)
        const resp = queue.shift() ?? last ?? { text: "" };
        if (resp.fail === "500") return send(500, JSON.stringify({ error: "boom" }));
        // capture the user + system message text for prompt assertions
        let userText = "";
        let systemText = "";
        for (const m of body.messages ?? []) {
          if (m.role === "user") {
            userText +=
              typeof m.content === "string"
                ? m.content
                : (m.content as { text?: string }[]).map((p) => p.text ?? "").join("\n");
          } else if (m.role === "system") {
            systemText += typeof m.content === "string" ? m.content : "";
          }
        }
        calls.push({ n: calls.length + 1, hadImage, userText, systemText, maxTokens: body.max_tokens ?? null });

        let text = resp.text ?? "";
        if (resp.imageEcho) {
          const n = (body.messages ?? []).reduce((acc, m) => {
            if (Array.isArray(m.content))
              return acc + (m.content as { type?: string }[]).filter((p) => p.type === "image_url")
                .length;
            return acc;
          }, 0);
          text = `I saw ${n} image(s). ${text}`;
        }
        if (resp.fail === "empty") {
          // 200 with no choices (degrade, not error)
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end();
          return;
        }

        const chunks = Math.max(1, resp.chunks ?? 2);
        const delay = resp.delayPerChunkMs ?? 0;
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        // thinking tokens first (reasoning_content), like llama.cpp's
        // reasoning support — then the answer
        if (resp.reasoning) {
          const rp = resp.reasoning.slice(0, Math.ceil(resp.reasoning.length / 3));
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: rp }, index: 0, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: resp.reasoning.slice(rp.length) }, index: 0, finish_reason: null }] })}\n\n`);
          if (delay) await new Promise((r) => setTimeout(r, delay));
        }
        if (text === "") {
          // reasoning only — the model ran dry before producing content
          // (what a thinking model does when the token budget is exhausted)
          res.write(`data: [DONE]\n\n`);
          res.end();
          return;
        }
        const size = Math.ceil(text.length / chunks);
        for (let i = 0; i < chunks; i++) {
          const piece = text.slice(i * size, (i + 1) * size);
          const payload = {
            choices: [
              {
                delta: { content: piece },
                index: 0,
                finish_reason: i === chunks - 1 ? "stop" : null,
              },
            ],
          };
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
          if (delay && i < chunks - 1) await new Promise((r) => setTimeout(r, delay));
        }
        res.write(`data: [DONE]\n\n`);
        res.end();
      });
      return;
    }

    send(404, JSON.stringify({ error: "not found" }));
  });

  app.listen(port, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  return {
    baseUrl,
    model,
    vision,
    calls,
    respondWith: (r) => {
      queue.push(r);
      last = r;
    },
    reset: () => {
      queue.length = 0;
      last = null;
    },
    loadStatus: () => status,
    whenReady: (timeoutMs = 5_000) =>
      new Promise<void>((resolve, reject) => {
        const t0 = Date.now();
        const tick = async () => {
          try {
            const r = await fetch(`${baseUrl}/models`);
            if (r.status === 200) return resolve();
          } catch {
            /* not up yet */
          }
          if (Date.now() - t0 > timeoutMs) return reject(new Error("fake LLM not ready"));
          setTimeout(tick, 25);
        };
        tick();
      }),
    close: () =>
      new Promise<void>((r) => {
        if (loadTimer) clearTimeout(loadTimer);
        app.close(() => r());
      }),
  };
}
