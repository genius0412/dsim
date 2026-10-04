/**
 * ROBOT IMPORT â€” real drivetrain hardware â†’ the sim's numbers. DOM-free, main-chunk safe.
 *
 * The sim models a drivetrain as a WHEEL RPM AT A 104 MM WHEEL (`SPEED_PER_RPM`, `src/config.ts`),
 * so a real build maps onto it by surface speed:
 *
 *   equivalent rpm = motor free rpm Ã· external ratio Ã— (wheel mm Ã· 104)
 *
 * which keeps both the top speed (âˆ rpm Ã— diameter) and the torque at the tread (âˆ 1 Ã· that)
 * right. Everything the UI shows beside it comes from `driveParams` / `pushForce` of the spec
 * that will actually be driven, clamped exactly as `coerceSpec` clamps it, so what is displayed
 * is what is driven.
 *
 * CATALOGUE SOURCES (read 2026-10-01, manufacturer pages):
 *  - goBILDA 5203/5204 Yellow Jacket: https://www.gobilda.com/yellow-jacket-planetary-gear-motors
 *    (per-ratio pages, e.g. â€¦-19-2-1-ratio-â€¦-312-rpm-3-3-5v-encoder/). Exact ratios are goBILDA's
 *    own formulas, a = 1 + 46/17, b = 1 + 46/11. The 5204 lists the same ratios and speeds.
 *  - REV HD Hex (REV-41-1291), 6000 rpm: https://www.revrobotics.com/rev-41-1291/
 *  - UltraPlanetary actual ratios 84:29, 76:21, 68:13:
 *    https://docs.revrobotics.com/rev-crossover-products/ultraplanetary/cartridge-details
 *  - REV Core Hex (REV-41-1300), 125 rpm, 72:1: https://www.revrobotics.com/rev-41-1300/
 *  - NeveRest Orbital 20 (344 rpm) and 3.7 (1784 rpm): https://andymark.com/products/neverest-orbital-gearmotors
 *  - Wheels: gobilda.com (96/104/140 mm mecanum, 96 mm omni, Gecko, Hogback, Rhino),
 *    revrobotics.com (REV-45-1655 75 mm mecanum, REV-41-1190 90 mm omni, REV-41-1160 60 mm omni,
 *    REV-41-1354 90 mm traction, REV-41-1267 90 mm grip), andymark.com (4 in HD mecanum,
 *    4 in DuraOmni).
 */
import type { DrivetrainType, RobotSpec } from '../types';
import * as C from '../config';
import { butterflyTankRpmLimits, driveParams, massLimits, pushForce, rpmLimits } from '../sim/drivetrain';
import type { DriveSetup, ImportCheck, MotorChoice, WheelChoice } from './types';

/** the sim's reference wheel (`C.WHEEL_DIAMETER_MM`) */
export const SIM_WHEEL_MM = C.WHEEL_DIAMETER_MM;
/** gravity in in/sÂ², to turn `pushForce` (lbÂ·in/sÂ²) into pounds-force */
const G_IN_S2 = 386.0886;

// ---- motors ------------------------------------------------------------------------------

const GB_A = 1 + 46 / 17;
const GB_B = 1 + 46 / 11;

/** goBILDA Yellow Jacket gearboxes: the listed free rpm at 12 V and the exact ratio */
export const GOBILDA_RATIOS: Readonly<Record<string, { ratio: number; freeRpm: number }>> = {
  '1': { ratio: 1, freeRpm: 6000 },
  '3.7': { ratio: GB_A, freeRpm: 1620 },
  '5.2': { ratio: GB_B, freeRpm: 1150 },
  '13.7': { ratio: GB_A * GB_A, freeRpm: 435 },
  '19.2': { ratio: GB_A * GB_B, freeRpm: 312 },
  '26.9': { ratio: GB_B * GB_B, freeRpm: 223 },
  '50.9': { ratio: GB_A ** 3, freeRpm: 117 },
  '71.2': { ratio: GB_A * GB_A * GB_B, freeRpm: 84 },
  '99.5': { ratio: GB_A * GB_B * GB_B, freeRpm: 60 },
  '139': { ratio: GB_B ** 3, freeRpm: 43 },
  '188': { ratio: GB_A ** 4, freeRpm: 30 },
};

