import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { query, withTransaction } from "../db/pool";
import { requireAuth } from "../auth/middleware";
import { isUniverseMember } from "../lore/ownership";
import { getConfig } from "../app";

export const imageRouter = Router();

imageRouter.use(requireAuth);

const ALLOWED_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = getConfig().imagesDir;
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = ALLOWED_MIME[file.mimetype] ?? "bin";
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}.${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME[file.mimetype]) cb(null, true);
    else cb(new Error("only png/jpg/gif/webp images are allowed"));
  },
});

// POST /api/images (multipart field "image"; optional lore_entry_id to attach)
imageRouter.post("/api/images", upload.single("image"), async (req: Request, res: Response, next) => {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "no file uploaded" });
      return;
    }
    const entryId = req.body?.lore_entry_id ? Number.parseInt(String(req.body.lore_entry_id), 10) : null;
    let ownedEntry: number | null = null;
    if (entryId) {
      const { rows } = await query(
        `SELECT e.universe_id FROM lore_entry e WHERE e.id = $1`,
        [entryId],
      );
      const entry = rows[0];
      if (!entry || !(await isUniverseMember(entry.universe_id, req.user!.id))) {
        fs.unlinkSync(path.join(getConfig().imagesDir, file.filename));
        res.status(404).json({ error: "entry not found" });
        return;
      }
      ownedEntry = entryId;
    }
    const { rows } = await query<{ id: number }>(
      `INSERT INTO image (filename, user_id, lore_entry_id) VALUES ($1, $2, $3) RETURNING id`,
      [file.filename, req.user!.id, ownedEntry],
    );
    res.status(201).json({ id: rows[0].id, filename: file.filename });
  } catch (err) {
    // clean up the file if the DB insert failed
    if (req.file) fs.promises.unlink(path.join(getConfig().imagesDir, req.file.filename)).catch(() => {});
    next(err);
  }
});

// POST /api/images/:id/attach {lore_entry_id: number | null}
imageRouter.post("/api/images/:id/attach", async (req: Request, res: Response, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const { rows: img } = await query<{ id: number; lore_entry_id: number | null }>(
      `SELECT id, lore_entry_id FROM image WHERE id = $1 AND user_id = $2`,
      [id, req.user!.id],
    );
    if (img.length === 0) {
      res.status(404).json({ error: "image not found" });
      return;
    }
    const entryId = req.body?.lore_entry_id ? Number.parseInt(String(req.body.lore_entry_id), 10) : null;
    if (entryId) {
      const { rows } = await query(`SELECT e.universe_id FROM lore_entry e WHERE e.id = $1`, [entryId]);
      if (!rows[0] || !(await isUniverseMember(rows[0].universe_id, req.user!.id))) {
        res.status(404).json({ error: "entry not found" });
        return;
      }
    }
    await query(`UPDATE image SET lore_entry_id = $2 WHERE id = $1`, [id, entryId]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/images/:id/delete — removes DB row + file
imageRouter.post("/api/images/:id/delete", async (req: Request, res: Response, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const removed = await withTransaction(async (q) => {
      const { rows } = await q<{ filename: string }>(
        `SELECT filename FROM image WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [id, req.user!.id],
      );
      if (rows.length === 0) return null;
      await q(`DELETE FROM image WHERE id = $1`, [id]);
      return rows[0].filename;
    });
    if (!removed) {
      res.status(404).json({ error: "image not found" });
      return;
    }
    fs.promises.unlink(path.join(getConfig().imagesDir, removed)).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /images/:filename — static serving from the flat images dir (no ../ escapes)
imageRouter.get("/images/:filename", (req: Request, res: Response) => {
  const filename = path.basename(req.params.filename);
  const full = path.join(getConfig().imagesDir, filename);
  if (!fs.existsSync(full)) {
    res.status(404).send("not found");
    return;
  }
  const mime = extMime(full);
  res.setHeader("content-type", mime);
  fs.createReadStream(full).pipe(res);
});

function extMime(fullPath: string): string {
  const ext = path.extname(fullPath).toLowerCase().slice(1);
  return {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
  }[ext] ?? "application/octet-stream";
}
