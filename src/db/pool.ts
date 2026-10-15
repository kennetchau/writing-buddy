import { Pool } from "pg";

/**
 * Single shared Postgres pool for the whole process.
 * Lazy module-level singleton so tests can create it on demand.
 */
let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}

export function setPool(p: Pool | null): void {
  pool = p;
}

export async function query<T extends import("pg").QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<import("pg").QueryResult<T>> {
  return getPool().query<T>(text, params as never[]);
}

export async function withTransaction<T>(fn: (q: typeof query) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const txQuery = <R extends import("pg").QueryResultRow>(
      text: string,
      params: unknown[] = [],
    ): Promise<import("pg").QueryResult<R>> => client.query<R>(text, params as never[]);
    const result = await fn(txQuery);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
