/**
 * WHAT THE CONTROLS SCREEN LISTS, AND WHERE — DOM-free, so `npm test` can hold the layout to the
 * binding model instead of trusting a component to keep up with it.
 *
 * The screen has two kinds of scope (`ControlsSection`), and every action appears in exactly
 * ONE of them, decided by its kind in `src/input/bindings.ts`:
 *
 *   All games   the SHARED controls (Driving, Match) and the OVERRIDABLE mechanisms every season
 *               starts from (Intake, Shoot), in three panels.
 *   a season    that season's own actions: Intake and Shoot again, which the season may
 *               override, and its SEASON-ONLY mechanisms, which live nowhere else.
 *
 * So a key is never shown twice for one meaning, and nothing that is the same in every season
 * is repeated under each of them — which was the whole complaint about the old screen, where a
 * season scope listed all eight drive keys and the stick sliders again with SYNCED beside each.
 */
import type { GameId } from '../games/types';
import {
  KEY_ACTIONS,
  PAD_ACTIONS,
  VIEW_ACTIONS,
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
  flyPreset: 'Next flywheel speed',
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
  id: 'driving' | 'mechanisms' | 'match' | 'view';
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
