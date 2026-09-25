/**
 * Database test — runs the REAL migrations and the REAL payment code against a
 * REAL Postgres, in process. `npm run dbtest`.
 *
 * Why this exists: the first cut of the Ko-fi tier shipped with its webhook
 * idempotency and its claim race "verified by reading, not by running", because
 * there is no Postgres on a dev machine and standing one up was a yak. That is
 * exactly the code where a read-only review is worth least — the guarantees live
 * in primary keys, `on conflict`, and `where claimed_by is null`, none of which
 * a type checker or a careful read can actually exercise.
 *
 * PGlite is Postgres 17 compiled to WASM, so the migrations, the constraints,
 * and the transaction semantics are the genuine article rather than a mock. It
 * runs in memory and leaves nothing behind.
 *
 * Deliberately NOT wired into `npm test` — a red `npm test` must keep meaning
 * "physics broke" (see CLAUDE.md). This is its own command, like `contrast`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { setPoolForTests, type DbPool } from '../server/db/pool';
import { monthsFor, whyNoMonths, DEFAULT_POLICY, policyFromEnv } from '../server/kofi';
// a LEAF module (no imports, no env read at module scope — see its own header), so unlike
// `server/db/repo` this is safe to import up front rather than after the pool swap.
import { stripUnentitledCosmetics, cosmeticTier, type CosmeticId } from '../src/cosmetics';

/** the repo root — the few checks below read SOURCE, because what they guard is a call
 *  being deleted while tidying, not a behaviour this suite can drive. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * MODERATION, STUBBED AT THE TRANSPORT — so `saveReplay`'s name scrub can be exercised
 * without a network call or an API key.
 *
 * At MODULE SCOPE and not at the top of `main()` on purpose: `server/moderation.ts` reads its
 * key at module scope (`const API_KEY`, `export const moderationEnabled`), and since
 * `saveReplay` scrubs, `server/db/repo` pulls that module in — inside `main()`. Set the env
 * any later and moderation is already resolved as DISABLED.
 *
 * The failure direction is the safe one: if this stub is mis-wired, `scrubName` FAILS OPEN
 * (that is the documented policy), the flagged name passes through, and the check below goes
 * RED rather than falsely green. Nothing else here fetches — PGlite is in-process — so there
 * is nothing to restore afterwards. That is a fact about this file today, not a promise to
 * whoever adds the next check.
 */
process.env.MODERATION_API_KEY = 'dbtest';
process.env.MODERATION_API_URL = 'http://moderation.invalid/v1/moderations';
globalThis.fetch = (async (_url: unknown, init: { body: string }) => ({
  ok: true,
  json: async () => ({
    results: [{ flagged: String((JSON.parse(init.body) as { input: string }).input).includes('SLUR') }],
  }),
})) as unknown as typeof fetch;

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/**
 * PGlite as a `DbPool`.
 *
 * It is a single connection, so `connect()` hands back the same one and
 * `release()` is a no-op. That is fine for everything under test — `tx()` issues
 * begin/commit on its own connection, and the only concurrency the payment paths
 * care about is enforced by constraints, not by connection isolation. The one
 * thing it CANNOT prove is two machines racing on separate connections; the
 * `on conflict` / `where claimed_by is null` clauses are what make that safe, and
 * the tests below at least prove those clauses do what they claim in sequence.
 */
function adapt(db: PGlite): DbPool {
  const query = async (text: string, params: unknown[] = []) => {
    // PGlite's `query` is the extended (prepared-statement) protocol, which
    // refuses more than one command per call — and a migration file is dozens.
    // `exec` is the simple protocol and takes the whole script; it cannot bind
    // parameters, which is exactly the split below. `pg` blurs the two, so this
    // is the one real difference the adapter has to paper over.
    if (params.length === 0) {
      const res = await db.exec(text);
      return { rows: (res[res.length - 1]?.rows ?? []) as never[] };
    }
    return (await db.query(text, params)) as { rows: never[] };
  };
  return {
    query: query as DbPool['query'],
    connect: async () => ({ query: query as DbPool['query'], release: () => {} }),
  };
}

