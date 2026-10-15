import { Router, type Request, type Response } from "express";
import { query, withTransaction } from "../db/pool";
import { requireAuth, requireAdmin } from "../auth/middleware";
import { isUniverseMember, listUniversesForUser } from "../lore/ownership";
import { listAllUsers } from "../admin/users";

export const universeRouter = Router();

universeRouter.use(requireAuth);

// ---- page (frontend doc §3.3) ----
universeRouter.get("/universe", async (req: Request, res: Response, next) => {
  try {
    const universes = await listUniversesForUser(req.user!.id);
    const allUsers = req.user!.is_admin ? await listAllUsers() : [];
    res.render("universe", {
      activeNav: "universe",
      universes,
      isAdmin: req.user!.is_admin,
      // the template iterates `allUsers` for the admin assign-user dropdown
      // (a previous revision only passed the JSON-serialized copy, so the
      // dropdown rendered empty)
      allUsers,
      message: req.query.message,
      error: req.query.error,
    });
  } catch (err) {
    next(err);
  }
});

// ---- API ----

// POST /api/universes {name, description?} — creator is the initial manager
universeRouter.post("/api/universes", async (req: Request, res: Response, next) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    const description = String(req.body?.description ?? "").trim() || null;
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const id = await withTransaction(async (q) => {
      const { rows } = await q<{ id: number }>(
        `INSERT INTO universe (name, description) VALUES ($1, $2) RETURNING id`,
        [name, description],
      );
      await q(
        `INSERT INTO universe_user (universe_id, user_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [rows[0].id, req.user!.id],
      );
      return rows[0].id;
    });
    res.status(201).json({ id });
  } catch (err) {
    next(err);
  }
});

// POST /api/universes/:id/delete — only if empty, else 409
universeRouter.post("/api/universes/:id/delete", async (req: Request, res: Response, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!(await isUniverseMember(id, req.user!.id))) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const entryCount = await withTransaction(async (q) => {
      const c = await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM lore_entry WHERE universe_id = $1`,
        [id],
      );
      if (c.rows[0].n === 0) {
        await q(`DELETE FROM universe WHERE id = $1`, [id]);
      }
      return c.rows[0].n;
    });
    if (entryCount > 0) {
      res.status(409).json({ error: "universe is not empty", entry_count: entryCount });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/universes/:id/users — admin user assignment (add; remove=true to take away)
universeRouter.post("/api/universes/:id/users", requireAdmin, async (req: Request, res: Response, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const targetId = Number.parseInt(String(req.body?.userId), 10);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      res.status(400).json({ error: "userId is required" });
      return;
    }
    const { rows: userRows } = await query(`SELECT 1 FROM "user" WHERE id = $1`, [targetId]);
    if (userRows.length === 0) {
      res.status(400).json({ error: "user does not exist" });
      return;
    }
    if (req.body?.remove) {
      await withTransaction(async (q) => {
        const c = await q<{ n: number }>(
          `SELECT count(*)::int AS n FROM universe_user WHERE universe_id = $1`,
          [id],
        );
        if (c.rows[0].n <= 1) {
          throw Object.assign(new Error("at least one user must keep access"), { status: 409 });
        }
        await q(`DELETE FROM universe_user WHERE universe_id = $1 AND user_id = $2`, [
          id,
          targetId,
        ]);
      });
    } else {
      await query(
        `INSERT INTO universe_user (universe_id, user_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [id, targetId],
      );
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
