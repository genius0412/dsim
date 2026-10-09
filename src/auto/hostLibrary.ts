/**
 * WHAT DSIM'S LIBRARY LOOKS LIKE TO ZENITH, AND WHAT A SAVE FROM ZENITH DOES TO IT
 * (`zenith-host/1`, docs/area/autos.md). DOM-free and Zenith-free, so the AUTO smoke lane can check
 * it; `src/ui/zenithLaunch.ts` is its one caller, and it reaches the client only through that lazy
 * entry.
 *
 * ── ONE WAYPOINTS FILE FOR THE WHOLE LIBRARY ──────────────────────────────────────────────────
 * `zenith-host/1` carries ONE waypoints file, and each library auto keeps its own. Sending only the
 * opened auto's made every other auto in Zenith's picker fail with "No waypoint named start", so
 * (owner's ruling, option A) DSIM merges them into the one file it sends, with no protocol change.
 * The opened auto's file is the base. Each other auto, newest first, adds the names the merged
 * file lacks.
 *
 * ⚠️ AN AUTO WHOSE NAMES CLASH IS LEFT OUT. Two autos that both say `start` at different poses
 * cannot share one file: the second would be drawn, estimated and edited in Zenith against the
 * first one's pose, while DSIM plays it against its own, so the plan the person edits is not the
 * one that runs. Such an auto is not sent at all (Zenith's picker does not list it) and the caller
 * says so in one sentence; Edit in Zenith on THAT auto makes its file the base. Equal poses under
 * one name are not a clash.
 *
 * ── A SAVE NEVER MOVES AN AUTO'S OWN WAYPOINTS ────────────────────────────────────────────────
 * Zenith's `save` carries the auto's text and no waypoints, so DSIM picks the file stored with it:
 * the auto's own file, unchanged, plus only the names the saved text uses that its own file lacks,
 * taken from the merged file Zenith showed it. A pose the auto already had is never replaced.
 */
import { AUTO_LIBRARY_MAX, type AutoLibraryEntry, type GameAutoLibrary } from './library';

export interface WaypointsFile {
  waypoints?: Record<string, unknown>;
  [k: string]: unknown;
}

/** A waypoints file's text as an object, or undefined for no file or a broken one. */
export function readWaypoints(text: string | undefined): WaypointsFile | undefined {
  try {
    const w = text ? (JSON.parse(text) as unknown) : undefined;
    return w && typeof w === 'object' && !Array.isArray(w) ? (w as WaypointsFile) : undefined;
  } catch {
    return undefined;
  }
}

function pointsOf(w: WaypointsFile | undefined): Record<string, unknown> | undefined {
  const p = w?.waypoints;
  return p && typeof p === 'object' && !Array.isArray(p) ? p : undefined;
}

/** two waypoints are the same pose when x, y and heading are; a note or provenance may differ */
export function samePose(a: unknown, b: unknown): boolean {
  const pa = (a ?? {}) as Record<string, unknown>;
  const pb = (b ?? {}) as Record<string, unknown>;
  return pa.xIn === pb.xIn && pa.yIn === pb.yIn && pa.headingRad === pb.headingRad;
}

/** an auto left out of a session, and the name that kept it out */
export interface LeftOutAuto {
  name: string;
  waypoint: string;
  /** the auto whose pose for `waypoint` the merged file already holds */
  against: string;
}

export interface HostLibraryView {
  /** auto name -> file text: every library auto except the ones left out */
  autos: Record<string, string>;
  /** the merged waypoints file, or undefined when no sent auto has one */
  waypoints?: WaypointsFile;
  leftOut: LeftOutAuto[];
}

/**
 * The autos and the one waypoints file a session sends. `opened` is the auto to open (its file is
 * the base), or null for a new auto, where the base is the auto that leaves the FEWEST others out
 * (the newest on a tie): two autos that agree on `start` outvote a newer one that does not.
 */
export function hostLibraryView(lib: GameAutoLibrary, opened: AutoLibraryEntry | null): HostLibraryView {
  if (opened) return viewFrom(lib, opened);
  let best = viewFrom(lib, null);
  for (const e of lib.entries) {
    const v = viewFrom(lib, e);
    if (v.leftOut.length < best.leftOut.length) best = v;
  }
  return best;
}

