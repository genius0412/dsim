import type { GameModule } from '../module';
import { BiobuzzGallery } from './Gallery';
import { BiobuzzRobotPreview } from './RobotPreview';
import {
  BiobuzzBuilderSlot,
  BiobuzzHudChips,
  BiobuzzScoreBar,
  biobuzzResultsRows,
} from './HudSlots';
import { drawBiobuzzBalls } from './draw';
import { drawBiobuzzField } from './drawField';
import { drawBiobuzzRobot } from './drawRobot';
import { bbConfigSummary } from './labels';
import { BB_PRESET_LIST, BB_REAL_PRESETS, bbPresetLines, bbSpecMatches } from './presets';
import { BIOBUZZ_SIM } from './sim';

/**
 * BIOBUZZ as a full (CLIENT) `GameModule` — the DOM-free `BIOBUZZ_SIM` plus every
 * browser-owned slot: the three renderers, the builder, the robot schematic, the two live-HUD
 * slots, the results breakdown, the config summary and the scene gallery's dev route.
 *
 * FILLING the slots rather than threading `game === 'biobuzz'` through the shared screens is
 * the whole point of them, and `src/games/module.ts` carries the argument: before they
 * existed, `Menu.tsx` alone had ~16 `isDecode` gates and a third game had to be hand-threaded
 * into every one, in files two other people edit at the same time. DECODE's and CR's inline
 * branches stay untouched — each consumer wires a slot as
 * `mod.X ? <the slot> : <the existing branch, unchanged>`.
 *
 * WHAT IS DELIBERATELY NOT FILLED, each an absence rather than an omission:
 *  • `drawOverlays` — the slot draws between the field and the robots (DECODE's ramp strips).
 *    BIOBUZZ has no published structure to underlay: Section 9 (ARENA) is a Kickoff
 *    placeholder, so the field is four walls and a tile grid. A no-op costs a call per frame
 *    and tells the next reader there is something to see. It lands with the geometry.
 *  • `mobileButtons` — the shell's only two actions are intake and fire and both already have
 *    a button in the shared pad. A genuinely new BIOBUZZ action needs a `GameSettings
 *    .mobileLayout` key and a protocol bit too, which is a cross-lane request, not a slot.
 *  • `startEditor` — `startLegality: false`: there is no legality to edit against, and the two
 *    anchors are picked from the shared preset list.
 */
export const BIOBUZZ_MODULE: GameModule = {
  ...BIOBUZZ_SIM,
  // ---- renderers. The scene gallery draws through these same three functions, which is what
  // makes a gallery cell evidence about the real game screen rather than about a second
  // drawing kept in sync by hand.
  drawField: drawBiobuzzField,
  drawRobot: drawBiobuzzRobot,
  drawBalls: drawBiobuzzBalls,
  // ---- UI slots ----
  Builder: BiobuzzBuilderSlot,
  Preview: BiobuzzRobotPreview,
  hudChips: BiobuzzHudChips,
  scoreBar: BiobuzzScoreBar,
  resultsRows: biobuzzResultsRows,
  labels: { configSummary: bbConfigSummary },
  /**
   * THE PRESET CARDS. Filling this slot is what makes `BB_PRESETS` reachable at all: the
   * builder's `Presets` section chose its list with `isDecode ? ROBOT_PRESETS : CHAIN_PRESETS`,
   * so BIOBUZZ did not fall through to "no presets" — it fell into the CHAIN arm and offered
   * Chain Reaction's nine robots, described in Chain Reaction's words, while this game's own
   * four were reachable only as `BB_PRESETS[0]` inside `BB_DEFAULT_SPEC`.
   */
  presets: {
    list: BB_PRESET_LIST,
    matches: bbSpecMatches,
    lines: bbPresetLines,
    realCount: BB_REAL_PRESETS,
  },
  /**
   * THE SCENE GALLERY, alpha-only — `devRoutesEnabled()` gates it inside `devRouteFor`, so a
   * stable build neither routes to it nor renders it.
   *
   * `/gallery/*`, not `/gallery`: every grid cell links to `/biobuzz/gallery/<scene>` for the
   * drivable view of one scene, and `devRouteFor` matches a route's `path` against the
   * game-stripped remainder of the URL. A bare `/gallery` entry would drop every sub-path
   * through to `parseScreen`, which sends an unknown path home — so the trailing `/*` is what
   * makes a pasted scene link actually open. Seventy scenes is not seventy route entries.
   */
  devRoutes: [{ path: '/gallery/*', Component: BiobuzzGallery }],
  // no score HUD (nothing is scored) and no start editor (no legality model). `intakes` is the
  // SHARED preset list, which is what the shared builder would offer; BIOBUZZ's own sweeper
  // dials live in `Builder` and the slot above is what actually renders.
  ui: { showScoreHud: false, startEditor: false, intakes: ['sloped', 'vector'] },
};
