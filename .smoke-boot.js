// Throwaway smoke boot: real server + fake DB, verifies story page serves
// the FIXED bundle and the /api/lore/search route exists.
// Dev smoke boot: uses the injected DATABASE_URL; no real credentials here.
process.env.SESSION_SECRET ??= "smoke-session-secret-dev";
process.env.PORT = "19187";
process.env.LLAMA_URL = "http://127.0.0.1:1/v1";
process.env.ADMIN_USERNAME ??= "testadmin";
process.env.ADMIN_PASSWORD ??= "testpw-dev-only";
process.env.IMAGE_DIR = "/tmp/smoke-images";
require("./dist/src/server.js");
