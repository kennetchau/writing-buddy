// Runs before each test file (see vitest.config.ts setupFiles).
// src/app.ts loads config at import time, so env must exist first.
// DATABASE_URL is injected by the environment (no credential fallback here —
// see agent/AGENT.md, "Database").
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgres://postgres:***@localhost:5432/novel";
}
if (!process.env.SESSION_SECRET) {
  process.env.SESSION_SECRET = "test-session-secret";
}
if (!process.env.PORT) {
  process.env.PORT = "9187";
}
if (!process.env.IMAGES_DIR) {
  process.env.IMAGES_DIR = "/tmp/novel-test-images";
}
// Point the LLM client at the fake llama.cpp (tests/fake-llm.ts, fixed port).
// Spec files that don't use AI never hit it.
if (!process.env.LLAMA_URL) {
  process.env.LLAMA_URL = `http://127.0.0.1:${process.env.FAKE_LLAMA_PORT ?? 45123}/v1`;
}
