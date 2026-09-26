/**
 * Load a Vercel Web Analytics export into `analytics_imported` (migration 0053). The owner runs it.
 *
 *   node scripts/vercel-analytics-export.mjs --team <teamId>         # writes scratch/vercel-analytics-production.json
 *   DATABASE_URL=… npx tsx scripts/import-vercel-analytics.ts --file scratch/vercel-analytics-production.json          # dry run
 *   DATABASE_URL=… npx tsx scripts/import-vercel-analytics.ts --file scratch/vercel-analytics-production.json --write  # writes
 *
 * DRY RUN unless `--write`: it prints what it would load and touches nothing. With `--write` it
 * replaces this source's rows over the file's day range in one transaction, so re-running it, or
 * running it again on a fresher export, is safe.
 *
 * The table comes from a migration, and migrations apply when the game server boots — deploy the
 * server that carries 0053 first. This script does not migrate. Import the PRODUCTION export into
 * the production database only; a preview (alpha) export belongs in alpha's, and is stored as
 * source `vercel-preview` so the dashboard counts it under the alpha channel.
 *
 * The dashboard folds these days into its own numbers: every day before DSIM's own count began
 * is read from here, and imported days on or after it are ignored. Loading overlapping days is
 * therefore harmless.
 */
import { readFileSync } from 'node:fs';
import { vercelImportRows, type VercelExport } from '../server/analyticsImport';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = opt('file');
const write = args.includes('--write');
if (!file) {
  console.error('usage: tsx scripts/import-vercel-analytics.ts --file <export.json> [--write]');
  process.exit(2);
}

const data = JSON.parse(readFileSync(file, 'utf8')) as VercelExport;
const rows = vercelImportRows(data);
const byDim = new Map<string, number>();
for (const r of rows) byDim.set(r.dim, (byDim.get(r.dim) ?? 0) + 1);
const views = rows.filter((r) => r.dim === 'total').reduce((s, r) => s + r.views, 0);
console.log(`${file}: environment ${data.environment ?? '?'}, ${data.firstDay} → ${data.lastDay}`);
console.log(`${rows.length} rows, ${views} page views; by dimension: ${[...byDim].map(([d, n]) => `${d} ${n}`).join(', ')}`);

if (!write) {
  console.log('dry run: nothing written (pass --write to load it)');
  process.exit(0);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(2);
}

// imported after the env check: pool.ts reads DATABASE_URL when it loads
const { q, pool } = await import('../server/db/pool');
const { replaceImportedAnalytics } = await import('../server/db/repo');
const exists = await q<{ ok: boolean }>(`select to_regclass('public.analytics_imported') is not null as ok`);
if (!exists[0]?.ok) {
  console.error('analytics_imported does not exist: deploy the server carrying migration 0053 first.');
  process.exit(1);
}
// The dashboard reads `vercel` as the stable web site and `vercel-preview` as alpha's
// (`IMPORT_CHANNEL` in server/analytics.ts), so the label says which one this file is.
const res = await replaceImportedAnalytics(data.environment === 'preview' ? 'vercel-preview' : 'vercel', rows);
console.log(`replaced ${res.deleted} rows with ${res.inserted} for ${res.firstDay} → ${res.lastDay}`);
await (pool as unknown as { end?: () => Promise<void> })?.end?.();