async function main(): Promise<void> {
  const db = new PGlite();
  await db.waitReady;
  setPoolForTests(adapt(db));

  // imported AFTER the pool swap purely for clarity; ESM live bindings mean the
  // order does not actually matter, but reading it top-down should not mislead.
  const { migrate } = await import('../server/db/migrate');
  const repo = await import('../server/db/repo');

  // ---------------------------------------------------------------- migrations
  await migrate();
  const tables = (
    await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public'`,
    )
  ).rows.map((r) => r.table_name);
  check('migrations: every .sql applies to a virgin database', tables.includes('profiles'));
  check('migrations: 0018 created kofi_payments', tables.includes('kofi_payments'));
  check('migrations: 0019 created supporter_grants', tables.includes('supporter_grants'));
  const cols = (
    await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'profiles'`,
    )
  ).rows.map((r) => r.column_name);
  check('migrations: profiles.supporter_until exists', cols.includes('supporter_until'));
  check('migrations: profiles.kofi_email exists', cols.includes('kofi_email'));
  check('migrations: 0020 added profiles.role', cols.includes('role'));
  check('migrations: 0044 added profiles.cosmetics', cols.includes('cosmetics'));

  // re-running must be a no-op, not an error — every regional machine boots this
  await migrate();
  check('migrations: a second run is a clean no-op', true);

  // ------------------------------------------------------------ tier policy
  const tip = { kind: 'Donation', amount: '1.00', currency: 'USD', isSubscription: false, tierName: null };
  const sub = { kind: 'Subscription', amount: '3.00', currency: 'USD', isSubscription: true, tierName: 'Supporter' };
  check('policy: a $1 tip buys nothing', monthsFor(tip) === 0);
  check('policy: a $3 subscription payment buys 1 month', monthsFor(sub) === 1);
  check(
    'policy: a subscription is 1 month regardless of amount (never double-counted)',
    monthsFor({ ...sub, amount: '36.00' }) === 1,
  );
  check('policy: a $9 one-off buys 3 months', monthsFor({ ...tip, amount: '9.00' }) === 3);
  check(
    'policy: a one-off is capped, so a typo cannot mint a decade',
    monthsFor({ ...tip, amount: '100000.00' }) === DEFAULT_POLICY.maxMonths,
  );
  check(
    'policy: a currency we do not settle in grants nothing rather than guessing a rate',
    monthsFor({ ...sub, currency: 'JPY' }) === 0,
  );
  check(
    'policy: float division cannot shave a month off an exact multiple',
    monthsFor({ ...tip, amount: '9.00' }, { ...DEFAULT_POLICY, monthlyPrice: 3 }) === 3 &&
      monthsFor({ ...tip, amount: '0.30' }, { ...DEFAULT_POLICY, monthlyPrice: 0.1 }) === 3,
  );
  check(
    'policy: but a cent SHORT of the tier is still short (no silent discount)',
    monthsFor({ ...tip, amount: '2.99' }) === 0,
  );
  check(
    'policy: the below-tier explanation names the real price',
    whyNoMonths(tip).includes('3.00'),
  );
  check(
    'policy: env overrides the price',
    policyFromEnv({ KOFI_MONTHLY_PRICE: '5', KOFI_CURRENCY: 'gbp' } as NodeJS.ProcessEnv)
      .monthlyPrice === 5,
  );

  // ------------------------------------------------------------------ set-up
  await repo.ensureProfile('user-a', 'Ada');
  await repo.ensureProfile('user-b', 'Bo');
  check('profiles: ensureProfile is idempotent', true);
  check('supporter: a fresh account is not a supporter', !(await repo.getSupporter('user-a')).supporter);

  // ------------------------------------------------- webhook: idempotency
  const evt = {
    messageId: 'msg-1',
    kind: 'Subscription',
    email: 'Payer@Example.com',
    transactionId: 'txn-1',
    amount: '3.00',
    currency: 'USD',
    isSubscription: true,
    tierName: 'Supporter',
    months: 1,
  };
  const first = await repo.recordKofiPayment(evt);
  check('webhook: a new event is recorded', first.fresh);
  check('webhook: an unknown payer is parked, not granted', first.autoGrantedTo === null);

  const retry = await repo.recordKofiPayment(evt);
  check('webhook: a Ko-fi RETRY of the same message_id is not recorded twice', !retry.fresh);
  const rowCount = (
    await db.query<{ n: string }>(`select count(*)::text as n from kofi_payments`)
  ).rows[0].n;
  check('webhook: exactly one payment row survives the retry', rowCount === '1', `rows=${rowCount}`);

  // ------------------------------------------------------------- claiming
  const missing = await repo.claimKofiPayment('user-a', 'nope');
  check('claim: an unknown transaction id is not-found', missing.outcome === 'not-found');

  const ok = await repo.claimKofiPayment('user-a', 'txn-1');
  check('claim: a valid payment grants the membership', ok.outcome === 'ok', ok.outcome);
  check('claim: it grants the months the payment was worth', ok.months === 1);
  check('supporter: the account is now a supporter', (await repo.getSupporter('user-a')).supporter);
  check(
    'claim: the payer email is linked, so future payments renew automatically',
    (await repo.getSupporter('user-a')).autoRenews,
  );
  const linked = (
    await db.query<{ kofi_email: string | null }>(
      `select kofi_email from profiles where user_id = 'user-a'`,
    )
  ).rows[0].kofi_email;
  check('claim: the linked email is stored lowercased', linked === 'payer@example.com', `${linked}`);

  const again = await repo.claimKofiPayment('user-a', 'txn-1');
  check('claim: the same account cannot claim one payment twice', again.outcome === 'already-claimed');
  const stolen = await repo.claimKofiPayment('user-b', 'txn-1');
  check('claim: a second account cannot claim a claimed payment', stolen.outcome === 'already-claimed');

  // ----------------------------------------------- THE RENEWAL PATH (blocker 1)
  const untilAfterFirst = (await repo.getSupporter('user-a')).supporterUntil!;
  const renewal = await repo.recordKofiPayment({
    ...evt,
    messageId: 'msg-2',
    transactionId: 'txn-2',
    email: 'payer@example.com',
  });
  check('renewal: month two is granted with NO manual claim', renewal.autoGrantedTo === 'user-a');
  const untilAfterSecond = (await repo.getSupporter('user-a')).supporterUntil!;
  check(
    'renewal: it EXTENDS the existing period rather than resetting it',
    new Date(untilAfterSecond) > new Date(untilAfterFirst),
    `${untilAfterFirst} -> ${untilAfterSecond}`,
  );
  const gap = new Date(untilAfterSecond).getTime() - new Date(untilAfterFirst).getTime();
  check(
    'renewal: exactly one month is added (28–31 days)',
    gap > 27 * 864e5 && gap < 32 * 864e5,
    `${Math.round(gap / 864e5)}d`,
  );
  const autoFlag = (
    await db.query<{ auto_claimed: boolean }>(
      `select auto_claimed from kofi_payments where message_id = 'msg-2'`,
    )
  ).rows[0].auto_claimed;
  check('renewal: the row records that a webhook, not a human, claimed it', autoFlag === true);

  // one Ko-fi subscription must not remove ads on unlimited accounts
  await repo.recordKofiPayment({
    ...evt,
    messageId: 'msg-3',
    transactionId: 'txn-3',
    email: 'payer@example.com',
  });
  // (msg-3 auto-granted to user-a as well; user-b tries to hijack the link)
  await repo.recordKofiPayment({
    ...evt,
    messageId: 'msg-4',
    transactionId: 'txn-4',
    email: 'payer@example.com',
    months: 1,
  });
  await db.query(`update kofi_payments set claimed_by = null, auto_claimed = false where message_id = 'msg-4'`);
  const hijack = await repo.claimKofiPayment('user-b', 'txn-4');
  check(
    'claim: an email already linked elsewhere cannot be re-linked to a second account',
    hijack.outcome === 'email-taken',
    hijack.outcome,
  );
  check('claim: the hijack attempt granted user-b nothing', !(await repo.getSupporter('user-b')).supporter);

  // ------------------------------------------------ below-tier (blocker 2)
  await repo.recordKofiPayment({
    messageId: 'msg-tip',
    kind: 'Donation',
    email: 'tipper@example.com',
    transactionId: 'txn-tip',
    amount: '1.00',
    currency: 'USD',
    isSubscription: false,
    tierName: null,
    months: monthsFor(tip),
  });
  const tipClaim = await repo.claimKofiPayment('user-b', 'txn-tip');
  check('claim: a $1 tip does NOT buy a month', tipClaim.outcome === 'below-tier', tipClaim.outcome);
  check('claim: the rejected tip stays unclaimed so an admin can still comp it', true);
  check('supporter: the tipper is still not a supporter', !(await repo.getSupporter('user-b')).supporter);

  // ------------------------------------------------- admin grant / revoke (3)
  const comped = await repo.grantSupporter('user-b', 3, 'admin', 'by admin-1: contributor');
  check('admin: a comp grants a membership', !!comped);
  check('admin: the comped account is a supporter', (await repo.getSupporter('user-b')).supporter);
  const hist = await repo.listSupporterGrants('user-b');
  check('audit: the comp is recorded with its source', hist[0]?.source === 'admin', hist[0]?.source);
  check('audit: the note names the acting admin', (hist[0]?.note ?? '').includes('admin-1'));

  const revoked = await repo.revokeSupporter('user-b', 'by admin-1: chargeback');
  check('admin: revoke ends the membership', revoked);
  check('admin: the revoked account is no longer a supporter', !(await repo.getSupporter('user-b')).supporter);
  check(
    'admin: revoking twice reports that there was nothing to revoke',
    !(await repo.revokeSupporter('user-b')),
  );
  const hist2 = await repo.listSupporterGrants('user-b');
  check('audit: the revocation is recorded too', hist2[0]?.source === 'revoke', hist2[0]?.source);

  const refunded = await repo.refundKofiPayment('txn-1');
  check('admin: a payment can be flagged refunded', refunded);
  check('admin: flagging the same payment twice is a no-op', !(await repo.refundKofiPayment('txn-1')));
  await db.query(`update kofi_payments set claimed_by = null where transaction_id = 'txn-1'`);
  const refundClaim = await repo.claimKofiPayment('user-b', 'txn-1');
  check('claim: a refunded payment cannot be claimed', refundClaim.outcome === 'refunded', refundClaim.outcome);

  // ------------------------------------------------------------ badge reads
  const badges = await repo.supportersAmong(['user-a', 'user-b', 'nobody']);
  check('badge: supportersAmong returns only the ACTIVE supporters', badges.has('user-a') && !badges.has('user-b'));
  check('badge: the profile read carries the supporter flag', (await repo.getProfile('user-a'))?.supporter === true);

  // an expired membership must read as lapsed, not as a supporter
  await db.query(`update profiles set supporter_until = now() - interval '1 day' where user_id = 'user-a'`);
  check('badge: a LAPSED membership reads as not-a-supporter', !(await repo.getSupporter('user-a')).supporter);
  check('badge: and drops out of supportersAmong', !(await repo.supportersAmong(['user-a'])).has('user-a'));
  await db.query(`update profiles set supporter_until = now() + interval '30 days' where user_id = 'user-a'`);

  // ------------------------------------------------------- staff roles (10)
  // `profiles.role` is a PROJECTION of ADMIN_USER_IDS/OWNER_USER_ID, and the two
  // things worth proving are that the projection is SYMMETRIC (losing the env
  // entry loses the role) and that staff are entitled to the supporter perks by
  // exactly the same predicate everything else reads.
  await repo.ensureProfile('user-own', 'Owner');
  await repo.ensureProfile('user-adm', 'Admin');
  await repo.ensureProfile('user-nob', 'Nobody');

  await repo.syncStaffRoles('user-own', ['user-own', 'user-adm']);
  check('staff: the owner gets the owner role', (await repo.getProfile('user-own'))?.role === 'owner');
  check('staff: the others get admin', (await repo.getProfile('user-adm'))?.role === 'admin');
  check('staff: everyone else keeps no role', (await repo.getProfile('user-nob'))?.role === undefined);

  // the owner appears in ADMIN_USER_IDS too (that is what gates the admin API),
  // and must NOT be demoted to admin by being listed twice
  check(
    'staff: an owner also listed as an admin stays the owner',
    (await repo.getProfile('user-own'))?.role === 'owner',
  );

  // THE PERK, and the reason the predicate is shared: no payment anywhere here
  const admEnt = await repo.getSupporter('user-adm');
  check('staff: an admin is entitled without paying', admEnt.supporter === true);
  check('staff: ...with no expiry, because nothing was bought', admEnt.supporterUntil === null);
  check('staff: ...and reports the role so the UI can say why', admEnt.role === 'admin');
  check('staff: the badge query agrees', (await repo.supportersAmong(['user-adm'])).has('user-adm'));
  check(
    'staff: a non-staff account with no membership is still not a supporter',
    !(await repo.getSupporter('user-nob')).supporter,
  );

  const staff = await repo.staffAmong(['user-own', 'user-adm', 'user-nob']);
  check('staff: staffAmong maps ids to roles', staff.get('user-own') === 'owner' && staff.get('user-adm') === 'admin');
  check('staff: and omits everyone else', !staff.has('user-nob'));

  // SYMMETRY — the sweep must revoke, not just grant. An id dropped from the env
  // that kept its badge and its free membership is the failure mode that matters.
  await repo.syncStaffRoles('user-own', ['user-own']);
  check('staff: dropping an id from the env clears the role', (await repo.getProfile('user-adm'))?.role === undefined);
  check(
    'staff: ...and takes the free entitlement with it',
    !(await repo.getSupporter('user-adm')).supporter,
  );

  // demotion of the owner themselves (handover), and the no-owner case
  await repo.syncStaffRoles(null, ['user-own']);
  check('staff: an owner demoted to admin becomes an admin', (await repo.getProfile('user-own'))?.role === 'admin');
  await repo.syncStaffRoles(null, []);
  check('staff: an empty env leaves nobody staff', (await repo.getProfile('user-own'))?.role === undefined);

  // the column is constrained, so a hand-edited row cannot invent a role
  let rejected = false;
  try {
    await db.query(`update profiles set role = 'superuser' where user_id = 'user-nob'`);
  } catch {
    rejected = true;
  }
  check('staff: the check constraint rejects an unknown role', rejected);

  // a staff member who ALSO paid keeps their real expiry — the role grants the
  // perks, it does not overwrite the purchase
  await repo.syncStaffRoles('user-a', []);
  const paidStaff = await repo.getSupporter('user-a');
  check('staff: a paying owner still reports the paid expiry', paidStaff.supporterUntil !== null);
  check('staff: ...and is a supporter either way', paidStaff.supporter === true);
  await repo.syncStaffRoles(null, []);

  // ------------------------------------------- badges on EVERY name surface
  // The badge is only meaningful if it is everywhere a name is: it shipped on
  // the record board and was silently missing from the ranked board beside it,
  // from match history, and from the friends list — every one of those a query
  // that simply did not project the two columns. Nothing in the type system
  // catches that (an absent field renders as "no badge"), so the queries behind
  // each surface are asserted here one by one.
  await repo.ensureProfile('badge-own', 'Ownie');
  await repo.ensureProfile('badge-sup', 'Suppy');
  await repo.ensureProfile('badge-nil', 'Plain');
  await repo.syncStaffRoles('badge-own', ['badge-own']);
  await db.query(
    `update profiles set supporter_until = now() + interval '30 days' where user_id = 'badge-sup'`,
  );
  await db.query(
    `update profiles set username = 'ownie' where user_id = 'badge-own'`,
  );

  const SEASON = 99;
  await repo.ensureSeason(SEASON, 'decode', 7);
  const act = await repo.actForSeason(SEASON, 'decode');

  // RANKED — the board that shipped bare. Placement gates the board, so each
  // player needs PLACEMENT_GAMES rated results before they appear at all.
  for (let i = 0; i < 5; i++) {
    await repo.upsertRating('badge-own', '1v1', act, 1600, 60, 0.06, 'decode');
    await repo.upsertRating('badge-nil', '1v1', act, 1400, 60, 0.06, 'decode');
  }
  await repo.upsertEloHistory('badge-own', '1v1', SEASON, 1600, 60, 0.06, 5, 'decode');
  const eloRows = await repo.eloLeaderboard({ mode: '1v1', act, game: 'decode' });
  const eloOwn = eloRows.find((r) => r.userId === 'badge-own');
  const eloNil = eloRows.find((r) => r.userId === 'badge-nil');
  check('badges/ranked: the live board carries the role', eloOwn?.role === 'owner');
  check('badges/ranked: ...and the supporter flag it implies', eloOwn?.supporter === true);
  check('badges/ranked: a plain player carries neither', !eloNil?.role && eloNil?.supporter === false);
  const eloHist = await repo.eloHistoryLeaderboard({ mode: '1v1', balanceVersion: SEASON, game: 'decode' });
  check(
    'badges/ranked: the ARCHIVED season board carries them too',
    eloHist.find((r) => r.userId === 'badge-own')?.role === 'owner',
  );

  // ---- getSkill / actFor — the reads a SKILL-BASED matchmaker pairs on ------
  // `getRating`'s `?? 1000` cannot tell "never played this board" from "played to
  // exactly 1000", and the placement flag is games-based — so the matcher needs
  // `games` in the same row, which neither existing read selects.
  {
    const placed = await repo.getSkill('badge-own', '1v1', act, 'decode');
    check('skill: a played board returns the real rating', placed.rating === 1600, String(placed.rating));
    check('skill: ...and the games count that decides placement', placed.games === 5, String(placed.games));
    check('skill: 5 games is PLACED', placed.placed === true);

    // the ambiguity the matcher must not fall into: an ACCOUNT WITH NO ROW reads
    // 1000, and that must surface as UNPLACED so a matcher declines to gate on it
    const unknown = await repo.getSkill('badge-nobody', '1v1', act, 'decode');
    check('skill: an unplayed board defaults to 1000', unknown.rating === 1000, String(unknown.rating));
    check('skill: ...but reports UNPLACED, so 1000 is never mistaken for a real rating',
      unknown.placed === false && unknown.games === 0);

    // a partially-placed player is the case that breaks a rating-only read
    await repo.ensureProfile('badge-new', 'Newbie');
    for (let i = 0; i < 2; i++) await repo.upsertRating('badge-new', '1v1', act, 1000, 300, 0.06, 'decode');
    const partial = await repo.getSkill('badge-new', '1v1', act, 'decode');
    check('skill: 2 games is still UNPLACED', partial.placed === false && partial.games === 2, String(partial.games));

    // the board key is (mode, game, act) — a rating must not leak across any of them
    const otherMode = await repo.getSkill('badge-own', '2v2', act, 'decode');
    check('skill: a 1v1 rating does not leak into the 2v2 board', otherMode.placed === false);
    const otherGame = await repo.getSkill('badge-own', '1v1', act, 'chain');
    check('skill: ...nor across games', otherGame.placed === false);

    // actFor collapses currentSeasonNumber + actForSeason and MEMOIZES them: reading a
    // rating was three sequential round trips, which is fine once per staged match and
    // not fine once per JOIN
    repo.clearActCache();
    const a1 = await repo.actFor('decode');
    check('actFor: resolves the same act as the two-query path', a1 === act, `${a1} vs ${act}`);
    const a2 = await repo.actFor('decode');
    check('actFor: a second call is served from the memo', a2 === a1);
    // and the memo is per-GAME, or a Chain queuer would be priced on DECODE's act
    const aChain = await repo.actFor('chain');
    check('actFor: the memo is keyed per game', typeof aChain === 'number');
    // the TTL is what lets an admin roll an act without a redeploy
    const aStale = await repo.actFor('decode', Date.now() + 120_000);
    check('actFor: past the TTL it re-reads rather than serving a stale act', aStale === act);
  }

  // RECORDS — the primary name already had a badge; the DUO PARTNER did not,
  // and a duo row prints two names.
  await repo.submitRecord({
    userId: 'badge-sup',
    partnerId: 'badge-own',
    mode: 'duo',
    drivetrain: 'tank',
    score: 250,
    balanceVersion: SEASON,
    replayId: null as unknown as string, // nullable FK; no replay needed here
    game: 'decode',
  });
  await repo.submitRecord({
    userId: 'badge-nil',
    mode: 'solo',
    drivetrain: 'tank',
    score: 100,
    balanceVersion: SEASON,
    replayId: null as unknown as string,
    game: 'decode',
  });
  const recRows = await repo.recordLeaderboard({ mode: 'duo', balanceVersion: SEASON, game: 'decode' });
  const duo = recRows.find((r) => r.userId === 'badge-sup');
  check('badges/records: the runner keeps their supporter flag', duo?.supporter === true);
  check('badges/records: the duo PARTNER carries their own role', duo?.partnerRole === 'owner');
  check('badges/records: ...and their own supporter flag', duo?.partnerSupporter === true);
  const solo = (await repo.recordLeaderboard({ mode: 'solo', balanceVersion: SEASON, game: 'decode' }))[0];
  check(
    'badges/records: a SOLO row reports the absent partner as false, not null',
    solo?.partnerSupporter === false,
  );

  // MATCH HISTORY — the Career page's list, and the one place a name appears
  // for BOTH alliances of somebody else's match.
  const matchId = await repo.saveMatch('1v1', SEASON, null as unknown as string, true, 'decode');
  await repo.addMatchParticipant({
    matchId, userId: 'badge-nil', alliance: 'red', drivetrain: 'tank',
    score: 80, won: false, ratingBefore: 1000, ratingAfter: 990,
  });
  await repo.addMatchParticipant({
    matchId, userId: 'badge-own', alliance: 'blue', drivetrain: 'tank',
    score: 120, won: true, ratingBefore: 1000, ratingAfter: 1010,
  });
  const vsHist = await repo.userMatchHistory('badge-nil', { balanceVersion: SEASON, game: 'decode' });
  const versus = vsHist.rows.find((r) => r.kind === 'versus');
  const oppo = versus?.players.find((p) => p.userId === 'badge-own');
  check('badges/history: an opponent in the list carries their role', oppo?.role === 'owner');
  check(
    'badges/history: ...and a plain participant carries neither',
    versus?.players.find((p) => p.userId === 'badge-nil')?.supporter === false,
  );
  const runHist = await repo.userMatchHistory('badge-sup', { balanceVersion: SEASON, game: 'decode' });
  const run = runHist.rows.find((r) => r.kind === 'record');
  check(
    'badges/history: a record run badges its PARTNER too',
    run?.players.find((p) => p.userId === 'badge-own')?.role === 'owner',
  );

  // FRIENDS + SEARCH — polled surfaces. These deliberately used to skip the
  // columns; they no longer do, because a badge that shows on the leaderboard
  // and not beside the same person in your friends list reads as a bug.
  await repo.sendFriendRequest('badge-own', 'badge-nil');
  const pending = await repo.listFriends('badge-nil');
  check('badges/friends: an INCOMING request carries the role', pending.incoming[0]?.role === 'owner');
  await repo.acceptFriendRequest('badge-nil', 'badge-own');
  const friendList = await repo.listFriends('badge-nil');
  check('badges/friends: a friend row carries the role', friendList.friends[0]?.role === 'owner');
  check('badges/friends: ...and the supporter flag', friendList.friends[0]?.supporter === true);

  await repo.inviteToRoom('badge-own', 'badge-nil', 'ROOM01', 'decode', 'match', null, 'casual1v1');
  const invited = await repo.listFriends('badge-nil');
  check('badges/friends: the CHALLENGE sender is badged', invited.invites[0]?.from.role === 'owner');
  // the SENT list shows the OTHER party, so it must project the badge from a
  // different join than the received list does — assert it against staff, or the
  // check passes on a query that selects nothing at all
  await repo.inviteToRoom('badge-nil', 'badge-own', 'ROOM02', 'decode', 'match', null, 'casual1v1');
  const asSender = await repo.listFriends('badge-nil');
  check('badges/friends: and the recipient on the SENDER’s side', asSender.sent[0]?.to.role === 'owner');
  check(
    'badges/friends: the standalone invite read agrees with the folded one',
    (await repo.listRoomInvites('badge-nil'))[0]?.from.role === 'owner',
  );
  check(
    'badges/search: a username lookup carries the badge',
    (await repo.searchUsersByName('own'))[0]?.role === 'owner',
  );

  // ---- "PLAY A FRIEND" CHALLENGES: clearing a spent one -------------------
  // Reported bug: an ACCEPTED challenge kept reading as "pending" — on both the
  // recipient's incoming list and the sender's sent list — for the rest of
  // INVITE_TTL_S even after the match it produced had been played to completion.
  // Nothing ever told `room_invites` the row was spent. `clearRoomInvites` is the
  // fix: the server calls it once the room a casual challenge named is actually
  // joined (`server/index.ts` `joinRoom`) or once a rated party token's match is
  // staged (`server/matchmaking.ts` `assign`) — this only covers the repo-level
  // half, which both call sites share.
  await repo.inviteToRoom('badge-own', 'badge-nil', 'ROOMCLR', 'decode', 'versus', null, 'casual1v1');
  check(
    'challenge: a fresh invite shows on both the recipient’s and the sender’s side',
    (await repo.listRoomInvites('badge-nil')).some((i) => i.room === 'ROOMCLR') &&
      (await repo.listFriends('badge-own')).sent.some((s) => s.room === 'ROOMCLR'),
  );
  await repo.clearRoomInvites('ROOMCLR');
  check(
    'challenge: clearing it drops it from the recipient’s incoming list',
    !(await repo.listRoomInvites('badge-nil')).some((i) => i.room === 'ROOMCLR'),
  );
  check(
    'challenge: ...and from the sender’s sent list — the exact symptom reported',
    !(await repo.listFriends('badge-own')).sent.some((s) => s.room === 'ROOMCLR'),
  );
  // scoped to the one room code: clearing a spent challenge must never touch a
  // different, still-live one polled in the same request.
  await repo.inviteToRoom('badge-own', 'badge-nil', 'ROOMKEEP', 'decode', 'versus', null, 'casual1v1');
  await repo.clearRoomInvites('ROOMCLR'); // already gone — must be a silent no-op
  check(
    'challenge: clearing one room code never touches another',
    (await repo.listRoomInvites('badge-nil')).some((i) => i.room === 'ROOMKEEP'),
  );
  // the JOIN path is scoped to the recipient: the host re-joining their own room (a reconnect)
  // must not delete an invite nobody has answered, and the recipient joining must.
  await repo.clearRoomInvitesTo('ROOMKEEP', 'badge-own');
  check(
    'challenge: the SENDER joining the room does not clear an unanswered invite',
    (await repo.listRoomInvites('badge-nil')).some((i) => i.room === 'ROOMKEEP'),
  );
  await repo.clearRoomInvitesTo('ROOMKEEP', 'badge-nil');
  check(
    'challenge: the RECIPIENT joining the room clears it, on both sides',
    !(await repo.listRoomInvites('badge-nil')).some((i) => i.room === 'ROOMKEEP') &&
      !(await repo.listFriends('badge-own')).sent.some((s) => s.room === 'ROOMKEEP'),
  );

  // ---- global presence aggregation ---------------------------------------
  // Rewritten from two statements into one (the sum, plus a distinct-count over the
  // same rows) to halve the cost of the site's most-called query. It had no coverage,
  // and the failure mode is a WRONG NUMBER rather than an error, so it needs some.
  await db.query(`delete from presence`);
  const beat = (m: string, region: string, online: number, authed: string[], q1 = 0, q2 = 0) =>
    repo.upsertPresence(m, region, online, authed, q1, q2);
  await beat('m-iad', 'iad', 3, ['u1', 'u2'], 1, 0);
  await beat('m-lhr', 'lhr', 2, ['u2', 'u3'], 0, 2);
  let pres = await repo.globalPresence();
  check('presence: sockets are summed across regions', pres.online === 5, `online=${pres.online}`);
  check(
    'presence: signed-in users are DEDUPED across regions (u2 is on both)',
    pres.signedIn === 3,
    `signedIn=${pres.signedIn}`,
  );
  check(
    'presence: queue depths are summed per bucket',
    pres.queues['1v1'] === 1 && pres.queues['2v2'] === 2,
    JSON.stringify(pres.queues),
  );

  // a machine that stopped beating drops out — that is how a crashed/stopped region
  // is forgotten, and it is why a BUSY machine must keep writing inside the window
  await db.query(`update presence set updated_at = now() - interval '60 seconds' where machine = 'm-lhr'`);
  pres = await repo.globalPresence();
  check('presence: a stale machine is excluded entirely', pres.online === 3, `online=${pres.online}`);
  check('presence: ...including its signed-in users', pres.signedIn === 2, `signedIn=${pres.signedIn}`);
  check(
    'presence: ...and its queue depth',
    pres.queues['2v2'] === 0,
    JSON.stringify(pres.queues),
  );

  // re-beating the SAME machine id overwrites rather than accumulating a ghost row
  await beat('m-iad', 'iad', 1, ['u1']);
  const n = (await db.query<{ c: string }>(`select count(*)::text as c from presence`)).rows[0].c;
  pres = await repo.globalPresence();
  check('presence: a machine re-beating updates its row, never adds one', n === '2', `rows=${n}`);
  check('presence: the updated count replaces the old one', pres.online === 1, `online=${pres.online}`);

  // everything quiet: zero, not null/NaN
  await db.query(`update presence set updated_at = now() - interval '60 seconds'`);
  pres = await repo.globalPresence();
  check(
    'presence: an empty world aggregates to a clean zero',
    pres.online === 0 && pres.signedIn === 0 && pres.queues['1v1'] === 0 && pres.queues['2v2'] === 0,
    JSON.stringify(pres),
  );
  await db.query(`delete from presence`);

  // ---- cross-region LIVE ROOMS + the operator view (0021) -----------------
  // "Watch Live" listed only the caller's own region, because a machine knows only
  // its own rooms and anycast picks which machine answers. Rooms now ride this same
  // heartbeat, and the aggregate is what the list reads.
  await repo.ensureProfile('op-1', 'Ada');
  await repo.ensureProfile('op-2', 'Grace');
  await repo.upsertPresence(
    'm-iad', 'iad', 4, ['op-1'], 1, 0,
    [{ room: 'iad-a1', mode: '1v1' }],
    [{ userId: 'op-1', act: 'match', room: 'iad-a1' }],
    { total: 2, inMatch: 1, inLobby: 0, idle: 1 },
  );
  await repo.upsertPresence(
    'm-nrt', 'nrt', 2, ['op-2'], 0, 0,
    [{ room: 'nrt-b2', mode: '2v2' }],
    [{ userId: 'op-2', act: 'menu', queue: '1v1', queuedS: 42 }],
    { total: 1, inMatch: 0, inLobby: 0, idle: 1 },
  );
  const liveAll = (await repo.globalLiveRooms()) as { room: string }[];
  check(
    'live rooms: matches from EVERY region come back, not just one',
    liveAll.length === 2 && liveAll.some((r) => r.room === 'iad-a1') && liveAll.some((r) => r.room === 'nrt-b2'),
    JSON.stringify(liveAll),
  );
  await db.query(`update presence set updated_at = now() - interval '60 seconds' where machine = 'm-nrt'`);
  check('live rooms: a stale machine’s rooms drop out with it', ((await repo.globalLiveRooms()) as unknown[]).length === 1);
  await repo.upsertPresence('m-nrt', 'nrt', 2, ['op-2'], 0, 0, [{ room: 'nrt-b2' }], [{ userId: 'op-2', act: 'menu', queue: '1v1', queuedS: 42 }], { total: 1, inMatch: 0, inLobby: 0, idle: 1 });

  const opRows = await repo.adminPresence();
  const allPlayers = opRows.flatMap((r) => r.players);
  check('operator view: every region is reported', opRows.length === 2, JSON.stringify(opRows.map((r) => r.region)));
  check(
    'operator view: signed-in accounts resolve to a handle',
    allPlayers.find((p) => p.userId === 'op-1')?.handle === 'Ada',
  );
  check(
    'operator view: a queued player shows the bucket AND the wait (a stall is the point)',
    allPlayers.find((p) => p.userId === 'op-2')?.queue === '1v1' &&
      allPlayers.find((p) => p.userId === 'op-2')?.queuedS === 42,
  );
  check(
    'operator view: anonymous sessions arrive as COUNTS',
    opRows.reduce((n, r) => n + r.anon.total, 0) === 3,
    JSON.stringify(opRows.map((r) => r.anon)),
  );
  // THE PRIVACY INVARIANT, asserted rather than assumed. If a later change starts
  // itemising guest sessions or recording what screen someone is on, these are what
  // say so out loud instead of it going unnoticed.
  check(
    'operator view: no anonymous session is identified anywhere in the payload',
    opRows.every((r) => Object.keys(r.anon).every((k) => ['total', 'inMatch', 'inLobby', 'idle'].includes(k))),
    JSON.stringify(opRows.map((r) => r.anon)),
  );
  check(
    'operator view: and it carries NO screen/menu detail for anybody',
    allPlayers.every((p) => !('screen' in p) && !('page' in p) && ['menu', 'lobby', 'match'].includes(p.act)),
  );
  // ---- PER-GAME queue depth aggregates across regions (0022) --------------
  // The flat q1v1/q2v2 columns count every game together, which is not how pairing
  // works — so a Chain Reaction queuer inflated DECODE's advertised depth.
  await repo.upsertPresence('m-iad', 'iad', 4, ['op-1'], 1, 0, [], [], null, {
    decode: { '1v1': 1, '2v2': 0 },
  });
  await repo.upsertPresence('m-nrt', 'nrt', 2, ['op-2'], 2, 1, [], [], null, {
    decode: { '1v1': 1, '2v2': 0 },
    chain: { '1v1': 1, '2v2': 1 },
  });
  const gq = await repo.globalPresence();
  check('per-game: depths are summed per game ACROSS regions',
    gq.gameQueues.decode['1v1'] === 2 && gq.gameQueues.chain['1v1'] === 1,
    JSON.stringify(gq.gameQueues));
  check('per-game: buckets stay separate within a game', gq.gameQueues.chain['2v2'] === 1);
  check('per-game: a game nobody is queued for is absent, not zeroed in',
    !('nope' in gq.gameQueues));
  check('per-game: the COMBINED total still adds up for older clients',
    gq.queues['1v1'] === 3 && gq.queues['2v2'] === 1, JSON.stringify(gq.queues));
  await db.query(`update presence set updated_at = now() - interval '60 seconds' where machine = 'm-nrt'`);
  const gq2 = await repo.globalPresence();
  check('per-game: a stale machine drops out of the per-game aggregate too',
    gq2.gameQueues.decode['1v1'] === 1 && !gq2.gameQueues.chain,
    JSON.stringify(gq2.gameQueues));
  await repo.upsertPresence('m-nrt', 'nrt', 2, ['op-2'], 0, 0, [{ room: 'nrt-b2' }], [{ userId: 'op-2', act: 'menu', queue: '1v1', queuedS: 42 }], { total: 1, inMatch: 0, inLobby: 0, idle: 1 });

  // ---- MAINTENANCE lockdown round-trips through the DB (0023) -------------
  // In the database rather than a machine's memory for two reasons that ARE the
  // feature: it has to survive the restart it exists to protect, and every region
  // has to agree (anycast puts players on different machines).
  const m0 = await repo.getMaintenance();
  check('maintenance: starts off', !m0.active && !repo.maintenanceBiting(m0));
  const T = Date.now();
  const m1 = await repo.setMaintenance({
    active: true, startsAt: T + 600_000, endsAt: T + 1_800_000, message: 'Season reset',
  });
  check('maintenance: a scheduled window round-trips', m1.active && m1.message === 'Season reset');
  check('maintenance: times survive the round trip', m1.startsAt === T + 600_000 && m1.endsAt === T + 1_800_000);
  check('maintenance: SCHEDULED does not lock anyone out yet', !repo.maintenanceBiting(m1, T));
  check('maintenance: ...but does once it starts', repo.maintenanceBiting(m1, T + 700_000));
  check('maintenance: ...and stops on its own when it ends', !repo.maintenanceBiting(m1, T + 2_000_000));
  const m2 = await repo.setMaintenance({ active: false, startsAt: null, endsAt: null, message: '' });
  check('maintenance: lifting it clears the window', !m2.active && m2.startsAt === null);
  check('maintenance: the row is a SINGLETON (no second window can exist)',
    (await db.query<{ c: string }>(`select count(*)::text as c from maintenance`)).rows[0].c === '1');

  // ---- LOCKDOWN SCOPE, ACCESS GROUPS, BANNERS (0051/0052) -------------------
  {
    const m3 = await repo.setMaintenance({
      active: true, startsAt: null, endsAt: null, message: 'Alpha is closed', scope: 'site',
      redirectUrl: 'https://playdsim.com', redirectLabel: 'Go to DSIM', bypass: ['beta', 'dev', 'contributor'],
    });
    check('lockdown: a SITE lockdown round-trips scope, redirect and bypass',
      m3.scope === 'site' && m3.redirectUrl === 'https://playdsim.com' && m3.redirectLabel === 'Go to DSIM' &&
      JSON.stringify(m3.bypass) === '["beta","dev","contributor"]', JSON.stringify(m3));
    check('lockdown: open-ended is allowed and bites now', repo.maintenanceBiting(m3));
    // an OLDER console posts none of the new fields: it must still mean "matches, nobody bypasses"
    const m4 = await repo.setMaintenance({ active: true, startsAt: null, endsAt: null, message: 'old console' });
    check('lockdown: a write without the 0051 fields means matches with no bypass',
      m4.scope === 'matches' && m4.bypass?.length === 0 && m4.redirectUrl === null, JSON.stringify(m4));
    const bad = await db.query(`update maintenance set scope = 'everything' where id = 1`).then(() => false, () => true);
    check('lockdown: the scope column refuses an unknown scope', bad);

    const W = { ...m3 };
    check('lockdown: an admin always passes', repo.lockdownPasses(W, { admin: true, groups: [] }));
    check('lockdown: a listed group passes', repo.lockdownPasses(W, { admin: false, groups: ['beta'] }));
    check('lockdown: nobody else does', !repo.lockdownPasses(W, { admin: false, groups: [] }));
    check('lockdown: an unlisted group does not',
      !repo.lockdownPasses({ ...W, bypass: ['dev'] }, { admin: false, groups: ['beta'] }));
    check('lockdown: a lockdown that is not biting lets everyone through',
      repo.lockdownPasses({ ...W, active: false }, { admin: false, groups: [] }));

    // ---- access groups, keyed by id, granted by tag
    await repo.ensureProfile('acc-1', 'Tester One');
    await repo.setUsername('acc-1', 'testerone');
    await repo.ensureProfile('acc-2', 'Twin');
    await repo.ensureProfile('acc-3', 'Twin');
    const byName = await repo.resolvePlayerTag('tester one');
    check('access: a display name resolves (case-insensitive)', byName.ok && byName.userId === 'acc-1', JSON.stringify(byName));
    const byUser = await repo.resolvePlayerTag('@TesterOne');
    check('access: an @username resolves', byUser.ok && byUser.userId === 'acc-1');
    const byId = await repo.resolvePlayerTag('acc-2');
    check('access: an account id resolves', byId.ok && byId.userId === 'acc-2');
    const twin = await repo.resolvePlayerTag('Twin');
    check('access: a shared display name is an error, not a guess', !twin.ok && /2 players/.test(twin.ok ? '' : twin.error));
    const none = await repo.resolvePlayerTag('nobody-here');
    check('access: an unknown tag says so', !none.ok && /No player/.test(none.ok ? '' : none.error));
    check('access: a first grant adds', await repo.grantAccess('acc-1', 'beta', 'admin-x', 'wave 1'));
    check('access: a second grant is a no-op', !(await repo.grantAccess('acc-1', 'beta', 'admin-y')));
    await repo.grantAccess('acc-1', 'dev', 'admin-x');
    check('access: groups are read by id', JSON.stringify((await repo.accessGroupsOf('acc-1')).sort()) === '["beta","dev"]');
    await repo.setHandle('acc-1', 'Renamed');
    const listed = await repo.listAccessMembers('beta');
    check('access: the list shows TODAY’s name, and a rename keeps the membership',
      listed.length === 1 && listed[0].handle === 'Renamed' && listed[0].grantedBy === 'admin-x', JSON.stringify(listed));
    const badGrp = await db.query(`insert into access_members (user_id, grp, granted_by) values ('acc-2', 'vip', 'x')`).then(() => false, () => true);
    check('access: an unknown group is refused by the table', badGrp);
    const ex = await repo.exportAccount('acc-1');
    check('access: the export lists the groups and never who granted them',
      (ex?.accessGroups.length ?? 0) === 2 && !JSON.stringify(ex?.accessGroups).includes('admin-x'));
    check('access: revoke removes', await repo.revokeAccess('acc-1', 'dev'));
    check('access: revoking twice says it was not there', !(await repo.revokeAccess('acc-1', 'dev')));
    await repo.deleteAccount('acc-1');
    check('access: deleting the account deletes its memberships',
      (await db.query<{ c: string }>(`select count(*)::text as c from access_members where user_id = 'acc-1'`)).rows[0].c === '0');

    // ---- banners
    const T2 = Date.now();
    const b1 = await repo.createBanner({ kind: 'known-bug', message: 'Ramp sticks. [Track it](https://x.y)', startsAt: null, endsAt: null, game: 'biobuzz', channel: null }, 'admin-x');
    const b2 = await repo.createBanner({ kind: 'info', message: 'later', startsAt: T2 + 3_600_000, endsAt: null, game: null, channel: 'alpha' }, 'admin-x');
    check('banners: a created banner starts at revision 1', b1.revision === 1 && b1.kind === 'known-bug' && b1.game === 'biobuzz');
    const open = await repo.listOpenBanners();
    check('banners: the open set includes scheduled ones (the cache filters by start)',
      open.some((b) => b.id === b1.id) && open.some((b) => b.id === b2.id));
    const b1e = await repo.updateBanner(b1.id, { kind: 'known-bug', message: 'Ramp sticks (fixed next deploy)', startsAt: null, endsAt: null, game: 'biobuzz', channel: null });
    check('banners: an edit bumps the revision, so a dismissal of the old text lapses', b1e?.revision === 2);
    check('banners: ending one takes it out of the open set',
      (await repo.endBanner(b1.id)) && !(await repo.listOpenBanners()).some((b) => b.id === b1.id));
    check('banners: ...and keeps it in the console history', (await repo.listBanners()).some((b) => b.id === b1.id));
    check('banners: delete removes the row', (await repo.deleteBanner(b2.id)) && !(await repo.listBanners()).some((b) => b.id === b2.id));
    const badKind = await db.query(`insert into banners (kind, message, created_by) values ('party', 'x', 'y')`).then(() => false, () => true);
    check('banners: an unknown kind is refused by the table', badKind);

    // ---- the cache every machine runs (server/siteState.ts), against the same database
    const site = await import('../server/siteState');
    await site.refreshLockdown(true);
    check('site: a matches-scope lockdown refuses a match start', !!(await site.lockdownRefusal(null, 'match')));
    check('site: ...but not a site-only action', (await site.lockdownRefusal(null, 'site')) === null);
    await repo.setMaintenance({ ...m3 });
    await site.refreshLockdown(true);
    check('site: a site lockdown refuses a site action for a stranger', !!(await site.lockdownRefusal(null, 'site')));
    await repo.ensureProfile('acc-9', 'Beta Nine');
    await repo.grantAccess('acc-9', 'beta', 'admin-x');
    site.forgetAccess('acc-9');
    check('site: ...and lets a beta tester through', (await site.lockdownRefusal('acc-9', 'site')) === null);
    const acc = await site.siteAccess('acc-9');
    check('site: /api/status access says the tester passes', acc.passes && acc.groups.includes('beta') && !acc.admin);
    check('site: the public lockdown carries the redirect and no ids',
      site.publicLockdown()?.redirectUrl === 'https://playdsim.com' && !JSON.stringify(site.publicLockdown()).includes('acc-'));
    await site.announceRestart('Server update', 300, 'admin-x');
    const n1 = site.legacyNotice();
    check('site: a restart announce is a DB row every machine reads, and the legacy notice follows it',
      n1?.kind === 'restart' && n1.message === 'Server update' && !!n1.until && n1.until > Date.now());
    check('site: the restart appears among the live banners', site.liveBanners().some((b) => b.kind === 'restart'));
    await site.cancelRestart();
    check('site: cancel clears it at once (no grace)', site.legacyNotice() === null && !site.liveBanners().some((b) => b.kind === 'restart'));
    await site.announceRestart('now', 0, 'admin-x');
    check('site: a zero-second restart still shows for its grace', site.legacyNotice()?.message === 'now');
    await site.cancelRestart();
    await repo.setMaintenance({ active: false, startsAt: null, endsAt: null, message: '' });
    await site.refreshLockdown(true);
  }

  // ---- guest sessions are ROWS now (0024) ---------------------------------
  await repo.upsertPresence(
    'm-iad', 'iad', 3, ['op-1'], 0, 0, [], [{ userId: 'op-1', act: 'match', room: 'r1', sessions: 2 }],
    { total: 2, inMatch: 1, inLobby: 0, idle: 1 }, {},
    [{ id: 'conn-a', act: 'match', room: 'r1' }, { id: 'conn-b', act: 'menu' }],
  );
  const gRows = (await repo.adminPresence()).find((r) => r.machine === 'm-iad');
  check('guests: each session is its own row', gRows?.guests.length === 2, JSON.stringify(gRows?.guests));
  check('guests: a row carries its activity and room', gRows?.guests[0].act === 'match' && gRows?.guests[0].room === 'r1');
  check('guests: an idle guest is visible as idle, not just as a total', gRows?.guests[1].act === 'menu');
  // the id is the SERVER's per-socket routing id — never an account id, and there is
  // still nothing in a guest row that could identify the person behind it
  check('guests: a guest row carries no account id, handle or username',
    gRows?.guests.every((g) => !('userId' in g) && !('handle' in g) && !('username' in g)) === true);
  check('accounts: a player\'s SOCKET count is reported (two tabs = one account, two sessions)',
    gRows?.players[0].sessions === 2);

  // a snapshot, never a timeline: re-beating REPLACES, so no history accumulates
  await repo.upsertPresence('m-iad', 'iad', 0, [], 0, 0, [], [], { total: 0, inMatch: 0, inLobby: 0, idle: 0 });
  const after = await repo.adminPresence();
  check(
    'operator view: a new beat REPLACES the last (snapshot, never a history)',
    (after.find((r) => r.machine === 'm-iad')?.players.length ?? 1) === 0,
  );
  await db.query(`delete from presence`);

  // ---- player search: @username OR display name --------------------------
  // The box says "name or @username", so both have to actually find someone. The
  // handle arm is a WORD prefix, which is the half that is easy to get wrong: it must
  // catch a surname mid-name and must NOT become a free substring probe.
  await repo.ensureProfile('find-1', 'Dohun Kim');
  await repo.ensureProfile('find-2', 'kimberly');
  await repo.ensureProfile('find-3', 'Nameless');
  await db.query(`update profiles set username = 'acekim' where user_id = 'find-1'`);
  await db.query(`update profiles set username = 'kimb' where user_id = 'find-2'`);
  // deliberately NO username on find-3 — it must never be offered
  const ids = async (qq: string): Promise<string[]> =>
    (await repo.searchUsersByName(qq)).map((u) => u.userId);

  check('search: finds by @username prefix', (await ids('acek')).includes('find-1'));
  check('search: finds by display-name prefix', (await ids('dohun')).includes('find-1'));
  check('search: finds by a WORD inside the display name', (await ids('kim')).includes('find-1'));
  check('search: is case-insensitive on the display name', (await ids('DOHUN')).includes('find-1'));
  check(
    'search: one query can match a username AND someone else’s display name',
    (async () => true)() && (await ids('kim')).includes('find-1') && (await ids('kim')).includes('find-2'),
  );
  check(
    'search: a username match outranks a display-name-only match',
    (await ids('kimb'))[0] === 'find-2',
  );
  check(
    'search: does NOT match a mid-WORD fragment (not a free substring probe)',
    !(await ids('ohun')).includes('find-1'),
  );
  check(
    'search: never offers a profile with no username (nothing to open or friend)',
    !(await ids('nameless')).includes('find-3'),
  );
  check('search: a LIKE wildcard cannot enumerate everyone', (await ids('%')).length === 0);

  await repo.syncStaffRoles(null, []);

  // -------------------------------------------------- account deletion (9)
  await repo.ensureProfile('user-c', 'Cy');
  await repo.recordKofiPayment({
    messageId: 'msg-c',
    kind: 'Donation',
    email: 'cy@example.com',
    transactionId: 'txn-c',
    amount: '3.00',
    currency: 'USD',
    isSubscription: false,
    tierName: null,
    months: 1,
  });
  await repo.claimKofiPayment('user-c', 'txn-c');
  await db.query(
    `insert into elo_history (user_id, mode, game, balance_version, rating) values ('user-c','1v1','decode',1,1500)`,
  );
  const gone = await repo.deleteAccount('user-c');
  check('delete: the account is removed', gone);
  check('delete: deleting a missing account reports false', !(await repo.deleteAccount('user-c')));
  const eloLeft = (
    await db.query<{ n: string }>(
      `select count(*)::text as n from elo_history where user_id = 'user-c'`,
    )
  ).rows[0].n;
  check('delete: elo_history has no FK, so it is deleted explicitly', eloLeft === '0');
  const grantsLeft = (
    await db.query<{ n: string }>(
      `select count(*)::text as n from supporter_grants where user_id = 'user-c'`,
    )
  ).rows[0].n;
  check('delete: the supporter audit rows cascade away with the profile', grantsLeft === '0');
  const pay = (
    await db.query<{ email: string | null; claimed_by: string | null }>(
      `select email, claimed_by from kofi_payments where transaction_id = 'txn-c'`,
    )
  ).rows[0];
  check('delete: the payment SURVIVES (financial history outlives the account)', !!pay);
  check('delete: but the payer email is scrubbed (personal data)', pay.email === null);
  check('delete: and the claim is unlinked by the FK', pay.claimed_by === null);

  // ------------------------------------------------------ misscore reports ----
  /**
   * A claim about a RESULT, and the smite that keeps the queue from being a weapon.
   *
   * Three things that are easy to get wrong: a second claim on the same match from the same
   * person must be a no-op rather than a second row (the unique index), resolving must be
   * idempotent under two moderators (the `status = 'open'` guard), and the smite must be
   * RECORDED on the row it was issued against. The standing charge itself goes through the
   * ordinary ledger and is covered with the rest of standing.
   */
  await repo.ensureProfile('sr-user', 'Filer');
  const srFiled = await repo.submitScoreReport({
    reporterId: 'sr-user',
    roomCode: 'ROOM1',
    detail: 'the last artifact scored and was not counted',
  });
  check('score reports: a claim is filed', srFiled === true);
  const srDupe = await repo.submitScoreReport({
    reporterId: 'sr-user',
    roomCode: 'ROOM1',
    detail: 'saying it again',
  });
  check('score reports: the same match from the same person is a no-op, not a second row', srDupe === false);
  const srOther = await repo.submitScoreReport({
    reporterId: 'sr-user',
    roomCode: 'ROOM2',
    detail: 'a different match',
  });
  check('score reports: ...but a different match still lands', srOther === true);

  const srOpen = await repo.listScoreReports({ status: 'open' });
  check('score reports: the queue lists open claims', srOpen.length === 2, `${srOpen.length}`);
  check(
    'score reports: each row carries the filer history a smite decision needs',
    srOpen[0].reporterFiled === 2 && srOpen[0].reporterRejected === 0,
    `filed=${srOpen[0].reporterFiled} rejected=${srOpen[0].reporterRejected}`,
  );

  const srDone = await repo.resolveScoreReport(srOpen[0].id, 'rejected', 'admin-1', 50);
  check('score reports: resolving returns the reporter to charge', srDone?.reporterId === 'sr-user');
  const srAgain = await repo.resolveScoreReport(srOpen[0].id, 'upheld', 'admin-2', 0);
  check('score reports: ...and a second moderator on the same row changes nothing', srAgain === null);
  const srAll = await repo.listScoreReports({});
  const srRejected = srAll.find((r) => r.id === srOpen[0].id);
  check(
    'score reports: the smite is recorded on the claim it was issued against',
    srRejected?.status === 'rejected' && srRejected?.smite === 50,
    `status=${srRejected?.status} smite=${srRejected?.smite}`,
  );
  const srStillOpen = await repo.listScoreReports({ status: 'open' });
  check(
    'score reports: ...and the rejected count is what the next moderator sees',
    srStillOpen[0]?.reporterRejected === 1,
    `${srStillOpen[0]?.reporterRejected}`,
  );

  // ------------------------------------------------------------------ replays
  /**
   * THE REPLAY ROUND-TRIP, which was broken for every replay ever stored.
   *
   * `replays` had no column for SIM_VERSION — `balance_version` is the SEASON and `sim_version`
   * holds the recording build's BALANCE_VERSION — so `getReplay` could not populate
   * `Replay.sim`, it came back undefined, and the playback gate read an absent `sim` as 0.
   * Nothing matched, so every DB-served replay was refused as stale on every build. It was
   * invisible because the replay tests all use in-memory containers, which carry the field.
   */
  {
    const { REPLAY_FORMAT, replayPlayable, replayRefusal } = await import('../src/sim/replay');
    const stored = {
      format: REPLAY_FORMAT,
      balanceVersion: 4,
      sim: 7,
      game: 'decode' as const,
      mode: 'match' as const,
      seed: 1234,
      ticks: 120,
      setups: [] as never[],
      tracks: { 0: [1, 2, 3, 4, 5, 6, 7] },
    };
    const id = await repo.saveReplay(stored, 9, 'decode');
    const back = await repo.getReplay(id);
    check('replays: a stored replay comes back', back !== null);
    check(
      'replays: the SIM_VERSION survives the round-trip (the gate has something to compare)',
      back?.sim === 7,
      `sim=${back?.sim}`,
    );
    check(
      'replays: the season stamp does NOT overwrite the recording build version',
      back?.balanceVersion === 4,
      `balanceVersion=${back?.balanceVersion} (season was 9)`,
    );
    check(
      'replays: a round-tripped replay plays against its own versions',
      !!back && replayPlayable(back, 4, 7),
    );
    /* ...and a row from before the column existed comes back UNSTAMPED, which is a different
       refusal from a known mismatch: the behaviour it ran is unrecoverable, not version 0. This
       is the only place that distinction is checked against a REAL row rather than a container
       built in memory — and reading it as 0 is exactly the bug 0031 exists to fix. */
    await db.query(`update replays set behaviour_version = null where id = $1`, [id]);
    const legacy = await repo.getReplay(id);
    check(
      'replays: a pre-0031 row is honestly UNSTAMPED, not silently version 0',
      !!legacy && legacy.sim === undefined && replayRefusal(legacy, 4, 7) === 'unstamped',
      `sim=${String(legacy?.sim)} refusal=${legacy ? replayRefusal(legacy, 4, 7) : 'n/a'}`,
    );

    /**
     * THE NAME ON THE FIELD. `src/render/renderer.ts` labels every robot from `spec.name`,
     * so an unmoderated one is public in the replay viewer and BURNED INTO every exported
     * video. It is scrubbed in `saveReplay` because that is the ONE funnel all three replay
     * writers share — and because `server/api.ts` moderates the LAN roster it DISPLAYS and
     * then hands the uploaded container straight to `saveLanRun`, so a THIRD PARTY's name
     * arrived unscrubbed. The stub at the top of this file is what decides 'SLUR' is flagged.
     */
    const { DEFAULT_SPEC, DEFAULT_ASSISTS } = await import('../src/sim/spawn');
    const dirty = await repo.saveReplay(
      {
        format: REPLAY_FORMAT,
        balanceVersion: 4,
        sim: 2,
        game: 'decode' as const,
        mode: 'match' as const,
        seed: 5,
        ticks: 60,
        tracks: { 0: [1, 2, 3, 4, 5, 6, 7] },
        setups: [
          {
            id: 0,
            alliance: 'red' as const,
            startIndex: 0,
            assists: DEFAULT_ASSISTS,
            spec: { ...DEFAULT_SPEC, name: 'SLUR bot', teamName: 'SLUR crew' },
          },
          {
            id: 1,
            alliance: 'blue' as const,
            startIndex: 1,
            assists: DEFAULT_ASSISTS,
            spec: { ...DEFAULT_SPEC, name: 'Perfectly Fine', teamName: 'Horizon' },
          },
        ],
      },
      SEASON,
      'decode',
    );
    const got = (await repo.getReplay(dirty))!.setups;
    check(
      'replays: a flagged robot name never reaches the field (it is drawn there, and burned into every exported video)',
      got[0].spec.name === DEFAULT_SPEC.name && got[0].spec.teamName === '',
      `name=${got[0].spec.name} team=${got[0].spec.teamName}`,
    );
    check(
      'replays: ...and a CLEAN name is passed through untouched (not blanked wholesale)',
      got[1].spec.name === 'Perfectly Fine' && got[1].spec.teamName === 'Horizon',
      `name=${got[1].spec.name} team=${got[1].spec.teamName}`,
    );
  }

  /**
   * ------------------------------------------------- solo practice runs -----
   *
   * The one table a CLIENT writes to, because solo practice is the offline mode and has no
   * authoritative loop to record it. Its whole safety argument is STRUCTURAL — `practice_runs`
   * is not reachable from `record_leaderboard`, which is a view over `records` — so the check
   * that matters most here is the boring one: a practice run does not appear on a board.
   */
  {
    await repo.ensureProfile('prac-a', 'Practiser');
    const container = (seed: number, ticks: number) => ({
      format: 2,
      balanceVersion: 4,
      sim: 2,
      game: 'decode' as const,
      mode: 'match' as const,
      seed,
      ticks,
      setups: [] as never[],
      tracks: { 0: [1, 2, 3, 4, 5, 6, 7] },
    });

    const first = await repo.savePracticeRun('prac-a', container(1, 9000), 87, SEASON, 'decode');
    check('practice: a run comes back with its replay', !!first.replayId && first.score === 87);
    const listed = await repo.listPracticeRuns('prac-a', 'decode');
    check('practice: ...and is listed for its owner', listed.length === 1 && listed[0].id === first.id);
    check(
      'practice: the stored replay is an ordinary one the viewer can already read',
      (await repo.getReplay(first.replayId!))?.sim === 2,
    );

    // THE POINT OF THE SEPARATE TABLE: a client-reported score cannot reach a board.
    const board = await repo.recordLeaderboard({ mode: 'solo', balanceVersion: SEASON, game: 'decode' });
    check(
      'practice: a practice run NEVER appears on the record leaderboard',
      !board.some((r) => r.score === 87 && r.userId === 'prac-a'),
      `${board.length} board rows`,
    );

    // PRUNE: the cap holds, and the pruned runs take their replays with them. A replay has no
    // back-reference to its run, so a prune that only deleted rows would leak the logs.
    for (let i = 2; i <= repo.PRACTICE_KEEP + 3; i++) {
      await repo.savePracticeRun('prac-a', container(i, 100 + i), i, SEASON, 'decode');
    }
    const capped = await repo.listPracticeRuns('prac-a', 'decode');
    check(
      'practice: an account keeps only PRACTICE_KEEP runs, newest first',
      capped.length === repo.PRACTICE_KEEP,
      `${capped.length} kept`,
    );
    check(
      'practice: the OLDEST went, not the newest',
      !capped.some((r) => r.id === first.id),
    );
    check(
      'practice: a pruned run took its replay with it (no orphaned logs)',
      (await repo.getReplay(first.replayId!)) === null,
    );

    /**
     * GAMES PLAYED + PLAYTIME. Practice is playing the game, so it credits `user_activity`
     * exactly like a server-run match does — the route mirrors `persist.ts`, measuring from
     * the replay's TICK COUNT. Pinned here because the two writes are in different files and
     * nothing else would notice them drifting apart.
     */
    {
      await repo.ensureProfile('prac-b', 'Counter');
      const before = (await repo.getActivity('prac-b')).byGame['decode']?.games ?? 0;
      const rep = container(99, 9000);
      await repo.savePracticeRun('prac-b', rep, 40, SEASON, 'decode');
      await repo.addActivity(['prac-b'], rep.ticks / 60, 'decode');
      const after = await repo.getActivity('prac-b');
      check(
        'practice: a run counts toward GAMES PLAYED',
        (after.byGame['decode']?.games ?? 0) === before + 1,
        `${before} → ${after.byGame['decode']?.games}`,
      );
      check(
        'practice: ...and adds the match length to PLAYTIME, from the replay ticks',
        (after.byGame['decode']?.seconds ?? 0) === 150,
        `${after.byGame['decode']?.seconds}s for ${rep.ticks} ticks`,
      );
      // pruning a run must NOT un-count it: you played it either way
      for (let i = 0; i < repo.PRACTICE_KEEP + 2; i++) {
        await repo.savePracticeRun('prac-b', container(500 + i, 60), i, SEASON, 'decode');
      }
      check(
        'practice: pruning old runs does not take back the games you played',
        ((await repo.getActivity('prac-b')).byGame['decode']?.games ?? 0) === before + 1,
      );
    }

    // ...and deleting the account takes the rest, for the same reason
    const live = (await repo.listPracticeRuns('prac-a', 'decode'))[0];
    await repo.deleteAccount('prac-a');
    check(
      'practice: deleting an account deletes its practice replays too',
      (await repo.getReplay(live.replayId!)) === null,
    );
    const rows = await db.query(`select count(*)::int as n from practice_runs where user_id = 'prac-a'`);
    check('practice: ...and its runs', (rows.rows[0] as { n: number }).n === 0);
  }

  /**
   * ------------------------------------------- THE PHYSICS TAG (0039) -------
   *
   * BIOBUZZ gains a second deterministic solve and stays ONE game on ONE board (the owner's
   * rule: never reset a season). So a 2D-era row and a 3D-era row are told apart by a column,
   * and everything below is the round-trip of that column through the REAL repo functions.
   *
   * The pre-0039 half is the one worth having. `physics` is `not null default '2d'`, and a row
   * written before the column existed IS a 2D-solve row — so it has to read back as one rather
   * than as null, or every consumer grows a `?? '2d'` and one of them eventually forgets.
   * There is no way to write a genuinely pre-0039 row here (the migration has already run), so
   * the closest honest thing is asserted instead: an insert that names no `physics` at all, i.e.
   * exactly the statement an older server build would send against the new schema.
   */
  {
    const { REPLAY_FORMAT } = await import('../src/sim/replay');
    const bb = (physics?: '2d' | '3d') => ({
      format: REPLAY_FORMAT,
      balanceVersion: 4,
      sim: 7,
      game: 'biobuzz' as const,
      physics,
      mode: 'match' as const,
      seed: 4242,
      ticks: 300,
      setups: [] as never[],
      tracks: { 0: [1, 2, 3, 4, 5, 6, 7] },
    });

    // ---- replays: the tag playback DISPATCHES on -------------------------------------
    const id3d = await repo.saveReplay(bb('3d'), SEASON, 'biobuzz');
    const back3d = await repo.getReplay(id3d);
    check('physics: a 3D replay round-trips its physics tag', back3d?.physics === '3d', `physics=${String(back3d?.physics)}`);
    const id2d = await repo.saveReplay(bb('2d'), SEASON, 'biobuzz');
    const back2d = await repo.getReplay(id2d);
    check(
      'physics: a 2D replay comes back ABSENT, not as the string — absent already reads 2d everywhere',
      back2d?.physics === undefined,
      `physics=${String(back2d?.physics)}`,
    );
    const idNone = await repo.saveReplay(bb(undefined), SEASON, 'biobuzz');
    check(
      'physics: an UNTAGGED container is stored as 2d (the column is not null)',
      ((await db.query(`select physics from replays where id = $1`, [idNone])).rows[0] as { physics: string }).physics === '2d',
    );
    // the pre-0039 row: an insert naming no `physics`, which is the statement an OLDER SERVER
    // BUILD sends against this schema — one Fly app serves every client, and a rollback is a
    // deploy away, so this is a live case and not a historical one.
    const legacy = await db.query(
      `insert into replays (format, balance_version, sim_version, behaviour_version, seed, ticks, setups, tracks, game)
       values (2, 1, 1, 1, 7, 10, '[]'::jsonb, '{}'::jsonb, 'biobuzz') returning id, physics`,
    );
    check(
      'physics: a row written WITHOUT the column reads back 2d, never null',
      (legacy.rows[0] as { physics: string }).physics === '2d',
      `physics=${String((legacy.rows[0] as { physics: string | null }).physics)}`,
    );

    // ---- records: the board row ------------------------------------------------------
    await repo.ensureProfile('phys-a', 'Physicist');
    const rec3d = await repo.submitRecord({
      userId: 'phys-a', mode: 'solo', drivetrain: 'mecanum', score: 123,
      balanceVersion: SEASON, replayId: id3d, game: 'biobuzz', physics: '3d',
    });
    const recRow = await db.query(`select physics from records where id = $1`, [rec3d]);
    check('physics: a record run stores its solve', (recRow.rows[0] as { physics: string }).physics === '3d');

    /**
     * ---- THE WRITE GATE (owner ruling, 2026-09-18) -----------------------------------
     *
     * Every server-connected BIOBUZZ match is 3D (`Room.physics`), so a 2D record submission
     * for it can only come from a process that disagrees — a stale one mid-deploy, or a caller
     * that invented one. `submitRecord` is the chokepoint and it REFUSES, rather than writing a
     * row every later read then has to hide. DECODE is the control: it has one solve, so its
     * untagged submissions are exactly what they always were.
     */
    let twoD = '';
    try {
      await repo.submitRecord({
        userId: 'phys-a', mode: 'solo', drivetrain: 'mecanum', score: 45,
        balanceVersion: SEASON, replayId: id2d, game: 'biobuzz', physics: '2d',
      });
    } catch (e) {
      twoD = e instanceof Error ? e.message : String(e);
    }
    check('ruling: a 2D record submission for BIOBUZZ is REFUSED', twoD !== '', twoD);
    let untagged = '';
    try {
      await repo.submitRecord({
        userId: 'phys-a', mode: 'solo', drivetrain: 'mecanum', score: 46,
        balanceVersion: SEASON, replayId: id2d, game: 'biobuzz',
      });
    } catch (e) {
      untagged = e instanceof Error ? e.message : String(e);
    }
    check('ruling: ...and so is an UNTAGGED one, since absent reads 2d', untagged !== '', untagged);
    await repo.ensureProfile('phys-dec', 'Decoder');
    const decRec = await repo.submitRecord({
      userId: 'phys-dec', mode: 'solo', drivetrain: 'mecanum', score: 77,
      balanceVersion: SEASON, replayId: id2d, game: 'decode',
    });
    check(
      'ruling: ...but a DECODE record run with no tag is accepted and stored as 2d',
      ((await db.query(`select physics from records where id = $1`, [decRec])).rows[0] as { physics: string })
        .physics === '2d',
    );

    /**
     * THE PRE-RULING ROW. Written with raw SQL on purpose: `submitRecord` refuses it now, and
     * the rows that matter are the ones already in the table from before the ruling. Its score
     * is HIGHER than the same player's 3D run, which is the shape that breaks a naive fix —
     * dedupe first and filter after, and this row becomes their "best", gets rejected by the
     * filter, and the player vanishes from a board they have a real 3D score on.
     */
    await db.query(
      `insert into records (user_id, mode, drivetrain, score, balance_version, replay_id, game, physics)
       values ('phys-a', 'solo', 'mecanum', 200, $1, $2, 'biobuzz', '2d')`,
      [SEASON, id2d],
    );

    // ---- the drivetrain CHECK finally knows about butterfly ---------------------------
    //
    // It was a hand-written list that never learned the fifth drivetrain, so a butterfly
    // record run was refused by the DATABASE after the match had been played and scored —
    // silent to the player, who simply never appeared on the board.
    let butterfly = '';
    try {
      await repo.submitRecord({
        userId: 'phys-a', mode: 'solo', drivetrain: 'butterfly', score: 66,
        balanceVersion: SEASON, replayId: id3d, game: 'biobuzz', physics: '3d',
      });
    } catch (e) {
      butterfly = e instanceof Error ? e.message : String(e);
    }
    check('physics: a BUTTERFLY record run is accepted (0039 widened records_drivetrain_check)',
      butterfly === '', butterfly);
    // ...and the constraint still REFUSES a name that is not a drivetrain, or it would have
    // been widened into nothing at all
    let bogus = '';
    try {
      await repo.submitRecord({
        userId: 'phys-a', mode: 'solo', drivetrain: 'hovercraft', score: 1,
        balanceVersion: SEASON, replayId: id3d, game: 'biobuzz', physics: '3d',
      });
    } catch (e) {
      bogus = e instanceof Error ? e.message : String(e);
    }
    check('physics: ...and the constraint still refuses a drivetrain that does not exist', bogus !== '');

    /**
     * ---- the BOARD read path: the DEFAULT is the 3D era ------------------------------
     *
     * The column existing and the board READING it are different facts, and the gap between
     * them is the kind that ships: a `select` that simply does not project a column still
     * compiles and still renders — which is how the ranked board once sat badge-less
     * (`docs/area/accounts.md`). So the projection is asserted, and so is the default.
     *
     * The default is the whole point of the ruling. It used to be "every row", with an optional
     * `physics` argument that `/api/records` filled from a QUERY PARAMETER — so the board a
     * client saw was the board it asked for, and a personal best or a career panel that forgot
     * to ask read both eras. `boardPhysics` moved that decision into the data layer.
     *
     * ⚠️ **THE FILTER IS INSIDE `best`, AND THIS IS THE CHECK THAT SAYS SO.** `best` is one row
     * per player. `phys-a` has a 3D run of 123 and a pre-ruling 2D run of 200, so their overall
     * best is the 2D one — and a filter applied AFTER `best` would find that row, reject it,
     * and leave the player off a board they demonstrably have a 3D score on. Filtering first is
     * what makes the board "each player's best 3D run".
     */
    {
      const def = await repo.recordLeaderboard({ mode: 'solo', balanceVersion: SEASON, game: 'biobuzz' });
      const mine = def.find((r) => r.userId === 'phys-a');
      check(
        'ruling/board: the DEFAULT BIOBUZZ board shows the player’s 3D run, not their higher 2D one',
        mine?.score === 123 && mine?.physics === '3d',
        `${String(mine?.score)}/${String(mine?.physics)}`,
      );
      check(
        'ruling/board: ...and no 2D row reaches it at all',
        !def.some((r) => r.physics === '2d'),
        def.map((r) => `${r.userId}:${String(r.physics)}`).join(','),
      );
      // the ESCAPE HATCH is still an argument (admin moderation, and this suite) — it is only
      // the public request that can no longer choose an era
      const only2d = await repo.recordLeaderboard({ mode: 'solo', balanceVersion: SEASON, game: 'biobuzz', physics: '2d' });
      const mine2d = only2d.find((r) => r.userId === 'phys-a');
      check(
        'ruling/board: an explicit 2D read still finds the retained row — nothing was deleted',
        mine2d?.score === 200 && mine2d?.physics === '2d',
        `${String(mine2d?.score)}/${String(mine2d?.physics)}`,
      );
      // DECODE is the control: one solve, so no filter is applied and its SQL is unchanged
      const dec = await repo.recordLeaderboard({ mode: 'solo', balanceVersion: SEASON, game: 'decode' });
      check(
        'ruling/board: a one-solve game is unfiltered — its 2D rows are its only rows',
        dec.some((r) => r.userId === 'phys-dec'),
        `${dec.length} rows`,
      );

      /**
       * THE THREE FIGURES BESIDE THE BOARD read the same era, or they contradict it: a PB of
       * 200 next to a board row of 123 is the player being told their best run is one nobody
       * can see, and a rank counted over both eras is a position on no board.
       */
      const pb = await repo.personalBest('phys-a', 'solo', 'mecanum', SEASON, 'biobuzz');
      check('ruling/pb: the personal best is the 3D one, not the higher 2D one', pb === 123, String(pb));
      const pbDec = await repo.personalBest('phys-dec', 'solo', 'mecanum', SEASON, 'decode');
      check('ruling/pb: ...and a one-solve game’s PB is untouched', pbDec === 77, String(pbDec));
      const rank = await repo.recordRank('phys-a', 'solo', 'mecanum', SEASON, 'biobuzz');
      check(
        'ruling/rank: the rank is computed WITHIN the 3D set',
        rank.rank === 1 && rank.total === 1,
        `${rank.rank}/${rank.total}`,
      );
      const stats = await repo.getUserStats('phys-a', SEASON, 'biobuzz');
      const solo = stats.records.find((r) => r.mode === 'solo');
      check(
        'ruling/career: the career panel’s record PB is the 3D one too',
        solo?.best === 123,
        String(solo?.best),
      );
      check('ruling/career: ...and its rank is over the 3D set', solo?.rank === 1, String(solo?.rank));
    }

    // ---- matches: the history row ----------------------------------------------------
    const m3d = await repo.saveMatch('2v2', SEASON, id3d, true, 'biobuzz', '3d');
    check(
      'physics: a versus match stores its solve',
      ((await db.query(`select physics from matches where id = $1`, [m3d])).rows[0] as { physics: string }).physics === '3d',
    );
    const mLegacy = await repo.saveMatch('1v1', SEASON, id2d, false, 'decode');
    check(
      'physics: an untagged match is 2d — which is what every DECODE match is',
      ((await db.query(`select physics from matches where id = $1`, [mLegacy])).rows[0] as { physics: string }).physics === '2d',
    );

    // ---- practice runs: physics AND the view it was watched in ------------------------
    //
    // The two are different KINDS of fact and are sourced differently, which is the thing to
    // pin: `physics` is read off the container (so it cannot disagree with the log), `view` is
    // the only thing the client tells us, and it is nullable because an old row genuinely does
    // not know rather than being 2D.
    await repo.ensureProfile('phys-b', 'Watcher');
    const run3d = await repo.savePracticeRun('phys-b', bb('3d'), 210, SEASON, 'biobuzz', '3d');
    check('physics: a practice run carries the solve it ran on', run3d.physics === '3d', String(run3d.physics));
    check('physics: ...and the view it was watched in', run3d.view === '3d', String(run3d.view));
    const runMixed = await repo.savePracticeRun('phys-b', bb('3d'), 44, SEASON, 'biobuzz', '2d');
    check(
      'physics: 3D physics WATCHED in the 2D view is a real combination and is stored as one',
      runMixed.physics === '3d' && runMixed.view === '2d',
      `${String(runMixed.physics)}/${String(runMixed.view)}`,
    );
    const runNoView = await repo.savePracticeRun('phys-b', bb(undefined), 5, SEASON, 'biobuzz');
    check(
      'physics: no view stated ⇒ null, not a guess',
      runNoView.view === null && runNoView.physics === '2d',
      `${String(runNoView.physics)}/${String(runNoView.view)}`,
    );
    const back = await repo.listPracticeRuns('phys-b', 'biobuzz');
    const listed3d = back.find((r) => r.id === run3d.id);
    check(
      'physics: the LIST path returns both columns (the Career panel reads this one)',
      listed3d?.physics === '3d' && listed3d?.view === '3d',
      `${String(listed3d?.physics)}/${String(listed3d?.view)}`,
    );
    // a garbage `view` off the wire must not reach the column: it is an enum, not free text
    const runJunk = await repo.savePracticeRun('phys-b', bb('3d'), 6, SEASON, 'biobuzz', 'vr-headset');
    check('physics: an unknown view is stored as null rather than passed through', runJunk.view === null,
      String(runJunk.view));

    // AND THE INVARIANT THAT MATTERS MOST: none of this made a practice run reachable from a
    // board. The tag is a label on a row; it must not become a second way in.
    const board = await repo.recordLeaderboard({ mode: 'solo', balanceVersion: SEASON, game: 'biobuzz' });
    check(
      'physics: a 3D practice run still never appears on the record leaderboard',
      !board.some((r) => r.userId === 'phys-b'),
      `${board.length} board rows`,
    );
  }

  /**
   * --------------------------------------------- self-hosted LAN matches ----
   *
   * The SECOND table a client writes to, and the less trusted of the two: a practice run at
   * least came off the player's own sim, while a LAN match comes off a server whose operator
   * could have patched it. Same structural defence — `lan_runs` cannot reach
   * `record_leaderboard` — plus one thing practice runs do not need: the upload is offered
   * more than once, by a client draining a backlog over a venue's connection, so `match_id`
   * has to make it idempotent.
   */
  {
    await repo.ensureProfile('lan-host', 'Hoster');
    await repo.ensureProfile('lan-host2', 'Other Hoster');
    const container = (seed: number, ticks: number) => ({
      format: 2,
      balanceVersion: 4,
      sim: 2,
      game: 'decode' as const,
      mode: 'match' as const,
      seed,
      ticks,
      setups: [] as never[],
      tracks: { 0: [1, 2, 3, 4, 5, 6, 7] },
    });
    const roster: repo.LanParticipant[] = [
      { name: 'Ana', teamName: 'Horizon', teamNumber: 36596, alliance: 'red', drivetrain: 'tank' },
      { name: 'Bo', teamName: 'Horizon', teamNumber: 36596, alliance: 'blue', drivetrain: 'mecanum' },
    ];
    /** a match id of the shape the hosting server actually mints, which the table now requires */
    const mid = (n: number): string =>
      `0000${n.toString(16).padStart(4, '0')}-0000-4000-8000-000000000000`;
    const MATCH_A = mid(1);

    const one = await repo.saveLanRun('lan-host', MATCH_A, container(1, 9000), { red: 120, blue: 98 }, roster, SEASON, 'decode');
    check('lan: a hosted match comes back with its replay', !!one.replayId && one.score.red === 120);
    check('lan: the roster round-trips as names, not ids', one.participants.length === 2 && one.participants[0].name === 'Ana');
    const listed = await repo.listLanRuns('lan-host', 'decode');
    check('lan: ...and is listed for the HOST', listed.length === 1 && listed[0].matchId === MATCH_A);
    check(
      'lan: the stored replay is an ordinary one the viewer can already read',
      (await repo.getReplay(one.replayId!))?.sim === 2,
    );

    // THE POINT OF THE SEPARATE TABLE: a score reported by an untrusted server cannot reach a board.
    const board = await repo.recordLeaderboard({ mode: 'solo', balanceVersion: SEASON, game: 'decode' });
    check(
      'lan: a LAN match NEVER appears on the record leaderboard',
      !board.some((r) => r.score === 120),
      `${board.length} board rows`,
    );

    // IDEMPOTENCE. The same match offered twice is ONE row — this is what makes a retry safe,
    // and it is the difference between a flaky venue connection and a duplicated history.
    const replaysBefore = await db.query(`select count(*)::int as n from replays`);
    const again = await repo.saveLanRun('lan-host', MATCH_A, container(99, 50), { red: 1, blue: 2 }, roster, SEASON, 'decode');
    check('lan: re-uploading the same matchId returns the SAME row', again.id === one.id);
    check('lan: ...and does not overwrite the first report', again.score.red === 120);
    const afterRetry = await repo.listLanRuns('lan-host', 'decode');
    check('lan: ...and creates no second row', afterRetry.length === 1);
    // the rejected upload must not leave its replay behind. A replay has no back-reference to
    // the run that owns it, so one written for a row that never existed is unreachable forever.
    const replaysAfter = await db.query(`select count(*)::int as n from replays`);
    const nBefore = (replaysBefore.rows[0] as { n: number }).n;
    const nAfter = (replaysAfter.rows[0] as { n: number }).n;
    check(
      'lan: ...and leaks no orphaned replay for the rejected upload',
      nAfter === nBefore,
      `${nBefore} -> ${nAfter}`,
    );

    /**
     * A SECOND ACCOUNT CANNOT CLAIM A MATCH SOMEBODY ELSE FILED, AND IS TOLD SO.
     *
     * It used to be handed the existing row with a 200. That reads like idempotence and is
     * not: the id was BROADCAST to the whole room with the match result, so any player or
     * spectator could file the host's match under their own account, and the real host's
     * upload was then answered with a stranger's row and marked done on the device. The id is
     * a host-only capability now (`matchArchive`), and the idempotence is scoped by host, so
     * this is a refusal `/api/lan` turns into a 409 rather than a silent win.
     */
    let claimed: string | null = null;
    try {
      await repo.saveLanRun('lan-host2', MATCH_A, container(7, 60), { red: 999, blue: 0 }, roster, SEASON, 'decode');
      claimed = 'accepted';
    } catch (err) {
      claimed = err instanceof repo.LanRunOwnedByAnother ? 'refused' : `wrong error: ${String(err)}`;
    }
    check('lan: another account claiming a filed matchId is REFUSED, not quietly answered', claimed === 'refused', String(claimed));
    check('lan: ...and it still belongs to the original host', (await repo.listLanRuns('lan-host2', 'decode')).length === 0);
    check(
      'lan: ...and the original host still owns the row it filed',
      (await repo.listLanRuns('lan-host', 'decode'))[0]?.hostUserId === 'lan-host',
    );
    // the refused claim must not leave its replay behind either
    const afterClaim = await db.query(`select count(*)::int as n from replays`);
    check(
      'lan: ...and the refused claim leaks no orphaned replay',
      (afterClaim.rows[0] as { n: number }).n === nAfter,
    );

    /**
     * THE SHAPE OF `match_id` IS A TABLE CONSTRAINT, not only an API check.
     *
     * The API refuses anything that is not a lowercase UUID, and that is a property of one
     * code path. This is a property of the table: the identity column is the one value the
     * uploader chooses, and freeform text there is an invitation to squat on it, to pad it,
     * or to store a megabyte of anything under it. Same for `game`, which arrives on a query
     * string and whose wrong values fail by silently listing nothing.
     */
    let badId = 'accepted';
    try {
      await db.query(
        `insert into lan_runs (match_id, host_user_id, game, balance_version, score, participants)
         values ('not-a-uuid', 'lan-host', 'decode', $1, '{}'::jsonb, '[]'::jsonb)`,
        [SEASON],
      );
    } catch {
      badId = 'refused';
    }
    check('lan: the TABLE refuses a match_id that is not a minted uuid', badId === 'refused');
    let badGame = 'accepted';
    try {
      await db.query(
        `insert into lan_runs (match_id, host_user_id, game, balance_version, score, participants)
         values ($2, 'lan-host', 'quidditch', $1, '{}'::jsonb, '[]'::jsonb)`,
        [SEASON, mid(9999)],
      );
    } catch {
      badGame = 'refused';
    }
    check('lan: ...and a game that does not exist', badGame === 'refused');

    // PRUNE: the cap holds and pruned runs take their replays with them.
    for (let i = 2; i <= repo.LAN_KEEP + 3; i++) {
      await repo.saveLanRun('lan-host', mid(i), container(i, 100 + i), { red: i, blue: 0 }, roster, SEASON, 'decode');
    }
    const capped = await repo.listLanRuns('lan-host', 'decode');
    check('lan: a host keeps only LAN_KEEP matches, newest first', capped.length === repo.LAN_KEEP, `${capped.length} kept`);
    check('lan: the OLDEST went, not the newest', !capped.some((r) => r.matchId === MATCH_A));
    check(
      'lan: a pruned match took its replay with it (no orphaned logs)',
      (await repo.getReplay(one.replayId!)) === null,
    );

    // ...and deleting the host's account takes the rest, keyed on host_user_id
    const live = (await repo.listLanRuns('lan-host', 'decode'))[0];
    await repo.deleteAccount('lan-host');
    check('lan: deleting the HOST account deletes its LAN replays too', (await repo.getReplay(live.replayId!)) === null);
    const rows = await db.query(`select count(*)::int as n from lan_runs where host_user_id = 'lan-host'`);
    check('lan: ...and its matches', (rows.rows[0] as { n: number }).n === 0);
  }

  // ------------------------------------- versus match replay + account deletion ---
  /**
   * A VERSUS match's replay is reachable only through `matches.replay_id`, and
   * `deleteAccount` did not sweep that column — so every match replay an account ever
   * played survived its own deletion, unreachable by both prunes and freed only by a
   * season purge.
   *
   * THE SECOND HALF IS WHAT MAKES THIS CHECK MEAN ANYTHING. The `matches` row must
   * SURVIVE with its `replay_id` nulled: it carries no personal data, and the
   * co-participant reads it in their own Career history and in the moderation
   * drill-down. A "fix" that cascaded the match away — or one that swept it by deleting
   * the match row — would pass a bare "the replay is gone" assertion while quietly
   * destroying somebody else's match history.
   */
  {
    await repo.ensureProfile('vs-a', 'Ana');
    await repo.ensureProfile('vs-b', 'Bo');
    const vsReplay = await repo.saveReplay(
      {
        format: 2,
        balanceVersion: 4,
        sim: 2,
        game: 'decode' as const,
        mode: 'match' as const,
        seed: 42,
        ticks: 1200,
        setups: [] as never[],
        tracks: { 0: [1, 2, 3, 4, 5, 6, 7] },
      },
      SEASON,
      'decode',
    );
    const vsMatch = await repo.saveMatch('1v1', SEASON, vsReplay, false, 'decode');
    for (const [userId, alliance] of [
      ['vs-a', 'red'],
      ['vs-b', 'blue'],
    ] as const) {
      await repo.addMatchParticipant({
        matchId: vsMatch,
        userId,
        alliance,
        drivetrain: 'tank',
        score: 100,
        won: alliance === 'red',
        ratingBefore: null,
        ratingAfter: null,
      });
    }

    await repo.deleteAccount('vs-a');
    check(
      'delete: a VERSUS match replay leaves with the account (matches.replay_id is swept)',
      (await repo.getReplay(vsReplay)) === null,
    );
    const survivor = (
      await db.query<{ replay_id: string | null }>(`select replay_id from matches where id = $1`, [vsMatch])
    ).rows;
    check(
      'delete: ...but the match ROW survives for the other player, replay_id nulled',
      survivor.length === 1 && survivor[0].replay_id === null,
      `rows=${survivor.length} replay_id=${String(survivor[0]?.replay_id)}`,
    );
    const seats = (
      await db.query<{ n: number }>(`select count(*)::int as n from match_participants where match_id = $1`, [vsMatch])
    ).rows[0].n;
    check(
      'delete: the co-participant keeps their seat in the shared history',
      seats === 1,
      `seats=${seats} (vs-a cascaded, vs-b stayed)`,
    );
  }

  // -------------------------------- one-sided versus rooms: kept if custom, swept if ranked ---
  /**
   * `persistMatch` writes the replay BEFORE calling `persistVersusMatch`. A CUSTOM room with
   * one side unauthed (a guest, nobody, bots) now writes its match row too, so its players find
   * it in their history and can watch it. A RANKED one still writes no row, and its replay
   * would be pointed at by NOTHING (invisible to `deleteAccount` and both prunes), so it is
   * swept.
   *
   * The `user_activity` assertion is the ANTI-VACUITY GUARD for the ranked case, and it is not
   * optional. `persistMatch` no-ops outright on four conditions (DB off, unscored game, zero
   * authed participants, a throw into its own catch) and every one of them ALSO leaves the
   * replay count unchanged — so without proof that the function actually RAN, "no new replay"
   * passes for the wrong reason.
   */
  {
    const { persistMatch } = await import('../server/persist');
    const { DEFAULT_SPEC, DEFAULT_ASSISTS } = await import('../src/sim/spawn');
    const replays = async (): Promise<number> =>
      (await db.query<{ n: number }>(`select count(*)::int as n from replays`)).rows[0].n;
    const oneSided = (userId: string, ranked: boolean, bots?: boolean) =>
      persistMatch({
        game: 'decode',
        config: { kind: 'versus' },
        ranked,
        bots,
        result: { score: { red: 90, blue: 40 }, foulPoints: { red: 0, blue: 0 }, hash: 0, ticks: 1200 },
        replay: {
          format: 2,
          balanceVersion: 4,
          sim: 2,
          game: 'decode',
          mode: 'match',
          seed: 77,
          ticks: 1200,
          setups: [],
          tracks: { 0: [1, 2, 3, 4, 5, 6, 7] },
        },
        participants: [
          {
            clientId: 'c1',
            userId,
            handle: 'Only',
            alliance: 'red',
            drivetrain: 'tank',
            score: 90,
            spec: DEFAULT_SPEC,
            assists: DEFAULT_ASSISTS,
          },
        ],
      });

    // ranked: swept
    await repo.ensureProfile('solo-vs', 'Only');
    let before = await replays();
    const ranked = await oneSided('solo-vs', true);
    let after = await replays();
    check(
      'versus/ranked: persistMatch RAN (it credited playtime) but wrote no match row',
      !ranked.matchId && (await repo.getActivity('solo-vs')).total.games === 1,
      `matchId=${String(ranked.matchId)}`,
    );
    check(
      'versus/ranked: ...so a ONE-SIDED ranked room leaves no orphaned replay behind',
      after === before,
      `replays ${before} → ${after}`,
    );

    // custom: kept, listed, watchable by its player and nobody else
    await repo.ensureProfile('solo-custom', 'Only');
    before = await replays();
    const custom = await oneSided('solo-custom', false);
    after = await replays();
    check('versus/custom: a ONE-SIDED custom room writes its match row', !!custom.matchId);
    check('versus/custom: ...and keeps its replay', after === before + 1, `replays ${before} → ${after}`);
    const bv = (
      await db.query<{ balance_version: number }>(`select balance_version from matches where id = $1`, [custom.matchId])
    ).rows[0]?.balance_version;
    const hist = await repo.userMatchHistory('solo-custom', { balanceVersion: bv, game: 'decode', viewerId: 'solo-custom' });
    const row = hist.rows.find((r) => r.id === custom.matchId);
    check('versus/custom: ...it is in the player’s history with a Watch button', !!row?.replayId, JSON.stringify(row));
    check(
      'versus/custom: ...the player may watch it',
      !!row?.replayId && (await repo.replayAccess(row.replayId, 'solo-custom')).access === 'ok',
    );
    check(
      'versus/custom: ...a stranger may not (a short roster never goes public)',
      !!row?.replayId && (await repo.replayAccess(row.replayId, 'rp-nosy-custom')).access === 'private',
    );
    const stats = await repo.getUserStats('solo-custom', bv, 'decode');
    check(
      'versus/custom: ...and its win is NOT on the "Ranked W–L"',
      stats.match.played === 0 && stats.match.wins === 0,
      JSON.stringify(stats.match),
    );

    // a bot room: kept, but no playtime
    await repo.ensureProfile('solo-bots', 'Only');
    const bots = await oneSided('solo-bots', false, true);
    check('versus/bots: a bot room writes its match row', !!bots.matchId);
    check(
      'versus/bots: ...but credits no playtime',
      (await repo.getActivity('solo-bots')).total.games === 0,
      JSON.stringify((await repo.getActivity('solo-bots')).total),
    );
  }

  /* ========================================================================
     THE MISSCORE PATH, END TO END: open the replay, correct the score.
     ========================================================================

     Two halves, and the first one is a bug this suite would have caught the day it shipped.
     `listScoreReports` handed the queue a MATCH id and the WATCH button passed it to
     `/api/replay/<id>`, which serves `replays.id` — so every misscore claim's replay 404'd,
     which is the one thing the queue exists to let a moderator do. The row carries the replay
     now, joined through `matches.replay_id`, and a claim with no match still has to appear.
  */
  {
    await repo.ensureProfile('mis-red', 'Red Driver');
    await repo.ensureProfile('mis-blue', 'Blue Driver');
    await repo.ensureProfile('mis-filer', 'Filer Two');

    const replayId = await repo.saveReplay(
      { format: 2, balanceVersion: SEASON, sim: 3, game: 'decode', mode: 'match', seed: 7, ticks: 10, setups: [], tracks: {} },
      SEASON,
      'decode',
    );
    const mid = await repo.saveMatch('1v1', SEASON, replayId, true, 'decode');
    await repo.addMatchParticipant({
      matchId: mid, userId: 'mis-red', alliance: 'red', drivetrain: 'tank',
      score: 40, won: false, ratingBefore: 1000, ratingAfter: 980,
    });
    await repo.addMatchParticipant({
      matchId: mid, userId: 'mis-blue', alliance: 'blue', drivetrain: 'mecanum',
      score: 55, won: true, ratingBefore: 1000, ratingAfter: 1020,
    });

    await repo.submitScoreReport({ reporterId: 'mis-filer', matchId: mid, roomCode: 'MIS1', detail: 'red scored 48' });
    const q = await repo.listScoreReports({ status: 'open' });
    const row = q.find((r) => r.matchId === String(mid));
    check(
      'misscore: the queue row carries the REPLAY id, not just the match id',
      row?.replayId === String(replayId) && row?.matchId === String(mid),
      `replay=${row?.replayId} match=${row?.matchId}`,
    );
    check(
      'misscore: ...and that id is the one /api/replay actually serves',
      (await repo.getReplay(row!.replayId as string)) !== null,
    );
    // a claim about a result that never finished writing has no match and no replay, and must
    // still reach the queue rather than being joined away
    await repo.submitScoreReport({ reporterId: 'mis-filer', roomCode: 'MIS2', detail: 'the room crashed at the buzzer' });
    const q2 = await repo.listScoreReports({ status: 'open' });
    check(
      'misscore: a claim with no stored match still appears, with a null replay',
      q2.some((r) => r.roomCode === 'MIS2' && r.matchId === null && r.replayId === null),
    );

    // ---- the correction itself -------------------------------------------------
    const detail = await repo.matchScoreDetail(String(mid));
    check(
      'score edit: the editor reads the alliance totals off the participants',
      detail?.red === 40 && detail?.blue === 55 && detail?.participants.length === 2,
      `${detail?.red}-${detail?.blue}`,
    );
    check('score edit: ...and no corrections yet', detail?.corrections.length === 0);

    const done = await repo.correctMatchScore(String(mid), { red: 62, blue: 55 }, 'admin-1', 'two artifacts uncounted');
    check(
      'score edit: the correction reports both sides of the change',
      done?.redBefore === 40 && done?.redAfter === 62 && done?.blueBefore === 55 && done?.blueAfter === 55,
      JSON.stringify(done),
    );
    const after = await repo.matchScoreDetail(String(mid));
    check('score edit: every participant on the alliance carries the new total', after?.red === 62);
    check(
      'score edit: the WIN is re-derived, so the record cannot say someone won a match they lost',
      after?.participants.find((x) => x.userId === 'mis-red')?.won === true &&
        after?.participants.find((x) => x.userId === 'mis-blue')?.won === false,
    );
    // RATINGS DO NOT MOVE. Glicko-2 is sequential; re-rating one match in the middle means
    // re-rating every match since, for everyone in it. The console says so and this pins it.
    check(
      'score edit: the ratings the players left the match with are untouched',
      after?.participants.find((x) => x.userId === 'mis-blue')?.ratingAfter === 1020 &&
        after?.participants.find((x) => x.userId === 'mis-red')?.ratingAfter === 980,
    );
    check(
      'score edit: the change is audited with both scores and the reason',
      after?.corrections.length === 1 &&
        after.corrections[0].redBefore === 40 &&
        after.corrections[0].redAfter === 62 &&
        after.corrections[0].note === 'two artifacts uncounted' &&
        after.corrections[0].adminId === 'admin-1',
      JSON.stringify(after?.corrections[0]),
    );
    // a TIE is `won = false` on both sides, which is what the sim records too
    await repo.correctMatchScore(String(mid), { red: 55, blue: 55 }, 'admin-1');
    const tied = await repo.matchScoreDetail(String(mid));
    check(
      'score edit: a tie leaves nobody marked as the winner',
      tied?.participants.every((x) => x.won === false) === true,
    );
    check('score edit: ...and both corrections are on the record', tied?.corrections.length === 2);
    check(
      'score edit: an id that names no match is refused rather than writing nothing quietly',
      (await repo.correctMatchScore('00000000-0000-0000-0000-000000000000', { red: 1, blue: 1 }, 'admin-1')) === null &&
        (await repo.matchScoreDetail('00000000-0000-0000-0000-000000000000')) === null,
    );
  }

  /* ========================================================================
     STANDING, EDITED BY A MODERATOR — the pardon and what it does to escalation.
     ========================================================================

     The point of voiding rather than deleting is that BOTH things have to be true afterwards:
     the offence stops counting toward the next penalty's rung, and it is still on the record.
     `recentStandingCount` is the function escalation reads, so it is the one that has to
     forget — a pardon that only gave the points back would leave the player's next dodge
     priced as their third.
  */
  {
    await repo.ensureProfile('st-user', 'Penalised');

    const charge = async (kind: string, points: number, cooldownMin = 0): Promise<void> => {
      const before = (await repo.getStanding('st-user')).score;
      await repo.writeStandingEvent('st-user', {
        kind: kind as never,
        points,
        scoreBefore: before,
        scoreAfter: Math.max(0, before - points),
        tierBefore: 'good',
        tierAfter: 'good',
        rung: 0,
        cooldownMin,
        restrictedUntil: cooldownMin ? Date.now() + cooldownMin * 60_000 : null,
        ratingCharge: 0,
        nextCooldownMin: 0,
      });
    };
    await charge('dodge', 5);
    await charge('dodge', 8);
    await charge('leave', 8, 30);

    check(
      'standing: the ledger counts what the server saw',
      (await repo.recentStandingCount('st-user', 'dodge', 24)) === 2,
    );
    const locked = await repo.getStanding('st-user');
    check('standing: ...and the walk-out locked the queue', locked.restrictedUntil !== null);

    // ONE OFFENCE pardoned: the points are a separate decision, so the score is untouched
    const events = await repo.listStandingEvents('st-user', 20);
    const oneDodge = events.find((e) => e.kind === 'dodge');
    const one = await repo.adminEditStanding('st-user', 'admin-1', { pardonIds: [oneDodge!.id] });
    check('standing: pardoning one offence voids exactly one row', one.pardoned === 1);
    check(
      'standing: ...and escalation immediately stops counting it',
      (await repo.recentStandingCount('st-user', 'dodge', 24)) === 1,
    );
    const stillThere = await repo.listStandingEvents('st-user', 20);
    check(
      'standing: ...while the row itself stays on the record, marked',
      stillThere.some((e) => e.id === oneDodge!.id && !!e.voidedAt),
    );
    check(
      'standing: the edit writes ONE adjustment row, so the player sees why the number moved',
      stillThere.filter((e) => e.kind === 'adjustment').length === 1,
    );

    // CLEAR EVERYTHING — the one-press pardon the console leads with
    const cleared = await repo.adminEditStanding('st-user', 'admin-1', {
      pardonAll: true,
      score: 100,
      lock: false,
      note: 'room crashed, not their fault',
    });
    check(
      'standing: clearing voids every offence still counting',
      cleared.pardoned === 3,
      `${cleared.pardoned}`,
    );
    const open = await repo.getStanding('st-user');
    check('standing: ...puts the score back', open.score === 100, `${open.score}`);
    check('standing: ...and lifts the ranked lock', open.restrictedUntil === null);
    check(
      'standing: ...and nothing escalates any more',
      (await repo.recentStandingCount('st-user', 'dodge', 24)) === 0 &&
        (await repo.recentStandingCount('st-user', 'leave', 168)) === 0,
    );
    const ledger = await repo.listStandingEvents('st-user', 20);
    const credit = ledger.find((e) => e.kind === 'adjustment' && e.points < 0);
    check(
      'standing: a restoration is a NEGATIVE cost, which is how the player is shown a credit',
      credit !== undefined && credit.points < 0,
      `${credit?.points}`,
    );
    check(
      'standing: the moderator\'s reason comes back on the row the player reads',
      ledger.some((e) => e.kind === 'adjustment' && e.note === 'room crashed, not their fault'),
      JSON.stringify(ledger.find((e) => e.kind === 'adjustment' && e.points < 0)),
    );

    // AN UNRELATED EDIT MUST NOT UNLOCK THE QUEUE. `lock` is three-valued on purpose: absent
    // leaves a cooldown somebody is legitimately serving exactly where it is.
    await charge('leave', 8, 30);
    const relocked = await repo.getStanding('st-user');
    check('standing: a fresh walk-out locks the queue again', relocked.restrictedUntil !== null);
    await repo.adminEditStanding('st-user', 'admin-1', { score: 90 });
    const after = await repo.getStanding('st-user');
    check(
      'standing: setting the SCORE alone leaves the lock alone',
      after.restrictedUntil !== null && after.score === 90,
      `score=${after.score} lock=${after.restrictedUntil}`,
    );
    check(
      'standing: ...and setting a score is not a pardon — the offence still escalates',
      (await repo.recentStandingCount('st-user', 'leave', 168)) === 1,
    );
    // an account with no standing row at all is still editable — a moderator can be looking at
    // somebody who has simply never offended
    await repo.ensureProfile('st-clean', 'Spotless');
    const fresh = await repo.adminEditStanding('st-clean', 'admin-1', { score: 100, pardonAll: true });
    check(
      'standing: an account with no row yet is created rather than failing',
      fresh.scoreAfter === 100 && fresh.pardoned === 0,
    );
  }

  /* ---- standing HEALING, and the read-only fast path in front of it ---------------------
     `getStanding` was a write transaction on a read path — `BEGIN`, an ensure-row INSERT, a
     healing UPDATE, a SELECT, `COMMIT` — and it is called by `GET /api/standing` and by
     `rankedLock` on every ranked queue attempt. A fast path now answers from one SELECT when
     the UPDATE would have changed nothing.

     That is only safe if healing still happens when it IS due, and healing had NO coverage at
     all, so the fast path would have been an untested behaviour change to the one case that
     matters. Both sides are pinned here. */
  {
    await repo.ensureProfile('heal-me', 'HealMe');
    // an account that has lost standing and last healed two days ago
    await repo.getStanding('heal-me'); // creates the row
    await db.query(
      `update account_standing set score = 80, healed_at = now() - interval '2 days' where user_id = 'heal-me'`,
    );
    const healed = await repo.getStanding('heal-me');
    check(
      'standing/heal: a heal that is DUE still happens through the fast path check',
      healed.score > 80,
      `80 -> ${healed.score}`,
    );

    // ...and the clock advanced with it, so asking again does not heal a second time
    const twice = await repo.getStanding('heal-me');
    check('standing/heal: ...and asking again does not heal twice', twice.score === healed.score);

    // a full-score account is the FAST path: the UPDATE would be a no-op, so the answer must
    // match and nothing must move
    await repo.ensureProfile('heal-full', 'HealFull');
    await repo.getStanding('heal-full');
    const beforeAt = (await db.query<{ healed_at: string }>(
      `select healed_at from account_standing where user_id = 'heal-full'`,
    )).rows[0].healed_at;
    const full = await repo.getStanding('heal-full');
    const afterAt = (await db.query<{ healed_at: string }>(
      `select healed_at from account_standing where user_id = 'heal-full'`,
    )).rows[0].healed_at;
    check('standing/heal: a full-score account reads clean and is not touched',
      full.score === 100 && String(beforeAt) === String(afterAt));

    // a row that does not exist yet must still be created — that is the other case the
    // transaction is for, and the fast path has to fall through to it
    await repo.ensureProfile('heal-never-seen', 'NeverSeen');
    const fresh = await repo.getStanding('heal-never-seen');
    check('standing/heal: an account with no row is still created by the slow path',
      fresh.score === 100);
    const exists = await db.query<{ n: string }>(
      `select count(*) as n from account_standing where user_id = 'heal-never-seen'`,
    );
    check('standing/heal: ...and the row is really there afterwards', Number(exists.rows[0].n) === 1);
  }

  /* ---- the batched writes on the ranked match-end path ----------------------------------
     `persistVersusMatch` used to issue 16 sequential round trips for a 2v2: a rating read per
     player, two writes per update, and an insert per participant. The reads and the inserts
     are now batched. Both new functions are the kind that fail at RUNTIME rather than at
     typecheck — an `unnest` with a wrong column cast, or a default that silently differs from
     the per-row version — and they sit on the path a player is watching for their rating, so
     they are exercised against the real schema here. */
  {
    const mid = await repo.saveMatch('2v2', SEASON, null as unknown as string, true, 'decode');
    for (const id of ['batch-a', 'batch-b', 'batch-c', 'batch-d']) await repo.ensureProfile(id, id);
    await repo.addMatchParticipants(mid, [
      { userId: 'batch-a', alliance: 'red', drivetrain: 'tank', score: 90, won: true, ratingBefore: 1000, ratingAfter: 1012 },
      { userId: 'batch-b', alliance: 'red', drivetrain: 'mecanum', score: 90, won: true, ratingBefore: 980, ratingAfter: 991 },
      // an UNRANKED participant carries nulls — the array cast has to survive them
      { userId: 'batch-c', alliance: 'blue', drivetrain: 'swerve', score: 40, won: false, ratingBefore: null, ratingAfter: null },
      { userId: 'batch-d', alliance: 'blue', drivetrain: 'xdrive', score: 40, won: false, ratingBefore: 1100, ratingAfter: 1088 },
    ]);
    const rows = await db.query<{ n: string }>(`select count(*) as n from match_participants where match_id = $1`, [mid]);
    check('batch: addMatchParticipants writes every row in one insert', Number(rows.rows[0].n) === 4, `${rows.rows[0].n} rows`);

    const one = await db.query<{ drivetrain: string; score: number; won: boolean; rating_after: number | null }>(
      `select drivetrain, score, won, rating_after from match_participants where match_id = $1 and user_id = 'batch-c'`,
      [mid],
    );
    const c = one.rows[0];
    check(
      'batch: ...with each column landing on the right row, nulls included',
      c.drivetrain === 'swerve' && Number(c.score) === 40 && c.won === false && c.rating_after === null,
      JSON.stringify(c),
    );

    // the per-row version is `on conflict do nothing`; the batch must be too, or a retried
    // persist after a partial failure would throw instead of being a no-op
    await repo.addMatchParticipants(mid, [
      { userId: 'batch-a', alliance: 'red', drivetrain: 'tank', score: 999, won: false, ratingBefore: 1, ratingAfter: 2 },
    ]);
    const again = await db.query<{ score: number }>(
      `select score from match_participants where match_id = $1 and user_id = 'batch-a'`, [mid],
    );
    check('batch: ...and a repeat is a no-op, not a throw or an overwrite', Number(again.rows[0].score) === 90);

    check('batch: an empty participant list writes nothing and does not throw',
      await repo.addMatchParticipants(mid, []).then(() => true).catch(() => false));

    // getRatingsFull must agree with getRatingFull for a player WITH a row and for one
    // without — a default that drifted between them would silently re-place a rated player
    await repo.upsertRating('batch-a', '2v2', 1, 1234, 40, 0.05, 'decode');
    const many = await repo.getRatingsFull(['batch-a', 'batch-nobody'], '2v2', 1, 'decode');
    const single = await repo.getRatingFull('batch-a', '2v2', 1, 'decode');
    const singleMissing = await repo.getRatingFull('batch-nobody', '2v2', 1, 'decode');
    check('batch: getRatingsFull matches getRatingFull for a rated player',
      many.get('batch-a')?.rating === single.rating && many.get('batch-a')?.rd === single.rd);
    check('batch: ...and uses the SAME defaults for a player with no row',
      many.get('batch-nobody')?.rating === singleMissing.rating && many.get('batch-nobody')?.rd === singleMissing.rd,
      `${many.get('batch-nobody')?.rating} vs ${singleMissing.rating}`);
  }

  /* ---- the homepage stats memo ---------------------------------------------------------
     `/api/stats` is public and unauthenticated, and `getGlobalStats` is three unbounded
     aggregates — so the memo is the only thing standing between a homepage and one full scan
     of `profiles`, `records` and `matches` per visitor. Both halves are asserted: that it
     actually serves a second call from cache, and that it is not a permanent cache. */
  {
    await repo.ensureProfile('stats-a', 'StatsA');
    const t0 = 1_000_000;
    const first = await repo.getGlobalStats(t0);
    const usersAtFirst = first.users;

    // a new account inside the TTL must NOT change the answer — that IS the cache working
    await repo.ensureProfile('stats-b', 'StatsB');
    const cached = await repo.getGlobalStats(t0 + 30_000);
    check('stats: a second call inside the TTL is served from the memo', cached.users === usersAtFirst);

    // ...and the memo is a memo, not a freeze: past the TTL the new account appears
    const later = await repo.getGlobalStats(t0 + 120_000);
    check('stats: past the TTL it re-queries, so the memo cannot go permanently stale', later.users === usersAtFirst + 1, `${usersAtFirst} then ${later.users}`);

    // and an explicit drop is honoured, which is what an admin wanting the real number uses
    await repo.ensureProfile('stats-c', 'StatsC');
    repo.clearStatsCache();
    const cleared = await repo.getGlobalStats(t0 + 120_000);
    check('stats: clearStatsCache drops it regardless of the clock', cleared.users === usersAtFirst + 2);
  }

  /* ---- games played, counted at the source (0050) -------------------------------------------
     The homepage reads `play_counts`, not `records`/`matches`, so a match that never writes a
     row (anonymous, Discord, practice, LAN) still counts. Three things to pin: the migration's
     backfill agrees with the tables it reads, the fold into the homepage's categories, and that
     `persistMatch` counts a room nobody signed in to. */
  {
    const n = async (sql: string): Promise<number> =>
      Number((await db.query<{ n: string | number | null }>(sql)).rows[0]?.n ?? 0);
    const counted = (where: string): Promise<number> =>
      n(`select coalesce(sum(n), 0) as n from play_counts where ${where}`);

    // the BACKFILL, re-run against a database that now has rows in every source table
    const mig = readFileSync(join(ROOT, 'server/db/migrations/0050_play_counts.sql'), 'utf8');
    const backfill = mig.slice(mig.indexOf('insert into play_counts'), mig.indexOf('comment on table'));
    await db.query(`delete from play_counts`);
    await db.query(backfill);
    const recs = await n(`select count(*) as n from records`);
    const ranked = await n(`select count(*) as n from matches where ranked`);
    const custom = await n(`select count(*) as n from matches where not ranked`);
    const practice = await n(`select count(*) as n from practice_runs`);
    const lan = await n(`select count(*) as n from lan_runs`);
    check('plays: the test has history to backfill from', recs > 0 && ranked + custom > 0, `records=${recs} matches=${ranked + custom}`);
    check('plays: backfill — record runs', (await counted(`source = 'record'`)) === recs);
    check('plays: backfill — ranked matches', (await counted(`source = 'ranked'`)) === ranked);
    check('plays: backfill — custom rooms', (await counted(`source = 'custom'`)) === custom);
    check('plays: backfill — practice runs', (await counted(`source = 'practice'`)) === practice);
    check('plays: backfill — LAN matches', (await counted(`source = 'lan'`)) === lan);

    // the FOLD: one of every source, on a game nothing else here touches
    repo.clearStatsCache();
    const before = await repo.getGlobalStats();
    const plays: [repo.PlaySource, repo.PlayMode][] = [
      ['record', 'solo'],
      ['practice', 'solo'],
      ['record', 'duo'],
      ['ranked', '1v1'],
      ['ranked', '2v2'],
      ['custom', '1v1'],
      ['discord', '2v2'],
      ['lan', '1v1'],
    ];
    for (const [src, mode] of plays) await repo.countPlay('chain', src, mode);
    await repo.countPlay('chain', 'practice', 'solo');
    repo.clearStatsCache();
    const after = await repo.getGlobalStats();
    const d = (k: keyof repo.GlobalStats['byCategory']): number => after.byCategory[k] - before.byCategory[k];
    check('plays: solo = record solo + practice', d('solo') === 3, `+${d('solo')}`);
    check('plays: duo = record duo', d('duo') === 1, `+${d('duo')}`);
    check('plays: 1v1 / 2v2 = ranked only', d('1v1') === 1 && d('2v2') === 1, `+${d('1v1')} / +${d('2v2')}`);
    check('plays: custom = custom + Discord + LAN', d('custom') === 3, `+${d('custom')}`);
    check('plays: the headline sums every source', after.games - before.games === 9, `+${after.games - before.games}`);
    check('plays: ...and per game', after.byGame.chain - before.byGame.chain === 9);
    check(
      'plays: the raw split keeps each source apart',
      after.detail.some((r) => r.game === 'chain' && r.source === 'discord' && r.mode === '2v2' && r.n >= 1) &&
        after.detail.some((r) => r.game === 'chain' && r.source === 'practice' && r.n >= 2),
    );
    check(
      'plays: a repeat increments one row per day, it does not add one',
      (await n(`select count(*) as n from play_counts where game = 'chain' and source = 'practice'`)) === 1,
    );

    // persistMatch: classification, and an ANONYMOUS room still counts
    const { persistMatch, playSourceOf } = await import('../server/persist');
    const { DEFAULT_SPEC, DEFAULT_ASSISTS } = await import('../src/sim/spawn');
    const part = (alliance: 'red' | 'blue', userId?: string) => ({
      clientId: 'c',
      userId,
      handle: 'P',
      alliance,
      drivetrain: 'tank',
      score: 0,
      spec: DEFAULT_SPEC,
      assists: DEFAULT_ASSISTS,
    });
    const outcome = (over: Partial<Parameters<typeof persistMatch>[0]>): Parameters<typeof persistMatch>[0] => ({
      game: 'decode',
      config: { kind: 'versus' },
      ranked: false,
      result: { score: { red: 0, blue: 0 }, foulPoints: { red: 0, blue: 0 }, hash: 0, ticks: 60 },
      replay: { format: 2, balanceVersion: 4, sim: 2, game: 'decode', mode: 'match', seed: 1, ticks: 60, setups: [], tracks: {} },
      participants: [part('red'), part('blue')],
      ...over,
    });
    const src = (o: Parameters<typeof persistMatch>[0]): string => playSourceOf(o).join('/');
    check('plays: a record duo room is record/duo', src(outcome({ config: { kind: 'record', record: 'duo' } })) === 'record/duo');
    check('plays: a ranked room is ranked/<its mode>', src(outcome({ ranked: true, mode: '2v2' })) === 'ranked/2v2');
    check('plays: a Discord room is discord, not custom', src(outcome({ discord: true })) === 'discord/1v1');
    check('plays: a code room is custom', src(outcome({})) === 'custom/1v1');
    const beforeAnon = await counted(`game = 'decode' and source = 'discord'`);
    await persistMatch(outcome({ discord: true }));
    let afterAnon = beforeAnon;
    for (let i = 0; i < 50 && afterAnon === beforeAnon; i++) {
      await new Promise((r) => setTimeout(r, 10));
      afterAnon = await counted(`game = 'decode' and source = 'discord'`);
    }
    check('plays: a room with NO signed-in player is still counted', afterAnon === beforeAnon + 1, `${beforeAnon} → ${afterAnon}`);
  }

  /* ---- SCHEMA HYGIENE, asked of the live schema rather than of the migration files -------
     Two invariants that fail SILENTLY — nothing errors, nothing returns a wrong answer, the
     database just does progressively more work as the tables grow — so neither shows up in any
     other check here. Both are asked of `pg_index`/`pg_constraint` AFTER every migration has
     run, so a later migration that reintroduces the problem is caught by the same assertion.  */
  {
    /* EVERY FOREIGN KEY NEEDS AN INDEX ON ITS REFERENCING COLUMNS. Without one, each delete of
       a parent row scans the whole child table to apply ON DELETE. This is what migration 0037
       fixed on `records.replay_id`, `matches.replay_id`, `records.partner_id` and
       `kofi_payments.claimed_by` — all four unindexed since 0001, and the replay prunes that
       walk them run on every practice and LAN upload. The RULE is stated here rather than the
       four columns, so the next unindexed foreign key is caught by the migration that adds it. */
    const unindexed = await db.query<{ tbl: string; col: string }>(`
      select c.conrelid::regclass::text as tbl,
             (select string_agg(a.attname, ',' order by k.ord)
                from unnest(c.conkey) with ordinality as k(attnum, ord)
                join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as col
        from pg_constraint c
       where c.contype = 'f'
         and not exists (
           select 1 from pg_index i
            where i.indrelid = c.conrelid
              and (i.indkey::int2[])[0:array_length(c.conkey,1)-1] = c.conkey
         )
       order by 1, 2`);
    check(
      'schema: every foreign key has an index leading with its own columns',
      unindexed.rows.length === 0,
      unindexed.rows.map((r) => `${r.tbl}(${r.col})`).join(' | ') || 'none',
    );

    /* NO INDEX IS A STRICT PREFIX OF ANOTHER ON THE SAME TABLE. Such an index can never be
       chosen — the longer one serves everything it could — and it costs a write on every insert
       and update. 0037 dropped the two that existed (`user_activity(user_id)`, already the PK's
       leading column; `friend_requests(from_user_id)`, already the unique constraint's).
       Redundancy is easy to add back by hand and impossible to notice. */
    const redundant = await db.query<{ tbl: string; dup: string; covered_by: string }>(`
      with ix as (
        select i.indrelid::regclass::text as tbl, i.indexrelid::regclass::text as name,
               i.indkey::int2[] as cols, i.indisunique as uniq, i.indpred is not null as partial
          from pg_index i
          join pg_class c on c.oid = i.indrelid
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
      )
      select a.tbl, a.name as dup, b.name as covered_by
        from ix a join ix b
          on a.tbl = b.tbl and a.name <> b.name
         and array_length(b.cols,1) > array_length(a.cols,1)
         and b.cols[0:array_length(a.cols,1)-1] = a.cols
       -- a UNIQUE or PARTIAL index is not redundant even as a prefix: it carries a constraint,
       -- or covers a different subset of rows, that the longer one does not.
       where not a.uniq and not a.partial
       order by 1, 2`);
    check(
      'schema: no index is a dead prefix of another on the same table',
      redundant.rows.length === 0,
      redundant.rows.map((r) => `${r.dup} < ${r.covered_by}`).join(' | ') || 'none',
    );
  }

  /* ---- TERMS ACCEPTANCE (migration 0040) -----------------------------------
     Two nullable columns and one write, and the part worth testing is the NULLS: a profile
     that predates the migration must read "never accepted" rather than being silently
     back-filled with whatever revision is current, because that is the difference between
     a consent record and a fabricated one. The version is the SERVER’S constant at every
     call site, so the round trip here is also what proves `acceptTerms` writes what it was
     given and a timestamp Postgres produced.
  */
  {
    /** timestamptz comes back from the driver as a Date (the same shape`supporter_until`
     *  already has here) and JSON-serializes to an ISO string on the wire. Compare the
     *  INSTANT, never the object. */
    const ms = (v: string | null): number => (v ? new Date(v).getTime() : 0);
    const cols0040 = (
      await db.query<{ column_name: string; is_nullable: string }>(
        `select column_name, is_nullable from information_schema.columns
           where table_name = 'profiles' and column_name like 'terms%'`,
      )
    ).rows;
    const col = (n: string) => cols0040.find((c) => c.column_name === n);
    check(
      'terms: 0040 added profiles.terms_version and terms_accepted_at',
      !!col('terms_version') && !!col('terms_accepted_at'),
      cols0040.map((c) => c.column_name).join(', ') || 'neither',
    );
    check(
      'terms: both are NULLABLE, so "never asked" is representable',
      col('terms_version')?.is_nullable === 'YES' && col('terms_accepted_at')?.is_nullable === 'YES',
    );

    // A PROFILE THAT NEVER ACCEPTED reads null on both — no default, no backfill. This is
    // every account that exists today and every OAuth sign-up, and it is what turns into a
    // dialog client-side (`termsGateState(null) === 'never'`).
    await repo.ensureProfile('terms-a', 'TermsA');
    const fresh = await repo.getTermsAcceptance('terms-a');
    check(
      'terms: a profile created without accepting reads null, not the current version',
      fresh.version === null && fresh.acceptedAt === null,
      JSON.stringify(fresh),
    );
    check(
      'terms: and so does an account with no profile row at all',
      (await repo.getTermsAcceptance('terms-nobody')).version === null,
    );

    // ACCEPT, THEN READ IT BACK.
    const v1 = '2026-08-04';
    const wrote = await repo.acceptTerms('terms-a', v1);
    check(
      'terms: accepting returns the version it wrote',
      wrote.version === v1,
      wrote.version ?? 'null',
    );
    check(
      'terms: ...with a timestamp Postgres produced, not a client clock',
      !!wrote.acceptedAt && Math.abs(Date.now() - new Date(wrote.acceptedAt).getTime()) < 60_000,
      wrote.acceptedAt ?? 'null',
    );
    const readBack = await repo.getTermsAcceptance('terms-a');
    check(
      'terms: a separate read sees the same row',
      readBack.version === v1 && ms(readBack.acceptedAt) === ms(wrote.acceptedAt),
      JSON.stringify(readBack),
    );

    // A LATER REVISION OVERWRITES, and moves the instant with it — the gate compares one
    // value, so a stale version left behind beside a new one would be the bug.
    const v2 = '2027-01-01';
    const again = await repo.acceptTerms('terms-a', v2);
    check(
      'terms: a new revision overwrites the old one rather than accumulating',
      again.version === v2 &&
        (await repo.getTermsAcceptance('terms-a')).version === v2,
    );
    check(
      'terms: the recorded instant moved with it',
      !!again.acceptedAt && !!wrote.acceptedAt && ms(again.acceptedAt) >= ms(wrote.acceptedAt),
    );

    // ACCEPTING FOR AN ACCOUNT WITH NO PROFILE WRITES NOTHING. The route calls
    // `ensureProfile` first for exactly this reason; the repo function must not invent a
    // row, or an unauthenticated id could seed `profiles` one UPDATE at a time.
    const ghost = await repo.acceptTerms('terms-ghost', v1);
    check(
      'terms: accepting for a non-existent profile records nothing',
      ghost.version === null &&
        (
          await db.query<{ n: string }>(
            `select count(*)::text as n from profiles where user_id = 'terms-ghost'`,
          )
        ).rows[0].n === '0',
    );

    // ⚠️ AND NOTHING ELSE ON THE ROW MOVED. `acceptTerms` writes `updated_at` too, so the
    // check that matters is that it did not touch the one column on this table that costs
    // money to get wrong.
    await repo.grantSupporter('terms-a', 1, 'admin', 'dbtest: terms block');
    const untilBefore = (await repo.getSupporter('terms-a')).supporterUntil;
    await repo.acceptTerms('terms-a', v1);
    check(
      'terms: accepting does not disturb the supporter expiry on the same row',
      ms((await repo.getSupporter('terms-a')).supporterUntil) === ms(untilBefore),
    );
  }

  /* ---- DATA EXPORT (GET /api/user/export) -----------------------------------
     The other half of the promise `deleteAccount` keeps, and the half with a way of going
     quietly wrong that deletion does not have: an export can be COMPLETE and still be a
     privacy failure, if what it completes with is somebody else's row. So the checks come in
     two halves — everything of mine is in there, and nothing of theirs is, asserted against
     the SERIALIZED document rather than field by field, because the leak this guards against
     is a join nobody remembered adding.
  */
  {
    const SEA = 1041;
    await repo.ensureSeason(SEA, 'decode', 9);
    await repo.ensureProfile('exp-me', 'Exporter');
    await repo.ensureProfile('exp-other', 'Bystander');
    await repo.setUsername('exp-me', 'exporter');
    await repo.setUsername('exp-other', 'bystander');

    const container = (seed: number) => ({
      format: 2,
      balanceVersion: SEA,
      sim: 3,
      game: 'decode' as const,
      mode: 'match' as const,
      seed,
      ticks: 600,
      setups: [] as never[],
      tracks: { 0: [1, 2, 3] },
    });

    await repo.saveUserSettings('exp-me', { drivetrain: 'swerve', dsimExportProbe: true });
    await repo.savePreset('exp-me', 1, 'Comp bot', { drivetrain: 'swerve' } as never);
    await repo.acceptTerms('exp-me', '2026-08-04');
    await repo.setReplaysPublic('exp-me', true);

    const recReplay = await repo.saveReplay(container(1), SEA, 'decode');
    await repo.submitRecord({
      userId: 'exp-me', mode: 'solo', drivetrain: 'swerve', score: 321,
      balanceVersion: SEA, replayId: recReplay, game: 'decode',
    });
    // ...and one belonging to the OTHER account, with a score nothing of mine shares
    const otherReplay = await repo.saveReplay(container(2), SEA, 'decode');
    await repo.submitRecord({
      userId: 'exp-other', mode: 'solo', drivetrain: 'tank', score: 777,
      balanceVersion: SEA, replayId: otherReplay, game: 'decode',
    });

    const prac = await repo.savePracticeRun('exp-me', container(3), 45, SEA, 'decode');

    // A MATCH WITH BOTH OF THEM IN IT — the shape the "no other players" rule exists for.
    const mid = await repo.saveMatch('1v1', SEA, null as unknown as string, true, 'decode');
    await repo.addMatchParticipant({
      matchId: mid, userId: 'exp-me', alliance: 'red', drivetrain: 'swerve',
      score: 88, won: true, ratingBefore: 1000, ratingAfter: 1016,
    });
    await repo.addMatchParticipant({
      matchId: mid, userId: 'exp-other', alliance: 'blue', drivetrain: 'tank',
      score: 41, won: false, ratingBefore: 1000, ratingAfter: 984,
    });

    // social: a friendship and a block, both of which MUST name the other party
    await repo.sendFriendRequest('exp-me', 'exp-other');
    await repo.acceptFriendRequest('exp-other', 'exp-me');
    await repo.ensureProfile('exp-blocked', 'Blocked');
    await repo.setUsername('exp-blocked', 'blockedone');
    await repo.blockUser('exp-me', 'exp-blocked');

    // a claimed payment, so the email-omission check has something to omit
    await repo.recordKofiPayment({
      messageId: 'exp-msg', kind: 'Subscription', email: 'exporter-payer@example.com',
      transactionId: 'exp-txn', amount: '3.00', currency: 'USD',
      isSubscription: true, tierName: 'Supporter', months: 1,
    });
    await repo.claimKofiPayment('exp-me', 'exp-txn');

    const ex = await repo.exportAccount('exp-me');
    check('export: an account with data exports something', !!ex);
    if (!ex) throw new Error('export: exportAccount returned null for a live account');
    const doc = JSON.stringify(ex);

    check(
      'export: it is versioned and stamped, so a file read years later is readable',
      ex.format === 1 && !!Date.parse(ex.exportedAt),
      `format=${ex.format} at=${ex.exportedAt}`,
    );
    check(
      'export: the profile fields are the ones the app shows you',
      ex.account.handle === 'Exporter' &&
        ex.account.username === 'exporter' &&
        ex.account.replaysPublic === true &&
        ex.account.termsVersion === '2026-08-04',
      JSON.stringify(ex.account),
    );
    check(
      'export: the synced settings blob comes back whole',
      !!ex.settings && (ex.settings as { dsimExportProbe?: boolean }).dsimExportProbe === true,
    );
    check('export: saved robot presets are included', ex.robotPresets.length === 1);
    check(
      'export: records are included, with the replay id behind each score',
      ex.records.length === 1 &&
        ex.records[0].score === 321 &&
        ex.records[0].replay_id === recReplay,
      `${ex.records.length} records`,
    );
    check(
      'export: practice runs are included',
      ex.practiceRuns.length === 1 && ex.practiceRuns[0].id === prac.id,
    );
    check(
      'export: ranked rating and its per-season history are included',
      Array.isArray(ex.ranked.ratings) && Array.isArray(ex.ranked.history),
    );
    check(
      'export: playtime and standing are included',
      Array.isArray(ex.playtime) && 'standing' in ex,
    );

    // REPLAYS BY ID AND KIND — not bodies. The union is the one `deleteAccount` deletes by,
    // so a replay that would be destroyed with the account must be listed with it.
    check(
      'export: every replay the account owns is listed by id and what it belongs to',
      ex.replays.some((r) => r.id === recReplay && r.kind === 'record') &&
        ex.replays.some((r) => r.id === prac.replayId && r.kind === 'practice'),
      JSON.stringify(ex.replays),
    );
    check(
      '⚠️ export: replay BODIES are not in it (seeds, tracks and setups stay out)',
      !doc.includes('"tracks"') && !doc.includes('"setups"'),
    );

    // MY OWN MATCH ROW, and nothing about who I played.
    check(
      'export: the match carries MY result and the match’s own facts',
      ex.matches.length === 1 &&
        ex.matches[0].match_id === mid &&
        ex.matches[0].alliance === 'red' &&
        ex.matches[0].score === 88 &&
        ex.matches[0].rating_after === 1016,
      JSON.stringify(ex.matches),
    );

    /**
     * ⚠️ THE OPPONENT IS NOWHERE IN THE FILE.
     *
     * Asserted against the serialized document and not against a field, because the leak this
     * guards against is a join somebody adds later for a good reason — "it would be nice to
     * see who I played" — and no per-field check would notice it. `exp-other` IS a friend, so
     * their public handle and username are legitimately in the friends section; what must not
     * appear is their USER ID, which is the thing that links rows across every table here, and
     * their score and rating, which are their match row rather than mine.
     */
    check(
      '⚠️ export: another player’s user id never appears, anywhere in the document',
      !doc.includes('exp-other'),
      doc.slice(Math.max(0, doc.indexOf('exp-other') - 60), doc.indexOf('exp-other') + 60),
    );
    check(
      '⚠️ export: and neither does their half of the match (their score, their rating move)',
      !ex.matches.some((m) => m.score === 41 || m.rating_after === 984),
    );
    check(
      '⚠️ export: another account’s RECORDS never appear (777 is theirs alone)',
      !ex.records.some((r) => r.score === 777) && !doc.includes(otherReplay),
    );

    // NAMES ONLY WHERE THE APP ALREADY SHOWS THEM. A friends list without names is not a
    // portable friends list, and both fields are public on every leaderboard already.
    check(
      'export: the friends list names the other party by handle and username',
      ex.friends.friends.length === 1 &&
        ex.friends.friends[0].handle === 'Bystander' &&
        ex.friends.friends[0].username === 'bystander',
      JSON.stringify(ex.friends.friends),
    );
    check(
      'export: blocks are included and name who is blocked',
      ex.friends.blocked.length === 1 && ex.friends.blocked[0].username === 'blockedone',
    );
    check(
      'export: the four request/invite buckets all exist, even when empty',
      Array.isArray(ex.friends.requestsSent) &&
        Array.isArray(ex.friends.requestsReceived) &&
        Array.isArray(ex.friends.invitesSent) &&
        Array.isArray(ex.friends.invitesReceived),
    );

    // PAYMENTS WITHOUT THE PAYER ADDRESS. The row survives account deletion with the email
    // nulled, so a route that reads the column at all is one refactor from reading it for the
    // wrong `claimed_by`; the address is on the caller's own Ko-fi receipt instead.
    check(
      'export: the payment behind a membership is included',
      ex.payments.length === 1 && ex.payments[0].transaction_id === 'exp-txn',
      JSON.stringify(ex.payments),
    );
    check(
      '⚠️ export: no email address is in the document, not even the payer’s own',
      !doc.includes('exporter-payer@example.com') && !doc.includes('"email"'),
    );
    check(
      'export: the file states what it deliberately leaves out',
      ex.notes.length >= 3 && ex.notes.some((n) => /other players/i.test(n)),
    );

    // ...AND AFTER DELETION THERE IS NOTHING TO EXPORT. The token outlives the row, so this is
    // the answer a live session gets seconds after pressing delete — a 404 at the route, which
    // is the honest reading of null, rather than an empty document that says "we hold nothing"
    // as though that had been checked.
    check(
      'export: an account that never existed exports null (the route’s 404)',
      (await repo.exportAccount('exp-nobody')) === null,
    );
    await repo.deleteAccount('exp-me');
    check(
      '⚠️ export: a DELETED account exports null, not an empty document',
      (await repo.exportAccount('exp-me')) === null,
    );
    check(
      'export: ...and the other account is still exportable (deletion took only mine)',
      !!(await repo.exportAccount('exp-other')),
    );
  }

  /* ---- REPLAY PRIVACY (migration 0038) -------------------------------------
     Match replays are private by default: watchable by everyone who PLAYED in the match, and
     by nobody else unless every one of them opts in. Every assertion below was written to
     FAIL on the code before the migration, where `/api/replay/<id>` served any row to
     anyone — so this block is also the regression test for the default itself, which is the
     part a later refactor can silently flip.
  */
  {
    const SEA = 1037;
    await repo.ensureSeason(SEA, 'decode', 7);
    for (const [id, name] of [
      ['rp-red', 'Red'], ['rp-red2', 'Red Two'],
      ['rp-blue', 'Blue'], ['rp-blue2', 'Blue Two'],
      ['rp-nosy', 'Nosy'], ['rp-mod', 'Mod'], ['rp-host', 'Host'],
    ] as [string, string][]) {
      await repo.ensureProfile(id, name);
    }
    await repo.syncStaffRoles('rp-mod', ['rp-mod']);

    /** `replayAccess` reports the refusal KIND alongside the verdict; most checks only care
     * about the verdict, so this keeps them readable. */
    const acc = async (id: string, viewer: string | null): Promise<string> =>
      (await repo.replayAccess(id, viewer)).access;

    const mkReplay = (seed: number): Promise<string> =>
      repo.saveReplay(
        { format: 2, balanceVersion: SEA, sim: 3, game: 'decode', mode: 'match', seed, ticks: 10, setups: [], tracks: {} },
        SEA,
        'decode',
      );

    const vsReplay = await mkReplay(1);
    const mid = await repo.saveMatch('1v1', SEA, vsReplay, true, 'decode');
    await repo.addMatchParticipant({
      matchId: mid, userId: 'rp-red', alliance: 'red', drivetrain: 'tank',
      score: 40, won: false, ratingBefore: 1000, ratingAfter: 980,
    });
    await repo.addMatchParticipant({
      matchId: mid, userId: 'rp-blue', alliance: 'blue', drivetrain: 'mecanum',
      score: 55, won: true, ratingBefore: 1000, ratingAfter: 1020,
    });

    // THE DEFAULT. A fresh profile publishes nothing, and that is a column default rather
    // than a code path, so it survives an account created by any of the `ensureProfile`
    // callers without each of them remembering to pass it.
    check(
      'privacy: a new account does not publish its replays',
      (await repo.getReplaysPublic('rp-red')) === false,
    );
    check('privacy: a stranger cannot watch a versus replay', (await acc(vsReplay, 'rp-nosy')) === 'private');
    check('privacy: ...nor can a signed-out visitor', (await acc(vsReplay, null)) === 'private');

    // EVERYONE WHO PLAYED IN IT, FROM EITHER SIDE. It is as much the opponent's match as the
    // subject's, and they watched the whole thing live — there is nothing left to withhold.
    check('privacy: a PARTICIPANT always can — it is their own match', (await acc(vsReplay, 'rp-red')) === 'ok');
    check('privacy: ...the OPPONENT too, not just the one whose history it is', (await acc(vsReplay, 'rp-blue')) === 'ok');

    // MODERATION MUST NOT BE LOCKED OUT. The report queue reaches a match through this exact
    // call, so a gate that refuses staff quietly breaks score corrections and misscore claims.
    check('privacy: staff can watch anything — the report queue depends on it', (await acc(vsReplay, 'rp-mod')) === 'ok');
    // ...and it is the ROLE doing that, not the account being special, so a demoted admin loses it
    // an env that names SOMEBODY ELSE — `syncStaffRoles` keeps its first argument as the
    // owner, so clearing the list alone would leave `rp-mod` staff by that route
    await repo.syncStaffRoles('rp-gone', ['rp-gone']);
    check(
      'privacy: ...and a demoted admin loses it again — the sweep is symmetric',
      (await acc(vsReplay, 'rp-mod')) === 'private',
    );
    await repo.syncStaffRoles('rp-mod', ['rp-mod']);

    // UNANIMITY. One player opting in must NOT publish the match, because the log shows the
    // other alliance's strategy too. This is the assertion that makes the setting honest.
    await repo.setReplaysPublic('rp-red', true);
    check('privacy: ONE participant opting in does not publish the match', (await acc(vsReplay, 'rp-nosy')) === 'private');
    await repo.setReplaysPublic('rp-blue', true);
    check('privacy: ...and once everyone has, anyone may watch it', (await acc(vsReplay, 'rp-nosy')) === 'ok');
    check('privacy: ...including a signed-out visitor, so a shared link works', (await acc(vsReplay, null)) === 'ok');
    // and it is REVOCABLE, or the setting is a one-way publish button
    await repo.setReplaysPublic('rp-blue', false);
    check('privacy: turning it back off hides the match again', (await acc(vsReplay, 'rp-nosy')) === 'private');
    await repo.setReplaysPublic('rp-blue', true);

    /* ⚠️ UNANIMITY IS OVER THE ROSTER, NOT OVER THE SURVIVING ROWS.
       `match_participants` holds a row only for an AUTHED player and cascades away with a
       deleted profile, so "every row says yes" is not "everyone who played said yes". Both
       cases below would publish a match against somebody who was never asked. */
    let anonMid = '';
    {
      const anonReplay = await mkReplay(10);
      anonMid = String(await repo.saveMatch('1v1', SEA, anonReplay, true, 'decode'));
      await repo.addMatchParticipant({
        matchId: anonMid, userId: 'rp-red', alliance: 'red', drivetrain: 'tank',
        score: 30, won: true, ratingBefore: 1000, ratingAfter: 1010,
      });
      check(
        'privacy/roster: a 1v1 against a SIGNED-OUT opponent never publishes — they were never asked',
        (await acc(anonReplay, 'rp-nosy')) === 'private',
        'rp-red has opted in and is the only stored participant',
      );
      check(
        'privacy/roster: ...and the one player in it can still watch it',
        (await acc(anonReplay, 'rp-red')) === 'ok',
      );

      // a 2v2 needs FOUR, so three consenting players is still not the roster
      const duoReplay = await mkReplay(11);
      const duoMid = await repo.saveMatch('2v2', SEA, duoReplay, true, 'decode');
      for (const [uid, side] of [['rp-red', 'red'], ['rp-red2', 'red'], ['rp-blue', 'blue']] as [string, string][]) {
        await repo.addMatchParticipant({
          matchId: duoMid, userId: uid, alliance: side as 'red' | 'blue', drivetrain: 'tank',
          score: 50, won: false, ratingBefore: 1000, ratingAfter: 1000,
        });
      }
      await repo.setReplaysPublic('rp-red2', true);
      check(
        'privacy/roster: a 2v2 with only three stored players never publishes',
        (await acc(duoReplay, 'rp-nosy')) === 'private',
      );
      await repo.addMatchParticipant({
        matchId: duoMid, userId: 'rp-blue2', alliance: 'blue', drivetrain: 'tank',
        score: 50, won: true, ratingBefore: 1000, ratingAfter: 1000,
      });
      await repo.setReplaysPublic('rp-blue2', true);
      check(
        'privacy/roster: ...and does once the fourth is there and has opted in',
        (await acc(duoReplay, 'rp-nosy')) === 'ok',
      );
      // DELETING an account is the same shape from the other end: it cannot consent any more,
      // and its row going away must not be read as the roster shrinking to fit.
      //
      // ⚠️ `deleteAccount` also sweeps this VERSUS match's replay outright (it is reachable
      // only through a participant, and the account being deleted is one) — a stronger
      // refusal than the roster falling incomplete, but not a weaker one: 'missing' still
      // fails every `=== 'ok'` check a false "consent by absence" would need to pass.
      await repo.deleteAccount('rp-blue2');
      check(
        'privacy/roster: a DELETED participant takes the match replay with it, rather than consenting by absence',
        (await acc(duoReplay, 'rp-nosy')) === 'missing',
      );
    }

    // A RECORD RUN IS PROOF, NOT STRATEGY — it stays public whatever the flag says, or the
    // leaderboard stops being checkable by the people it ranks.
    const recReplay = await mkReplay(2);
    await repo.submitRecord({
      userId: 'rp-blue', mode: 'solo', drivetrain: 'tank', score: 120,
      balanceVersion: SEA, replayId: recReplay, game: 'decode',
    });
    await repo.setReplaysPublic('rp-blue', false);
    check(
      'privacy: a RECORD run replay stays public — it is the board proof',
      (await acc(recReplay, 'rp-nosy')) === 'ok',
      'rp-blue has replays_public = false at this point',
    );

    // A PRACTICE run is an unverified offline log its own list endpoint never shows anyone
    // else. Only the unguessable uuid was protecting it.
    const prac = await repo.savePracticeRun(
      'rp-red',
      { format: 2, balanceVersion: SEA, sim: 3, game: 'decode', mode: 'match', seed: 3, ticks: 10, setups: [], tracks: {} },
      50,
      SEA,
      'decode',
    );
    const pracReplay = String(prac.replayId);
    check(
      'privacy: a PRACTICE replay is owner-only, even with the flag ON',
      (await acc(pracReplay, 'rp-red')) === 'ok' && (await acc(pracReplay, 'rp-nosy')) === 'private',
      'rp-red has replays_public = true',
    );

    /* A LAN RUN IS THE HOST'S OWN EVENT. `lan_runs` exposes exactly one read path (one host's
       own matches, 0033) and its drivers are NAMES rather than accounts, so there is nobody
       else `replays_public` could speak for — which argues for keeping it shut, not open. It
       still lands in the database, where staff can reach it. */
    {
      const lanRun = await repo.saveLanRun(
        'rp-host',
        '11111111-2222-3333-4444-555555555555',
        { format: 2, balanceVersion: SEA, sim: 3, game: 'decode', mode: 'match', seed: 20, ticks: 10, setups: [], tracks: {} },
        { red: 40, blue: 50 },
        [{ name: 'Guest One', alliance: 'red' }, { name: 'Guest Two', alliance: 'blue' }],
        SEA,
        'decode',
      );
      const lanReplay = String(lanRun.replayId);
      check('privacy/lan: the HOST who uploaded it can watch it', (await acc(lanReplay, 'rp-host')) === 'ok');
      check('privacy/lan: a stranger cannot', (await acc(lanReplay, 'rp-nosy')) === 'private');
      check('privacy/lan: ...nor can a signed-out visitor', (await acc(lanReplay, null)) === 'private');
      check(
        'privacy/lan: ...and the host opting in does NOT publish it — the drivers are names, not accounts',
        (await (async () => {
          await repo.setReplaysPublic('rp-host', true);
          return acc(lanReplay, 'rp-nosy');
        })()) === 'private',
      );
      check('privacy/lan: the database still has it, and staff can see it', (await acc(lanReplay, 'rp-mod')) === 'ok');
      check(
        'privacy/lan: the refusal says it is a self-hosted match, not that a setting is off',
        repo.replayRefusalMessage((await repo.replayAccess(lanReplay, 'rp-nosy')).kind).includes('self-hosted'),
        repo.replayRefusalMessage('lan'),
      );
    }

    // THE REFUSAL NAMES ITSELF. Three owners refuse for three different reasons, and one
    // generic sentence would be wrong about two of them.
    check(
      'privacy: a private MATCH refusal points at the setting behind it',
      repo.replayRefusalMessage('versus').includes('played in the match'),
      repo.replayRefusalMessage('versus'),
    );
    check(
      'privacy: a PRACTICE refusal does not — there is no setting that would open it',
      !repo.replayRefusalMessage('practice').includes('allow it'),
      repo.replayRefusalMessage('practice'),
    );

    // A DEAD LINK IS NOT A SECRET. A season purge deletes replays, and telling somebody their
    // bookmark is private would send them asking a player to publish something that is gone.
    check(
      'privacy: an unknown replay id reads MISSING, not private',
      (await acc('00000000-0000-0000-0000-000000000000', 'rp-red')) === 'missing',
    );
    // ...and an ORPHAN is the other way round: the replay is there, nothing claims it, deny.
    check(
      'privacy: a replay nothing points at is DENIED rather than defaulting open',
      (await acc(await mkReplay(30), 'rp-nosy')) === 'private',
    );

    // THE MATCH HISTORY HALF. The list stays public — results, scores and rating deltas are
    // the leaderboard's substance — but a row a reader may not watch must not hand out a
    // replay id, or the Watch button is drawn and answers 403 when pressed.
    await repo.setReplaysPublic('rp-red', false);
    const hist = (subject: string, viewer: string | null, staff = false): Promise<repo.MatchHistoryPage> =>
      repo.userMatchHistory(subject, {
        balanceVersion: SEA, game: 'decode', viewerId: viewer, viewerIsStaff: staff,
      });

    const asStranger = await hist('rp-red', 'rp-nosy');
    const strangerRow = asStranger.rows.find((r) => r.id === String(mid));
    check('privacy/history: a stranger still SEES the match', !!strangerRow && strangerRow.score === 40);
    check(
      'privacy/history: ...with no replay id on it, so no Watch button is drawn',
      strangerRow?.replayId === null,
    );
    check(
      'privacy/history: a participant keeps the replay id on their own row',
      (await hist('rp-red', 'rp-red')).rows.find((r) => r.id === String(mid))?.replayId === String(vsReplay),
    );
    // THE OPPONENT BROWSING THE SUBJECT'S PROFILE — the case the roster rule is really about.
    // It is their match too, so the Watch button has to survive being reached from somebody
    // else's history page rather than only from their own.
    check(
      'privacy/history: the OPPONENT sees Watch on that match from the subject’s profile',
      (await hist('rp-red', 'rp-blue')).rows.find((r) => r.id === String(mid))?.replayId === String(vsReplay),
    );
    check(
      'privacy/history: staff keep it too',
      (await hist('rp-red', 'rp-mod', true)).rows.find((r) => r.id === String(mid))?.replayId === String(vsReplay),
    );
    check(
      'privacy/history: an anonymous read is treated as a stranger, not as the subject',
      (await hist('rp-red', null)).rows.find((r) => r.id === String(mid))?.replayId === null,
    );
    // a RECORD row in the same feed keeps its replay for everyone, matching `replayAccess`
    check(
      'privacy/history: a record run keeps its replay id for a stranger',
      (await hist('rp-blue', 'rp-nosy')).rows.find((r) => r.kind === 'record')?.replayId === String(recReplay),
    );
    // ⚠️ THE LIST MUST APPLY THE ROSTER RULE, NOT UNANIMITY ALONE. rp-red is the ONLY stored
    // participant of that 1v1 and is about to opt in, so a gate that asked only "did every
    // stored row say yes" would draw a Watch button here — on a match whose other driver was
    // signed out and never asked, and which `replayAccess` then answers 403 to.
    await repo.setReplaysPublic('rp-red', true);
    check(
      'privacy/history: a roster-incomplete 1v1 draws no Watch button even with every stored row opted in',
      (await hist('rp-red', 'rp-nosy')).rows.find((r) => r.id === anonMid)?.replayId === null,
    );
    // the positive half, so the gate is not just answering no to everything: the full 1v1
    // roster has both players opted in, so a stranger DOES get the id.
    await repo.setReplaysPublic('rp-blue', true);
    check(
      'privacy/history: a fully released match hands a stranger the replay id',
      (await hist('rp-red', 'rp-nosy')).rows.find((r) => r.id === String(mid))?.replayId === String(vsReplay),
      'rp-red and rp-blue are both public here',
    );
  }

  /* ---- ANALYTICS (migration 0042) -------------------------------------------------------
     The feature's guarantees are all database-shaped, which is to say none of them can be
     confirmed by reading the code that states them:

       · a visitor hash is stable within a day and DIFFERENT across days, because the salt
         rotated and the old one was destroyed;
       · sessions are derived from a 30-minute gap — a rule that exists only inside a window
         function, and whose two failure modes (a session split by a bucket boundary, a session
         counted again in the bucket it continued into) both look like plausible numbers;
       · the rollup is IDEMPOTENT, because the job re-runs the last three hours every pass;
       · the all-games `'*'` row is a real aggregate and not the sum of the per-game ones,
         which is the whole reason it is written;
       · retention actually deletes, including the salt, which is the privacy promise itself.

     Run against the real migration and the real queries, like everything else in this file.  */
  {
    const an = await import('../server/analytics');

    // ---- the salt, and the hash that depends on it --------------------------------------
    an.resetSaltCache();
    const today = await an.currentSalt(new Date('2026-09-19T10:00:00Z'));
    an.resetSaltCache();
    const again = await an.currentSalt(new Date('2026-09-19T22:00:00Z'));
    check('analytics/salt: one salt per UTC day, shared rather than per process', today === again);
    an.resetSaltCache();
    const tomorrow = await an.currentSalt(new Date('2026-09-20T01:00:00Z'));
    check('analytics/salt: a new UTC day gets a new salt', tomorrow !== today);

    const ip = '203.0.113.9';
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36';
    const h1 = an.visitorHash(today, ip, ua, 'playdsim.com');
    check('analytics/hash: the same visitor on the same day hashes the same', h1 === an.visitorHash(today, ip, ua, 'playdsim.com'));
    check(
      '⚠️ analytics/hash: the SAME visitor on the NEXT day is a different visitor — the salt is what makes that true',
      h1 !== an.visitorHash(tomorrow, ip, ua, 'playdsim.com'),
    );
    check('analytics/hash: two deployments never merge audiences (the site term)', h1 !== an.visitorHash(today, ip, ua, 'alpha.playdsim.com'));
    check('analytics/hash: 16 hex characters, not a full digest', /^[0-9a-f]{16}$/.test(h1));

    // ---- classification, which decides most of the breakdown columns --------------------
    check('analytics/ua: Edge is Edge, not the Chrome and Safari it also claims to be', an.classify(ua.replace('Chrome/128.0', 'Chrome/128.0 Edg/128.0')).browser === 'Edge');
    check('analytics/ua: plain Chrome on Windows', an.classify(ua).browser === 'Chrome' && an.classify(ua).os === 'Windows' && an.classify(ua).device === 'desktop');
    check(
      'analytics/ua: an iPhone is mobile and an Android tablet is a tablet',
      an.classify('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605 Version/17 Mobile Safari/604').device === 'mobile' &&
        an.classify('Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537 Chrome/120 Safari/537').device === 'tablet',
    );
    check('⚠️ analytics/bot: a blank user agent is a bot, not a visitor', an.isBot(''));
    check('analytics/bot: crawlers and probes are refused', an.isBot('Googlebot/2.1') && an.isBot('curl/8.4.0') && an.isBot('Mozilla/5.0 HeadlessChrome/120'));
    check('analytics/bot: a real browser is not', !an.isBot(ua));
    check('analytics/lang: the primary subtag only, never the whole header', an.primaryLang('en-GB,en;q=0.9,de;q=0.8') === 'en' && an.primaryLang('') === '');
    check('analytics/country: a known zone maps, an unknown one contributes nothing', an.countryForTimezone('Europe/Berlin') === 'DE' && an.countryForTimezone('Etc/GMT+5') === '');

    // ---- the beacon validator ------------------------------------------------------------
    check('analytics/parse: a beacon with no path is not a partial record, it is not a record', an.parsePageview({ g: 'decode' }) === null);
    {
      const pv = an.parsePageview({ p: '/decode/records', g: 'decode', w: 'lg', x: 'web', r: 'GOOGLE.COM', z: 'Europe/Berlin' });
      check('analytics/parse: a good beacon comes back normalized', pv?.path === '/decode/records' && pv.ref === 'google.com' && pv.screen === 'lg');
      const junk = an.parsePageview({ p: '/x', w: '9000', x: 'curl', g: 'DECODE!', evil: 'select 1' });
      check(
        '⚠️ analytics/parse: an allowlist — an unknown key is never read, and a bad enum falls back',
        junk !== null && junk.screen === '' && junk.surface === 'web' && junk.game === '' && !('evil' in junk),
      );
      const long = an.parsePageview({ p: '/a', c: 'x'.repeat(500) });
      check('analytics/parse: every field is length-capped at the boundary', (long?.utmCampaign.length ?? 0) <= 48);
    }
    check('analytics/parse: an event needs a well-formed name', an.parseEvent({ n: 'Drop Table' }) === null);
    {
      const ev = an.parseEvent({ n: 'sponsor_shown', p: '/decode', d: { placement: 'footer', n: 3, bad_KEY: 'x', long: 'y'.repeat(99) } });
      check(
        '⚠️ analytics/parse: event properties are BOUNDED here, not trusted — bad keys dropped, values truncated',
        ev?.props.placement === 'footer' && ev.props.n === '3' && !('bad_KEY' in (ev?.props ?? {})) && (ev?.props.long.length ?? 0) <= 32,
      );
    }

    // ---- rate limits ----------------------------------------------------------------------
    an.resetRateLimits();
    let allowed = 0;
    for (let i = 0; i < an.VISITOR_LIMIT + 5; i++) if (an.rateOk('v1', an.VISITOR_LIMIT)) allowed++;
    check('analytics/rate: one visitor is bounded inside the window', allowed === an.VISITOR_LIMIT);
    check('analytics/rate: ...and a DIFFERENT visitor is unaffected by it', an.rateOk('v2', an.VISITOR_LIMIT));
    check('analytics/rate: the window expires rather than banning', an.rateOk('v1', an.VISITOR_LIMIT, Date.now() + 20 * 60_000));

    // ---- ingest, sessions, and the rollup -------------------------------------------------
    const t0 = new Date('2026-09-10T12:00:00Z');
    const mins = (n: number): Date => new Date(t0.getTime() + n * 60_000);
    const pv = async (visitor: string, at: Date, path: string, game: string, extra: Partial<Record<string, string>> = {}): Promise<void> => {
      await db.query(
        `insert into analytics_pageviews (at, visitor, path, game, ref_host, country, device, os, browser, screen, lang, surface, channel, build)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [at, visitor, path, game, extra.ref ?? '', extra.country ?? 'US', extra.device ?? 'desktop',
          extra.os ?? 'Windows', extra.browser ?? 'Chrome', 'lg', 'en', 'web', 'stable', 'abc123'],
      );
    };
    // visitor A: three views five minutes apart (ONE session), then a fourth two hours later
    // (a SECOND session). visitor B: one view, which is a bounce.
    await pv('aaaa000000000001', mins(0), '/decode', 'decode', { ref: 'google.com' });
    await pv('aaaa000000000001', mins(5), '/decode/records', 'decode');
    await pv('aaaa000000000001', mins(10), '/chain/records', 'chain');
    await pv('aaaa000000000001', mins(130), '/decode', 'decode');
    await pv('bbbb000000000002', mins(20), '/privacy', '', { country: 'DE', device: 'mobile' });
    await db.query(`insert into analytics_events (at, visitor, name, game, path, props) values ($1,$2,'support_view','decode','/decode/donate','{"placement":"footer"}')`, [mins(6), 'aaaa000000000001']);

    const day0 = new Date('2026-09-10T00:00:00Z');
    const day1 = new Date('2026-09-11T00:00:00Z');
    await an.runRollup(day0, day1);

    const daily = async (game: string, dim: string, val: string) =>
      (await db.query<{ views: number; visitors: number; sessions: number; bounces: number; seconds: string }>(
        `select views, visitors, sessions, bounces, seconds from analytics_daily
          where day = '2026-09-10' and game = $1 and dim = $2 and val = $3`,
        [game, dim, val],
      )).rows[0];

    const all = await daily('*', 'total', '*');
    check('analytics/rollup: every view in the day is counted once', all?.views === 5, `views=${all?.views}`);
    check('analytics/rollup: two distinct visitors', all?.visitors === 2, `visitors=${all?.visitors}`);
    check(
      '⚠️ analytics/session: a 30-minute gap ends one — A is two sessions, B is one',
      all?.sessions === 3,
      `sessions=${all?.sessions}`,
    );
    check(
      'analytics/session: a one-view session is a bounce (B, and A’s second)',
      all?.bounces === 2,
      `bounces=${all?.bounces}`,
    );
    check(
      'analytics/session: duration is first view to last — A’s first session is 10 minutes',
      Number(all?.seconds ?? 0) === 600,
      `seconds=${all?.seconds}`,
    );

    const decode = await daily('decode', 'total', '*');
    check('analytics/rollup: the per-game row counts only that game’s views', decode?.views === 3, `views=${decode?.views}`);
    check(
      '⚠️ analytics/rollup: the all-games row is an AGGREGATE, not the sum of the per-game rows',
      (await daily('chain', 'total', '*'))?.visitors === 1 && decode?.visitors === 1 && all?.visitors === 2,
      'one person on two games is one visitor, not two',
    );

    check('analytics/rollup: the pages breakdown', (await daily('*', 'path', '/decode'))?.views === 2);
    check('analytics/rollup: the referrer breakdown, with direct traffic kept as its own value', (await daily('*', 'ref', ''))?.views === 4 && (await daily('*', 'ref', 'google.com'))?.views === 1);
    check('analytics/rollup: the country breakdown', (await daily('*', 'country', 'DE'))?.views === 1);
    check('analytics/rollup: entry pages are a SESSION fact, and /decode is where two of them started', (await daily('*', 'entry', '/decode'))?.sessions === 2);
    check('analytics/rollup: named events land in the same table as the traffic', (await daily('*', 'event', 'support_view'))?.views === 1);

    // ⚠️ IDEMPOTENCE. The job re-rolls the last three hours on every pass, so a second run
    // must REPLACE rather than accumulate — an `insert … on conflict do update` that said
    // `views = analytics_daily.views + excluded.views` would double every number here and
    // look perfectly reasonable in review.
    await an.runRollup(day0, day1);
    check('⚠️ analytics/rollup: re-running a bucket replaces it rather than adding to it', (await daily('*', 'total', '*'))?.views === 5);

    // ⚠️ A RANGE THAT STARTS MID-BUCKET. The job rolls "the last three hours", which starts
    // mid-hour and mid-day on every pass, and the upsert REPLACES a bucket with what the range
    // held. 12:15–12:25 holds one of the day's five views; unaligned, it overwrote both the
    // 12:00 bucket and the whole day with that one.
    await an.runRollup(mins(15), mins(25));
    const hour12 = (
      await db.query<{ views: number }>(
        `select views from analytics_hourly where hour = '2026-09-10T12:00:00Z' and game = '*' and dim = 'total' and val = '*'`,
      )
    ).rows[0];
    check(
      '⚠️ analytics/rollup: a range starting mid-bucket re-rolls WHOLE buckets instead of overwriting them with a slice',
      (await daily('*', 'total', '*'))?.views === 5 && hour12?.views === 4,
      `day=${(await daily('*', 'total', '*'))?.views} hour12=${hour12?.views}`,
    );

    // ---- the dashboard read ---------------------------------------------------------------
    {
      const rep = await an.analyticsReport({ from: day0, to: day1, game: '*', filters: [], grain: 'day' });
      check('analytics/report: totals match the rollup', rep.totals.views === 5 && rep.totals.sessions === 3);
      check('analytics/report: the series has a bucket', rep.series.length === 1 && rep.series[0].views === 5);
      const country = rep.breakdowns.filter((b) => b.dim === 'country');
      check('analytics/report: breakdowns come back for every dimension at once', country.length === 2 && rep.breakdowns.some((b) => b.dim === 'entry'));
      check('analytics/report: events and their properties both come back', rep.events[0]?.name === 'support_view' && rep.eventProps[0]?.val === 'footer');

      // CLICK-TO-FILTER is the feature the raw tier exists for: it has to narrow EVERY number
      // on the page, not just the panel that was clicked.
      const de = await an.analyticsReport({ from: day0, to: day1, game: '*', filters: [{ dim: 'country', val: 'DE' }], grain: 'day' });
      check('⚠️ analytics/filter: a filter narrows the totals, not just its own panel', de.totals.views === 1 && de.totals.visitors === 1);
      check('analytics/filter: ...and the breakdowns with them', de.breakdowns.filter((b) => b.dim === 'path').length === 1);
      const bogus = await an.analyticsReport({ from: day0, to: day1, game: '*', filters: [{ dim: 'drop table', val: 'x' }], grain: 'day' });
      check(
        '⚠️ analytics/filter: a dimension that is not one of ours is DROPPED, never interpolated',
        bogus.totals.views === 5,
      );
      check('analytics/report: a game filter narrows it too', (await an.analyticsReport({ from: day0, to: day1, game: 'chain', filters: [], grain: 'day' })).totals.views === 1);
      check(
        'analytics/report: a range older than the raw tier keeps is served from the aggregates, and says so',
        (await an.analyticsReport({ from: new Date('2025-01-01'), to: new Date('2025-02-01'), game: '*', filters: [], grain: 'day' })).source === 'aggregate',
      );
    }

    // ---- events outlive the raw tier, properties included --------------------------------
    // The sponsor report is read by placement, a month after the fact. Before the `evprop` rows,
    // a range past 30 days had event names from nowhere and properties from nowhere.
    check(
      'analytics/rollup: event PROPERTIES are rolled up too, as name|key|value',
      (await daily('*', 'evprop', 'support_view|placement|footer'))?.views === 1,
    );
    {
      await db.query(
        `insert into analytics_daily (day, game, dim, val, views, visitors)
         values ('2025-01-10', '*', 'event', 'sponsor_click', 3, 2), ('2025-01-10', '*', 'evprop', 'sponsor_click|placement|game', 3, 2)`,
      );
      const old = await an.analyticsReport({ from: new Date('2025-01-01'), to: new Date('2025-02-01'), game: '*', filters: [], grain: 'day' });
      check(
        '⚠️ analytics/report: a range past the raw tier reads events AND their properties off the rollups',
        old.events[0]?.name === 'sponsor_click' && old.events[0].views === 3 &&
          old.eventProps.some((p) => p.name === 'sponsor_click' && p.key === 'placement' && p.val === 'game' && p.views === 3),
      );
      check('analytics/report: property rows never show up as a breakdown panel', !old.breakdowns.some((b) => b.dim === 'evprop'));
      check('analytics/report: it says where its own traffic history starts', old.historyStart === '2026-09-10', String(old.historyStart));
      check('analytics/report: no import yet means no imported section', old.imported === null);
      await db.query(`delete from analytics_daily where day = '2025-01-10'`);
    }

    // ---- history imported from Vercel Web Analytics (0053) ---------------------------------
    {
      const { vercelImportRows } = await import('../server/analyticsImport');
      const { replaceImportedAnalytics } = await import('../server/db/repo');
      const v = (day: string, value: string | null, pageviews: number, visitors: number) => ({ day, value, pageviews, visitors });
      const file = {
        source: 'vercel' as const,
        environment: 'production',
        firstDay: '2026-09-13',
        lastDay: '2026-09-14',
        visits: {
          total: [
            { day: '2026-09-12', pageviews: 0, visitors: 0 },
            { day: '2026-09-13', pageviews: 100, visitors: 10 },
            { day: '2026-09-14', pageviews: 50, visitors: 5 },
          ],
          by: {
            requestPath: [
              v('2026-09-13', '/decode/profile/alice', 3, 1),
              v('2026-09-13', '/decode/profile/bob', 2, 1),
              v('2026-09-13', '/decode/records?token=secret', 5, 2),
            ],
            route: [v('2026-09-13', null, 100, 10)],
            referrerHostname: [v('2026-09-13', null, 90, 9), v('2026-09-13', 'www.google.com', 10, 1)],
            osName: [v('2026-09-13', 'Mac', 40, 4)],
            browserName: [v('2026-09-13', 'Microsoft Edge', 20, 2), v('2026-09-13', 'Others', 5, 1)],
          },
        },
        events: {
          byName: [{ day: '2026-09-13', name: 'sponsor_click', count: 4, visitors: 3 }],
          byProp: [
            { day: '2026-09-13', name: 'sponsor_click', key: 'placement', value: 'game', count: 4, visitors: 3 },
            { day: '2026-09-13', name: 'sponsor_shown', key: 'format', value: '', count: 9, visitors: 9 },
          ],
        },
      };
      const rows = vercelImportRows(file);
      check(
        '⚠️ analytics/import: paths are scrubbed like the live beacon, so no username or token lands in the table',
        !rows.some((r) => /alice|bob|token|secret/.test(r.val)) && rows.find((r) => r.dim === 'path' && r.val === '/decode/profile/:name')?.views === 5,
      );
      check(
        'analytics/import: the host’s spellings map onto ours, and a direct visit stays a blank referrer',
        rows.some((r) => r.dim === 'os' && r.val === 'macOS') && rows.some((r) => r.dim === 'browser' && r.val === 'Edge') &&
          rows.some((r) => r.dim === 'ref' && r.val === 'google.com') && rows.some((r) => r.dim === 'ref' && r.val === ''),
      );
      check(
        'analytics/import: empty days, route rows and absent property values are left out',
        !rows.some((r) => r.day === '2026-09-12') && !rows.some((r) => r.dim === 'route') && !rows.some((r) => r.val.startsWith('sponsor_shown|')),
      );
      const count = async (): Promise<number> =>
        Number((await db.query<{ n: string }>(`select count(*) as n from analytics_imported`)).rows[0].n);
      const first = await replaceImportedAnalytics('vercel', rows);
      const second = await replaceImportedAnalytics('vercel', rows);
      check(
        '⚠️ analytics/import: idempotent, a second run replaces the days instead of adding to them',
        first.inserted === rows.length && second.deleted === rows.length && (await count()) === rows.length,
        `inserted=${first.inserted} deleted=${second.deleted} rows=${await count()}`,
      );
      await replaceImportedAnalytics('vercel', rows.filter((r) => r.day === '2026-09-14'));
      check(
        'analytics/import: a narrower re-import replaces only the days it covers',
        Number((await db.query<{ n: string }>(`select count(*) as n from analytics_imported where day = '2026-09-13'`)).rows[0].n) > 0,
      );
      const rep = await an.analyticsReport({ from: new Date('2026-09-13T00:00:00Z'), to: new Date('2026-09-15T00:00:00Z'), game: '*', filters: [], grain: 'day' });
      const imp = rep.imported;
      check(
        'analytics/import: the report carries the imported span and its totals',
        imp?.source === 'vercel' && imp.firstDay === '2026-09-13' && imp.lastDay === '2026-09-14' && imp.totals.views === 150 && imp.series.length === 2,
        JSON.stringify(imp && { ...imp, breakdowns: undefined }),
      );
      check(
        'analytics/import: ...its breakdowns, events and event properties',
        !!imp?.breakdowns.some((b) => b.dim === 'path' && b.val === '/decode/profile/:name') &&
          imp.events[0]?.name === 'sponsor_click' && imp.eventProps[0]?.key === 'placement' && imp.eventProps[0]?.val === 'game',
      );
      check('⚠️ analytics/import: never added into the first-party totals', rep.totals.views === 0);
      const oneDay = await an.analyticsReport({ from: new Date('2026-09-13T00:00:00Z'), to: new Date('2026-09-14T00:00:00Z'), game: '*', filters: [], grain: 'day' });
      check('analytics/import: the range end is exclusive, as it is for live data', oneDay.imported?.series.length === 1);
    }

    // ---- retention, which is where the privacy promise is either kept or not ---------------
    await db.query(`insert into analytics_pageviews (at, visitor, path) values (now() - interval '45 days', 'old0000000000001', '/old')`);
    await db.query(`insert into analytics_salt (day, salt) values ((now() at time zone 'UTC')::date - 9, 'ancient')`);
    await an.sweepAnalytics();
    check(
      'analytics/retention: a raw row past 30 days is deleted',
      Number((await db.query<{ n: string }>(`select count(*) as n from analytics_pageviews where path = '/old'`)).rows[0].n) === 0,
    );
    check(
      '⚠️ analytics/retention: an old SALT is DESTROYED — this deletion is the promise that a visitor cannot be followed across days',
      Number((await db.query<{ n: string }>(`select count(*) as n from analytics_salt where salt = 'ancient'`)).rows[0].n) === 0,
    );
    check(
      'analytics/retention: the aggregates outlive the raw rows they were built from',
      (await daily('*', 'total', '*'))?.views === 5,
    );

    // ---- the maintenance pass itself ----------------------------------------------------------
    {
      an.stopAnalyticsJobs();
      const advisory = async (): Promise<number> =>
        Number((await db.query<{ n: string }>(`select count(*) as n from pg_locks where locktype = 'advisory'`)).rows[0].n);
      await an.analyticsTick(mins(140).getTime()); // no traffic noted: must not touch the database
      an.noteTraffic();
      await an.analyticsTick(mins(140).getTime());
      check(
        'analytics/job: a pass three hours into the day leaves the day whole',
        (await daily('*', 'total', '*'))?.views === 5,
      );
      check('⚠️ analytics/job: the pass gives its advisory lock back', (await advisory()) === 0);
      an.stopAnalyticsJobs();
    }

    // ---- ⚠️ THE SCHEMA ITSELF CANNOT HOLD AN IDENTIFIER ------------------------------------
    // The strongest statement this feature makes is "no account id is ever attached to
    // traffic", and it is worth asserting as a property of the SCHEMA rather than of the code
    // that writes it: a column somebody adds later for a good reason is exactly how this
    // guarantee would be lost, and it would not fail any other test here.
    {
      const cols = (await db.query<{ table_name: string; column_name: string }>(
        `select table_name, column_name from information_schema.columns
          where table_schema = 'public' and table_name like 'analytics\\_%'
            and (column_name in ('user_id', 'ip', 'ip_address', 'user_agent', 'ua', 'email', 'handle', 'username')
                 or column_name like '%user_id%')`,
      )).rows;
      check(
        '⚠️ analytics/schema: no analytics table has a user id, an IP or a user-agent column',
        cols.length === 0,
        cols.map((c) => `${c.table_name}.${c.column_name}`).join(', ') || 'none',
      );
    }

    // ---- the product half ------------------------------------------------------------------
    {
      const prod = await an.productReport(new Date('2020-01-01'), new Date('2030-01-01'), '*');
      check('analytics/product: matches are counted per game × kind × mode × physics', prod.matches.length > 0);
      check('analytics/product: signups per day come off `profiles`', prod.signups.length > 0);
      check('analytics/product: the ranked distribution buckets by 100 points', prod.ranked.every((r) => r.bucket % 100 === 0));
      check('analytics/product: replay storage is measured, not estimated', prod.replayBytes > 0);
      check('analytics/product: a retention cohort carries its own size', prod.retention.every((r) => r.size >= r.d1 && r.d1 >= 0));
      check(
        'analytics/product: a day is YYYY-MM-DD rather than whatever the driver returned',
        prod.signups.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.day)),
      );
      const one = await an.productReport(new Date('2020-01-01'), new Date('2030-01-01'), 'chain');
      check('analytics/product: the game filter reaches every per-game query', one.matches.every((m) => m.game === 'chain'));
    }

    // ---- concurrency sampling ---------------------------------------------------------------
    await db.query(
      `insert into presence (machine, region, online, authed, q1v1, q2v2, updated_at, rooms)
       values ('m1', 'iad', 7, '["u1","u2"]'::jsonb, 1, 0, now(), '[{"room":"a"}]'::jsonb)`,
    );
    check('analytics/concurrency: a live machine is sampled into the history table', (await an.sampleConcurrency()) === 1);
    check(
      '⚠️ analytics/concurrency: an EMPTY service writes nothing — the gap in the chart is the answer, and an unconditional write would pin the Neon compute awake',
      (await db.query(`update presence set online = 0 where machine = 'm1'`), await an.sampleConcurrency()) === 0,
    );
  }

  /* ---- THE ADMIN CONSOLE'S OWN LAYER (migration 0041) ----------------------
     The audit log, moderator notes, the name resolver behind the "(no profile)" fix, and the
     one-request user detail. Every one of these is a moderation surface, which is the class
     of code where a read-only review is worth least: the guarantees live in a `left join`
     that must survive a missing row, a delete scoped by two columns, and a paging clause
     that must not show one row twice.
  */
  {
    await repo.ensureProfile('adm-mod', 'Moderator');
    await repo.ensureProfile('adm-target', 'Target Player');
    await repo.ensureProfile('adm-other', 'Somebody Else');
    await repo.setUsername('adm-target', 'targetplayer');

    const t41 = (
      await db.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = 'public' and table_name in ('admin_audit','admin_notes')`,
      )
    ).rows.map((r) => r.table_name);
    check('audit: 0041 created admin_audit', t41.includes('admin_audit'));
    check('audit: 0041 created admin_notes', t41.includes('admin_notes'));

    // ---- the log ---------------------------------------------------------------------
    await repo.writeAudit({
      adminId: 'adm-mod',
      action: 'user.rename',
      targetUser: 'adm-target',
      detail: { from: 'Target Player', to: 'Renamed' },
      note: 'inappropriate name',
    });
    await repo.writeAudit({ adminId: 'adm-mod', action: 'season.start', detail: { season: 7 } });
    await repo.writeAudit({ adminId: 'secret', action: 'notice.restart', detail: { seconds: 300 } });

    const all = await repo.listAudit({ limit: 50 });
    check('audit: every write lands, newest first', all.rows.length === 3 && all.rows[0].action === 'notice.restart');
    check(
      'audit: the detail blob round-trips as an object, not a string',
      all.rows.find((r) => r.action === 'user.rename')?.detail.to === 'Renamed',
    );
    // ⚠️ THE NAME IS RESOLVED AT READ TIME, NEVER STORED. A handle copied into the row would
    // be a lie the moment somebody is renamed — which, for a log whose commonest entry IS a
    // rename, is the very next row.
    check(
      'audit: the target’s CURRENT name is joined on, not a copy taken when it was written',
      all.rows.find((r) => r.action === 'user.rename')?.targetHandle === 'Target Player',
    );
    await repo.setHandle('adm-target', 'After The Rename');
    check(
      'audit: ...so renaming them changes what the old row reads as',
      (await repo.listAudit({ action: 'user.rename' })).rows[0]?.targetHandle === 'After The Rename',
    );
    // a SERVICE-WIDE action has no target, and that is a real state rather than a gap: the
    // acting admin must never end up in the column that means "the person this was done to"
    check(
      'audit: a service-wide action has no target account',
      all.rows.find((r) => r.action === 'season.start')?.targetUser === null,
    );

    check('audit: filter by action', (await repo.listAudit({ action: 'season.start' })).rows.length === 1);
    check('audit: filter by acting admin', (await repo.listAudit({ adminId: 'secret' })).rows.length === 1);
    check(
      'audit: filter by target account — "what has been done to this person"',
      (await repo.listAudit({ targetUser: 'adm-target' })).rows.length === 1,
    );
    check(
      'audit: free text reaches the note',
      (await repo.listAudit({ query: 'inappropriate' })).rows.length === 1,
    );
    check(
      'audit: ...and the target’s name, through the join',
      (await repo.listAudit({ query: 'After The' })).rows.length === 1,
    );
    // ⚠️ A BARE `%` MUST NOT MATCH EVERYTHING. The search is five `ilike`s; unescaped, one
    // character typed into the box turns a filter into a full scan that returns the lot.
    check(
      'audit: a wildcard typed into the search box is a literal, not a wildcard',
      (await repo.listAudit({ query: '%' })).rows.length === 0,
    );
    check(
      'audit: the action list is the filter menu’s options',
      (await repo.auditActions()).join(',') === 'notice.restart,season.start,user.rename',
    );

    // PAGING. `more` is answered by fetching one row past the page, never by a second count
    // over the same scan.
    const p1 = await repo.listAudit({ limit: 2 });
    check('audit: a page is capped at what was asked for', p1.rows.length === 2);
    check('audit: ...and says there is another', p1.more === true);
    const p2 = await repo.listAudit({ limit: 2, offset: 2 });
    check('audit: the next page is the remainder', p2.rows.length === 1 && p2.more === false);
    check(
      'audit: no row appears on both pages',
      !p1.rows.some((a) => p2.rows.some((b) => b.id === a.id)),
    );
    check(
      'audit: an absurd limit is clamped rather than honoured',
      (await repo.listAudit({ limit: 10_000 })).rows.length === 3,
    );

    // -------------------------------------------------- earned cosmetics (11)
    //
    // `profiles.cosmetics` (0044) is the SECOND ledger docs/cosmetics-plan.md §3.2 calls
    // for — separate from `supporter_until` so a lapsed membership can never delete
    // something earned, and an earned unlock can never quietly become something sold
    // (plan §1's non-goal). Run down here, AFTER the admin_audit count assertions above:
    // `grantCosmetic`/`revokeCosmetic` write to that same table, and this block's own
    // writes must not shift the exact row counts the audit section just checked.
    await repo.ensureProfile('cos-free', 'Free');
    await repo.ensureProfile('cos-sup', 'Supporter');
    await repo.ensureProfile('cos-earn', 'Earner');
    await db.query(
      `update profiles set supporter_until = now() + interval '30 days' where user_id = 'cos-sup'`,
    );

    check('cosmetics: a fresh profile has no earned unlocks', (await repo.getCosmeticsUnlocks('cos-earn')).length === 0);
    check(
      'cosmetics: getProfile carries the (empty) list too',
      ((await repo.getProfile('cos-earn'))?.cosmetics ?? []).length === 0,
    );

    // shape validation — the SAME closed set coerceSpec/stripUnentitledCosmetics clamp to
    check('cosmetics: grantCosmetic refuses a malformed id (no colon)', !(await repo.grantCosmetic('cos-earn', 'chevron', 'admin')));
    check('cosmetics: grantCosmetic refuses an unknown axis', !(await repo.grantCosmetic('cos-earn', 'paint:chevron', 'admin')));
    check('cosmetics: grantCosmetic refuses a key not on the axis', !(await repo.grantCosmetic('cos-earn', 'decal:nope', 'admin')));
    check('cosmetics: none of the refused grants wrote anything', (await repo.getCosmeticsUnlocks('cos-earn')).length === 0);
    check('cosmetics: grantCosmetic refuses an unknown account', !(await repo.grantCosmetic('cos-nobody', 'decal:chevron', 'admin')));

    const granted = await repo.grantCosmetic('cos-earn', 'decal:chevron', 'admin-1', 'contributor thank-you');
    check('cosmetics: a valid grant succeeds', granted);
    check('cosmetics: the unlock is on the account', (await repo.getCosmeticsUnlocks('cos-earn')).includes('decal:chevron'));
    check(
      'cosmetics: re-granting the same id is idempotent (no duplicate array entry)',
      (await repo.grantCosmetic('cos-earn', 'decal:chevron', 'admin-1')) &&
        (await repo.getCosmeticsUnlocks('cos-earn')).filter((id) => id === 'decal:chevron').length === 1,
    );

    const cosGrantAudit = (
      await db.query<{ action: string; target_user: string; note: string | null }>(
        `select action, target_user, note from admin_audit
          where action = 'cosmetics.grant' and target_user = 'cos-earn' order by at asc limit 1`,
      )
    ).rows[0];
    check('audit: a cosmetics grant is logged to admin_audit (0041)', cosGrantAudit?.action === 'cosmetics.grant');
    check('audit: ...with the note kept', (cosGrantAudit?.note ?? '').includes('contributor'));

    check(
      'cosmetics: revoking an unheld id reports nothing to revoke',
      !(await repo.revokeCosmetic('cos-earn', 'plate:bold', 'admin-1')),
    );
    const revokedCos = await repo.revokeCosmetic('cos-earn', 'decal:chevron', 'admin-1', 'mistake');
    check('cosmetics: revoke removes a held unlock', revokedCos);
    check('cosmetics: the unlock is gone', !(await repo.getCosmeticsUnlocks('cos-earn')).includes('decal:chevron'));
    const cosRevokeAudit = (
      await db.query<{ action: string }>(
        `select action from admin_audit
          where action = 'cosmetics.revoke' and target_user = 'cos-earn' order by at desc limit 1`,
      )
    ).rows[0];
    check('audit: a cosmetics revoke is logged too', cosRevokeAudit?.action === 'cosmetics.revoke');

    // re-grant it — the strip tests below need 'cos-earn' to actually have it
    await repo.grantCosmetic('cos-earn', 'decal:chevron', 'admin-1');

    // ---------------------------------------- entitlement strip semantics (§3.3)
    //
    // `stripUnentitledCosmetics` itself is a pure function (src/cosmetics.ts, covered by
    // `npm test`'s fuzz); what only a live database can prove is that the ACCOUNT STATE it
    // is fed — `getSupporter().supporter` and `getCosmeticsUnlocks()` — lines up with what
    // the room's entitlement strip (server/index.ts, server/room.ts) actually reads.
    const spoofed = { chassisColor: 'gold', accent: 'match', decal: 'chevron', plate: 'classic' };

    const freeSupporter = (await repo.getSupporter('cos-free')).supporter;
    const freeEarned = await repo.getCosmeticsUnlocks('cos-free');
    const freeOut = stripUnentitledCosmetics(spoofed, freeSupporter, freeEarned);
    check(
      'strip: a non-supporter declaring gold+chevron is downgraded on both unowned axes',
      freeOut.chassisColor === 'default' && freeOut.decal === 'none',
      JSON.stringify(freeOut),
    );
    check(
      'strip: ...but keeps a FREE-tier chassis colour (red)',
      stripUnentitledCosmetics({ chassisColor: 'red' }, freeSupporter, freeEarned).chassisColor === 'red',
    );

    const supSupporter = (await repo.getSupporter('cos-sup')).supporter;
    const supOut = stripUnentitledCosmetics(spoofed, supSupporter, await repo.getCosmeticsUnlocks('cos-sup'));
    check('strip: a supporter keeps a supporter-tier chassis colour (gold)', supSupporter && supOut.chassisColor === 'gold');

    const earnSupporter = (await repo.getSupporter('cos-earn')).supporter;
    const earnOut = stripUnentitledCosmetics(spoofed, earnSupporter, await repo.getCosmeticsUnlocks('cos-earn'));
    check(
      'strip: an EARNED decal survives even for a non-supporter',
      !earnSupporter && earnOut.decal === 'chevron',
      JSON.stringify({ supporter: earnSupporter, decal: earnOut.decal }),
    );
    check('strip: ...but the same account still loses the gold chassis it never earned or paid for', earnOut.chassisColor === 'default');

    // ⚠️ IT MUST NEVER THROW INTO A ROUTE. A moderator who has just pardoned somebody must
    // not see the pardon fail because a logging insert did — the same rule server/standing.ts
    // states. `admin_audit` has no foreign keys, so an unknown target is fine by design; this
    // asserts the swallow on a genuinely broken write.
    let auditThrew = false;
    await repo
      .writeAudit({ adminId: 'adm-mod', action: 'x'.repeat(100_000), targetUser: 'nobody-at-all' })
      .catch(() => {
        auditThrew = true;
      });
    check('audit: a write can never throw into the route that called it', !auditThrew);
    check(
      'audit: a row naming an account that does not exist still reads back',
      (await repo.listAudit({ targetUser: 'nobody-at-all' })).rows.length === 1,
    );

    // ---- moderator notes -------------------------------------------------------------
    const n1 = await repo.addAdminNote('adm-target', 'adm-mod', '  warned in the event chat  ');
    check('notes: a note is stored trimmed', n1?.note === 'warned in the event chat');
    check('notes: an empty note is refused rather than stored blank', (await repo.addAdminNote('adm-target', 'adm-mod', '   ')) === null);
    await repo.addAdminNote('adm-other', 'adm-mod', 'unrelated');
    check('notes: a note belongs to ONE account', (await repo.listAdminNotes('adm-target')).length === 1);
    // ⚠️ SCOPED BY USER AS WELL AS ID. A note id pasted from one account's panel must not be
    // able to delete another's row — the delete takes both, so a mistyped id is a no-op.
    check(
      'notes: deleting by id from the WRONG account does nothing',
      (await repo.deleteAdminNote('adm-other', n1!.id)) === false,
    );
    check('notes: ...and the note is still there', (await repo.listAdminNotes('adm-target')).length === 1);
    check('notes: deleting from the right account works', (await repo.deleteAdminNote('adm-target', n1!.id)) === true);

    // ---- the name resolver: the whole of the "(no profile)" fix ----------------------
    const names = await repo.profileNames(['adm-target', 'no-such-account']);
    check('names: a real account resolves to its handle', names.get('adm-target')?.handle === 'After The Rename');
    check('names: ...with its username', names.get('adm-target')?.username === 'targetplayer');
    // ⚠️ THE BIT THAT MATTERS. An account with auth and no `profiles` row is NOT "a name we
    // failed to look up" — it is a real state (the row is created lazily by `ensureProfile`
    // on the API routes a client hits, not when its socket authenticates), and the operator
    // view printed both as "(no profile)". `known` is what lets the UI say which it is.
    check('names: an account with no profile row is ABSENT, not a null handle', !names.has('no-such-account'));
    check('names: a resolved row says so explicitly', names.get('adm-target')?.known === true);
    check('names: an empty input costs no query', (await repo.profileNames([])).size === 0);
    await repo.syncStaffRoles('adm-mod', ['adm-mod']);
    check(
      'names: the staff role rides along, so the console can tell a colleague’s session apart',
      (await repo.profileNames(['adm-mod'])).get('adm-mod')?.role === 'owner',
    );

    // ---- the one-request user detail --------------------------------------------------
    await repo.submitReport({ reportedId: 'adm-target', reporterId: 'adm-other', reason: 'cheating', roomCode: 'r1' });
    await repo.submitReport({ reportedId: 'adm-target', reporterId: 'adm-mod', reason: 'afk', roomCode: 'r1' });
    await repo.submitReport({ reportedId: 'adm-other', reporterId: 'adm-target', reason: 'afk', roomCode: 'r2' });
    await repo.submitScoreReport({ reporterId: 'adm-target', roomCode: 'r3', detail: 'the score was wrong' });
    await repo.addAdminNote('adm-target', 'adm-mod', 'keep an eye on this one');

    const detail = await repo.adminUserDetail('adm-target');
    check('detail: the profile half', detail.known && detail.handle === 'After The Rename' && detail.username === 'targetplayer');
    check('detail: reports AGAINST, open and distinct reporters', detail.reportsAgainst.total === 2 && detail.reportsAgainst.open === 2 && detail.reportsAgainst.reporters === 2);
    // ⚠️ BOTH DIRECTIONS. "Reported twice" and "has filed forty reports of their own" are
    // opposite conclusions about the same person, and the console could only see the first.
    check('detail: reports FILED by them, which is how a report-button habit becomes visible', detail.reportsFiled.total === 1);
    check('detail: misscore claims they have filed', detail.scoreReportsFiled.total === 1);
    check('detail: their notes', detail.notes.length === 1);
    check('detail: their standing ledger is on the same read', Array.isArray(detail.standingEvents));
    check('detail: what has been done to them', detail.audit.some((a) => a.action === 'user.rename'));

    // AN ID WITH NO ACCOUNT STILL ANSWERS. That is the state somebody is looking at when they
    // arrive from a session that said it was signed in, and refusing it would hide exactly
    // the thing they came to see.
    const ghost = await repo.adminUserDetail('no-such-account');
    check('detail: an unknown account answers rather than erroring', ghost.userId === 'no-such-account');
    check('detail: ...and says it has no profile row', ghost.known === false && ghost.handle === null);

    // ---- the admin search ------------------------------------------------------------
    check(
      'search: a substring of the display name finds them',
      (await repo.searchProfiles('Rename')).some((r) => r.userId === 'adm-target'),
    );
    check(
      'search: an exact username finds them',
      (await repo.searchProfiles('targetplayer')).some((r) => r.userId === 'adm-target'),
    );
    check(
      'search: an exact account id finds them',
      (await repo.searchProfiles('adm-target')).some((r) => r.userId === 'adm-target'),
    );
    // ⚠️ THE SAME WILDCARD HOLE AS THE AUDIT SEARCH, and worse here: these rows carry the
    // membership and the staff role, so one character typed into the box used to enumerate
    // every account on the service.
    check('search: a bare wildcard matches nothing rather than everyone', (await repo.searchProfiles('%')).length === 0);
    // PAGING is tie-broken on `user_id` because `handle` is NOT unique — two people called
    // "Zzpager" have no stable order between pages without it, so one is shown twice and
    // another never at all. Which is why both of these share a handle exactly.
    await repo.ensureProfile('adm-page1', 'Zzpager');
    await repo.ensureProfile('adm-page2', 'Zzpager');
    const sp1 = await repo.searchProfiles('Zzpager', 1, 0);
    const sp2 = await repo.searchProfiles('Zzpager', 1, 1);
    check('search: a page is the size asked for', sp1.length === 1 && sp2.length === 1);
    check('search: two identically-named rows still page apart', sp1[0].userId !== sp2[0].userId);
    check('search: and the page after the last one is empty', (await repo.searchProfiles('Zzpager', 1, 2)).length === 0);

    /* ---- MODERATION CAPABILITIES (migration 0043 + the reads behind them) --------------
       The five things a moderator could not do before: suspend an account, take an abusive
       @username away, see the reports it FILED rather than only a count of them, flag a
       charged-back payment, and delete the account outright. Every one of them is a moderation
       surface, and three of the five are the kind whose failure is silent — a suspension that
       reads as lifted because the deadline passed, a cleared name that the audit row records
       as `null`, a refund flagged against a transaction nobody could find.
    */
    {
      await repo.ensureProfile('adm-susp', 'Suspendable');
      await repo.setUsername('adm-susp', 'suspendable');

      // ---- suspension is a DEADLINE, not a flag ------------------------------------
      check(
        'suspend: a fresh account is not suspended',
        (await repo.getSuspension('adm-susp')).until === null,
      );
      check(
        'suspend: an account that does not exist is not suspended either (the gate fails OPEN)',
        (await repo.getSuspension('nobody-at-all')).until === null,
      );
      const set = await repo.setSuspension('adm-susp', Date.now() + 7 * 86_400_000, 'griefing');
      check('suspend: setting one answers with the stored state', set !== null && set.until !== null);
      const live = await repo.getSuspension('adm-susp');
      check('suspend: ...and the door reads it back', live.until !== null && live.reason === 'griefing');
      check(
        'suspend: setting one against an id with no profile row answers null, not a silent no-op',
        (await repo.setSuspension('nobody-at-all', Date.now() + 86_400_000, 'x')) === null,
      );
      // ⚠️ AN EXPIRED DEADLINE IS "NOT SUSPENDED". This is the whole reason the column is a
      // timestamp: a suspension has to end by ARRIVING. A `getSuspension` that answered
      // "suspended, in the past" would keep somebody out for ever.
      await repo.setSuspension('adm-susp', Date.now() + 86_400_000, 'temporary');
      await db.query(`update profiles set suspended_until = now() - interval '1 hour' where user_id = 'adm-susp'`);
      check(
        'suspend: an expired deadline reads as not suspended, without anybody lifting it',
        (await repo.getSuspension('adm-susp')).until === null,
      );
      // ...and `setSuspension` refuses to store a deadline in the past rather than writing one
      // that is already expired, which would read as a suspension nobody can find the end of.
      const past = await repo.setSuspension('adm-susp', Date.now() - 1000, 'backdated');
      check('suspend: a past deadline stores as NOT suspended', past !== null && past.until === null);

      await repo.setSuspension('adm-susp', Date.now() + 5 * 86_400_000, 'cheating');
      const lifted = await repo.setSuspension('adm-susp', null, null);
      check('suspend: lifting clears the deadline', lifted !== null && lifted.until === null);
      // the REASON goes with it: a sentence left behind on an account that is no longer
      // suspended is a line the next moderator reads as current.
      check('suspend: ...and takes the reason with it', lifted !== null && lifted.reason === null);

      await repo.writeAudit({ adminId: 'adm-mod', action: 'account.suspend', targetUser: 'adm-susp', detail: { days: 7 }, note: 'griefing' });
      check(
        'suspend: the action is in the audit log',
        (await repo.listAudit({ action: 'account.suspend' })).rows[0]?.targetUser === 'adm-susp',
      );

      // ---- clearing an abusive @username -------------------------------------------
      const was = await repo.clearUsername('adm-susp');
      check('username: clearing answers with the name that was taken away', was === 'suspendable');
      check(
        'username: ...and the column really is null afterwards',
        (await repo.getProfile('adm-susp'))?.username == null,
      );
      check('username: clearing again answers null rather than pretending', (await repo.clearUsername('adm-susp')) === null);
      // the freed name is claimable again — by anybody, including them. A unique index that
      // still held it would make this a permanent seizure rather than a name-policy action.
      check('username: the freed name is available again', await repo.usernameAvailable('suspendable'));
      await repo.writeAudit({ adminId: 'adm-mod', action: 'user.username.clear', targetUser: 'adm-susp', detail: { from: was } });
      check(
        'username: the OLD name is in the audit row — it is the only remaining evidence',
        (await repo.listAudit({ action: 'user.username.clear' })).rows[0]?.detail.from === 'suspendable',
      );

      // ---- the reports an account FILED --------------------------------------------
      await repo.submitReport({ reportedId: 'adm-target', reporterId: 'adm-susp', reason: 'cheating', roomCode: 'iad-1', detail: 'wallhacks' });
      await repo.ensureProfile('adm-vanish', 'Will Be Deleted');
      await repo.submitReport({ reportedId: 'adm-vanish', reporterId: 'adm-susp', reason: 'afk', roomCode: 'iad-2' });
      const filed = await repo.listReportsBy('adm-susp');
      check('reports filed: both rows come back, newest first', filed.length === 2);
      // the SUBJECT's live handle, not a literal: `adm-target` is renamed by the audit block
      // above, and a test that pins the old name is asserting the order of two blocks.
      const subjectHandle = (await repo.getProfile('adm-target'))?.handle ?? null;
      check(
        'reports filed: each names its SUBJECT, which is the useful name when the filer is known',
        filed.some((r) => r.subjectId === 'adm-target' && r.subjectHandle === subjectHandle),
      );
      await repo.ensureProfile('adm-quiet', 'Never Reported Anyone');
      check('reports filed: an account that has filed nothing gets an empty list, not an error', (await repo.listReportsBy('adm-quiet')).length === 0);
      // ⚠️ A REPORT DIES WITH EITHER PARTY, and the filer's history is thinned by deletions
      // they had nothing to do with. `player_reports` cascades on BOTH `reported_id` and
      // `reporter_id` (0026), so a moderator reading "9 filed, 4 rejected" is reading what
      // SURVIVES, not what was filed. Pinned here because the number is used to judge a
      // person: it is a floor, never a total, and a future migration that softened either
      // foreign key would change what this panel means without changing a line of its code.
      // `listReportsBy` left-joins anyway, so the row would render with a null subject rather
      // than vanish a second time if that ever happens.
      await repo.deleteAccount('adm-vanish');
      check(
        'reports filed: a row is deleted with its SUBJECT — the filed count is a floor, not a total',
        (await repo.listReportsBy('adm-susp')).length === 1,
      );

      // ---- Ko-fi payments, and the chargeback flag ---------------------------------
      await repo.recordKofiPayment({
        messageId: 'msg-refund-1', kind: 'Donation', email: 'payer@example.test',
        transactionId: 'txn-refund-1', amount: '5.00', currency: 'USD',
        isSubscription: false, tierName: null, months: 1,
      });
      await db.query(`update kofi_payments set claimed_by = 'adm-susp', claimed_at = now() where message_id = 'msg-refund-1'`);
      const pays = await repo.listKofiPayments('adm-susp');
      check('payments: a claimed payment is listed against the account that claimed it', pays.length === 1);
      check('payments: ...with the TRANSACTION id, which is what the refund route is keyed by', pays[0]?.transactionId === 'txn-refund-1');
      // ⚠️ THE BUYER'S EMAIL IS NEVER PROJECTED. 0018 stores it to match a claim and says it is
      // never displayed; the admin console is not an exception to that.
      check('payments: the buyer email is not in the row', !('email' in (pays[0] ?? {})));
      check('payments: not yet charged back', pays[0]?.refundedAt === null);
      check('payments: flagging one takes', await repo.refundKofiPayment('txn-refund-1'));
      check('payments: ...and shows on the row', (await repo.listKofiPayments('adm-susp'))[0]?.refundedAt !== null);
      check('payments: flagging it twice answers false rather than re-stamping it', !(await repo.refundKofiPayment('txn-refund-1')));

      // ---- and all of it reaches the one request the panel actually makes -----------
      await repo.setSuspension('adm-susp', Date.now() + 3 * 86_400_000, 'final warning');
      const detail = await repo.adminUserDetail('adm-susp');
      check('user detail: carries the live suspension', detail.suspension.until !== null && detail.suspension.reason === 'final warning');
      check('user detail: carries the reports filed', detail.reportsFiledList.length === 1);
      check('user detail: carries the payments', detail.payments.length === 1);
      check(
        'user detail: and the reports AGAINST, which the counts alone could not explain',
        detail.reportsAgainstList.length === (await repo.listReportsFor('adm-susp')).length,
      );
    }

    // ---- account deletion sweeps the notes, and deliberately NOT the audit -------------
    await repo.deleteAccount('adm-other');
    check('notes: a deleted account takes its notes with it (the FK cascades)', (await repo.listAdminNotes('adm-other')).length === 0);
    check(
      'audit: ...but the audit log outlives the account it names, which is the point of it',
      (await repo.listAudit({ targetUser: 'adm-target' })).rows.length > 0,
    );
  }


  // ---- SEASON AWARDS (0045) ------------------------------------------------------------
  /**
   * The checks `docs/rewards-round2-plan.md` §7 asks for by name. The one that matters
   * most is IDEMPOTENCY: a season roll is a thing an admin can press twice, and the whole
   * defence is 0045's unique slot index plus `on conflict do nothing`.
   */
  {
    await repo.ensureProfile('aw-1', 'Champ');
    await repo.ensureProfile('aw-2', 'Runner');

    const GAME = 'decode' as const;
    // A season with no boards behind it still rolls, and awards nothing. That is the
    // ordinary case on a fresh install and it must not throw.
    const before = await repo.startNewSeason(1, 'awards-a', false, GAME);
    check('awards: a season with empty boards still rolls', typeof before.season === 'number');
    check('awards: ...and mints nothing', (await repo.userAwards('aw-1')).length === 0);

    // Mint a slot by hand. 0048 RETIRED this table — nothing writes it now — so what is under
    // test HERE is that the rows it already holds keep their contract and stay in the trophy case.
    const mint = async (rank: number, user: string) =>
      db.query(
        `insert into season_awards (game, balance_version, act, kind, mode, drivetrain, rank, user_id, score)
         values ($1, $2, $3, 'ranked', '1v1', null, $4, $5, 1500) on conflict do nothing`,
        [GAME, before.season, 0, rank, user],
      );
    await mint(1, 'aw-1');
    await mint(2, 'aw-2');
    check('awards: two ranks, two holders', (await repo.userAwards('aw-1')).length === 1 && (await repo.userAwards('aw-2')).length === 1);

    // ⚠️ THE SAME SLOT TWICE IS ONE ROW. This is what makes a retried close safe.
    await mint(1, 'aw-1');
    check('⚠️ awards: re-minting the same slot is a no-op (the unique slot index)', (await repo.userAwards('aw-1')).length === 1);

    // ...but a DUO slot legitimately holds two people, which is why `user_id` is in it.
    await db.query(
      `insert into season_awards (game, balance_version, act, kind, mode, drivetrain, rank, user_id, score)
       values ($1, $2, 0, 'record_overall', 'duo', null, 1, $3, 900),
              ($1, $2, 0, 'record_overall', 'duo', null, 1, $4, 900) on conflict do nothing`,
      [GAME, before.season, 'aw-1', 'aw-2'],
    );
    const duo = await db.query<{ n: number }>(
      `select count(*)::int as n from season_awards where kind = 'record_overall' and mode = 'duo' and rank = 1`,
    );
    check('⚠️ awards: a DUO rank decorates BOTH members, not whichever one inserted first', Number(duo.rows[0].n) === 2);

    // a retired award stays on show: the trophy case reads it (titles, which it once made
    // wearable, went in 0049)
    const case1 = (await repo.getUserStats('aw-1', before.season, GAME)).awards ?? [];
    check('awards: a retired award stays in the trophy case', case1.some((x) => x.kind === 'ranked' && x.rank === 1), JSON.stringify(case1));

    // the FK cascades — an award decorates a name, so with no name there is nothing left
    await repo.deleteAccount('aw-2');
    const left = await db.query<{ n: number }>(`select count(*)::int as n from season_awards where user_id = 'aw-2'`);
    check('awards: a deleted account takes its awards with it (the FK cascades, no deleteAccount line needed)', Number(left.rows[0].n) === 0);
  }


  // ---- THE REWARD LEDGER + THE COMPETITIVE AWARD JOB (0048) -------------------------
  /**
   * Owner, 2026-09-22: ranked TOP 3 of 1v1 and 2v2 at the end of every ACT (the prestigious
   * one: a gold/silver/bronze podium badge), and at the end of every SEASON the record board's
   * overall TOP 3 and each drivetrain's #1 (the Record Holder badge; each placement is a
   * trophy-case row off the grant's reason) — never Act 0, paid for every past period NOW and automatically from here
   * on, and never silently: every grant waits to be CLAIMED.
   *
   * The world below is built by hand on `chain` at balance versions far above anything the
   * rest of this suite writes, so the job's inputs are exactly these rows:
   *   bv 901  Act 0             ← the beta: its boards must pay NOTHING
   *   bv 902  Act 1 · Season 1
   *   bv 903  Act 1 · Season 2
   *   bv 904  Act 2 · Season 1  ← closed season in the CURRENT act: records pay, ranked not
   *   bv 905  Act 2 · Season 2  ← live: pays nothing
   */
  {
    const G = 'chain' as const;
    for (const u of ['rw-a', 'rw-b', 'rw-c', 'rw-d', 'rw-e', 'rw-z', 'rw-s']) await repo.ensureProfile(u, u.toUpperCase());
    for (const [bv, act] of [[901, 0], [902, 1], [903, 1], [904, 2], [905, 2]] as const) {
      await db.query(
        `insert into seasons (game, balance_version, act, active) values ($1, $2, $3, $4)
         on conflict (game, balance_version) do update set act = excluded.act, active = excluded.active`,
        [G, bv, act, bv === 905],
      );
    }
    await db.query(`update seasons set active = false where game = $1 and balance_version <> 905`, [G]);
    const elo = (u: string, mode: '1v1' | '2v2', act: number, rating: number, games: number) =>
      db.query(`insert into elo_ratings (user_id, mode, game, act, rating, rd, vol, games) values ($1, $2, $3, $4, $5, 80, 0.06, $6)`,
        [u, mode, G, act, rating, games]);
    await elo('rw-z', '1v1', 0, 2400, 40); // ACT 0 — must earn nothing
    await elo('rw-a', '1v1', 1, 1800, 20);
    await elo('rw-b', '1v1', 1, 1700, 15); // ⚠️ an EXACT tie with rw-c on rating AND games…
    await elo('rw-c', '1v1', 1, 1700, 15); // …decided by user id, the way the board decides it
    await elo('rw-d', '1v1', 1, 1600, 30); // 4th — off the podium
    await elo('rw-e', '1v1', 1, 2500, 2); // highest rating of all, but UNPLACED: not on the board
    await elo('rw-a', '2v2', 1, 1500, 12);
    await elo('rw-d', '1v1', 2, 3000, 30); // the LIVE act: not closed, pays nothing
    const rec = (u: string, bv: number, dt: string, score: number, at: string) =>
      db.query(`insert into records (user_id, mode, drivetrain, score, balance_version, game, created_at) values ($1, 'solo', $2, $3, $4, $5, $6)`,
        [u, dt, score, bv, G, at]);
    await rec('rw-z', 901, 'mecanum', 999, '2026-01-01T00:00:00Z'); // Act 0 season
    await rec('rw-a', 902, 'mecanum', 300, '2026-02-01T00:00:00Z');
    await rec('rw-b', 902, 'tank', 280, '2026-02-01T00:00:00Z');
    await rec('rw-c', 902, 'mecanum', 250, '2026-02-01T00:00:00Z'); // ⚠️ ties rw-d on score but set it FIRST…
    await rec('rw-d', 902, 'swerve', 250, '2026-02-02T00:00:00Z'); // …so rw-d is 4th overall, #1 swerve only
    await rec('rw-e', 902, 'xdrive', 100, '2026-02-01T00:00:00Z');
    await rec('rw-a', 903, 'mecanum', 310, '2026-03-01T00:00:00Z'); // a second season: the counter's case
    await rec('rw-b', 905, 'tank', 999, '2026-05-01T00:00:00Z'); // the LIVE season
    // a record 0045 already awarded (the legacy table), to prove the job does not double it
    await db.query(
      `insert into season_awards (game, balance_version, act, season_no, kind, mode, drivetrain, rank, user_id, score)
       values ($1, 902, 1, 1, 'record_overall', 'solo', null, 1, 'rw-a', 300)`,
      [G],
    );

    const first = await repo.runRewardJob({ games: [G] });
    check('job: the first run pays the closed periods', first.grants > 0, JSON.stringify(first));
    const again = await repo.runRewardJob({ games: [G] });
    check('⚠️ job: a SECOND run pays nothing — every boot on every machine runs it', again.grants === 0 && again.periods === 0, JSON.stringify(again));
    const periods = await db.query<{ board: string; period: number }>(
      `select board, period from reward_periods where game = $1 and period between 0 and 999 order by board, period`, [G],
    );
    const paid = periods.rows.map((p) => `${p.board}:${p.period}`);
    check('job: it marked exactly the closed periods it paid', paid.includes('ranked_act:1') && paid.includes('record_season:902') && paid.includes('record_season:903') && paid.includes('record_season:904'), paid.join(' '));
    check('⚠️ job: ACT 0 is never paid — neither its ladder nor its seasons', !paid.includes('ranked_act:0') && !paid.includes('record_season:901'), paid.join(' '));
    check('job: the LIVE act and the LIVE season are not closed, so not paid', !paid.includes('ranked_act:2') && !paid.includes('record_season:905'), paid.join(' '));
    check('⚠️ job: the Act 0 leader got nothing', (await repo.pendingRewards('rw-z')).length === 0);

    const pend = async (u: string) => (await repo.pendingRewards(u)).sort((x, y) => (x.createdAt < y.createdAt ? -1 : 1));
    const ranked = async (u: string, mode: string) =>
      (await pend(u)).find((p) => p.reason.kind === 'ranked_act' && p.reason.mode === mode && p.reason.act === 1);
    const a1 = await ranked('rw-a', '1v1');
    const b1 = await ranked('rw-b', '1v1');
    const c1 = await ranked('rw-c', '1v1');
    check('job: 1v1 #1 is the top rating', a1?.reason.kind === 'ranked_act' && a1.reason.rank === 1, JSON.stringify(a1?.reason));
    check('⚠️ job: an exact tie is decided by the board\'s own order (user id last) — rw-b #2, rw-c #3',
      b1?.reason.kind === 'ranked_act' && b1.reason.rank === 2 && c1?.reason.kind === 'ranked_act' && c1.reason.rank === 3);
    check('job: the podium is three — #4 gets nothing', !(await ranked('rw-d', '1v1')));
    check('⚠️ job: an UNPLACED player is not on the board, so not on the podium', !(await ranked('rw-e', '1v1')));
    check('job: 2v2 is its own ladder with its own podium', (await ranked('rw-a', '2v2'))?.reason.kind === 'ranked_act');
    check('⚠️ job: a podium grant carries the metal badge and NOTHING else — no title (0049)',
      !!a1 && a1.items.length === 1 && a1.items[0].kind === 'badge' && a1.items[0].id === 'ranked-gold',
      JSON.stringify(a1?.items));
    check('job: silver and bronze by placement', !!b1?.items.some((i) => i.id === 'ranked-silver') && !!c1?.items.some((i) => i.id === 'ranked-bronze'));

    const recOf = async (u: string, bv: number) =>
      (await pend(u)).find((p) => p.reason.kind === 'record_season' && p.reason.balanceVersion === bv);
    const aRec = await recOf('rw-a', 902);
    const dRec = await recOf('rw-d', 902);
    const cRec = await recOf('rw-c', 902);
    check('job: the overall #1 is also #1 of their drivetrain — two placements, ONE grant, ONE badge',
      aRec?.reason.kind === 'record_season' && aRec.reason.placements.length === 2 &&
        aRec.items.length === 1 && aRec.items[0].kind === 'badge' && aRec.items[0].id === 'record-holder',
      JSON.stringify(aRec));
    check('⚠️ job: per-drivetrain #1 — 4th overall on score, but the best swerve run',
      dRec?.reason.kind === 'record_season' && dRec.reason.placements.length === 1 && dRec.reason.placements[0].board === 'swerve',
      JSON.stringify(dRec?.reason));
    check('⚠️ job: a tied score goes to whoever set it FIRST — rw-c is #3 overall, rw-d is not',
      cRec?.reason.kind === 'record_season' && cRec.reason.placements.some((p) => p.board === 'overall' && p.rank === 3),
      JSON.stringify(cRec?.reason));
    check('job: a closed season in the CURRENT act still pays its records (bv 904 had none, so nobody)', !(await recOf('rw-a', 904)));
    check('job: the live season pays nothing', !(await recOf('rw-b', 905)));

    // ---- pending → claimed → equipped ------------------------------------------------
    check('⚠️ pending: an unclaimed badge does not count', Object.keys(await repo.badgeCounts('rw-a')).length === 0);
    check('pending: ...and cannot be worn', (await repo.setEquippedBadges('rw-a', ['ranked-gold'])) === null);
    const claimed = await repo.claimReward('rw-a', a1!.id, false);
    check('claim: CLAIM counts the badge', claimed?.badges['ranked-gold'] === 1, JSON.stringify(claimed?.badges));
    check('claim: ...but plain Claim wears nothing', !!claimed && claimed.equippedBadges.length === 0);
    check('claim: the reward state carries no title fields (0049)', !!claimed && !('title' in claimed) && !('earnedTitles' in claimed));
    const twice = await repo.claimReward('rw-a', a1!.id, false);
    check('claim: claiming twice (two tabs, a double click) delivers nothing twice', twice?.badges['ranked-gold'] === 1);
    check('claim: somebody else\'s grant is not yours to claim', (await repo.claimReward('rw-b', a1!.id, true)) === null);
    const eq = await repo.claimReward('rw-a', (await ranked('rw-a', '2v2'))!.id, true);
    check('⚠️ equip now: CLAIMS AND WEARS the badge, with its COUNTER — two golds', eq?.equippedBadges.length === 1 && eq.equippedBadges[0].id === 'ranked-gold' && eq.equippedBadges[0].n === 2,
      JSON.stringify(eq?.equippedBadges));
    // jsonb re-orders an object's keys, so the projection is compared by VALUE, not by its text
    const goldTimes2 = (v: unknown): boolean =>
      Array.isArray(v) && v.length === 1 && (v[0] as { id?: string }).id === 'ranked-gold' && Number((v[0] as { n?: number }).n) === 2;
    const wearing = await db.query<{ equipped_badges: unknown }>(`select equipped_badges from profiles where user_id = 'rw-a'`);
    check('equip now: the projection on profiles is what the boards will ship', goldTimes2(wearing.rows[0].equipped_badges),
      JSON.stringify(wearing.rows[0].equipped_badges));

    // ---- the badge counter: a second season's record award raises it, never adds a badge
    const r902 = await repo.claimReward('rw-a', aRec!.id, true);
    check('counter: the record grant wears its badge beside the gold', r902?.equippedBadges.map((b) => b.id).join(',') === 'ranked-gold,record-holder',
      JSON.stringify(r902?.equippedBadges));
    const r903 = await repo.claimReward('rw-a', (await recOf('rw-a', 903))!.id, true);
    check('⚠️ counter: earning the SAME badge again INCREMENTS it — Record Holder ×2', r903?.badges['record-holder'] === 2, JSON.stringify(r903?.badges));
    check('counter: ...and the worn copy shows the new count, not a second badge',
      r903?.equippedBadges.filter((b) => b.id === 'record-holder').length === 1 && r903.equippedBadges.find((b) => b.id === 'record-holder')?.n === 2,
      JSON.stringify(r903?.equippedBadges));
    const stats = await repo.getUserStats('rw-a', 905, G);
    check('trophy case: the profile lists the claimed awards once each, legacy included',
      (stats.awards ?? []).filter((x) => x.kind === 'record_overall' && x.balanceVersion === 902).length === 1 &&
        (stats.awards ?? []).some((x) => x.kind === 'ranked_act' && x.act === 1 && x.mode === '1v1'),
      JSON.stringify(stats.awards?.map((x) => `${x.kind}:${x.balanceVersion}:${x.mode}:${x.rank}`)));
    check('trophy case: ...and every badge with its count', stats.badgeCounts?.['record-holder'] === 2 && stats.badgeCounts?.['ranked-gold'] === 2);

    // ---- equipping badges is validated on the server ---------------------------------------
    check('badges: wearing one you hold takes', (await repo.setEquippedBadges('rw-a', ['record-holder']))?.length === 1);
    check('⚠️ badges: one you do NOT hold is refused', (await repo.setEquippedBadges('rw-a', ['ranked-silver'])) === null);
    check('badges: an unknown id is refused', (await repo.setEquippedBadges('rw-a', ['self-made'])) === null);
    check('badges: a duplicate is refused', (await repo.setEquippedBadges('rw-a', ['record-holder', 'record-holder'])) === null);
    check('badges: more than three is refused', (await repo.setEquippedBadges('rw-a', ['ranked-gold', 'record-holder', 'ranked-silver', 'ranked-bronze'])) === null);
    check('badges: an empty list clears them', (await repo.setEquippedBadges('rw-a', []))?.length === 0);
    const board = await repo.eloLeaderboard({ mode: '1v1', act: 1, game: G });
    await repo.setEquippedBadges('rw-a', ['ranked-gold']);
    const board2 = await repo.eloLeaderboard({ mode: '1v1', act: 1, game: G });
    const rowA = board2.find((x) => x.userId === 'rw-a') as unknown as { badges?: unknown };
    check('⚠️ badges: every board row carries the worn badges (badgeCols), counter included',
      board.length > 0 && goldTimes2(rowA?.badges), JSON.stringify(rowA?.badges));
    check('badges: ...and the room join reads them off the profile', goldTimes2((await repo.getProfile('rw-a'))?.badges));

    // ---- a silent source is silent, and only a silent source is ----------------------------
    const silent = await repo.grantReward({
      userId: 'rw-s', key: 'legacy:test', source: 'legacy', reason: { kind: 'other', note: 'test' },
      items: [{ kind: 'badge', id: 'record-holder' }],
    });
    check('⚠️ silent: a source marked silent IN CODE is applied at once', silent === 'created' && (await repo.badgeCounts('rw-s'))['record-holder'] === 1);
    check('⚠️ silent: ...and never reaches the claim dialog', (await repo.pendingRewards('rw-s')).length === 0);
    check('silent: every OTHER source is pending by default', Object.entries(repo.REWARD_SOURCES).every(([k, v]) => v.silent === (k === 'legacy')));
    check('grant: an item outside every closed set is dropped, and a grant of nothing refused',
      (await repo.grantReward({ userId: 'rw-s', key: 'x', source: 'ranked_act', reason: { kind: 'other' }, items: [{ kind: 'badge', id: 'fake' as never }] })) === 'refused');

    // ---- what was handed out BEFORE the ledger survives it, and survives 0049 ------------------
    /* An account that already held the star reward in `profiles.cosmetics` and was WEARING the
       title when 0048 landed. 0048 imports it as a claimed, SILENT grant — showing a "you earned
       this" for a thing already worn would be the dialog lying the other way. 0049 then turns
       the title into the `stargazer` badge and WEARS it, because the player was wearing it.
       Re-running both migrations' SQL is safe by design, which is also what proves it. */
    await repo.ensureProfile('rw-old', 'Old');
    await db.query(`update profiles set cosmetics = '["title:stargazer","decal:star"]'::jsonb, title = 'title:stargazer' where user_id = 'rw-old'`);
    await db.exec(readFileSync(join(ROOT, 'server/db/migrations/0048_reward_grants.sql'), 'utf8'));
    const imported = await db.query<{ silent: boolean; claimed: boolean }>(
      `select silent, claimed_at is not null as claimed from reward_grants where user_id = 'rw-old' and grant_key = 'stargazer'`,
    );
    check('⚠️ legacy: a reward given before the ledger is imported CLAIMED and SILENT — no dialog for a thing already worn',
      imported.rows.length === 1 && imported.rows[0].silent && imported.rows[0].claimed && (await repo.pendingRewards('rw-old')).length === 0,
      JSON.stringify(imported.rows));

    /* 0049's other cases, staged as they would stand before it ran: somebody wearing an act
       podium title they hold the badge for, somebody wearing a RETIRED per-season title (0045 —
       it never came with a badge), and a PENDING grant still carrying a title item. rw-a already
       holds ranked-gold ×2; its worn list is emptied so there is room. */
    await db.query(`update profiles set title = 'award:chain:act1:ranked_act:1v1:1', equipped_badges = '[]'::jsonb where user_id = 'rw-a'`);
    await repo.ensureProfile('rw-t45', 'Retired');
    await db.query(`update profiles set title = 'award:decode:5:ranked:1v1:1' where user_id = 'rw-t45'`);
    await db.query(
      `insert into reward_grants (user_id, grant_key, source, reason, items)
       values ('rw-t45', 'old:pending', 'ranked_act', '{"kind":"other"}'::jsonb,
               '[{"kind":"title","id":"award:decode:act1:ranked_act:1v1:1"},{"kind":"badge","id":"ranked-gold"}]'::jsonb)`,
    );
    const m49 = readFileSync(join(ROOT, 'server/db/migrations/0049_titles_to_badges.sql'), 'utf8');
    await db.exec(m49);
    await db.exec(m49); // twice: every statement must be a no-op the second time

    const oldRow = await db.query<{ title: string | null; cosmetics: string[]; equipped_badges: unknown }>(
      `select title, cosmetics, equipped_badges from profiles where user_id = 'rw-old'`,
    );
    const oldGrant = await db.query<{ items: unknown }>(`select items from reward_grants where user_id = 'rw-old' and grant_key = 'stargazer'`);
    check('⚠️ 0049: the star grant delivers the stargazer BADGE (and still the decal), no title',
      JSON.stringify(oldGrant.rows[0].items) === JSON.stringify([{ id: 'stargazer', kind: 'badge' }, { id: 'decal:star', kind: 'cosmetic' }]),
      JSON.stringify(oldGrant.rows[0].items));
    check('⚠️ 0049: the star\'s title leaves the inventory, the decal stays',
      !oldRow.rows[0].cosmetics.includes('title:stargazer') && oldRow.rows[0].cosmetics.includes('decal:star'), JSON.stringify(oldRow.rows[0].cosmetics));
    check('⚠️ 0049: whoever WORE the stargazer title now wears the badge — once, after two runs',
      JSON.stringify(oldRow.rows[0].equipped_badges) === JSON.stringify([{ n: 1, id: 'stargazer' }]), JSON.stringify(oldRow.rows[0].equipped_badges));
    check('0049: ...and the badge counts off the rewritten grant', (await repo.badgeCounts('rw-old')).stargazer === 1);
    check('0049: nobody wears a title any more', Number((await db.query<{ n: number }>(`select count(*)::int as n from profiles where title is not null`)).rows[0].n) === 0);
    const aRow = await repo.getProfile('rw-a');
    check('⚠️ 0049: a podium title\'s wearer wears its badge, with the real count',
      aRow?.badges?.length === 1 && aRow.badges[0].id === 'ranked-gold' && aRow.badges[0].n === 2, JSON.stringify(aRow?.badges));
    check('0049: a retired per-season title, which never had a badge, maps to nothing',
      ((await repo.getProfile('rw-t45'))?.badges ?? []).length === 0);
    const oldPending = await db.query<{ items: unknown }>(`select items from reward_grants where user_id = 'rw-t45' and grant_key = 'old:pending'`);
    check('⚠️ 0049: a PENDING grant loses its title item and keeps its badge',
      JSON.stringify(oldPending.rows[0].items) === JSON.stringify([{ id: 'ranked-gold', kind: 'badge' }]), JSON.stringify(oldPending.rows[0].items));
    check('legacy: ...and the 0048 import re-runs cleanly (one row, not two)', Number((await db.query<{ n: number }>(
      `select count(*)::int as n from reward_grants where user_id = 'rw-old'`)).rows[0].n) === 1);

    // ---- a roll pays automatically, through the same job ------------------------------------
    await repo.startNewSeason(905, 'rw-roll', true, G); // closes Season 905 AND Act 2
    const afterRoll = await db.query<{ board: string; period: number }>(
      `select board, period from reward_periods where game = $1 and ((board = 'ranked_act' and period = 2) or (board = 'record_season' and period = 905))`, [G],
    );
    check('⚠️ rollover: an ACT roll pays the closed act and its last season, automatically', afterRoll.rows.length === 2, JSON.stringify(afterRoll.rows));
    check('rollover: ...rw-d, alone on the Act 2 ladder, is its champion', !!(await ranked('rw-d', '1v1')) === false && (await pend('rw-d')).some((p) => p.reason.kind === 'ranked_act' && p.reason.act === 2 && p.reason.rank === 1));
    check('rollover: ...and rw-b\'s live-season run is paid now that the season closed', !!(await recOf('rw-b', 905)));

    // ---- account deletion takes the ledger with it -------------------------------------------
    await repo.deleteAccount('rw-c');
    const gone = await db.query<{ n: number }>(`select count(*)::int as n from reward_grants where user_id = 'rw-c'`);
    check('⚠️ delete: a deleted account takes its rewards with it (the FK cascades)', Number(gone.rows[0].n) === 0);
    check('delete: ...and nothing more is minted for it on the next run', (await repo.runRewardJob({ games: [G] })).grants === 0);
  }


  // ---- AN ARCHIVED SEASON'S BOARD IS THE SOLVE IT WAS PLAYED ON (owner, 2026-09-24) -----
  /**
   * BIOBUZZ Act 1 was a 2D season. With the era decided per GAME, the 3D cutover read it as
   * `'3d'`: its board came back empty and the roll into Act 2 claimed its record awards with
   * zero winners, for good. Built on `biobuzz` at balance versions nothing else writes:
   *   bv 951  Act 1 · Season 1  ← closed, 2D rows plus one 3D straggler (a run set between the
   *                                deploy and the roll)
   *   bv 952  Act 2 · Season 1  ← live
   */
  {
    const G = 'biobuzz' as const;
    for (const u of ['era-a', 'era-b', 'era-c', 'era-x']) await repo.ensureProfile(u, u.toUpperCase());
    for (const [bv, act] of [[951, 1], [952, 2]] as const) {
      await db.query(
        `insert into seasons (game, balance_version, act, active) values ($1, $2, $3, $4)
         on conflict (game, balance_version) do update set act = excluded.act, active = excluded.active`,
        [G, bv, act, bv === 952],
      );
    }
    await db.query(`update seasons set active = false where game = $1 and balance_version <> 952`, [G]);
    const rec = (u: string, bv: number, score: number, physics: '2d' | '3d') =>
      db.query(`insert into records (user_id, mode, drivetrain, score, balance_version, game, physics) values ($1, 'solo', 'mecanum', $2, $3, $4, $5)`,
        [u, score, bv, G, physics]);
    await rec('era-a', 951, 300, '2d');
    await rec('era-b', 951, 250, '2d');
    await rec('era-c', 951, 200, '2d');
    await rec('era-x', 951, 999, '3d'); // the straggler: highest score, wrong era
    await rec('era-a', 952, 120, '3d');
    await rec('era-b', 952, 500, '2d'); // cannot happen through submitRecord; the live board must not show it anyway

    check('era: the live BIOBUZZ season is 3D', (await repo.boardPhysics(G, 952)) === '3d');
    check('⚠️ era: an archived BIOBUZZ season is the solve most of its runs were played on', (await repo.boardPhysics(G, 951)) === '2d');
    check('era: a one-solve game has no era filter, live or archived', (await repo.boardPhysics('decode', 1)) === undefined);

    const old = await repo.recordLeaderboard({ mode: 'solo', balanceVersion: 951, game: G });
    check('⚠️ era: the archived Act 1 board shows its 2D runs', old.map((r) => r.userId).join(',') === 'era-a,era-b,era-c',
      old.map((r) => `${r.userId}:${r.score}:${String(r.physics)}`).join(','));
    const live = await repo.recordLeaderboard({ mode: 'solo', balanceVersion: 952, game: G });
    check('era: the live board is still 3D only', live.length === 1 && live[0].userId === 'era-a' && live[0].physics === '3d',
      live.map((r) => `${r.userId}:${String(r.physics)}`).join(','));
    check('era: a personal best on the archived season reads its own era', (await repo.personalBest('era-x', 'solo', 'overall', 951, G)) === null);
    check('era: ...and so does the rank', (await repo.recordRank('era-c', 'solo', 'overall', 951, G)).rank === 3);

    await repo.runRewardJob({ games: [G] });
    const period = await db.query<{ winners: number }>(
      `select winners from reward_periods where game = $1 and board = 'record_season' and period = 951`, [G],
    );
    check('⚠️ era: the closed 2D season pays its record holders instead of claiming zero winners',
      Number(period.rows[0]?.winners) === 3, JSON.stringify(period.rows));
    const paidTo = async (u: string) =>
      (await repo.pendingRewards(u)).some((p) => p.reason.kind === 'record_season' && p.reason.balanceVersion === 951);
    check('era: ...its #1 is paid', await paidTo('era-a'));
    check('⚠️ era: ...and the 3D straggler is not', !(await paidTo('era-x')));
  }


  // ---- PROVIDER LINKS + THE STAR SWEEP (0047) --------------------------------------
  /**
   * The anti-farm and the fail-safe. `docs/rewards-round2-plan.md` §3.1/§6 asks for both by
   * name, and the fail-safe is the one that was written before the code.
   */
  {
    await repo.ensureProfile('gh-1', 'Star');
    await repo.ensureProfile('gh-2', 'Other');

    check('links: linking an account takes', (await repo.linkProvider('gh-1', 'github', '1001')) === true);
    check('links: ...and it shows up as live', (await repo.providerLinks('gh-1')).length === 1);
    check('links: re-linking the SAME pair is fine (somebody undoing their own mistake)', (await repo.linkProvider('gh-1', 'github', '1001')) === true);
    check(
      '⚠️ links: the SAME external account cannot be linked to a SECOND DSIM account',
      (await repo.linkProvider('gh-2', 'github', '1001')) === false,
    );

    // the sweep grants to a linked stargazer and not to anybody else
    let r = await repo.sweepStargazers(['1001'], true);
    check('star sweep: a linked stargazer is granted', r.applied && r.granted.includes('gh-1'), JSON.stringify(r));
    /* ⚠️ GRANTED IS NOT GIVEN (0048). The sweep creates a PENDING reward and delivers nothing:
       the badge does not count and the decal is not unlocked until the player claims it
       through the dialog — "titles should not ever silently get added" (owner, 2026-09-22). */
    const starPending = (await repo.pendingRewards('gh-1')).find((p) => p.source === 'stargazer');
    check('⚠️ star sweep: ...as a PENDING reward, not a silent write', !!starPending, JSON.stringify(await repo.pendingRewards('gh-1')));
    check('⚠️ star sweep: ...and a pending reward delivers NOTHING yet — no badge',
      !(await repo.badgeCounts('gh-1'))[repo.STARGAZER_BADGE]);
    check('star sweep: the pending reward is the stargazer BADGE and the decal (0049)',
      (starPending?.items ?? []).map((i) => `${i.kind}:${i.id}`).join() === repo.STARGAZER_ITEMS.map((i) => `${i.kind}:${i.id}`).join(),
      JSON.stringify(starPending?.items));
    const unlockedEarly = await db.query<{ cosmetics: string[] }>(`select cosmetics from profiles where user_id = 'gh-1'`);
    check('⚠️ star sweep: ...and no decal', !(unlockedEarly.rows[0].cosmetics ?? []).includes(repo.STARGAZER_DECAL));
    await repo.claimReward('gh-1', starPending!.id, false);
    check('star sweep: once CLAIMED it holds the badge', (await repo.badgeCounts('gh-1'))[repo.STARGAZER_BADGE] === 1);
    check('star sweep: ...and a claimed reward leaves the pending queue', (await repo.pendingRewards('gh-1')).length === 0);
    /**
     * ⚠️ **THE STAR GRANTS A BADGE AND A DECAL AND THEY MUST MOVE TOGETHER** (owner,
     * 2026-09-21: the star should carry a cosmetic, not only a mark on a name). Half a reward
     * is a state no later sweep repairs. Both ride ONE grant (`STARGAZER_ITEMS`), and these
     * checks are what stop the two drifting apart.
     */
    const cosmOf = async (u: string): Promise<string[]> => {
      const rows = await db.query<{ cosmetics: unknown }>(`select cosmetics from profiles where user_id = $1`, [u]);
      const c = rows.rows[0]?.cosmetics;
      return Array.isArray(c) ? (c as string[]) : Object.keys((c as Record<string, unknown>) ?? {});
    };
    const held = await cosmOf('gh-1');
    check('⚠️ star sweep: ...and the COSMETIC too — both, or the reward is half granted',
      held.includes(repo.STARGAZER_DECAL), JSON.stringify(held));
    check('star sweep: the badge is never written into the cosmetics inventory', !held.some((id) => id.includes('stargazer')), JSON.stringify(held));
    check('...and the cosmetic it grants is `earned` tier, NOT a supporter fill given away free',
      cosmeticTier(repo.STARGAZER_DECAL as CosmeticId) === 'earned', repo.STARGAZER_DECAL);
    r = await repo.sweepStargazers(['1001'], true);
    check('star sweep: a second identical sweep grants nothing new (grantCosmetic is idempotent)', r.granted.length === 0 && r.revoked.length === 0);

    // ⚠️ THE FAIL-SAFE. A fetch that did not finish must change NOTHING — with revocation
    // on, the same failure that used to mean "no grants this cycle" would otherwise strip
    // the badge from every holder at once.
    r = await repo.sweepStargazers([], false);
    check(
      '⚠️ star sweep: an INCOMPLETE fetch revokes nobody and grants nobody',
      r.applied === false && r.revoked.length === 0 && r.granted.length === 0,
    );
    check('⚠️ star sweep: ...and the badge is still held after it', (await repo.badgeCounts('gh-1'))[repo.STARGAZER_BADGE] === 1);

    // unstarring revokes (owner ruling 2026-09-21) — and takes the WORN badge off the name
    const wearing = await repo.setEquippedBadges('gh-1', [repo.STARGAZER_BADGE]);
    check('star sweep: the badge can be worn before it is taken away', wearing?.[0]?.id === repo.STARGAZER_BADGE, JSON.stringify(wearing));
    r = await repo.sweepStargazers([], true);
    check('⚠️ star sweep: unstarring REVOKES (owner, 2026-09-21)', r.applied && r.revoked.includes('gh-1'), JSON.stringify(r));
    check('star sweep: ...the ledger no longer counts it', !(await repo.badgeCounts('gh-1'))[repo.STARGAZER_BADGE]);
    /* ⚠️ BOTH, the other way. The grant side is checked above; an asymmetry here is the one
       that LASTS — a revoke that took the badge and left the decal leaves an account holding a
       reward it no longer qualifies for, and the sweep reads the decal as "already holds it",
       so no later sweep would ever look at it again. */
    const leftOver = await cosmOf('gh-1');
    check('⚠️ star sweep: ...and the COSMETIC went with it — a half-revoke is permanent',
      !leftOver.includes(repo.STARGAZER_DECAL), JSON.stringify(leftOver));
    check('⚠️ star sweep: ...and the WORN badge came off the name, not left dangling',
      ((await repo.getProfile('gh-1'))?.badges ?? []).length === 0, JSON.stringify((await repo.getProfile('gh-1'))?.badges));
    // a RE-STAR re-opens the SAME grant — the key stays spoken for, so it is never a second row
    r = await repo.sweepStargazers(['1001'], true);
    const starRows = await db.query<{ n: number }>(`select count(*)::int as n from reward_grants where user_id = 'gh-1' and grant_key = 'stargazer'`);
    check('star sweep: a re-star re-opens the reward as PENDING, on the same row',
      r.granted.includes('gh-1') && (await repo.pendingRewards('gh-1')).length === 1 && Number(starRows.rows[0].n) === 1,
      `${JSON.stringify(r)} rows=${starRows.rows[0].n}`);
    // and a pending one that is withdrawn simply stops being offered
    r = await repo.sweepStargazers([], true);
    check('star sweep: an unstar while still PENDING withdraws the offer', r.revoked.includes('gh-1') && (await repo.pendingRewards('gh-1')).length === 0);

    // unlink keeps the row, so the pair can never earn on another account
    check('links: unlinking takes', (await repo.unlinkProvider('gh-1', 'github')) === true);
    check('links: ...and the account has no live link', (await repo.providerLinks('gh-1')).length === 0);
    check(
      '⚠️ links: ...but the PAIR is still spoken for — unlink/relink is not a free reward mint',
      (await repo.linkProvider('gh-2', 'github', '1001')) === false,
    );
    check('links: the original owner may relink it', (await repo.linkProvider('gh-1', 'github', '1001')) === true);

    // a `title:` id is not a cosmetic any more (0049), so the inventory refuses every one
    check('links: a title id cannot be granted as a cosmetic', (await repo.grantCosmetic('gh-1', 'title:stargazer', 'rewards')) === false);

    await repo.deleteAccount('gh-2');
    const left = await db.query<{ n: number }>(`select count(*)::int as n from provider_links where user_id = 'gh-2'`);
    check('links: a deleted account takes its links with it (the FK cascades)', Number(left.rows[0].n) === 0);
  }


  // ---- THE STARGAZER FETCH: `complete` is the safety property ----------------------
  /**
   * `fetchStargazers` takes an injected `fetch`, so every failure path is reachable without
   * a network or a token. The property under test is not "does it parse JSON" — it is that
   * EVERY failure produces `complete: false`, because `sweepStargazers` revokes on a
   * complete list and an incomplete one misread as empty strips every holder at once.
   */
  {
    /* ⚠️ IMPORTED LAZILY, LIKE `server/db/repo` ITSELF. `server/stargazers` pulls repo in,
       repo pulls `server/moderation`, and moderation reads its key AT MODULE SCOPE — so a
       top-of-file import here resolves moderation as DISABLED before the stub at the top of
       this file sets the env, and the replay name-scrub check goes red. That stub's own
       header warns about exactly this; this is that hazard, met. */
    const stargazers = await import('../server/stargazers');
    const page = (n: number, ids: number[]) => ({ ok: true, status: 200, json: async () => ids.map((id) => ({ id })) }) as unknown as Response;
    const stub = (pages: Response[]): typeof fetch => {
      let i = 0;
      return (async () => pages[Math.min(i++, pages.length - 1)]) as unknown as typeof fetch;
    };

    // a single short page is a complete answer
    let got = await stargazers.fetchStargazers('o/r', undefined, stub([page(1, [1, 2, 3])]));
    check('stargazers: a short page ends the walk and is COMPLETE', got.complete && got.ids.join() === '1,2,3', JSON.stringify(got));

    // ⚠️ zero stars is a real, COMPLETE answer — and it is the one a naive implementation
    // conflates with failure. `sweepStargazers` would revoke everybody on it, correctly.
    got = await stargazers.fetchStargazers('o/r', undefined, stub([page(1, [])]));
    check('⚠️ stargazers: an EMPTY repo is complete, not a failure', got.complete && got.ids.length === 0);

    // a full page followed by a short one pages through
    const full = Array.from({ length: 100 }, (_, k) => k + 1);
    got = await stargazers.fetchStargazers('o/r', undefined, stub([page(1, full), page(2, [101])]));
    check('stargazers: it pages until a short page', got.complete && got.ids.length === 101);

    // every failure path is INCOMPLETE
    const bad = { ok: false, status: 502, headers: new Headers(), json: async () => [] } as unknown as Response;
    got = await stargazers.fetchStargazers('o/r', undefined, stub([bad]));
    check('⚠️ stargazers: a non-2xx is INCOMPLETE', !got.complete);

    const throws = (async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;
    got = await stargazers.fetchStargazers('o/r', undefined, throws);
    check('⚠️ stargazers: a thrown fetch is INCOMPLETE', !got.complete);

    const notJson = { ok: true, status: 200, json: async () => { throw new Error('bad json'); } } as unknown as Response;
    got = await stargazers.fetchStargazers('o/r', undefined, stub([notJson]));
    check('⚠️ stargazers: an unparseable body is INCOMPLETE', !got.complete);

    const notArray = { ok: true, status: 200, json: async () => ({ message: 'rate limited' }) } as unknown as Response;
    got = await stargazers.fetchStargazers('o/r', undefined, stub([notArray]));
    check('⚠️ stargazers: a body that is not an array is INCOMPLETE (this is the rate-limit shape)', !got.complete);

    // a list that never shortens must stop, and stopping early is INCOMPLETE
    got = await stargazers.fetchStargazers('o/r', undefined, stub([page(1, full)]));
    check('⚠️ stargazers: a list that never ends hits MAX_PAGES and is INCOMPLETE', !got.complete, `${got.ids.length} ids`);

    /**
     * ⚠️ **NO TOKEN MUST NOT MEAN "NOBODY STARRED", AND FOR A WHILE IT DID.**
     *
     * MEASURED against the live API on 2026-09-21: `GET /repos/<public repo>/stargazers`
     * answers **401 Requires authentication** anonymously — from a clean rate-limit budget,
     * on a repo whose own `/repos/…` is 200 with `"private": false` — and 200 with any
     * credential. The token is REQUIRED, and this file's own comments used to say it was
     * optional and bought rate limit alone.
     *
     * That wrong belief was survivable only because of how quiet the failure is. Every layer
     * below `fetchStargazers` refuses to act on a list it cannot trust, so an unauthenticated
     * deploy sweeps hourly, logs one generic `stargazer fetch 401` line, grants nothing,
     * revokes nothing, and is indistinguishable from a repo nobody has starred. So what is
     * under test here is not the 401 — it is that the sweep NAMES the reason and does not
     * spend a request finding out.
     */
    let fetched = 0;
    const countingFetch = (async () => {
      fetched++;
      return page(1, [1]);
    }) as unknown as typeof fetch;
    stargazers.resetNoTokenWarning();
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => void warnings.push(a.join(' '));
    const noTok = await stargazers.runStarSweep('o/r', undefined, countingFetch);
    console.warn = realWarn;
    check('⚠️ star sweep: NO GITHUB_TOKEN means the sweep does not apply — a 401 list is not an empty one',
      !noTok.applied && noTok.granted.length === 0 && noTok.revoked.length === 0, JSON.stringify(noTok));
    check('...and it refuses BEFORE the request, so it does not burn one to learn that',
      fetched === 0, `${fetched} fetches`);
    check('...and it says GITHUB_TOKEN by name, because the alternative is a silent no-op forever',
      warnings.some((w) => w.includes('GITHUB_TOKEN')), warnings.join(' | ').slice(0, 120));

    /**
     * ⚠️ **AND AN EXPIRED TOKEN IS THE SAME OUTAGE, ARRIVING LATER.** The refusal above
     * catches a token that is ABSENT; one that has lapsed is PRESENT and reaches the non-2xx
     * path instead. A fine-grained GitHub token caps out around a year, so this is the
     * ordinary end of its life rather than an edge case — and the reward would go quiet on
     * whatever day that is, with a `401` in a log nobody is reading.
     *
     * 403 is deliberately NOT the same sentence: rate limiting is self-healing and the next
     * sweep is an hour away, so it is a note. The two are told apart by
     * `x-ratelimit-remaining`, not by the status.
     */
    const errs: string[] = [];
    const realErr = console.error;
    const realWarn2 = console.warn;
    const capture = async (status: number, remaining: string | null): Promise<string> => {
      errs.length = 0;
      console.error = (...a: unknown[]) => void errs.push(a.join(' '));
      console.warn = (...a: unknown[]) => void errs.push(a.join(' '));
      const res = {
        ok: false,
        status,
        headers: { get: (h: string) => (h === 'x-ratelimit-remaining' ? remaining : null) },
        json: async () => [],
      };
      await stargazers.fetchStargazers('o/r', 'tok', (async () => res) as unknown as typeof fetch);
      console.error = realErr;
      console.warn = realWarn2;
      return errs.join(' | ');
    };

    const dead = await capture(401, null);
    check('⚠️ stargazers: a REJECTED token (401) says the token was rejected, not just "401"',
      /REJECTED|expired/i.test(dead) && dead.includes('GITHUB_TOKEN'), dead.slice(0, 110));
    const limited = await capture(403, '0');
    check('...and a rate-limit 403 does NOT cry credential — it is self-healing by the next sweep',
      /rate-limited/i.test(limited) && !/REJECTED/i.test(limited), limited.slice(0, 110));
    const forbidden = await capture(403, '57');
    check('...while a 403 with budget left DOES, because that one is not going to fix itself',
      /FORBIDDEN/i.test(forbidden), forbidden.slice(0, 110));

    /**
     * ⚠️ **AND 404 IS THE ONE THAT LIES.** On this endpoint GitHub answers 404 rather than
     * 403 for an under-scoped token, so that a caller cannot use the status to learn a repo
     * exists — which makes the one status that reads as "you typed the name wrong" also mean
     * "your token is too weak". MEASURED 2026-09-21: an unscoped classic PAT reads `/user` and
     * `/repos/genius0412/dsim` at 200 and 404s on that repo's `/stargazers`. This check exists
     * because I gave the owner the wrong advice from exactly that 404.
     */
    const notfound = await capture(404, null);
    check('⚠️ stargazers: a 404 WITH a token says MISSING SCOPE, because GitHub will not',
      /scope/i.test(notfound) && notfound.includes('public_repo'), notfound.slice(0, 120));

    /**
     * ⚠️ **THE LINK MUST SWEEP FOR ITSELF, AND THE SWEEP MUST NOT BE ABLE TO FAIL THE LINK.**
     * Both halves were wrong at once and it is worth spelling out how it presented: the only
     * thing that granted anything was `setInterval(…, 1 h)` in `server/index.ts`, created at
     * BOOT — so every deploy pushed the first fire back another hour, and after an afternoon
     * of alpha deploys the live log had no `[rewards]` line at all. Somebody who linked saw
     * GitHub connected and nothing else, indefinitely, which is indistinguishable from a
     * feature that does not work. It is what the owner reported.
     *
     * Grepped rather than driven: the route needs a signed `state`, a verified bearer token
     * and a live provider round trip, none of which this suite has. What is actually at risk
     * is somebody deleting either half while tidying — a reachable `runStarSweep` call, and
     * the `try` around it, since the link is already COMMITTED by then and a GitHub outage
     * must not turn a good link into `?link=error` and send somebody round OAuth again.
     */
    const apiSrc = readFileSync(join(ROOT, 'server/api.ts'), 'utf8');
    const cb = apiSrc.slice(apiSrc.indexOf('const linked = await linkProvider('));
    const onLink = cb.slice(0, cb.indexOf('return back(linked'));
    check('⚠️ link: a completed GitHub link sweeps IMMEDIATELY — an hourly timer is the bug',
      /runStarSweep\(/.test(onLink), onLink.length ? 'found the callback' : 'CALLBACK NOT FOUND');
    check('...and the sweep is wrapped, so a GitHub outage cannot fail a link already committed',
      /try \{/.test(onLink) && /catch/.test(onLink));
    const idxSrc = readFileSync(join(ROOT, 'server/index.ts'), 'utf8');
    check('...and one sweep runs after BOOT too, because the hourly timer first fires an hour late',
      /starBoot = setTimeout\(/.test(idxSrc) && /runStarSweep\(STAR_REPO/.test(idxSrc));
  }


  // ---- THE BOOST FLOOR, AND THE MISTAKE IT EXISTS TO NOT MAKE ---------------------
  /**
   * ⚠️ **THE BOOST FLOOR DOES NOT ACCUMULATE.** `docs/rewards-round2-plan.md` §7 names this
   * as the check to write BEFORE the code, and it is the single most expensive mistake
   * available in the rewards work: `grantSupporter` adds MONTHS, so an hourly sweep routed
   * through it would mint a decade of membership inside a year and nothing in the system
   * could expire it — `supporter_until` is the one predicate behind the badge, ads-off, the
   * saved-start cap and the palette. A thousand sweeps must leave the account inside the
   * grace window, not a thousand months out.
   */
  {
    const boosts = await import('../server/boosts');
    await repo.ensureProfile('bo-1', 'Booster');
    await repo.ensureProfile('bo-2', 'Payer');

    const untilOf = async (u: string): Promise<Date | null> => {
      const r = await db.query<{ supporter_until: string | null }>(
        `select supporter_until from profiles where user_id = $1`, [u],
      );
      const v = r.rows[0]?.supporter_until;
      return v ? new Date(v) : null;
    };

    const first = await repo.ensureSupporterFloor('bo-1', boosts.BOOST_GRACE_DAYS);
    check('boost: the first sweep sets a floor', first === true);
    const at1 = await untilOf('bo-1');
    const days = (d: Date | null): number => (d ? (d.getTime() - Date.now()) / 86_400_000 : -1);
    check('boost: ...roughly the grace window out', Math.abs(days(at1) - boosts.BOOST_GRACE_DAYS) < 1, `${days(at1).toFixed(2)}d`);

    // A THOUSAND SWEEPS. With `EXTEND_SQL` this lands ~83 years out; with a floor it does not move.
    for (let i = 0; i < 1000; i++) await repo.ensureSupporterFloor('bo-1', boosts.BOOST_GRACE_DAYS);
    const at2 = await untilOf('bo-1');
    check(
      '⚠️ boost: A THOUSAND SWEEPS LEAVE IT INSIDE THE GRACE WINDOW (it is a floor, not an extension)',
      Math.abs(days(at2) - boosts.BOOST_GRACE_DAYS) < 1,
      `${days(at2).toFixed(2)}d after 1001 sweeps \u2014 EXTEND_SQL would give ~${(1001 * 30).toFixed(0)}d`,
    );

    // ...and it writes ONE audit row, not 1001. The table exists to answer "why does this
    // account have a membership?" and an hourly heartbeat would stop it answering.
    const grants = await db.query<{ n: number }>(
      `select count(*)::int as n from supporter_grants where user_id = 'bo-1' and source = 'boost'`,
    );
    check('⚠️ boost: ...and logs ONCE, not once per sweep', Number(grants.rows[0].n) === 1, `${grants.rows[0].n} rows`);

    // a PAYER who also boosts keeps the later of the two — paid time is never truncated
    await repo.grantSupporter('bo-2', 6, 'kofi');
    const paid = await untilOf('bo-2');
    await repo.ensureSupporterFloor('bo-2', boosts.BOOST_GRACE_DAYS);
    const after = await untilOf('bo-2');
    check(
      '⚠️ boost: a PAYER who boosts keeps the later date \u2014 the floor never truncates paid time',
      !!paid && !!after && after.getTime() === paid.getTime(),
      `${paid?.toISOString()} -> ${after?.toISOString()}`,
    );

    // the fetch half: an empty member list is the INTENT-IS-OFF signature, not "nobody boosts"
    const ok = (rows: unknown[]) => ({ ok: true, status: 200, json: async () => rows }) as unknown as Response;
    const stub = (pages: Response[]): typeof fetch => {
      let i = 0;
      return (async () => pages[Math.min(i++, pages.length - 1)]) as unknown as typeof fetch;
    };
    let got = await boosts.fetchBoosters('g', 't', stub([ok([{ user: { id: '5' }, premium_since: '2026-01-01' }, { user: { id: '6' }, premium_since: null }])]));
    check('boost fetch: only members with premium_since count', got.complete && got.ids.join() === '5', JSON.stringify(got));
    got = await boosts.fetchBoosters('g', 't', stub([ok([])]));
    check(
      '⚠️ boost fetch: an EMPTY member list is INCOMPLETE \u2014 it is what Discord returns with the intent OFF, with a 200 and no error',
      !got.complete,
    );
    const bad = { ok: false, status: 403, json: async () => [] } as unknown as Response;
    got = await boosts.fetchBoosters('g', 't', stub([bad]));
    check('boost fetch: a non-2xx is INCOMPLETE', !got.complete);
    const swept = await boosts.sweepBoosters([], false);
    check('⚠️ boost sweep: an incomplete read pushes no floors at all', swept.applied === false && swept.floored.length === 0);
  }

  // ------------------------------------------------ the email gate's source of truth
  /* Neon Auth keeps its tables in the game's own database (`neon_auth` schema), and the
     verification code flips `neon_auth."user"."emailVerified"`. The gate reads it when the JWT
     carries no claim. It is a MANAGED schema this repo does not migrate, so it is built here the
     way Neon has it, and every way of not finding the answer must be null (the gate passes). */
  {
    check(
      'email gate: no neon_auth schema is null, not a throw',
      (await repo.authEmailVerified('00000000-0000-0000-0000-000000000001')) === null,
    );
    await db.exec(`create schema neon_auth;
      create table neon_auth."user" (id uuid primary key, email text, "emailVerified" boolean not null);
      insert into neon_auth."user" values
        ('00000000-0000-0000-0000-000000000001', 'a@b.co', false),
        ('00000000-0000-0000-0000-000000000002', 'c@d.co', true);`);
    check(
      'email gate: an unverified row reads false',
      (await repo.authEmailVerified('00000000-0000-0000-0000-000000000001')) === false,
    );
    check(
      'email gate: a verified row reads true',
      (await repo.authEmailVerified('00000000-0000-0000-0000-000000000002')) === true,
    );
    check(
      'email gate: an unknown id is null',
      (await repo.authEmailVerified('00000000-0000-0000-0000-00000000000f')) === null,
    );
    check(
      'email gate: an id that is not a uuid is null, not a throw',
      (await repo.authEmailVerified('not-a-uuid')) === null,
    );
    await db.exec(`drop schema neon_auth cascade;`);
  }

  await db.close();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
