import { Router, type Request, type Response } from "express";
import { requireAuth } from "../auth/middleware";
import { SETTING_DEFAULTS, getUserSettings, setUserSetting } from "./settings";

export const settingsRouter = Router();

settingsRouter.use(requireAuth);

// ---- user settings (change request 2026-10-13, FR-23a) ----
// GET /api/settings → { settings: { key: value } } — stored values merged
// over SETTING_DEFAULTS, so the client always sees a complete map.
settingsRouter.get("/api/settings", async (req: Request, res: Response, next) => {
  try {
    const settings = await getUserSettings(req.user!.id);
    res.json({ settings });
  } catch (err) {
    next(err);
  }
});

// POST /api/settings { key, value } → upsert ONE whitelisted key.
// Unknown keys and malformed values are rejected — the table is only ever
// written through this route.
settingsRouter.post("/api/settings", async (req: Request, res: Response, next) => {
  try {
    const key = String(req.body?.key ?? "");
    const value = String(req.body?.value ?? "");
    if (!(key in SETTING_DEFAULTS)) {
      res.status(400).json({ error: `unknown setting: ${key}` });
      return;
    }
    await setUserSetting(req.user!.id, key, value);
    res.json({ ok: true, key, value });
  } catch (err) {
    if (err instanceof Error && (err.message.startsWith("unknown setting") || /value must be/.test(err.message))) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});
