/**
 * AN OLDER CLIENT'S SETTINGS SAVE MUST NOT STRIP THE ACCOUNT'S IMPORTED ROBOT (docs/area/accounts.md,
 * "Settings sync"; docs/area/robot-import.md, "The active robot across devices").
 *
 * `POST /api/user/settings` stores the blob it is sent, verbatim: the blob is client-shaped and
 * the server reads nothing in it. A build that predates robot import (main, and alpha until the
 * import branch merges) rebuilds every robot field by field in `coerceSettings`, so the blob it
 * saves has no `spec.imported`, no `lastStandardSpec` and no import in any archived game's
 * loadout, and ANY save from it (picking Free Drive on Modes is one) used to delete the
 * account's imported robot on every other device.
 *
 * So the server merges, for a save that does NOT say it keeps imports (`SETTINGS_KEEPS_IMPORTS` in
 * the body's `caps`, sent by every build with this file). Per game, the flat fields for the active
 * game and `loadouts[g]` for the others:
 *  1. **The robot.** The stored robot is imported, the incoming one is not, and the incoming one is
 *     the stored one MINUS what the older client could not read: every field it sent equals the
 *     stored field (`sameButDropped`). Then the stored robot is kept whole, import and all. Any
 *     difference (another preset, a saved robot, a slider moved) is a deliberate change, and the
 *     incoming robot stands.
 *  2. **The last standard robot.** Kept from the store when the incoming blob has none, and only
 *     while that game's robot (after 1) is imported: it is what ranked and record runs play then,
 *     and nothing reads it otherwise.
 *  3. **An archived game the older client did not send at all** keeps its stored loadout when that
 *     loadout holds an import.
 *
 * Measured against the real older coercer (main and alpha's `coerceSettings`, 2026-10-02): it
 * returns an imported DECODE, Chain Reaction or BIOBUZZ robot exactly minus `imported` (and minus
 * DECODE's `launcher`/`hoodDeg`/`flywheel`, which rule 1 restores with it). ⚠️ The one robot it
 * CHANGES is a BIOBUZZ fixed launcher (kind `'fixed'` reads as a turret there, and the mass moves
 * with it), so an import with one is not re-attached: that save really did change the robot.
 *
 * **Rules 1 and 3 cover a STANDARD DECODE robot too** when it carries what an older build cannot
 * read (`carriesNew`): a fixed launcher, a fixed hood, a setpoint flywheel, or NO intake. Measured
 * the same way (alpha's coercer, 2026-10-02): the three shooter fields are dropped, and `intake:
 * 'none'` comes back as the sloped preset with the length clamped to its 13.5–15 in and the width
 * raised to its 14.5 in floor (`olderReading`), so that rewrite is compared as "not read", not as
 * a change.
 *
 * DOM-free, no runtime imports beyond the game list: the server (`server/db/repo.ts`) and the smoke
 * suite read it, and the client reads the capability.
 */
import { GAME_IDS, isGameId } from '../games/types';
import type { GameId } from '../types';
import { INTAKE_PRESETS, ROBOT_MAX_SIZE, ROBOT_MIN_WIDTH, SWERVE_MIN_WIDTH } from '../config';

/** the body field a settings save carries (`{ settings, caps }`) when the build keeps imports */
export const SETTINGS_KEEPS_IMPORTS = 'robotImport';

/** does a settings save that carries `caps` come from a build that round-trips imports? */
export function keepsImports(caps: unknown): boolean {
  return Array.isArray(caps) && caps.includes(SETTINGS_KEEPS_IMPORTS);
}

/** ...and the cap of a build that also round-trips an import's practice tuning (`ImportedRobot.tune`) */
export const SETTINGS_KEEPS_TUNE = 'importTune';

/** does a settings save come from a build that round-trips practice tuning? */
export function keepsTune(caps: unknown): boolean {
  return Array.isArray(caps) && caps.includes(SETTINGS_KEEPS_TUNE);
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const isImported = (spec: unknown): boolean => isObj(spec) && isObj(spec.imported);
/** does this robot carry something an older build cannot read back (see the header)? */
const carriesNew = (spec: unknown): boolean =>
  isObj(spec) && (isObj(spec.imported) || spec.launcher !== undefined || spec.hoodDeg !== undefined || spec.flywheel !== undefined || spec.intake === 'none');

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
/**
 * The stored robot as an older build reads it back, for the fields it REWRITES rather than drops:
 * NO intake (`intake: 'none'`) is not a preset there, so it falls back to the sloped one and the
 * size is clamped to that preset's range (alpha's `coerceSpec`, measured 2026-10-02).
 */
function olderReading(stored: Obj): Obj {
  if (stored.intake !== 'none') return stored;
  const p = INTAKE_PRESETS.sloped;
  const floor = Math.max(stored.drivetrain === 'swerve' ? SWERVE_MIN_WIDTH : ROBOT_MIN_WIDTH, p.minWidth);
  return {
    ...stored,
    intake: 'sloped',
    length: Math.min(Math.max(num(stored.length, p.maxLength), p.minLength), p.maxLength),
    width: Math.min(Math.max(num(stored.width, floor), floor), ROBOT_MAX_SIZE),
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  const ka = Object.keys(a as Obj).filter((k) => (a as Obj)[k] !== undefined);
  const kb = Object.keys(b as Obj).filter((k) => (b as Obj)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Obj)[k], (b as Obj)[k]));
}

