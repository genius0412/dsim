<!-- governs: src/ui/**, src/input/**, src/render/**, src/tutorial/**, src/settings.ts, src/theme.ts, src/audio.ts, src/main.tsx, src/optionalChunks.ts, src/seo.ts, src/download.ts, src/contributors.ts, src/desktop.ts, src/perfStats.ts -->
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
  ⚠️ **A MECHANISM DOES NOT LOAD UNBOUND** (2026-09-26). A map from before the ramp (Place
  POLLEN on its old default Z) gave Deploy ramp no key, the ramp never deployed from the
  keyboard, and a save wrote the empty row back. An action in `FRESH_FALLBACK_KEYS` takes the
  first free fallback instead (the ramp: G, then M), and a stored empty ramp beside Place POLLEN
  still on exactly Z is repaired the same way. View keys have no fallback.
  **The pad follows the same new-action rule** (2026-09-26): Deploy ramp's pad default moved
  from D-DOWN (13) to R3 (11), because players reported D-DOWN restarting their run. A stored
  map keeps its own ramp button, D-DOWN included. A map with no ramp row takes R3 unless a
  conflicting action already holds R3 in main or in a BIOBUZZ override; then it loads unbound
  (no pad fallback). D-DOWN went to Reverse intake on 2026-10-24.
  **NECTAR bar has its own action** (`bbBar`, 2026-11-01; it rode Deploy ramp before): key `'`,
  fallbacks `[` then `]`, pad B. B was Intake's second bind, so **Intake defaults to LT alone in
  every game** (owner's pick: every other button carries a BIOBUZZ bind, and the defaults are one
  map for all games). A saved map whose Intake is exactly the old LT + B moves too, on load
  (`mergeBindings`): a season reset never touches main's Intake, so without that Reset BIOBUZZ
  could not give the bar B (owner report, same day). Not on a map that turns with the triggers,
  where B is the only live pad Intake; its bar loads unbound and marks BIOBUZZ.
  **No duplicate defaults** (owner, same day: "why even have the duplicate controls?", then "Drop
  A too"). A and B were Shoot's and Intake's second binds, and their one job was to be Shoot and
  Intake while the triggers turn. Shoot is RT alone and A is unbound; a stored Shoot of exactly
  RT + A loads as RT, by the same rule and with the same trigger exception. The cost, known and
  checked in smoke: a map that turns with the triggers has no pad Shoot or Intake until the player
  binds them, and the tutorial hint says "Shoot has no button. Bind one in Controls."
  **Every action carries as many alternatives as the player wants**: the `+` keycap at the end
  of a row captures into a new slot, and Backspace or Delete while a slot is waiting removes
  it (neither key is anywhere a driving hand goes, so nothing bindable is lost). **On a pad,
  HOLD one button alone for `PAD_HOLD_REMOVE_MS` (1 s) and let go**: that removes the armed slot,
  or cancels an empty one (`PadCapture`, `padChords.ts`). Pad navigation is suspended while a
  capture is armed and every button is the bind, so before this a controller-only player could
  neither remove a bind nor leave a capture. The same stepper runs during a KEY capture, where a
  pad press cancels. The screen
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
    in its season's scope, and in All games while that season is the active one.
  - **OVERRIDABLE** — a mechanism more than one game has: Intake and Shoot. Main is what every
    season starts from (All games), and a season may override it.
  `perGame?: Partial<Record<GameId, {keys?, padButtons?, padCombos?}>>` is a NEW SIBLING FIELD —
  same reasoning as `combos`: an older client ignores it and plays the main map. An overridable
  action PRESENT in a game's override is **DESYNCED** there; ABSENT inherits main, and "sync back"
  is the deletion of the entry. `padButtons` and `padCombos` for one action are ONE UNIT. Stick
  role, deadzone, both curves, trigger threshold and the combo wait stay GLOBAL.
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
the ACTIVE season's tutorial, titled "{Season} tutorial" (`activeGame`; the row is absent when
that season has none) — then the bind panels —
  Driving, Mechanisms (Intake and Shoot), the active season's own cards, Match — each a keyboard
  column and a gamepad column, and a Gamepad panel for the trigger threshold, combo wait and menu
  navigation (the stick role, Turn with, deadzone, Drive curve and Turn curve head the Driving panel's gamepad
  column). A season scope is ONE panel: that season's own actions.
  ⚠️ **THE ACTIVE SEASON'S OWN MECHANISMS ARE IN ALL GAMES TOO** (owner, 2026-10-10: "People keep
  missing the fact that there is a separate panel for biobuzz controls"). `allGamesPanels(active)`
  puts "{Season} mechanisms" and, for BIOBUZZ, "{Season} 3D view" after Mechanisms, holding only
  SEASON-ONLY actions. Those have one store (main), so the row in All games and the row in the
  season scope edit the same bind; Intake and Shoot overrides are still the season scope's alone.
  Only the active season's: all three would bury the shared rows. A conflict whose holder is on
  one of those cards is ringed in place and names no scope (`holderListed`). A row carries **Sync only while it differs** from All games, and nothing
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
- **TURN WITH TRIGGERS** (`PadBindings.turnWith`, owner 2026-10-10; Controls ▸ Driving ▸ gamepad
  "Turn with": the other stick, or Triggers). LT turns left and RT right, analog, through the
  stick deadzone and the turn curve (`GamepadInput.sample`); the other stick then turns nothing. A new
  sibling field, so an older client ignores it and turns with the stick.
- **DRIVE CURVE AND TURN CURVE ARE TWO SLIDERS** (owner 2026-10-11). `PadBindings.curve` shapes the
  drive stick (strafe and forward, radially) and the two tank sticks; `PadBindings.turnCurve` shapes
  turning, on the stick or the triggers. `turnCurve` is a new sibling field: an older client ignores
  it and turns on `curve`, and a stored blob without it loads it as its own `curve`, so the split
  changes nobody's turning until they move the slider.
  ⚠️ **A BIND ON A TRIGGER IS PAUSED, NEVER REMOVED.** Shoot and Intake default to RT and LT, so
  removing them on the switch is the silent unbind the conflict policy forbids. `livePad` drops
  every bind with a trigger in it (combos too) from the map the chord resolver plays, the keycap
  stays on its row struck through (`.ds-key.paused`), and switching back restores it. Every
  reader that NAMES a pad control reads `livePadBinds` (tutorial `padFor`, the start prompt), so
  a hint never says "Hold RT" while RT turns; `seasonUnbound` counts a paused bind as none.
  Binding a trigger while it is on is refused by `padConflict` as held by Turn left / Turn right.
  Switching says what happened in the Driving title when any map has a trigger bind.
- **HOLD OR TOGGLE** (`ControlBindings.modes`, `MODE_ACTIONS`, `src/input/pressModes.ts`; player
  request 2026-11-03: "hold down shift for flower intake instead of it toggling"). Ten actions
  have a Hold | Toggle choice on a "Hold or toggle" card after the mechanism cards: Intake, Shoot,
  Place NECTAR, Pass and Reverse intake (native Hold); Deploy ramp, NECTAR bar, Swap wheel set,
  Flip front and Park mode (native Toggle). Single presses (Place POLLEN, Next flywheel speed,
  Start…) have none. One mode per action, for keyboard and pad alike and the same in every
  season; touch is unchanged. A new sibling field that stores only non-native entries, so an
  older client ignores it and a blob that never used it round-trips byte for byte. All Games
  lists the active season's own rows; a season scope lists only its season-only ones, because
  Intake's mode there would read as that season's alone. Reset of a season resets its own.
  ⚠️ **IT IS ALL IN THE INPUT LAYER, NEVER THE SIM.** A held action on Toggle is a client latch
  (`ToggleLatch`) whose level the command carries. A SIM toggle on Hold (ramp, bar, wheel set)
  cannot be a level on the wire, because the sim flips on press edges (`debouncedPress`), so
  `HoldFollower` presses FOR the player when the held level and the robot (`poll(localRobot)`)
  disagree, waiting out the sim's latch between presses. It presses ONCE per change of the held
  level, not until the robot agrees: the swing guard reverses a ramp that hits the flower, and
  pressing until it agreed would flap it into the flower for as long as the button stayed down.
  Both ignore a release under `RELEASE_DEBOUNCE_MS` (42 ms, the client twin of
  `TOGGLE_DEBOUNCE_S`). Flip front and Park mode were client toggles already: on Hold the button
  inverts the toggle while down (`flippedNow` / `parkedNow`), and a touch tap still flips it. No
  server, replay or SIM_VERSION change: the commands are what the sim always read.
  Tutorial hints follow the mode: `holdControl` ("hold SPACE" / "press SPACE") and `withHeld`
  ("with SHIFT held" / "toggled on") in `src/tutorial/hints.ts`. A touch button is always held, so
  the on-screen pad keeps the hold wording.
- **MATCH SETUP AND PRACTICE SETUP (`SoloSetup.tsx`) ARE NOT CONFIGURE SECTIONS**
  (owner, 2026-10-12). Solo practice used to open one setup screen with a sticky start bar; it now
  STARTS straight away (behind `guardStart`). Since 2026-11-01 the two cards are Play's **Solo setup
  popup** (the Solo group's Match setup button; App's `soloSetupOpen`, an `OverlayDialog page` with Done and
  Start solo practice), not its right column (see THE MENU STAGE below); `/match-setup`, `/practice-setup`, `/solo-setup` and
  `/configure/match` all land on `/modes`. `part` picks the card. Match setup: alliance, start position, the Zenith autonomous routine (its order, library then buttons then preview, is what keeps it reachable in the scrolling column: `docs/area/autos.md`, "The Autonomous panel").
  Practice setup: Practice physics (only where the game offers 3D) and the three other robots —
  Partner / Opponent 1 / Opponent 2, each None · Dummy · AI (AI only where the game registers a
  `BotDriver`) with its own difficulty row, which is always rendered and DISABLED unless the seat is AI
  (§1.4: no rows appear or vanish). `/configure/match` and the old `/solo-setup` land on Match setup.
  ⚠️ THE RUN LENGTH PICKER IS GONE; `GameSettings.runLength` is still read by Solo practice, record
  runs and the rooms you create, so it keeps its stored value and nothing can change it now. Seats are
  stored per game in `GameSettings.practiceSeats`, a sibling of the legacy `practiceBots`/
  `practiceDummies` (left in the blob, no longer read, so older clients keep theirs). Applies in Solo
  practice AND Free drive; the spawn is `practiceSetups` in `settings.ts`, DOM-free so `npm test`
  holds it. A run with other robots gets a "With robots" badge in Practice replays
  (`PracticeRunMeta.others`) — practice runs are never ranked anyway.
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

### Screens with their own step rail, and things you drag

- **LB/RB step through `[data-padnav-sections]` when a screen names one** (`sectionStep` in
  `PadNavLayer.tsx`). Without it, LB/RB step through the list that holds focus, and from a
  control in a body that list is the PAGE rail, so RB on the importer's Model step left for
  Records. The importer's `nav.ds-tabs` is the first user; a wizard or tabbed editor that adds
  one gets the same behaviour from any control on the screen.
- **A draggable thing on a 2D map is a real `<button>`** laid over the drawing by percent, so
  keyboard, screen reader and pad reach it as an ordinary control. Keyboard: arrows move a
  fixed step (Shift a finer one), Home puts it back, each press commits. Pad: A GRABS it
  (`suspendPadNav('handle')`, the layer stops reading the stick and D-pad), the D-pad steps on
  `PAD_SLIDER_REPEAT`, the stick moves at a rate, A drops, B restores the pre-grab position,
  and the status line under the map names the buttons in `PAD_GLYPHS`. Pointer: the drawing
  follows the drag and the move commits on release. `src/robotImport/ui/useHandleGrab.ts` +
  `TopDownMap.tsx` are the reference; `scripts/importpad.cjs` proves all three inputs.
- ⚠️ **Several key presses can land inside one React render.** A handler that computes "move
  from the current position" off a prop reads the SAME stale prop for each, and two presses
  move once. Keep the last emitted position in a ref until the props catch up (`moved` in
  `TopDownMap.tsx`).
- **A pad walkthrough needs a window that paints.** `requestAnimationFrame` does not run in a
  hidden browser tab, and the layer polls the pad on rAF, so a stubbed gamepad in a background
  tab does nothing at all. `scripts/importpad.cjs` stubs `navigator.getGamepads` in an
  OFFSCREEN Electron window, which keeps painting; copy it for a new screen.

## THE MENU STAGE — Home and Play over the field (owner, 2026-10-18, after MoSim's home)

The owner asked for DSIM's front door to look like MoSim's, and answered every layout question; the
rulings below are theirs, not defaults.

- **ONE stage behind both screens** (`src/ui/MenuStage.tsx`, mounted by `App` while `screen` is `home`
  or `modes`). Going Home → Play is a change of `view`, not a remount, which is what lets the camera
  FLY (`FLY_MS`, `--ds-dur-fly`: 1 s ease-in-out, instant under reduced motion; Back flies it back).
- **The selected game's field.** BIOBUZZ: the match's own 3D scene (`createBiobuzzScene`, lazy,
  `interactive: false`), drawn through `SceneFrame.pose` ON DEMAND (while the camera moves, once more
  50 ms after a move ends, and once when `assetsSettled` resolves for EVERY world it builds: 2026-11-02, it was only the boot's, so an import picked on Play stayed on its outline until another robot was picked and back), not every frame.
  DECODE and Chain Reaction, and BIOBUZZ when the device's view pref is 2D, it is a coarse-pointer
  phone, or the scene fails: the game's own 2D `drawField`/`drawBalls`, drawn once and shown FLAT.
  The scene took 1.3 s (fast line) to 8 s (Slow 4G) to appear, on a dark empty backdrop. On the first
  load the boot screen waits for it (`holdBoot`, capped); otherwise, and past the cap, a loading bar
  stands where the field will be (`StageWait`, after 600 ms). ⚠️ **NOT THE 2D FIELD UNDER IT**: tried
  the same day, it was a second picture of the field that the 3D replaced a second later (owner: "the 2d
  field for a split second before switching to 3d"). The 3D fades in at `--ds-dur-screen`. ⚠️ **THE
  PLAYER'S ROBOT IS ON THE 3D FIELD ON HOME TOO**, at Play's showcase spot (owner, 2026-11-03: "so that it
  doesn't just suddenly appear and disappear"): it used to join when the fly to Play began and leave
  when the camera was back at Home, so it popped in and out. The 2D stage's robot is still Play's page.
- **The stage's world is never stepped, so the game rests it** (`GameModule.restMenuWorld`, 2026-11-03):
  BIOBUZZ moves its hive NECTAR and flower POLLEN to where a match's physics leaves them, baked from a
  real settle of the stage's `STAGE_SEED` world (`docs/area/biobuzz.md`, THE MENU STAGE'S HIVES AND
  FLOWERS). A new `STAGE_SEED` needs that table regenerated; the STAGE smoke lane fails until it is.
- ⚠️ **THE 3D STAGE DRAWS AT THE PLAYER'S GRAPHICS** (owner, 2026-11-04: "the home/play menu's render
  should match the graphics selected by the user"): their tier, room, shadows, AA, element detail,
  render scale and the device's full pixel ratio, following a change to them. It REVERSES the
  2026-11-01 ruling (Home "still distorted and EXTREMELY laggy on some devices"), under which the stage
  drew Medium in the procedural `arena` at 1.5 dpr whatever the player chose. The distortion was the
  photographed venues, retired the same day (`docs/area/biobuzz.md`, NO PHOTOGRAPH IS PROJECTED ONTO
  GEOMETRY); the cost comes back with a High-or-up pick: the first load and every fly frame pay the
  match's cost. What stayed: the scene draws on demand and boots on idle, shows no perf overlay
  (non-interactive), and `SceneOptions.tunesTier: false` lets Auto measure menu frames without
  stepping the stored tier. A first visit runs Auto's GPU guess on Home, as the first match used to.
- **Home** (`HomeMenu.tsx`): no app-bar fill or mark (the bar keeps only its right-hand cluster:
  profile, Admin, online chip), ONE LEFT COLUMN on a left-to-right scrim — wordmark, sponsor, game
  switcher, the keycaps, the labelled
  social pills, the stats — and the normal footer. Text drawn ON the scrim is category 3 (on-field
  tokens, the sponsor's light-ink cut); the keycaps, pills, switcher and cards keep their themed fills.
  ⚠️ Do not put a colour on `.ds-home` itself: it leaked into the white tutorial card in light theme.
- **Play** (`ModeSelect.tsx`) keeps the app bar (its fill slides down during the fly, a `::before`
  moved by `transform`), the ad strip, no footer, no friends panel. The robot's free area
  (`.ds-setup-view`) is the 3D ORBIT's drag surface (`stageOrbit`; it eases back on release) — the stage
  is behind the shell, so the page owns the pointer — and on a 2D stage the page draws the 2D preview
  there itself (`useStageMode`). Bottom-left: `RobotStrip` (`Menu.tsx`), ONE scrolling row (a plain wheel scrolls it sideways, owner 2026-10-24) of
  `RobotCard`s — the kept unsaved edit, the kept preset build, saved robots, imports. Picking the card
  that is ALREADY on opens the builder (an import's opens the importer). Header: **New robot, Edit,
  Import**. Every gate the old tiles had is kept.
- ⚠️ **THE GARAGE RAIL: FROM 1000PX WIDE, IN A LANDSCAPE WINDOW, THE ROBOTS ARE A COLUMN ON THE LEFT**
  (owner, 2026-11-02, on an ultrawide: "the robot selectors are massive and the robot in the
  background is tiny"; picked from three layouts). Measured first: the camera's FOV is VERTICAL, so the
  robot's size follows the HEIGHT of `.ds-setup-view`, and the view was what the 204px picker row and
  the 106px banner strip left: 880px at 3440x1300 but 190-250 at 1280x610, 1366x657, 2000x670 and the
  owner's ~1700x590, beside 320px cards that each repeated the robot's picture. Now `[rail | robot |
  modes]` (`--play-rail` clamp 300..340, `--play-side` clamp 344..420, shared with the 2D stage, which
  centres under the same space): the view is the page's full height (470 at 2000x670, 457 at 1366x657,
  410 at 1280x610). The rail is as tall as its cards, never past the page, and scrolls vertically.
  Wherever the picker is a column (the rail; a portrait window's, beside the modes) a card is COMPACT:
  a 64px picture, the name, the team, and the build as ONE text line ("Mecanum · Single turret center",
  ending in an ellipsis), with the three actions sharing a row under the title. Under 1000px (the robot
  would be a slit between two columns) and on a phone, the row layout is unchanged. `SETUP_FRAME_MAX_H`
  (840) caps the box the camera frames, so a tall window (3440x1300) does not blow the robot up beside
  fixed-size panels.
  **ONE INSET IN THE RAIL, 16, like the modes card** (measured with `scratch`-style DOM probes, owner
  2026-11-02: "make sure padding is correct"): the head's padding, the first card under the head's
  line, the list's sides and foot. The horizontal strip's track room had left 20 / 13, and a thin
  scrollbar took the right inset to 27 while the list scrolled, so the vertical list has NO BAR (the
  wheel scrolls a column natively; the fades say there is more). The title is a 32px row like a modes
  group's head, so "Robot" and "Solo" stand on one line. ⚠️ **THE RAIL IS HEIGHT-BOUND**: the actions
  share the title's row where they fit (a 340px rail) and wrap under it only on a narrower one; the
  second row put the third card out of view at 2000x670. The columns' caps are a 1080p window's
  (`--play-rail` 380, `--play-side` 460; owner, 2026-11-02: "slightly too small" there at 340 / 420), and
  from 860px tall the modes' tiles are 56px and the rail's pictures 72px. Two steps DOWN on a laptop's
  short window (2026-11-03; 1366x657, 1280x610 and 1700x590 showed two cards and a cut third with the
  tutorial offer up, three now): under 760px tall a card drops its team line and its picture is 48px;
  under 640 the head is one 32px row of the actions, its title `.ds-sr`-style. The banner strip under Play
  is the compact 72px frame on a window 820px tall or less (`BannerStrip fitted`, `docs/area/
  monetization.md`). ⚠️ **AN IMPORT DISABLES SOLO RECORD, RANKED AND DUO RECORD** (owner, same day):
  they start no import (`robot-import.md`), and used to start the last standard robot under a "Uses your
  last standard robot" note. ⚠️ **ON PLAY, VIEW HEIGHT IS THE CRITERION**
  (owner, 2026-11-02): responsive layout elsewhere follows width as usual, but here the camera's FOV is
  vertical and the rail stacks its cards, so Play's budgets and breakpoints read the window's height.
  Name the binding constraint from measurements before choosing one.
- ⚠️ **NEW ROBOT IS A BUTTON, AND THE STRIP HOLDS NO PRESETS** (owner, 2026-11-01: "i should NOT have
  to scroll an extreme amount in thr play menu to get to 'new robot'"). It was the strip's LAST card,
  after saved robots, imports and every preset: 1,464 px of sideways scroll at 1366x657 on first
  launch, 7,108 px for Chain Reaction with ten imports (measured by a user-perspective audit). As the
  first card it pushed the robot being driven off a phone's panel, so it is in the panel head
  (`startNewRobot`: the first preset's build under the player's name, then the builder). The presets
  are the builder's Start from. **Edit** says what a second click on the card that is on does.
- ⚠️ **A PICK NEVER MOVES THE ROW OR LOSES A BUILD** (same audit): the build on was a card only while
  it was on, so picking a saved robot removed it, the row slid 332 px left under the cursor, and an
  unsaved build was gone. Two per-game slots for the page load (`keptEdits`, `keptPresets` in
  `Menu.tsx`) hold the last unsaved edit (an "Unsaved" badge) and the last preset build driven, each
  in a fixed place; a slot empties only when its build is saved. Which card is on is the build object
  itself, because the presets' own match and the cards' `sameRobot` disagree on the default robot.
  ⚠️ **EVERY CARD THAT IS NOT A SAVED ROBOT OR AN IMPORT SAYS WHAT IT IS** (owner, 2026-11-04: Play listed
  four robots beside the builder's "Your robots 3/3"). The kept PRESET build had no badge, so after New
  robot it read as a fourth saved robot: it says "Preset" now and the kept edit says "Unsaved", a word
  for a build the player made and never saved. The strip is the builder's two lists
  (`settings.savedRobots`, this device's library) plus those slots, and the 3/3 cap counts only the saved
  list. **DELETING A SAVED ROBOT REMOVES IT FROM PLAY** (`removeSavedRobot`, `src/ui/savedRobots.ts`): when
  it was the robot being driven, the next saved robot (the one that took its place, else the last) is
  driven instead, else the default preset's build under a fresh player's name; and no copy of it stays in
  the kept slots. It used to drive on with the deleted build, which Play then listed as an "Unsaved" card.
  **EDIT DETAILS IS ON THE CARD**: a saved robot's and an import's card carries a ✎ (`ds-opt-edit`, the
  delete's twin, beside the ✕ in the builder's lists) that opens ONE dialog (`IdentityDialog`,
  `robotImport/ui/LibraryDialogs.tsx`, lazy) for the robot name, team name and team number, with the
  limits `coerceSpec` has (`src/robotImport/identity.ts`: 24 / 48 / 0-99999, an empty name refused).
  A saved robot's edit writes `settings.savedRobots[i]` (and `settings.spec` when it is the one on, so the
  card stays on); an import's writes the device library (`updateIdentity`) and the active spec when it is
  active, which is what the account syncs. The dialog is a portal on Play, whose panel is a floating surface.
- ⚠️ **PLAY'S RIGHT COLUMN IS EVERY MODE, ONE CLICK AWAY** (owner, 2026-11-01: "VERY, VERY awkward to
  navigate the tiny panel on the play page. The current main's navigation is 1000% easier"). ONE card
  (`.ds-play-modes`), two labelled groups the way main's "Pick a mode" page lays them out: **Solo**
  (Solo practice, Free drive, Solo record, a Match setup button; the one-line summary under them, "Red
  alliance · 2 other robots", is GONE: owner, 2026-11-02, "I dont know why this is here") and
  **Multiplayer** (Ranked, Duo record, New room, Browse rooms, Competitions, LAN), two
  tiles across (`.ds-play-tiles`; an odd count gives the first tile the whole row). It used to be
  Match setup and Practice setup scrolling in a 420px column with Solo and Multiplayer pinned under
  them, each REPLACING the column with its list and a Back: two clicks and a scroll to any mode, in a
  column that showed a card and a half at 1366x768. The setup cards are the Solo setup popup (above).
  One card, not one per group: the second head and padding scrolled the column at a 1366x768 laptop's
  657px viewport.
- **The camera frames what the page leaves free**: `insetsFor` reads `.ds-setup-view` (Play) and the
  column's right edge (Home) off the DOM and hands them to the scene as `insets`. Poses are the
  hand-tuned `POSES`/`SHOW` constants in `menuStagePoses.ts` (DOM-free, so the BIOBUZZ RENDER lane
  reads them); the showcase spot is on open floor, clear of the hive's legs.
- **HOME'S HIGH SHOT** (150 in up) smeared every photographed venue, even drawn as relief; that is
  one of the reasons they were retired (2026-11-04). The RENDER lane sweeps both stage eyes with the
  match's (`sweepMatchEyes`), so a venue that blocks or smears from there fails like one that does
  in a match.
- ⚠️ **A PHONE'S HOME IS NOT ON THE STAGE, AND IT FITS AN iPHONE SE IN SAFARI WITH NO SCROLL**
  (owner, 2026-10-18: "restore that page … to the original one", alpha's; then "fit without needing
  to scroll for any phone"). Below 720px `App.tsx` mounts no `MenuStage` for Home and passes no
  `stage`: it is the normal shell (`.ds-app.is-home`) and `HomeMenu stage={false}` renders alpha's
  order, compacted by `.ds-app.is-home …` rules in the phone block:
  - no footer (`> .ds-foot` hidden); a "More" link opens a bottom sheet (`MoreSheet`, `useDialog`)
    with the stats breakdown and the SAME footer contents (`FootBody` from AppShell, via
    `FootContext`). So the sponsor's footer credit and the consent link are never copied.
  - labels-only keycaps (`.mh` hidden; Play keeps its queue count), the switcher on one row of
    three equal segments, and the social pills as three equal icon + name pills on one row (owner:
    "full text instead of icons"; `--ds-t-md`, which is what fits "Instagram" at 360).
  - the stats as one line ("N players · N games played") on ONE BASELINE (`align-items: baseline`,
    tight line-heights; the tiles had been centred on each other, owner: "on the same row"), no bar queue line (it ran the profile
    button 2px off a 390 screen), and the column centred in the height left.

  Measured `scroll 0` at 375x550, 360x640, 390x664, 360x740, 414x736 and 390x844, all three games,
  both themes; the column ends at 499px. A smaller or sideways phone may scroll (owner's call).
  **The base `.ds-home*` / `.ds-homestats*` / `.ds-menu` / `.ds-menu-btn` rules are alpha's
  verbatim**; the desktop look is `.ds-app.stage-home …` overrides and the phone look
  `.ds-app.is-home …` overrides, so neither reaches the other. Scope any new Home rule the same way.
  ⚠️ **A `.ds-app.stage-home` override out-weighs the shared `.ds-seg.on`**, so every state it restyles needs
  its own `.on` twin. The switcher's unpicked fill (`--ds-panel`) won over the picked chip's accent, and
  the accent-ink label vanished into it (white on white in light, dark on dark in dark) until
  `.ds-app.stage-home .ds-home-games .ds-seg.on` set its own `background`.
- ⚠️ **THE TUTORIAL OFFER AND THE REJOIN BANNER ARE ON PLAY**, desktop and phone (owner,
  2026-10-18), as `.ds-setup-notice`, opaque, with the floating edge. It is a SIBLING of
  `.ds-setup-view` (2026-11-02), placed against `.ds-setup`: in the garage rail it HEADS the rail
  (`.ds-setup.has-notice` adds the row), and everywhere else it floats at the top-left of the robot's
  space as before. There the view gets `.has-notice` and a left padding the width of the stack, so
  the 2D robot (sized off the content box) and the 3D camera (`insetsFor` reads the content box)
  stand BESIDE the cards. On a phone they span the robot band, over the robot (the owner's choice).
- Phone Play keeps its stage: the robot in a top 42dvh band, Modes | Robot toggle buttons under
  it (Modes first; the page scrolls on Modes), no per-game queue line and no "· N signed in" in the bar (≤ 440px), and
  no scroll track (a narrow desktop window carried Home's track into Play and overflowed it by 10px
  at 360x740).
  ⚠️ **The band is CLAMPED so a short phone's Robot tab fits** (2026-10-24): `height: clamp(120px,
  100dvh - 370px - var(--ds-bar-h), 42dvh - bar - 16px)`. 370 is everything else on the Robot tab but
  the bar (tabs 36, picker 214, the 72px banner strip, the gaps; 438 with the pinned Solo / Multiplayer
  buttons, gone 2026-11-01); the bar is 103px since it holds the sections' row (2026-11-01). Without it
  the strip alone pushed 360x640 Play 51px past the window; measured after the row, 360x640 fits to
  the pixel. Change the picker's or the strip's height and that number moves with it.
- ⚠️ **EVERY WINDOW SHAPE IS COMPOSED, NOT ONLY FITTED** (owner, 2026-11-01: "Aesthetics matter. Do the
  placements MAKE SENSE AND LOOK GOOD? For ALL dimensions, even ultrawide or super thin?"). Swept
  offscreen at 24 shapes (5120x1440 and 3440x1440 down to a 280px folding phone, landscape phones,
  portrait tablets) over Home, Play, Solo setup, Configure, Controls, Records and DECODE's 2D stage
  (`scratch/aesthetic/` in the alpha-ux worktree has the sweep). What it changed:
  - **A 2560px BAND** (`--ds-wide-max`): past it the bar's items, Play, the shell's body, the footer
    and Home's column (`--home-inset`) keep to a centred band, and the 3D field frames inside it
    (`insetsFor`'s right inset); only the stage stays full-bleed. At 3440 and 5120 the robot panel
    ran 1,800-4,600px wide for one card and the bar's sections were 2,000px from their page.
  - **THE ROBOT PANEL IS AS WIDE AS ITS CARDS, CENTRED UNDER THE ROBOT** (721-999px landscape since
    2026-11-02; wider is the garage rail): full width it was one card at the left of a 900-1,800px
    panel, unrelated to the robot above.
  - **A PORTRAIT WINDOW (721px+, taller than wide)** puts Home's column on top, centred, and the
    field below (its scrim is laid on the column, so it ends under it at any height; the 2D field
    sits at the window's foot), and gives Play a full-width robot band on top with the picker and
    the modes side by side under it. Beside the column the field had ~300px at 820x1180 and ran off
    the edge; beside the modes the 3D camera could only fill a 460x800 space with floor.
  - **THE STAGE'S FOV WIDENS FOR A TALL FREE AREA** (`fitFov`, `STAGE_MIN_ASPECT` 1.5): the poses'
    FOV is vertical and was set on landscape windows, so a narrow area cut the field and robot off.
  - **Play's settings column is never under 344px** (`max(38vw, 344px)`): at 311 "Browse rooms"
    wrapped. **A 280px phone** takes one tile a row and sizes the game switcher to its labels.
  - **The builder hero's Play button is its own grid cell** (`'view play stats'`), the card's full
    width on a phone-width card, where in the name's column it broke onto two lines.
- ⚠️ **BOTH SCREENS FIT THE WINDOW; THERE IS NO PAGE SCROLLBAR** (owner, 2026-10-18). Measured
  `scrollHeight - clientHeight` = 0 on Home and Play at 1920x1080, 1536x864, 1366x768, 1280x720,
  and on both at 390x844 and 360x740 (`scratch/stage.cjs` prints it per size); a phone's Home down
  to 375x550 (above). A landscape phone (844x390) scrolls. Home's bar is OUT OF FLOW and a window ≤ 820px tall takes a tighter column. `.ds-app.on-stage` is `overflow-y: auto`, not the shell's always-on `scroll`.
  ⚠️ **"TALL ENOUGH" IS A LAPTOP'S BROWSER VIEWPORT, NOT ITS SCREEN** (owner, 2026-11-01: "for some
  weird screen types, the entire homepage does NOT fit"). The tabs, address bar and taskbar take
  ~110px: a 1280x720 screen shows ~610 and a 1366x768 one 625..657. Home scrolled at every width under
  ~640 tall. So Home steps down twice more: ≤ 700px tall drops the stats breakdown, the column's
  padding to 16 and its gap to 8; ≤ 600 drops the keycaps' sub-lines. Play's floor is 400 (not 480)
  and its tiles a step tighter at ≤ 700. Swept 721..2560 wide x 540..900 tall plus three portrait
  tablets (`scratch`-style sweep, one offscreen window resized through 102 sizes): Home fits at all
  102; Play fits from 625 tall at every width and from 600 at 1024 wide and up. Under that the
  column scrolls on a thin track rather than cutting a tile off.
- **HOME'S STATS ARE ON SCREEN FROM THE FIRST FRAME** (owner, 2026-11-01: they "load AFTER the data is
  received from the server, so it shifts UI"). Home's column is centred, so a block that arrived a
  second in moved every keycap up by half its height. With a game server configured the tiles and the
  breakdown render at once, a dash for each number until `fetchGlobalStats` lands; a failed fetch keeps
  the dashes rather than removing the block, which would be the same shift the other way. Since
  2026-11-02 a returning device shows the counts it last saw (`HOME_STATS_KEY`) instead of dashes, with
  `aria-busy` on until the fetch answers; each number is keyed on its text, so only one that changed
  fades in (`.ds-arrive`). The fetch starts only after mount and waits on the router (one round trip
  warm, ~4 s when an idle one wakes). Still measured: a first visit on a PHONE re-centres its one-line
  stats when the dashes become numbers (layout-shift 0.0008); the desktop tiles do not move.
- **THE ADMIN LINK ON HOME is a plate like the two chips beside it** (owner, 2026-11-01: "genuinely
  very off"): it was the bar's outlined ghost button, an unfilled box with a pale edge over the scene,
  taller than the chips, whose hover fill (`--ds-panel`) was white under on-field white text in light
  theme. On `.stage-home` it takes the chips' `--ds-scrim-strong` plate, size and height.
- ⚠️ **THE PLAY LIST'S ENTRIES OPEN AS POPUPS OVER PLAY, ALL 520px** (owner, 2026-10-24: "instead of
  opening new pages, i want things to show up the way the New room screen shows up. use the same width
  for every popup"). Multiplayer reads Ranked (renamed from Find match), Duo record, New room, Browse
  rooms, Competitions, LAN. `POPUPS` in `App.tsx` lists the screens (`matchmaking`, `duorecord`,
  `lobby`, `rooms`, `competitions` without a `sub`, `lan`, `record`): each keeps its URL, so a reload or a
  link opens Play with it up, but it renders in ONE `.overlay.ds-popup-host` in the SHELL's tree with
  `ModeSelect` mounted under it. They used to be early returns, and an early return remounts the stage
  (the WebGL scene) and Play (its list state) on every open. `popupShell` (`PopupPanel`: `useDialog`,
  a close control LAST in the DOM so focus lands on the popup's own first control, Escape closes) is
  handed to `Matchmaking`, `Lobby`, `LanPanel` and `RecordRun` where `shell` used to be, and wraps
  `RoomBrowser` and `CompList` directly; closing is `navigate('modes')`, so Play's list is where it
  was. A state that was ALWAYS full-screen (a joined room, `MatchStrategy`) does not call it and fills
  the host, opaque, as the same component instance, so no socket drops. The shell's `FriendsProvider`
  reports `lobby` (`match` for Solo record) under one, which is why the separate presence heartbeat
  and ranked's own `AccountSync` mount are gone. Every `OverlayDialog` takes `.ds-popup` too, so New
  room and the start guards are the same width. Browse rooms' Host a room closes the popup before
  New room opens, so two scrims never stack.
  ⚠️ **NO SHELL BACKDROP OVER A POPUP.** The early returns used to keep the gates, the claim and notice
  dialogs and the announcements off a room by replacing `AppShell`; inside it, they would land on a
  joined room or the 20-second strategy window. So all of them wait while `popup` is set (`modalsWait`,
  the gates' `suspended`, Announcements unmounted) and show once the player is back on Play. Under a
  full-screen state `shell.css` sets the bar, the footer and Play to `visibility: hidden` so Tab cannot
  reach behind it. Ranked's **Match found** is `popupShell(body, true)`: no × and Escape does nothing,
  because the clocks are running and leaving only parks the seat for the takeover to pull back. A
  plain search closes and keeps searching in the queue bar.
- **ONE SPACING**: Home has one inset (`--ds-s-7`, the bar's too) EXCEPT the column's left, which is
  `--home-inset` = `max(48px, 7vw)` (owner, 2026-10-24: "all the homepage things are too left"; 90px
  at 1280, 134px at 1920). The scrim's solid stop, its width and the 2D field's free area all add it,
  and the 3D camera needs nothing (`insetsFor` reads the column off the DOM), and one gap between groups
  (`--ds-s-4`, `--ds-s-3` when short); no group carries a margin of its own.
  **Every group is CENTRED on the column's axis** (owner: "center this"), and the switcher, the pills
  and the two stat tiles stretch to the column's width, so it has one left and one right edge. The
  three-across rows (switcher, pills, stat tiles) share ONE gap (`--ds-s-2`) and EQUAL items
  (`flex: 1 1 0`), so the switcher's and the pills' edges line up; "Chain Reaction" fits a third
  only at the 8px inset given and never wraps.
- **The desktop scrim is SOLID behind the whole column** (to the inset + 444px) and only then fades,
  and the online chip has a `--ds-scrim-strong` plate: the BIOBUZZ warehouse is bright in places
  (`contrast.mjs` checks the pale text against its 99th-percentile wall). **The 2D field** is FLAT and
  top-down (2026-11-01; it was tilted in CSS, `rotateX(50deg) rotateZ(-30deg)`, which drew a flat map
  in perspective and read as distorted, and BIOBUZZ falls back to it): one size on both screens,
  `--stage2d-size`, the free area right of the column and between the bar's cluster (64) and the footer
  (48), 24px clear of each edge. Play moves it under the robot's space and dims it to 0.35. The fly
  animates `transform` and `opacity` only; it used to animate width and height, a layout per frame. Play uses 16px for the page edge, the gap between areas and
  the panel padding. `.ds-panel + .ds-panel`'s margin is zeroed in the setup column, whose flex gap
  owns it, so a 32px gap never appears.
- **A lost WebGL context drops the stage to its 2D field** (`webglcontextlost`), the way a match
  drops to 2D. Before this, the stage showed an empty backdrop.
- ⚠️ **THE 2D STAGE IS AN `<img>`, NOT A CANVAS IN THE PAGE.** The field is drawn once into a
  detached canvas and shown through `toBlob`. A canvas left in the page went BLANK after any window
  resize (pixels still readable in it, nothing on screen, a redraw did not bring it back; a fresh
  canvas or an image did) — measured offscreen 2026-10-18, and a phone rotating is a resize. The 3D
  stage draws once more 150ms after a resize settles, for the same reason. Never HIDE a mounted stage
  (`display: none`, `visibility: hidden`): a 3D scene that drew and was then hidden came back blank.
- **Every picker card carries its robot's picture**, presets included (owner: "I can't see the
  robot"). The 2D robot on Play is sized to the free area (`ResizeObserver`, 96..400px).
- **A first visit (nothing stored) opens on BIOBUZZ**, web and activity alike; `defaultSettings()`
  stays DECODE.

## The first load and screen changes (2026-11-02)

Owner: the first load was an old static page, then a black field, then missing counts; every
transition should feel smooth "but not with excessive or annoying animation". Measured cold, in an
offscreen Electron window, unthrottled and on Chrome's Slow 4G profile (`scratch/coldload/` in the
worktree that did it; frame sheets in HANDOFF's 2026-11-02 section).

- ⚠️ **THE BOOT SCREEN IS `#seo-home`, BESIDE `#root`, NOT IN IT.** It was the pre-stage centred
  menu inside `#root` (DECODE picked, links that reload the page), replaced by the real Home in one
  frame when React mounted: 0.3 s on a fast line, 7 s on Slow 4G (the 901 KB entry bundle). With JS on
  (`data-boot`, stamped by an inline script) it is now a loading screen: the mark, the sponsor line,
  a bar that shows after 600 ms. Its ground is the screen it hands over to: `stage` (the menu stage's
  colours, pinned to the tokens by `npm test`) or `shell` (themed `--ds-bg`), from the path and the
  phone breakpoint. React mounts under it and `dismissBoot` (`screenFade.ts`) fades it once the first
  screen has painted, and once a 3D stage has drawn its first frame (`holdBoot`; at most `HOLD_MAX_MS`
  3 s after mount, past which the stage shows its bar), so Home appears once, whole. The menu, game
  links and footer are hidden in that look, not removed: they are still what a crawler and a no-JS
  client get, and the sponsor line is a contracted placement.
- **A baked-closed build (the alpha) waits on the boot screen for its first access answer**
  (`main.tsx`, `GATE_WAIT_MS` 10 s), so a tester no longer sees "Alpha is closed · Checking your
  account…" on every cold load. An idle `dsim-alpha-primary` took 7.8 s to answer `/api/status`.
- **ONE SCREEN FADE, `--ds-dur-screen` (200 ms), entry only** (`docs/ui-standard.md` §7): a route's
  content (`AppShell`'s `page`, App's screen, or `modes` under a popup; not the sub-route), popups
  and dialogs (`.overlay`, `.ds-modal-backdrop`), the presence chip, the 2D stage picture, a match
  opening (a `--ds-stage-bg` cover lifts off `.game-shell`: a fade from opacity 0 showed the page's
  `--ds-bg`, white in light theme, between two dark screens), and the shell mounting again after a
  match (`.ds-arrive` on `.ds-app`, decided at mount by `bootDone`; never flipped onto a mounted
  element, which would start the fade on a screen already showing). The stage itself does not fade
  on return: its ground is there at once and its field fades in on its own.
- ⚠️ **THE FIRST PLAY CLICK** (owner, same day: "Extreme lag when clicking play for the first time").
  Profiled: every card on Play carries a BIOBUZZ 3D picture, made on first sight, and with no builder
  turntable to borrow the batch made a scene of its own at the PLAYER's tier. On Ultra that scene built
  a room environment map and drew with shadows: 640 ms of shader-compile waits (`getProgramInfoLog`),
  a 559 ms task and a 191 ms frame gap in the camera fly, on a fast desktop. Fixed at the cause: a card
  on Play (`onStage`) is drawn at `menuTier()` (Medium, Low on a Low device), never through the
  turntable; since 2026-11-04 the stage beside it draws at the player's own tier, so on High or up a
  card is plainer than the robot behind it; the cache keys on the tier, so the builder still draws its own at the
  device's. And the cards are drawn ahead, while Home is idle after the boot screen
  (`GameModule.warmCards`), so the click does none of it and no card swaps a schematic for a render
  under the cursor. After, same session: no task over 100 ms after the click even at 4x CPU, worst fly
  frame gap 58 ms (70 at 4x). What is left is the fly's own per-frame rendering.
- Not changed, measured: the 3D scene's build costs two long tasks (~690 and ~460 ms on this machine)
  right after the first load, under the boot screen now; the sponsor logo (two 30 KB PNGs) lands about
  a second after Home on Slow 4G, into its reserved box.

## Configure — the sections, and the three rules that hold them together

`src/ui/Configure.tsx` routes five keys at `/configure/<key>`. ⚠️ **ROBOT IS CONFIGURE'S FIRST SECTION** (owner, 2026-11-01: "The robot configure menu feels like it should be in configure"; it was a Play page without the sub-nav from 2026-10-13). It is in the sub-nav ("Build, save & import"), a bare `/configure` opens it, its trail is Configure's, and the importer's up is Configure. Home's Configure keycap reads "Robot, controls & settings". The builder also carries a way back in its hero, **Play with this robot** (`onPlay`), beside the bar's sections. **Save changes** updates the saved robot being edited (`editingSaved`, the slot last on, forgotten on another kind of pick), with **Save as new** beside it: Save used to add a copy every time, so with three saved an edit could not be saved at all. Leaving a match lands on **Play**, not Home (`exitGame`; a test drive and a competition match keep their own returns). Play still picks the robot (the strip) and opens the builder (Edit, New robot). **The ARRAY is the order on
screen; the KEYS are shipped URLs** (`audio` is Audio and Visual), so reordering must never
rename one. Order is task order — Robot, Controls, Audio and Visual, Graphics, Network:
build it, learn to drive it, set up the session, the two output sections, then the connection.
**Network** (`NetworkSection.tsx`) holds client prediction, which sat in a Controls fold until
2026-09-22 (owner: "Network prediction should NOT be part of controls") — it is how this machine
draws its own robot in a 3D-physics room, not a control, and not Graphics either.
It also holds "Show other players’ imported robots" (`importVisualsPref.ts`, the room relay's download): per
device, and every game has it — Graphics is hidden for a game with no 3D view, and the 2D picture is a
download too. **A sub-nav hint
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
  before it draws (~140 ms after, the floor being context + PMREM setup). A new picture on this
  page gets measured the same way.
  **2026-09-26, the rest of that floor** (`scratch/perf.cjs`, 5 runs, `GFX=` tier, `MBPS=`
  throttle): (1) `createEnvironment` built a room PMREM at construction (69 ms) that Low/Medium,
  lighting off, never used; it now builds nothing until `apply`. (2) The thumbnails draw through
  the live turntable (`capture(size, spec)`), not a second context. (3) `App.tsx` warms the scene
  chunk on idle via `preloadRoomView`. Long tasks: Medium 90–147 → ~62 ms, High 211–219 → ~105. The
  "prefetch bought nothing" finding was localhost, which has no network to hide: at 10 Mbit/s,
  click-to-ready goes 400 → 200 ms.
- **THE IDLE WARM COVERS MORE THAN THE CHUNK (BIOBUZZ 3D, 2026-10-24).** `preloadRoomView` also
  starts the 3D physics solve (solo practice has no lobby to do it) and calls the game's
  `warmScene` (`warmBiobuzz3d`, same `./scene/renderScene` specifier as `scene`): the post /
  surfaces / bay chunks its settings want, plus a low-priority fetch of the field glb (`/models`
  carries a day's `max-age` in `vercel.json`, so it fills the cache). The first draw's hitch now
  runs BEFORE it: `createBiobuzzScene` awaits `compileAsync` (capped 1 s) before resolving. Field glb / HDR module caches were NOT added (unmeasured).

**Configure copy.** No decorative glyph (the `🎯` on preset cards, the `＋` on the add cards and
the `✎` on Edit build are gone), no sentence whose content is where another screen is, and no
sub-line naming a KEY —
every control in this app is rebindable, so `L-stick/W-S: Fwd/Back` is a claim that goes stale
the moment somebody opens Controls. A blurb survives only where it names a trade-off the player
is choosing between (`docs/ui-standard.md` §8): the archetype and drivetrain descriptions, the
four `PERF_DISPLAY_BLURB` lines, an option's download size, and the R102 stow note.

**The fixed-shooter controls** (`src/ui/LauncherRows.tsx`): DECODE's Scoring block gains
Launcher (Turret / Fixed), Hood (Adjustable / Fixed + angle) and Flywheel (Auto / One speed /
Presets + speed, wheel and feed sliders, each with the exit speed it throws); BIOBUZZ's fixed
launcher shows its firing edge, hood and one speed. Every envelope is the coercer's constant.
The preset step (`flyPreset`) is a DECODE action on Z / R3 — the MODE TOGGLE role, shared with
BIOBUZZ's Deploy ramp — with a touch SPEED button only on a presets wheel. The HUD's sub-card
names a setpoint wheel's speed (and preset) and READY / SPIN UP.

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
  On the alpha the sign-in line adds that the playdsim.com account works there (one Neon Auth
  project), and a signed-in account that does not pass is told its tag (`access.username`, else
  its name) and to send it to the DSIM team; elsewhere it still reads "doesn’t have access".
- HUD mimics the FTC live scoring display: red|timer|blue bar at the BOTTOM.
- **THE PACE LINE** (`src/ui/pace/`, 2026-10-07; owner asked for a "+/- of what PB would be at
  the given time"): `+12 PB`, the FIRST CHIP in the row over the score bar (`.breakdown-row`,
  beside NECTAR LOCKED / CLASSIFIED / PARTICLES), in SOLO PRACTICE and RECORD runs only.
  Setting `GameSettings.pace` (Off · Your best · World record · Replay) in Audio and Visual beside
  the other read-outs; the replay is picked with **Use as pace** in the replay viewer
  (`paceReplays`, per game). A replay is an input log, so the reference's score-over-time is
  re-simulated ONCE in `paceWorker.ts` and stored per replay (`PACE_CURVES_KEY`); the live run is
  matched on the CLOCK `(phase, ticks left)`, never the tick, because practice starts AUTO on a
  keypress and records count a pre-match in the sim. Score is NET (`recordScore`). PB/WR are
  looked up again every match, so a new best is the pace from the next match on.
  ⚠️ **ONLY AN EXACT RE-RUN IS A PACE** (`replayFidelity === 'ok'`), stricter than the viewer:
  measured, a 723-point DECODE record from sim v2 re-ran as 40 on v5 and BIOBUZZ v3 records ran
  598 → 96. WR takes the first PLAYABLE run tied at the top; practice PB the best run on this sim.
  After a `SIM_VERSION` or `BALANCE_VERSION` bump every older PB/WR shows `—` until beaten — expected, not a bug.
  ⚠️ **A RECORD IS STAMPED WITH THE SERVER'S SIM** (2026-10-09, tester: "WR doesn't exist, record
  runs don't work, practice is fine"). The one Fly app runs main's sim, so while alpha's client is
  ahead EVERY record — set today included — is a drift here, and record pace was `—` everywhere.
  Two ways back in, both checked against the score the run is known by (`PaceTarget.expect`, its
  board/stats row): (1) a RECORD RUN RECORDS ITS OWN CURVE from the HUD while played
  (`useRecordedRunCurve`), stored under the replay's seed + length (`playedRef`; the client never
  learns the server's replay id) and found again from the fetched replay; (2) a drifted replay is
  re-run and accepted only if it lands EXACTLY on its score — a miss is cached (`Entry.miss`) so it
  is not re-simulated every match. On sim 5 DECODE's sim-4 records landed (719 → 719) and
  BIOBUZZ's did not (850 → 99); on sim 7 none land (DECODE 719 → 50, BIOBUZZ 889 → 173). So a
  record from before a sim change, set by someone else, is `—` until it is beaten on the new sim.
  The chip is rendered from the first frame of a paced match (`— WR` while it is worked out), so
  the row's height never changes mid-match. ⚠️ **A REFUSAL IS SAID ON THE CHIP**, not only in its
  tooltip: `WR · OLD VERSION`, `PB · SIGN IN`, `· NONE YET`, `· NOT PICKED`, `· UNAVAILABLE`
  (`PaceState.short`). `.hud` takes no pointer, so the tooltip never shows in a match, and a bare
  `—` read to a tester as "WR doesn't exist" (2026-10-09). GREEN ahead, RED behind (ink and edge, like `.warn`),
  plain `--ds-ink` level; on the opaque `--ds-hud` fill, not the row's soft one, because light
  theme's green ink is 4.08:1 on `--ds-hud-soft` (contrast-checked, both themes and the 3D scrim).
  ⚠️ **NOT IN THE SCORE BAR** (owner, 2026-10-08: in-panel versions "broke the clean, symmetrical
  scoring look"; then "make it another chip like how NECTAR LOCKED is, in that row, of the same
  style"). Under the total it made a BIOBUZZ panel four lines, beside it it pushed the total off
  centre, and a tab on the panel's edge was a third shape in the HUD. The row now wraps as whole
  chips at every size (it did only in the compact block): at 627px wide the extra chip made
  NECTAR LOCKED and PENDING break their own words onto two lines.
  ⚠️ **SOLO PRACTICE RECORDS ITS OWN CURVE WHILE IT IS PLAYED** (`GameController.paceRec`, stored
  with the run by `keepPracticeRun`). Re-simulating a BIOBUZZ run in the worker beside a live match
  took 70 s to 9 min here, and for all of it a new best could not be raced; smoke asserts the live
  curve equals the re-simulated one. While a NEW run's curve is still being made the tag reads `—`,
  never the previous run's curve under the new run's name (`usePace`'s `shownRun`).
- **No popup toasts over the field** — events go to the muted left-edge log; zone status lives
  in the top-right chips. ONE exception, owner 2026-10-12 ("allow notifications from people while in
  match"): friend toasts (`FriendToasts inMatch`, top-left, information only — no Accept on an invite,
  no profile link, because either would leave the match). The ranked search is a bottom-RIGHT
  pinned card (`QueueBar`, owner 2026-10-24; it was bottom-left), with the friend toasts stacked above it;
  closing Ranked while it searches parks the search there, it is not a page.
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
- **AN IMPORTED ROBOT IS DRAWN FROM ITS HULL, IN ALL THREE GAMES** (`src/render/drawImported.ts`,
  robot import 2026-10-01). Each game's sprite branches on `spec.imported`: the clip is the HULL (the
  collider), not the box; the body is the import's top-down PNG when this device has it, else the
  hull in the chassis fill with wheels at `importedWheels`; the outline stays the neutral trim and
  the alliance stays a FILL (DECODE/Chain chevron, BIOBUZZ's NECTAR rim). Over a PICTURE only STATE
  is drawn — the mouths' grab areas with a live/idle lip, the turret's aim (`drawAimMark`), held
  elements, the hopper bar, the place marker — never a second set of hardware; over a silhouette
  the game's own mechanisms are drawn where its accessors put them. ⚠️ **"Its accessors" means the
  SIM's import-aware ones, never the bounding box**: DECODE's mouth is `decodeImportMouth` /
  `decodeImportGrabRect` / `decodeImportSolids`, BIOBUZZ's `bbMouths`, `turretLocal`,
  `bbPlacePointLocal`, `bbDumperFrame`, Chain's `chainIntakeMouths`, `catalystOrigin`,
  `launcherFrame` (= `chainImportLaunchLine`); BIOBUZZ's held discs are searched on the hull. The
  shared smoke pins each drawn rect, ring and frame to its accessor. The deck arrow moves ahead of
  a turret ring rather than under it (`frontArrowSpot`, shared with 3D and `FootprintSvg`).
  - ⚠️ **ONE FRAME FOR THE PICTURE, AND IT IS THE IMPORTER'S** (`topImageFrame`,
    `docs/area/robot-import.md` "Frames"), re-exported by `src/render/importedAssets.ts`. Its map has
    determinant −1 in the robot frame on purpose: the camera's y-flip cancels it, and smoke checks
    the picture is not mirrored nose-up. Never re-derive it in a renderer.
  - **The pictures come from `importedAssets`**, a capped LRU over a source (the device library by a
    dynamic import, so main never carries IndexedDB code) plus blobs the editor or the relay lend.
    It owns its object URLs and revokes them on eviction — the one exception to "only `saveBlob`
    revokes". A canvas that draws once (the builder previews) subscribes with
    `useImportedAssetVersion`; the match redraws every frame and needs nothing.
  - **`FootprintSvg`** (`src/ui/`) is the import's SVG: cards and the hero when there is no
    thumbnail, and the Chain/BIOBUZZ builder previews (with the picture and the accessors' marks).
    Nose up through `ROBOT_FRAME`, on the field mat, category-3 tokens only.
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
  **Touch labels sit on the 11px floor** (`.mb-lbl` is `1em` of the button's 11px, 12px on SHOOT; it was
  `0.82em` = 9px, and an `em` is why the type audit never saw it). The one exception is CATALYST, eight
  capitals that touch the ring of a 64px circle at 11px, so `.mobile-btn.catalyst .mb-lbl` keeps 9px. In a
  short landscape phone the DRIVE / TURN label is inside the ring's top, not above it: above, it lay across
  the score stack's last tile. Still open (the pad's packer is the owner's): in PORTRAIT the sticks' rings
  cross the score bar and the breakdown chips, and the tutorial card sits over BIOBUZZ's second button column.
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
  drive`, `Room`). ALL CAPS is correct in exactly five places and they are all
  deliberate: `.overlay-buttons button` (13/13), the HUD chips (the FTC scoring display is
  uppercase), `ds-cta` (14/14), the admin console (29/34), and `.ds-panel-title` — mono,
  uppercased BY CSS, often an `<h2>`, so its source text stays sentence case.
- **One name per thing.** The rating is "rating", never "ELO", in anything a player reads (the
  system is Glicko-2). A player-made room is a **"room"** everywhere it is named (the setup option that starts from scratch is "Custom").
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
  permanent "{Season} tutorial" row with a Start button in Controls ▸ All games (`activeGame`), running the
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
  ⚠️ **It is `position: absolute`, so it needs a positioned ancestor INSIDE `.ds-app`.** The app
  scrolls in `.ds-app`; `html` and `body` are `overflow: hidden`. A `.ds-sr` with no
  positioned ancestor is placed against the page at its static spot, outside `.ds-app`'s clip,
  so one 1,500px down a long screen made the ROOT 660px taller than the window. Nothing shows
  until something scrolls the root — `scrollIntoView` does, overflow hidden or not, and every
  pad focus move calls it — and then the whole window is blank below the first screenful. A
  long screen's own wrapper takes `position: relative` (`.ds-import` does). Check with
  `document.documentElement.scrollHeight === innerHeight` on the screen scrolled to its end.
- **A LAZY screen's sheet lives in `src/ui/<name>.css` and is imported by the lazy module**
  (`importer.css` by `ImportEditor.tsx`), so Vite ships it with the chunk and `uiaudit` /
  `uiindex` still read it. Its own prefix is exempt from `ds-outside-shell` the way `.ds-tut*`
  is (`(?!tut|import)` in `uiaudit.mjs`); compounds of shared classes stay scoped under that
  prefix (`.ds-import .ds-facts dd.warn`). A class the MAIN chunk draws (the robot page's import
  thumbnail, the hero image) goes in `shell.css`.
- **`.ds-facts` is the one label/value list** (it was `.ds-auto-facts`, the autos panel's;
  the imported-robot panel and the importer's Model step use it too). A `dt`/`dd` grid, mono
  values; do not write a per-panel one.
- **A one-shot notice handed across screens is PEEKED while rendering and TAKEN in an effect**
  (`useRobotNotice`). StrictMode renders twice and throws one away; a `useState` initialiser
  that consumed the notice consumed it in the discarded render, and "Saved Ironclad." never
  showed.
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
  **A pair must be the one that RENDERS.** The Home primary keycap's sub-line was `color-mix(accent-ink 74%,
  transparent)` (4.40:1 in light) while `contrast.mjs` held solid `--ds-accent-ink` for it, so the audit
  passed for a colour nobody saw. When a rule mixes alpha into an ink, check the mixed result.
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
- ⚠️ **THE SECTIONS ARE IN THE BAR (2026-11-01; it was "THE SHELL HAS NO RAIL", 2026-10-10).** Play,
  Configure and Records (`AppShell`'s `BAR_NAV`, from `RAIL_ITEMS`) sit right-aligned in the bar
  before the cluster on every screen but Home, the one you are in latched (`--ds-accent-soft`, the
  rail's style; the trail's root names it). Owner: production's navigation was "1000% easier and more
  intuitive"; the owner left the call to analysis, and a user-perspective audit ranked the missing nav
  among the top causes: every move between sections went through the mark, Home and a 1 s camera
  fly. Production's 214px left rail was not brought back: it would cover Play's stage and stand
  beside Home's own column. Home has none (its keycaps are this menu): on the stage it fades with
  the bar's left side (`.stage-home .ds-bar > :not(.ds-bar-right)`), off it (a phone) it is not
  rendered. **The trail drops its root while the sections show it** (`AppShell`'s `trail`): "PLAY"
  twice in one bar said nothing twice, so Play's bar is "DSIM · BIOBUZZ" and Leaderboards' "DSIM ·
  BIOBUZZ  LEADERBOARDS", the latched section being the way up. ≤ 900px wide AND 501px+ tall the
  sections are the bar's SECOND ROW, at their own width, left-aligned (stretched to thirds they were
  330px slabs at 1024), and `.has-barnav` sets `--ds-bar-h` to 103px (63 + a gap + a 32px row), so
  what pins under the bar and Play's phone band follow; the band's clamp is `100dvh - 370px -
  var(--ds-bar-h)`. A landscape phone (≤ 500px tall) keeps one line and drops the season name, a row
  being a quarter of its window. One line needs ~900px with a signed-in cluster and the longest
  trail; with Admin the trail ellipsizes its last ~70px. Profile stays the avatar's menu. Home is still the
  hub for the game switcher. Every other shell screen also
  shows a BREADCRUMB TRAIL after the season name (`AppShell`'s `crumbs`; Admin is a bar link). **There is no Back button, because one that only exists off Home moves the DSIM mark ~80px between Home and every other screen** (owner, 2026-10-11): nothing left of the trail depends on the screen, so the mark, the season, the bar height and the right-hand cluster are pixel-identical everywhere (measured on six screens at 1366 and 390). `src/ui/crumbs.ts` is the ONE table of trails and of "up" (`parentOf`: the second-to-last crumb), so what the bar shows and where up goes cannot drift. Parents are links, the last crumb is `aria-current` text, a phone shows the last two. A public profile's up is Records (it was Home). **Ranked, Duo record, Room entry, LAN and Solo record are popups over Play** (2026-10-24, THE MENU STAGE above; shell pages from 2026-10-13): `App`'s `popupShell(body)` is handed to `Matchmaking`, `Lobby`, `LanPanel` and `RecordRun`, which wrap only their pre-connection states in it (title + panels, `ConsoleHead` with no `onBack`), and the bar shows Play's trail under one. A joined room, `MatchStrategy`, the game and replays stay full-screen and keep their Back: it leaves a live socket. Leaving a shell page by the trail skips `onCancel`, so App resets the lobby hand-over state when `screen` leaves `lobby`. Play is the robot setup over the menu stage (2026-10-18, THE MENU STAGE above): its Solo list is Solo practice, Free drive, Solo record, and its Multiplayer list holds Duo record (a two-driver run). ⚠️ **NO
  PER-SCREEN COLOUR** (owner, 2026-10-10: "let's not do color coding"): a per-section hue and
  full-width colour tiles were built and dropped; the one accent stays mint and the buttons are the
  keycaps and cards they were. **`BannerStrip`** (NOT on Home; it is the `banner` ad unit, env `VITE_ADSENSE_SLOT_BANNER`) sits at the BOTTOM, just above the footer, on every
  shell screen and RESERVES its height: the `banner` ad unit (728x90, 320x50 under 760px) when ads can
  run, the sponsor's banner (`SponsorStripMark`, placement `strip`) when there is no ad or AdSense
  answers `unfilled`, nothing once both are gone. Both fill the SAME `.ds-adframe` (728x90, 320x50 under 760px, a hairline outline, a 14px label above: “Advertisement” for the unit, “Sponsored” for the placement), so swapping them moves nothing; under 520px tall the strip is hidden. **FRIENDS IS AN OVERLAY (owner, 2026-10-10: it must not push the page).** The toggle card stays in the layout; opening it shows `.ds-friends-overlay`, a `position: fixed` sheet from the right edge under the app bar (full height in a room, which has no bar) with a transparent `.fr-scrim` behind it. Escape or a click outside closes it. It always starts closed: the stored open state (`decodesim.friendsPanelOpen`) and the squeeze media query are gone. At ≤900px `.ds-body` wraps so the toggle takes the first line and the content its own (`.ds-body > .ds-main`); at ≤640px the toggle is icon-only, its label visually hidden but still read. The
  profile hero is a CONTAINER query (`@container hero (max-width: 439px)`): picture + name on top,
  stats three across below.
- **RECORDS IS A HUB AND THE PAGES BEHIND IT (2026-10-10).** `/records` is `RecordsHub` (a player search, a
  link to every page, and a FEED of new No.1s and top-3 scores over Today / This week / This month / This
  season); `/records/<key>` is one page. **The pages are a registry**, `RECORDS_PAGES` in `recordsPages.ts`
  (DOM-free, so the router and `npm test` read it): adding a page is ONE entry there plus one component in
  `Records.tsx`'s `PAGES` (three now: Leaderboards, My records, Achievements: every badge, earned or dimmed, from `BADGE_EARN`, plus the awards; there is no Players page, the hub's search is how you find a player), which is typed `Record<RecordsPageKey, …>` so a missing component fails the
  typecheck, and the hub's link cards, the URL and the routing all follow. No tab strip: the trail in the app bar (`Records › Achievements`) is how you go up to the hub, and the hub is a top-level screen (up is Home). `/leaderboard`, `/stats` and `/records/career` still resolve.
  **`?mock=1` on a DEV build** fills the feed from `recordsFeedMock.ts` so the page can be reviewed with no
  server (read once at load; a production bundle drops it).
- **BROWSE ROOMS: ONE CONTROL PER ROW, TWO BUTTONS TO HOST, ONE BOX FOR A CODE (2026-11-04, owner playtest).** A row is a single button: **Join →** while a seat is free, **Spectate →** when the room is full or in its match (the row names which). There is no Watch button. The header's **Private room** and **Public room** buttons open the create dialog already on that visibility (Public is disabled signed out), so the dialog is titled "Private room" / "Public room" and carries no New room / Have a code toggle: **Join with a code** (a code box, plus a region picker where there is more than one server) on Browse rooms is where a code is typed to take a seat in an ordinary room. A typed code names no kind, so it is joined as an ordinary room and, when the server answers "different game mode", goes again on the Duo record screen (`retriesAsRecord`, `onRecordCode`); that screen's own entry still has **New room | Have a code**, because a record partner has no browser to go to. ⚠️ **SPECTATING IS A SOCKET, NOT A ROSTER FLAG.** `Lobby` attaches a spectator (`LobbyClient.spectate`) when the join is refused with `room_full` (new code, same sentence) or `in_progress`, and "Spectate" in **Your alliance** drops the seat and re-attaches the same way (RED / BLUE take one again; the host cannot spectate, and a Discord activity keeps its wait-and-retry). A spectator's match hands off through `onWatchStart`. `WatchLobby` and its screen are deleted. With **Drivers pick a side**, the host has no Move buttons for drivers (bots keep theirs) and `Room.moveMember` refuses a human; **Host places drivers** is unchanged; a side with every seat taken cannot shrink (the "−" is off, with the reason), as the server refuses it. The decisions are `src/ui/lobbyRules.ts`, DOM-free so `npm test` drives them ("rooms:", "spectate:", "move lock:", "shrink:" in the room-screens block of `scripts/smoke.ts`).
- **THE RANKED SCREEN OPENS ON YOUR STANDING** (`RankedStanding`, above the 1v1/2v2 pick): the rating for the picked format, its rank, the games it is over and the overall W–L, from the one `fetchUserStats` read, in a box that is RESERVED while the read is in flight and stays empty on failure.
- ⚠️ **THE RESULTS SCREEN MUST NOT SCROLL (2026-10-10).** `.resx-stage` is `100dvh` and was measured with a real
  solo match at six sizes: 1920x1080, 1366x768, 1280x720 fit, and 1024x600, 844x390, 390x844 scrolled by 63,
  320 and 244px. A short or narrow window (`max-height: 640px`, `max-width: 720px`) now lays the SOLO breakdown
  out in two columns, shrinks the edge inset, and a stacked half is a `22vh` floor, not a `40vh` share; the
  first five now fit; the short-window rule also drops the eyebrow and sets the breakdown at 2.2u (it needs `.resx-body` in front of `.resx-breakdown`, whose base block sits LATER in the file), which brought **844x390 to fit** (435px to 390). The **VERSUS board is measured too**, with a BIOBUZZ solo match and an AI opponent (the one way to get both alliances onto it without a second driver): it scrolled by 241px at 844x390 and 141px at 390x844, and now fits all six sizes by splitting its value | label | value table into two columns, narrowing the halves to 24% on a short window and letting stacked halves size to their content (a `min-height` floor let the big total spill over the table). 
  The results ad
  (`ResultsAd`, a 300x250 in the one column) cost ~264px and scrolled even a 1080p stage, so it mounts only
  at `min-height: 1180px`; that is inventory traded for the no-scroll rule, and moving it into the alliance
  panel's empty middle is the way to win it back. To re-measure: `scratch/shot-results.cjs` style drive
  (start Solo practice, press Enter, wait for `.resx-stage`, compare `scrollHeight` to `clientHeight`).
- ⚠️ **Breakpoints are literals, repeated across CSS and TS** (18-10: no shared module yet).
  `FriendsPanel.tsx`'s `SQUEEZE` query (`(max-width: 1099px) and (min-width: 901px)`) must
  match `shell.css` by hand — change one, grep for the other.
- **A PRESS ON A FRIENDS-PANEL ROW OPENS A PROFILE PREVIEW, NOT THE PROFILE** (owner, 2026-11-04: "add
  profile previews on press for friendslist"). `FriendPreview.tsx`: avatar monogram, name and badges,
  the presence line (friends only), 1v1 and 2v2 rating and rank, ranked W–L, playtime, and View profile.
  It reads the profile page's own `fetchUserStatsByUsername` for the viewer's game (`friends.game`), so
  there is no endpoint of its own. `PersonRow`'s `onPreview` wins over `onOpenProfile`; `UserSearchBar`'s
  rows still navigate. In a room (`allowProfileNavigation` false) the preview opens but has no profile link.
  - **Beside the sheet from 721px, a bottom sheet at 720px and under** (`--fr-pv-top`/`--fr-pv-right` are
    measured off the row and the sheet and ignored by the phone rule). It is a `useDialog`: focus goes to
    View profile, Tab stays in, Esc closes the preview ALONE (the sheet's `useEscape` yields to a consumed
    Escape), focus returns to the row. An outside press closes the preview only; the scrim's click that
    ends the same press is swallowed (`scrimSwallowAt`), so the second outside click closes the sheet.
  - **Every state is one height**: tiles show a dash while loading, on an error and for a player with no
    games, so the card never jumps when the numbers land.
  - ⚠️ Two traps, both measured: React re-renders BETWEEN the preview's document-level `pointerdown` and the
    scrim's own React `onPointerDown`, so the scrim cannot reset the swallow (it is a timestamp);
    and `autoFocus` loses to the previous row's card when switching rows (its `useDialog` cleanup
    runs after the new card mounts), so View profile is focused from an effect declared after `useDialog`.
