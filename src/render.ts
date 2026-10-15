import fs from "node:fs";
import path from "node:path";
import hbs from "hbs";
import type { Request, Response } from "express";

/**
 * Render a page template wrapped in the hbs layout.
 * (hbs natively auto-wraps in views/layout.hbs with {{{body}}} — this helper
 * exists so routes can share one entry point as pages multiply.)
 */
export function resolveViewsDir(): string {
  const srcGuess = path.join(__dirname, "..", "views");
  if (fs.existsSync(srcGuess)) return srcGuess;
  return path.join(__dirname, "views");
}

export function renderPage(
  req: Request,
  res: Response,
  name: string,
  data: Record<string, unknown> = {},
): void {
  res.render(name, { activeNav: null, ...data });
}
