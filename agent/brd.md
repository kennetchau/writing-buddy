# Business Requirements Document — Writing Buddy (AI novel-writing app, v2.0, simplified)

|            |                                                                    |
|------------|--------------------------------------------------------------------|
| Version    | 2.0                                                                |
| Date       | 2026-09-08                                                         |
| Status     | For sign-off (supersedes v1.1 "Base OS")                           |
| Context    | Rewrite driven by deliberate simplification of the previous build  |

## 1. Product Vision

A private, LAN web app where an author manages lore (universes + markdown entries), writes a rough story outline, and generates the story chapter by chapter with a local LLM. Every AI action is a button the user clicks — nothing runs in the background. The author edits everything, the AI only helps.

**Design rule for this rewrite: if a feature is not listed here, it is out of scope.**

## 2. Goals & Non-Goals

Goals
1. Single Node.js + TypeScript app (server-rendered, no React/Vite SPA) + PostgreSQL. One codebase, one container.
2. Lore as plain relational data (Postgres), not filesystem/symlinks/git.
3. Chapter-by-chapter AI generation from the outline + lore, streamed live to the browser.
4. Model management: load/unload the LLM on demand (VRAM control) from the AI Monitor page.

Non-Goals
- Agentic multi-role pipelines (Writer/Editor/Publisher loops), Plot Review, Unverified-World Mode, Ask-the-Lore chat, style/taste mining, inline suggestions, notifications center, version history/git, audit logs, multi-node, cloud, EPUB/PDF export. (Desktop is the primary target; **basic mobile support** — usable layout on narrow screens — was added by Feature Request 2026-10-08 but is a CSS-only concern, not a separate app surface.)

## 3. Users

- **User**: creates universes/lore, writes outlines, generates and edits chapters, reads the shelf.
- **Admin** (flag on user row): user management only — add/delete users, set/reset passwords. No other special access.

Auth: local username + password (argon2id hash), cookie session. No lockout policy, no external identity. *Remember me* (FR-9, Feature Request 2026-10-09): a checkbox on the login screen — ticked = 30-day persistent session; unticked = a browser session that ends when the browser closes.

## 4. Functional Requirements

### 4.1 Pages (one vertical navbar)

| # | Page               | Purpose |
|---|--------------------|---------|
| 1 | **Story**          | Projects: create a story, edit its outline, generate next chapter, edit chapter text, trigger summaries, finalize to shelf |
| 2 | **Lore**           | Browse/edit lore entries (markdown text); attach images; AI-assist: image → description, AI lore suggestion |
| 3 | **Universe**       | Create/delete universes; assign entries to universes; user assignment (admin). A story's primary universe is picked on the Story page, not here |
| 4 | **AI Monitor**     | Model status (loaded/unloaded) + Load/Unload buttons; live view of the currently running AI action |
| 5 | **Shelf**          | Read-only reader for finalized stories (chapters in order) |

### 4.2 Lore & Universes

- FR-10 A **universe** is a named container owned by one user (users can own many).
- FR-11 A **lore entry** is a markdown text document (title + body + optional reference images) stored in Postgres; each entry belongs to exactly one universe.
- FR-12 Users create, edit, and delete universes and their own entries freely. No AI is involved unless the user clicks an AI button.
- FR-12a **User-defined lore categories** (Feature Request 2026-10-09): per universe, the user can add and delete named categories and attach 0..n entries to each (entry editor checkboxes). Categories are a bookkeeping aid only — they change no AI behavior, and deleting one detaches (never deletes) its entries.
- FR-13 **Images**: uploaded files go to one flat directory on disk; the database stores the path. An image may be attached to a lore entry.
- FR-14 **AI image → description**: button on an image; the app sends the image to the llama.cpp server (OpenAI-compatible `image_url`/base64 parts; Gemma ships with mmproj, always available) and returns the text. The user copies/edits it into the lore entry — the AI never writes lore itself.
- FR-15 **AI lore suggestion**: button on a story (or entry); the AI proposes lore changes based on the story so far. Policy: **additions are applied directly** (author can edit/delete afterwards); **deletions require a confirmation step** showing what will be deleted. Never anything else, never silent.

### 4.3 Story

