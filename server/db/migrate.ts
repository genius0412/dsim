import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, dbEnabled } from './pool';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, 'migrations');

// Advisory-lock key serializing migrate() across machines. Arbitrary but FIXED —
// every machine must pick the same number for the lock to mean anything.
const MIGRATE_LOCK_KEY = 0x4d494752; // 'MIGR'

/**
 * Apply any migration `.sql` files not yet recorded in `schema_migrations`, each
 * in its own transaction. Runs once at server boot (off the hot path). No-ops
 * when the DB is disabled. Files also use `IF NOT EXISTS`, so a re-run is safe.
 *
 * CONCURRENCY: every regional machine (iad/sjc/lhr/syd/nrt) boots its own copy and
 * calls this at the same time after a deploy. Without serialization two of them can
 * both see a file as pending and run it: the loser hits `schema_migrations`' primary
 * key, throws, and — because `index.ts` treats a migration failure as non-fatal — that
 * machine logs "records disabled" and SKIPS ITS REMAINING MIGRATIONS while happily
 * serving traffic. So take a session-level advisory lock around the whole scan+apply:
 * the first machine migrates, the rest block briefly and then find nothing pending.
 * The `on conflict do nothing` is belt-and-braces for the same race.
 */
export async function migrate(): Promise<void> {
  if (!dbEnabled || !pool) return;
  // held for the duration on its OWN client — a session-level lock lives with the
  // connection, so it must not be the client the per-file transactions use.
  const lock = await pool.connect();
  try {
    await lock.query('select pg_advisory_lock($1)', [MIGRATE_LOCK_KEY]);
    await lock.query(
      `create table if not exists schema_migrations (
         name text primary key,
         applied_at timestamptz not null default now()
       )`,
    );
    const done = new Set(
      (
        await lock.query<{ name: string }>('select name from schema_migrations')
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
        await client.query(
          'insert into schema_migrations(name) values ($1) on conflict (name) do nothing',
          [f],
        );
        await client.query('commit');
        console.log(`[db] applied migration ${f}`);
      } catch (e) {
        await client.query('rollback');
        throw e;
      } finally {
        client.release();
      }
    }
  } finally {
    // release the lock even on a throw, or a failed migrate would wedge every other
    // machine's boot until this connection died.
    await lock
      .query('select pg_advisory_unlock($1)', [MIGRATE_LOCK_KEY])
      .catch(() => {});
    lock.release();
  }
}
