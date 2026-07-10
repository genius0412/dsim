# HANDOFF — 2026-07-10 (merge low-poly UI into alpha) — READ FIRST

> **GREEN — `npm run build` + `npm test` (363 checks) both pass; GUI verified in
> Electron.** No sim-core change this session → **no server redeploy needed.**

## What shipped this session — low-poly UI merge

Merged `origin/low-poly-ui` (the 4-commit low-poly design-system retheme: `theme.ts`,
`shell.css`, `NavRail`/`HomeMenu`/`ModeSelect`/`Configure`/`Records` shell, dark mode +
accessibility) **into alpha** (which had the gate-lever, G408, drivetrain, netcode, and
start-position/role-swap work). Branches diverged at `2cadad7`; 16 files overlapped.

- **Conflicts resolved (4 files):** `App.tsx` (kept alpha's `beginSession`
  one-game-per-user + `blockedByActive` overlay, adopted low-poly's `navigate('modes')`
  IA + `startBlocked`/comment), `AppShell.tsx` (dropped the old header nav — low-poly's
  side `NavRail` replaces it), `ReplayView.tsx` (both imports), `HANDOFF.md` (took ours).
  `config.ts` auto-merged (kept alpha's `BALANCE_VERSION = 3`). `Home.tsx`→`ModeSelect.tsx`
  rename carried alpha's rejoin banner across cleanly.
- **New dep:** low-poly added `@fontsource-variable/plus-jakarta-sans` + `space-grotesk`
  → **run `npm install`** after pulling. The **Electron build needs `ELECTRON=1
  npm run build`** (relative asset base) or the file:// bundle 404s to a blank page.
- **Design-system audit of alpha-new UI** (`RoleSwapBar`, `StartPositionEditor`, the
  ModeSelect rejoin banner — none of which low-poly ever rethemed): they already used
  the `--ds-*` tokens from the `2cadad7` base, so they inherit the retheme + dark mode
  for free. Fixed three gaps in `shell.css`: added the missing `.ds-btn.small` keycap
  variant (used but never defined → buttons rendered full-size), `--ds-font` →
  `--ds-font-ui` (low-poly renamed it), and start-position status/inputs now use
  `--ds-font-mono` (Space Grotesk) instead of raw `ui-monospace`. Verified in Electron:
  home, Configure/Robot, Configure/Match (start-position editor), and Play/ModeSelect
  all render coherently in the low-poly dark theme.
- **Backup branch:** `alpha-pre-lowpoly-merge` (pre-merge alpha HEAD, `a0cb653`).

Known-benign: `.ds-section` (Admin.tsx only) has no CSS rule on ANY branch — a plain
unstyled wrapper with an inline `maxWidth`; left as-is (pre-existing, admin-only).

---

## Prior session — G408 over-possession / plowing penalty

> **GREEN (build + smoke both pass, 363 checks).**
> **SIM-CORE change** (`src/sim/penalties.ts`, `src/types.ts`, `src/sim/spawn.ts`,
> `src/config.ts`) ⇒ a server running matches should **`flyctl deploy --remote-only`**
> to stay in sync. The new `PenaltyState.possession` map is plain JSON and rides
> `slimWorld`/`unslimWorld` snapshots fine (penalties pass through whole), so a stale
> server is not a correctness hazard — it just won't assess G408 until redeployed.
> No `BALANCE_VERSION` bump (new foul rule, not drivetrain/scoring calibration).

## What shipped this session

Added the **G408 over-possession / plowing** penalty (was on the deferred list in
`penalties.ts` and the CLAUDE.md roadmap). A ROBOT may CONTROL at most
`POSSESSION_LIMIT` (= 3 = `HOPPER_CAPACITY`) artifacts at once; controlling more past a
short grace draws a MINOR foul on the offender's alliance (→ +5 to the victim), via the
same `awardFoul` path as every other rule.

### How "control" is counted (`controlledArtifacts` in `penalties.ts`)
- **Stored:** `r.hopper.length` (the hopper mirror of held balls) — caps at 3.
- **Plowed:** loose `kind: 'ground'` balls whose surface is within
  `POSSESSION_CONTROL_MARGIN` (1.5") of the robot's collision footprint
  (`closestPointOnRobot`) **while the robot is moving** (`|vel| >=
  POSSESSION_MOVE_SPEED` = 5 in/s). Motion is required so a parked robot merely
  resting against loose balls isn't "controlling" them (they can roll free).
- Only `ground` balls count as loose — flight/basin/rail/held-by-others are excluded,
  so held balls are never double-counted.

### Firing (`updatePossession`)
Per robot, a per-id second-accumulator (`PenaltyState.possession[id]`): while
`controlled > POSSESSION_LIMIT` it ticks up, and once it passes `POSSESSION_GRACE`
(**0.35 s** — user asked for a short grace) it `fire()`s `G408 over-possession`
(MINOR). Dropping back to the limit resets the clock to 0. The grace is comfortably
longer than any intake capture (all presets' `capMax`/`clumpInterval` are < 0.2 s), so
driving through a clump to *collect* it never trips the foul — only sustained
plowing/hoarding does. Re-arm after firing uses the shared `PENALTY_CLEAR` episode
debounce (one foul per over-possession episode; release and re-offend fouls again).

### Why MINOR
Consistent with the other control/zone violations (G422/G424/G425/G426 are MINOR).
The manual groups G408 with plowing as a control violation, not a game-breaking act.
If you later want a MINOR→MAJOR escalation on repeat (like G422), mirror the
`pinFouls` pattern with a per-id committed counter.

## Files touched
- `src/config.ts` — `POSSESSION_LIMIT`, `POSSESSION_CONTROL_MARGIN`,
  `POSSESSION_MOVE_SPEED`, `POSSESSION_GRACE` (in the fouls block, after `PIN_WALL_SLOP`).
- `src/types.ts` — `PenaltyState.possession: Record<number, number>`.
- `src/sim/spawn.ts` — init `possession: {}` in the penalties block.
- `src/sim/penalties.ts` — header doc updated (moved G408 out of "deferrable" into the
  modeled list), `updatePossession` + `controlledArtifacts`, wired after `updateGateFouls`.
- `scripts/smoke.ts` — 4 new checks: over-limit-moving fires; parked-touching does not;
  full-hopper-at-limit is legal; briefer-than-grace does not fire. (+2 config imports.)

## Verify
- `npm test` → ALL PASS (363 checks).
- `npm run build` → green.

## Gotchas / notes
- `updatePenalties` still early-returns outside `auto`/`teleop`, so G408 only assesses
  during live play (correct — no possession rules pre-match/transition).
- The move-speed gate reads **actual `r.vel`** (post-solver), robust whether or not a
  blocked robot's velocity was zeroed — same choice the pin accumulator makes.
- Deferred fouls remaining: G423 (shutting down major gameplay / completely blocking a
  gate — needs duration+"completely" judgment), G402.B (displacing pre-staged spike
  artifacts). Everything else in Section 11 is modeled.

## Next up (unchanged from roadmap)
1. Penalty hitbox audit — re-verify each rule's ZONE GEOMETRY against the manual figures.
2. Balls → Rapier (Phase 2 slice 2, deferred — keep basin/rail/gate scripted).
