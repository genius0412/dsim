# HANDOFF — session ending 2026-07-06 (human-player loading BOX)

Read `CLAUDE.md` first (load-bearing rules), then this file. Master plan lives at
`C:\Users\geniu\.claude\plans\if-artifacts-are-scored-vivid-sphinx.md`.

## ✅ Current state: BUILD GREEN, `npm test` = 137 checks ALL PASS

## 2026-07-06 session — human-player loading rework (box + grab row)

Replaced the old "drip stock into a vertical column" human-player restock with the real
DECODE layout. GUI-verified via Electron (solo match: red box 6 / blue box 3; free-drive
2v2: both boxes empty; each zone shows the 3-ball grab row).

- **Grab row** — the 3 pre-staged loading-zone artifacts (PGP, part of the real game) are
  now a **row along field-x** (`loadSlots` in `src/sim/field.ts` → `LOAD_COL_XS × LOAD_ROW_Y`
  in config). Field-x reads *vertical on the driver's rotated screen*, so a robot cycling
  the zone drives straight along x and sweeps all 3.
- **2×3 box** — the human player's off-field artifacts live in a drawn `2×3` box (capacity
  6, out of play): `loadBoxSlots(a)` (`LOAD_COL_XS × LOAD_BOX_YS`), drawn in
  `src/render/drawField.ts` (dark backing + frame + stored balls; box balls are NOT in
  `world.balls`, they stay off physics). It sits **OFF the field**, just beyond the
  audience wall with a slight gap (`LOAD_BOX_YS = [-77,-82]`, y < -FIELD_HALF) — the human
  player stands off-field. `HumanPlayerState.stock` → **`box`** (`src/types.ts`).
- **Box init scales with missing robots** — `hpBox(present)` in `src/sim/spawn.ts` =
  `[[...PRELOAD],[...HP_INITIAL_STOCK]].slice(present).flat()` → 2 robots → 0, 1 → PPG(3),
  0 → PGP+PPG(6, 4P+2G). (Old code wrongly gave a 0-robot alliance only 3.)
- **`updateHumanPlayers`** (`src/sim/humanPlayer.ts`) does two things per tick: (1)
  **CONTINUOUSLY grabs** a loose `ground` ball out of the loading zone into `hp.box`
  (recycling returned/overflow artifacts; skips balls staged at a grab slot and any a
  robot is on; gated by `box.length < 6`), and (2) **STAGES** the grab row from `hp.box`
  one artifact per `HP_PLACE_DELAY` when a slot is free. One-at-a-time keeps box +
  in-transit within the 6-out-of-play cap. `HP_PLACE_DELAY` cut 3 s → **0.35 s** (fast).
  In 2v2 the box starts empty, so the loop is fed entirely by recycled returned balls.
- `docs/decode-reference.md` Artifacts section updated. `scripts/smoke.ts` +9 checks
  (box counts by robot count, grab-row-along-x, box ≤ 6, pre-staged PGP still spawns).

## 2026-07-06 (earlier) — LIVE multiplayer desync fixed (cross-browser)

## 2026-07-06 session — LIVE multiplayer desync fixed (cross-browser)

Symptom reported: in live MP, "other people's robots are desynced, headings wrong,
everyone has different final scores, but NOTHING shows top-right (no DESYNC chip)."
Testers were **all web, different browsers**. Two bugs found + fixed:

