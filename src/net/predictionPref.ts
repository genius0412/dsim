/**
 * CLIENT PREDICTION MODE — Off / Light / Full / Auto, PER DEVICE
 * (`docs/biobuzz/plan-3d.md` §5, Day 3 lane C).
 *
 * How much work this machine does to render its OWN robot ahead of the authoritative snapshot
 * in a 3D-physics room. It is a property of the MACHINE, not of the account — the whole point
 * of the setting is that a Chromebook and a desktop answer it differently — so it lives beside
 * `decodesim.view.v2` and `decodesim.theme` in localStorage rather than in `GameSettings`, which
 * syncs to Postgres per account. Same shape as `graphics/store.ts`, deliberately: read it
 * without React, subscribe for in-tab changes, never throw.
 *
 * ── WHAT EACH MODE COSTS, AND WHO SHOULD PICK IT ──────────────────────────────────────────
 *  · `off`   — no prediction at all. The local robot is rendered from interpolated snapshots
 *              exactly like a remote one, so it answers the stick about `INTERP_DELAY_TICKS`
 *              (~83 ms) plus half the round trip later. Costs nothing and is never chosen by
 *              Auto; it exists for a machine that cannot afford even Light, and for anyone who
 *              would rather see the truth late than see a guess corrected.
 *  · `light` — the shared drive model plus the walls (`createLightPredictor`). Under 1 ms per
 *              reconcile and exact on open floor.
 *  · `full`  — a small Rapier 3D prediction world (`createFullPredictor`). Right through a
 *              push; ~2 ms measured, budget `PREDICT_FULL_BUDGET_MS` (8).
 *  · `auto`  — the DEFAULT and the shipped answer: probe Full once during the pre-match
 *              countdown and take it if this machine is inside the budget, else Light.
 *
 * ⚠️ **THE SETTING IS A 3D-ROOM SETTING AND NOTHING ELSE.** A 2D-physics room (every DECODE
 * room, every Chain Reaction room, every BIOBUZZ room an older server hosts) keeps replaying
 * the whole `mod.step`, byte for byte, whatever is stored here — see `GameController.reconcile`.
 * That is the owner's permanence rule for the 2D pipeline applied to the netcode half.
 */

import { PREDICTION_KEY as PREDICT_KEY, PREDICTION_OFF_NOTICE_KEY as OFF_NOTICE_KEY } from '../storageKeys';

/** the stored preference — what the player asked for, which is not necessarily what is
 *  running (see `PredictionMode` for that). */
export type PredictionPref = 'auto' | 'off' | 'light' | 'balanced' | 'full';

/** what is ACTUALLY running this match: `auto` has been resolved to one of the other three
 *  by the time a tick is stepped, so this is the narrower type the controller and the HUD use. */
export type PredictionMode = 'off' | 'light' | 'balanced' | 'full';

/** the cycle order the in-match control walks. `auto` leads because it is the default and the
 *  answer a player who has never opened this should be able to get back to. */
export const PREDICTION_PREFS: readonly PredictionPref[] = ['auto', 'off', 'light', 'balanced', 'full'];

/** the words the two controls print, in one place so Controls and the in-match panel cannot
 *  drift. Sentence case per `docs/area/ui.md`. */
export const PREDICTION_LABELS: Record<PredictionPref, string> = {
  auto: 'Auto',
  off: 'Off',
  light: 'Light',
  balanced: 'Balanced',
  full: 'Full',
};

/** one line under each option — what it costs and what it feels like. */
export const PREDICTION_BLURBS: Record<PredictionPref, string> = {
  auto: 'Measures this machine before the match and picks Full, Balanced or Light.',
  off: 'Your robot is drawn from the server’s updates. No guessing, about 80 ms of lag.',
  light: 'Predicts driving and walls. Instant on open floor; a nudge when you push.',
  balanced: 'Predicts your robot, the robots near it and the moving balls. Lighter than Full.',
  full: 'Predicts the whole field: every robot, every ball, your shots. Needs the most CPU.',
};

const isPref = (v: unknown): v is PredictionPref =>
  typeof v === 'string' && (PREDICTION_PREFS as readonly string[]).includes(v);

/** the stored preference, or `'auto'` when absent, corrupt, or storage is unavailable (private
 * browsing, a locked-down profile). Never throws. */
export function getPredictionPref(): PredictionPref {
  try {
    const v = localStorage.getItem(PREDICT_KEY);
    return isPref(v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}

type Listener = (pref: PredictionPref) => void;

/** listeners for a change made THROUGH `setPredictionPref`, in this tab — same rule as
 * `subscribeViewPref`: no cross-tab `storage` relay, because a prediction mode changing under
 * a driver mid-match because another tab changed its mind is a worse surprise than one that
 * catches up on the next match. */
const listeners = new Set<Listener>();

/** persist a preference and notify this tab's subscribers. Best-effort: a storage failure
 * still notifies, so the pick applies for this session even though it will not survive a
 * reload. */
export function setPredictionPref(pref: PredictionPref): void {
  try {
    localStorage.setItem(PREDICT_KEY, pref);
  } catch {
    /* non-fatal: the pick still applies for this session */
  }
  for (const fn of listeners) fn(pref);
}

/** subscribe to `setPredictionPref` calls made anywhere in this tab (the Controls section, the
 * in-match connection panel). Returns an unsubscribe function — call it on unmount/dispose. */
export function subscribePredictionPref(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * HAS THIS DEVICE ALREADY BEEN TOLD WHAT `off` COSTS?
 *
 * Plan §5: "an event-log line explains Off's latency the first time it is chosen". FIRST time,
 * not every match — the event log is the toast surface and a line that reappears at every
 * kickoff stops being an explanation and becomes noise. Stored rather than held in memory so
 * a reload does not re-earn it.
 */
// OFF_NOTICE_KEY is imported at the top, beside PREDICT_KEY (src/storageKeys.ts)

export function offNoticeShown(): boolean {
  try {
    return localStorage.getItem(OFF_NOTICE_KEY) === '1';
  } catch {
    // storage unavailable ⇒ say it HAS been shown. The alternative is repeating it at every
    // kickoff for the whole session, which is the failure this flag exists to prevent.
    return true;
  }
}

export function markOffNoticeShown(): void {
  try {
    localStorage.setItem(OFF_NOTICE_KEY, '1');
  } catch {
    /* nothing to do — see `offNoticeShown` */
  }
}
