import { keyLabel, keyName, livePadBinds, padBindLabel, type KeyAction, type PadAction } from '../input/bindings';
import { ACTION_LABELS } from '../ui/controlsLayout';
import type { Hint, HintKey, HintPart, TutorialHintCtx } from './types';

/**
 * HINTS NAME THE PLAYER'S OWN CONTROLS — the whole point of routing them through
 * `ControlBindings` rather than writing "press SPACE" into a string.
 *
 * Every keyboard action and every pad button in this app is rebindable
 * (`docs/area/ui.md`), and the tutorial is the first thing a new player meets. A hint that
 * names a default the player has already changed is worse than no hint: they press the key it
 * names, nothing happens, and the step they are stuck on is the one that was supposed to
 * teach them the control.
 *
 * ── WHY A PAD WINS WHEN ONE IS CONNECTED ──────────────────────────────────────
 * Somebody holding a controller is not looking at the keyboard, and the in-match overlay
 * already prints both (`GameView`'s "Press ENTER or START to start"). A step card has one
 * line, so it names the device in their hands and says the other one only for the drive
 * step, where both are worth knowing.
 */

/**
 * THE ON-SCREEN BUTTON an action has on a touch pad, where it has one.
 *
 * ⚠️ IT DUPLICATES `GameMobileButton.label` AND IT HAS TO. This module is the shared engine and
 * the TUTORIAL lane asserts that `src/tutorial/` imports no game module — content hangs off the
 * slot, the engine does not reach back through it — so the four labels a tutorial hint can name
 * are written here instead of read off `MobileControls`'s list. They are four short strings that
 * have not changed since the touch pad shipped; a fifth one going out of step shows up as a hint
 * naming a button that is not on screen, which is visible the moment anybody looks at a phone.
 *
 * An action with NO on-screen button (drive-mode, flip-front, park, start, restart) is absent
 * here, and `control` then falls back to the key — the hint that names it is expected to leave
 * that clause out on touch, which is something only the step's own copy can decide.
 */
const TOUCH_LABELS: Partial<Record<KeyAction, string>> = {
  intake: 'INTAKE',
  fire: 'SHOOT',
  catalyst: 'CATALYST',
  fling: 'THROW',
  bbNectar: 'NECTAR',
};

/** the name an unbound action is called by in the sentence that says so: the Controls row's own
 * label ("Shoot (hold)") without its parenthetical, so the player looks for the same words there. */
const actionName = (a: KeyAction): string => ACTION_LABELS[a].replace(/ \(.*\)$/, '');

/** the FIRST key bound to an action, as a keycap — or, when it is unbound, a `missing` part that
 * `resolveHint` turns into "Shoot has no key. Bind one in Controls." (design review 12-09). */
export function keyFor(ctx: TutorialHintCtx, action: KeyAction): HintKey {
  const k = ctx.bindings.keys[action][0];
  return k === undefined ? { key: '', missing: actionName(action) } : { key: keyLabel(k), name: keyName(k) };
}

/** the FIRST pad bind of an action — a face label, or a combo's buttons joined by `+` — or a
 * `missing` part when it has none. `padBinds` lists singles before combos, so a player who kept a
 * single is told the single. A bind paused by the triggers turning is skipped: Shoot on RT and A
 * is "A" then. */
export function padFor(ctx: TutorialHintCtx, action: PadAction): HintKey {
  const b = livePadBinds(ctx.bindings.pad, action)[0];
  return b === undefined ? { key: '', missing: actionName(action), pad: true } : { key: padBindLabel(b) };
}

/**
 * The control to name for one action: the pad button when a pad is connected, the key
 * otherwise.
 *
 * `pad` is optional because three keyboard actions have no pad twin (the tank right-side
 * pair, and the strafe/turn keys, which a pad does with a stick).
 */
export function control(ctx: TutorialHintCtx, key: KeyAction, pad?: PadAction): HintKey {
  if (ctx.gamepad && pad) return padFor(ctx, pad);
  // a PAD wins over touch: somebody who plugged one into a tablet is holding it, and the
  // on-screen pad is what they stopped using.
  if (ctx.touch && TOUCH_LABELS[key]) return { key: TOUCH_LABELS[key]! };
  return keyFor(ctx, key);
}

/**
 * COMPOSE A HINT — a template tag, so a step's copy still reads as one sentence:
 * `` say`Hold ${control(c, 'fire', 'fire')}. The turret tracks the goal for you.` ``.
 *
 * A value may be a string, a control, or another `Hint` (`driveHint`, or a clause that is `''`
 * on touch), and nested hints are flattened. ⚠️ If ANY control in it is unbound, the whole hint
 * becomes the one line that says so (`resolveHint`): a sentence composed around a missing key
 * reads "Hold .", and the step it is on is the one that was supposed to teach that control.
 */
export function say(strings: TemplateStringsArray, ...vals: (HintPart | Hint)[]): Hint {
  const out: HintPart[] = [];
  const put = (v: HintPart | Hint): void => {
    if (Array.isArray(v)) (v as Hint).forEach(put);
    else if (v !== '') out.push(v as HintPart);
  };
  strings.forEach((s, i) => {
    put(s);
    if (i < vals.length) put(vals[i]);
  });
  return out;
}

/** the hint as shown: if ANY control in it is unbound, the one line that says so. Applied once, at
 * the top (`runner.view`, `hintText`), not inside `say` — a nested `driveHint` collapsed early
 * would be pasted mid-sentence into the outer hint. */
export function resolveHint(h: Hint): Hint {
  const gap = h.find((p): p is HintKey => typeof p !== 'string' && p.missing !== undefined);
  return gap ? [`${gap.missing} has no ${gap.pad ? 'button' : 'key'}. Bind one in Controls.`] : h;
}

/** a hint as one plain string, each control inlined as its label — for checks and logs. */
export function hintText(h: Hint): string {
  return resolveHint(h).map((p) => (typeof p === 'string' ? p : p.key)).join('');
}

/**
 * HOW TO DRIVE, in this player's words.
 *
 * The keyboard form lists the four translation keys and the two turn keys, in the order a
 * driver's hand sits on them, and it reads the bound values so a rebound WASD prints as
 * whatever it is now — each one its own keycap, so `NUM8NUM4…` cannot run together. The pad form
 * names the stick the player picked for driving (`pad.driveStick`) and what turns: the other
 * stick, or LT and RT (`pad.turnWith`), which is the only thing about a pad a driver has to be
 * told. It opens a sentence, so it is capitalised in every form (design review 12-08).
 */
export function driveHint(ctx: TutorialHintCtx): Hint {
  if (!ctx.gamepad && ctx.touch) return ['Left stick to drive, right stick to turn'];
  if (ctx.gamepad) {
    const left = ctx.bindings.pad.driveStick === 'left';
    const turn = ctx.bindings.pad.turnWith === 'triggers' ? 'LT and RT' : left ? 'right stick' : 'left stick';
    return [`${left ? 'Left' : 'Right'} stick to drive, ${turn} to turn`];
  }
  const k = (a: KeyAction): HintKey => keyFor(ctx, a);
  return say`${k('driveUp')}${k('driveLeft')}${k('driveDown')}${k('driveRight')} to drive, ${k('rotateCCW')} and ${k('rotateCW')} to turn`;
}
