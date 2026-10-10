/**
 * WHAT THE CONTROLS SCREEN LISTS, AND WHERE — DOM-free, so `npm test` can hold the layout to the
 * binding model instead of trusting a component to keep up with it.
 *
 * The screen has two kinds of scope (`ControlsSection`), decided by each action's kind in
 * `src/input/bindings.ts`:
 *
 *   All games   the SHARED controls (Driving, Match) and the OVERRIDABLE mechanisms every season
 *               starts from (Intake, Shoot), in three panels — plus the ACTIVE season's own
 *               mechanisms, on cards named for it (`allGamesPanels`).
 *   a season    that season's own actions: Intake and Shoot again, which the season may
 *               override, and its SEASON-ONLY mechanisms.
 *
 * Nothing that is the same in every season is repeated under each of them — which was the whole
 * complaint about the old screen, where a season scope listed all eight drive keys and the stick
 * sliders again with SYNCED beside each.
 *
 * ⚠️ THE ACTIVE SEASON'S OWN CARDS ARE IN ALL GAMES TOO (owner, 2026-10-10: "People keep missing
 * the fact that there is a separate panel for biobuzz controls"). Place POLLEN, the ramp and the
 * camera keys were listed in the BIOBUZZ scope alone, one tab over from the page everybody opens,
 * so players read Driving / Mechanisms / Match, found no Place POLLEN and concluded it was not
 * rebindable. A season-only action has ONE store, main (`actionIsSeasonOnly`), so the same row
 * in two scopes edits the same bind — a second place to find it, never a second value. Only the
 * active season's are shown: three seasons' worth would bury the shared rows under controls for
 * games the player is not playing.
 */
import type { GameId } from '../games/types';
import { seasonFor } from '../seasons';
import {
  KEY_ACTIONS,
  PAD_ACTIONS,
  VIEW_ACTIONS,
  actionIsSeasonOnly,
  actionOverridable,
  seasonKeyActions,
  seasonPadActions,
  type KeyAction,
  type PadAction,
} from '../input/bindings';

/**
 * ONE NAME PER ACTION, for both devices. The keyboard and pad spellings used to be two tables
 * that had to be kept identical by hand. The season an action belongs to is NOT in its name —
 * the scope it is listed under already says that.
 */
export const ACTION_LABELS: Record<KeyAction, string> = {
  driveUp: 'Forward (Tank: left side)',
  driveDown: 'Back (Tank: left side)',
  tankRightUp: 'Tank: right side forward',
  tankRightDown: 'Tank: right side back',
  driveLeft: 'Strafe left',
  driveRight: 'Strafe right',
  rotateCCW: 'Turn left',
  rotateCW: 'Turn right',
  intake: 'Intake (hold)',
  fire: 'Shoot (hold)',
  catalyst: 'Catalyst pick up / place',
  fling: 'Catapult throw',
  bbPlaceNectar: 'Place NECTAR',
  bbPlace: 'Place POLLEN',
  bbNectar: 'Human player: enter NECTAR',
  bbRamp: 'Deploy ramp',
  bbPass: 'Pass to partner',
  viewToggle: 'Switch 2D / 3D view',
  cameraCycle: 'Next camera',
  eyeUp: 'Camera higher',
  eyeDown: 'Camera lower',
  driveMode: 'Swap wheel set (Butterfly)',
  flipFront: 'Flip front',
  park: 'Park mode',
  start: 'Start match',
  restart: 'Restart',
};

export interface BindPanel {
  /** unique within one scope. `season` is the active season's own mechanisms in All games, which
   *  already has a `mechanisms` card. */
  id: 'driving' | 'mechanisms' | 'season' | 'match' | 'view';
  title: string;
  /** the keyboard column, in reading order */
  keys: readonly KeyAction[];
  /** the gamepad column, in the SAME order as the keyboard one where both have the action */
  pads: readonly PadAction[];
}

/** keyboard order, applied to a pad list, so the two columns of a panel read alike */
const inKeyOrder = (list: readonly PadAction[]): PadAction[] =>
  [...list].sort((a, b) => KEY_ACTIONS.indexOf(a) - KEY_ACTIONS.indexOf(b));

/**
 * THE ALL GAMES SCOPE. Movement reads forward/back, strafe, turn, and then the tank's second
 * side, which only a tank uses; the three drive toggles close the panel on both devices. The
 * match panel's Menu row is not an action (Escape is reserved, the pad's is `menuButton`), so
 * the component adds it.
 */
export const ALL_GAMES_PANELS: readonly BindPanel[] = [
  {
    id: 'driving',
    title: 'Driving',
    keys: [
      'driveUp',
      'driveDown',
      'driveLeft',
      'driveRight',
      'rotateCCW',
      'rotateCW',
      'tankRightUp',
      'tankRightDown',
      'driveMode',
      'flipFront',
      'park',
    ],
    pads: ['driveMode', 'flipFront', 'park'],
  },
  {
    id: 'mechanisms',
    title: 'Mechanisms',
    keys: KEY_ACTIONS.filter(actionOverridable),
    pads: inKeyOrder(PAD_ACTIONS.filter(actionOverridable)),
  },
  {
    id: 'match',
    title: 'Match',
    keys: ['start', 'restart'],
    pads: ['start', 'restart'],
  },
];

const isView = (a: KeyAction): boolean => (VIEW_ACTIONS as readonly KeyAction[]).includes(a);

/**
 * A SEASON'S SCOPE: its own actions and nothing any other season shares with it unchanged. The
 * robot's mechanisms first; then, for a season with a 3D view, a "3D view" card for the camera
 * keys, which are keyboard-only and move no part of the robot.
 */
export function seasonPanels(game: GameId): BindPanel[] {
  const mech: BindPanel = {
    id: 'mechanisms',
    title: 'Mechanisms',
    keys: seasonKeyActions(game).filter((a) => !isView(a)),
    pads: inKeyOrder(seasonPadActions(game)),
  };
  const view = seasonKeyActions(game).filter(isView);
  return view.length ? [mech, { id: 'view', title: '3D view', keys: view, pads: [] }] : [mech];
}

/**
 * THE ALL GAMES SCOPE AS SHOWN: the three shared panels, with `active`'s season-only actions on
 * cards named for it after Mechanisms — where somebody looking for a mechanism bind is already
 * reading. Intake and Shoot stay on Mechanisms, the bind every season starts from; a season's
 * override of them is still edited in its own scope. A season with no action of its own (DECODE)
 * adds nothing.
 */
export function allGamesPanels(active: GameId | null): BindPanel[] {
  if (!active) return [...ALL_GAMES_PANELS];
  const name = seasonFor(active).name;
  const own = seasonPanels(active)
    .map(
      (p): BindPanel => ({
        id: p.id === 'mechanisms' ? 'season' : p.id,
        title: `${name} ${p.title === 'Mechanisms' ? 'mechanisms' : p.title}`,
        keys: p.keys.filter(actionIsSeasonOnly),
        pads: p.pads.filter(actionIsSeasonOnly),
      }),
    )
    .filter((p) => p.keys.length > 0);
  const at = ALL_GAMES_PANELS.findIndex((p) => p.id === 'mechanisms') + 1;
  return [...ALL_GAMES_PANELS.slice(0, at), ...own, ...ALL_GAMES_PANELS.slice(at)];
}
