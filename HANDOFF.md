# HANDOFF — 2026-07-08 (session 6: classifier ball fix + connection-quality HUD) — READ FIRST

## Build state
GREEN. `npm test` = **190/190** checks pass (0 fail). `npm run build` (tsc strict + vite)
clean. `npx tsc -p tsconfig.server.json` (server) clean. main = alpha = beta, all pushed.
Fly (`dohun-sim-decode`) deployed, `/health` → ok. Vercel auto-deploys the client.

## What shipped this session

### 1. Ground balls can no longer mesh under the classifier (`src/sim/world.ts`)
Root cause: the hard geometric clamp for ground balls (`clampBallPosToStatics`) covered
walls + goal faces but NOT the classifier channel, so a ball that entered the channel and
became `ground` (e.g. a flight ball that landed inside before the flight-phase eviction
ran) had only Rapier for containment — and Rapier's soft contacts can't clear a DEEPLY
embedded body. It sat meshed and ungrabbable (the robot's intake OBB can't reach into the
channel). Fix: ground balls now get `collideBallRect(b, classifierRect('red'|'blue'))` in
the clamp loop — the same geometric eviction flight balls already use — pushing the ball
out the field side (the only valid exit). Tunnel-exit balls become `ground` at the channel
bottom edge already moving out, so they're unaffected. Smoke: "a ground ball meshed in the
classifier is evicted out the field side (grabbable)". **Invariant for the future:** any
new solid a ball can tunnel into needs a geometric clamp, not just a Rapier collider.

### 2. Connection-quality readout in the top-right HUD (multiplayer only)
So a laggy player can tell whether it's their link or the game. New `NetQuality` chip in
`GameView.tsx` (in the `.status-wrap` top-right cluster) shows `● 42ms · 30Hz · ±6ms`:
- **Ping** — new `ping`/`pong` protocol messages; the client probes once/sec, the server
  echoes the timestamp at the SOCKET level (`server/index.ts`, answers in lobby AND match),
  RTT = now − ts, EWMA-smoothed.
- **Hz** — snapshot arrival rate, measured client-side (target 30).
- **±jitter** — snapshot inter-arrival mean-abs-deviation. THE real choppiness signal.
- Coloured dot + SMOOTH/OK/CHOPPY bucket from rtt+jitter; tooltip spells them out.
- `NetStatus` (`src/net/session.ts`) gained `rttMs/snapHz/jitterMs/quality`; measured in
  `ServerSession` (ping loop cleared in `dispose`). Solo path unaffected (`net` stays null).

Commits: `d4f5552` (classifier), `32c1c76` (connection HUD). No Co-Authored-By trailer
(per user rule — commits must look hand-typed).

## Gotchas / notes
- **Deploy protocol for SIM or server changes** (BOTH the classifier fix and the ping
  handler needed it): commit on alpha → `git checkout main; git merge alpha --no-ff` →
  `flyctl deploy --remote-only` → `curl .../health` → Vercel auto-deploys client →
  `git branch -f alpha main; git branch -f beta main; git push origin alpha beta`.
- A sim-behaviour change shifts the deterministic worldHash, so OLD replays that hit the
  changed scenario (a ball in the classifier) won't re-verify identically. This session did
  NOT bump `BALANCE_VERSION` (a bump resets the whole leaderboard season) since the impact
  is a rare edge case — if strict record integrity is ever wanted, bump it deliberately.
- The connection HUD's RTT needs the SERVER ping handler deployed (it is). If you ever run
  against an old server, ping shows "—" / quality "MEASURING" but Hz+jitter still work.
- `ADMIN_USER_IDS` on Fly is what enables the admin menu + scheduled-restart notices; once
  set, FUTURE deploys can warn players first instead of dropping matches cold.

## Next steps (user's stated TODO — in order)
1. **Penalty hitbox audit.** The foul RULES are correct (Phase C). Re-verify the trigger
   GEOMETRY against the manual figures: `gateZone`/`gateTapeSegments`, `tunnelStrip`,
   `allianceArea` (loading/base), `pinnedAgainstWall` slop, and the SAT contact test that
   fills `rrContacts` — confirm the trigger VOLUMES match the real markings + bumper
   extents, not just the rule logic. Add smoke cases per zone. (Extract manual Section 11
   figures with the scratchpad `extract-imgs.cjs` pattern and Read them as images.)
2. **Major intake revamp.** Substantial rework of the intake model (presets sloped/vector/
   triangle, capture band, trapezoid mouths, geometric side-intake rules, clump feeding).
   Product decision #10 in CLAUDE.md is the CURRENT baseline to improve on — preserve the
   user-named presets + the side-intake feel unless the user redirects. Re-smoke capture
   after any change; `src/sim/physics.ts` (`robotExtents`, capture) + `robot.ts`
   (`updateIntake`) + the preset defs are the surface.

## Doc state
`CLAUDE.md` State-of-play updated (Phase 1 = 30 Hz + interpolation not 60 Hz/extrapolation,
connection HUD, Phase 3 core LIVE, ball-containment invariant, "Next up" section, smoke
count 190). `docs/netcodeplan.md` marked Phase 0/1/2-robots/3-core done + connection
indicator done. `docs/decode-reference.md` (field geometry source) is unchanged and still
accurate.
