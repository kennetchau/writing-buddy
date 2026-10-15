// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Client regression test for the story page editors (CR round 3, FR-12/13).
 *
 * Drives the REAL `src/public/js/story.ts` (CodeMirror 6 + `/keyword` lore
 * autocomplete) inside jsdom, the same way the story page loads it. This
 * exists because two production-breaking bugs were found ONLY by running
 * the bundle in a DOM (2026-10-11):
 *   1. `CompletionResult.options` was a Promise — CM6 requires a plain
 *      array (the SOURCE may be async) → "options is not iterable" killed
 *      the dropdown on every keystroke after `/`.
 *   2. CM6's default fuzzy filter matches options against the completion
 *      range — which starts at the `/`, no label contains one, so every
 *      option was filtered out and the dialog never opened. Fixed with
 *      `filter: false` (the server does the searching).
 * Headless limitation: jsdom has no layout, so the tooltip is never
 * PAINTED — we assert on the completion STATE (what a real browser renders).
 */

// ---- jsdom lacks bits of CSSOM/layout that CM6 probes ----
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver ?? RO;
window.HTMLElement.prototype.scrollIntoView = window.HTMLElement.prototype.scrollIntoView ?? (() => {});
window.Range.prototype.getBoundingClientRect =
  window.Range.prototype.getBoundingClientRect ??
  (() => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }));
window.Range.prototype.getClientRects =
  window.Range.prototype.getClientRects ??
  (() => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }));
window.document.elementFromPoint = window.document.elementFromPoint ?? (() => null);

const CANON_TITLE = "Executor class star dreadnought";
let fetchImpl: (url: string) => Promise<Response>;
const fetchLog: string[] = [];

beforeAll(async () => {
  // ---- the story page shape (views/story_detail.hbs) ----
  document.body.innerHTML = `
    <div id="outline-host" class="md-host">
      <textarea id="outline" rows="12">Beat one.</textarea>
    </div>
    <div id="ch-body-host" class="md-host">
      <textarea id="ch-body" rows="18"></textarea>
    </div>`;

  // ---- the page's inline textarea-backed stub ----
  const w = globalThis as any;
  function boxFor(ta: HTMLTextAreaElement) {
    return {
      get: () => ta.value,
      set: (v: string) => {
        ta.value = v;
      },
      setReadOnly: (b: boolean) => {
        ta.readOnly = b;
      },
    };
  }
  w.storyEditors = {
    outline: boxFor(document.getElementById("outline") as HTMLTextAreaElement),
    chapter: boxFor(document.getElementById("ch-body") as HTMLTextAreaElement),
  };

  // ---- fetch stub (relative URL, like the browser) ----
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    fetchLog.push(u);
    return fetchImpl(u);
  }) as typeof fetch;
  fetchImpl = async (u: string): Promise<Response> => {
    if (u.startsWith("/api/lore/search")) {
      const q = new URL(u, "http://x/").searchParams.get("q") ?? "";
      const results = q === "" || CANON_TITLE.toLowerCase().includes(q.toLowerCase())
        ? [{ id: 5, title: CANON_TITLE, universe: "Star Wars", universe_id: 3, snippet: "flagship class" }]
        : [];
      return new Response(JSON.stringify({ q, results }), { status: 200 });
    }
    return new Response("nope", { status: 404 });
  };

  // ---- import the editor entry (runs init(), swaps in CodeMirror) ----
  await import("../src/public/js/story.ts");
  // let CM finish mounting
  await new Promise((r) => setTimeout(r, 50));
});

afterAll(async () => {
  const w = globalThis as any;
  for (const k of ["outline", "chapter"]) {
    w.storyEditors?.[k]?._view?.destroy?.();
  }
});

