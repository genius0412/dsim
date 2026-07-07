import pg from 'pg';

/**
 * Postgres (Neon) connection pool. The Fly game server is a long-lived process,
 * so a standard `pg.Pool` is the right fit (not the edge/serverless HTTP driver).
 *
 * When `DATABASE_URL` is unset the pool is null and ALL persistence NO-OPS — the
 * game, lobby, and matches keep working; only leaderboards/records/ELO are off.
 * That keeps local dev and a boards-less deploy trivial. Neon connection strings
 * already carry `?sslmode=require`.
 */
const url = process.env.DATABASE_URL;

export const dbEnabled = !!url;

export const pool: pg.Pool | null = url
  ? new pg.Pool({
      connectionString: url,
      max: Number(process.env.DB_POOL_MAX ?? 5),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    })
  : null;

if (!dbEnabled) {
  console.warn(
    '[db] DATABASE_URL unset — records/leaderboards/ELO disabled (play still works)',
  );
}

pool?.on('error', (e) => console.error('[db] idle client error:', e));

/** parameterized query → rows. Throws if the DB is disabled; callers use the
 * repo helpers (which guard on `dbEnabled`) rather than calling this directly. */
export async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  if (!pool) throw new Error('DB disabled (DATABASE_URL unset)');
  const res = await pool.query<T>(text, params);
  return res.rows;
}
