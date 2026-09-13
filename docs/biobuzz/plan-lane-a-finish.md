# Plan — finish Lane A (field + scoring) from the master chat

Written 2026-09-12 against alpha `68bfb4b`. Run top to bottom in THIS chat, one phase per
commit batch. Every phase ends with the gate block and a push. Caveman mode stays on for the
user; code, comments and commits are written normally.

## Standing rules

- **Never touch Lane B**: `src/games/biobuzz/{robot,mechs,launcher,turret,dumper,drawRobot,
  hudRobot}.ts`, the builder half of `src/ui/Menu.tsx`, `docs/biobuzz/HANDOFF-robot.md`,
  `scripts/smoke-biobuzz/robot.ts`. Relay notes via the user only.
- No Claude attribution in commits. No bare `flyctl deploy` (only `./scripts/fly-deploy.sh`,
  and only after the user says go). Never redraw supplied artwork. Manual page images never
  committed. Never bare `git stash`.
- Push is always `git fetch && git merge --no-edit origin/alpha && git push origin HEAD:alpha`.
  A plain `git push` silently no-ops on this worktree.
- **Gate block** (run all, in this order, after every phase):
  `npx tsc --noEmit -p .` · `npm run server:check` · `npm test` (BOTH suites, must print
  `ALL PASS` twice — phase 1 touches `src/sim/`) · `npm run uiaudit` · `npm run contrast`.
  For a docs-only commit `npm run test:bb` is enough.
- Bash heredocs longer than a screen get mangled by the shell hook here; write files with the
  Write tool and keep git commands short.
- A GPT review chat runs in parallel; its findings arrive through the user. Do not
  self-review the same diffs; act on what the user relays.
- Owner questions still open (do not guess; leave the code on the current ruling):
  yellow cards game-wide? · spill 11 % short tail acceptable? · G304 frontage.

## Phase 0 — land A6a (origin/biobuzz-field `260218a`, 4 commits)

Trial merge showed exactly 3 conflicts:

1. `docs/biobuzz/HANDOFF-field.md` — keep both sections, delete the markers.
2. `src/net/protocol.ts` — the field branch still names bit 32 `bbLift`; alpha (Lane B 3f41802)
   renamed it `bbPlaceNectar`. Result must be: 32 `bbPlaceNectar`, 64 `bbPlace`, 128 `bbNectar`,
   in both quantize and dequantize, and `bbLift` must not survive anywhere (`grep -rn bbLift src/`
   → 0). Bit 128 is the LAST that fits `src/sim/replay.ts` (`q.buttons & 0xff`); the comment
   there should say so.
3. `src/ui/ControlsSection.tsx` — keep both label rows (Lane B's place pair + the field's
   `bbNectar`).

After resolving, check the auto-merged files by hand, they are where the two lanes overlapped
without a textual conflict:
- `src/types.ts` `RobotCommand`: `bbPlaceNectar`, `bbPlace`, `bbNectar` all present, no `bbLift`.
- `src/input/{bindings,gamepad,input}.ts`: Lane B took pad 11 (RS) and 12 (D-UP); the field
  took pad 13 for `bbNectar` and key `N`. Confirm no index or key collides.
- `src/games/biobuzz/index.ts` `mobileButtons` (field added the nectar button) and
  `src/settings.ts` `mobileLayout.bbNectar` coerce — both present.
- `src/games/biobuzz/play.ts` and `spawn.ts`: both lanes edited; run the smoke before reading.

Gate block. Expect `test:bb` ≈ 1105 + the field's new checks. Commit
`merge origin/biobuzz-field (A6a: human player button, G304, flower section, thresholds)`. Push.

## Phase 1 — shared-core requests (integration chat's files)

Each is its own commit. Each keeps DECODE and Chain Reaction byte-identical (the first
`npm test` suite is the proof). Order chosen so a failure late does not block the early wins.

### 1.1 Per-game start legality → `startLegality: true`

`server/room.ts:865/978` and `src/ui/startPositions.ts` call DECODE's `activeStartLegal`
directly, so the field lane left `BIOBUZZ_SIM.startLegality = false` (HANDOFF-field §2). Add
`GameSimModule.startLegal?(spec, alliance, pose): boolean` to `src/games/types.ts`; DECODE's
module fills it with `activeStartLegal`, BIOBUZZ's with `bbEvalStart(...).legal` (via
`elements.ts` `evalStart`), Chain leaves it absent (`startLegality: false` already). The two
callers read `simModuleFor(game).startLegal ?? activeStartLegal`. Flip the flag, update the
smoke label the field lane wrote for it (`grep -n startLegality scripts/smoke-biobuzz/`). This
is a `server/` change → deploy in phase 3.

### 1.2 Per-game solids for `pinnedAgainstWall` (G421 corner pins)

`src/sim/penalties.ts:951` reads DECODE's goal triangles by hand, so a BIOBUZZ robot held on a
FLOWER foot or the HIVE frame is never "against a solid". Give `isPinning` the active module's
`colliders` (the `StaticSpec` list the physics already builds) instead of the DECODE tables:
`pinnedAgainstWall(pinner, pinned, solids)`, with the walls plus every static rect/poly. DECODE
passes exactly what it reads today (assert the DECODE G422 checks in `scripts/smoke.ts` do not
move). Rules lane's `bbUpdatePenalties` already calls `isPinning`; add one smoke in
`scripts/smoke-biobuzz/rules.ts`: a victim held on a FLOWER foot bills G421.