- **ROOT CAUSE — non-deterministic transcendentals.** `Math.sin/cos/tan/atan2` are NOT
  spec-required to be correctly-rounded, so they differ by ~1 ULP **across browser
  engines/versions**. The sim calls `rot()` (cos/sin) every tick per robot/ball, plus
  atan2/tan in aim + `startPose` heading — so two different browsers fork within seconds,
  and the basin's gate RNG (`goal.ts` `nextRandom`) amplifies it into totally different
  games. FIX: added `dsin/dcos/dtan/datan2` to `src/math.ts` — built ONLY from `+ - * /`
  and `Math.round/sqrt` (all IEEE-754 exact ⇒ bit-identical everywhere). Accuracy vs
  `Math.*`: sin/cos 6e-12, atan2 2.7e-9. Routed ALL sim-path trig through them: `rot`
  (math.ts), `robot.ts` (solveShot/aimSolution/fire/updateIntake), `physics.ts:160`,
  `field.ts` `startPose`. **Rule: never use `Math.sin/cos/tan/atan2` in `src/sim/` or in
  shared helpers the sim calls — use the `d*` versions.** (`Math.sqrt` IS exact — keep it;
  that's why `hyp` already avoids `Math.hypot`.) Render/UI trig can stay on `Math.*`.
- **DESYNC DETECTOR WAS MASKING FAILURES** (why nothing showed top-right). `NetSession`
  had a single shared `peerHashes: Map<tick,hash>`; with >2 peers each peer's checksum
  OVERWROTE the others, so a match with a diverging peer + a matching peer compared
  against the matching one and missed it. FIX (`src/net/session.ts`): `peerHashes` is now
  `Map<peerId, Map<tick,hash>>`; `compareAt(tick)` flags a mismatch vs ANY peer, is
  sticky, `console.warn`s the exact first diverging tick, and prunes old hashes.

**Still non-deterministic (known, next):** the disconnect path (`session.ts:71`
`markDisconnected` → unilateral ZERO_CMD substitution at a per-peer wall-clock moment)
can silently desync on a real WebRTC drop. The `{t:'bye'}` control msg is defined but
never sent/handled. Proper fix = host broadcasts a deterministic "drop robot R at tick T"
so all peers drop on the same tick. Not hit by the cross-browser bug above, but do this
before shipping to flaky networks (STUN-only, no TURN).

### Lobby stability fixes (same session)
Reported: roster shows different counts per client / "more than 4" / leader keeps
switching. All are presence-set instability. Fixes:
- `Lobby.tsx` now renders the deterministic capped `keep` set (first `ROOM_CAPACITY`
  by joinedAt, peerId tiebreak) instead of the raw uncapped presence list — never
  shows >4, and all clients agree once presence converges.
- `lobby.ts` `peerId` is now **stable per tab** (`sessionStorage`), so a refresh
  replaces the same presence key instead of spawning a ghost under a new id (ghosts
  were the main churn: inflated counts + stole the earliest-joiner host election).
- `lobby.ts` presence dedup filters empty key arrays (an empty one threw the `reduce`
  and froze the whole roster).
- `hostStart` builds setups from the capped roster, not `getPlayers()` — a ghost/
  overflow presence can no longer spawn a phantom, undriven robot that stalls lockstep.

STILL imperfect (inherent): host = earliest `joinedAt`, which relies on wall clocks
(skew) and flickers if the earliest member's presence transiently drops. The fixes cut
the dominant churn (ghosts); a bulletproof host would need a heartbeat/consensus. Note
the reported "everyone in different positions in-game" is the SAME cross-browser desync
the deterministic-trig fix targets (not yet deployed) — distinct from normal lockstep
tick-skew (clients a few ticks apart look momentarily offset, self-corrects) and from
the per-alliance camera perspective (each side views mirrored).

### ⛔ REAL ROOT CAUSE (found after deploy): the NETWORK/TRANSPORT layer, not the sim
Deployed the deterministic-trig + detector + lobby fixes; live cross-browser test STILL
broke ("positions all weird"), AND — the key clue — **"a lot of the time at match start
everyone is at WAITING and the game is frozen."** That reframes everything:

- The sim IS deterministic (verified again: `physics.ts` collisions are all `+ - * /`,
  min/max/abs/round/sqrt, clamp, dot, `rot`, `datan2` — nothing engine-variant remains).
  Weird positions are collisions/RNG AMPLIFYING a divergence that entered elsewhere.
- `canStep(tick)` needs EVERY robot's command for that tick ⇒ needs an open DataChannel to
  every peer. The mesh is **STUN-only, no TURN** (`mesh.ts:12`). Across mixed browsers/NATs
  some pairs never connect ⇒ their commands never arrive ⇒ WAITING forever (frozen). A
  link that opens then DROPS hits `markDisconnected` → unilateral `ZERO_CMD` at a per-peer
  moment → that robot drifts differently per client ("weird positions"), UNDETECTABLE by
  the checksum (can't hash-compare with a peer you've lost). Same fragility, two faces.

**TRANSPORT FIXES — DONE this session (all 3 priorities), build-green, 128 smoke checks:**
1. **TURN** (`env.ts` `iceServers()`/`loadIceServers()`, used in `mesh.ts`). Free Metered
   Open Relay is the built-in DEFAULT (no signup) so NAT-bound peers relay out of the box.
   Overridable: (A) `VITE_TURN_ICE_URL` = a runtime endpoint that mints EPHEMERAL creds
   (secret-free, preferred — mesh fetches it on construction, falls back to sync default);
   (B) static `VITE_TURN_URL/USERNAME/CREDENTIAL` pair. Security: never a provider API
   *secret* in VITE (Vite inlines it); the static pair is client-side by nature (worst case
   bandwidth theft, quota-capped), ephemeral (A) avoids even that. `.env.example` documents it.
2. **Connection gate + timeout + status** (`mesh.ts` + `Lobby.tsx`). A link that doesn't
   open within `CONNECT_TIMEOUT_MS` (20 s) or hits ICE 'failed' now fires a `'failed'`
   event → per-peer dot in the lobby (open/connecting/NO CONNECT), and host START is
   DISABLED until every in-room peer has an OPEN channel (`allConnected`). No more silently
   starting a match that freezes at WAITING; a failed peer is shown so the host can kick.
   Failed links are retried after `RETRY_COOLDOWN_MS` (8 s) — replaced the permanent
   `attempted` block so a recovered network / reloaded peer reconnects.
3. **Deterministic disconnect** (`protocol.ts` `{t:'bye',robotId,tick}` + `session.ts`
   `onPeerGone`/`applyDrop` + `lockstep.ts` `dropAt`/`lastTickFor`/`dropTicks`). On a peer
   drop/fail the HOST authors ONE drop tick (just past the robot's last input, ≥ the sim
   frontier) and broadcasts it; every peer drops that robot at the SAME tick (ZERO from
   there). Ticks BEFORE it still REQUIRE the real input, so a peer missing it STALLS (safe)
   instead of silently ZEROing (which desynced). `markDisconnected` kept as `dropAt(id,0)`.

Now the deterministic-trig + detector + lobby-presence fixes (earlier this session) finally
get exercised on a connection that stays up.

**Known transport limitations (next):** if the HOST itself drops, non-hosts wait for a bye
that never comes → stall (no host migration in v1). Free Open Relay is best-effort/rate-
limited — for reliability the user should set `VITE_TURN_ICE_URL` (their own ephemeral
endpoint). Backfill packets cap at 255 ticks (Uint8 count) — fine given prune, but chunk
it if a late-join path is ever added.

## ✅ Prior state: Phase C + Phase D landed

All four phases (A markings, B robots/physics, C penalties, **D netcode**) are code-
complete and green. `npm run build` passes (106 vite modules). Everything is still
**uncommitted** working-tree changes (one big blob — commit when the user asks). New
runtime dep this session: `@supabase/supabase-js`.

## This session (two big things)

### Phase C — penalty engine (recap; see CLAUDE.md for the full rule list)
MINOR = **5 pts**, MAJOR = **15 pts** (user-set, not the manual's 10/30). Fouls are
**EDGE-TRIGGERED, NO cooldown** (user was emphatic): fire on false→true, once while
held, again immediately on re-entry. `src/sim/penalties.ts`, wired in `world.ts` after
the robot-robot solver. The gate is now physically openable by ANY robot (`updateGates`
dropped its alliance filter) and working the opponent's gate is a MAJOR foul.

### Phase D — netcode (NEW, `src/net/` — build-green, NOT yet live-verified)
WebRTC lockstep over a Supabase lobby. Files + roles are documented in
`docs/multiplayer.md` (also the manual 2-tab checklist). Key pieces:
- `protocol.ts` — quantize command → 4 B **at the producer**, and the producer steps
  the SAME dequantized value locally, so every peer's sim gets bit-identical inputs.
  Binary command packets (ArrayBuffer) + JSON control messages (start/restart/checksum/
  bye), told apart by JS type on the DataChannel.
- `checksum.ts` — `worldHash` (FNV-1a over rounded poses/balls/scores/rngState/tick).
- `lockstep.ts` — input-delay buffer, `INPUT_DELAY` 8 ticks; `canStep(tick)` gate;
  disconnect ⇒ that robot runs on ZERO_CMD.
- `lobby.ts` — `SupabaseLobby`: one Realtime channel per room code (presence +
  broadcast, no DB tables). Host = smallest peerId.
- `mesh.ts` — `RtcMesh`: full mesh ≤4, lower id offers, one ordered+reliable
  DataChannel, STUN only (no TURN v1).
- `session.ts` — `NetSession`: ties mesh+lockstep+host authority; the only net object
  `GameController` touches.
- `env.ts` — `supabaseConfigured()` / `getSupabase()` from `VITE_SUPABASE_URL/ANON_KEY`.

Integration: `GameController` takes an optional `session` (**null ⇒ solo bit-
identical**); the loop split into `stepSolo` (unchanged) and `stepNetworked`
(`produce → canStep → step → checkpoint`). MP match world is built from the host's
`matchStart{seed,setups}` and `startMatch`ed immediately at tick 0 — this is the
determinism seam (NO controller-local countdown/seed in MP; the old batch-step +
post-batch countdown would desync). Restart is host-authored. HUD gained `net`
(NET peers / WAITING · <driver> / DESYNC chips). UI: `App.tsx` now menu|lobby|game;
`Lobby.tsx` (room code, driver list, ready-up, host START); MULTIPLAYER menu button
shows only when `supabaseConfigured()`.

Also: **determinism hardening** — replaced `Math.hypot` with `hyp` (= `Math.sqrt(x*x+
y*y)`, engine-stable) across `src/sim/*` + `math.ts`. Smoke unchanged (values identical
at our magnitudes).

## ⚠️ NOT DONE / next steps
1. **RE-TEST live cross-browser MP** with the deterministic-trig fix — the reported
   desync should be gone. If a DESYNC chip still appears, the `console.warn("[net] DESYNC
   at tick …")` now names the first diverging tick — use it. Next suspect if so: the
   disconnect ZERO_CMD hole (above), or any remaining non-determinism the smoke can't see
   (the in-process determinism test can't catch cross-engine float drift — only a real
   two-browser run can). Signaling/ICE/presence-race first-run bugs may still exist.
2. `.env` is gitignored; `.env.example` documents the two vars. Vercel/Electron need the
   same vars set (baked at build time).
3. Deferred: TURN relay (cross-NAT), replays, obelisk AprilTags, mobile/touch, G408.

## Gotchas (this session)
- **Lockstep determinism seam**: any match-flow mutation OUTSIDE `step()` (countdown→
  startMatch) desyncs if applied at different ticks per peer. MP fixes this by starting
  the match at tick 0 from the host seed. If you add MP pre-match UI, DON'T gate stepping
  on it — keep it a non-authoritative overlay, or fold the transition into the sim.
- **Command frame** (still true from Phase C tests): `fieldCentric=false` ⇒ `driveY` is
  robot-forward along `heading`; field-centric is rotated per alliance.
- Broadcasts don't echo to self (`broadcast:{self:false}`) — the host must call its own
  `handleStart`/`applyRestart` locally (it does).
- Penalty point values are 5/15 and edge-triggered (no cooldown) — do not "restore" the
  manual's 10/30 or the old 2 s debounce.

## Verification & tooling
- `npm test` after ANY `src/sim`/`config`/`src/net` change (122 checks; the netcode
  foundation — protocol/lockstep/worldHash/deterministic-trig — is smoke-tested, the
  browser layer is not).
- `npm run build` before "done". Dev: `npm run dev`.
- Manual PDFs: WebFetch `ftc-resources.firstinspires.org/ftc/game/manual-NN`.
- PowerShell 5.1: no `&&`; Bash tool available for POSIX.

## Standing user instructions
- Write/refresh this HANDOFF at the END of every session.
- Product decisions in CLAUDE.md — do not regress. Physical models over scripted behavior.
- The user gives rapid, specific field/UX feedback and expects it addressed precisely; when
  a visual is wrong they'd rather you look at the real render than argue from the docs.
