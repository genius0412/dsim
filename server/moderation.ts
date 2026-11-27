import { envVar } from './runtimeEnv';
import { blocklistHit, parseBlocklist } from './blocklist';
// `specDefaults` is a LEAF on purpose (see its own header) — importing it here adds no
// browser-hostile weight to the modules `server/room.ts` pulls into the LAN host's tab.
import { DEFAULT_SPEC } from '../src/sim/specDefaults';
import type { RobotSpec } from '../src/types';
/**
 * Hosted content moderation for user-supplied NAMES: account username, display name,
 * and the robot / team names embedded in a persisted leaderboard record. The server
 * is the AUTHORITY here — any client value is spoofable via devtools — so every
 * deliberate name claim (`server/api.ts`) and every durable public write
 * (`server/persist.ts`) runs through `moderateName()`.
 *
 * We call a HOSTED moderation model rather than shipping a hand-maintained wordlist:
 * the service tracks slurs, obfuscation, and new terms far better than a static list
 * and needs no upkeep. Defaults to OpenAI's free Moderation endpoint
 * (`POST /v1/moderations`, model `omni-moderation-latest`), but the endpoint, model,
 * and auth are env-configurable so it can point at any provider that speaks the same
 * request/response shape.
 *
 * ENV (all optional — absent ⇒ moderation is DISABLED and every name is allowed,
 * exactly the way `DATABASE_URL` gates the leaderboard):
 *   MODERATION_API_KEY    bearer token for the service (falls back to OPENAI_API_KEY)
 *   MODERATION_API_URL    endpoint (default https://api.openai.com/v1/moderations)
 *   MODERATION_MODEL      model id (default omni-moderation-latest)
 *   MODERATION_TIMEOUT_MS request timeout (default 4000)
 *   MODERATION_BLOCKLIST  the LOCAL word list, checked BEFORE the hosted model and with no round
 *                         trip (`server/blocklist.ts` has the format and the reason it exists).
 *                         ⚠️ A SECRET, NEVER A FILE IN THIS REPO — owner ruling 2026-09-19. It
 *                         works on its own: with no API key the list still refuses what is on it.
 *
 * POLICY — FAIL OPEN. If the service is unconfigured, unreachable, times out, or
 * errors, the name is ALLOWED and a warning is logged. Moderation is a guardrail with
 * a human backstop (the admin forced-rename in `src/ui/Admin.tsx`); locking every
 * player out during a provider outage is the worse failure. Decisions are cached
 * in-process so a repeated username-availability probe never re-bills the API.
 */

const API_KEY = envVar('MODERATION_API_KEY') ?? envVar('OPENAI_API_KEY') ?? '';
const API_URL = envVar('MODERATION_API_URL') ?? 'https://api.openai.com/v1/moderations';
const MODEL = envVar('MODERATION_MODEL') ?? 'omni-moderation-latest';
const TIMEOUT_MS = Number(envVar('MODERATION_TIMEOUT_MS') ?? 4000);

/**
 * THE PROVIDER BUDGET — hosted calls per rolling minute, across this whole process.
 *
 * Every join can cost up to four uncached calls (driver, team, robot and robot-team name), and a
 * live rename one call per round trip per seat. Nothing bounded the total, so anyone opening
 * sockets with fresh names could spend the key's rate limit — after which every check fails, and
 * a failed check ALLOWS (see `moderateName`). Past the budget a name is not checked, but without
 * the call: the key keeps working for everybody once the minute rolls over. What happens to the
 * unchecked name depends on who asked: a persistent CLAIM (username, display name, competition
 * text) is REFUSED with `NAME_CHECK_BUSY` (`ModerationResult.budget`), a match-end write (record,
 * replay setups: nobody to tell) is allowed. The blocklist still applies to every name either way.
 * 300/min is several times the busiest join rate the service has seen;
 * `MODERATION_MAX_PER_MINUTE` overrides and `0` removes the limit.
 */