- FR-20 A **story** (project) belongs to a user and has one **primary universe** (the world it takes place in), chosen at creation and editable later; it may be null = an original/custom world.
- FR-21 The author writes the story as a **free-form outline** (the overall flow of the plot). Beats may be marked for expansion, e.g. "the two are in a heated battle of swordsmanship (expand this)". Specific concepts borrowed from other universes are written as markdown links in the outline, e.g. `[Infinity Gauntlet](marvel)`.
- FR-21a **Verify** (button, no AI): scans the outline for all markdown links and matches each target case-insensitively against lore entry titles (then universe names) in the user's universes, reporting per link: found (entry + universe) or not found. Instant, changes nothing.
- FR-21b The story's **settings panel** (hidden until toggled) shows the primary universe selector plus a read-only **borrowed-lore panel**: the primary universe and every outline link with its match (entry + universe) or "not found" — i.e. a view of all lore/universes the story draws on.
- FR-22 **Chapter generation** (button): one chapter at a time, sequential. The prompt is built from: outline + lore of the primary universe + lore entries matched by outline links (borrowed concepts) + **all existing chapter summaries** + **the last 2 full chapters**. Output streams live to the browser (SSE). A model must be loaded first (or Load is triggered); if outline links fail Verify, the user is asked to confirm before generating.
  - *FR-22a Word-count hint* (Feature Request 2026-10-08): a dropdown near the chapter title bar offers a length hint (under 1000 / 1000–3000 / 3000–6000 / 6000–9000 / 9000+ words, or no preference). The chosen range is appended to the generate system prompt. **No verification is done — it is a type hint only.**
  - *FR-22b Chapter preview* (Feature Request 2026-10-08): a Preview button renders the chapter currently in the editing pane (including unsaved text) in a Shelf-style read-only panel (same server-side markdown renderer as the Shelf).
  - *FR-22c Save keeps the chapter open* (Feature Request 2026-10-08): saving a chapter refreshes only the chapter list — the pane stays open, so "Generate this chapter" is available immediately after saving a draft.
  - *FR-22d Style prompt / "skill"* (Feature Request 2026-10-09): the user can save multiple named writing styles (the "skills" — how they want the AI to write). On the story page, a dropdown next to the word-count hint lets them pick one (or none); the chosen style's text is appended to the generate system prompt for that run. It is a user-edited text block, not an AI feature — no style analysis, no relevance ranking. (This is deliberately NOT the agentic "style/taste system" listed out of scope in §7; it is just user-authored prompt text.) *AI help landing in the same store was added by FR-22e — the author still reviews and names it before it is saved.*
  - *FR-22e Style extraction* (Change request 2026-10-13): an **Extract style** button on the story page makes the AI read the story's last few chapters (up to 3) and write a description of the *author's* writing style (voice, rhythm, tone, dialogue habits, imagery, register, recurring patterns) as direct guidance for an AI writer. The text streams live like any AI action; the user then **saves it (with a name) or discards it** — saving goes through the FR-22d style-prompt store, so the extracted style appears in the Style dropdown and can be picked for Generate. The action itself persists nothing.
- FR-23 **Chapter summaries**: stored per chapter; generated on user click ("Summarize" summarizes all chapters that lack a summary). Summaries are the AI's memory of older chapters.
  - *FR-23a Summarize hint* (Change request 2026-10-13): when a story accumulates unsummarized chapters — by default once **3** lack a summary — the story page shows a hint banner ("Do you want to summarize now?") with a **Summarize now** button and **Not now** (dismisses for the browser session only). The user can turn the hint off or change the threshold in the story page's **⚙ Settings → Hints** (per-user setting, stored in Postgres).
