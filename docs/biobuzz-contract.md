# BIOBUZZ — the lane contract (READ FIRST if you are building the game)

Two people build this game in parallel. **Lane A owns the FIELD; Lane B owns the ROBOT.**
This file is the interface between them and the list of who may edit what. If a rule here
is wrong, change it here first, then change the code. Companion: `biobuzz-plan.md`
(why), `biobuzz-reference.md` (the manual, distilled — Lane A writes it on kickoff day).

Everything BIOBUZZ lives in `src/games/biobuzz/`. Nothing BIOBUZZ goes into `src/sim/`
or `src/config.ts` (repo rule, same as Chain Reaction). The sim code obeys the shared
determinism rule: no DOM, no clock, no `Math.random`, no `Date`; all game state is plain
JSON on `world.biobuzz`.

## 1. Ownership map

| path | owner | notes |
|---|---|---|
| `src/games/biobuzz/config.ts` | **A** | field, element, scoring, timing constants; `mm()`; `APPROX` flag convention |
| `src/games/biobuzz/state.ts` | **A** | `BiobuzzState` + `emptyBiobuzzState()` + field geometry helpers |
| `src/games/biobuzz/colliders.ts` | **A** | `statics`, `bounds`, optional `dynamic` |
| `src/games/biobuzz/spawn.ts` | **A** | `createBiobuzzWorld`; pollen layout; start anchors; calls B's `coerceSpec(…, 'biobuzz')` — never re-clamps a spec |
| `src/games/biobuzz/play.ts` | **A** | pollen lifecycle, scoring, match assessment |
| `src/games/biobuzz/elements.ts` | **A** | **the contract surface** (§3). Signatures frozen after the T0+2h sync |
| `src/games/biobuzz/penalties.ts` | **A** | |
| `src/games/biobuzz/drawField.ts`, `draw.ts` | **A** | |
| `src/games/biobuzz/StartEditor.tsx` | **A** | only if the game has start legality |
| `src/games/biobuzz/hud.ts` | **A** | field half of the HUD slice (§5) |
| `scripts/smoke-biobuzz/field.ts` | **A** | |
| `src/games/biobuzz/scenesField.ts` | **A** | gallery scenes: field, elements, pollen physics set (frozen after the Phase 0.5 sign-off) |
| `docs/biobuzz-reference.md`, `docs/biobuzz/HANDOFF-field.md` | **A** | |
| `src/games/biobuzz/robot.ts` | **B** | archetype geometry: `bbMouths`, `bbLaunchers`, `bbFootprint`, `bbHopperCap` (§4) |
| `src/games/biobuzz/mounts.ts` | **B** | LEAF module — imports only `../../types` (the footprint reader in `src/sim/field.ts` may need it, and anything heavier cycles) |
| `src/games/biobuzz/robotConfig.ts` | **B** | dial ranges, defaults, `BB_PRESETS`, clamp helpers |
| `src/games/biobuzz/drawRobot.ts`, `parts.ts` | **B** | `parts.ts` is a copy of `chain/parts.ts` |
| `src/games/biobuzz/RobotPreview.tsx`, `Builder.tsx` | **B** | rendered through the `GameModule.Preview` / `Builder` slots |
| `src/games/biobuzz/labels.ts`, `hudRobot.ts` | **B** | |
| `src/types.ts` — `RobotSpec.bb*` fields, `RobotCommand.bb*` buttons | **B** | optional fields only; JSDoc says "BIOBUZZ:" like CR's do |
| `src/sim/spawn.ts` — the `game === 'biobuzz'` arms of `coerceSpec` | **B** | every new spec field is clamped/enum-checked here; idempotent |
| `src/sim/field.ts` — `footprintExtents` biobuzz arm | **B** | only if the robot footprint differs from the shared rule |
| `src/input/bindings.ts`, `src/ui/MobileControls.tsx` via module slot | **B** | new actions |
| `scripts/smoke-biobuzz/robot.ts` | **B** | |
| `src/games/biobuzz/scenesRobot.ts` | **B** | gallery scenes: archetype × mount sheets, capture/release mechanism scenes |
| `docs/biobuzz/HANDOFF-robot.md` | **B** | |
| `src/games/biobuzz/scenes.ts` (registry), `Gallery.tsx`, `scripts/shots.cjs` | **frozen** after Phase 0 | lanes register scenes in their own file; the registry imports both |
| `docs/biobuzz/feedback/*.md` | **the human** | Claude appends only below `## Response <sha>`; never edits above it |
| `src/games/biobuzz/step.ts` | **A owns the order.** B does not edit it; robot behaviour enters through `elements.ts` hooks that `play.ts` calls | |
| `src/games/biobuzz/sim.ts`, `index.ts` | **frozen** after Phase 0 (flags flipped at integration) | |
| `src/types.ts` — `World.biobuzz` | **A** | |
| `src/games/types.ts`, `module.ts`, `index.ts`, `sim.ts`, `src/seasons.ts`, `src/net/protocol.ts`, `src/net/sanitize.ts`, `server/**`, `src/ui/Menu.tsx`, `GameView.tsx`, `App.tsx`, `game.ts`, `CLAUDE.md`, root `HANDOFF.md` | **integration chat only** | Phase 0 made these game-agnostic; a lane that needs a change here writes the request into its handoff file |
| `scripts/smoke.ts` | **nobody during the sprint** | biobuzz checks go in `scripts/smoke-biobuzz/` |

The one sanctioned cross-lane edit: a new `RobotCommand` button needs a protocol bitfield
bit (`BTN_*` in `src/net/protocol.ts`) and a `localizeCommand` line. B writes the request in
`HANDOFF-robot.md`; the integration chat lands it the same day.

