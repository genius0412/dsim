# HANDOFF — 2026-09-25e (Vercel Analytics removed; its history imported)

**State: committed on branch `claude/drop-vercel-analytics` (off alpha 96225a0a), NOT pushed.** `build`, `server:check`, `dbtest` (ALL PASS, 17 new checks), `uiaudit`, `docaudit`, `bundleaudit` pass. `npm test`: shared PASS; BIOBUZZ only wall-clock timing flakes (predict budget / step3d p95), lanes pass alone. ⚠️ **Server change + migration 0053** (renumbered at merge: 0051/0052 are lockdown/banners).

- **Owner:** first-party analytics is extensive enough; pull Vercel's data in and remove Vercel Analytics.
- **Removed:** `@vercel/analytics` (package.json + lockfile), `<Analytics />` in `main.tsx`, the `track` sink in `src/analytics.ts`. Events now go only to `/api/a/ev`, so DNT/GPC now also stops events (it did not for Vercel's). No CSP/vercel.json entries existed for it.
- **Gaps closed:** events and their properties are rolled up (`dim = 'event'`/`'evprop'`, val `name|key|value`), so ranges past 30 days show events and a month-old sponsor report still breaks down by placement. New **Sponsor report** panel (docs/sponsor.md's lines, CSV) and **Last month** range. "First-party history starts …" note. Vercel had nothing else we lacked (its UTM breakdowns were a paid add-on it never gave us; `route` is empty for Vite).
- **History:** `scripts/vercel-analytics-export.mjs` (public Web Analytics API, read-only) → `scratch/vercel-analytics-<env>.json`; `scripts/import-vercel-analytics.ts` (dry run unless `--write`) → `analytics_imported` (0053), replacing the file's days. Paths are scrubbed with `normalizePath` (moved to `src/pathScrub.ts` so the server can import it). Shown as its own dashboard section, never summed with ours. Exported 2026-09-13 → 2026-09-25: 408,814 page views, 13,008 daily-unique visitors, events incl. 194,805 `sponsor_shown`, 379 `sponsor_click`, 823 `player_joined`. Preview (alpha) export too: 10,720 views.
- **Next (owner):** deploy the server (migration 0052), then RE-EXPORT (to catch the days up to removal) and import: `VERCEL_TOKEN=… node scripts/vercel-analytics-export.mjs --team team_btPkJqnmnzu4DXvfygxEr4vl`, then `DATABASE_URL=<prod> npx tsx scripts/import-vercel-analytics.ts --file scratch/vercel-analytics-production.json --write`. Do it before ~2026-10-13: the API only answers inside the plan's reporting window, and data starts 2026-09-13. Then disable Web Analytics in the Vercel project.
- **Legal:** Vercel's "second usage count" line dropped from the processors list, one sentence added that its daily totals were kept. `LEGAL_UPDATED` NOT moved: a processor removed is not a material expansion (monetization.md).
# HANDOFF — 2026-09-25f (lockdown scopes, access groups, site banners, alpha closed)

**State: committed on a feature branch, NOT pushed, NOT deployed.** `build`, `server:check`, `dbtest` (ALL PASS, new `lockdown:`/`access:`/`banners:`/`site:` checks), `uiaudit`, `contrast` (399), `docaudit`, `shiftaudit` (0 shifts) pass; `npm test` shared PASS, BIOBUZZ one wall-clock check (PREDICT_FULL_BUDGET_MS) failed under load and passed alone. ⚠️ **Server change + migrations 0051/0052**: alpha needs `./scripts/fly-deploy.sh --alpha`, production a `main` deploy.

- **Lockdown has a scope** (`matches` = old maintenance, `site` = whole app closed), a message, a redirect button, an open-ended window, and bypass groups. Admins always pass. Enforced at join, queue, room start/restart/rematch, LAN host (either scope) and spectate, LAN join, every `/api` POST (site). Rules in `docs/area/accounts.md`.
- **Access groups** `beta`/`dev`/`contributor` (`access_members`, by user id, audited). Console tab **Access** (single + bulk by player tag). Per deployment: alpha testers go in the alpha DB.
- **Banners** (`banners` table): info / known-bug / warning / restart. The restart countdown now reaches every region (it was in one machine's memory). Console **Server** tab. Strip is `BannerStack.tsx`; one row + "N more"; dismiss per id+revision.
- **Closed screen** (`ClosedScreen.tsx`) replaces the app at first load; fail open, except a build with `VITE_SITE_LOCKDOWN=1`.
- **To close alpha** (owner/release manager, in order): deploy the alpha server, run the lockdown curl in `docs/deploy.md` ("Closing alpha…"), then set `VITE_SITE_LOCKDOWN=1` on Vercel's `alpha` branch and redeploy it. Then add testers (owner sends tags).
- **Not built:** tester badges on profiles; draining the ranked queue when a lockdown starts (a pairing staged before it bites still plays).

# HANDOFF — 2026-09-25d (stuck-robot batch, SIM_VERSION 4)

**State: pushed on `alpha`, going to `main` in the same release.** `npm test` passes except the known `PREDICT_FULL_BUDGET_MS` wall-clock flake under load (5 ms alone). `build`, `server:check`, `docaudit`, `uiaudit`, `bundleaudit` pass. ⚠️ **Server + sim change; `SIM_VERSION` 3 → 4 (owner approved 2026-09-25)**: every older replay, all games, plays as drift. Standings do not move (`BALANCE_VERSION` keys them).

- **Everything from 09-25c's "not fixed" list is fixed:**
  - Hive-frame perch: every case started inside the frame (the harness spawned into overlaps). `setChassisClear` (`engineImpl.ts`) sets a chassis placed > 0.25 in inside a fixed part down beside it.
  - Flower trap: ring-plate trimeshes have no inside. Robots now meet the middle/top plates as solid boxes (`buildFlowerSolids3d`, `GROUP_CHASSIS`); elements meet the same surfaces as before. 8,960 drive-ins: 2 traps / 1,025 lifts → 0 / 0.
  - Server gap-fill: a tick filled from a future `latest` keeps the last applied buttons (`frameCommands`). Smoke "input gap:" fails on the old fill.
  - `debouncedPress` (`src/sim/robot.ts`, `TOGGLE_DEBOUNCE_S`) serves butterfly `driveMode` and the ramp.
  - `GamepadInput` holds the last sample through a < 100 ms pad dropout.
- `scratch/rampstuck.ts` (overlap spawns included): 0/400 on seeds 2/3 sweeper and 2/4 ramp, from 8/14/11/10.
- **Patch notes**: `docs/releases/2026-09-25-stuck-robot-fixes.md`, three notes (BIOBUZZ, DECODE, Chain Reaction) with the publishing block. Publish AFTER the production deploy. The What's New modal and `/changelogs` were restyled for reading (15-px body, 68ch measure, fixed button bar).
- **Also merged into this release from another session:** homepage play counts (`0050_play_counts`) and the room-cap fix that was waiting on `main`.
- **Open, separate branches (second release):** `claude/drop-vercel-analytics` (`b94531fa`; its migration is 0053 after the merge; the Vercel history import must be run by hand against production — see its HANDOFF section; the API window likely drops data from ~2026-10-13). The lockdown / alpha-closed / access groups / banners agent is still running; merged too: its migrations are 0051/0052.
- A flower-side note from that agent: `containmentPass` clamps an out-of-field robot to x ±70.17 without checking statics. `setChassisClear` now catches the resulting overlap on the next sync.

# HANDOFF — 2026-09-25e (prod "region busy" with few games: the room cap counted finished matches)

**State: pushed on `alpha`.** `server:check`, `test:mm` (201), `docaudit` pass; `npm test` shared PASS, BIOBUZZ 1 wall-clock perf check failed under load (a different one each run, no `src/` touched). ⚠️ **Also on `main` as `ffaf321f`** (cherry-picked alone onto a8390771; build, server:check, test:mm pass there). **NOT DEPLOYED**: production needs `./scripts/fly-deploy.sh` from a `main` worktree, which also re-applies the new per-size caps. Verify after: `/api/perf` with `fly-prefer-region: lhr` shows `capRooms` and `maxRooms 10`.

- **Owner report:** prod says some servers are busy with few games running.
- **Measured (`/api/perf`, fly-prefer-region):** lhr `rooms 2, maxRooms 6, admitting false`, 0.25 cores. Its log: `[admit] refused room … at cap (6/6)` for record runs every few seconds, and two staged ranked rooms (`lhr-1v15…`) refused, which cancels the pairing.
- **Cause:** a finished match stops stepping but stays in `rooms` while anyone is on the results screen (no timeout), and the cap counted `rooms.size`. Also 6 was below the 8–10-with-margin figure for a dedicated core, and six of seven satellites are performance-1x now.
- **Fix:** the cap counts `Room.holdsCapacity()` (not finalized) via `roomsHoldingCapacity()`; `/api/perf` adds `capRooms`; the refusal log prints both counts. `fly-deploy.sh`: `SATELLITE_MAX_ROOMS_DEDICATED=10` for performance-*, 6 for shared. mmsmoke + smoke pin both. `docs/deploy.md` / `docs/capacity.md` updated.
- **Not fixed:** the matchmaker is still not load-aware (capacity.md §7), so a genuinely full satellite still refuses staged ranked rooms.

# HANDOFF — 2026-09-25d (homepage counts every game: custom, practice, LAN, Discord)

**State: pushed on `alpha`.** `build`, `server:check`, `dbtest` (ALL PASS, 19 new `plays:` checks), `uiaudit`, `docaudit` pass. `npm test`: shared PASS; BIOBUZZ 3 wall-clock perf checks failed under full load (predict budget, step3d p95), no sim code touched. ⚠️ **Server change + migration 0050**: needs the alpha deploy (and a `main` deploy for production).

- **Owner:** the homepage should count custom games, solo practice, LAN and Discord games, each logged separately and per game; the page folds them into Solo / Duo / 1v1 / 2v2 / Custom.
- **Before:** the counts came from `records` + `matches`, so anonymous rooms, Discord rooms (signed out), practice and LAN never counted, and custom rooms were inside 1v1/2v2.
- **Now:** `play_counts` (0050) counts per UTC day × game × source × mode. Server rooms count in `persistMatch` before the anonymous drop (`playSourceOf`; `MatchOutcome.discord` from `Room.group`). Practice (every kept run, signed in or out) and LAN (host only) are reported by the client to the public `POST /api/played` (text/plain, keepalive; 30 per 10 min per hashed address; always 204). The migration backfills from `records`, `matches`, `practice_runs`, `lan_runs`.
- **Homepage:** two lines under the tiles, Solo · Duo then 1v1 · 2v2 · Custom (owner: the one line was cramped). Solo = record solo + practice, Duo = record duo, 1v1/2v2 = ranked only, Custom = custom + Discord + LAN. `/api/stats` also returns `detail` (the raw split). Custom is hidden against an older server. Rule in `docs/area/accounts.md`.
- **Expect** 1v1/2v2 to DROP after the deploy (custom rooms moved to Custom) and Solo to rise (practice uploads backfilled).
# HANDOFF — 2026-09-25c (BIOBUZZ ramp: the self-freeze and the double toggle)

**State: pushed on `alpha`.** `npm test` (shared + 5129 BIOBUZZ), `build`, `server:check`, `docaudit` pass. ⚠️ **Sim change** (`src/games/biobuzz/`), so the game servers run it only after a deploy. Production needs this on `main` plus a Fly deploy.

- **Player report + replay 1dc6eb8f (production, 3D):** a `frontback` ramp build deployed and folded "at random" and froze at 1:50 of match time until the buzzer. Pulled the row read-only and re-simulated it (`scratch/analyzereplay.ts`, `scratch/replayticks.ts`; the replay JSON stays in `scratch/`, it is private).
- **The freeze:** t6508 fold pressed 3 in short of the −y wall at 45 in/s → the fold's overshoot hit the wall → reversed to a deploy the old guard never re-tested → no ramp collider mid-swing, the robot closed 2.4 in → the ramp settled inside the wall, the deck's contact normal was (0,0,−1), and the chassis sank to z −0.32 and stayed. Every later fold press reversed instantly. Fix in `bbRampSwingStep3d`: a reversed deploy is re-tested and folds on a second hit; a settled ramp a fixed body presses vertically (`rampEmbedded`, `BB_RAMP_EMBED_DEPTH`) folds. Verified on the recorded state (old guard until t6505, new after): the robot folds at t6511 and drives off.
- **Same jam off the hive foot bars:** 7/400 random ramp drives froze with the blade under a foot bar or frame foot; 0/400 after.
- **The random toggles:** two 1-tick button dropouts in that match (one a whole all-zero input frame, an empty gamepad read) each toggled twice. `bbRampStep` is debounced (`BB_RAMP_DEBOUNCE_S` 2.5 ticks, `RobotState.bbRampUpAt`). The rest were the swing guard doing its job near walls and the hive foot bars (2.15 in, easy to miss).
- ⚠️ Replays of ramp builds recorded before this can diverge (this one does from t6172). `SIM_VERSION` stays 3, as ruled 2026-09-20.
- **Not fixed, found on the way:**
  - ANY build can get stuck ON TOP of a hive foot bar or frame foot (z ≈ 2.1): 8/400 random drives with a sweeper or a folded ramp; `scratch/rampstuck.ts <n> <seed> sweeper` reproduces it.
  - A chassis can end up inside a flower's ring trimesh (1/400).
  - The server fills a missing input tick with `latest`, the NEWEST command by tick, which is usually from the future, so a lost packet near an edge can double-toggle any edge-triggered button (`frameCommands`, `server/room.ts`). The replay shows no case of it.
  - `driveMode` has the same undebounced latch.
  - The client produced an all-zero input frame mid-press (gamepad dropout); worth a look in `src/input/gamepad.ts`.

# HANDOFF — 2026-09-25b (ranked badge numerals centred)

**State: pushed on `alpha`.** `build` and `uiaudit` pass. Client-only.

- **Bug (owner):** the 1/2/3 on the podium crests sat off centre. They were HTML text over the SVG, so Space Grotesk's metrics decided where they landed: the 1's flag pulled its ink a unit left, and the digits rode high at the small sizes.
- **Fix:** `NUMERAL` in `BadgeMark.tsx` draws them as stroked paths in the crest's 24 box, centred on (12, 11.5), so they also scale with the crest at every size (they were 60% of it at `sm` and 30% at `lg`). `.badge-num` is now a stroke rule in `shell.css`.

# HANDOFF — 2026-09-25b (email verification + Google sign-in fix RELEASED to production)

**State: production = `main` = `a8390771`**, Vercel (`/version.json` a839077) and every Fly machine on it. `REQUIRE_VERIFIED_EMAIL=1` is Deployed on `dohun-sim-decode` and `dsim-alpha`: unverified email/password accounts are refused ranked, record rooms and practice saves, and each refusal shows the code form in place.

- Shipped: code entry (Profile banner, sign-up step, `/account/verify`, and at each refusal), set/change password by code (Google accounts get a password login), the gate reading `neon_auth."user"`, the practice-save refusal no longer silent, and the Google sign-in verifier kept through URL canonicalization. Also rode along: ranked badge numeral (`1f1421a3`) and the career stats flash fix (`537af652`).
- Deployed twice with `announce-deploy.sh` (players were online): the owner set the secret after the first deploy, and the classifier blocks Claude from `flyctl secrets set` on production (memory note).
- **Watch:** Google sign-in reports on prod (if some still bounce, ask for the browser: Safari/Brave third-party cookie blocking is the next suspect), and complaints from the 742 unverified accounts about expired codes. The in-place Send a new code covers them.

# HANDOFF — 2026-09-25 (alpha: email verification takes the CODE Neon Auth sends)

**State: pushed on `alpha`.** `npm test` (shared + 5123 BIOBUZZ), `build`, `server:check`, `uiaudit` pass. Server change (the two refusal strings now say "Enter the code we emailed you"), so it rides the next Fly deploy. Nothing on `main`.

- **Bug (owner):** the verification email arrived with a code and nowhere in the app took one. Neon Auth verifies with an OTP; the app only knew the link/token path.
- **Fix:** `verifyEmailCode` (`authFlows.ts`, `emailOtp.verifyEmail`) + `VerifyCodeForm`, shown in the Profile banner, as a code step in the sign-up dialog, and on `/account/verify`. The session refreshes itself on that route, so the banner goes away. Rule in `docs/area/accounts.md`.
- **Copy:** the banner said ranked and record runs need a verified address. False: `REQUIRE_VERIFIED_EMAIL` is off. The sentence is gone.
- **Gate ON on alpha (owner, 2026-09-25):** `REQUIRE_VERIFIED_EMAIL=1` on `dsim-alpha`. The JWT's claims were never confirmed, so the gate now reads Neon Auth's own `neon_auth."user"."emailVerified"` from the game DB (`authEmailVerified`, repo.ts; dbtest pins it) before the `/get-session` fallback. At the time of setting, 742 of 1787 auth users were unverified. Production still needs the code UI on `main` first, then the secret. It gates ranked, record rooms AND practice saves (`POST /api/practice`, which now has its own refusal sentence).
- **Google sign-in "just reloads" (prod report):** Neon returns from Google with `?neon_auth_session_verifier=`, which the SDK reads off `location.search` when its first `get-session` starts. App's mount-time URL canonicalization stripped every query and sometimes won that race, so the player came back signed out. It now keeps that one param (the SDK deletes it after the exchange). Client-only; reaches prod with the next `main` deploy. Smoke pins it.
- **Refusals are fixable in place:** the three gate refusals carry `code: 'email_unverified'` (new `ErrorCode`). The ranked screen and the record card show `VerifyEmailInline` (code field + Send a new code) instead of the Profile-page sentence; the record card swaps TRY AGAIN for START RUN once verified. A refused practice save used to fail SILENTLY and stall the upload backlog; it now sets `practiceUploadBlocked` and Practice replays says so with the same form. A successful code fires `dsim:email-verified`, and App drains the backlog on it. Older clients still get the sentence.
- **Password by code (owner: Google users should be able to sign in both ways):** Profile ▸ Account ▸ Password now emails a code and takes code + new password (`requestPasswordCode` / `setPasswordWithCode`). It creates the password login for a Google-only account ("Not set" / "Set a password") and changes an existing one. Reviewed in an offscreen preview with a stubbed client; not yet run against real Neon Auth.
- **Password resets stay link-based:** owner confirmed Neon sends a LINK for resets, so "Forgot password?" and `/account/reset` are right as they are.

# HANDOFF — 2026-09-24o (BIOBUZZ Act 2 RELEASED to production; PR #83 merged with review fixes)

**State: production = `main` = `fff39e92`, Vercel and every Fly machine on it.** Maintenance lifts 22:30 EDT (02:30Z); the Act 2 and patch-notes announcements publish at the same moment.

- **Released:** alpha → `main` fast-forward (`9d9efac2`, 21:37), then PR #83 + review fixes (`fff39e92`, 22:23). Migrations 0037–0049 applied on boot. Boot award job: 23 grants over 5 periods (DECODE and Chain Reaction Act 1 + their closed seasons).
- **BIOBUZZ rolled to Act 2 · Season 1** (season 5), `announce=0`: 11 grants over 2 periods. Act 1's archived board shows its 2D records (per-season era, 2026-09-24n). DECODE (7) and Chain Reaction (5) unchanged.
- **Production secrets:** the ten linking/star/boost secrets are live. `.env` in `D:\Projects\2ddecodesim` holds alpha's under the plain names and production's GitHub OAuth app as `PROD_GITHUB_OAUTH_ID` / `PROD_GITHUB_OAUTH_SECRET`. ⚠️ `ADMIN_SECRET` needs URL-encoding in a query string (`curl -G --data-urlencode`); a raw one 403s.
- **Satellites:** gru/syd/nrt on `performance-1x` in `SATELLITE_SIZES`, MAX_ROOMS 6. ⚠️ **Multi-core game server is the urgent next capacity item** (`docs/capacity.md`, "MULTI-CORE").
- **PR #83 review** found a blocker (seat token lost after a room recycle, so reconnect/abandon refused from a room's second match) plus 8 smaller issues and 12 CRLF-fragile checks; all fixed in `fff39e92` and pinned by checks. The first-time BIOBUZZ loadout now seeds from `BB_DEFAULT_SPEC` (Pollinator); owner approved.
- **Next:** post the Discord announcement (text in `docs/releases/biobuzz-act2.md` §5; link `https://playdsim.com/?act2` so Discord re-fetches the card, the old one said "2D"). The public FTC post (§6) a day later. Watch `/api/perf` and the capacity task for 3D room load. The Discord Activity is still unverified in a real Discord client.

# HANDOFF — 2026-09-24o (PR #83 review fixes, branch `pr83-fixes`)

**State: committed on local branch `pr83-fixes` (PR #83's `fix/discord-activity-audit` + `origin/alpha` merged in). Not pushed, not deployed.** ⚠️ Server change (`server/room.ts`: the recycle's `lobby` frame carries `seatToken`; per-field moderation verdicts), so it rides the next Fly deploy.

- **Seat token lost on recycle (blocker):** the lobby that adopts a recycled socket never gets a `welcome`, so match two's session had an empty token and rejoin/Abandon were refused. Fixed both ways: `ResumedRoom.seatToken` → `LobbyClient.resume`, and the owner's `t: 'lobby'` frame re-states it.
- **Moderation:** a verdict is written only over a field that still holds the value checked.
- **Lobby:** an in-room refusal is shown (`.ds-form-err`) and no longer latches `refusedRef`; the web invite panel drops "Trying again in 0s."; TRY NOW / TRY AGAIN dispose the refused socket.
- **App.rejoinGame:** re-entry guard (`rejoiningRef`); a session the player walked away from during the wait is disposed (not when the recycle took its socket).
- **HDRI failure count** resets on success and after `HDRI_RETRY_MS`. **Discord lobby list:** two failed reads with no answer unlock JOIN MAIN LOBBY.
- **Smoke:** the PR's source-reading checks normalise CRLF at the read site; new checks under "recycle seat:", "moderation:", "lobby:", "rejoin:", "discord lobbies:".
- **Not changed, owner call pending:** `settings.ts` seeding a first-time BIOBUZZ loadout from `BB_DEFAULT_SPEC`.

# HANDOFF — 2026-09-24n (BIOBUZZ Act 1's 2D records stay on the boards; Act 2 release prep)

**State: pushed on `alpha`.** `dbtest` ALL PASS (10 new era checks), `server:check`, `build`, `docaudit` pass. Server change: `dsim-alpha` needs a redeploy, and production gets it with the `main` deploy. Nothing merged to `main`, nothing deployed.

- **Owner:** "Biobuzz Act 1's 2D records should NOT get filtered off the boards."
- **Bug:** `boardPhysics` was per GAME, so after the 3D cutover every BIOBUZZ season read as `'3d'`. Act 1's archived board came back empty, and rolling into Act 2 would have claimed its record awards with `winners = 0`, which is permanent.
- **Fix (`server/db/repo.ts`):** `boardPhysics(game, balanceVersion)` is per season. The live season is the live solve. An archived season is the solve most of its rows were played on, so a few 3D runs set between the deploy and the roll can't take the board. `submitRecord` keeps the live-only rule (`livePhysics`). `/api/records` echoes the era, and `Leaderboard.tsx` keeps rows of that era.
- **Also fixed:** `recordRank` threw on the `'overall'` board (a mixed-drivetrain duo). `$4` was left out of the SQL, and Postgres refuses a parameter it can't type.
- **Also:** the Lobby hint said bot rooms aren't saved. They have been since 09-24e.
- **Release plan, patch notes, Discord posts:** `docs/releases/biobuzz-act2.md`. Open items for the owner are in its §1: production Fly secrets for linking/star/boost (missing on `dohun-sim-decode`), satellite sizes, the mis-merged `update_rc` block in `fly-deploy.sh`, and leaving the Discord Activity unannounced.
- **Roll BIOBUZZ Act 2 right after the Fly deploy, under maintenance,** before anyone sets a 3D record in season 4.

# HANDOFF — 2026-09-24m (BIOBUZZ builder: 18-in chassis, no inertia, no mount blurbs)

**State: committed and pushed on `alpha`.** `npm test` 5090/5090, `build`, `server:check`, `uiaudit`, `docaudit` pass. The predict lane's timing checks failed twice under full load before the rebase and pass alone. ⚠️ **Server change** (`src/sim/spawn.ts`, the BIOBUZZ size clamp): alpha needs `./scripts/fly-deploy.sh --alpha`, production a deploy from `main`. An old server clamps an 18-in BIOBUZZ chassis back to 15 × 17.

- **Owner:** "Single turret single intake no boxtube should be as low as 18 lbs… I dont know where this .1 lbs comes from… why is max width/length 17 not 18?" and remove the text under the SIDES / FRONT+BACK mount buttons.
- **The .1 lb:** BIOBUZZ has no inertia, but `bbMassLimits` added `4 · flywheelInertia` and a new BIOBUZZ spec is seeded from DECODE's `DEFAULT_SPEC` (0.4), so mecanum + turret floored at 18.6 and tank + turret at 20.1. The term is gone, `coerceBiobuzzSpec` pins `flywheelInertia` to 0, `BB_INERTIA_DEFAULT` is deleted, and `bbSpecMatches` no longer compares it. `BB_MASS_TURRET` is 5 and `BB_MASS_DUMPER` 3.5, so preset floors are unchanged. The mass slider steps 0.5 (`BB_MASS_STEP`) instead of 1 anchored at the floor.
- **18 in:** `BB_MAX_LENGTH/WIDTH` = `ROBOT_MAX_SIZE`. The BIOBUZZ arm of `coerceSpec` carries raw `length`/`width` across (DECODE's `lengthLimits` capped sloped at 15), and `bbEnvelope` keeps only the shared floors.
- **Width depends on length now.** The R105.A envelope is the union of both rectangles. Picking one per build made a front sweeper + flank tube choose 18 × 15.5 over 15 × 18 and shrink saved 15 × 17 builds. The coercer clamps length first, then reads width off it.
- Masses are NOT snapped: replays re-coerce specs through `createWorld`, so a saved 20.1 stays 20.1 until the slider moves. No legal spec moves under the new clamps.
- `BB_INTAKE_MOUNT_BLURBS` is deleted.
- **Box Tube 2.5 → 1.5 lb** (owner: "1.5 lbs max"). Offset lists the 2-stage kit at ~475 g, 275 g moving. Pollinator floor 20.5 → 19.5; its declared 24.5 is unchanged.
- ⚠️ `npm test` has one non-timing failure that is NOT from this work: net3d "ruling: ...and it drops a 2D row an OLDER server still serves" greps `Leaderboard.tsx` for the 2D-row filter that `172c6ca1` (09-24n) removed on purpose. The check needs updating to the new per-season era rule.
- Checks: robot lane "mass: a DECODE-seeded spec coerces to no inertia…", "size: …" ×4. Rules in `docs/area/biobuzz.md` ("BIOBUZZ HAS NO INERTIA", "THE CHASSIS GOES TO 18 × 18").

# HANDOFF — 2026-09-24l (a turret SPAWNS at the elevation it aims at, and the preview draws it there)

**State: pushed on `alpha`, alpha game server redeployed.** `build`, `server:check` pass; `npm test` passes except the known `PREDICT_FULL_BUDGET` timing flake.

- **Bug (owner):** "The hood is WAY too high. It never goes that high." A turret's pitch was absent at spawn (read as 0, LEVEL), which is the hood's tallest pose and one no HIVE shot uses: the aim solve never goes below ~58.6° (2,116 poses per exit on a double turret; p50 68.7°, max the 80° stop). The builder preview and thumbnails never run `sync`, so they sat there permanently; a match sat there until its first aim tick and swung ~69° up.
- **Fix:** `BB_TURRET_PITCH_REST` (69°, `config.ts`) is the one value. `spawn.ts` seeds `bbTurretPitch` (and a double turret's `bbTurret2Pitch`, which was 0) at it; `buildRobotGroup` builds every hood at it, so preview and spawn cannot disagree. Turretless builds still carry no pitch field.
- ⚠️ **IT CHANGES PLAY, SO REPLAYS OF TURRETED ROBOTS RECORDED BEFORE THIS DIVERGE.** A/B over 2D and 3D bot matches: traces split at tick 30 (first shots leave ~0.5 s sooner) and final scores differ. `SIM_VERSION` stays 3, the same call as 2026-09-20. Production is untouched; it needs this on `main` plus a Fly deploy.
- **Checks:** robot lane — a turret and a double turret spawn at REST, a dumper carries no pitch; render lane — REST lies inside the band `bbTurretSolution` produces, and `hoodPlateChecks`' `default` pitch is REST. The AIPLAY 2v2 foul check moved 7007 → 7005: 7007 picked up one AUTO G402 when the match diverged; the rate over 7000–7019 is 2/20, against 3/20 before.

# HANDOFF — 2026-09-24j (games left at the buzzer were never saved)

**State: committed and pushed on `alpha`, alpha game server deployed.** `server:check`, `build`, `dbtest`, `docaudit` pass; `npm test` all pass except the known `PREDICT_FULL_BUDGET_MS` load flake. Server change: production gets it with the `main` deploy.

- **Report (beta tester):** some replays are not saving, or not viewable sometimes.
- **Cause, reproduced headlessly:** only SOLO record runs kept stepping to finalize after their driver left. In every other room (custom, vs bots, duo record, ranked), the last connected driver leaving between the buzzer and the field settling (up to 10 s, before the results screen appears) froze the room and it was deleted unsaved. That meant no replay, no history row and no ELO. Closing the tab, a network drop and Abandon all lost it.
- **Fix (`server/room.ts`):** `detach` sets `finishing` in any room once nobody is connected inside `inFinishWindow`; `abandonSlot` leaves the seat in any room inside it. Mid-match walkouts are still not saved. Checks: `smoke.ts` "versus buzzer" (they fail on the old code).
- **Ruled out:** the recorder and playback are sound. Real `Room` matches (record, vs bots, mid-match drop and reconnect, late loader, leave at buzzer) re-simulate to the server's exact hash after a JSON round trip. Alpha DB (read-only, aggregates): every match and record in 14 days has a replay; the 11 orphan replays are all Sep 12–19 and match already-fixed bugs.
- **Also:** `fetchReplay` retries a 403 once with a freshly fetched token (`maybeAuthedJson`), because a failed or stale token made a player's OWN versus replay read as "private".
- **Left as is:** deleting an account deletes the versus replays other players were in (`deleteAccount`), which is deliberate.

# HANDOFF — 2026-09-24i (3D matches wait for every driver's physics AND view; 20 s cap)

**State: committed and pushed on `alpha`, alpha game server deployed.** `build`, `server:check`, `docaudit`, `uiaudit`, `bundleaudit` pass. `npm test`: all pass except the known `PREDICT_FULL_BUDGET_MS` load flake (10 ms under 18 processes, 4 ms alone). Server + protocol change: production gets it with the `main` deploy.

- **Owner:** server matches, record runs included, still started while 3D physics/render were loading. Also: cap the wait and start anyway.
- **Cause:** the 2026-09-22 gate (`physicsReady`) is sent from the lobby and covers only the physics chunk. The 3D view loads in the game screen, which is only built on `matchStart`, so it always loaded after the match had started.
- **Fix:** a `'3d'` match now holds at tick 0 after `matchStart` (`Room.beginLoadHold`/`loadHeld`) until every connected `'viewready'` seat sends `{ t: 'viewReady', gen }`. The controller sends it once physics and the scene are up (2D view or a failed scene count). `loadHold` messages drive the loading screen ("Another driver · Loading… starts in Ns") and stop client prediction.
- **Cap:** `LOAD_HOLD_MAX_MS` = 20 s, then the match starts. Late seats are logged server-side and named in the others' event log. The late client joins when loaded, and its loading ticks are excused from the AFK verdict.
- `preloadRoomView` fetches the scene chunk from Lobby/Matchmaking/RecordRun.
- Verified over a real socket against a local server: held at tick 0 for 3 s with no snapshots, released within a tick of `viewReady`; the silent client was started without at 20 s. A browser record run released on its own report.
- Rules: `docs/area/netcode.md` ("THE LOAD HOLD"). Checks: `net3d.ts` §2c.

# HANDOFF — 2026-09-24h (pre-merge pass over the background work alpha added)

**State: committed and pushed on `alpha`.** `npm test` 5055/5055, `dbtest`, `build`, `server:check`, `bundleaudit`, `docaudit`, `uiaudit` pass. Server change: needs `./scripts/fly-deploy.sh --alpha`, and production gets it with the `main` deploy.

Reviewed every timer, poll and spawned process in `origin/main...alpha`. Fixed:
- **Analytics job, advisory lock** (`server/analytics.ts`): lock and unlock went through `q()`, i.e. any pooled connection, so the unlock could land on another session and leave the lock held. Now a dedicated client, as `migrate()` does. A machine that loses the lock race re-arms instead of dropping its rows.
- **Analytics rollup window**: the job rolled "the last three hours" unaligned, and the upsert replaces a bucket, so every pass overwrote the oldest hourly bucket and TODAY'S DAILY ROW with a 3-hour slice. `runRollupGrain` widens to whole buckets. The day rollup and the retention sweep now run at most once per UTC hour (were every 5 min), rolling from a watermark so a quiet spell loses nothing. New `analyticsTick(now)` is exported for dbtest.
- **Star/boost hourly sweeps** (`server/index.ts`): every machine read Postgres hourly with nobody online, waking Neon for 5 billed minutes per machine per hour. They now skip an hour with no signed-in player on that machine (`sweepWanted`). The boot sweep and the on-link sweep are unchanged.
- **Client**: AdminAnalytics auto-refresh and the Discord lobby list (3 s) skip hidden tabs. The builder's 3D turntable skips drawing while scrolled off screen (IntersectionObserver).
- **`npm test`**: the two runners together started 18 processes regardless of core count. Below 19 threads the budget is now split 2:1. No change on a 32-thread box.
- `docs/ui-components.md` regenerated (it was stale from the stow-slider removal and failing `uiaudit`).

Looked at and left alone: the presence heartbeat and pending reaper (already activity-gated), room start retries (bounded; a failed server wasm load exits the process), pad-nav polls (only while a pad is connected), `usePolled` (already visibility-aware), Electron's unlimited-FPS switches (opt-in, default off).

# HANDOFF — 2026-09-24g (titles folded into badges; stargazer is a badge; one claim card per item)

**State: committed and pushed on `alpha`.** `npm test` 5055/5055, `dbtest`, `build`, `server:check`, `uiaudit`, `docaudit`, `contrast` all pass. ⚠️ **Server change + migration 0049**: the alpha game server needs `./scripts/fly-deploy.sh --alpha`, and production needs a deploy from `main` once it gets there.

- **Owner:** "titles are now essentially the same thing as badges … remove titles completely", keep 3 badge slots, no count-based evolving art for now, and stargazer becomes a badge.
- **Migration 0049** strips title items from `reward_grants`, rewrites `title:stargazer` to the `stargazer` badge (the decal stays on the same grant), removes `title:stargazer` from `profiles.cosmetics`, moves anyone wearing a title onto its badge if they hold it and have a free slot, and nulls `profiles.title` (the column stays). A retired per-season title (0045) had no badge, so it is simply taken off; the row stays in the trophy case.
- **Gone:** `TitleChip`/`TitleMark`/`TitlePicker`/the `AwardBadge` hexagon, `earnedTitles`/`setTitle`/`getTitle`/`clearTitleIfEquipped`, `TITLE_KEYS`, `LobbyPlayer.title`, `badgeCols`' title column. Every name surface uses `<BadgeMarks badges={…}/>`. The trophy case is `AwardList.tsx`, each row drawn with `awardBadge`. `awardTitleId` is `awardKey` (dedupe only).
- **Old clients:** `/api/user/title` still answers (GET empty, POST `null` only) and the reward routes still send `title: null, earnedTitles: []` (`RETIRED_TITLE_FIELDS`). Delete both once no pre-0049 client can connect.
- **Claim dialog, one card per item (owner):** the star grant is two cards, badge then decal, each with its own Claim / Equip now. The first card claims the whole grant; Equip now wears that card's item only. `grantCards` (rewards.ts), `answerCard`/`currentCard`/`revealing` (rewardsStore.ts).
- The stargazer disc is drawn by `BadgeArt` (`.badge-mark.tier-stargazer`), not `SupporterBadge`.
- Rules: `docs/area/accounts.md` ("TITLES ARE GONE", "ONE CARD PER ITEM", "THE STAR").

# HANDOFF — 2026-09-24f (BIOBUZZ height dial capped at 18 in)

**State: committed and pushed on `alpha`.** `build`, `server:check`, `docaudit` pass; `npm test` all pass (the `PREDICT_FULL_BUDGET_MS` timing flake failed once and passed on a rerun).

- **Owner:** the height slider went to 29 in, which was too tall. `heightIn` is the robot's TOTAL height, not the chassis.
- `BB3_HEIGHT_MAX` 29 → **18**. The builder slider and `coerceBiobuzzSpec` both read it, so they cannot disagree. The AI roster (15–17 in) was already under it.
- 18 is R102's starting cube, so no coerced build folds any more. The builder's **stow height slider and the R102 note are removed**. The fold rule itself (`bbStowHeightIn`/`bbStowLegal`/`bbHeightNow`, the deploy-edge rebuild) is untouched and still refuses a raw spec off the wire. The 3D preview's "Stowed" toggle is also untouched; it can no longer appear.
- Saved builds over 18 in are clamped to 18 on load.
- Nothing about physics changed. The owner prefers height to be cosmetic eventually, but asked for only the cap for now.
- Tests: the `heightIn` coerce checks use 16/29; the 29-in hive drive-under checks now say R105.A's 29 (raw spec) instead of `BB3_HEIGHT_MAX`; the declared-stow refusal uses an uncoerced spec.

# HANDOFF — 2026-09-24e (custom-room games are saved, so their replays can be watched)

**State: committed and pushed on `alpha`, alpha game server deployed.** `dbtest` all pass, `server:check` and `build` pass. `npm test` has 5 failures out of 5047, all timing checks (`PREDICT_FULL_BUDGET` ×3, the Auto probe, 2v2 `step3d` p95). The parallel session's stargazer/badge SVG work is committed separately ("Badges: every disc badge is one 128×128 SVG…"). ⚠️ **Production still needs a Fly deploy from `main`** once this reaches main.

- **Bug (owner):** users could not see their custom room games. The cause was not `replayAccess`. The games were never saved. `persistVersusMatch` dropped any room without an authed player on both alliances (vs a guest, alone, two accounts on one side), and `persistMatch` deleted the replay. `Room.unpersisted` also wrote nothing at all once a bot had been seated.
- **Fix:** the two-sided rule applies to RANKED only (`server/ranked.ts`). `unpersisted` is channel-only. `MatchOutcome.bots` (room.ts) makes `persistMatch` skip `addActivity`, so bot games still earn no playtime. `getUserStats` played/wins is `m.ranked` only, matching its "Ranked W–L" label (it counted custom games before). `MatchHistory.tsx` shows `—` for an alliance with no signed-in driver.
- LAN and the `replays_public` toggle are unchanged. A one-sided game never goes public (short roster), so only its players and staff can watch it.
- Games played before the deploy are gone, because their replays were never kept.
- Checks: dbtest "versus/ranked|custom|bots" block. net3d "a finished bot room reaches persistence, tagged bots:true" replaces a vacuous check that stopped at tick 700.
- Rule in `docs/area/accounts.md` ("EVERY CUSTOM GAME IS KEPT").

# HANDOFF — 2026-09-23 (branch `fix/discord-frame-ancestors`: the activity was forbidden from being framed)

**READ FIRST if you are on `fix/discord-frame-ancestors`.** Three files, rebased onto
`origin/alpha` @ `838fd2b7`. Pushed, and **PR #82 into `alpha` is OPEN**. Alpha has moved
under this branch several times; `vercel.json` and `docs/deploy.md` have never been touched
upstream, so every rebase has collided on this log alone and nothing else.

**What was wrong.** PR #41 (the Discord Activity) merged into alpha on 2026-09-21 (`eae5b98`). Two
days BEFORE that, `f993507` gave `vercel.json` `X-Frame-Options: DENY` and `frame-ancestors 'none'`,
because the one-click consent controls were frameable. Both are correct in isolation and they
cannot both stand: **a Discord Activity IS an iframe.** The client is served through the proxy at
`<app-id>.discordsays.com` and framed by the Discord client, so `'none'` forbids the whole
activity. Verified live on 2026-09-21: `alpha.playdsim.com` was serving both headers, and
`www.playdsim.com` was not (f993507 has not reached `main`). The two changes were never seen
together because the last real-embed test predates the headers, and nothing in this repo loads
that surface — no audit, no smoke lane, no gate. It fails silently inside Discord.

**The fix.** `frame-ancestors` is an ALLOWLIST instead of `'none'`: `'self'` plus `discord.com`,
`*.discord.com` (canary, ptb) and `*.discordsays.com` (the proxy origin and any nesting inside
it). Every other origin is still refused, so the consent controls keep the protection f993507
gave them. `X-Frame-Options` is REMOVED rather than kept: it has no allowlist, `ALLOW-FROM` is
dead, so `DENY` is all it can say and anything honouring it over the CSP blocks the activity. A
browser new enough to run DSIM supports `frame-ancestors`, so nothing real loses cover. The rule
is written into `docs/deploy.md` §2, because `vercel.json` is strict JSON and cannot hold a
comment — without it the next security pass resets this to `'none'` and kills the activity again.

- **Verified:** the exact directive was served by a local server and driven in a real browser.
  A framer NOT on the allowlist never ran the child (blocked); the same directive with the framer
  appended ran it. So it parses and enforces as intended. `docaudit` ALL PASS. No other gate is
  affected: no CSS, no source, no sim.
- ⚠️ **Still unverified, and only a launch can settle it:** whether Discord's proxy FORWARDS the
  origin's headers to the browser at all. If it does, this is the fix. If it strips them, this is
  inert and harmless, and the embed was never blocked by them. Either way the header is now
  correct. **Nobody has yet launched the activity in a real Discord client since the merge.**
- **Next:** commit, push to the fork, PR into `alpha`. Vercel rebuilds `alpha` on merge, so the
  header ships with that build; no Fly deploy is involved (the alpha game server already answers
  `/api/lobbies`, checked 2026-09-21). Then create a Discord app, map `/` to `alpha.playdsim.com`
  and `/gs` to `dsim-alpha.fly.dev`, and launch it from a voice channel.
---

# 2026-09-24d (NECTAR lip, predicted mouth, FOV + driver view, desktop Google pop-up)

**State: pushed on `alpha` (11870a1).** `build`, `server:check`, `uiaudit`, `docaudit`, `bundleaudit` pass. `npm test`: every check passes except the known load flake `FULL reconciles 40 ticks inside PREDICT_FULL_BUDGET_MS`. It measures 9–10 ms with 12 test processes running and 4 ms alone. It was 3 ms alone before the predicted-mouth change below, so it now flakes more often.

**⚠️ One thing still to do, and it needs the owner:**
- **DONE: the alpha game server is redeployed** from 7cb1b34 (health ok, one machine, shared-cpu-2x iad). The first attempt failed because the flyctl login had passed its 30-day expiry.
- **The desktop Google pop-up ships only with a new desktop release.** `electron/main.cjs` and `preload.cjs` live inside the installed app. The site half is on Vercel already, and older shells keep the in-window redirect.

What landed:
- **A NECTAR seats on the flower's middle ring** (`BB3_FLOWER_NECTAR_SORT_D` 3.4, `buildNectarSorter3d`, `GROUP_NECTAR` / `GROUP_NECTAR_SORTER` in `sim3d/groups.ts`; the pocket filler excludes the new bit too). Before this it sat on the tiles in the retrieval opening, and a ramp lifted it on the way in and dragged it out on the way back. The FLOWER3D lane drives in and back out; the check fails 5 ways with the lip removed. The lone-NECTAR 2D/3D scoring divergence (audit §11.3) is gone.
- **The Full predictor's LOCAL chassis has the authority's mouth** (frame, mechanisms, arms, pocket filler with the lintel folded in; `predictChassisShapes`). The one solid cuboid lifted the predicted robot up to 2.2 in over a wall row of POLLEN with a full hopper. p95 prediction error on the seven bot builds went 0.25 → 0.06 in.
- **FOV slider is horizontal, 60–120°** (`GraphicsSettings.hfov`; a stored vertical `fov` converts once, old default 70 → 100). `graphics/fov.ts` does the conversions, and each camera converts per screen shape.
- **Height-accurate driver view**: the whole field and both hives always in frame, turning smoothly toward the robot (`fitDriverEyeFrame`, `driverEyeFollow`). The eye stands about 77 in behind the real driver spot at 100° to leave turning room. The default driver view (no "Your height") is unchanged: static, whole field.
- **3D view hints** name the player's bound key (`viewKeyName`), not a literal T.
- **Desktop Google sign-in** runs in a pop-up window (`dsim:oauth`), with details in `docs/area/sponsor.md`. It has NOT been exercised against a real Google account here. The wiring is pinned by source checks, and both Electron files parse.

# 2026-09-24c (Controls: conflicts are refused, 3D view keys are rebindable)

**State: green, pushed on `alpha`.** `npm test` 5044 checks all pass. `build`, `server:check`, `uiaudit`, `contrast`, `docaudit` and `bundleaudit` pass. Client-only.

- **Rebinding a key another action holds is REFUSED, not stolen.** `keyConflict` / `padConflict` (`src/input/bindings.ts`) run before any assign. The slot stays armed, the card title turns red and names the holder, the holder's keycap gets a red ring and shakes twice, and the holder's scope button is ringed when it sits in another scope. `assignKey`'s steal code is untouched and still tested; the screen just never reaches it with a taken bind. Rules are in `docs/area/ui.md`.
- **The 3D view keys are bindings**: `VIEW_ACTIONS` = `viewToggle` T, `cameraCycle` **L** (was a hard-coded C, which also placed POLLEN), `eyeUp` I, `eyeDown` O. They are BIOBUZZ-only and keyboard-only, on a new "3D view" card in the BIOBUZZ scope (`seasonPanels` replaces `seasonPanel`). `graphics/viewKey.ts` holds the binds (`setViewBindings`, called from `App.tsx`), and both listeners read them through `viewActionOf`.
- **Migration:** an action missing from a stored blob gets its default only where no stored bind of a conflicting action holds that key (`mergeBindings`). An old Deploy ramp on L keeps L, and the camera starts unbound with the red dot on BIOBUZZ.
- The conflict message names only the FIRST holder found. With C in All games that is Chain Reaction's Catalyst, although BIOBUZZ's Place POLLEN has it too.
- ⚠️ Don't run `npx prettier --write` here. There is no Prettier config, so the defaults (double quotes, 80 columns) rewrite whole files.

# 2026-09-24b (BIOBUZZ PIN line stayed up after the pin stopped)

**State: green, committed (4cfb37f).** `build`, `server:check` pass; `npm test` 3/5039 failures, all timing
(`PREDICT_FULL_BUDGET`, the Auto probe that measures the same budget, 2v2 `step3d` p95).

- **Bug:** the `PIN · 20 IN x.x S` line (event log + score-bar row) drew every entry in
  `penalties.pins`. G421 keeps a PAUSED pin on the books until 3 s of 2 ft distance, so robots that
  stayed close after a brief pin left a frozen countdown up for the rest of the match.
- **Fix:** `PinState.at` (optional, `src/types.ts`) = `world.time` of the last counted tick, set in
  `bbUpdatePins`; `BbPinHud.counting` (`hud.ts`, 0.5 s hold); `soonestPin` skips paused pins.
  Rules unchanged. 3 checks in the rules.ts pause/resume block.
- ⚠️ **Online needs a game-server deploy** (the HUD reads the server's `penalties.pins`). Until
  then a snapshot without `at` reads as counting, which is the old behaviour.

## 2026-09-24 (3D multiplayer: balls teleporting, shots flashing at the intake spot)

**State: green.** `npm test` 5030 checks all pass. `build`, `server:check`, `docaudit` and `bundleaudit` pass. Client-only, so no server deploy is needed.

Two owner reports, both from the networked 3D draw path (`displayWorld` / `drawPredictedElements` in `src/game.ts`):
- **"The balls on the field keep teleporting."** Balls near your robot are drawn on the prediction clock and all others on the interpolation clock, ~10 ticks apart. Every switch between the two was snapped once it passed 6 in: a shot leaving `PREDICT_ELEMENT_RADIUS`, a shot landing in a hive (re-tagged `element`), a shot entering the radius. Fixes: the Full predictor keeps a ball past the radius while it moves faster than `PREDICT_ELEMENT_KEEP_SPEED` (12 in/s, `config.ts`). A ball that lands while drawn predicted stays predicted. Switches ease in up to `BALL_SWITCH_MAX` (48 in), and a single correction now snaps only past `BALL_SMOOTH_MAX` (6 → 12 in).
- **"When I shoot, the ball sometimes appears for a split second where I intaked it."** The newest snapshot said `flight`, but both snapshots the render clock sat between still said `held`, and the lerp drew the held pose. Now the ball stays hidden (it keeps the held state from the snapshot the render clock is on) until the render clock reaches the launch. Your own shot is drawn from the predictor at once.
- Measured with `scratch/teleprobe.ts` (not committed), a real `Room`, a 2v2 of scripted drivers, two seeds, 3 min each. Pops over 6 in per run went from 40–45 to 3–7 at 66–130 ms RTT, and from 46 to 6 at 200 ms. "Ghost" frames, a visible ball more than 6 in from anywhere the server had it loose in the last 20 ticks, went from ~120 to 2–17.
- Checks: `scripts/smoke-biobuzz/net3d.ts` §14 (source rules, release) and §16 (the predictor keeps a moving ball, drops it at rest, and never adds one from outside the radius).
- **Not verified in a live browser match.** The probe copies the client's draw logic rather than running `GameController` itself.

## 2026-09-24 (integration check: 23h + the parallel BIOBUZZ-builder session)

**State: green, UNCOMMITTED** (both sessions' work is still in the tree). `build`, `uiaudit` (after
`uiindex`), `docaudit` pass; full `shiftaudit` 650 state changes, **0 shifts**; `npm test` 2/5036
failures, both known perf flakes (`PREDICT_FULL_BUDGET`, 2v2 `step3d` p95).

- The parallel session left no entry. Its work: BIOBUZZ builder reordered FRAME → INTAKE →
  LAUNCHER → FLOWER SCORING; the refused-cell hint lines under `BbChassisMap` are gone (hover
  title only), and the twin-turret captions carry the glyph; the pass-target picker moved out of
  the builder into a new `GameModule.DrivingRows` slot (end of the Driving panel, `BiobuzzDrivingSlot`);
  presets became a sideways `.ds-opts.robots.strip`.
- **Fixed:** that strip's `scroll-snap-type` was 23h's 4 shifts. Chrome re-snaps to the snapped
  card's TRANSFORMED box, so a hover/press on preset 0 scrolled the strip and slid every other card
  1-2px. `scroll-padding` fixed the hover case but not `:active`, so snap is removed (comment in
  shell.css). Also a stale "My Robot builder" comment on `.ds-passpick`.
- **Presets strip scrollbar** (owner): invisible at rest, a thin `--ds-line-strong` thumb on
  hover/focus (colour only, so 0 shifts). "There is more" is an EDGE FADE (`mask-image` driven by
  `animation-timeline: scroll(self inline)` over `@property --strip-fade-l/r`). Behind
  `@supports`, so Firefox keeps its plain bar. Verified in Electron in both themes: right fade at
  rest, both mid-scroll, left at the end. Not checked: a width where every preset fits (no fade
  expected, because the timeline is inactive). If testers miss the fade, arrow buttons are next.
- Checked, no conflict: the strip's 260px columns vs 23h's `minmax(260px)` grid (strip rule
  outranks); `Marquee` in preset cards (no picture, fits); `DrivingRows` gets the same props as `Builder`.

## Next
- Commit both sessions by hunk (Menu.tsx and shell.css hold both).

## 2026-09-23h (robot cards + pinned hero: bigger picture, marquee, faster entry)

**State: green, UNCOMMITTED.** `build`, `uiaudit`, `docaudit`, `bundleaudit` pass; `npm test`
fails only the known BIOBUZZ perf flakes (a different timing check each run under load). A
PARALLEL SESSION is editing the same tree (Builder.tsx, HudSlots.tsx, PassPicker.tsx, biobuzz
index.ts, adding-a-game.md, AND parts of Menu.tsx/shell.css — the presets `.strip`). Stage by hunk.

- **Cards** (`RobotCard.tsx`, shell.css robot-card block): every SAVED robot, every game, has a
  96px picture as the LEFT COLUMN; name, team, build line to its right. BIOBUZZ's `savedThumb`
  draws its 2D schematic when there is no 3D render; other games get `preview2d` (Menu.tsx).
  Grid `minmax(260px,1fr)` (220 measured worse: 90px text column at 1100).
- **Marquee** (`src/ui/Marquee.tsx`): `DriverName` moved out of Results.tsx unchanged; CSS renamed
  `.resx-name-*` → `.ds-marquee*`, now in shell.css. Two passes, NOT infinite (WCAG 2.2.2; user
  picked this). Used for card name/team and the hero name/team.
- **Hero**: picture column `minmax(200px,30%)`, 160px box; pins from **860px** tall (was 721).
- **Entry lag, measured** (offscreen Electron, cold, long tasks >50ms, `scratch/perf.cjs`):
  DECODE 64 → 0 ms (was 276 with the new card pictures) — `RobotPreview` builds ONE template world
  per document instead of `createWorld` (G304 search, ~30ms) per picture. BIOBUZZ 3D ~210 → ~140
  ms: thumbnail batch on `requestIdleCallback`, one capture per slice, after `scene.ready()`;
  `renderPreview.ts` warms shaders with `compileAsync` before its loop draws. Chunk prefetch was
  measured: no gain, not added. Floor left is context + PMREM setup; sharing the turntable's
  context for thumbnails is the next lever (ponytail note in Preview3D.tsx).
- ~~`shiftaudit` shows 4 shifts on /configure/robot, from the presets `.strip` snap~~ — fixed
  2026-09-24 (snap removed).

## Next
- Commit these files by hunk (Menu.tsx and shell.css hold both sessions' work).
- Owner check on a real screen: hero picture size, card density at 1100/1440.

## 2026-09-23g (3D HUD sponsor logo follows the scrim; records Watch column)

**State: green, pushed to `alpha`.** `build`, `uiaudit`, `contrast`, `docaudit` pass; `npm test` fails
only the known BIOBUZZ perf flakes (2v2 ROOM tick ratio 1.23–1.25 vs 1.2 under load; flips between runs).

- **Bug:** in a 3D match in light theme, the sponsor logo in the MENU/RESET row was the dark-ink cut on the
  dark 3D scrim. Its swap was keyed on `:root[data-theme]`, the only theme-keyed CSS that reaches `.game-root`.
  Fix: `.game-root.view-3d [data-hud-band] .sponsor-logo-swap …` in `shell.css` pins the light-ink cut there.
  Smoke check in `scripts/smoke-biobuzz/sponsor.ts`; rule written into `docs/area/ui.md` HUD section.
- **Also:** `.mobile-edit-bar` joined the 3D scrim list in `styles.css` (it was the one white card in a 3D
  view). `.eventlog` must stay the LAST selector of that list, because `contrast.mjs` regex-finds the block by it.
- `docs/ui-components.md` regenerated (`npm run uiindex`).
- Verified in Electron (offscreen has no WebGL2, so `view-3d` was added by hand): light and dark 3D both show
  the light cut; 2D light still shows the dark cut on the white chip.
- **Records board:** Watch has its own column (`Leaderboard.tsx` + `shell.css`), so the right-aligned Score header sits over the numbers and the button no longer crowds them. Visually hidden header reads "Replay"; the detail row spans 5. On phones Score and Watch pin to the right edge together. Rating board unchanged.

---

# HANDOFF — 2026-09-23f (3D loading screen; perf read-out moved and filled out; prediction picker removed)

**State: green, pushed to `alpha`** (32602e9d, d02eef48, and the 2D-lock fix after them). `build`, `uiaudit` (after `uiindex`),
`docaudit`, `contrast` (383), `bundleaudit` and `npm test` pass. Client-only, no deploy needed.

- **In-match prediction picker removed.** Its buttons never took a click (`.hud` is
  `pointer-events: none`). The setting is Configure › Network only; the PREDICT row in the
  detailed read-out says what is running (`auto · full`).
- **3D loading screen.** `GameController.sceneLoading` is true from the first `syncScene` load
  until the scene mounts: the 2D pass draws nothing and solo does not step. `LoadingScreen` in
  GameView replaces the old "Loading 3D physics…" card and covers field + HUD. First load only.
  Measured in dev: physics ready at ~0.1 s, view at ~0.7–1.1 s, no 2D frame between.
- **Perf read-out.** Simple line is now fps · 1% low · ping ±jitter. Desktop: bottom-right in
  `.net-corner` above the net chips. Phone: unchanged spot, simple only. Frame gaps over 1 s
  (hidden tab) are not sampled.
- **Stuck on 2D / black Graphics (tester report).** A lost GPU context or a failed WebGL2 probe
  used to STORE `'2d'`, and the failed probe was cached for the tab, so 3D could not come back
  without a reload. Now `fallBackTo2d()` (graphics/store.ts) is per tab only, a failed probe is
  not cached, and `releaseRenderer` frees contexts on dispose (`forceContextLoss`), so they no
  longer pile up to Chrome's cap of 16. A lost builder-preview context shows the 2D card with 3D
  one click away. Black screen: lazy pages had no error boundary, so a failed chunk (stale file
  after a deploy) unmounted the app. `LoadBoundary` wraps every `lazy()` page, and `main.tsx`
  reloads once on `vite:preloadError` (`CHUNK_RELOAD_KEY`). Devices that already stored `'2d'`
  keep it, since it looks the same as a real pick; clicking 3D now works.
- **Not verified:** the online ping ± jitter line (no game server in this dev build) and a room's
  loading screen. Both paths are small; worth a look on alpha.

# (previous) HANDOFF — 2026-09-23e (touch pad existence vs readiness; BIOBUZZ chips; phone footer)

**State: green, committed on `alpha` (c56ccaa, 991e8bb, 58d45f6), NOT pushed.** `build`,
`uiaudit` (after `uiindex`), `docaudit` and `contrast` (389) pass, and so does `shiftaudit`
(646 state changes, 0 shifts). `server:check` was not run, because nothing it includes changed.
`npm test`: the shared suite is 2402 checks with 1 failure, the `lan guide` backspace-byte check
already reported in 23c. BIOBUZZ has 8 failures, all perf timing (`step3d` median/p95 ×4,
`PREDICT_FULL_BUDGET` ×3, the Auto probe).
⚠️ **This machine was on the Windows Battery Saver plan** (CPU held at 1.5 GHz). `npm test` took
~400s wall instead of ~40s, and the shared suite alone took 216s. If a run looks hung, check the
power plan before the code. The perf failures are that too.

Tester feedback, all client-only (no deploy needed beyond the usual Vercel build):
- **Touch pad: two questions, on two clocks** (`src/ui/mobileActions.ts`; the rule is written
  up in `docs/area/ui.md`).
  - `present(ctx)` is EXISTENCE, fixed per match by the build and the assists. INTAKE is gone
    under auto intake, SHOOT under auto fire, FLIP in field-centric drive. A default DECODE phone
    is now the two sticks and PARK. The exception is `GameTouch.manualFireCounts`: Chain drum
    and dumper keep SHOOT when aim assist is on (a held fire steers the chassis,
    `chainAimAssist`), and BIOBUZZ always keeps it. This reverses the 2026-09-21 "ghosted, never
    hidden" ruling.
  - `ready(live)` is READINESS, off `touchLiveOf(hud)` at the 10 Hz poll. The cases are an empty
    hopper, no FLOWER in reach, nectar not ok, not carrying, robots disabled, and so on. An
    unready button is drawn `.mobile-btn.idle` IN PLACE (with `aria-disabled`), still sends its
    press, and never moves. A season predicate FAILS OPEN when its HUD half is missing.
    `.mobile-btn.auto` is gone.
- **BIOBUZZ NECTAR LOCKED / PENDING under the score bar.** The phone `.breakdown-row` had a
  literal `bottom: 50px`, which is 6px below the 56px compact `--hud-bottom`. BIOBUZZ also
  rendered its row BEFORE `.scorebar`, so the bar painted over it. The literal is gone and
  `HudSlots.tsx` now renders the row after the bar. Measured: the chips clear the bar by 16px in
  portrait, and in landscape they sit in the right gutter.
- **Phone footer, three rows** (≤640px): the brand ("DSIM · PRESENTED BY" + the Offset mark, as the
  owner chose), then Download · Contributors · (Support) · Changes, then Privacy · Data · Terms.
  `AppShell.tsx` wraps the links in two `.ds-foot-group` spans. On desktop it is still one row.
  Measured with no horizontal overflow at 375 and 320px. The `off-grid-gap` ratchet dropped to
  110.

New checks (smoke.ts, the touch block):
- Stepping the sim with a button held and released proves each hidden button really was dead:
  DECODE auto intake and auto fire, the Chain turret, and the Chain dumper with aim assist off.
  The dumper with aim assist on DOES differ, which is why it keeps SHOOT.
- The existence table per game, the readiness table per row plus fail-open, and `touchLiveOf`
  on synthetic HUD snapshots for all three games.

Gotchas:
- **`coerceAssists` forces `aimAssist = true`** for every setup, so a test wanting aim assist
  OFF must set `w.robots[0].aimAssist = false` after `createChainWorld`. That also means drum
  and dumper SHOOT is always present in real play today.
- A hidden Electron window (`show: false`) runs no rAF, so a match started in it freezes at the
  countdown. That is fine for reading the pad's idle state, but not for anything mid-match.
  Use a fresh `userData` per capture, because a stale profile carries old settings (it showed
  FLIP because `fieldCentric` was false).

Next:
- The owner should try the pad on a real phone in all three games.
- The `lan guide` byte fix from 23c is still open.

---

# (older) HANDOFF — 2026-09-23d (3D view is the default for everyone)

**State: green, pushed on `alpha`.** `npm test` 5025 checks all pass, `build` and `docaudit` pass.

- **The graphics view defaults to 3D.** `getViewPref` (`src/games/biobuzz/graphics/store.ts`)
  returns `'3d'` when nothing is stored. To reset players who had stored `'2d'`, `VIEW_KEY` moved
  from `decodesim.view` to `decodesim.view.v2`. The old key is no longer read, so every device
  starts on 3D once and can switch back to 2D. A device without WebGL still falls back on its own
  (`renderScene` stores `'2d'`). Checks are in `scripts/smoke-biobuzz/render.ts` beside the camera default.
- **Fixed the `lan guide` clone-command check** (`scripts/smoke.ts` 8243): the two 0x08 bytes are `` again.
- **Next:** this reaches production when alpha is promoted to `main`. It is client-only, so no
  server deploy is needed. The old `decodesim.view` value stays in browsers, unread.

---

# (older) HANDOFF — 2026-09-23c (Controls status in the card title; Practice card on Match)

**State: green, committed and pushed on `alpha` (205adb9, 54fc0fd, fa62da7).** `build`, `server:check`, `uiaudit` (after
`uiindex`), `contrast` and `docaudit` pass. `npm test`: 5021 checks. The failures are the known
perf flakes under load (`PREDICT_FULL_BUDGET` ×3, Auto probe, BIOBUZZ `step3d` median/p95 ×4),
plus ONE that was already there before this session: `lan guide: the clone command is built from
LINKS.repo` (`scripts/smoke.ts` ~8243). Its regex holds two LITERAL backspace bytes (0x08) where
`` was meant, and HEAD has the same bytes. The fix is a one-byte change on each side of `LINKS`.
It was left alone as out of scope.

The owner asked for two things:
- **Configure ▸ Controls gap.** The reserved `.ds-hint` status line under the scope switch is
  gone. The message now REPLACES THE TITLE of the card holding the row being edited (`panelFor`
  in `ControlsSection.tsx`; `.ds-panel-title.notice`: accent, sentence case, ellipsis, same
  line-height). The real title moves to a `.ds-sr` span. Prompts stay while a slot is armed, and
  notices fade after `NOTICE_MS` = 4s. The switch now sits `--ds-s-5` above the first card.
- **Configure ▸ Match ▸ Practice card** (below Match setup). It holds Practice physics (3D games
  only) and Partner / Opponent 1 / Opponent 2, each None · Dummy · AI, with a per-seat difficulty
  row that is disabled unless the seat is AI (`OptRow` gained `disabled`). AI is offered only
  where a `BotDriver` exists (BIOBUZZ).
  - Stored per game: `GameSettings.practiceSeats`, coerced in `coerceSettings`; read through
    `practiceSeatsFor`. The legacy `practiceBots`/`practiceDummies` are left in the blob and no
    longer read. The default is all None.
  - Spawned by `practiceSetups` (settings.ts, pure) in BOTH Solo practice and Free drive.
    `GameController.seatBots` now takes an id→tier map. The BIOBUZZ policy already played in
    `freeplay`, so it needed no change.
  - A practice run records `others` (`PracticeRunMeta`). Practice replays shows a "With robots"
    badge.
  - The tutorial override sets `practiceSeats: {}`.

New checks:
- smoke.ts "PRACTICE SEATS" block: coerce round-trip and rejects, and the line-up
  ids/sides/anchors/passive/tiers.
- smoke-biobuzz/ai.ts: an AI drives in free drive, in both 2D and 3D.
- aiplay.ts: the `build` source check now reads `settings.ts`.

Next:
- Not run this session: `shiftaudit` (needs `vite preview`) and the Electron screenshots of the
  Controls title swap and the two-card Match page (DECODE vs BIOBUZZ, phone + desk).

---

# (older) HANDOFF — 2026-09-23b (owner polish: home, hints, play tiles, privacy, queue spacing)

**State: green, committed on `alpha`, NOT pushed.** `build`, `uiaudit`, `contrast` and `docaudit` pass. `npm test`: 5019 checks, and the only failures are the known perf flakes under load (`PREDICT_FULL_BUDGET` ×3, the Auto probe, and BIOBUZZ `step3d` median/p95). Two LAN source-grep checks were updated for `ConsoleHead`. Electron screenshots (desk light, phone dark) of home, /modes, /configure, /privacy and Custom room look right.

What changed, all by owner request:
- **Home:** the season lines are gone: "BIOBUZZ presented by RTX · FIRST Tech Challenge 2026–27" under the switcher (`.ds-home-season`) and "… · 2026–27" in the footer (`.ds-foot-season`). The social pills now sit between the game switcher and the menu. `docs/area/sponsor.md` is updated.
- **Hint lines are back.** They show on the home keycaps (`.mh`), the left rail (`.rh`, which hides when the rail turns horizontal, and Home/Admin have hints too) and the Configure sub-nav (`.sh`, all six sections). This reverses b7009c4's cut.
- **Play tiles** are main's size again: `auto-fit` grid and `min-height: 78px`, with the title centred. The kickers (SOLO / PRACTICE …) stay removed **for good** (owner).
- **"Privacy & cookie settings" → "Data".** The footer link, the policy text that names it (`legalText.ts`) and the doc comments are updated.
- **/privacy:**
  - The policy card and "Your data" share one column (`.ds-legal-col` is `fit-content` to the policy card, and the rest takes `contain: inline-size`). Before this the page had two right edges.
  - `#your-data` now scrolls on a fresh load.
  - `<Announcements>` stands down on the legal pages, like the gates.
  - Stale copy is fixed ("mailbox at the bottom of it", and the markdown header note).
- **Queue/join pages** (Ranked, Record run, Custom room entry/room/builder, Match strategy, LAN, Discord lobbies) share the new `src/ui/ConsoleHead.tsx`. This is design review 02-01. There is one owner per gap:
  - The `.ds-console-in` gap is `--ds-s-5` and nothing in the column adds a margin: `.ds-sub` and the `.ds-panel + .ds-panel` pair are zeroed.
  - The title and its sub are one `.ds-title` group, 8px apart.
  - `.ds-sub-tight` is gone.
  - Head, actions, strategy cards and players are on tokens.
  - RecordRun's in-panel loading line is a `.ds-hint`.
  - `off-grid-gap` baseline is 117 → 112.
- WatchLive was NOT converted: it is a shell page (inside `.ds-main`), not a console page.

Open: the policy says ad requests are ALWAYS tagged for users under the age of consent (`legalText.ts` ~316), but `YourData` says so only when `AD_TFUAC` is set. That is an owner/legal call. Note also that `node_modules` was re-synced with `npm ci` (three, rapier3d and the discord SDK were missing).

---

# HANDOFF — 2026-09-23 (design review 2026-09-22 resolved, waves 1–8)

**State: green, committed on `alpha`, NOT pushed.** `build`, `npm test` (known perf flakes only: `PREDICT_FULL_BUDGET`, BIOBUZZ `step3d` median/p95, the Auto probe and ROOM tick under load; rerun once), `uiaudit`, `contrast` (393 checks), `docaudit` and `server:check` pass. `shiftaudit` 0 shifts over 646 states; `audit.cjs` 0 FAIL · 25 WARN per theme (was 31).

`docs/design-review-2026-09-22.md` is committed, with **§7 Resolution**: all 471 IDs are fixed (file:line) or closed (with a reason). Commits: W1 `5f814ea` correctness · W2 `916c726` a11y semantics · W3 `293a019` contrast/tokens · W4 `318237a` interaction/components · W5 `9b9a0fc` mobile/layout · merge `4469a55` · W6 `28543e8` HUD/game parity/tutorial · W7 `8104901` copy · W7x+W8 `17d8149` replay, builder polish, contract docs.

**The merge.** While the W6 agents were rate-limited, a pull of origin/alpha (the owner's builder-hero rebuild, 06f8971/83a6aec/dfe1084) was left mid-merge, with conflicts in shell.css, Menu, Lobby, tutorial.css and uiaudit. It was resolved as `4469a55`, keeping upstream's structure. RobotCard's nested delete button was re-done as a sibling slot (C09), and the hero was kept flat.

New shared pieces worth knowing (docs/area/ui.md has the rules):
- the shared dialog hook
- `resolveHint` (the tutorial hint collapses an unbound key once, in `runner.view` and in `hintText`)
- `timerPanel.ts`
- the `.ds-badge` family
- `.ds-sr` (one definition)
- `.ds-danger` error ink
- the `font-inherit-mix` uiaudit rule
- the replay speed strip and Space/←/→ keys (new functionality, 09-03)

## Open, owner calls (not done)
- **19-18:** `bbLiftKindLabel` says OFFSET™. This is sponsor-terms naming, and smoke `core.ts:633` pins it.
- **C44:** `.lb-standing` radius. The owner's own 4a1d7ee edit was kept.
- **07-09:** the Records information architecture.
- **`settings.ts:134,174`:** every game's loadout is seeded from DECODE's `DEFAULT_SPEC`. A fresh BIOBUZZ loadout should probably use `BB_DEFAULT_SPEC`.
- **Chain disclaimer:** it now shows only on the first Play via the modes screen. Other routes to a first Chain match skip it.
- **AuthPanel:** the Display name field is gone, so display name = username (08-10).
- **Builder preset tag:** says "Real robot", not "Real team". StarterBot is a kit.
- **Pad-only bind removal:** a gamepad-only user cannot remove a binding.
- **WatchLive badges:** need a server field. The phaseLabel keeps "Autonomous/Final", left as is.
- **`api.ts searchUsers`:** swallows errors by design, so older servers read as "no results".

## Gotchas / device checks
- **`--ds-gold`** is still used for non-reward type at a few sites. The code comments mark them for `--ds-warn`.
- **`.fr-toggle-label`** is a visually-hidden rule local to Friends. Fold it into `.ds-sr` when next there.
- **Phone HUD, portrait 2D:** the status card overlaps the field's top corner by ~26–58px (accepted: it floats over the corner).
- **Phone HUD, landscape:** a DESYNC chip can push the cluster into the breakdown chips (transient).
- **Landscape phone `.eventlog`:** at top 52 / left 14 it overlaps the stacked MENU/RESET column. This predates the review and is now ~7px taller. It needs a phone position.
- **Optional follow-up:** extract a ConsoleHead for RecordRun/MatchStrategy/Lobby/Matchmaking (02-01).

---

# HANDOFF — 2026-09-22f (logos out, HUD, box tube, bots, controls, rewards, robot cards)

**State: green, all on `origin/alpha` (tip `83a6aec`).** `npm test`, `build`, `server:check`,
`uiaudit`, `contrast`, `docaudit`, `dbtest`, `bundleaudit` pass. The one known flake is BIOBUZZ's
`step3d p95` perf check under machine load; rerun once. The alpha server (`dsim-alpha`) was
redeployed from `7c179bb` (migration 0048 applied, boot award job: 7 grants over 2 periods).
The later commits are client-only.

What landed, by owner request:
- **FIRST logos out** (`58ebb3e`): reverted fa2d021 / 60c030b / e5c66da and `brandUrl`.
  `public/brand/` is gone, Chain Reaction's own marks included. The plain-text season name in
  the app bar stays.
- **Top-right HUD** (`db906cc`): RAMP UP/DOWN chip deleted, main's NECTAR column restored.
- **Offset box tube** (`40d6b1b`, `7c179bb`): a vertical three-tube slide with a claw that lands
  on the flower's bore. 2D, builder and 3D share one geometry, and the stowed tower has a
  rounded collider. This changes 3D physics for Box Tube robots, so their replays diverge.
  SIM_VERSION is unchanged.
- **Bots** (`33ea7cf`..`03e7951`): rewritten policy, six-robot non-default build roster picked
  by (seed, seat), server rooms seat bots on their builds. `npm run bench:ai` measures;
  hard solo 62 → 248 pts. New constants live in `src/games/biobuzz/ai/tuning.ts`.
- **Controls** (`5a0f5b4`): shared binds only under All games, season tabs show only that
  season's actions, touch first, Network is its own Configure section, no per-row SYNCED.
  `coerceSettings` folds season-only overrides into main settings and DROPS per-season overrides
  of shared controls. That drop is lossy, but only affects alpha data from the last few days.
- **Rewards** (`3a1a24c`, `31b3976`): every grant is a pending `reward_grants` row claimed in a
  dialog (Claim / Equip now). A grant only skips the dialog if its `REWARD_SOURCES` entry is
  flagged silent. Profile splits into `/account/appearance` and `/account`. Badges carry counts,
  and up to 3 can be worn. Payouts: act top 3 on 1v1 and 2v2, and season records top 3 plus #1
  per drivetrain. Act 0 excluded. One job runs at boot and at rollover, keyed by
  `reward_periods`. `season_awards` (0045) is retired, and its titles stay wearable.
- **Copy and cards** (`bd93ecf`, `b7009c4`, `06f8971`, `83a6aec`): the pass-picker hint and the
  lift blurbs are gone, and the rail and Configure sub-nav carry labels only (home keycaps keep
  their hints). The builder hero is one card that fits every width; saved robots and presets are
  one card with one build line, and that line leaves out an absent Box Tube.

Next:
- **Production** runs migration 0036. Promoting alpha applies 0037–0048, and the first boot pays
  every closed act and season as pending rewards. Ask the owner before deploying.
- **Owner decisions open:** a Box Tube build deploys to ~22.6 in against a declared 14 in height
  (should the builder require more?), and duo record boards are left out of the season payout
  (`RECORD_AWARD_MODES` in `server/db/repo.ts` turns them on).
- **Box tube leftovers:** a side-cell turret next to the tube can still overlap the tower (only
  the centre turret is checked), corner-mount colliders are up to 0.6 in larger than the drawn
  tower, and the claw is drawn empty.
- **Bot leftovers:** 2D easy/medium still give away some G407 points (3.5 / 1.5 per alliance),
  and the old `BB_AI_*` constants in `config.ts` are unused.

Gotchas:
- `Agent` with `isolation: "worktree"` twice produced a worktree at a 347-commit-old commit
  (`fae45c2`), not alpha. Check `git merge-base --is-ancestor origin/alpha HEAD` in a new
  worktree, or create it yourself with `git worktree add <dir> -b <branch> origin/alpha`.
- `.claude/worktrees/agent-af14a4e6938867157` could not be removed (a process holds a file);
  `git worktree remove --force` it later.
- A contributor ("crescent") pushes to alpha directly (`4a1d7ee Update shell.css`); fetch
  before every push.

# (older) HANDOFF — 2026-09-22e (repeat fouls, the BIOBUZZ mass model, presets, builder strip, box tube, front marks, copy)

**State: green.** `npm test` (2288 + 4972, ALL PASS, no flakes hit), `npm run build`, `server:check`,
`uiaudit` (baselines: `literal-radius` 13→12, `off-scale-font-size` 46→45), `docaudit`, `contrast`
(247), `bundleaudit` (`scene` baseline 216.61→221.06, real geometry, note in the file), `test:mm`,
`dbtest`. One commit on `claude/biobuzz-ui-physics-fixes-2745b9`, branched from alpha.

⚠️ **THIS IS A SERVER CHANGE** — G402/G407 billing, `bbMassLimits` in the coercer, the new default
spec, and `LobbyPlayer.title` / `MatchDriver.supporter|role` on the wire. Deploy the game server
with the client. Additive protocol fields only; old clients ignore them.

Owner requests, and where each landed:

- **Fouls bill per instance, not once per match.** `penalties.ts`: G402's `g402billed` latch is gone;
  a (crosser, victim) pair bills on each rising edge of "crossed and in contact", debounced by
  `BB_G402_REARM_S` = 1 s via `world.penalties.episodes` (DECODE's own debounce idiom). The window
  is sized to MEASURED contact chatter: head-on hits never flicker; angled grinds flicker up to
  0.783 s with the chassis never separating (`scratch/g402sweep.ts`, 908 duels). G407's
  `g407billed` no longer gates the STRATEGIC MAJOR (every sustained 6+, every 5+ from the second);
  the flag is still WRITTEN because `hud.ts` reads it for the chip. `robotsContact` →
  `bbRobotsContact`, exported for the chatter checks. Checks in `rules.ts`.
- **BIOBUZZ owns its mass model.** `bbMassLimits(spec)` (`config.ts`): bare chassis (mecanum/xdrive
  11.5, tank 13, swerve 15.5, butterfly 17) + 1.5 per sweeper edge + turret 4 (+3.5 second) +
  dumper 2.5 + Box Tube 2.5 + inertia term. Mecanum + one sweeper + one turret = **18.00** exactly
  (asserted). `bbMassFloorBump`/`BB_TWIN_MASS_FLOOR`/`BB_LIFT_MASS_FLOOR` are gone. ⚠️ One line in
  `src/sim/spawn.ts` (`out.massLb = sp.massLb` inside the existing biobuzz arm) so the shared floor
  no longer lifts a light build before this model is consulted. R104 sets NO weight limit; the 42
  ceiling is the sim's drivetrain envelope and says so. The triangle intake was unbuildable
  (inverted length range) — `bbEnvelope` caps the game floor to the intake ceiling. Not done, flagged:
  `BB_MAX_LENGTH` (17) is dead — `spawn.ts` still sizes with DECODE's `lengthLimits` (15/14.5/13).
- **Presets** (all coercer fixed points, all scored with HARD bots, 3D, 5 seeds vs StarterBot):
  StarterBot 43 · **Pollinator** (`BB_PRESETS[0]`, the new DEFAULT: mecanum, front sweeper, centre
  turret, back tube, 24.5 lb) 55 · **Forager** (butterfly, front+back sweepers, front dumper,
  30.5 lb, 420/300) 64 · Skimmer 68 · Sniper 70. The Hauler (25.8, and Chain Reaction's card
  copied verbatim) is gone. ⚠️ **THE DEFAULT SPEC CHANGED**: 21×17 but asymmetric (front 10.5,
  rear 7.5). Six fixtures measured on the old symmetric one were retuned: `START_CHASSIS_HALF`
  10.5→7.5, G304 probes, `PIN_BUILD`/`PARK_BUILD` (they now STATE their 21×17), the dumper
  close-limit fixture pins `frontback`, the corner-graze scene pins `swerve`. Open: on the
  corner-graze rig mecanum hooks at 0.30 / 94° where swerve slides — the owner's "stuck on a
  corner" for what is now the default drivetrain. 3D-lane work.
- **Robot builder.** The preview is a pinned TOP strip again (owner: the right rail "looks way
  worse"), one row, 105–106 px at every width (the sprite sets the height, not the tiles); static
  at ≤720 tall; off under 1100. `.ds-robot-rail` and the `:has(.ds-subnav-layout)` widening are
  deleted. Placement is a picture: `BbChassisMap` (front up, robot-left = screen-left) replaces all
  four mount pickers with one glyph-labelled chassis diagram; blocked cells are disabled with the
  reason as `title`. Four self-explanatory `d:` sub-lines removed from Menu.tsx.
- **Box tube.** Aims at the NEAR RIM of the top lip (`bbBoxTubeAim` takes `rim`), so the arm stays
  outside the flower column below the plate — 0/13104 poses inside vs 13104/13104 for the centre
  aim (check in `render.ts`). Smoothstep ease at `BB_BOX_TUBE_EXTEND_S` 0.40 s (was linear 0.12),
  retract 0.32, targets slewed at 3 rad/s / 60 in/s so a change of flower sweeps instead of snapping.
- **Front/back.** `bbFrontMarks` (`parts.ts`) is one geometry for both renderers: near-white
  light bar across the front rail (emissive in 3D), a short deck arrow, an amber-ribbed hazard bar
  across the rear. Not alliance colours. Does NOT echo REVERSED (input-level, shared scene).
- **Copy.** "2D" no longer describes the app anywhere (title/meta/manifest/README/CLAUDE.md, the OG
  card regenerated). `APP_TAGLINE` deleted; the home lead sentence, the "Driving X · no team" line
  and "Record runs are played on the 3D physics." removed. Butterfly on the record boards (client
  `BOARDS`, `Board` type, Admin list; server needed nothing).
- **UI consistency / mobile / badges.** The "large plain white text" was `.overlay-panel h2` — a
  bare in-match rule inherited by six shell dialogs and two `.net-overlay-card h3`s; they take
  `.ds-dialog-title` now. Leaderboard rows: table `min-width` 520, nowrap ellipsis names (20ch /
  16ch), fixed score column; lobby roster wraps; the six-entry drivetrain filter is an even 3+3
  under 640 (`.ds-segs.even`). `TitleMark` (award else ledger title) now renders wherever the badge
  did: Profile, Career, MatchHistory, Friends, Lobby, MatchStrategy (which had no badge at all);
  Results roster gets the BADGE only (a title chip clipped a long name to "M." on a 340 px half).

**Follow-up, same day (owner: "You've made UI even worse. Remove 'DSIM · Play'").** The "large plain
white text" was the `.ds-eyebrow` line. Alpha's a0bb3b4 deleted the CSS rule and removed the eyebrow
from three pages, but fourteen other pages (and the home page, re-introduced by the merge) still
rendered `<p className="ds-eyebrow">` as a bare 16px body-ink paragraph. All of them are gone now,
with their dead `APP_NAME` imports. The replay-sharing checkbox in Account was a raw `<span>` in
the same body type; it is a `ToggleRow` (Private / Anyone can watch), and the other `.ds-checkline`
labels (title picker, consent, your-data, admin) take `--ds-t-md` 600 ink. Client-only; no Fly
redeploy needed.

**Follow-up, same day: no server match starts before the 3D chunk is loaded** (owner). A
`'ready3d'` cap + `{t:'physicsReady'}` ClientMsg; a 3D room's `beginMatch` waits for every seated
client that advertised the cap (old clients, bots and disconnected seats count as ready), bounded
by `READY3D_DEADLINE_MS` 45 s. ⚠️ **The deadline STARTS the match, never cancels it**: a client
chooses whether to send `physicsReady`, so a cancel would be a free dodge. Ranked: the strategy
window is extended to the deadline (`extendStrategyForReady3d`, re-broadcast) so a driver still
fetching the chunk is not billed an `unready` dodge; the strategy screen shows `LOADING 3D` per
seat. Custom rooms open the same window with `strategyStart.ranked: false` (no ELO, no countdown)
when every member has both `'strategy'` and `'ready3d'`; otherwise the old immediate start.
Record runs show `.ds-loading` while the chunk loads. Client preloads on queue entry / room mount /
record page (`src/net/roomPhysics.ts`); `LobbyClient.physicsReady()` LATCHES and flushes on
`welcome` (a frame sent behind the join races the async join handler and is dropped). 50 checks in
`net3d.ts` §2b. **SERVER CHANGE — deployed to dsim-alpha.** Details: docs/area/netcode.md.

**Also:** the in-match top-right HUD is main's again (game card alone; SPEC / DESYNC / server chips
in the restored bottom-right `.net-corner`, which carries no `data-hud-band`, so the 3D camera no
longer re-frames when a spectator chip lands). Alpha's later removal of the NECTAR dot column is
kept. The app bar names the loaded season (`.ds-bar-season`, "DSIM · BIOBUZZ").

**Reverted, same day (owner):** the wordmark-tab-strip game picker and the poster-tile/hive-lockup
season artwork (`public/brand/*`, `Season.brand`, `brandUrl`, the `.ds-wordmarks`/`.ds-poster` home
picker, `renderFieldGlb.ts`'s `bannerTexture`) are backed out; the home game picker and the hive
banner are back to how they were before this session touched them. (Landed independently on both
sides of this merge — genius0412/alpha's own 58ebb3e reverts the same thing, same day.)

**Also this day:** the box tube clears the flower's REAL solid (`BB_FLOWER_OUTER_R` measured off the
GLB, tip parks outside the top plate's edge; swept-arm check 0/5176 vs 3736 for the bore aim); the
rear hazard bar is gone (owner: not FTC); the title picker is `.ds-opt` tiles; the footer's Discord
link (back via a main merge, unstyled) is gone; ~70 copy strings de-padded; `Admin.tsx` drivetrain
list and the OG card gained Butterfly / lost "2D".

Gotchas found on the way: `@discord/embedded-app-sdk` was not installed in this worktree (a bare
`npm install` fixed the build). `scripts/smoke-biobuzz/sim3d.ts` and `docs/area/biobuzz.md` are
stored with CRLF in the repo (everything else is LF); they were staged with `core.autocrlf=false`
so this commit does not rewrite every line of both. Normalize them in a commit of their own.

Next: deploy alpha (`./scripts/fly-deploy.sh --alpha` from an alpha tree) and check a match's
foul log; decide `BB_MAX_LENGTH`; the mecanum corner hook.
# HANDOFF — 2026-09-22d (merged origin/main into alpha — LAN Screen Redesign + CR HudChips)

**State at the time: green.** `npm run build`, `npm run server:check`, `npm run uiaudit` (all rules at or
under baseline, `off-grid-gap` ratcheted 146 → 144), `npm run contrast` (249 pairs) and
`npm run docaudit` all pass. `npm test` has the one known machine-load perf flake
(`perf: bot-driven 2v2 step3d p95 <= 1.5ms`) and nothing else — 4774 checks. Working tree
clean; merge commit is `b142895`.

**What came in:** main's LAN Screen Redesign (`LanPanel.tsx` fully rewritten — tabbed
host/join, `initialName` propagated into `Lobby`), Chain Reaction's own `ChainHudChips`
(`src/games/chain/HudSlots.tsx`, new file) plus the `pinnedNotice` slot's PIN/CONTROL-5+
relocation into the event log (`GameModule.pinnedNotice`, `eventlog-pinned`), the Admin
console's Users tab and a corrected Aadvik Gupta GitHub handle, and assorted `ui-fixes` PR
work (`Admin.tsx`'s `adm-*` spacing classes, `.park-status`/`.sub-hud`/`.cr-hud` CSS).

⚠️ **TWO classes of merge bug, not just textual conflicts, and both are worth knowing about
before the next big merge:**
- **Diff-alignment gave wrong "clean" merges on at least a dozen files.** Every page's
  `<p className="ds-eyebrow">…</p>` line (Account, AppShell's footer Discord link, Changelog,
  Configure, Contributors, Donate, Download, HomeMenu's `season`/`APP_TAGLINE`, Legal,
  ModeSelect, Profile, Records, WatchLive, `seasons.ts`'s `APP_TAGLINE` export itself) vanished
  with NO conflict marker — git matched alpha's later addition against unrelated main content
  near the same heading and silently dropped it. Three pages (DesktopUpdate, MatchHistory,
  PracticeReplays) reverted from alpha's `.ds-panel`+`OptRow` refactor back to main's older
  `.ds-sec` markup the same way. Caught by `tsc` (`Cannot find name 'season'`, unused-import
  errors) for the ones that broke the build; the rest only showed up by diffing every
  "cleanly" merged file against `23fe5a5` by hand. **If you merge main again and a page's
  brand line or panel styling looks off, diff it against alpha's last tip before assuming
  it's new.**
- **`scripts/smoke.ts` conflicted across its ENTIRE 46k lines** (one `<<<<<<<` at line 1, one
  `>>>>>>>` at the end) — not a real whole-file conflict, `git show :2:` was emitting CRLF
  (Windows `core.autocrlf=true`) while `:1:`/`:3:` came out LF, so every line differed. Fixed
  by re-running `git merge-file` on `\r`-stripped extractions of all three stages, which
  produced a normal, small, correct conflict. Same trick unstuck `contributors.ts` and several
  `src/ui/*.tsx` files. **If a merge conflict spans a whole large file, suspect line endings
  before attempting a manual resolution.**

Judgment calls, in case they need revisiting: kept alpha's BIOBUZZ NECTAR-chip removal (owner
ruling 2026-09-19) over main's same-day dot-row redesign of it — ported main's PIN/CONTROL-5+
relocation and flower-icon layout forward onto alpha's decision, and added the G407 MAJOR
escalation to `BiobuzzPinnedNotice` since main's version predates that feature. Kept alpha's
`PerfHud` consolidation (owner ruling 2026-09-19 — the old NetQuality/ping-graph click target
never worked, `.hud` is `pointer-events: none`) over main's `net-corner`/`NetQuality` re-add.

---

# HANDOFF — 2026-09-22c (the solo breakdown sits on the page's own centre line)

**State at the time: green.** `npm run build`, `npm run uiaudit` (all rules at baseline) and the measured
harness below all pass. `npm test` has the TWO known machine-load perf flakes and nothing else
(`perf: bot-driven 2v2 step3d p95 <= 1.5ms`, `FULL reconciles 40 ticks inside
PREDICT_FULL_BUDGET_MS`) — see 2026-09-22b's note; this change is CSS and a comment, and the
smoke harness never loads either. Uncommitted: `src/ui/styles.css`, `src/ui/Results.tsx`,
`docs/ui-components.md` (regenerated — the CSS edit moved ~23 lines, so nine `ds-*` line numbers
in the index shifted; `uiaudit`'s `stale-component-index` is a hard 0, so it must be committed
WITH the CSS).

Owner: the three blocks stacked in the one-panel content column — the header, the breakdown, the
notes + buttons — did not share a centre line. The middle one sat left.

- ⚠️ **`.resx-val` IS OUT OF FLOW ON THE ONE-PANEL TABLE, and that is what centres the labels.**
  In flow it took a table column of its own, so `.resx-cat` (`width: 100%`) absorbed only what
  was LEFT of it and centred its label on THAT midline — measured 32.9px left of the title and
  the button row at 1440px, 52px at 2560px. Positioned (`absolute; top: 0; right: 0`, containing
  block `.resx-breakdown-solo tr`), the label cell is the table's only column, so its centre IS
  the table midline, which is already the axis `.resx-bar` and `.resx-secondary` centre on.
  **The number does not move**: `right: 0` plus the cell's own `1em` padding is exactly where the
  in-flow column put it (measured identical to 0.0px, horizontally and vertically).
- **`.resx-cat`'s `padding-inline: 4em` is SYMMETRIC on purpose.** It reserves the gutter the
  value now floats over, and being equal on both sides it cannot move the centre — so the number
  only has to be big enough to keep a long label off the value, never exact. Worst label in the
  app is a DECODE record run's `Fouls committed (3 minor · 1 major)`: it clears by 162px at
  1440×860 and 86px at 390×844.
- The `colSpan={1}` ruling below (2026-09-22b) STANDS and its reason is now simpler: with one
  in-flow column the heading's box is the whole table, which is the label's box. Its comment in
  `Results.tsx` was rewritten — spanning two would also land on the axis today, and would drift
  again the moment the value returned to flow.
- **Verified by measurement, not by squinting**: `scratch/center.cjs` (gitignored, beside the
  existing `scratch/results.html` harness — `npm run dev`, then
  `env -u ELECTRON_RUN_AS_NODE npx electron scratch/center.cjs --port <n>`). It reads the label
  and heading TEXT centres (a `Range` rect, not the cell's — a centred cell with lopsided padding
  still paints its label off-axis), then re-applies the OLD rules in the same page and diffs, so
  "labels moved onto the axis, values did not move" is two numbers. `--label` forces the long
  record-run label in; `--w/--h` covers the narrow stacked layout.
- VERSUS is untouched: it has `.resx-rv`/`.resx-bv` and is already symmetric about `.resx-cat`.

---

# HANDOFF — 2026-09-22b (biobuzz results: points-only rows, name marquee, section-label fix)

**Owner follow-up #3 — the one-panel content stack CENTRES as a group.**

- ⚠️ **`.resx-body-solo` IS FIVE ROWS: `1fr auto auto auto 1fr`.** The header, the breakdown and
  the actions sit in rows 2/3/4 and the two `1fr` spacers centre THE WHOLE STACK. The versus
  board pins its header to the top and its actions to the bottom because two alliance panels
  flank the column and give it edges — a one-panel board has nothing on one side, so the same
  three-row map left the title marooned at the top, the buttons at the bottom, and two voids
  around a centred table (owner: "all this stuff for solo match results should appear
  vertically centered with each other").
  - **The panel now spans rows 1 → 6**, so "top to bottom and nothing trims it" is unchanged —
    re-measured, `panel steady` in all eight states at 2560×1392.
  - The `:has(.resx-half.blue)` mirror block carries the SAME five-row map; its placements are
    rows 2/3/4 of column 1. If you change one map, change both.
  - The narrow `@media (max-width: 720px)` block still re-declares its own four-row map and
    still wins on source order — verified, nothing scrolls at 1280×720 and the blue mirror
    correctly does not apply below 721.
  - VERSUS is untouched: only `.resx-body-solo` moved.

**Owner follow-up #2 — the roster row, and a marquee.**

- ⚠️ **A LONG DRIVER NAME MARQUEES; THE ROW NEVER WRAPS.** `.resx-roster-row` is `nowrap` and
  the NAME is the only part that gives (`flex: 0 1 auto` + `min-width: 0` on both the name and
  the clip inside it) — it used to wrap, which pushed the team number onto a second line and,
  on a versus board, put the two halves' rows at different heights. `DriverName`
  (`Results.tsx`) measures the overflow and sets `.scroll`; a name that fits never moves.
  Three bugs were found by LOOKING at the capture, and each would have shipped silently:
  - ⚠️ **`scrollWidth` ON AN INLINE ELEMENT IS 0**, so the overflow test was false for every
    name however long and the marquee never once fired. It is
    `getBoundingClientRect().width` now. The text span has to STAY inline for the
    `text-overflow: ellipsis` fallback to apply to it, so making it a block was not the fix.
  - ⚠️ **THE FIRST MEASUREMENT IS TAKEN IN THE FALLBACK FACE.** Both families are `@fontsource`
    variable cuts, and the fallback is narrower — a name that overflows Plus Jakarta measured
    as fitting. `document.fonts?.ready` re-measures. A `ResizeObserver` cannot catch it: the
    CLIP's box never changes, only the text's.
  - `flex: 1 1 auto` on the name made it GROW, which dragged the YOU chip off the name it
    belongs to and parked it against the team number. Shrink-only is the whole intent.
  - Reduced motion switches the marquee off outright — capping an INFINITE animation's
    duration only makes it loop faster — and the clip falls back to its ellipsis.
- **The roster row is display type now.** `.resx-you` 0.85em, `.resx-roster-meta` **1.05em** —
  deliberately over 1em, because the team number is what a driver looks for on a scoreboard, so
  it is the LARGEST item in the row rather than the smallest. The ELO delta rides the same size.
  One-panel rows are 5.2u (67px at 1392). The row's column gap is `2u`: once a long name has
  eaten the slack, that gap is the only thing separating the name block from the team number.
- **`🏆` is gone from WORLD RECORD** — the gold fill is already the loudest treatment on the
  stage and an emoji beside it says the same thing twice, in a face that is not the UI's. The
  `core.ts` assertion on that exact string moved with it.
- ⚠️ **THE SOLO SECTION HEADING IS `colSpan={1}`, NOT 2.** Spanning both columns centred it on
  the TABLE's midline while `.resx-cat` (which carries `width: 100%`) centres its label on the
  midline of everything left of the value column — so every heading sat half a value-column to
  the RIGHT of the labels under it. One column means the heading's box IS the label's box.
- ⚠️ **`npm run test:bb` has ONE failure and it is NOT this work.** `perf: a 2v2 BIOBUZZ ROOM
  tick costs <= 1.2x a 2v2 Chain Reaction room tick` (ratio 1.33). **Verified by STASHING every
  change and re-running: the clean tree fails it identically at 1.33** (4507 checks vs 4516).
  It and the `step3d p95` gate below trade places depending on machine load.

**Owner follow-up, same session — six changes on top of everything below.**

- ⚠️ **A BLUE ONE-PANEL BOARD NOW SITS ON THE RIGHT** (`@media (min-width: 721px)`, a
  `:has(.resx-half.blue)` block). The winner banner bleeds toward its own ALLIANCE's outer wall
  — red's left, blue's right — and that is a property of the alliance, not of the layout. With
  every one-panel board pinned to the left column, a blue panel squared its banner against the
  INNER seam, so the tag read as glued to the details column instead of running off the screen.
  Record runs are forced blue server-side, so that was every one of them. Owner: "this way, it
  will always look like the banner extends from off the screen."
  - Scoped to the **complement of the narrow breakpoint** so the stacked layout needs no
    `:has()` counterpart to out-specify — one column has nothing to mirror. Verified at 400×800:
    the panel is still at x=0.
  - `AllianceHalf`'s `outward` is now just `alliance === 'red'`, and **the `versus` prop is
    gone** — it existed only to make a lone panel read as the left one, which is no longer true.
- **The banner is the thing that changed most.** `padding: 0.34em 0.75em` with
  `min-height: calc(1em + 2 * 0.34em)`. ⚠️ **Those two are one edit**: the reserved slot must
  equal a filled banner exactly, and with `line-height: 1` that height IS `1em + 2 × the
  vertical padding`. Both `em` of the banner's own size, so they stay equal at every viewport;
  the `2 *` is written out rather than pre-multiplied so the relationship is legible at both
  sites. Measured `bannerH=[69,69]` (was 36 before this session, 49 mid-way).
- Versus panels **25% → 30%** each. One-panel categories and section heads are **centred**, like
  the versus board's — left-aligned they sat against the panel seam with the value at the far
  wall and the row read as two unrelated things across a 1280px column.
- `.resx-body-solo .resx-roster-row` is **4.4u** (58px at 1392): a one-panel board has ONE driver
  row in a half-width panel where a versus board has up to two in a 30% one.
- **Gates after the follow-up:** `uiaudit` ALL AT OR UNDER (146/146), `build`, `contrast` (237),
  `shiftaudit` (596 changes, 0 shifts), `resshot` panel steady in all 8 states — and the
  one-panel boards now report `x=1280`, which is the mirror landing.
- ⚠️ **`npm run test:bb` is 4516 checks with ONE failure, and it is the documented flake:**
  `perf: bot-driven 2v2 step3d p95 <= 1.5ms` (1.629ms under load). **It PASSES at 1.416ms when
  `--lane ai` runs alone**, which is exactly what the note below predicts. A second perf check
  (`BIOBUZZ ROOM tick <= 1.2x Chain`) also failed once while a dev server and Electron captures
  were running and passed on a quiet machine. Nothing in this work touches sim code.

---

**READ FIRST — the screen is sized off ONE custom property and the row count PAYS for it.**
`--resx-u: clamp(7px, min(0.92vh, 0.62vw), 19px)` on `.resx-stage`, and every size on the
stage is an inline `calc(n * var(--resx-u))`. The multipliers are the ratios the screen already
shipped, so nothing is re-proportioned — it just SCALES now, which it never did: only
`.resx-sting` and `.resx-total-num` were viewport-driven and everything else was flat chrome
type on what is often a 1400px display. Measured before: the whole red half of a versus board
carried ink on **22 rows out of 1340**.

- ⚠️ **NINE ROWS IS A LAYOUT INVARIANT, NOT A CONTENT PREFERENCE.** `biobuzzResultsRows` is
  points-only now (owner ruling) — 17 → 9. The arithmetic only closes at nine: at 2560×1392 the
  worst board (ranked versus: 2 notes, a 2-row button block, 2 report links) lands at **1347 of
  1392**, and seventeen rows of the same type overruns any display by ~390px. `core.ts` pins the
  row count, the exact nine labels in order, that no unit parenthetical survives, and per-section
  label uniqueness — none of which anything asserted before. The `*Count` fields are still
  computed; putting a row back is one `row(…)` tuple, but it costs the type size.
- ⚠️ **PADDING ON A `border-collapse: collapse` TABLE IS IGNORED OUTRIGHT.** The one-panel
  boards' value column ran to the stage wall (nothing catches it there — on the versus board the
  alliance fill does). `padding-inline` on `.resx-breakdown-solo` did NOTHING: measured, the last
  value's box still ended exactly on the viewport edge, gap 0. It is
  `width: calc(100% - 2 * var(--resx-pad))` with the existing `margin: … auto` re-centring it.
  Now 42px each side at 1392, 24px at 720.
- ⚠️ **THE REPORT LINKS CANNOT BE SIZED BY INHERITANCE.** `.results-report` /
  `.results-report-done` set size through a `font:` SHORTHAND in `shell.css`, and an expanded
  longhand is not reachable from an ancestor's `font-size` — they sat at 12px under 30px buttons.
  All four elements also carry `resx-linkbtn`, so one declaration in the existing
  `.resx-stage .resx-linkbtn` block does it: (0,2,0) beats the shorthand's (0,1,0) whichever file
  loads last. Measured back at 23.05px. **No `shell.css` edit**, which is what keeps
  `off-scale-font-size` frozen at 46.
- **The versus centre track is `25% minmax(0,1fr) 25%`** — that closes 21h's ⚠️ KNOWN item. The
  `auto` track was why a shrink-wrapped table floated in a void AND why both panels narrowed
  525 → 516 when the actions row arrived. `resshot` now prints `panel steady` for versus too.
  The comment at that rule was rewritten; **do not put an `auto` track back.** One-panel is
  `50% minmax(0,1fr)` (the owner's "half the screen"). `minmax(0,…)` on BOTH boards: a bare
  `1fr` is `minmax(auto,1fr)` and the buttons are `white-space: nowrap`, so the one-panel board
  was never actually immune the way 21h claimed.
- **The banner moved OUT of `.resx-half-top`** (the only `Results.tsx` edit) so that block can
  be `flex: 1; justify-content: center` — banner welded to the top edge, roster centred, total
  pinned at the bottom. That closes 21h's "name and stats towards the centre" open item.
  `min-height: calc(1em + 2 * var(--ds-s-1))` is UNTOUCHED and still self-corrects; measured
  `bannerH=[49,49] rosterTop=[390,390]`, both pairs equal. Only the banner's HORIZONTAL padding
  scales (`0.5em`) — the vertical token is what the min-height calc references.
- ⚠️ **21h's "uiaudit does not catch a repeated DESCENDANT selector" IS WRONG.**
  `scripts/uiaudit.mjs:133` records any single selector at depth 0, descendant ones included;
  only `@media` interiors are exempt. The new `.resx-stage .overlay-buttons button` block is safe
  because the two existing `.resx-stage .overlay-buttons …` rules are comma LISTS, which claim no
  name. Grep before adding another.
- `off-grid-gap` baseline **149 → 146** (`scripts/uiaudit.mjs:69`): all three resx offenders were
  off-grid because they were sized for 15px type, and they are `em` now.
- **Gates, all green on this tree:** `uiaudit` (146/146, ALL AT OR UNDER), `build`, `contrast`
  (237), `test:bb` all lanes (**4516 CHECKS, ALL PASS**), `shiftaudit` (596 state changes, 0
  shifts), `resshot` panel steady in all 8 states at 2560×1392 and 1280×720, and nothing scrolls
  at 2560×1392 / 1440×860 / 1280×720.
- **`npm run shiftaudit` fails in an agent shell** — the npm script runs bare `electron`, and the
  shell exports `ELECTRON_RUN_AS_NODE=1`, so `app` is undefined. Use
  `env -u ELECTRON_RUN_AS_NODE npx electron scripts/shiftaudit.cjs`. Same gotcha the verify skill
  documents for `scratch/*.cjs`; it bites the packaged script too.
- **`@discord/embedded-app-sdk` was in `package.json` but missing from `node_modules`**, so
  `npm run build` failed on an import unrelated to any of this. `npm install` fixes it; I reverted
  the `package-lock.json` churn it produced (`peer: true` flags, a different npm version).
- `scratch/edge.cjs` is new (gitignored): prints the computed ladder, the table's edge gaps and
  whether the stage scrolls, per state and viewport. That is what caught the table-padding bug.
- **OPEN, owner's call:** the ad. When `ResultsAd` renders it adds a fixed 300×264 box the ladder
  cannot scale, plus `.menu-ad`'s `32px 0 8px` — ~296px against 45px of slack on the worst board.
  The stage is `overflow-y: auto` and already scrolled there before this work. Sizing the board to
  fit WITH the ad needs the unit near 0.7vh, which undoes the ask; the better answer is where the
  ad lives.
- **Chain Reaction stays airy** — 3 sections / 3 rows against a unit sized for BIOBUZZ's and
  DECODE's ~58u breakdowns. If that comes back as a complaint the answer is rows, not a unit.

---

# HANDOFF — 2026-09-22a (alpha: the star reward actually works now, and says so)

**READ FIRST.** Gates on alpha at the tip: `npm test` 4,742 ALL PASS, `dbtest`, `build`,
`server:check`, `docaudit`, `bundleaudit` ALL PASS, `uiaudit` at baseline, `contrast` 247.
`dsim-alpha` deployed, `/health` ok. **The GitHub star reward is LIVE and verified end to end:**
the log reads `[rewards] star sweep: +1 -0 of 7 stargazers`.

⚠️ **THE REWARD WAS BUILT, DEPLOYED, CORRECTLY CONFIGURED — AND GRANTED NOTHING, FOR A
REASON THAT WAS NOT IN THE SWEEP.** The only thing that ever granted was
`setInterval(…, 1 h)`, created at BOOT. First fire is an hour after start and every deploy
pushes it back another hour, so on a day with several alpha deploys it never ran once. Nothing
was broken; there was simply no path from "somebody linked" to "somebody is granted" that ran
in human time. Fixed three ways, and all three are worth keeping:

1. **The link route sweeps for itself**, before the redirect. One GitHub request either way
   (the sweep reads the REPO's stargazers, never the person), and it is wrapped — the link is
   already committed by then and an outage must not turn a good link into `?link=error`.
2. **One sweep 30 s after boot.** This is what actually granted the owner's. It is also the
   only thing that catches a star made while the process was down.
3. **`StarReward`** (`src/ui/StarReward.tsx`) — the panel on the bounce back. Even a working
   grant was silent, and silent is indistinguishable from broken.

⚠️ **AND THE SWEEP WAS SILENT IN MOST OF ITS OUTCOMES, WHICH COST AN HOUR OF DIAGNOSIS.** The
no-links path returned with NO log; the applied path logged only when something CHANGED. So
"never ran", "ran, nobody linked" and "ran, changed nothing" were indistinguishable from
outside — three situations with three different fixes. Every path prints one line now, tagged
with the caller (`boot` / `hourly` / `link`).

⚠️ **`GITHUB_TOKEN` NEEDS `public_repo`, AND "NO SCOPES" IS WRONG.** Measured: an unscoped
classic PAT authenticates, reads `/repos/<repo>` and `/contributors` at 200, and **404s** on
`/stargazers` — GitHub answers 404 rather than 403 there, so the one status that reads as a
typo is the one that means the token is too weak. GraphQL is worse, not a way round: the same
token reads `stargazerCount: 7` and gets ZERO nodes. All four failure modes (401, 403-limited,
403-forbidden, 404) name themselves now, with `dbtest` checks on the sentences.

⚠️ **THE FIRST `earned` COSMETIC WAS UNSELECTABLE, AND THE PICKER WAS THE ONLY BROKEN LINK.**
`CosmeticsRows` held `const earned = NO_EARNED_COSMETICS` — a hardcoded `[]` from back when
nothing fell through to the `earned` tier. Its own comment named the one thing to change
("wiring the real one in later is this one name") and it was still missed when `decal:star`
became the first key to fall through. Everything either side already worked:
`/api/user/entitlements` has sent `unlockedCosmetics` since 0044, the join path loads
`client.earnedCosmetics`, and `server/room.ts` strips on every re-pick. The list rides on
`AdsProvider`'s context now — that provider already fetched the endpoint for the ad gate and
was discarding the field. **Any future `earned` key inherits this working path**; three smoke
greps stop the placeholder returning.

⚠️ **THE SHARD RUNNER'S SUMMARY LINE LIED ABOUT A DEAD SHARD.** `bad` and the exit code were
always right and the per-shard death block printed, but the LAST line — the one anybody reads
— said `0 FAILURES`. Measured: a transform error in one shard dropped 146 checks and still
summarised as 0 FAILURES. Fixed and verified by injecting a broken block (`1 SHARD(S) DIED`,
exit 1).

⚠️ **`sed -i` STRIPS CRLF AND PRODUCES 25,000-LINE DIFFS.** `scripts/smoke.ts` and
`scripts/dbtest.ts` have CRLF blobs in git; a `sed -i` pass rewrites the whole file as LF, and
the diff then hides the real change. Caught on `smoke.ts` and converted back (25 lines instead
of 25k). **`scripts/dbtest.ts` was already flipped in `ad5234a` and shipped** — left as LF
because converting back is a second full rewrite that recovers nothing, and its blame is
already spent. There is NO `.gitattributes` and `core.autocrlf=true`, so this will recur:
prefer a Python round-trip with `newline=''` over `sed -i` on these files. Adding
`* text=auto` would fix it repo-wide but rewrites many blobs — an owner decision, not taken.

⚠️ **PRODUCTION DOES NOT HAVE THE REWARDS ROUTES.** `dohun-sim-decode`'s
`/api/user/links` answers **200 with a PROFILE** — an older `/api/user/:id` pattern is
swallowing the path and reading "links" as a user id. Harmless today (no client calls it
there), but it means any prod rollout has to confirm route ORDER, not just that the code
shipped. Alpha 401s correctly.

**WHAT THE STAR NOW GIVES:** `title:stargazer` and `decal:star`. Both move as a UNIT on one
holder set read off the title (`STARGAZER_GRANTS`) — a half-grant or half-revoke is a state no
later sweep repairs, and the unlink path had that bug waiting. The decal is `earned` tier, the
first that file has ever had, deliberately NOT a supporter fill: a star is one click, and
gifting a Ko-fi colour for one click prices the membership at one click.

**STILL UNVERIFIED:** the Discord boost perk end to end (the bot reads the guild — 422 members,
intent on — but nobody is boosting, so nothing has been granted); and the Discord redirect URI
registration, which Discord only validates client-side.

---

# HANDOFF — 2026-09-21l (alpha: mobile, the overhead cross, real tile mats, the OAuth bounce)

**READ FIRST.** Gates on alpha at `d4d0b70`: `npm test` ALL PASS (4,735 biobuzz + shared),
`build`, `server:check`, `dbtest` ALL PASS, `uiaudit` at baseline, `contrast` **247**,
`docaudit`, `bundleaudit`. `dsim-alpha` deployed and `/health` ok; one machine, iad,
shared-cpu-2x.

**FIVE THINGS SHIPPED**, all owner-asked:

1. **Mobile.** Per-game action sets (`src/games/*/mobile.ts` behind `src/ui/mobileActions.ts`)
   instead of the shell guessing three buttons for every game. The pad-navigation CSS
   (`data-padnav`, `.ds-padhint`, `.ds-osk*`) was referenced by five class names and defined
   in ZERO stylesheets — it exists now.
2. **The cross over the top-down view**, which was a regression of mine: the venue's lighting
   truss hangs under the ceiling and the overhead camera sits at z=800, so it looked straight
   through a 5×5 beam grid. Truss and fittings are on `VENUE_OVERHEAD_LAYER`; the side cameras
   see them, the overhead and PiP cameras do not (`scratch/crosslayer.ts` checks all five
   enclosed venues).
3. **Real field tiles** at higher mesh detail — `src/games/biobuzz/scene/renderTiles.ts`.
4. **The mat colour**, below.
5. **Minimap off** on all four presets.

⚠️ **THE MAT COLOUR RULE CHANGED, AND THE OLD ONE IS WRITTEN DOWN IN PLACES THAT NO LONGER
GOVERN.** The 3D mat used to be pinned to `COLORS.tile`'s luminance because `contrast.mjs`
measured the driver label's FILL against the lightest ground it crosses — which made the field
itself the ceiling on that pair. `LABEL_STROKE` is OPAQUE now, so the governing pair is
fill-against-its-own-stroke and it does not move when the field does. A SECOND ceiling was
underneath it and is the one that sets the value: canvas on-field TEXT. Measured against
`--ds-on-field-dim` at AA, `#585858` reads 3.77 and was backed out; `#454545` is the lightest
neutral that holds. The seam LIP is the tighter cap of the two (`#565656` read 3.89, so it is
`#4c4c4c`) — it is ground a glyph sits on just as much as the mat is, and the first pass
missed it. Both are pinned in `contrast.mjs`. **`COLORS.mat`/`COLORS.tile` are UNTOUCHED** —
those are the 2D board for all three games and repainting DECODE's was never the ask.

**THE REWARDS SECRETS ARE SET ON `dsim-alpha`** — nine of them, from the owner's
`D:/Projects/2ddecodesim/.env`, mapped onto the names the server actually reads
(`*_OAUTH_ID` → `*_OAUTH_CLIENT_ID`). What is verified against the REAL providers, and what
is not:

| | |
|---|---|
| Discord bot reads the guild | ✓ 200, **422 members**, 0 boosting — so the SERVER MEMBERS intent is ON |
| GitHub OAuth client id + secret | ✓ a bogus code at the token endpoint returns `bad_verification_code`, not `incorrect_client_credentials` and not `redirect_uri_mismatch` |
| Discord OAuth client id + secret | ✓ same probe returns `invalid_grant`, not `invalid_client` |
| Discord redirect URI registered | **UNVERIFIED** — Discord validates it client-side in a SPA and does not check it before the code, so neither probe reaches it |
| the browser round trip | **UNVERIFIED** — it needs a person to sign in and click through |
| the star sweep | **OFF.** See below. |

⚠️ **`GITHUB_TOKEN` NEEDS THE `public_repo` SCOPE. RESOLVED — alpha carries one and the
live fetch returns all seven ids** (`complete: true`, numeric, unique, through the real
`fetchStargazers`). It is written down because my advice was wrong TWICE on the way here —
first that the token was optional, then that it needed no scopes — and the second one is a
trap anybody would fall into. MEASURED 2026-09-21 with an unscoped classic PAT that
authenticates perfectly (5,000/hr, `/user` 200):

    /repos/genius0412/dsim                200  ("private": false)   /contributors  200
    /repos/genius0412/dsim/stargazers     404                       /followers     200
    /repos/octocat/Hello-World/stargazers 404                       /forks         200

Not the repo, not privacy, not the budget: starring and watching are gated where every
neighbouring list endpoint is not. **GitHub answers 404 rather than 403 there**, so a caller
cannot use the status to learn a repo exists — which means the one status that reads as "you
typed the name wrong" is also the one that means "your token is too weak". GraphQL is worse,
not a way round: the same token reads `stargazerCount: 7` and gets ZERO nodes. A token with
`repo` returns all seven; `public_repo` is its read-only subset.

401, 403-rate-limited, 403-forbidden and 404 each say what they mean now rather than printing
a status code, `dbtest` pins all four sentences, and alpha boots with no rewards warning.

**WHAT IS STILL UNEXERCISED:** the sweep does not fire until somebody has linked a GitHub
account (`liveLinks('github')` is empty, so it returns before the request). So the first real
end-to-end run of the star reward happens in the hour after the first link, and until then a
configuration mistake there would be invisible — which is the whole reason the four sentences
above exist.

⚠️ **AND IT WAS REQUIRED AT ALL, WHICH IS THE FIRST HALF OF THE SAME MISTAKE.** Found by calling the API once the rest was
in place. MEASURED anonymously from a clean rate-limit budget on a repo that is genuinely
public (`GET /repos/genius0412/dsim` → 200, `"private": false`): the stargazers endpoint answers
**401 Requires authentication**, and 200 with any credential. `stargazers.ts` had said the
opposite — optional, buys rate limit alone. The defect was not the 401 but how quiet it is:
every layer below `fetchStargazers` refuses to act on a list it cannot trust, so an
unauthenticated deploy sweeps hourly, logs one generic line, and is indistinguishable from a
repo nobody has starred. It now refuses BEFORE the request, names the variable, warns at BOOT
rather than an hour later (confirmed in the deployed log), and three `dbtest` checks pin it.
The token needs NO SCOPES; a personal CLI token must not be reused here.

Two more things that are not obvious:

- **The provider callback is registered on the GAME SERVER, not the site.** Vercel serves the
  SPA and proxies nothing to Fly, so it is `https://dsim-alpha.fly.dev/api/link/<p>/callback`.
  A GitHub OAuth App accepts exactly ONE callback URL, so **alpha and production need separate
  GitHub apps**; a Discord application takes several redirect URIs and can serve both.
- **`APP_ORIGIN` is new and the flow is broken without it on any real deploy.** Found while
  wiring the credentials: the callback 302'd to a relative `/account`, and the game server does
  not serve the app (only a LAN self-host does, via `SERVE_CLIENT`), so every link ended in a
  404 on `dsim-alpha.fly.dev`. It is an env var rather than something the client hands to
  `/start`, because a server that redirects wherever it is told is an open redirect whatever
  else is signed around it. Unset is correct for `npm run dev` and LAN, where the two origins
  are the same one.

**NOT DONE / NOT CHECKED.** Nothing in the link flow has been exercised end to end against a
real provider — it cannot be until the secrets land. Alpha's entry chunk is still ~20.7 KB over
its own baseline, from the results-redesign commits rather than the Discord PR (+2.18 KB), and
that is still unexplained.

---

# HANDOFF — 2026-09-21k (alpha: rewards A, B and C are BUILT — only owner setup is left)

**READ FIRST.** Gates on alpha at `951ac33`: `npm test` ALL PASS (2,202 shared + 4,702
biobuzz), `build`, `server:check`, `dbtest` ALL PASS, `uiaudit` at baseline, `contrast` 239,
`docaudit`, `bundleaudit`. `dsim-alpha` deployed; 0045–0047 applied. Live-verified:
`/api/user/links` and `/api/link/github/start` 401 without a token, and a FORGED `state` on
the callback 302s to `?link=error`.

**THERE IS NO REWARDS CODE LEFT TO WRITE.** What remains is owner setup only: two OAuth
apps, a bot, and four Fly secrets. The guide is §“Owner setup” in
`docs/rewards-round2-plan.md`.

- ⚠️ **THE SERVER DOES THE CODE EXCHANGE, AND THE PLAN WAS WRONG ABOUT THIS.** It had
  GitHub linking through the auth SDK with the client POSTing its own provider id. That is
  forgeable — anybody could post a stargazer's id and take the reward for a star somebody
  else gave, the same impersonation primitive `LobbyPlayer.role` is server-authored against.
  One authorization-code flow (`server/oauthLink.ts`), the id arrives from the PROVIDER, and
  **neither provider now depends on the Neon Auth dashboard** — which removed a blocker
  rather than adding one.
- ⚠️ **NO TOKEN IS STORED, ANYWHERE.** One identity fetch, then dropped. The signed `state`
  uses a PER-BOOT key: no new secret to manage, and a link in flight across a deploy is
  refused rather than forged.
- ⚠️ **`ensureSupporterFloor` MUST NEVER BECOME `EXTEND_SQL`.** That adds MONTHS; an hourly
  sweep through it mints a decade on the one column behind the badge, ads-off, the
  saved-start cap and the palette. The test was written first: 1,001 sweeps leave it 7.00
  days out, where EXTEND_SQL gives ~30,030.
- ⚠️ **TWO BUGS THE TESTS CAUGHT, BOTH MINE.** `RETURNING` sees the row AFTER the update, so
  “did the floor move?” was always false and the first sweep logged nothing — a CTE snapshots
  the old value (`RETURNING OLD.col` is PG 18; this is 17). And an empty first member page
  fell through to the MAX_PAGES branch, logging a pagination error for what is really the
  intent-is-off signature.
- ⚠️ **AN EMPTY DISCORD MEMBER LIST IS A FAILURE, NOT A FACT.** With the intent off Discord
  returns `[]` with a 200. The floor expires by arriving, so that revokes nothing outright —
  it stops extending and every booster lapses a week later with nothing in the log.
- **UNLINKING GITHUB TAKES THE TITLE WITH IT** (and clears it if equipped), or the decal
  outlives the proof and unlink-keep-relink is a farm. The 0047 row survives regardless.
- ⚠️ **THE `GUILD_MEMBERS` INTENT IS A TOGGLE, NOT AN APPROVAL** — threshold moved
  2026-06-10 to 10,000 unique users. Earlier entries in this log say otherwise and are wrong.

## Next

- Owner setup (see the plan). Nothing ships to players until then — every sweep is a no-op
  with no links and the panel hides a provider with no credentials.
- ⚠️ **ALPHA'S ENTRY CHUNK IS ~20.7 KB OVER ITS OWN BASELINE AND IT IS STILL UNEXPLAINED.**
  The results redesign grew it without re-measuring; baseline raised to 946.79 with the split
  attributed in `bundleaudit.mjs`.
- The two HDRIs now buy only IBL and reflections since the venue hides them. Product call.

---

# HANDOFF — 2026-09-21j (alpha: rewards stage A COMPLETE, stage B's server half, and the venue)

Gates on alpha at `3272b6f`: `npm test` ALL PASS (**2,202** shared + 4,702
biobuzz), `build`, `server:check`, `dbtest` ALL PASS, `uiaudit` (all at baseline), `contrast`
(**239**), `docaudit`, `bundleaudit`. `dsim-alpha` redeployed; 0045/0046/0047 applied at boot.

**STAGE A IS DONE AND SHIPPED.** Season awards, equippable titles, the badge, the board chip
and the picker. **STAGE B's server half is done too** — schema, anti-farm, entitlement, set
algebra, fetch and sweep. What B still needs is not code: **the owner enabling GitHub in the
Neon Auth project** (Neon offers Google/GitHub/Vercel only — see below), after which the link
button is the last piece. Stage C (Discord) needs bespoke OAuth for the same reason.

- **AWARDS** (`0045`, `0046`). Owner's counts: ranked top 3/mode, record overall top 3 +
  per-drivetrain top 1, and the DUO record board the same pair. Champion / Finalist /
  Semifinalist.
  - ⚠️ **`startNewSeason` IS ONE TRANSACTION NOW.** It was four loose `q()` calls and `q()`
    takes a connection PER CALL. With awards in the roll that stops being untidy: insert the
    new season, fail to write the awards, and the closed season is permanently un-awarded,
    because the next attempt reads `closing` from a `seasons` table that already moved on.
  - ⚠️ **THE CLOSING SEASON IS AWARDED, AT THE ACT IT BELONGED TO.** `act` may already be
    bumped for the season being OPENED; stamping that names the wrong act in every title on
    any roll that starts a new act.
  - ⚠️ **`user_id` IS IN THE UNIQUE SLOT INDEX BECAUSE A DUO AWARD HAS TWO HOLDERS.** Keying
    on (board, rank) alone lets the first insert and rejects the second — silently awarding
    one half of a team.
  - Every board read is the board's own function called the way the site calls it:
    `recordLeaderboard` with NO `physics` argument (passing one mints an award for a holder
    the public board hides) and ranked through `eloHistoryLeaderboard`, keyed by
    BALANCE_VERSION — `eloLeaderboard` is keyed by ACT and names the wrong person on every
    season but an act's last.
- **TITLES ARE DERIVED, NOT STORED** (`awardTitleId`, and it lives in `src/awards.ts` beside
  `parseAwardTitleId` so the writer and reader cannot drift). ⚠️ **A PARSED ID HAS NO
  ACT/SEASON** — they are on the ROW for the sentence, so a parsed award renders through
  `awardShortText` and NOT `awardTitleText`. ⚠️ **THE BOARD CHIP COSTS NO JOIN**: `badgeCols`
  carries `profiles.title` off a row it already joined and the client parses it. That is why
  the id is derived from the slot rather than being a surrogate key.
- **THE BADGE** (owner delegated): a HEXAGON with the rank numeral, one saturated violet
  (`--ds-award`). ⚠️ **GOLD/SILVER/BRONZE IS THE TRAP** — gold already means supporter, and
  silver and bronze are desaturated by definition, which is the exact failure
  `docs/area/accounts.md` records. Checked by eye in both themes.
- **STAGE B, SERVER HALF** (`0047`). ⚠️ **A TABLE, NOT A COLUMN, BECAUSE OF THE UNLINK**:
  `(provider, provider_user_id)` is the PK and an unlink stamps `unlinked_at` rather than
  deleting, so unlink-and-relink on a second account cannot mint the reward again. Stores the
  provider id and two timestamps — **never a token**, because every reward asks the platform
  about its OWN resource.
  - ⚠️ **A LEDGER TITLE IS NOT A ROBOT-SPEC AXIS.** The plan said to put `title:` in
    `COSMETIC_AXES`; that is wrong on contact — that registry is the axes of a `Cosmetics` on
    a `RobotSpec` and `clampCosmetics` folds each onto a FIELD of it. `TITLE_KEYS` is its own
    closed set in the same ledger.
  - ⚠️ **THE SWEEP DECIDES BY SET DIFFERENCE, AND A TEST CAUGHT WHY.** `grantCosmetic` is
    idempotent in EFFECT but not in its RETURN — its UPDATE matches the profile row either
    way — so driving the audit off it wrote a `cosmetics.grant` row on EVERY sweep.
  - ⚠️ **`complete: false` CHANGES NOTHING** — the whole cost of unstarring revoking. Every
    failure path in `fetchStargazers` sets it: non-2xx, throw, unparseable body, a body that
    is not an array (the rate-limit shape), MAX_PAGES. Revoking also CLEARS an equipped title.
- ⚠️ **A NEW dbtest IMPORT MAY HAVE TO BE LAZY.** `server/stargazers` at the top of the file
  pulls `db/repo` → `server/moderation`, which reads its key AT MODULE SCOPE, so it resolved
  DISABLED before the stub sets the env and the replay name-scrub check went red three
  thousand lines away. The stub's header warns about it; the eager import walked in anyway.
- **THE VENUE** — real geometry around the field, `scene/renderVenue.ts`, written up in
  `docs/area/biobuzz.md` under Environments. The "blurry lights" were the dome's lower half
  smeared by `backgroundBlurriness`, plus no ground at all on the CAD field.
- **PASS TO YOUR PARTNER** (`bbPass`) — the target is a POINT, never the partner.

## Next

- **Stage B's last piece**: the link button, once GitHub is enabled in Neon Auth. ⚠️ **Neon
  Auth offers Google, GitHub and Vercel ONLY** (owner, 2026-09-21), so **Discord needs a
  bespoke authorization-code flow** in `server/api.ts` — `identify` scope, store the
  snowflake, discard the tokens. Budget +0.5–1 day on stage C.
- ⚠️ **THE `GUILD_MEMBERS` INTENT IS A TOGGLE, NOT AN APPROVAL — corrected 2026-09-21,
  earlier entries in this log say otherwise and are WRONG.** Discord moved the review
  threshold on 2026-06-10 from “100 servers” to **10,000 unique users across every server
  the app is in**; below that it is a checkbox in the Developer Portal. DSIM's bot would be
  in one guild. So stage C's blocker is the bespoke OAuth alone — do not re-cost the perk
  around a refusal that is not coming. `docs/rewards-round2-plan.md` §10.4.
  ⚠️ **But WITHOUT the intent `GET /guilds/{id}/members` returns an EMPTY ARRAY WITH NO
  ERROR.** The boost perk is a rolling FLOOR, so that does not revoke anything outright —
  it stops extending, and every booster lapses at the end of the grace window with nothing
  in the log. The boost sweep needs `fetchStargazers`' `complete` discipline, and an empty
  member list must be treated as SUSPECT rather than as “nobody is boosting”.
- **NO INSTAGRAM FOLLOW REWARD** (owner, decided). A follow is unverifiable: the
  follower/relationship endpoints went in 2018, Basic Display died 2024-12-04, and there is no
  `follows` webhook. `docs/rewards-round2-plan.md` §10 is the framework for the next platform.
- ⚠️ **ALPHA'S ENTRY CHUNK IS ~20.7 KB OVER ITS OWN BASELINE AND IT IS NOT THE DISCORD PR'S.**
  The results redesign (5392737..918173b) grew it without re-measuring; the baseline was
  raised to 946.79 with the split attributed in `bundleaudit.mjs`. Still unexplained.
- The two HDRIs (`school-hall`, `monochrome-studio`) still download 1.6–1.7 MB and now buy
  only IBL and reflections, since the venue geometry hides the photograph. Product call.

---

# HANDOFF — 2026-09-21i (alpha: the venue, PASS, rewards stage A, and four fixes)

Gates on alpha at `4755321`: `npm test` ALL PASS (**2,184** shared + **4,702**
biobuzz), `build`, `server:check`, `dbtest`, `uiaudit` (all at baseline), `contrast` (237),
`docaudit`, `bundleaudit`. `dsim-alpha` redeployed and healthy (0045/0046 applied at boot).

⚠️ **`npm test` WAS RED ON EVERY WINDOWS CHECKOUT AND NOBODY HAD CHANGED THE CODE.** 21h's
header blames `freeCam.ts:186` and calls it "that file's owner's call" — it was neither the
comment's fault nor the file's. The two source guards in `smoke.ts` split on `'\n'`, and JS
`.` does not match `\r`, so on a CRLF checkout `^\s*\*.*$` cannot reach the end of a JSDoc
line and strips NOTHING — the guard then reads a COMMENT as code. They split on `/\r?\n/`
now. It went red the moment git normalised that file on commit; every `core.autocrlf`
checkout was already in that state.

- **HIVE ELEMENTS STOPPED DROOPING IN SERVER ROOMS** (owner: "constantly drooping downwards
  and teleporting back up"). The FULL predictor's near set is every non-held ball within
  `PREDICT_ELEMENT_RADIUS` and it built them all DYNAMIC — but an `element` tag means the
  AUTHORITY holds it, and nothing in the prediction world catches a hive cell. MEASURED, six
  seated elements over 100 reconciles: the predicted body sat **-1.76 in mean, -1.96 worst**
  under an authoritative z whose range was **0.000** — ½gt² for the window, i.e. free fall.
  Kinematic now (not skipped, so a chassis still feels a flower column). NET3D §15.
- **THE RAMP WILL NOT DEPLOY THROUGH ANOTHER ROBOT.** The swing guard filtered on
  `isFixed()` — written to the first wording of the rule, "any non-moving solid thing" — and
  a chassis is not fixed. `rampSwingHitsStatic` is `rampSwingBlocked` and takes the other
  robots' body handles. Refused at 16..24 in nose-to-nose, deploys at 26+; with robots left
  out it deploys at every gap, so the SIM3D check is not vacuous.
- **PR #41 (Discord Activity) MERGED** after four conflicts (all generated/log files) and
  four fixes: a grouped room is no longer joinable by code alone (`/api/lobbies?group=`
  publishes CODES to anyone holding the `instance_id`, and a harvested code was a bearer
  token in the ordinary web join box forever); the fly-replay region is validated before it
  reaches a header (an unvalidated one THROWS inside the handler and the socket hangs);
  `/discord-lobbies` had no `parsePath` arm so a reload landed on home; and an inline
  negative margin that `uiaudit`'s regex cannot see.
  ⚠️ **ALPHA'S BUNDLE RATCHET WAS ALREADY RED BEFORE THAT MERGE** — alpha alone builds a
  944.61 KB entry chunk against a 923.89 baseline. The results redesign (5392737..918173b)
  grew it ~20.7 KB and did not re-measure. PR #41 added **+2.18 KB**. Baseline raised to the
  measured 946.79 WITH the split attributed in `bundleaudit.mjs`'s header; **the 20.7 is not
  explained and is not mine.**
- **A REAL VENUE AROUND THE FIELD.** The surround was `scene.background` alone: no parallax
  (sampled by view direction), no horizon (every camera looks DOWN, so the frame samples the
  dome's lower half and `backgroundBlurriness` smears it — that band IS the "blurry lights"),
  and no ground at all on the CAD field (`bb-room` was only added by the constants fallback).
  `renderVenue.ts`: hall / arena / studio / outdoor, one InstancedMesh per category. +1.86 KB
  scene, **zero asset bytes**, worst case 7 draws and 5,762 tris. Only LOW takes the cut.
- **PASS TO YOUR PARTNER** (`bbPass`). ⚠️ **The target is a POINT, never the partner** —
  owner: "in real life, you can't know where your opponent is accurately." `spec.bbPassTarget`
  or the alliance LOADING ZONE. Lands 0.2/3.0/5.8 in from a 102-in preset.
  ⚠️ **Gating on `sol.reachable` alone is wrong and I shipped it once in draft**: a solved arc
  says a shot EXISTS, not that the turret has slewed onto it — the hive path gets that free
  from `bbTurretShotEnters`. Without `bbTurretOnTarget` the three passes landed 34.8/64.2/78.3
  in short. Turreted builds only; **unbound on the pad** (0..15 all taken, 15 is the menu
  button) with an EXACT allowlist in the smoke check so a second one cannot join quietly.
- **REWARDS STAGE A** — `0045_season_awards`, `0046_titles`, and `startNewSeason` is one
  transaction at last (it was four loose `q()` calls, and `q()` takes a connection per call).
  Owner's counts: ranked top 3/mode, record overall top 3 + per-drivetrain top 1, and the DUO
  board gets the same pair. ⚠️ `user_id` is IN the unique slot index because a duo award has
  TWO holders. ⚠️ The **closing** season is awarded, at the act it belonged to — `act` may
  already be bumped for the one being opened. Titles are DERIVED (`awardTitleId`), never
  stored. `docs/rewards-round2-plan.md` is the plan; §10 is the framework for adding socials.
  **Owner decisions taken: unstarring REVOKES** (free — same sweep, `revokeCosmetic` already
  exists; the cost is the FAIL-SAFE rule, since a failed fetch would otherwise strip everyone)
  and **NO Instagram follow reward** — a follow is unverifiable, the follower/relationship
  endpoints went in 2018, Basic Display died 2024-12-04, and there is no `follows` webhook.

## Next

- Stage A's **UI half is not built**: `awardTitleText`, the `AwardBadge` chip (decided: one
  hexagon, one saturated violet, rank as a numeral — gold/silver/bronze is the trap, gold is
  supporter and the other two are desaturated by definition), the leaderboard chip, Career
  "Awards", the title picker, the API surface, and a `contrast.mjs` pair for the new hue.
- Stage B (GitHub) is unblocked — Neon Auth has GitHub. **Discord needs bespoke OAuth**: Neon
  Auth offers Google, GitHub and Vercel only. `guilds.members.read` returns `premium_since`
  and needs no privileged intent, but re-checking needs a stored refresh token or a
  user-present button — the bot + `GUILD_MEMBERS` intent is still the cleaner route.
- `docs/area/biobuzz.md`'s Environments bullet is now partly stale (it says the surround is
  the dome) and wants a Venue paragraph.
- The two HDRIs (`school-hall`, `monochrome-studio`) still download 1.6–1.7 MB and now buy
  only IBL and reflections, since the geometry hides the photograph. Product call.

---

# HANDOFF — 2026-09-21h (the ONE-PANEL results screen: a full-height panel beside its content)

** `npm test` is red on this tree for TWO reasons and NEITHER is this work.**
`npm run test:bb --lane core` is ALL PASS, and `build`, `server:check`, `uiaudit` (all at
baseline, none moved), `contrast` (235) and `docaudit` are green.

1. `scripts/smoke.ts` — "sim source uses NO engine-defined Math" flags
   `src/games/biobuzz/graphics/freeCam.ts:186`, which is a **doc comment** spelling
   `Math.exp(deltaY * rate)` while describing where the real call lives. It was at :159 before
   the free-cam work moved it, so it has now survived two commits. ⚠️ **21g's header claims
   `npm test` ALL PASS; on this tree it does not** — this is a deterministic source grep, so it
   fails everywhere. One word, either in the comment or in the grep, but it is that file's
   owner's call. While it is red the BIOBUZZ suite does not run under `npm test` at all.
2. `perf: bot-driven 2v2 step3d p95 <= 1.5ms` — wall-clock, and it swings with machine load
   (1.63 / 1.66 / 2.07 / 4.66 ms across runs today, and it PASSES when its lane runs alone).
   Established earlier by running the full suite on a clean tree and getting the same numbers.

- **THE PANEL RUNS TOP TO BOTTOM AND NOTHING TRIMS IT** (owner: "blue must be top to bottom …
  when buttons or the title text appears, it should not trim the blue"). A record run and a
  practice run with no opponent drew a 640px card centred in a flex column — title above,
  buttons below, both eating into the fill, and the panel's height changing as the sequence
  revealed them. `.resx-body-solo` is **two columns** now (`1fr 2fr`): the alliance panel owns
  the left one and spans all three rows; the header, the breakdown and the actions stack down
  the right. **Measured, not eyeballed**: 480×860 before the actions row and after it, in all
  six one-panel states.
  - ⚠️ **COMPOUND placements.** A plain `.resx-body-solo .resx-half` ties
    `.resx-half.red { grid-area }` at (0,2,0) and loses on source order — the exact bug that
    put the header under the panel in `8812b4c`. `.red`/`.blue` wins at (0,3,0), and a
    multi-selector list claims no name so `duplicate-selector` stays 0.
  - The BREAKDOWN moved OUT of the panel into the content column, so the panel is short and
    the laptop-scroll open item from 21e is closed.

- **⚠️ AN EMPTY BANNER RESERVED NOTHING, AND THAT WAS A LIVE REGRESSION ON THE VERSUS BOARD.**
  `visibility: hidden` keeps a box, but a block with no text has no line box, so the slot
  collapsed to its 8px of padding. Measured: `bannerH=[8,36] rosterTop=[40,68]` — the losing
  half's roster sat **28px above** the winner's, which is the one thing the reserved slot
  exists to prevent. `min-height: calc(1em + 2 * var(--ds-s-1))` fixes it; the padding is
  added back because the box is border-box (`min-height: 1em` alone gave 28, not 36). Now
  `[36,36]` / `[68,68]`.

- **The banner is a PROP, not a `versus` flag.** `AllianceHalf` gated it on `versus`, which is
  what removed it from this screen; `win`/`tie` are gone and an empty `text` means "reserved
  but blank" — the versus loser and a rank still in flight, from one rule.
  `src/ui/recordBanner.ts` is a DOM-free leaf (the smoke suite imports it) deciding: **gold**
  for a WORLD RECORD, the ordinary banner for a PERSONAL BEST, a quiet `#9 OF 128` for a plain
  placing, blank while the rank is in flight, PRACTICE for a run with no leaderboard.
  `--ds-gold-ink` on `--ds-gold` is already an audited AA pair, so the loudest thing on the
  screen cost no new colour.

- **`RecordStanding` qualifies the banner and never repeats it.** A record prints
  `Solo · Mecanum · #1 of 128`; a plain placing has its rank in the banner already, so only the
  category is left. Its five state classes had **no CSS at all** before this — a world record
  and 12th place rendered identically.

- **The signed-out prompt is a BUTTON.** It read "… see your rank →" as a plain `<p>`, an arrow
  promising an affordance the markup did not have. `onSignIn` threads App → GameView → Results
  the way `Matchmaking` already does, and is optional.

- ⚠️ **KNOWN, on the VERSUS board only, and NOT fixed:** the actions row's buttons are wider
  than the breakdown, the versus centre track is `auto`, so when the row appears both panels
  narrow — **525px → 516px**. Neither `width: 0; min-width: 100%` nor `contain: inline-size`
  stops an intrinsic contribution there; the deterministic fix is a percentage track
  (`33% 1fr 33%`), which changes that board's proportions and wants its own commit. The
  one-panel screens are immune: `fr` tracks never size to content.

- ⚠️ **OPEN, owner's call:** with the panel now full height, "name and stats towards the
  centre" is only *partly* delivered. The restored slot moves the driver row down ~35px, which
  is what was asked for, but there is far more empty blue below it than there was in the 640px
  card, so it still reads as top-anchored. One line
  (`.resx-half-top { margin-block: auto }`, roughly) would centre it properly.

- **Verified with the harness, extended:** `scratch/results.{html,tsx}` now covers
  `versus | tie | solo | wr | pb | rank | pending | signedout` and passes **blue** (a record run
  is forced to blue server-side — the earlier captures used red and were unrepresentative).
  `scratch/resshot.cjs` MEASURES the panel box before and after the actions row and prints
  "panel steady" / "PANEL MOVED", which is the must-have itself; `scratch/measure.cjs` prints
  banner heights and roster tops, which is how the collapse above was found. Neither
  `shiftaudit` (13 menu routes) nor `uiindex` (`ds-` classes only) can see this screen.

- New check: `recordBanner` in `scripts/smoke-biobuzz/core.ts` — every state's text and tone,
  that a world record outranks the personal best it also is, and that no two VISIBLE states
  print the same banner.

---

# HANDOFF — 2026-09-21g (alpha: controller navigation finished and wired; free-cam presets carried over)

Gates on this tree: `npm test` ALL PASS (**2,165** shared + **4,494** biobuzz),
`build`, `server:check`, `uiaudit` (ALL AT BASELINE), `docaudit`, `contrast` (235). The tree is
`.claude/worktrees/alpha-flower-intake-plate-930ef5`, branch
`claude/alpha-flower-intake-plate-930ef5`, which sits on alpha's tip.

A previous round of agents stopped mid-flight at 12:30 — the gate logs in `scratch/`
(`npmtest.log`, `gate-build.log`, `gate-server.log`) are stamped 12:26–12:27 and three pad-nav
files were written AFTER them. Two workstreams were in the tree:

- **Free camera presets, the invisible robot, and the rest of the 21f follow-ups** — code
  complete and GATED at 12:26, untouched since. `docs/biobuzz/free-cam-presets.md` is the
  evidence file for each preset row (vendor page, its own wording, and what it does NOT state);
  `scratch/handoff-invisbox.md` is the long form of the chassis-envelope fix. Nothing here was
  re-opened.
- **Controller navigation** — the core and the layer were written, they typechecked, and they
  were **not wired to anything**. Three gaps, all closed below.

## What was missing, and what closed it

- **THE FOCUS RING DID NOT EXIST.** `PadNavLayer` sets `data-padnav="on"` and renders
  `.ds-padhint` / `.ds-osk*`, and **not one of those selectors was in any stylesheet** — the
  layer drew an unstyled keyboard and no ring at all. `shell.css` now carries the block, and it
  rings plain `:focus` under the attribute rather than `:focus-visible`, because a pad move is a
  synthetic `.focus()` that Chromium does not reliably grant `:focus-visible` to. Inside
  `.hud`/`.game-root` it takes `--ds-on-field-accent` (category 3 — the field is hardcoded dark).
  Verified in a real browser, both themes: ring `#366758` in the shell, `#5fb597` over the field.
- ⚠️ **THE IN-MATCH CONTRACT WAS NEVER APPLIED.** The design says the pad is the robot's in a
  match, and `PadNavLayer`'s own comment says `GameView` registers the menu opener — but
  `GameView` did not import `padNav` at all, so **nothing suspended the layer and
  `setPadMenuHandler` had no caller**: a connected pad would have moved focus and fired
  synthetic clicks off the same stick the driver was steering with. `GameView` now suspends for
  its whole mount and registers `onExit`, MOUNT-ONCE with `onExit` in a ref — it is a fresh
  arrow every render and `App` re-renders on the presence poll, which would otherwise tear the
  suspension down mid-match. (The Controls screen's `'capture'` suspend was already wired.)
- **NO CHECKS.** The core was split DOM-free explicitly so `npm test` could drive it, and had
  none. 48 new checks in one block in `scripts/smoke.ts` (2,117 → 2,165): the picker's
  cross-axis term on a ragged grid, the strictly-past rule, determinism on repeated geometry,
  wrap, the repeat clock's monotonicity and floor, the slider profile crossing 100 steps under
  4 s, family detection by name and by USB vendor id, the Nintendo confirm/back swap, the
  suspend registry's overlap, the mask's release semantics, and the OSK reducer's one-shot caps
  and `maxLength` cap. The load-bearing one is **`⚠️ padnav: the in-match MENU button is an
  index no default pad bind uses`** — it asserts 15 against `DEFAULT_BINDINGS` instead of
  trusting the comment, because a future default taking it would make the button that leaves a
  match also drive the robot.

## The one design change

`.ds-key` was reused for the legend rather than declaring a second keycap — but it is sized for
a bind ROW, where the cap has to hold SHIFT (`min-width: 34px`, `4px 10px`). At that size the
caps were wider than the words they annotate and the legend read as three empty boxes. The
legend and the keyboard's foot size it down (`--ds-s-0`, which §2 permits inside a chip and
nowhere else) instead of adding a class. Caught by looking at it; it is not something an audit
would have flagged.

The durable rules are in **`docs/area/ui.md` ▸ "Controller navigation"**. `scratch/padnav-design.md`
was the working note and `scratch/` is gitignored, so the guide is the only copy that survives.

## Next

- **Not pushed, and alpha is not advanced.** The commit is on
  `claude/alpha-flower-intake-plate-930ef5`, which was level with `alpha`/`origin/alpha` at
  `eb6c9ac`. Fast-forwarding alpha and pushing is a one-liner when you want it.
- **Untried at the real surface: the pad itself.** Every rule above is verified by `npm test` on
  synthetic rects or by measurement in a browser; nothing has been driven with a physical
  controller. The things to try first are the menu button leaving a match without firing a shot
  on the way out, and A on a text field.
- `.claude/worktrees/_verify` holds an exact copy of the free-cam half and can be deleted.

---

# HANDOFF — 2026-09-21f (alpha: nine owner items in one commit — see each bullet)

Gates on the merged tree: `npm test` ALL PASS (shared + 4,357 biobuzz), `build`, `server:check`,
`uiaudit`, `docaudit`, `contrast` (235), `bundleaudit` (scene 216.6 KB gz, baseline raised with reasons), `test:mm`
(200), `dbtest`. Nine opus agents ran in ONE shared worktree; a usage limit killed all of them mid-edit once and
every one resumed cleanly via SendMessage. Each area guide carries the long form; this is the index.

- **THE INVISIBLE CORNER (owner, 5th report).** `slimFootBars` (2026-09-20) narrowed the hive foot bar across its
  width and left it SQUARE-TOPPED on two ramps: the flange stood 1.91 in over a top that starts at 0.24 in, and each
  of the four outer corners carried a 1.94-in block over a 0.19-in chamfer. ⚠️ A chassis is a floor-to-roof prism
  and stops on a 0.16-in lip exactly as on a 2.15-in one — so FOUR driving probes were clean; what it held up was
  ELEMENTS (a POLLEN rested 2.13 in up in mid-air). Six pieces, each now the hull of its own polytope (⚠️ six is
  part of the fix: a stacked-box version changed the collider COUNT and flipped a ramp check 60 in away). Checks:
  `sim3d.ts` "THE INVISIBLE CORNER". If the owner means the ROBOT catching, this is not it — ask where.
- **FIELD MESH WINDING.** All 193 components of `field.glb` are closed shells with MIXED winding (49.2 % of
  triangles inward); `repairFieldWinding` (`scene/renderFieldGlb.ts`) REPLACES `fixGroundBeamWinding`: propagate
  across shared edges, orient by signed volume, index-only, before `styleScene`. Ray parity 44.9 % → 1.7 %. Clear
  panels untouched (pinned). DoubleSide only for genuinely open comps (none on the high LOD). Real defect is
  `convert.py`'s.
- **BALLS IN SERVER GAMES.** Two clocks in one frame: the local robot drew from the PREDICTION, elements from the
  INTERPOLATION ~6 ticks behind (p95 8.65 in of a pushed POLLEN drawn inside the chassis; identical at 0 and 140 ms;
  prediction off = 0.01). `Predictor.elements()` + `drawPredictedElements`/`ballSmooth` in `game.ts` → 0.99 in. And the
  kind-change SNAP fired on BIOBUZZ 3D's DERIVED ground/flight re-tags → narrowed to `held`/`stock`. Client-only, no
  wire/egress change, solo bit-identical. LIGHT predictor keeps the old drawing. `net3d.ts` §13–14.
- **G407 OVER-CONTROL.** Unreachable in 3D (a plowed ball SKIPS, `derive.ts` tags it `flight` 14.3 % of contact
  ticks, the sweep deleted its hold clock: peak hold 0.000 s vs 0.45 s) and inert in free drive. `ControlGeometry.loose`
  + `bbLooseElement` (`flight` under `BB_CONTROL_SKITTER_Z` 2 in, 3D only; measured 0.92 vs 7.60). ⚠️ FREE DRIVE NOW
  BILLS in BIOBUZZ (DECODE precedent; G410 unlocked there) — owner CONFIRMED ("free drive should show fouls"); the bar
  shows no score outside a match, so a foul there is a line in the event log and nothing else.
  Egress +135 B/snap deflated in 3D. DECODE G408 healthy; Chain has no such rule by design.
- **SIDE ROLLERS pass 2.** Protrusion 1.90 → **1.65** (not the 1.40 I asked for: park-then-intake is 58 % at 1.65,
  44 % at 1.60, 0 % at ≤ 1.45 — reach covers the 18–22° yaw a one-sided plate contact gives). Frictionless wheels
  tried: 324/540 both ways, reverted. Bracket = rear yoke to the axle, 264° of tread open; wheel = hub + lugged tread.
- **NO EDGE LINE ON A 3D ROBOT** (the dark halo went too: "the robot now just has a black outline"). 2D keeps
  `ROBOT_TRIM`. `chassisEdges`/`lineMat` deleted.
- **ELEMENTS ARE THE REAL CAD SOLID on High/Ultra/export** (`npm run element-cad`, `elements.glb` 16 KB br; new
  seventeenth setting `elementDetail`), they ROLL (visual only), and two instancing bugs fixed (stale frustum sphere;
  56 instances drawn). DECIDED by the owner ("Keep the sim ... as long as it is consistent"): `BB_NECTAR_R` stays 1.800
  and `bake` FITS the CAD mesh (1.810) onto the config radius, so drawn = solved at every tier.
- **DRIVE WHEELS ARE CATALOGUE PARTS** (`BB_WHEEL_PARTS`): 104 mm GripForce mecanum (11 rollers, handed, X pattern
  measured), 96 mm omni, 96/72 mm Hogback. Stripe texture gone. Renderer reads `C.WHEEL_DIAMETER_MM`. 2D: BIOBUZZ's
  X-drive omnis were drawn radially — fixed. A wheel is nearly invisible behind the side plate; owner: leave the
  plate, keep the wheel accurate at the higher tiers (it is).
- **11 BACKGROUNDS** (8 painted, procedural, per-environment light rig; Low/Medium get a picker for the first time;
  ⚠️ env maps were on their side — z-up vs three's y-up, `+π/2`; rigs held to ≥ 25° sun). **FLOWER READ-OUT** on the
  3D overhead camera via the NEW slot `GameModule.drawSceneOverlay` + `GameScene.camera` (⚠️ a third arg on
  `drawOverlays` drew DECODE's ramp strips in screen pixels).
- **CONFIGURE REDESIGN.** Task order (Robot · Controls · Match · Audio and Visual · Graphics; route keys unchanged),
  Robot = Start from/Build/Look/Driving with the preview in a sticky rail ≥ 1320 px, rare controls behind `.ds-fold`,
  one `OptRow`/`ToggleRow` (`src/ui/OptRow.tsx`), duplicate view picker in `MatchSetup` deleted, slop strings 34 → 1.
  Audit: `scratch/configure-audit.md`. No stored-data change.
- Tooling: `.claude/launch.json` gained `dev-b` (5186). Headless capture scripts that destroy a window per shot need
  `app.on('window-all-closed', () => {})` or Electron quits after shot one.

---

# HANDOFF — 2026-09-21e (the match-results screen: full-height panels, a per-section cascade)

Gates on this tree: `build`, `server:check`, `docaudit`, `uiaudit` (ALL RULES AT OR UNDER
BASELINE, no baseline moved), `contrast` (221 ALL PASS), `tsc --noEmit`, and the BIOBUZZ suite
at 3,822 checks.

⚠️ **(Previously READ FIRST.)** `npm test`'s SHARED suite was red on this tree at the time, and it was NOT this work.
`scripts/smoke.ts`'s "sim source uses NO engine-defined Math" check flags
`src/games/biobuzz/graphics/freeCam.ts:159`, which is a **doc comment** that spells
`Math.exp(deltaY * rate)` while describing where the real call lives. It arrived with 0701544
(the free-cam commit) and is untouched by anything below. It is a one-word fix in either
direction — reword the comment, or teach the grep to skip comments — but it belongs to
whoever owns that file, and while it is red the BIOBUZZ suite does not run at all under
`npm test` (use `npm run test:bb`).

Also: this tree is **one commit behind `origin/alpha`** (b9a093f, the alliance-outline and
username-label work). Nothing below touches those files; it just has not been pulled.

- **THE BREAKDOWN'S ORDER, AND RANKING POINTS.** `END OF MATCH` sat second in
  `biobuzzResultsRows`, so the two sections settled at the buzzer were a table apart. Now
  AUTONOMOUS · HIVE · FLOWER · GARDEN · **END OF MATCH · PENALTIES**. DECODE and Chain Reaction
  were checked and already had theirs adjacent on BOTH the versus and the record screens, so
  neither moved — "all three games" needed one edit, not three.
  **RANKING POINTS is REMOVED** (owner's call). It was the only surface in the product that
  printed one, so SWARM / POLLINATOR 1 / POLLINATOR 2 now reach nobody. `BbRankPoints` is still
  computed and still rides the HUD slice; restoring the section is one tuple. BB-11 rewritten,
  BB-51 closed, the `:1904` ledger line marked false.

- **THE SCREEN.** Panels run the full height and the header sits between them: `.resx-body` is
  the whole layout grid, three rows down its centre column (header / breakdown / actions) with
  each half spanning all three, placed by `grid-area` so the DOM keeps its tab order. The
  WINNER banner is alone across the top, bleeding past the half's padding to the outer edge —
  squared against the wall, rounded on the inner end — rendered on both versus halves and
  hidden on the loser so the rosters and totals stay on one line. The alliance name labels its
  own total and the number is bare. The roster carries the TEAM NUMBER (`-` for the 0 that
  means unset) instead of the drivetrain. The two halves MIRROR: every row is written
  inner→outer and the LEFT half renders each group outer-first.

- **ANIMATION.** The stagger restarts at each section, heading first (`headDelay`/`rowDelay`),
  where one capped index had put every BIOBUZZ row past the tenth on the same frame. Each value
  flashes as its own count-up lands — a SECOND TIMER, not a second animation of the number,
  because `useCountUp` has no completion event and both obvious substitutes restart every
  frame. `filter` only, so nothing moves.

- **⚠️ THE ROW ENTRANCE IS NOW GATED ON `rowsActive`,** and that was a real bug: `.resx-row`
  animated on MOUNT (`phase !== 'wait'`, i.e. during `wipe`) while `rowsActive` is 1350 ms
  later, so rows cascaded in reading 0 and sat there for over a second. The old flat ramp hid
  it; a per-section rhythm does not.

- **⚠️ FIXED IN PASSING: `resx-body-solo` was hard-coded OFF** in the versus component
  (`Results.tsx`), so a one-sided run drew its half in column 1 of a three-column grid with
  half the stage dead beside it, and "breakdown beside the total" had never fired on that path.
  `RecordResults` had it right.

- **`NET SCORE` STAYS on the record screen.** The brief said "same treatment everywhere", but
  that number has the runner's own penalties subtracted and deliberately does not equal the
  breakdown beside it — which is why that screen prints a NEGATIVE penalties row. `totalLabel`
  stayed an optional prop; only the versus screen drops it.

- **Two traps worth keeping.** `.resx-body-solo` must NOT be a grid: its overrides tie on
  specificity with `.resx-half.red { grid-area }`, so the half kept spanning three rows and the
  header landed below it. It is a flex column and the `grid-area`s are inert. And
  `uiaudit`'s `duplicate-selector` does NOT catch a repeated DESCENDANT selector — I declared
  `.resx-body-solo .resx-half` twice and the audit stayed green.

- **Verified by eye, not just by gate.** `scratch/results.{html,tsx}` + `scratch/resshot.cjs`
  (gitignored) mount the real `<Results>` against a synthetic hud and capture it offscreen, so
  every state is reachable without playing a 2:30 match: `--states versus,tie,solo,record`,
  `--w/--h` for the narrow stack. Both solo defects above were found that way and by nothing
  else. `npm run shiftaudit` cannot help here — it visits 13 menu routes and a Free Drive
  session, and never sees a match result.

- OPEN, small: at a 1440×860 viewport the record and solo screens SCROLL, because a 14-row
  breakdown beside the total is simply taller than the panel. The stage has always been
  `overflow-y: auto`. It fits from roughly 960 px up.

---

# HANDOFF — 2026-09-21d (alpha: no alliance outline; usernames over robots in alliance colour)

Gates: `npm test` ALL PASS, `build`, `server:check`, `contrast` (235), `docaudit`, `uiaudit`, `test:mm`.
⚠️ FIVE agents were still in flight in this worktree when this was committed (field-mesh winding, the hive's
invisible corner, CAD element meshes, ball behaviour under prediction, side-roller pass 2) — their files were
left OUT of this commit on purpose.

- **THE RED/BLUE OUTLINE IS GONE** (owner). Every sprite STROKE in all three games is `ROBOT_TRIM` (#9aa3ad,
  `render/drawRobot.ts`); `drawOutlineHalo` deleted. The alliance is FILLS only: the heading chevron, the sign
  placard, BIOBUZZ's NECTAR turret rim. 3D: the alliance `LineSegments` round the bumper band is removed, the
  dark `outlineHalo` trace stays as plain edge trim. Check: a permissive Proxy ctx records the `strokeStyle` at
  every stroke — no sprite strokes in an alliance colour (3 games × 2 alliances × intake on/off).
- **In-match labels are the driver's username, in their alliance colour.** `matchStart` gained an optional
  `drivers?: MatchDriver[]` (`robotId` → username; a bot seat is named for its tier), built once in
  `Room.beginMatch` via `seatedDrivers()` and FROZEN there — `robotOf` is torn down as people leave, so a list
  derived at send time could not name a dropped driver's robot for a late spectator. Additive both ways, so no
  `caps` gate. Path: `NetSession.driverName(id)` → `GameController.driverName` → `Renderer.render(…, driverName?)`,
  both the 2D and the projected 3D label pass. NOT in `World`/`RobotState` (30 Hz egress; deterministic JSON).
  No name ⇒ the old `teamNumber + spec.name`; the local robot is still never labelled. ⚠️ `drivers` is the
  FOURTH field `ActiveGameRef.start` carries by hand (after `physics`, `gen`) — copied in `App.beginSession`,
  pinned by smoke. Fill = `COLORS.redLabel` #f87171 / `blueLabel` #60a5fa: the raw hues are 3.52 / 3.60:1 as type
  on the tiles; the tints are 4.78 / 5.20. `contrast.mjs` owns the arithmetic (7 new pairs).

---
# HANDOFF — 2026-09-21c (alpha: side rollers are a HOUSED module; the protrusion is measured, not guessed)

Gates on this tree: `npm test` ALL PASS (2,090 shared + 3,816 biobuzz, 33 s), `build`,
`server:check`, `docaudit`, `uiaudit`, `bundleaudit` (scene 211.26 KB gz). The side-roller work moved nothing in
the sim. **The SAME commit also carries two RAMP sim changes — the pivot on the roller shaft and the
ramp/flower-ring collision group — written up in 21b just below** (final tree: 2,090 + 3,818 ALL PASS).

- **OWNER: "do the side roller wheels need to stick out that much for flower intaking? it looks
  ugly and not the most realistic in terms of packaging." MEASURED ANSWER: the floor is 1.004 in
  and the shipped 1.90 is the KNEE, so the number stays and the PACKAGING is what changed.**
  - **What the chassis stops against** (`scratch/srgeom.ts`, real 3D colliders): a BIOBUZZ chassis
    is ONE RECTANGULAR PRISM to a static (frame + arms + lintel + `chassis3dPocketShapes`), so at a
    FLOWER its whole front face stops with the TIP LINE on the ring plates — LOWER RING PLATE
    `u ≤ 2.404`, `z −0.199…0.354`; MID PLATE `u ≤ 2.415`, `z 3.904…5.254`. A real square drive-in
    settles at `uTip` **2.4145**. Only the wheel (z 0.5…2.5) passes into the retrieval window, so
    its front must reach `2.404 − 1.400` = **1.004 in** past the tip line to touch the POLLEN.
    Relieving the arm nose is NOT available — the pocket filler is what stopped a fork driving over
    the hive foot bars.
  - **Every thousandth above that floor buys the skew.** `scratch/sidesweep.ts`, 540 real drive-ins
    per value: 2.05 → 73.5 %, **1.90 → 73.3 %**, 1.85 → 68.5 %, 1.80 → 64.4 %, 1.75 → 60.0 %,
    1.40 → 60.0 %, 1.20 → 43.7 %, 1.00 → 44.3 %; straight-on holds 100 % to 1.40 and breaks below.
    FLAT above 1.90, −4/−5 points per 0.05 in below it. `BB_SIDE_ROLLER_OUT` therefore UNCHANGED at
    0.4 and the before/after sweep is identical (73.3 % / 100 % straight-on, both).
  - **The packaging IS the fix.** The wheel hung off one diagonal strut, 63 % of it forward of the
    arm tips, nothing around it. Now a retainer plate over it, a plate under it, a dead axle between
    them and a strap/web back to the side arm's rail — and the drawn envelope ENDS on
    `tip + BB_SIDE_ROLLER_PROTRUDE` (the wheel's own SOLID front), so the package bought no reach.
    Same bracket in the 2D sprite. `BB_SIDE_ROLLER_PLATE_T` 0.12 is set by the BOTTOM plate, the one
    part that drives over the lower ring rim (0.5 − 0.354 = 0.146 in of room).
  - New: `BB_SIDE_ROLLER_PROTRUDE` — the ONE number `BbFlowerReach.out[1]`, `bbArchetypeWallExtra`
    and `bbIntakeExtraReach` now all read. Checks in `render.ts` (the four module nodes, their
    outward extent, the plates' sandwich, the rim clearance, the sprite's closed filled path) and
    `robot.ts` (the 1.004-in floor; the one-number identity).
  - Pictures: `scratch/shots/sr2-open.png` (BEFORE, 2026-09-20) vs `scratch/shots/sr3-34.png`,
    `sr3-close.png`, `sr3-top.png`, `sr3-flower.png`. Shooter: `scratch/srshots.cjs` (headless).
  - OPEN, unchanged: the skewed envelope is still 73 %. It is bounded by the protrusion, and the
    protrusion is bounded by the flower's own plate rim — a bigger envelope needs a different
    mechanism or a driver assist, not a tuning pass.

---

# HANDOFF — 2026-09-21b (alpha: free cam mouse layouts)

Gates: `npm test` ALL PASS, `build`, `uiaudit` (index regenerated), `docaudit`, `bundleaudit`.

- **FREE CAM MOUSE LAYOUTS** (owner: "scroll wheel click to slide around ... presets for popular cad
  software"). `graphics/freeCam.ts` `freeCamGesture(preset, button, mods)` is the ONE table; `renderScene.ts`
  asks it on `pointerdown`. Presets `dsim` (default: left orbit, MIDDLE/right/shift+left pan), `onshape`,
  `solidworks`, `fusion`, `blender`; drag-zoom exists where the package has it. CAD presets leave LEFT
  unbound. Wheel direction is a separate `invertZoom`. Stored per device in `FREE_CAM_NAV_KEY`
  (`decodesim.freeCamNav`, in the privacy inventory); picker shows in Graphics only while Camera = Free.
- ⚠️ A middle press starts the browser AUTOSCROLL on Windows and eats the drag: `renderScene.ts` cancels
  the legacy `mousedown` (not `pointerdown`) for button 1 while the free camera is up.
- ⚠️ PAN WAS BACKWARDS as shipped in 21a (the camera followed the cursor). Now the GROUND follows the
  cursor, as CAD does; two direction checks pin it. Measured with trusted input: `scratch/freenav.cjs`
  (headless Electron `sendInputEvent`, per preset). The Browser pane is `hidden` when the owner is away,
  so rAF never fires there — use the Electron script, not the pane, for anything frame-driven.
- scene-preview: `free` is in the camera cycle; `window.__bbGameScene` exposes the scene.
- **RAMP DEPLOY SANK THE ROBOT 0.28 in** (owner report). The settle edge cleared the WHOLE chassis compound
  (`removeCollider(…, false)` on a resting body): three ticks with no floor contact = free fall, then the
  solver walks it back ~0.001 in/tick, i.e. never while parked. Fix: `swapChassis3dReachColliders`
  (`sim3d/bodies.ts`) swaps ONLY the reach hardware at a ramp edge, authority and predictor both; the
  height edge still does the full clear (it re-seats with wake and measures 0.0000). Check: sim3d (c2),
  three mounts, deploy + fold, worst |dz| 0.0002. Probes: `scratch/rampsink.ts`, `rampsink2.ts`.
- **RAMP PIVOTS ON THE ROLLER SHAFT** (owner: "the ramp collides with the intake rollers when folded").
  `BB_RAMP_PIVOT_Z` 2.2 → 4.5 (= `BB_ROLLER_Z`, render-pinned). The old pivot hung under the axle on the
  same `u`, so a folded rail crossed the shaft at its bearing and the blade sat 0.77 in inside the flap
  sweep. Now the blade is 4.93 in from the axle at every swing angle. `BB_RAMP_ANGLE`/`_L`/`_TIP_Z` derive
  (36°, 6.9 in; folded top 11.4 in). `BB_RAMP_REACH.z` top = the rail at the TIP LINE (3.05), not the pivot.
- **RAMP HOP AT A FLOWER** (owner: "gets caught on the bottom aluminum part ... robot jumps upwards").
  171/240 drive-ins lifted the chassis ≤ 0.23 in with NO penetration: a speculative edge-edge contact,
  blade (0.40) over lower ring plate (0.354), diagonal normal, yaw-only chassis ⇒ hop. New
  `sim3d/groups.ts`: `GROUP_RAMP` (blade + rails) does not meet `GROUP_FLOWER_RING` (the ring trimeshes
  only). 0/240 after; extraction 400/400 (mean 0.285 s), drain 72 ticks. Checks: sim3d (c3), render
  fold pair. Probes: `scratch/ramphop.ts`, `ramphop2.ts`, `rampfold.ts`.
- OPEN (in flight when written): side-roller protrusion (owner: "do they need to stick out that much").

---
# HANDOFF — 2026-09-21a (alpha: ramp by physics, one-piece shooter plates, free cam, real-eye driver cam, full top plate)

Gates on the final tree: `npm test` ALL PASS (2,090 shared + 3,716 biobuzz, 26 s wall),
`build`, `server:check`, `uiaudit`, `docaudit`, `contrast`, `bundleaudit` (scene 211.0 KB gz), `dbtest`,
`test:mm`. `dsim-alpha` redeployed. The agents below each prepended their own notes further down.

- **RAMP EXTRACTS BY PHYSICS (opus).** The "0.42 jam" was the LOWER RING PLATE: a tilted box hangs below
  its profile line (0.42 → 0.307 vs the plate's 0.354); the old probe sampled the centreline, where the
  bore is open. And NO PASSIVE LIP works: a ball backed by the supports climbs only below 0.637 in, and
  below 0.175 once the column has walked it 0.44 in wallward (the owner's "depends how they're stacked").
  So: one LEVEL blade (`BB_RAMP_FLOOR_Z` 0.40 / `BB_RAMP_DECK_Z` 0.48, `BB_RAMP_IN` 0.85 … `BB_RAMP_OUT`
  3.54) with a DRIVEN LIP (`BB_RAMP_ROLLER_V` 50 in/s). 400/400 real drive-ins, mean 0.39 s; forced
  h1/h4/h8 400·400·398; an 8-column drains 8/8 in 76 ticks. The stall fallback, its constants and two
  `RobotState` fields are GONE. `BB_RAMP_IN` 0.85 (not 0.15) so that FOLDED the roller's hub sits in the
  U's opening (owner's original spec) — flaps are pressed 0.77 in by design; render checks pin the hub.
- **SHOOTER SIDE PLATES ARE ONE PIECE (opus + me).** The split was the feed wall's two EARS carrying the
  motor in the side plate's own plane, 0.63 in behind it. Now one outline per side (straight top, 0.15
  rim round the motor, rear at the turntable's own `plateBackX` so the envelope did not grow), motor
  face-bolted INBOARD to the drive-side plate, belt on that plate. The feed wall stops at the plates'
  INNER faces under their top edge — it used to pass through and stand proud, which still read as a
  seam. Hood arms solid (bore removed), `BB_HOOD_SIDE_CLEAR` 0.08, flywheel never tinted.
- **FREE CAM** (`'free'` SceneCamera; `graphics/freeCam.ts` pure state, `renderCameras.ts` pose):
  left-drag orbit, right/shift-drag pan, wheel dolly, double-click or the HUD ⟲ RESET VIEW chip.
  Mouse only, hidden on touch. **DRIVER EYE** (`graphics/driverEye.ts`): optional per-device "Your
  height"; eye = height − 4.5 in, 12 in behind the field edge in the local ALLIANCE AREA, ± a quarter of
  the area along the wall by TOP/BOTTOM (`SceneFrame.localStartCat`); the eye never moves, only aims.
  Unset = the legacy driver camera, byte-identical. ⚠️ `graphics/` may not use bare `Math.sin/cos/pow`.
- **Chassis**: the top plate is the FULL footprint (reverses the 2026-09-19 "not a slab" ruling; the
  check asserts ≥ 99 %); cross members sit behind the end plates and under the deck (they z-fought the
  back plate and the deck).
- ⚠️ PROCESS: subagents ignore SendMessage redirects as injection unless their brief says coordinator
  messages are genuine — put the spec in the brief or start a new agent. Resuming a STOPPED agent via
  SendMessage works. Electron captures are headless (`scratch/shots.cjs`).
- OPEN: side rollers' skewed approach (72 % over ±10°); split the `sim3d` lane (the test floor);
  TOP-position driver eye stands behind the wall flower (true to life, maybe unwanted).

---

# HANDOFF — 2026-09-21a (alpha: the ramp's wedge is a FLAT PLOW BLADE with a driven lip, and it extracts 400/400 by physics)

Owner: "the pollen should be getting intaked from the deployable ramp BECAUSE it
collides with the ramp and slides down towards the intake"; "the old ramp works 99% of the
time... when it does not work, the pollen don't budge... I think it depends on how the pollen are
stacked". Gates on this tree: `npm test` **3649 checks, 1 failure** — `every non-auto camera
preference is a real SceneCamera`, which is ANOTHER session's in-flight `graphics/freeCam.ts` work
in this same worktree and is not from this pass; the lane subset
`render,robot,sim3d,flower3d,tutorial,predict,net3d,hive3d` is otherwise clean, `build`,
`server:check`, `docaudit` and `bundleaudit` all green.

- **THE 0.42 FREEZE THE LAST PASS LEFT UNEXPLAINED IS THE LOWER RING PLATE**, and the previous
  CAD probe missed it for one reason: it sampled the wedge's CENTRELINE (`v = 0`), which is
  exactly where the 3.222-in bore is open. A tilted box hangs `2·thick·cos(angle)` BELOW its own
  profile line, so "lead z 0.42" really reached **0.3067** against a plate top of **0.354**, and
  the ramp is ±7.57 in wide against a 1.611-in bore radius. A free-shape `intersectionsWithShape`
  NAMES the collider: `LEAD_Z 0.42 -> trimesh z=[-0.199,0.354] FLOWER0` at every standoff, 0.50
  and up CLEAR.
- **AND THE 0.60 LEAD THAT "FIXED" IT COULD NOT LIFT ANYTHING.** A POLLEN backed by the peanut
  supports climbs only while `h < BB_POLLEN_R·(1 − μ/√(1+μ²))` = **0.637** at μ 0.65; a tilted
  box's outermost point is its end cap's TOP corner, at **0.713**. Measured on a real drive-in:
  the chassis stalls 1.47 in short of flush, the POLLEN is driven 0.42 in onto the supports
  (normals `(0.89, ±0.46, 0)`) and 0.054 in into the tiles, and its centre never rises.
- **THE RAMP IS ONE LEVEL BLADE NOW** — `BB_RAMP_IN` 0.15 … `BB_RAMP_OUT` 3.54 past the tip line,
  `BB_RAMP_FLOOR_Z` 0.40 under / `BB_RAMP_DECK_Z` 0.48 over, a 0.08-in sheet, rail to rail. A
  tilted cap OVERHANGS and traps the ball (measured: no clear at a roller speed of 160 in/s); a
  crest is pure cost, because everything the ball climbs the column climbs. **And the lip is
  DRIVEN** (`rampRollerDrive`, `BB_RAMP_ROLLER_V` 50 in/s along the deck), because no passive
  profile can do it: a ball met on its flank retreats 0.458 in onto the supports, the lip would
  then need 1.541 in of reach and the same supports cap it at 1.156.
- **`BB_RAMP_STALL_S`, `BB_RAMP_RELEASE_V` AND `RobotState.bbRampStallId/Since` ARE GONE.** The 3D
  ramp gate is the ball's own height (`BB_RAMP_LIFT_Z` — its bottom above the ramp's underside,
  which is above the plate's rim); the release is a RE-TAG IN PLACE and the intake's own extended
  pull does the rest. `derive.ts` carries the other half: a `ground` element lifted clear of the
  rim is not re-claimed into the tube.
- **MEASURED (`scratch/rampsweep.ts`, real drive-ins, no teleports): 400 runs, 400 extracted**,
  mean 0.40 s / p95 1.10 s from the ramp reaching the opening to the hopper; 100% at every column
  height, approach angle and lateral offset. Forcing the height: h1 400/400, h4 400/400, **h8
  398/400** — the compounding offset+angle corner, reported rather than papered over. DRAIN: a
  full 8-column empties on one held stick in 1.27 s, 0.05–0.20 s per POLLEN after the first.
- **AND THE FOLDED U HAS ITS HOLE BACK.** Owner's own spec: *"when deployed, from the top down, it
  should look like an upside down U shape... the hole created by the U is where the intake rollers
  are situated in when the ramp is folded up vertically."* The pivot is ON the roller's axle line,
  so FOLDED the rails stand past it and the rigid HUB is the rail band 1.55 … 3.05. MEASURED on the
  built group (`scratch/rampfold.ts`): at `BB_RAMP_IN` 0.15 the blade spanned rail **2.563 … 5.825**
  — inside the hub's band, clearing it sideways only (+0.289); at **0.85** it spans 3.232 … 5.825,
  0.18 in past the hub's top, +0.477 radial. Rails clear by 1.56; the pivot bracket's −0.08 is the
  (u, z) metric over-reporting a part that sits outboard of the barrel laterally. The FLAPS are
  pressed 0.773 in and that is allowed — they are compliant and hinged, and clearing their r-2.0
  sweep would leave 1.5 in of deck. **It cost the extraction nothing**: 400/400 either way (mean
  0.403 → 0.386 s), h1/h4/h8 identical, drain 75 → 76 ticks.
- Checks: `flower3d.ts` (five representative drive-ins + the drain), `render.ts` (folded: nothing
  within 0.1 in of the hub, blade's inboard edge outboard of it along the rail), `sim3d.ts` (the ramp's own
  ground-capture sweep over 10 lateral offsets, intake on and off; the 30 in/s through-the-blade
  probe re-pointed at the deck), `render.ts` (the drawn blade's lip/inboard end/UNDERSIDE pinned
  to config). Screenshots: `scratch/shots/ramp3-up.png` (folded, the roller inside the U),
  `scratch/shots/ramp3-down.png`, `scratch/shots/ramp2-down-side.png`, `scratch/shots/ramp2-down-open.png`.
- ⚠️ **ANOTHER SESSION IS EDITING THIS WORKTREE** (`src/cosmetics.ts`, `graphics/freeCam.ts`,
  `scene/renderCameras.ts`, `ui/*`, the hood constants). Nothing above touches those files.

# HANDOFF — 2026-09-20d (alpha: hive tip trap, solid side rollers, ramp wedge (interim), ground beams, perched pollen, end plates, TEST SUITE 110 s → 25 s)

**Earlier.** Gates on that tree: `npm test` ALL PASS (2,090 shared + 3,541 biobuzz, **25 s wall**),
`build`, `server:check`, `uiaudit`, `docaudit`, `contrast`, `bundleaudit` (scene 210.2 KB gz, baseline
raised 205.83 → 209.99 with the reason in the file), `dbtest`, `test:mm`. `dsim-alpha` redeployed.

- **HIVE NOT TIPPING (player reports) — it was the SWING, never the count** (opus, 420-scenario fuzz,
  `scratch/hivemiss.ts`): firing through a swing loads the RISING cell (`hiveTakingSide` hands over at
  release) and can turn the tray back (measured at −24°, −21°, −9°); and `hiveDynamicTick` had no
  failure path, so a tray that came back kept `released` latched for the match → `contents` read the
  DOWN cell forever (dead hive, lying HUD). Fix: between the stops a stalled swing is carried on at a
  FLOOR of `BB3_HIVE_TIP_CREEP_W` 0.12 rad/s (0.25 shortened the ruled 4 s swing to 3.1 — measured and
  rejected), and a tray at rest on its own stop with `tipping > 0` resets. 386 armed → 386 tipped,
  0 phantom, spill spread unchanged.
- **TEST SUITE.** `scripts/bbshard.mjs` shards BIOBUZZ by lane; `test-all.mjs` runs both suites at once
  (`--serial` to opt out). `smokeshard` hashed blocks with raw line endings, so its cost table matched
  0 of 281 blocks and it packed blind — hash is CRLF-normalised now, `--costs[=N]` lists the expensive
  blocks. smoke.ts: 286 → 367 blocks (the 3,400-line CR block, the 2,000-line audio→LAN block, the
  held/tapped floor split), eight run-a-full-match-to-reach-post blocks use `forceRoomToPost`, three
  duplicate sims removed. 5 checks removed in total, each strictly implied by a neighbour (notes left
  in place). Equivalence proven by diffing sorted `PASS name — detail` lines against a captured serial
  baseline (`scratch/cleanup/`): same verdicts and details except 8 already-nondeterministic ones.
  ⚠️ `tsc -p tsconfig.json` does NOT cover `scripts/` — smoke files are only parsed when run.
  Next: split the `sim3d` lane (the BIOBUZZ floor, ~14 s) and `net3d`/`ai` (`scratch/cleanup/review-bb.md`).
- **Side rollers**: at the arm noses in front of the drive wheels, 3-in (`R` 1.5, `OUT` 0.4), SOLID
  cylinders in the default group (authority + predictors), gate = CONTACT (`BB_SIDE_ROLLER_GRIP`), the
  pollen is RELEASED as a ground element and the sweeper takes it. Real-driving sweep: 100% straight
  on (45/45), 71.9% over ±10° × offsets — OPEN: the skewed approach.
- **Ramp**: wedge crossbar (lead 0.60 / crest 1.00 / drop 0.42, `BB_RAMP_OUT` 3.42). ⚠️ INTERIM: physics
  alone does not yet extract reliably; the stall fallback is `BB_RAMP_STALL_S` 0.25 s (the agent's 1.2 s
  made a retrieval take 1.85 s). The jam at a 0.42 lead is unexplained (suspect: the tilted box's lower
  corner meets the lower ring plate at 0.354). An opus pass owns "100% by physics" next.
- **Ground beams**: one-sided rendering = closed shells with INCONSISTENT WINDING (volume 2.7–7.8× their
  bbox); only those components render `DoubleSide`. The "invisible bump" = my own `squareFootBars` box
  (2.15 in tall over a channel whose floor is < 0.1 in); now `slimFootBars`: a 0.66-in flange + two feet
  as TOUCHING, NEVER OVERLAPPING boxes (overlap froze a strafing chassis).
- **Perched pollen**: the rest snap froze balls on knife-edge hulls; untagged elements on CAD hulls get a
  deterministic vibration (give up after 30 ticks). 132 → 88 of 1,404 rain drops; hive frame 0.
- **End plates** (3D): full plate on a mouth-free end, two floor-to-deck corner plates on an end with a
  mouth; proven inside the chassis collider for every mount × drivetrain.
- ⚠️ **INCIDENT**: a subagent ran `git stash -u` in the shared worktree and wiped every agent's
  uncommitted work. Restored from the stash; briefs now ban stash/checkout/reset/clean. Electron
  captures are HEADLESS (`scratch/shots.cjs`: `show:false`, `offscreen:true`).

---

# HANDOFF — 2026-09-20f (alpha: the ramp's flat crossbar is a WEDGE now, and the retrieval fallback is restructured to survive it)

**READ FIRST.** Owner: "the ramp could have a slight slope up and a larger slope down... just
pushing on the pollen with whatever is likely enough to get it up due to impulse but also the
ball's geometry"; "the old ramp works 99% of the time... when it does not work, the pollen don't
budge." Replaced the flat crossbar (`chassis3dReachShapes`'s ramp branch) with a two-box WEDGE —
LEADING EDGE (`BB_RAMP_OUT`/`BB_RAMP_LEAD_Z`), CREST (`BB_RAMP_CREST_OUT`/`BB_RAMP_CREST_Z` = 1.00,
0.104 in under the mid-plate ceiling), DROP back into the U — all in `config.ts`'s "THE DEPLOYABLE
RAMP", derived with `dsin`/`dcos`/`dtan`/`datan2` only, never `Math.atan2`/`Math.hypot`.
`scene/renderRobots.ts` draws the same two boxes under the SAME node name (`robot:ramp:bar:<edge>`,
now a group); the RENDER lane's new checks pin the drawn LEADING EDGE/CREST/DROP points to
config's own numbers to 1e-3, all mounts, ALL PASS.

**ANALYSIS FIRST, as asked — and it changed the plan twice.** A real drive-in
(`scratch/ramp_debug.ts`, gitignored, kept for the next pass) at the owner's own target height
(`BB_RAMP_LEAD_Z` 0.42, "z 0.40-0.45") stopped the chassis dead 2.27 in short of flush, frozen —
`world3d.contactPairsWith` pinned a live contact on the WEDGE, not the rails or bare chassis, and
isolating the two wedge boxes from the rails (`BB_DEBUG_NO_WEDGE`/`_NO_RAILS` env toggles, since
removed) proved it was the wedge alone. A CAD-hull probe (`scratch/wedge_cad_probe2.ts`) could
NOT reproduce the exact hit against the eight named `flower_support` hulls or the ring plates' own
bore — it is a mesh feature finer than those checks already resolve elsewhere, an OPEN
measurement gap. Fix, empirical: raise `BB_RAMP_LEAD_Z` to 0.60 (found by raising until the
chassis reached within 0.5 in of true flush). That reopened a SECOND bug: `BB_RAMP_REACH.z` is
`[BB_RAMP_DROP_Z, BB_RAMP_CREST_Z]`, read by the PERMANENT 2D pipeline's own z-bite against the
model's fixed bottom-POLLEN centre (1.754) — `DROP_Z` tied to the 0.60 `LEAD_Z` dropped that
overlap to 0.40 in, under `BB_FLOWER_BITE`'s 0.5-in floor, and the 2D ramp gate went dark on every
pose. `BB_RAMP_DROP_Z` is now its OWN constant (0.42, the owner's original target — restores 0.58
in of 2D overlap) instead of a `LEAD_Z`-relative formula.

**The wedge alone does not yet clear every pose — a real residue, reported honestly rather than
claimed away.** With the ceiling-respecting geometry (`CREST_Z` capped at 1.00), a single staged
POLLEN driven at flush still needed the FALLBACK to complete extraction within the tested window;
an earlier draft that let `CREST_Z` reach 1.18 (violating the 3.904 ceiling) DID clear on physics
alone, which is the actual size of the gap between "ships" and "the ideal ask". Restructured the
fallback rather than ship the miss silently: `flowerRetrieve3d`'s ramp branch tracks how long the
SAME bottom POLLEN has sat gated (`RobotState.bbRampStallId`/`bbRampStallSince`,
`BB_RAMP_STALL_S` = 1.2 s) and, past that, shoves the LEANING element above it (a small
deterministic hash-driven kick, `rngState` read-only, `dsin`/`dcos` only) if one exists, or falls
back to the old teleport-release — re-anchored behind `BB_RAMP_DROP_OUT` (the wedge's own
innermost point now; the old `BB_RAMP_OUT`-relative anchor spawned the released ball INSIDE the
drop segment's own solid box, a THIRD bug this pass found and fixed) — if nothing is above it. The
stall clock reads the MOUTH gate only (`bbFlowerAtIntakeMouth`, pose-only, never `ball.z`) rather
than the full z-bite: gating it behind the z-bite too (tried first) meant a ball the wedge pressed
out of the eligible band without lifting it stalled the clock FOREVER, since the branch that would
have rescued it never ran again. MEASURED (a real drive-in): pop-to-hopper end to end is 111–112
ticks (1.85–1.87 s) once this is right, mostly the stall wait, not the drive. **A full 300+-run
sweep across standoff/lateral/angle/column-height/scatter-seed — what the task actually asked
for — is the open item.** What shipped is real and verified (SIM3D/FLOWER3D/RENDER/ROBOT lanes,
plus direct `contactPairsWith` debugging), not that scale of statistical claim.

New checks: `sim3d.ts` (a wedge-vs-CAD solidity probe — a 30 in/s ground POLLEN fired at the
deployed wedge's own plane, at the crest's height, never crosses it; a two-run determinism hash
with a REAL ramp flower retrieval, wedge + stall fallback, both hash-equal and JSON-identical —
had to deploy the ramp IN THE OPEN before moving flush, since pressing it already-flush is exactly
the swing guard's own refusal case and left `bbRampStallId` permanently `undefined` the first time
through), `render.ts` (the wedge profile pin above), `robot.ts` (the two existing one-tick ramp-
pull fixtures rewritten for the two-phase pull — `holdTicks` for 150 ticks, not one `tick()` call —
and the 2D/3D parity sweep's `ramp` rows moved to their own "the gate at least RECOGNISED the
pose" check rather than a one-call verdict comparison, which is no longer the right question for
an archetype whose first call is always `false` by design). Gates: the requested lane subset
(`render,robot,sim3d,flower3d,tutorial,predict,net3d,hive3d`) 2544/2544 ALL PASS, `npm test`
3541/3541 ALL PASS, `build`/`server:check`/`docaudit` all green, `costprobe` shows the two new
`RobotState` fields (`bbRampStallId`/`bbRampStallSince`) did not appear in the per-tick wire cost
table for the scenarios it drives (narrow, ramp-specific — same category as the existing
`bbRampOut`/`bbRampAt`/`bbRampBlocked`). One pre-existing hive3d timing failure surfaced once,
mid-session, in another agent's in-flight `fieldColliders.ts`/hive area — untouched by this
session, not chased, and gone on the next run. Screenshots:
`scratch/shots/ramp2-down-open.png`, `scratch/shots/ramp2-down-side.png` (headless Electron,
`scratch/shots.cjs`, both pre-existing entries — `ramp2-down-*`).

# HANDOFF — 2026-09-20e (alpha: a tip the table called for now reaches the far stop, and a failed swing no longer kills the hive)

**READ FIRST.** Owner: "People are still reporting hive not tipping in some cases." Fuzzed it
(`scratch/hivemiss.ts`, gitignored — 420 seeded turret/dumper volleys under the real `step3d`,
judged against an independent geometric count of the taking cell rather than against `contents`).
Registration was fine — pin lift is mean 1.0 ticks, p95 1, before and after. **TWO causes, both in
the swing, neither in the count:** (1) `hiveTakingSide` hands over at the release, so a driver
firing through a swing fills the RISING cell, and that load torques the tray BACK — seed 9039
reached −24.2°, five degrees short of the far stop, and coasted home. Balls on the floor, no tip.
(2) `hiveDynamicTick` had NO failure path: `tipping`/`released` cleared only at the far stop, so a
tray that came back sat with `released` latched forever, `hiveTakingSide` named the DOWN cell, and
`contents` — the pin's list, the HUD's list, §10.5 C's list — was derived from the wrong cell for
the rest of the match. **A permanently dead hive with a lying "N MORE TO TIP".** 8 of 420 runs.
Fixes: `BB3_HIVE_TIP_CREEP_W` (0.12 rad/s, between the stops only, a FLOOR — an anti-stall, not a
rate; 0.25 was tried first and broke the 4 s `BB_TIP_SWING_S` ruling at 3.12 s) and a reset to
settled when the tray is at rest on its own stop. **386 armed → 382 tipped / 5 missed / 8 trapped,
now 386 → 386 / 0 / 0**; 0 phantom tips either side (120 miss-rain runs, 0 tips); 8-POLLEN reference
swing 4.12 → 4.08 s; spill dispersal unchanged (mean 61.0 → 61.1 in from the pivot, max 106.9).
Checks: `commitChecks` in `scripts/smoke-biobuzz/hive3d.ts` (4 checks, ~1.6 s). Gates: the requested
lane subset `hive3d,sim3d,net3d,ai,rules,field` 1227/1227, `npm test` 3538/3538 ALL PASS, `build`
and `server:check` green. One note: `config.ts` was momentarily broken by another agent's in-flight
ramp work (`dtan` used, not imported) and I added it to the existing `../../math` import line to
unblock — that line is the only shared-file edit this session made.

# HANDOFF — 2026-09-20d (alpha: side rollers are solid cylinders, the retrieval gate is CONTACT, and the release is generalised from the ramp's)

**Earlier 2026-09-20d.** Owner rulings: "the side roller should also be larger in diameter" and "it should
also be colliding with everything. It is a physical thing." Gates on the final tree: `npm test`
ALL PASS except a `foot bar 3d` check and a `bot-driven 2v2` perf check, BOTH pre-existing/mid-edit
in `engineImpl.ts`'s concurrent "rest snap"/narrow-hull-vibration work (another agent's, not this
session's — do not chase, they touch hive foot-bar solidity and step perf, nothing this session
changed), `build`, `server:check`, `docaudit` all green. The requested lane subset
(`render,robot,sim3d,flower3d,tutorial,predict,net3d`) is 2424/2424.

- **`BB_SIDE_ROLLER_R` 1.0 → 1.5 (a 3-in wheel), `BB_SIDE_ROLLER_OUT` 0.9 → 0.4** — the wheel spans
  −1.1 … 1.9 past the tip line, the SAME 1.9-in front poke as before (`OUT+R` unchanged), the extra
  diameter going backward under the side arm's nose.
- **The wheel is a real SOLID CYLINDER now** — `Chassis3dShape` grew `shape: 'box' | 'cylinder'`;
  `reachColliderDesc` builds `ColliderDesc.cylinder(halfHeight, radius)` with a fixed +90°-about-X
  quaternion (`CYL_AXIS_Z`, `bodies.ts`) standing Rapier's own Y-axis cylinder up on world Z, in the
  DEFAULT collision group (`elementSolid: true`) — meets an element, a wall, another robot,
  everything, same as the ramp's bar. `birthClear` (`engineImpl.ts`) grew the archetype reach
  shapes into its escape solids too — a launch point born inside a wheel or a ramp bar was the
  same "shoots in a different direction" bug the function already guards against for the bare
  frame, just never counted the reach hardware before.
- **The retrieval gate is a CONTACT RADIUS, not the old x-bite box.** A solid wheel can never
  overlap the POLLEN it grips, so `bbFlowerAtIntakeMouth` (`play.ts`) now tests the xy distance
  from a wheel's own axis to the POLLEN's centre against `BB_SIDE_ROLLER_GRIP`
  (`R + BB_POLLEN_R + BB_SIDE_ROLLER_CONTACT_TOL`, ≈3.25in) — same predicate in 2D (no solid wheel
  there, so the robot CAN overlap; the ≤ test with no lower bound still works) and 3D.
  `BB_SIDE_ROLLER_CONTACT_TOL` is 0.35, MEASURED against a real drive-in's own yaw/lateral drift.
- **The pollen comes out physically here too — THREE WRONG RELEASE POINTS before the right one,
  each measured, not guessed.** Retreating along `u` (toward the chassis) runs straight into the
  wheel's own new solid body — a continuous drive through that overlap threw the element clear
  across the field the next tick. Retreating further, behind the wheel's own inner edge (the
  ramp's own trick), found the pocket is only `bbIntakeReach` deep (3in) and the wheel already
  eats 1.1in of it — 0.2in of headroom, not enough for a 2.8in POLLEN. Leaving the release exactly
  at the flower's own true position (banking on the wheel's own small compression) failed the
  OTHER way: the ball's world position never moved, so `derive.ts`'s tube test re-tagged it right
  back the next tick, invisibly. The one that works: `u` UNCHANGED (the true position already
  sits ≈0.5in past the wheel's own outer edge), `v` shifted toward the centreline by
  `BB_SIDE_ROLLER_RELEASE_CLEAR` (`BB_FLOWER_OPEN_R + 0.3`) — lands inside the retrieval opening's
  own documented open band, clear of the wheel. `bbIntakeExtraReach` grew a `siderollers` term
  (`BB_SIDE_ROLLER_OUT + BB_SIDE_ROLLER_R`) so the pull actually reaches out to sweep it in.
- **Retrieval-rate sweep, real driving, no teleports** (135 combos: lateral offset × `bbSideRollerY`
  ± {0, 0.8, 1.5}in, approach angle {0, ±10°}, stick {0.4, 0.7, 1.0}, column height {1, 4, 8}):
  **71.9% retrieved overall, mean time-to-first-pollen 0.80s; a straight-on (angle=0) approach is
  100% (45/45)**. Every failure is at ±10° where the initial heading error compounds with the
  lateral offset in the same rotational sense; the opposite pairing mostly still lands. A centred
  approach (neither wheel on the flower) retrieves NOTHING, as designed. **This is short of the
  ≥95% target across the FULL envelope** — the compounding offset+angle failure is a real,
  measured limit of the current contact radius, not a bug, and is the open item for the next
  tuning pass (a bigger `BB_SIDE_ROLLER_CONTACT_TOL`, or damping the yaw drift on first wall
  contact, are the two obvious levers — neither tried this session).
- New smoke coverage: `scripts/smoke-biobuzz/sim3d.ts` — a head-on wheel probe (30in/s POLLEN
  deflects, never crosses), a capture-rate sweep vs the SWEEPER build across lateral offsets, and
  a two-run determinism hash with a real side-roller flower retrieval in the script (held at the
  analytic flush pose, not driven in — a real drive-in's own yaw/lateral drift is what the
  retrieval-rate sweep above characterizes, and is the wrong thing to depend on for a check whose
  only claim is "the same script produces the same bytes twice"). `flower3d.ts`'s drive-in fixture
  lost its analytic reseat (a previous pass teleported the robot back to test the bite instead of
  fixing the gate) and now tests the bite at the REAL driven pose; tolerance re-measured 1.5→1.6in.
  `predict.ts`'s side-roller wall-standoff tolerance re-measured 1→1.9in (a round collider makes
  line contact against a flat wall where a box made face contact — the two independently-stepped
  Rapier worlds resolve it a little differently).
- Render: `scene/renderRobots.ts`'s side-roller cylinder went 8→12 radial segments (owner: "larger
  in diameter"); the 2D canvas (`drawRobot.ts`) and the builder preview (`RobotPreview.tsx`) both
  already read `BB_SIDE_ROLLER_R` live, so the bigger wheel drew correctly with no code change.
- Docs: `docs/area/biobuzz.md`'s side-roller bullets carry the same measurements.

---

# HANDOFF — 2026-09-20c (alpha: ramp physics + swing guard, side rollers at the edges, cadence, COSMETICS)

**READ FIRST.** Four owner rounds on top of 2026-09-20b. Gates on the final tree: `npm test` ALL PASS
(3,322 biobuzz + shared), `build`, `server:check`, `uiaudit`, `docaudit`, `contrast`, `bundleaudit`
(scene 209.3 KB gz), `dbtest`, `test:mm`. `dsim-alpha` redeployed (migration 0044, the strip, the wire).

- **The ramp is solid to POLLEN and takes a FLOWER's pollen physically-ish** (owner: "it just looks
  like the pollen is passing through the ramp"). Crossbar + rails are element colliders; a deployed,
  settled ramp extends the intake's pull out to the crossbar (`bbIntakeExtraReach`, both pipelines).
  Measured: the proximity gate always fires before the bar can lift the ball, so the gate now
  RELEASES the bottom pollen as a `ground` element under the crossbar (`BB_RAMP_RELEASE_V` offsets it
  sideways past the tube's membership radius, else `derive.ts` re-tags it) and the pull takes it —
  8–13 ticks of visible transit, never instant, nothing crosses the bar (30 in/s probe). 2D keeps the
  proximity capture. Rails 4.5 → 5.3 in at 18.7° (`BB_RAMP_OUT` 3.02: 0.64 past the pollen's centre).
- **Swing guard** (owner: "should not be able to deploy INTO a flower ... same with un-deploying"):
  during a swing the rail/crossbar boxes at the eased angle are tested against STATICS (Rapier query
  in 3D, flat SAT in 2D); a hit REVERSES from that angle (`bbRampReverse`, `bbRampBlocked` guards
  oscillation). A rotating arm overshoots its settled reach mid-swing (peaks at 90°): 3 in off a
  flower is refused, 4 in settles.
- **Side rollers are at the intake's EDGES** (owner). Axis `bbSideRollerY(mouthHalf)`; at a FLOWER
  one wheel grips (`edgeGrip`): the driver lines an end of the intake up on the opening. Tutorial
  offsets the loaned build by that. **Tucked in 2026-09-20d** (owner: "right in front of the
  wheels ... not sticking out like that"): `BB_SIDE_ROLLER_R` 0.75→1.0, `BB_SIDE_ROLLER_OUT`
  1.9→0.9 — wheel spans −0.1…1.9 past the tip (was 1.15…2.65), flush x-bite 0.92 in (0.42-in
  margin over `BB_FLOWER_BITE`), bracket is a diagonal gusset off the side arm's own nose, not an
  outrigger off the front brace.
- **Cadence halved again**: `BB_INTAKE_PERIOD_MIN/MAX` 0.03/0.06, `BB_FLOWER_RETRIEVE_S` 0.15. The
  corner-capture check needed an empty field (the run-up now eats four pollen in 0.43 s).
- **COSMETICS** per `docs/cosmetics-plan.md` (owner: "colour options are dull ... follow our plan").
  `src/cosmetics.ts` is the registry: 18 vivid fills (12 free, 6 supporter), accent (wheels/rollers),
  decal (stripe/chevron/racing/hazard/checker, parametric), plate frame (classic/rounded/bold).
  `OUTLINE_HALO`: a dark ring between fill and alliance outline (5.2:1 vs both alliance colours),
  and dark trim under the 3D silhouette line. Four builder rows, locked options visible with the
  reason. `coerceSpec` clamps shape only; the SERVER strips entitlement at join/queue/update
  (`stripUnentitledCosmetics`, `server/index.ts` + `room.ts`) — never in `coerceSpec`, so replays
  keep their look. Migration `0044_cosmetics.sql` (`profiles.cosmetics`, earned unlocks, empty
  until the rewards ledger); `grantCosmetic`/`revokeCosmetic` in repo.ts, audited. `worldHash` is
  invariant across the whole palette (smoke). Old dark keys fold to `default`.
  Not done: editable number plates, cosmetics on leaderboard rows.
- Follow-up flagged by the sim lane: none real — the "corner deadlock" it named was the hopper cap.

---

# HANDOFF — 2026-09-20b (alpha: three intake archetypes — only hardware that reaches a FLOWER's opening takes from it)

**READ FIRST.** One owner item: "intaking from the flower is not physically accurate. Current rollers
cannot actually reach the pollen under." Gates on the final tree: `npm test` ALL PASS (3,280 biobuzz +
shared), `build`, `server:check`, `uiaudit`, `docaudit`, `bundleaudit` (scene 208.2 KB gz, +2.4),
`test:mm` (200). Not run: `dbtest` (no DB change), `shiftaudit`, `test:ai`. `dsim-alpha` redeployed
(server: the wire's `buttons` widened, `room.ts` counts a ramp press as activity). Production untouched.

- **The opening, measured off the CAD hulls** (`config.ts`, "ROBOT — intake ARCHETYPES" header): the
  bottom POLLEN rests on the tiles inside the lower bore, centre 1.4 up and 2.384 in BEHIND the plate's
  field edge; under the mid plate (ceiling 3.904) the field side is open the full 5.95-in plate width
  and 3.57 in deep to the peanut supports. The sweeper's roller (axle 4.5, flaps to 2.5 two inches
  behind the tip line) never passes the plate edge. `scratch/flowerhulls.ts` is the probe.
- **Three archetypes** (`mechs.ts` `BB_INTAKE_KINDS`, `bbMech.intake.kind`, absent = `sweeper`). All
  keep the same sweeper mouth/footprint/solids — ground POLLEN is unchanged for every build, and the 2D
  pipeline is byte-identical for every existing spec. What differs is a REACH box in the mouth frame
  (`bbFlowerReachOf`): sweeper `null`; `siderollers` two 1.5-in compliant wheels at ±1.9 / 1.9 past the
  tip line, z 0.5–2.5; `ramp` a 4.5-in U-frame pivoting 2.0 behind the tip line at 2.2 up, deployed 22°
  down so the crossbar sits 2.17 in into the opening at 0.5 (over the lower plate's 0.354 rim, under the
  POLLEN's centre). The gate (`bbFlowerAtIntake` + `bbBites`) wants ≥ 0.5 in of overlap in x AND z with
  the actual bottom element. Standoff tolerance: ≈1.17 in side rollers, ≈0.68 in ramp.
- ⚠️ **`u` is measured from `mouthAxes.uOut` (the footprint edge), not the chassis frame.** The frame
  can never get nearer than `bbIntakeReach`; measured from it nothing reached and the tutorial's
  retrieve step never completed. `uOut` sits ON the foot face when driven flush, so `u ≈ BB_PLACE_REACH`.
- **Reach parts ARE colliders in 3D** (owner: "It should be a collider"), in the authority AND both
  predictors, in `GROUP_POCKET` (walls/statics/robots meet them, elements pass through):
  `chassis3dReachShapes` (`sim3d/bodies.ts`; `Chassis3dShape.rot` for the tilted rails). The ramp's
  appear at the settle edge (0.3 s after the press) and go on the fold press; rebuild key is
  (height, rampReady). Measured: side rollers stand off a wall by exactly 2.65 in; predictors agree
  with the authority to 0.25/0.42 in; step3d 1.0 ms; predictor cost unchanged.
  ⚠️ A wall-flush start with the wheels in the wall NEVER settles (Rapier escapes through the floor
  — the wheel is 2.5 tall vs 2.65 sideways — and the floor cancels it, zero drift for 300 ticks), so
  `spawn.ts` backs a 3D start off by `bbArchetypeWallExtra` (side rollers only; 0 elsewhere). 2D is
  drawing-only (no z; the foot is a solid rect) — documented in the biobuzz.md bullet.
- Pictures: `scratch/shots.cjs` (one Electron process per shot) against `scene-preview` with
  `?physics=3d&intake=…&park=flower|open&ramp=1`; `.claude/launch.json` has `scene-preview-b` on 5177.
- **The ramp toggle**: `RobotCommand.bbRamp` (edge, like `driveMode`), `RobotState.bbRampOut/bbRampAt/
  bbRampHeld` (absent on every other build; written only on a press), `bbRampStep` in both pipelines at
  the turret-slew site, gated on `robotsEnabled`; credited only `BB_RAMP_DEPLOY_S` (0.3 s) after the
  stamp, and both renderers ease off the same stamp. Key `L`, pad RS (11). HUD chip RAMP DOWN/UP.
- ⚠️ **`QCommand.buttons` is 16 bits** (`BTN_BBRAMP` = 256; sanitizer to 0xffff). The replay
  recorder's `packKey` masked buttons `& 0xff` inside a packed number — bit 256 was invisible and a
  ramp press was never recorded; it is a string with the buttons alongside now. No `REPLAY_FORMAT`
  bump: the track is plain numbers and an old reader masks the bits it knows. An OLD server refuses a
  packet carrying bit 256 (one tick of input lost, only on a build with no ramp to press).
- **Builder**: the static "Sweeper" card is a 3-card picker; `send()` now carries the intake through a
  launcher/Box Tube edit (it used to rebuild `bbMech` without it, which would have reset the kind).
- **Tutorial**: the retrieve step lends a sweeper-only build side rollers for the lesson and says so.
- **Open**: the AI never retrieves from a flower (unchanged). A ramp deployed against a wall is drawn
  through it. `RobotPreview.tsx` (SVG) draws the ramp folded only.

---

# HANDOFF — 2026-09-20a (alpha: third playtest pass — phantom hive corner, phantom hive tip, the hive's pivot hardware, Box Tube reach, disabled-robot prediction, intake in the transition, spent friend challenges)

Seven owner items. Gates on the final tree: `npm test` ALL PASS (3,143 biobuzz +
shared), `build`, `server:check`, `uiaudit`, `docaudit`, `bundleaudit`, `test:mm` (200), `dbtest`.
Not run: `shiftaudit`, `test:ai`. `dsim-alpha` was redeployed (server code moved: the challenge
clear and the 3D collider set). Production untouched.

- **The hive foot bar is ONE box** (`sim3d/fieldColliders.ts`, `squareFootBars`). The exporter's
  bar plus two feet buried 0.11 in behind its face left an internal edge; a pressed chassis sits
  0.09 in in and its leading corner stopped dead on the foot's side face (mecanum, 0.8 push / 0.5
  strafe, stuck at y 9.14, blue bar, +y only). The 8-point decimation had also made the bar a
  wedge (24.73 → 24.62). Same class of bug to look for anywhere two CAD hulls are near-coplanar.
- **Parts bolted to the TRAY are tray colliders** (`cadTrayRiders`, `buildHiveTray3d`): the eight
  Churro braces and, per hive, two pivot brackets, two damper holders, two dampers. They ship under
  the static frame in both the GLB and the collider JSON. The renderer now carries all of them on
  the tilting group (`renderFieldGlb.ts`, selected per welded COMPONENT within 1.25 in of the tray
  centreline — per-triangle slices the A-frame top corner); physics had them frozen at the captured
  pose. Zero density, so the see-saw's calibration does not move.
- **Only the UP cell loads the tip** (`sim3d/derive.ts`). Both cells went into `contents`, which the
  tip pin, the HUD and Table 10-2 read as the up cell's load; a miss through the open down cell
  counted. 7 up + 1 down tipped at tick 330. Both cells are still TAGGED `hive:<a>`. A physical
  knock was ruled out: 480 shots at 260 in/s never moved a pinned tray.
- **The 3D predictors zero the command while robots are disabled** (`sim3d/predict.ts`, `liveCmd`).
  They re-stepped the raw stick through `pre`, the transition and `post`. The phase read is the
  last snapshot's, so the local robot wakes one snapshot after the server enables it.
- **The drawn intake is gated on `robotsEnabled`** in `render/renderer.ts` (all games),
  `biobuzz/drawRobot.ts` and the 3D roller.
- **The Box Tube reaches the flower's opening** (`scene/renderRobots.ts`, `bbBoxTubeStages` /
  `bbBoxTubeAim` in `config.ts`). Shoulder on the frame rail (an inboard pivot rose through a centre
  turret), fixed cradle + four pitching stages, pose solved per frame from the flower
  `bbFlowerInReach` returns, 0.12 s. Render only.
- **A friend challenge is cleared when it is used** (`clearRoomInvitesTo` on the recipient's join,
  `clearRoomInvites` when the matchmaker stages a rated party token, plus the client's own dismiss
  in `onJoinInvite`). It only ever aged out at `INVITE_TTL_S`. The join clear is scoped to the
  recipient on purpose: a host reconnect must not delete an unanswered invite. No WS-level test
  exists for the two call sites; `dbtest` covers the repo half.

Open: the AI lane's `bot-driven 2v2 step3d p95 <= 1.5ms` flickers under load on the dev box
(1.41–1.61); it passed in the full run. An element can still come to REST in the down cell — it is
excluded from the load and counted when that cell comes up, which is right, but nothing evicts it.

---

# HANDOFF — 2026-09-19e (alpha: THE FLOWER LANE FINISHED, plus the owner's second playtest pass — intake front, shooter head, turret lead, catapult dumper, tape, hive sheets, G417 out / G407 per the manual, FPS slider, game-specific keybinds on top of PR 81)

Twelve owner items, run as parallel lanes and merged here. Every gate below was run
on the MERGED tree. The one thing that needed the coordinator rather than a lane is the first
section: the lanes each wrote a real 2x room-tick regression off as "machine load".

## ⚠️ A RESTING ELEMENT NEVER SLEPT, AND SCATTER IS WHAT MADE THAT EXPENSIVE

`perf: a 2v2 BIOBUZZ ROOM tick costs <= 1.2x a 2v2 Chain Reaction room tick` read **1.41–1.92 in
ISOLATION** on the merged tree against 0.77–0.96 at `f17395f` on the same machine, same hour (bb
0.29 → 0.55 ms). Three lanes saw it, and each blamed contention — because this file says that
check is load-sensitive. It is; and it was also really broken. **If it fails, run the same check
in isolation on a baseline worktree before believing either story.**

Bisected by toggling: not the flower cage, not the chassis contact skin, not the pocket filler
(each removed alone: no change). It was the STAGED SCATTER — but only as the trigger. The cause is
older: every element at rest in a FLOWER or a CELL was woken EVERY TICK, by two zeroing writes with
`wakeUp: true` (`groundRoll3d`'s floor-band branch, which the BOTTOM element of a flower column
sits in, and `syncElement`'s diff-teleport, which fired on every `derive.ts` rest snap). Measured,
idle 3D world, tick 900: 16/16 FLOWER and 6/6 CELL elements awake at `vmax` 0, against 0/16 on the
tiles. Nearly free while a column stood dead on the bore axis (an element touches two neighbours);
scattered, every leaning element is a standing wall contact: idle step 0.168 → 0.302 ms.

Fixed in `sim3d/engineImpl.ts`, three edits, each with its measurement in the comment: a rest snap
zeroes WITHOUT waking; the floor-band write wakes only what is moving; and READBACK calls
`wakeUp()` on any element whose rounded position moved more than `RELAX_EPS` (5e-4 in) that tick —
without that last one a scattered column fell asleep MID-SEPARATION (interpenetration 0.13 → 0.69
in). `RELAX_EPS` is a measured knee (table on the constant). After: idle step **0.124 ms** (below
the pre-scatter 0.168), room tick back to bb 0.29–0.33 ms; CELL elements stay awake (they touch the
jointed tray). The SIM3D "relaxation DECAYS" check now accepts all-zero drift, which is the
expected reading; its comment says why.

## What landed

- **THE FLOWER LANE (the item this branch was opened for).** The jam was the TUBE, not the balls:
  between the mid plate (5.254) and the top plate (20.254) a flower has NO WALL, only four round
  pipes with open gaps — a POLLEN centre reaches 0.53 in toward a pipe and 1.05 in into a gap, so
  two shoulder and the column arches (stranded 10/24 at n=4, 22–24/24 at n=7). `buildFlowerCage3d`
  (`flowerTube.ts`) is ONE circumscribed trimesh prism per flower on the middle bore's own CAD
  radius (1.948) — the 12-cuboid fan failed the AI lane's p95 (1.86–1.95 ms vs 1.5), the prism
  does not (1.25–1.44); fewer than 10 sides puts a vertex past the pipes. Jam 0/360, drain 0/64
  (n = 1..8 × 8 seeds, real retrieval), NECTAR still locks. SCATTER: `flowerPlace3d` and, in 3D
  worlds only, the pre-match STAGED columns, offset by a hash of `(tick, id, flower, rngState)` —
  `rngState` READ, never advanced; the bound is `bbFlowerDropSlack` × `BB3_FLOWER_SCATTER_FRAC`
  (the tightest BORE, not the cage — against the cage a drop landed inside the peanut supports
  and was ejected 8–28 in). **2D is byte-identical, proven**: 30 worlds built through today's and
  `f17395f`'s spawn code, whole-JSON + `worldHash`, 0 divergences. The old "DO NOT JITTER IT"
  table was re-measured flat once the wall existed; both headers say so.
- **THE INTAKE FRONT IS A RECTANGLE (owner: "the intake plates stick out further than the rollers
  so the hitboxes are weird").** Two earlier passes answered the wrong question (arms end at
  `uOut`; true, irrelevant). The compound's outer prism had exactly ONE hole — between the arm
  tips, floor to `BB3_MOUTH_SLOT_Z` — and eight statics fit under the lintel (six hive base
  bars/feet at 2.13–2.15 in, two flower base plates; never a robot, `BB3_HEIGHT_MIN` is 12). A
  hive bar's end sat **2.03 in inside the robot's own `robotExtents` box** and yawed it 128°.
  `chassis3dPocketShapes` adds one FILLER per mouth that everything meets EXCEPT elements
  (`GROUP_ELEMENT` / `GROUP_POCKET`; the masks table is in `bodies.ts`). After: 0.15 in. Capture
  counts, flat-wall rest, start legality, no-climb: unchanged. Cost 1.049x step (8 paired rounds;
  an earlier "+20 %" was contention; lifting the filler off the floor bought nothing and would
  have re-opened the hole — the shortest reachable static is 0.24 in). Also kept: a 0.125-in edge
  break as a CONTACT SKIN (`chassisBoxDesc`; a `roundCuboid` cost 1.065x), mirrored in
  `predict.ts`. Drawn: a front BRACE across the tips + rounded plate noses, 3D and the 2D sprite.
  ⚠️ **Every corner probe the stopped lane left in `scratch/` drove `driveX: 1`, which is STRAFE.**
- **THE SHOOTER HEAD (owner: "the parallel plates became ugly … the arc does not need to be big";
  "the flywheel looks like two wheels").** The fixed plate is the compact pre-`f17395f` outline
  again; the HOOD carries its own sector CHEEKS on `bb-turret-pitch` (boss on the axle, span =
  `BB_HOOD_WRAP`, inboard of the plates), so it is one hinged assembly at every pitch and nothing
  is left standing at the 80° cap. ONE flywheel mesh at y = 0 with bare shaft and collars (it was
  two meshes at ±0.7). Muzzle chain BYTE-IDENTICAL: sha256 over 62,447 rows of `bbMuzzleLocal` +
  `bbTurretSolution` equals `f17395f`'s.
- **SHOOTING ON THE MOVE (`feat/bb-turret-lead`).** A release leaves with `v + ω×r` at the muzzle
  (turret AND dumper, both pipelines — there was NO inheritance before, so nothing to lead).
  `bbTurretSolution` leads inside the same fixed `BB_TURRET_SOLVE_PASSES`; parked it is
  byte-identical (289 poses, deviation 0). `bbSlewTurret` is rate + ACCELERATION (`BB_TURRET_ACCEL`
  70, `BB_TURRET_PITCH_ACCEL` 12): 90° in 0.333 s, overshoot 0. `turretHeading` is WORLD-frame and
  the rate window is centred on `r.angVel`. Flat out past the hive 75–100 % of released shots
  score; a hard reversal leaves it 22–24° behind for 0.60–0.75 s and the gate releases NOTHING
  meanwhile. New optional `bbTurret*Vel` fields: +2.5 % snapshot (7,826 → 8,021 B of 10,000).
  ⚠️ **3D's release gate is now the ballistic landing check, not alignment — an outcome change in
  every server match, owner-authorised by the instruction.**
- **THE DOTTED PATH.** Six causes of a path with no score, closed: empty hopper, wrong phase,
  passive robot, a dumper mid re-arm, 3D gating on alignment while the path ran a landing
  prediction (ONE predicate now: `bbTurretShotEnters` / `bbDumpShotEnters`), and a MID-SWING hive
  (28 of the last 28). Before 24.6 % (2D) / 53.8 % (3D) false paths over 1,600 cases; after 0.
  ⚠️ **THEN THE OWNER RULED ON THE LAST ONE, THE SAME DAY: the path is drawn "in the case that we
  can make the shot assuming that the hive is completely up on the side that we are aiming for".**
  So `solveShotPath` asks `bbPretendHive` — the fire gate's own copy — and a cell that is DOWN or
  MID-SWING still draws a path; the `hive.tipping > 0` refusal is gone, and so is "against the
  REAL hive". Path and gate are one verdict with no exception (a RENDER check re-asks the gate by
  hand over a pose spread: 0 disagreements). The "0 false paths" figure above was measured with
  the refusal in, and no longer holds for a down/swinging cell BY DESIGN.
- **THE DUMPER IS A CATAPULT.** `bbDumpCluster`: four seats, two across × two high, ONE velocity,
  parallel arcs; the whole hopper on one tick. The 3D stagger (`perDump`, `BB_DUMP_STAGGER_S`) is
  deleted; 2D keeps the converging solve (`BbShot.cluster` is the switch). 20/28 poses score
  (equals the stagger), 16/28 all four. At 22 in the bottom row clips the structure — pinned.
  `bb-dump-arm` snaps off `lastFireAt`; no wire field.
- **TAPE WIDTHS — THE FIFTH REPORT, AND IT WAS NEVER THE DATA.** All 16 strips are 1.000 in. The
  map draws at 2–6 device px/in, so where a 3.1-px strip's edges fell inside a pixel decided its
  look. `snapTapeGroup` (`drawField.ts`) snaps a zone's strips as a GROUP to one whole-pixel
  width, corners exact; the fallback floor texture uses it too. The recorder ctx (no `canvas`)
  still gets world rects, so the CAD-strip check is intact. The GARDEN is two 1-in tapes BY THE
  MANUAL (Fig 9-3); it is drawn as one band of exactly two widths.
- **THE HIVE'S CLEAR SHEETS WERE BACK-FACE CULLED.** Three shading passes moved the owner's view by
  under 0.1 of a level because the back of a cell was not being rasterised from behind. NO clear
  surface in `field.glb` is a closed slab — single-sided sheets wound INWARD (two-faced area 0.0 %
  walls, 0.4 % trays). The earlier "not culling" proof binned ±x/±y normals only; a cell's back is
  a gable at (0.54, 0, ±0.84). `DoubleSide` draws a SHEET once from either side, so the layer
  count does not double (the old header assumed slabs). Back skin alone from behind 12 → 35;
  `PANEL_VEIL` 0.018, alphas unchanged (0.08 / 0.13). The RENDER lane parses the real GLB and
  fails on a side/geometry mismatch. The perimeter walls had it too (culled from outside).
- **G417 IS GONE, G407 FOLLOWS THE MANUAL.** Hive-ramming billing, `frameRam`, `bb.hiveRam`,
  `BB_FRAME_RAM_SPEED` deleted in both pipelines; a check rams the frame under both physics and
  asserts nothing is awarded. G407: warning at 5+, and ONE MAJOR per robot per match when 6+ is
  held past MOMENTARY (3 s, manual §10.6) or on the second >MOMENTARY instance of 5+. New line
  `G407 STRATEGIC CONTROL of 5+ elements` — **a foul STRING, so this is a SERVER change.**
- **X-DRIVE.** A 45° omni reaches 1.945 in on both axes and sat in the mecanum channel (1.17 in
  inside the frame): 0.78 in proud. Inset by its own reach; the inner side plate drops, as swerve.
- **MAX FRAME RATE** is a slider (24–360) + number box (to 1000); the top stop is "Display rate"
  on the web (Unlimited is never offered there — rAF is the ceiling) and VSync/Unlimited on
  desktop. A stored `-1` on the web displays as Display rate and is not rewritten.
- **GAME-SPECIFIC KEYBINDS, ON TOP OF PR 81** (`ArushYadlapati/gamepad-combo-keybinds`, merged
  here via `feat/game-keybinds`). `ControlBindings.perGame` is a SIBLING field (old clients keep
  working); an action present there is CUSTOM for that season, absent = SYNCED; `effectiveBindings`
  is the one resolver. Two actions conflict only if some season uses both (`ACTION_GAMES`). A
  main edit that collides with an override: the override loses the bind. `BIND_SLOTS_MAX` 8.
  PR 81's rule-4 TAP lasted one rAF frame and was lost ~2 in 3 at 165 Hz; `PAD_TAP_HOLD_MS` 34.

## Gates (merged tree)

`npm test` **ALL PASS** (shared PASS; biobuzz 3,095) · `build` 0 · `server:check` 0 · `uiaudit`
at/under · `docaudit` ALL PASS · `contrast` ALL PASS · `bundleaudit` ALL ROUTES AT/UNDER ·
`test:mm` PASS. `dbtest` not run (nothing under `server/db` moved). `shiftaudit` not run.
`test:ai`: **ALL PASS** (150 matches, 535 s) — HARD beats EASY 95/100, mean margin 52.5; idle means easy 33.2 / medium 79.1 / hard 101.9. It notes the plan's 90 % is now met and `BB_AI_WIN_RATE_FLOOR` could be raised; left alone, one run.

## Open, and owner decisions pending

- Keybinds: owner, same day — "keybinds should stay the same across seasons for sure". Read as:
  shared is the default. Reset wiping per-season overrides and the scope switch opening on All
  games are therefore right as built; nothing changed.
- AI: owner — ignore the bots for now, they get an overall pass later. `BB_AI_WIN_RATE_FLOOR`
  was NOT raised.
- 3D still slides past a tall post at 0.4 in of overlap where 2D manages 1.0 — a box chassis in
  the 3D solve; no corner treatment closes it (a cylinder does 1.6).
- **NAME MODERATION IS TWO LAYERS NOW, AND THE WORD LIST IS NOT IN THIS REPO.** The owner's key
  works (42/42 names really checked) and is set: DEPLOYED on `dsim-alpha`, STAGED on production
  (`dohun-sim-decode` — takes effect on its next deploy; nothing was restarted). Measured with it,
  the hosted model refuses slurs and threats and ALLOWS most bare obscenities (it classifies
  hate/harassment; it is not a profanity filter). So `server/blocklist.ts` is a local matcher in
  FRONT of it, fed by the `MODERATION_BLOCKLIST` secret — ⚠️ **owner ruling: no profanity in the
  repo and no published list; the checks in `smoke.ts` use a NONSENSE vocabulary on purpose, do
  not paste a real word into one.** The real list lives at `D:/Projects/2ddecodesim/.env.blocklist`
  (git-ignored there by `.env.*`), same secret on both Fly apps, same alpha-now / production-staged
  split. Both layers together: 35/35 should-block, 21/22 should-allow; the one false positive
  ("Assassins …") is the HOSTED model's and no list can fix it — an allowlist secret would.
  Whole-word entries by default (the Scunthorpe problem is real: it was the first false positive
  the real list produced), `*` for substring; CamelCase is a word boundary.
- The models README records the single-sided clear sheets as an asset defect for `field-cad`.

## Next steps

1. Push `alpha`; redeploy `dsim-alpha` (`./scripts/fly-deploy.sh --alpha`) — the sim, a foul
   string and `RobotState` fields all moved.
2. Production (`main`, `dohun-sim-decode`) untouched; promotion is the owner's call.

---

# HANDOFF — 2026-09-19d (branch `ArushYadlapati/gamepad-combo-keybinds` off alpha: GAMEPAD COMBOS + add/remove binding slots, PR into alpha)

**(Previously READ FIRST.)** One commit on the owner's fork, rebased onto alpha `f17395f` and opened as a PR
into `alpha` with the owner's go-ahead (the only conflicts on the rebase were this file and the
generated class inventory). `npm run build` is green, `npm test`'s shared suite is green
(51 new checks in the `gamepad COMBOS` block), `uiaudit`, `docaudit`, `contrast` and
`server:check` are green. An independent review pass (2026-09-19) found two real gaps, both
fixed and pinned: a prefix TAPPED inside the combo wait fired nothing (now rule 4, below), and
the pad capture effect restarted on every App re-render (the 8 s presence poll), dropping a
half-built chord (the effects now depend on `capture` alone, values in refs). The BIOBUZZ
suite has ONE failure that predates this branch and is not touched by it: `fieldDims.gen.ts is
exactly what emit-dims.mjs renders from field-measurements.json`. Its own message says to run
`npm run field-cad`; **do not, on a Mac** — it drops a 92 MB `C:/` tree into the repo root.

## What was built (the owner's request, verbatim intent)

"Combo keybinds for the gamepad, like the multiple keybinds people use IRL … chain keybinds
together once the other keybinds run out, e.g. a lift on D-UP and RT" — and the complaint under
it: changing one binding "messed up everything else", because the screen could only REPLACE a
slot, never ADD one, so every rebind on a full pad cascaded into an UNBOUND somewhere else.

- **Every action takes any number of alternatives**, keyboard and pad: a `+` keycap at the end
  of each row captures into a new slot; Backspace or Delete while a slot is waiting removes it.
- **Gamepad COMBOS**: hold two or three buttons during a capture and the bind is the chord
  (`RT + D-UP`). Capture commits on the first RELEASE so a second button can join; a lone press
  is still a single. `PAD_CHORD_MAX` is 3.
- **The model** (`src/input/bindings.ts`): `PadBindings.combos: Record<PadAction, PadChord[]>`,
  a SEPARATE field from `buttons` — a settings blob is persisted and account-synced verbatim,
  and an older client reading arrays inside `buttons` would reject every pad binding and save
  the defaults back over them. `padBinds(pad, action)` (singles then combos) is the one view
  the resolver, the keycaps, the start overlay and the tutorial hints read. The edit helpers
  (`assignKey` / `removeKey` / `assignPadBind` / `removePadBind`) moved here from the screen so
  the steal policy is pinned by smoke: **stealing is exact** — a single steals that single and
  touches no combo, a combo steals the identical combo and touches no single.
- **The resolver** (`src/input/padChords.ts`, DOM-free, clock-injected): (1) longest satisfied
  chord wins and masks the singles it is made of; (2) a satisfied chord that is a strict prefix
  of a bound, unsatisfied chord waits `PAD_CHORD_GRACE_MS` (80 ms) — nobody presses two buttons
  on one frame, and DECODE's first shot is instant — the wait is the player's own
  `chordGraceMs` (the "Combo wait" slider under Trigger threshold, 20..200 ms, greyed until a
  combo is bound); (3) a fired combo consumes its buttons until released, so letting go of
  D-UP with RT still down does not start shooting; (4) a prefix let go INSIDE the wait fires
  once on release, so a quick tap still counts. Rule 3 is tested before rule 2 so a blocked
  chord is never a waiting one. With no combo bound it takes an explicit fast path: the old
  any-button test, no state. `docs/area/ui.md` lists the two things the rules deliberately do
  not do (non-nested overlapping chords all fire; masking reads satisfied, not fired).
- `gamepad.ts` builds the held set (triggers past `triggerThreshold`) and asks the resolver;
  edge detection for start/restart/flip/park is unchanged. `GameView`'s start overlay and
  `tutorial/hints.ts` print the first bind's label (`padBindLabel`). `.ds-key.add` is the one
  new class (`uiindex` regenerated). `docs/area/ui.md` carries the rules.

## Verified at the surface (hidden offscreen Electron, `scratch/verify-combos.cjs`)

Fake `navigator.getGamepads` stub, DOM assertions: the `+` captures; the keycap reads
`D-UP + …` then `RT + D-UP + …` while the chord builds; releasing binds `RT + D-UP` on the
catapult throw with Shoot's RT and Place POLLEN's D-UP untouched; an identical combo bound to
Park is stolen from the throw; Backspace removes it; keyboard `+`/steal/UNBOUND/Backspace all
behave; the saved blob carries `combos.fling = [[7,12]]` beside untouched singles. In a Solo
Practice AUTO with auto-fire off: holding RT + D-UP for 1.5 s leaves the hopper at 3 of 3
(Shoot masked); with the wait at 200 ms, RT held 100 ms fires nothing and RT held on empties it.
A capture held across the 8 s presence re-render still binds. Screenshots in
`scratch/shots-combos/` (gitignored).

⚠️ **The owner does not want a test window on their desktop.** The driver runs
`show: false` + `offscreen: true`; the verify skill now says so. Do not go back to `show: true`.

## Next steps

1. PR review on `genius0412/dsim` (base `alpha`). Nothing server-side to deploy.
2. Feel-test the default combo wait with a real pad; 80 ms is a judgment call, not a measurement,
   and the slider's 20..200 bounds are the same kind of call.
3. Not built, deliberately: keyboard chords (the request was the pad), and a touch-only way to
   remove a slot (Backspace needs a keyboard; a phone with a pad is rare).

# HANDOFF — 2026-09-19c (alpha: THE OWNER'S PLAYTEST PASS — two launch bugs, the hive registration delay, the robot signs, the frame-rate row; FLOWER LANE STOPPED AND NOT LANDED)

**(Previously READ FIRST.)** Six lanes ran off `d64cf19`. Five landed and are in this commit. **The SIXTH — the
FLOWER lane — was STOPPED mid-work on owner instruction and its source edits were REVERTED**; what
it learned is written down below and its probes survive in `scratch/`. Read "THE FLOWER LANE"
before picking that up, because the expensive half (the measurement harnesses) is already done.

## What landed

- ⚠️ **TWO LAUNCH BUGS, ONE ROOT SHAPE: a Rapier body created or teleported INSIDE a solid, which
  penetration recovery then ejects along the contact normal.** `birthClear`
  (`sim3d/engineImpl.ts`) is the guard, and there were two doors into it.
  1. **Walls and corners.** It built its solid list from `world.robots` ONLY — no walls, no frame
     bars, no flower feet — and its escape marches FORWARD along the arc, which walks a release
     deeper INTO a wall rather than out of it. ⚠️ **Measured NOT reachable on the normal path:**
     576 real shots flush at every wall and corner, 8 headings by 3 mounts, gave **0** bad births,
     because aim assist is forced on by `coerceAssists` and only releases a shot its landing gate
     says enters the CELL, which is always inboard. On MANUAL aim (`r.aimAssist = false`, a branch
     the sim still has) it is severe: birth 2.86–3.84 in PAST the wall's inner face, and five ticks
     later the element was dead and buried in 12 of 21 poses, or 136–176 degrees off in the
     corners. `fieldClamp` now pushes a birth point the shortest way out along that wall's own
     normal with the solved velocity untouched, and the arc march STOPS at the first sample that
     leaves the field. Identity in the open field; the old dumper behaviour is byte-for-byte
     unchanged.
  2. ⚠️ **INTAKE WHILE SHOOTING — this is the one that bit in production.** `birthClear` was gated
     on `!existing`, i.e. it guarded body CREATION and not the transition INTO flight. An element
     normally has no body while `held` (`wantsDynamicBody` is true only for `ground`/`flight`/
     `element`), but bodies are removed only inside `syncElement`, and stage 11 runs capture then
     launch **with no sync between them** (`step3dImpl.ts:148-149`). So on any tick where the
     intake takes something and the turret's beat is ready — the ordinary feed-and-shoot loop, with
     `autoIntake`/`autoFire` on — the element went ground to held to flight keeping its live ground
     body, the guard was skipped, and the body was teleported to the muzzle, a point on the
     mechanism INSIDE the chassis compound. A dumper's lob came out **101 degrees off, apexing at
     10 in instead of 63**; a turret's 2.4–3.6 degrees, born 7.3 in inside the chassis. After:
     **2.1 degrees, apex 63.2**, born 0.00 in inside.
     ⚠️ **THE GUARD IS KEYED ON "TELEPORTED SINCE THE LAST READBACK **AND** `by` STAMPED", NOT ON
     "kind changed to flight".** `derive.ts` re-tags every bouncing GROUND element as `flight`, so
     the obvious rule would teleport a ball in mid-flight clear of a robot it is supposed to hit.
     Only `releasePollen` stamps `by`. An intake pull edits velocity only, so it never qualifies.
- ⚠️ **THE HIVE REGISTRATION DELAY — a rest timer where the physics wanted a depth test.**
  `deriveTick` required `BB3_REST_TICKS` (6) consecutive ticks under `BB3_REST_SPEED` before a ball
  counted as being in a CELL, and `hives[a].contents` — which the tip threshold, `cellCount`, the
  HUD and G410 all read — was built from that. Measured over **1,500 randomized arrivals**, centre
  entering the interior to `contents` holding it: **mean 95.3 ticks / 1,588 ms, p50 75, p90 205,
  max 264, and 1 in 100 never registered at all.** The settling was 84–90% of it. TIP latency
  48–76 ticks (0.80–1.27 s). **After: mean 0.3 ticks / 6 ms, 0 misses; TIP 11–15 ticks
  (0.18–0.25 s).** No animation duration and no tip threshold was touched.
  ⚠️ **THE REST GATE'S STATED REASON WAS FALSE, AND THAT IS WHAT MADE THE FIX CHEAP.** It was
  defended as "a shot crossing the mouth is not yet in it". Of 209 arrivals that put a centre
  inside, 92 left again — and **every one stayed within 2.75 in of the open rim**. Nothing enters a
  one-opening box and comes back. The shallowest a really-landed element ever RESTS is 4.33 in
  down. So `BB3_CELL_SEAT_DEPTH` (3.5 in, mid-window) separates them outright, with a LATCH read
  off `b.state.el` so a counted ball cannot flicker. 0 grazes counted, 0 landings missed.
- **The settle clock asks about MOTION again** (`settle.ts`). The hive fix left a hole: an element
  bouncing in a cell used to be tagged `flight` and held the clock open, and is now tagged
  `element` from the tick it is deep, so it held nothing — and a tray over its load is a TIP **when
  the match is called**, so a clock that can close mid-bounce can miss one. Reproduced at `vz`
  83.57 in/s reading `settled = true`. The gate is inverted now: skip `held`/`stock`, motion-test
  everything else. ⚠️ **The opposite failure is on record in that file** (elements parked on the
  frame are permanently `flight`, and refusing on the TAG held the clock for the whole 10 s cap —
  the owner's "takes forever when nothing is moving"), so this was measured before it was changed:
  across nine end-of-match states, every `element`-tagged ball read max planar `v` **0.0000** and
  max `|vz|` **0.0000**, 0 ticks above threshold, because `derive.ts`'s REST SNAP has no tag gate
  and holds a rested element at exactly zero. Eight bot-driven matches finalize at identical ticks
  with identical scores and **0** predicate disagreements; 51,857 `element` readings in 2D agree.
- **ROBOT SIGNS, to the actual rules.** R401/R402/R403 were fetched from Competition Manual V1
  section 12.4 (pp127–129) rather than guessed. Two signs on opposite surfaces, **6.5 x 2.75 in**
  (2.75 is the only height at which R403.A and R403.B both hold and it still clears R401.C's 2.5),
  solid alliance fill, white Arabic numerals. Two bugs found on the way: the old sign printed the
  robot's **slot index** and not `spec.teamNumber`, and its white border is **prohibited** by R402.
  `-` when the number is 0/unset, matching the 2D team card.
  ⚠️ **`bbSpecKey` NOW CARRIES `teamNumber`** even though it moves no vertex: the number is
  rasterised into the sign texture at BUILD time, so without it a changed number would keep the old
  one on both plates AND in the cached thumbnail.
- **The hive's own surfaces.** AprilTag bleed on the upper face — undecodable by RASTER RESOLUTION
  (1.4 px/in against 0.325-in tag cells, 2.2 cells per pixel), not by opacity, so the bits are gone
  before the texture exists. The sticker label is the manual's two-line form. The back panel was
  never a culling problem: `transparent` with a constant `opacity` multiplies the SPECULAR too, so
  a more see-through sheet got a fainter reflection — backwards; it is polycarbonate IOR 1.586 with
  a Fresnel-weighted alpha now, face-on unchanged at the measured 0.08/0.13.
- ⚠️ **THE BANNER IS BLANK ON PURPOSE, AND IT IS NOT A COMPROMISE.** The CAD's `am-5883 Panel
  Sticker` ships BLANK (`decal#ffffff`); the old `bannerTexture` invented "FIRST TECH CHALLENGE /
  BIOBUZZ / amber rule" and painted it onto blank source data, which is why it read as wrong.
  FIRST's IP policy (rev 04/19/25) restricts LOGOS to registered teams identifying their own teams,
  to written agreement, or to nobody — field DESIGNS are copyrighted material in a different, more
  permissive tier, which is what the rest of this sim relies on. Redrawing the wordmark by hand is
  not a loophole: the brand guidelines say use only the versions provided and forbid altered ones.
  The manual also notes the panel "may not be present at all events". The no-logo assertion is
  STRENGTHENED — the banner body may now contain no `fillText`/`strokeText`/`.font`.
- **Intake plate meshing with the chassis.** `bbMouths` makes every mouth EXACTLY chassis-width —
  `f.half - chassisHalf = 0.0000` at all 20 mouth sites — so the arm's outer face sat precisely on
  the side plate's, with `armX0 = f.rail - 1.1` running 1.1 in of overlapping solids behind it.
- **The hood reads as one assembly.** `BB_SIDE_PLATE_TOP_Z` (+0.967, BELOW the flywheel crown at
  +1.417) was applied over the WHOLE upper hemisphere, including behind the exit lip where the
  hood, its tail and the feed shoe are — so the hood floated 2.95 in above anything fixed, carried
  by two 0.26-in arms. ⚠️ **The VALUE did not move and nothing in the muzzle chain reads it**
  (`sidePlateR` is its only reader); what changed is the ANGULAR RANGE it binds over — a forward
  cut, then a 22-degree relief ramp, then the hood's own arc. Gap **3.23 to 0.566 in**.
- **Chassis colour actually shows.** The file header CLAIMED the deck carried `chassisFill`; the
  code had the deck in the STRUCTURAL mesh, and the cosmetic mesh was four VERTICAL plates
  presenting a 0.22-in edge from above. The deck is cosmetic now, plus a top cap on each side
  plate, with the lane measuring upward-facing cosmetic area (>60 sq in, >25% and <75% of
  footprint).
- **The frame-rate row** (`graphics/settings.ts`, `GraphicsSection.tsx`, `electron/`).
  `30 / 60 / 120 / 144 / 240 / Custom / VSync / Unlimited`. `MaxFps` is a `number` with two
  sentinels (`0` VSync, `-1` Unlimited) and a typed range `[24, 1000]`; `coerceMaxFps` matches the
  sentinels FIRST and exactly so no clamp can produce one, and rejects `NaN`, the infinities,
  `'60'` and `59.5` via `Number.isInteger`. ⚠️ **`0` ALWAYS WAS UNCAPPED** — it was called
  "Display", which is what made it read as a cap; rAF is paced by the compositor, so in a browser
  it IS the ceiling. Unlimited is real only in the desktop shell (`disable-frame-rate-limit` plus
  `disable-gpu-vsync`, appended before `app.whenReady()`, hence a restart), shown on the web anyway
  with the truth on its face. ⚠️ **`update-pref.json` was written by REPLACING the whole
  document**, so adding a second key would have silently destroyed the update auto-check
  preference; it is read-modify-write now.

## THE FLOWER LANE — stopped, reverted, and how to finish it cheaply

Owner instruction, mid-work. **Its source edits are GONE** (`sim3d/flower3d.ts`, `sim3d/bodies.ts`
and `scripts/smoke-biobuzz/flower3d.ts` reverted to `d64cf19`; `BB3_INTAKE_CORNER_*` and
`BB3_FLOWER_CAGE_*` stripped from `config.ts`) — roughly 756 insertions. **Its PROBES SURVIVE in
`scratch/` and are the expensive half**: `flowerstuck{,2,3,4,5}.ts`, `flowersweep.ts`,
`flowerthresh.ts`, `flowerperturb.ts`, `flowerplace.ts`, `flowermissing.ts`, `cageperf.ts`,
`corner{,2,3}.ts`, `cornerfinal.ts`, `intakebox.ts`, `bbintake.ts`, `rapiercaps.ts`.

Three items, none landed:

1. **Placing balls in a flower is too uniform** (owner). `placeFlower3d` drops every element on the
   flower's exact centreline with zero velocity, so a column is a perfect stack. Needs
   deterministic scatter — from `world.rngState` (mulberry32) or from settling the element, NEVER
   `Math.random`, and the draw has to happen where every peer makes it identically.
2. **POLLEN get stuck in a flower instead of dropping.** The lane reached a jam between a PAIR of
   elements across the bore and was probing contact NORMALS (`flowerstuck5.ts`). Its proposed fix
   was a **CAGE WALL**: a fan of tangent cuboid slabs inside the bore, `BB3_FLOWER_CAGE_SEGMENTS`
   12 and `BB3_FLOWER_CAGE_T` 0.5 in, because a trimesh measured WORSE on the SIM3D room-tick
   budget. Inscribed shave at 12 rays is `r * (1 - cos(pi/12))` = 0.066 in on the 1.948-in bore —
   tighter than CAD, which is the safe direction — against 1.02 in of slack for a 2.8-in POLLEN.
3. **The intake corner catch** (owner: "I can get stuck on a corner"). ⚠️ **MEASURED: the side
   plates are NOT longer than the rollers.** Arms end exactly at the mouth's `uOut` for every
   preset — sloped 10.250, vector 10.750, triangle 12.250 — and are flush with the frame laterally
   (+/-8.250 = `hw`). What catches is that the LINTEL spans the same depth across the full mouth
   width from z -5.40 to +9.00, so for anything taller than an element the robot's whole front face
   is `reach` (3–5 in) ahead of the frame, with perfect 90-degree corners. **Do NOT shorten the
   arms or the lintel** — `chassis3dShapes`'s header records that the tips end exactly where
   `robotExtents` ended so flat-wall contact, wall-flush starts and start legality do not move, and
   that thin arms alone let a robot climb a low static (parked 2.14 in in the air, stalled).
   The approach was an EDGE BREAK, not a shorter box: `ColliderDesc.roundCuboid` **is available in
   `@dimforge/rapier3d-deterministic-compat`** (probed at runtime — `scratch/rapiercaps.ts` also
   confirms `convexHull`, `roundConvexHull`, `roundCylinder`), so half-extents reduced by `r` keep
   every flat face in its own plane. At `r = 0.125` the two-edge corner pulls in by
   `(1 - 1/sqrt 2) * r` = 0.037 in and the three-edge vertex by `(1 - 1/sqrt 3) * r` = 0.053 in —
   both under the 0.1 in of resting penetration the solver allows anyway, so no contact distance
   anybody measures can tell the difference.
   ⚠️ **ITS LAST FINDING, UNRESOLVED:** "a 45-degree chamfer still has lockable edges (and locks
   harder at depth) — try a multi-segment arc." Start there.

## Two follow-ups the lanes raised and left

- **`scene/renderField.ts`** (the constants fallback path) did NOT get the Fresnel panel treatment
  the GLB path did, so its panels will look flatter. The three cross-path constants the RENDER lane
  compares are unchanged, so nothing fails — it is a fidelity gap, not a break.
- **The CAD statics gap in `fieldClamp` is open and documented in the code.** It covers the four
  perimeter walls and the tile plane analytically; the rest of the field's statics are CAD convex
  hulls and trimeshes with no analytic sphere-vs-hull escape, and an AABB stand-in would teleport
  an element several inches out of a box that is mostly air a robot legally drives through. No
  reachable launch puts a birth point inside one, which is why it was left.

## Gates

Run on a QUIET tree, after the flower lane was stopped and reverted.

`npm test` **2918 checks, ALL PASS** (shared PASS, biobuzz PASS) - `build` exit 0 -
`server:check` exit 0 - `dbtest` ALL PASS - `test:mm` 197 - `contrast` ALL PASS (221) -
`uiaudit` at/under baseline - `docaudit` ALL PASS - `bundleaudit` ALL ROUTES AT/UNDER -
`shiftaudit` 576 state changes, 0 layout shifts.

⚠️ **`perf: a 2v2 BIOBUZZ ROOM tick costs <= 1.2x a 2v2 Chain Reaction room tick` IS LOAD
SENSITIVE, NOT FLAKY LOGIC.** Three separate lanes hit it while five agents were running; it reads
1.20–1.42 under contention and 0.79–0.86 in isolation, and it passes on a quiet tree. If it fails,
check what else is running before believing it.

## Next steps

1. Merge to `alpha`, push, redeploy `dsim-alpha` (the server moved: nothing here, but the previous
   commit's analytics/admin/suspension did).
2. Production (`main`, `dohun-sim-decode`) is untouched; promotion is the owner's call.
3. The flower lane above is the only owner item from this pass that is not done.

---

# HANDOFF — 2026-09-19b (alpha: THE OWNER'S 25-ITEM PASS, RECOVERED FROM A HALTED SESSION AND FINISHED)

**(Previously READ FIRST.)** A previous session ran out of usage mid-pass over the owner's 25-item list and
left its whole tree UNCOMMITTED in `.claude/worktrees/shooter-simulation-fixes-c916ec` — ~70 files,
7.7k insertions, never committed and never gated. That work is now commit `9162190` (checkpoint,
verbatim) plus the lanes below. **All 25 items are closed.** Every gate is green.

## Where the work actually was (the archaeology, so nobody repeats it)

Ten worktrees exist. Only ONE held live work:

| worktree | state |
|---|---|
| `shooter-simulation-fixes-c916ec` | **the live one** — ~70 files uncommitted at `4a48038`, the tip of every other branch's lineage. Now `9162190`. |
| `alpha-main-divergence-7a6134` | 60 files uncommitted at `56e5836`, superseded — its `shotPath.ts` / `drawShot.ts` / `Results.tsx` are committed in `9b4478a`, an ancestor of `4a48038`. |
| `nice-morse-09b59a` | clean, same commit as the live one. |
| `alpha-ui` | 5 files uncommitted, last commit 2026-09-12. Long superseded. |
| `main-deploy` | ⚠️ leftover UNMERGED index entries from an aborted operation (no `MERGE_HEAD`), local `main` 62 commits behind `origin/main`. Its staged work (`src/net/stagedMatch.ts`, `src/ui/copyText.ts`) is already in `origin/main`, so the leftovers are discardable — NOT discarded here, because that worktree holds production's branch. |
| `biobuzz-3d`, `biobuzz-3d-worktree-*`, `pr-alpha` | clean, all ancestors. |

`origin/alpha` was already at `4a48038` — so the alpha BRANCH was never behind. Item 9's complaint
was about the deployed `dsim-alpha` machine, not about code.

## The checkpoint (`9162190`) — what the halted session had already finished

Items 1, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 24, 25. Audited
item-by-item against the diff rather than taken on trust, and the claims hold: each carries a
measurement or a regression check, not a renamed constant. The load-bearing ones:

- **Item 1, the shooter** (five previous passes rejected). `bbHeadDims(elemR)` in `config.ts` is the
  whole dimension chain: motor at θ = 180°, dead behind the wheel and outboard of the hood's swept
  disc (a); `axleX = pathR`, so the element pinches on the rotation axis it came up (b); the back
  flap is now `bb-turret-throat`, the channel's rear wall and the rear tie (c); `BB_HEAD_POLLEN` vs
  `BB_HEAD_NECTAR` are genuinely different heads — 9.635 in muzzle against 10.035 (d). The RENDER
  lane proves the motor can's front face is behind the hood's rear-most point over the WHOLE pitch
  sweep, rather than asserting an angle.
- **Items 6 and 12, the tape.** The manual (p65) says 1-in or 2-in ProGaff; `docs/biobuzz/manual-distilled.md:510`
  shows the 2-in zones drawn as two 1-in strips, which is why `BB_TAPE` is 16 measured 1.000-in
  strips and `BB_TAPE_2` is gone. No centre cross exists on the real field — the HIVE structure is
  what stands at the centre — so the fake 8-in white cross was removed. **`BB_TAPE_W` is not a line
  width**: every mark is a filled rectangle.
- **Items 11 and 13.** Gated on `quality === 'high'`. The AprilTag check decodes `apriltag36h11Cells`
  against the real `tag36h11.c` payloads for ids 30 and 45 — it is not a picture of a tag.
- **Item 21.** The restitution combine rule was picking Min, so a 30-in drop rebounded 0.9 in once.
  Measured now over eight elements: 1–4 bounces, up to 12.7 in of rebound, ~38 in of scatter.

## What this session added

- **Item 2 — the swerve pod's check was wrong, not its renderer.** `podParts()` merges the fork
  plates, the TOP PLATE and the kingpin into one unnamed `swervePod:struct` geometry, and the check
  took the union bbox of every unnamed mesh — so it picked up the 3.2-in top plate sitting at
  z 3.60–3.90, clear above the wheel's 3.00 crown, and called the 2.1-in fork "3.20 long over a 2.92
  tyre". Both checks now walk the struct's own world-space triangles, keep what reaches the crown or
  below, and RASTERISE the silhouette onto the tyre's bounding square on a 200×200 grid: **74% left
  clear against a 55% floor**. ⚠️ The companion "fork length" metric reads 0.90, not ~1.76, because
  three.js's `CurvePath.getPoints` does not subdivide straight `LineCurve` segments — the only
  below-crown VERTICES are the boss arc's. The rasterised coverage is the real assertion; the length
  metric is a weaker sanity bound than it looks.
- **Item 23 — the replay export camera.** It was `useState<SceneCamera>('driver')`, a literal. The
  live camera is not scene state: it is the device preference in `graphics/store.ts` that the scene
  reads at construction and writes when `c` cycles it. `openMenu()` now seeds the default through
  the same `resolveSceneCamera(interactive, hostPick, pref)` the render loop resolves with, so there
  is no second copy of the cycling logic. `exportView` was already seeded this way; no other export
  default carried the bug.
- **Item 9 — nothing to fix.** `eaf5a71` is in `origin/alpha`. Redeploy `dsim-alpha`.

## Gotchas found while verifying at the surface

- ⚠️ **The perf HUD needs 30 frames before it draws anything** (`getPerfStats` returns null under
  `frames.count < 30`). In an automated browser the Browser pane only paints when a screenshot forces
  one, so the card looks BROKEN at every level until ~30 forced paints have gone by — and then the
  frame times read 100007 ms, which is the harness, not the game. This cost a false bug report here;
  do not file it again. Same root cause as the `world.tick` note in `docs/area/biobuzz.md`.
- `GraphicsSettings.perfOverlay` is deliberately INERT — `GameSettings.perfDisplay` is the one
  setting, and it is four levels (`off` / `simple` / `detailed` / `graphs`), not a boolean. There is
  no UI control bound to `perfOverlay`; do not add one back.

## The admin console (items 24 and 25) — verified at the surface, and it was broken at the door

The checkpoint's admin work compiled and passed `dbtest`, but nobody had ever WATCHED it run. Driven
through `scratch/admin/boot.ts` (the real `server/index.ts` on PGlite with a local JWKS) it turned
out the front door did not work at all:

- ⚠️ **`/admin#tab=users&user=…` ALWAYS OPENED ON LIVE.** `App.tsx` canonicalizes `/admin` →
  `/decode/admin` with `replaceState(canonical)`, and `pathFor` emits no fragment — so the hash was
  destroyed before `Admin` mounted. Every tab link, every account link pasted between moderators,
  and the whole `#tab=`/`#user=` design added in `9162190` had never worked once. `replaceState`
  now carries `location.hash`; the QUERY is still stripped, which is what that call is for
  (`?token=`).
- ⚠️ **`bundleaudit` HAD BEEN RED SINCE `9162190`** — `other` 9.12 KB against a 1.00 baseline, and
  `main` grown to 938.59 KB, because `App.tsx` imported `Admin` STATICALLY and dragged six panels
  into the chunk every player downloads. `lazy(() => import('./Admin'))` puts it behind its own
  route: **main 938.59 → 923.89 KB**, `other` 1.66, a new `admin` route at 25.21. The static import
  predated the checkpoint; what made it fail was the checkpoint's ~1000 new lines behind it.
- **The 30d and 90d analytics ranges rendered a dashboard of zeros.** `from` is computed in the
  browser and floored on the server, so the 30-day preset was ALWAYS microseconds past the
  raw-retention boundary and fell through to `analytics_daily`, which is empty on a service younger
  than the range. A 1-hour boundary grace fixes it (series 0 → 186 points), and an empty aggregate
  tier now says so instead of printing zeros under "read from the daily rollups".
- Four smaller ones: `ds-btn ghost smallall danger` (`smallall` is declared nowhere, so two
  destructive buttons rendered full-size — same bug class as `--ds-font`), a keyless fragment in
  `EventsPanel`, `AccountName` printing "no username yet" beside accounts that HAVE one (it treated
  an unprojected `undefined` as a never-claimed `null` — the same three-state bug as `(no profile)`,
  one level down), a 7-day suspension reading "168 hours", and Refresh disabled exactly when the
  report queue is empty.

All 7 tabs render, 22 read routes return 200, and all 18 mutating routes round-trip AND write an
audit row — verified by diffing `listAudit` across every call, not by reading the code.

**Five moderation gaps closed** (migration `0043`): suspend/lift (a DEADLINE, not a flag, so it ends
by arriving; enforced at BOTH `join` and the ranked `queue`, read from the DB rather than a cache
because it matters most one second after the button); clear an abusive @username (CLEARED, so the
account re-runs `UsernameGate` and no moderator picks somebody's permanent name); delete an account
(the player's own tested cascade, refused for a staff id because `syncStaffRoles` would resurrect
it, audit row written BEFORE the delete since afterwards there is no profile row to join); reports
filed AND received on the account panel; and flagging a Ko-fi payment charged back (it does not
revoke — that stays a second decision). ⚠️ `player_reports` cascades on BOTH parties, so the "filed"
count a moderator judges somebody on is a FLOOR, not a total.

**Deliberately not done: kicking a live session.** Sockets live on the machine serving the request
and one Fly app runs several regions, so a kick from the console would silently miss sessions
elsewhere. The suspension is the cross-region lever; a real kick needs a cross-machine signal.
Also left: events on an aggregate range still read the raw tier (labelled in the banner);
`adminSupporterHistory` in `src/net/api.ts` is now a dead client function.

## Design pass on three left-border accents (the `impeccable` hook, owner asked for a real fix)

The hook flags `border-left: Npx solid <colour>` on a card as the side-tab tell. All three sites
predate this work. The test applied was **does the colour carry anything a reader who cannot see it
would lose** — and it split them three ways:

- **`.eventlog-line`** — carried NOTHING. Identical accent on every line whatever the event was.
  Removed; the 1px full edge was always what separated it from the letterbox.
- **`.ann-item`** — carried nothing EITHER, and the comment that defended it was wrong.
  `Announcements.tsx` renders `<KindBadge kind={a.kind} />` at the top of every item, so the edge
  restated in colour what the header already says in words. Removed, with `.ann-item.season` and
  `.ann-item.act` (which existed only to recolour it).
- **`.intro-card`** — the ONLY one that had to keep its colour. Nothing else in that card says red
  or blue: it prints a team number, a name, a team name, a drivetrain and an ELO. So the SHAPE
  changed instead — 1px frame + 4px left slab became a 2px border all round, and `.red`/`.blue`
  set `border-color` rather than `border-left-color`. Symmetric weight is not a side-tab, and it
  reads better over the intro's dark scrim. `box-sizing` is border-box globally, so it moves no
  layout — `shiftaudit` agrees (576 state changes, 0 shifts).

⚠️ **The hook also reports ~31 `design-system-color` / `-radius` / `-font` findings in
`src/ui/styles.css` that are PRE-EXISTING palette drift**, untouched by any of this work. They are
not addressed here — that is a separate, whole-file pass, and mixing it into this one would bury
the 25 items in unrelated churn.

## The admin harness is real tooling now, not scratch

`scratch/admin/boot.ts` (gitignored) is promoted to **`scripts/adminharness.ts`** / `npm run
adminharness`, and `.claude/launch.json` gains an `admin-harness` entry on port 5189 plus
`"autoPort": false` on `dev` (the owner wants `dev` pinned to 5173). The reason is the trap: the
admin console is the one surface with no automated UI coverage, the harness is how you verify it,
and a launch config pointing at a gitignored file is a dead end on a fresh clone. It touches no
real database and no Fly machine — PGlite in memory, a local JWKS, bound to localhost, gone when
the process is. Same `setPoolForTests` seam `scripts/dbtest.ts` already uses.

⚠️ **It binds 8798/8799 and the client wants 5189.** A harness left running from a previous session
will silently answer your `curl` and make a FAILED boot look green — that happened here. Kill the
old PID before trusting a health check.

## Gates on the merged tree

`npm test` **shared PASS + biobuzz PASS** (2713 checks) · `build` exit 0 · `server:check` exit 0 ·
`dbtest` ALL PASS · `test:mm` 197 · `contrast` ALL PASS (221) · `uiaudit` at/under baseline ·
`uiindex` 251 classes, 0 unreferenced · `docaudit` ALL PASS · `bundleaudit` ALL ROUTES AT/UNDER
(main 923.89, admin 25.21, other 1.66) · `shiftaudit` **576 state changes, 0 layout shifts**.

## Next steps

1. Merge to `alpha`, push, and **redeploy `dsim-alpha`** — that is item 9, and the server moved
   (analytics, admin routes, suspension enforcement at `join`/`queue`, migrations 0041–0043).
2. Production (`main`, `dohun-sim-decode`) is untouched; promotion is the owner's call.
3. `main-deploy`'s stale unmerged entries are still sitting there — see the table at the top.

---

# HANDOFF — 2026-09-19 (alpha: THE SHOOTER REBUILT — hood-only elevation, a 72 mm flywheel on a
turret plate, and the sim's release following the hood lip)

**(Previously READ FIRST.)** The sixth pass at this one mechanism, and the first that changed the machine rather
than a constant. Gates: `npm test` (**2538** — shared and BIOBUZZ both green) · `build` ·
`server:check` · `docaudit` · `uiaudit` · `contrast` (221) · `test:mm` (197) · `bundleaudit`
(scene 201.81 against a 201.44 baseline, inside the 4 KB tolerance and the 250 ceiling) ·
**`test:ai`** (150 matches, 9.5 min: HARD beats EASY 74/100, mean margin 26.2; tiers ordered
66.1 / 113.3 / 127.8 against idle).

## Why five passes failed

Each one moved a constant to answer the last complaint and produced the next: a flat front cut
(accepted); `rIn` raised until the flywheel's rim sat in a bare annulus ("the flywheel looks like it
is not constrained to the plate anymore"); the tail zeroed after measuring AT REST ("the plate is
meshing with the chassis"); `BB_FLYWHEEL_R` cut 2.0 → 1.5 to buy ρ for a motor pocket under the axle.

⚠️ **THE ROOT CAUSE WAS OWNERSHIP, NOT GEOMETRY.** `scene/renderRobots.ts` owned the shooter's
dimension chain privately while the sim owned a flat `BB_LAUNCH_Z0 = 10`. Two sources, no check
between them, so the picture and the physics could disagree indefinitely — and did, for five rounds.
The chain lives in `config.ts` now and the renderer imports it.

## The four owner rulings this implements

| | ruling | what it forced |
|---|---|---|
| (b) | the hood extends above the plates | the plate's outer arc IS `BB_HOOD_R`, so the hood's own 0.28 of material is the proud part, by construction |
| (c) | the flywheel sits right above the turret plate | a real turret plate exists now; the wheel bottom is 0.300 above it |
| (d) | only the hood moves | `bb-turret-pitch` carries the hood arc and two arms and nothing else |
| (e) | a standard flywheel is 72 mm | `BB_FLYWHEEL_D_MM = 72`, never a rounded decimal |

⚠️ **(d) IS WHAT MADE THE REST POSSIBLE.** The pitch node used to carry the whole head, pivoting
about the muzzle, which is the only reason a ρ budget ever existed — the entire assembly swept
through the drivetrain at elevation and everything had to be squeezed inside it. Fixed parts need
static deck clearance and nothing more, so `BB_HEAD_RHO_MAX`, `minHeadWorldZ` and `plateOuterR` are
gone rather than re-tuned.

## The release follows the hood (owner-authorised, it changes shot outcomes)

A hood pivoting on the axle moves its own lip, so the release is no longer flat: **9.634 in level,
8.466 at 57.6°, 7.554 at the 80° cap**, retreating along the heading as it drops. `bbMuzzleLocal`
(`robot.ts`) is the one muzzle and `scene/renderRobots.ts` imports it — the RENDER lane proves the
drawn lip is on the sim's muzzle at every pitch rather than assuming it.

⚠️ **`bbTurretSolution` IS A FIXED POINT**: the elevation moves the release and the release moves
the elevation. `BB_TURRET_SOLVE_PASSES` (4) runs ALWAYS — no early exit, no tolerance — because a
trip count resting on a float comparison can differ between a client's prediction and the server's
authority. A fifth pass moves the pitch by at most 1.76e-9 rad over 7,688 field poses.

Measured consequence, authorised knowingly: scoreable field cells **1359 → 1382** north and
1417 → 1439 south, pitch-capped cells 255 → 211, nothing speed-capped, worst required muzzle speed
253.26 → 256.37 against a 260 cap. The lower release costs a little speed and unblocks more of the
field than it loses. **No version was bumped** — replays from before this re-simulate slightly
differently under the same `SIM_VERSION`, which the owner was told and has not asked to change.

⚠️ **A DUMPER HAS NO HOOD AND ITS RELEASE IS STILL FLAT.** `bbLobThrow`, `bbDumpSolution` and
`bbLaunch`'s dumper branch all still read `BB_LAUNCH_Z0`, and the ROBOT lane carries a leak guard: a
dumper's release stays flat at every pitch while a turret on the same chassis follows its hood down.

## The feed shoe, which is what answered "a weird flap in the back"

A hood on an axle pivot carries its own feed mouth round with it — at 80° of pitch the mouth has
gone 80° round the wheel and the feed no longer lines up. So the wrap shrank 1.05 → 0.556 rad and a
FIXED shoe at `BB_FEED_SHOE_R` 4.397 spans 146°–202° and takes over the entry. It bolts to both side
plates, so it is also the rear tie. The loose plank is gone because something real replaced it.

## What the adversarial check measured, not what the builders claimed

An independent agent built the real `buildTurret()` group and measured world positions:

- meshes under the pitch node: `hood`, `hood-arm`, `hood-arm` — nothing else;
- wheel, plates, braces, motor and feed shoe all diff **0.000000** between pitch 0 and the cap;
- hood-minus-plate gap **+0.280 worst** over 3600 samples, +3.230 at rest, never negative;
- wheel lowest 5.700 against a turret plate top of 5.400;
- sim muzzle vs drawn lip: **0.000000** at pitch 0/20/40/60/80.

It also found a defect neither builder caught: the plate's full-radius arc was documented as
θ ∈ [14.30°, 206.00°] when it is actually **[165.70°, 206.00°] — 40.3°, at the back, and nowhere
else**. Everything from 15° to 166° is governed by the flat top. Corrected in `config.ts`, with the
reason the hood-proud figure is 3.23 at rest and 0.280 at full elevation rather than one number: at
rest the hood rides its arms well above the flat top, and at 80° it has swung round to exactly the
arc stretch.

## Two bugs the build found in the CHECKS themselves

Both had been hiding real geometry, and both are why the RENDER lane passed five times on work the
owner rejected:

1. `radialBar` returned an INDEXED `BoxGeometry`. `mergeGeometries` refuses a mixed indexed and
   non-indexed list, returns null, and `framePart` falls back to `parts[0]` — so each hood arm was
   silently its rim alone.
2. The corridor sweep filtered on the nearest VERTEX's `|y|`. A `CylinderGeometry` standoff has
   vertices only at its end caps, so every brace, the motor and the belt read `|y| ≥ 1.92` and
   dropped out of the sweep unmeasured. It tests the part's y INTERVAL now.

The lane no longer greps source text for the shooter: it imports `buildTurret`, BUILDS the group,
poses `bb-turret-pitch` at 41 elevations and measures vertices.

## Open

- The `+20°` brace leaves **0.133** of exit-corridor clearance. It stands: the side plate's own flat
  top is the binding part there and clears by 0.150 by definition, so nothing fixed at that height
  can do better.
- Far-corner speed headroom is **3.63** against the 260 cap, down from 6.74. A ratchet check fails
  if it drops below 3.6. Raising `BB_LAUNCH_SPEED_MAX` is a balance decision nobody has made.
- `BB_AI_WIN_RATE_FLOOR` stays at 55%. `test:ai` measured 74% and its own footer suggests raising
  the ratchet, but the PRE-change rate was never measured, so there is no way to say whether 74 is
  an improvement or where it always sat. Measure a baseline before tightening it.

# HANDOFF — 2026-09-19 (alpha: THE OWNER'S TWELVE-ITEM PASS — the hive tip, scoring instants, flower
and tile contact, the shooter/swerve/box-tube rebuild, intake cadence, one alliance blue)

Eight commits plus the merge of `origin/alpha` they sit on. Twelve items, all
from playing the running 3D game. Nine were diagnosed read-only first and then implemented under
one-owner-per-file, which is what kept nine concurrent agents off each other.

⚠️ **THIS LANDED ON TOP OF THE PRE-PUBLISH MERGE BELOW, AND THAT SECTION'S PUBLISH STILL HOLDS.**
`alpha` still contains `main`, so `git checkout main && git merge --ff-only alpha` is still a
fast-forward, and the deploy ORDER that section gives — Vercel builds `main` and serves it FIRST,
`./scripts/fly-deploy.sh` from a `main` worktree SECOND — is unchanged and still load-bearing.
Nothing here was deployed.

Four files conflicted with what had landed on alpha meanwhile. Three were mine to keep; the fourth
was not: **`scene/renderElements.ts` took the upstream resolution whole.** That lane found the same
bug from the other end and its answer is a superset of mine — one `bottom = biobuzzPhysics(world)
=== '3d'` deciding whether `b.z` is an underside, applied to the FLOWER branch as well as the hive
one, and it also catches that my earlier "lift by `r` unconditionally" fix had leaked into the 2D
pipeline it was never about.

## 1 · The HIVE tips on the table it promises

⚠️ **THE DYNAMIC TRAY'S TRIGGER IS `BB_TIP_POLLEN`, NOT A TORQUE** (`sim3d/hive3d.ts`). The owner's
report was "it says 0 more to tip and it does not tip", staged as 1 POLLEN + 4 NECTAR: the load
weighed 5701 against a hold of 5915 and the tray sat on its stop for the rest of the match.

No calibration could have fixed it, and that is the part worth keeping. **ONE COUNT DOES NOT
DETERMINE ONE TORQUE.** Measured in one cell at the shipped hold, staging the same count four ways:

| load | crammed 2-wide up the back | guide staging | 2-wide line down the tray |
|---|---|---|---|
| 8 POLLEN | 4560 (no tip) | 7284 | 8051 |
| 7 POLLEN | 4146 (no tip) | 5647 | 6769 (tips) |
| 3P + 3N | 4933 (no tip) | 6869 | 8407 |

The two counts' ranges overlap over most of their length, so no value of `BB3_HIVE_DETENT` separates
them — and both halves of field guide §12.3 were being violated at once on the shipped numbers. The
lane never saw it because every fixture staged one packing. The detent is a PIN THE TABLE LIFTS now;
everything after the release is still the free see-saw. `hiveContentsTorque`/`hiveRestoringTorque`
stay exported because they are how the lane and `scripts/hive-calibrate.ts` MEASURE the tray.

⚠️ **`BB3_HIVE_DYNAMIC = false` IS NOT A ONE-WORD REVERT, AND HAS NOT BEEN SINCE G409 LANDED.**
`bb.spill` — G409's whole tag — is written in exactly one place, inside `hiveDynamicTick`. The
kinematic path never writes it, and all four G409 checks live inside `if (BB3_HIVE_DYNAMIC)` blocks,
so flipping the word kills G409 in 3D **and the lane stays green**. The comments that claimed
otherwise are corrected.

## 2 · A scored line waits for the instant §10.5 assesses it at

⚠️ **AN INSTANT LINE IS WORTH ZERO UNTIL ITS INSTANT HAS PASSED.** Measured before the fix: the
score bar read 4 before the match started and 9 one second into AUTO, 29 s before anything on it had
been assessed.

| line | instant | §10.5 |
|---|---|---|
| LEAVE, AUTO PARK | end of AUTO | F |
| TELEOP PARK | end of the MATCH | G |
| POLLEN/NECTAR in the up-CELL | everything at rest, end of MATCH | C |
| POLLEN/NECTAR in a GARDEN | end of TELEOP, all at rest | E |
| the HIVE TIP, both FLOWER lines | continuous | A, D |

The COUNT stays live — a driver still sees the achievement land — and `BbAllianceScore.pendingPts`
carries what the instants still owe, shown as a `+N PENDING` chip in the muted row, deliberately not
in the panel. `total + pendingPts` is invariant for a field that stops changing. **The FINAL score is
unchanged**: every harvest happens at or after `post`. This is shared rules code, so it moved the 2D
pipeline too — correct for a rules bug, and no version was bumped.

## 3 · The shooter, the swerve pods and the box tube

The shooter plate had been "fixed" twice and kept digging into the chassis, because both fixes
measured the plate AT REST. ⚠️ **THE CONSTRAINT IS THE SWEPT ENVELOPE, NOT THE POSE.** Elevation
rotates the whole pitching head, so `BB_HEAD_RHO_MAX` is the new invariant: nothing on the head may
exceed ρ = `BB_LAUNCH_Z0 − BB_DECK_Z − 0.2`. At rest the old head cleared the deck by 0.45 in and
looked right; at 45° of elevation the feed ramp swept the deck, the belly pan and the wheels and
stopped 0.04 in off the tile. `minHeadWorldZ` is the closed form the RENDER lane samples.

- **Swerve is a pod**: top plate, azimuth ring, fork, 3-in wheel, belt drive, all of it under the
  deck plate's 4.34 in of headroom and inside the frame (`BB_POD_INSET`). A 4-in wheel does not fit
  — it leaves 0.34 in for plate, ring and bearing — which is why COTS FTC pods are 3-in.
- **The flywheel motor** is behind the hood at 205° about the axle, between the plates, driving a
  belt over a 0.68/0.54 pulley pair. It is not beside the flywheel any more.
- **The box tube** telescopes over `BB_BOX_TUBE_EXTEND_S`, off `bbFlowerInReach` — the SIM's own
  predicate, not a second reach model.
- **The in-reach cue** is one predicate and two drawings, the rule the shot path already follows:
  `scene/renderReticle.ts` in 3D and `drawShot.ts`'s `drawBiobuzzReachCue` in 2D, both reading
  `bbFlowerInReach`. The 2D call site is in `draw.ts`, under the shot path, matching the 3D render
  order.

## 4 · Flower and tile contact

A FLOWER column is a physical pile now, not computed heights: four POLLEN settle at gaps
2.735/2.757/2.778 against an ideal 2.8, and a dropped POLLEN's bottom lands at −0.011 in at all four
tubes with `containmentFixes` still 0. A NECTAR is still stopped by the 3.222 bore, so G418 holds.
`BB3_CONTACT_FREQ` 30 (the shared default is 12) is what stopped elements sinking into the tray
floor. The tiles bounce slightly more: `TILE_RESTITUTION` 0.05, which under Rapier's Average rule
makes the element/tile coefficient 0.25 rather than 0.225. `sim3d/predict.ts` took the same number,
or the drawn shot path would lie.

## 5 · The intake

The cadence gate is 0.06–0.12 s per element (was 0.15–0.3). ⚠️ **AND THE GRIP WAS A UNITS BUG**:
`approach(from, to, maxDelta)` was being handed `BB_INTAKE_DRAW_IN` — a SPEED — as a per-TICK
displacement cap, i.e. 3120 in/s² of effective acceleration, so an element reached full draw-in
speed from rest in one tick. `BB_INTAKE_GRIP_ACCEL` (1200 in/s², APPROX) times `dt` replaces it, and
`BB_INTAKE_DRAW_IN` is 84 (was 52).

## 6 · One alliance blue, and it is not the CAD's

⚠️ **THE CAD IS AUTHORITATIVE FOR DIMENSIONS AND IS NOT AUTHORITATIVE FOR THIS COLOUR.** The STEP
gives the hive Goal Ribs `plastic#0000ff`. Pure `#0000ff` is OKLCH hue 264.1° — 1.7° off the most
violet blue sRGB can express, and the worst available answer to "it looks too purple". An assembly
carrying pure `#ff0000` AND pure `#0000ff` is carrying placeholder part colours, the same way its
`#e6e6e6` "white plastic" is one, which `renderFieldGlb.ts` has overridden since the clear-panel
pass.

Every BIOBUZZ blue is **`#007be1`** now — tape, NECTAR, hive accents, the constants-built fallback
scene, the GLB's ribs and the robot silhouette. Hue 252.9°, the least violet a saturated blue gets
before it reads cyan, at the most chroma sRGB has there, and L 0.583, within 0.002 of the red tape's
own lightness. APPROX: **no authoritative AndyMark blue was found**, so this is a perceptual
correction and not a sourced value. RED is untouched — a pure red still reads as red, and the owner
named only blue.

## Open, and deliberately so

- **`BB_INTAKE_LANE_W` stays at 9.** Moving it to 8 gives the default 17-in build a second feed lane
  — a balance change rather than a feel change, and the owner has not ruled on it.
- **`src/config.ts`'s `COLORS.blue` (`#3b82f6`, hue 259.8°) is unchanged.** It is DECODE's and Chain
  Reaction's too; BIOBUZZ no longer reaches for it.
- A staged FLOWER column is born one radius high in 3D — `spawn.ts` writes `flowerStackZ`, which
  returns CENTRES (the one exception to `b.z` being a bottom), and `syncElement` adds another
  radius. It settles correctly on tick 1 now that the column is physical, so it is a first-tick
  drop rather than a wrong resting height.
- A vz −200 shot still peaks at 0.154 in of penetration into the tray floor on the landing tick at
  30 Hz. Settled penetration is what item 3 was about and that is fixed; the transient is not, and
  no check pins it.
# HANDOFF — 2026-09-19 (alpha: PRE-PUBLISH AUDIT — main merged INTO alpha, so alpha → main is a fast-forward)

`alpha` was ready to publish at this commit. `origin/main` has been merged into it here, with the
five conflicts resolved (below), so the publish is a **fast-forward**, no hand-merge:

```
git checkout main
git merge --ff-only alpha
git push origin main
```

Then deploy **in this order and no other**: let Vercel build `main` and confirm the site serves
it, THEN `./scripts/fly-deploy.sh` from a `main` worktree. `docs/deploy.md` → "Deploy ORDER when
the wire protocol moved" says why: the new server refuses every pre-`bb3d` client from every
BIOBUZZ room, and the reverse order locks production BIOBUZZ players out until Vercel catches up.

Gates on the tree this merge commit carries: `build` · `server:check` · `docaudit` · `uiaudit` ·
`contrast` (221) · `test:mm` (197) · `dbtest` · `bundleaudit` (re-measured: `main` DOWN 6 KB gz, a
new `gallery` route) all green; `npm test` is **1878** shared, all green, and **2380** BIOBUZZ with
**three wall-clock `step3d` perf checks red on the audit machine** — the same three are red on the
PRE-fix tree there (A/B, alternated), and green in the 2026-09-19 render-pass HANDOFF below on the
owner's. Every other BIOBUZZ check passes. `npm test` now runs BOTH suites unconditionally
(`scripts/test-all.mjs`). `shiftaudit` was not run this round.

## What the audit was

Eight read-only audits of the alpha-vs-main delta (202 commits, 245 files) by lane — main-only
drift, server/net, security, sim core + versioning, BIOBUZZ 3D, UI, docs/hygiene, tests — then
the findings triaged and fixed in four disjoint batches. Findings the owner has to rule on are
listed at the end; nothing there was decided silently.

## Fixed — things main had and alpha lacked (cherry-picked: `63bc806` `882fda6` `eaf5a71`)

- `applyBallDelta` returns COPIES — a spectator's stationary elements (flower stacks, hive
  cells) were never corrected again. `f52b175`.
- A reconnecting spectator re-spectates instead of claiming a driver slot. `747dae0`, hand-merged
  so the rejoin frame keeps alpha's `caps: CLIENT_CAPS` (a `'3d'` room re-gates a reclaim).
- Restarting a solo record run works — `releaseSeatLock` / `abandonSlot` /
  `releaseSoloRecordHold`. `aca358e`; this was the regression main's 2026-09-17b section is about,
  and alpha never had the fix.

Everything else on main was already on alpha by content. Main's `ff5044c` (revert of the
HIVE-feel batch) is the ONE intentional divergence and the merge resolved it to alpha — see the
versioning entry below for why that is now safe.

## Fixed — replay fidelity

- **`SIM_VERSION` 2 → 3.** Main and alpha both stamped 2 over DIFFERENT `step()` behaviour for a
  BIOBUZZ world (six-draw spill, `hiveDeflect`, load-driven swing rate, CAD geometry, the 2D
  intake rewrite, `bbSnapSize`). The ledger in `src/config.ts` now lists all of it under 3, and
  says plainly that replays recorded 2026-09-13→17 are mis-stamped 2 and will play as `behaviour`
  DRIFT on a v3 build, which is the correct label. A bump is a drift, not a refusal.
- Main's spill draw-count tripwire is ported to the FIELD lane, retargeted to **6**. The next
  change to that number comes with another bump, in the same commit.

## Fixed — server

- `verifiedFromSession` (the email-verified fallback) is deduplicated per token and has a 2 s
  timeout; it was an unbounded, un-timed HTTP call on the join hot path, made even when the gate
  it feeds is off.
- A ranked / matchmade room cannot start before the 3D wasm has resolved
  (`physicsReadyForRoom`): custom rooms waited, `startRankedImmediate` / `beginRanked` did not.
- `Room.stop()` frees the match's Rapier 3D world (`disposePhysics3dFor`). The engine map is a
  `WeakMap`, so dropping the World dropped the only handle without `free()`, and wasm linear
  memory never shrinks — a few hundred 3D matches would have held every one.
- `addBot` mints unique seat ids (`bot-<seq>-<code>`); remove-then-add reused an id.
- `caps` off the wire is coerced (`coerceCaps`: strings only, ≤16) at all eight sites.
- `lanRateOk` / `exportRateOk` sweep unconditionally; `POST /api/user/settings` body capped at
  64 KB (was 512 KB, unlimited calls); `accept-terms` short-circuits when the version is already
  accepted.

## Fixed — client / UI

- `TermsGate` and `UsernameGate` STAND DOWN on `/terms` and `/privacy` (`suspended`). They are
  full-viewport backdrops beside the routed screen, so the gate's own "read the terms" link opened
  a tab with the same gate over the document. The acceptance fetch still runs.
- Results: `solo` is "no opposing roster", not "no session" — a BIOBUZZ practice against bots
  showed a one-sided screen for a match that had an opponent and a winner. The eyebrow still says
  SOLO PRACTICE for any local run. The record run's net score is animated once (it was tweened
  twice, and the inner tween restarted every frame).
- `AuthPanel` is a real dialog (`role="dialog"`, labelled, Escape closes); auth errors are
  described, not dumped (`describeAuthError`). The prediction picker has group semantics and a
  focus ring; Results overlay buttons have a visible focus ring on the field surface.
- The analytics beacon strips the QUERY STRING, and URL canonicalization compares
  `pathname + search` — a reset / verification `?token=` on an already-canonical path was never
  cleaned and left the device inside a pageview.
- `safeHref` no longer admits protocol-relative (`//evil`) links in admin markdown.
- `vercel.json` sends `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `Referrer-Policy`,
  `nosniff` — the one-click consent controls were frameable.

## Fixed — BIOBUZZ 3D

- `renderElements.ts` branches the parked-element z convention on the PHYSICS
  (`biobuzzPhysics(world)`), never on `state.kind`: 3D writes a bottom for every ball, 2D writes a
  centre for a parked one. Both mistakes had shipped, one per branch (hive floating 1.4 in in 2D,
  flower sunk a radius in 3D). Pinned numerically in the FLOWER3D lane against the real body.
- The FULL predictor stands its robots at `bbHeightNow` (stowed before the match, deployed after)
  and re-fits across the R102 deploy edge, reading back against the height it actually built. It
  used `robotHeightIn` — deployed whatever the phase. **Its chassis stays ONE `robotExtents`
  cuboid, deliberately**: giving it the authority's open-mouth compound was built, measured
  (forty-tick reconcile 3–6 ms → 9–11 ms on the local robot alone, 16–17 ms on all four, A/B
  alternated against the tree without it) and taken back out, because Auto reads that probe
  against `PREDICT_FULL_BUDGET_MS = 8` and would have picked LIGHT everywhere. Written down above
  `makeRobotBody` in `predict.ts`; owner decision 11.
- `GameController.adoptWorld` frees the outgoing world's 3D solve on every swap (five sites) and
  on `dispose`; `bufferSnapshot` reads the physics off `snap.world`, not the previous world (the
  first snapshot of a 3D room dropped its ball poses); both `initPhysics3d()` continuations check
  `disposed`.
- WebGL context loss is watched (`watchContextLoss`): the match scene falls back to the 2D view
  with an event-log line, the builder preview tears itself down. Without it a lost context is a
  frozen field that still takes input.
- `renderScene.dispose()` frees robots through `BbRobots.dispose()` BEFORE the blanket walk, which
  was freeing `SHARED_GEO`/`SHARED_MAT` out from under the builder preview.
- The scene gallery is `React.lazy` (`GalleryRoute.tsx`) — a gated dev route was still a static
  import, 6 KB gz in `main` for every player of every game.
- The RENDER lane's `three` boundary check now catches subpath imports and scans all of `src/`.

## Fixed — docs and hygiene

- `CLAUDE.md`: BIOBUZZ is a full scored ranked game, not alpha-only; the repo map gains
  `src/tutorial`, `src/lib`, `src/lan`, `src/games/biobuzz`, `api/`, `electron/`; counts current.
  26,896 of the 27,000-byte docaudit budget — the next addition must cut something first.
- `README.md` rewritten: DSIM, three games, playdsim.com. It described a DECODE-only 2D sim.
- `src/seasons.ts` header said "DohunSim, only DECODE is playable". Fixed.
- `docs/area/netcode.md` governs `api/**` (the `api/download.ts` Vercel function had no owner and
  was invisible to `docaudit`). `docs/multiplayer.md` carries a HISTORICAL banner.
- `docs/area/biobuzz.md`: the alpha-only paragraph and the "kinematic tray, `BB3_HIVE_DYNAMIC =
  false`" sentence rewritten to the shipped config.
- `docs/deploy.md`: the deploy-order section above.

## The merge of main into alpha — how the five conflicts went

| file | resolution |
|---|---|
| `HANDOFF.md` | alpha's sections on top; main's 2026-09-17b and 2026-09-17 sections kept verbatim in their date order (the 17b one is the only record of the record-restart cause AND of the still-open "account in a live versus is admitted to a new solo record room" gap) |
| `src/games/biobuzz/hive.ts`, `state.ts` | **alpha** — the physics-agnostic `hiveTimerStep` the 3D pipeline depends on; `angle`/`angVel` are the dynamic-tray readback |
| `src/net/serverSession.ts` | **alpha** — it already carries main's `if (!spectator)` guard (cherry-pick `882fda6`) plus `caps` on the rejoin frame |
| `scripts/smoke-biobuzz/field.ts` | **alpha** — its 12 hive-feel checks plus main's draw-count tripwire at 6 |
| `src/games/biobuzz/play.ts` | NOT flagged by git, auto-merged to main's REVERTED text; restored to alpha's (`hiveDeflect` in the flight loop). A merge algorithm was making a gameplay decision |

`SIM_VERSION = 3` is what makes "take alpha" honest here: main's replays at 2 play as drift on
3, labelled.

## Owner decisions — nothing below was decided for you

1. **Deploy order** is the mitigation for the `bb3d` lockout; the zero-window alternative is an
   env flag in front of `serverPhysics`/`boardPhysics`/`stagedPhysics`. Not built. Say so if wanted.
2. **Every production BIOBUZZ record row is `'2d'` and vanishes from the boards** the moment the
   new server boots (`boardPhysics`). Filtered, not deleted. Your ruling of 2026-09-18 implies it;
   confirm you want it, or change the one predicate before deploying.
3. `jwtVerify` (`server/auth.ts`) is called with no `issuer` / `audience` / `algorithms`. Pinning
   them needs a live Neon Auth token to read the claims off; not done blind.
4. `ADMIN_SECRET` is accepted as a URL query parameter (pre-existing). Header-only would be a
   one-line change plus your own bookmarks.
5. `cm.pdf` (9.2 MB, the competition manual) is tracked with no licence; the FIRST courtesy note
   for the field CAD is unsent. Both are yours.
6. `LEGAL_UPDATED` (`src/legalText.ts`) drives `LEGAL_VERSION`. The privacy text changed (CCPA
   paragraph, Your-data panel); if that is a material change, move the date so everyone
   re-accepts. If not, leave it.
7. `flowerScoreZ` ships unused — 3D flower scoring runs on the 2D stacking model. Ruling needed.
8. `package.json` is `0.1.3`; this publish is the largest since it was set.
9. `migrate()` (`server/index.ts`) is not awaited before `listen`, and a migration failure is
   non-fatal while the new code hard-depends on 0037–0040's columns. Worth an `await` and a
   fatal exit — but that reverses a deliberate "a DB failure must not take the game server down".
10. Neon Auth `trustedOrigins` — confirm no wildcard on the production project (dashboard only).
11. **The FULL predictor's mouth is solid where the authority's is open.** A predicted element
    can bounce off a mouth the real one rolls into, and the reconcile snaps it. Fixing it costs
    2× the reconcile (numbers above). Options: accept as is; raise `PREDICT_FULL_BUDGET_MS` and
    accept Full on fewer machines; or make the compound cheaper (fewer boxes: arms only, no
    lintel, for the predictor). Not decided here.
12. Follow-ups, not blockers: a golden `worldHash` table so cross-build sim drift fails a test;
    `.gitattributes` (`* text=auto eol=lf`) for the CRLF checkout; dead `spike3d` / `scene-preview`
    scripts; no 404 route.

## Gotchas found on the way

- `rg` is not on the Bash PATH under the rtk hook; `git grep` is.
- Three BIOBUZZ perf checks (`PREDICT_FULL_BUDGET_MS`, `step3d p95`, room-tick ratio) are
  wall-clock and fail under CPU contention from parallel agents. They pass on an idle machine;
  do not "fix" them by widening the budget.
- The CLAUDE.md byte ratchet is at 99.6%.

---

# HANDOFF — 2026-09-19 (alpha: THREE ABANDONED LANES FINISHED, plus the owner's render pass)

Four commits on top of `8d3cde4`, every gate green:
`build` · `server:check` · `docaudit` · `uiaudit` · `contrast` (221) · `dbtest` · `test:mm` (197) ·
`bundleaudit` (re-measured) · `npm test` (**2375** BIOBUZZ + **1861** shared) · **`shiftaudit`**
(576 state changes, 0 shifts — the first run in three rounds, and its route list now covers
`/privacy`, `/terms` and `/contributors`).

Three lanes had been left UNCOMMITTED in the worktree `.claude/worktrees/alpha-main-divergence-7a6134`
(branch `claude/3d-field-visuals-855bd5`, sitting on `56e5836`, two commits behind alpha). They were
replayed onto alpha's tip with `git apply --3way` and finished here. **The originating worktree was not
touched** — it still holds the abandoned copy, so it is safe to delete once these land.

Two other dirty worktrees were left alone on the owner's instruction:
- `.claude/worktrees/alpha-ui` (detached at `dada8a0`, **396 commits behind**) holds a home-menu
  redesign — the eyebrow merged into one subtitle, the season moved onto the cards that pick it, the
  outbound links moved below the menu. It was applied here by mistake and then **fully reverted**. The
  owner does not want it.
- `.claude/worktrees/main-deploy` (branch `main`) holds staged-match / `copyText.ts` / contributors work
  with **two files still carrying unresolved index entries** (`src/ui/App.tsx`, `src/ui/Matchmaking.tsx`).

## The three lanes

**1. BIOBUZZ field visuals + one shot-path predictor.** `src/games/biobuzz/shotPath.ts` is the one
predictor; `drawShot.ts` (2D) and `scene/renderReticle.ts` (3D) are two drawings of it, and neither
works anything out for itself. It is NOT under `scene/`, because nothing outside `scene/` may import
from there. A path is drawn only for a shot that is MADE, dotted, no landing ring; "made" is
`hiveAccepts` against the REAL hive, not Aim Assist's pretend-up copy. `bbFlightEnters` gained an
optional `BbFlightTrace` out-parameter, which is what retired `scene/renderLanding.ts` — that file
carried a COPY of the integrator and its own header said the copy would drift.
⚠️ **A TURRET'S YAW AND ELEVATION ARE SEPARATE NODES** (`bb-turret-head` → `bb-turret-pitch`). Both on
one node is what "the shooter is not automatically aiming" looked like: a `THREE.Euler` defaults to
order `XYZ`, so elevation was applied about the UN-yawed axis, and at the 160° yaw / 80° elevation hive
range asks for, the barrel came out 67.7° BELOW horizontal and 44.5° off in azimuth while the SIM's
turret was dead on target.

**2. One board is one physics (owner ruling 2026-09-18).** Every server-connected match of a 3D-capable
game runs 3D; nobody picks. `Room.physics` is one line (`serverPhysics`); `RoomConfig.physics` still
rides the wire and is still sanitized but no current server reads it, and the lobby's 3D/2D picker is
gone. `boardPhysics` (`server/db/repo.ts`) is the single predicate, applied by the DATA LAYER and read
by `recordLeaderboard`, `personalBest`, `recordRank` and `getUserStats`; it sits INSIDE the per-player
`best` CTE, because filtering after it would find a player's 2D personal best, reject it, and leave them
off a board they have a legitimate 3D score on. Pre-ruling 2D rows are KEPT, not deleted; no season was
reset. An old client without the `'bb3d'` cap is REFUSED (`BB3D_REFUSAL`), not silently downgraded.

**3. The broadcast Results screen.** `src/ui/Results.tsx`, 1,064 lines, split out of `GameView.tsx`
(which loses ~700). ⚠️ **FIXED-DARK, like the field canvas**: `--ds-stage-bg` (new) and the
`--ds-on-field*` family are CANVAS-GROUND tokens, never re-valued in the dark block.

## What the lanes had left broken, and what fixed it

| where | what was wrong |
|---|---|
| `scene/renderFieldGlb.ts` | three type errors from a half-done refactor; `addPanelEdges` written and never wired |
| `scene/renderField.ts` | the clear-panel re-tune reached the CAD path only, so the fallback kept the rejected 0.22 / 0.3 / `DoubleSide` while its comments claimed parity |
| `sim3d/elements3d.ts` | a dumper fired on the first tick fire was held, at any heading — the 2D pipeline has gated this since stage 5b existed |
| `sim3d/contacts3d.ts` | G409's spill tag died while the element was still riding the tray it was leaving (seed 871: 8 tags at tick 13, all gone by tick 16 at z≈48) |
| `scripts/smoke.ts` | four `recycle/biobuzz` checks measured NOTHING — a BIOBUZZ room will not tick until `physics3dReady()`, and the shared suite never called `initPhysics3d()` |
| `scene/renderElements.ts` | every hive element drew one radius LOW. `syncElement` puts the body at `b.z + r`, so `b.z` is the BOTTOM for every ball the sim solves; the hive branch alone read it as a centre. Visible as a drop the tick `derive.ts` retags a landing shot from `flight` to `element` |

⚠️ **The settle check no longer pins a magic tick count.** It settles 3,600 ticks and asserts BIT
equality plus exactly-zero velocity, and a sibling check asserts the residual contact relaxation DECAYS
(each 600-tick window drifts at most half the last). The old 900-tick / 1e-3 form reported the machine.

## FIXED — a 3D dumper could not score into a hive cell

`drive: shoot (3d, blue|red, box tube)` in the TUTORIAL lane. Measured over 28 stationary firing poses
(dx 0/3/6/9 in, dy 14–38 in from the cell): a clean HEAD tree scores from **13**, this tree from **0**.

⚠️ **THE FIX IS IN TWO PARTS AND BOTH HAD TO BE 3D-ONLY** (the 2D pipeline is permanent): a
`flight` body is born CLEAR of the robot that threw it, walked out along its own parabola at
body-creation time in `sim3d/engineImpl.ts`; and a 3D dump is STAGGERED one element at a time
(`BbShot.perDump`, set only by `sim3d/elements3d.ts`), because `bbDumpSolution` converges every
element on one point — free in 2D, a four-way pile-up at the mouth in 3D. **0/28 → 20/28**, 2D
byte-identical at 28/28. A shared `launchClearance()` in `robot.ts` was tried first and reverted:
3/28, and it broke two 2D checks. A straight-ray nudge was also tried and measured at 3/28 — a
dumper's lob leaves at 80.6°, so raising the release without advancing the solved `vz` overshoots
the opening. The eight remaining misses are the two CLOSEST rows, where the lob clips the hive
underside; that is the CAD ruling's own documented consequence, and 2D scores there only because
a 2D flight element passes through the hive.

The cause was NOT the tutorial. `bbLaunch` throws the hopper from the release line at the bare FRAME face
(`mountOrigin` = `spec.length/2`). Until this lane the 3D chassis collider was `robotExtents(r)` — the
footprint, 3 in wider on a mouthed edge — so a dumped element was **born inside its own robot's
collider** and depenetration flung the four arcs apart; one happened to settle in the cell. The collider
is now `chassis3dShapes`, whose base box is the bare frame, so the release sits on the collider face and,
on a mouthed edge, inside the `BB3_MOUTH_SLOT_Z` lintel, where the four elements jam and rest on the
roof. **The old behaviour was an accident and the new collider is correct; do not restore the accident.**
Pushing the release out to `bbFootprint` was tried: 2/28. The deeper cause is that `bbLobThrow` /
`bbDumpSolution` throw a near-vertical lob at a cell whose mouth normal is HORIZONTAL, so the element
arrives dropping onto the lip rather than travelling into the opening.

## The owner's render pass (2026-09-19, from looking at the running game)

Landed or in flight, in order received:

1. the human player's nectar container should be the STANDARD HOLDING BOX, on the GROUND — not the
   bespoke shelf-on-legs at `RACK_SHELF_Z = 30`;
2. the shooter's side plates end in a sharp radial point — the front should terminate flat, and there
   should be BRACING between the two plates. ⚠️ **Follow-up: the bracing must sit CLOSE TO THE
   FLYWHEELS, and the plate does not need to be as big as it is;**
3. swerve is not rendered at all — one squat cylinder per corner at deck height, not a module.
   ⚠️ **Follow-up: NO MOTOR ON TOP of the swerve module;**
4. the intake wants a much faster draw-in and a real force model; its sides must not be solid aluminium
   plate; the roller stays but elements must pass UNDER it; and the roller is too low.
   ⚠️ **Measured: `BB_ROLLER_R` 1.0 at `BB_ROLLER_Z` 1.15 puts the roller's bottom 0.15 in off the
   floor, against a 2.8 in pollen and a 3.6 in nectar — while `BB3_MOUTH_SLOT_Z` (= `2 * BB_NECTAR_R`)
   says the collider leaves a 3.6 in clear slot under that same intake. The picture blocks a gap the
   physics says is open, by 3.45 in.**

### The intake design (measured 2026-09-19; NOT yet implemented)

⚠️ **GRIP AND PASS-UNDER CANNOT BOTH HOLD FOR A RIGID ROLLER.** Gripping a POLLEN needs the roller
bottom below its 2.8 in crown; letting a NECTAR through needs it at or above 3.6. One roller still
does both if the low part is the COMPLIANT part: a rigid HUB that clears the slot, and flaps that
reach into it and yield. Compliance IS "grip when driven, yield when not", which is both requirements
in one part. Put these in `config.ts` beside `BB_INTAKES` — they are hardware geometry, and the RENDER
lane already forbids `renderRobots.ts` owning intake constants:

    BB_ROLLER_HUB_R  = 0.75                                   // 1.5-in hub on a 0.5-in hex shaft
    BB_ROLLER_FLAP_R = 2.0                                    // a 4-in compliant wheel
    BB_ROLLER_Z      = BB3_MOUTH_SLOT_Z + BB_ROLLER_HUB_R + 0.15   // = 4.50; hub bottom 3.75
    BB_ROLLER_SPIN   = BB_INTAKE_DRAW_IN / BB_ROLLER_FLAP_R        // the picture ran at HALF the
                                                              // sim's speed: 26 rad/s x 1.0 in
                                                              // = 26 in/s against a 52 in/s draw-in

⚠️ **THE "UNREALISTIC INTAKE" IS A UNITS BUG, NOT AN ANIMATION ONE.** `robot.ts` calls
`approach(from, to, maxDelta)` with `BB_INTAKE_DRAW_IN` as `maxDelta`. `approach` caps the per-CALL
change and it is called once per tick, so the cap is 52 in/s PER TICK = 3120 in/s²: an element at
rest reaches full draw-in in ONE tick. It reads as a teleport in velocity space because it is one.
The fix is an acceleration — `BB_INTAKE_GRIP_ACCEL` (APPROX, ~1200 in/s²) times `dt` — shared by both
backends. The measurement that would settle the number: weigh a POLLEN and a NECTAR (`BB3_ELEMENT_MASS`
is already flagged APPROX, plan-3d §3.6, owner action).

⚠️ **TWO HARD CEILINGS ON `BB_INTAKE_DRAW_IN`, both of which must become smoke arithmetic.**
(1) `C.BALL_MAX_SPEED` is 90 and the 2D solve clamps every ground artifact to it; the 3D pipeline does
not, so a draw-in above 90 is clipped in 2D ONLY and the backends diverge. (2)
`BB_INTAKE_DRAW_IN * BB_INTAKE_CENTRE_FRAC < BB_INTAKE_CROSS_MAX`, or the intake's own funnelling trips
its own grip test and it drops every element it funnels — the failure `bbIntakeAct`'s header already
records ("0/1 captured, 66 in of plow"). And do NOT raise `CROSS_MAX` to buy margin: a robot-lane check
stages `vel.y = CROSS_MAX + 40`, which the 2D solve clamps to 90.

Proposed speed set (owner asked for "WAY faster"; the LANE_W change is the one with real balance
weight, because the default 17-in build goes from ONE feed lane to two): `PERIOD_MIN` 0.15 → 0.06,
`PERIOD_MAX` 0.3 → 0.12, `LANE_W` 9 → 8, `DRAW_IN` 52 → 84, `CENTRE_FRAC` 0.5 → 0.6, `THROAT_FRAC`
0.72 → 0.85, `SEAT` 1.1 → 1.4, `CROSS_MAX` unchanged.

**PASS-UNDER NEEDS NO SIM CHANGE.** `chassis3dShapes` puts nothing between the floor and 3.6 in
between the mouth's two arms, and the sim3d lane already asserts that pocket is open. The roller is not
a collider in either backend. It is the PICTURE that intersects, so flap deflection in the renderer is
what makes pass-under true — and it must run whether or not the roller is spinning.

**THE SIDES** are two `platePlane(armLen, 2.8, 0.3, 2)` solid plates per mouth — a 4.1 x 2.8 in wall in
front of the mechanism, 3D only (the 2D sprite already draws open rails). Replace each with a
three-member open truss (bottom rail, axle boss, diagonal), no member thicker than `INTAKE_RAIL_T` 0.5,
which is what the COLLIDER claims — the drawn arm must never claim more solid than the collider has.

**ONE MORE CONTRADICTION IN THE SAME AREA:** `BB3_INTAKE_Z` is 5 (an element-BOTTOM ceiling for
capture) while the proposed flap tip is 2.50, so an element at 4.9 would be eligible in the sim and
untouchable in the picture. `BB3_INTAKE_Z = BB_ROLLER_Z` closes it; it is a 0.5-in tightening that only
bites on 3D low-flight captures.

### The shooter bracing constraint (owner follow-up)
The ribs sit at radius ~4.9 against a flywheel radius of 2.0, so "way too far out" is right. But a rib
CANNOT move in to the flywheel: the annulus between `BB_FLYWHEEL_R` and `BB_HOOD_R` IS the element's
channel through the hood, and the brace angles all lie inside the wrap. What can be done is shrink the
plate (`rOut = BB_HOOD_R + 0.5` today) and keep the ribs flush on the hood face. Both are pinned by
checks in `scripts/smoke-biobuzz/render.ts`, so they move together.
5. elements teleported slightly downwards on landing in the hive — FIXED, see the table above.

## Gates

`build` · `server:check` · `docaudit` · `uiaudit` (baseline: `off-grid-gap` 155) · `contrast` (221) ·
`dbtest` · `test:mm` (197) · shared `npm test` — all green. `bundleaudit` needs its `scene` baseline
re-measured (192.28 → ~199 KB gz, inside the 250 KB spec ceiling). **`shiftaudit` was RUN** — the first
time in three rounds — 576 state changes, 0 shifts, and its route list now covers `/privacy`, `/terms`
and `/contributors`, which rounds 1–2 added without ever adding them here.

`.impeccable`'s design hook reports 38 findings in `src/ui/styles.css`; **every one is on a
pre-existing line** and none on anything this work added. Two that WERE this work's are fixed: the
Results screen's win-banner and total-punch keyframes already overshoot and settle, so an overshooting
timing function on top rubber-banded each segment — both are ease-out-quint now.

---

# HANDOFF — 2026-09-19 (alpha: ROADMAP ROUND 2 LANDED — privacy & cookie settings, the 3D robot creator; alpha server redeployed for the export route)

**(Previously READ FIRST.)** Branch **`alpha`** (worktree `.claude/worktrees/pr-alpha`), pushed; every gate green on the
merged tree (counts in the log). `dsim-alpha` was redeployed after the privacy merge (`GET /api/user/export`
is a server route). The section directly below is the 3D builder's own handoff from `biobuzz-3d`; the
ones after it are round 1 (auth, tutorial, contributors, plans) and the BIOBUZZ 3D days. All eight
roadmap items are now either landed or a plan awaiting the owner's decisions:

| # | item | state |
|---|---|---|
| 1 | 3D robot creator | landed (`feat/3d-builder` → `biobuzz-3d` → alpha): `Preview3D.tsx` on the `Preview` slot, `scene/renderPreview.ts` turntable built by the match's own `buildRobotGroup`, height + stow controls, saved-robot thumbnails; the chassis colour finally draws in 3D (fill = `chassisFill`, alliance = edge silhouette + sign panel), which also fixed the live match; three match render bugs fixed (mechanisms built inside the chassis, `specKey` missing `drivetrain`, group disposal) |
| 2 | replay download 2D/3D | landed with BIOBUZZ Day 3 |
| 3 | cosmetics | PLAN `docs/cosmetics-plan.md` — owner decisions pending |
| 4 | rewards | PLAN `docs/rewards-plan.md` — owner decisions pending |
| 5 | auth: reset, verification, terms | landed round 1; server gate off until `REQUIRE_VERIFIED_EMAIL=1` (`docs/deploy.md` §4) |
| 6 | tutorial | landed round 1 (BIOBUZZ + DECODE) |
| 7 | contributors | landed round 1; owner fills the `TODO` handles |
| 8 | privacy & cookies | landed round 2: `src/storageKeys.ts` registry (17 keys; the privacy page renders from it; a smoke check forbids unregistered keys — the old prose listed four keys that never existed), analytics opt-out incl. the pageview beacon (`src/analyticsPref.ts`, `beforeSend`), `GET /api/user/export` (authed, one per minute, own rows only, ids-only for replays, no email column; 404 after deletion; 24 dbtest checks), the Your-data panel on `/privacy` with the existing typed-`DELETE` account deletion surfaced, a footer consent link that explains itself when the CMP offers no revocation entry; legal text changes (CCPA/CPRA paragraph, Poly Haven added to the processors, storage prose by category) with `LEGAL_VERSION` deliberately NOT bumped — bumping re-prompts every account; the owner decides |

## Owner actions (consolidated)
- Legal: review the round-1/round-2 wording (terms acceptance, CCPA line, Poly Haven processor, storage
  categories); decide whether to bump `LEGAL_VERSION`.
- Neon Auth: sender domain, "require email verification", then `REQUIRE_VERIFIED_EMAIL=1`.
- Contributors' handles/avatars; the cosmetics and rewards decisions; test the 3D builder, the privacy
  panel (export needs a signed-in session) and the tutorial on `alpha.playdsim.com`.
- BIOBUZZ 3D rulings still open: lone-nectar flower scoring; weigh an element set; AI 59/100.

## Gotchas (new)
- An OLD server answers `/api/user/export` with a 200 from its `/api/user/<id>` profile route — guard
  on the payload, not the status. `analytics.ts` reads `import.meta.env` at module scope, so the
  pref lives in `analyticsPref.ts` (importable by `smoke.ts`).
- `index.ts` fills `scene` and `previewScene` from ONE dynamic specifier on purpose: two would hoist
  three.js into a shared chunk behind two facades that carry none of `bundleaudit`'s marker strings.
  `specKey` moved out of the scene chunk (`src/games/biobuzz/specKey.ts`) so the thumbnail cache can
  key on it without loading `three`. Thumbnails follow the device quality tier on purpose (pinning
  High fetched a 1.7 MB HDRI to draw three 96-px cards).
- Merging `biobuzz-3d` into `alpha` conflicts on `scripts/bundleaudit.mjs` (baselines) and
  `scripts/vercel-prune.mjs` (alpha's has the rate-limit fix): take alpha's, then re-measure.

---

# HANDOFF — 2026-09-18 (feat/3d-builder: roadmap item 1, A PROPER 3D ROBOT CREATOR MENU — landed, not merged)

**(Previously READ FIRST.)** Branch **`feat/3d-builder`**, off `biobuzz-3d` at `cf794b6`, five commits, **not
pushed and not merged**. Every gate green: `build` · `bundleaudit` · `npm test` (both suites) ·
`uiindex`+`uiaudit` · `docaudit` · `server:check`. The section below is the whole of it; the
Day 3 handoff it sits on top of follows underneath.

## What landed (`docs/roadmap.md` item 1)

- **`scene/renderPreview.ts`** — `createRobotPreviewScene(host, opts)` → `{ element, setSpec(spec,
  alliance), setQuality(tier|null), resize, capture(size), dispose }`. A turntable over ONE robot on
  a disc of field tile: slow auto-rotate (0.28 rad/s, off under `prefers-reduced-motion`), drag to
  swing and wheel to zoom at the match orbit camera's own rates and signs, the shared light rig, the
  same environment map at the device's own quality, transparent buffer so the card's themed surface
  is the background.
- **`scene/renderCore.ts`** — factored OUT of `renderScene.ts`: the renderer factory, the light-rig
  constants (`SCENE_EXPOSURE`, the hemisphere pair, the sun, the shadow bias pair), the
  once-per-document WebGL2 probe, `readBackdropColor`, `SceneUnsupportedError`, `disposeObject3D`.
  Both scenes build a renderer through it, so the same robot cannot come out two colours.
  `antialias: false` stays at `renderScene`'s own call site (a decision, not plumbing); the preview
  passes `true` — a 190px card recreated on every mount does not earn a render target and a blit.
- **`Preview3D.tsx`** (main chunk, no `three`, no `scene/` import) — the `Preview` slot. Without the
  host's `allow3d` it IS the 2D schematic, unchanged, which is what the four strategy cards get.
  The builder hero passes it and gets the turntable, a 2D/3D segmented toggle on the device's own
  `decodesim.view`, a `Stowed` toggle for a build over the cube, and a one-line fallback to the
  schematic when the scene cannot start (the 3D button doubles as the retry). It reaches the chunk
  through `moduleFor('biobuzz').previewScene()`.
- **Chassis colour in 3D** — fill = `chassisFill(spec.chassisColor)`, alliance = the silhouette
  `LineSegments` plus the sign panel. **This fixes the live match too**: the 3D chassis was
  alliance-filled and `chassisColor` was not rendered in 3D at all.
- **Height pair in the Frame section** — `heightIn` 12–29, and (only over the 18-in cube) the
  declared `stowHeightIn`, beside the R102 note that was already there.
- **Saved-robot thumbnails** — rendered once per build+alliance through the same scene, in place of
  the summary line on the 3D view, cached in memory and never persisted.

## The three bugs the preview exposed, all fixed in `renderRobots.ts`

Looking at a BIOBUZZ robot from close up for the first time found three things the match view had
been hiding at driver range. All three are fixed for the MATCH, not only the preview.

1. **The turret and the Box Tube were built INSIDE the chassis box** (z 1 and 0.6·height). Every
   robot in the 3D view was a featureless slab whatever launcher it carried. Both sit on the deck.
2. **`specKey` left out `drivetrain`**, so swapping mecanum for tank never rebuilt the wheels.
3. **A group thrown away on a rebuild was never disposed** — and a blanket traverse would have
   freed the module caches every other robot is still using. `SHARED_GEO`/`SHARED_MAT` register what
   is shared and `disposeRobotGroup` frees the rest; the match's own sync uses it too.

## Decisions worth knowing before touching this

- ⚠️ **BOTH module slots write `import('./scene/renderScene')`.** `previewScene` resolves the
  preview factory through a re-export rather than importing `./scene/renderPreview` by its own path.
  One dynamic specifier is ONE Rollup chunk; two would hoist three.js into a shared chunk behind two
  facades, and a facade carries none of the marker strings `bundleaudit` routes the `scene` budget
  by — both would land in `other` and fail that audit for a reason unrelated to size.
- **`bbSpecKey` (`src/games/biobuzz/specKey.ts`) is the one rebuild key.** It has readers on both
  sides of the lazy boundary: the generator, and the thumbnail cache in the main chunk, which cannot
  load the scene chunk to ask. Two copies is how a cached thumbnail shows the previous build.
- **The camera frames a bounding sphere MEASURED off the built group** (`Box3.setFromObject`), not
  one derived from `length × width × heightIn`: a turret stands above the deck and its barrel
  reaches past the frame rail, and the spec-derived fit cropped it off the top of the card. The
  distance is aspect-aware — a `PerspectiveCamera`'s `fov` is the VERTICAL one and the builder's
  220px column is taller than it is wide.
- **Thumbnails follow the DEVICE tier and are deliberately not pinned to High**, which is the
  opposite of what a replay export does. Two reasons pointing the same way: a thumbnail sits on the
  same screen as the live turntable, so one drawn at another tier is a second picture that does not
  match the first; and High selects the `school-hall` HDRI, so pinning it would fetch 1.7 MB to draw
  three 96px cards for somebody whose own setting asked for the procedural room.
- **The preview does NOT set the view preference to 2D when it fails.** `createBiobuzzScene` does,
  because there the fallback has to stick or the scene is retried on every remount. A menu card with
  a toggle directly above it is not that.
- **One WebGL context per thumbnail BATCH**, drained on a microtask and disposed immediately —
  not one per card (`Gallery.tsx` shares one scene across thirty cells for the same reason).

## Deviations from the roadmap's design, and what was not done

- The roadmap said "a `BiobuzzPreview3D` component fills the `Preview` slot" and left the loader
  unspecified; it is a new `GameModule.previewScene` slot so that ALL of a game's dynamic renderer
  imports stay in its `index.ts` (the property the RENDER lane asserts).
- The saved-robot card needed a second new slot, `GameModule.savedCard`: what belongs under the name
  is no longer always a sentence, and the choice between a thumbnail and a summary is the GAME's,
  not the shared menu's.
- `buildRobotGroup` now takes `(spec, id, alliance)` rather than a `RobotState` — a preview has no
  pose, no hopper and no world.
- **Not done: a Gallery still of the preview.** The Gallery's robot cells still draw the 2D
  schematic. The anti-drift claim is covered structurally instead (one generator, one rebuild key,
  both asserted in the RENDER lane), which is stronger than a picture.
- **Not done: `shiftaudit`.** It needs a build plus `vite preview` in a second shell; the new
  controls are `.ds-seg` (weight constant across states by design) and a fixed-size preview box, so
  there is nothing new that moves layout — but it has not been RUN on this tree.

## Numbers

- `npm test` — both suites green; the BIOBUZZ suite is 1800+ checks with the new RENDER-lane block
  (one generator, one rebuild key, the colour split, the import boundary, the height pair).
- `bundleaudit` — main 918.72 → **919.99 KB gz** (+1.27: the toggle, the thumbnail batcher, the two
  dials, the Menu wiring — inside §10's "+≤ 2 KB" because the component holds no renderer); scene
  192.28 → **194.67 KB gz** (+2.39: the turntable plus `renderCore`, which is a MOVE), 55 KB inside
  the §2.5 ceiling.
- Browser (dev server, this machine): the toggle, wheels by drivetrain, the two deck turrets, the
  sign panel, live follow on preset / height / colour changes, drag-to-orbit, the stow toggle, a
  saved thumbnail, back to 2D (zero canvases left mounted), both themes, 375px with no horizontal
  overflow, console clean of anything but the pre-existing AdSense 403s. A solo practice in View 3D
  shows the same rust chassis with the same blue outline as the card.

---

# HANDOFF — 2026-09-19 (alpha: ROADMAP ROUND 1 LANDED — auth flows, tutorial, contributors, cosmetics/rewards plans, Vercel policy; alpha server redeployed)

**(Previously READ FIRST.)** Branch **`alpha`** (worktree `.claude/worktrees/pr-alpha`), pushed, every gate green on
the merged tree: `build` · `bundleaudit` · `server:check` · `docaudit` · `uiaudit` · `contrast` ·
`test:mm` · `dbtest` · `npm test` (counts in the log). The ALPHA game server (`dsim-alpha`) was redeployed
from this tree (`./scripts/fly-deploy.sh --alpha`) because auth adds migration `0040` and server routes.
The four sections below this one are each branch's own handoff, written by the agent that built it;
their "NOT merged / NOT pushed" lines are stale — all four ARE merged here. Production is untouched.

## What landed on alpha (each on its own branch, merged in this order)
- `feat/plans-cosmetics-rewards` → `docs/cosmetics-plan.md`, `docs/rewards-plan.md` (roadmap items 3–4;
  the owner approves before code). Two code facts they surfaced: the 3D chassis ignores `chassisColor`
  (paints alliance fill), and `coerceSpec` checks only that a colour KEY is legal, never that the account
  is entitled — enforcement is UI-only today.
- `feat/contributors` → real sections (core team, contributors from `CONTRIBUTORS.md` incl. a missing
  signer, presented-by via `sponsorLink`, third-party credits with versions baked from `package.json`
  at build time, get involved). Owner still fills the `TODO(fill in)` handles/avatars.
- `feat/tutorial` → `src/tutorial/` engine (DOM-free runner, `GameModule.tutorial` slot), BIOBUZZ six
  steps + DECODE four, the step card in the HUD band, a first-run offer on Modes and a Controls entry,
  per-device flag `decodesim.tutorial.v1`; TUTORIAL lane 318 checks (non-vacuous AND completable, both
  physics, both alliances). Runs as FREE DRIVE so nothing is recorded (a staged world is not
  reconstructible from `{seed, setups}`); `startMatch` refuses while a tutorial is live.
- `feat/auth-flows` → `src/lib/authFlows.ts` (one wrapper over the Neon/Better-Auth SDK, pinned exactly
  at 0.4.2-beta): forgot password (`/account/reset`), email verification (banner, resend,
  `/account/verify`), terms acceptance (`LEGAL_VERSION`, migration `0040_terms_acceptance.sql`,
  `POST /api/user/accept-terms`, a blocking `TermsGate` on version mismatch incl. OAuth first sessions).
  ⚠️ The email-verification SERVER GATE (ranked queue, record-room join, `/api/practice`) is OFF until
  `REQUIRE_VERIFIED_EMAIL=1` — every existing password account is unverified and no sender domain is
  configured; the owner's Neon dashboard steps are in `docs/deploy.md` §4. Also fixed in passing:
  `uiaudit`'s component-index staleness check compared CRLF against LF (failed on every fresh Windows
  checkout).
- Vercel: `vercel.json` builds ONLY `main` and `alpha` (`ignoreCommand`) and disables auto-deploy for the
  feature branches; `scripts/vercel-prune.mjs` (owner-run, token via env, dry run by default, waits out
  the 200-deletions-per-10-minutes limit) took the project from 501 to 113 deployments on 2026-09-18.
  Feature-branch pushes had been queueing previews ahead of the alpha build.

## Owner actions
- Neon Auth: sender domain + "require email verification", then `REQUIRE_VERIFIED_EMAIL=1` on the alpha
  app (`docs/deploy.md` §4). Review the terms/privacy copy touched by the acceptance flow.
- Fill the contributors' handles; decide the cosmetics and rewards plans' numbered decisions.
- Test on alpha: sign-up with the terms box, forgot-password screen, the tutorial from Modes, Contributors.

## Next (roadmap)
`feat/privacy-cookies` (item 8; shares `LEGAL_VERSION`), the 3D robot creator (item 1, on
`biobuzz-3d`), replay 2D/3D export is DONE (Day 3), cosmetics/rewards builds after approval. BIOBUZZ 3D
follow-ups are in the Day 3 section: nectar-in-flower scoring ruling, weigh an element set, AI 59/100.

## Gotchas (new)
- The Neon adapter THROWS on any non-2xx (`AuthApiError` with lower_snake codes); the `{data,error}`
  union's `error` is essentially never populated — classify the throw.
- Read the emailed `?token=` at module load (`src/ui/entryToken.ts`): App canonicalises the address bar
  before any screen renders. Spend a verification token once (a ref, not state — StrictMode).
- A tutorial predicate that is already true on the staged world is invisible; the lane's non-vacuity
  check is the only guard. A hand-written `held` ball state without `lx/ly/side` is a NaN into Rapier —
  stage through `capturePollen`. `TutorialRunner.abandon()` is not `finish()` (the recorder check counts
  `.finish()` calls in `game.ts`).
- Vite's dev server refuses to serve files whose real path is outside the worktree (junctioned
  `node_modules` → font 403s in dev only); builds are fine.

---

# HANDOFF — 2026-09-18 (`feat/auth-flows`: password reset, email verification, terms acceptance — roadmap item 5, BUILT, NOT PUSHED)

**(Previously READ FIRST.)** Branch **`feat/auth-flows`**, off `alpha` at `76034a9`. Seven commits, not pushed
and not merged. Gates green on the branch: `build` · `server:check` · `npm test` (1840 shared +
1780 BIOBUZZ) · `dbtest` (ALL PASS, +12 for migration 0040) · `uiindex` then `uiaudit` (all rules
at baseline) · `docaudit` · `contrast` (223, unchanged — no new colour, the banner's tint is
`color-mix` over `--ds-warn`) · `bundleaudit` (main +0.9 KB gz, hostWorker unchanged).

⚠️ **NOTHING IS LIVE UNTIL THE OWNER DOES THE NEON DASHBOARD WORK.** `docs/deploy.md` §4 is the
checklist. The terms half works the moment the game server is deployed (migration 0040 applies at
boot); the two email flows send nothing until a sender domain is configured, and that failure is
SILENT — the forms answer 200 and no mail leaves. Send yourself one before believing it works.

## What is on the branch

- **`src/lib/authFlows.ts`** — the ONE module that calls the SDK. Four functions, each returning a
  discriminated `AuthFlowResult` and never throwing at a component:
  `requestPasswordReset(email)`, `completePasswordReset(token, pw)`,
  `requestEmailVerification(email)`, `completeEmailVerification(token)`. `@neondatabase/auth` is
  pinned to the exact installed `0.4.2-beta` (no `^`).
- **Forgot password** — a `.ds-linkbtn` under the sign-in password field opens a third form in the
  same modal; `/account/reset` handles the emailed link (and offers the request form when it
  arrives without a token).
- **Email verification** — sign-up asks for the email; a per-session banner on Profile with Resend;
  `/account/verify` spends the token on mount, exactly once, and clears the cached JWT.
- **Terms** — `LEGAL_VERSION` derived from `LEGAL_UPDATED`, migration `0040_terms_acceptance.sql`,
  `POST /api/user/accept-terms`, a required checkbox on sign-up and a blocking `TermsGate` that
  WRAPS `UsernameGate`.
- **`REQUIRE_VERIFIED_EMAIL`** gates ranked queueing, joining a record room, and `POST /api/practice`.

## The five things worth knowing before touching any of it

1. ⚠️ **THE SDK THROWS ITS FAILURES.** The Neon adapter installs its own `customFetchImpl` which
   throws a normalized `AuthApiError` on any non-2xx, so the `{data, error}` union the `.d.mts`
   advertises is real but `error` is essentially never populated. The first cut classified every
   throw as `network` and told somebody with an expired reset link to check their connection. The
   throw carries `status` and a lower_snake `code` (`bad_jwt`, `weak_password`,
   `over_email_send_rate_limit` — the adapter's own vocabulary, NOT Better Auth's SCREAMING_SNAKE),
   and `classifySdkError` now speaks both. Rate limiting is tested before the address, because
   EMAIL is a substring of that last code.
2. ⚠️ **`forgetPassword` IS NOT A TOP-LEVEL METHOD** on this build — only `forgetPassword.emailOtp`
   is, and that is a different flow. The top-level request is `requestPasswordReset`. The roadmap
   named the old one; the wrapper's header cites all four real `.d.mts` signatures with line
   numbers.
3. ⚠️ **THE EMAILED TOKEN IS READ AT MODULE LOAD** (`src/ui/entryToken.ts`). `App`'s mount effect
   canonicalizes the address bar with `history.replaceState(pathFor(...))`, and `pathFor` builds a
   path with NO query string on it — so `?token=` is gone before any screen component renders.
4. ⚠️ **THE RECORD-RUN GATE IS AT THE JOIN DOOR IN `server/index.ts`**, not in `Room.startMatch`
   beside the duo-record "both drivers must be signed in" guard it otherwise belongs with.
   `server/room.ts` is bundled into the LAN host worker (`src/lan/hostWorker`) and must not import
   `jose` or read `process.env` — that is why it goes through `./runtimeEnv` for everything.
5. ⚠️ **`REQUIRE_VERIFIED_EMAIL` IS OFF BY DEFAULT AND MUST STAY OFF UNTIL MAIL WORKS.** Every
   email/password account on the live site is unverified today, and the Resend button cannot help
   until the sender domain exists. Deploy → mail works → let people verify → set the secret.
   `emailGateRefusal` is the single predicate; extend it rather than adding a second check.
   `null` (nobody told us) counts as VERIFIED, deliberately — a gate whose unknown case refuses
   would take ranked down silently the first time an upstream stopped sending a field.

## Open, for the owner

- **The dashboard steps are `docs/deploy.md` §4**: sender domain + DNS, the redirect allow-list
  (every origin: prod, alpha, beta, `localhost:5173`), the provider's "require email verification"
  switch, then the Fly secret LAST.
- **Confirm the JWT carries `email_verified` before trusting the gate.** The server reads that
  claim (or `emailVerified`) off the verified token and falls back to ONE cached
  `GET /get-session` per token; if neither answers, the state is `null` and the gate PASSES. Sign
  in as a test account and read `/token`'s payload once.
- **The legal wording is the owner's to review.** One line was added to the Terms' `## Changes`
  section, because continued use after a change now genuinely does require re-acceptance and the
  document did not say so.
- **The three email flows are NOT end-to-end tested** — no mail can be sent from here. What was
  driven in a browser against a stub auth endpoint: the link and the checkbox, the refusal copy,
  the neutral confirmation, `/account/reset?token=fake` and `/account/verify?token=fake` on their
  error paths, the banner and both variants of the terms dialog (forced locally, reverted), light
  and dark, 375px.

## Next

Roadmap item 8 (`feat/privacy-cookies`) shares `LEGAL_VERSION` and should pick it up from here
rather than re-deriving it. If the terms text moves, `LEGAL_UPDATED` is the only line to change —
and moving it prompts every signed-in account once, so it is a deploy of BOTH halves (Vercel for
the dialog, Fly for the route that records the server's own constant).

---

# HANDOFF — 2026-09-18 (feat/tutorial: ROADMAP ITEM 6 LANDED — the game tutorial, engine + BIOBUZZ + DECODE)

**(Previously READ FIRST.)** Branch **`feat/tutorial`**, off `origin/alpha` at 76034a9. NOT pushed, NOT merged.
Every gate green: `build` · `npm test` (1806 shared across 12 shards + 2098 in the BIOBUZZ suite,
which now includes the new `TUTORIAL` lane) · `uiindex` then `uiaudit` (all rules at or under
baseline) · `docaudit` (CLAUDE.md 26,855 / 27,000 bytes) · `server:check`. `shiftaudit` was NOT run
(it needs Electron + a `vite preview` in another shell) — the card's pressables move by
`transform` / `box-shadow` only, which is the rule it enforces.

## What a tutorial IS here

A scripted SOLO PRACTICE. `src/tutorial/` is the shared, DOM-free engine; the CONTENT is per game
on the new `GameModule.tutorial` slot (`src/games/biobuzz/tutorial.ts`, `src/games/decode/tutorial.ts`).
`docs/area/ui.md` carries the rules — read that section before touching any of it. The one that
shapes everything:

⚠️ **A STEP'S SITUATION IS STAGED AT WORLD CONSTRUCTION, NEVER INTO A RUNNING WORLD.** Solo practice
is recorded and a replay rebuilds from `{seed, setups, commands}` alone (`docs/area/netcode.md`), so
`TutorialStep.stage(world)` runs at tick 0 on a freshly built world and moving to the next step
REBUILDS it (`GameController.rebuildForTutorial`, which is `restart()` minus the abort cue and the
harvest). The tutorial runs as FREE DRIVE, which is drivable from tick 0, bills no BIOBUZZ fouls,
and is **never recorded** — the honest answer to "could a replay reproduce a staged world": it
could not, so none is kept.

## Files

- `src/tutorial/{types,runner,hints,flag,index}.ts` — the engine. `TutorialRunner` is a state
  machine the caller drives: `stage` → `tick` per sim tick → `advance` (the caller rebuilds).
  `hints.ts` composes every hint from the player's LIVE `ControlBindings`, naming a pad button when
  a pad is connected and an on-screen button on a coarse pointer. `flag.ts` is
  `decodesim.tutorial.v1`, per device, fail-open both ways (the `chainDisclaimer.ts` pattern).
- `src/ui/TutorialCard.tsx` + `src/ui/tutorial.css` (imported from `main.tsx`, its own file for the
  reason `predict.css` is) — the step card. A `data-hud-band` element at bottom centre, so the 3D
  camera reframes the field above it and it gets the 3D view's dark scrim.
- `src/game.ts` — `tutorial` constructor option, `getTutorial()` on the HUD snapshot, `tutorialSkip`
  / `tutorialReplay` / `tutorialExit`, the per-tick predicate inside `stepSolo`, and the `startMatch`
  guard.
- Surfaces: the first-run card on `/modes` (hidden once the flag is set), a permanent
  "Run the tutorial" block at the top of Controls, and `GameView`'s `tutorial` prop.
- `scripts/smoke-biobuzz/tutorial.ts` — the `TUTORIAL` lane, 318 checks, 1.4 s.

## The content

**BIOBUZZ, six steps** (five for a build without the hardware for the NECTAR one): drive to your
garden · pick up a pollen · shoot into your hive · tip the hive (the cell is staged with the three
NECTAR the field gives it plus two POLLEN, so the measured table's third POLLEN is the shot the
player takes) · place a nectar in a flower **or** take a pollen from a flower · park in your loading
zone. **DECODE, four steps**: drive into your launch zone · pick up an artifact · score in your goal
· return to your base.

⚠️ **THE TWO FLOWER STEPS ARE A PARTITION, and the lane asserts it.** `TutorialStep.applies(spec)`
is resolved once when the runner is built. Placing a NECTAR needs a Box Tube **and** a launcher that
carries NECTAR (`bbCarriesNectar` — a single turret feeds POLLEN only, so **no shipped preset can do
it**); every other build is asked to retrieve a POLLEN instead. Every build is offered exactly one.

## Gotchas this shipped against

- ⚠️ **A PREDICATE THAT IS TRUE ON THE STAGED WORLD TEACHES NOTHING, AND IT IS INVISIBLE** — the card
  flashes past. The SHOOT step shipped as `contents.length > 0`; the field stages three NECTAR in
  every up CELL, so it was true at tick 0 for both alliances. It is `cellPollen(...) > 0` now, and
  the lane asserts non-vacuity for every step of both games under both physics and both alliances.
- ⚠️ **A hand-written `held` ball state is a NaN that reaches Rapier.** `{ kind:'held', robot, slot }`
  omits `lx/ly/side`, `positionHeldBalls` puts `undefined` through `rot()`, and the collider
  translation throws out of the solve. Staging goes through `capturePollen`, which is also what
  enforces the hopper cap, G408 and the NECTAR-capacity rule.
- ⚠️ **A staged pose derived from the CHASSIS is wrong for half the builds.** Both FLOWER steps act
  through a mechanism whose edge is a builder choice, so the pose is derived from
  `bbPlacePointLocal` / `bbMouths` and the robot is turned until that offset points along the wall.
  A front-assumed pose put a relocated Box Tube 10 in off the ring, pointing at open floor.
- ⚠️ **`TutorialRunner.abandon()` is not called `finish()`** — `npm test` counts `.finish()` calls in
  `src/game.ts` and requires exactly one, because the replay RECORDER may only be closed inside
  `harvestPracticeRun`. A second `.finish()` in that file reads as a second save policy to the grep,
  and the grep is the check.
- **Hive frame bars are at x = ±24…25, y = ±19.4.** Three staged poses had to move off them; a pose
  overlapping a static does not throw, it explodes the solve and reads as a position in the hundreds.
- **DECODE's penalty engine runs in `freeplay`** (BIOBUZZ's does not), so a DECODE step staged near
  the gate can bill the player in the one mode where nothing is meant to count against them. The lane
  asserts every scripted DECODE run ends with zero fouls.

## Next steps

- Push and merge to `alpha` (not done — the branch is local).
- Chain Reaction has no tutorial and registers none; the slot is there when somebody wants one.
- `shiftaudit` on the card, from an Electron shell with `npx vite preview --port 4173` running.
- Worth considering: an in-match entry point (the tutorial is currently only reachable before a run),
  and a step that teaches the human-player NECTAR entry, which free drive cannot host (`bbHumanPlayerTick`
  is gated to TELEOP).

---

# HANDOFF — 2026-09-18/19 (biobuzz-3d: DAY 3 LANDED — bots, graphics settings, HDRI, 3D export, prediction modes, cutover; merged to ALPHA and the alpha server deployed)

**READ FIRST.** Branch **`biobuzz-3d`** was merged into **`alpha`** at the merge commit named in the
log and the ALPHA game server (`dsim-alpha`, `fly.alpha.toml`, one machine) was deployed from the
alpha worktree with `./scripts/fly-deploy.sh --alpha` for proper testing (owner instruction). Every
gate green on the merged tree: `build` · `bundleaudit` · `server:check` · `docaudit` · `uiaudit` ·
`test:mm` (197) · `dbtest` (266) · `npm test` (1798 shared + the BIOBUZZ suite, count in the log).
Production (`main`, `dohun-sim-decode`) is untouched; promotion is the owner's call (spec §12 q7).

## Day 3 (spec §10) — landed, three OPUS lanes
- **Lane A, bots** (`src/games/biobuzz/ai/`): `GameSimModule.bot = { tiers, defaultTier, coerceTier,
  create(world, robotId, tier, seed) → { step(world): RobotCommand; dispose?() } }` — the caller owns
  the memory, steps a seat once per tick BEFORE the sim step, records the (already quantized) command
  like a driver's; nothing is written to `World`; reads positions and the derived lists only (a Proxy
  check forbids `rngState`; source greps forbid DOM, clocks, `process.`, `import.meta`, `sim3d/` except
  `tilt`). Tiers easy/medium/hard differ in execution only (hesitation, speed cap, aim tolerance, verdict
  strictness, placing, defending, patience, park time). AI lane 47 checks in `npm test` (determinism
  over 3,600 ticks under both physics with equal hashes AND command logs). `npm run test:ai` (150
  matches, ~8 min, outside `npm test`): hard vs idle 102 pts mean (1.93× easy); **hard beats easy 59/100
  head-to-head, NOT the plan's 90** — a BIOBUZZ 1v1 is decided in 20-point tip lumps from one shared
  element pool; the check is a ratchet at the measured rate (`BB_AI_WIN_RATE_FLOOR` 0.55) with the target
  named; levers: fouls (~6 pts/match), element denial, the 99-in drive after a hive flip. Perf with four
  bots: `step3d` 2v2 median 0.345 ms, p95 0.498 — no tuning needed; bots cost 0.004 ms. R102: `bbStowHeightIn`
  (declared `stowHeightIn` or `min(heightIn, 18)`), refused at `startLegal`, deploy = a read of
  `world.match`, the collider rebuilt at the edge with `z` continuous.
- **Lane B, graphics** (`graphics/{settings,auto,environments,viewKey}.ts`, `scene/renderEnvironment.ts`,
  `renderStats.ts`, Configure's Graphics section): presets Auto/Low/Medium/High/Ultra/Custom over the
  sixteen settings, per device (`decodesim.graphics`), 14 live, mesh detail needs a rebuild, SMAA and
  SSAO NOT offered (chunk cost; the UI says why). AA is a scene-owned MSAA target (the renderer is created
  `antialias:false`). Auto: GPU string + cores/memory/DPR → first guess, 2 s warm-up p95 (down > 16.7,
  up < 6), slip ≥ 25 ms sustained 3 s lowers once with one event line; `STALL_MS` 500 discards samples
  after a throttled gap (an alt-tabbed player must not come back to Low). This machine: Ultra. Two CC0
  Poly Haven HDRIs (School Hall; Monochrome Studio 02), 1k `.hdr` on demand via `HDRLoader` + PMREM,
  never bundled; `src/contributors.ts` DERIVES the credits from `BB_ENVIRONMENTS` (a check pins the
  count). Replay export View 2D/3D + camera (roadmap item 2): scene → its own overlay sheet → export
  canvas → burn-in; 3D costs 1.96× the 2D export at 1920; insets = the bottom band. Gallery draws 2D | 3D
  per cell with ONE shared scene (Chrome caps contexts). Phone: overhead default, a 2D/3D button; the
  view key `t` is armed by `InputManager.attach/detach` (`installViewKey`). Scene chunk 192 KB gz; a
  `graphics` route (5.6 KB) in bundleaudit.
- **Lane C, integration**: prediction Off/Light/Full/Auto (`src/net/predictionPref.ts`, Controls
  section + in-match panel): in a 3D online room the client no longer steps the world — the local robot
  advances through the predictor and the reconcile replays through it; measured Light 0.9 in / Full 0.16 in
  headless, Full reconcile p95 0.3–0.4 ms live; Auto picked LIGHT on the dev build (a 45.8 ms cold probe
  vs 0.3 ms steady — re-measure on a production build before tuning `PREDICT_FULL_BUDGET_MS`). Bot seats:
  solo practice (`GameSettings.practiceBots`, "Opponents"), custom lobbies (host `addBot`/`removeBot`,
  roster rows with `bot: tier`, refused in staged/ranked/record rooms, `unrated` latched), LAN via the
  same `Room`; `SERVER_CAPS` `bb3d` + `bots`; the online "Loading 3D physics" panel via
  `onPhysicsPending`; leaderboard era chip + All/3D/2D filter (`/api/records?physics=`), practice runs
  carry `physics`/`view` with the comparability note; the client refuses BIOBUZZ ranked on a server
  without `bb3d`. Migration renumbered **`0039_physics.sql`** (alpha took 0038 for replay privacy;
  idempotent, disjoint). Two Day 2 rejoin bugs fixed (caps and `physics` on `rejoin`). costprobe 2v2 with
  bots: 0.047 cores/room, 7,556 B/snapshot.
- Coordinator: `game.ts` routes `SceneOptions.onQualityEvent` into `world.events`; `RobotSpec.stowHeightIn`
  + its `coerceSpec` carry-across; the main-chunk bundleaudit baseline re-measured (the `ai/` policy is
  in the main chunk by design — a tier is offered before any physics loads).

## Owner actions and rulings pending
- Test on alpha: online 3D rooms (custom lobby, physics 3D, both views), bots in a lobby and in practice,
  prediction modes, the Graphics section, a 3D replay export (one human MP4 export closes the only
  unexercised path), ranked BIOBUZZ (3D) on the alpha server.
- Rulings: the lone-nectar flower score (CAD 3.597 vs floor 3.904); the CAD lower bore 3.222 vs the
  manual's 2.79; weigh a real element set; the AI head-to-head target (59/100 measured vs 90).
- Production promotion when satisfied (`main` from a main worktree; `./scripts/fly-deploy.sh`).

## Next (roadmap) — `docs/roadmap.md`
Own branches off `alpha`: `feat/auth-flows` (password reset, email verification, terms acceptance —
the SDK already exposes the calls), `feat/privacy-cookies`, `feat/contributors`, `feat/tutorial`; on
`biobuzz-3d`: the 3D robot creator (item 1); plans for cosmetics and rewards (items 3–4) for approval.
BIOBUZZ 3D days 4–14: play-testing, tuning, weighing a set, `MAX_SAVED_ROBOTS` 3 → 4, promotion.

## Gotchas (new)
- `setViewport`/`setScissor` take CSS pixels (they multiply by the pixel ratio); `shadow.map` must be
  disposed and nulled for a live map-size change; `renderer.info.render` resets at the START of `render()`.
- A `process.env` read in `ai/` is green in Node and fatal in a browser (the first bot decision unmounts
  the game screen) — the AI lane now greps for it.
- `coerceSettings` must not fold `practiceBots` to `'off'` for a game with no driver (a DECODE visit
  erased a BIOBUZZ tier); coerce at the point of use.
- `Renderer.render(overlayOnly)` clears the whole canvas — right for the live view, fatal for a
  composite export (every frame black); the export draws the overlay on its own sheet.
- A perf watch pinned at 0.75 ms failed at 0.778 the moment the suite ran beside anything else —
  thresholds that close to the measurement report the machine's load, not the code (gate at 1.5 ms).
- `git merge-tree --write-tree` previews conflicts read-only; alpha and a feature branch both prepending
  HANDOFF always conflict there — keep the feature sections on top; regenerate `docs/ui-components.md`.

---

# HANDOFF — 2026-09-18, night (biobuzz-3d: CAD-authoritative dimensions + DAY 2 LANDED — 3D rooms online, dynamic hive, flower tubes, prediction, cameras)

**(Previously READ FIRST.)** Branch **`biobuzz-3d`**, worktree `.claude/worktrees/biobuzz-3d`, clean at the merge
commit named in the log; every gate green there: `build` · `bundleaudit` · `server:check` ·
`docaudit` · `uiaudit` · `test:mm` (197) · `dbtest` (263) · `npm test` (1798 shared + 1615 BIOBUZZ;
lanes CORE/SIM3D/HIVE3D/FLOWER3D/PREDICT/NET3D/RENDER + the 2D lanes).

⚠️ **THE OWNER MUST DEPLOY THE ALPHA APP before anyone joins a 3D room online**: this day adds a
migration (`0038_physics.sql`), a protocol field (`RoomConfig.physics`, `matchStart.physics`, the
`'bb3d'` cap) and a replay header field — three server changes. `./scripts/fly-deploy.sh` (the
owner's wrapper; NEVER a bare `flyctl deploy`), then verify `/health` and `fly machine list`.
Production later from a `main` worktree. Backward compatibility held: `physics` is omitted (never
written as `'2d'`) on the wire and in containers; old clients still join 2D rooms; pre-0038 rows
read `'2d'`; no version bumped.

## Owner rulings this day
- **"The CAD is authoritative for dimensions."** `BB_*` geometry is GENERATED: `npm run field-cad` →
  `scripts/field-cad/emit-dims.mjs` → `src/games/biobuzz/fieldDims.gen.ts` (STEP version + sha, the
  derivation and residual of every value); `config.ts` imports it under the old names. The field is
  141.35 in inside the walls (`BB_HALF_X` 70.674), tiles 23.528 in on centre (`BB_TILE_PITCH`,
  `BB_TILE_SEAMS`), flowers at their bore-fit centres, hive `BB_HIVE_BOTTOM_Z` 31.981, opening
  [53.375, 65.497], tape as 16 CAD strips (`BB_TAPE`). 2D collider = 3D collider = GLB wall to
  0.0000 in (asserted). The manual's figures are history where they differ
  (`docs/biobuzz-reference.md` carries the dated note). `C.TILE`/`src/config.ts` untouched.
  Pre-2026-09-18 BIOBUZZ replays diverge on re-sim (alpha-only, unranked; no version bump).
- Better agents: rounds after the first play-test ran on OPUS with an analysis phase first.

## Day 2 (spec §10) — landed
- **Lane C, online** (`6ac687c`…`4ae3663`): `await initPhysics3d()` at server boot and lazily in
  the LAN host worker (`vite.config.ts` `worker.format = 'es'` was REQUIRED — an IIFE worker cannot
  code-split, and `initPhysics3d` had been tree-shaken out of the worker); `createWorld` gains a
  FIFTH optional `physics` parameter (a room is not a practice); `Room.physics` decided once
  (ranked/record/staged → `'3d'`, host option in the lobby, absent → `'2d'`); `'bb3d'` cap refused
  at `join`/`spectate`/`rejoin`/BIOBUZZ `queue` with "Update DSIM to play this room."; matchmaking
  stages BIOBUZZ `'3d'`; migration 0038 (`physics` on records/matches/replays/practice_runs, `view`
  on practice_runs, `butterfly` in the drivetrain check); recorder/player stamp and honour `physics`
  (`ReplayView` awaits the wasm); `displayWorld` interpolates elements and remote `z` in 3D worlds
  only; `costprobe` `biobuzz3d-*`: 2v2 0.026 cores/room, 7,231 B/snapshot (72 % of budget; 3D is
  cheaper than 2D). Verified locally: two clients, one 2D-view one 3D-view, same room, identical
  scores/positions at the same tick, the replay re-simulated to the server's score exactly.
- **Lane A, sim** (`366e3ce`…`506a890`): **dynamic see-saw ON** (`BB3_HIVE_DYNAMIC = true`): CAD
  tray hulls on a revolute joint (limits via `.setLimits` on the instance), mass 13 lb APPROX with
  the CoM 5.53 in above the pivot (that is the bi-stability), the detent is a HOLD at the stop
  released when the contents' torque beats `restoring + BB3_HIVE_DETENT` (Rapier has no joint
  friction; a capped motor keeps pulling), `npm run hive-calibrate` swept it: detent 3041, ballast
  6 lb at w −9.5, damping 4.466 → 4.00 s swing; all four §12.3 target rows hold with ±0.31
  element-weights of margin (the whole window is 0.60 wide at nectar ratio 1.6 — weighing a real
  set is what widens it); validation 4/7 (no linear weighting fits the owner-measured rows, as the
  reference already says). `hives[a].angle`/`angVel` ride the JSON; `hiveTiltAngle` reads them.
  **Flower tubes** from the CAD plates (lower bore 3.222 at z −0.2…0.35, mid 3.896 at 3.90…5.25,
  top 4.171 at 20.25…21.40; retrieval opening derives to 3.550 = Fig 9-12); elements fall to the
  tiles inside the bottom bore (nothing seats on a ring); G418's intent holds (only pollen exits
  the bottom). G409 (`bb.spill`) and G417 (`bb.hiveRam`, 3D only; the 2D "no robot can move the
  hive" ruling stands) bill from real contacts. **Predictors** in `sim3d/predict.ts`:
  `createLightPredictor(world, localId)` / `createFullPredictor(world, localId)` with
  `reset/step/dispose`, `probeFullReconcileMs(world, id, now)`; convergence 0.57/0.22 in open
  floor, 2.12/0.19 in on a push; Light < 1 ms, Full 2 ms (budget 8). `step3d` 2v2 median 0.255 ms.
- **Lane B, render** (`a0557e1`…`5ec9d40`): reticle at the sim's own landing (`renderLanding.ts`
  duplicates `bbFlightEnters`'s integrator on purpose — matching the sim beats being "accurate");
  fixed dark HUD scrim in 3D (`.game-root.view-3d`, tracks a LIVE scene via a MutationObserver);
  chase and orbit cameras (drag/wheel on the host; pref `decodesim.camera`, keys `c`/`i`/`o`/`t`
  handled inside the scene while mounted); `GameScene.project` + `Renderer.setScene` so labels and
  auto paths project through the scene camera (wired in `game.ts` by the coordinator, `8f7300b`);
  theme change followed live. Scene chunk 187 KB gz.
- Roadmap: `docs/roadmap.md` now leads with the owner's eight priorities (auth, privacy, contributors,
  tutorial, replay 2D/3D export, 3D builder, cosmetics plan, rewards plan) with branches and order.

## Owner rulings PENDING (raised by this day's measurements; nothing moved)
1. **A lone NECTAR in a flower does not reach the scoring floor by the CAD geometry** (tops out at
   3.597 vs `BB_FLOWER_VOL_Z` floor 3.904): by the 2D model it always scored. 0.30 in, worth 7
   points and an ownership. `flowerScoreZ` is the extraction that measures it. The 2026-09-12
   sorter ruling is what a change would overturn.
2. The CAD lower bore is 3.222, the manual's Fig 9-12 says 2.79 — CAD wins by the standing ruling;
   noted because the manual's sorting story (nectar seats on the middle ring) is not what the CAD
   does.
3. Weigh a real element set: `BB3_ELEMENT_MASS` 0.2 and the nectar ratio 1.6 are APPROX and the
   tip margin depends on them.

## Next: Day 3 (spec §10) — not started
A: perf tuning, heights in coercion, AI policy and tiers (`GameSimModule.bot`), bots in practice and
lobbies. B: Graphics section with presets and Auto detection (`SceneQuality` is ready), HDRI
environments, export compositing (roadmap item 2), gallery 3D stills, the mobile overhead default,
the 2D→3D key. C: wire the predictors into `game.ts`'s reconcile with the Off/Light/Full/Auto
setting (Lane A's API above), the online-room "Loading 3D physics" panel (`GameView` `need3d` is
`!session && …`; the controller latches `physicsPending` meanwhile), leaderboard `physics` badge and
filter, ranked cutover on the alpha server, smoke lanes filled, docs. Then the alpha ship.
DONE at the end of Day 2 (`20d0194`, `634d749`): `sim3d/` loads ONLY through `initPhysics3d()` —
`sim3d/engine.ts` is the light loader, `sim3d/tilt.ts` the light `hiveTiltAngle`/`hiveTrayRefTheta`
seam the scene imports, `sim3d/step3d.ts` a thin gate over `step3dImpl`, and `sim3d/impl.ts` the
heavy re-export the loader `import()`s (predictors included: `physics3dImpl().createFullPredictor`
after init). Main chunk 917 → 907.88 KB gz (seam 904.17 + the loader/tilt), hostWorker 700.84,
physics3d 1123 (the impl rides with the wasm), scene 187.27; bundleaudit baselines re-measured; a
CORE check forbids static imports of heavy sim3d modules outside `sim3d/` (only `engine` and `tilt`).

## Gotchas (new)
- `setAdditionalMassProperties` on a BODY is discarded by the collider mass recompute — set it on
  the desc; `body.mass()` is stale until the first step. A pinned tray SLEEPS and gravity does not
  wake it: `wakeUp()` at breakaway. The tray and its frame overlap at the bearing: separate
  collision groups; the joint limits are the damper.
- `atan2` is (−π, π]: wrap corner rays into [0, 2π) before sorting an annulus, or the ring closes
  across its bore. A convex hull of a C-bracket fills the C (visual-only parts stay visual-only).
- A `Date.now` DEFAULT PARAMETER trips the sim source guard, and should.
- `Client.send` hands out a live view of the world (`slimWorld` spreads one level): a test sink
  must encode/decode as the transport does. `physics: cond ? '3d' : undefined` CREATES the key:
  test "absent" on `JSON.stringify`, not `in`.
- `w.balls.length = 0` does not clear `rob.hopper`; a fired-out robot ends with an EMPTY hopper
  (measure the peak).
- `npm run dev` was broken by a Day 0 spike file importing an uninstalled package (`scripts/
  spike3d-browser/noncompat.*`, deleted). Orphaned `esbuild.exe`/`node.exe` from a dead Vite lock
  `npm ci` (taskkill first). Never `Remove-Item -Recurse` a directory containing a junction.

---

# HANDOFF — 2026-09-18, later (biobuzz-3d: play-test round 2 — true CAD geometry, CAD colours and tape, HUD-safe framing)

**(Previously READ FIRST.)** Branch **`biobuzz-3d`**, worktree `.claude/worktrees/biobuzz-3d`, clean at the merge
commit named in the log; all gates green there (`npm test` 1798 + the BIOBUZZ suite with a 105-check
SIM3D lane). This round was done by OPUS agents with an analysis phase first, at the owner's request;
the audit is `docs/biobuzz/field-cad-audit.md` — read it before touching the field pipeline.

## The owner's five sentences → root cause → fix (all verified)
1. *Balls on a different plane than the hive bottom* — `convert.py` exported tray hulls as WORLD-frame
   bounding boxes at the 30° tilt and the sim read them as tray-LOCAL; the collider floor sat 3.26 in
   above the mesh floor. Now every tray point is un-tilted about the pivot before export
   (`captureTheta` ±30.000° exactly), `hiveTrayRefTheta` is 0, the body rotation is plain
   `hiveTiltAngle`, and a headless check plus a dev-only raycast at GLB load assert the mesh and
   collider floors coincide (Δ ≤ 0.017 in) with a resting element 1.275 in above the plane.
2. *Hive back gone* — `convert.py`'s `other` group (25 parts: ACM logo panel, A-frame top bar, top
   corners, axle holders, feet, AprilTag plates) was never emitted. Unknown parts now go to a `misc`
   node and are printed; `assemble-gltf.mjs` refuses to finish with an unclaimed STL.
3. *Support structures missing* — the fastener regex matched the word "rivet" and dropped the 24
   perimeter rails and 16 corner hinges. `RE_FASTENER` is an explicit list of fastener families.
4. *Flowers wrong colour* — `XCAFDoc_ColorTool` returns nothing on this STEP; the colours live in the
   styled-item chain, now parsed from the STEP text and carried in the glTF material name
   `<finish>#<rrggbb>` (flowers: amber top ring, green HIPS pipes, purple backstop; the hive's
   alliance colour is the RIBS, not the white skins). Runtime overrides only surface params, forces
   `glass` transparent, and forces `tile` to `COLORS.mat` (the CAD tile grey is a placeholder).
5. *Tape wrong* — the GLB's 16 real tape strips were hidden behind procedural `strokeRect` outlines.
   The CAD tape is shown: all strips 1.000 in wide; loading zones taped on three edges (wall edge
   bare), gardens are two side-by-side 1-in strips, alliance areas on the gym floor; every on-tile
   strip stops 0.573 in clear of the wall face (asserted).
Also: the scoreboard/field overlap — `GameController.refreshHudInsets()` measures every
`data-hud-band` element (score bar, breakdown, status, buttons, BIOBUZZ's own score bar) into
`SceneFrame.insets`; both 3D cameras fit the field into the safe rect via `setViewOffset`; the 2D
camera already reserved matching bands (unchanged). A game that fills the `scoreBar` slot must mark
it `data-hud-band` or it gets the old overlapping fit.

## Physics now
Statics are true per-part convex hulls incl. the frame's diagonal legs, uprights, dampers and
crossbar (73 hulls); tray colliders are planar-facet oriented boxes (a hull of an open shell fills
the cell; the perforated Goal Rib gets none). 18-in AND 29-in robots pass under the down cell (CAD
floor 31.98; a 34.98-in robot is stopped); retention 20/20 at 24/48/72 in; the load table matches;
containment 0; two-run hash equal; perf median 0 ms / p95 1 ms. Sizes: `field.glb` 474 KB br,
`field-low.glb` 137 KB, colliders 31 KB; scene chunk 184 KB gz.

## OPEN findings (owner ruling pending; in the coordinator's memory) — now TWO facts, not four
- The real field is **141.35 in inside the walls** (tiles 23.528 in on centre): that one fact is the
  wall delta (±70.67 vs 72) AND the flower delta (~1.54 in vs `BB_FLOWERS`; `BB_FLOWER_D` itself is
  right to 0.09 in). Deciding the sim's field size is a 2D gameplay change — the owner's call.
- `BB_HIVE_BOTTOM_Z` 25.5 vs the CAD's 31.98.
- CLOSED: the up-cell opening matches the manual within 0.13 in (the old delta was the bbox artifact).

## Gotchas (new)
- **Never `Remove-Item -Recurse` a directory that contains a junction** — it follows the junction; an
  agent deleted 12 entries of this worktree's `node_modules` that way and restored them by copy;
  `npm ci` was re-run afterwards.
- A flat CAD face tessellates to its corners only: measure meshes by triangle/raycast, never by
  vertex scan. `MeshoptSimplifier.compactMesh` rewrites indices in place and returns `[remap, n]`.
  The LOW LOD needs `simplifySloppy` (honeycomb plates plateau). The determinism guard greps
  `sim3d/` by TEXT — do not name a trig function even in a comment.
- The scene preview's `scene.render` is what rotates the trays; a frozen frame loop draws them
  level, which looks exactly like the tilt bug.
- The near wall-top corners pin the driver FOV at 95° below ~21:9; the field fills the safe rect
  horizontally and leaves vertical slack at 16:9 (inherent).

---

# HANDOFF — 2026-09-18 (biobuzz-3d: owner's first 3D play-test fixes — hive tilt/spill, visuals, driver POV)

**(Previously READ FIRST.)** Branch **`biobuzz-3d`**, worktree `.claude/worktrees/biobuzz-3d`, clean at the merge
commit named in the log; all gates green there (`npm test` 1798 + 1413, SIM3D lane 83). The owner
reported four things after playing the Day 1 build; all four are fixed and verified:

1. **Hive visually tilted more than the physics.** The GLB tray node is captured at its rest pose, and
   the scene applied the ABSOLUTE tilt on top of it (double tilt). The scene now imports the physics'
   `hiveTiltAngle(world, a)` (`sim3d/hive3d.ts`) and `hiveTrayRefTheta(a)` (`sim3d/bodies.ts`) and
   rotates the tray by `hiveTiltAngle − hiveTrayRefTheta` — 0 at rest, 60° after a tip — the same
   expression `engine.ts`'s `applyHiveTilt` gives the kinematic body. ONE angle authority; never
   re-derive it in a renderer.
2. **Elements spilled out of the up cell.** Root cause in the PHYSICS: the CAD-sized tray collider was
   built from the box captured at the tray's own tilt without re-inclining it, so at rest the up-cell
   floor was FLAT (mouth and divider at the same z) and every landed element rolled out. Fix:
   `obliqueBoxCollider` bakes the capture angle into each collider's fixed local rotation (never a
   per-tick collider rotation — that destabilises the kinematic body); tray colliders use a `Min`
   restitution combine rule (floor/sides 0.15, back 0). Retention 20/20 at 24/48/72 in; the load table
   (3, 7, 3+2 stay; 8, 3+3 tip) now matches the manual in physics; an unchanged kinematic target does
   not wake resting elements. Consequence: the down-cell clearance is now ~22.7–29.8 in (mid 26.2, vs
   the manual's 25.5) so a 29-in robot IS stopped; the up-cell opening top reads 68.85 vs the manual's
   65.6 — a new OPEN finding beside the bottom one (see below).
3. **Rendering too dark, bad shadows, opaque panels, grey flowers.** ACES exposure 1.2, hemisphere
   1.3 + key 1.9, `RoomEnvironment` IBL via PMREM, `VSMShadowMap` (PCFSoft is deprecated in three
   0.186) with a shadow camera fitted to ±92 in, bias −0.0012 / normalBias 0.035 / radius 3; walls and
   station panels are transparent polycarbonate (opacity 0.22, depthWrite off, DoubleSide, renderOrder
   10); room backdrop lightened to gym grey. The GLB now carries one primitive PER PART CLASS with a
   named material (`flower_ring/pipe/base`, `hive_frame_metal`, `tray_metal`, `tray_panel_red/blue`,
   `wall_panel/extrusion`, `tile`, `tape_*`); `renderFieldGlb.ts` assigns PBR by material NAME.
   `convert.py` writes one STL per class per node; `assemble-gltf.mjs` builds the primitives.
   Colliders/measurements stayed byte-identical through the regeneration.
4. **Driver POV missed the near edge.** `fitDriverCamera(alliance, viewAngle, aspect)` in
   `renderCameras.ts` solves pitch analytically and the setback by search so all four corners, both
   wall tops and the hive tops fit with a 4 % margin: 16:9 → eye 72 in, setback 24 in, pitch 37.5°,
   FOV 95° (the near corners pin the FOV at `DRIVER_FOV_MAX`; raising the eye is preferred over
   pulling back). If it reads too wide in play, `DRIVER_EYE_H_*`/`DRIVER_SETBACK_*`/`DRIVER_FOV_MAX`
   are the knobs.

**OPEN findings (owner ruling pending, move nothing; in the coordinator's memory):** flower ring
centres ~1.4 in off `BB_FLOWERS`/`BB_FLOWER_D`; wall inner faces ±70.67 vs 72 (3D walls stay at 72);
hive up-cell opening [47.05, 68.85] vs `BB_HIVE_OPEN_Z` [53.5, 65.6] and down-cell clearance ~26.2
vs 25.5. The measurements check prints them under wide, commented tolerances.

**Gotchas added:** `PCFSoftShadowMap` is gone in three 0.186 (use `VSMShadowMap`); in the app the
`computer` tool's key presses may not reach the game's listeners (dispatch a synthetic
`KeyboardEvent`); `coerceAssists` forces `aimAssist` on, so a synthetic firing test sets
`r.aimAssist = false` on the spawned robot; `releasePollen`/`takeHeld` need a matching `held` ball
in `world.balls`, not just a hopper entry; the "Goal Rib" parts are treated as tray metal and only
the Top/Back/Bottom skins as the alliance panel (a judgement from part names, unverified against a
photo). Day 2 (spec §10) remains next; see the section below for the plan.

**Owner re-test 2026-09-18, after these fixes: STILL WRONG.** Elements sit on a different plane than the
tray floor; the hive's back and some support structures are missing from the GLB; flower colours still
wrong; tape layout and widths incorrect (wall-bounded zones carry no tape on the wall side; tape widths
are documented); the scoreboard overlaps the field. Diagnosis: the collider export used per-part AABB
corners (so the physics tray floor is not the mesh floor and the frame legs were dropped), the GLB
assembly drops/mis-classes structural parts, and colours/tape/tiles were procedural guesses. Round 2 is
running on OPUS agents (owner asked for better agents and more thorough analysis): a CAD audit doc,
true per-part hull colliders in each tray's un-tilted local frame, CAD (XCAF) colours and CAD tape,
and HUD-safe camera framing.

---

# HANDOFF — 2026-09-17, night (biobuzz-3d: Day 1 LANDED — 3D physics, 3D renderer, CAD field)

**(Previously READ FIRST.)** Branch **`biobuzz-3d`**, worktree `.claude/worktrees/biobuzz-3d`. Tree clean at the
merge commit named in the log; every gate green at that commit: `build` · `server:check` · `docaudit`
(CLAUDE.md 26,850 / 27,000 bytes) · `uiaudit` · `bundleaudit` · `npm test` (1798 shared + the
BIOBUZZ suite incl. the SIM3D and RENDER lanes, count in the log). The owner play-tested the first
3D view mid-day, found field parts misplaced and the graphics too plain, and ruled "the field should be
CAD derived" — both are addressed below. Day 2 (spec §10) is next; nothing of it is started.

## What Day 1 delivered (spec `docs/biobuzz/plan-3d.md` §10, all three lanes, merged)

- **Seam** (`941a598`): `Physics` type; `World.biobuzz.physics` + `biobuzzPhysics()`; `step2d`/`step3d`
  dispatch; `RobotState.z/vz`; `RobotSpec.heightIn` (+ the `coerceSpec` carry-across fix in
  `src/sim/spawn.ts`); `GameSettings.practicePhysics` (default `'3d'`); `GameModule.scene` and the
  `GameScene`/`SceneFrame` contract; `GameSimModule.bot?`/`physicsOptions`; `sim3d/engine.ts` loader
  (`initPhysics3d()`, dynamic import of the wasm); `graphics/store.ts` view pref; `worldHash` mixes `r.z`.
- **Lane A, sim** (`src/games/biobuzz/sim3d/`): persistent Rapier 3D world per `World` (WeakMap),
  id-ordered bodies, sync-before/readback-after, robots on the SHARED wrench (parity 1.000 in open
  field), elements with CCD, capture/launch/place/human player reusing the 2D bookkeeping (pure
  extractions: `hiveTimerStep`, `bbHumanPlayerTick`, exported `placeInFlower`/`biobuzzStepMatch`),
  KINEMATIC tray on the shared timer with PHYSICAL spill, `derive.ts` (contents/stacks/tags), containment
  net with `containmentFixes === 0` asserted. SIM3D lane: 34+ checks incl. two-run hash and perf
  (`step3d` 2v2 median ≈ 0 ms, p95 1 ms vs the 1.5 ms gate).
- **Lane B, renderer** (`scene/render*.ts`, lazy chunk 182 KB gz of 250): field, robots generated from
  spec (chamfered chassis, drivetrain wheels, sweepers, mechanisms, team sign), 56 instanced spheres
  with rolling spin, driver-station + overhead cameras, ACES + sRGB, PCF-soft 2048 shadows, procedural
  room. Geometry proven against `drawField.ts` with a side-by-side page (`scripts/scene-preview`, in-page
  named-object check) — four real errors fixed (flower pipes sideways, up-cell 3 in high, wall
  thickness, flower-parked element height); conventions (y direction, heading, alliance walls) were right.
- **Lane C, client**: Practice setup gains **Physics 2D/3D** (`practicePhysics`) and **View 2D/3D**
  (per device); `GameView` awaits `initPhysics3d()` before a 3D practice (fallback to 2D with an
  event-log line); the scene mounts UNDER the 2D canvas (`renderer.ts` `overlayOnly`), created/disposed
  live on view switch; `scripts/bundleaudit.mjs` ratchet (main, hostWorker, physics3d, scene).
- **CAD field** (owner decision): `npm run field-cad` → `public/models/biobuzz/` (`field.glb` 359 KB br,
  `field-low.glb` 242 KB, `field-colliders.json` 23 KB, `field-measurements.json`, README with source,
  sha256 and node names). Scene draws the CAD walls, hive frames, trays and flowers over the procedural
  tile/tape floor (constants fallback on any load failure). Physics: floor and walls analytic at the
  CONSTANTS; tray cells sized from the CAD cell; flower supports CAD trimesh (`FIX_INTERNAL_EDGES`);
  hive-frame legs/uprights EXCLUDED (their hulls are loose AABBs that sealed the drive-under). Twelve
  probe points agree between the CAD and constants engines.
- **Verified in the real app** (Physics 3D): drive, capture (HUD pips), a real parabolic shot, tray tip
  with physical spill, View 2D↔3D mid-match, resize; console clean.

## OPEN findings — owner ruling pending; MOVE NOTHING (also in the coordinator's memory)

CAD vs constants: flower ring centres ~1.4 in off `BB_FLOWERS`/`BB_FLOWER_D` (pipe-centroid proxy;
a bore fit would settle it); wall inner faces ±70.67 vs `BB_HALF_X` 72 (3D walls kept at 72 for
parity with the 2D pipeline and the staging); hive up-cell opening [47.05, 65.65] vs `BB_HIVE_OPEN_Z`
[53.5, 65.6] and down-cell lowest point 31.96 vs `BB_HIVE_BOTTOM_Z` 25.5 (one rigid bar cannot meet
both manual figures; the CAD says 25.5 is not the tray floor). The measurements check prints all of
them under wide, commented tolerances.

## Next: Day 2 (spec §10)

A: dynamic see-saw on a revolute joint + `scripts/hive-calibrate.ts` against the field-guide rows
(`BB3_HIVE_DYNAMIC` flips to true; kinematic stays the fallback); flower TUBES (the CAD rings are
excluded from the collider file because a hull of an annulus fills its hole — export ring trimeshes
from `convert.py`); derived flower stacks by z; G409/G417 tags; Light/Full prediction worlds + Auto
probe. B: reticle, HUD scrim, chase/orbit cameras, interpolation of balls and remotes (the scene
ignores `frame.alpha` today), labels through the scene camera, theme change mid-scene (backdrop read
once). C: `await initPhysics3d()` at server boot, `RoomConfig.physics`, `'bb3d'` cap gate, matchmaking
`3d`, the `physics` migration, `costprobe` scenarios, replay header + re-sim check, LAN lazy init.
Cleanups queued: move `sim3d/` behind `initPhysics3d()` (it is statically imported by `step.ts`, so
the main chunk carries ≈ +4.5 KB gz); tight per-part hulls for the hive frame in `convert.py`; Aim
Assist's landing prediction is an alignment gate under 3D; elements can marginally perturb a robot
(collision groups); the GLB's tiles/tape node is unused (no per-region colour); courtesy note to FIRST
(owner sends). Days 4-14: weigh a real element set (`BB3_ELEMENT_MASS` is APPROX).

## Gotchas (new this day)

- **Sonnet subagents obey the session's cwd over the prompt** when the Edit/Write tools refuse
  cross-worktree paths: two of six lanes worked in the session's own worktree. State the path in every
  command and check `git log` for where a commit landed. Lane worktrees shared ONE `node_modules`
  through junctions (`New-Item -ItemType Junction`; remove with `cmd /c rmdir`, never `rm -rf`).
- **Never route base64 image data through a tool call** (a `toDataURL` write blew the 64k output
  limit twice). Describe screenshots; the browser pane is visible to the owner anyway.
- **The in-app browser pane**: `requestAnimationFrame` only advances when a paint is forced
  (alternate `wait` and `screenshot`); the pane is shared between concurrent agents (always
  `tabs_create` and pass `tabId`); Enter does advance the countdown. Fastest way to drive the game
  from a script: walk the React fiber from the canvas to `GameView`'s third ref (the `GameController`)
  and edit `world` JSON directly — the next tick reconciles the bodies.
- **Rapier 3D**: forces persist across steps (`resetForces`/`resetTorques` per tick); a collider's
  `setTranslation` offset rotates with the BODY, so a per-collider rotation offset needs its
  translation rotated too; `RigidBodyDesc.enabledRotations`; `TriMeshFlags.FIX_INTERNAL_EDGES`.
- **CAD pipeline**: `BRepMesh_IncrementalMesh` caches on the shape (call `BRepTools.Clean_s`
  first); flat STL normals block meshoptimizer's simplifier (drop normals, recompute in the loader);
  GLTFLoader strips `/` from node names (use `userData.name`); `.cmd` shims cannot be `execFileSync`'d
  on Windows (call `node <cli.js>`); the standalone `scene-preview` needed its own `vite.config.ts`
  (`publicDir`) to serve `/models/biobuzz/*`.
- Pre-existing: `uiaudit` `stale-component-index` after a merge — `npm run uiindex`; `smoke.ts` is 1798
  checks, not the 1765 CLAUDE.md still says; a dev-only "Invalid hook call" cascade in `AdsProvider`
  on cold loads (both physics; not investigated).

---

# HANDOFF — 2026-09-17, later (biobuzz-3d: Day 0 physics spike results)

**(Previously READ FIRST.)** Branch **`biobuzz-3d`**, worktree `.claude/worktrees/biobuzz-3d`. Tree is clean
except for the files this session adds/commits: `scripts/spike3d.ts` (new, throwaway CLI),
`scripts/spike3d-browser/` (new, throwaway browser+Electron harness), `docs/biobuzz/spike3d-
results.md` (new), this HANDOFF section, and `package.json`/`package-lock.json` (three new
pinned installs, `src/` and `docs/area/` untouched). `npm ci` ran clean (560 packages). `npm run
docaudit` passes (CLAUDE.md 26,670 / 27,000 bytes, unchanged).

## Installed this session (all pinned `-E`, `@dimforge/rapier2d-compat` untouched at 0.19.3)

`@dimforge/rapier3d-deterministic-compat@0.20.0` (dependencies), `three@0.186.0` +
`@types/three@0.186.0` (devDependencies). `@dimforge/rapier3d-deterministic@0.20.0` (the
non-compat build) was installed once with `--no-save` to probe it and is **not** in
`package.json`/`package-lock.json` — confirmed by grep after the probe.

## Results: the Day 0 spike PASSED the gate

Full numbers, the runtime matrix, and the tray/joint gotcha are in
`docs/biobuzz/spike3d-results.md`. Summary:

- **Hashes equal across two Node runs** (`1971098706` both times) — the mandatory check.
  **Also equal in Chromium (Electron)** — `1971098706` there too, which the gate did not
  require but the plan hoped for. The deterministic build's cross-platform promise held on
  this scene, this machine.
- **Step time far under budget**: 0.020 ms median, 0.046 ms p95 against a ≤ 1.5 ms target — but
  this scene (4 robots, 56 elements, 2 tray bodies, no CAD trimesh, no real gameplay reads) is
  smaller than a real 2v2 room will be, so treat this as a floor, not a prediction; re-run with
  `costprobe`'s `biobuzz3d-*` scenarios once `step3d` is real.
- **Runtime matrix**: `-deterministic-compat` initialises and matches hashes in both Node/tsx
  and browser (Vite dev + Electron). The non-compat `-deterministic` package **fails in both**
  Node/tsx and Vite/browser as published on this Vite version (6.4.3) — it has no `init()` and
  its glue does a bare `import * as wasm from "*.wasm"`, which Vite explicitly rejects without
  `vite-plugin-wasm` and Node's ESM resolver rejects on the extensionless imports before it even
  gets that far. **Stay on compat, as the plan already defaults to** — do not spend Day 1/2 time
  trying to swap packages without adding a wasm plugin, which is a separate decision.
- **Tray/joint gotcha, worth remembering for the real `sim3d/`**: `JointData.limitsEnabled` /
  `.limits` set before `createImpulseJoint` were **not enough** — the tray span past the
  intended ±30° to ~177° before something else stopped it. Fix: call `.setLimits(min, max)` on
  the `ImpulseJoint` **instance** `createImpulseJoint` returns. With that, both trays sat
  exactly at `30.0000448913582°` for the full run (the ballast pins the empty/lightly-loaded
  tray at one stop, matching the intended start condition) — not a calibrated see-saw yet,
  which is `hive-calibrate.ts`'s job on a later day per plan §3.6.
- **Chunk size**: the physics chunk is 2,891,032 B raw / 1,089,268 B gzip-9 (matches the plan's
  ~1.1 MB gzip estimate); the main chunk grows by a noise-level 110 B raw when the loader is
  merely reachable. **Methodology gotcha**: an exported-but-never-referenced function is
  tree-shaken away entirely before Rollup code-splits it — the first attempt (exactly what the
  spec asked for) produced a byte-identical build and no new chunk at all. Had to add one
  module-scope side-effecting reference (`globalThis.__x = theFn`) to keep the declaration alive
  for the measurement, then revert everything (`git checkout --`) and rebuild to confirm the
  tree was clean again (it was — byte-identical to the pre-spike baseline). Worth remembering
  for whoever writes `bundleaudit` (spec §2.5/§7): it needs the same trick, or a real call site,
  to measure an as-yet-unused dynamic import honestly.

## Next: Day 1 (spec §10) — the whole game on 3D physics in the 2D view

Not started. Per the spec: `sim3d/engine.ts` (persistent Rapier world, `initPhysics3d()` behind
a dynamic import), `step3d` (§3.1's nine-step tick), `derive.ts` (§3.5, fills
`hives[a].contents`/`flowers[i].stack` from body positions so `score.ts`/`hud.ts`/the 2D
renderers work unchanged), the real hive frame + tray (§3.6, starting from this spike's geometry
but calibrated against the manual's two published tip rows via `hive-calibrate.ts`), flowers
(§3.7), and the `World.biobuzz.physics: '2d' | '3d'` dispatch in `biobuzzStep`. Also queued at
Day 0 but not run by this session: the CAD pipeline (`scripts/field-cad.mjs` +
`scripts/field-cad/convert.py`) and the courtesy note to FIRST (owner sends it; draft is in the
demoted section below).

## Gotchas (carried forward + new)

- **`JointData`'s `limitsEnabled`/`limits` fields alone did not clamp a revolute joint** in
  `@dimforge/rapier3d-deterministic-compat` 0.20.0 — call `.setLimits(min, max)` on the created
  `ImpulseJoint` instance too. Untested whether this is a compat-wrapper quirk or true of raw
  Rapier 0.35; did not have time to check upstream, and it does not block Day 1 since the
  workaround is one line.
- **An exported function with no call site or reference is dead-code-eliminated**, `import()`
  inside it and all — do not trust "add an unused export, build, measure" for a chunk-size
  check without also keeping the declaration reachable (see above).
- Two Rapier packages coexist on purpose: 2D on `rapier2d-compat` 0.19.3, 3D on
  `rapier3d-deterministic-compat` 0.20.0. Never upgrade the 2D package as a side effect.
- The 3D wasm must load through a **dynamic import** inside `initPhysics3d()`, same reasoning
  as before — this spike's own chunk-size measurement is the number that makes that concrete
  (≈1.09 MB gzip if it ever leaked into a chunk every player loads).
- Other sessions have worktrees here (`main-merge`, `alpha-ui`, `nice-morse-…`, a
  `claude/biobuzz-3d-worktree-…` that is unrelated). Do not `cd` into them; the stash stack is
  shared.
- CLAUDE.md still has headroom (26,670 / 27,000 bytes) — unchanged this session, nothing here
  touched it.

---

# HANDOFF — 2026-09-17, late (biobuzz-3d: Day 0 begun, alpha carries the split, PAUSED before the physics spike)

**(Previously READ FIRST.)** Branch **`biobuzz-3d`**, worktree `.claude/worktrees/biobuzz-3d`, now based on
**`alpha` 7e268dd**. The branch carries `docs/biobuzz/plan-3d.md` (draft 3 with the owner's eleven
decisions, §12) and this HANDOFF. **No code has been written.** The owner asked for cheap
subagents and a pause with a detailed handoff before any step that could use a whole session;
this is that pause.

## Done this session (Day 0, part 1)

- **`efficiency-audit` merged into `alpha`** (1ecc3f2; the owner's Q10). No conflicts: the two
  branches touched disjoint files (`git merge-tree` preview, then the merge). `npm run uiindex`
  regenerated the component index alpha's six UI commits had outdated (7e268dd). **Every gate on
  the merged alpha is green**: `build` · `docaudit` (CLAUDE.md 26,670 / 27,000 bytes) · `uiaudit`
  · `npm test` **1765 + 1321 ALL PASS**. Pushed to `origin/alpha`.
  ⚠️ **Migration 0037 is a SERVER change**: until the alpha app is redeployed (owner's wrapper,
  `fly-deploy.sh --alpha`), its six indexes do not exist in production. Same for main later.
- `biobuzz-3d` merged with the new alpha. HANDOFF conflict resolved by keeping the biobuzz-3d
  sections on top of alpha's log. The spec's status line records the base.
- `npm ci` ran in `.claude/worktrees/pr-alpha` (it has `node_modules` now); **the biobuzz-3d
  worktree still has none**, and neither do the other worktrees.

## PAUSED HERE: the next step is the Day 0 physics spike (spec §10)

Run it as **one sonnet subagent** in the biobuzz-3d worktree. Estimated: 30 to 60 minutes wall,
moderate tokens, no shared-file edits. The plan, in order, with the acceptance it must report:

1. `npm ci` in the worktree (a few minutes; Electron is a dependency).
2. Install, pinned exactly like the 2D physics: `npm i -E @dimforge/rapier3d-deterministic-compat@0.20.0`
   (in `dependencies`: the server needs it) and `npm i -D -E three@0.186.0 @types/three@0.186.0`.
   Nothing imports them yet except the spike. (Registry checked 2026-09-17: all three at those
   versions; the compat package unpacks to 10.3 MB, wasm about 2.05 MB / 767 KB gz.)
3. `scripts/spike3d.ts` (throwaway, run with `tsx`, never in `npm test`): `await import(...)` the
   compat module and `init()`; build a z-up world (gravity `{x:0, y:0, z:-386}` in inches);
   statics: floor, four walls at ±72, two frame base bars (x in [24,25] and [-25,-24], y ±19.4);
   four dynamic 18-in boxes with yaw-only rotation (`setEnabledRotations(false,false,true)`),
   z free; 56 dynamic spheres (40 × r 1.4, 16 × r 1.8, mass 0.2 lb, CCD on); one dynamic tray per
   hive on a revolute joint about x at (±12.75, 0, 43.95) with limits ±30° and a trial ballast
   (or kinematic first if the joint fights); a scripted push on one box for 600 ticks; step 3,600
   ticks at 1/60. Every 60 ticks hash all positions rounded to 1e-4 (FNV-1a, the `worldHash`
   shape). Print: median and p95 ms/step, body count, sleeping count, the final hash.
4. **Run it twice in Node**: the two final hashes must be equal (the deterministic build's whole
   promise). If they differ, stop and report; do not tune.
5. Cross-runtime: run the same spike in Chromium (a throwaway Vite page or the Electron shot
   runner) and compare the final hash with Node's. Report equal / not equal.
6. Try the non-compat `@dimforge/rapier3d-deterministic@0.20.0` with the raw `.wasm` (Vite `?url`
   in browser and worker; `fs.readFileSync` in Node and `tsx`). Record which of the four runtimes
   initialise; if all four, it saves about 300 KB gzipped per §2.5. Do not switch packages in
   this spike; just report.
7. Add a dynamic `import()` of the compat module behind an unused function, `npm run build`, and
   record the emitted chunk sizes (`dist/assets`), then remove it. `bundleaudit` does not exist
   yet; this is the baseline number for it.
8. Commit the spike script and a `docs/biobuzz/spike3d-results.md` (numbers only, the runtime
   matrix, the hash outcome) on `biobuzz-3d`; prepend a HANDOFF section.

**Gate (spec §10 Day 0):** hashes equal across two runs; median step at or under 1.5 ms for the
2v2-equivalent world. **Kill/adjust:** step over 3 ms after enabling sleeping and limiting CCD to
fast bodies → the "freeze far elements" fallback in spec §11; hashes unequal on the deterministic
build → stop, the vendor's promise failed, report before anything else is written.

Also on Day 0, as separate cheap agents once the spike passes: **the CAD pipeline**
(`scripts/field-cad.mjs` + `scripts/field-cad/convert.py`; needs Python and `pip install cadquery`,
a heavy install: run it in its own agent and report the measurements file first, the GLB second),
and the **courtesy note to FIRST** (the owner sends it; draft below).

## Draft note to FIRST (for the owner to send)

> Hello. I run DSIM (playdsim.com), a free driver-practice simulator for FTC teams. For the
> BIOBUZZ season I am building a 3D mode and would like to use the published field CAD (the STEP
> release on ftc-resources) as the source for a simplified, decimated field mesh and collision
> geometry, served from the site and committed to the project's public repository, with
> attribution to FIRST and the manual's CAD credit. Your terms of use grant personal use; could
> you confirm this use is acceptable, or tell me what attribution or limits you would want?
> Thank you for publishing the CAD; it is what makes an accurate simulator possible.

## Gotchas

- **Two Rapier packages coexist**: 2D on `rapier2d-compat` 0.19.3, 3D on
  `rapier3d-deterministic-compat` 0.20.0 (Rapier 0.35: new sleeping, sweep CCD on for fixed
  colliders, changed contact defaults). Never upgrade the 2D package as a side effect.
- The 3D wasm must load through a **dynamic import** inside `initPhysics3d()`; a static import
  anywhere reachable from `src/games/index.ts` or the LAN `hostWorker` puts about 1.1 MB gzipped
  into chunks every player pays for. `bundleaudit` (to write) is the ratchet.
- CLAUDE.md has **330 bytes of headroom**: the spec's two sentences (game table row, the
  client-bundle rule) must fit or the rule moves to `docs/area/biobuzz.md` with a pointer.
- Other sessions have worktrees here (`main-merge`, `alpha-ui`, `nice-morse-…`, a
  `claude/biobuzz-3d-worktree-…` that is a main-merge branch unrelated to this work). Do not
  `cd` into them; the stash stack is shared.
- The spec compares against a comparable third-party 3D sim only generically; keep it that way.
- The CAD-derived field files SHIP by owner decision (Q9); keep the constants fallback complete.

---

# HANDOFF — 2026-09-17, night (biobuzz-3d: draft 3 of the spec, ONE game with a 3D deterministic authority)

**(Previously READ FIRST.)** Branch **`biobuzz-3d`**, a worktree at `.claude/worktrees/biobuzz-3d`, based on
`alpha` **1ecc3f2** (`efficiency-audit` merged into alpha on 2026-09-17, the first Day 0 step). The branch carries only **`docs/biobuzz/plan-3d.md`** and this HANDOFF. No
code has been written. Every gate is alpha's, unchanged.

⚠️ **Drafts 1 and 2 were REJECTED by the owner.** Draft 1 kept the 2D sim authoritative under a
3D view; draft 2 made 3D a separate `biobuzz3d` game. The owner's direction (2026-09-17, verbatim
in spirit): BIOBUZZ stays ONE game; every ranked or record match runs on a 3D deterministic
server; players render in 2D or 3D and the 2D path stays very fast; practice offers the old 2D
physics, 3D physics with a 2D view, or 3D physics with 3D rendering, each with or without AI;
prediction is a player option; graphics have presets and detailed settings; GPU acceleration is
on automatically. Draft 3 is that. Read it, not the commit history.

## What draft 3 decides

- **One game id.** `World.biobuzz.physics: '2d' | '3d'` (absent `'2d'`); `biobuzzStep` dispatches.
  The 2D pipeline is untouched and stays selectable for practice and casual rooms; deleting it
  later is one branch of one function (owner Q11).
- **Rapier 3D, deterministic build** (`@dimforge/rapier3d-deterministic-compat` 0.20) in
  `src/games/biobuzz/sim3d/`, authoritative for ranked, record and matchmade rooms and their
  replays. Persistent server world, JSON readback each tick, spill and flower stacking from
  physics, the manual's tip table kept.
- **Derived lists** (`sim3d/derive.ts`) fill `hives[a].contents` and `flowers[i].stack` from body
  positions, so the shared `score.ts`, HUD, results and the 2D renderers work under both physics.
- **Same wire for 2D and 3D clients** (robots gain `z/vz`; elements already carry them). Two
  renderers over one world: the canvas (no WebGL, no wasm) and a lazy Three.js chunk.
- **Prediction: Off / Light / Full** (Light = drive model + walls, no wasm, the 2D default).
- **Graphics: Auto / Low / Medium / High / Ultra / Custom** over sixteen settings, per device;
  Auto = GPU detection + a 2 s warm-up; software GL → 2D view; `high-performance` power
  preference; hardware acceleration never disabled in the app.
- **Practice**: physics 2D/3D, view 2D/3D, AI opponents off or a tier. Runs upload with
  `physics` + `view` tags. One migration adds `physics` to records/matches/replays/practice_runs
  (default `'2d'`), no season reset (owner rule).
- **CAD import**: `scripts/field-cad.mjs` (STEP → CadQuery → glTF + collider meshes +
  measurements); constants fallback; licence unresolved (ask FIRST, owner Q9).
- **Build plan in days**: Day 0 spike gate (hash equal across runtimes, 2v2 step ≤ 1.5 ms);
  Day 1 the whole game on 3D physics in the 2D view; Day 2 3D rooms online; Day 3 the 3D
  renderer, graphics settings and the alpha ranked cutover. Three lanes.

## Owner decisions (2026-09-17, recorded in §12)

Lobbies/LAN default 3D with a host 2D option · deterministic build everywhere (Day 0 speed gate) ·
robots yaw-only now, pitch/roll designed for later (3.3) · **dynamic see-saw calibrated to the
field-guide rows** (3.6; kinematic fallback) · realism then rulebook for opponent shots · prediction
Auto-calibrated (5) · ranked cutover on alpha Day 3, production when the owner says · Force-GPU
toggle offered, off by default, auto-cleared after a GPU crash · **ship the CAD-derived field files**
(owner accepts the licence risk; courtesy note to FIRST) · merge `efficiency-audit` first · **the 2D
physics is a permanent light practice option, never deleted**.

## Next steps

1. Merge `efficiency-audit` into `alpha` (a real merge, +14/+6), rebase `biobuzz-3d`.
2. Day 0 per §10: deterministic 3D package spike (hash across runtimes, 2v2 step ≤ 1.5 ms),
   CAD pipeline run, courtesy note to FIRST.
3. Weigh a real element set when possible; mass and the nectar ratio are APPROX until then.

## Gotchas

- The base now carries the CLAUDE.md split: `docs/area/` guides, `npm run docaudit`, the sharded
  `npm test` and migration 0037. CLAUDE.md is at 26,670 of its 27,000-byte budget, so the spec's
  two sentences must fit or move to a guide. Spec line refs are as of `efficiency-audit` e0ce598.
- The spec compares against a comparable third-party 3D sim only generically; keep it that way.
- The CAD-derived field files SHIP by owner decision (Q9); keep the constants fallback complete so they can be pulled in one commit.
- `V` is Chain Reaction's `fling`; the view-cycle key is `t`.
- Under 3D physics, `state.kind === 'element'` means "a body inside a structure", not "not
  solved": the 2D readers only read the tag; do not port the 2D assumption into `sim3d/`.

---

# HANDOFF — 2026-09-17b (main: the record-restart regression, fixed and deployed)

**READ FIRST.** The alpha merge (below) shipped a regression: **restarting a record run was
refused** with "You already have a game in progress - rejoin or leave it first". Fixed,
deployed, `/health` ok, one image across all 8 machines.

**The cause is worth knowing, because it was latent for months.** `startLoop` used to open
with `stop()`, which releases every single-game lock `startMatch` had just taken — so the
one-game-per-user guard bound NOTHING. `0857745` split `stopLoop()` out and made the guard
real, and the restart path had always quietly depended on it being inert: restarting is a
full teardown (dispose the session, join a BRAND-NEW `rec-` room), so the new run arrives
while the old room still holds the account's lock.

**⚠️ IT ONLY APPEARS ON AN AUTHENTICATED JOIN** (`if (user && activeElsewhere(...))`), which
is why nothing caught it. Every ad-hoc socket test run against it was anonymous — the join
field is `authToken`, not `token`, and a wrong field name reads as a signed-out player and
passes vacuously. If you are testing a lock, assert the lock was TAKEN first.

**The fix**: a solo record run yields at the door and is the only room kind that does — no
opponent, no alliance, no rating, so the only person it can be in the way of is its owner.
Versus, duo and ranked still refuse. Only the LOCK is released (`releaseSeatLock`), never the
room, because a run decided at the buzzer is kept alive by `finishing` until the field settles
and its score is written. Client half: `restartRun` sends `abandon` on the live socket before
disposing, and clears `activeGame` (which still named the abandoned run, so Home went on
offering to rejoin a match that no longer existed). 8 checks in `npm test`.

## Still open

- **A REJOIN COMPLAINT I COULD NOT REPRODUCE** ("can't move, can't see anyone else move").
  Driven end to end against the real server — 2-player versus, one player dropped with a 1006,
  rejoined, both drove: the rejoined player moved exactly as far as the one who never dropped,
  both saw the same positions, snapshots kept flowing. `reattach` is fine on this evidence.
  Needs specifics before it can be chased: which mode (ranked / custom / record duo), and which
  "rejoin" — the Home card, a page refresh, or a network drop that recovered by itself.
- **A PRE-EXISTING GAP, found while testing and NOT fixed**: an account in a LIVE VERSUS match
  is admitted into a new solo record room. It reproduces with the fix reverted, so it predates
  all of this — the guard simply does not fire on that path. Worth a look; it is the same guard
  the record restart was tripping over, pointed the other way.
- The season-4 drift from the merge below is unchanged and still the owner's call.

# HANDOFF — 2026-09-17 (main: alpha merged whole and deployed, season HELD at 4)

**Superseded by the section above.** `alpha` is merged into `main` as a single merge commit and deployed to Fly.
The branches are level: everything that was on alpha is on main, and main's two spectator
fixes (`applyBallDelta` COPIES, a reconnecting spectator re-spectating) survived the merge —
their four smoke checks are asserted present in the merged tree.

**⚠️ NO VERSION BUMP WAS TAKEN.** `BALANCE_VERSION` stays **4** and `SIM_VERSION` stays **2**
(both were already equal on the two branches, so the merge moved neither). The owner declined
the owed bump to 5 on 2026-09-17: the batch does move scores — settle-based finalize, and the
BIOBUZZ buzzer-TIP — but bumping archives the standings for everyone on the one Fly app, and
holding the season was the call. The consequence is on the record in `src/config.ts`: records
set before and after this deploy share a board although the scoring moved under them. That is
accepted, not an oversight. Do not "fix" it by bumping later without asking.

## The five conflicts and how they went

| file | hunks | resolution |
|---|---|---|
| `src/standing.ts` | 1 | **alpha's `card: 5`** — main's `20` contradicted the docstring directly above it, and the 2026-09-16 backport HANDOFF had already written down that alpha's side wins here next time |
| `server/room.ts` | 2 | alpha's — `passCrown` on a host leaving a finished match, and `stopLoop()`, which alpha split out of `stop()` and main never had |
| `scripts/smoke.ts` | 1 | alpha's — the HEAD side was empty; purely additive room-recycle tests |
| `src/ui/Matchmaking.tsx` | 6 | alpha's — all six HEAD sides empty (`saveStagedMatch`/`clearStagedMatch` calls) |
| `HANDOFF.md` | 1 | alpha's, then this section prepended |

None of the five needed a judgement the repo had not already recorded.

## Gates, all green on the merge commit

`npm test` **ALL PASS twice** (shared + BIOBUZZ 1321) · `npm run test:mm` 186 ·
`npm run dbtest` ALL PASS · `build` · `server:check` · `uiaudit` at/under baseline ·
`contrast` 223.

No new migrations — the admin-panel pair (0035/0036) was already on main from the backport,
so this deploy needed no schema step.

## Next

- `alpha` is now behind `main` by this merge commit. Fast-forward it before doing more work
  there, or the branches re-diverge immediately.
- The season-4 drift above is the open question, not a task. It gets settled the next time
  someone is willing to reset standings.

# HANDOFF — 2026-09-16, later (efficiency audit: the test loop, the indexes, the render path)

**READ FIRST.** Branch **`efficiency-audit`** off `alpha`, 12 commits, **not merged and not
deployed**. Every gate green: `npm test` ALL PASS ×2 (1765 + 1321) · `test:mm` 186 · `dbtest`
ALL PASS · `build` · `server:check` · `uiaudit` · `contrast` · **`docaudit`** (new).

⚠️ **The DB migration (0037) is a SERVER change and needs a deploy** to take effect, like
0035/0036 before it. Until then the indexes do not exist in production.

## What landed

| # | commit | what |
|---|---|---|
| 1 | `test:` | **`npm test` 237s → 39s.** `smoke.ts` sharded across 12 processes by `scripts/smokeshard.mjs`. |
| 2 | `db:` | migration **0037**: six missing indexes, two dead ones dropped, and the two RULES asserted in `dbtest`. |
| 3 | `render:` | held-artifact grouping, the per-ball highlight hoisted, `useCoarsePointer`. |
| 4 | `docs:` | HANDOFF archived, and the check counts in CLAUDE.md corrected. |
| 5 | `server:` | LAN roster moderation parallelised, `/api/stats` memoized. |
| 6 | `docs:` | HANDOFF entry for the session. |
| 7 | `docs:` | search with `rg`, not `grep -r` — `.claude/worktrees/` is 810 MB of repo copies. |
| 8 | `docs:` | **CLAUDE.md split: 43.7k tokens → 6.6k**, plus `docaudit` and the area hook. |

### 0. CLAUDE.md is now a routed core, and the routing is enforced

It was 2,206 lines (~43,700 tokens) and it is loaded into EVERY session, so a session fixing a
button paid in full for DECODE's gate-lever geometry and the Ko-fi webhook policy. It is now
~6,600 tokens: what is true everywhere, plus a routing table to ten guides in `docs/area/`
read on demand.

**Nothing was rewritten.** 2,035 of the original 2,042 non-trivial lines are byte-identical in
their new homes; the 7 that differ are the reworded opening blockquote and five
cross-references that pointed at sections now in another file. Verified by a line-level diff
against git HEAD, not by assertion.

⚠️ **The risk here is not size, it is SILENCE** — a rule in a guide nobody opens has been
deleted, not relocated. Two defences:
- **`npm run docaudit`** — every guide routed, every link resolving, every `governs:` glob
  still matching real files (catches a RENAME, which otherwise leaves a guide governing
  nothing), every source file owned, and CLAUDE.md inside a token budget that is a **RATCHET**
  (only ever lowered, so the file cannot grow back). All five rules were tested by breaking
  them. Writing it found a `governs:` line already wrong and sixteen unowned top-level modules.
- **`scripts/areahook.mjs`** — a PostToolUse hook naming the guide for the file just edited,
  once per area per session. Reminder, never a block; always exit 0.

**If you add a rule to CLAUDE.md, the test is whether a session working somewhere else needs
it.** If not, it belongs in the guide for the path it governs.

### 1. The test loop was the single biggest thing wrong with this repo to work in

`scripts/smoke.ts` was **220s** of the 237s `npm test` took, and CLAUDE.md called it "fast".
Everything else combined is 12.5s (`tsc` 6.3 · `vite build` 3.8 · `server:check` 2.3 ·
`uiaudit` 0.1 · `contrast` 0.07). The memory note "don't run full npm test" is what that had
already cost.

It turned out to be trivially parallel. `smoke.ts`'s top level is 360 statements, **257 of them
bare blocks** — closed scopes declaring nothing anyone else sees — over a 103-statement
preamble whose only mutable is `failures`, which every block writes and none reads.
`smokeshard.mjs` parses it with the TypeScript parser, copies the preamble verbatim into each
shard, deals the blocks out, and bin-packs them longest-first from a measured cost table keyed
by block CONTENT. **smoke.ts is untouched.**

Proved rather than assumed: serial and sharded produce **the same 1765 check names with the
same outcomes**. The only three textual differences are a UUID and two world hashes that
`Room` seeds from `Date.now() ^ Math.random()` (room.ts:1281) — different on every run either
way.

⚠️ **The guard matters more than the speed.** A shard runner that loses a block still prints
ALL PASS. So: the assignment is asserted to be a partition (set equality, not a count), a shard
that dies without a verdict fails the run, and an **independence guard** refuses to shard at
all if smoke.ts grows a top-level `let` or a stray side effect. `npm run test:serial` is the
way out; `npm run test:calibrate` re-measures.

**~22s is the floor at any width** — one block costs 22.4s alone and a block cannot be split.
4 shards 54.6s · 8 28.6s · 12 23.4s · 16 24.5s.

### 2. The indexes, and the rule that found one the sweep had missed

`records.replay_id` and `matches.replay_id` are `references replays(id) on delete set null`
and **neither was indexed since 0001**, so every replay delete scanned both tables in full —
and the practice/LAN prunes that delete replays run on **every upload**. Same for
`records.partner_id` and `kofi_payments.claimed_by`. The pattern was already understood here:
`practice_replay_idx` (0032) and `lan_replay_idx` (0033) exist for exactly this reason. The two
oldest tables missed out.

Also: `recentMatches` unions all of `matches` and all of `records` and orders by `created_at`
with nothing indexed on it; `challengeParty` filters `room_invites` on an unindexed `room`,
and that gates every rated friend match. Dropped two indexes that can never be chosen
(`user_activity(user_id)` and `friend_requests(from_user_id)`, each already a prefix of a
constraint's index).

**`dbtest` now asserts the RULES, not the columns** — every FK indexed, no index a dead prefix
of another — against the live schema after every migration. That is not decoration: **the FK
rule found a fifth unindexed key on its first run** (`score_reports.match_id`) that the manual
sweep had missed.

### 3. Render, server, docs

`renderer.ts` filtered `world.balls` for held artifacts **inside** the per-robot loop —
O(robots × balls) per frame, ~173,000 predicate calls/s in a 2v2 CR room at 144 Hz. Grouped
once. `drawBalls` rebuilt an `rgb(...)` string per artifact per frame for one of two possible
colours. `GameView` called `matchMedia('(pointer: coarse)')` five times per render at the 10 Hz
poll — and reading a media query during render is **not subscribing to it**, so a 2-in-1 that
changed pointer kept whichever controls it booted with. `useCoarsePointer` fixes both; verified
live in both layouts.

Server: the LAN roster moderated names **one at a time** against a hosted API with a 4s timeout
— up to 16 sequential calls per upload. `/api/stats` is public and ran three unbounded
aggregates per homepage load; memoized 60s, with dbtest asserting it is a memo and not a
freeze.

Docs: HANDOFF.md was **5,888 lines (~97k tokens)** with "read at session start" beside it. The
29 oldest sections moved **unedited** to `docs/handoff-archive.md`; all 37 survive. CLAUDE.md
said smoke was "~1240 checks" (1765), `test:mm` 36 (186), `dbtest` ~61 and elsewhere 36 (232).

## Next steps

1. **Merge to `alpha`**, then promote + deploy from a `main` worktree — 0037 applies at boot.
2. `npm run test:calibrate` after adding or deleting an expensive block.

## Found and NOT fixed — ranked, all verified, none started

1. **The client bundle is 2.54 MB and 1.57 MB of it is base64-inlined WASM** (62%), duplicated
   again in `hostWorker` (1.89 MB). `@dimforge/rapier2d-compat` inlines its wasm, and base64
   costs 33% over the raw binary. The non-compat `@dimforge/rapier2d` loads a separate,
   cacheable `.wasm`. ⚠️ **But Rapier is pinned EXACTLY on purpose** — a different physics
   build changes `step()` with no version bump, making every replay stamp a lie — so this is a
   SIM_VERSION-bump decision, not a dependency swap. And note `main.tsx` awaits `initPhysics()`
   before the first render, so code-splitting alone buys nothing without reordering boot.
2. ~~`persistVersusMatch` is 16 sequential round trips~~ — **FIXED.** Batched to about four.
3. ~~`getStanding` is a write transaction on a read path~~ — **FIXED** with a read-only fast
   path. Note the SURROUNDING item is still open: `chargeStanding` is still ~7 round trips per
   offender and still serialized ACROSS offenders in `persist.ts:220`.
4. **`broadcastSnapshot` stringifies every ball individually just to detect change** (30×/s per
   room, 300 balls in CR), then stringifies the changed ones again into the body. A dirty
   epoch stamped by the sim would remove the first pass. The broadcast itself is already well
   optimized — this is the remaining hot allocation.
5. **`matchStart` and `strategyStart` are encoded per recipient** though they vary only in
   `yourRobotId` — the shared-prefix trick `broadcastSnapshot` already uses.
6. **`MobileControls` re-renders at touch-event rate** (60–120 Hz while a thumb is on a stick,
   on the device class with the least headroom) and has no `memo`/`useCallback` anywhere:
   every render rebuilds the button array and 4 fresh closures per button.
7. **`useCountUp` drives React state at rAF** for ~1s after every match, three concurrently,
   each re-render rebuilding the whole `sections` structure in `Results`.
8. **`GameView.tsx:259` builds a full `HudSnapshot` 4×/s to read two booleans**, and the timer
   is created even in solo where its body can never do anything.
9. **`App.tsx:740` creates a 400ms interval outside an effect** — the only timer in `src/ui/`
   or `src/net/` with no unmount cleanup. Self-limiting at 30s.
10. **`profileEnsured` (repo.ts:288) is never pruned** — bounded only by Fly's scale-to-zero
    restarting the process, which is not a bound on a machine that stays warm.
11. **Correlated per-row subqueries in both moderation queues** (repo.ts:2138, :2421); the
    second aggregates the entire `player_reports` table with no `WHERE` at all.
12. **47 exports with zero importers and zero string references**, incl. `simGameOf`,
    `adminRefundPayment` (a whole HTTP client call), `useAnyoneQueued` (a whole React hook),
    and the `listPresets`/`savePreset`/`deletePreset` trio with no route. `chain/config.ts:633`
    says outright "Nothing reads these at runtime any more".
13. **Large duplication between `chain/` and `biobuzz/`**: `parts.ts` (120 identical lines, doc
    comments included), `mounts.ts` (9 same-named functions), `drawRobot.ts`,
    `RobotPreview.tsx`. Three near-identical start editors; `specKey` defined 4 times with 4
    different field sets.
14. ⚠️ **Four m:ss formatters, and two disagree** — `replayOverlay.ts:67` uses `Math.ceil`,
    `ReplayView.tsx:52` uses `Math.round`. The clock burned into an exported video and the one
    in the viewer header can therefore read a second apart for the same frame. Smallest real
    bug in this list.
15. **`ago()` is byte-identical in three files** (`AdminLive`, `AdminReports`, `StandingCard`)
    while `src/ui/fmtDate.ts` exists and is the obvious owner.
16. **`scripts/zz-accept.ts` is superseded by `zz-accept-clean.ts`** by its own header — the
    original measures against artifacts it thinks it removed. Both say "throwaway".
    `zz-mm-quality.ts:4` references a `zz-mm-marginal.ts` that does not exist.

### The game engine: measured, and deliberately left alone

Profiled per game and then actually tried an optimization, which is how I know not to ship
one. Inside `step()`: Rapier's rebuild-per-tick is ~23% of CPU, `separateParticles` (CR only)
7.6%, the possession/control penalty passes ~4.4%, everything else diffuse.

The 23% is the stateless Rapier world, which is a deliberate architecture choice — rebuilt
every tick so reconcile and determinism hold — so it is not available without the port CLAUDE.md
already has on the roadmap.

`separateParticles` rebuilds its whole spatial grid (a `Map` plus one array per occupied cell)
twice a tick for 300 particles, so pooling the memory looked free. **It was bit-identical and
21% SLOWER** — 0.222 → 0.267 ms/tick for CR, three runs each, low variance, verified
bit-identical by `worldHash` over 3,000 ticks across all three games before the timing was
even taken. V8's nursery beats manual pooling for short-lived small objects. Reverted.

The conclusion to carry forward: **the sim has no cheap safe win left.** Its allocation
pattern is not the bottleneck, and the thing that is, is deliberate.

⚠️ **Snapshot change detection was measured and deliberately NOT changed.** The per-ball
`JSON.stringify` in `broadcastSnapshot` is 45% of a Chain Reaction snapshot's cost (0.093 of
0.208 ms), but that is only ~0.28% of a core per room, and the alternative — a hand-written
field comparator — fails by MISSING a change, which is a silent client desync. The payoff does
not cover that failure mode.

Measured for reference, per-tick `step()` cost (32-thread box, 2v2): DECODE 0.50ms
(cores/room 0.030) · CR 0.28ms (0.017) · BIOBUZZ 0.37ms (0.022). Inside `step`, Rapier's
rebuild-per-tick is ~23% of CPU, `separateParticles` (CR only) 7.6%, the possession/control
penalty passes ~4.4%.

---

# HANDOFF — 2026-09-16 (alpha: the admin panel merged, five PRs merged, main backported)

**(Superseded as READ FIRST by the efficiency-audit session above; still the state of
`alpha` itself, which that branch has not been merged into.)** `alpha` and `main` are both
green and both pushed. **NOTHING IS DEPLOYED.**

`npm test` prints **ALL PASS twice** for the first time in a while — PR #69 fixed the stale
lan-gate asserts that had been failing on a clean tree since LAN went on in production on
2026-09-13, which (because the suites chain with `&&`) meant the BIOBUZZ suite had not been
running at all.

## Merged into alpha

| PR | what |
|---|---|
| #69 | the lan-gate asserts follow the config that moved under them — **this is what unblocked the second suite** |
| #58 | `stageBiobuzz` is idempotent: the hopper is cleared with the ball array, so a re-stage stops refusing its own preloads |
| #61 | a lossy LAN guest's snapshot delta is keyed to its **ACK**, not the last broadcast — **server** |
| #68 | a rematch cannot field a seat nobody is in; the format comes from the room, not a head count — **server** |
| #67 | a backgrounded ranked queue cannot lose the match it was given — client only |

Plus the **admin-panel** batch (its own section below).

Gates on alpha: `npm test` ALL PASS ×2 (BIOBUZZ 1317) · `test:mm` 186 · `dbtest` ALL PASS ·
`build` · `server:check` · `uiaudit` · `contrast`.

## main was CHERRY-PICKED, not promoted

`main` took those six changes only and is still **~28 commits behind alpha** (settle-based
finalize, the standing repricing, room recycle, the LAN tab host, the BIOBUZZ hive work). Same
gates, all green there (BIOBUZZ 1299 — fewer checks because main lacks the alpha-only features
those checks cover).

⚠️ **`src/standing.ts` conflicted and the two branches now price behaviour DIFFERENTLY ON
PURPOSE.** main keeps `afk: 12` / `leave: 15` / `card: 20`; alpha has the repricing (8 / 8,
yellow 5 with `RED_CARD_MULT` for red). Only the new `adjustment` kind was backported. **On the
next promotion this file will conflict again and ALPHA should win** — the repricing is the later
decision.

## Next steps

1. **Deploy the game server** from a **main** worktree (`./scripts/fly-deploy.sh`, never a bare
   `flyctl deploy`). Migrations 0035/0036 apply at boot; until then the admin panel's two new
   endpoints 404 and #61/#68 are inert.
2. Vercel picks up the client half on push (#67, the replay penalties).
3. Still outstanding: clear every infraction on `018fdc59-4e80-4a16-908c-682be86bfee8` —
   after the deploy, one press of CLEAR ALL INFRACTIONS in Admin → Moderation.
4. Neither #61's LAN path nor #68's rematch gate has been exercised against a live server; both
   are covered by driven smoke checks only.

---

# HANDOFF — 2026-09-15 (the admin-panel batch: misscore replays, score editing, replay penalties, standing edits)

**(MERGED into `alpha` and cherry-picked onto `main` on 2026-09-16 — see the section above.
Still NOT deployed.)** It is a SERVER change AND a MIGRATION change — two new migrations
(0035, 0036) that apply at game-server boot, so nothing here works until the Fly server is
redeployed.

Build green: `npm run build`, `npm run server:check`, `npm run contrast`, `npm run uiaudit`,
`npm run dbtest` (ALL PASS, +29 checks). `scripts/smoke.ts` passes +23 new checks.

⚠️ ~~**`npm test` is RED on alpha already, and not from this work.**~~ **FIXED by PR #69**,
merged 2026-09-16. Left below because the reasoning is why it mattered. Two stale checks —
`lan gate: alpha opens it; production does not mention it at all` and `lan gate: and
production still opens neither door` — assert that production's `fly.toml` mentions neither
`LAN_UPLOADS` nor `LAN_SIGNALLING`. Both were deliberately turned ON in production on
2026-09-13 (see that section below), and nobody updated the checks. They fail on `alpha` with
no changes at all. **The consequence is the one CLAUDE.md warns about: while the first suite
is red the BIOBUZZ suite never runs.** Either update the two checks to the fleet as deployed
or revert the config; it is a policy call, not a bug fix, so it was left alone here.

## What landed

1. **The misscore queue's WATCH button 404'd on every claim.** `listScoreReports` returned a
   MATCH id and the button passed it to `/api/replay/<id>`, which serves `replays.id`. It now
   carries `replayId`, joined through `matches.replay_id`; a claim with no stored match says
   "no replay" rather than offering a dead button. `onWatchReplay` is
   `(replayId, matchId?) => void` everywhere (`WatchReplay` in `AdminReports.tsx`).
2. **Score correction** — `GET/POST /api/admin/match`, `correctMatchScore`, migration
   **0035** (`match_score_corrections`). `won` is re-derived; **ratings are deliberately not**
   (Glicko-2 is sequential). The editor is `ScoreEditor` in `src/ui/ReplayRail.tsx`, offered
   only when `ReplayView` gets an `adminMatchId`, which only ever comes from the admin panel
   via in-memory state in `App.tsx` — never from the URL, which is shareable.
3. **Penalties on every replay, for everyone.** `src/sim/penaltyLog.ts` is the ONE place a
   sanction line is written and read (`awardFoul`/`awardCard` and BIOBUZZ's tariff wrapper
   both format through it); `ReplayPlayer.log` stamps each line with its tick and phase clock.
   The viewer has an always-on summary row and a seekable timeline in the rail. A solo record
   run shows one chip and reads its fouls as a deduction.
4. **Standing editing** — `GET/POST /api/admin/standing`, `adminEditStanding`, migration
   **0036** (`voided_at`/`voided_by`/`admin_id`/`note` on `standing_events`). A pardon VOIDS:
   `recentStandingCount` filters voided rows so escalation forgets them, and the row stays on
   the record. `src/standing.ts` gained an `adjustment` kind with a SIGNED cost — render every
   ledger row through `standingDelta`, never a hard-coded minus.

## Next steps

- **Nothing is deployed.** Merge to `alpha`, then promote and deploy the Fly server from a
  **main** worktree (see the 2026-09-13 note). The migrations run at boot.
- **Not yet exercised against a live server**: the two new admin endpoints have unit coverage
  in `dbtest` and typecheck against the server, but no request has been made to a running
  instance. First deploy, then open `/admin` → Moderation → search a player → STANDING.
- The owner asked to clear every infraction on `018fdc59-4e80-4a16-908c-682be86bfee8`. **Not
  done** — production DB and production HTTP reads are blocked in this environment, and the
  admin endpoint that would do it is on this undeployed branch. Once deployed it is one press
  of CLEAR ALL INFRACTIONS on that uuid.

## Gotchas found on the way

- **`ghost` + `primary` on one `.ds-btn` makes the label white on the page's own surface.**
  `.ds-btn.ghost` is declared after `.ds-btn.primary`, so it wins on `background: none` while
  primary's `color: var(--ds-accent-ink)` survives. It reads as a missing control. There is a
  `uiaudit` rule for it now at baseline 0.
- A replay's penalty list is built from `world.events`, so **the foul strings are now parsed,
  not just displayed** — changing one is still a server change, and now also breaks a reader.
  `npm test` round-trips the formatter against the parser.
- The default robot's start anchor faces its own goal: a full-throttle `driveX: 1` holds it
  flush against the goal for the whole match. Crossing the field from anchor 0 is `driveX: -1`.
  Cost several throwaway scenes before it was noticed; worth knowing when writing any headless
  scene that needs the robot to actually go somewhere.

---

# HANDOFF — 2026-09-14, later (account standing: behaviour charges WIRED, repriced — alpha only)

**(superseded as READ FIRST by the 2026-09-15 section above; still current for its own subject.)** On `alpha`, NOT deployed, NOT on `main`. It is a SERVER change: it does nothing
until the Fly game server is redeployed (from a main worktree — see below).

- **`persistBehaviour` was never wired into production rooms** (`server/index.ts` passed 7 of
  `Room`'s 8 args; `docs/multiplayer-architecture.md` §17.1 had flagged it). So in production
  the clean-match heal (+2), AFK, leave and card standing charges had NEVER fired — only dodges
  did. Now wired. ⚠️ Deploying it turns ALL of those on at once, for the first time against real
  matches.
- **Repriced (owner):** AFK 8 (was 12), leave 8 (was 15), yellow card 5 (was 20), red card 15
  (was a flat 40 override). A red is now `severity: RED_CARD_MULT` (3) through the ladder, so it
  rides the repeat multiplier like every other kind (a 2nd red in the week costs 23, a 2nd
  yellow 8). Cooldown/rating ladders unchanged.
- **Leaving a 1v1 is not charged** (`chargedForParticipation`, `src/standing.ts`); leaving a 2v2
  is. AFK is charged in both. An excused 1v1 leaver is NOT credited clean either. The 1v1 match
  is still rated, so the leaver still takes the loss.
- Verified: `server:check` and client `tsc` clean; the changed standing checks run green through
  the real functions in a scratch script. Full `npm test` NOT run (owner preference); the smoke
  checks in `scripts/smoke.ts` were updated to the new values.

---

# HANDOFF — 2026-09-14, early (settle-based finalize LIVE, PR 65 landed, all night fixes shipped)

**What production is running.** Fly release **v111** = `main` @ `b09f12e`, deployed
from a main WORKTREE (never this alpha tree — `fly-deploy.sh` builds whatever tree it runs in).
Everything below the line is on BOTH `main` and `alpha`.

- **LIVE: a match is finalized when the field comes to rest, and the score is shown only then**
  (`34bf3a2` main / `6326a6b` alpha). New `src/sim/settle.ts`: `settleStep` finalizes once the
  game's `GameSimModule.settled` has held for `MATCH_SETTLE_HOLD_S` 0.5 s, capped at
  `MATCH_SETTLE_MAX_S` **10 s — the owner's absolute maximum, do not raise it**. DECODE
  (`decodeSettled`): nothing in flight, nothing pending or moving on a rail, ground/basin
  artifacts and robots at rest. CR (`chainSettled`): no non-staged particle in flight, ground
  particles and robots at rest. BIOBUZZ (`bbSettled`, `src/games/biobuzz/settle.ts`): nothing in
  flight, no hive swinging or loaded past its tip, ground elements and robots at rest. The server
  (`room.ts` `stepOnce`) and solo practice (`game.ts`) share the clock, in ticks.
  `MATCH_SETTLE_S` / `MATCH_RESULT_REVEAL_MS` are DELETED. Client: the results screen reveals only
  on `HudSnapshot.resultFinal` (online = the server's `matchResult` arrived; practice = its own
  settle) and shows the SERVER's totals; the live HUD, replay viewer and burned-in video say
  MATCH OVER until then and FINAL only on the finalized score; `resultLost` says so if the result
  never comes. `maxMatchTicks` carries the 10 s cap. Measured: an idle DECODE or CR run finalizes
  on the 0.5 s hold (no jitter); a rolling artifact held it to 116 ticks.
  ⚠️ **Known to bind:** a BIOBUZZ tip that sets off a SECOND tip can outlast 10 s; PR 65's rule
  (below) still pays a swing the cap cuts off.
- **LIVE: PR 65, a BIOBUZZ tip caught by the buzzer scores and its load is not deducted**
  (`7d0331c` main / `04ce456` alpha; its check moved onto the settle clock in `b09f12e` /
  `41865e7`). Landed as CLEAN commits and the PR CLOSED, not merged: its own commits were
  authored `Claude <noreply@anthropic.com>` with `Co-Authored-By`/`Claude-Session` trailers, and
  the owner wants no attribution anywhere. No `BALANCE_VERSION` bump (owner's call).
- **LIVE (since v110): a cancelled ranked match cannot be cancelled again** — no longer held; see
  the section below. **LIVE: a solo record run left after the buzzer is still saved** (the room
  keeps stepping with nobody connected until it finalizes).
- ⚠️ **A gated shell chain lied once tonight:** `grep -c` exits 1 on a count of 0, so
  `X=$(… | grep -c …) && cd worktree && …` stopped before the `cd` and the "main" tests ran on
  alpha. The push gate caught it. Use `|| true` on counts and guard every `cd`.
- `npm test`'s shared suite still ends at the 2 pre-existing `lan gate` failures. Alpha still
  carries unreviewed BIOBUZZ commits that are not on main (see the review note below).

# HANDOFF — 2026-09-13, night (production hotfixes: record-room reap LIVE, dodge double-cancel shipped in v110)

Superseded by the section above. Deploys go from a MAIN worktree, never this alpha tree; killing
a background deploy does NOT kill its `flyctl` child, so run deploys in the foreground. (v108,
built from alpha by mistake, was live for about 5 minutes around 01:19Z and was replaced.)

- **LIVE: a solo record run closed on purpose frees its room at once** (`f0e0430` main /
  `df5872d` alpha, `server/room.ts` `detach(id, conn, clean)`, `server/index.ts` close code).
  Record-run restarts used to hold the old `rec-` room for the 45 s reconnect grace, still
  simulating. At the BIOBUZZ launch spike iad sat at 24/24 with 8-12 real runs and refused new
  ones as `region_full`, which the Record Run screen shows as "Couldn’t start". A close with
  code 1000/1005 on a solo record room now reaps immediately. 1006 (network) and 1001 (tab)
  keep the grace, and so does every room with a second driver.
- **SHIPPED in v110 (was held earlier that night): a cancelled ranked match can no longer be
  cancelled a second time** (`28575be` on alpha, `406f506` on main).
  `cancelPending` left `pendingMatch`/`phase` set, and a socket's `room` is never cleared. So
  the first player to leave the cancelled screen re-ran the cancel from `detach` and was billed
  a STRATEGY BAIL. The innocent driver was shown "Nothing was charged to you" and then lost
  standing anyway; the player who never readied was billed twice. Smoke reproduces it: 3
  charges without the fix, 1 with it. **Standing already lost this way is not refunded:** the
  false rows are `standing_events` kind `dodge` whose `room_code` also carries a legitimate
  charge to the other player.
- `npm test`'s shared suite still ends at the 2 pre-existing `lan gate` failures (below).
- Unreviewed alpha content not on main (review summary): BIOBUZZ hive tip rate / spill / miss
  bounce and LEAVE-from-start-wall change scoring and RNG draw counts with no `SIM_VERSION`
  bump; `startWalls` is read without a guard, so an alpha client against a main server throws in
  online BIOBUZZ. Deploy the server before clients, or guard it, before promoting.

# HANDOFF — 2026-09-13, later (BIOBUZZ hive feel: tip rate, spill scatter, miss bounce, canopy)

Branch **`claude/hive-physics-rendering-tjz7mj`**. Four owner-reported HIVE items, all inside
`src/games/biobuzz/` (nothing shared touched). Gates: `npx tsc --noEmit -p .` clean,
`server:check` clean, `test:bb` **1289 ALL PASS**, `npm run build` ok. Full `npm test` run to the
end: the shared suite reports **2 FAILURES, both PRE-EXISTING and not this branch's** — `lan gate:
alpha opens it; production does not mention it at all` and `lan gate: and production still opens
neither door`. They assert `fly.toml` carries no `LAN_UPLOADS` / `LAN_SIGNALLING`, and the
2026-09-13 promotion (below) deliberately put both in `fly.toml [env]` to turn LAN on for
production. The check is stale against that owner decision; the files it reads are untouched by
this commit. Whoever owns the LAN policy should either retire those two checks or drop the flags.

**MERGED INTO `alpha`** (`f3f74dc`), no conflicts: alpha's own `state.ts` change adds `startWalls`
to `BiobuzzState` while this one adds `swingRate` to `BbHiveState`, and alpha's HUD change only
moves the `tipping > 0` readout from a chip to the score bar's `cellLine`, which this preserves.
Gates on the MERGED tree: `tsc` / `server:check` / `build` / `uiaudit` clean, `test:bb` **1294 ALL
PASS**.

⚠️ **A SEPARATE ALPHA BUG WAS FIXED TO GET A GATE AT ALL** (`scripts/smoke.ts`, own commit). Alpha's
LAN commit `d14895b` added a check reading `roomSrc` ~126 lines ABOVE the `const roomSrc` in the same
block, so it threw `ReferenceError: Cannot access 'roomSrc' before initialization` and **aborted the
whole shared suite** — which, being `&&`-chained, also meant the BIOBUZZ suite never ran under
`npm test` at all. The read is hoisted to its first use. The two checks involved now run and pass,
and the shared suite completes at its 2 pre-existing LAN gate failures. Nothing else moved.

- **A heavier tray tips faster** (`hive.ts` `hiveSwingRate`, `hiveSurplus`). The 4 s swing is
  the swing of a tray at EXACTLY its tip-table threshold; each element over the threshold adds
  `BB_TIP_RATE_PER_EXTRA` 0.35 to the rate, capped at `BB_TIP_RATE_MAX` 3. The surplus is
  measured against `BB_TIP_POLLEN`, so every row's threshold load still takes 4.0 s and every
  existing timing check is untouched. Pre-release the rate reads the live contents (the cell
  keeps taking, so feeding a swinging tray speeds it up — measured: 2 pollen dropped in at
  0.5 s settle it at 2.57 s instead of 4.0); post-release the rate is carried in the NEW
  optional `BbHiveState.swingRate` (absent when settled and on old snapshots = nominal).
  `tipping` stays in nominal seconds, so `tipProjection` / `tipProgress` are unchanged.
- **Spill scatter** (`hive.ts`): `BB_SPILL_SPEED` [35,62] → **[30,62]**, `BB_SPILL_FAN` 18° →
  **40°**, plus a new all-directions **`BB_SPILL_KICK`** 12 in/s. Every pose still leaves
  outboard by construction (23 in/s outboard minimum vs a 12 kick). `spillPoses` now draws SIX
  rng values per pose. `docs/biobuzz/feedback/001-spill-kinematics.md` has the addendum.
- **A miss bounces off the structure** (`hive.ts` `hiveDeflect`, called from `play.ts` after
  the capture loop for BOTH hives). The assembly is an APPROX box (`BB_HIVE_W` × `BB_HIVE_LEN`,
  `BB_HIVE_BOTTOM_Z`..`BB_HIVE_OPEN_Z[1]`) with: the two long sides, the DOWN cell's outer end
  and the underside solid; an interior PIVOT PLANE (y = 0) solid; **no top** (a descent from
  above is the capture test's business, and a top is a shelf a ball could rest on); and the
  **TAKING cell's outer end OPEN at every height** (`hiveTakingSide`, so it follows the
  release). ⚠️ That mouth exemption is load-bearing: with the face solid, the dumper parked at
  the lip and Aim Assist's flat lobs (which cross the lip a hair before apex, still climbing)
  were ALL refused — 8 checks red. Bounce is `BB_HIVE_MISS_REST` 0.3 on the normal,
  `BB_HIVE_MISS_TANGENT` 0.5 on the rest, vz kept on a side hit. Measured: a 150 in/s shot into
  the red hive's flank lands 18.8 in short of the face on the side it came from; the same shot
  at 70 in clears the top and lands downrange.
- **Translucent canopy** (`drawField.ts` `drawHiveCanopy`, called from `draw.ts` between the
  low and high element passes). The renderer draws field → robots → elements, so a robot under
  the hive was painted OVER it. The canopy repaints the body, the up cell's fill and its
  contents row at `CANOPY_A` 0.42 over the assembly's own footprint, after the robots and the
  ground/low-flight elements and before the airborne ones (split at `BB_HIVE_BOTTOM_Z`). The
  contents row is now `drawCellContents`, shared by the field pass and the canopy. Not a
  `globalAlpha` on the sprite — the ruling is the PORTION under the hive, not the robot.
- No `SIM_VERSION` bump was made (owner's standing call on this branch); spill RNG draw count
  and the miss bounce both change sim output for the same inputs.

---

# HANDOFF — 2026-09-13, late (DEPLOYED: alpha is production, BIOBUZZ is public)

- **`main` is `088addb`** (alpha fast-forwarded onto it and pushed; this handoff note is on alpha
  only, so a docs commit does not rebuild the site). Vercel production serves it
  (`https://www.playdsim.com/version.json` → `088addb`, `/biobuzz` in the sitemap).
- **BIOBUZZ is public**: `src/seasons.ts` has no `channels` for it. The crawler files were edited to
  match (`public/sitemap.xml`, `public/robots.txt`, the static nav and the four home-description
  copies in `index.html`), as the BIOBUZZ suite requires. `test:bb` 1272 PASS, `npm run build` ok.
- **Production game server deployed** with `./scripts/fly-deploy.sh` (the owner said to skip the
  in-game warning; the countdown was cancelled before it deployed anything). Verified after:
  every machine on one image; iad `performance-2x`/4096; ord, sjc, lhr `performance-1x`/2048;
  gru, jnb, syd, nrt `shared-cpu-4x`/1024 (stopped until someone connects); `/health` ok;
  `/api/perf` `admitting:true` on every started machine; `/api/presence` caps `party,lan`;
  `/api/seasons`: DECODE Act 2 · S1 (bv 7), Chain Reaction Act 2 · S1 (bv 5), BIOBUZZ Act 1 · S1 (bv 4).
- **Alpha preview deployed** too (`--alpha`), healthy, caps `party,lan`.
- **Announcements published** from `docs/announcements/biobuzz-act1-season1.md`: a `season` reveal
  and the `patch` notes.
- The room-leak fix (`8e2ea2b`) is now live in production, so `iad` should no longer need restarts.
- `ADMIN_SECRET` lives in `D:\Projects\2ddecodesim\.env`; load it into one command, never print it.

---

# HANDOFF — 2026-09-13 (preparing the alpha → production promotion)

Branch **alpha**, pushed. `npm run server:check` clean; the new room-leak smoke check was run in
isolation and mutation-checked (fails without the fix). The full `npm test` was NOT run (owner).
**Nothing deployed to production — the owner said not to until the promotion is ready.**

## (was READ FIRST) — production `iad` was refusing every new room

`/api/perf` on the always-warm primary read `rooms: 0, admitting: false`, and its log was a wall
of `[admit] refused room rec-…: at cap (24/24)` from at least 04:53 UTC. US-East players could not
start a record run or a custom room at all.

**Cause:** `finalizeMatch` stops the room's loop and keeps the room for the results screen, but
the reconnect grace is only ever checked BY that loop. A driver who closed the tab from the
results screen was held forever and the room never deleted — one leaked room per finished match
someone walked away from. Satellites auto-stop and start clean; `iad` never does, so only it
filled up.

- **Mitigated:** `iad` (6836e6dc0e2348) restarted 2026-09-13 with the owner's go; it read
  `admitting: true` 43 s later.
- **Fixed on alpha only:** `8e2ea2b` (`Room.armGraceReap`). The owner chose to ship it WITH the
  promotion, so **production will leak again until then.** If `/api/perf` on `iad` shows
  `admitting: false` with few live `rooms`, restart that machine (ask first). The scheduled
  checkup below flags exactly this as URGENT.

## Update, later the same day: PRs merged, main merged, LAN on, launch fleet sized

All on alpha, **still not deployed**.

- **main merged into alpha** (`a335bb0`). One conflict, the HUD chip block in `GameView.tsx`,
  kept as alpha had it. `fly-deploy.sh`, `fly.toml` and `.env.example` now carry main's fleet.
- **PRs #45, #60 and #57 merged** (`a4dd082`, `7d301f5`, `3b1d3c9`). #57's three conflicts kept
  both sides. Its replay start-pose snap was gated on `startLegality`, which BIOBUZZ sets too, so
  it became a per-game hook, **`GameSimModule.startSnap`**: DECODE fills it with the same G304
  snap; BIOBUZZ and Chain Reaction keep their field-clamped pose. **No `SIM_VERSION` bump**
  (owner): some pre-deploy replays may play back differently from what happened.
- **LAN is ON for production**: `LAN_UPLOADS` and `LAN_SIGNALLING` in `fly.toml [env]`. The client
  lights LAN from the server's `lan` capability, so Vercel needs nothing. Migration
  **`0034_lan_runs_biobuzz.sql`** widens `lan_runs.game` to accept BIOBUZZ, which 0033 refused.
- **Launch fleet, from `docs/capacity.md`** (one machine per region is a hard rule, and one
  process uses about one core, so a dedicated core is the only size step that adds rooms):

  | region | size | why | $/mo if never stopped |
  |---|---|---|---|
  | iad (primary, matchmaker, API) | `performance-2x` / 4096 | dedicated core for the loop; 2nd core for GC and every socket's deflate | 64.39 |
  | ord, sjc, lhr | `performance-1x` / 2048 | real traffic; ~8–10 driven rooms, never throttled | 32.19 each |
  | gru, jnb, syd, nrt | `shared-cpu-4x` / 1024 | rarely host; 4x's baseline held 2 rooms / 8 players | 8.08 each |

  Satellites auto-stop and bill only rootfs while stopped, so their real cost is only while
  someone plays. Worst case, all eight never stopping: **~$193/mo** (today's worst case ~$31).
  Rough ceiling with margin: ~60 driven rooms fleet-wide, roughly 90 concurrent players at the
  real solo/1v1/2v2 mix, ~130 at redline. Past that, the fix is `SIM_WORKERS`
  (`docs/scaling-multicore.md`), not bigger VMs or a second machine per region.
  `fly.toml [[vm]]` is the primary's size; `scripts/fly-deploy.sh` `SATELLITE_SIZES` puts each
  satellite on its own after the deploy. Checked with `bash -n` and a dry run of the lookup.
- ⚠️ **gru and jnb still do not host CROSS-region matches** (`DEPLOY_REGIONS` unchanged). Adding
  them failed 8 `test:mm` checks: their real distances to syd/nrt and to each other (315–395 ms)
  are above `RTT_UNKNOWN` (300), so a real far pair looked like a missing row. They do host every
  room their own players open.
- Gates run for this: `npx tsc --noEmit -p .` clean, `server:check` clean, `test:bb` 1270 PASS,
  `test:mm` 186 PASS, `uiaudit` at baseline, `dbtest` ALL PASS (0034 applied). Full `npm test` NOT run (owner).

## Promotion checklist

1. **BIOBUZZ is still hidden on stable.** `src/seasons.ts` has `channels: ['alpha']` and the blurb
   "Rules land at kickoff on 2026-09-12." Both must change for it to appear in production. The
   CLAUDE.md BIOBUZZ section still describes a placeholder, alpha-only, unscored shell — stale.
2. **Open PRs to alpha** (reviewed 2026-09-13, nothing merged):
   | PR | verdict | why |
   |---|---|---|
   | #45 | **URGENT** | any socket can send a malformed `input` (NaN, `ld: 1e9`) into the authoritative world broadcast to the room. Server-only, merges clean, `test:mm` 186 pass on a trial merge |
   | #57 | recommended | real client/sim fixes (auto-path waits, replay `coerceSetup`); CONFLICTS in 3 files (trivial). Changes sim output for two narrow inputs without a `SIM_VERSION` bump — decide. Its `coerceSetup` gate keys on `startLegality`, which BIOBUZZ now sets, so BIOBUZZ replays still get DECODE's snap |
   | #60 | recommended | solo practice saves its score before the 2.8 s settle; practice-only, clean |
   | #58 | defer | `stageBiobuzz` idempotency; no shipped path calls it twice |
   | #61 | defer | LAN guest ack-keyed deltas; LAN is off in production; the shared WebSocket path measured byte-identical |
3. **Merge `origin/main` into alpha before promoting.** main has 10 commits alpha lacks (the
   ord/gru/jnb fleet, satellites at 512 MB, `fly-deploy.sh` re-shrinking all 7 satellites, fly.toml
   notes, the 8-region `.env.example`, a replay fix, controls copy). ⚠️ Deploying production from
   alpha's current `scripts/fly-deploy.sh` would re-shrink only 4 satellites, leaving ord/gru/jnb on
   fly.toml's `shared-cpu-4x`, and put the rest back on 1024 MB. A trial merge has ONE conflict:
   the HUD chip block in `src/ui/GameView.tsx` (both sides removed the pose readout) — take alpha's.
4. **Seasons.** Production: DECODE Act 2 · Season 1 (bv 7), Chain Reaction Act 2 · Season 1 (bv 5).
   `BALANCE_VERSION` is 4 on both branches and `currentSeasonNumber` returns each game's existing
   max, so **the deploy does not advance DECODE or Chain Reaction.** BIOBUZZ has no production rows
   (today's prod server coerces `biobuzz` to DECODE, so `/api/seasons?game=biobuzz` shows DECODE's
   list); the new server seeds `(biobuzz, 4, act 1)` on first use — alpha's database already holds
   exactly that. **Do not use the admin season/act roll for this launch.**
5. **Migrations:** none differ between main and alpha. `lan_runs` has `check (game in ('decode',
   'chain'))`, harmless while LAN is off in production, but it refuses a BIOBUZZ LAN upload on alpha.
6. **Announcements:** `docs/announcements/biobuzz-act1-season1.md` (a `season` reveal + `patch`
   notes), with a pre-publish checklist. Publish only after the deploy is verified.
7. **Order:** merge #45 (and any other chosen PRs) → merge main into alpha → full gates (`npm test`,
   `test:mm`, `dbtest`, `build`, `server:check`, `uiaudit`) → alpha into main →
   `scripts/announce-deploy.sh` (players are online) → verify `/health`, `fly machine list` sizes,
   `/api/perf` `admitting` on every started machine, `/api/seasons` per game → Vercel production →
   publish the announcements.

## Capacity — recommendation, NOT applied

Load today is tiny: 3 online; `iad` 0.02–0.04 cores; alpha ran 2 rooms / 8 players at 0.17 cores.
`npm run costprobe` (sim-only, laptop): a BIOBUZZ solo room costs 0.0245 cores (same as DECODE), a
2v2 0.0345; 10.2 / 38.4 KiB/s per client on the wire. Size on `docs/capacity.md`'s driven 0.075.

- **`iad`: `shared-cpu-4x`/1024 ($8.08/mo) → `performance-1x`/2048 ($32.19/mo).** The only size step
  that adds rooms: a dedicated core never throttles (~8–10 driven rooms against 5–8), and two rooms
  with 8 players already sat on the 4x sustained baseline (0.244 of ~0.25 cores, 2026-09-06).
  `shared-cpu-8x` buys nothing — one process uses one core.
- **`ord` and `sjc`: `shared-cpu-1x`/512 → `shared-cpu-4x`/1024 for the launch.** A 1x baseline is
  about one busy room. They auto-stop, so the extra ~$4.76/mo each is only paid while awake.
  Needs per-region sizes in `scripts/fly-deploy.sh` (today one `SATELLITE_SIZE` for all seven).
- Everything else stays `shared-cpu-1x`/512. Never a second machine in a region (room codes route
  by region); past `performance-2x` the fix is `SIM_WORKERS` (`docs/scaling-multicore.md`).

**Scheduled checkup:** the Claude desktop task `dsim-capacity-checkup` runs every 3 hours while the
app is open. It is read-only (machine list, `/api/perf` per started machine via
`fly-force-instance-id`, presence, log signals), recommends only, and keeps a history in
`C:\Users\geniu\.claude\scheduled-tasks\dsim-capacity-checkup\history.jsonl` so a downscale is only
ever suggested after 7 days of low readings.

---


---

# Older sessions

Sessions before 2026-09-12g are in **`docs/handoff-archive.md`** — moved there on
2026-09-16, unedited. This file had reached 5,888 lines and is read at the start of every
session; the archive keeps the history without charging every session for it.
