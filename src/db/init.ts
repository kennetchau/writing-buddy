import fs from "node:fs";
import path from "node:path";
import { query } from "./pool";

/**
 * Apply schema.sql idempotently (backend doc §1: no migrations framework,
 * everything IF NOT EXISTS). Safe to run on every boot.
 */
export async function applySchema(): Promise<void> {
  // Works both from src (tests, vitest) and dist (runtime; build copies
  // schema.sql next to the views dir).
  const candidates = [
    path.join(__dirname, "schema.sql"),
    path.join(__dirname, "..", "..", "views", "schema.sql"),
  ];
  const schemaPath = candidates.find((p) => fs.existsSync(p));
  if (!schemaPath) throw new Error(`schema.sql not found: ${candidates.join(" | ")}`);
  const sql = fs.readFileSync(schemaPath, "utf8");
  await query(sql);
}

export async function closeDb(): Promise<void> {
  const { getPool } = await import("./pool");
  await getPool().end();
}
