# HANDOFF — 2026-07-10 (scoring-assessment TIMING per manual 9.x A–F) — READ FIRST

> **GREEN — `npm run build` + `npm test` (all checks, incl. two new ones) pass.**
> **Sim change in `src/sim` (`scoring.ts` + `match.ts`), no protocol/DB/config change,
> no `BALANCE_VERSION` bump.** Server-authoritative and identical everywhere, so a live
> redeploy is only needed if you want the Fly server running the new timing
> (`flyctl deploy --remote-only`). Determinism holds (pure functions of world state).

## What shipped this session — WHEN each score is assessed (manual rules A–F)

The manual specifies exactly when each score is locked in. Three of the six were being
assessed on the buzzer tick, before artifacts/robots came to rest. Fixed all three; the
sim already keeps stepping through the `transition` and post-match settle windows (solo
`stepSolo` + server), so the scores just needed to be (re)computed as things settle.

- **Rule A** (CLASSIFIED/OVERFLOW throughout, and *anything before TELEOP starts counts
  as AUTO*): `addClassified`/`addOverflow` now bucket `auto` **OR `transition`** as AUTO
  (new `scoredAsAuto` helper in `scoring.ts`). A ball that commits during the post-auto
  transition settle was previously mis-billed TELEOP. Everything from teleop onward
  (incl. the post-match settle) is TELEOP.
- **Rule B** (AUTO PATTERN at rest-after-auto OR teleop-start, whichever first): no
  longer snapshotted on the auto buzzer. `assessAutoPattern` (idempotent, no events) is
  recomputed every `transition` tick and **locked at TELEOP start** (that's where the
  `AUTO PATTERN +N` event now fires). A ball still in flight/on the rail at the auto
  buzzer is counted once it settles.
- **Rules C/D/F** (TELEOP PATTERN / DEPOT / BASE at rest-after-match): `assessMatchEnd`
  is now **idempotent** (base is reset + recomputed, not accumulated) and `stepMatch`
  calls it **every tick during phase `post`**, so late-draining ramp balls, still-rolling
  depot balls, and a robot coasting into its base during the settle window are all folded
  in; the value locks when motion ceases.
- **Rule E** (LEAVE at end of AUTO): unchanged behavior — split out into `assessLeave`,
  still called once on the auto→transition edge.

`assessEndOfAuto` is GONE (was leave+pattern in one); replaced by `assessLeave` +
`assessAutoPattern`. Only `match.ts` and `smoke.ts` referenced the scoring exports.

### Files touched
- `src/sim/scoring.ts` — `scoredAsAuto`; `addClassified`/`addOverflow` bucket by it;
  `assessEndOfAuto` → `assessLeave` + `assessAutoPattern` (idempotent); `assessMatchEnd`
  now resets `s.base` (idempotent, safe to recompute each tick).
- `src/sim/match.ts` — `stepMatch`: `post` recomputes `assessMatchEnd` each tick;
  `transition` recomputes `assessAutoPattern` each tick; auto-end calls `assessLeave` +
  seeds pattern; teleop-start locks the final auto pattern + fires the event.
- `scripts/smoke.ts` — imports `addClassified`/`addOverflow`; +2 checks: (1) an artifact
  scored in `transition` banks as AUTO; (2) BASE is re-assessed as a robot settles into
  base during the `post` window (0 at buzzer → 10 after it rests).

## Gotchas / notes
- `assessMatchEnd` is now safe to call repeatedly (idempotent). Smoke calls it directly
  on fresh worlds — still fine.
- Nothing gates balls by phase in `step()`, so they keep flowing/scoring in `transition`
  and `post` — that's what makes the deferred assessment work. Don't add a phase gate to
  ball physics or you'll re-break rules A/B/C/D.
- The `AUTO PATTERN +N` event now fires at TELEOP start (was auto end). Cosmetic (event
  log only).

## Prev session (still true) — gate "easier to open"
Ram-speed-scaled gate lift (`gateLiftRate`) + anticipated collider retract
(`gateColliderPos` → `buildGateArms`) so no 1-tick jolt. `GATE_OPEN_HOLD` 0,
`GATE_OPEN_RATE` 10, new `GATE_OPEN_RATE_SPEED`/`_MAX`. See git log for detail.
