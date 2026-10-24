/**
 * BIOBUZZ's own touch buttons.
 *
 * Four of the five were unreachable on a phone until this file existed — `bbPlace`,
 * `bbPlaceNectar`, `bbRamp` and `bbPass` all shipped with a keybind and a pad button and no
 * touch control, which three separate BIOBUZZ handoffs recorded as debt. The shared pad now
 * DERIVES its set from `ACTION_GAMES`, so the omission is a test failure rather than a note
 * (`touchCoverageGaps`, `src/ui/mobileActions.ts`).
 *
 * ⚠️ EVERY `present` HERE ASKS THE SPEC, NOT THE TICK. "Does this build have the mechanism" is
 * a property of the robot the player assembled; whether a press would do anything RIGHT NOW
 * (something of that kind in the hopper, a FLOWER in reach, an entitlement owed) changes
 * several times a match and is `ready`'s question — it draws the button IDLE in place, never
 * by a button appearing and vanishing under a driver's thumb.
 */
import type { GameTouch, TouchButton } from '../../ui/mobileActions';
import { BB_HOOD_DEFAULT_DEG } from './config';
import { bbAutoSorts, bbCarriesNectar, bbIntakeKindOf, bbIsTurreted, bbLauncherOf, bbLiftOf, bbNectarRejectOf } from './mechs';

const BB_TOUCH_BUTTONS: readonly TouchButton[] = [
  {
    // place a held POLLEN into the FLOWER in reach. No Box Tube, no placement
    // (`placeInFlower` returns false on the first line), so no button.
    action: 'bbPlace',
    hold: 'bbPlace',
    label: 'POLLEN',
    aria: 'Place POLLEN',
    glyph: '◇',
    cls: 'bbplace',
    side: 'right',
    present: (c) => bbLiftOf(c.spec) !== null,
    // `placeInFlower`: a FLOWER in reach and one of that kind in the hopper (a full FLOWER is
    // not in the HUD, and is rare enough to leave to the press)
    ready: (l) => !l.bb || (l.bb.flowerInReach && l.held.includes('yellow')),
  },
  {
    // place a held NECTAR. Needs the tube AND an intake that takes NECTAR at all — a POLLEN-only
    // intake (`bbIntakeFeedOf`) can never have one to place.
    action: 'bbPlaceNectar',
    hold: 'bbPlaceNectar',
    label: 'NECTAR',
    aria: 'Place NECTAR',
    glyph: '◆',
    cls: 'bbplacenectar',
    side: 'right',
    present: (c) => bbLiftOf(c.spec) !== null && bbCarriesNectar(c.spec),
    // the tube places its OWN alliance's NECTAR only (`placeInFlower`), so an opponent NECTAR in
    // the hopper does not light it
    ready: (l) => !l.bb || (l.bb.flowerInReach && l.held.some((c) => c === l.bb!.alliance)),
  },
  {
    // PASS to your partner: the same solver aimed at a field point rather than at the hive.
    // A turretless launcher fires along a fixed line and cannot aim at one.
    action: 'bbPass',
    hold: 'bbPass',
    label: 'PASS',
    aria: 'Pass to partner',
    glyph: '▶',
    cls: 'bbpass',
    side: 'right',
    present: (c) => bbIsTurreted(bbLauncherOf(c.spec, BB_HOOD_DEFAULT_DEG)),
    ready: (l) => l.held.length > 0,
  },
  {
    // the deployable ramp, or a `bar` sorter's NECTAR bar on any other intake — one button, as
    // on the keyboard (`bbRampStep`, `nectarReject.ts`'s `bbBarStep`). Every other build's sim ignores
    // the bit outright. DEPLOY names both.
    action: 'bbRamp',
    hold: 'bbRamp',
    label: 'DEPLOY',
    aria: 'Deploy ramp / NECTAR bar',
    glyph: '◣',
    cls: 'bbramp',
    side: 'left',
    present: (c) => bbIntakeKindOf(c.spec) === 'ramp' || bbNectarRejectOf(c.spec) === 'bar',
  },
  {
    // REVERSE: run the intake backwards while held (`nectarReject.ts`). On the pad only where it is the
    // way out for an opponent NECTAR: a POLLEN + NECTAR intake with no sorter of its own. A
    // POLLEN-only intake never holds one, and an auto-reverse or pass-through build throws it out
    // by itself. Every build still has the key and the pad button; the touch pad is the room the
    // narrowest phones do not have to spare.
    action: 'bbReverse',
    hold: 'bbReverse',
    label: 'REV',
    aria: 'Reverse intake',
    glyph: '◁',
    cls: 'bbreverse',
    side: 'right',
    present: (c) => bbCarriesNectar(c.spec) && !bbAutoSorts(c.spec),
    ready: (l) => l.held.length > 0,
  },
  {
    // THE HUMAN PLAYER (G426): enter one NECTAR into the alliance's own LOADING ZONE. No
    // `present`, and that is a statement — the human player is not hardware, so there is no
    // build that should be missing the button. It keeps its own `mobileLayout` slot and sits
    // on the LEFT: it acts on the ALLIANCE rather than on the robot, and it is pressed at a
    // cue rather than in the drive rhythm, so it stays out of the scoring thumb's sweep.
    // Labelled HUMAN, not NECTAR, because the two FLOWER buttons above are also nectar and
    // pollen — three buttons agreeing on a noun name nothing.
    action: 'bbNectar',
    hold: 'bbNectar',
    label: 'HUMAN',
    aria: 'Human player: enter NECTAR',
    glyph: '⬗',
    cls: 'bbnectar',
    side: 'left',
    slot: 'bbNectar',
    // the tick already says why an entry would be refused (`bb.nectarWhy`: none left, none
    // owed, locked); only 'ok' takes one
    ready: (l) => !l.bb || l.bb.nectarOk,
  },
];

export const BB_TOUCH: GameTouch = {
  buttons: BB_TOUCH_BUTTONS,
  // BIOBUZZ has NO auto fire (spawn forces it off and `robot.ts` never reads it), so SHOOT is
  // the only way to fire and is never made redundant. Stated rather than left to the flag.
  manualFireCounts: () => true,
};
