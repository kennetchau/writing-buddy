# Writing Buddy

A private, self-hosted web app for producing **long-form document series with a
local LLM** (llama.cpp) — with a human in control of every step. Every AI action
is a button the user clicks, streams live to the screen (SSE), and produces
editable output. Nothing runs in the background, nothing is auto-published, and
the model never leaves the machine: the app talks to an *existing* llama.cpp
HTTP endpoint and nothing else.

Spec of record: [`agent/brd.md`](agent/brd.md) (v2.0) +
[`agent/technicaldoc_frontend.md`](agent/technicaldoc_frontend.md) +
[`agent/technicaldoc_backend.md`](agent/technicaldoc_backend.md).

## Building blocks

- **Universes + Lore** — a markdown *knowledge base*, organized into namespaces
  ("universes"). Entries are plain markdown text in Postgres; full-text +
  substring search; `/keyword` autocomplete in the outline editor links outline
  items to lore entries.
- **Series + outline** — a "story" is a *series of documents* driven by a
  markdown outline. Outline items may link to lore entries (`[Title](Title)`);
  a pure-string **Verify** step checks that every link resolves before you
  start writing.
- **Documents (chapters)** — written or generated one at a time, in a CodeMirror
  markdown editor (live-rendered). Drafts can be regenerated in place;
  finalized documents are locked.
- **Rolling summaries** — each document can be summarized into a running digest
  that is fed back into every future generation, so the model stays consistent
  across a very long series.