const BUDGET_PER_MIN = ((): number => {
  const n = Number(envVar('MODERATION_MAX_PER_MINUTE') ?? 300);
  return Number.isFinite(n) && n >= 0 ? n : 300;
})();
/**
 * ⚠️ A PROBE MAY NEVER EXHAUST THE POOL A CLAIM DRAWS FROM. `GET /api/username-available` is public
 * and unauthenticated, one fresh name is one hosted call, and nothing rate-limits it, so one `curl`
 * loop at about five requests a second held the whole budget at zero, after which every name a
 * signed-in account claimed passed unchecked. A probe (`moderateName(raw, { probe: true })`) now
 * has its own cap, a fifth of the budget (60 of 300), counted inside the shared pool: past it a
 * probe is answered unchecked WITHOUT touching the shared counter, so a flood leaves at least four
 * fifths of the minute for real claims. The claim re-checks, so the hint is all a probe can lose.
 */
const PROBE_BUDGET_PER_MIN = Math.min(60, Math.ceil(BUDGET_PER_MIN / 5));
let budgetWindowAt = 0;
let budgetUsed = 0;
let probeUsed = 0;
let budgetWarnedAt = 0;
export function takeProviderBudget(now = Date.now(), probe = false): boolean {
  if (BUDGET_PER_MIN === 0) return true;
  if (now - budgetWindowAt >= 60_000) {
    budgetWindowAt = now;
    budgetUsed = 0;
    probeUsed = 0;
  }
  // a probe past its own cap stops here: the shared counter is not touched
  if (probe && probeUsed >= PROBE_BUDGET_PER_MIN) return false;
  if (budgetUsed >= BUDGET_PER_MIN) {
    if (now - budgetWarnedAt >= 60_000) {
      budgetWarnedAt = now;
      console.warn(`[moderation] hosted-check budget (${BUDGET_PER_MIN}/min) spent - claims are refused and match-end names pass unchecked until it refills`);
    }
    return false;
  }
  budgetUsed++;
  if (probe) probeUsed++;
  return true;
}
/** test seam: the budget as configured, the probe cap, and a reset */
export const MODERATION_BUDGET_PER_MIN = BUDGET_PER_MIN;
export const MODERATION_PROBE_PER_MIN = PROBE_BUDGET_PER_MIN;
export function resetProviderBudgetForTests(): void {
  budgetWindowAt = 0;
  budgetUsed = 0;
  probeUsed = 0;
}

/** the local word list — see `server/blocklist.ts`. Parsed once; only its SIZE is ever logged. */
const BLOCKLIST = parseBlocklist(envVar('MODERATION_BLOCKLIST'));

/** true when ANY moderation is configured — the hosted model, the local list, or both; when false
 * everything is allowed */
export const moderationEnabled = API_KEY.length > 0 || BLOCKLIST.size > 0;
/** the hosted half on its own: the local list needs no key, and must not make the code below
 * call a provider it has no credentials for */
const hostedEnabled = API_KEY.length > 0;

export interface ModerationResult {
  /** whether the name may be used */
  allowed: boolean;
  /** whether the service actually ran (false ⇒ disabled / empty / failed-open) */
  checked: boolean;
  /** true ONLY when the name went unchecked because the per-minute hosted budget was spent (a
   * provider failure stays plain fail-open). A persistent claim (username, display name,
   * competition text) refuses on it with `NAME_CHECK_BUSY`; a match-end write ignores it. */
  budget?: true;
}

/** what a player is told when a claim met a spent budget; the callers answer 400 with it, which
 * every form that claims a name already prints */
export const NAME_CHECK_BUSY = 'Couldn’t check that name right now. Try again in a minute.';

// bounded decision cache (normalized text → allowed). A plain Map with FIFO-ish
// eviction is plenty: the working set is tiny and entries are cheap booleans.
const cache = new Map<string, boolean>();
const CACHE_MAX = 2000;

function cacheSet(key: string, allowed: boolean): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, allowed);
}

/** POST the text to the moderation endpoint; resolve to whether it is ALLOWED
 *  (i.e. NOT flagged). Throws on a network / non-2xx / malformed response so the
 *  caller can fail open. */