function viewFrom(lib: GameAutoLibrary, opened: AutoLibraryEntry | null): HostLibraryView {
  const order = opened ? [opened, ...lib.entries.filter((e) => e.id !== opened.id)] : lib.entries;
  const merged: Record<string, unknown> = {};
  /** which auto put each name in the merged file */
  const owner = new Map<string, string>();
  let template: WaypointsFile | undefined;
  const autos: Record<string, string> = {};
  const leftOut: LeftOutAuto[] = [];
  for (const e of order) {
    const w = readWaypoints(e.waypoints);
    const points = pointsOf(w);
    const clash = points ? Object.keys(points).find((n) => owner.has(n) && !samePose(merged[n], points[n])) : undefined;
    if (clash !== undefined && e !== opened) {
      leftOut.push({ name: e.name, waypoint: clash, against: owner.get(clash) ?? '' });
      continue;
    }
    autos[e.name] = e.auto;
    if (!points) continue;
    template ??= w;
    for (const [n, p] of Object.entries(points)) {
      if (owner.has(n)) continue;
      merged[n] = p;
      owner.set(n, e.name);
    }
  }
  return { autos, ...(template ? { waypoints: { ...template, waypoints: merged } } : {}), leftOut };
}

/** The one sentence naming the autos left out, why, and how to edit one; null when none was. */
export function leftOutSentence(leftOut: readonly LeftOutAuto[]): string | null {
  if (leftOut.length === 0) return null;
  const why = leftOut.map((l) => `${l.name} because its waypoint "${l.waypoint}" has a different pose in ${l.against}`).join(', or ');
  const which = leftOut.length === 1 ? leftOut[0].name : 'one of them';
  return `Zenith doesn’t list ${why}; to edit ${which}, select it in the Autonomous panel and use Edit in Zenith.`;
}

/** Every waypoint name an auto file refers to (`{ "ref": name }` anywhere in it). */
export function waypointRefs(autoText: string): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
    } else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.ref === 'string') out.add(o.ref);
      for (const x of Object.values(o)) walk(x);
    }
  };
  try {
    walk(JSON.parse(autoText));
  } catch {
    // the caller validates the text; a broken one refers to nothing
  }
  return out;
}

/**
 * The waypoints file to store with a saved auto: its own file untouched, plus each name the text
 * uses that the own file lacks, from the file the session sent. Text, or undefined for none.
 */
export function waypointsForSave(own: string | undefined, sent: WaypointsFile | undefined, autoText: string): string | undefined {
  const mine = readWaypoints(own);
  const minePoints = pointsOf(mine) ?? {};
  const sentPoints = pointsOf(sent) ?? {};
  const add: Record<string, unknown> = {};
  for (const n of waypointRefs(autoText)) if (!(n in minePoints) && n in sentPoints) add[n] = sentPoints[n];
  if (Object.keys(add).length === 0) return own;
  const template = mine ?? sent ?? {};
  return JSON.stringify({ ...template, waypoints: { ...minePoints, ...add } }, null, 2) + '\n';
}

/** `base`, else `base-2`, `base-3`…: the first name no library entry has (Zenith's own scheme) */
export function freeAutoName(lib: GameAutoLibrary, base: string): string {
  const names = new Set(lib.entries.map((e) => e.name));
  const root = base.replace(/-\d+$/, '') || base;
  let i = 2;
  while (names.has(`${root}-${i}`)) i += 1;
  return `${root}-${i}`;
}

/** what one session remembers between saves */
export interface HostSaveState {
  /** THE NAMES THIS SESSION MAY WRITE: every auto it sent Zenith, and every auto it has saved */
  own: Set<string>;
  /** Zenith's name -> the library name a save under it went to */
  alias: Map<string, string>;
  /** the waypoints file the last `open` carried */
  sent?: WaypointsFile;
}

export type HostSavePlan =
  | { ok: false; error: string }
  | { ok: true; target: string; entry: Omit<AutoLibraryEntry, 'id' | 'savedAt' | 'source'> & { id?: string } };

/** The sentence refusing a new auto into a full library (Zenith's Save). */
export const LIBRARY_FULL_SAVE = `DSIM’s auto library is full (${AUTO_LIBRARY_MAX}). Delete an auto in DSIM’s Autonomous panel, then save again.`;

/**
 * Where a save of `name` from Zenith goes. A save under a library name this session never sent or
 * saved is stored under a free name (every New in Zenith used to come back as `new-auto` and
 * replace the last one), and a NEW auto into a full library is refused rather than dropping the
 * oldest, which could be the one AUTO plays. The caller has validated `text`.
 */
export function planHostSave(lib: GameAutoLibrary, state: HostSaveState, name: string, text: string): HostSavePlan {
  let target = state.alias.get(name) ?? name;
  let prior = lib.entries.find((e) => e.name === target);
  if (prior && !state.own.has(target)) {
    target = freeAutoName(lib, target);
    prior = undefined;
  }
  if (!prior && lib.entries.length >= AUTO_LIBRARY_MAX) return { ok: false, error: LIBRARY_FULL_SAVE };
  const waypoints = waypointsForSave(prior?.waypoints, state.sent, text);
  return {
    ok: true,
    target,
    entry: { ...(prior ? { id: prior.id } : {}), name: target, auto: text, ...(waypoints ? { waypoints } : {}) },
  };
}
