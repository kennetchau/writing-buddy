-- schema.sql — applied idempotently at boot (backend doc §2, verbatim).
-- No migrations framework; everything uses IF NOT EXISTS / ON CONFLICT.

-- user (table name is a reserved word — always double-quote it in SQL)
CREATE TABLE IF NOT EXISTS "user" (
  id          SERIAL PRIMARY KEY,
  username    TEXT UNIQUE NOT NULL,
  pw_hash     TEXT NOT NULL,
  is_admin    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- cookie; remember-me flag so the sliding window extends by the right TTL
-- (12h for normal logins, 30d for "remember me"). The column is added with
-- ALTER because existing databases already have the table (IF NOT EXISTS
-- above would not add it).
CREATE TABLE IF NOT EXISTS session (
  token       TEXT PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
ALTER TABLE session ADD COLUMN IF NOT EXISTS remember BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS session_user_id_idx ON session (user_id);
CREATE INDEX IF NOT EXISTS session_expires_at_idx ON session (expires_at);

-- ownership/access: which users may manage a universe (BRD §5: no user_id on universe)
CREATE TABLE IF NOT EXISTS universe (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS universe_name_idx ON universe (lower(name));

CREATE TABLE IF NOT EXISTS universe_user (
  universe_id INT NOT NULL REFERENCES universe(id) ON DELETE CASCADE,
  user_id     INT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  PRIMARY KEY (universe_id, user_id)
);

-- each entry belongs to exactly one universe (OI-3)
CREATE TABLE IF NOT EXISTS lore_entry (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  body_md     TEXT NOT NULL DEFAULT '',
  universe_id INT NOT NULL REFERENCES universe(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lore_entry_universe_id_idx ON lore_entry (universe_id);
CREATE INDEX IF NOT EXISTS lore_entry_title_idx ON lore_entry (lower(title));

-- user-defined lore categories, scoped to a universe (FR round 2, 2026-10-09):
-- the author names categories per universe and attaches 0..n entries to each.
CREATE TABLE IF NOT EXISTS lore_category (
  id          SERIAL PRIMARY KEY,
  universe_id INT NOT NULL REFERENCES universe(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- (universe_id, lower(name)) is a UNIQUE INDEX, not a table constraint:
-- PG table constraints cannot take expressions like lower(name)
CREATE UNIQUE INDEX IF NOT EXISTS lore_category_universe_name_uq
  ON lore_category (universe_id, lower(name));
CREATE INDEX IF NOT EXISTS lore_category_universe_id_idx ON lore_category (universe_id);

CREATE TABLE IF NOT EXISTS lore_entry_category (
  lore_entry_id INT NOT NULL REFERENCES lore_entry(id) ON DELETE CASCADE,
  category_id   INT NOT NULL REFERENCES lore_category(id) ON DELETE CASCADE,
  PRIMARY KEY (lore_entry_id, category_id)
);

-- one flat images dir on disk; filename is the path relative to it
CREATE TABLE IF NOT EXISTS image (
  id            SERIAL PRIMARY KEY,
  filename      TEXT NOT NULL,
  user_id       INT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  lore_entry_id INT REFERENCES lore_entry(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS image_lore_entry_id_idx ON image (lore_entry_id);

-- universe_id NULL = original/custom world (FR-20)
CREATE TABLE IF NOT EXISTS story (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  outline_md  TEXT NOT NULL DEFAULT '',
  user_id     INT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  universe_id INT REFERENCES universe(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'finalized')),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS story_user_id_idx ON story (user_id);

-- seq is UNIQUE per story
CREATE TABLE IF NOT EXISTS chapter (
  id          SERIAL PRIMARY KEY,
  story_id    INT NOT NULL REFERENCES story(id) ON DELETE CASCADE,
  seq         INT NOT NULL,
  title       TEXT NOT NULL,
  body_md     TEXT NOT NULL DEFAULT '',
  summary_md  TEXT,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'final')),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (story_id, seq)
);

-- one editable prompt per user x action; action: generate|generate_this|summarize|lore_suggest|image_desc|style_extract
CREATE TABLE IF NOT EXISTS system_prompt (
  user_id     INT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  action      TEXT NOT NULL,
  text_md     TEXT NOT NULL,
  PRIMARY KEY (user_id, action)
);

-- user-defined writing-style prompts ("skills", FR round 2, 2026-10-09):
-- multiple per user; on generate the user picks one (or none) and its text
-- is appended to the generate system prompt for that run.
CREATE TABLE IF NOT EXISTS style_prompt (
  id          SERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  text_md     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS style_prompt_user_name_uq ON style_prompt (user_id, lower(name));
CREATE INDEX IF NOT EXISTS style_prompt_user_id_idx ON style_prompt (user_id);

-- per-user settings (change request 2026-10-13): tiny key/value store;
-- keys are whitelisted server-side (src/settings), values are plain text
CREATE TABLE IF NOT EXISTS user_setting (
  user_id     INT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  setting_key TEXT NOT NULL,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, setting_key)
);

-- one row per on-trigger AI action; one running per user at a time
CREATE TABLE IF NOT EXISTS ai_run (
  id          SERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  target_jsonb JSONB,
  status      TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'error')),
  error       TEXT,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ai_run_user_id_idx ON ai_run (user_id);