async function callProvider(text: string): Promise<boolean> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ model: MODEL, input: text }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`moderation HTTP ${res.status}`);
  const body = (await res.json()) as { results?: Array<{ flagged?: boolean }> };
  const flagged = body.results?.[0]?.flagged;
  if (typeof flagged !== 'boolean') throw new Error('moderation: unexpected response shape');
  return !flagged;
}

/**
 * Decide whether `raw` is an acceptable name. Empty/whitespace and the
 * moderation-disabled case both resolve to allowed (length/emptiness is the caller's
 * own concern). Fails open on any provider error.
 */
export async function moderateName(raw: string, opts: { probe?: boolean } = {}): Promise<ModerationResult> {
  const text = (raw ?? '').trim();
  if (!text || !moderationEnabled) return { allowed: true, checked: false };

  // THE LOCAL LIST FIRST: exact, free, and it cannot fail open — there is no network to lose.
  if (blocklistHit(BLOCKLIST, text)) return { allowed: false, checked: true };
  if (!hostedEnabled) return { allowed: true, checked: true };

  const key = text.toLowerCase();
  const cached = cache.get(key);
  if (cached !== undefined) return { allowed: cached, checked: true };

  // OVER BUDGET: not checked, exactly as if the provider had failed — but WITHOUT spending a
  // call, so a flood of unique names cannot exhaust the key and fail every check after it. It is
  // flagged `budget` so a persistent claim can REFUSE instead of passing the name.
  if (!takeProviderBudget(Date.now(), opts.probe === true)) return { allowed: true, checked: false, budget: true };

  try {
    const allowed = await callProvider(text);
    cacheSet(key, allowed);
    return { allowed, checked: true };
  } catch (err) {
    console.warn('[moderation] check failed — allowing:', err instanceof Error ? err.message : err);
    return { allowed: true, checked: false };
  }
}

/**
 * Return `raw` when it is acceptable, otherwise `fallback`. For the persistence path,
 * where a flagged robot/team name is silently replaced with a safe default rather
 * than rejected (a record is written off the hot path at match end — there is no user
 * to show an error to). `fallback` is trusted to be clean.
 */
export async function scrubName(raw: string | undefined | null, fallback: string): Promise<string> {
  if (typeof raw !== 'string' || !raw.trim()) return typeof raw === 'string' ? raw : fallback;
  const { allowed } = await moderateName(raw);
  return allowed ? raw : fallback;
}

/** Copy a spec with its public free-text names run through hosted moderation. The
 *  robot/team name land in `records.config` (a public leaderboard card) AND in a
 *  replay's `setups`, which `src/render/renderer.ts` draws ON THE FIELD above every
 *  robot — so a flagged one is public in the replay viewer and burned into every
 *  exported video. Replaced with the safe default before it is ever written. No-op
 *  (returns the SAME object) when moderation is disabled or the names are clean, which
 *  is what keeps it free on a dev box and in CI.
 *
 *  It lives HERE rather than in `server/persist.ts`, where it was written, because
 *  `server/db/repo.ts` now needs it too (`saveReplay` is the one funnel all three replay
 *  writers share) and persist.ts imports repo.ts — importing it back would be a cycle. */
export async function scrubSpecNames(spec: RobotSpec): Promise<RobotSpec> {
  // ⚠️ CONCURRENT, because this is now on the RESULTS-SCREEN path. `saveReplay` calls it, and
  // `Room`'s `eloResult` broadcast awaits `onResult` → `persistMatch` → `saveReplay`, so two
  // SEQUENTIAL hosted round trips per robot are two of them added to every player's wait for
  // their own rating change (`MODERATION_TIMEOUT_MS` is 4 s each). They are independent
  // lookups against a shared cache; there is no reason to order them.
  const [name, teamName] = await Promise.all([
    scrubName(spec.name, DEFAULT_SPEC.name),
    scrubName(spec.teamName, ''),
  ]);
  return name === spec.name && teamName === spec.teamName ? spec : { ...spec, name, teamName };
}
