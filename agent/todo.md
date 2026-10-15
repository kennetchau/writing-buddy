# TODO — Writing Buddy (AI novel-writing app, build order)

> ## ✅ RESOLVED 2026-10-07 — the force-logout (was the blocker)
> Root cause was a **units bug**: the session cookie's `Max-Age` was 43
> **seconds** instead of 12h (12h value passed in *seconds* to Express, which
> takes *ms*), so the browser expired the cookie ~43s in and 401'd. Fixed in
> `src/auth/session.ts` (one shared `SESSION_TTL_MS` for cookie + DB) with a
> regression test asserting `Max-Age=43200`. Also added the missing
> **chapter delete button** (the delete API already existed).
> (Earlier cert + "browser security-state" theories were wrong — see
> `agent/issue-autologout.md`.)
> **✅ CONFIRMED 2026-10-08: re-deployed on the host and user-tested live —
> the login sticks 12h and the whole build works in the browser.** No pending
> host actions remain.

> ## Post-build polish (2026-10-07 → 2026-10-08, after all T-tasks were done)
> User-driven fixes/enhancements on top of the finished build — NOT new BRD
> scope. All committed + tested (42 passing) + **deployed on the host and
> user-tested live 2026-10-08** ("I quite like it"; more ideas coming later):
> - **Force-logout fix** — session cookie `Max-Age` was 43 s (ms-vs-seconds
>   bug). See `agent/issue-autologout.md`. → host re-deploy ✅ confirmed
>   2026-10-08 (login sticks 12h, user-tested live).
> - **Chapter delete button** — delete API existed; added the missing UI
>   (`views/story_detail.hbs`, renumbers the rest, refuses finalized).
> - **Story page toolbars** — one shared `.toolbar` style (was mis-padded
>   `.button` + a `float:right` that overlapped); actions grouped by purpose,
>   Delete pushed to the far right.
> - **AI Monitor model list** — replaced the confusing Load/Unload button pair
>   with a vertical list: each model row has a **toggle switch** on the right
>   whose position IS the load state (on=loaded, pulsing=loading). Switching
>   unloads the current model first (one model at a time). See
>   `views/ai_monitor.hbs` (`.model-list` / `.switch`).
> - **SSE `done`-payload reads** fixed in `views/story_detail.hbs` +
>   `views/lore_entry.hbs`; 401 `reason` + `?next=` + login banner +
>   `REQ_LOG=1` + `COOKIE_SECURE=true` kept in for diagnostics.
> - **Generate button ambiguity + "is this story being written?"** (user
>   feedback 2026-10-07):
>   1. *Button context*: with no chapter open the button says "Generate next
>      chapter" (the only thing it can do); when an existing draft is open in
>      the pane the button becomes "Generate this chapter" (regenerate THAT
>      chapter in place — new backend support: `POST /api/ai/generate` now
>      takes optional `chapter_seq`; final chapters refuse, stale summary is
>      cleared). For a rewrite, the prompt gains a `CURRENT_CHAPTER` section
>      (title + existing body, which may be the author's notes) and asks the
>      model to "Rewrite chapter N now" instead of "Write the next chapter"
>      — otherwise the current text wasn't even in the context.
>   2. *Story-level lock visibility*: `/api/ai/current` now resolves the run
>      target to a display name (`title`, e.g. the story title). The navbar
>      badge now reads "writing a chapter… “Story Name”" on EVERY page; the
>      story page itself polls it and, when the active run is THIS story,
>      shows a spinning "the AI is writing this story" marker next to the
>      title, locks the chapter inputs + all chapter/story AI buttons (and
>      disables Summarize/Lore-suggest/New chapter too), and re-attaches to
>      the run's SSE stream so the page still ends with the reload if you
>      reload mid-generation.
>   - Tests: 42 passing (+3: regenerate-in-place, final-chapter refusal,
>     `/api/ai/current` title). NOTE: added `fakeLlm.reset()` — a run that
>     fails BEFORE its chat call (e.g. "no model loaded") leaves its queued
>     canned response for the NEXT test's run to consume, which made the
>     `/api/ai/current` test flaky (run finished in ms, invisible to poll).

> ## Feature Request round (2026-10-08) — all 8 items DONE, tested (48 passing)
> Implemented top-to-bottom from `agent/Feature_Request.md` in one pass
> (user-approved scope). Docs updated to match (BRD FR-22a/b/c, FR-25a/b,
> FR-33; frontend §3.1/§3.4/§3.5/§4; backend §2/§3/§4).
> **Pending host action: re-deploy new code (`deploy/install-quadlet.sh`)
> before the user sees these on the live app.**
> - **FR-1 mobile CSS** — `src/public/styles.css`: below 860px the frame
>   collapses (top horizontal navbar, single-column story/shelf/ai grids,
>   tighter padding). CSS-only.
> - **FR-2 word-count hint** — "Length" select in the chapter pane
>   (5 ranges, `views/story_detail.hbs`); sent as `word_hint` to
>   `POST /api/ai/generate`, whitelisted in `src/ai/routes.ts`, appended to
>   the generate system prompt in `runGenerate` (type hint, no verification).
> - **FR-3 chapter preview** — "Preview" button renders the *current pane*
>   (unsaved text) via new `POST /api/stories/:id/preview-chapter` (same
>   server-side markdown renderer as the Shelf) into a Shelf-style overlay
>   (Esc/backdrop close).
> - **FR-4 save keeps chapter open** — `saveChapter()` no longer reloads:
>   new `GET /api/stories/:id/chapters` re-renders just the list
>   (`#chapter-list-holder`); pane + "Generate this chapter" stay.
> - **FR-5 shelf nav** — chapter list in collapsible `<details>`; prev/next
>   buttons at top+bottom of the reader (`views/shelf_reader.hbs`,
>   route computes prev/next seq+title).
> - **FR-6 AI emergency stop** — `Run.abort` (AbortController) in
>   `src/ai/runs.ts` + `POST /api/ai/runs/:id/cancel`; `chatStream` takes
>   `signal` (abort drops the llama HTTP stream). Red **■ Stop** in the AI
>   Monitor active-action card and next to the story page's "writing"
>   indicator. Cancelled run → status `error`, message "cancelled by
>   user", nothing persisted.
> - **FR-7 thinking visibility** — llama.cpp puts model thinking in
>   `reasoning_content` chat deltas (README: "Reasoning support",
>   `--reasoning-format`). `chatStream` has an `onThinking` callback →
>   new `thought` SSE event (display-only, never persisted) → dedicated
>   thinking pane in the AI Monitor + the story page stream pane. Inert
>   unless the server emits reasoning. Fake-LLM streams `reasoning_content`.
> - **FR-8 second generate prompt** — new `generate_this` action in
>   `system_prompt` (5th AI Monitor tab, default prompt in
>   `src/db/prompts.ts`, seeded idempotently); `runGenerate` uses it when
>   `chapter_seq` is set. Prompt POST now validates against `AI_ACTIONS`.
> - Tests: 48 passing (+6: word_hint inject/whitelist, generate_this prompt
>   split, thought events, cancel run, preview endpoint, chapter-list API).
> - **Live llama.cpp check needed on re-deploy**: if the model thinking is
>   never shown, start the llama server with `--reasoning-format deepseek`
>   (or the equivalent the model supports) — the app side is ready either
>   way.

> ## Bug fix (2026-10-09): non-admin home page 403 "admin only"
> Symptom: create a user (as admin), log in as that user → home page shows
> 403 "admin only" (though /story etc. worked once navigated to directly).
> Root cause: `src/admin/routes.ts` had `adminRouter.use(requireAuth,
> requireAdmin)` — unscoped router-level middleware on a router mounted at
> "/", so it ran for EVERY request passing through, and rejected any
> non-admin request that had not already matched an earlier router. `GET /`
> matches no earlier route → hit `requireAdmin` → 403 before
> `app.get("/")` could redirect to /story (unknown pages 403'd too, instead
> of the 404 view). Fix: scope the gate to the admin paths only —
> `adminRouter.use("/admin", …)` + `adminRouter.use("/api/admin", …)`.
> Regression test in `tests/phase5.spec.ts` (non-admin `GET /` → 302 /story;
> unknown page → 404, not "admin only"). 54 tests passing.
> **Host action: re-deploy** (`deploy/install-quadlet.sh`) — the live app
> (pre-feature-request build) has the same bug.

> **Future sessions: read this file first. Pick the first unchecked task (top to
> bottom). Before starting any task, re-read the relevant section of
> `agent/brd.md` (what) and `agent/technicaldoc_frontend.md` /
> `agent/technicaldoc_backend.md` (how) and verify the task still matches them —
> if code/docs disagree, the docs win; if a task looks wrong against the docs,
> stop and ask before coding. Tick `[x]` only after its Check passes. Keep task
> IDs stable; append new tasks at the end of their phase.**

Spec of record: `agent/brd.md` (v2.0) + `agent/technicaldoc_frontend.md` +
`agent/technicaldoc_backend.md`. Reference folders (`reference/story_creator`,
`reference/llama.cpp`) are read-only.

> ## Bug-sweep round (2026-10-09) — full code review, 9 bugs fixed (53 passing)
> User asked for a full sweep of the codebase. Read every `src/`, `views/`,
> `tests/`, `deploy/` file. Fixed (all regression-tested):
> 1. **`/lore` story picker was empty** — route passed `storiesJson` but the
>    template iterates `{{#each stories}}`; the FR-15 "AI lore suggestion
>    (from a story)" panel on the Lore page could never pick a story.
> 2. **Universe "Assign user" dropdown was empty** — same class of bug
>    (`usersJson` vs `{{#each allUsers}}`) on the admin Universe page.
> 3. **Story-page "Confirm delete" for AI lore suggestions silently failed** —
>    `views/story_detail.hbs` sent the raw suggestion without `confirmed`,
>    the server (correctly) rejected the delete, and the client still alerted
>    "Applied." (the API answers 200 `{ok:false}` on rejection). Now sends
>    `confirmed` after the user's confirm() and checks `ok` before claiming
>    success.
> 4. **"Generate this chapter" clobbered the chapter title** — the prompt
>    says "do not include a chapter title line", so `body[0]` is prose; the
>    rewrite overwrote the author's title with the chapter's first line.
>    Rewrites now keep the existing title (next-chapter still falls back to
>    the first line — the only source available there). Also: next-chapter
>    seq is now `max(seq)+1` (was `count+1`, fragile against seq gaps).
> 5. **Markdown link sanitizer allowed `//evil.example`** (protocol-relative
>    → open redirect in Shelf/Preview) — now neutralized.
> 6. **`GET /login` redirect loop with a stale cookie** — it redirected to
>    `/` whenever the cookie was PRESENT; with a stale cookie whose DB row is
>    gone that looped `/login → / → 401 → /login`. Now redirects only for a
>    valid session.
> 7. **Error handler HTML-injected `err.message`** (can carry llama/pg
>    external input) — now escaped; also `headersSent` guard.
> 8. **NaN `universe_id`/`move_to` body values → 500** (passed straight to pg)
>    on entry create/move + story create/save — now 404/400-class rejections.
> 9. **Finished AI runs leaked in memory** — the in-process `runs` map kept
>    every run (full chapter text in `events`) forever; now finished runs are
>    evicted after 1 h.
> Tests: 48 → **53 passing** (+4 markdown sanitizer, +1 /lore picker
> regression, +assertions in the admin-assign test; the regenerate-in-place
> test now asserts the title is KEPT). Docs unchanged (no spec deviation —
> item 4 matches the backend doc's "no title line" prompt).
> **PENDING HOST ACTION: re-deploy `deploy/install-quadlet.sh`** (the live
> app still runs the pre-feature-request build, so this is folded into that
> pending re-deploy).

> ## Feature Request round 2 (2026-10-09) — FR-9/10/11 DONE, tested (60 passing)
> Items 9–11 from `agent/Feature_Request.md` (user's third batch), implemented
> top-to-bottom in one pass. Docs updated to match (BRD FR-9/FR-12a/FR-22d +
> data model; frontend §3.1/§3.2/§3.4/§3.6; backend §2/§3/§4/§5).
> - **FR-9 remember-me (login)** — "Remember me" checkbox on `/login`
>   (`views/login.hbs`; form `remember=on`, JSON `remember: true`). Ticked →
>   30-day persistent session (`Max-Age=2592000`); unticked → **no** Max-Age:
>   a browser session cookie that dies when the browser closes (the "logout
>   when close" the user asked for). The `session` table gained
>   `remember BOOLEAN` (`ALTER TABLE … ADD COLUMN IF NOT EXISTS` — the table
>   already exists on old DBs, `CREATE TABLE IF NOT EXISTS` wouldn't add the
>   column); the sliding window extends by the ROW's TTL (30d vs 12h) so a
>   remembered session never silently downgrades, and `POST /api/auth/
>   change-password` re-issues the cookie with the same flag. See
>   `src/auth/session.ts` (`REMEMBER_TTL_MS`, `sessionCookieOptions(secure,
>   remember)`, `sessionRememberFlag`).
> - **FR-10 lore categories** — user-defined categories **per universe**:
>   `lore_category` (+unique index `(universe_id, lower(name))`) and
>   `lore_entry_category` (0..n each). Universe lore page
>   (`views/lore_universe.hbs`) gains a Categories panel: add (input + Add),
>   delete (✕ + confirm; detaches entries, never deletes them), click to
>   filter the list (`?category=<id>` + "show all"). Entry editor
>   (`views/lore_entry.hbs`) has a checkbox group; `POST /api/entries/:id`
>   accepts `category_ids` (ids must belong to the entry's universe, else 400)
>   and moving an entry to another universe detaches foreign categories.
>   API: `POST /api/lore-categories`, `POST /api/lore-categories/:id/delete`,
>   `GET /api/entries/:id` now includes `categories`. Bookkeeping only —
>   generate/verify ignore categories.
> - **FR-11 style prompts ("skills")** — `style_prompt` (per user, name uq
>   case-insensitive). AI Monitor (`views/ai_monitor.hbs`) gained a
>   "Style prompts (skills)" section: list of name+textarea+Save/Delete + an
>   Add form; API `GET/POST /api/style-prompts/:id` (`:id=0` creates),
>   `POST /api/style-prompts/:id/delete`. Story page
>   (`views/story_detail.hbs`) got a **Style** dropdown next to the Length
>   hint (`(none)` + the user's styles); `generateChapter` sends `style_id`,
>   `POST /api/ai/generate` validates it as the user's row (400 otherwise)
>   and stores it on the run target; `runGenerate` appends a
>   `Writing style … ---text---` block to whichever generate system prompt is
>   in use (next AND generate_this modes). Deliberately NOT the out-of-scope
>   agentic "style/taste system" — it is user-authored prompt text (BRD note).
> - **Build bug found while smoke-testing**: `npm run build` did
>   `cp -r views dist/views` — once `dist/views` exists, cp nests into
>   `dist/views/views/` and the top-level templates go **stale** silently
>   (local re-builds served Oct-7 templates; the Docker build stage is clean
>   each run, so prod never noticed). Now `rm -rf dist/views &&` first.
>   Rule of thumb: a rebuilt app that "ignores" template edits → check
>   `dist/views` mtime / nesting before suspecting the template.
> - Schema gotcha hit locally: a table-level `UNIQUE (col, lower(name))`
>   constraint is NOT valid SQL (PG table constraints can't take expressions)
>   — use a `CREATE UNIQUE INDEX … (universe_id, lower(name))` instead.
> - Tests: 54 → **60 passing** (+2 remember-me/checkbox, +3 categories
>   (CRUD/attach/filter/delete, move-detach, isolation), +1 style prompts
>   (CRUD + injection into both generate modes + rejection)). `npm test` and
>   a live curl smoke (login cookie bytes, all four pages) verified.
> **PENDING HOST ACTION: re-deploy `deploy/install-quadlet.sh`** (folded into
> the same pending re-deploy as the rounds above — the live app still runs
> the pre-feature-request build).

> ## Change Request round 3 (2026-10-11) — live markdown editor + `/` lore search
> Chat change request (user, 2026-10-11; logged as FR items 12–13 in
> `agent/Feature_Request.md`): (1) the story input boxes should **render the
> markdown live** — one pane, no split preview → **CodeMirror 6** markdown
> editor (decided in chat; `marked` was discussed first and then dropped,
> CM6 renders the formatting inline). (2) typing `/word` in the **outline**
> triggers a **live lore search** (`GET /api/lore/search` — Postgres
> full-text prefix + substring over the user's accessible entries); picking
> a suggestion inserts a plain `[Title](Title)` link, so **no new syntax**:
> Verify/generate pick it up through the existing matched-link machinery.
> Packages: `codemirror` + `@codemirror/{lang-markdown,autocomplete,state,
> view}` (runtime, **bundled** — see CR-2) and **`esbuild`** (devDependency;
> the app's first bundler — no Vite, no framework). **Deploy unchanged**:
> no unit/port/env/volume/schema change; the editor ships as one static
> `/js/story.js` built inside the image. Rides the same pending host
> re-deploy as the FR rounds.
> - [x] **CR-1** `GET /api/lore/search?q=&limit=` (in
>       `src/lore/routes.ts`) — title+body search over entries in universes
>       the user can access; FTS prefix tokens (`word*`, `simple` config,
>       title weight A / body B) + `ILIKE` substring fallback; empty `q` =
>       browse list (by title). Returns
>       `{q, results: [{id, title, universe, universe_id, snippet}]}`.
>       *Check: tests — token/multi-token, substring-in-token, empty-q
>       browse + limit clamp, isolation (user B never sees user A's lore),
>       401.*
> - [x] **CR-2** Client bundle: `esbuild` devDep + `build:js` script
>       (`esbuild src/public/js/story.ts --bundle --format=iife --minify
>       --outfile=dist/src/public/js/story.js`), `src/public/js/story.ts`
>       excluded from tsc, `<script src="/js/story.js" defer>` in
>       `views/story_detail.hbs` only. *Check: `npm run build` emits the
>       bundle; story page serves it; other pages unaffected.*
> - [ ] **CR-3** CodeMirror 6 editors for the **outline box + chapter
>       body** (single pane, live heading/bold/italic/list/code rendering;
>       plain textareas kept as content source + no-JS fallback). Page JS
>       talks through a `window.storyEditors` API (stub backed by the
>       textareas, swapped in by the bundle) so save/verify/preview/
>       load/new + the AI-lock `readOnly` all work with or without the
>       bundle. *Check: smoke-boot + browser walkthrough of those flows.*
>       **Status 2026-10-11:** bundle + stub + hosts verified in smoke boot;
>       `window.storyEditors` contract covered headlessly — only the real
>       browser walkthrough (host deploy) is left.
> - [ ] **CR-4** `/` autocomplete in the **outline** (CM6
>       `@codemirror/autocomplete` custom source → `/api/lore/search`;
>       ↑/↓/Enter or click → insert `[Title](Title)` replacing the
>       `/token`; empty `/` = browse top entries). No trigger in the
>       chapter body (canon links live in the outline only). *Check:
>       browser — type `/star`, dropdown shows entries, Enter inserts the
>       link, Verify reports it ✅.* **Status 2026-10-11:** full
>       type→search→dropdown→accept cycle proven headlessly in
>       `tests/client-story-editor.spec.ts` (vitest + jsdom, real CM6
>       source, 5 cases) — incl. the two silent-failure gotchas found
>       there (lessons 9/10 in AGENT.md: Promise in `options`, `filter:
>       false`). Awaiting host deploy + user's browser.
> - [x] **CR-5** Docs: frontend doc §1 (stack/bundle note) + §3.1
>       (outline/chapter editors + `/` search), backend doc §3 (endpoint
>       row) + §6 (esbuild step, "no deploy-topology change" note),
>       `AGENT.md` (bundled client JS + this round's status). *Check: no
>       stale "plain textarea" statements left in the docs.*
> - [ ] **CR-6** Full pass — DONE 2026-10-11 (re-run after the CR-4 bug
>       fixes): `npm test` green (73 tests: 68 server + 5 headless client),
>       `npm run build` clean (tsc + esbuild → 613 KB iife), smoke boot of
>       the real app (login, story create, story page serves hosts/stub/
>       bundle tag, `/js/story.js` 200, search endpoint live). FR items
>       12/13 get ticked (and CR-3/CR-4 above) after the **host re-deploy +
>       user browser walkthrough**.

## Change Request round 4 (2026-10-13) — summarize hint + extract style
> Chat change request (user, 2026-10-13; logged as FR items 14–15 in
> `agent/Feature_Request.md`):
> 1. **Summarize has no guidance** → the story page now nudges the author:
>    once a story accumulates unsummarized chapters (default **3**), a hint
>    banner offers "Do you want to summarize now?" with **Summarize now**
>    (the existing Summarize flow) / **Not now** (dismisses per browser
>    session, per story). Disableable in **⚙ Settings → Hints** on the
>    story page (per-user, Postgres — new `user_setting` table, keys
>    whitelisted in `src/settings/settings.ts`; `GET/POST /api/settings`).
> 2. **Style from chapters** → new AI action **style_extract** ("✍
>    Extract style" button next to the Style dropdown): the model reads the
>    story's **last up-to-3 chapters** (oldest dropped past ~60% of ctx)
>    with its own editable system prompt (seeded like the others; new AI
>    Monitor prompt tab) and streams a 150–250-word description of the
>    author's writing style as guidance for an AI writer. The result arrives
>    in the stream pane as text + name input: **Save as style** goes
>    through the EXISTING `POST /api/style-prompts/0` (so the saved style
>    feeds the generate Style dropdown) and **Discard** saves nothing — the
>    action itself persists nothing (image_desc pattern). New kind wired
>    through `AI_KINDS` → `beginAction` → `runStyleExtract`, the navbar
>    badge ("extracting style… “Story”"), `describeTarget`, Stop button,
>    and the story page's AI-lock.
> - [x] **CR7-1** `user_setting` table + `src/settings` (whitelisted keys:
>       `summarize_hint` on/off, `summarize_hint_chapters` 1..20) +
>       `GET/POST /api/settings` (unknown key / bad value → 400).
>       *Check: tests — defaults, save, whitelist, per-user isolation.*
> - [x] **CR7-2** Summarize hint banner on `/story/:id` (server-rendered
>       from settings + unsummarized count) + Hints block in ⚙ Settings +
>       sessionStorage dismissal. *Check: tests — banner at threshold,
>       hidden below it / when disabled / when chapters are summarized;
>       threshold respected.*
> - [x] **CR7-3** `style_extract` prompt + kind + `POST /api/ai/style-extract`
>       + `runStyleExtract` (last-3-chapters selection, budget drop-oldest,
>       free-text `done` payload) + badge/monitor labels.
>       *Check: tests — done.text + prompt carries chapter bodies + seeded
>       system prompt; last-3-only with 5 chapters; no-chapters → error run;
>       prompt seeding lists 6 actions (phase1 + phase4).*
> - [x] **CR7-4** Story page "✍ Extract style" button + save/discard card
>       (saves via the existing style-prompts API) + button in the AI-lock
>       list. *Check: smoke boot renders; browser walkthrough on re-deploy.*
> - [x] **CR7-5** Docs: BRD FR-22e/FR-23a + FR-33 + data model; frontend
>       §3.1 (hints setting + Extract style) + §3.4 (prompt tabs); backend
>       §2/§3/§4/§6 (`user_setting`, style-extract + settings endpoints,
>       prompt assembly, deploy-neutral note). *Check: no stale statements.*
> - [x] **CR7-6** Full pass: `npm test` green (**79 tests**: +5 this round,
>       +1 for the new prompt in phase1), `npm run build` clean.
> **PENDING HOST ACTION: re-deploy `deploy/install-quadlet.sh`** — ONE
> re-deploy now carries all FR rounds + round 3 + the 2026-10-12 mobile
> fix + this round 4 (the `user_setting` table is created by the idempotent
> schema.sql at boot — no manual migration).
>
> ### Bug fix (2026-10-13, same day): hint banner "Summarize now" did nothing
> User reported the banner button being dead. TWO real bugs, both found by
> repro:
> 1. **`{{storyTitleJson}}` was HTML-escaped by hbs** → every story page
>    rendered `const STORY_TITLE = &quot;…&quot;` → **SyntaxError on line 1
>    of the inline script → the entire page script died → EVERY button on
>    the page silently did nothing** (the banner was just the first one
>    noticed). Fix: triple braces `{{{storyTitleJson}}}` (the established
>    raw-JSON-local pattern, cf. `{{{borrowedJson}}}`).
> 2. **The stream pane lived inside the chapter pane** (hidden when no
>    chapter is open — the normal state when clicking the banner at the top
>    of the page), so even a working click streamed progress/errors into an
>    invisible element. Fix: `#stream-pane` (+ "AI activity → AI Monitor"
>    link) moved to page level, after the story grid.
> Plus: the banner button now uses a guarded `summarizeFromHint()` (alerts
> if no model loaded / another AI action is running, dismisses the banner
> while the run goes) instead of the bare toolbar `summarize()`.
> Tests: +2 (raw-JSON-local regression with a quoted `&` title; page-level
> stream pane + banner handler asserted in the hint test). 80 passing.
>
> ### Follow-up (2026-10-13): "Summarize now" = ALL unsummarized chapters, visibly
> User asked for the banner to summarize ALL unsummarized chapters, not one.
> The behavior was ALREADY all-chapters (OI-2; `runSummarize` loops every
> `summary_md IS NULL` chapter, one LLM call each — T4.6 proves 2/2); the
> problem was visibility: the story page's stream pane dropped the
> `thinking` phase markers, so the run looked like a single summary. Now:
> (1) server markers read "summarizing ch N — Title (k of M)…" (progress
>     count),
> (2) the story page stream pane renders `thinking` events (the AI Monitor
>     already did),
> (3) banner text says "Do you want to summarize **them all** now?".
> Tests: T4.6 now asserts the two "k of 2" progress markers; the hint test
> asserts the "them all" wording. 80 passing.
>
> ### Fix (2026-10-13, user report: "Summarize now only summarizes the
> first chapter") — the all-chapters loop is intact; the run was DING
> MID-RUN and the failure was invisible. Three fixes:
> 1. **Server**: an empty (reasoning-only) model answer is now **retried
>    once** before failing (the most likely real-server cause of the run
>    dying right after chapter 1); if it still fails, the error names the
>    failed chapter AND lists which summaries survived ("Chapters 1 were
>    summarized and saved — click Summarize again to do the rest").
>    Earlier chapters' summaries are KEPT (each saves as it finishes).
> 2. **Client**: the story page now persists a run's error to sessionStorage
>    and shows a **failed-run banner after the post-run reload** (previously
>    the `[error]` line flashed and the immediate `location.reload()` wiped
>    it — leaving exactly the "only ch 1 summarized, no clue why" state).
>    Dismiss button; 30-min expiry; auto-cleared when a new run starts.
> 3. Tests: +2 (empty-answer retry succeeds; dying at ch 2 of 3 → error
>    names ch 2 + saved ch 1, DB shows exactly ch 1 summarized). 82 passing.
> **PENDING HOST ACTION: re-deploy** (folded into the same pending
> re-deploy; this is what the user needs to see the explained partial state
> + the retry).
>
> ### Review (user QA on newest version: "banner Summarize still only
> summarizes one chapter" + "no indication which chapters are summarized")
> The user re-deployed (newest version — do not re-ask) and QA'd:
> (a) "Summarize now" still ends up with only 1 chapter summarized;
> (b) the story page gives no indication of which chapters are already
> summarized.
> **Review verdict on (a): the all-chapters loop is CORRECT** — `runSummarize`
> (src/ai/actions.ts) loops EVERY `summary_md IS NULL` chapter, saves each as
> it completes, retries an empty answer once, and its failure error names the
> failed chapter + which summaries survived (tests: T4.6 + the two failure
> tests). So "stopped at ch 1" = the run FAILED mid-run after ch 1 (or was
> still running when the user looked — runs on the slow local model take
> minutes per chapter; the page reloads only at run end). **STANDING
> INSTRUCTION: before changing any summarize code, get the user's EXACT red
> "The last AI run on this story failed: …" banner text** (it should read
> "empty summary for ch N — … Chapters X were summarized and saved…").
> Suspected root cause, host-side: model returns empty/reasoning-only
> answers. Contributing code-side factor found in review: `maxTokens: 600`
> for the summarize calls — on a llama.cpp server run with
> `--reasoning-format`, reasoning tokens count against `max_tokens`, so a
> chatty thinker can spend the whole 600-token budget on
> `reasoning_content` and leave `content` empty (→ the empty-retry →
> mid-run failure). Candidate fix (NOT yet made — wait for the banner
> text): raise the summarize `maxTokens` (e.g. 2000).
> **UI fixes shipped for (b) + review nits (regression-tested, 83 passing):**
> 1. **"✓ summarized" indicator**: green `.badge.summary` on each
>    already-summarized chapter in the list (was an inconspicuous grey
>    "summarized" pill that read as nothing) + a status line in the OPEN
>    chapter pane under the Title input ("✓ Summarized — the AI remembers
>    this chapter from its summary." / "No summary yet — … click
>    Summarize."), filled from the chapter API's existing `has_summary`.
>    (views/story_detail.hbs, src/public/styles.css, +1 test: badge on ch1
>    only, pane element, API has_summary true/false.)
> 2. **Double SSE subscription**: the 5s `refreshAiActivity` poll attached a
>    SECOND stream to a run the page had just started (it couldn't know —
>    `aiBusy` is only set by the poll), which reset the stream pane to
>    "starting…" a few seconds into the run. Fixed: `streamedRuns` Set, the
>    poll skips runs this page already streams.
> 3. The chapter-pane `summarize()` lacked the busy/model-loaded guards every
>    other AI entry point has (double-click → raw 409 alert). Added.
> 4. Summarize toolbar button got a `title` explaining it summarizes ALL
>    unsummarized chapters (it is not "summarize this chapter").
> Tests: 82 → **83 passing**. Inline-script syntax re-verified with
> `node --check` (the new JS badge title string initially carried an
> unescaped apostrophe — the sort of bug that kills the whole page script;
> see lesson 11).
> **PENDING HOST ACTION: re-deploy** (folded into the same pending
> re-deploy). After re-deploy: user checks the ✓ badges + pane status line;
> on the next failed summarize run, get the EXACT failed-run banner text.
>
> ### Round 5 (2026-10-14, user QA on re-deployed version — "your fix does
> not work")
> User report, verbatim gist: (1) previous summarize fix did not work;
> (2) opened chapter 6, clicked Summarize there, "it still summarizes
> chapter 1"; (3) "even the summarize dialogue is gone (for chapter 1)";
> (4) chapter 1 still has NO summary.
> Analysis:
> - (2) is **designed behavior, not a bug**: the chapter-pane/toolbar
>   Summarize button posts only `story_id`; `runSummarize` loops EVERY
>   unsummarized chapter in ascending seq, so a run always starts at the
>   OLDEST unsummarized chapter (ch 1). The button tooltip says this, but
>   the user has now hit this expectation twice (rounds 4+5) — they want
>   the button on the open chapter to summarize THAT chapter. SCOPE
>   QUESTION ASKED (2026-10-14): should the chapter-pane button become
>   "Summarize this chapter" (target `chapter_seq`) while the toolbar one
>   stays "summarize all"? NOT implemented yet — confirm with user first.
> - (3)+(4) mean the run FAILED and the user saw no explanation: the
>   failed-run banner (sessionStorage, 2026-10-13 fix) only shows if the
>   page that streamed the run is still open when it ENDS — user
>   apparently left the page / the pane had already vanished. The run
>   died at ch 1 this time (nothing saved). **STANDING INSTRUCTION STILL
>   IN FORCE: get the exact error text before changing summarize code.**
>   Fastest path given the user is not on the page at run-end: the
>   `ai_run` table already stores it. One-liner given to the user for the
>   host (paste output back):
>   `podman exec novel-db psql -U novel -d novel -c "SELECT id, kind, status, left(error,300) AS error, started_at, ended_at FROM ai_run ORDER BY id DESC LIMIT 8;"`
>   If it confirms "empty summary for ch 1 — …" → apply the candidate fix
>   (summarize `maxTokens` 600 → ~2000 in src/ai/actions.ts, reasoning
>   tokens eat the budget on `--reasoning-format` servers) + re-deploy.
>   If it says something else (model server unreachable / no model loaded /
>   cancelled) → the bug is host-side, not code.
>   User replied (2026-10-14): "there is no banner at all and no summary is
>   generated" — i.e. they did NOT catch the banner (consistent with
>   leaving the page at run-end), and did not run the psql one-liner.
> **SHIPPED (2026-10-14): DB-backed failed-run banner** — the sessionStorage
> banner only showed if the page was still open (streaming) when the run
> ended; now the story page reads the story's LAST `ai_run` row from the
> DB on load and shows "⚠ The last AI run on this story failed
> (summarize): <exact error>" until dismissed (per run id) — so a failed
> run is reported on the NEXT visit, no need to watch the stream. Parts:
> new `GET /api/ai/last-run?story_id=` (src/ai/routes.ts, filters
> `target_jsonb->>'story_id'`); story_detail.hbs: `showSavedRunError`
> (sessionStorage IIFE) replaced by a top-level `api(...)` fetch of
> last-run, `dismissRunError(runId)` stores `aiRunErrorDismissed` per run
> id, `streamTo` no longer persists the error, `refreshAiActivity` no
> longer clears the old key (banner removal on new run kept — a newer run
> replaces "the last run" so it won't come back). +1 test (null before
> any run; failed ch-1 run → exact "empty summary for ch 1" error
> queryable; sibling story unaffected; later success → status done; page
> HTML references the endpoint). **84 passing.**
> STILL PENDING: the actual summarize failure text — either the psql
> one-liner above on the CURRENT deploy (fastest, no re-deploy), or the
> new banner after the next re-deploy. If it says something UNRELATED to
> empty answers (model not loaded / unreachable / cancelled), the 40k
> token budget won't help and the fix is host-side.
> **SHIPPED (2026-10-14, user instruction "Boost the summary token count
> on 40k" — overrides the "wait for banner text" gate): summarize
> `maxTokens` 600 → 40000** (src/ai/actions.ts `runSummarize`, with the
> reasoning-budget comment). Recorded as FR-16 in
> agent/Feature_Request.md (change request round 5). fake-llm now records
> `max_tokens` per chat call; the new last-run test asserts the summarize
> requests carry 40000 (call + retry). 84 passing.
> ALSO STILL OPEN (asked, user hasn't answered): should the chapter-pane
> Summarize button become "Summarize THIS chapter" (chapter_seq) while the
> toolbar/banner button stays "summarize all"?

> ## Bug fix (2026-10-12): code editor broke the mobile layout ("desktop site,
> everything stretched out")
> User report: after the CR-3 editors went in, the story page on a phone
> rendered in the scaled-down desktop layout. Root cause (measured
> headlessly with playwright): CodeMirror's `.cm-content` is `white-space:
> pre`, so the editor host's **intrinsic min-content width = the full width
> of the longest line** — one long AI paragraph (no hard line breaks) made
> the story page's min-content width ~2000-3000px. Mobile browsers (iOS
> Safari most of all) size the layout viewport at least as wide as the
> content's min-content width → the `<860px` media query stopped matching →
> the whole app reflowed to the desktop layout, zoomed out ("desktop site,
> everything stretched out"). The old textareas never did this (textarea
> min-width ≈ 20ch).
> Fixes: (1) `EditorView.lineWrapping` in `src/public/js/story.ts` (both
> editors — restores the textarea wrap behaviour; long prose now wraps on
> phones); (2) `.md-host { contain: inline-size; overflow-x: hidden; }` in
> `src/public/styles.css` — severs the editor's intrinsic width from the
> document (measured: host min-content 2705px → 0; verified the editor still
> renders/wraps/scrolls). Regression: new headless client test asserts
> `cm-lineWrapping` on both editors (74 tests passing). **Also fixed while
> probing**: `views/story_detail.hbs` called `novelAuthLost()` at top level —
> it is defined by the *deferred* `/js/app.js` (runs after the inline
> script), so the first call threw a ReferenceError and the
> `setInterval(refreshAiActivity, 5000)` below it never registered (the
> story-level AI lock stopped working on reload). Now a `typeof` guard.
> **Rides the same pending host re-deploy.**

## Phase 1 — Skeleton

- [x] **T1.1** Repo scaffold: `package.json` (Node 22, TS, Express + hbs + pg +
      argon2 + multipart), `tsconfig.json`, `src/` layout per backend doc §1,
      config from env vars, entry point boots an Express app.
      *Check: `npm run build && node dist` serves a placeholder page on the
      configured port.*
- [x] **T1.2** `schema.sql` (backend doc §2, verbatim) applied idempotently at
      boot; `pg` query helpers with user-scoping filter.
      *Check: boots against a disposable local Postgres; re-running is a no-op.*
- [x] **T1.3** Auth: `/login` (argon2id + cookie session, 12h sliding),
      `/api/logout`, `/api/me`, first-admin bootstrap (env `ADMIN_USERNAME` /
      `ADMIN_PASSWORD` creates the admin if no users exist).
      *Check: login/logout/protected-route tests green; wrong pw rejected.*

## Phase 2 — Lore & Universes

- [x] **T2.1** Universe CRUD API + Universe page (create, list w/ entry counts,
      delete-if-empty, admin user assignment).
- [x] **T2.2** Lore entry CRUD API + Lore page (entry list per universe,
      markdown editor w/ explicit Save, move entry between universes).
- [x] **T2.3** Images: upload to single flat dir (multipart), path in `image`
      table, static serving, attach to entry, delete.
      *Check for T2.1–T2.3: API tests cover ownership isolation (user A cannot
      read/write user B's universes/entries).*

## Phase 3 — Story core

- [x] **T3.1** Story CRUD (title + primary universe select, nullable) + Story
      list page + Story page skeleton (outline editor w/ Save, settings toggle
      w/ primary-universe select).
- [x] **T3.2** Verify: `POST /api/stories/:id/verify` — extract `[t](target)`
      links, case-insensitive match entry titles then universe names,
      per-link result; Verify button + report UI; borrowed-lore panel in the
      settings pane (same data, read-only).
- [x] **T3.3** Chapter CRUD (list, load into chapter pane, save, status,
      finalize chapter, finalize story) + Shelf (list finalized, reader with
      server-side markdown render, read-only).
      *Check: create story → outline w/ links → verify report matches
      hand-computed result; finalize → readable on Shelf.*

## Phase 4 — AI

- [x] **T4.1** LLM client module: llama.cpp `/v1/models` poll,
      `/v1/chat/completions` streaming wrapper (read timeout 900s), defensive
      JSON parse helper (see `reference/story_creator/app/llm/verdict.py` for
      the failure modes). Fake-LLM mock for tests.
- [x] **T4.2** Model management: `/api/model` (GET status),
      `/api/model/load|unload` (proxies llama router API, async load state) +
      AI Monitor model card.
- [x] **T4.3** `ai_run` lifecycle: one action per user (409 otherwise),
      SSE stream endpoint with `start`/`delta`/`done`/`error` vocabulary,
      re-subscribable; `GET /api/ai/current`; navbar "AI working" badge (poll 5s).
- [x] **T4.4** System prompts: seed per user×action, AI Monitor edit UI
      (4 tabs, textarea + save).
- [x] **T4.5** **Generate chapter**: prompt assembly per backend doc §4
      (outline + primary-universe lore + matched-link entries + summaries +
      last 2 chapters, section delimiters, 60%-context truncation), stream to
      new draft chapter, unmatched-link confirm on the client.
- [x] **T4.6** **Summarize**: all chapters without summary, sequential calls,
      ~200-word summaries into `chapter.summary_md`.
- [x] **T4.7** **Image → description**: base64 image parts call, streamed
      result pane (user copies into entry; nothing auto-written).
- [x] **T4.8** **Lore suggestion**: JSON `{type, universe, title, body_md,
      reason}`; UI list — adds applied per-item, **deletes require confirm**;
      backend never deletes lore itself.
      *Check: full fake-LLM suite — generate/summarize/image/lore-suggest each
      produce correct DB state through the SSE lifecycle, including error and
      one-action-per-user 409.*

## Phase 5 — Admin & ops

- [x] **T5.1** Admin user management page + API (add w/ temp pw, delete
      cascade w/ typed-username confirm, reset password, toggle admin).
- [x] **T5.2** Backup script + systemd user timer (nightly `pg_dump` + images
      dir, 14× retention).
- [x] **T5.3** **systemd quadlet deploy**: `deploy/` — `novel-db.container`
      (postgres:16, named volume, network-only, no host port),
      `novel-app.container` (multi-stage build from this repo,
      `novel-images` volume, env: `DATABASE_URL` → `novel-db`,
      `LLAMA_URL=http://host.containers.internal:21000/v1` (env-overridable —
      old build verified this address; see `reference/story_creator/deploy/
      DEPLOYMENT.md` for SELinux `:z`, uid mapping, rootless-pasta quirks),
      port 9187), shared network unit, install script.
      *Check: on the deploy host — both units active, `/api/health` ok,
      llama reachable from app container, login works over LAN.*

## Phase 6 — Hardening & sign-off

- [x] **T6.1** Full test pass (auth isolation, lore links, verify, AI
      lifecycle, admin), `npm run build` clean, manual smoke script in
      `testing/` mirroring the BRD pages end-to-end.
- [x] **T6.2** README: dev setup (local Postgres), deploy pointer, env vars.

## Deferred (not in scope unless the user asks)

Relevance-ranked lore selection · autosave · EPUB/PDF export · notifications ·
version history · multi-model routing.
