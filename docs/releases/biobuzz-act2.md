# BIOBUZZ Act 2 release (alpha → main)

Prepared 2026-09-24 against `origin/alpha` @ `5e56964b`. Nothing here has been run yet.

What ships: 439 commits (381 non-merge) from `alpha` onto `main`. `main` (`fae45c2a`) is an
ancestor of `alpha`, so the merge is a fast-forward. BIOBUZZ opens Act 2 · Season 1.
DECODE (Act 2 · Season 1, season key 7) and Chain Reaction (Act 2 · Season 1, key 5) do not
move: `BALANCE_VERSION` stays 4 on both branches and `currentSeasonNumber` takes the larger of
it and the DB, so neither game rolls on its own.

## 1. Before the merge

### Blockers

1. **FIXED on alpha (owner, 2026-09-24: Act 1's 2D records stay on the boards).** The board era
   is now per season; see `docs/area/accounts.md`, "THE ERA IS PER SEASON". What it was:
   **BIOBUZZ Act 1 · Season 1 record-holder badges would go to nobody.**
   `recordSeasonGrants` (`server/db/repo.ts:1500`) reads `recordLeaderboard` with its default
   physics, and `boardPhysics` returns `'3d'` for BIOBUZZ for every season. Migration 0039 stamps
   every existing record `'2d'`, so the closed season's board reads empty. `payPeriod` still
   claims the period with `winners = 0`, which marks it paid for good. The 8,586 Act 1 records
   earn nothing, or worse, the podium is whoever sets a 3D record between the deploy and the
   roll.
   The same filter empties the archived Act 1 board on the site: `/api/leaderboard` ignores a
   `physics` parameter and always uses `boardPhysics` (`server/api.ts:1710`), so after the
   deploy BIOBUZZ Act 1 · Season 1 shows no records at all. `docs/deploy.md` records "no 2D
   BIOBUZZ board" as the owner's ruling from 2026-09-18, made before an act roll was planned.
   Fix: make board physics a property of the season, not the game. An archived season uses the
   physics its rows were played on; the live one stays `'3d'`. Both `recordLeaderboard` calls
   in `recordSeasonGrants` and the archived-board read go through it. Add a dbtest case: a
   closed BIOBUZZ season of `'2d'` rows shows on its board and pays its top 3. The ranked
   podium is unaffected (`eloLeaderboard` has no physics filter; Act 1 has placed players on
   both ladders).
   If the owner keeps the 2026-09-18 ruling, no code change is needed, and the notes must not
   promise record-holder badges or a viewable Act 1 board for BIOBUZZ.

2. **Freeze alpha.** Other sessions are still pushing. Pick one commit, run the gates in §2 on it,
   and merge exactly that SHA.

### Decisions for the owner

3. **Production Fly secrets for account linking.** `dsim-alpha` has these and
   `dohun-sim-decode` does not: `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`,
   `GITHUB_TOKEN` (needs `public_repo`), `GITHUB_STAR_REPO`, `DISCORD_OAUTH_CLIENT_ID`,
   `DISCORD_OAUTH_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `PUBLIC_ORIGIN`,
   `APP_ORIGIN`. Without them GitHub/Discord linking, the stargazer badge and the booster perk do
   not work in production. A GitHub OAuth app has one callback URL, so production needs its own
   GitHub app (callback on `dohun-sim-decode.fly.dev`); the Discord app can take a second
   redirect. Set them with `fly secrets set --stage` so they apply with the deploy. If they are
   not set, cut the stargazer and booster lines from the notes and posts below.
   `MODERATION_API_KEY` and `MODERATION_BLOCKLIST` are already staged on production and go live
   with the deploy.

4. **Satellite sizes.** The capacity task moved gru, syd and nrt to `performance-1x` on 09-23.
   `fly-deploy.sh` resets them to `SATELLITE_SIZES` (`shared-cpu-4x`) and now also applies
   `MAX_ROOMS=6` (satellites currently run 24). Every online BIOBUZZ room becomes a 3D solve,
   which costs more per room. Run `npm run costprobe` and either copy the task's sizes into
   `SATELLITE_SIZES` before deploying or accept the reset and let the task re-grow them.

5. **Discord Activity.** It ships in this merge, but nobody has launched it in a real Discord
   client since the frame-ancestors fix (HANDOFF 2026-09-23). Leave it out of the announcements
   until someone does.

### Small fix worth taking

6. `scripts/fly-deploy.sh` has a mis-merged block: `update_rc=0` and its end-of-run report sit
   inside the `--alpha` branch (lines 41, 48–51), where nothing sets it. On the production path
   a failed satellite re-shrink prints one `!!` line and the script still exits 0. Move the init
   above the `if [ "$ALPHA" … ]` and the report to the end of the production path.

## 2. Gates on the frozen commit

Run in a clean worktree of the frozen SHA:

```
npm test          # known flake: PREDICT_FULL_BUDGET_MS under load; rerun alone
npm run test:mm
npm run dbtest    # migrations 0037–0049 + the reward job
npm run build
npm run server:check
npm run uiaudit
npm run docaudit
npm run contrast
npm run bundleaudit
```

Then two rehearsals:

- **Migrations on real data.** In the Neon console, branch the production database
  (`rehearsal-act2`). Boot the frozen server locally against it
  (`DATABASE_URL=<branch url> npm run server:start`) and read the log: 0037–0049 apply, the boot
  reward job pays DECODE and Chain Reaction Act 1 (their closed periods), no errors. Then roll
  BIOBUZZ against the branch with the curl in §3 step 6 and check `reward_periods`:
  `biobuzz / record_season / 4` and `biobuzz / ranked_act / 1` both have `winners > 0`. Delete
  the branch afterwards.
- **Alpha.** `dsim-alpha` already runs this code. Play one BIOBUZZ custom room, one ranked or
  record run and one DECODE match on `alpha.playdsim.com`.

## 3. Release

Deploy order is client first, then server (`docs/deploy.md`, "Deploy ORDER"): the new server
refuses BIOBUZZ clients without the `bb3d` capability, so Fly before Vercel locks every
production BIOBUZZ player out until their tab reloads. The maintenance window covers the gap
between the two.

`ADMIN_SECRET` is in `D:\Projects\2ddecodesim\.env`. Load it into the command; don't print it.
`GS=https://dohun-sim-decode.fly.dev`.

| step | action | check |
|---|---|---|
| T−60 min | Schedule maintenance: `curl -X POST "$GS/api/admin/maintenance?active=1&startsAt=<ms>&endsAt=<ms>&msg=DSIM+BIOBUZZ+Act+2+update&secret=$ADMIN_SECRET"` (or the admin console). Post the heads-up in the DSIM Discord. | `/api/presence` shows `maintenance`, `biting:false` |
| T−0 | Window starts. Admins still get in. | `biting:true`; `/api/presence` rooms drain |
| 1 | Neon: create branch `pre-act2-2026-09-xx` from production. This is the restore point. | branch listed |
| 2 | Merge: `git push origin <frozen-sha>:main` (fast-forward; `main` is not protected). | `git log origin/main -1` = frozen SHA |
| 3 | Wait for the Vercel production build of `main`. | `https://www.playdsim.com/version.json` shows the frozen SHA |
| 4 | Fly, from a **main** worktree, foreground: `./scripts/fly-deploy.sh`. Never a bare `fly deploy`. | exits 0, no `!!` lines |
| 5 | Verify the fleet. | `fly machine list -a dohun-sim-decode`: one image, all 1/1, sizes as intended. `/health` ok. `/api/seasons?game=decode` still `current 7, act 2`; `chain` still `current 5, act 2`. Fly logs: migrations to 0049, `[rewards]` lines for DECODE/CR Act 1. |
| 6 | Roll BIOBUZZ: admin console → Seasons → BIOBUZZ → Start new ACT, or `curl -X POST "$GS/api/admin/season/start?game=biobuzz&act=new&announce=0&secret=$ADMIN_SECRET"`. `announce=0` because step 8 publishes our own copy. | response `{"season":5,"act":2,"seasonNo":1}`; log `[rewards] roll paid N grant(s)`; `/api/seasons?game=biobuzz` `current 5`; DECODE and Chain unchanged |
| 7 | Smoke as admin: one BIOBUZZ practice and one custom room (3D), one DECODE and one Chain Reaction match, open a replay, check the badge claim dialog on an account that placed in Act 1. Don't set a BIOBUZZ record before step 6. | no console errors |
| 8 | Publish in the admin console: an `act` announcement (title `BIOBUZZ · Act 2 · Season 1`, tagline `A NEW ACT BEGINS`, body below), then the `patch` announcement (§4). | `/api/announcements` lists both |
| 9 | Lift maintenance: `curl -X POST "$GS/api/admin/maintenance?active=0&secret=$ADMIN_SECRET"`. | `/api/presence` `maintenance:null` |
| 10 | Post the DSIM Discord announcement (§5). The public FTC post (§6) can wait a day until the release has held up. | |
| 11 | Afterwards: HANDOFF entry, watch `/api/perf` and the capacity task for 3D room load, optional desktop build (`ELECTRON=1`) for the Google sign-in pop-up. | |

Act announcement body:

> BIOBUZZ is 3D. Act 2 opens with fresh boards and ranked ratings, and Act 1's top drivers
> get their badges.

### What players lose, stated in the notes

- BIOBUZZ ranked ratings reset and re-enter placements (new act). Record boards start empty (new
  season). Act 1 records stay viewable on the archived season only with blocker 1's fix.
- Online BIOBUZZ is 3D-only.
- `SIM_VERSION` goes 2 → 3 in production with this merge (it has been 3 on alpha since
  2026-09-19; the owner declined a further bump). Older replays in every game still play but
  are labelled "the ending may land differently". Scores on the boards are unaffected.

### Rollback

- **Client:** Vercel dashboard → Deployments → promote the previous production deployment
  (`fae45c2`).
- **Server:** `./scripts/fly-deploy.sh --image registry.fly.io/dohun-sim-decode:deployment-01M2QEASVSKMCP9322B3RQ532W`
  (the image running now). Roll back client and server together: an old client on the new
  server is locked out of BIOBUZZ.
- **Database:** migrations do not roll back. The old server should run on the new schema (the
  migrations add tables and columns; 0049 clears `profiles.title`, which old code reads as no
  title). Restore from the step 1 Neon branch only for data damage; it loses every write since.
- **The act roll cannot be undone** cleanly (a `seasons` row and paid grants). Roll only after
  step 5 passes.

## 4. Patch notes (admin console, kind `patch`, title `BIOBUZZ · Act 2`)

Lines marked `[3]` need the §1.3 production secrets. Delete them before publishing if the
secrets are not set. Paste everything inside the fence.

```markdown
# Welcome to BIOBUZZ · Act 2 · Season 1

- **BIOBUZZ is 3D.** Every online match runs on 3D physics and is drawn in 3D by default.
- **Bots** to practice with and against, at three levels.
- **Badges** for the top ranked drivers and record holders of every past act and season.
- **Download any replay as a video**, in 2D or 3D.
- **DECODE and Chain Reaction do not change.**

## Before you play

- **BIOBUZZ opens Act 2 · Season 1.** Record boards start empty. Ranked ratings reset and re-enter placements.
- **Act 1 is kept.** Its boards, 2D records included, stay viewable under Act 1 · Season 1.
- **DECODE and Chain Reaction stay on Act 2 · Season 1**, with their boards and ratings as they were.
- **Older replays still play in every game.** Some show a note that the ending may land differently. Scores on the boards are unaffected.

## 3D

- **Every online BIOBUZZ match is 3D**: ranked, record runs and custom rooms. Solo practice can still pick 2D physics.
- **The 3D view is the default on every device.** Press T to switch to the 2D view.
- **The field comes from the official CAD.** The HIVE tips as a real see-saw, and each FLOWER is a real tube that elements stack in.
- **Graphics settings**: Auto, Low, Medium, High and Ultra presets, and a horizontal FOV slider from 60° to 120°.
- **Driver view**: enter your height and the camera stands at your eye level, with the whole field in frame.
- **A match waits for every driver's 3D to load**, for up to 20 seconds.

## Bots

- **Easy, Medium and Hard**, driving six different robot builds.
- **Practice**: pick a partner and two opponents, each None, Dummy or AI.
- **Custom rooms**: the host can seat bots. A room with a bot is unrated.

## Building

- **Three intakes**: Sweeper, Side rollers and Deployable ramp. Only an intake that reaches a FLOWER's opening can take from it.
- **The Box Tube is a two-stage vertical slide.** Drive its marker onto a FLOWER and press C for POLLEN or X for NECTAR.
- **The dumper is a catapult**, and turrets lead their shots while you drive.
- **Robots are capped at 18 in tall.**
- **Presets**: Pollinator (the new default), Forager, Skimmer, Sniper and StarterBot.
- **PASS to your partner** with V. Pick where the pass lands in the Driving panel.

## Fouls

- **G402 and G407 are billed every time**, not once per match.
- **G407** is a warning, and a MAJOR when the control is strategic.
- **G417 (ramming the HIVE) is removed.**

## Rewards

- **Ranked Champion, Finalist and Semifinalist**: the top 3 of each ranked ladder when an act ends.
- **Record Holder**: the solo record board's top 3, and each drivetrain's #1, when a season ends.
- **Past acts and seasons are paid too**, in every game, BIOBUZZ Act 1 included.
- **Claim each reward** when it arrives, then wear up to 3 badges beside your name.
- [3] **Star DSIM on GitHub** and link GitHub in Profile › Account for the Stargazer badge and a star decal.
- [3] **Boost the DSIM Discord** and link Discord for supporter perks while you boost.
- **Robot cosmetics**: chassis colour, accent, decal and number plate.

## Replays and history

- **Download a replay as a video**: 2D or 3D, MP4 or WebM.
- **Custom room games are saved to Match history**, including one-sided games and games with bots.
- **A game is saved even if everyone leaves at the buzzer.**

## Controls

- **A key another action already uses is refused**, and the screen shows which action holds it.
- **Each game keeps its own binds**, with shared controls under All games. The 3D view keys can be rebound too.
- **Gamepad combos**, and every menu works with a controller.
- **Touch controls on phones** for all three games.
- **Prediction** has moved to Settings › Network.

## Everything else

- **Tutorials** for BIOBUZZ and DECODE.
- **A new match results screen.**
- **Challenge a friend** to a rated match from the Friends panel.
- **Accounts**: reset a forgotten password, download everything we hold about you, and change your cookie choices at any time.
```

## 5. DSIM Discord announcement

Heads-up for T−60 (§3):

```
@everyone DSIM goes down for maintenance at <time> for the BIOBUZZ Act 2 update, for about 30 minutes. Finish your match before then. Matches already running are not cut off, but new ones can't start during the window.
```

Release post (after step 9):

```
@everyone **BIOBUZZ Act 2 is live.**

BIOBUZZ is now 3D. Every online match runs on 3D physics, on a field built from the official CAD. The HIVE tips as a real see-saw and each FLOWER is a real tube. T still switches to the 2D view.

**What's new**
• Bots at Easy, Medium and Hard. Practice with a bot partner against two bot opponents, or seat bots in a custom room.
• Badges. The top 3 of every ranked ladder get Ranked Champion, Finalist or Semifinalist when an act ends, and record holders get Record Holder when a season ends. Every past act and season is paid out today, so check your rewards when you sign in.
• Download any replay as a video, in 2D or 3D.
• Three intakes, a two-stage Box Tube, PASS to your partner, and robots capped at 18 in.
• Tutorials, controller menus, phone controls and a new results screen.

**Act 2 · Season 1**
BIOBUZZ record boards start empty and ranked ratings reset. Act 1 stays viewable on the boards, 2D records included. DECODE and Chain Reaction don't change.

Full patch notes are in the app under Changes. Play at https://playdsim.com. Tell us what breaks in #bug-reports.
```

Swap `#bug-reports` for the real channel. If the §1.3 secrets are set, add a bullet before
"Download any replay":
`• Star DSIM on GitHub or boost this server, then link the account in Profile › Account for the Stargazer badge or supporter perks.`

## 6. Public FTC Discord post

Check the server's self-promotion rules and post in the channel they allow.

```
**DSIM: a free FTC driver-practice sim, now with BIOBUZZ in 3D**

DSIM runs in your browser: https://playdsim.com. No install, and a desktop app if you want one.

• BIOBUZZ presented by RTX (2026–27), DECODE (2025–26) and Chain Reaction
• Build your robot: drivetrain, intake, launcher and where each one mounts
• Drive with a gamepad, a keyboard or a phone
• Solo record runs, 1v1 and 2v2 ranked, custom rooms with friends, and LAN rooms for a team meeting
• Bots from Easy to Hard to practice with or against
• Scored per the game manual, with fouls, and replays you can export as video

BIOBUZZ just moved to 3D physics on a field built from the official CAD, and Act 2 of its ranked ladder starts today.

Community and feedback: https://discord.gg/YB4tXnx7Pj

DSIM is a community project and is not affiliated with or endorsed by FIRST.
```