- **AI Monitor** — every AI action is *named* (which series it's working on),
  streamed token-by-token, stoppable, and shows the model's reasoning tokens
  when the server is run with reasoning extraction. One action per user at a
  time; the failed run's exact error is persisted and shown on the next visit.
- **Editable system prompts** — each AI action (generate, generate-in-place,
  summarize, lore suggest, image → description, style extract) has its **own
  free-text system prompt, editable per user**, no versioning. This is what
  makes the app domain-agnostic — see below.
- **Style extraction** — the model reads your last few documents and writes a
  reusable description of *your* writing style, which you can save as a "style"
  that future generations follow.
- **Lore suggestions** — the model proposes markdown bookkeeping (new entries /
  retired entries) for your knowledge base; additions apply directly, deletes
  require a confirm (the only approval step).
- **Shelf** — a built-in reader for finished markdown, including borrowed
  (linked) entries.
- **Images** — one flat directory, path in the DB; an "image → description"
  action turns any uploaded image into a lore reference note (uses the model's
  multimodal input when available).
- **Users & admin** — argon2id + cookie sessions (12 h sliding), per-user data
  isolation; the admin flag only manages users.

## Real-world uses

The defaults assume fiction (the seeded prompts target novel writing), but the shape —
**knowledge base + outline + sequentially produced documents + rolling
summaries + per-user prompts** — is domain-agnostic. Point the AI Monitor's
prompts at your job and the same buttons produce it:

| Use | Lore holds | Outline is | The AI produces |
|---|---|---|---|
| Novels / serial fiction / fanfic (default) | world & character notes | chapters | the next chapter, in your style |
| Technical book / long-form docs | glossary, product facts, API notes | the table of contents | chapters that stay consistent with the glossary over hundreds of pages (this is what the rolling summaries buy you) |
| Course / tutorial series | domain terms, exercise library | the lesson plan | one lesson at a time, each grounded in the shared reference material |
| TTRPG campaign & worldbuilding | NPCs, factions, locations, uploaded maps (image → description) | campaign arcs | session prep notes, NPC sheets, new locations |
| Blog / newsletter series | recurring topics, source notes | the post calendar | a post per issue |
| Marketing content | brand voice, product claims | the content plan | posts and briefs in brand voice |

Because each action's system prompt is free text owned by each user, "novel
writer" and "technical documentation author" are a two-minute config change,
not a code change.

## Stack

- **One Node.js 22 + TypeScript app**: Express + hbs (server-rendered),
  small vanilla TS, plain SSE for live AI output. No React / Vite / SPA.
- **PostgreSQL** for all data (lore is markdown *text columns*).
- **Images**: one flat directory on disk, path stored in the DB.
- **Auth**: argon2id + cookie session (12 h sliding). Admin flag = user
  management only.
- **AI**: on-trigger only, one action per user, streamed via SSE. Talks to the
  llama.cpp router HTTP API (`/v1/models`, `/v1/chat/completions`) — never
  manages the model process itself.

## Development setup

Prerequisites: Node.js ≥ 22, a local PostgreSQL.

```sh
npm install
npm run build          # tsc → dist/ (also copies views + schema.sql)

# environment (all via env vars):
export DATABASE_URL="postgres://user:pass@localhost:5432/novel"
export SESSION_SECRET="$(openssl rand -hex 32)"
export PORT=9187                                  # optional, default 9187
# optional:
export ADMIN_USERNAME=admin                      # creates the admin on first
export ADMIN_PASSWORD='...'                      #   boot (only if no users)
export LLAMA_URL=http://localhost:21000/v1       # your llama.cpp server
export LLM_READ_TIMEOUT=900                      # default; local models are slow
export IMAGES_DIR=/tmp/novel-images              # default /images

node dist/src/server.js
# → open http://localhost:9187/login
```

The schema (`src/db/schema.sql`) is applied **idempotently at boot** —
there is no migrations framework (scale is tiny by design). Default system
prompts are seeded per user×action at boot (`INSERT … ON CONFLICT DO NOTHING`).

> If the llama.cpp server is unreachable the app still boots: the AI Monitor
> shows "model server unreachable" and all editing/reading works normally.

### Tests

Tests use the real local Postgres from `DATABASE_URL` plus an **in-process
fake llama.cpp** (`tests/fake-llm.ts`) for all AI paths — no model needed.

```sh
npm test               # vitest run (auth, lore, story, verify, AI lifecycle, admin)
bash testing/smoke.sh http://127.0.0.1:9187 admin '<pw>'   # end-to-end page smoke
```

> The suite truncates the database tables it tests — point `DATABASE_URL`
> at a **throwaway** database, not a live one.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | *(required)* | Postgres connection string |
| `SESSION_SECRET` | *(required)* | any long random string (cookie/session) |
| `PORT` | `9187` | listen port |
| `LLAMA_URL` | `http://host.containers.internal:21000/v1` | llama.cpp router base URL (the podman host name from the original deploy; override for your own server, e.g. `http://localhost:21000/v1`) |
| `LLM_READ_TIMEOUT` | `900` | LLM read timeout in **seconds** (local CPU models are slow; silence while streaming is not a hang) |
| `IMAGES_DIR` | `/images` | flat directory for uploaded images |
| `COOKIE_SECURE` | off | set `true` when the site is HTTPS-only (deploy does this — nginx terminates TLS) so the session cookie gets the `Secure` flag; leave off for local HTTP dev / curl smoke |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | – | first-admin bootstrap (consumed only while the user table is empty) |

## Deployment (Fedora host, podman quadlet)

**Full guide: [`deploy/DEPLOYMENT.md`](deploy/DEPLOYMENT.md)** — pre-flight,
install, verification, smoke, backup/restore, operations and troubleshooting.

Two new containers on a shared podman network; the existing llama.cpp
container is untouched. See `deploy/` and
`agent/technicaldoc_backend.md` §6:

- **`novel-db`** — `postgres:16`, named volume `novel-pgdata`,
  network-only (no host port).
- **`novel-app`** — multi-stage build from this repo
  (`deploy/Dockerfile`), named volume `novel-images` at `/images`,
  host port `9187`.

```sh
deploy/install-quadlet.sh
# → builds the image, installs the units (generates a SESSION_SECRET),
#   starts novel-db + novel-app, enables the nightly backup timer.
```

Verify on the host:

```sh
curl -s http://127.0.0.1:9187/api/health       # → {"ok":true}
systemctl --user status novel-app.service novel-db.service
journalctl --user -u novel-app.service -n 40   # boot: schema apply + admin
```

Log in with the admin user from `novel-app.container` and **reset that
password immediately** (Admin → Users).

### Backups

Nightly at 03:30 UTC via `novel-backup.timer` → `scripts/backup.sh`:
`pg_dump` (run inside `novel-db`) + a tar of the `novel-images` volume into
`/srv/novel/backups/<date>/`, 14× retention.

- Run now: `systemctl --user start novel-backup.service`
- Restore: `psql novel < backups/<date>/novel.sql`, then extract
  `images.tar.gz` into the `novel-images` volume.

### Host quirks (rootless podman + pasta + SELinux)

Bind mounts need `:z`; the `llama` address
`http://host.containers.internal:21000` is the *stable* podman host name —
do **not** use the pasta netns gateway IP (it churns). Full troubleshooting:
the table in [`deploy/DEPLOYMENT.md`](deploy/DEPLOYMENT.md) and the
auto-logout root-cause write-up in `agent/issue-autologout.md`.

## Project layout

```
src/
  server.ts        entry point (boot with DB retry)
  app.ts           express app, layout wiring, hbs helpers
  config.ts        env → config
  db/              pool, schema.sql (idempotent), prompt seeds
  auth/            argon2id, cookie sessions, middleware, bootstrap
  lore/  universe/  story/  shelf/  images/   domain routes + pages
  ai/              llm client, run lifecycle (SSE), actions, prompts
  admin/           user management (admin only)
  settings/        per-user key/value settings
  markdown.ts      small server-side md→html (Shelf reader)
views/             hbs templates (layout auto-wrap via {{{body}}})
src/public/        one CSS file + small vanilla TS + bundled story-page editor
tests/             vitest + fake-llm (all AI paths tested without a model)
testing/smoke.sh   end-to-end page smoke (curl)
deploy/            Dockerfile + quadlet units + install script
```
