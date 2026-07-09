# HANDOFF — 2026-07-09 (swerve: 4-module kinematics, fast wobble, converge-at-rest, steering power) — READ FIRST

> **LATEST: GREEN, uncommitted on alpha.** `npm test` (334), `server:check`, `build` pass.
> Iterations on the 4-module swerve wobble (below), plus swerve STEERING POWER DRAW:
> - **Wobble is a FAST, IRREGULAR jitter** (`SWERVE_WOBBLE_FREQ` 8→30 rad/s, `SWERVE_WOBBLE_AMP`
>   ~0.15 rad — user-dialed). Each pod's error is a SUM of 3 incommensurate sinusoids at
>   per-module-varied frequencies (robot.ts), so it's non-periodic and every pod hunts on its own —
>   NOT a clean uniform sine (fixed a "too uniform" complaint). Pods buzz independently (~12°
>   spread), heading jitters ±~1° fast, path drifts ~0.3 in. Tunable knobs in the balance block.
> - **Bounded-model fix (important):** the wobble is now added by slewing each pod toward a
>   DISTURBED setpoint (`target + err`) rather than adding `err` after slewing — the old way
>   ACCUMULATED once `err` exceeded the per-tick slew step (that's why amp 0.18 blew up to a 20°
>   heading swing). Now it scales cleanly with AMP, no runaway.
> - **Pods slew to the last COMMANDED target** (`RobotState.moduleTargets[4]`, new; spawn/backfill
>   [0,0,0,0]): the drive command sets each pod's target (with flip); when the stick is released the
>   target is HELD, so `moduleAngles` keep slewing to it. A BRIEF TAP therefore finishes the turn
>   (3-tick tap → pods at -0.35 rad, release → they complete to exactly -90°) instead of freezing
>   partway or snapping to forward. Replaced the earlier circular-MEAN idle hold (which held the
>   pods' current position, not the commanded angle — that was the "faces forward when moving" bug).
>   Disturbance ∝ speed → 0 at rest, so pods still converge to exactly one aligned angle (spread 0.0)
>   and hold EXACTLY the last direction (-90° after a strafe, not -94°).
> - **Swerve steering power draw** (`POWER_DRAW_SWERVE` ~0.1, user-dialed): the pivot motors pull
>   steady current just running, on top of the flywheel/intake draws (`POWER_DRAW_MAX` raised
>   0.18→0.2) — so a swerve chassis is always a bit slower/weaker-shoving. Smoke checks it (swerve
>   powerDraw ≥ the constant, mecanum 0).
> - Smoke: reworked swerve block — pods hunt independently / drift / heading-yaw jitter / CONVERGE
>   at rest / steady steering power / per-module pod-flip. Tolerances widened for the wobble. (334)
>
> ---

# HANDOFF — 2026-07-09 (swerve = FOUR independent steered modules, proper kinematics)

> **LATEST: GREEN, uncommitted on alpha.** `npm test` (332), `server:check`, `build` pass.
> **Swerve is now modeled as 4 INDEPENDENT modules** (user: "properly model wheel swivel", not a
> single sideways drift). `RobotState.moduleAngle` (scalar) → **`moduleAngles: number[4]`** (FL,FR,
> BL,BR). robot.ts swerve block (the `vec` branch) does real per-module INVERSE kinematics (each
> pod's target vel = translation + ω×r), per-module pod-flip optimization + slew, an INDEPENDENT
> phase-offset control-loop error per module (`SWERVE_WOBBLE_AMP`/`_FREQ`), then FORWARD kinematics
> (`targetFwd=Σfx/4`, `targetStrafe=Σfy/4`, `targetOmega=Στorque/(4·Σ|r|²)`) → the ACHIEVED chassis
> motion. When perfect it recovers the command exactly; the independent pod errors make it DRIFT
> AND YAW-WOBBLE driving straight (headless: pods spread ~5.4°, ~0.87 in drift, ~2.0° heading
> wobble; mecanum = perfectly straight, heading fixed). `drawRobot` renders each of the 4 pods at
> its own `moduleAngles[i]` (they visibly swivel + wobble independently). backfill/spawn updated
> ([0,0,0,0]); snapshot round-trip covers the array. Deterministic (dsin, world.time+id+i).
> - Swerve keeps its STRENGTH (accel/push/speed/full-strafe); weakness = the wobble + reorient lag.
>   `SWERVE_WOBBLE_AMP` is the balance dial (raise for harder-to-drive swerve). X-drive = novelty.
> - Smoke: reworked the swerve block for the array — pods hunt independently, drift, heading-yaw
>   wobble, mecanum perfect line+heading, per-module pod-flip. (332 total.)
>
> ---

# HANDOFF — 2026-07-09 (swerve WOBBLE weakness + drivetrain niches)

> **LATEST: GREEN, uncommitted on alpha.** `npm test` (330), `server:check`, `build` pass.
> **Drivetrain BALANCE philosophy (agreed w/ user): distinct niches, not a strict hierarchy.**
> - **Swerve's weakness is WOBBLE, not weight.** A heavy-swerve nerf (mass floor 28 + lower
>   accel/push) was implemented then **REVERTED** on user direction. Instead: imperfect pivot
>   control — `SWERVE_WOBBLE_AMP` 0.05 rad / `SWERVE_WOBBLE_FREQ` 8 (robot.ts swerve block)
>   superimposes a small speed-scaled oscillation on `moduleAngle` (dsin, deterministic) so the
>   pods can't HOLD an exact angle → the drive direction + PATH wobble driving straight (headless:
>   ~0.6 in lateral drift; mecanum 0.00). Swerve keeps its STRENGTH (accel 1.3 / push 1.35 / speed
>   0.95 / full strafe restored); its cost is imprecision + pod reorient lag (`MODULE_SLEW_RATE`
>   10→7). Swerve mass floor is back to **23** (the earlier +1, not the reverted 28). The old crude
>   "heading jump" wobble code is deleted.
> - **Niches:** tank raw power/no-strafe · swerve strongest-but-imprecise · mecanum
>   light/instant/precise-but-weaker · **x-drive = deliberately-weak novelty** (user chose to keep
>   it weak rather than fake a niche or remove it). `SWERVE_WOBBLE_AMP` is the tuning knob if the
>   wobble should bite harder for balance.
> - Smoke: swerve floor 23, pod-reach tolerance widened for wobble, +2 (swerve wobbles at speed /
>   mecanum holds a perfect line). Removed the heavy-swerve niche checks.
>
> ---

# HANDOFF — 2026-07-09 (swerve steering pods + X-drive X visuals; WPILib-style module optimization)

> **LATEST: GREEN, uncommitted on alpha.** `npm test` (328), `server:check`, `build` pass. GUI-verified.
> - **Swerve modules now STEER — visually + in the sim.** New `RobotState.moduleAngle` (robot-frame
>   pod angle; spawn 0, backfilled in `unslimWorld` for old snapshots). robot.ts `updateRobot` (the
>   `saturation==='vec'` branch) steers the pods toward the commanded direction with **WPILib-style
>   MODULE OPTIMIZATION (pod flip)**: the target angle is set IMMEDIATELY, and if it's >90° from the
>   pods, they aim the OPPOSITE way and the drive motor REVERSES — pods never rotate >90°, a 180°
>   reversal is instant (no rotation, just flipped power). `MODULE_SLEW_RATE = 10` rad/s (≤~0.16 s
>   to re-aim). The drive follows the pods (they push where they point). Uses the dsin/dcos/datan2
>   discipline (determinism). Deterministic + serialized (snapshot round-trip covers it).
> - **Visuals** (`render/drawRobot.ts` + `ui/RobotPreview.tsx`): wheels now drawn per drivetrain
>   ON TOP of the chassis (RobotPreview previously hid them under it). SWERVE = 4 steering-pod
>   housings + wheels rotated to `moduleAngle` (in-game they turn live) + a direction tick. X-DRIVE =
>   4 omni wheels canted ±45° into a proper **X**. mecanum/tank = forward wheels. A light wheel
>   outline makes orientation read. All wheels use `r.moduleAngle` only for swerve (else 0).
> - **Swerve base weight +1 lb** (user): `DRIVETRAIN_LIMITS.swerve.minMass` 22→**23** (heaviest base
>   — 8 motors + modules); the `Cypher` swerve preset mass 22→23 to match. Smoke updated.
> - Smoke +5 (pod steer ≤90°, reach command, pod-flip stays put, reversal drives backward, mecanum
>   moduleAngle stays 0).
>
> ---

