import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ACTION_GAMES,
  BIND_SLOTS_MAX,
  DEFAULT_BINDINGS,
  PAD_ACTIONS,
  PAD_CHORD_GRACE_MAX_MS,
  PAD_CHORD_GRACE_MIN_MS,
  actionIsSeasonOnly,
  actionIsShared,
  assignKey,
  assignKeyInGame,
  assignPadBind,
  assignPadBindInGame,
  chordKey,
  cloneBindings,
  effectiveBindings,
  keyConflict,
  keyDesynced,
  keyLabel,
  keyName,
  padBindLabel,
  padBinds,
  padButtonLabel,
  padConflict,
  padDesynced,
  removeKey,
  removeKeyInGame,
  removePadBind,
  removePadBindInGame,
  resetGame,
  seasonUnbound,
  syncKeyInGame,
  syncPadInGame,
  type BindConflict,
  type ControlBindings,
  type KeyAction,
  type PadAction,
  type PadChord,
  type PadBindings,
} from '../input/bindings';
import { PadCapture } from '../input/padChords';
import { resumePadNav, suspendPadNav } from '../input/padNav';
import type { GameId } from '../games/types';
import { seasonFor } from '../seasons';
import { visibleSeasons } from '../seasonVisibility';
import { OptRow, ToggleRow } from './OptRow';
import { rangeFill } from './rangeFill';
import { useCoarsePointer } from './useCoarsePointer';
import { ACTION_LABELS, ALL_GAMES_PANELS, seasonPanels, type BindPanel } from './controlsLayout';

/**
 * WHICH MAP IS BEING EDITED. `all` is the MAIN setting — the shared controls, and the Intake and
 * Shoot every season starts from — and it is the default, with nothing remembered: a player who
 * comes back to rebind Shoot should land on the row that changes Shoot everywhere (owner,
 * 2026-09-19: "keybinds should stay the same across seasons for sure").
 *
 * A season scope lists THAT SEASON'S OWN ACTIONS and nothing else (`controlsLayout.ts` holds the
 * split, `npm test` holds it to the model). Its Intake and Shoot are overrides of main, with a
 * Sync on a row only while it differs; its season-only mechanisms are simply its binds.
 */
type Scope = GameId | 'all';

/** the game a capture commits into — `null` is the main map */
type Capture =
  | { kind: 'key'; action: KeyAction; slot: number; game: GameId | null }
  | { kind: 'pad'; action: PadAction; slot: number; game: GameId | null };

/**
 * A CAPTURE is one slot of one action waiting for input. `slot` indexes the action's list —
 * `bindings.keys[a]` for a key, `padBinds(pad, a)` (singles then combos) for the pad — and a
 * slot PAST THE END is the add slot, which is how every action can carry as many alternatives
 * as the player has buttons. The steal policy lives with the model (`assignKey` /
 * `assignPadBind` in `bindings.ts`), where `npm test` pins it.
 */
interface Props {
  bindings: ControlBindings;
  onChange: (b: ControlBindings) => void;
  /** launch Free Drive with the on-screen touch-control layout editor open */
  onEditTouchControls: () => void;
  /** run the tutorial (roadmap item 6) — absent when the active game has no tutorial, and the
   *  panel is then not rendered at all rather than shown disabled. */
  onTutorial?: () => void;
  /** the game `onTutorial` runs. The row sits in the All games scope but runs the ACTIVE
   *  season's tutorial, so its title names that season (design review 12-20). */
  tutorialGame?: GameId;
}

/**
 * A BIND THAT IS ALREADY TAKEN IS REFUSED, NOT STOLEN (owner, 2026-09-24: binding a key another
 * function uses "shouldn't unbind the other one. Instead, it should show a conflict error").
 * The slot stays armed, the card title says who has it, and that action's keycap is ringed red
 * wherever it is drawn — here, or on the scope button that shows it when it is somewhere else.
 */
interface Conflict {
  device: 'key' | 'pad';
  /** the action that holds the bind, and the bind (`chordKey` for the pad) */
  action: KeyAction;
  bind: string;
  /** the bind as the player reads it ("C", "RT + D-UP") */
  label: string;
  /** the scope that lists the holder */
  scope: Scope;
}

/** the scope whose screen lists the holder of a conflict */
const holderScope = (c: BindConflict): Scope =>
  actionIsSeasonOnly(c.action) ? ACTION_GAMES[c.action][0] : actionIsShared(c.action) ? 'all' : (c.game ?? 'all');

