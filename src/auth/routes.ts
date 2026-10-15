import { Router, Request, Response } from "express";
import { query } from "../db/pool";
import {
  createSession,
  destroySession,
  getSessionUser,
  sessionCookieOptions,
  sessionRememberFlag,
  tokenFromReq,
} from "./session";
import { findUserByName, hashPassword, verifyPassword } from "./bootstrap";
import { requireAuth } from "./middleware";
import { getConfig } from "../app";

export const authRouter = Router();

// ---- pages (server-rendered, PRG) ----

function safeNextUrl(req: Request): string {
  // only same-origin absolute paths (starts with "/", not "//")
  const n = String(req.query.next ?? "");
  return /^\/(?!\/)/.test(n) ? n : "/";
}

/** "Remember me" (FR round 2, 2026-10-09): the form sends `remember=on` when
 *  the checkbox is ticked; the JSON API sends a boolean. Unchecked/absent =
 *  false → a browser-session cookie that dies when the browser closes. */
function isRemembered(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").trim().toLowerCase();
  return s === "on" || s === "true" || s === "1";
}

authRouter.get("/login", async (req, res, next) => {
  try {
    // Only a VALID session skips the login page — merely having the cookie
    // is not enough (a stale cookie whose row is gone/expired would loop:
    // /login → / → 401-redirect → /login → …).
    const token = tokenFromReq(req);
    if (token) {
      const { user } = await getSessionUser(token, { deleteExpired: false });
      if (user) {
        res.redirect("/");
        return;
      }
    }
    res.render("login", {
      layout: false,
      message: req.query.error as string | undefined,
      next: safeNextUrl(req),
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/login", async (req, res, next) => {
  try {
    const username = String(req.body.username ?? "").trim();
    const password = String(req.body.password ?? "");
    const remember = isRemembered(req.body.remember);
    const nextUrl = /^\/(?!\/)/.test(String(req.body.next ?? "")) ? String(req.body.next) : "/";
    const user = await findUserByName(username);
    if (!user || !(await verifyPassword(user.pw_hash, password))) {
      res.status(401).render("login", {
        layout: false,
        message: "Invalid username or password.",
        next: nextUrl,
      });
      return;
    }
    const token = await createSession(user.id, remember);
    res.cookie("session", token, sessionCookieOptions(getConfig().cookieSecure, remember));
    res.redirect(nextUrl);
  } catch (err) {
    next(err);
  }
});

authRouter.post("/logout", async (req, res, next) => {
  try {
    const token = tokenFromReq(req);
    if (token) await destroySession(token);
    res.clearCookie("session", { path: "/" });
    res.redirect("/login");
  } catch (err) {
    next(err);
  }
});

// ---- JSON API (backend doc §3) ----

authRouter.post("/api/login", async (req, res, next) => {
  try {
    const username = String(req.body?.username ?? "").trim();
    const password = String(req.body?.password ?? "");
    const remember = isRemembered(req.body?.remember);
    const user = await findUserByName(username);
    if (!user || !(await verifyPassword(user.pw_hash, password))) {
      res.status(401).json({ error: "invalid credentials" });
      return;
    }
    const token = await createSession(user.id, remember);
    res.cookie("session", token, sessionCookieOptions(getConfig().cookieSecure, remember));
    res.json({ user: { id: user.id, username: user.username, is_admin: user.is_admin } });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/api/logout", async (req, res, next) => {
  try {
    const token = tokenFromReq(req);
    if (token) await destroySession(token);
    res.clearCookie("session", { path: "/" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

authRouter.get("/api/me", async (req, res, next) => {
  try {
    const { user, reason } = await getSessionUser(tokenFromReq(req));
    if (!user) {
      res.status(401).json({ error: "not authenticated", reason });
      return;
    }
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/change-password {current, next} — change YOUR OWN password
// (self-service; the admin "Reset pw" deliberately excludes self, so without
// this a single-admin install can never change its password). Re-issues the
// session cookie so the sliding window restarts from the change.
authRouter.post("/api/auth/change-password", requireAuth, async (req: Request, res: Response, next) => {
  try {
    const current = String(req.body?.current ?? "");
    const nextPw = String(req.body?.next ?? "");
    if (nextPw.length < 6) {
      res.status(400).json({ error: "new password must be at least 6 characters" });
      return;
    }
    const user = await findUserByName(req.user!.username);
    if (!user || !(await verifyPassword(user.pw_hash, current))) {
      res.status(401).json({ error: "current password is incorrect" });
      return;
    }
    const pw_hash = await hashPassword(nextPw);
    await query(`UPDATE "user" SET pw_hash = $2 WHERE id = $1`, [user.id, pw_hash]);
    // re-issue the session (sliding window restarts) while keeping the
    // remember-me flag of the current session
    const remember = await sessionRememberFlag(tokenFromReq(req) ?? "");
    const token = await createSession(user.id, remember);
    res.cookie("session", token, sessionCookieOptions(getConfig().cookieSecure, remember));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
