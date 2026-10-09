import type { ImportedMech, RobotSpec } from '../types';
import type { GameId, ImportMechHandle, ImportMechIssue, ImportMechSlot } from './types';
import { DECODE_IMPORT_MECH } from './decode/importChecks';
import { CHAIN_IMPORT_MECH } from './chain/importChecks';
import { BB_IMPORT_MECH } from './biobuzz/importChecks';

/**
 * IMPORTED ROBOTS: what the mechanism placement editor asks a game — the handles it may drag, the
 * pre-fill, and the plain-language checks (`docs/robot-import-plan.md` §1, "Plain-language
 * checks"). One `ImportMechSlot` per game (`<game>/importChecks.ts`), registered below.
 *
 * ⚠️ ONLY THE EDITOR (`robotImport/ui/placement.ts`, lazy) AND THE SMOKE SUITE IMPORT THIS. The
 * slots used to hang off `GameSimModule.importMech`, so the three games' check code and the shared
 * `importChecks.ts` helpers were in the entry chunk of every page — measured at ~3 KB gzipped — to
 * serve a screen one player in a hundred opens. Do not import this from the sim registry, the
 * server, the renderers or the robot page: Rollup puts a module a main-side file imports wholly in
 * `main`. A new game adds its slot here (`docs/area/adding-a-game.md`).
 */
function slotFor(game: GameId): ImportMechSlot | undefined {
  // an unknown game falls back to DECODE's, the same single back-compat rule as `simModuleFor`
  switch (game) {
    case 'chain':
      return CHAIN_IMPORT_MECH;
    case 'biobuzz':
      return BB_IMPORT_MECH;
    default:
      return DECODE_IMPORT_MECH;
  }
}

/**
 * `spec` is COERCED for `game`; a spec with no `imported` has nothing to check. `block` issues stop
 * Save.
 */
export function validateImportedMech(spec: RobotSpec, game: GameId): ImportMechIssue[] {
  if (!spec.imported) return [];
  return slotFor(game)?.issues(spec) ?? [];
}

/** the placements the importer pre-fills for this build — from its archetype's mount cells and its
 *  hull — already coerced, so saving them changes nothing */
export function defaultImportedMech(game: GameId, spec: RobotSpec): ImportedMech {
  if (!spec.imported) return {};
  return slotFor(game)?.defaults(spec) ?? {};
}

/** what the top-down editor lets the player drag for this game and build */
export function mechHandles(game: GameId, spec: RobotSpec): ImportMechHandle[] {
  if (!spec.imported) return [];
  return slotFor(game)?.handles(spec) ?? [];
}