### 1.3 Per-game geometry for the CONTROL (herding) test

`controlledArtifacts(world, r, dt, intaking)` (`src/sim/penalties.ts:555`) uses DECODE's
funnel for the flat/concave face and the DECODE LOADING ZONE for carve-out C. BIOBUZZ's face
is `bbRobotSolids` (already a `GameSimModule.artifactSolids` slot) and its carve-out is its own
LOADING ZONE. Route the face through `artifactSolids` when present and add
`GameSimModule.controlCarveOut?(r, a): boolean` for the zone. Smoke (rules lane): herding 5
loose POLLEN in open floor warns G407; the same in the own LOADING ZONE while intaking does not.

### 1.4 Per-artifact radius in the shared solve (NECTAR 1.8 vs POLLEN 1.4)

`Artifact.r?` exists (`src/types.ts:312`) and renderers read it; `solveArtifacts`,
`clampBallPosToStatics`, `robotSolids`/`bbRobotSolids` held circles and `pinnedArtifacts` still
take one radius per call. Read `ball.r ?? radius` at each site. DECODE sets no `r`, so the
first smoke suite is the byte-identical proof; then in `scripts/smoke-biobuzz/field.ts` assert
a resting NECTAR sits 1.8 in off the wall (today 1.4 — the "0.4 in past the wall" note in
HANDOFF-field ~862/881) and a NECTAR on a POLLEN pile rests at the larger sum of radii. Update
`docs/biobuzz/feedback/000-solver-observations.md` (close the radius item) and field-plan §6
request 1.

### 1.5 Verify, do not build

- Foul tariff per game: already handled locally by `bbAwardFoul` (5 / 20). Leave.
- `'TELEOP'` event string: `grep -rn "'TELEOP'" src/` finds nothing today — the earlier note
  was stale. Confirm and drop from the queue.

Gate block after each of 1.1–1.4. Update field-plan §6 (strike each request as it lands).

## Phase 2 — Lane A remainder inside `src/games/biobuzz/`

1. **`nectarWhy` chip** — `HudSlots.tsx:226` has a `TODO(A6a)`; A6a now exposes
   `nectarWhy: 'ok' | 'locked' | 'none-owed' | 'none-left'` on the state. Surface it: chip
   text `NECTAR LOCKED` (before 1:00, already exists) · `NO NECTAR OWED` · `NECTAR OUT`; `ok`
   shows the existing `NECTAR n` count. Table 10-2 wording, uppercase, no new colours
   (`contrast` must stay at 223).
2. **Gallery re-shoot after the merge** — `flower-stack`, `hive-tip`, `nectar-entry`,
   `park-examples`, `field-labelled` at 1600 px, both themes (`node scripts/shots.cjs --scene …`,
   output under `scratch/`, gitignored). LOOK at every PNG (Read the file). Anything that reads
   wrong goes to the user as a one-line question, not a fix.
3. **Replay round-trip for bit 128** — the field lane says a check exists; confirm by name in
   `scripts/smoke-biobuzz/field.ts`, add it if absent (record a press, JSON round-trip, hash
   equal, nectar placed in both runs).
4. **HUD chip for FLOWERS OPEN** — `step.ts:205` pushes `FLOWER OWNERSHIP UNLOCKED`; confirm
   `HudSlots.tsx` flips `NECTAR LOCKED` → nothing/`FLOWERS OPEN` at 1:00 (field-plan §3).
5. **APPROX ledger** — `grep -n APPROX src/games/biobuzz/config.ts` into
   `docs/biobuzz/feedback/002-thresholds.md`'s tail as the 09-14 tape-measure list, one line per
   constant, if the note does not already carry it.
6. **Owner answers, when relayed** — yellow cards: if yes, wire `awardCard` into `bbAwardFoul`
   for G417 STRATEGIC and G421 repeats (the rules lane's `penalties.ts:377` names the spot);
   if no, leave the comment. Spill tail: if a second term is wanted, it is one `BB_SPILL_*`
   constant plus the `hive-tip` re-shoot.

Gate block. Commit per item or per pair. Push.

## Phase 3 — deploy and close

1. **Ask the user**, then `./scripts/fly-deploy.sh`; verify `/health` and
   `fly machine list -a dohun-sim-decode` (satellites still small). Server-side changes waiting:
   Lane B's `server/room.ts` participation credit, phase 1.1's start-legality dispatch, any
   `src/sim/` string change.
2. Docs: prepend `HANDOFF.md` (root) with the day's state; `docs/biobuzz/field-plan.md` §6 all
   struck or re-queued; `docs/biobuzz/prompts.md` gets a one-line "Round 6 closed at <sha>";
   `docs/biobuzz-contract.md` notes that Lane A is now run from the master chat.
3. Tell the user: alpha sha, check counts, what is deployed, the three owner questions still
   open, and the 09-14 measurement list.

## Done means

- alpha carries A6a + phases 1–2; `npm test` prints `ALL PASS` twice; uiaudit at baseline;
  contrast 223 pass; `startLegality: true` and `scored: true` for BIOBUZZ.
- Every §6 shared-core request is landed or explicitly re-queued with a reason.
- No Lane B file touched; no attribution lines; Fly deployed only via the wrapper and only on
  the user's go.
