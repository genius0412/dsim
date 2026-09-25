import { BiobuzzAutoPreview } from './AutoPreview';
import type { GameModule } from '../module';
import { BiobuzzGalleryRoute } from './GalleryRoute';
import { BiobuzzPreview3D, BiobuzzSavedThumb } from './Preview3D';
import {
  BiobuzzBuilderSlot,
  BiobuzzDrivingSlot,
  BiobuzzHudChips,
  BiobuzzPinnedNotice,
  BiobuzzScoreBar,
  biobuzzResultsRows,
} from './HudSlots';
import { drawBiobuzzBalls } from './draw';
import { drawBiobuzzField } from './drawField';
import { drawBiobuzzFlowerReadout } from './drawFlowerReadout';
import { drawBiobuzzRobot } from './drawRobot';
import { bbConfigSummary, bbStatTiles } from './labels';
import { BB_PRESET_LIST, BB_REAL_PRESETS, bbSpecMatches } from './presets';
import { BIOBUZZ_SIM } from './sim';
import { BiobuzzStartEditor } from './StartEditor';
import { BIOBUZZ_TUTORIAL } from './tutorial';

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
 *  • `drawOverlays` — the 2D slot draws between the field and the robots (DECODE's ramp strips),
 *    in FIELD INCHES. BIOBUZZ has nothing to underlay there: everything this game draws over the
 *    mat belongs to the field renderer or to `drawBalls`. Its 3D sibling `drawSceneOverlay` IS
 *    filled (2026-09-21) — a different slot in a different coordinate system, over a live scene.
 */
export const BIOBUZZ_MODULE: GameModule = {
  ...BIOBUZZ_SIM,
  // ---- renderers. The scene gallery draws through these same three functions, which is what
  // makes a gallery cell evidence about the real game screen rather than about a second
  // drawing kept in sync by hand.
  drawField: drawBiobuzzField,
  drawRobot: drawBiobuzzRobot,
  drawBalls: drawBiobuzzBalls,
  /**
   * THE 3D OVERLAY SLOT — the FLOWER contents read-out over a top-down 3D shot.
   *
   * ⚠️ AND NOT `drawOverlays`, WHICH STAYS EMPTY. On the 2D path `drawBiobuzzField` draws the
   * four sections itself, in the same pixels, so a second pass there would paint them twice —
   * and the two slots are in different coordinate systems besides (`games/module.ts` carries the
   * bug that distinction exists to prevent). `drawBiobuzzFlowerReadout` refuses every camera but
   * `overhead`; see its header for why the side-on cameras do not want one.
   */
  drawSceneOverlay: drawBiobuzzFlowerReadout,
  // ---- UI slots ----
  Builder: BiobuzzBuilderSlot,
  DrivingRows: BiobuzzDrivingSlot,
  /**
   * THE ROBOT SCHEMATIC — and, where the host allows it, the live 3D turntable
   * (`docs/roadmap.md` item 1). `BiobuzzPreview3D` wraps `BiobuzzRobotPreview`: without the
   * host's `allow3d` it IS the schematic, byte for byte what this slot was before.
   */
  Preview: BiobuzzPreview3D,
  /** the saved-robot card's thumbnail: a 3D render on the 3D view, nothing on the 2D one. See
   * `GameModule.savedThumb` for why the GAME makes that choice and not the menu. */
  savedThumb: BiobuzzSavedThumb,
  hudChips: BiobuzzHudChips,
  scoreBar: BiobuzzScoreBar,
  pinnedNotice: BiobuzzPinnedNotice,
  resultsRows: biobuzzResultsRows,
  labels: { configSummary: bbConfigSummary },
  // THE START EDITOR. Empty, Configure fell into Chain Reaction's editor and the 2v2 lobby and
  // strategy screens into DECODE's; this one draws the BIOBUZZ field and judges G304 with
  // `bbEvalStart`, with TOP / BOTTOM roles.
  startEditor: BiobuzzStartEditor,
  // the Autonomous section's preview: a Zenith auto on this field (docs/area/autos.md)
  autoPreview: BiobuzzAutoPreview,
  // no auto-fire: the driver fires, and Aim Assist only releases a shot that would land
  offersAutoFire: false,
  /**
   * THE BUILDER'S MECHANISM WORDS (the hero's build line and every robot card's line, through
   * `buildWords`). The second instance of the preset bug, and the same shape of fix: the hero
   * picked its mechanism tiles with `isDecode ? … : …`, so BIOBUZZ fell into the CHAIN arm and
   * showed a **CATALYST** — Chain Reaction's mechanism, off a field `coerceBiobuzzSpec` deletes.
   * This says launcher and lift, which is what a BIOBUZZ robot has.
   */
  statTiles: bbStatTiles,
  /**
   * THE TOUCH BUTTONS moved out of this module, to `src/games/biobuzz/mobile.ts`.
   *
   * They were a `GameModule` slot, and this game filled it with ONE button (the human player's
   * NECTAR entry) while `bbPlace`, `bbPlaceNectar`, `bbRamp` and `bbPass` all shipped with a
   * keybind, a pad button and nothing at all on a phone — recorded as debt in three of this
   * game's own handoffs and never paid, because an optional slot cannot fail a test. The pad
   * derives its set from `ACTION_GAMES` now (`src/ui/mobileActions.ts`), and `npm test` asserts
   * that every action this game uses is reachable on touch, so the next one cannot slip.
   */
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
   *
   * ⚠️ THE COMPONENT IS `GalleryRoute`, NOT `Gallery` — a lazy wrapper, because the gate is on
   * the URL and a static import is on the BUNDLE. See that file.
   */
  devRoutes: [{ path: '/gallery/*', Component: BiobuzzGalleryRoute }],
  /**
   * ⚠️ `showScoreHud: false` IS NOT "NOTHING IS SCORED". `sim.ts` has said `scored: true` since
   * kickoff evening and `score.ts` scores the whole of Table 10-2 — the old comment here
   * ("nothing is scored") predates that and read as a claim about the GAME.
   *
   * What it actually says is "do not give this game the SHARED score chrome", and BIOBUZZ draws
   * its own: `scoreBar: BiobuzzScoreBar` and `hudChips: BiobuzzHudChips` (`HudSlots.tsx`) print
   * the alliance panels, the up-CELL line and the rule row. `GameView.tsx`'s `Hud` picks the
   * slot when a game fills it, so the shared bar on top of those would be the same numbers twice.
   *
   * ⚠️ AND NOTHING READS THIS FLAG ANY MORE — grep it: the three games set it and no consumer
   * asks. The slots replaced it. It is kept because `GameUiSpec` still requires it and because
   * `false` is the answer that stays right if a reader comes back; do not take it as the thing
   * that suppresses anything today.
   *
   * `startEditor: false` is still literally true (no legality model, so no G304-style editor).
   * `intakes` is the SHARED preset list, which is what the shared builder would offer; BIOBUZZ's
   * own sweeper dials live in `Builder` and the slot above is what actually renders.
   */
  ui: { showScoreHud: false, startEditor: false, intakes: ['sloped', 'vector'] },
  // THE TUTORIAL (roadmap item 6). Content only — the engine is `src/tutorial/` and the thing
  // that drives it is `GameController`. Read `./tutorial.ts`'s header before editing a step:
  // every `stage` runs at WORLD CONSTRUCTION, which is what keeps the replay invariant intact.
  tutorial: BIOBUZZ_TUTORIAL,
  /**
   * THE LAZY 3D SCENE (Day 1 seam, `docs/biobuzz/plan-3d.md` §2.3/§2.5/§10). A FUNCTION that
   * resolves to the factory — never the factory itself — so `scene/renderScene.ts` (and the
   * `three` it imports) is only ever pulled into a chunk the moment a player actually mounts a
   * 3D BIOBUZZ view; a player who stays on the 2D view, or plays DECODE/Chain Reaction, never
   * downloads it. `scene/` is reachable ONLY through this one dynamic `import()` — see
   * `scripts/smoke-biobuzz/render.ts`'s import-boundary checks.
   */
  scene: () => import('./scene/renderScene').then((m) => m.createBiobuzzScene),
  /**
   * THE ROBOT-BUILDER TURNTABLE, out of the SAME chunk (`docs/roadmap.md` item 1).
   *
   * ⚠️ THE SPECIFIER IS `./scene/renderScene`, NOT `./scene/renderPreview`, AND THAT IS THE
   * POINT. One dynamic specifier is one Rollup chunk. Two would make three.js a hoisted shared
   * chunk with a thin facade either side — and a facade contains none of the marker strings
   * `scripts/bundleaudit.mjs` routes the `scene` budget by, so both would land in `other` and
   * fail the audit for a reason that has nothing to do with size. `renderScene.ts` re-exports
   * the preview factory; its header carries the same note.
   */
  previewScene: () => import('./scene/renderScene').then((m) => m.createRobotPreviewScene),
};
