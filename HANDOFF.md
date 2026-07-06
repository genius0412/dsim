# HANDOFF — session ending 2026-07-05 (Phase C + Phase D landed; netcode needs live 2-tab test)

Read `CLAUDE.md` first (load-bearing rules), then this file. Master plan lives at
`C:\Users\geniu\.claude\plans\if-artifacts-are-scored-vivid-sphinx.md`.

## ✅ Current state: BUILD GREEN, `npm test` = 117 checks ALL PASS

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
1. **LIVE 2-tab verification of multiplayer** — the whole `src/net/` layer only build-
   verifies here (no browser/WebRTC/Supabase in this env). Follow the checklist in
   `docs/multiplayer.md`: needs a (free) Supabase project + keys in `.env`, then two
   `localhost:5173` tabs. Expect to find + fix real bugs on first run (signaling timing,
   ICE, presence races). Likely first suspects: mesh offer/answer glare (both peers
   offering), presence `sync` firing before `track`, DataChannel open ordering.
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
- `npm test` after ANY `src/sim`/`config`/`src/net` change (117 checks; the netcode
  foundation — protocol/lockstep/worldHash — is smoke-tested, the browser layer is not).
- `npm run build` before "done". Dev: `npm run dev`.
- Manual PDFs: WebFetch `ftc-resources.firstinspires.org/ftc/game/manual-NN`.
- PowerShell 5.1: no `&&`; Bash tool available for POSIX.

## Standing user instructions
- Write/refresh this HANDOFF at the END of every session.
- Product decisions in CLAUDE.md — do not regress. Physical models over scripted behavior.
- The user gives rapid, specific field/UX feedback and expects it addressed precisely; when
  a visual is wrong they'd rather you look at the real render than argue from the docs.