const scopeName = (s: Scope): string => (s === 'all' ? 'All games' : seasonFor(s).name);

/** "C is taken by Place POLLEN (BIOBUZZ). Press another key, or Esc." — the scope is named only
 *  when the holder is not on the screen being edited */
const conflictText = (c: Conflict, here: Scope): string =>
  `${c.label} is taken by ${ACTION_LABELS[c.action]}${c.scope === here ? '' : ` (${scopeName(c.scope)})`}. ` +
  `Press another ${c.device === 'key' ? 'key' : 'button'}, or Esc.`;

/** a message and the card whose TITLE it stands in for — the card holding the row it is about */
interface Notice {
  text: string;
  panel: BindPanel['id'];
  /** a refusal, drawn in the error colour */
  error?: boolean;
}

/** how long a confirmation holds a card title before the title comes back. A PROMPT (a slot is
 *  armed) is not a notice and holds for as long as the slot does. */
const NOTICE_MS = 4000;

/** the card that lists `action` in this scope. A season scope is one card; in All games each
 *  action is in exactly one (`controlsLayout.ts`). */
const panelFor = (action: KeyAction, game: GameId | null): BindPanel['id'] =>
  (game ? seasonPanels(game) : ALL_GAMES_PANELS).find(
    (p) => p.keys.includes(action) || (p.pads as readonly KeyAction[]).includes(action),
  )?.id ?? 'mechanisms';

