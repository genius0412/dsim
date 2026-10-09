import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, dbEnabled, type DbClient } from './pool';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, 'migrations');

// Advisory-lock key serializing migrate() across machines. Arbitrary but FIXED — every machine
// must pick the same number for the lock to mean anything. It is NOT the old session lock's
// key (0x4d494752, 'MIGR'): a session lock leaked by an older build on a pooled backend holds
// that key until the backend closes, and would still block a transaction lock on it.
const MIGRATE_LOCK_KEY = 0x4d494732; // 'MIG2'

/**
 * Apply any migration `.sql` files not yet recorded in `schema_migrations`, each in its own
 * transaction. Runs once at server boot (off the hot path). No-ops when the DB is disabled.
 * Files also use `IF NOT EXISTS`, so a re-run is safe.
 *
 * CONCURRENCY: every regional machine boots its own copy and calls this at the same time
 * after a deploy. Without serialization two of them can both see a file as pending and run
 * it: the loser hits `schema_migrations`' primary key, throws, and — because `index.ts`
 * treats a migration failure as non-fatal — that machine logs "records disabled" and SKIPS
 * ITS REMAINING MIGRATIONS while serving traffic. So each file's transaction takes a
 * TRANSACTION-level advisory lock and re-checks `schema_migrations` under it: the first
 * machine applies the file, the rest wait a moment and find it recorded.
 *
 * ⚠️ NOT A SESSION LOCK (2026-09-27). It used to be `pg_advisory_lock` on one client, held
 * across the whole scan, released by `pg_advisory_unlock` at the end. `DATABASE_URL` points
 * at Neon's POOLER (PgBouncer, transaction mode), where each statement outside a transaction
 * may run on a different server backend: the unlock could land on a backend that never held
 * the lock, fail silently, and leave the lock held on a pooled backend that other clients
 * keep alive. The next boot then waited on it indefinitely — `dsim-alpha` sat with 0056
 * unapplied and no "database ready" line. A transaction lock lives and dies with its
 * transaction, which a transaction-mode pooler keeps on one backend, so it cannot leak.
 */
export async function migrate(): Promise<void> {
  if (!dbEnabled || !pool) return;
  const p = pool;
  /** run `fn` in one transaction holding the migrate lock */
  const locked = async <T>(fn: (c: DbClient) => Promise<T>): Promise<T> => {
    const client = await p.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock($1)', [MIGRATE_LOCK_KEY]);
      const out = await fn(client);
      await client.query('commit');
      return out;
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  };
  await locked((c) =>
    c.query(
      `create table if not exists schema_migrations (
         name text primary key,
         applied_at timestamptz not null default now()
       )`,
    ),
  );
  const done = new Set(
    (await p.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name),
  );
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = readFileSync(join(migrationsDir, f), 'utf8');
    const applied = await locked(async (c) => {
      // another machine may have applied it while this one waited for the lock
      const again = await c.query('select 1 from schema_migrations where name = $1', [f]);
      if (again.rows.length) return false;
      await c.query(sql);
      await c.query('insert into schema_migrations(name) values ($1) on conflict (name) do nothing', [f]);
      return true;
    });
    if (applied) console.log(`[db] applied migration ${f}`);
  }
}
