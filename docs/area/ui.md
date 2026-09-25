<!-- governs: src/ui/**, src/input/**, src/render/**, src/tutorial/**, src/settings.ts, src/theme.ts, src/audio.ts, src/main.tsx, src/seo.ts, src/download.ts, src/contributors.ts, src/desktop.ts, src/perfStats.ts -->
# UI — controls, settings, audio, HUD, and the copy rules

Rebindable controls, assists, persisted settings, HUD product rules, and the UI COPY house rules — which were settled by a measured audit, so read them before writing any user-visible string. `docs/ui-standard.md` is the CSS half.

*Split out of `CLAUDE.md` on 2026-09-16, **verbatim** — CLAUDE.md is loaded into every
session and this is not needed by most of them. The `governs:` line above is read by
`scripts/docaudit.mjs` and by the editor hook, so keep it accurate when paths move.*

## Before you add a class, look it up

`docs/ui-components.md` is the generated inventory of every `ds-` class: where it is declared
and how many times `src/**` uses it, grouped by family. There are 233 of them across 8,700
lines of CSS, which is not greppable in practice — and a new class written because the grep
was inconclusive is the mechanism by which this design system drifts.

`npm run uiindex` regenerates it; `npm run uiaudit` fails if the committed copy is stale.

The other three are not interchangeable: **`DESIGN.md`** (repo root) is the look — the
driver-station keycap language, the palette, the ONE depth model. **`docs/ui-standard.md`** is
the geometry and the scales, and it is STRICT: if a rule there is wrong, change the rule first
and then the code. **`uiaudit`** is what actually enforces both, as ratchets.

---

## Controls, settings, audio

- **Controls are fully rebindable** (`src/input/bindings.ts`, `src/ui/ControlsSection.tsx`):
  every keyboard action, gamepad buttons, AND the drive/turn stick assignment. Escape is
  reserved (menu/cancel — never bindable). Defaults: WASD drive, Q/E or ←/→ turn, Shift/K intake,
  Space fire, C catalyst (CR), F flip-front, P park, Enter start, R restart.
  ⚠️ **CONFLICT POLICY: A TAKEN BIND IS REFUSED, NEVER STOLEN** (owner, 2026-09-24: binding a
  key another function uses "shouldn't unbind the other one. Instead, it should show a
  conflict error"). The screen asks `keyConflict` / `padConflict` (`bindings.ts`) BEFORE it
  assigns. On a hit the slot STAYS ARMED, the card title turns red ("C is taken by Place
  POLLEN (BIOBUZZ). Press another key, or Esc."), the holder's keycap is ringed red and shakes
  twice (`.ds-key.conflict`), and when the holder is listed in another scope that scope's
  button is ringed too (`.ds-seg.conflict`). The ring outlives the capture by `NOTICE_MS`, so
  following the red button still finds the keycap. The query covers what the old steal
  reached: main vs every action sharing a game, and main vs a season's own override. The
  steal code in `assignKey` / `assignPadBind` is still there and still tested, but the screen
  only calls it once the bind is free. Everything below that says "steals" describes those
  model functions, not what the player sees.
  **THE 3D VIEW KEYS ARE BINDINGS** (`VIEW_ACTIONS`: `viewToggle` T, `cameraCycle` L,
  `eyeUp` I, `eyeDown` O; BIOBUZZ-only, keyboard-only, on a "3D view" card in the BIOBUZZ
  scope). They were hard-coded in `graphics/viewKey.ts` and `scene/renderScene.ts`, missing from
  this screen, and the camera sat on C with Place POLLEN, so one press did both. The listeners
  read the player's binds through `viewActionOf`, which the App keeps current with
  `setViewBindings`. `mergeBindings` gives an action newer than the stored blob its default
  only where no stored bind in a conflicting action holds that key. An old Deploy ramp on L keeps
  L, and the camera starts unbound, with the red dot on BIOBUZZ.
  **Every action carries as many alternatives as the player wants**: the `+` keycap at the end
  of a row captures into a new slot, and Backspace or Delete while a slot is waiting removes
  it (neither key is anywhere a driving hand goes, so nothing bindable is lost). The screen
  used to let you REPLACE a slot and never ADD one, which with sixteen buttons and twelve pad
  actions meant every rebind cascaded into an UNBOUND somewhere else.
- **GAMEPAD COMBOS** (`PadBindings.combos`, `src/input/padChords.ts`): two or three buttons
  held together fire one action (`RT + D-UP` for a lift), the way real drive-team code reads
  `gamepad.dpad_up && gamepad.right_trigger > 0.5`. Capture commits on the first RELEASE, so a
  second button can join; a chord is stored canonical (ascending, unique, `2..PAD_CHORD_MAX`)
  and `padBinds(pad, action)` is the one view — singles then combos — that the resolver, the
  keycaps, the start overlay and the tutorial hints all read.
  ⚠️ **`combos` is a SEPARATE field from `buttons`, on purpose.** A settings blob is persisted
  and account-synced VERBATIM, so an older client reading `buttons` full of arrays would reject
  every pad binding and, on its next save, write the defaults back over them. Kept apart, an
  older client ignores the field and the singles keep working.
  **Stealing is EXACT**: a single steals that single from every action and touches no combo; a
  combo steals the identical combo and touches no single. RT can be Shoot AND half of a lift
  combo at once, which is the whole point.
  **The resolver has three rules, and each one wrong is a lift that fires a shot** (DECODE's
  first shot is instant): (1) the longest satisfied chord wins, masking the singles it is made
  of; (2) a satisfied chord that is a strict prefix of a bound, unsatisfied chord WAITS
  the COMBO WAIT from the moment it completed, because nobody presses two buttons on the
  same frame — `PadBindings.chordGraceMs`, the player's own slider under the gamepad block
  (default `PAD_CHORD_GRACE_MS` 80 ms, clamped to 20..200 on load, disabled rather than
  hidden while no combo is bound so the rows under it never move); (3) a fired combo CONSUMES its buttons until they are released, so
  letting go of D-UP with RT still down does not start shooting, and one finger lifting off a
  three-chord does not fire the two-chord under it; (4) a tap INSIDE the wait still counts —
  a prefix let go before the wait runs out, with no wider chord having fired, fires once on
  the frame of the release, so a quick RT tap is still one shot and park / flip / start /
  restart still work on a button that also lives in a combo (rule 2 alone swallowed it, which
  a review caught). ⚠️ **A rule-4 tap is held asserted for `PAD_TAP_HOLD_MS` (34 ms), not one
  frame.** `resolve()` runs once per FRAME, but the HELD-level bits it produces are consumed by
  the SIM on a fixed 60 Hz accumulator, and above 60 fps most frames step ZERO ticks — so a
  one-frame pulse landed on a frame that stepped nothing about two in three at 165 Hz and the
  shot was silently lost (multiplayer has the same hole: a jittery `setInterval` at the sim
  period). With frame period `p` and sim period `T`, at most `floor(T/p)` frames in a row step
  nothing, so the gap between stepping frames is always under `2T` = 33.34 ms; 34 is that floor
  rounded up. The window is CONTINUOUS, so `gamepad.ts`'s `prev*` detectors still see exactly
  one rising edge. Two things the rules deliberately do NOT do, so nobody rediscovers them:
  overlapping chords that are not nested all fire (`LB + RT` and `RB + D-UP` held together
  also satisfies an `RT + D-UP` bound elsewhere, exactly as `&&` on the real pad would), and
  masking reads SATISFIED rather than fired, so under a three-chord the two-chord's wait also
  silences the single for its length. With no combo bound, none of this runs: the fast path is
  the old any-button test with no state. All of it is pinned in `npm test`.
- **GAME-SPECIFIC BINDS — three kinds of action** (`ControlBindings.perGame`,
  `effectiveBindings`, `SHARED_ACTIONS` in `bindings.ts`). `ControlBindings` (keys + pad + combos)
  stays THE MAIN SETTING. Every action is exactly one of three kinds, and the kind decides where
  its binds live and which scope of the Controls screen lists it (`npm test` holds all three):
  - **SHARED** — the drive keys, Swap wheel set, Flip front, Park mode (a speed cap on the drive
    command), Start and Restart. Every game reads them and they mean the same thing in every
    game: main only, listed under All games only, never overridden.
  - **SEASON-ONLY** — an action one game uses (Catalyst, Catapult, the five BIOBUZZ ones). Main
    only as well, because main's bind for it already reaches that one game and no other; listed
    in its season's scope alone.
  - **OVERRIDABLE** — a mechanism more than one game has: Intake and Shoot. Main is what every
    season starts from (All games), and a season may override it.
  `perGame?: Partial<Record<GameId, {keys?, padButtons?, padCombos?}>>` is a NEW SIBLING FIELD —
  same reasoning as `combos`: an older client ignores it and plays the main map. An overridable
  action PRESENT in a game's override is **DESYNCED** there; ABSENT inherits main, and "sync back"
  is the deletion of the entry. `padButtons` and `padCombos` for one action are ONE UNIT. Stick
  role, deadzone, curve, trigger threshold and the combo wait stay GLOBAL.
  ⚠️ **THE MIGRATION (2026-09-22).** `perGame` used to take an override of ANY action a game
  used, so every season scope listed the drive keys and stick sliders again with SYNCED beside
  each (owner: "Shared settings like drivetrain controls SHOULD BE only shown on global"), and a
  season-only action had two stores for its one bind. `mergePerGame` migrates on every load, so it
  is idempotent: a season-only override FOLDS into main (lossless — it reaches the same one game);
  a shared override is DROPPED (the one lossy step, alpha-only and three days old, and usually not
  a choice at all but the victim of a season-scope steal); and a game that had one dropped is
  SCRUBBED, its own actions giving up any bind a shared control now holds again — otherwise W
  drives forward AND shoots. A scrubbed override left empty reads UNBOUND. Every reader
  (`keyDesynced`, `effectiveBindings`, …) also ignores an override of a kind that may not have one.
  **`effectiveBindings(b, game)` is the one resolver**, and everything that drives or NAMES a
  control reads it, never `settings.bindings`: `InputManager` (via `GameController.bindings`,
  resolved once from `gameId`), the start overlay, and the tutorial hints. It returns a plain
  main-shaped `ControlBindings` with the overrides applied, `perGame` stripped, and the actions
  the game does not use **EMPTIED** — not ignored later. That emptying is load-bearing: the
  chord resolver reads a `PadBindings` and has no idea what a game is, so a Chain Reaction combo
  left in a BIOBUZZ map would mask a single, consume its buttons, and make a tap wait for a
  combo that can never fire.
  ⚠️ **`ACTION_GAMES` (`bindings.ts`) is the table that makes a duplicate legal**, and every row
  was checked against which `RobotCommand` bit that game's SIM reads: `catalyst`/`fling` are
  Chain Reaction only, `bbPlace`/`bbPlaceNectar`/`bbNectar` are BIOBUZZ only, everything else is
  every game (`driveMode` included — it is read in `src/sim/robot.ts`, which all three route
  through). **Two actions conflict only if some game uses both.** So MAIN may put one key on
  both `catalyst` and `bbPlace` — no session offers both — while `fire` still steals from
  everything. **The season-scope editors are the main editors run against that season's
  EFFECTIVE map**, so the steal scope is right by construction, and each changed action is then
  written where it lives: a season-only one to main, an overridable one to the override (a steal
  victim among them is DESYNCED there). **A season scope may not take a bind from a shared
  control** — `assignKeyInGame` / `assignPadBindInGame` REFUSE (`sharedKeyHolder` /
  `sharedPadHolder` name the holder for the screen), rather than steal a drive key in one season
  or, from a screen that says it edits one season, in all of them. **Main-edit vs override**: when
  a main edit would put a bind on an action that is SYNCED in game G while some other action G
  uses holds it in a DESYNCED override, **the override loses that bind**. **Sync is the same rule
  run the other way**: the binds a synced action comes back to WIN, and the season's other actions
  give them up. `resetGame` (the season scope's Reset) syncs the season and puts its season-only
  actions back on their defaults, minus any default a shared or overridable bind now holds.
  `mergeBindings` validates `perGame` entry by entry (unknown game ids, unknown actions, and
  actions a game does not use are all dropped; lists go through the same validators as main),
  and **`BIND_SLOTS_MAX` (8) caps every list, main included** — `+` could grow one without
  bound, and the server caps the settings blob at 64 KB. A blob with no `perGame` round-trips
  byte for byte, and the field is pruned back to absent when the last override is synced away.
  **UI** (`ControlsSection.tsx`, with the row lists in the DOM-free `controlsLayout.ts` so the
  smoke run can hold them to the kinds): the scope switch comes first — `All games` plus one
  entry per **visible** season. All games opens with ONE panel of two rows — Touch controls, then
the ACTIVE season's tutorial, titled "{Season} tutorial" (`tutorialGame`; the row is absent when
that season has none) — then three bind panels —
  Driving, Mechanisms (Intake and Shoot), Match — each a keyboard column and a gamepad column,
  and a Gamepad panel for the trigger threshold, combo wait and menu navigation (the stick role,
  deadzone and curve head the Driving panel's gamepad column). A season scope is ONE panel: that
  season's own actions. A row carries **Sync only while it differs** from All games, and nothing
  while it matches — the SYNCED/CUSTOM marker on every row is gone, and so is a reserved
  invisible slot for the button, which wrapped Intake's keycaps on a phone in every season. **The
  status message takes the place of the TITLE of the card holding the row it is about**
  (`panelFor`): while Park mode is armed, "Press a key for Park mode…" replaces DRIVING; the title
  stays in a `.ds-sr` span so the card keeps its heading. The title slot keeps its line-height and
  ellipsizes (`.ds-panel-title.notice`), so a message never moves the panels. That is also why
  there is no status line under the switch any more: a reserved empty line there cost ~25px of gap
  above the first card. A prompt stays while its slot is armed, and so does a conflict (in red,
  in place of the prompt); a confirmation ("Place POLLEN: J") fades after `NOTICE_MS` (4s). A season's
  button carries a red dot while one of its own rows has no bind (`seasonUnbound`).
  ⚠️ **The capture effects on the controls screen depend on `capture` ALONE**, with
  `bindings`/`onChange` in refs: `onChange` is a fresh arrow every render and the App re-renders
  on its own every few seconds (the presence poll), which restarted the pad effect mid-capture
  and swept the buttons still held into `alreadyDown` — the release then bound nothing. A
  single-press capture never showed it; commit-on-release made it a real window.
- **Configure ▸ Match is two cards: Match setup, then Practice.** Practice holds Practice
  physics (only where the game offers 3D) and the three other robots — Partner / Opponent 1 /
  Opponent 2, each None · Dummy · AI (AI only where the game registers a `BotDriver`) with its own
  difficulty row, which is always rendered and DISABLED unless the seat is AI (§1.4: no rows
  appear or vanish). Stored per game in `GameSettings.practiceSeats`, a sibling of the legacy
  `practiceBots`/`practiceDummies` (left in the blob, no longer read, so older clients keep
  theirs). Applies in Solo practice AND Free drive; the spawn is `practiceSetups` in
  `settings.ts`, DOM-free so `npm test` holds it. A run with other robots gets a "With robots"
  badge in Practice replays (`PracticeRunMeta.others`) — practice runs are never ranked anyway.
- "Flip front" reverses robot-centric drive so the shooter side leads — applied at INPUT level
  in `GameController`, sim untouched; REVERSED chip in the HUD.
- All `GameSettings` persist to `localStorage['decodesim.settings.v1']` via `src/settings.ts`
  (validated field-by-field on load — corrupt/stale data falls back per field) and sync to
  Postgres per account.
- **Assists are menu-only** (field/robot-centric, auto intake, auto fire) — NO in-game toggle
  keybinds. Auto-fire/intake must respect match phases (no firing in `pre`/`transition`).
- **AIM ASSIST IS ALWAYS ON, in BOTH games, and is NOT configurable.** `coerceAssists`
  (sim/spawn.ts) forces `aimAssist` true — deliberately in the SHARED coercer, not the UI,
  because a stored `false` can arrive from localStorage, a synced account blob, a saved robot
  slot, or the wire, and forcing it only in the menu would strand anyone who had switched it
  off with no control to switch back. The FLAG and both sims' manual-aim branches stay
  (DECODE's chassis-locked turret in `updateRobotActions`, Chain's `chainAimAssist` guard),
  tested by setting `r.aimAssist` on the spawned robot — restoring the option is deleting one
  line in `coerceAssists` and putting the toggle back in `Menu.tsx`. A DECODE "auto align"
  assist (hold fire → steer the chassis onto the shot) was built and then REMOVED: with the
  turret always tracking there is nothing for it to do. Chain's turretless hold-to-steer is a
  different thing and STAYS — see `chainAimAssist`.
- Audio: real FIRST field sounds (`public/sounds`, from Team254/cheesy-arena) + an announcer
  VOICE via speechSynthesis. Countdown digits must interrupt in-flight speech to stay on the
  visual beat. Menu has Sounds ON/OFF (master) + Voice lines ON/OFF (falls back to beeps).
  Shoot/intake/gate SFX are SYNTHESIZED (WebAudio, `sfx*` in `audio.ts`) and triggered by
  edge-detection on world state in `GameController.handleActionAudio` — **the sim core stays
  event-free for these**.

## Controller navigation — the pad drives the MENUS too

One focus-navigation layer for the whole app (`src/input/padNav.ts` + `src/ui/PadNavLayer.tsx`).
It drives NATIVE focus and NATIVE activation on the real DOM, so everything keyboard-reachable
is pad-reachable and every fix it forces is an accessibility fix in its own right. **Nothing
here invents a parallel selection state** — a second model of "what is selected" would drift
from the one the browser already keeps, and the two would disagree first on exactly the screens
that are hardest to test.

- **The split is what makes it testable.** `padNav.ts` is DOM-free, clock-free and
  `navigator`-free: the geometry picker, the repeat clock, the glyph families, the on-screen
  keyboard's reducer, the suspend registry and the button mask. `npm test` drives all of it on
  synthetic rects and an injected clock, which is the only way to test spatial navigation
  without a browser. `PadNavLayer.tsx` is the half that touches focus, and it is the ONLY half
  that may.
- **The layer is mounted beside `<App/>` (`main.tsx`), not inside it**, for the reason the ad
  provider wraps it: the game, lobby, record and ranked screens are returned EARLY, so anything
  inside `App` would have to be remembered by each of them. It renders through a portal to
  `body`, so its position in the tree costs it nothing, and it polls nothing until a pad
  connects.
- **Focus moves by GEOMETRY, and the cross-axis term is the whole trick.** A candidate qualifies
  when its centre is strictly past the source's on that axis (strictly, or a row whose centres
  line up is a candidate for itself and a move sits still); the winner minimises
  `alongDistance + 2 × crossGap`, where `crossGap` is 0 while the two boxes overlap on the other
  axis. That is what makes a ragged grid behave — moving down out of a narrow tile picks
  whatever is actually UNDERNEATH it, not whatever is nearest by straight-line distance. With no
  candidate it scrolls, then wraps within the container, then stays put.
- ⚠️ **THE RING IS ON `:focus`, NOT `:focus-visible`.** A pad move is a synthetic `.focus()`,
  which the browser treats as programmatic — Chromium grants `:focus-visible` after keyboard-ish
  interaction but not reliably from a gamepad, so the app's own rings cannot be leaned on. The
  layer sets `data-padnav="on"` on `<html>` while a pad is the ACTIVE input (any pointer move
  clears it, so a mouse user never sees a ring), and one rule set in `shell.css` rings plain
  `:focus` underneath it. It is an `outline`, so it moves no layout. Inside `.hud`/`.game-root`
  it takes `--ds-on-field-accent` — **category 3**, because the field is hardcoded dark.

### The in-match contract

**In a match the pad is the robot's.** `GameView` calls `suspendPadNav('match')` for its whole
mount, so there are no focus moves and no synthetic clicks while somebody is driving. The
Controls screen stands the layer down the same way while a rebind is armed
(`suspendPadNav('capture')`) — without it, A-to-activate binds A to whatever row was just opened.

- **A registry, not a boolean.** The two reasons OVERLAP (Controls is reachable from a match),
  and with a boolean the second release would undo the first.
- ⚠️ **`GameView`'s effect is MOUNT-ONCE, with `onExit` in a ref.** It is a fresh arrow every
  render and `App` re-renders on its own every few seconds (the presence poll), so depending on
  it would tear the suspension down and rebuild it mid-match — the same trap the capture effects
  above document.
- **The way back in is the MENU button**, watched even while the layer is suspended because it
  is the way back out. Default `PAD_MENU_BUTTON` (15, D-RIGHT): the one standard-mapping index
  no default bind uses, and `npm test` asserts that against `DEFAULT_BINDINGS` rather than
  trusting the comment, because a future default taking it would make the button that leaves a
  match also drive the robot.
- ⚠️ **EDGE CONSUMPTION.** The press that opens the menu must not also drive, and the press that
  closes it must not fire a shot. `maskPadButtons(held)` records everything held at that instant;
  `GamepadInput.sample` runs `applyPadMask` over the held list **before the chord resolver sees
  it**, and an entry clears when its button is physically released. Same rule as the chord
  resolver's rule 3, same reason. It is module state because the two sides are different objects
  on different loops — the pad-nav rAF sets it, the sim's input manager reads it.

### Preferences, text and glyphs

- **Two new `PadBindings` fields, both NEW SIBLINGS** validated field-by-field like
  `chordGraceMs`: `menuButton` (0..31) and `navEnabled` (default true, the "Controller menu
  navigation" toggle in Controls ▸ Gamepad). Same reasoning as `combos` — an older client ignores
  them and keeps its Esc-only exit. No new storage key: both ride the settings blob that already
  persists and syncs. `App` mirrors them into `padNav.ts`'s little store because the layer is
  mounted outside it; importing `PadBindings` as a value there would close the cycle
  `bindings.ts → padNav.ts`.
- **A text field activated BY PAD gets an on-screen keyboard.** Ordinary buttons, so the same
  layer navigates it and no second input model exists. Caps is ONE-SHOT, and the cap on length
  is the field's own `maxLength` — a keyboard that let a pad user past it would write a value
  the form then rejects.
- ⚠️ **Confirm is not always index 0.** In the standard mapping 0 is the BOTTOM face button and
  1 the RIGHT one; on a Switch pad the RIGHT one is A, so `padConfirmButton`/`padBackButton`
  SWAP for `nintendo`. Relabelling alone would hand that player a legend saying A and a layer
  listening to B. An unrecognised pad stays `generic` rather than guessing Xbox — a wrong glyph
  is worse than a neutral one, because the player trusts it and presses it.
- **No keyboard view keys, and the arrows stay the driver's.** Every bind in this app is
  rebindable, so a navigation layer that ate the arrows would either steal a driving control or
  need a runtime conflict check against `effectiveBindings` on every keystroke.

## Configure — the six sections, and the three rules that hold them together

`src/ui/Configure.tsx` routes six sections at `/configure/<key>`. **The ARRAY is the order on
screen; the KEYS are shipped URLs** (`audio` is Audio and Visual), so reordering must never
rename one. Order is task order — Robot, Controls, Match, Audio and Visual, Graphics, Network:
build it, learn to drive it, set up the session, the two output sections, then the connection.
**Network** (`NetworkSection.tsx`) holds client prediction, which sat in a Controls fold until
2026-09-22 (owner: "Network prediction should NOT be part of controls") — it is how this machine
draws its own robot in a 3D-physics room, not a control, and not Graphics either. **A sub-nav hint
is optional**: Audio and Visual's "Follows your account" and Graphics' "This device only" said
where the settings are stored, which nobody picks a section by, and went as clutter.

- **ONE SPELLING OF A PICK: `OptRow` / `ToggleRow` (`src/ui/OptRow.tsx`).** There used to be
  three — a single tile whose LABEL carried the state (`Auto intake ON`), a two-tile `Off`/`On`
  row, and a segmented strip — and the first is the bad one: the tile is already filled accent
  when it is on, so the word says a second time what the fill says, and an unlit `Sorter OFF`
  beside a lit `Sorter ON` reads as two different controls. Every boolean and small enum in
  Configure goes through this component, which is also where the `aria-pressed` fourteen
  hand-rolled toggles were missing comes from. **Toggle buttons, never an ARIA radiogroup** —
  a radiogroup owes roving tabindex and arrow keys, and half that pattern is worse than none.
- **RARE CONTROLS FOLD; THEY ARE NOT ROUTED ELSEWHERE.** `<details class="ds-fold">` — Graphics
  ▸ Advanced (the sixteen overrides the Quality preset already sets), Audio ▸ Individual sounds
  (the five per-emitter trims). A fold is for a RARE control, not an ORPHAN one: Controls ▸ More
  held touch controls and network prediction because neither was a binding, which put the one
  control a phone needs last on the page — touch is the first panel now, prediction is Network. Closed
  it is one row; open it is exactly where it was, so nothing is hidden from somebody who knows
  it exists. `.ds-fold.inset` is the variant for inside a panel body, where a second card would
  be nesting. The marker rotates and `[open]` changes a border COLOUR, never a width.
- **THE ROBOT PREVIEW STAYS ON SCREEN, AT THE TOP.** Owner ruling, 2026-09-22: the 260px rail is
  gone — it kept the robot on screen but read as a widget parked beside the build — and `.ds-hero`
  is pinned flush under the app bar from 1100px up (not at 720px tall or less). ⚠️ **The strip that
  was reverted before held 26% of a 720px viewport, and the cause was the stat tiles**, never the
  sprite. The chip wall that replaced them failed the other way: nine chips wrapped inside 96px,
  scrolling in both directions between 1100 and 1280 with the top chip clipped and the name cut to
  "My Ro…", and under 1100 the card was 509px tall (690 on a phone). **It is ONE card now, laid
  out by a CONTAINER query on its own width** — the viewport breakpoint gave a 535px card a strip it
  could not hold. The picture is a 160px-tall box in a column of `minmax(200px, 30%)` (owner,
  2026-09-23: "the robot should take up the left fourth - third"; it was 96px and too small to
  read); beside it the name and the team, ONE LINE each, scrolling when they do not fit (`Marquee`
  — wrapped, a 24-character name broke mid-word across three lines at 1100), and ONE build line
  (`buildWords`); then a FIXED grid of six numbers, 3×2 or 2×3, so no season's stat can widen or
  deepen the card. About 178px as a strip, so it pins only from **860px** tall (it was 721 at
  114px). On a phone the numbers go under the picture. A 3D preview that cannot start marks its 3D
  segment (dashed, reason in the title); it does not print a sentence into the picture column.
- **ONE ROBOT CARD** (`src/ui/RobotCard.tsx`): a saved robot, a preset, and the "Your robot" swap
  row in the lobby and the ranked strategy window. Name, the team when there is one (a preset's
  only when it is a real team — a demo's `teamName` is a tagline), and ONE line, `buildWords`: the
  drivetrain and the mechanisms, no numbers. A preset card used to carry a tagline, a spec line and
  a loadout chip — three readings of one robot. **Every SAVED robot in the builder carries a 96px
  picture** (owner, 2026-09-23), as the card's LEFT COLUMN with the name, team and line stacked to
  its right: the game's `GameModule.savedThumb` when it has one (BIOBUZZ: the 3D render, else its
  2D schematic), otherwise the same 2D schematic the hero draws. The name and team are one line
  each through `Marquee` (the results roster's — two passes, hover pauses, off under reduced
  motion; not infinite, WCAG 2.2.2). Presets and the lobby pass no picture and are unchanged.
  `.ds-opts.robots` is auto-FILL at `minmax(260px, 1fr)`, so a lone saved robot is one card wide;
  at 220 two cards shared 1100px with a 90px text column.
- ⚠️ **ENTERING CONFIGURE ▸ ROBOT IS MEASURED, 2026-09-23** (cold, offscreen Electron, long tasks
  over 50 ms). DECODE's `RobotPreview` used to call `createWorld` per picture, whose G304 start
  search is ~30 ms a call; with the saved cards that was a 276 ms task, so it now builds ONE
  template world per document (0 ms after). BIOBUZZ 3D was ~210 ms: the thumbnail batch now waits
  for idle and captures one per slice, and the preview warms its shaders with `compileAsync`
  before it draws (~140 ms after, the floor being context + PMREM setup). Prefetching the scene
  chunk was measured and bought nothing. A new picture on this page gets measured the same way.

**Configure copy.** No decorative glyph (the `🎯` on preset cards, the `＋` on the add cards and
the `✎` on Edit build are gone), no sentence whose content is where another screen is, and no
sub-line naming a KEY —
every control in this app is rebindable, so `L-stick/W-S: Fwd/Back` is a claim that goes stale
the moment somebody opens Controls. A blurb survives only where it names a trade-off the player
is choosing between (`docs/ui-standard.md` §8): the archetype and drivetrain descriptions, the
four `PERF_DISPLAY_BLURB` lines, an option's download size, and the R102 stow note.

## HUD / UX product rules

- **THE BANNER STRIP** (`BannerStack.tsx`, beside `<App/>` in `main.tsx`) is where the restart
  countdown always was, now also admin notices (info, known bug, warning) and the line that
  tells an admin or tester they are past a lockdown. Fixed, so it never moves layout. ONE row
  shows, most important first (restart, warning, known bug, notice); the rest sit behind "N
  more". **In a match only the restart shows.** A player closes a banner per id + revision
  (`BANNERS_DISMISSED_KEY`); an edit brings it back; a restart cannot be closed. Filtering is
  client-side by the current game and the build's channel (`visibleBanners`, siteRules.ts).
- **THE CLOSED SCREEN** (`ClosedScreen.tsx`) replaces the whole app while the site is closed
  to this viewer, for every URL. The way out (the redirect, "Go to DSIM") is the primary action
  and takes focus; the way in is Sign in, after which the status is asked again and the app
  replaces the screen with no reload. Copy: DSIM or "Alpha" is closed, never a game name.
- HUD mimics the FTC live scoring display: red|timer|blue bar at the BOTTOM.
- **No popup toasts over the field** — events go to the muted left-edge log; zone status lives
  in the top-right chips.
- Visible MENU/RESET buttons on the game screen (don't rely on Esc/R knowledge); "MATCH
  BEGINS IN" text lead-in before the 3-2-1 digits.
- END GAME at 20 s left (`ENDGAME_START` / `CHAIN_ENDGAME_S`): warning cue + HUD label/tint.
- Games opt into chrome via `GameModule.ui` (`showScoreHud`, `startEditor`, `intakes`).
- **THE LABEL OVER A ROBOT IS THE DRIVER'S USERNAME, IN THEIR ALLIANCE COLOUR**
  (`renderer.ts`, both the 2D pass and the 3D projected one). It answers "who is that", so the
  username wins over the build's `spec.name` and the team-number prefix goes with it; a seat the
  server did not name — solo, a bot before `matchStart.drivers` existed, a replay, an old server
  — falls back to the old `teamNumber + spec.name`. The LOCAL robot is still never labelled.
  The fill is `COLORS.redLabel` / `COLORS.blueLabel`, a separate pair because `COLORS.red`/`blue`
  are under 4.5:1 as 12-px type on the field; the dark stroke stays, and it is what carries the
  glyphs onto the light backdrop and onto a 3D background. Category 3 (their ground is the
  canvas), so they do not theme.
- ⚠️ **NOTHING IN `.game-root` MAY KEY A COLOUR OR AN ASSET ON `:root[data-theme]`.** The 3D
  view's scrim (`.game-root.view-3d …`, styles.css) makes every HUD plate dark in BOTH themes by
  REDEFINING tokens, so anything themed by the attribute instead misses it. The sponsor logo swap
  did, and put the dark-ink cut on a dark chip in light theme. Draw with a token the scrim
  redefines, or add a `.game-root.view-3d` override beside the theme rule.
- ⚠️ **`.hud` IS `pointer-events: none`** so the canvas keeps a drag. Anything in it meant to
  be clicked re-enables them ON ITSELF (`.game-btn`, `.sponsor-chip`, `.mobile-btn`).
  The connection chip did not, for months: its `onClick` opened a ping graph and the click never
  arrived. The in-match prediction picker had the same bug and was removed (2026-09-23); the
  setting lives in Configure › Network only. **Before adding a control to the HUD, add the rule.**
- ⚠️ **THE TOUCH PAD'S BUTTON SET IS DERIVED FROM `ACTION_GAMES`** (`src/ui/mobileActions.ts`
  + each game's `src/games/<id>/mobile.ts`), and `npm test` asserts the coverage per game: every
  action a season uses is either a button, a stick, on-screen chrome, or a written entry in
  `TOUCH_OTHER_ACTIONS`. It was a hand-written list of four, so BIOBUZZ shipped `bbPlace`,
  `bbPlaceNectar`, `bbRamp` and `bbPass` with a keybind, a pad button and nothing at all on a
  phone — three of its own handoffs recorded that and none of them could fail a build.
  **Two questions, on two clocks.** `present(ctx)` asks whether a press could EVER act for this
  build and these assists, which only the menu can change. A button that can't is not drawn:
  INTAKE under auto intake, SHOOT under auto fire, FLIP in field-centric drive. Each of those
  is checked by STEPPING THE SIM with the button held and released, not by reading the table
  back. The exception is Chain Reaction's drum and dumper with aim assist on, where a held
  SHOOT steers the chassis onto the goal (`chainAimAssist`) and so keeps its button (the
  `manualFireCounts` hook). This reverses the 2026-09-21 "ghosted, never hidden" ruling (tester
  feedback, 2026-09-23). A default DECODE phone really is the two sticks and PARK, because
  nothing else on it would do anything. `ready(live)` asks whether a press would act NOW
  (hopper empty, no FLOWER in reach, robots disabled), off `touchLiveOf(hud)` at the 10 Hz HUD
  poll. An unready button is drawn IDLE in place (`.mobile-btn.idle`, `aria-disabled`), still
  sends its press, and **never moves or vanishes under a thumb**, which was the real concern
  behind the old ruling. Sub-second cooldowns, BIOBUZZ's shot-lands gate and Chain alignment are
  deliberately NOT modelled, because at 10 Hz they would flicker while the driver aims. A
  season-specific predicate FAILS OPEN when its half of the HUD is missing. The idle look is the
  fill, the ring, the glyph at 0.45 and a `--ds-on-field-dim` label, **never `opacity` on the
  button**, which would take the hit area's feedback down with it. And **positions are
  computed, not stored** —
  a `mobileLayout` fraction cannot be right in both orientations (the shipped default overlapped
  SHOOT with INTAKE in portrait and hung the drive stick off the left edge), so the pad packs
  itself into two thumb columns against the live viewport and reads a stored position only once
  the player has dragged that control. In LANDSCAPE the score bar and the breakdown chips are in
  the left and right gutters, and the packer treats both as obstacles.
- **ONE performance read-out**, `PerfHud`, bottom-right above the net chips on a desktop (the
  top-right cluster on a phone, where the bottom-right is the thumb pad), driven by
  `GameSettings.perfDisplay` alone (off · simple · detailed · graphs, default simple = fps,
  1% low, ping ± jitter). It used to hang under the top-right chip column and moved with each
  game's column height. It is NOT interactive and NOT a `[data-hud-band]`: a band reserves an edge and the 3D
  camera reframes the field around it, so a diagnostic carrying one would change the shot it
  was turned on to measure. Its three ancestors each drew their own corner box and two of them
  landed on something — `?perf=1` over MENU/RESET, the 3D overlay over the event log.
- **A 3D match opens on the loading screen, never on the 2D field.** `GameController.sceneLoading`
  is true until the first scene mounts; the 2D pass draws nothing meanwhile and `LoadingScreen`
  (GameView) covers the field and HUD. First load only: a mid-match 2D → 3D switch keeps the 2D
  view until the scene lands.
- **`data-hud-band` goes on the thing that covers the field, not on its wrapper.** It is on
  `.status-row` (the chips), not on `.status-wrap`, so a panel stacked under the chips cannot
  grow the reserved inset mid-match.

### UI COPY — the house rules, settled by measurement

A seven-slice audit of every user-visible string (2026-09-06) found the voice already
strong — almost no marketing vocabulary, no "Oops!", no exclamation marks — and the real
yield in CONSISTENCY. These are the rulings, with the counts that decided them, so the
same arguments are not had again:

- **Typographic punctuation: `’` `“` `”` and `…`**, never the ASCII ones (measured 60:18
  for the apostrophe; the ellipsis was already 50:0). A file full of `’` with an ASCII
  hyphen doing an em dash's job is the actual inconsistency.
- ⚠️ **PREFER A FULL STOP OR A COLON TO A DASH.** The hyphen-vs-em-dash split was 50/50
  across the app — genuine drift, not a convention — so it had to be ruled on, and
  "normalise every ` - ` to ` — `" is the WRONG answer to a request that is explicitly
  anti-AI-slop: a dash-joined appositive is the single most-cited tell of machine-written
  prose. Almost every one of them was two sentences. Where a dash is genuinely the right
  mark, it is `—`.
- **Failures are `Couldn’t <verb the thing>.` plus a concrete next step** (`Couldn’t` beat
  `Could not` 12:5). No "Something went wrong.", ever — it tells a person nothing, and it
  was on the claim form and the sign-in form, which are the two worst places for it.
  The admin console composes its own through **`adminFail()` (`src/ui/adminCopy.ts`)**,
  which existed because five spellings of `Failed - check admin sign-in` had accumulated
  across two files, none of which said WHICH action failed.
- **Sentence case** for `ds-btn`, every heading, and the mode tiles (`Solo practice`, `Free
  drive`, `Custom room`). ALL CAPS is correct in exactly five places and they are all
  deliberate: `.overlay-buttons button` (13/13), the HUD chips (the FTC scoring display is
  uppercase), `ds-cta` (14/14), the admin console (29/34), and `.ds-panel-title` — mono,
  uppercased BY CSS, often an `<h2>`, so its source text stays sentence case.
- **One name per thing.** The rating is "rating", never "ELO", in anything a player reads (the
  system is Glicko-2). A player-made room is a **"Custom room"** everywhere it is named.
- **A CTA carries no trailing ▶**, and **no label is a dingbat alone**: a ✕ or ▶ is
  `aria-hidden` beside words or under an `aria-label` that names the target.
- **Errors are plain language.** The raw text ("Failed to fetch", "HTTP 502", a server
  message) goes to `console.warn` with a `[area]` prefix; the screen says `Couldn’t …` and
  what to do next.
- **`.ds-empty` for an empty list** (`.big` headline, no period, then one sentence with
  one), **`.ds-loading` for a loading state** (9/10 already did).
- **A name always gets `SupporterBadge`, as a SIBLING** — see the badge rules above — and
  **`BadgeMarks` beside it** (the worn badges; titles folded into badges in 0049): see
  `docs/area/accounts.md` for the surfaces.
- **Terminology.** DSIM is the app; DECODE and Chain Reaction are seasons. DECODE has
  ARTIFACTS, CR has PARTICLES, and a leak either way is a bug. CR's ring is a **CATALYST**
  — the **RING STAND** is a different object in the same game, so the HUD chips that said
  RING now say CATALYST. Teleop is **DRIVER-CONTROLLED** on all THREE surfaces that name it
  (the live HUD, `world.events`, and the burned-in video overlay); it used to be
  DRIVER-CONTROLLED on one and TELEOP on the other two, and free drive was FREE DRIVE and
  PRACTICE. `npm test` now pins the overlay to the HUD's words.
- **No padding**: simply / just / please note / be sure to / feel free to. **No helper text
  that restates its own label** — a hint under a button that already says what it does is
  the most common form of it here.
- **Foul lines name the ACT, not the place** (`G424 contact in the gate zone`, not
  `G424 gate zone`), because a driver reads them mid-match; CR's `G05`/`G06` used to be
  bare rule ids. ⚠️ Those strings live in `src/sim/` and `src/games/chain/`, so **changing
  them is a SERVER change and needs a deploy.**
- Code comments and JSDoc are OUT of this ruleset. The verbose in-code voice this file is
  written in is deliberate house style.

## The TUTORIAL (`src/tutorial/`, content in `src/games/<id>/tutorial.ts`)

A tutorial is a scripted solo practice: a list of STEPS, each a staged field, a goal predicate
over the world, a hint naming the player's own bound keys, and a step card in the HUD band. The
ENGINE is shared and DOM-free; the CONTENT is per game, on `GameModule.tutorial`.

⚠️ **STAGING IS WORLD CONSTRUCTION, NEVER A MID-RUN TELEPORT.** `docs/area/netcode.md` states the
invariant solo practice depends on: a run is fully SIM-DRIVEN so `{seed, setups, commands}` alone
reproduce it. So a step's `stage(world)` is applied to a world that has just been built, at tick 0,
before the robot may move — the same moment `stageBiobuzz` lays the field out — and moving to the
next step **REBUILDS** the world and stages that one, exactly as `startMatch`/`restart` do
(`GameController.rebuildForTutorial`). Everything else follows from that:

- **It runs as FREE DRIVE**, and all three consequences are wanted. Drivable from tick 0 (no
  countdown and no 30-second AUTO, six times over); BIOBUZZ bills **no fouls outside the played
  periods**, so the step that asks for a NECTAR in a FLOWER cannot hand out a G410 MAJOR for doing
  as it says; and free drive is **never recorded** (`startMatch` returns on a phase that is not
  `pre`), which is the honest answer to "could a replay reproduce a staged world" — it could not,
  so none is kept. ⚠️ **DECODE's penalty engine DOES run in `freeplay`** (`src/sim/penalties.ts`
  says so), so a DECODE step staged near the gate can bill the player; the TUTORIAL lane asserts
  every scripted run ends with zero fouls.
- **It is not a `GameSettings` field.** A run is not a preference: settings persist to
  localStorage and sync to Postgres per account, so a "in the tutorial right now" bit would follow
  the account to another machine and survive a reload onto a screen with no idea what was staged.
  It is a `GameView` prop and a `GameController` option, and it does not survive a refresh.
- **The seen flag is `decodesim.tutorial.v1`**, per device, PER GAME, and FAIL-OPEN both ways
  (`src/tutorial/flag.ts`, the `chainDisclaimer.ts` pattern): a read that throws answers "not
  seen" so the offer appears, and a write that throws is swallowed. Set on completion, on Exit,
  and on the Modes card's Not now. The value is a comma list of game ids; the legacy value
  `'1'` means EVERY game (whichever tutorial wrote it cannot be recovered, and re-offering one
  to somebody who has done one is the nag the flag exists to stop).
- **Predicates are evaluated every SIM TICK**, not at the 10 Hz HUD poll: several of the things a
  step asks for are cleaned up by the ticks that follow them (an up CELL is emptied by the tip it
  caused), so a predicate read six ticks late can look at a field that has already been tidied.
- ⚠️ **A PREDICATE MUST BE FALSE ON THE STAGED WORLD.** A step that is already true when it opens
  completes instantly and teaches nothing, and the failure is invisible — the card flashes past.
  The SHOOT step shipped as `contents.length > 0` and the field stages three NECTAR in every up
  CELL, so it was true at tick 0 for both alliances. The TUTORIAL lane asserts non-vacuity for
  every step under both physics and both alliances, which is the only place that can catch it.
- **Hints are functions of `ControlBindings`**, never strings. Every control in this app is
  rebindable, and a tutorial that names a key the player has moved is worse than one with no hints:
  they press what it says, nothing happens, and the step they are stuck on is the one that was
  meant to teach them the control. A connected pad names the BUTTON instead.
  **Compose them with the `say` template tag** (`src/tutorial/hints.ts`):
  `` say`Hold ${control(c, 'fire', 'fire')}. The turret aims for you.` ``. A hint is a list of
  parts: prose, and controls that `TutorialCard` renders as `.ds-key.fixed` keycaps with the
  key's spoken name in a `.ds-sr` span (an `aria-label` on a `<kbd>` may be ignored). **An
  unbound control collapses the WHOLE hint** to "Shoot has no key. Bind one in Controls." via
  `resolveHint`, applied ONCE at the top (`runner.view`, `hintText`), never inside `say`, or a
  nested `driveHint` would collapse mid-sentence. The TUTORIAL lane holds the prose: **≤ 25
  words** on every device, opens with a capital, **game nouns lowercase** in hint prose (the
  caps belong to the HUD chips; a keycap part keeps its own), and aim assist worded once, the
  same in both games: "The turret aims for you."
- **The finished card** reads eyebrow "Tutorial complete", title "Try a Solo practice match",
  hint "Open MENU and pick Solo practice for a full scored match." (sentence case, matching the
  mode tile) — a next action, not a sign-off.
- **A step may not apply to a build.** `TutorialStep.applies(spec)` is resolved once, when the
  runner is constructed, so the card numbers the steps that are actually going to be asked for.
  BIOBUZZ's two FLOWER steps are exactly complementary (place a NECTAR needs a Box Tube *and* a
  launcher that carries NECTAR; retrieve a POLLEN needs neither), and the lane asserts every build
  is offered exactly one of them.
- **The card is a `data-hud-band` element, never an overlay** — no popups over the field, per the
  HUD rules above, and a step card is up for the whole of a step. `data-hud-band` is load-bearing:
  `GameController.refreshHudInsets` measures it so the 3D camera reframes the field above it, and
  `.game-root.view-3d [data-hud-band]` is what gives it the fixed dark scrim a lit 3D background
  needs. Its CSS is `src/ui/tutorial.css`, imported last from `main.tsx`
  as its own file so its additive rules merge without conflicts.
- **Surfaces**: the first-run card on the Modes page (hidden once THIS game's flag is set), and a
  permanent "{Season} tutorial" row with a Start button in Controls ▸ All games, running the
  ACTIVE season's tutorial — which is where somebody who skipped it, or who has just rebound half
  their keys, gets it back. A game with no `tutorial` (Chain Reaction) shows neither.
- **Verification**: the `TUTORIAL` lane in `scripts/smoke-biobuzz/` (`npm run test:bb`, also
  inside `npm test`). It drives every step of both games to completion with scripted commands
  under both physics and both alliances, and asserts non-vacuity, ball conservation, the
  hopper/held mirror, determinism of staging, the `applies` partition, and that the hints follow
  rebound keys and a connected pad.



## Dialog titles, and the phone sweep (2026-09-22)

- **A SHELL DIALOG'S TITLE IS `ds-dialog-title`.** `.overlay-panel h2` is a bare element rule
  carrying the MATCH overlay's 3px all-caps tracking, and exactly one element wants it
  (`GameView`'s `RED ALLIANCE`). The six sentence-case dialogs in `App.tsx` inherited it and
  came out as 20px of plain ink spaced like a sign — no chosen weight (the browser's `bold`
  stood in), no token colour, no line-height, and the one heading in the app that belonged to
  no design system. `.ds-dialog-title` is `--ds-t-xl` at 800, `--ds-track-tight`,
  `--ds-lh-heading`, `--ds-ink` (NOT `.ds-h2`'s clamp), and the same class fixes
  `.net-overlay-card h3` ("Connection lost", "Reconnecting…"), a bare `h3` for the same reason.
  It is declared BARE as well as compound, because it is the title of EVERY shell dialog,
  **`.ds-modal` included** (`AuthPanel`, `ChallengePicker`, `TermsGate`, `UsernameGate`,
  `RewardDialog`), not only the `App.tsx` overlays. It pairs with `.ds-dialog-actions`, which
  made exactly this split for the BUTTONS already.
- **`useDialog` (`src/ui/useDialog.ts`) IS the dialog behaviour.** Attach its ref to the element
  carrying `role="dialog" aria-modal="true" aria-labelledby=…` — those stay in the JSX, where a
  reader of the markup sees them — and it moves focus in on open (first control, else the card:
  give it `tabIndex={-1}`), traps Tab, calls `onClose` on Escape (omit it for a dialog that must
  be answered, like `TermsGate`), and hands focus back on close. Do not hand-roll a trap.
- **`.ds-title h1` is `.ds-h1`'s type.** It was 26→40 against 26→38 — the same heading on two
  page shells, two clamps, visible only by navigating between them.
- **A NAME CLAMPS; IT DOES NOT BREAK ITS ROW.** `.lb-name-h` / `.lb-at` are nowrap ellipses
  with `ch` caps, and `.lb-scroll .ds-table` has a 520px floor so the board SCROLLS instead of
  squeezing the one column with prose in it (`.mh-table` has had that floor since its own
  sweep). Without both, a 24-character handle came apart one word per line and a duo row stood
  five lines tall beside one-line rank and score cells.
- **`.ds-player` WRAPS.** The lobby/strategy roster row was one non-wrapping flex line, so on a
  phone READY — the chip a driver actually watches — was off the right edge of a `.ds-panel`
  that clips. It wraps at `row-gap: --ds-s-1` now: name line, then the chips.
- **`.ds-segs.even`** is the modifier for a strip that cannot fit: under 640px it becomes an
  `auto-fit` grid, so the six drivetrain filters read as a deliberate 3 + 3 rather than a
  ragged 4 + 2. Not a scroller — a filter must not hide how many options there are.

## Shared primitives, touch and phone layout (design review 2026-09-22)

- **`.ds-sr` is the ONE visually-hidden utility** (`shell.css`). Use it for a spoken name
  beside a glyph or a keycap, a live region's text, a table caption. Do not write another
  clip-rect rule for a single component.
- **`.ds-badge` is the one inline status tag** (`shell.css`): neutral on `--ds-tile`, mono
  `--ds-t-xs` caps, pill. Tones `.accent` / `.ok` / `.warn` / `.danger` / `.staff` colour the
  TEXT and EDGE only; `.count` is the one filled form. Never `--ds-red` (that is an alliance,
  not an error). It replaced `.adm-pill`, `.ann-badge` and `.fr-badge` — do not revive a
  per-screen pill.
- **`.ds-table-scroll` is the one table scroller** (it replaced `mh-`/`yd-`/`an-scroll` and
  `adm-table-wrap`): edge shadows show there is more, `[aria-busy='true']` fades it to 0.5
  while a page loads. `.tall` caps it at 70vh and makes the header row sticky — at ≥641px only,
  because a sticky header on a phone eats the rows it is labelling.
- **TOUCH TARGETS KEY ON `(pointer: coarse)`, NOT WIDTH** (18-02). A narrow desktop window has a
  mouse; a landscape tablet is wide and has a finger. The coarse block only raises SIZES
  (min-height / padding) — `.ds-key` and the range track are deliberately left alone (a keycap
  is a label, not a button). The sponsor mark's coarse rule sits AFTER its base rule on
  purpose; the file position is the tiebreak.
- **`--hud-bottom`** is the height the in-match score bar reserves: 68px on `.game-root`, 56px
  under `@media (pointer: coarse), (max-height: 520px)` — the SAME query as the compact score
  bar, so the two cannot disagree. `.breakdown-row` and the tutorial card read it, on phones
  too; anything new that sits above the bar reads it too instead of a literal. The phone row
  used to carry its own `bottom: 50px`, 6px under the bar, and BIOBUZZ rendered its row BEFORE
  `.scorebar`, so the bar painted over NECTAR LOCKED and PENDING. **Render a chip row AFTER the
  bar it sits on**, as all three games do now, because DOM order is the paint order between
  siblings.
- **Contrast blind spots are audited now.** `scripts/contrast.mjs` covers the in-match
  surfaces that used to be skipped: the 3D view's scrim (its tokens are parsed from
  `.game-root.view-3d .eventlog` in `styles.css`, so retuning the scrim retunes the check), the
  prediction panel, the server notice, the touch pad's idle labels, the score-bar
  tips and the replay-video labels, plus the results stage on `--ds-stage-bg`. A new in-match
  surface gets its pairs there.
- **PATCH NOTES ARE READ AT `.ann-md`, NOT `.md`** (2026-09-25, owner: the card was "pretty
  small so it is hard to read"). The "What’s new" modal, `/changelogs` and the admin preview all
  render `AnnouncementItem`/`.ann-md`: body `--ds-t-lg` at `--ds-lh-long` and 68ch, title
  `--ds-t-xl`, `##` a mono-caps accent label (every bullet already opens in bold, so a bold
  heading read as one more bullet). Items are FLAT, divided by a rule: no tile inside the panel.
  The base `.md` stays compact for everything else. The modal scrolls between a fixed action
  bar and the panel top, so "Got it" never scrolls away. ⚠️ A class added beside a `.ds-*` one
  (`.cl-body` on `.ds-panel-body`, `.cl-head` on `.ds-panel-h`) is written COMPOUND: at equal
  specificity file position decides, `shell.css` loads after `styles.css`, and `.ds-panel-h` sits
  below `.cl-head` in shell.css. `.cl-head` lost that way, and its lone GitHub button
  sat on the left. (A compound `.ds-*` rule belongs in shell.css, or `uiaudit` counts it as
  `ds-outside-shell`.)
- **Career tiles hide when empty** (G9). `CareerPanel` renders `.ds-stats` only when the player
  has played a match or holds a best — a wall of zeros tells a new player nothing.
- **PHONE LAYOUT.** At ≤900px `.ds-body` wraps into ONE nav row: the rail (order 1) and the
  collapsed friends chip (order 2) share the first line and the content takes its own
  (`.ds-body > .ds-main` order 3). The strips WRAP, they do not scroll. In a room, friends
  drops BELOW the console, capped at `min(42dvh, 360px)`. At ≤640px the rail's Home item goes
  (the DSIM mark routes home), the subnav becomes an `auto-fit` grid, and the friends chip is
  icon-only, its label visually hidden
  but still read. The profile hero is a CONTAINER query
  (`@container hero (max-width: 439px)`): picture + name on top, stats three across below.
- ⚠️ **Breakpoints are literals, repeated across CSS and TS** (18-10: no shared module yet).
  `FriendsPanel.tsx`'s `SQUEEZE` query (`(max-width: 1099px) and (min-width: 901px)`) must
  match `shell.css` by hand — change one, grep for the other.
