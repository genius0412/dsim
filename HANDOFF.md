# HANDOFF — 2026-07-11 (driver assists → PER DRIVETRAIN; prev: replay version gate + duo record sign-in) — READ FIRST

> **GREEN — `npm run build` (tsc strict + vite) and `npm test` (~205 checks) pass. CLIENT-ONLY change (no server/ or protocol edit) → Vercel on push, NO Fly deploy.**

## Latest — driver assists are now remembered PER DRIVETRAIN (was per-user)

Field-centric/robot-centric + aim assist + auto intake + auto fire are now saved **per
drivetrain**, not as one global. New default per drivetrain: **robot-centric, aim/intake/fire
all ON** — EXCEPT **swerve, which defaults field-centric** (so the Cypher swerve preset loads
field-centric out of the box, every other preset robot-centric). Design: keep the ACTIVE
`assists` as the resolved config that spawns + goes on the wire (no protocol change), add a
LOCAL per-drivetrain library that persists + account-syncs — mirrors the `savedStartPoses`
pattern.

- `src/types.ts` — `GameSettings.assistsByDrivetrain: Record<DrivetrainType, AssistConfig>`.
- `src/sim/spawn.ts` — `defaultAssistsFor(d)` (swerve ⇒ field-centric, else robot-centric, all
  auto ON) + `defaultAssistsByDrivetrain()`. **`DEFAULT_ASSISTS` deliberately UNCHANGED** — it
  stays the neutral sim/wire/replay/dummy/**smoke** fallback (auto OFF); only the player-facing
  menu default moved. Don't conflate the two.
- `src/settings.ts` — `defaultSettings()` sets active `assists = defaultAssistsFor(DEFAULT_SPEC
  .drivetrain)` (mecanum) + the full library. `coerceSettings` coerces spec FIRST, then each
  drivetrain slot, then active assists (base = the spec-drivetrain slot). Migration: an old save
  with no `assistsByDrivetrain` seeds the active drivetrain's slot from its stored active assists.
- `src/ui/Menu.tsx` — new `applySpec(next)` helper swaps active assists to `assistsByDrivetrain
  [next.drivetrain]` whenever the drivetrain CHANGES; `setSpec`, the drivetrain buttons, saved-
  robot loads, and ROBOT_PRESETS cards all route through it. `setAssist` writes active + the
  current drivetrain's slot. Drive-style/assists UI stayed in the ROBOT menu (per-drivetrain =
  a build property, so NOT moved to Controls). Added a "Saved per drivetrain (…)" hint.
- No smoke change needed (DEFAULT_ASSISTS unchanged; UI/settings only).

Note: `tankControlMode` was left as-is (tank-only already ⇒ effectively per-drivetrain).

## Prev — replay "older version" false-positive + duo one-name records (both SERVER-only)

Two bug fixes, both entirely server-side (client `ReplayView` gate + `Leaderboard`
partner rendering were already correct). Deployed via `scripts/announce-deploy.sh`
(5-min player warning). Migration `0012` runs at server boot.

### 1) Replays read as "recorded on an older version" when they weren't
- ROOT CAUSE: `persist.ts` overwrote `o.replay.balanceVersion` with the DB **season**
  (`currentSeasonNumber` = `max(seasons.balance_version, code BALANCE_VERSION)`), but the
  playback gate (`src/ui/ReplayView.tsx:51`) compares it to the client's compiled
  `BALANCE_VERSION`. An **admin season bump** (no physics change) pushes the season past
  the code version → `4 !== 3` → false "older version (Season 4)".
- FIX: keep the **season** on `replays.balance_version` (purge-by-season + its 0004 index),
  store the real **sim-code version** in a new `replays.sim_version` column (migration
  `0012`), and gate on THAT. `saveReplay(replay, season)` now takes the season separately
  (persist no longer clobbers `replay.balanceVersion`); `getReplay` returns
  `sim_version ?? balance_version`.
- BACKFILL (`0012`): `sim_version = least(balance_version, 3)` — 3 = current `BALANCE_VERSION`,
  the highest REAL physics version, so season-bumped replays (stamped >3) become watchable
  again while genuine v1/v2 replays stay correctly gated. **If BALANCE_VERSION later bumps
  for a real physics change, that hardcoded 3 in the already-applied migration is fine (one-time
  historical backfill); new replays get their true version via `saveReplay`.**

### 2) Duo record runs showed only one user
- The whole pipeline (DB `partner_id`, API `partnerId/partnerHandle`, `Leaderboard.tsx:345`)
  is correct. `persist.ts` only credits a partner that is **authed** (`partner = authed[1]`),
  so a **guest** second driver saved a one-name record.
- FIX: `room.ts` `startMatch` refuses to start a **duo record** until every client has a
  `userId` (broadcasts an `error`, same backstop shape as the illegal-start-pose check).
  `LobbyPlayer` does NOT expose auth status, so there's no client-side pre-check yet — the
  server error surfaces in the Lobby (kicks to its error screen). A nicer client hint would
  need a protocol field on the roster (deferred).

**DEPLOY (this session):** committed on main (`baa7de0`) → `scripts/announce-deploy.sh "…" 300`
(announce fired: `notified:2`) → `fly-deploy.sh` → `/health`. No client rebuild needed
(server-only), but Vercel will still pick up main.

## Prev — balance: swerve accel/weight + per-intake minimum widths

- **Swerve** (`config.ts`): `accelMult` 1.30 → **1.32**, base min weight (`DRIVETRAIN_LIMITS.swerve.minMass`) → **21.5** lb. Tuned so a min-weight / max-inertia / 500rpm swerve just OUT-accels the equivalent mecanum (~1.7%); at equal weight swerve is clearly ahead (1.32 vs mecanum 1.12). Smoke pins the corner comparison. (Peak accel ~317 in/s².)
- **Per-intake MIN WIDTH** (`INTAKE_PRESETS[*].minWidth`, applied in `drivetrain.ts` `widthLimits`): sloped **14.5"**, triangle **15.5"**, vector **10"** (`ROBOT_MIN_WIDTH`). The width floor is now `max(drivetrain floor, intake floor)` — so swerve+triangle = 15.5, mecanum+vector = 10. All 5 `ROBOT_PRESETS` + `DEFAULT_SPEC` already clear the new floors.

## Prev — swerve minimum width 13.5" · vector intake spans the chassis width

Two builder/intake tweaks (both `src/sim`+`config`, so they change SERVER behavior too → deploy client+server together).

### Swerve minimum width = 13.5"
- `config.ts` `SWERVE_MIN_WIDTH = 13.5`. `drivetrain.ts` `widthLimits(intake, drivetrain)` now floors swerve at 13.5" (others `ROBOT_MIN_WIDTH` 10").
- `spawn.ts` `coerceSpec` REORDERED: resolve intake + drivetrain BEFORE the size clamps (width's floor now depends on drivetrain). `Menu.tsx` slider passes `spec.drivetrain`. Smoke: swerve clamps up to 13.5, non-swerve stays 10.

### Vector intake width = chassis width (NO overhang)
- `config.ts` `intakeMouth(spec)` helper: VECTOR `mouthHalf = spec.width/2` (mouth spans the full frame); sloped/triangle keep their fixed funnel mouth. Routed ALL per-robot mouth-width reads through it: `robot.ts` (capture), `physics.ts` (ball collision), `render/drawRobot.ts`, `ui/RobotPreview.tsx`. Vector preset `overhang:false` (that flag is doc-only — never read in code; real overhang was `mouthHalf > half`).
- **Reverses product-decision #10's "chassis may be narrower than the intake" for VECTOR** — the overhang flank-grab is GONE (mouth == frame). Updated the two smoke tests that pinned it (now: mouth = width/2 rule; "captures at the front only, never the flank"; edge/center uses localY 6 since width-14 mouth half is now 7). `CLAUDE.md` #10 not yet reworded.

**DEPLOY:** committed on alpha → `flyctl deploy` (announce first) → Vercel auto-deploys. Client+server MUST match (shared capture physics; a mismatch desyncs multiplayer).

---

## Prev — ranked drivetrain split dropped (records keep theirs) · no server auto · duo shows both drivetrains

### 1) RANKED (ELO) no longer divided by drivetrain — RECORD boards UNCHANGED
Scope correction mid-session: the user wanted the drivetrain split gone from **ranked
only**, NOT from the record leaderboards. Ranked collapses to one rating per **(user ×
mode × season)**; the record boards KEEP their per-drivetrain buckets (+ the mixed-duo
`'overall'` bucket) exactly as before.
- **DB migration `server/db/migrations/0011_drop_drivetrain_boards.sql`** (DESTRUCTIVE, runs at
  server boot via `migrate.ts`) — ELO ONLY: `delete from elo_ratings where drivetrain <> 'overall'`,
  drop the `drivetrain` column + it from the PK + `elo_board_idx` (recreated de-keyed). `records`
  and `match_participants` are left fully intact.
- **`server/ranked.ts`** — `EloParticipant` lost `drivetrain`/`drive`; `computeGlicko` writes ONE
  update per player (no `board` field). `persistVersusMatch` reads/writes one rating per (mode,season).
- **`server/db/repo.ts`** — the ELO fns (`getRating`, `getRatingFull`, `upsertRating`,
  `eloLeaderboard`, `eloUserStanding`) + `getUserStats`'s elo query dropped the drivetrain
  param/filter. The RECORD fns (`submitRecord`, `recordLeaderboard`, `personalBest`, `recordRank`,
  `adminListRecords`) + the match-history record branch STILL carry drivetrain (unchanged).
- **`server/persist.ts`** — records still compute `drivetrain` (solo/matched-duo = that drivetrain,
  mixed duo = `'overall'`); only `persistVersusMatch` (ranked) lost it. `api.ts` `/api/elo` dropped the
  drivetrain param; `/api/records` kept it. `matchmaking.ts` `getRating` call updated.
- **Client**: `src/net/api.ts` — `fetchElo` lost its `Board` arg; `fetchRecords`/`adminFetchRecords` +
  the `Board` type KEPT. `src/ui/Leaderboard.tsx` — the Drivetrain segmented picker now renders for
  **records only** (`{isRecords && …}`); ranked shows no picker. `Admin.tsx`, `GameView.tsx`
  `RecordStanding`, `protocol.ts` `RecordRankInfo.drivetrain`, `Lobby.tsx` record copy — all UNCHANGED
  (reverted to HEAD). `Matchmaking.tsx` ranked copy + `config.ts` PLACEMENT comment updated (ranked).

### 2) Autonomous never runs in server-authoritative matches
User: "Auto runs in multiplayer" (in PATCHNOTES) is FALSE — server-required things must not run auto now.
- **`server/room.ts` `beginMatch`** (the ONE chokepoint all three setup-build paths funnel through) now
  strips `autoPath`/`autoPathEnabled` from every setup before `createWorld` + the `ReplayRecorder`, so
  NO server room (versus or record) runs auto, whatever a client advertised. **Local session-less
  practice (GameController, `session===null`) never reaches Room → still runs auto client-side.**
- `PATCHNOTES.md` line corrected ("not enabled in online matches yet").

### 3) Duo records store + show BOTH drivers' drivetrains
Real duos already spawn each client's OWN spec (`room.ts` builds from `c.player.spec`) — only the
test-only `recordSetups` helper cloned. But a duo record persisted only the PRIMARY's spec, so the
board showed one drivetrain.
- **`RecordConfig` gained `partnerSpec?: RobotSpec`** (`server/db/repo.ts` + mirror in `src/net/api.ts`;
  stored in the `records.config` jsonb — no schema change). `server/persist.ts` writes
  `partnerSpec: partner?.spec`.
- **`src/ui/Leaderboard.tsx`** — the robot cell shows `Mecanum + Tank` for a duo; `ConfigSummary`
  refactored to `RobotSpecSummary` and renders BOTH robots when `partnerSpec` present.
- `src/sim/replay.ts` `recordSetups` now takes an optional `partnerSpec` (duo slot 1's own build,
  defaults to `spec`); comment + smoke updated (a duo may mix drivetrains).

**DEPLOY (REQUIRED — server + DESTRUCTIVE migration):** commit on alpha → `flyctl deploy --remote-only`
→ verify `/health` → Vercel auto-deploys clients. Migration 0011 deletes per-drivetrain ELO rows +
drops the `elo_ratings.drivetrain` column on first boot (the `'overall'` rows = everyone's real rating
survive; `records`/`match_participants` untouched). **The one Fly app serves all client versions** — an
old client sends `&drivetrain=…` to `/api/elo` (server ignores it) and still gets a valid elo board;
`recordResult` still carries `drivetrain` (records unchanged), so no client regresses. Backward-compatible.

---

## Prev — leaderboard + career: split Act/Season pickers · both-team scores · end-of-season final stats

User ask: "For the leaderboard and career, there should be an act selector and a season selector. For
career, show the final scores of both teams. Show the final stats of the user at the end of the season
for historical stats." Three changes, all backward-compatible.

### 1) Split ACT + SEASON pickers (was one combined `<optgroup>` select)
- `src/ui/PeriodPicker.tsx` (NEW) — shared component: an **Act** `<select>` + a **Season** `<select>`
  (seasons filtered to the chosen act). `value` = selected `balance_version` (null = live); `onChange`
  emits null when the pick lands on the current period. Renders nothing until `seasons.length > 1`.
  Picking an act jumps to that act's latest season. CSS `.ds-period` in `shell.css`.
- `src/ui/Leaderboard.tsx` — dropped the inline combined select + `acts` grouping; now `<PeriodPicker
  label="Period" />`.

### 2) Career match history shows BOTH teams' final scores
- **No migration** — `match_participants.score` already stores the **alliance total** (`room.ts:826`
  writes `w.match.scores[alliance].total`), so red/blue are recoverable from the participant fan-out.
- `server/db/repo.ts` `userMatchHistory` — added `mp.score` to the participants query, built
  `scoreByMatch` (red/blue per match), and added `redScore`/`blueScore` to `MatchHistoryEntry` (null for
  record runs). Mirrored the two fields in `src/net/api.ts`.
- `src/ui/MatchHistory.tsx` — new `ScoreCell`: a versus row renders `redScore–blueScore` (red/blue ink
  via `.mh-vscore`, winner bold); record runs keep the single score. **Backward-compat:** an old server
  omits the fields ⇒ `redScore == null` ⇒ falls back to `r.score`.

### 3) End-of-season historical stats (one picker drives BOTH stats + history)
- `src/ui/CareerView.tsx` (NEW) — the shared Career body: owns ONE period picker, fetches
  `UserStats` for the selected season, and renders `CareerPanel` + `MatchHistory` (both season-controlled).
  A PAST period ⇒ `archived` ⇒ CareerPanel header reads "… · **Final**" + a FINAL tag (that season's
  final standings). 404 from `loadStats` ⇒ the `notFound` slot.
- `src/ui/MatchHistory.tsx` — now **controlled**: `season`/`seasonLabel` props (dropped its own
  `fetchSeasons` + season select). Resets to page 1 on a period switch.
- `src/ui/CareerPanel.tsx` — takes `seasonLabel`/`archived` props (dropped its own `fetchSeasons`).
- `src/ui/Stats.tsx` + `Profile.tsx` — thin wrappers over `CareerView` (inject `loadStats`/`fetchPage`
  bound to user id / username; keep their own head + auth/notfound gating).

**Server season handling already worked** (`/api/user/:id/stats?season=` + `/api/*/matches?season=` route
through `getUserStats`/`userMatchHistory` with the season). Only `userMatchHistory` changed on the server.

**DEPLOY:** server change (repo.ts) ⇒ `flyctl deploy --remote-only` (verify `/health`), then Vercel
auto-deploys clients. Additive JSON, protocol unchanged → fully backward-compatible (old client ignores
the new fields; new client on the old server falls back to the single score). No smoke change (UI/DB, no
sim behavior). NOT yet committed/deployed.

## Prev — duo/2v2 CLOSE·FAR role: distinct-role guarantee + category force (CLIENT-ONLY)

Two bugs, both in `src/ui/useRoleSwap.ts` role logic + the start-category wiring:
1. **Both players ended up FAR** after: duo room → 2 join → SWAP roles → host leaves (partner
   becomes host) → original host rejoins. Cause: `derivedRole` split roles purely by clientId
   sort, ignoring the partner's explicit `startRole`. A lobby rejoin returns as a FRESH `join`
   (rejoin never reattaches a duo lobby slot — "rejoin doesn't appear for duo") with a NEW random
   clientId and NO `startRole`, so the rejoiner fell to the positional sort, which — since the new
   UUID sorted after the partner — gave `far` while the partner kept its swapped `far`. Both far.
2. **Locked role didn't force the start position**: role = CLOSE but a FAR start (carried from
   single-player settings) stayed FAR instead of being forced to a CLOSE spot.

Fixes:
- `src/ui/startPositions.ts` — `derivedRole` moved here (pure, no React) and rewritten to
  GUARANTEE distinct roles: honour an explicit `startRole`; a member WITHOUT one takes the
  OPPOSITE of a partner who HAS one (rule 3 — this is what fixes the rejoiner); only fall back to
  the clientId positional split when neither (or both-identical) is explicit. Deterministic +
  identical on both clients from the shared roster → always one close + one far. `otherCat` also
  moved here. (No `startRole` preservation across rejoin needed — the partner's retained role
  decides the rejoiner.)
- `src/ui/useRoleSwap.ts` — imports `derivedRole`/`otherCat`; `role` is now just
  `derivedRole(players, me)` (it already folds in `startRole`), dropping the old
  `me.startRole ?? derived`.
- `src/ui/Lobby.tsx` + `src/ui/MatchStrategy.tsx` — new effect: when a role is locked and the
  active start is in the OTHER category (`me.startPose ? settings.startCat : indexCategory
  (me.startIndex)` ≠ role), `applyStart(switchCategory(sCat, role))` forces it to the role's
  remembered/default pick.
- `scripts/smoke.ts` — +4 role checks (fresh split; explicit honored; **rejoiner takes opposite
  of partner’s retained role — the exact repro**; identical-collision still distinct).

Deploy: CLIENT-ONLY (no server/ change) → Vercel picks it up on push; NO Fly deploy needed.

## Prev — start-pose block + room-code kind-scoping (deployed to Fly, c552e37)

### (1) EVERY game refuses an illegal custom start pose (block-and-warn)
Bug report: "the game should not start with an invalid starting position" when a custom
start pose is saved with one chassis then used with a DIFFERENT-sized chassis — and it happens
in BOTH local and SERVER games. Investigation (scratchpad repro against the real sim) showed the
sim spawn is geometrically robust — `createWorld` → `coerceSetup` → `snapStartToLegal` re-snaps
every custom pose legal for the actual chassis on both client AND server (server `beginMatch`
calls `createWorld`; 0/2312 cross-chassis poses spawn illegal). So the robot never spawns
overlapping — but the user configured the pose for a DIFFERENT chassis, and wants the game to
**refuse to start and warn** rather than silently RELOCATE the robot. Applies to all games (the
"server games don't matter" read was wrong — corrected: server games did it too).
- `src/sim/field.ts` — new pure `activeStartLegal(spec, alliance, startPose)`: `null` (a preset)
  is always ok; a custom pose is `evalStartPose(spec, mirrorStartPose(pose, a), a)` (same
  actual-frame check the editor uses; canonical poses are alliance-symmetric so the settings
  alliance is fine even if the server reassigns). Lives in `field.ts` (pure geometry) so the
  SERVER can import it too.
- `src/ui/App.tsx` — the check lives INSIDE `guardStart`, which gates ALL six entry points
  (free drive, solo match, record, duo record, ranked, custom room). On an illegal active pose
  it shows a new overlay ("Start position invalid" → FIX START POSITION jumps to
  `configure/match`, or CANCEL) instead of entering the game/lobby.
- **READY-UP gate (lobby + pre-match)** — a player can't ready up with an illegal pose:
  - `src/ui/Lobby.tsx` + `src/ui/MatchStrategy.tsx` — compute `startLegal =
    activeStartLegal(me.spec, me.alliance, me.startPose)`; the READY UP button is `disabled`
    when illegal (still allows UN-readying), with a ⚠ hint. These screens let a player SWAP
    chassis right next to ready, which is what makes a saved pose go illegal mid-lobby.
  - `server/room.ts` (AUTHORITATIVE) — `case 'update'` force-clears `ready` whenever the
    resulting pose is illegal for the player's spec (covers spec-swap-then-stale-ready +
    spoofed ready), so the ranked auto-start (`maybeBeginRanked`, all-ready) can't fire. And
    `startMatch()` refuses (broadcasts an error) if ANY driver's pose is illegal — closing the
    host-start path, which isn't gated on all-ready server-side. The server still SNAPS at
    `createWorld` as a last resort, but these gates mean an illegal pose never reaches it.
- `scripts/smoke.ts` — +2 checks (null pose ok; a pose legal for a small chassis but illegal
  for a big one is flagged).
- Auto-path was explicitly OUT of scope (user said ignore). NOT changed.

### (2) Room codes are kind-scoped (custom room ≠ duo record)
Bug: custom (versus) rooms and duo-record rooms mint codes from the SAME `generateRoomCode()`
into ONE shared `rooms` map, and `joinRoom` attached a joiner to whatever room owned the code
WITHOUT comparing kind — so a duo-record code typed into the custom join box (or a rare random
collision) dropped you into the wrong mode (wrong capacity/alliance/leaderboard).
- `server/index.ts` `joinRoom` — when the code already names a room (`!created`), compare the
  joiner's `msg.config` (kind + record) to `r.config`; on mismatch send `{t:'error', message:
  'That code is for a different game mode.'}` and refuse. A just-created room can't mismatch.
  Client already surfaces server `error` (Lobby → phase 'error'). No protocol change →
  backward-compatible. Deploy: server change ⇒ `flyctl deploy --remote-only`.

## Prev — Act & Season system (competitive periods now Act → Season)

User model: periods form an **Act → Season** hierarchy — MULTIPLE seasons per act, both
1-indexed, plus **Act 0** for the historical beta/pre-season. Before, the leaderboard bucket
was a single flat integer (`balance_version`) auto-labeled `Season N`; since `BALANCE_VERSION`
starts at 3 the first board read "Season 3" (the "weird name"), the picker showed raw ints and
hid itself for one period, and career showed the same. Now everything reads "Act X · Season Y".

Key idea: `balance_version` stays the internal per-record/match/replay key. A NEW `act` column
GROUPS versions; the displayed **season number is the version's 1-indexed ORDINAL WITHIN ITS
ACT** (derived via `row_number`), so it's always contiguous from 1 regardless of the raw bv.

Changes:
- `server/db/migrations/0010_season_acts.sql` — `seasons.act int not null default 0` (all
  existing rows → Act 0 = beta), and `seasons.name` made nullable (null ⇒ use structured label).
- `server/db/repo.ts` — `SeasonRow` gains `act`/`seasonNo`, `name: string|null`; `listSeasons`
  computes `season_no = row_number() over (partition by act order by balance_version)` and
  NULLs legacy auto `"Season N"` names; `ensureSeason` no longer bakes a name; `startNewSeason
  (fallback, name?, bumpAct?)` returns `{season, act, seasonNo}` — `bumpAct` ⇒ act++, season
  ordinal resets to 1, else same act.
- `server/index.ts` — `/api/admin/season/start` reads `act=new`, fires the `'act'` vs
  `'season'` cinematic announcement, returns `{season, act, seasonNo}`. Label via `periodLabel`.
- `src/seasons.ts` — new pure `periodLabel({name, act, seasonNo})` = custom name || "Act X ·
  Season Y" (shared by leaderboard, career, match history, server announcement).
- `src/net/api.ts` — `SeasonInfo` gains `act`/`seasonNo`, `name` nullable; `adminStartSeason
  (name?, {newAct?})`.
- `src/ui/Leaderboard.tsx` + `MatchHistory.tsx` — picker is now `<optgroup>`-per-act
  ("Act 0 · Beta" for act 0), options show "Season Y" / custom title; badges use `periodLabel`.
- `src/ui/CareerPanel.tsx` — maps `stats.season` → full `SeasonInfo` and labels via `periodLabel`.
- `src/ui/Admin.tsx` — "Acts & Seasons" card: START NEW SEASON + START NEW ACT buttons, custom
  title optional (blank ⇒ auto label).

Behavior on the live prod DB (bv3, name "Season 3", beta): migration adds act 0 → the board
now reads **"Act 0 · Season 1"**. When ready to launch, admin clicks START NEW ACT → bv4,
**"Act 1 · Season 1"**. Non-destructive: underlying balance_version stamps are untouched; only
the DISPLAY is derived. Deploy: server + migration ⇒ `flyctl deploy --remote-only` (migration
runs at boot; verify `/health`), Vercel auto-deploys clients. Protocol unchanged, backward-compat
(old clients that don't send `act=new` just start a same-act season).

## Prev — duo record now allows DIFFERENT drivetrains (mixed ⇒ overall board only)

User: duo record mode should let the pair run different drivetrains — such a run counts
on the OVERALL record ranking but NOT any drivetrain-specific board. Previously the server
hard-refused to start a mismatched duo. This mirrors ranked ELO's existing rule
(`computeGlicko`: the per-drivetrain board updates only when all participants share one
drivetrain; mixed teams hit `overall` only).

Changes (server + DB + client copy — NO protocol shape change, backward-compatible):
- `server/room.ts` `startMatch` — DELETED the `dts.size > 1` block that broadcast an error
  and refused to start a mismatched duo. No drivetrain gate remains.
- `server/persist.ts` — a duo whose participants ran different drivetrains keys the
  `'overall'` sentinel instead of `primary.drivetrain`
  (`new Set(o.participants.map(p=>p.drivetrain)).size > 1 ? 'overall' : primary.drivetrain`).
  Uses ALL participants (incl. an unauthed partner) so the mix reflects the robots that played.
- `server/db/repo.ts` — `personalBest` + `recordRank` now treat `drivetrain === 'overall'`
  as NO drivetrain filter (matching `recordLeaderboard`'s existing 'overall' semantics), so a
  mixed run's PB/rank is computed on the cross-drivetrain board it actually lands on.
- `server/db/migrations/0009_record_overall_drivetrain.sql` — relaxes the `records.drivetrain`
  CHECK to also allow `'overall'` (elo_ratings already permitted it). WITHOUT this the INSERT
  throws 23514 and the run is silently dropped (results screen hangs on "computing rank").
- `src/net/protocol.ts`, `src/ui/Lobby.tsx` — copy updated (no longer says "same drivetrain").
- `src/ui/GameView.tsx` — `DRIVETRAIN_LABEL.overall = 'Mixed'` so the results line reads
  "Duo · Mixed" not lowercase "overall".

Deploy: server + migration ⇒ `flyctl deploy --remote-only` (migration runs at boot; verify
`/health`), then Vercel auto-deploys clients. Protocol unchanged → old clients keep working
(they'd just render a received `drivetrain:'overall'` via their `?? d` fallback).

Design note: matched-drivetrain duos are UNCHANGED — they still rank both that drivetrain's
board and (via best-any) the overall board. Only mixed pairs are new, and they land on
overall alone.

## Prev — rejoin worked "weirdly" for duo-record + multiplayer (reconnect race)

> `npm run build`, `npm test` (5 new reconnect checks), `npm run server:check` passed then.

Symptom: after a transient drop, rejoining a live match often failed to a "Connection
lost" panel (or the reconnected player mysteriously went offline / got dropped).

Root cause: on a transient network partition the client reconnects fast (~1s) and sends
`rejoin`, but the server hasn't reaped the OLD socket yet (a partitioned TCP connection
lingers for tens of seconds, so `c.connected` is still true). `Room.reattach` REFUSED a
reclaim whenever `c.connected` — so the fast reconnect was rejected (`rejoined:false` →
hard fail). Naively allowing it introduced the mirror bug: the stale old socket's
eventual `close` → `detach` would then knock the freshly-reconnected player offline.

Fix (server only, sim/protocol untouched):
- `server/room.ts` — each slot carries a monotonic owning-connection stamp
  `Client.conn` (bumped by `add`/`reattach` from `connSeq`). `reattach` now takes over
  even a still-`connected` slot (the correct clientId proves ownership; the old socket is
  orphaned — its `send` is replaced) and returns the new conn (or `null` only when the
  slot is truly gone → grace lapsed). `detach(id, conn?)` ignores a close whose `conn`
  doesn't match the current owner (the stale old socket).
- `server/index.ts` — the connection tracks its `conn` (set on join/rejoin) and passes it
  to `detach` on close; the rejoin branch adopts the conn `reattach` returns.
- `scripts/smoke.ts` — +5 checks: fast rejoin reclaims a still-connected slot, resync
  snapshot sent, stale old-close ignored (no roster churn), current-close honoured,
  unknown slot → null.

Deploy: server change ⇒ needs `flyctl deploy --remote-only` (verify `/health`). Protocol
is unchanged (no new caps), so it's backward-compatible with old clients.

## Prev — held balls of REMOTE robots didn't move with the robot (multiplayer)

Symptom: balls held inside *other* robots in a room floated/lagged relative to the
robot body. Cause: remote robots render at an **interpolated** pos (`displayWorld` in
`game.ts`), but balls are NOT interpolated (render from the predicted sim). `drawRobot`
recovered each held ball's local offset via `b.pos - r.pos` — the interpolated `r.pos`
and the sim-built `b.pos` diverge, so the ball was misplaced.

Fix (`src/render/drawRobot.ts`, render-only — sim/netcode untouched): held balls carry
their true robot-frame offset in state (`b.state.lx/ly`, already synced in the ball
delta), so draw them from that directly instead of the world round-trip. They now track
the body rigidly regardless of interpolation. No smoke change (render layer).

---

## Prev session — Markdown announcements + scoring-timing per manual 9.x A–F

> Was GREEN incl. `npm run contrast`; deployed (Fly server + pushed to alpha for Vercel).

## This session, part 2 — Markdown announcement bodies

Announcement bodies (patch notes / season / act) now render as **Markdown** instead of
being flattened into flat bullets. New self-contained renderer (NO deps — project rule),
React elements only (no `dangerouslySetInnerHTML`), so admin-authored bodies can use
structure with no HTML-injection surface. Unsafe link schemes (e.g. `javascript:`) → `#`.
Supported: `#`..`######` headings, paragraphs, `-`/`*`/`•`/`+` + `1.` lists (nested by
indent), `**bold**`/`*italic*`/`` `code` ``, `[label](url)`, `---` rules.

