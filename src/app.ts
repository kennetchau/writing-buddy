import fs from "node:fs";
import path from "node:path";
import express, { type Request } from "express";
import hbs from "hbs";
import { loadConfig } from "./config";
import { applySchema } from "./db/init";
import { seedDefaultPrompts } from "./db/prompts";
import { ensureFirstAdmin } from "./auth/bootstrap";
import { requireAuth } from "./auth/middleware";
import { authRouter } from "./auth/routes";
import { universeRouter } from "./universe/routes";
import { loreRouter } from "./lore/routes";
import { imageRouter } from "./images/routes";
import { storyRouter } from "./story/routes";
import { chapterRouter } from "./story/chapters";
import { shelfRouter } from "./shelf/routes";
import { aiRouter } from "./ai/routes";
import { settingsRouter } from "./settings/routes";
import { adminRouter } from "./admin/routes";
import { getSessionUser, tokenFromReq } from "./auth/session";

const app = express();

let config = loadConfig();
export function setConfig(c: typeof config): void {
  config = c;
}
export function getConfig() {
  return config;
}

// ---- views & static (frontend doc §1: hbs layout + one CSS + vanilla JS) ----
// Works from src/ (vitest) and dist/src/ (runtime; build copies views + schema).
function distSibling(...rel: string[]): string {
  const srcGuess = path.join(__dirname, "..", ...rel);
  if (fs.existsSync(srcGuess)) return srcGuess;
  return path.join(__dirname, ...rel);
}
const viewDir = distSibling("views");
app.set("view engine", "hbs");
app.set("views", viewDir);
hbs.registerHelper("eq", (a: unknown, b: unknown) => a === b);
hbs.registerHelper("contains", (arr: unknown, v: unknown) =>
  Array.isArray(arr) && arr.includes(v),
);
hbs.registerHelper("labelFor", (action: string) =>
  ({
    generate: "Generate chapter",
    generate_this: "Generate this chapter",
    summarize: "Summarize",
    lore_suggest: "Lore suggest",
    image_desc: "Image description",
    style_extract: "Extract style",
  }[action] ?? action),
);
hbs.registerHelper("formatDate", (d: Date | string) =>
  new Date(d).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }),
);
// Note: hbs auto-wraps every rendered view in views/layout.hbs, injecting the
// rendered page as {{{body}}} — no manual layout wiring needed.
app.use(express.static(distSibling("public")));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ---- request log (issue-autologout): the DECISIVE capture for the
// intermittent force-logout. Logs every request line with:
//   status · cookie? (token prefix the browser sent) · setcookie? (whether
//   THIS response issued a Set-Cookie). One journalctl grep after a drop
//   tells us the side:
//     cookie=none on 401s, setcookie=false  -> browser stopped sending it
//     cookie=<t> + 401                      -> row gone from the DB (server)
//     setcookie=true                        -> app rotated/cleared it (server)
// Gated: set REQ_LOG=1 (the prod unit does). Skip the health probe.
if (process.env.REQ_LOG === "1") {
  app.use((req: Request, res, next) => {
    res.on("finish", () => {
      if (req.path === "/api/health") return;
      const cookie = tokenFromReq(req);
      const setCookie = res.getHeader("set-cookie") ? "yes" : "no";
      console.log(
        `[req] ${req.method} ${req.path} -> ${res.statusCode} ` +
          `cookie=${cookie ? cookie.slice(0, 8) + "…" : "none"} setcookie=${setCookie}`,
      );
    });
    next();
  });
}

// ---- template locals: appTitle + current user on every render ----
app.use(async (req: Request, res, next) => {
  res.locals.appTitle = "Writing Buddy";
  try {
    res.locals.user = (await getSessionUser(tokenFromReq(req), { deleteExpired: false })).user;
  } catch {
    res.locals.user = null;
  }
  next();
});

// ---- routes ----
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/", authRouter); // /login, /logout, /api/login, /api/logout, /api/me
app.use("/", universeRouter); // /universe, /api/universes*
app.use("/", loreRouter); // /lore*, /api/entries*
app.use("/", imageRouter); // /api/images*, /images/:filename
app.use("/", storyRouter); // /story*, /api/stories*
app.use("/", chapterRouter); // /api/stories/:id/chapters/*
app.use("/", shelfRouter); // /shelf*, /api/shelf
app.use("/", aiRouter); // /ai, /api/ai/*, /api/model*, /api/prompts
app.use("/", settingsRouter); // /api/settings (per-user key/value settings)
app.use("/", adminRouter); // /admin/users, /api/admin/users*

// home = story list (the app's first page, frontend doc §2)
app.get("/", requireAuth, (_req, res) => {
  res.redirect("/story");
});

// 404 for unknown non-API page routes
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api") || req.path === "/login") {
    next();
    return;
  }
  res.status(404);
  res.render("404", { activeNav: null });
});

// error handler (must be 4-arg)
app.use(
  (
    err: Error & { status?: number },
    _req: Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (res.headersSent) {
      _next(err);
      return;
    }
    const status = err.status ?? 500;
    if (status >= 500) console.error("[app] error:", err);
    // escape: err.message can carry external input (llama error bodies,
    // pg messages) and is rendered into raw HTML
    const escaped = String(err.message ?? err)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    res.status(status).send(`<h1>${status}</h1><p>${escaped}</p>`);
  },
);

// ---- boot: idempotent schema + seeds, then listen ----
// In the podman deploy the app can start before novel-db accepts
// connections, so the schema apply retries a few times (backend doc §6:
// boot must not crash the stack on DB race).
async function withDbRetry(fn: () => Promise<void>, what: string): Promise<void> {
  const attempts = Number.parseInt(env_or("NOVEL_BOOT_DB_ATTEMPTS", "10"), 10);
  const delayMs = Number.parseInt(env_or("NOVEL_BOOT_DB_DELAY_MS", "3000"), 10);
  for (let i = 1; ; i++) {
    try {
      await fn();
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      console.warn(
        `[app] ${what} failed (attempt ${i}/${attempts}): ${err instanceof Error ? err.message : err} — retrying in ${delayMs / 1000}s`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

function env_or(name: string, def: string): string {
  return process.env[name] ?? def;
}

export async function boot(): Promise<void> {
  await withDbRetry(async () => {
    await applySchema();
    await seedDefaultPrompts();
  }, "database init");
  await ensureFirstAdmin(process.env);
  app.listen(config.port, () => {
    console.log(`[app] listening on :${config.port}`);
  });
}

export { app };
export default app;