# HANDOFF — 2026-07-09 (drivetrain: 95% efficiency, higher tops, traction-limited accel)

> **LATEST: GREEN, uncommitted on alpha.** `npm test` (323), `server:check`, `build` pass.
> User feedback double-check: **efficiency ~95%, top speeds way higher, accels lower.** Applied:
> - `DRIVE_EFFICIENCY` 0.80 → **0.95** (real gearbox/bearing loss). Tops rise ~19%: @435rpm now
>   tank 88.6 / swerve 84.2 / mecanum 77.1 / xdrive 74.4 in/s (7.4/6.6 ft/s); on-field ~78/68 with
>   flywheel power-draw. DEFAULT mecanum bot ~73 → ~89 theoretical.
> - **Accel is now TRACTION-limited (μ·g), not motor-limited** — the MATRIX stall torque could give
>   ~460 in/s² but wheels slip first. `BASE_DRIVE_ACCEL` 280 → **240**; accelMults land each at μ·g:
>   tank 348 (μ0.9) / swerve 312 / mecanum 211 (μ0.55) / xdrive 175 (μ0.45). All LOWER than before
>   (was 406/322/230/224). mecanum accelMult 0.82→0.88, xdrive 0.80→0.73, swerve 1.15→1.30.
> - Smoke checks made constant-based (no magic 75/280): calibration uses `BASE_DRIVE_ACCEL` +
>   `SPEED_PER_RPM`; ref-speed band widened to a realistic 6–8 ft/s; formula check uses
>   `WHEEL_DIAMETER_MM`/`DRIVE_EFFICIENCY`.
>
> ---

# HANDOFF — 2026-07-09 (drivetrain grounded in real 104mm wheel + MATRIX 12VDC motor)

> **LATEST: GREEN, uncommitted on alpha.** `npm test` (323), `server:check`, `build` pass.
> Follow-ups to the real-motor retune (below):
> - **mecanum ≥ xdrive on forward** (user correction — mecanum is optimized for forward; X-drive's
>   omni wheels are the compromise). mecanum speed 0.85→**0.87**, xdrive 0.90→**0.84**. New order
>   speed tank>swerve>mecanum>xdrive; smoke check updated. @435: tank 74.6 / swerve 70.9 / mecanum
>   64.9 / xdrive 62.7.
> - **`SPEED_PER_RPM` now DERIVED from real hardware**: `WHEEL_DIAMETER_MM = 104` (goBILDA wheel)
>   free-speed geometry × `DRIVE_EFFICIENCY = 0.80` (a motor never reaches free speed under load) =
>   0.1714 in/s per wheel-rpm ≈ the old hand-tuned 75/435. Modeled motor = MATRIX / goBILDA
>   5000-series 12VDC (5800 rpm free, 20.45 oz-in stall) — its LINEAR torque–speed curve is the
>   motorStep model. Grounding only — magnitudes ~unchanged, so the mecanum balance holds. The
>   calibration smoke check is now FORMULA-based (no magic 75) + a 104mm-geometry check.
>
> ---

# HANDOFF — 2026-07-09 (real-motor drivetrain realism + one-block balancing)

> **LATEST: GREEN, uncommitted on alpha.** `npm test` (321, +7), `server:check`, `build` pass.
> Pure-sim change (deterministic); `BALANCE_VERSION` 1→2 (alpha only, physics never went to main,
> so the season reset is a non-issue per the user).
>
> **Drivetrains are now physically realistic + all balance knobs live in ONE place.**
> - **Real DC-motor torque–speed curve** (`motorStep` in `src/sim/drivetrain.ts`, used by
>   `robot.ts` for fwd/strafe/turn instead of constant-accel `approach`): full stall accel off the
>   line, falling ~linearly to `MOTOR_MIN_TORQUE_FRAC` at the free speed, so velocity approaches the
>   top ASYMPTOTICALLY (~0.5–0.8 s to 95% vs the old 0.27 s). `MOTOR_TORQUE_CURVE` 1.0 = real, 0 =
>   old ramp; `MOTOR_BRAKE_MULT` makes stops crisp. New consts in config's balance block.
> - **Mecanum de-buffed to real losses** (per GM0 — 45° rollers slip, low friction): was
>   speed 1.02 / accel 1.06 / **push 1.0 (the old anchor)**; now **0.85 / 0.82 / push 0.65** +
>   strafe 0.80. It loses straight-line speed AND gets shoved by tank. Full retune of all four
>   (tank 1.0/1.45/push1.7, swerve 0.95/1.15/push1.35, xdrive 0.90/0.80/push0.45). Orders now
>   realistic: speed tank>swerve>mecanum>xdrive, push tank>swerve≫mecanum>xdrive. DEFAULT mecanum
>   bot ~88→~73 in/s. Headless-checked: tank 70 / swerve 65 / xdrive 62 / mecanum 58 top.
> - **Easy balancing**: one documented `DRIVETRAIN & MOTOR BALANCE — TUNE HERE` block in
>   `config.ts`; `driveSummary()` + a smoke test PRINT the speed/strafe/accel/push table every
>   `npm test` run so any edit's effect is immediate. Base 75/280 kept as the ideal-traction datum
>   (calibration check self-adjusts via the mecanum mult).
> - Smoke: replaced the 2 old-buff checks (speed/push order + "mecanum has losses"), added 4 motor-
>   curve checks (stall off the line, falloff near top, strong braking, ~0.5–1.2 s to 95%).
> - **Scope note**: the user picked "everything tunable + how actual motors work." I delivered the
>   drive/motor realism (the explicit ask) + the one-block restructure; power-draw/flywheel/intake
>   values are left as-is but are the next candidates if further realism is wanted (all reference-
>   linked from the balance block header).
>
> ---

# HANDOFF — 2026-07-09 (2v2 start-role consent swap)

> **LATEST: GREEN, uncommitted on alpha.** `npm test` (316), `server:check`, `build` pass.
> **NEEDS A FLY REDEPLOY** for the swap to work over the network (server `sanitize` must pass the
> new roster fields; an old server STRIPS them → the Swap button is a graceful no-op). Not
> live-verified (needs a running server + 2 same-alliance clients — can't orchestrate headlessly,
> same as prior multiplayer ships).
>
> **2v2 start ROLE (Close/Far) is now swappable by mutual consent.** The role still defaults to
> alliance join order (1st by clientId = CLOSE, 2nd = FAR) and LOCKS the editor category, but
> either member can propose a swap the other must ACCEPT.
> - **Handshake rides two self-patched roster flags — no new server message, no cross-patching:**
>   `LobbyPlayer.startRole?` + `LobbyPlayer.swapReq?` (protocol.ts + PlayerPatch; sanitize.ts passes
>   both through — the ONLY reason a redeploy is needed). A member proposes by setting `swapReq`; the
>   partner accepts by setting theirs; when BOTH are set each client flips ITS OWN role to the
>   opposite (`other(role)`) and clears its flag. Race-free/convergent (they always held opposite
>   roles) and a `enacted` ref stops a double-flip in the patch→broadcast window.
> - **`src/ui/useRoleSwap.ts`** (new hook): derives the role, exposes `requesting/incoming/swapping`
>   + `requestSwap/acceptSwap/cancelSwap`, and runs the enact effect. The enact ALSO resets the
>   active start to the new category's default (`categoryDefaultIndex`) so a now-FAR robot isn't left
>   sitting at a CLOSE preset. `useDismissable` handles Decline (LOCAL hide — a partner can't clear
>   my flag; "must accept to switch" ⇒ non-accept = no swap). **`src/ui/RoleSwapBar.tsx`** = the UI
>   (role label + propose/accept/cancel), rendered in Lobby + MatchStrategy above the editor.
> - Both surfaces now derive the role via the hook (replacing the inline clientId-order derivation).
>   Smoke +3 (sanitize passthrough / bogus-role reject).
>
> ---

