import pg from "pg";
import { config } from "../backend/config.js";
export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 16,
});
export type DB = Pick<pg.PoolClient, "query">;
export type Row = Record<string, unknown>;

/** Keeps multi-line SQL readable while sending PostgreSQL a compact statement. */
export function sql(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  return String.raw({ raw: strings }, ...values)
    .replace(/\s+/g, " ")
    .trim();
}

export async function rows<T extends pg.QueryResultRow = Row>(
  db: DB,
  sql: string,
  args: unknown[] = [],
): Promise<T[]> {
  const result = await db.query<T>(sql, args);
  return result.rows;
}

export async function one<T extends pg.QueryResultRow = Row>(
  db: DB,
  sql: string,
  args: unknown[] = [],
): Promise<T | undefined> {
  const result = await rows<T>(db, sql, args);
  return result[0];
}
export async function tx<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
export function camel(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(camel);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.replace(/_([a-z])/g, (_, character: string) =>
          character.toUpperCase(),
        ),
        camel(item),
      ]),
    );
  }
  return value;
}
