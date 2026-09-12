# `npm test` baseline — the gate for the BIOBUZZ work

**The gate is GREEN.** Not "no new failures against a list" — green.

That is a change, and it is the whole point of this file. The BIOBUZZ Phase 0 work was
measured against a recorded list of 7 accepted failures, because `npm test` on `alpha` was
not green and a refactor could not be asked to fix DECODE's contact physics. `alpha` has
since landed the artifact-collision rewrite and **all seven are fixed**. There is no
accepted-failure list any more. Any `FAIL` line is a regression.

```bash
npm test                       # BOTH suites; must print ALL PASS twice
npm test 2>&1 | grep '^FAIL'   # must print nothing
```

## The measurement

| | |
|---|---|
| `alpha` SHA | **`4c4ab277dd10487b72fbbd0e495949b5df8b6d54`** (`sim: a shoved artifact stops like foam on tile, not like a ball bearing`) |
| merged into | `biobuzz` at `d9f9e57`, then `biobuzz-core` (`a51ba62`) and `biobuzz-shell` (`ac27349`) |
| `npm test`, suite 1 (`scripts/smoke.ts`) | **1308 PASS, 0 FAILURES** — `ALL PASS` |
| `npm test`, suite 2 (`scripts/smoke-biobuzz/index.ts`) | **349 CHECKS, ALL PASS** |

## `npm test` runs BOTH suites now, and that is the news

`"test": "tsx scripts/smoke.ts && tsx scripts/smoke-biobuzz/index.ts"`. The `&&` is
deliberate — a red first suite must keep meaning "the physics broke" — and for the whole of
Phase 0 it also meant the BIOBUZZ suite **never ran under `npm test` at all**, because the
first suite always exited non-zero on the seven. That footgun is gone: the chain reaches the
second suite, and a `npm test` that prints `ALL PASS` has now genuinely proved both.

`npm run test:bb` stays, as a convenience — it is the fast loop while working inside
`src/games/biobuzz/` (a few seconds against a couple of minutes) and it is the only way to
run the BIOBUZZ suite when the first one is red for an unrelated reason. It is no longer the
only way to run it *at all*.

## The seven that used to be here

For the record, because three separate handoffs argue about them. All in DECODE contact
physics, all recorded on 2026-09-09 against `alpha` `3054f59c`:

1. `a robot resting against something does not turn while the driver does nothing`
2. `...and how far grows with how far off centre you hit it, without ever spinning you round`
3. `a SIDE hit on the gate arm turns the robot INTO the corner`
4. `...and a closed arm gives where one at its stop does not`
5. `ramming a wall at speed never snaps the chassis round — it squares it`
6. `an OFF-CENTRE ram spins the robot it lands on`
7. `an artifact pinned in the doorway settles instead of buzzing back and forth`

They were fixed on `alpha`, not here: the pin/eviction model was rewritten (`solveBalls` →
`solveArtifacts`, `robotSolids` as the one geometry authority, the two-solve round loop in
`world.ts`). Nothing in the BIOBUZZ branches touched `src/sim/`.

## The one thing that did NOT clear

`solveArtifacts` hard-codes `C.BALL_RADIUS` (2.5", DECODE's artifact) for the ball collider,
the speed cap and `robotSolids`' held-artifact circles. BIOBUZZ's POLLEN is 1.5". The
`'rapier'` arm of `BB_BALL_SOLVER` therefore separates pollen at the wrong diameter — it
conserves count and stays in bounds (both are asserted), but a pile settles looser than it is
drawn. The default arm (`'bespoke'`) uses `BB_POLLEN_R` and is unaffected. This is the P0.5
solver-comparison caveat, it costs a shared-core change (`src/sim/physicsEngine.ts` +
`src/sim/artifactSolids.ts`) that no lane owns, and it is not a test failure — see
`src/games/biobuzz/play.ts`'s header and the root `HANDOFF.md`.