# HANDOFF — 2026-07-09 (start positions: Close/Far categories + saved library)

> **LATEST: GREEN, uncommitted on alpha.** `npm test` (313), `server:check`, `build` pass;
> GUI-verified. Client-only (no deploy needed — the saved library + category are LOCAL settings;
> only the active start rides the existing wire fields).
>
> **Start positions are now split CLOSE vs FAR (by distance to goal) with a per-player saved
> library.** Built on the G304 editor below.
> - **Presets carry `cat: 'close'|'far'`** (`config.ts` START_POSES): close = GATE/GOAL/INTAKE/BACK,
>   far = AUDIENCE. `MAX_SAVED_STARTS = 2`.
> - **Settings** (`types.ts`/`settings.ts`, coerced + persisted + account-synced): `startCat`,
>   `savedStartPoses: {close:StartPose[], far:StartPose[]}` (≤2 each), `startMemory: {close,far}`
>   (last selection per category so switching tabs restores it). `startIndex`/`startPose` remain the
>   ACTIVE start (spawn + wire) — the new fields are the client library/memory only.
> - **`src/ui/startPositions.ts`** (new, pure): `categoryPresets`, `switchCategory`, `selectStart`,
>   `saveStart`, `deleteSavedStart`, `samePose`. These return GameSettings PATCHES.
> - **Editor** (`StartPositionEditor.tsx`): CLOSE/FAR tabs + category presets + saved ★ slots
>   (＋Save, disabled when illegal/at cap; × to delete). New props: `category/saved/lockedCategory/
>   onCategory/onSave/onDeleteSaved`. `.ds-startpos-tabs/-tab/-role/-del` CSS.
> - **2v2 role lock**: in Lobby + MatchStrategy the first robot on an alliance (by clientId sort) is
>   the CLOSE robot, the second FAR — `lockedCategory` hides the tabs and limits the picks (derived
>   CLIENT-side; positions stay all-legal so no server enforcement needed). Solo/1-robot ⇒ both tabs.
>   `App.tsx` now passes `onSettingsChange` to Lobby. `applyStart` routes active→roster,
>   library/memory→settings.
> - Smoke +3 (partition, coerce defaults, saved-cap). **Reminder gotcha:** a preset click must be
>   ONE settings patch (`selectStart`), not two calls — stale-closure overwrite (see below).
>
> ---

# HANDOFF — 2026-07-09 (configurable start positions, rulebook G304)

> **LATEST: GREEN, uncommitted on alpha.** `npm test` (309, +16), `npm run server:check`,
> `npm run build` all pass. GUI-verified via Electron. **Client-only for solo/free/record**
> (works today, no deploy). Multiplayer custom poses need a Fly redeploy (server passes
> `startPose` through); until then a networked custom pose falls back to the preset — SAFE
> (backward-compatible additive field), never a crash.
>
> **What shipped — players can drag/place a CUSTOM start pose, constrained to the rulebook.**
> Replaces the old 3 fixed mid-launch-zone presets (which were NOT even G304-legal).
>
> **Rule: G304** (pulled from the live Competition Manual §11 this session — extract via the
> scratchpad `extract.cjs` PDF-text pattern): a robot must be (A) over a white LAUNCH LINE,
> (B) touching the GOAL or the FIELD perimeter, (C) fully in its own half — and (my addition,
> per the user "abide to collision boxes") its collision box may only REST AGAINST a solid,
> not penetrate it.
>
> **Sim core (`src/sim/field.ts`):** `evalStartPose`/`StartLegality` (flags: overLaunchLine /
> touching / contained / ownHalf / clear), `snapStartToLegal` (nearest legal along goal-face +
> audience loci; deterministic), `mirrorStartPose` (canonical↔actual, self-inverse),
> `footprintExtents`/`footprintCorners` (extracted; `physics.robotExtents` now delegates),
> `startPose(a,i,custom?)`. Config: `START_TOUCH_TOL` 1.25, `START_PEN_SLOP` 0.75, new legal
> `START_POSES` (GOAL·FAR / AUDIENCE / GOAL·GATE — **index 0/1 kept far apart** for the 2-robot
> spawn invariant). `StartPose` type lives in `types.ts` (avoids a settings↔field cycle).
>
> **Data model (backward-compatible additive):** optional `startPose` (canonical goalSide=+1,
> OVERRIDES `startIndex`) on `RobotSetup` / `GameSettings` / `LobbyPlayer` / `PlayerPatch`.
> `coerceStartPose` (structural+bounds) in spawn.ts + settings.ts + net/sanitize.ts;
> **`coerceSetup` snaps any custom pose G304-legal at the spawn chokepoint** so no path
> (localStorage / wire / staged match) spawns an illegal robot. Threaded through game.ts,
> replay.ts (`recordSetups`), server/room.ts (both LIVE-player setup sites pass
> `c.player.startPose`). `CLIENT_CAPS` gains `'startpose'`.
>
> **BUGFIX (user follow-up):** (1) snap-OFF no longer reverts an illegal release to the last
> legal pose — it leaves the robot exactly where dropped (red, "won't save"); only the toggle
> or the "Snap now" button ever moves it. (2) Preset buttons were a no-op/glitch because the
> editor called `onPickPreset(i)` AND `onChange(null)` — two separate `set()` calls spreading
> the SAME stale `settings`, so the second clobbered the first (startIndex lost). Now the
> editor calls ONLY `onPickPreset`, and each parent clears startPose + sets startIndex in ONE
> update (`{ startIndex, startPose: null }`). Watch for this stale-closure double-set pattern.
>
> **Preset tuning (user follow-ups):** current `START_POSES` = **GOAL·GATE** (58,48.5,270),
> **AUDIENCE** (31.25,−63.75,0 → tucked into the audience/loading corner, blue shows 180),
> **GOAL·FAR** (48,57,270 — x fixed 48, y chosen legal). Index 0/1 (GATE+AUDIENCE) stay far
> apart for the 2-robot spawn invariant; a new preset goes at index 2+. game.ts practice-dummy
> partner index is `startIndex===1?0:1` (never overlaps the player). The old "start pose inside
> launch zone" smoke check became "default spawn is a legal G304 start" (a goal-hugging default
> has its CENTER outside the launch triangle but the footprint over the depot line).
>
> **DYNAMIC presets (user follow-up):** `START_POSES` are semantic ANCHORS resolved per
> chassis via `presetPose(index,a,spec)` (= snap the anchor legal for that robot), so every
> preset is legal at ANY size. `startPose` gained a `spec?` arg; spawn passes `s.spec`; the
> editor's base pose uses `presetPose`. Smoke: presetPose legal for default/big/small.
>
> **UI (`src/ui/StartPositionEditor.tsx`, new):** a CANVAS that reuses the REAL renderers
> (`drawField`/`drawRobot`) — actual field markings + the actual selected robot sprite — with
> drag-to-place, a heading handle, and X/Y/heading inputs. **Snapping is an OPT-IN toggle
> (default OFF)** — the user found always-snapping hard to control. An illegal pose is
> PREVIEWED red ("— won't save") but NEVER committed; releasing an illegal drag reverts to the
> last legal pose (or snaps if the toggle is on). `.ds-startpos-*` CSS. Wired into MatchSetup
> (solo/free), Lobby, MatchStrategy; roster chips show "CUSTOM". +16 smoke checks.
>
> **DEPLOY (for networked custom poses):** commit on alpha → `flyctl deploy --remote-only` →
> verify `/health` → Vercel auto-deploys the client. Old server ignores `startPose` (preset
> fallback) — no break. Solo/free/record need no deploy.

