/**
 * SYNC THE ALPHA DATABASE FROM PRODUCTION. One way, prod → alpha, run right after a promotion.
 *
 *   npm run sync:alpha -- --env D:/Projects/2ddecodesim/.env              dry run (the default)
 *   npm run sync:alpha -- --env D:/Projects/2ddecodesim/.env --apply      write to alpha
 *   ... --replays     also copy the replay logs the copied records and matches point at
 *
 * WHY IT EXISTS. The alpha signs in through production's Neon Auth, so the same email and
 * password work on both sites, but `dsim-alpha`'s DATABASE_URL is its own Neon branch
 * (`alpha`, a child of `production` taken 2026-08-10). Every profile, record, rating and saved
 * robot on the alpha was the 2026-08-10 copy until this ran. docs/deploy.md has the runbook.
 *
 * WHEN. Only while both databases have applied exactly the same migrations, which is true
 * right after alpha is promoted to production and false the rest of the time (alpha's
 * migrations run ahead). `--apply` REFUSES otherwise; the dry run still prints its counts and
 * says why it would refuse.
 *
 * WHAT IT DOES (an upsert merge, never a delete of anything a tester owns):
 *  - copies the per-account tables below from production; on the same key, PRODUCTION WINS;
 *  - never touches a table that is not listed: access groups, the lockdown row, banners, the
 *    admin log and notes, competitions, analytics, notices and reports stay the alpha's own;
 *  - keeps every alpha-only row (an account, record, match or grant production does not have);
 *  - all of it in ONE alpha transaction, so a failure leaves the alpha exactly as it was.
 * Production is read inside one REPEATABLE READ, READ ONLY transaction on a session opened
 * with `default_transaction_read_only=on`, and both are checked before the first read.
 *
 * WHY NOT A NEON "RESET FROM PARENT". A reset is cheaper in storage, but it replaces the whole
 * alpha database and then has to put the alpha's own rows back: until that second step lands,
 * the alpha has production's lockdown row (open) and no tester grants. One transaction that
 * only adds and overwrites cannot lock a tester out, at any point, however it fails.
 *
 * NOT DONE, ON PURPOSE:
 *  - Deletions do not propagate. A row production deleted (a cleared record, a deleted account)
 *    stays on the alpha; the dry run counts alpha rows production does not have.
 *  - Replay logs are opt-in (`--replays`). They are 3.4 GB of production's database against
 *    ~100 MB for everything else; without them a copied record or match whose log is not on the
 *    alpha is stored with no replay, the state a season purge already leaves behind.
 *  - Practice runs, LAN runs, friends, provider links and notices are not copied.
 */
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** one connection: `pg.Client`, or the PGlite adapter's connection in `scripts/dbtest.ts` */
export interface SyncConn {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface SyncOptions {
  /** write to alpha; false = count only, with alpha opened read-only too */
  apply: boolean;
  /** also copy the replay logs the copied rows point at */
  replays?: boolean;
  /** rows per page read from production */
  pageSize?: number;
  log?: (line: string) => void;
  /** called once the schema check has passed and before alpha is written (the CLI's backup) */
  beforeWrite?: () => Promise<void>;
}

export interface TableReport {
  table: string;
  /** rows production has (after the table's filter) */
  prod: number;
  /** rows alpha had before the sync */
  alpha: number;
  /** production rows alpha does not have */
  insert: number;
  /** rows on both whose alpha copy differs and is overwritten */
  update: number;
  /** rows on both that already match */
  same: number;
  /** alpha rows production does not have: kept */
  alphaOnly: number;
  notes: string[];
}

export interface SyncReport {
  /** migrations or columns differ: `apply` wrote nothing */
  refused: string[];
  applied: boolean;
  tables: TableReport[];
  /** counts for the steps that are not a table copy */
  extras: Record<string, number>;
  /** alpha's own tables, untouched, with their row counts */
  untouched: Record<string, number>;
}

/**
 * THE TABLES, IN FOREIGN-KEY ORDER (a parent before its children: the checks are immediate).
 * Everything here is keyed by a uuid or by a natural key, never by a bigserial: two branches
 * hand out the same serial id to different rows after they split, so "same key" would not
 * mean "same row".
 */
interface TableRule {
  table: string;
  /** a production-side filter (SQL over the table's own columns) */
  where?: string;
  /** keep the alpha's value of these columns on a row both have */
  keepAlpha?: string[];
  /** the alpha's value of these columns stays for an account IN USE on the alpha */
  keepForTesters?: string[];
  /** a column pointing at `replays`: copied only when the log is on the alpha */
  replayCol?: string;
}

const TABLES: TableRule[] = [
  // a game's act and season periods; production's roll wins (see `seasonsActive` below)
  { table: 'seasons' },
  // `role` is the alpha's own projection of its ADMIN_USER_IDS (syncStaffRoles). `settings` holds
  // the saved robots and controls, and the robot importer is alpha-only, so a tester's imported
  // robots exist nowhere but here: production's blob would delete them.
  { table: 'profiles', keepAlpha: ['role'], keepForTesters: ['settings'] },
  { table: 'elo_ratings' },
  { table: 'elo_history' },
  { table: 'user_activity' },
  { table: 'account_standing' },
  { table: 'matches', replayCol: 'replay_id' },
  { table: 'match_participants' },
  { table: 'records', replayCol: 'replay_id' },
  { table: 'reward_periods' },
  // team badges follow each deployment's own access groups (docs/area/accounts.md)
  { table: 'reward_grants', where: `grant_key not like 'team:%'` },
];

/** alpha-owned state the sync never writes, listed in the report so a run shows it untouched */
const UNTOUCHED = ['access_members', 'maintenance', 'banners', 'admin_audit', 'admin_notes', 'announcements'];

/** an account IN USE on the alpha: a tester (any access group) or staff */
const IN_USE = (t: string) =>
  `(${t}.role is not null or exists (select 1 from public.access_members a where a.user_id = ${t}.user_id))`;

const ident = (s: string): string => `"${s.replace(/"/g, '""')}"`;

async function rows<T = Record<string, unknown>>(c: SyncConn, text: string, params: unknown[] = []): Promise<T[]> {
  return (await c.query(text, params)).rows as T[];
}
async function one<T = Record<string, unknown>>(c: SyncConn, text: string, params: unknown[] = []): Promise<T> {
  return (await rows<T>(c, text, params))[0];
}

interface Col {
  name: string;
  type: string;
}
async function columnsOf(c: SyncConn, schema: string, table: string): Promise<Col[]> {
  return (
    await rows<{ column_name: string; data_type: string }>(
      c,
      `select column_name, data_type from information_schema.columns
        where table_schema = $1 and table_name = $2 and is_generated = 'NEVER'
        order by ordinal_position`,
      [schema, table],
    )
  ).map((r) => ({ name: r.column_name, type: r.data_type }));
}
async function primaryKey(c: SyncConn, table: string): Promise<string[]> {
  return (
    await rows<{ attname: string }>(
      c,
      `select a.attname from pg_index i
         join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where i.indrelid = $1::regclass and i.indisprimary
        order by array_position(i.indkey::int2[], a.attnum)`,
      [`public.${table}`],
    )
  ).map((r) => r.attname);
}
async function count(c: SyncConn, table: string, where?: string): Promise<number> {
  const r = await one<{ n: number }>(c, `select count(*)::int as n from ${table}${where ? ` where ${where}` : ''}`, [] as unknown[]);
  return Number(r.n);
}
async function readOnly(c: SyncConn): Promise<boolean> {
  const r = await one<{ transaction_read_only: string }>(c, 'show transaction_read_only');
  return r.transaction_read_only === 'on';
}

export async function syncAlpha(prod: SyncConn, alpha: SyncConn, opts: SyncOptions): Promise<SyncReport> {
  const log = opts.log ?? (() => {});
  const pageSize = opts.pageSize ?? 1000;
  const report: SyncReport = { refused: [], applied: false, tables: [], extras: {}, untouched: {} };

  // ⚠️ PRODUCTION IS READ-ONLY, AND THAT IS CHECKED, NOT ASSUMED. One snapshot for every read.
  await prod.query('begin transaction isolation level repeatable read, read only');
  let alphaOpen = false;
  try {
    if (!(await readOnly(prod))) throw new Error('refusing: the production transaction is not read-only');

    // ---------------------------------------------------------------- the schema check
    const migs = async (c: SyncConn) =>
      (await rows<{ name: string }>(c, 'select name from schema_migrations order by name')).map((r) => r.name);
    const pm = await migs(prod);
    const am = await migs(alpha);
    const prodOnly = pm.filter((m) => !am.includes(m));
    const alphaOnly = am.filter((m) => !pm.includes(m));
    if (prodOnly.length) report.refused.push(`migrations only production has applied: ${prodOnly.join(', ')}`);
    if (alphaOnly.length) report.refused.push(`migrations only alpha has applied: ${alphaOnly.join(', ')}`);

    const plan: { rule: TableRule; cols: string[]; pk: string[] }[] = [];
    for (const rule of TABLES) {
      const pc = await columnsOf(prod, 'public', rule.table);
      const ac = await columnsOf(alpha, 'public', rule.table);
      if (!pc.length || !ac.length) {
        report.refused.push(`${rule.table}: missing on ${pc.length ? 'alpha' : 'production'}`);
        continue;
      }
      const key = (c: Col) => `${c.name} ${c.type}`;
      const inProd = new Set(pc.map(key));
      const inAlpha = new Set(ac.map(key));
      const onlyP = pc.filter((c) => !inAlpha.has(key(c))).map(key);
      const onlyA = ac.filter((c) => !inProd.has(key(c))).map(key);
      if (onlyP.length || onlyA.length)
        report.refused.push(
          `${rule.table}: columns differ (${[...onlyP.map((c) => `production ${c}`), ...onlyA.map((c) => `alpha ${c}`)].join('; ')})`,
        );
      // the dry run still counts over the columns both have
      const cols = ac.filter((c) => inProd.has(key(c))).map((c) => c.name);
      plan.push({ rule, cols, pk: await primaryKey(alpha, rule.table) });
    }
    const refusing = report.refused.length > 0;
    if (refusing) log(`schema check: REFUSED\n  ${report.refused.join('\n  ')}`);
    else log('schema check: migrations and columns match');
    if (opts.apply && refusing) return report;

    for (const t of UNTOUCHED) {
      if ((await columnsOf(alpha, 'public', t)).length) report.untouched[t] = await count(alpha, `public.${t}`);
    }

    if (opts.apply && opts.beforeWrite) await opts.beforeWrite();
    // the dry run opens alpha read-only as well: a bug here then errors instead of writing
    await alpha.query(opts.apply ? 'begin' : 'begin transaction read only');
    alphaOpen = true;
    const write = opts.apply;

    // -------------------------------------------- usernames and Ko-fi emails: production wins
    // A unique index, checked row by row, so a production account taking a username the alpha
    // gave somebody else would abort the whole copy. Clear the alpha holder first; they pick a
    // new one at the username prompt. Their access grant is keyed by id and does not move.
    for (const col of ['username', 'kofi_email']) {
      const held = await one<{ j: string }>(
        prod,
        `select coalesce(json_agg(json_build_object('user_id', user_id, 'v', ${ident(col)})), '[]')::text as j
           from public.profiles where ${ident(col)} is not null`,
      );
      const pred = `from jsonb_to_recordset($1::jsonb) as p(user_id text, v text)
                    where t.${ident(col)} = p.v and t.user_id <> p.user_id`;
      const n = write
        ? (await rows(alpha, `update public.profiles t set ${ident(col)} = null ${pred} returning t.user_id`, [held.j])).length
        : Number((await one<{ n: number }>(alpha, `select count(*)::int as n from public.profiles t, jsonb_to_recordset($1::jsonb) as p(user_id text, v text) where t.${ident(col)} = p.v and t.user_id <> p.user_id`, [held.j])).n);
      report.extras[`profiles.${col} cleared on alpha (production gives it to another account)`] = n;
    }

    // ------------------------------------------- reward grants: one grant per (account, key)
    // A grant both have for one account and key, under two ids (each branch's reward job paid it):
    // production's replaces the alpha's, or the unique (user_id, grant_key) index aborts the copy.
    let replacedGrants = 0;
    {
      const grantRule = TABLES.find((t) => t.table === 'reward_grants');
      const pg = await one<{ j: string }>(
        prod,
        `select coalesce(json_agg(json_build_object('id', id, 'user_id', user_id, 'grant_key', grant_key)), '[]')::text as j
           from public.reward_grants${grantRule?.where ? ` where ${grantRule.where}` : ''}`,
      );
      const pred = `jsonb_to_recordset($1::jsonb) as p(id uuid, user_id text, grant_key text)
                    where t.user_id = p.user_id and t.grant_key = p.grant_key and t.id <> p.id`;
      replacedGrants = write
        ? (await rows(alpha, `delete from public.reward_grants t using ${pred} returning t.id`, [pg.j])).length
        : Number((await one<{ n: number }>(alpha, `select count(*)::int as n from public.reward_grants t, ${pred}`, [pg.j])).n);
    }

    // --------------------------------------------------------------- replay logs (opt-in)
    {
      const ref = await one<{ j: string }>(
        prod,
        `select coalesce(json_agg(id), '[]')::text as j from (
           select replay_id as id from public.records where replay_id is not null
           union select replay_id from public.matches where replay_id is not null) x`,
      );
      const missing = JSON.parse(
        (
          await one<{ j: string }>(
            alpha,
            `select coalesce(json_agg(x), '[]')::text as j from jsonb_array_elements_text($1::jsonb) x
              where not exists (select 1 from public.replays r where r.id = x::uuid)`,
            [ref.j],
          )
        ).j,
      ) as string[];
      report.extras['replay logs referenced by production records/matches and not on alpha'] = missing.length;
      const avg = await one<{ b: string; n: number }>(prod, `select pg_total_relation_size('public.replays')::text as b, count(*)::int as n from public.replays`);
      report.extras['MB those logs would add with --replays (estimate)'] = Number(avg.n)
        ? Math.round((missing.length * Number(avg.b)) / Number(avg.n) / 1048576)
        : 0;
      if (opts.replays) {
        let copied = 0;
        for (let i = 0; i < missing.length; i += 50) {
          const ids = JSON.stringify(missing.slice(i, i + 50));
          const page = await one<{ j: string }>(
            prod,
            `select coalesce(json_agg(r), '[]')::text as j from public.replays r
              where r.id in (select x::uuid from jsonb_array_elements_text($1::jsonb) x)`,
            [ids],
          );
          if (write) {
            const cols = (await columnsOf(alpha, 'public', 'replays')).map((c) => ident(c.name)).join(', ');
            copied += (
              await rows(
                alpha,
                `insert into public.replays (${cols}) select ${cols} from jsonb_populate_recordset(null::public.replays, $1::jsonb)
                 on conflict (id) do nothing returning id`,
                [page.j],
              )
            ).length;
          }
          if (i % 2000 === 0) log(`  replays ${i}/${missing.length}`);
        }
        report.extras['replay logs copied'] = copied;
      }
    }

    // ------------------------------------------------------------------- the table copies
    for (const { rule, cols, pk } of plan) {
      if (!pk.length) {
        report.refused.push(`${rule.table}: no primary key on alpha`);
        if (write) throw new Error(`${rule.table}: no primary key`);
        continue;
      }
      const tr: TableReport = {
        table: rule.table,
        prod: 0,
        alpha: await count(alpha, `public.${rule.table}`),
        insert: 0,
        update: 0,
        same: 0,
        alphaOnly: 0,
        notes: [],
      };
      // what a column becomes, read off `src` (the incoming row) and `t` (the alpha row)
      const value = (c: string, src: string, onUpdate: boolean): string => {
        if (onUpdate && rule.keepAlpha?.includes(c)) return `t.${ident(c)}`;
        if (onUpdate && rule.keepForTesters?.includes(c))
          return `case when ${IN_USE('t')} then t.${ident(c)} else ${src}.${ident(c)} end`;
        if (c === rule.replayCol)
          return `case when ${src}.${ident(c)} is null or exists (select 1 from public.replays r where r.id = ${src}.${ident(c)})
                       then ${src}.${ident(c)} end`;
        return `${src}.${ident(c)}`;
      };
      const upd = cols.filter((c) => !pk.includes(c));
      const differs = (src: string) =>
        upd.length
          ? `(${upd.map((c) => `t.${ident(c)}::text`).join(', ')}) is distinct from (${upd.map((c) => `(${value(c, src, true)})::text`).join(', ')})`
          : 'false';
      const on = pk.map((c) => `t.${ident(c)} = p.${ident(c)}`).join(' and ');
      const list = cols.map(ident).join(', ');
      const order = pk.map(ident).join(', ');
      let dropped = 0;

      for (let offset = 0; ; offset += pageSize) {
        const page = await one<{ j: string; n: number }>(
          prod,
          `select coalesce(json_agg(x), '[]')::text as j, count(*)::int as n from (
             select * from public.${ident(rule.table)}${rule.where ? ` where ${rule.where}` : ''}
              order by ${order} limit $1 offset $2) x`,
          [pageSize, offset],
        );
        const n = Number(page.n);
        if (!n) break;
        tr.prod += n;
        const src = `jsonb_populate_recordset(null::public.${ident(rule.table)}, $1::jsonb) as p`;
        if (rule.replayCol && !opts.replays) {
          dropped += Number(
            (
              await one<{ n: number }>(
                alpha,
                `select count(*)::int as n from ${src} where p.${ident(rule.replayCol)} is not null
                   and not exists (select 1 from public.replays r where r.id = p.${ident(rule.replayCol)})`,
                [page.j],
              )
            ).n,
          );
        }
        if (write) {
          const res = await rows<{ inserted: boolean }>(
            alpha,
            `insert into public.${ident(rule.table)} as t (${list})
             select ${cols.map((c) => value(c, 'p', false)).join(', ')} from ${src}
             on conflict (${order}) do update set ${upd.length ? upd.map((c) => `${ident(c)} = ${value(c, 'excluded', true)}`).join(', ') : `${ident(pk[0])} = excluded.${ident(pk[0])}`}
             where ${differs('excluded')}
             returning (xmax = 0) as inserted`,
            [page.j],
          );
          const ins = res.filter((r) => r.inserted).length;
          tr.insert += ins;
          tr.update += res.length - ins;
          tr.same += n - res.length;
        } else {
          const c = await one<{ ins: number; upd: number; same: number }>(
            alpha,
            `select count(*) filter (where t.${ident(pk[0])} is null)::int as ins,
                    count(*) filter (where t.${ident(pk[0])} is not null and ${differs('p')})::int as upd,
                    count(*) filter (where t.${ident(pk[0])} is not null and not ${differs('p')})::int as same
               from ${src} left join public.${ident(rule.table)} t on ${on}`,
            [page.j],
          );
          tr.insert += Number(c.ins);
          tr.update += Number(c.upd);
          tr.same += Number(c.same);
        }
        if (n < pageSize) break;
      }
      tr.alphaOnly = tr.alpha - tr.update - tr.same;
      if (rule.table === 'reward_grants' && replacedGrants) {
        // applied, they were deleted before `alpha` was counted; a dry run counts them as still there
        if (!write) tr.alphaOnly -= replacedGrants;
        tr.notes.push(`${replacedGrants} alpha grants replaced by production’s for the same account and key`);
      }
      if (dropped) tr.notes.push(`${dropped} copied without their replay (log not on alpha; --replays copies it)`);
      if (rule.keepForTesters)
        tr.notes.push(
          `${Number((await one<{ n: number }>(alpha, `select count(*)::int as n from public.profiles t where ${IN_USE('t')}`)).n)} testers/staff keep their alpha ${rule.keepForTesters.join(', ')}`,
        );
      report.tables.push(tr);
      log(`  ${rule.table}: prod ${tr.prod}, alpha ${tr.alpha} → +${tr.insert} new, ${tr.update} overwritten, ${tr.same} same, ${tr.alphaOnly} alpha-only kept`);
    }

    // -------------------------------------------- the season roll: production's active season
    // Upserting production's rows set their `active`; an alpha-only row for a game production has
    // rolled past would stay active beside it. `startNewSeason` deactivates the rest the same way.
    {
      const ps = await one<{ j: string }>(
        prod,
        `select coalesce(json_agg(json_build_object('game', game, 'bv', balance_version, 'active', active)), '[]')::text as j
           from public.seasons`,
      );
      const p = `jsonb_to_recordset($1::jsonb) as p(game text, bv int, active boolean)`;
      const pred = `s.active
        and not exists (select 1 from ${p} where p.game = s.game and p.bv = s.balance_version)
        and exists (select 1 from ${p} where p.game = s.game and p.active)`;
      report.extras['alpha-only seasons deactivated (production rolled past them)'] = write
        ? (await rows(alpha, `update public.seasons s set active = false where ${pred} returning s.game`, [ps.j])).length
        : Number((await one<{ n: number }>(alpha, `select count(*)::int as n from public.seasons s where ${pred}`, [ps.j])).n);
    }

    // ------------------------------ Neon Auth's verified flag (the email gate reads it there)
    // Neon Auth writes only the PRODUCTION branch's `neon_auth` schema. The alpha's copy has been
    // frozen since the branch was taken, so an address verified since reads unverified on alpha,
    // and `REQUIRE_VERIFIED_EMAIL` is on there. Only that one column, only for rows alpha has.
    {
      const has = async (c: SyncConn) =>
        (await columnsOf(c, 'neon_auth', 'user')).some((x) => x.name === 'emailVerified');
      if ((await has(prod)) && (await has(alpha))) {
        const v = await one<{ j: string }>(
          prod,
          `select coalesce(json_agg(json_build_object('id', id::text, 'v', "emailVerified")), '[]')::text as j from neon_auth."user"`,
        );
        const pred = `jsonb_to_recordset($1::jsonb) as p(id text, v boolean)
                      where u.id::text = p.id and u."emailVerified" is distinct from p.v`;
        report.extras['neon_auth.user emailVerified corrected'] = write
          ? (await rows(alpha, `update neon_auth."user" u set "emailVerified" = p.v from ${pred} returning u.id`, [v.j])).length
          : Number((await one<{ n: number }>(alpha, `select count(*)::int as n from neon_auth."user" u, ${pred}`, [v.j])).n);
      } else {
        report.extras['neon_auth.user emailVerified corrected'] = 0;
      }
    }

    if (write) {
      await alpha.query('commit');
      alphaOpen = false;
      report.applied = true;
    }
    return report;
  } finally {
    if (alphaOpen) await alpha.query('rollback').catch(() => {});
    await prod.query('rollback').catch(() => {});
  }
}

// ======================================================================================= CLI

const NEON = 'https://console.neon.tech/api/v2';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`${name}=`));
  return eq?.slice(name.length + 1);
}

