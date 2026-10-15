# Technical Document — BACKEND (Data Model & API)

|          |                                                     |
|----------|-----------------------------------------------------|
| Version  | 2.0 (companion to BRD v2.0)                         |
| Scope    | Data model, API, AI integration, deploy             |
| Frontend | See `agent/technicaldoc_frontend.md` (UI)           |

## 1. Stack

- **Node.js + TypeScript**, single service. Express + `hbs` (server-rendered), `pg` (Postgres), argon2id (`@node-rs/argon2` or `argon2`), plain SSE for streaming.
- One container; config via env vars (DB URL, llama URL, images dir, session secret, port).
- No ORM — `pg` with small typed query helpers. No migrations framework: one `schema.sql` applied at boot (idempotent `CREATE TABLE IF NOT EXISTS`) — scale is tiny (BRD NFR-03).

## 2. Data Model (PostgreSQL)

```sql
user            (id PK, username TEXT UNIQUE NOT NULL, pw_hash TEXT NOT NULL,
                 is_admin BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ)
session         (token TEXT PK, user_id FK→user, created_at, expires_at,
                 remember BOOLEAN NOT NULL DEFAULT false)          -- cookie; remember
                                                            -- = 30d sliding, else 12h
universe        (id PK, name TEXT, description TEXT, created_at)
universe_user   (universe_id FK, user_id FK, PRIMARY KEY (universe_id, user_id))  -- ownership/access
lore_entry      (id PK, title TEXT, body_md TEXT, universe_id FK, created_at, updated_at)
lore_category   (id PK, universe_id FK, name TEXT, created_at)     -- user-defined, per
                           + UNIQUE INDEX (universe_id, lower(name))
lore_entry_category (lore_entry_id FK, category_id FK,
                     PRIMARY KEY (lore_entry_id, category_id))     -- 0..n each (FR-12a)
image           (id PK, filename TEXT, user_id FK, lore_entry_id FK NULL, created_at)
story           (id PK, title TEXT, outline_md TEXT, user_id FK,
                 universe_id FK NULL,   -- primary universe (the world the story
                                        -- takes place in); NULL = original world
                 status TEXT CHECK (status IN ('draft','finalized')), updated_at)
chapter         (id PK, story_id FK, seq INT UNIQUE per story, title TEXT,
                 body_md TEXT, summary_md TEXT NULL,
                 status TEXT CHECK (status IN ('draft','final')),
                 updated_at)
system_prompt   (id PK, user_id FK, action TEXT, text_md TEXT,
                 PRIMARY KEY (user_id, action))   -- action: generate|generate_this|summarize|
                                                   -- lore_suggest|image_desc|style_extract
style_prompt    (id PK, user_id FK, name TEXT, text_md TEXT, created_at, updated_at)
                           + UNIQUE INDEX (user_id, lower(name))   -- writing-style "skills"
                                                                    -- (FR-22d/22e)
user_setting    (user_id FK, setting_key TEXT, value TEXT, updated_at,
                 PRIMARY KEY (user_id, setting_key))   -- per-user settings (FR-23a);
                                                        -- keys whitelisted server-side
ai_run          (id PK, user_id FK, kind TEXT, target_jsonb, status TEXT
                 CHECK (status IN ('running','done','error')),
                 error TEXT NULL, started_at, ended_at)   -- one per on-trigger AI action
```

- **No version history, no git.** Edits overwrite `body_md`/`outline_md` and bump `updated_at`.
- **Lore membership**: a `lore_entry` has exactly one `universe_id` (BRD OI-3). `universe_user` decides who may manage a universe. `story.universe_id` is the story's primary universe (nullable). Specific borrowed concepts are *not* stored as a relation — they are the markdown links in the outline (`[Infinity Gauntlet](marvel)`) and are resolved at Verify/generate time.
- **Lore categories** (FR-12a): `lore_category` is universe-scoped; `lore_entry_category` links 0..n categories per entry. Bookkeeping only — generate/verify ignore them. Deleting a category detaches entries (they survive); moving an entry to another universe detaches categories that belong to a different universe.
- **Style prompts** (FR-22d): `style_prompt` rows are per user, managed on the AI Monitor, and injected into the generate system prompt when the story page passes `style_id` to the run. The **Extract style** action (FR-22e) can also land in this store — but only after the user reviews the AI's text and clicks save; the action itself writes nothing.
- **User settings** (FR-23a): `user_setting` is a tiny per-user key/value table written only through `POST /api/settings`, which whitelists the keys (`summarize_hint` on/off, `summarize_hint_chapters` 1..20) and validates values. `GET /api/settings` merges stored rows over the defaults, so clients always see a complete map.
- **Images**: `filename` = path relative to the single images directory on disk (mounted volume). `lore_entry_id` nullable until attached.
- **system_prompt seed**: on boot, insert default prompts for each user×action if missing (`INSERT … ON CONFLICT DO NOTHING`).
- **ai_run**: exists so the global "AI working" badge (frontend §2) and AI Monitor can observe any in-flight action from any page. One `ai_run` per user at a time (409 if one is running).