---

# HANDOFF — 2026-07-09 (strategy 20s + countdown SFX; "matched on <server>" HUD chip)

> **LATEST: GREEN, uncommitted on alpha.** `npm test` + `npm run server:check` + `npm run build` pass.
> **Needs a Fly redeploy** for the strategy-time + server-region pieces to take effect (client-only
> bits ship via the Vercel push).
>
> **1. Ranked strategy window 60s → 20s.** `server/room.ts` `STRATEGY_DURATION_MS = 20000`.
>
> **2. Countdown SFX in the strategy screen** (`src/ui/MatchStrategy.tsx`). The window now beeps
> once per second over the final `STRAT_TICK_FROM = 5` seconds, rising in pitch, with a longer
> final beep at 1s. Own `MatchAudio` instance (the GameController isn't up yet pre-match), gated
> by the player's Sounds toggle (`settings.audio.sounds`). Fires once per new second (poll is 4 Hz,
> guarded on a strict decrease of `secsLeft`). The ⏱ chip's warning style now flips at ≤5s (was ≤10)
> to match the shorter window.
>
> **3. "Matched on <server>" HUD chip for ALL multiplayer games** (ranked, custom, record).
> - Server now reports its Fly region at matchStart: `server/room.ts` `SERVER_REGION`
>   (`FLY_REGION`/`SERVER_REGION` env) → new optional `region` on the `matchStart` ServerMsg
>   (`src/net/protocol.ts`) + `MatchStart` (`src/net/lobbyClient.ts`).
> - `src/net/env.ts`: `regionLabel(code)` (iad→'US East', sjc→'US West', lhr→'Europe', syd→
>   'Australia', nrt→'Asia'; unknown→UPPER) + `isKnownRegion`.
> - `ServerSession` derives a `serverLabel` (`deriveServerLabel`): reported region → region-coded
>   room-code prefix (`iad-…`) → picked server label. Surfaced as `NetStatus.server` (new field).
> - `GameView.tsx`: a `🌐 <label>` chip next to the NET chip (only when `hud.net.server` is set).
> - Backward-compatible: an OLD server omits `region`, so the client falls back to the room-code
>   prefix (accurate for ranked) or the selected server's label.
>
> **4. Fly VM cost downgrade.** `fly.toml` default performance-2x/4GB → **performance-1x/2GB**
> (applies to iad + sjc; still dedicated). `scripts/fly-deploy.sh` far satellites (lhr/syd/nrt)
> performance-1x → **shared-cpu-1x/1024MB** (`SATELLITE_SIZE`/`SATELLITE_MEMORY`, now passes
> `--vm-memory`). Shared CPU can throttle-flap a sustained 60Hz match (the exact risk the
> dedicated-CPU note warns about) — accepted for the low-traffic far regions (they auto-stop when
> idle + rarely host); bump back to a performance-* size if one flaps. Applied on the next
> `fly-deploy.sh` run (the satellite-resize step), OR live now via `fly machine update`.
>
> **5. Homepage redesign** (`src/ui/Home.tsx`, `MatchSetup.tsx`, `shell.css`). Play tiles are now
> grouped into three labeled sections (`.ds-tileset`/`.ds-tileset-label`): **Practice · offline**
> (Solo Practice primary + Free Drive), **Compete · online** (Find Match, Record Run, Duo Record),
> **Custom** (Custom Room) LAST. "Solo Match" → **"Solo Practice"** (was misleading — it's a full
> match, used for practice). **Match setup** is now a COLLAPSED `<details>` panel
> (`.ds-collapse`/`.ds-collapse-sum`) with the hint "Alliance, start & auto · Ranked and Custom set
> these in the lobby" — those options only apply to solo/offline modes, so they no longer clutter
> the landing. GUI-verified via Electron (structure + collapsed→expanded). Client-only (no deploy
> dependency beyond the Vercel push). NOTE: `verify` needs `ELECTRON=1 npm run build` (relative
> `base` for `file://`); the plain web build uses `base:'/'` and renders blank under Electron.
>
> **6. UI de-clutter pass** (`shell.css`, `Menu.tsx`, `Lobby.tsx`, `MatchHistory.tsx`). Trimmed
> over-tall boxes: the My Robot HERO card was ~292px (a long/narrow robot preview stretched it) →
> **239px** — `RobotPreview size={160}` in Menu + `.ds-hero-view svg { max-height:190px }` (capped
> just under the stats column so the stats drive the height, killing the empty bottom-right gap) +
> `.ds-hero-view` min-height 200→150. Home `.ds-tile` min-height 118→94 (lone Custom Room tile no
> longer looms). `.ds-empty`/`.ds-loading` padding 44→30px. Removed 3 redundant tooltips: Lobby
> ★HOST chip (text already says it) + the presence dot ('you'/'connected', row already shows "(you)"),
> and the MatchHistory season `<select>` (options name the seasons). Kept genuinely-explanatory ones
> (copy-room-code, ServerPicker ping-dot quality, net-stat chips, view-@user). GUI-verified via Electron.
>
> **7. Park mode box too tall — real layout bug** (`Menu.tsx`). The Park-mode `.ds-panelbox` was
> 214px with a ~150px empty gap between the slider and the hint. Cause: a bare `.ds-field` (`flex:
> 1 1 150px`) sat directly in the panelbox's COLUMN flex, so its 150px flex-BASIS became a forced
> HEIGHT. Fix: wrap it in `.ds-fields` (a row) like every other section does → basis is width again;
> box 214→**102px**. (No CSS change — purely the missing wrapper.)
>
> **8. Settings reachable when signed out** (`AccountButton.tsx`). Auth-enabled + signed-out showed
> ONLY "Sign in" (a modal) with no path to the settings page, so controls/audio were unreachable
> without an account. Added a "Settings" ghost button beside "Sign in" (in the account-name slot)
> → `onAccount` → the Account page, which already renders Controls/Audio/Reset regardless of sign-in.
> GUI-verified: header shows Settings·Sign in, and Settings lands on Account → Controls section.
>
> **9. Drivetrain rebalance** (`config.ts` `DRIVETRAIN_PRESETS`). Small tuning: **tank**
> speedMult 1.05→1.03, accelMult 1.5→1.42; **mecanum** speedMult 1.0→1.02, accelMult 1.0→1.06.
> Preserves the core accel order tank>swerve>mecanum>xdrive (383/302/286/248 in/s²) and keeps tank
> the top straight-line speed (1.03>1.02); `pushMult` untouched so mass-shove calibration holds.
> Mecanum is NO LONGER the 1.0/1.0 anchor — the BASE (`SPEED_PER_RPM`/`BASE_DRIVE_ACCEL`) is the
> 75/7/280 calibration and the ref mecanum now reads 76.5/7.14/296.8. Updated the calibration smoke
> check to divide out the mecanum mult (pins the base regardless of tuning) + 2 new checks (speed
> order, mecanum buffed). Comments updated in config.ts / drivetrain.ts / CLAUDE.md. smoke + build green.
>
> **NOT live-verified for the multiplayer bits** (#2/#3 need a running server + 2 signed-in clients —
> couldn't orchestrate headlessly, same as the strategy-window ship). Deploy is safe from alpha
> (server + client changed): commit → `flyctl deploy` → verify /health → Vercel auto-deploys the client.

---

# HANDOFF — 2026-07-09 (FIX: alpha↔main matchmaking pool separation → strategy window)

> **LATEST (build-id matchmaking segregation): GREEN, uncommitted on alpha.**
> `npm test` (+3 checks) + `npm run server:check` + `npm run build` all pass.
>
> **Symptom (reported):** an alpha 2v2 RANKED match did NOT open the pre-match STRATEGY
> window (it should). Alpha and main were sharing a matchmaking pool.
>
> **Root cause — one bug, both symptoms.** The strategy window opens only if EVERY client
> in a staged ranked room advertises the `strategy` cap (`server/room.ts:492`). `main`
> clients advertise NEITHER a `channel` NOR the `strategy` cap (verified:
> `git show main:server/matchmaking.ts`/`:src/net/protocol.ts` have neither). The
> matchmaker already segregates by `channel`, but ONLY if alpha actually reports
> `channel:'alpha'` — which comes from `VITE_APP_CHANNEL`, a MANUAL Vercel env var
> (`.env.example:46`, commented). If it's unset, the alpha client reports `'stable'`, so
> alpha and main land in one pool; an alpha 2v2 can then include a `main` client (no
> `strategy` cap) → the server falls to `startRankedImmediate()` → no strategy window.
> (A *pure* alpha 2v2 already works — the whole reconnect/caps path was traced.)
>
> **Fix — automatic pool separation by BUILD ID (`__BUILD_ID__`, the git sha).** The client
> now sends its build id on `queue` and the matchmaker segregates by (channel + build), so
> two DIFFERENT builds NEVER share an authoritative match — the exact "same code" invariant
> the client-side version gate already implies, now enforced server-side. Alpha and main
> always have different shas ⇒ separated automatically, no env var needed.
> - `server/matchmaking.ts`: `QueueEntry.build`; new `bucketKey(e)=`${channel}|${build}``;
>   `findMatch` + `broadcastStatus` bucket by it (was channel-only). Absent build ⇒ '' ⇒
>   channel-only fallback (old clients still pair among themselves).
> - `src/net/protocol.ts`: optional `build?` on the `queue` ClientMsg.
> - `src/net/env.ts`: `appBuild()` (reads `__BUILD_ID__`; declared here, NOT imported from
>   `version.ts` which pulls React). `src/net/lobbyClient.ts` `queue()` sends `build: appBuild()`.
> - `server/index.ts`: queue handler reads `msg.build` → `enqueue`.
> - `scripts/smoke.ts`: +3 (different builds don't pair; same build pairs; build-less old
>   clients still pair via channel fallback).
>
> **DEPLOY (both needed; the code alone does nothing until the SERVER runs it):**
> 1. **Redeploy the Fly server from current alpha** (`flyctl deploy --remote-only`) — the
>    matchmaker must run this bucketing code. Verify `/health`.
> 2. **Rebuild the alpha client on Vercel** so it sends `build`. (A build id is baked on
>    every deploy already — no config needed for separation.)
> 3. **STILL set `VITE_APP_CHANNEL=alpha`** on the alpha Vercel project — the `channel`
>    remains what keeps alpha results OFF the leaderboard/ELO (unpersisted); build-id only
>    handles pool separation. Both matter.
> Note: build-id bucketing means a client on an OLD build (pre-refresh) only matches other
> old-build clients until the version gate refreshes it — intended (never pair mismatched sims).

---

# HANDOFF — 2026-07-09 (FIX: networked robot NaN → renders at field centre)

> **LATEST (old-server field-skew NaN fix): GREEN, uncommitted on alpha.**
> `npm run build` + `npm test` (+2 new checks) + `npm run server:check` all pass.
>
> **Bug (reported on the alpha DEPLOYMENT only):** in any server-connected mode the local
> robot rendered at its start pose for one frame, then vanished and a static robot appeared
> at the field CENTRE (0,0), while the "real" robot stayed faintly controllable. HUD showed
> `PWR NaN%`.
>
> **Root cause — client/server SIM version skew.** The deployed Fly server
> (`dohun-sim-decode`) is running an OLDER `src/sim` that PREDATES the power-draw model, so
> its snapshot `RobotState` has NO `flywheelSpin` / `flywheelSpinRate` / `powerDraw` (verified
> by scanning a live snapshot: robot keys end at `pathTargetHeading`). The newer alpha CLIENT
> reconciles `this.world = snap.world`, so those fields arrive `undefined`; then `updateRobot`
> computes `POWER_DRAW_FLYWHEEL_HOLD * undefined` → NaN → `powerDraw` NaN → `dp.maxSpeed *=
> (1 − NaN)` → NaN velocity/position. `ctx.translate(NaN,NaN)` is a no-op, so the robot draws
> at the camera origin = field centre and freezes. Never reproduced LOCALLY because
> `npm run server` runs the CURRENT sim (fields present). One Fly app serves every client
> version, so this old→new skew is exactly the backward-compat hazard `CLAUDE.md` warns about
> (cf. the tank `ld/rd ?? 0` guard).
>
> **Fix (`src/net/protocol.ts` `unslimWorld` → new `backfillRobot`):** when the client rebuilds
> a world from the wire, back-fill any missing/non-finite dynamic robot field to a sane value
> (`flywheelSpin` ← `flywheelSpinTarget(alliance,pos)` like spawn, `flywheelSpinRate`/`powerDraw`
> ← 0). `finiteOr` catches `undefined` AND `null` (JSON serializes NaN→null). Harmless when the
> server DOES send them. Also removed the leftover TEMP DEBUG overlay in `game.ts` (green text +
> `window.__dbg`) that was left in to chase this. +2 smoke checks (old-server skew: back-fill is
> finite; stepping the stripped snapshot never NaNs the position).
>
> **CHOSEN FIX (user directive): segregate + don't persist ALPHA, plus the NaN guard.**
> A single Fly binary can only run ONE `src/sim`, so alpha (new physics) and stable (old
> physics) clients can't safely share an authoritative match. Instead of forcing everyone onto
> one sim, the build now carries a **release channel** and the server keeps the two apart:
> - **`src/net/env.ts` `appChannel()`** — baked from `VITE_APP_CHANNEL` (default `'stable'`; the
>   alpha Vercel project sets `alpha`). Sent to the server on `join`/`queue` (`lobbyClient.ts`,
>   new optional `channel` on both `ClientMsg`s).
> - **Matchmaking segregation** (`server/matchmaking.ts`): `findMatch` only groups entries of the
>   SAME channel; `broadcastStatus` counts per-channel (so an alpha queuer isn't told a mixed
>   pool is "ready"); the staged `PendingMatch` + each roster entry carry the channel (persisted
>   inside the roster jsonb — NO schema migration; `repo.ts` `takePendingMatch` reads it back).
> - **No DB writes for alpha** (`server/room.ts`): `Room.channel` is set from the first client
>   (or the staged roster); `finalizeMatch` still broadcasts `matchResult` (results + replay
>   work) but RETURNS before `onResult` when `channel === 'alpha'` — no leaderboard/ELO/record
>   rows. Client shows "Not saved / Not rated on this test build" (`GameView.tsx`) instead of
>   spinning on "computing rank…".
> - **NaN guard kept** (`unslimWorld` back-fill) as defence-in-depth for any residual field skew.
>
> **DEPLOY STEPS (both needed for the feature; the client push alone already stops the NaN):**
> 1. **Set `VITE_APP_CHANNEL=alpha`** on the alpha Vercel project (Settings → Env), then push →
>    Vercel rebuilds `alphadec.dohunkim.xyz`. WITHOUT this the alpha client reports `stable` and
>    won't segregate / stays persisted.
> 2. **Redeploy the Fly server from current alpha** (`scripts/announce-deploy.sh` to warn players,
>    then `flyctl deploy --remote-only`) so the server knows `channel` AND runs the current sim.
>    Note: the server then runs the alpha sim for ALL rooms (stable clients would rubber-band on
>    the changed physics but never NaN — extra snapshot fields are ignored). Verify `/health`.
> Repro/diagnosis: headless `ws` clients + an Electron driver pointed at the live deployment
> reading `window.__dbg` (that TEMP overlay is now removed).

---

# HANDOFF — 2026-07-09 (ranked pre-match STRATEGY window)

> **LATEST (pre-match strategy lobby for random matchmaking): GREEN, uncommitted on alpha.**
> `npm run build` + `npm run server:check` + `npm test` (+20 new checks) all pass.
>
> **Problem:** ranked matchmaking paired strangers and dropped them STRAIGHT into the
> match — no reveal, no coordination; the `ready` flag existed but was never enforced;
> start poses were silently de-conflicted server-side.
>
> **What shipped — a `phase: 'connecting' | 'strategy' | 'match'` window on staged ranked
> rooms** (`server/room.ts`). Once every paired player connects, `maybeStartRanked` now
> calls `enterStrategy()` (NOT `beginMatch`): it seeds each client's authoritative
> alliance + default pose from the staged roster, resets `ready`, arms a strict
> `STRATEGY_DURATION_MS` (60s) deadline, and sends each client a new `strategyStart`
> ServerMsg. Drivers then re-pick / claim a pose / ready via the existing `update`/
> `roster`; `maybeBeginRanked` starts the match the instant all ready, or
> `onStrategyDeadline` CANCELS if anyone isn't ready in time (user decision — strict, no
> auto-start). `beginRanked` builds setups from the LIVE re-picked specs (alliance/seed
> stay authoritative from the staged `PendingMatch`; spec re-clamped by
> `coerceSpec`/`coerceSetup` so re-pick can't break the build limits).
>
> - **Alliance-only reveal is server-side.** `broadcastRoster` is now per-recipient during
>   strategy: own + same-alliance entries full (with a `slot` for ELO lookup); OPPONENT
>   entries redacted to name/team/ELO (`hidden:true`, spec/assists neutralized to
>   `DEFAULT_SPEC`/`DEFAULT_ASSISTS`). Opponent detail is revealed only at `matchStart`.
>   **Gotcha closed:** during `'connecting'` (before strategy) clients self-report alliance
>   `'red'` (placeholder), so alliance-based redaction can't work — the roster is WITHHELD
>   entirely for a staged room until `enterStrategy` sends the redacted one.
> - **Alliance is locked** during ranked strategy (the `update` handler strips `alliance`).
> - **Disconnect during strategy CANCELS** the match (`detach` → `cancelPending`); the
>   `join`-based reconnect can't reclaim a held pre-match slot. Full strategy-phase
>   reconnection is DEFERRED.
> - **Protocol** (`src/net/protocol.ts`): `LobbyPlayer` gained `slot?`/`hidden?` (server-
>   authored, never patchable); new `strategyStart` ServerMsg. `lobbyClient.ts` dispatches
>   it. No new ClientMsg — `ready`/`startIndex`/`spec` ride the existing `update`.
> - **Client** (`src/ui/MatchStrategy.tsx`, new): alliance build cards (reuses
>   `RobotPreview`), minimal opponent cards, close/far start-pose claim (`START_POSES`),
>   saved-robot quick-swap + full builder (reuses `Menu`), ready + live countdown. Wired
>   into `Matchmaking.tsx` (`wireStrategy` attaches to both the dev mm-socket and the
>   production host-room socket; `playerInfo` now sends `ready:false`); `App.tsx` passes
>   `onSettingsChange={update}` so re-picks persist. Shared labels lifted to
>   `src/ui/robotLabels.ts`. New CSS `.ds-strat-*` in `shell.css`.
> - **Dev parity** (`server/matchmaking.ts`): `localStart` (no-DB) now routes through
>   `applyPending` (synthesizing a stable userId per connection) so the strategy window is
>   exercisable locally without Postgres.
> - **`STRATEGY_DURATION_MS = 60s`** — tune in `server/room.ts` if needed.
>
> **BACKWARD-COMPATIBLE SINGLE SERVER (mixed client versions safe).** Because one Fly app
> serves EVERY client (alpha/beta/main all bake the same `VITE_GAME_SERVER_URL`), the new
> server must not break old clients. Fix: a **capability handshake** — the client sends
> `caps: CLIENT_CAPS` (`['strategy']`) on `join`/`queue` (`protocol.ts`), the server stores
> it per-`Client`, and `maybeStartRanked` opens the strategy window ONLY if EVERY connected
> client advertises `'strategy'`; otherwise it calls the new `startRankedImmediate()` (the
> old instant-start with STAGED specs). So: all-new room ⇒ strategy; any old client ⇒
> instant start (old clients never get a `strategyStart` they can't render); a new client in
> a fallback room just gets `matchStart` and skips the screen; a new client against an OLD
> (not-yet-deployed) server also just works (no `strategyStart` ever arrives). This means
> you can `fly deploy` the new server WITHOUT breaking main/beta users, and roll the client
> out to alpha→beta→main at your own pace. **Nuance:** one shared matchmaking queue ⇒ a
> cross-version pair skips strategy; it fires only when two updated clients meet. Once all
> branches carry the new client, it's universal.
>
> **NOT yet done:** live end-to-end UI verification (needs a running game server + two
> signed-in clients; couldn't orchestrate headlessly). Deploy is now SAFE from alpha
> (`flyctl deploy` — `server/` changed); no need to sync branches first thanks to the
> capability gate. Consider strategy-phase reconnection + a config for the deadline length
> as follow-ups.
>
> **BUG FIX (separate, pre-existing — TANK frozen over the network).** `quantizeCommand`/
> `dequantizeCommand` (`src/net/protocol.ts`) only encoded `dx/dy/rot/buttons` and
> hard-set `leftDrive/rightDrive = 0`. TANK is the only drivetrain that steers via
> `leftDrive`/`rightDrive` (mecanum/swerve/xdrive use `driveX/driveY`), so a networked
> tank robot (multiplayer OR record run — both go through `ServerSession` → `quantize`)
> got ZERO drive and sat frozen at its spawn = the middle of the field, while the local
> client kept predicting its movement (`localizeCommand` = `dequantize∘quantize`, so
> prediction ALSO dropped the tank fields → the robot was frozen everywhere the net path
> ran). Mecanum worked (its axes are transmitted); solo FREE-DRIVE worked (`stepSolo` uses
> the raw command, no quantize). FIX: added `ld`/`rd` (int8) to `QCommand` +
> quantize/dequantize, with `?? 0` guards so an older client's ld/rd-less packet still
> decodes. Verified with a headless tank record-run probe (robot now drives) + 2 smoke
> checks. **DEPLOY NOTE:** tank only works over the net once BOTH the client (Vercel) and
> the server (Fly) carry this fix — a client/server version skew here is exactly the
> desync class the capability/backward-compat work above is meant to make safe.
>
> **BONUS FIX:** `server:check` (strict tsc for `tsconfig.server.json`) was already RED at
> HEAD — the staged-roster `autoPath` (a `string`) never type-checked against
> `RobotSetup.autoPath: AutoPathData`. `startRankedImmediate` now coerces it via
> `coerceAutoPath`, so `server:check` is green again.

---

# HANDOFF — 2026-07-08 (usernames + profiles + duo-name fix, on session 9) — READ FIRST

> **LATEST (usernames + public profiles + duo-name fix): rebased onto session 9, GREEN.**
> `npm run build` + `npm run server:check` + `npm test` all pass.
> - **USERNAME** — unique lowercase `[a-z0-9]` slug per account, SEPARATE from the display
>   `handle`. Migration `0006_username.sql` (renamed from 0005 to dodge the
>   `0005_pending_matches.sql` collision): nullable `profiles.username` + unique index.
>   Format `^[a-z0-9]{3,20}$`, validated in the DB index + `server/api.ts` +
>   `src/net/api.ts`.
> - **DUO names** — root cause was read-side only (`partner_id` was always stored).
>   `recordLeaderboard` now `left join`s the partner profile → `partnerHandle`/
>   `partnerUsername`; `Leaderboard.tsx` `DriverName` renders host + partner and links
>   each to `/profile/<username>` (records + ranked boards).
> - **Public profile** — `/profile/:username` route in `App.tsx`; `Profile.tsx` +
>   `Stats.tsx` share the extracted `CareerPanel.tsx`. Capture: required sign-up field,
>   the non-dismissible `UsernameGate.tsx` (any signed-in account with no username), and
>   the Account editor — all via `UsernameField.tsx` (debounced availability check).
> - **Endpoints** — `POST /api/user/username` (JWT, 409 taken), `GET /api/username-available`,
>   `GET /api/profile/:username[/stats]`.
> - Deployed physics-free (beta/main); migration `0006` runs at server boot.
>
> Session 9 (anti-cheat) notes follow.

> **session 9: server-authoritative spec/settings sanitization (anti-cheat).**
> Players were spoofing their robot config via devtools (inspect-element / edited
> `localStorage` / hand-crafted wire messages) to spawn oversized or NaN-dimensioned
> robots. Fixed by making config validation a SINGLE SOURCE OF TRUTH enforced at every
> layer. Build + smoke (+18 new checks) + server:check GREEN, uncommitted on alpha.
>
> - **`src/sim/spawn.ts`** now owns the canonical coercers: `coerceSpec` (clamps every
>   numeric axis to its per-drivetrain / per-preset legal range, GUARDS finiteness — bare
>   `clamp(NaN,…)` returns NaN, which previously slipped through), `coerceAssists`,
>   `coerceAutoPath` (structural + field-bound clamp so a spoofed auto path can't teleport
>   a robot to an absurd/NaN pos), and `coerceSetup`. All idempotent.
> - **`createWorld` runs `coerceSetup` on EVERY setup** — the ultimate chokepoint: no spawn
>   path (client localStorage, wire join, DB-staged ranked match) can produce an illegal
>   robot. Deterministic + idempotent ⇒ live play and replay re-runs agree.
> - **`src/net/sanitize.ts`** (new): `sanitizePlayer` / `sanitizePlayerPatch` for server
>   ingress. Wired into `server/index.ts` (`join` + ranked `queue`) and `server/room.ts`
>   (`update` patch) — a spoofed spec is clamped BEFORE it lands on the roster.
> - **`src/settings.ts`** `coerceSettings` refactored to delegate to the same coercers
>   (deleted its inline spec block + `isValidAutoPathData`), so client + server sanitize
>   identically. NOTE: this also FIXED a latent client bug — the old inline path let
>   `length/width/mass/rpm: NaN` through (no finiteness guard).
>
> Earlier session-8 notes (region-aware matchmaking + `fly-replay` routing) follow.

# HANDOFF — 2026-07-08 (session 7: intake/ball feel + seasons + multi-server)

## Branch strategy (IMPORTANT — this session introduced a two-branch split)
- **`alpha`** = the primary dev line: physics/ball tuning **plus** the new backend features.
- **`beta`** = **`main` + the backend features only, NO physics** (per user). Branched fresh
  off `main` this session (old beta was a stale ancestor; force-moved to `main`).
- The backend feature commits are authored on `beta`, then **cherry-picked onto `alpha`**
  (feature files — `server/*`, `src/net/*`, `src/ui/*` — are disjoint from the physics files
  `config.ts`/`goal.ts`/`robot.ts`, so cherry-picks are clean).
- `main` is untouched this session. Nothing pushed yet (`git push` when ready).

## Build state
- **`alpha`**: GREEN — `npm test` ALL PASS, `npm run build` clean, `npm run server:check` clean.
- **`beta`**: GREEN — same three all pass (after the tank-NaN guard below).

## alpha ≠ main on the TANK drivetrain (gotcha)
`alpha` and `main` **diverged** on tank drive. `main` merged a "tank" PR that added required
`leftDrive`/`rightDrive` to `RobotCommand` and an independent-stick tank model — but left two
bugs: server `ZERO_CMD` missing those fields (server:check red) and `(undefined+undefined)/2`
= NaN on a driver-frame strafe (smoke red). `alpha` never took that PR (its own drivetrain
overhaul has no `leftDrive`/`rightDrive`). On `beta` both were fixed (ZERO_CMD fields;
`cmd.leftDrive ?? 0`). Do NOT assume alpha and main share tank code.

## What shipped this session

### 1. Ball/intake feel (ALPHA ONLY — `config.ts`/`goal.ts`/`robot.ts`)
- **Goal basin**: split funnel velocity into radial+tangential and damp the tangential hard
  (`BASIN_TANGENT_DAMPING`) so balls spiral STRAIGHT into the classifier throat instead of
  orbiting it (the "circular jumble"); brisker funnel (`BASIN_FUNNEL_ACCEL` 500→700, grip
  260, entry-keep 0.45).
- **Gate release**: `TUNNEL_EXIT_VEL.along` 42→22 (gentle) with independent x/y jitter (0.6–1.4)
  — low momentum + friction + ball↔ball spread the drain. Earlier a symmetric perpendicular
  kick split it into TWO branches; removed. Overflow flow speed untouched (58).
- **Triangle intake**: strongest grab (`drawIn` 28→46, `capMin/Max` 0.04/0.07, clump 0.035).
  Tradeoff stays TRANSFER (`fireCap`), not the grab.
- **Vector intake**: no clump SPEED bonus (that's a wedge trait now — gated on `m.wedge`). A
  FLAT intake rammed into an OFF-CENTER ball at high CLOSING speed (`INTAKE_RAM_SPEED` 32,
  measured RELATIVE to the robot) is NOT vectored — it bounces off the flat front as a normal
  impact collision (`collideBallRobot`). Impact-only: once a ball rides with the chassis (low
  closing speed) it vectors in even while pushing hard; the CENTER compliant wheels always
  intake fast.

### 2. Feature A — Seasons (BOTH branches)
Season = the `balance_version` key, but the LIVE season is now DB-controlled so an admin can
start a fresh season at runtime without a redeploy.
- `server/db/repo.ts`: `currentSeasonNumber(fallback)` = max(highest `seasons` row, config
  `BALANCE_VERSION`); `listSeasons()`, `startNewSeason(name)`, `purgeSeasonReplays(season)`.
- Migration `0004_season_replay_index.sql`: index `replays.balance_version` for bulk purge.
- `persist.ts`: stamps results AND the replay with `currentSeasonNumber` (identical to before
  until an admin advances the season).
- API: `GET /api/seasons` (list + `current`); default board view = live season. Admin
  `POST /api/admin/season/start` + `/purge-replays` (JWT admin id OR `ADMIN_SECRET`).
- Client: **season picker** in `Leaderboard.tsx` (archived seasons stay viewable; wires the
  already-supported `season` param); Admin buttons "Start new season" + "Purge archived
  replays". Purge deletes replays only — `records/matches.replay_id` are `on delete set null`,
  so boards survive and just lose watchability.

### 3. Feature B — Multi-server (BOTH branches) — partial
- `src/net/env.ts`: game server is now a **list** (`VITE_GAME_SERVERS` JSON of
  `{id,label,region,url}`), back-compat to single `VITE_GAME_SERVER_URL`. A module-level
  SELECTED server drives `gameServerUrl()/gameServerHttpUrl()`, so all existing connect sites
  follow the choice with no change. `multiServer()`, `setSelectedServer(id)`, `httpOf()`.
- `src/net/ping.ts`: pre-connection latency probe (`pingServer`/`pingAll`/`pingQuality`/
  `fastestServer`) timing each server's `/health`. `/health` now sends CORS + `x-region`
  (from `FLY_REGION`/`SERVER_REGION`); `/api/presence` reports its region.
- **Record-run server picker** (`src/ui/ServerPicker.tsx`, wired in `RecordRun.tsx`): when
  >1 server is configured, the player picks a region from a live ping list before starting;
  single-server deploys skip it. Choice is **saved to the account** via
  `GameSettings.preferredServerId` (synced through the existing account-settings sync — NOT
  localStorage) and restored on load (App effect on `settings.preferredServerId`).
- `.env.example` documents `VITE_GAME_SERVERS`.

## Region-aware matchmaking + `fly-replay` routing — DONE (uncommitted on alpha, build/smoke green)
Full plan in `docs/netcodeplan.md` **Phase 4**; plan file `~/.claude/plans/yes-plan-mode-on-ancient-rain.md`.
Model: **ONE Fly app, one machine per region** (`iad/sjc/lhr/syd/nrt`), routing via `fly-replay`
(NOT separate apps, NOT the old region-lock). The earlier region-lock toggle/`findGroup` were
REPLACED. Region-local ranked by default; search radius widens over time / on demand; a
cross-region match is hosted on the fair MIDPOINT region (minimax).
- **`server/regions.ts`** (new): `DEPLOY_REGIONS`, `MATCHMAKER_REGION` (env, default iad),
  `INTER_REGION_MS` static RTT matrix (SEED values — calibrate post-deploy), `bestHost()` minimax
  → `{hostRegion, cost, spread}`. **`server/matchTypes.ts`** (new): `PendingMatch`/roster.
- **`server/matchmaking.ts`** (rewritten): `QueueEntry` now `homeRegion/accessMs/noWiden/
  enqueuedAt/expandBumps`; `radiusCeiling()` (cross-region-ms gate, 0→300 widening); `findMatch`
  FIFO-greedy under the radius; `assign()` stages `pending_matches` + sends `matchAssigned`;
  `localStart()` no-DB dev fallback (hosts on the matchmaker machine). Injectable `now`/`stage`
  for tests. `expand(id)` = `expandSearch`.
- **`server/index.ts`**: WSS `noServer` + `httpServer.on('upgrade')` interceptor → `routeTarget`
  (`?mm=1`→MATCHMAKER_REGION, `?room=<region>-…`, `?region=`) answers with `fly-replay: region=<r>`
  (loop-guarded on `fly-replay-src`; inert when `FLY_REGION=''`). `/health?region=` also fly-replays
  (per-region ping). `join` is now async `joinRoom`: claims a staged match via `takePendingMatch`,
  verifies auth BEFORE add (maps roster by userId), `maybeStartRanked`. Queue handler uses the new
  fields; `expandSearch` wired. Periodic `cleanupStalePending`.
- **`server/room.ts`**: `applyPending()`/`maybeStartRanked()`/`cancelPending()` build the
  authoritative ranked match from the staged roster (ignores client specs) once all userIds
  reconnect (or 20s join grace → cancel). Extracted `beginMatch()` shared by all start paths.
- **DB**: `0005_pending_matches.sql` + repo `createPendingMatch/takePendingMatch(delete-returning)/
  cleanupStalePending`.
- **Client**: `protocol.ts` queue msg (`homeRegion/accessMs/noWiden`), `matchAssigned` ServerMsg,
  `expandSearch` ClientMsg. `ping.ts` `probeHome()` (reads `x-region`) + `pingServer` appends
  `?region`. `env.ts` `gameServerUrlWith(hint)`. `lobbyClient.queue(mode,player,homeRegion,accessMs,
  noWiden)` + `expandSearch()` + `matchAssigned` handler. `Matchmaking.tsx`: connect `?mm=1`, probe
  home, on `matchAssigned` DROP the mm socket and reconnect `?room=<code>` (two-socket handoff);
  region-lock checkbox REPLACED by expand-search + widening status + `noWiden` opt-in. `Lobby.tsx`
  region `<select>` + `?region` connect; `RecordRun.tsx` `?region` connect.
- **Config**: `fly.toml` `min_machines_running=1` (warm matchmaker region). `.env.example` Model-M
  block + `MATCHMAKER_REGION`. `deploy.md` multi-region recipe. 14 new smoke checks (bestHost,
  radiusCeiling, region-local/cross-region/noWiden/expand, staged code+roster shape).
- **Decisions**: designated matchmaker machine (not Postgres shared queue); built A+B+C.
- **NOT committed** — edited alpha directly (per protocol re-author on `beta` then cherry-pick, or
  commit alpha + backport). Cross-region ranked needs `DATABASE_URL` (roster staging); region-local
  + custom rooms don't.
- **PENDING LIVE VERIFICATION**: `fly-replay` can't be exercised on localhost (needs the Fly proxy).
  After the multi-region deploy, confirm `?region=lhr` from the US lands on lhr (`/api/presence`),
  and a widened cross-region ranked match hosts on the minimax region. Provisioning is user-run:
  `fly deploy` → `fly scale count 1 --region <code>` (×5) → `fly secrets set MATCHMAKER_REGION=iad`
  → set `VITE_GAME_SERVERS` (all same base URL, per-region entries) on Vercel. Then calibrate
  `INTER_REGION_MS` from real `/health` pings.

## Gotchas / how to work here
- **Two-branch flow**: author backend features on `beta`, `git cherry-pick <sha>` onto `alpha`.
  Verify BOTH: `npm run server:check`, `npm test`, `npm run build`.
- PowerShell: no `&&`; here-strings for commit messages must use single-quoted `@'…'@` and the
  closing `'@` at column 0. Avoid inner double-quotes in the message body (they broke a commit).
- Season model: reads default to the LIVE season (may be admin-advanced past config
  `BALANCE_VERSION`); an explicit `?season=` picks an archived one. `replays.balance_version`
  is stamped with the season so a purge is a direct delete-by-season.
- Deploy protocol (unchanged): commit on alpha → merge main → `flyctl deploy --remote-only`
  (`dohun-sim-decode`) → verify `/health` → Vercel auto-deploys the client. `docs/deploy.md`.
- No Co-Authored-By / Claude trailer on commits (user preference).

## Commit log (this session)
- alpha: `d183841` intake+basin+gate feel · `753d3bd` gate-branch fix · `7c6cd34` seasons ·
  `b7d3149` multi-server foundation · `990b1eb` record-run picker · `cf2c174` env docs.
- beta: `06ec281` ZERO_CMD fix · `42ffc3d` seasons · `17e073d` foundation · `70de2ae` picker ·
  `9d4d94a` env docs · (+ tank-NaN guard) — same features, no physics.
