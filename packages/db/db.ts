import pg from 'pg';
import { config } from '../backend/config.js';
export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 16 });
export type DB = Pick<pg.PoolClient, 'query'>;
export type Row = Record<string, unknown>;
export async function rows<T extends pg.QueryResultRow = Row>(db: DB, sql: string, args: unknown[] = []): Promise<T[]> { return (await db.query<T>(sql, args)).rows; }
export async function one<T extends pg.QueryResultRow = Row>(db: DB, sql: string, args: unknown[] = []): Promise<T | undefined> { return (await rows<T>(db, sql, args))[0]; }
export async function tx<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try { await db.query('BEGIN'); const result = await fn(db); await db.query('COMMIT'); return result; }
  catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
}
export function camel(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(camel);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), camel(v)]));
  return value;
}
