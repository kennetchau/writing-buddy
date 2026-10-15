import { Router, type Request, type Response } from "express";
import { query } from "../db/pool";
import { requireAuth, requireAdmin } from "../auth/middleware";
import { hashPassword } from "../auth/bootstrap";
import { listAllUsers } from "./users";

export const adminRouter = Router();

// ⚠️ Scope the admin gate to the admin PATHS, not the whole router.
// `adminRouter.use(requireAdmin)` (unscoped) would run for EVERY request that
// passes through the router (it is mounted at "/"), so a non-admin GET /
// would 403 "admin only" before app.get("/") gets to redirect to /story.
adminRouter.use("/admin", requireAuth, requireAdmin);
adminRouter.use("/api/admin", requireAuth, requireAdmin);

// ---- page (frontend doc §3.6) ----
adminRouter.get("/admin/users", async (req: Request, res: Response, next) => {
  try {
    const users = await listAllUsers();
    res.render("admin_users", {
      activeNav: "admin",
      users,
      isAdmin: true,
      currentUser: req.user!.id,
      message: strQuery(req, "message"),
      error: strQuery(req, "error"),
    });
  } catch (err) {
    next(err);
  }
});

function strQuery(req: Request, key: string): string | undefined {
  const v = req.query[key];
  return typeof v === "string" ? v : undefined;
}

// ---- API (backend doc §3: /api/admin/users/*) ----

// POST /api/admin/users {username, password} — add with temp password
adminRouter.post("/api/admin/users", async (req: Request, res: Response, next) => {
  try {
    const username = String(req.body?.username ?? "").trim();
    const password = String(req.body?.password ?? "");
    if (!/^[a-zA-Z0-9_.-]{3,50}$/.test(username)) {
      res.status(400).json({ error: "username must be 3-50 chars (letters, digits, _ . -)" });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ error: "password must be at least 6 characters" });
      return;
    }
    const pw_hash = await hashPassword(password);
    try {
      const { rows } = await query<{ id: number }>(
        `INSERT INTO "user" (username, pw_hash) VALUES ($1, $2) RETURNING id`,
        [username, pw_hash],
      );
      res.status(201).json({ id: rows[0].id });
    } catch (e) {
      if ((e as { code?: string }).code === "23505") {
        res.status(409).json({ error: "username already exists" });
        return;
      }
      throw e;
    }
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/users/:id/delete {confirm: username} — cascade delete.
// The typed-username confirm happens in the UI (native confirm); the API
// requires the username echoed back as `confirm` as a second gate.
adminRouter.post("/api/admin/users/:id/delete", async (req: Request, res: Response, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const { rows: target } = await query<{ id: number; username: string }>(
      `SELECT id, username FROM "user" WHERE id = $1`,
      [id],
    );
    const user = target[0];
    if (!user) {
      res.status(404).json({ error: "user not found" });
      return;
    }
    if (user.id === req.user!.id) {
      res.status(409).json({ error: "you cannot delete your own account" });
      return;
    }
    if (String(req.body?.confirm ?? "") !== user.username) {
      res.status(409).json({ error: "confirm does not match the username" });
      return;
    }
    await query(`DELETE FROM "user" WHERE id = $1`, [id]); // cascades
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/users/:id/reset-password {password}
adminRouter.post("/api/admin/users/:id/reset-password", async (req: Request, res: Response, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const password = String(req.body?.password ?? "");
    if (password.length < 6) {
      res.status(400).json({ error: "password must be at least 6 characters" });
      return;
    }
    const pw_hash = await hashPassword(password);
    const { rowCount } = await query(`UPDATE "user" SET pw_hash = $2 WHERE id = $1`, [
      id,
      pw_hash,
    ]);
    if (!rowCount) {
      res.status(404).json({ error: "user not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/users/:id/toggle-admin
adminRouter.post("/api/admin/users/:id/toggle-admin", async (req: Request, res: Response, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (id === req.user!.id) {
      res.status(409).json({ error: "you cannot change your own admin flag" });
      return;
    }
    const { rows } = await query<{ is_admin: boolean }>(
      `UPDATE "user" SET is_admin = NOT is_admin WHERE id = $1 RETURNING is_admin`,
      [id],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "user not found" });
      return;
    }
    res.json({ is_admin: rows[0].is_admin });
  } catch (err) {
    next(err);
  }
});