/** a robot an older client sent at least names and sizes these, whatever its build */
const SPEC_FLOOR = ['name', 'drivetrain', 'length', 'width'] as const;

/**
 * Is `sent` the robot `stored` with only the fields an older client cannot read taken off? Every
 * field `sent` carries must equal the stored one (as the older build reads it back, `olderReading`);
 * a field only `stored` has is one the older client dropped (`imported`, and whatever else it
 * predates). `sent` itself must carry no import.
 */
export function sameButDropped(sent: unknown, stored: unknown): boolean {
  if (!isObj(sent) || !isObj(stored) || isImported(sent)) return false;
  if (!SPEC_FLOOR.every((k) => sent[k] !== undefined)) return false;
  const read = olderReading(stored);
  for (const [k, v] of Object.entries(sent)) {
    if (v === undefined) continue;
    if (!(k in read) || !deepEqual(v, read[k])) return false;
  }
  return true;
}

const activeGame = (blob: Obj): GameId => (isGameId(blob.game) ? blob.game : 'decode');

/** game `g`'s loadout in a blob: the flat fields for its active game, else `loadouts[g]` */
function sliceOf(blob: Obj, g: GameId): Obj | null {
  if (activeGame(blob) === g) return blob;
  const lo = isObj(blob.loadouts) ? blob.loadouts[g] : undefined;
  return isObj(lo) ? lo : null;
}

/**
 * The blob to store for a settings save from a build that does NOT keep imports: `incoming` with the
 * account's imported robots (and their last standard robots) carried over from `stored` by the
 * three rules in the header. Returns `incoming` itself when nothing is carried; never mutates
 * either argument.
 */
export function keepImportsFromOlderClient(stored: unknown, incoming: Obj): Obj {
  if (!isObj(stored)) return incoming;
  let out: Obj | null = null;
  const own = (): Obj => (out ??= { ...incoming, ...(isObj(incoming.loadouts) ? { loadouts: { ...incoming.loadouts } } : {}) });
  const inActive = activeGame(incoming);
  for (const g of GAME_IDS) {
    const st = sliceOf(stored, g);
    if (!st || !carriesNew(st.spec)) continue;
    const sent = sliceOf(incoming, g);
    if (!sent) {
      // 3. a game the older client did not send at all (it does not know it): keep the stored loadout
      if (g === inActive) continue;
      const o = own();
      o.loadouts = { ...(isObj(o.loadouts) ? o.loadouts : {}), [g]: st };
      continue;
    }
    // 1. the same robot, minus what the older client could not read: the stored one, whole
    if (!sameButDropped(sent.spec, st.spec)) continue;
    const o = own();
    const target: Obj = g === inActive ? o : { ...(o.loadouts as Obj)[g] as Obj };
    target.spec = st.spec;
    // 2. its last standard robot, which only an imported robot needs
    if (target.lastStandardSpec === undefined && st.lastStandardSpec !== undefined) target.lastStandardSpec = st.lastStandardSpec;
    if (g !== inActive) (o.loadouts as Obj)[g] = target;
  }
  return out ?? incoming;
}

/**
 * 4. **Practice tuning** (`ImportedRobot.tune`). A build that keeps imports but predates tuning
 * (no `SETTINGS_KEEPS_TUNE`) sends the imported robot without it: its coercer rebuilds the import
 * field by field. When that robot is the stored one minus the tuning, the stored robot is kept
 * whole; any other difference is a real change and stands. Never mutates either argument.
 */
export function keepTuneFromOlderClient(stored: unknown, incoming: Obj): Obj {
  if (!isObj(stored)) return incoming;
  let out: Obj | null = null;
  const own = (): Obj => (out ??= { ...incoming, ...(isObj(incoming.loadouts) ? { loadouts: { ...incoming.loadouts } } : {}) });
  const inActive = activeGame(incoming);
  for (const g of GAME_IDS) {
    const st = sliceOf(stored, g);
    const sent = sliceOf(incoming, g);
    if (!st || !sent || !isObj(st.spec) || !isObj(sent.spec)) continue;
    const imp = st.spec.imported;
    if (!isObj(imp) || !isObj(imp.tune)) continue;
    const sentImp = sent.spec.imported;
    if (!isObj(sentImp) || sentImp.tune !== undefined) continue;
    if (!deepEqual(sent.spec, { ...st.spec, imported: { ...imp, tune: undefined } })) continue;
    const o = own();
    if (g === inActive) o.spec = st.spec;
    else (o.loadouts as Obj)[g] = { ...((o.loadouts as Obj)[g] as Obj), spec: st.spec };
  }
  return out ?? incoming;
}
