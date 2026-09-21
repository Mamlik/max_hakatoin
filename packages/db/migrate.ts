import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { config } from '../backend/config.js';
const db = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL ?? config.DATABASE_URL });
try {
  await db.connect();
  await db.query('SELECT pg_advisory_lock(724991)');
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const name of (await readdir(new URL('./migrations/', import.meta.url))).filter(n => n.endsWith('.sql')).sort()) {
    if ((await db.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name])).rowCount) continue;
    await db.query('BEGIN');
    try { await db.query(await readFile(new URL(`./migrations/${name}`, import.meta.url), 'utf8')); await db.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]); await db.query('COMMIT'); console.log(`Applied ${name}`); }
    catch (e) { await db.query('ROLLBACK'); throw e; }
  }
} finally { await db.end(); }