/** pick NEON_API_KEY / NEON_PROJECT_ID out of an env file, never echoing it */
function loadEnvFile(path: string): void {
  if (!existsSync(path)) throw new Error(`--env: no file at ${path}`);
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^(NEON_API_KEY|NEON_PROJECT_ID)=(.*)$/);
    if (!m || process.env[m[1]]) continue;
    let v = m[2].trim();
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}

async function neon<T>(key: string, method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(NEON + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Neon ${method} ${path.split('?')[0]}: ${r.status} ${text.split(key).join('***').slice(0, 200)}`);
  return JSON.parse(text) as T;
}

interface Branch {
  id: string;
  name: string;
  default?: boolean;
  parent_id?: string;
}

async function main(): Promise<void> {
  const env = argValue('--env');
  if (env) loadEnvFile(env);
  const key = process.env.NEON_API_KEY;
  if (!key) throw new Error('NEON_API_KEY is not set (pass --env <file> or set it in the environment)');
  const apply = process.argv.includes('--apply');
  const replays = process.argv.includes('--replays');
  const alphaName = argValue('--alpha-branch') ?? 'alpha';

  let project = process.env.NEON_PROJECT_ID;
  if (!project) {
    const ps = (await neon<{ projects: { id: string }[] }>(key, 'GET', '/projects')).projects;
    if (ps.length !== 1) throw new Error(`this key sees ${ps.length} Neon projects; set NEON_PROJECT_ID`);
    project = ps[0].id;
  }
  const branches = (await neon<{ branches: Branch[] }>(key, 'GET', `/projects/${project}/branches`)).branches;
  const prodBranch = branches.find((b) => b.default);
  const alphaBranch = branches.find((b) => b.name === alphaName);
  if (!prodBranch || !alphaBranch) throw new Error(`need the default branch and a branch named "${alphaName}"`);
  // ⚠️ THE ONE BRANCH THIS WRITES MUST NEVER BE PRODUCTION'S
  if (alphaBranch.id === prodBranch.id || alphaBranch.default)
    throw new Error(`refusing: "${alphaName}" is the default branch`);
  if (alphaBranch.parent_id !== prodBranch.id)
    throw new Error(`refusing: "${alphaName}" is not a child of the default branch "${prodBranch.name}"`);

  const uri = async (b: Branch): Promise<string> => {
    const db = (await neon<{ databases: { name: string; owner_name: string }[] }>(key, 'GET', `/projects/${project}/branches/${b.id}/databases`)).databases[0];
    const q = new URLSearchParams({ branch_id: b.id, database_name: db.name, role_name: db.owner_name, pooled: 'false' });
    return (await neon<{ uri: string }>(key, 'GET', `/projects/${project}/connection_uri?${q}`)).uri;
  };
  const prodUri = await uri(prodBranch);
  const alphaUri = await uri(alphaBranch);
  if (new URL(prodUri).hostname === new URL(alphaUri).hostname) throw new Error('refusing: both branches resolve to one endpoint');

  const { default: pg } = await import('pg');
  // the session itself refuses writes, before the transaction says it again
  const prod = new pg.Client({ connectionString: prodUri, options: '-c default_transaction_read_only=on' });
  // a dry run opens alpha read-only too
  const alpha = new pg.Client({ connectionString: alphaUri, ...(apply ? {} : { options: '-c default_transaction_read_only=on' }) });
  await prod.connect();
  await alpha.connect();
  try {
    const ro = (await prod.query('show default_transaction_read_only')).rows[0] as { default_transaction_read_only: string };
    if (ro.default_transaction_read_only !== 'on') throw new Error('refusing: the production session is not read-only');
    console.log(`production: branch ${prodBranch.name} (read-only)`);
    console.log(`alpha:      branch ${alphaBranch.name}`);
    console.log(apply ? 'MODE: APPLY (writes to alpha)' : 'MODE: dry run (nothing is written; --apply writes)');

    const report = await syncAlpha(prod, alpha, {
      apply,
      replays,
      log: (l) => console.log(l),
      beforeWrite: async () => {
        // THE RESTORE POINT: alpha's WAL position now, plus a Neon snapshot when the plan allows.
        const lsn = ((await alpha.query('select pg_current_wal_lsn()::text as lsn, now() as at')).rows[0]) as { lsn: string; at: Date };
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        let snapshot = '';
        try {
          const s = await neon<{ snapshot?: { id: string; name: string } }>(
            key,
            'POST',
            // kept 14 days, then Neon deletes it: a snapshot is billed storage
            `/projects/${project}/branches/${alphaBranch.id}/snapshot?${new URLSearchParams({
              name: `alpha-pre-sync-${stamp}`,
              expires_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
            })}`,
          );
          if (s.snapshot) snapshot = `${s.snapshot.name} (${s.snapshot.id})`;
        } catch (e) {
          console.log(`  (no Neon snapshot: ${(e as Error).message}; the restore point below is the rollback)`);
        }
        const retention = (await neon<{ project: { history_retention_seconds: number } }>(key, 'GET', `/projects/${project}`)).project
          .history_retention_seconds;
        console.log('\nRESTORE POINT, taken before writing:');
        if (snapshot) console.log(`  Neon snapshot ${snapshot}: console → Backup & restore → restore it onto "${alphaName}".`);
        console.log(`  alpha LSN ${lsn.lsn} at ${new Date(lsn.at).toISOString()} (history kept ${Math.round(retention / 3600)} h).`);
        console.log('  ROLLBACK (alpha only; production is never written):');
        console.log(`    curl -X POST "${NEON}/projects/${project}/branches/${alphaBranch.id}/restore" \\`);
        console.log('      -H "Authorization: Bearer $NEON_API_KEY" -H "Content-Type: application/json" \\');
        console.log(`      -d '{"source_branch_id":"${alphaBranch.id}","source_lsn":"${lsn.lsn}","preserve_under_name":"alpha-synced-${stamp}"}'`);
        console.log('    or Neon console → Branches → alpha → Restore → from its own history at the time above.\n');
      },
    });

    console.log('\ntable                   prod    alpha   +new   overwritten   same   alpha-only kept');
    for (const t of report.tables) {
      console.log(
        `${t.table.padEnd(20)} ${String(t.prod).padStart(7)} ${String(t.alpha).padStart(8)} ${String(t.insert).padStart(6)} ${String(t.update).padStart(13)} ${String(t.same).padStart(6)} ${String(t.alphaOnly).padStart(17)}`,
      );
      for (const n of t.notes) console.log(`${''.padEnd(22)}${n}`);
    }
    console.log('');
    for (const [k, v] of Object.entries(report.extras)) console.log(`${String(v).padStart(7)}  ${k}`);
    console.log(`untouched (alpha's own): ${Object.entries(report.untouched).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    if (report.refused.length) {
      console.log(`\n${apply ? 'REFUSED, nothing written' : 'An --apply now would REFUSE'}:\n  ${report.refused.join('\n  ')}`);
      console.log('  Run it right after alpha is promoted to production, when both have applied the same migrations.');
      process.exitCode = apply ? 2 : 0;
    } else if (report.applied) console.log('\nAPPLIED: one transaction, committed.');
  } finally {
    await prod.end().catch(() => {});
    await alpha.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`sync-alpha-db: ${(e as Error).message}`);
    process.exit(1);
  });
}