- `src/ui/markdown.tsx` (NEW) — `<Markdown text=… className=… />`. Block parser +
  earliest-match inline tokenizer; nested lists via an indent stack; safe-href guard.
  Verified with a `react-dom/server` render harness (9 structure/security asserts).
- `src/ui/Announcements.tsx` — "What's new" list renders `<Markdown>`; dropped the old
  `bulletLines` flattener.
- `src/ui/Admin.tsx` — composer advertises Markdown + shows a **live preview**; textarea
  `maxLength` 4000→8000, `rows` 5→8.
- `server/index.ts` — announcement body cap `slice(0,4000)`→**8000** (long patch notes).
  *This is the only server change → needed a redeploy (done).*
- `src/ui/styles.css` — replaced `.ann-list*` with themed `.md*` classes (headings, lists,
  code, links, hr). `npm run contrast` still 135/135 in both themes.
- `PATCHNOTES.md` (repo root) — user-facing patch notes for the whole alpha-vs-main delta
  (written this session; ready to paste into an announcement).

## This session, part 1 — scoring-assessment TIMING per manual 9.x A–F

> Sim change in `src/sim` (`scoring.ts` + `match.ts`), no protocol/DB/config change,
> no `BALANCE_VERSION` bump. Server-authoritative + identical everywhere; deployed.
> Determinism holds (pure functions of world state).

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