/** one pad slider row, the `.ds-field` shape Audio and Graphics use */
function PadSlider({
  label,
  shown,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  label: string;
  shown: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <label className="ds-field">
      <span className="cap">
        {label} <span className="val">{shown}</span>
      </span>
      <input
        className="ds-range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        aria-valuetext={shown}
        style={rangeFill(value, min, max)}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

export function ControlsSection({ bindings, onChange, onEditTouchControls, onTutorial, tutorialGame }: Props) {
  const [scope, setScope] = useState<Scope>('all');
  const coarse = useCoarsePointer();
  const [capture, setCapture] = useState<Capture | null>(null);
  /** a confirmation, a refused bind, or what a main edit took from a row this scope does not
   *  show — shown IN PLACE OF the title of the card the edit was made in, so it costs no line of
   *  its own and moves nothing (owner, 2026-09-23: the empty line it used to hold under the scope
   *  switch was most of the gap between the switch and the first card). Clears after
   *  `NOTICE_MS`. */
  const [notice, setNotice] = useState<Notice | null>(null);
  /** the bind the armed slot was just refused, and who holds it. It OUTLIVES the capture by
   *  `NOTICE_MS`, so a player who follows the red scope button to the holder's season still
   *  finds its keycap ringed there; a new capture or a bind that lands clears it at once. */
  const [conflict, setConflict] = useState<Conflict | null>(null);
  useEffect(() => {
    if (!conflict || capture) return;
    const t = window.setTimeout(() => setConflict(null), NOTICE_MS);
    return () => window.clearTimeout(t);
  }, [conflict, capture]);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(t);
  }, [notice]);
  /** the buttons held so far while a PAD slot is capturing, in the order they went down —
   *  shown live on the status line so a driver sees the combo build (`RT + …`). NOT on the
   *  keycap: a cap that grew to fit it moved every cap to its left (§1.4). */
  const [chordSoFar, setChordSoFar] = useState<PadChord>([]);
  /** a lone pad button has been held past `PAD_HOLD_REMOVE_MS`: letting go removes the slot */
  const [holding, setHolding] = useState(false);
  /**
   * THE CAPTURE EFFECTS DEPEND ON `capture` ALONE. `onChange` arrives as a fresh arrow from
   * `Configure` on every render, and the App re-renders every few seconds on its own (the
   * presence poll, among others) — with `bindings`/`onChange` in the deps, every one of those
   * restarted the pad effect mid-capture: its cleanup ran, `first` went back to true, the
   * buttons the driver was still holding were swept into `alreadyDown`, and the release then
   * committed nothing. A single-press capture was a one-frame window, so it never showed;
   * commit-on-release made it a real one. Refs give the effects the live values without
   * making them dependencies.
   */
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const seasons = useMemo(() => visibleSeasons(), []);
  const seasonsRef = useRef(seasons);
  seasonsRef.current = seasons;

  /**
   * ⚠️ PAD NAVIGATION STANDS DOWN WHILE A CAPTURE IS ARMED.
   *
   * The pad capture below takes EVERY button that goes down, which is exactly what the
   * navigation layer's A-to-activate reads — so without this, opening a pad slot with A binds A
   * to that action and then to the next one, and the screen becomes unusable with the device it
   * configures. Keyed on `capture` alone, like the two effects under it and for the same reason.
   */
  useEffect(() => {
    if (!capture) return;
    suspendPadNav('capture');
    return () => resumePadNav('capture');
  }, [capture]);

  /**
   * THE MATCH-MENU BUTTON's own capture, and it is a separate one on purpose: `menuButton` is not
   * a `PadAction` (see `PadBindings.menuButton`), so it has no slot, no combo and no steal — it
   * is one index. Commit on the first button DOWN, unlike the action capture beside it, because
   * there is no combo to wait for; Escape cancels.
   */
  const [menuCapture, setMenuCapture] = useState(false);
  useEffect(() => {
    if (!menuCapture) return;
    suspendPadNav('capture');
    let raf = 0;
    const alreadyDown = new Set<number>();
    let first = true;
    const poll = (): void => {
      raf = requestAnimationFrame(poll);
      const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
      const pad = pads.find((p) => p && p.connected);
      if (!pad) return;
      const thr = bindingsRef.current.pad.triggerThreshold;
      for (let i = 0; i < pad.buttons.length; i++) {
        const b = pad.buttons[i];
        const down = !!b && (b.pressed || b.value > thr);
        if (first) {
          if (down) alreadyDown.add(i);
          continue;
        }
        if (!down || alreadyDown.has(i)) {
          if (!down) alreadyDown.delete(i);
          continue;
        }
        const b0 = cloneBindings(bindingsRef.current);
        onChangeRef.current({ ...b0, pad: { ...b0.pad, menuButton: i } });
        setNotice({ text: `Menu: ${padButtonLabel(i)}`, panel: 'match' });
        setMenuCapture(false);
        return;
      }
      first = false;
    };
    raf = requestAnimationFrame(poll);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuCapture(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
      resumePadNav('capture');
    };
  }, [menuCapture]);

  /** REMOVE the armed slot — the only way to shrink a list that `+` can grow. Reached by Backspace
   *  or Delete during a capture (below) and by the `×` cap that stands in for `+` while a bound
   *  slot is armed, so a pointer or touch player is not left with a keyboard-only chord. */
  const removeSlot = (c: Capture): void => {
    const b = bindingsRef.current;
    const g = c.game;
    onChangeRef.current(
      c.kind === 'key'
        ? g
          ? removeKeyInGame(b, g, c.action, c.slot)
          : removeKey(b, c.action, c.slot)
        : g
          ? removePadBindInGame(b, g, c.action, c.slot)
          : removePadBind(b, c.action, c.slot),
    );
    setNotice({ text: `${ACTION_LABELS[c.action]}: bind removed`, panel: panelFor(c.action, g) });
    setCapture(null);
  };

  // keyboard capture: next keydown becomes the binding; Escape cancels. Backspace and Delete
  // REMOVE the slot instead, for either device: neither key is anywhere a driving hand goes, so
  // nothing bindable is lost.
  useEffect(() => {
    if (!capture) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setCapture(null);
        return;
      }
      const b = bindingsRef.current;
      const g = capture.game;
      if (e.key === 'Backspace' || e.key === 'Delete') {
        removeSlot(capture);
        return;
      }
      if (capture.kind !== 'key') return;
      const k = e.key.toLowerCase();
      // REFUSED, AND STILL ARMED: the next key the player tries lands on the same slot
      const taken = keyConflict(b, g, capture.action, k);
      if (taken) {
        setConflict({ device: 'key', action: taken.action, bind: k, label: keyName(k), scope: holderScope(taken) });
        return;
      }
      onChangeRef.current(
        g ? assignKeyInGame(b, g, capture.action, capture.slot, k) : assignKey(b, capture.action, capture.slot, k),
      );
      setNotice({ text: `${ACTION_LABELS[capture.action]}: ${keyName(k)}`, panel: panelFor(capture.action, g) });
      setConflict(null);
      setCapture(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capture]);

  // gamepad capture (`PadCapture`): everything that goes down AFTER capture starts, and is still
  // down, is the bind, committed when one of those buttons is released. HOLDING one button alone
  // past `PAD_HOLD_REMOVE_MS` and letting go removes the slot instead (or cancels an empty one) —
  // the pad's Backspace and Esc, since pad navigation cannot reach the `×` cap while a capture
  // is armed. It runs for a KEY capture too, where a pad can bind nothing: a press cancels it
  // and a hold removes the key, so a slot armed with A is never a dead end for a pad player.
  useEffect(() => {
    if (!capture) return;
    const { action, slot, game } = capture;
    const cap = new PadCapture();
    let raf = 0;
    const panel = panelFor(action, game);
    /** true when the capture is over; false when it was refused and stays armed */
    const commit = (chord: number[]): boolean => {
      if (capture.kind !== 'pad') {
        setCapture(null);
        return true;
      }
      const b = bindingsRef.current;
      const sorted = [...chord].sort((x, y) => x - y);
      const taken = padConflict(b, game, capture.action, sorted);
      if (taken) {
        setConflict({
          device: 'pad',
          action: taken.action,
          bind: chordKey(sorted),
          label: padBindLabel(sorted),
          scope: holderScope(taken),
        });
        // re-arm: only a fresh press can start the next attempt
        cap.rearm();
        setChordSoFar([]);
        return false;
      }
      onChangeRef.current(
        game ? assignPadBindInGame(b, game, capture.action, slot, chord) : assignPadBind(b, capture.action, slot, chord),
      );
      setNotice({ text: `${ACTION_LABELS[action]}: ${padBindLabel(sorted)}`, panel });
      setConflict(null);
      setCapture(null);
      return true;
    };
    const poll = () => {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      const pad = Array.from(pads).find((p) => p && p.connected);
      if (pad) {
        // the same press test the game uses, so a trigger that counts as held in play (past the
        // player's own threshold) is the same trigger the capture sees
        const threshold = bindingsRef.current.pad.triggerThreshold;
        const down = new Set<number>();
        for (let i = 0; i < pad.buttons.length; i++) {
          if (pad.buttons[i].pressed || pad.buttons[i].value > threshold) down.add(i);
        }
        const s = cap.step(down, performance.now());
        if (s.t === 'remove') {
          const b = bindingsRef.current;
          const v = game ? effectiveBindings(b, game) : b;
          const n = capture.kind === 'key' ? v.keys[capture.action].length : padBinds(v.pad, capture.action).length;
          if (slot < n) removeSlot(capture);
          else setCapture(null);
          return;
        }
        if (s.t === 'commit' && commit(s.chord)) return;
        if (s.t === 'chord' && capture.kind === 'pad') setChordSoFar(s.chord);
        setHolding(s.t === 'hold');
      }
      raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);
    return () => {
      cancelAnimationFrame(raf);
      setChordSoFar([]);
      setHolding(false);
    };
  }, [capture]);

  const begin = (c: Capture): void => {
    setNotice(null);
    setConflict(null);
    setCapture(c);
  };

  /**
   * ⚠️ AN ARMED CAP KEEPS ITS LABEL. It used to read `PRESS…` (or `RT + …`), ~70px against a 34px
   * cap, and `.ds-keys` is `justify-content: flex-end` — so every cap to its left slid over and a
   * long row wrapped mid-capture. The pulse and the accent ring say "armed"; the status line says
   * what to press and shows a pad combo as it builds.
   */
  const keycap = (
    label: string,
    active: boolean,
    unbound: boolean,
    onClick: () => void,
    key?: number,
    spoken = label,
    clash = false,
  ) => (
    <button
      key={key}
      className={`ds-key ${active ? 'capturing' : ''} ${unbound ? 'unbound' : ''} ${clash ? 'conflict' : ''}`}
      // the glyph alone is a poor name ("leftwards arrow"); while armed the status line speaks
      aria-label={active ? undefined : unbound ? 'Unbound, press to bind' : `${spoken}, press to rebind`}
      onClick={onClick}
    >
      {label}
    </button>
  );
  /** the ADD slot: one past the end of a list that has something in it (an empty list shows
   *  UNBOUND instead, which already captures into slot 0) */
  const addcap = (active: boolean, onClick: () => void, what: string) => (
    <button
      key="add"
      className={`ds-key add ${active ? 'capturing' : ''}`}
      aria-label={`Add another ${what}`}
      title={`Add another ${what}`}
      onClick={onClick}
    >
      +
    </button>
  );
  /** REMOVE, in the `+` cap's place while a BOUND slot of this row is armed: the same one-glyph
   *  box, so nothing moves when it swaps in. */
  // ponytail: a row already at BIND_SLOTS_MAX has no `+` to stand in for, so there the `×` is
  // appended and the row shifts once; eight binds on one action is not a row anyone builds.
  const removecap = (c: Capture, what: string) => (
    <button
      key="remove"
      className="ds-key remove"
      aria-label={`Remove ${what}`}
      title={`Remove ${what}`}
      onClick={() => removeSlot(c)}
    >
      ×
    </button>
  );
  /**
   * SYNC, ON A ROW THAT DIFFERS AND NOWHERE ELSE. The old screen put SYNCED or CUSTOM beside every
   * row of a season scope and a Sync button on each, disabled on all but the ones that differed —
   * the drive keys included, which a season could not usefully change. Now only Intake and Shoot
   * can differ at all, and a row that matches All games shows nothing.
   *
   * ⚠️ ABSENT, NOT MERELY HIDDEN, while the row matches. A reserved invisible slot was tried: on a
   * phone it pushed Intake's third keycap onto a second line in EVERY season, for a button that is
   * almost never there. The button arrives with the edit that makes it mean something, and that
   * edit has already changed the row's keycaps — the row was never going to hold still through it.
   */
  const syncBtn = (label: string, onClick: () => void) => (
    <button key="sync" className="ds-btn small" title={`Use the All games bind for ${label}`} onClick={onClick}>
      Sync
    </button>
  );

  /** a combo ANYWHERE — main or any season's override. The combo wait is global, so the slider
   *  is live as soon as one map has a combo in it. */
  const anyCombo =
    PAD_ACTIONS.some((a) => bindings.pad.combos[a].length > 0) ||
    (bindings.perGame !== undefined &&
      Object.values(bindings.perGame).some((ov) =>
        Object.values(ov?.padCombos ?? {}).some((list) => (list as PadChord[]).length > 0),
      ));

  const game: GameId | null = scope === 'all' ? null : scope;
  /** THE MAP ON SCREEN: main itself, or the season's effective map (its overrides applied and
   *  the actions it does not use already gone). Editing routes by `game`, not by this. */
  const view = game ? effectiveBindings(bindings, game) : bindings;

  /**
   * THE LIVE LINE, and the card it belongs to: it prompts while a slot is armed ("Press a key for
   * Forward…"), shows a pad combo as it builds ("Intake: RT + …"), and otherwise shows the last
   * notice. It takes the place of that card's TITLE, so capture is not announced by a keycap's
   * text alone and nothing on the page moves to make room for it.
   */
  /** what the armed slot holds, as the player reads it — null for the add slot and UNBOUND */
  const armedBind: string | null = !capture
    ? null
    : capture.kind === 'key'
      ? capture.slot < view.keys[capture.action].length ? keyName(view.keys[capture.action][capture.slot]) : null
      : capture.slot < padBinds(view.pad, capture.action).length
        ? padBindLabel(padBinds(view.pad, capture.action)[capture.slot])
        : null;
  const armedFilled = armedBind !== null;
  const live: Notice | null = capture && holding
    ? {
        panel: panelFor(capture.action, game),
        text: armedBind ? `Release to remove ${armedBind} from ${ACTION_LABELS[capture.action]}.` : 'Release to cancel.',
      }
    : capture && conflict
    ? { panel: panelFor(capture.action, game), text: conflictText(conflict, scope), error: true }
    : capture
    ? {
        panel: panelFor(capture.action, game),
        text:
          capture.kind === 'pad' && chordSoFar.length > 0
            ? `${ACTION_LABELS[capture.action]}: ${padBindLabel([...chordSoFar].sort((x, y) => x - y))} + …`
            : capture.kind === 'key'
              ? `Press a key for ${ACTION_LABELS[capture.action]}. Esc cancels${armedFilled ? ', Backspace removes' : ''}.`
              : `Press a button or combo for ${ACTION_LABELS[capture.action]}. Hold one to ${armedFilled ? 'remove' : 'cancel'}, or Esc.`,
      }
    : menuCapture
      ? { panel: 'match', text: 'Press a gamepad button for Menu. Esc cancels.' }
      : notice;

  const pad = bindings.pad;
  const setPad =(patch: Partial<PadBindings>): void => {
    const b = cloneBindings(bindings);
    onChange({ ...b, pad: { ...b.pad, ...patch } });
  };

  const switchScope = (s: Scope): void => {
    setScope(s);
    setNotice(null);
    // a capture belongs to the row it started on, and that row may not exist in the new scope
    setCapture(null);
  };

  /** is this keycap the bind the armed slot was just refused? Only on the scope that lists it. */
  const clashes = (device: Conflict['device'], a: KeyAction, bind: string): boolean =>
    !!conflict && conflict.scope === scope && conflict.device === device && conflict.action === a && conflict.bind === bind;

  const keyRow = (a: KeyAction) => {
    const list = view.keys[a];
    const armed = capture?.kind === 'key' && capture.action === a ? capture : null;
    return (
      <div className="ds-bind-row" key={a}>
        <span className="ds-bind-label">{ACTION_LABELS[a]}</span>
        {/* a keycap's own name is only its key ("W"), so the group carries the action */}
        <span className="ds-keys" role="group" aria-label={`${ACTION_LABELS[a]}, keyboard`}>
          {game &&
            keyDesynced(bindings, game, a) &&
            syncBtn(ACTION_LABELS[a], () => onChange(syncKeyInGame(bindings, game, a)))}
          {list.map((k, i) =>
            keycap(
              keyLabel(k),
              armed?.slot === i,
              false,
              () => begin({ kind: 'key', action: a, slot: i, game }),
              i,
              keyName(k),
              clashes('key', a, k),
            ),
          )}
          {list.length === 0
            ? keycap('UNBOUND', !!armed, true, () => begin({ kind: 'key', action: a, slot: 0, game }))
            : armed && armed.slot < list.length
              ? removecap(armed, `${keyName(list[armed.slot])} from ${ACTION_LABELS[a]}`)
              : list.length < BIND_SLOTS_MAX &&
              addcap(!!armed && armed.slot >= list.length, () => begin({ kind: 'key', action: a, slot: list.length, game }), 'key')}
        </span>
      </div>
    );
  };

  const padRow = (a: PadAction) => {
    const binds = padBinds(view.pad, a);
    const armed = capture?.kind === 'pad' && capture.action === a ? capture : null;
    return (
      <div className="ds-bind-row" key={a}>
        <span className="ds-bind-label">{ACTION_LABELS[a]}</span>
        <span className="ds-keys" role="group" aria-label={`${ACTION_LABELS[a]}, gamepad`}>
          {game &&
            padDesynced(bindings, game, a) &&
            syncBtn(ACTION_LABELS[a], () => onChange(syncPadInGame(bindings, game, a)))}
          {binds.map((c, i) =>
            keycap(
              padBindLabel(c),
              armed?.slot === i,
              false,
              () => begin({ kind: 'pad', action: a, slot: i, game }),
              i,
              padBindLabel(c),
              clashes('pad', a, chordKey(c)),
            ),
          )}
          {binds.length === 0
            ? keycap('UNBOUND', !!armed, true, () => begin({ kind: 'pad', action: a, slot: 0, game }))
            : armed && armed.slot < binds.length
              ? removecap(armed, `${padBindLabel(binds[armed.slot])} from ${ACTION_LABELS[a]}`)
              : binds.length < BIND_SLOTS_MAX &&
                addcap(
                  !!armed && armed.slot >= binds.length,
                  () => begin({ kind: 'pad', action: a, slot: binds.length, game }),
                  'button or combo',
                )}
        </span>
      </div>
    );
  };

  /** a bind panel: the keyboard and the gamepad side by side, one column each (stacked on a
   *  phone, where `.ds-binds` drops to one track) */
  const bindPanel = (p: BindPanel) => {
    const msg = live?.panel === p.id ? live.text : null;
    return (
    <section className="ds-panel" key={`${p.id}-${game ?? 'all'}`}>
      <div className="ds-panel-h">
        {/* THE TITLE SLOT CARRIES THE LIVE LINE (see `live`). The heading keeps its name for a
            screen reader in `.ds-sr`; the status region is always present, so a message that
            arrives is announced rather than only drawn. */}
        <h2 className={`ds-panel-title${msg ? ' notice' : ''}${msg && live?.error ? ' error' : ''}`} title={msg ?? undefined}>
          <span className={msg ? 'ds-sr' : undefined}>{p.title}</span>
          <span role="status">{msg}</span>
        </h2>
      </div>
      <div className="ds-panel-body">
        <div className="ds-binds">
          <div className="ds-bind-col">
            <h3>Keyboard</h3>
            {p.keys.map(keyRow)}
            {p.id === 'match' && (
              <div className="ds-bind-row">
                <span className="ds-bind-label">Menu</span>
                <span className="ds-keys">
                  <span className="ds-key fixed">ESC</span>
                </span>
              </div>
            )}
          </div>
          {/* the 3D view card is keyboard-only: a camera key has no pad action (`VIEW_ACTIONS`) */}
          {p.id !== 'view' && (
            <div className="ds-bind-col">
              <h3>Gamepad</h3>
              {/* HOW A PAD DRIVES, at the head of its column, level with the drive keys: the stick
                  role and the two settings that shape it are the pad's half of this panel, and they
                  left the right-hand column two-thirds empty while they lived a panel further down. */}
              {p.id === 'driving' && (
                <>
                  <OptRow<PadBindings['driveStick']>
                    label="Drive stick"
                    hint={`${pad.driveStick === 'left' ? 'right' : 'left'} stick turns`}
                    value={pad.driveStick}
                    cols="two"
                    mini
                    onPick={(driveStick) => setPad({ driveStick })}
                    options={[
                      { v: 'left', t: 'Left' },
                      { v: 'right', t: 'Right' },
                    ]}
                  />
                  <PadSlider
                    label="Stick deadzone"
                    shown={`${Math.round(pad.deadzone * 100)}%`}
                    value={pad.deadzone}
                    min={0}
                    max={0.4}
                    step={0.01}
                    onChange={(deadzone) => setPad({ deadzone })}
                  />
                  <PadSlider
                    label="Sensitivity curve"
                    shown={pad.curve === 1 ? '1.0 · linear' : pad.curve.toFixed(1)}
                    value={pad.curve}
                    min={1}
                    max={3}
                    step={0.1}
                    onChange={(curve) => setPad({ curve })}
                  />
                </>
              )}
              {p.pads.map(padRow)}
              {p.id === 'match' && (
                <div className="ds-bind-row">
                  <span className="ds-bind-label">Menu</span>
                  <span className="ds-keys">
                    <button
                      className={`ds-key${menuCapture ? ' capturing' : ''}`}
                      aria-label={`Menu button, ${padButtonLabel(bindings.pad.menuButton)}. Press to rebind`}
                      onClick={() => {
                        setNotice(null);
                        setMenuCapture(true);
                      }}
                    >
                      {padButtonLabel(bindings.pad.menuButton)}
                    </button>
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
    );
  };

  /* TOUCH CONTROLS + TUTORIAL: ONE PANEL, TWO ROWS (design review 04-09). They were two
     head-only cards a section gap apart, one button each. TOUCH CONTROLS AT THE TOP (owner,
     2026-09-22): it sat in a "More" fold under the whole keyboard map, which on a phone — the
     one device it is for — was the last thing on the page. THE TUTORIAL STAYS ON THIS SCREEN:
     it is where somebody lands when the controls are what they do not understand, and the
     only way back in for a player who skipped the Modes page's first-run card. */
  const startPanel = (
    <section className="ds-panel">
      <div className="ds-panel-body">
        <div className="ds-ctl-row">
          <h2 className="ds-panel-title">Touch controls</h2>
          <button className="ds-btn small" onClick={onEditTouchControls}>
            Customize
          </button>
        </div>
        {onTutorial && (
          <div className="ds-ctl-row">
            <h2 className="ds-panel-title">{tutorialGame ? `${seasonFor(tutorialGame).name} tutorial` : 'Tutorial'}</h2>
            <button className="ds-btn small" onClick={onTutorial}>
              Start
            </button>
          </div>
        )}
      </div>
    </section>
  );

  const scopeSwitch = (
    <>
      {/* THE SCOPE SWITCH, first, because it decides what everything under it is. A season's
          button carries a mark while one of its own rows has no bind (a Reset, or a stored map
          older than one of its actions), and a RED ring while it holds the bind the armed slot
          was refused (`conflict`). */}
      <div className="ds-bind-scope ds-segs" role="group" aria-label="Which games these binds are for">
        <button
          className={`ds-seg ${scope === 'all' ? 'on' : ''} ${conflict?.scope === 'all' && scope !== 'all' ? 'conflict' : ''}`}
          aria-pressed={scope === 'all'}
          onClick={() => switchScope('all')}
        >
          All games
        </button>
        {seasons.map((s) => {
          const unbound = seasonUnbound(bindings, s.key).length;
          return (
            <button
              key={s.key}
              className={`ds-seg ${scope === s.key ? 'on' : ''} ${conflict?.scope === s.key && scope !== s.key ? 'conflict' : ''}`}
              aria-pressed={scope === s.key}
              aria-label={unbound ? `${s.name}, ${unbound} without a bind` : undefined}
              onClick={() => switchScope(s.key)}
            >
              {s.name}
              <span className={`ds-seg-dot${unbound ? ' lit' : ''}`} aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </>
  );

  const panels =
    game === null ? (
      <>
        {ALL_GAMES_PANELS.map(bindPanel)}

        {/* THE PAD'S BUTTONS — when a trigger counts as pressed, how long a combo's buttons wait,
            and whether the pad drives the menus. How a hand works, not what a button means, so
            every one is the same in every season. The `.ds-field` rows Audio and Graphics use:
            these were the only sliders in Configure drawn a different way. */}
        <section className="ds-panel">
          <div className="ds-panel-h">
            <h2 className="ds-panel-title">Gamepad</h2>
          </div>
          <div className="ds-panel-body stack">
            <PadSlider
              label="Trigger threshold"
              shown={`${Math.round(pad.triggerThreshold * 100)}%`}
              value={pad.triggerThreshold}
              min={0.1}
              max={0.9}
              step={0.05}
              onChange={(triggerThreshold) => setPad({ triggerThreshold })}
            />
            {/* THE COMBO WAIT. Disabled rather than hidden while no combo is bound: it does
                nothing then, and a row that appears when the first combo lands would move every
                row under it (§1.4 of the UI standard), whereas a greyed slider says it exists. */}
            <PadSlider
              label="Combo wait"
              shown={`${Math.round(pad.chordGraceMs)} ms`}
              value={pad.chordGraceMs}
              min={PAD_CHORD_GRACE_MIN_MS}
              max={PAD_CHORD_GRACE_MAX_MS}
              step={10}
              disabled={!anyCombo}
              onChange={(chordGraceMs) => setPad({ chordGraceMs })}
            />
            {/* the one rule a player cannot work out from the keycaps: how to make a combo, and
                that it beats its own buttons at a price */}
            <p className="ds-hint">
              Hold two or three buttons together while binding to make a combo. It wins over the
              buttons it is made of, which then fire on their own only after the combo wait.
            </p>
            <ToggleRow
              label="Controller menu navigation"
              value={pad.navEnabled}
              onPick={(navEnabled) => setPad({ navEnabled })}
            />
          </div>
        </section>
      </>
    ) : (
      seasonPanels(game).map(bindPanel)
    );

  return (
    <>
      {/* A PHONE LEADS WITH TOUCH (design review 18-15). The scope switch and the whole
          keyboard/gamepad grid are unusable without a keyboard or a pad, and they filled the
          page under the one panel a touch device can use — so on a coarse pointer they fold,
          closed, behind one disclosure. A tablet with a pad paired opens it. */}
      {coarse ? (
        <>
          {startPanel}
          <details className="ds-fold ds-bind-fold">
            <summary>Keyboard &amp; gamepad bindings</summary>
            <div className="ds-fold-body">
              {scopeSwitch}
              {panels}
            </div>
          </details>
        </>
      ) : (
        <>
          {scopeSwitch}
          {game === null && startPanel}
          {panels}
        </>
      )}

      <div className="ds-actions">
        {game === null ? (
          <button
            className="ds-btn"
            onClick={() => {
              if (
                !window.confirm(
                  'Reset all controls? Every keyboard and gamepad bind, in every game, goes back to its default.',
                )
              )
                return;
              setNotice(null);
              onChange(cloneBindings(DEFAULT_BINDINGS));
            }}
          >
            Reset to defaults
          </button>
        ) : (
          <button
            className="ds-btn"
            title={`${seasonFor(game).name}’s own binds back to their defaults, and Intake and Shoot back on All games`}
            onClick={() => {
              const name = seasonFor(game).name;
              if (!window.confirm(`Reset ${name} controls? Its own binds go back to their defaults, and Intake and Shoot back to All games.`))
                return;
              setNotice(null);
              onChange(resetGame(bindings, game));
            }}
          >
            Reset {seasonFor(game).name}
          </button>
        )}
      </div>
    </>
  );
}
