# HANDOFF — 2026-07-07 (session 5: penalty engine corrected to the manual) — READ FIRST

## Build state
GREEN. `npm test` = 183/183 checks pass (0 fail). `npm run build` (tsc strict + vite)
clean.

## Latest addition — G417 / G418 gate-and-ramp fouls (`updateGateFouls` in penalties.ts)
- **G417** — operating an OPPONENT's gate = immediate **MAJOR** (edge-triggered via the
  `fire` episode debounce). Detected with updateGates' lever condition (in the gate zone,
  field side), filtered to the owner's opponents. Operating your own gate is legal.
- **G418.B** — each classified (committed, non-overflow) artifact that leaves an
  opponent's RAMP because you opened their gate = **MAJOR per artifact**.
- Attribution: `penalties.gateCulprit[goal]` records which opponent opened each gate
  (set while they operate it, held through the drain, cleared when the gate shuts);
  `penalties.rampBallIds[goal]` tracks the ramp's committed balls tick-to-tick, and every
  departure while a culprit is set bills that opponent. Matches manual Example 3 (open
  the opponent gate → 1 G417 + N G418; smoke verifies blueMajor == N+1).
- Two new `PenaltyState` fields (`gateCulprit`, `rampBallIds`) — plain JSON, init in
  spawn.ts. Note `updatePenalties` runs BEFORE this tick's `updateGates`/`updateRails`
  (world.ts), so it observes end-of-previous-tick gate/ball state — consistent for the
  cross-tick ramp-departure comparison.
- G417 co-occurs with G424 whenever an opponent is in your gate zone (robots are wide,
  the gate zone is 10"); that's realistic. Smoke isolates G424 (owner defends its own
  gate, opponent contacts from the field side clear of the zone) and G417 (operate the
  gate, no contact needed) with direct `updatePenalties` calls.

## What was done — Section 11 penalty fixes (`src/sim/penalties.ts`)

The user reported: **AUTO interference and pinning fouls went to the WRONG alliance**,
and **gate/secret-tunnel rules didn't follow the manual**. I pulled the actual
Competition Manual Section 11 (text extracted from the PDF via scratchpad `extract.cjs`)
and fixed:

1. **G402 AUTO interference — was inverted (WRONG ALLIANCE).** It keyed "own side" off
   `driverSide`, but robots stage near their cross-court GOAL (`startPose` uses
   `goalSide`), so an alliance's own side is its **goalSide** (blue −x, red +x, matching
   G304.C start columns). The old code fired when a robot sat on its OWN side. Now uses
   `goalSide`; fires only when a robot is fully on the OPPONENT's side + contacting an
   opponent, fouling the crosser.

2. **G422 pinning — both orderings fired (WRONG ALLIANCE).** In a wall shove both robots
   are slow + commanding motion, so it accumulated a pin for (A pins B) AND (B pins A),
   fouling the victim's alliance too. Added `pinnedAgainstWall(pinner, pinned)`: the
   victim must be trapped against a field boundary with the pinner on the open-field side
   (leading corner within `PIN_WALL_SLOP` (config, =3") of the perimeter). Only the real
   pinner is fouled now.

3. **Gate — replaced homebrew rule with manual G424.** Deleted the "presence in the
   opponent's gate = MAJOR (no contact)" rule (not in the manual) and the mislabeled
   "G428 gate zone". New **G424** = MINOR, contact-based, protects the gate OWNER's
   access to their own gate. Opening a gate is still legal (`updateGates` unchanged) —
   only in-zone *contact* fouls.

4. **Unified all contact-pair zone rules** (G424/G425/G426/G427) into one by-owner loop:
   each zone is owned by an alliance; a cross-alliance contact while either robot is in
   it fouls the non-owner. Also fixed a completeness gap — an INVADER in the owner's
   loading/base zone now fouls (old code only checked "victim in its own zone").

5. **G424↔G425 mutual exclusivity (G424.A exception).** A side wall holds one alliance's
   gate zone AND the other alliance's secret tunnel (overlapping in the classifier
   corner). Two fixes so exactly one rule fires:
   - **G425 now fouls only when the INTRUDER (non-owner) is in the strip.** Previously it
     fired if EITHER robot was in the tunnel, so an owner *defending in its own tunnel*
     wrongly drew a tunnel foul on the opponent.
   - **G424 exception:** if the gate robot is ALSO in the opponent's tunnel, skip the gate
     foul (G425 governs). Result: gate-robot-in-both → G425 only (on the gate robot);
     gate-robot-clear-of-tunnel → G424 only (on the opponent). Two smoke tests
     (`updatePenalties` driven directly with a forced contact) lock both cases.

Files touched: `src/sim/penalties.ts`, `src/config.ts` (`PIN_WALL_SLOP`),
`scripts/smoke.ts` (gate test → G424 MINOR/contact; G402 test → opponent side + own-side
negative; pinning → asserts victim alliance NOT fouled), `CLAUDE.md` (Phase C rewritten).

## Gotchas / notes
- Goals are CROSS-COURT. Blue goal + blue gate zone + blue AUTO start are all on −x
  (left, red's drive wall); blue drive team / loading / base are on +x. `tunnelStrip(a)`
  sits on `goalSide(a)` but is OWNED by `other(a)`.
- Deferred (unchanged): G423 (completely blocking opponent's gate — needs "blocking" +
  duration judgment), G408 possession/plowing, G402.B pre-staged artifact displacement.
- Manual Section 11 text dump lives at scratchpad `m11.txt` (regenerate with
  `extract.cjs` on a re-downloaded `manual-11` PDF if needed).

## Next steps
- None outstanding for penalties. Optionally model G423.D (blocking the opponent's gate)
  later — it needs duration + "completely blocking" heuristics.
- Not verified at the GUI surface this session (pure sim/logic change, covered by smoke).