export const REV_HD_HEX_FREE_RPM = 6000;
/** UltraPlanetary cartridges: nominal â†’ ACTUAL ratio (84:29, 76:21, 68:13) */
export const ULTRAPLANETARY: Readonly<Record<3 | 4 | 5, number>> = { 3: 84 / 29, 4: 76 / 21, 5: 68 / 13 };
/** REV documents gear charts for up to three stages */
export const ULTRAPLANETARY_MAX_STAGES = 3;
export const REV_CORE_HEX_FREE_RPM = 125;
export const NEVEREST: Readonly<Record<'orbital20' | 'orbital3.7', { ratio: number; freeRpm: number }>> = {
  orbital20: { ratio: 19.2, freeRpm: 344 },
  'orbital3.7': { ratio: 3.7, freeRpm: 1784 },
};

/** output-shaft free rpm of a motor choice (gearbox included, external ratio not) */
export function motorFreeRpm(m: MotorChoice): number {
  switch (m.kind) {
    case 'gobilda':
      return GOBILDA_RATIOS[m.ratio]?.freeRpm ?? GOBILDA_RATIOS['19.2'].freeRpm;
    case 'revHdHex': {
      const stages = m.cartridges.slice(0, ULTRAPLANETARY_MAX_STAGES);
      let r = 1;
      for (const s of stages) r *= ULTRAPLANETARY[s] ?? 1;
      return REV_HD_HEX_FREE_RPM / r;
    }
    case 'revCoreHex':
      return REV_CORE_HEX_FREE_RPM;
    case 'neverest':
      return NEVEREST[m.model]?.freeRpm ?? NEVEREST.orbital20.freeRpm;
    case 'custom':
      return Number.isFinite(m.freeRpm) && m.freeRpm > 0 ? m.freeRpm : 0;
  }
}

/** a short label for a motor choice, e.g. "goBILDA 19.2:1" or "REV HD Hex 4:1 Ã— 5:1" */
export function motorLabel(m: MotorChoice): string {
  switch (m.kind) {
    case 'gobilda':
      return `goBILDA Yellow Jacket ${m.ratio}:1`;
    case 'revHdHex':
      return m.cartridges.length ? `REV HD Hex ${m.cartridges.map((c) => `${c}:1`).join(' Ã— ')}` : 'REV HD Hex (no gearbox)';
    case 'revCoreHex':
      return 'REV Core Hex';
    case 'neverest':
      return m.model === 'orbital20' ? 'NeveRest Orbital 20' : 'NeveRest Orbital 3.7';
    case 'custom':
      return `Custom, ${Math.round(m.freeRpm)} rpm`;
  }
}

// ---- wheels ------------------------------------------------------------------------------

export interface WheelEntry {
  id: string;
  label: string;
  diameterMm: number;
  type: 'mecanum' | 'omni' | 'traction';
}

export const WHEELS: readonly WheelEntry[] = [
  { id: 'gobilda-mecanum-96', label: 'goBILDA mecanum 96 mm', diameterMm: 96, type: 'mecanum' },
  { id: 'gobilda-gripforce-104', label: 'goBILDA GripForce mecanum 104 mm', diameterMm: 104, type: 'mecanum' },
  { id: 'gobilda-mecanum-140', label: 'goBILDA mecanum 140 mm', diameterMm: 140, type: 'mecanum' },
  { id: 'rev-mecanum-75', label: 'REV mecanum 75 mm', diameterMm: 75, type: 'mecanum' },
  { id: 'andymark-hd-mecanum-4in', label: 'AndyMark HD mecanum 4 in', diameterMm: 101.6, type: 'mecanum' },
  { id: 'gobilda-omni-96', label: 'goBILDA omni 96 mm', diameterMm: 96, type: 'omni' },
  { id: 'gobilda-omni-72', label: 'goBILDA omni 72 mm', diameterMm: 72, type: 'omni' },
  { id: 'rev-omni-90', label: 'REV omni 90 mm', diameterMm: 90, type: 'omni' },
  { id: 'rev-omni-60', label: 'REV omni 60 mm', diameterMm: 60, type: 'omni' },
  { id: 'andymark-duraomni-4in', label: 'AndyMark DuraOmni 4 in', diameterMm: 101.6, type: 'omni' },
  { id: 'gobilda-gecko-96', label: 'goBILDA GripForce Gecko 96 mm', diameterMm: 96, type: 'traction' },
  { id: 'gobilda-hogback-96', label: 'goBILDA Hogback traction 96 mm', diameterMm: 96, type: 'traction' },
  { id: 'gobilda-rhino-96', label: 'goBILDA Rhino 96 mm', diameterMm: 96, type: 'traction' },
  { id: 'gobilda-rhino-120', label: 'goBILDA Rhino 120 mm', diameterMm: 120, type: 'traction' },
  { id: 'rev-traction-90', label: 'REV traction 90 mm', diameterMm: 90, type: 'traction' },
  { id: 'rev-grip-90', label: 'REV grip 90 mm', diameterMm: 90, type: 'traction' },
];

