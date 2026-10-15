/**
 * Story page editors (CR round 3, 2026-10-11).
 *
 * Replaces the plain textareas with CodeMirror 6 markdown editors — one
 * pane, live-rendered (headings/bold/italic/lists/code as you type; the
 * Preview button still shows the exact final Shelf look). The OUTLINE
 * editor also gets a `/keyword` autocomplete (FR-13): typing `/star` live-
 * searches the user's lore (GET /api/lore/search) and picking a suggestion
 * inserts a standard `[Title](Title)` outline link — Verify/generate pick
 * it up through the existing matched-link machinery, no new syntax.
 *
 * This file is BUNDLED (esbuild → /js/story.js, iife), NOT compiled by
 * tsc (see tsconfig "exclude"). The inline page script talks to the
 * editors only through `window.storyEditors` — a textarea-backed stub
 * that it creates first — so if this bundle ever fails to load the page
 * degrades to plain textareas and everything (save/verify/AI-lock) still
 * works.
 */
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { basicSetup } from "codemirror";

interface StoryBox {
  get(): string;
  set(v: string): void;
  setReadOnly(b: boolean): void;
}

interface LoreHit {
  id: number;
  title: string;
  universe: string;
  snippet?: string;
}

// ---------- lore search (FR-13) ----------

/**
 * A failed search must NEVER be silent: an empty options list makes
 * CodeMirror render no dropdown at all, so on failure we surface one
 * unselectable "search failed" row instead (2026-10-11: user typed
 * /Executor and saw nothing — the first suspect was a dead/404 endpoint).
 */
const SEARCH_FAILED: LoreHit = {
  id: -1,
  title: "✖ lore search failed",
  universe: "check the host is running the latest build",
  snippet: "F12 → Network: what does /api/lore/search return?",
};

/** fetch with the same 401 handling as the page's api() helper */
async function fetchLore(q: string): Promise<LoreHit[]> {
  let res: Response;
  try {
    res = await fetch(`/api/lore/search?q=${encodeURIComponent(q)}&limit=8`, {
      headers: { accept: "application/json" },
    });
  } catch (e) {
    console.warn("[story] lore search request failed", e);
    return [SEARCH_FAILED];
  }
  if (res.status === 401) {
    (window as any).novelOn401?.();
    throw new Error("not authenticated");
  }
  if (!res.ok) {
    console.warn(`[story] lore search returned HTTP ${res.status} for q="${q}"`);
    return [SEARCH_FAILED];
  }
  const j = (await res.json()) as { results: LoreHit[] };
  return j.results;
}

/**
 * The `/keyword` completion source. Triggers only on a bare `/token` right
 * before the cursor (slash at line start or after whitespace/`(` — URLs
 * like https://… never match).
 *
 * ASYNC SOURCE: CM6 awaits the source itself — `result.options` must be a
 * plain array (a Promise there throws "options is not iterable" and kills
 * the dropdown; found via headless repro 2026-10-11). CM's built-in 100 ms
 * typing delay already debounces rapid keystrokes.
 */
async function loreCompletion(ctx: CompletionContext): Promise<CompletionResult | null> {
  const head = ctx.state.selection.main.head;
  const line = ctx.state.doc.lineAt(head);
  const before = line.text.slice(0, head - line.from);
  const m = /(^|[\s(])\/([^/\s()[\]]*)$/.exec(before);
  if (!m) return null;

  // position of the `/` itself: the leading group is "" (line start) or one
  // whitespace char, so the slash sits m.index + m[1].length into the line
  const from = line.from + m.index + m[1].length;
  const q = m[2];
  const hits = await fetchLore(q);

  return {
    from,
    to: from + 1 + q.length, // end of the `/token`
    // NO client-side fuzzy filtering: the range starts at the `/`, which no
    // label contains, so CM's default FuzzyMatcher would drop every option
    // (found via headless repro 2026-10-11). The server already searched —
    // options are exactly the matches.
    filter: false,
    options: hits.map((h) => ({
      label: h.title,
      detail: h.universe,
      info: h.snippet || undefined,
      // the "search failed" marker row: visible but inserts nothing
      apply:
        h.id === -1
          ? () => null
          : (view: EditorView, _completion: unknown, fromPos: number, toPos: number) => {
              const text = `[${h.title}](${h.title})`;
              view.dispatch({
                changes: { from: fromPos, to: toPos, insert: text },
                selection: { anchor: fromPos + text.length },
              });
            },
    })),
  };
}

// ---------- editor factory ----------

function makeEditor(host: HTMLElement, opts: { lore: boolean; height: string }): StoryBox {
  const ta = host.querySelector("textarea");
  const doc = ta ? ta.value : "";
  const readOnly = new Compartment();

  const extensions = [
    basicSetup,
    markdown({ base: markdownLanguage }),
    // wrap long lines: the plain textareas wrapped too, and an unbroken
    // `white-space: pre` line gave the editor a huge INTRINSIC min-width
    // (the full line width). Mobile browsers size the layout viewport from
    // content min-width — one long AI paragraph then forced the whole page
    // into a desktop-width "stretched" reflow (2026-10-12 mobile bug).
    EditorView.lineWrapping,
    readOnly.of(EditorState.readOnly.of(false)),
    EditorState.tabSize.of(2),
    EditorView.theme({
      "&": { height: opts.height, fontSize: "14px" },
      ".cm-scroller": { overflow: "auto" },
    }),
  ];
  if (opts.lore) extensions.push(autocompletion({ override: [loreCompletion] }));

  const view = new EditorView({ doc, parent: host, extensions });
  ta?.remove();

  return {
    get: () => view.state.doc.toString(),
    set: (v: string) => {
      if (view.state.doc.toString() === v) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
    },
    setReadOnly: (b: boolean) => {
      if (view.state.facet(EditorState.readOnly) !== b) {
        view.dispatch({ effects: readOnly.reconfigure(EditorState.readOnly.of(b)) });
      }
    },
    // test hook (client repro/tests dispatch real input-type transactions)
    _view: view,
  };
}

// ---------- init ----------

function init(): void {
  console.info("[story] story.js loaded — replacing textareas with CodeMirror editors");
  const w = window as any;
  w.storyEditors = w.storyEditors || {};
  const outline = document.getElementById("outline-host");
  if (outline) w.storyEditors.outline = makeEditor(outline, { lore: true, height: "340px" });
  const chapter = document.getElementById("ch-body-host");
  if (chapter) w.storyEditors.chapter = makeEditor(chapter, { lore: false, height: "440px" });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
