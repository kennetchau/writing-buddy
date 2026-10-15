# Technical Document — FRONTEND (UI)

|          |                                                        |
|----------|--------------------------------------------------------|
| Version  | 2.0 (companion to BRD v2.0)                            |
| Scope    | UI only: pages, layout, interactions, streaming UX     |
| Backend  | See `agent/technicaldoc_backend.md` (data model/API)   |

## 1. Stack

- Server-rendered HTML: **Express + hbs templates** (one layout, partials for navbar/messages).
- **No React, no Vite.** A few small vanilla TypeScript files compiled to static JS under `/public/js` (SSE reading, form helpers). One exception (CR round 3, 2026-10-11): the story page's **CodeMirror 6** editors are the only bundled client module — `src/public/js/story.ts` is bundled by **esbuild** (a build-time devDependency, not a framework) into a single static `/js/story.js` (iife). No dev server, no module runtime.
- Styling: one plain CSS file (dark, minimal). No CSS framework.
- Live AI output: **SSE** via `fetch` + `ReadableStream` (EventSource can't POST, and generation needs to trigger a server-side action; pattern: `POST /api/.../start` returns a run/stream URL, then subscribe — or simpler: a `GET /api/stream/{action_id}` SSE endpoint per active action).

## 2. Layout

Single persistent frame, all pages server-rendered at their routes:

```
┌────────────┬──────────────────────────────────────────┐
│  LORE      │                                          │
│  STORY     │            page content                  │
│  UNIVERSE  │                                          │
│  AI MONITOR│                                          │
│  SHELF     │                                          │
│ ─────────  │                                          │
│  ⚙ admin   │                                          │
│  user ▾    │                                          │
└────────────┴──────────────────────────────────────────┘
```

- Vertical navbar, left, ~160px. Active page bolded.
- Top-right: current username + logout; Admin item only for `is_admin` users.
- **Global "AI working" indicator**: a small badge in the navbar (spinning marker + label, e.g. "writing a chapter… "Story Name"") — it names the story being worked on (the active `ai_run`'s target, resolved server-side), so any page makes clear *which* story is locked. The model is slow (minutes per chapter) — every AI action must make itself visible *everywhere*, including when the user navigates to another page. Implementation: while an action runs the page polls `GET /api/ai/current` (every ~5s); on load, if an action is active, the badge appears and links to AI Monitor. (This lesson came directly from the old build.)

## 3. Pages

### 3.1 Story (`/story`, `/story/:id`)

- **List**: cards with title, primary universe (or "original world"), status, last-updated. "New story" → create with title + primary universe (select, optional = original world).
- **Story page** (the main work area):
  - **Outline editor**: full-width **CodeMirror 6 markdown editor** (CR round 3) — the markdown renders *live* in the one pane as the user types (headings, bold/italic, lists, code; the Preview button still shows the exact final Shelf look). **Lines wrap** (`EditorView.lineWrapping`, like the textareas it replaced — mobile bug fix 2026-10-12: unbroken `pre` lines gave the host a huge intrinsic width and reflowed the mobile layout, see also `.md-host { contain: inline-size }` in the CSS). Manual Save button. Beats like "the two duel (expand this)" live here. The outline may reference canon with markdown links — `[Star Destroyer](star wars)` — display text = entity, link target = what Verify matches against. (Links live in the outline only; chapters are plain prose.) **Lore autocomplete** (FR-13): typing `/word` (slash at line start or after whitespace — URLs never trigger) live-searches the user's lore via `GET /api/lore/search` (title + body, FTS prefix + substring; empty `/` = browse top entries). The dropdown shows title, universe, and a body snippet; ↑/↓+Enter or click **inserts a standard `[Title](Title)` link** at the token — no new syntax, so Verify ✅ and Generate pick it up through the existing matched-link machinery. The **chapter body** uses the same editor (no `/` trigger). If `/js/story.js` ever fails to load, the editors degrade to the plain underlying textareas — the page script talks to them only through a `window.storyEditors` API, so save/verify/AI-lock all keep working. Editor behavior (incl. the `/` search → insert cycle) is regression-tested headlessly in `tests/client-story-editor.spec.ts` (vitest + jsdom drives the real CM6 source with a stubbed fetch).
  - **Verify button** (top of page): scans the saved outline for all `[...](...)` links and matches each target **case-insensitively against lore entry titles and universe names** in the user's universes. Pure string matching, no AI, instant. Result = a report under the button: per link ✅ matched (entry title + its universe) or ❌ not found. Changes nothing.
  - **Settings** (collapsed by default; a "⚙ Settings" toggle under the title expands it):
    - **Primary universe**: single select over the user's universes, "(original world)" option = null. Editable any time. Shown as a small line under the title (e.g. "World: Star Wars").
    - **Borrowed lore panel**: read-only view of everything the story borrows — the primary universe (with entry count), and one row per outline link: link target → matched entry title + its universe, or "not found" if unmatched (same data as Verify, so it stays in sync with the saved outline). Pure listing; no editing here.
    - **Hints** (FR-23a, change request 2026-10-13): per-user preferences for the **summarize hint** — a checkbox ("Suggest summarizing chapters") and a threshold number (default **3**, 1..20): the story page shows a hint banner ("…Do you want to summarize them all now?" + **Summarize now** / **Not now**) once that many chapters lack a summary — the button runs the ONE all-unsummarized-chapters Summarize action (OI-2), and the stream pane shows the per-chapter "k of M" progress so the all-chapters scope is visible. "Not now" dismisses for the browser session only (per story); the checkbox turns it off for good. Saved via `POST /api/settings`. **Summarize now** runs the Summarize action through a guarded handler (alerts if no model is loaded or another AI action is running; dismisses the banner while the run goes) and streams into the **page-level** stream pane (below the chapter grid — NOT inside the chapter pane, so it is visible even with no chapter open).
  - **Chapter list** (top or right rail): `#n · title · status` — click loads the chapter below.
  - **Chapter pane**: title input + markdown editor (CodeMirror, same as the outline) for the body; Save button. Status badge: draft / final. "Finalize chapter" button. While the AI is running for THIS story the page is visibly locked (spinning "the AI is writing this story" marker by the title, inputs read-only, action buttons disabled) — the page polls `/api/ai/current` like the navbar badge does.
  - **Action bar** (top of chapter pane):
    - **Length hint** (word-count dropdown): `(no preference) | under 1000 words | 1000-3000 words | 3000-6000 words | 6000-9000 words | 9000+ words`. Sent as `word_hint` to `POST /api/ai/generate` and appended to the generate system prompt. Type hint only — the UI never counts or verifies words (FR-22a).
    - **Style** (writing-style dropdown, next to Length): `(none)` + the user's saved style prompts ("skills", managed on the AI Monitor). Sent as `style_id`; the chosen style's text is appended to the generate system prompt for that run (FR-22d).
    - **Extract style** (✍, next to the Style dropdown; FR-22e, change request 2026-10-13): the AI reads the story's **last up-to-3 chapters** and streams a description of the author's writing style (the `style_extract` system prompt) into the stream pane. The result appears as text plus a name input — **Save as style** stores it through the existing style-prompt API (so it lands in the Style dropdown for Generate) and reloads; **Discard** keeps the text but saves nothing. Disabled like the other chapter AI buttons while an AI action runs.
    - **Generate next chapter** (no chapter open) / **Generate this chapter** (an existing draft is open in the pane) → both disabled with a tooltip if the model is unloaded ("load a model", Load is one click from AI Monitor) or while any AI action runs (one per user). If the outline has links that don't Verify against anything, confirm first ("3 outline links match no lore — generate anyway?"). *Next* streams a new draft chapter into the read-only "streaming" pane live (SSE) and appends it to the list; *this* asks the model to **rewrite the open chapter in place** (prompt carries the current text as a `CURRENT_CHAPTER` section, and uses the separate `generate_this` system prompt — FR-8) and replaces it — final chapters cannot be regenerated.
    - **Summarize** → summarizes **all** chapters without a summary in one run; streams per-chapter progress markers ("… summarizing ch 2 — Title (2 of 4)…" — rendered in the story page's stream pane, and the AI Monitor's) plus each summary's live output, so the all-chapters loop is visible. A mid-run failure (e.g. the model returning an empty answer at ch 3 after ch 1–2 were saved) is never silent: the story page persists the run's error and shows a **failed-run banner after its post-run reload** (dismiss button; 30-min expiry; cleared when the user starts a new run).
    - **Save chapter** refreshes only the chapter list (`GET /api/stories/:id/chapters`) — the pane stays open, so "Generate this chapter" appears immediately for a just-saved draft without a page reload (FR-22c).
    - **Preview** renders the chapter as it currently sits in the pane (unsaved text included) in a Shelf-style read-only overlay (markdown rendered server-side via `POST /api/stories/:id/preview-chapter`; Esc/backdrop closes) (FR-22b).
    - While the AI is writing THIS story, a red **■ Stop** button sits next to the "the AI is writing this story" marker: it confirms, then `POST /api/ai/runs/:id/cancel` aborts the run (FR-25a).
  - **Story actions**: "Finalize story" (all chapters final → read from Shelf), "AI lore suggestion" button (see §3.2).
- Editing rules: the AI never *quietly* rewrites saved text — "Generate this chapter" is an explicit user click with a confirm, and everything else only appends new drafts.

### 3.2 Lore (`/lore`, `/lore/universe/:id`, `/lore/entry/:id`)

- **Universe list** → click → **entry list** for that universe (title, word count, image thumbnails).
- **Categories** (FR-12a): a "Categories" panel on the universe's lore page — the user **adds** a named category (input + Add) and **deletes** one (✕, confirm; attached entries are detached, never deleted). Clicking a category filters the entry list to it (`?category=<id>`, "show all" to clear). The **entry editor** has a category checkbox group ("check all that apply"); the selection is saved with the entry. Categories are universe-scoped: moving an entry to another universe detaches categories that don't belong there.
- **Entry editor**: title input + markdown textarea + category checkboxes; Save. No autosave — explicit buttons only (keeps UX predictable).
- **Images**: per entry — upload (plain file input), thumbnail row, delete.
  - **Image → description** button per image: opens a result pane, streams the model's text; user copies/edits it into the entry (AI never writes the entry).
- **AI lore suggestion** (also reachable from Story page): click → user sees proposed entries as a list with the full proposed text per item → **each addition has an Apply button** (applies directly); **each deletion shows "delete 'X'?" with a Confirm** (the only confirmation flow in the app).

### 3.3 Universe (`/universe`)

- Create universe (name + description).
- Per universe: entry count, owner; **assign entries** (move an entry between universes — simple "move to" select on the entry editor).
- Delete universe: only if empty, else warn.
- (Admin) user assignment: assign a universe to another user.

### 3.4 AI Monitor (`/ai`)

- **Model card**: vertical model list from `/v1/models`; each row has a **toggle switch** on the right whose position IS the load state (on = loaded, pulsing = loading/unloading). Switching unloads the current model first (one model at a time). The 5s status poll keeps every switch synced.
- **Active action card**: which action is running, started when (named story in quotes), and its **live stream** (the same SSE stream the originating page uses, re-subscribable). Above the stream a **thinking pane** shows the model's reasoning tokens (`thought` SSE events from `reasoning_content` — only when the llama.cpp server is run with reasoning extraction) (FR-25b). A red **■ Stop** button appears while an action runs: confirm → `POST /api/ai/runs/:id/cancel` aborts the in-flight LLM call; the run ends with a "cancelled" error and the stream closes (FR-25a).
- **System prompts**: tabs/sections, one per action — Generate chapter · **Generate this chapter** · Summarize · Lore suggest · Image description · **Extract style**. Each: textarea (prompt text) + Save. Plain, no versioning.
- **Style prompts (skills)** (FR-22d): a separate section below the system prompts. A list of the user's styles — each a name input + textarea + Save/Delete — plus an "Add style" form at the bottom. These are *user-authored writing styles* (how the AI should write), freely addable, and are what the story page's **Style** dropdown offers. They are NOT system prompts (which stay one-per-action).

### 3.5 Shelf (`/shelf`, `/shelf/:id`)

- Grid of finalized stories (title + chapter count).
- Reader: story → chapter list sidebar (collapsible `<details>`) → chapter body rendered from markdown (small md→html renderer server-side). Read-only. **Prev/next chapter buttons** at the top and bottom of the chapter navigate in seq order ("— start/end of story —" at the ends) (FR-5).

### 3.6 Login / Admin

- `/login`: username + password form (server-rendered, POST) + a **Remember me** checkbox (FR-9). Ticked → persistent 30-day session (`Max-Age=2592000` cookie); unticked → a browser session cookie (no `Max-Age`) that dies when the browser closes.
- `/admin/users` (admin only): table of users (username, is_admin, created); add user (name + temp password), delete user, reset password, toggle admin flag. Deleting a user deletes their content (cascade — confirm with a typed username).

## 4. Frontend conventions

- Forms POST to same-page endpoints; redirect back on success (PRG); errors re-rendered with the form.
- All destructive actions confirm via native `confirm()`. No modal framework.
- Client JS is limited to: SSE subscription/rendering, the AI badge poll, model status poll, small form conveniences. Everything else is plain forms + full-page loads.
- Accessibility: semantic HTML, labels on all inputs, keyboard-navigable (WCAG 2.1 AA as target).
- Browsers: current Chrome & Firefox (desktop primary; CSS-only responsive layout for narrow screens — the frame collapses to a top navbar + single-column content below ~860px, FR-1).