type Box = {
  get(): string;
  set(v: string): void;
  setReadOnly(b: boolean): void;
  _view: import("@codemirror/view").EditorView;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const outline = (): Box => (globalThis as any).storyEditors.outline as Box;

/** type text the way CM's keymap does (userEvent "input.type") */
function type(view: import("@codemirror/view").EditorView, text: string): void {
  const head = view.state.selection.main.head;
  view.dispatch(
    view.state.update({
      changes: { from: head, insert: text },
      selection: { anchor: head + text.length },
      userEvent: "input.type",
    }),
  );
}

describe("story page editors (CodeMirror + `/` lore autocomplete)", () => {
  it("replaces both textareas with CM6 editors", () => {
    const box = outline();
    expect(box._view).toBeTruthy();
    expect(document.getElementById("outline")).toBeNull(); // textarea removed
    expect(box.get()).toBe("Beat one.");
    expect((globalThis as any).storyEditors.chapter._view).toBeTruthy();
  });

  it("wraps long lines (mobile: an unbroken pre-line made the page's intrinsic width = line width)", () => {
    // EditorView.lineWrapping adds the cm-lineWrapping class to .cm-content
    // (white-space: pre-wrap + overflow-wrap: anywhere). Without it, a single
    // long AI paragraph gives the editor host a min-content width of the full
    // line, and mobile browsers size the layout viewport to that — reflowing
    // the whole app to the stretched desktop layout (2026-10-12 bug).
    for (const key of ["outline", "chapter"] as const) {
      const content = (globalThis as any).storyEditors[key]._view.contentDOM;
      expect(content.classList.contains("cm-lineWrapping"), `${key} editor wraps`).toBe(true);
    }
  });

  it("typing /word live-searches and shows the lore entry", async () => {
    const { completionStatus, currentCompletions } = await import("@codemirror/autocomplete");
    const box = outline();
    const view = box._view;
    box.set("Beat one.");
    view.dispatch(view.state.update({ selection: { anchor: 0 } }));

    type(view, "/");
    await sleep(600); // CM's 100 ms typing delay + fetch + accept
    expect(completionStatus(view.state)).toBe("active");

    type(view, "star");
    await sleep(800);
    const opts = currentCompletions(view.state);
    expect(opts.map((o) => o.label)).toContain(CANON_TITLE);
    expect(fetchLog.some((u) => u.includes("q=star"))).toBe(true);
  });

  it("accepting inserts a standard [Title](Title) link and consumes the /token", async () => {
    const { acceptCompletion, currentCompletions } = await import("@codemirror/autocomplete");
    const box = outline();
    const view = box._view;
    // self-contained: fresh doc, cursor at the start, type the token
    box.set("Reset.");
    view.dispatch(view.state.update({ selection: { anchor: 0 } }));
    await sleep(50);
    type(view, "/star");
    await sleep(900); // typing delay + fetch + accept (also > 75 ms interactionDelay)
    expect(currentCompletions(view.state).map((o) => o.label)).toContain(CANON_TITLE);
    expect(acceptCompletion(view)).toBe(true);
    await sleep(50);
    expect(box.get()).toBe(
      `[${CANON_TITLE}](${CANON_TITLE})Reset.`,
      "the /token (incl. the slash) must be replaced by the link",
    );
  });

  it("a failed search shows an explicit failure row, never nothing", async () => {
    const { currentCompletions } = await import("@codemirror/autocomplete");
    const box = outline();
    const view = box._view;
    fetchImpl = async () => new Response("gone", { status: 404 }); // e.g. old server build
    try {
      box.set("Fresh line.");
      view.dispatch(view.state.update({ selection: { anchor: 0 } }));
      type(view, "/anything");
      await sleep(1000);
      const opts = currentCompletions(view.state);
      expect(opts.map((o) => o.label)).toContain("✖ lore search failed");
    } finally {
      fetchImpl = (u: string) =>
        new Promise<Response>((resolve) =>
          setTimeout(
            () =>
              resolve(
                new Response(
                  JSON.stringify({
                    q: "",
                    results: [{ id: 5, title: CANON_TITLE, universe: "Star Wars", universe_id: 3, snippet: "" }],
                  }),
                  { status: 200 },
                ),
              ),
            0,
          ),
        );
    }
  });

  it("does not trigger mid-word or without a slash", async () => {
    const { completionStatus } = await import("@codemirror/autocomplete");
    const box = outline();
    const view = box._view;
    box.set("plain sentence");
    view.dispatch(view.state.update({ selection: { anchor: 14 } })); // end of line
    type(view, "x");
    await sleep(600);
    expect(completionStatus(view.state)).toBeNull();
  });
});
