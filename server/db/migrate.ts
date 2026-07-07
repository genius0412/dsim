import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, dbEnabled } from './pool';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, 'migrations');

/**
 * Apply any migration `.sql` files not yet recorded in `schema_migrations`, each
 * in its own transaction. Runs once at server boot (off the hot path). No-ops
 * when the DB is disabled. Files also use `IF NOT EXISTS`, so a re-run is safe.
 */
export async function migrate(): Promise<void> {
  if (!dbEnabled || !pool) return;
  await pool.query(
    `create table if not exists schema_migrations (
       name text primary key,
       applied_at timestamptz not null default now()
     )`,
  );
  const done = new Set(
    (
      await pool.query<{ name: string }>('select name from schema_migrations')
    ).rows.map((r) => r.name),
  );
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = readFileSync(join(migrationsDir, f), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations(name) values ($1)', [f]);
      await client.query('commit');
      console.log(`[db] applied migration ${f}`);
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
  }
}
