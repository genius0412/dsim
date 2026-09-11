# `npm test` baseline — the gate for the BIOBUZZ Phase 0 work

The Phase 0 shared-core generalization is a **refactor**: `decode` and `chain`
behaviour must come out byte-identical. `npm test` on `alpha` is NOT green, so the
gate cannot be "green" — it is **"no NEW failures against this list"**.

Recorded by the P0-core chat on **2026-09-09**, on an UNTOUCHED
`biobuzz-core` worktree (no edits of mine in the tree), i.e. the state of `biobuzz`
as branched from `alpha`.

- `alpha` SHA: **`3054f59c7518b75ce1ed339618e203bd785a631c`** (`sim: the artifact eviction
  may only undo the robot's own advance`)
- `biobuzz-core` HEAD at measurement: `20e65a4` (docs only, three commits of plan/prompt
  documents on top of that same `alpha` commit — no code differs from `alpha`)
- Command: `npm test` (`tsx scripts/smoke.ts`)
- Result: **1289 PASS, 7 FAILURES**

`node_modules` did not exist in this worktree; `npm install` was run first. That is
the only thing done to the tree before the measurement.

## The 7 baseline failures (all DECODE contact physics)

Verbatim, in the order the suite prints them:

1. `a robot resting against something does not turn while the driver does nothing` —
   worst idle turn over four resting poses: 2.44deg (the gate turned 359.6 on its own)
2. `...and how far grows with how far off centre you hit it, without ever spinning you
   round` — tunnel side 3/7/10/6deg vs channel side 0/0/0/0deg
3. `a SIDE hit on the gate arm turns the robot INTO the corner` — driving at the wall
   from y = -12/-9/-6/-3: turned 0/0/23/2deg toward the gate
4. `...and a closed arm gives where one at its stop does not` — pinned shut it turns the
   robot 27.1deg, at its stop 23.2deg
5. `ramming a wall at speed never snaps the chassis round — it squares it` — worst 5.5deg
   in one tick, peak spin 3.35 rad/s
6. `an OFF-CENTRE ram spins the robot it lands on` — 2in→-0.7° 4in→-1.3° 8in→-2.9°
   12in→-6.7°
7. `an artifact pinned in the doorway settles instead of buzzing back and forth` — worst
   25 reversals in the last 2s, peak 238.5 in/s

These are the same seven the 2026-09-07 HANDOFF describes (it lists eight; #2 of that
list, the gate-arm off-centre turn profile, has since been split/renumbered by the suite —
the CLUSTER is identical and all seven are `src/sim` contact physics, which Phase 0 does
not touch).

## How to re-check

```bash
npm test 2>&1 | grep '^FAIL'
```

Any FAIL line not in the list above is a NEW failure and fails the gate.