### Concurrency

Single Node process; one AI action per user at a time (`ai_run` row, `SELECT … FOR UPDATE` or a simple existence check is enough at this scale). Everything else is normal row-level locking.

## 3. API surface

Conventional `GET/POST` for pages + `/api` JSON for the parts that need it. All `/api` require the session cookie.

| Endpoint | Purpose |
|---|---|
| `POST /api/login` (optional `remember`), `POST /api/logout`, `GET /api/me` | auth — `remember=true` → 30-day sliding session (`Max-Age=2592000`); else a browser session cookie with NO `Max-Age` (dies on browser close, FR-9) |
| `GET/POST /api/universes` · `POST /api/universes/:id/delete` · `POST /api/universes/:id/users` | universe CRUD + user assignment (admin) |
| `GET/POST /api/entries/:id` · `POST /api/entries/:id/delete` | entry CRUD (`POST` = create or save; `move_to` field for universe change; optional `category_ids: number[]` replaces the entry's category links — ids must belong to the entry's universe) |
| `POST /api/lore-categories` (universe_id, name) · `POST /api/lore-categories/:id/delete` | user-defined categories per universe (FR-12a); delete detaches entries, never deletes them |
| `GET /api/lore/search` (`q`, `limit` ≤20) | live lore search for the outline editor's `/keyword` autocomplete (FR-13, CR round 3): title+body of entries in the user's accessible universes — FTS prefix match (`word*`, `simple` config, title weighted over body) + `ILIKE` substring fallback, so `/star` finds "Star Destroyer" and `/venge` finds "Avengers"; empty `q` = browse by title. Returns `{q, results: [{id, title, universe, universe_id, snippet}]}`. Pure SQL, no AI, no schema change |
| `POST /api/images` (multipart) · `POST /api/images/:id/delete` · `GET /images/:filename` (static) | images |
| `GET/POST /api/stories/:id` | story CRUD (title, outline, `universe_id`, status) |
| `POST /api/stories/:id/verify` | scan outline links → per-link `{target, matched: {entry_id, title, universe} \| null}` (pure string match, no AI). The same data feeds the settings panel's borrowed-lore list (the story page renders it server-side, so no extra endpoint) |
| `GET/POST /api/stories/:id/chapters/:n` | chapter CRUD; `POST /api/stories/:id/chapters/:n/finalize` |
| `GET /api/stories/:id/chapters` | the story's chapter list (the story page refreshes this after a save instead of reloading the page, so the open pane stays — FR-22c) |
| `POST /api/stories/:id/preview-chapter` | render the chapter currently in the editing pane (unsaved text) as Shelf-style HTML (server-side markdown renderer) → `{title, html, word_count}` (FR-22b) |
| `POST /api/stories/:id/finalize` | finalize story (all chapters → final, story → finalized) |
| `GET /api/shelf` | finalized stories of the user |
| **AI actions** (each: create `ai_run`, stream via SSE, mark done/error) | |
| `POST /api/ai/generate` (story_id, optional chapter_seq, optional word_hint, optional style_id) → `GET /api/ai/runs/:id/stream` | generate next chapter; with `chapter_seq`, regenerate that draft in place (final chapters refused, stale summary cleared) — in that mode the **`generate_this`** system prompt is used instead of `generate` (FR-8). `word_hint` is one of the whitelisted ranges ("under 1000 words", "1000-3000 words", …) appended to the generate system prompt — a type hint, no verification (FR-22a). `style_id` is one of the user's `style_prompt` rows (400 otherwise); its text is appended to the system prompt as a "Writing style" block (FR-22d) |
| `POST /api/ai/summarize` (story_id) → same stream endpoint | summarize all unsummarized chapters |
| `POST /api/ai/lore-suggest` (story_id) → same | lore suggestions (result JSON in stream terminal event) |
| `POST /api/ai/style-extract` (story_id) → same | **Extract style** (FR-22e, change request 2026-10-13): the model reads the story's last up-to-3 chapters (oldest dropped first if they exceed ~60% of the context window; 0 chapters → error run) and writes a description of the author's writing style using the **`style_extract`** system prompt. Free-text result in the `done` payload (`{text, chapters}`); the user saves it as a style prompt via the existing style-prompt API — the action persists nothing |
| `POST /api/ai/image-desc` (image_id) → same | image → description |
| `POST /api/ai/runs/:id/cancel` | **emergency stop** (FR-25a): abort the run's in-flight LLM HTTP stream; the run fails with "cancelled by user" (409 if already finished). Nothing is persisted by a cancelled run |
| `GET /api/ai/current` | the user's active `ai_run` (badge poll, 5s); includes `title` — the run's target resolved to a display name (story title / image entry) so the badge shows *which* story is being written |
| `GET /api/model` · `POST /api/model/load` · `POST /api/model/unload` | proxy to llama.cpp (see §4) |
| `GET/POST /api/prompts` | system prompts per action |
| `GET /api/style-prompts` · `POST /api/style-prompts/:id` (`:id=0` creates) · `POST /api/style-prompts/:id/delete` | style prompts ("skills", FR-22d): multiple named, per user; case-insensitive unique name (409 on duplicate) |
| `GET /api/settings` · `POST /api/settings` (`{key, value}`) | per-user settings (FR-23a, change request 2026-10-13): GET returns stored values merged over the defaults; POST upserts ONE whitelisted key — `summarize_hint` (`"on"`/`"off"`) and `summarize_hint_chapters` (integer 1..20) — anything else is 400. The story page renders the summarize-hint banner server-side from these settings + the story's unsummarized chapter count |
| `/api/admin/users/*` (admin) | add user (temp pw), delete (cascade), reset password, toggle admin |