const MM_PER_IN = 25.4;

/** wheel diameter, mm (0 when a custom value is not a positive number) */
export function wheelDiameterMm(w: WheelChoice): number {
  if (w.kind === 'custom') return Number.isFinite(w.diameterMm) && w.diameterMm > 0 ? w.diameterMm : 0;
  return WHEELS.find((e) => e.id === w.id)?.diameterMm ?? SIM_WHEEL_MM;
}

/** a custom wheel typed in inches */
export const wheelFromInches = (inches: number): WheelChoice => ({ kind: 'custom', diameterMm: inches * MM_PER_IN });

// ---- the conversion ----------------------------------------------------------------------

/**
 * THE MAPPING. The sim's `driveRpm` is a wheel rpm at a 104 mm wheel, so a real wheel turning at
 * `freeRpm / externalRatio` with diameter `wheelMm` has the same surface speed as a 104 mm wheel
 * at that Ã— `wheelMm / 104`. goBILDA 19.2:1, direct, 104 mm â†’ 312.
 */
export function equivalentDriveRpm(motorRpm: number, externalRatio: number, wheelMm: number): number {
  if (!(motorRpm > 0) || !(externalRatio > 0) || !(wheelMm > 0)) return 0;
  return (motorRpm / externalRatio) * (wheelMm / SIM_WHEEL_MM);
}

/** the equivalent rpm of both wheel sets (the tank set only for a butterfly), unclamped */
export function driveRpmFor(d: DriveSetup): { rpm: number; tankRpm?: number } {
  const motor = motorFreeRpm(d.motor);
  const rpm = equivalentDriveRpm(motor, d.externalRatio, wheelDiameterMm(d.wheel));
  if (d.drivetrain !== 'butterfly') return { rpm };
  const tankRpm = equivalentDriveRpm(motor, d.tankExternalRatio ?? d.externalRatio, wheelDiameterMm(d.tankWheel ?? d.wheel));
  return { rpm, tankRpm };
}

// ---- the readout -----------------------------------------------------------------------

export interface DriveReadout {
  /** the equivalent rpm before clamping, and what the sim will drive */
  equivalentRpm: number;
  driveRpm: number;
  tankEquivalentRpm?: number;
  tankRpm?: number;
  massLb: number;
  /** sim truth, from `driveParams` / `pushForce` of the clamped spec */
  topSpeedInS: number;
  topSpeedFtS: number;
  strafeInS: number;
  accelInS2: number;
  turnRadS: number;
  pushLbf: number;
  /** butterfly only: the same numbers with the traction set down */
  tank?: { topSpeedInS: number; accelInS2: number; pushLbf: number };
  rpmRange: { min: number; max: number };
  massRange: { min: number; max: number };
  checks: ImportCheck[];
}

const r1 = (v: number): number => Math.round(v * 10) / 10;
/** the spec stores rpm and weight to 0.01, so the readout and the saved spec agree exactly */
const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * What the sim will do with this spec, and every clamp it applies, as plain-language checks.
 * `raw` carries the values the player chose before clamping (the equivalent rpm off the gearing,
 * the weight off the scale); the spec itself is clamped here exactly as `coerceSpec` clamps it.
 * `extraMassFloor` is lb of mechanism a game adds to the mass floor (`massLimits`).
 */
