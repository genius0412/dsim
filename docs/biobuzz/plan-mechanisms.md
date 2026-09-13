# BIOBUZZ modular mechanisms — the build plan (Lane B)

> **Superseded in part, 2026-09-12 night (owner feedback).** Read `HANDOFF-robot.md` → "READ
> FIRST — 2026-09-12, night" before trusting anything below. Three rulings changed the shape:
> - **No launcher-less builds.** `BbMechSpec.launcher` is never null. A stored `launcher: null`
>   migrates from the flat `scoreMode` mirror, so the "phantom turret" distinction this plan is
>   built around now only matters for migrating OLD saves.
> - **No drum.** The launchers are `turret` (POLLEN only), `twinturret` (two individual turrets,
>   `mount` POLLEN plus `mount2` NECTAR) and `dumper` (hood 70–85°, reaches the HIVE). A stored
>   `drum` folds to `dumper`.
> - **The lift is the OFFSET™ Box Tube: placement with NO raise.** No `maxZ`, no
>   `RobotState.bbLiftZ`, no hold-to-raise button. It mounts on a perimeter cell, places at
>   `bbPlacePointLocal`, and uses one edge-triggered button per element kind (`bbPlace` POLLEN,
>   `bbPlaceNectar` NECTAR on bit 32).

Approved 2026-09-12. Design chosen by a four-architecture judge panel; see
`HANDOFF-robot.md` for the alternatives and why they lost.

## The shape

One container field, two independently-optional named slots:

```ts
RobotSpec.bbMech?: { launcher: BbLauncherSpec | null; lift: BbLiftSpec | null }
```

`bbMech === undefined` ⇒ a legacy spec, migrate from `scoreMode`.
`bbMech.launcher === null` ⇒ this robot genuinely has no launcher.

Those two must stay distinguishable, because `src/sim/spawn.ts` writes `out.scoreMode`
unconditionally and defaults it to a turret — so "no launcher" spelled as an absent
`scoreMode` grows a **phantom turret** on the next coercion. That is the single fact the
whole design is shaped around.

## Settled calls (owner, 2026-09-12)

| question | ruling |
|---|---|
| default launch elevation | **35°** — a real launcher angle; re-shoot the firing scenes |
| a 5th chassis-fixed SEQUENTIAL launcher kind | **defer one increment** — it re-keys 26 gallery scene ids |
| placing into a FLOWER | **dedicated `bbPlace` button**, not a `fire`+raised mode |
| `RobotState.bb*` ownership | **on `RobotState`** (the `catalystRail` precedent); contract needs the row |

## Why a lift and a launcher are different mechanisms, not two flavours

- HIVE up-CELL opening: **53.5–65.6 in** above the tiles.
- R105 caps a robot at **29 in**.
- FLOWER top ring: **21.5 in**, a 4.0 in hole.

So the HIVE is **launch-only** and the FLOWER is **placeable**. `BB_R105_HEIGHT_CAP = 29` is a
single shared ceiling both mechanisms clamp against, which makes "a lift structurally cannot
reach the HIVE" fall out of arithmetic rather than a hand-written exclusion.

## Order of work

**Phase 1 — the spine (one author, serial).** Everything below depends on these types, and
they have to be one coherent design.

1. `src/types.ts` — `bbMech` on `RobotSpec`; `bbTurretPitch` / `bbLiftZ` on `RobotState`;
   `bbLift` / `bbPlace` on `RobotCommand`. ✅ done
2. `src/games/biobuzz/mechs.ts` (NEW, LEAF) — vocabulary, resolution, mount-clash. ✅ done
3. `src/games/biobuzz/config.ts` — the new constants (all `APPROX`, see Risks).
4. `src/games/biobuzz/coerce.ts` — validate, migrate, clamp, resolve the clash, mirror back.
5. `src/sim/spawn.ts` — **the carry-across.** The BIOBUZZ arm receives `out`, not the raw
   input, so a field no shared pass reads is already gone. Without this line the whole feature
   silently reverts on every load, every wire ingress and every `createWorld`. The trap is
   documented in full at `spawn.ts:473-484`; this is the first field to hit it.
6. `src/games/biobuzz/robot.ts` — the arc solve (`bbSolveShot(d, dh)`, target-height
   parameterised), turret yaw+pitch easing, per-archetype muzzle height, lift geometry.

**Phase 2 — the surfaces (parallel, one file-set each).** Independent once Phase 1 lands.

- **A. Builder** — `Builder.tsx`: launcher picker gains a NONE option, hood slider, lift
  block (kind, 9-cell mount, height). Zero new CSS: `.ds-opts` has `two`/`three`/`four`/
  `card4`/`fill`/`wide` and nothing else.
- **B. Sprite + preview** — `drawRobot.ts`, `RobotPreview.tsx`, `parts.ts`: draw a mast,
  draw a pitched barrel, draw nothing where a mechanism is absent.
- **C. Presets + labels** — `presets.ts`, `labels.ts`: express the four StarterBots through
  `bbMech` (Studica gets `launcher: null`, which is the whole point), and the strings.
- **D. Smoke + scenes** — `scripts/smoke-biobuzz/robot.ts`, `scenesRobot.ts`: coercion
  invariants, migration, clash resolution, arc reachability, one scene per mechanism.

**Phase 3 — integration (one author).** Gates, gallery re-shoot, screenshots, handoff.

## Invariants every phase must keep

- `coerceSpec` stays **idempotent** — `f(f(x)) === f(x)`; smoke asserts it.
- Every preset stays a **coercer fixed point**, or its card stops highlighting as selected.
- **The drawn mouths ARE the capture areas** — one geometry, three readers.
- No DOM, no clock, no `Math.random`, no `Date` in sim code.
- A new per-tick `RobotState` field is wire cost: `npm run costprobe` before claiming done.

## Cross-lane requests (file, do not edit)

1. **`src/net/protocol.ts`** — two `BTN_*` bits (`bbLift`, `bbPlace`) plus `localizeCommand`
   lines. The one sanctioned cross-lane edit; goes in `HANDOFF-robot.md`.
2. **`docs/biobuzz-contract.md`** — §4's dial table (still `(filled at T0+2h)`), a row for
   `RobotState.bb*` ownership, and the §3 aim signature, which must gain speed+angle:
   `bbAimHeading` returns yaw only and a turret shooting into a CELL 34 in above its muzzle
   needs pitch and speed too.
3. **Lane A, `elements.ts`** — its header still says `scoreTargets` is a stub. It is not, as
   of `bc733e1`.

## Risks

- **Every new number is a guess.** `BB_LIFT_*`, `BB_HOOD_*`, `BB_TURRET_PITCH_SLEW`,
  `BB_LAUNCH_PITCH_DEFAULT_DEG` have no hardware behind them. R105's 29 in and the FLOWER's
  21.5 in are real (Manual V1); the arithmetic on top is invented. The SHAPE should survive,
  the numbers will not — they need a gallery scene and a human verdict, not a passing check.
- **35° re-hashes every firing scene.** Deliberate, and it also unwinds the
  `BB_LAUNCH_Z0` height-vs-velocity conflation — but it owes a real re-shoot.
- **The mirror is lossy through an old peer, and once worse than lossy.** A launcher-less
  build mirrors to an absent `scoreMode`, and the old peer's own coercer then invents one.
  Rollout-window only, for a build class that could not previously exist — name it in the
  release note.
- **The clash is sized for TWO above-deck slots.** A third turns resolution order into a felt
  product decision. `bbResolveLiftMount` already takes a blocker list; the ordering policy
  does not exist and should not be invented before a third mechanism does.
