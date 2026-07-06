# HANDOFF — session ending 2026-07-06 (multiplayer desync root-caused + fixed: deterministic trig)

Read `CLAUDE.md` first (load-bearing rules), then this file. Master plan lives at
`C:\Users\geniu\.claude\plans\if-artifacts-are-scored-vivid-sphinx.md`.

## ✅ Current state: BUILD GREEN, `npm test` = 122 checks ALL PASS

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