**SSE stream events** (one vocabulary for all AI actions):
`start` (kind, target) → `thinking` (phase marker, e.g. "summarizing ch 3…") / `thought` (model **reasoning** tokens — llama.cpp `reasoning_content` deltas, only when the server extracts reasoning; display-only, never persisted) / `delta` (answer text chunks) → `done` (final payload: chapter id, or suggestion JSON, or summary list) → or `error` (message — "cancelled by user" after a stop). The stream is re-subscribable: on connect, replay from the in-memory run state, then live deltas.

**Prompt injection defense**: lore/outline/chapters are wrapped in `<<<SECTION:name>>>…<<<END:name>>>` delimiters and declared data-only in the system prompt (carried over from the old build for free — it's prompt text, not code).

## 4. LLM integration (llama.cpp, out-of-scope container)

The app talks **only** to the existing llama.cpp HTTP API:

- `GET /v1/models` — model list; each entry has status (`loaded`/`unloaded`) and `multimodal` capability. App caches for a few seconds.
- `POST /models/load` / `POST /models/unload` — body `{"model": "<name>"}`. Loading takes time → app returns immediately, UI polls `GET /api/model` until `loaded`.
- `POST /v1/chat/completions` — OpenAI-compatible, `stream: true`, `model` field in body.
  - **Images**: OpenAI content parts — `{"type":"image_url","image_url":{"url":"data:<mime>;base64,…"}}`. Gemma ships with mmproj, so vision is always available (per user). Read the file from the images dir, base64-encode, send.
  - **Structured output** (lore suggestions): request strict JSON; **parse defensively** (tolerate code fences / stray text — the old build's `parse_verdict` in `reference/story_creator/app/llm/verdict.py` is the reference for why).
  - **Timeouts**: LLM read timeout 900s (env `LLM_READ_TIMEOUT`); the model is slow, never treat silence as a hang while a stream is alive.
  - **Thinking/reasoning**: if the llama.cpp server is run with reasoning extraction (`--reasoning-format deepseek`, so chat deltas carry `reasoning_content` before the answer), the client forwards those tokens as `thought` SSE events — display-only (never part of the saved chapter/summary). Inert on servers without it.
  - **Cancellation**: each action holds an AbortController; the emergency stop (`POST /api/ai/runs/:id/cancel`) aborts it, dropping the llama.cpp HTTP stream so the model stops serving the completion.
- One LLM client module, no agent framework: a plain function per action that (1) assembles the prompt, (2) calls the streaming endpoint, (3) forwards deltas to the SSE stream, (4) persists the result.

### Prompt assembly (per action)

- **generate** (BRD OI-1): `system_prompt(generate)` + sections: OUTLINE, LORE (all entries of the story's primary universe, if any, **plus** entries matched by the outline's Verify links — i.e. explicitly borrowed concepts from other universes; if total lore > ~60% of context window, truncate lowest-priority first — simple, no relevance ranking), SUMMARIES (all, in chapter order), LAST_CHAPTERS (last 2 full chapters). Instruction: write the next chapter, continue the story. **Regenerate variant** (polish, `chapter_seq`): same sections **plus** CURRENT_CHAPTER (the target's existing title + body — which may be the author's own notes), and the instruction is "Rewrite chapter N now, keeping continuity" — otherwise the current text is not in context (unless it happens to be in the last two chapters). The two modes use **separate system prompts**: `generate` and `generate_this` (FR-8). An optional `word_hint` range from the chapter pane is appended to whichever system prompt is used (FR-22a — hint only, no verification). An optional **style prompt** ("skill") selected on the story page is appended after that as a `Writing style …` block — the user's own text on how to write (FR-22d; validated as the user's `style_prompt` row before the run starts).
- **summarize**: per unsummarized chapter (sequentially, one LLM call each): chapter text → ~200-word summary → `chapter.summary_md`. An empty (reasoning-only) answer is **retried once** before failing (defensive parsing for local models); if a mid-run chapter still fails, the earlier chapters' summaries are KEPT and the error names the failed chapter and the saved ones ("…Chapters 1, 2 were summarized and saved — click Summarize again to do the rest"), so a partial run is never a silent state.
- **lore_suggest**: outline + summaries (+ last chapters) → JSON list of `{type: add|delete, universe, title, body_md, reason}`. Adds: user-applied from UI. Deletes: user-confirmed from UI. **The backend never deletes lore on its own.**
- **style_extract**: last up-to-3 chapters (newest always kept; oldest dropped first past ~60% of the context window) in one `CHAPTERS` section → 150–250-word prose description of the author's style as direct guidance for an AI writer. Free-text `done` payload; nothing persisted (the save is the user's explicit click through the style-prompt API).
- **image_desc**: single user message with image part + instruction → free text.