- FR-24 **Author edits**: chapter text and outline are always editable; edits take effect immediately. Generated chapters start as drafts; the user finalizes a chapter (or the whole story) to move it to the Shelf.
- FR-25 One AI action per user at a time; the running action is visible on the AI Monitor page and its page.
  - *FR-25a Emergency stop* (Feature Request 2026-10-08): a red **■ Stop** button (AI Monitor active-action card, plus the story page's "writing" indicator) cancels the running action: the in-flight LLM stream is aborted and the run ends with a "cancelled" error (nothing is persisted).
  - *FR-25b Thinking visibility* (Feature Request 2026-10-08): when the llama.cpp server extracts reasoning (`reasoning_content` in chat deltas, e.g. `--reasoning-format deepseek`), the model's thinking tokens are streamed to the active-action panel (AI Monitor) and the story page's stream pane, distinctly from the output. Inert when the server doesn't emit reasoning.

### 4.4 AI Monitor & Model Management

- FR-30 Shows llama.cpp model status via `GET /v1/models` (loaded / unloaded).
- FR-31 **Load / Unload buttons** call the llama.cpp router API (`POST /models/load`, `POST /models/unload`) so the user controls VRAM usage.
- FR-32 Shows the currently running AI action (if any) and its live stream; nothing else.
- FR-33 **System prompts**: one editable prompt per AI action (chapter generation, **generate-this-chapter**, summarize, lore suggestion, image description, **style extraction**). Stored in Postgres, edited on the AI Monitor (or a settings area). No versioning. (*The generate-this-chapter prompt was added by Feature Request 2026-10-08 — "generate this chapter" is a different job than "write the next one" and gets its own prompt; the style-extraction prompt by Change request 2026-10-13, for the same reason.*)

## 5. Data Model (PostgreSQL)

| Table            | Key columns                                                        |
|------------------|--------------------------------------------------------------------|
| `user`           | id, username (uq), pw_hash, is_admin, created_at                   |
| `session`        | token (uq), user_id, created_at, expires_at, **remember** (bool — remember-me session, 30d sliding) |
| `universe`       | id, name, description   *(ownership via `universe_user`, per backend doc §2 — no `user_id` column)* |
| `lore_entry`     | id, title, body_md, universe_id, created_at, updated_at            |
| `lore_category`  | id, universe_id, name (uq per universe, case-insensitive) — user-defined categories (FR-12a) |
| `lore_entry_category` | lore_entry_id, category_id (entry↔category, 0..n each) |
| `universe_lore`  | universe_id, lore_entry_id  *(if a different membership shape is needed)* |
| `universe_user`  | universe_id, user_id (ownership / access)                          |
| `image`          | id, filename (path under the single images dir), lore_entry_id (nullable), user_id |
| `story`          | id, title, outline_md, user_id, universe_id (primary, nullable = original world), status (draft \| finalized), updated_at |
| `chapter`        | id, story_id, seq, title, body_md, summary_md (nullable), status (draft \| final), updated_at |
| `system_prompt`  | id, action (uq: generate \| **generate_this** \| summarize \| lore_suggest \| image_desc \| **style_extract**), text_md, user_id |
| `style_prompt`   | id, user_id, name (uq per user, case-insensitive), text_md — writing-style "skills" (FR-22d/22e) |
| `user_setting`   | user_id, setting_key (uq per user), value — per-user settings (FR-23a); keys whitelisted server-side |

No version history, no git.

## 6. Non-Functional Requirements

- NFR-01 Single Fedora host, LAN only. Containers: **app** (Node) + **postgres** on a podman network; the existing **llama.cpp** container is out of scope and is only ever touched via its HTTP API (router mode: `/v1/models`, `/models/load`, `/models/unload`, OpenAI-compatible `/v1/chat/completions` with streaming + image parts).
- NFR-02 Local model (Gemma with mmproj) is slow — every AI action streams; the UI must always show that the AI is working.
- NFR-03 Scale: a handful of users, tens of universes, 200 chapters/book — trivial for Postgres; keep it that way.
- NFR-04 Browsers: current Chrome & Firefox.
- NFR-05 Backups: nightly `pg_dump` + the images directory. (No other data.)

## 7. Out of Scope (explicit)

React/SPA frontend · FastAPI/Python · filesystem lore & symlinks & per-user git · agentic multi-stage pipeline with verdicts/re-loops · Plot Review & Unverified-World Mode · Ask-the-Lore chat · style/taste system · inline text suggestions · proposal/diff approval bundles (only the delete-confirmation exception in FR-15) · notifications center · audit logs · multi-server · cloud · EPUB/PDF export.

## 8. Open Items

| #    | Item                              | Proposed default |
|------|-----------------------------------|------------------|
| OI-1 | "Last N chapters" in the prompt   | N = 2 full chapters + all summaries |
| OI-2 | Summarize scope                   | all chapters without a summary, in order |
| OI-3 | Universe assignment semantics     | entry belongs to exactly one universe; story links universes |
| OI-4 | Node framework / templating       | Express + hbs + small vanilla TS for interactivity + SSE |
| OI-5 | Image → description result target | free text result; user pastes/edits into the entry |