## 2. World state (A owns the shape, B reads it)

```ts
// src/games/biobuzz/state.ts — DRAFT, finalized at the T0+2h sync
export interface BiobuzzState {
  /** per-alliance scored counts / points, split by how the manual scores them */
  scored: Record<Alliance, number>;
  points: Record<Alliance, number>;
  /** per-robot end-of-match status if the game has park/climb/etc. */
  endgame: Record<number, string>;
  /** last button state per robot id for edge-triggered actions */
  held: Record<number, Record<string, boolean>>;
  /** monotonic ball-id allocator — deterministic, no module global */
  nextBallId: number;
  /** penalty EDGE state, `${rule}-${offender}-${victim}` keys */
  foulEdge: Record<string, boolean>;
}
```

Pollen live in `world.balls: Artifact[]` exactly as CR's particles do (ground / flight
states; `flight` already carries `target`, `scored`, `staged`). Count is conserved; the sim
never creates or deletes a ball mid-match without A's explicit rule saying so.

## 3. `elements.ts` — what A exports to B (DRAFT; finalized T0+2h)

B's mechanisms never touch `world.balls` or `world.biobuzz` directly. They call these.

```ts
/** ground pollen inside a robot-local rect (B's mouth), oldest-first. Pure. */
export function pollenIn(world: World, r: RobotState, mouth: LocalRect): Artifact[];
/** move ONE pollen from the ground into r.hopper. Returns false if the hopper is full
 * or a possession rule (manual) forbids it. */
export function capturePollen(world: World, r: RobotState, ball: Artifact): boolean;
/** launch/deposit ONE pollen from r.hopper with a world-frame velocity (+z lift) and an
 * optional scoring target. A decides what it hits; B decides how it leaves. */
export function releasePollen(world: World, r: RobotState, v: Vec3, target?: ScoreTarget): void;
/** the scoring targets an alliance can aim at, with the geometry a launcher needs
 * (opening centre / normal / height) — replaces CR's accelMouth. */
export function scoreTargets(world: World, a: Alliance): ScoreTarget[];
/** is a start pose legal for this robot (rule-text in biobuzz-reference.md)? */
export function evalStart(spec: RobotSpec, a: Alliance, pose: StartPose): { legal: boolean; reason?: string };
/** any element interaction that is not pollen (a lever, a climb, a gate): one
 * edge-triggered hook per element type, named for the ACT. */
export function actOnElement(world: World, r: RobotState, act: string): boolean;
```

`play.ts` calls B's geometry each tick: `bbMouths(spec)` to know where to look, and B's
`bbLaunch(world, r, cmd)` (in `robot.ts`) to let a mechanism decide when to call
`releasePollen`. The step order is CR's: resolve commands → B's aim override →
drivetrain → Rapier + containment → `updateBiobuzz` (A) → penalties (A) → phase machine.

## 4. Robot geometry — what B exports to A

```ts
// src/games/biobuzz/robot.ts
export function bbMouths(spec: RobotSpec): LocalRect[];          // capture areas, robot-local
export function bbFootprint(spec: RobotSpec): { front: number; rear: number; half: number };
export function bbHopperCap(spec: RobotSpec): number;
export function bbAimHeading(r: RobotState, target: ScoreTarget): number | null; // turretless aim
export function bbLaunch(world: World, r: RobotState, cmd: RobotCommand, enabled: boolean): void;
```

The drawn mouths ARE the capture areas: `drawRobot.ts`, `RobotPreview.tsx`, and `play.ts`
all read `bbMouths`. Never a second geometry.

`RobotSpec` additions are optional, prefixed `bb`, defaulted and clamped in `coerceSpec`'s
`game === 'biobuzz'` arm, and listed here as they land:

| field | type | range / enum | since |
|---|---|---|---|
| (filled at T0+2h) | | | |

Sizing law to build against: **R102** 18 in cube start configuration; **R105** expansion
limits published at kickoff (read the rule before choosing any reach/extension dial).
There is **no weight limit (R104)** — the shared 20–42 lb mass slider stays a sim balance
range, not a rule.

## 5. HUD slice

`GameSimModule.hud(world, robotId)` returns `{ field: A's object, robot: B's object }`;
`game.ts` stores it on `HudSnapshot.gameHud`. A's `hud.ts` builds `field` (scores, counts,
phase extras); B's `hudRobot.ts` builds `robot` (mechanism state, hopper, action prompts).
`GameModule.hudChips` / `resultsRows` / `scoreBar` render them; A owns `scoreBar` and
`resultsRows`, B owns `hudChips`.

## 6. Terminology

DSIM is the app; BIOBUZZ is the season. The scoring element is **POLLEN** (never "ball",
"artifact", or "particle" in user-visible text). Every other element takes the manual's
ALL-CAPS defined term exactly. Foul lines name the ACT, not the place.

## 7. Definition of done, per merge into `biobuzz`

- **Visual proof**: `node scripts/shots.cjs --scene <ids>` run after the change, the PNGs
  Read by the chat that made the change, and the cells to look at named in the handoff.
  A visual change without a gallery cell is not done. A physics change without a scene
  and a human feedback dump acknowledging it is not done.
- `npm test` — no new failures vs the `alpha` baseline; every behaviour change has a check
  in `scripts/smoke-biobuzz/<lane>.ts`; every scene hashes deterministically.
- `npm run build`, `npm run server:check` green.
- `npm run uiaudit` green if any `.tsx`/`.css` changed; `npm run contrast` if any colour.
- Manual-derived numbers cite the figure/rule in a comment; guesses are marked `APPROX`.
- Handoff file updated (state, what landed, next steps, gotchas).
- First PR from a new contributor: `CONTRIBUTORS.md` line + the CLA sentence in the body.