## 5. Auth & security

- argon2id password hashing; session = random token in `session` table, httpOnly + SameSite=Lax cookie. **Remember me** (FR-9): the `session.remember` flag selects the sliding TTL (30d vs 12h) *and* the cookie kind — remember → `Max-Age=2592000`; normal → **no** `Max-Age` (browser session cookie, gone when the browser closes). The flag lives on the row so the sliding window always extends by the right TTL, and cookie re-issue (e.g. password change) preserves it.
- Row-level ownership enforced in query helpers: every user-scoped query is filtered by `user_id` (or universe membership via `universe_user`). Admin only unlocks `/api/admin/*`.
- LAN-only; plain HTTP is acceptable (BRD). Port bound inside the podman network only; exposed via the app container's published port (e.g. 9187, as before — check `plan/reference/usedport` in the old repo if ports collide).

## 6. Deploy (podman, single Fedora host)

- Podman network `novel` (user bridge). Two new containers, existing llama.cpp untouched:
  - **`novel-app`**: built from this repo (multi-stage: `node:22` build stage runs `npm ci` + `npm run build` = `tsc` + **esbuild bundling of the story-page CodeMirror editor** (`src/public/js/story.ts` → one static `dist/src/public/js/story.js`) → runtime stage with `npm ci --omit=dev`, so esbuild/CodeMirror are NOT in the running image — the editor ships as a plain static JS file). Volumes: `novel-images:/images` (named volume for image files). Env: `DATABASE_URL=postgres://novel:novel@novel-db:5432/novel`, `LLAMA_URL=http://<llama-host-address>:21000`, `LLM_READ_TIMEOUT=900`. Port `9187`.
  - **`novel-db`**: `postgres:16` (or host PG — either is fine), named volume `novel-pgdata`, env `PGUSER/PGPASSWORD/POSTGRES_DB=novel`. Not exposed to the host (network-only).
- **Llama reachability**: the old build found `http://host.containers.internal:21000/v1` works from a rootless podman container (SELinux/pasta quirks are documented in `reference/story_creator/deploy/DEPLOYMENT.md`). Reuse that address; make it an env var so it's a one-line fix if it changes.
- **CR round 3 (live editor + lore search, 2026-10-11) changes no deploy topology**: no new containers/ports/volumes/env vars and no schema migration — the search is plain SQL over existing columns and the editor is a static file inside the same image. Re-deploy stays `deploy/install-quadlet.sh`.
- **CR round 4 (2026-10-13: summarize hint + extract style)** is likewise topology-neutral: the new `user_setting` table is created by the same idempotent `schema.sql` at boot, the style-extract prompt is seeded like the others, and no container/port/env/volume changes. Re-deploy stays `deploy/install-quadlet.sh`.
- **Backups** (NFR-05): nightly timer — `pg_dump novel > /srv/novel/backups/` + `podman cp`/bind of the images volume; 14× retention. A 10-line host script + systemd user timer, as before.
- Boot behavior: if llama is unreachable, app still boots (UI works for writing/editing; AI buttons show "model server unreachable").

## 7. Testing

- Postgres via `testcontainers` or a throwaway local PG in CI; **fake-LLM mode**: `LLM_URL` pointing at a tiny in-process mock returning canned streamed responses (pattern proven in `reference/story_creator/tests/fakes`).
- Core tests: auth/ownership isolation, entry↔universe↔story links, chapter generate against fake LLM (stream + persist + ai_run lifecycle), summarize, lore-suggest apply/delete, model load/unload proxy, admin user management.
