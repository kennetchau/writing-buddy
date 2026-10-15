import { Request, Response, NextFunction } from "express";
import { getSessionUser, SessionUser, tokenFromReq } from "./session";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

/** Attach req.user from the session cookie; redirect (pages) or 401 (JSON API). */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = tokenFromReq(req);
    const result = await getSessionUser(token);
    if (!result.user) {
      // DEBUG (issue-autologout): distinguish the 401 causes — missing
      // cookie, unknown token, or EXPIRED token (only expiry deletes the
      // row). grep "\[auth\] 401" on the host once the fix ships.
      const reason =
        result.reason === "missing"
          ? "NO cookie"
          : result.reason === "expired"
            ? "EXPIRED"
            : "UNKNOWN token";
      console.warn(
        `[auth] 401 ${req.method} ${req.path} — ${reason} ` +
          `(host=${req.headers.host ?? "?"}, xff=${req.headers["x-forwarded-for"] ?? "-"})`,
      );
      if (req.path.startsWith("/api")) {
        res.status(401).json({ error: "not authenticated", reason: result.reason });
        return;
      }
      const nextParam = req.originalUrl === "/" ? "" : `?next=${encodeURIComponent(req.originalUrl)}`;
      res.redirect(`/login${nextParam}`);
      return;
    }
    req.user = result.user;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.is_admin) {
    next();
    return;
  }
  res.status(403).send("admin only");
}
