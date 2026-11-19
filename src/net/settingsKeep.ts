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
 * read (`carriesNew`): a fixed launcher, a fixed hood, a setpoint flywheel, NO intake, or coast
 * (`zeroPower`, any game; rule 5 covers the builds that keep imports but predate it). Measured
 * the same way (alpha's coercer, 2026-10-02): the three shooter fields are dropped, and `intake:
 * 'none'` comes back as the sloped preset with the length clamped to its 13.5–15 in and the width
 * raised to its 14.5 in floor (`olderReading`), so that rewrite is compared as "not read", not as
 * a change. Production's build (no caps) also drops `plateFont` and a BIOBUZZ intake's `feed` /
 * `reject` (`bbMech.intake` comes back as `{ kind }`), so those are `carriesNew` too (2026-11-18).
 *
 * DOM-free, no runtime imports beyond the game list and the bindings' action table: the server (`server/db/repo.ts`) and the smoke
 * suite read it, and the client reads the capability.
 */
import { GAME_IDS, isGameId } from '../games/types';
import type { GameId } from '../types';
import { INTAKE_PRESETS, ROBOT_MAX_SIZE, ROBOT_MIN_WIDTH, SWERVE_MIN_WIDTH } from '../config';
import { ACTION_GAMES } from '../input/bindings';

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

/** ...and the cap of a build that also round-trips the drive motors' zero-power mode (`RobotSpec.zeroPower`) */
export const SETTINGS_KEEPS_ZERO_POWER = 'zeroPower';

/** does a settings save come from a build that round-trips coast? */
export function keepsZeroPower(caps: unknown): boolean {
  return Array.isArray(caps) && caps.includes(SETTINGS_KEEPS_ZERO_POWER);
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const isImported = (spec: unknown): boolean => isObj(spec) && isObj(spec.imported);
/** does this robot carry something an older build cannot read back (see the header)? */
const carriesNew = (spec: unknown): boolean =>
  isObj(spec) &&
  (isObj(spec.imported) || spec.launcher !== undefined || spec.hoodDeg !== undefined || spec.flywheel !== undefined || spec.intake === 'none' || spec.zeroPower !== undefined ||
    spec.plateFont !== undefined || bbIntakeChoice(spec));
/** a BIOBUZZ robot's intake FEED or opponent-NECTAR choice (2026-10-24), which production's coercer drops */
const bbIntakeChoice = (spec: Obj): boolean =>
  isObj(spec.bbMech) && isObj(spec.bbMech.intake) && (spec.bbMech.intake.feed !== undefined || spec.bbMech.intake.reject !== undefined);

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
/**
 * The stored robot as an older build reads it back, for the fields it REWRITES rather than drops:
 * NO intake (`intake: 'none'`) is not a preset there, so it falls back to the sloped one and the
 * size is clamped to that preset's range (alpha's `coerceSpec`, measured 2026-10-02).
 */
function olderReading(stored: Obj): Obj {
  let read = stored;
  // a BIOBUZZ intake's feed and reject: production's coercer rebuilds `bbMech.intake` as `{ kind }`
  if (bbIntakeChoice(stored)) {
    const mech = stored.bbMech as Obj;
    read = { ...read, bbMech: { ...mech, intake: { kind: (mech.intake as Obj).kind } } };
  }
  if (stored.intake !== 'none') return read;
  const p = INTAKE_PRESETS.sloped;
  const floor = Math.max(stored.drivetrain === 'swerve' ? SWERVE_MIN_WIDTH : ROBOT_MIN_WIDTH, p.minWidth);
  return {
    ...read,
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
 * three rules in the header, and the newer settings and binds by rule 6
 * (`keepNewerFieldsFromOlderClient`). Returns `incoming` itself when nothing is carried; never
 * mutates either argument.
 */
export function keepImportsFromOlderClient(stored: unknown, incoming: Obj): Obj {
  if (!isObj(stored)) return incoming;
  // the same build predates every setting and bind in rule 6, so they are carried first
  incoming = keepNewerFieldsFromOlderClient(stored, incoming);
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

/**
 * 5. **Coast** (`RobotSpec.zeroPower`). A build that predates it (no `SETTINGS_KEEPS_ZERO_POWER`)
 * rebuilds every robot without the field, so its save turns a coasting robot back into a braking
 * one on every other device. Per game, the active robot, the last standard robot and each saved
 * robot that came back as the stored one minus `zeroPower` gets the stored one back. Saved robots
 * pair by position, since an older build keeps the list's order. Any other difference is a real
 * change and stands. Never mutates either argument.
 */
export function keepZeroPowerFromOlderClient(stored: unknown, incoming: Obj): Obj {
  if (!isObj(stored)) return incoming;
  let out: Obj | null = null;
  const own = (): Obj => (out ??= { ...incoming, ...(isObj(incoming.loadouts) ? { loadouts: { ...incoming.loadouts } } : {}) });
  const inActive = activeGame(incoming);
  const lostCoast = (sent: unknown, st: unknown): boolean =>
    isObj(st) && st.zeroPower !== undefined && isObj(sent) && sent.zeroPower === undefined && deepEqual(sent, { ...st, zeroPower: undefined });
  for (const g of GAME_IDS) {
    const st = sliceOf(stored, g);
    const sent = sliceOf(incoming, g);
    if (!st || !sent) continue;
    const patch: Obj = {};
    for (const k of ['spec', 'lastStandardSpec']) if (lostCoast(sent[k], st[k])) patch[k] = st[k];
    const stSaved = st.savedRobots;
    if (Array.isArray(sent.savedRobots) && Array.isArray(stSaved) && sent.savedRobots.some((r, i) => lostCoast(r, stSaved[i]))) {
      patch.savedRobots = sent.savedRobots.map((r, i) => (lostCoast(r, stSaved[i]) ? stSaved[i] : r));
    }
    if (Object.keys(patch).length === 0) continue;
    const o = own();
    if (g === inActive) Object.assign(o, patch);
    else (o.loadouts as Obj)[g] = { ...((o.loadouts as Obj)[g] as Obj), ...patch };
  }
  return out ?? incoming;
}

/** the top-level settings production's build does not read (`coerceSettings` on `main`, 2026-11-18) */
const NEWER_SETTINGS = ['runLength', 'communityToasts', 'pace', 'paceReplays'] as const;
/** the actions production's bindings do not know; each lives in the main maps (season-only, folded there) */
const NEWER_ACTIONS = ['flyPreset', 'bbReverse', 'bbBar'] as const;

/**
 * Did the older build give an entry of `list` to another action that plays in a game `a` plays in?
 * Only an entry that action did not already hold in the stored map counts: a key the player shared
 * on purpose is the player's, not a choice the older build made.
 */
function bindClash(a: string, list: unknown[], map: Obj, storedMap: Obj): boolean {
  const gamesOf = (x: string): readonly GameId[] => (ACTION_GAMES as Record<string, readonly GameId[] | undefined>)[x] ?? GAME_IDS;
  const games = gamesOf(a);
  return Object.entries(map).some(([o, v]) => {
    if (o === a || !Array.isArray(v) || !gamesOf(o).some((g) => games.includes(g))) return false;
    const had = storedMap[o];
    return v.some((x) => list.includes(x) && !(Array.isArray(had) && had.includes(x)));
  });
}

/**
 * 6. **What production's build cannot read back** (2026-11-18). Both deployments sign in to one
 * account and the alpha's row is a copy of production's, so a save from a build with NO settings
 * caps (production's `main`, and alpha builds from before the import) arrives rebuilt from the
 * fields that build knows. Every field below is one it does not know, so its absence is "not read",
 * never "cleared": the stored value is carried over. A build that knows a field writes it or prunes
 * it on purpose, which is why this runs only for a save with no caps (`saveSettingsFromClient`).
 *  · `runLength`, `communityToasts`, `pace`, `paceReplays`, and `audio.volume.penalty`;
 *  · `bindings.modes` (hold or toggle);
 *  · `bindings.pad.turnCurve`, only where the player split it from `curve`: an unsplit one follows
 *    the curve the older build saved, as it does when it is absent;
 *  · the binds of `flyPreset`, `bbReverse` and `bbBar` (keys, and the pad's buttons and combos as
 *    one), unless the older build gave one of those keys or buttons to another action of a game
 *    the action plays in: that later choice stands, and the action is left absent, where the
 *    bindings merge seats it on its default or a free fallback.
 * A robot field it does not know is rules 1 and 3 (`carriesNew`). Never mutates either argument.
 */
export function keepNewerFieldsFromOlderClient(stored: unknown, incoming: Obj): Obj {
  if (!isObj(stored)) return incoming;
  const out: Obj = { ...incoming };
  let changed = false;
  for (const k of NEWER_SETTINGS) {
    if (out[k] === undefined && stored[k] !== undefined) {
      out[k] = stored[k];
      changed = true;
    }
  }
  const stVol = isObj(stored.audio) && isObj(stored.audio.volume) ? stored.audio.volume : null;
  if (stVol && stVol.penalty !== undefined && isObj(out.audio) && isObj(out.audio.volume) && out.audio.volume.penalty === undefined) {
    out.audio = { ...out.audio, volume: { ...out.audio.volume, penalty: stVol.penalty } };
    changed = true;
  }
  const sb = stored.bindings;
  const ib = out.bindings;
  if (isObj(sb) && isObj(ib)) {
    const b: Obj = { ...ib };
    let bChanged = false;
    if (b.modes === undefined && isObj(sb.modes)) {
      b.modes = sb.modes;
      bChanged = true;
    }
    if (isObj(sb.keys) && isObj(b.keys)) {
      let keys: Obj | null = null;
      for (const a of NEWER_ACTIONS) {
        const list = sb.keys[a];
        if (b.keys[a] !== undefined || !Array.isArray(list) || bindClash(a, list, b.keys, sb.keys)) continue;
        (keys ??= { ...b.keys })[a] = list;
      }
      if (keys) {
        b.keys = keys;
        bChanged = true;
      }
    }
    const sp = sb.pad;
    if (isObj(sp) && isObj(b.pad)) {
      const pad: Obj = { ...b.pad };
      let padChanged = false;
      if (pad.turnCurve === undefined && typeof sp.turnCurve === 'number' && sp.turnCurve !== sp.curve) {
        pad.turnCurve = sp.turnCurve;
        padChanged = true;
      }
      if (isObj(sp.buttons) && isObj(pad.buttons)) {
        const buttons: Obj = { ...pad.buttons };
        const combos: Obj = isObj(pad.combos) ? { ...pad.combos } : {};
        for (const a of NEWER_ACTIONS) {
          const list = sp.buttons[a];
          if (buttons[a] !== undefined || !Array.isArray(list) || bindClash(a, list, pad.buttons as Obj, sp.buttons)) continue;
          buttons[a] = list;
          const ch = isObj(sp.combos) ? sp.combos[a] : undefined;
          if (combos[a] === undefined && Array.isArray(ch)) combos[a] = ch;
          padChanged = true;
        }
        if (padChanged) {
          pad.buttons = buttons;
          if (isObj(pad.combos) || Object.keys(combos).length) pad.combos = combos;
        }
      }
      if (padChanged) {
        b.pad = pad;
        bChanged = true;
      }
    }
    if (bChanged) {
      out.bindings = b;
      changed = true;
    }
  }
  return changed ? out : incoming;
}
