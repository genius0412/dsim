/**
 * THE PRACTICE-TUNING FIELDS (`ImportTuning`, `docs/area/robot-import.md`, "Practice tuning"): which
 * ones a build has, and the number the sim derives for each when it is not tuned (what the field
 * shows until the player types over it). Editor-only; the sim reads the values where it reads its
 * own (`driveParams`, each game's fire, intake and turret code).
 */
import type { GameId } from '../../games/types';
import type { ImportTuning, RobotSpec } from '../../types';
import * as C from '../../config';
import { driveParams } from '../../sim/drivetrain';
import { decodeFixedLauncher } from '../../sim/fixedShot';
import { IMPORT_TUNE } from '../../sim/imported';
import { BB_DUMP_RELOAD_S, BB_FIRE_INTERVAL, BB_FIXED_FLY_DEFAULT, BB_HOOD_DEFAULT_DEG, BB_RAMP_DEPLOY_S, BB_TURRET_SLEW } from '../../games/biobuzz/config';
import { bbIntakeKindOf, bbIsTurreted, bbLauncherOf } from '../../games/biobuzz/mechs';
import { CHAIN_DUMP_INTERVAL, CHAIN_FIRE_INTERVAL, CHAIN_TURRET_SLEW, CHAIN_TWIN_FIRE_MULT } from '../../games/chain/config';
import { COPY } from './copy';

export type TuneKey = keyof ImportTuning;

export interface TuneField {
  key: TuneKey;
  label: string;
  unit: string;
  /** what the sim derives for this build, in the field's unit */
  calculated: number;
  min: number;
  max: number;
  step: number;
}

const DEG = 180 / Math.PI;

/** a field over `IMPORT_TUNE[key]`'s range, its calculated value put inside it */
function field(key: TuneKey, calculated: number): TuneField {
  const L = IMPORT_TUNE[key];
  return { key, label: COPY.tune[key].label, unit: COPY.tune[key].unit, calculated: Math.min(L.max, Math.max(L.min, calculated)), min: L.min, max: L.max, step: L.step };
}

/** `spec` as the sim derives it, without its tuning */
function untuned(spec: RobotSpec): RobotSpec {
  if (!spec.imported?.tune) return spec;
  const { tune: _t, ...imported } = spec.imported;
  void _t;
  return { ...spec, imported };
}

/** the Drivetrain step's three: top speed, acceleration, turn rate. An untuned turn rate follows a
 *  tuned top speed (`driveParams`), so its calculated value is read with the speed tuning on. */
export function driveTuneFields(spec: RobotSpec): TuneField[] {
  const p = driveParams(untuned(spec));
  const tune = spec.imported?.tune;
  const turn = tune?.topSpeed !== undefined ? driveParams({ ...spec, imported: { ...spec.imported!, tune: { topSpeed: tune.topSpeed } } }).maxTurn : p.maxTurn;
  return [field('topSpeed', p.maxSpeed), field('accel', p.accel), field('turnRate', turn * DEG)];
}

/** the Mechanisms step's: what this build's launcher, intake and ramp have */
export function mechTuneFields(game: GameId, spec: RobotSpec): TuneField[] {
  const s = untuned(spec);
  const out: TuneField[] = [];
  const spinUp = (): number => C.FLY_RAMP_RPM_S * (1 - C.FLY_RAMP_INERTIA_SLOW * Math.min(1, Math.max(0, s.flywheelInertia)));
  if (game === 'decode') {
    const ip = C.INTAKE_PRESETS[s.intake];
    const sort = s.canSort ? C.SORT_FIRE_PENALTY : 0;
    const shot = s.flywheel ? Math.max(s.flywheel.feedS + sort, ip.fireCap) : Math.max(ip.fireInterval + sort, ip.fireCap);
    out.push(field('shotInterval', shot));
    if (s.flywheel) out.push(field('spinUp', spinUp()));
    if (decodeFixedLauncher(s)) out.push(field('aimTurn', driveParams(s).maxTurn * DEG));
    if (s.intake !== 'none') out.push(field('intakeTime', 1));
  } else if (game === 'biobuzz') {
    const l = bbLauncherOf(s, BB_HOOD_DEFAULT_DEG);
    if (l.kind === 'fixed') {
      out.push(field('shotInterval', s.flywheel?.feedS ?? BB_FIXED_FLY_DEFAULT.feedS));
      out.push(field('spinUp', spinUp()));
      out.push(field('aimTurn', driveParams(s).maxTurn * DEG));
    } else if (l.kind === 'dumper') {
      out.push(field('reload', BB_DUMP_RELOAD_S));
    } else if (bbIsTurreted(l)) {
      out.push(field('shotInterval', BB_FIRE_INTERVAL));
      out.push(field('turretSlew', BB_TURRET_SLEW * DEG));
    }
    out.push(field('intakeTime', 1));
    if (bbIntakeKindOf(s) === 'ramp') out.push(field('rampDeployS', BB_RAMP_DEPLOY_S));
  } else {
    if (s.scoreMode === 'turret' || s.scoreMode === 'twinturret') {
      out.push(field('shotInterval', s.scoreMode === 'twinturret' ? CHAIN_FIRE_INTERVAL / CHAIN_TWIN_FIRE_MULT : CHAIN_FIRE_INTERVAL));
      out.push(field('turretSlew', CHAIN_TURRET_SLEW * DEG));
    } else if (s.scoreMode === 'dumper') {
      out.push(field('reload', CHAIN_DUMP_INTERVAL));
    }
  }
  return out;
}

/** `tune` with `key` set, or cleared when `v` is undefined; undefined when nothing is left */
export function setTune(tune: ImportTuning | undefined, key: TuneKey, v: number | undefined): ImportTuning | undefined {
  const next: ImportTuning = { ...(tune ?? {}) };
  if (v === undefined) delete next[key];
  else next[key] = v;
  return Object.keys(next).length ? next : undefined;
}