export function driveReadout(
  spec: RobotSpec,
  raw: { driveRpm?: number; tankRpm?: number; massLb?: number } = {},
  extraMassFloor = 0,
): DriveReadout {
  const dt: DrivetrainType = spec.drivetrain;
  const rpmRange = rpmLimits(dt);
  const massRange = massLimits(dt, spec.flywheelInertia, extraMassFloor);
  const wantRpm = raw.driveRpm ?? spec.driveRpm;
  const wantMass = raw.massLb ?? spec.massLb;
  const driveRpm = round2(Math.min(rpmRange.max, Math.max(rpmRange.min, Number.isFinite(wantRpm) ? wantRpm : rpmRange.min)));
  const massLb = round2(Math.min(massRange.max, Math.max(massRange.min, Number.isFinite(wantMass) ? wantMass : massRange.min)));
  const checks: ImportCheck[] = [];
  if (wantRpm < rpmRange.min) {
    checks.push({
      code: 'rpm-low',
      level: 'warn',
      message: `This gearing works out to ${Math.round(wantRpm)} rpm at a 104 mm wheel; the simâ€™s slowest ${dt} is ${rpmRange.min}, so it drives at ${rpmRange.min}.`,
    });
  } else if (wantRpm > rpmRange.max) {
    checks.push({
      code: 'rpm-high',
      level: 'warn',
      message: `This gearing works out to ${Math.round(wantRpm)} rpm at a 104 mm wheel; the simâ€™s fastest ${dt} is ${rpmRange.max}, so it drives at ${rpmRange.max}.`,
    });
  }
  if (wantMass < massRange.min) {
    checks.push({
      code: 'mass-low',
      level: 'warn',
      message: `${r1(wantMass)} lb is under the simâ€™s ${massRange.min} lb floor for this build, so it drives as ${massRange.min} lb.`,
    });
  } else if (wantMass > massRange.max) {
    checks.push({
      code: 'mass-high',
      level: 'warn',
      message: `${r1(wantMass)} lb is over the simâ€™s ${massRange.max} lb limit for this build, so it drives as ${massRange.max} lb.`,
    });
  }
  let tankRpm: number | undefined;
  const tankEquivalentRpm = dt === 'butterfly' ? (raw.tankRpm ?? spec.tankRpm ?? wantRpm) : undefined;
  if (tankEquivalentRpm !== undefined) {
    const L = butterflyTankRpmLimits();
    tankRpm = round2(Math.min(L.max, Math.max(L.min, tankEquivalentRpm)));
    if (tankEquivalentRpm < L.min || tankEquivalentRpm > L.max) {
      checks.push({
        code: 'tank-rpm-clamped',
        level: 'warn',
        message: `The traction set works out to ${Math.round(tankEquivalentRpm)} rpm; the sim drives it at ${Math.round(tankRpm)} (range ${L.min}â€“${L.max}).`,
      });
    }
  }
  const s: RobotSpec = { ...spec, driveRpm, massLb, ...(tankRpm !== undefined ? { tankRpm } : {}) };
  const p = driveParams(s);
  const out: DriveReadout = {
    equivalentRpm: wantRpm,
    driveRpm,
    massLb,
    topSpeedInS: p.maxSpeed,
    topSpeedFtS: p.maxSpeed / 12,
    strafeInS: p.maxSpeed * p.strafeMult,
    accelInS2: p.accel,
    turnRadS: p.maxTurn,
    pushLbf: pushForce(s) / G_IN_S2,
    rpmRange,
    massRange,
    checks,
  };
  if (tankRpm !== undefined) {
    out.tankEquivalentRpm = tankEquivalentRpm;
    out.tankRpm = tankRpm;
    const pt = driveParams(s, true);
    out.tank = { topSpeedInS: pt.maxSpeed, accelInS2: pt.accel, pushLbf: pushForce(s, true) / G_IN_S2 };
  }
  return out;
}

/**
 * The parametric half of an imported spec (plan Â§3.1): drivetrain, the clamped equivalent rpm,
 * the clamped weight, and `length`/`width` from the hull's bounding box (clamped to the cube) so
 * a reader that knows nothing about imports still sees a legal rectangle. The caller adds
 * `imported` and the game's mechanism fields; `coerceSpec` has the last word on both.
 */
export function importedDriveFields(
  base: RobotSpec,
  d: DriveSetup,
  hullBox: { length: number; width: number },
  extraMassFloor = 0,
): Pick<RobotSpec, 'drivetrain' | 'driveRpm' | 'massLb' | 'length' | 'width' | 'tankRpm'> {
  const { rpm, tankRpm } = driveRpmFor(d);
  const probe: RobotSpec = { ...base, drivetrain: d.drivetrain };
  const ro = driveReadout(probe, { driveRpm: rpm, tankRpm, massLb: d.massLb }, extraMassFloor);
  const fields: Pick<RobotSpec, 'drivetrain' | 'driveRpm' | 'massLb' | 'length' | 'width' | 'tankRpm'> = {
    drivetrain: d.drivetrain,
    driveRpm: ro.driveRpm,
    massLb: ro.massLb,
    length: Math.min(C.ROBOT_MAX_SIZE, Math.max(1, hullBox.length)),
    width: Math.min(C.ROBOT_MAX_SIZE, Math.max(1, hullBox.width)),
  };
  if (ro.tankRpm !== undefined) fields.tankRpm = ro.tankRpm;
  return fields;
}
