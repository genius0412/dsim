import type { RobotSpec } from '../types';
import {
  CHAIN_CLEARANCE_DEFAULT,
  CHAIN_DEFAULT_INTAKE,
  CHAIN_DEFAULT_CATALYST,
  CHAIN_DEFAULT_CATALYST_MOUNT,
  CHAIN_CATAPULT_RANGE_DEFAULT,
  CHAIN_CATAPULT_YAW_DEFAULT,
  CHAIN_DEFAULT_SCORE_MODE,
  CHAIN_STORAGE_DEFAULT,
} from '../games/chain/config';
import { CHAIN_DEFAULT_INTAKE_MOUNT, CHAIN_DEFAULT_TURRET_POS } from '../games/chain/mounts';

/**
 * THE DEFAULT ROBOT SPEC, IN A LEAF MODULE — imported by `src/sim/spawn.ts`, which
 * RE-EXPORTS it, so every existing `import { DEFAULT_SPEC } from './spawn'` is unchanged.
 *
 * ── WHY IT IS NOT IN `spawn.ts` ANY MORE ───────────────────────────────────
 * Because `spawn.ts` is inside an import CYCLE and this value is read at MODULE-EVAL TIME by
 * a game module. `spawn.ts` imports `simModuleFor` (the per-game start-anchor clamp) from
 * `../games/sim`, which imports every game's sim module, which import `spawn.ts` back. A cycle
 * is safe only while nothing is read during evaluation — `spawn.ts`'s own registry read is a
 * hoisted function call at runtime, and `SIM_GAMES`' entries are getters for the same reason
 * (see CLAUDE.md's Gotchas).
 *
 * `src/games/biobuzz/coerce.ts` breaks that rule by necessity: its `BB_DEFAULT_SPEC` is
 * `{ ...DEFAULT_SPEC, ...BB_PRESETS[0] }`, a top-level spread, and ES modules evaluate a
 * module's dependencies BEFORE its own body — so `games/sim` → `biobuzz/sim` →
 * `biobuzz/spawn` → the coercer all ran while `spawn.ts` was still mid-evaluation and
 * `DEFAULT_SPEC` was in its TDZ. The failure is a hard
 * `ReferenceError: Cannot access 'DEFAULT_SPEC' before initialization` at import time, and it
 * appeared the moment BIOBUZZ's real module replaced the placeholder — the placeholder never
 * reached a file with a top-level read.
 *
 * A LEAF cannot be mid-evaluation when somebody reads it: it has no path back to `spawn.ts`,
 * so it is fully evaluated before anything in the cycle starts. Its only imports are
 * `../types` and Chain Reaction's two constant modules, both of which are leaves themselves.
 * Keep it that way — an import here that reaches `spawn.ts`, `physicsEngine.ts` or a game
 * module puts the cycle back.
 */

// A new player starts on the TW BUILD (Turtle Walkers' archetype) but with a
// generic identity they fill in themselves — a preset is a build, not a name.
export const DEFAULT_SPEC: RobotSpec = {
  name: 'My Robot',
  teamName: '',
  teamNumber: 0,
  length: 14.5,
  width: 16.5,
  intake: 'sloped',
  massLb: 23.5,
  drivetrain: 'mecanum',
  driveRpm: 500,
  flywheelInertia: 0.4,
  canSort: false,
  ballStorage: CHAIN_STORAGE_DEFAULT,
  groundClearance: CHAIN_CLEARANCE_DEFAULT,
  scoreMode: CHAIN_DEFAULT_SCORE_MODE,
  chainIntake: CHAIN_DEFAULT_INTAKE,
  intakeMount: CHAIN_DEFAULT_INTAKE_MOUNT,
  shooterMount: CHAIN_DEFAULT_TURRET_POS, // DEFAULT_SPEC is a TURRET, so this is a position
  catalystType: CHAIN_DEFAULT_CATALYST,
  catalystMount: CHAIN_DEFAULT_CATALYST_MOUNT,
  catapultRange: CHAIN_CATAPULT_RANGE_DEFAULT,
  catapultYaw: CHAIN_CATAPULT_YAW_DEFAULT,
  // deprecated mirrors of the two mounts above (kept in sync by coerceSpec)
  intakeSide: false,
  shooterRear: false,
  // driver assists ride the ROBOT (both games) — all ON by default. See PLAYER_ASSISTS.
  assists: { fieldCentric: true, aimAssist: true, autoIntake: true, autoFire: true },
};
