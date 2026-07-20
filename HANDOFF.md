# HANDOFF — 2026-07-20 (friends: accept-bug hotfix DEPLOYED + blocked list) — READ FIRST

## This session — two friends fixes, both on `main` and shipped

Build green: `npm run build`, `npm run server:check`, `npm run contrast` (151). `npm test`
not re-run — nothing under `src/sim/` or `config.ts` was touched.

### 1. `55432d6` — "Accepting friend request says bad request" (SERVER, deployed to Fly)

**Root cause, confirmed against the production DB, not inferred.** All three pending
requests were from the account `ace` — a **3-character** username. The friends routes
validated the *target* name with the **claim-time** validator:

```ts
const USERNAME_RE = /^[a-z0-9]{4,20}$/;      // 4-char minimum
const username = normalizeUsername(body.username);
if (!username) return json(400, { error: 'bad request' }), true;
```

`'ace'` fails the 4-char floor, so the name was rejected **before the DB was ever
consulted** — an opaque 400 on accept, decline, block, everything naming that account,
with no way for either side to clear it. `ace` is the only one of 407 usernames that
fails today's rule (claimed 2026-07-07, presumably before the minimum was raised).

The diagnostic tell: `/api/profile/ace` worked fine. Those public routes do a plain
lowercase-and-look-up; only the friends block ran a format check. **A claim rule and a
lookup rule are different things** — that's the general lesson, and it's why the fix is a
split rather than a loosened regex:

- `lookupUsername` (`^[a-z0-9]{1,20}$`) bounds a key that names an EXISTING account and
  lets the DB decide existence. Used by every `/api/friends/*` route.
- `normalizeUsername` (unchanged, strict) stays where a NEW name is claimed
  (`/api/user/username`). Do not merge these back together.
- The 400 body is now `No player named.` rather than `bad request`.

Also closed the adjacent hole: **`/api/friends/request` now requires the SENDER to hold a
username.** 26 profiles have none; the recipient accepts by naming the sender *by
username*, so a usernameless sender would plant a row nobody could ever act on. The
`UsernameGate` normally guarantees one but deliberately doesn't trap users when its
profile fetch fails — which leaves exactly that hole.

**Deployed**: `flyctl deploy --remote-only`, all 5 machines healthy, `/health` ok.
Verified post-deploy that `POST /api/friends/accept {"username":"ace"}` now reaches auth
(401) instead of 400. The authenticated path was NOT exercised — that needs the user's
token. Those three requests from `ace` should now accept; worth confirming.

### 2. `96728d6` — blocked list + unblock (CLIENT only, Vercel auto-deploys)

Blocking was a one-way door **in the UI only**: `friends.data.blocked` was already
fetched every poll and `friends.unblock` was already wired to `POST /api/friends/unblock`.
The panel simply never rendered either. So this was pure presentation — no API, protocol,
or DB change.

- `FriendsPanel.tsx`: a **Blocked** section (rows + Unblock, plus a line on what a block
  does), between "Sent" and "Add a friend". Renders only when non-empty and starts
  **folded** (new `FoldSection`) — blocked players shouldn't hold permanent space in a
  panel otherwise about people you want to see, but an unblock buried in settings is worse.
- `FoldSection` is deliberately **not** `.fr-section`: that class is `display: flex`, and a
  flex `<details>` has a history of leaking its closed content in some engines. Plain block
  box, column layout on an inner `.fr-fold-body`.
- `shell.css` `.fr-fold`: summary reuses `.fr-sec-h` typography so a fold reads as a peer
  of the plain sections; the ▸ marker **rotates in place** rather than reflowing the header
  (a reflowing marker would move every row below it on open — see `npm run shiftaudit`).
- Unblock is `disabled` rather than sending `''` for a usernameless row. Unreachable in
  practice, but that empty-string lookup is the exact shape of the bug in §1.

**NOT visually verified** — the section only renders when you have a block, and that needs
your account. Production has exactly 1 `friend_blocks` row; if it's yours it'll appear.

### Branch state — `alpha`, `beta`, `main` are now IDENTICAL

Both were reset/fast-forwarded to `main` at `a9fc501`+.

Worth knowing before the next branch sync: `git rev-list --count` showed `beta` as **1
ahead** of main (`54e261d`, netcode anti-stutter — snapshot coalescing + prediction lead
cap + ping graph), which looks like unmerged work. **It is not.** That commit's content was
already ported to main wholesale — `MAX_PREDICT_LEAD 40`, `PING_INTERVAL_MS 300`,
`INTERP_DELAY_TICKS 5`, `PingGraph`, and `room.ts`'s `stepOnce(): boolean` coalescing are
all present on main under a different SHA. `git diff main beta` outside `HANDOFF.md` was
EMPTY.

**The ahead/behind count measures commits, not content.** A cherry-picked or
re-applied commit stays "ahead" forever. Trying to merge it back produced conflicts and a
`Duplicate function implementation` on `PingGraph` (tsc caught it — a resolution that only
removes conflict markers can still be wrong, so always build the merged tree). Diff the
trees before believing a branch holds unique work.

## Earlier session — MERGED `friendslist` → `main` + deployed to Fly

The friends list, Contributors page, and audio volume sliders (branch `friendslist`, 3
commits) were reviewed and **merged into `main`** (merge commit). All green on the merged
tree: `npm test` (smoke), `npm run contrast` (151), `npm run server:check`, `npm run build`.

- **Only conflict was `HANDOFF.md`** (docs) — resolved. Every code file auto-merged
  cleanly: main's mobile-touch-layout work and friendslist's audio restructure touch
  disjoint regions of `settings.ts`/`types.ts`/`App.tsx`; `game.ts`/`smoke.ts` likewise.
- **Pre-merge hardening (collation).** `0016_friends.sql`'s `friendships` CHECK was
  `(user_low < user_high)` under the column's DB collation, but `repo.ts` builds the
  ordered pair with JS `<` (UTF-16 byte order on ASCII auth subjects). A libc/ICU DEFAULT
  collation could order a pair OPPOSITELY → the INSERT violates the CHECK → a pair-dependent
  500. Fixed the CHECK to compare `collate "C"` (byte order == JS `<` for ASCII), so the
  pair repo.ts inserts always satisfies it. Surgical (CHECK expression only — PK index and
  FKs keep the default collation). Also fixed a stale `respondToBlock`→`blockUser` comment.
- **DEPLOY.** After this merge commit, `flyctl deploy --remote-only` (app
  `dohun-sim-decode`) ships the server; `migrate()` applies `0016_friends.sql` on boot
  (additive, `create table if not exists` ×4 + the `user_presence` table — distinct from
  main's machine-level `presence` table in `0015`), then verify `GET /health`. Vercel
  auto-deploys the clients from `main`.
- Review verdict: friends security model is sound (actor is always the JWT `sub`; wire
  carries usernames not user ids; blocks report generic failures; invisible/offline resolved
  server-side; LIKE wildcards escaped, prefix-only search; ProfileCols allowlist). Remaining
  LOW findings are self-healing concurrency edges (reciprocal-request race, block-vs-request
  race) — accepted, not blocking. Still worth running the two-account curl security checklist
  in `docs/friends-list-plan.md` §Verification against the live DB now that it's up.

## Latest session — friends list (PR #4)

Branch `friendslist`. **`npm run build`, `npm test`, `npm run server:check`, and
`npm run contrast` (now 151 checks) are all green.**

- **Migration `0016_friends.sql`** — `friend_requests` (pending only, deleted on
  resolve), `friendships` (ONE row per unordered pair, `check (user_low < user_high)`, so
  a friendship can't half-exist), `friend_blocks` (one-way), and `user_presence`.
  Presence is its OWN skinny table, NOT columns on `profiles`: the ~30s heartbeat would
  otherwise rewrite the whole `profiles` row (Postgres UPDATE is copy-on-write, including
  the `settings` jsonb) on the table every leaderboard/profile/match read also hits — and
  it makes keeping last-seen out of the PUBLIC profile reads structural rather than a
  discipline one future `select *` breaks.
- **`server/db/pool.ts` gained `tx()`** — `q()` takes a connection per call, so a
  sequence of `q()`s is not atomic. Accepting a request is "delete the request AND insert
  the friendship"; a half-applied version either drops a request nobody honoured or mints
  a friendship nobody agreed to.
- **`repo.ts` friends section.** The security properties are structural, not vigilance:
  accept/decline/cancel/remove are CONDITIONAL writes scoped to the caller and return
  false on no match (⇒ handler 404s), so **accept is authorised by the DELETE itself** —
  a client naming a request that was never sent gets a 404, not a friendship. `remove`
  binds one side of the pair to the caller, so it can't delete two strangers' friendship.
  `listFriends` reaches presence only THROUGH the caller's own friendship rows, so no
  query shape here can return a non-friend's presence. **`invisible` is flattened to a
  plain offline row IN THE SQL** — a server that sent `{online:true,status:'invisible'}`
  and trusted the component not to render it would leave the truth in a payload any
  friend can read in devtools. Offline durations are `coarsen`ed to the buckets the UI
  renders (5min/1h/1d); second precision would be a needlessly exact activity log.
  `searchUsersByUsername` is a PREFIX match on `username` (not the admin substring search
  on `handle`, which would let anyone enumerate every display name) and **escapes LIKE
  wildcards** — `?q=%` would otherwise return the whole table.
- **`server/api.ts`** — one `/api/friends*` block (Bearer JWT; the subject is ALWAYS the
  token `sub`, no endpoint takes an actor parameter) + public `GET /api/users/search`.
  The wire carries **usernames, not user ids**, so a leaked friends list doesn't hand out
  valid auth-provider `sub` values. **The friends READ doubles as the presence
  heartbeat** — no `/api/presence/ping`, because the poll that refreshes everyone else's
  status already proves the caller is here, and with no user id on the wire there is
  nothing to forge. A block reports the SAME generic failure as any other refusal: a
  distinct message would let someone confirm they'd been blocked.
- **Client** — `authedJson` in `net/api.ts` (the existing `getJson` is the *public*
  reader and sends no Authorization header, so a friends read through it would just 401);
  `useFriends.ts` owns the poll timer, cache, and optimistic mutations; `FriendsPanel.tsx`
  + `.ds-friends`/`.fr-*` CSS. **The poll only runs while `document.visibilityState` is
  visible** — otherwise every abandoned background tab pings a scale-to-zero Fly machine
  ~2,900×/day AND keeps that player eternally "online" while they're asleep, which is
  both a cost problem and a wrong answer. 30s open / 120s collapsed.
- **Panel layout** — a flex sibling in `.ds-body` mirroring `NavRail`, never
  `position:fixed` (`.ds-app` is the only scroll container). Collapsed by default (a new
  account has no friends; an expanded panel would be a column of empty state on every
  screen) with an **incoming-request badge on the collapsed rail** — without it a request
  is invisible until someone happens to expand, and the feature quietly doesn't work.
  Force-collapses between 901–1100px, where there's room for the rail and content but not
  a third column; that's a CONSTRAINT, not a preference, so the stored open/closed choice
  survives and widening restores it. Below 900px `.ds-body` is already a column, so the
  panel becomes a full-width strip ordered under the rail.
- **Status is spelled out in words**, not carried by dot hue alone — a red DND dot and a
  green online dot are the same dot to a red-green colourblind player.
- **`scripts/contrast.mjs` gained 16 pairs** (135 → 151) for the panel's `--ds-bar`
  ground and the Contributors cards. Worth knowing: contrast.mjs audits a HARDCODED pair
  list, so a green run does NOT imply new CSS was checked — new colour pairs must be added
  there or the pass is meaningless.

**Still not verified:** `npm run shiftaudit` (Electron loads the script as plain Node in
this shell — `app` undefined at `shiftaudit.cjs:36`, an environment problem unrelated to
these changes). The friends rows are new pressables in a new flex column, which is exactly
the shape of change that audit exists to catch — run it locally. Also untested: the
resize behaviour across both breakpoints, and the whole friends feature end-to-end.

**Nothing is committed.** `docs/friends-list-plan.md` §Sequencing calls for FOUR separate
PRs, and PRs #1/#3/#4 all touch `App.tsx`, so the split needs deliberate staging rather
than one lump commit.

## Previous session — display-name fix, volume sliders, Contributors page

Branch `friendslist`. **Build + `npm test` + `npm run contrast` all green.** These are PRs
#1–#3 of the four-PR split in `docs/friends-list-plan.md`; **PR #4 (the friends list itself)
is NOT started** — it needs a DB migration and, per the main developer, Claude generates the
`.sql` but never runs the deploy.

- **§3 display-name fix** (`App.tsx`, `AccountButton.tsx`, `Account.tsx`). Root cause: the
  header pill read `user.name` (the immutable Neon Auth sign-up name), the Profile page read
  the app's mutable `handle` — two sources, never synced. App now owns
  `handle: string | null | undefined` (fetched once per sign-in via `fetchProfile`) and passes
  it to `AccountButton`, which prefers it over `user.name`. `undefined` renders `…` rather
  than the auth name, so a page load doesn't *flash* the very bug being fixed. `Account` takes
  `onHandleSaved` (→ `Identity` → `DisplayName`), fired after `updateHandle` resolves, so the
  pill updates on save instead of on reload. Kept OUT of `AccountSync`'s effect deliberately —
  that one is guarded by a module-level `syncedUser` whose retry semantics shouldn't apply here.
- **§2 volume sliders** — 4 categories replacing the 2 booleans. `GameSettings.audio` is now
  `{ volume: {master, game, sfx, voice}, sounds, voice }`. **`sounds`/`voice` are LEGACY MIRRORS,
  not dead fields**: settings sync per account and one account is shared across client versions,
  so an old tab / old Electron install still reads only those two booleans. `audioMirrors()`
  re-derives them in `coerceSettings` (load) and `syncAudioMirrors()` in App's `update()` (the
  one choke point for edits — a slider drag never passes through coerce). Legacy blobs migrate
  `sounds:false → master 0`, `voice:false → voice 0`. **Round trip through an old client loses
  the levels but keeps the mute** — smoke-checked.
  `MatchAudio` swapped `soundsEnabled`/`voiceEnabled` for `masterVolume/gameVolume/sfxVolume/
  voiceVolume` + a `gain(category)` helper; WAV cues set `.volume` per *play* (was static at
  construction) so a slider applies immediately; `tone`/`noiseBurst` scale there since every
  synthesized effect funnels through them. **`ensureCtx` no longer early-returns when muted** —
  a browser only starts an AudioContext from a user gesture, so refusing to build one at
  master 0 meant raising the slider mid-match stayed silent until reload; `startKeepAlive`
  now warms it. Voice at 0 keeps the old beep fallback exactly.
  UI: `AudioSection.tsx` `VolumeRow` (`.ds-field`/`.ds-range`/`rangeFill`, step 5), auditions
  its category on pointer-up/key-up (never `onChange` — a drag would stutter), greys the value
  when master is 0. **8 new smoke checks** cover the migration in both directions.
- **§4 Contributors page** — `src/contributors.ts` (hand-maintained roster) +
  `src/ui/Contributors.tsx` + `.contrib-*` CSS in `shell.css` + route `/contributors` +
  a footer link beside Download (public — deliberately NOT admin-gated like Download).
  Display names are fetched live per card via `fetchProfileByUsername`, falling back to a
  static `fallbackName`, so a rename never staleness the page and a cold/absent game server
  still renders. **⚠️ The roster is incomplete on purpose**: names + GitHub URLs came from
  `CONTRIBUTORS.md`, but `discordAvatarUrl` / `discordUrl` / `inGameUsername` are recorded
  NOWHERE in the repo and must be collected from each person. Every field except
  `fallbackName` is optional and the card degrades (initials avatar, no icons, non-clickable
  name), so the file can be completed one contributor at a time.

**Not verified this session:** `npm run shiftaudit` — Electron in this shell loads the script
as plain Node (`app` is undefined at `shiftaudit.cjs:36`), an environment problem unrelated to
these changes. Worth running once locally: AudioSection swapped `.ds-opt` buttons for
`.ds-range` inputs, and Contributors adds new pressables (`.contrib-name`/`.contrib-icon`,
written to move only via `transform`/colour, never a border or margin).

---

---

# HANDOFF — 2026-07-19 (server spec clamp is now GAME-AWARE — CR chassis limits match the config menu)

## Latest session — server-side chassis limits == config-menu limits (CR record runs)

Build + tsc + smoke (`npm test`) + `server:check` all green.

**Bug:** Chain Reaction record runs (and ranked/custom) resized the chassis differently
from the config menu. CR runs its own length envelope (`CHAIN_MIN_LENGTH`=10 ..
`CHAIN_MAX_LENGTH`=18); DECODE clamps length to the per-intake range (sloped 13.5–15). The
config menu (`Menu.tsx`) + the actual CR spawn (`createChainWorld`→`coerceSpec(...,'chain')`)
were already game-aware — but the SERVER ingress sanitizers weren't: `sanitizePlayer` /
`sanitizePlayerPatch` in `src/net/sanitize.ts` called `coerceSpec` WITHOUT the `game` arg, so
a CR robot's length got clamped with DECODE's intake range before it ever reached the
chain-aware spawn (e.g. length 10 → 13.5). That sanitized spec is what lands on the roster,
feeds the setups, and gets recorded into the replay.

**Fix:** thread `game` through the server clamp so server limits == config-menu limits:
- `src/net/sanitize.ts`: `sanitizePlayer(raw, game?)` and `sanitizePlayerPatch(raw, current,
  game?)` now pass `game` into `coerceSpec`.
- `server/index.ts`: join → `sanitizePlayer(msg.player, cfg.game)`; spectate →
  `sanitizePlayer(undefined, r.config.game)`; ranked queue → `sanitizePlayer(msg.player,
  msg.game==='chain'?'chain':'decode')`.
- `server/room.ts`: update patch → `sanitizePlayerPatch(msg.patch, c.player, this.game)`.
- Smoke: 6 new checks in the sanitize block (CR keeps length 10/18; DECODE range still
  applies with no game arg — regression guard both ways).

Backward-compatible (no protocol change — just widens the accepted CR envelope to match what
the menu already offers). **Needs a Fly deploy** (`flyctl deploy --remote-only`) to take
effect on the live server; until then the deployed server keeps the old DECODE clamp for CR.

---

## Prior session — Chain Reaction: UI polish — game-aware footer + game-prefixed URLs

Build + tsc all green. Changes are UI-only (no `src/sim`/`config` touch, so smoke unaffected).

- **Footer is now game-aware.** `AppShell` took a static `CURRENT_SEASON` (always DECODE) →
  now takes a `game: GameId` prop and renders `seasonFor(game)` → "DSIM · Chain Reaction 2026"
  vs "DSIM · DECODE 2025–26". Wired from `App.tsx` (`game={settings.game}`).
- **Every URL is now game-prefixed** (user picked "both prefixed"): `/decode/…` and `/chain/…`.
  All routing lives in `App.tsx`. `pathFor(screen, args, game)` prepends `/${game}` (home =
  `/decode` / `/chain`); `screenSuffix` is the un-prefixed part. `parsePath(pathname,
  fallbackGame)` strips a leading `/(decode|chain)` segment (→ the game) then `parseScreen(rest)`
  (the old body, incl. legacy `/leaderboard`→records etc.). Unprefixed OLD links fall back to the
  last-selected game and are canonicalized on load (replaceState). The `settings` initializer
  `switchGame`s to the URL's game up front (so a `/chain/…` deep load spawns CR's loadout on the
  FIRST render); a mount effect persists it + canonicalizes the URL. `navigate`/`onGame`/popstate
  all thread `settingsRef.current.game`; popstate + `onSyncLoad` reconcile the game (URL is
  authoritative for the ACTIVE game — account settings don't revert a deep-linked game).
  Verified via Electron-over-HTTP (`vite preview`, file:// can't route): `/`→`/decode`, switch→
  `/chain`, `/chain/records`, deep-load `/chain/configure/robot`, legacy `/leaderboard`→canonical.
- **document.title** now names the game ("Chain Reaction · DSIM" / "DECODE · DSIM"), effect on
  `settings.game`. Static `index.html` `<title>` is just the pre-hydration placeholder.
- **GameView field aria-label** was hardcoded "DECODE field" → now game-aware via `hud?.game`.
- **Top-right Settings button** now matches Sign in (both `ds-btn`; dropped `ghost`) —
  `AccountButton.tsx` signed-out branch + `App.tsx` no-auth fallback.
- **Homepage Discord + GitHub pills** (`HomeMenu.tsx` `.ds-home-links`, styled in `shell.css`):
  prominent bordered pills with inline brand SVGs, centered under the game switcher above the
  Play menu. Reuse `LINKS` from `seasons.ts`; the footer links stay as secondary. No new tokens.
- **One-time Chain Reaction disclaimer** ("just for fun / not realistic / don't use for real
  robot design"): local-only flag `src/chainDisclaimer.ts` (`decodesim.chainDisclaimer.v1`, like
  `theme.ts` — NOT in synced `GameSettings`). `App.tsx` effect on `settings.game` sets
  `showChainDisclaimer = game==='chain' && !seen`; the `.overlay` modal (GOT IT →
  `markChainDisclaimerSeen`) sits with the other menu guards inside the AppShell block. Verified:
  shows on first CR select, dismiss persists, never reappears.

### Leaderboard "shows DECODE when CR selected" — NOT a client bug (deploy-gated)
The client is already fully game-keyed (`api.ts` appends `&game=chain`; `Records`/`Leaderboard`/
`Stats` thread `settings.game`). You still see DECODE because `.env` points at the LIVE Fly server
`wss://dohun-sim-decode.fly.dev`, which runs the **undeployed** DECODE-only server + DB — migration
`0012_game_boards.sql` and the game-keyed queries only exist on this private branch, so the live
server ignores `?game=chain` and returns DECODE rows. There is NO client-side fix (the rows look
identical). Resolves when the CR-aware server is deployed (private-branch rule: not until told) or
by running a local CR server (`npm run server` + a DATABASE_URL). Left untouched per that rule.

## Prior session — fire-rate tune (turret ~10.5 bps / drum ~27 bps)

- Turret `CHAIN_FIRE_INTERVAL` 1/9→1/12 (~8.8→~10.5 bps), drum `CHAIN_DRUM_INTERVAL` 1/41→1/37.5
  (~30→~27 bps). See "fire rates" below. Build + ~205 smoke + client/server tsc all green.

## Prior session — physical turret aim + Front/Side intake mount

- **Physical turret aim** (user: shots should depend on physical state, not pre-solved). The CR
  turret now SLEWS toward the lead solution at `CHAIN_TURRET_SLEW` (4 rad/s) and `launchToAccel`
  fires along the ACTUAL `r.turretHeading` + real velocity (no re-solved lead). Steady driving
  tracks perfectly; a SUDDEN shove (collision) jumps the solution faster than the turret follows,
  so shots fire along the stale heading and MISS. `makeChainRobot` seeds `turretHeading` aimed at
  the goal (it slews, so it must start aimed). Smoke: settled/steady = accurate, sudden shove =
  18.5° error. (Teleporting tests reset `turretHeading` — a real turret tracks continuously.)
- **Intake MOUNT selector (Front / Side)** — NOT a new style; the same sweeper on the front or
  the left+right edges (`RobotSpec.intakeSide`, like the shooter Front/Rear). `chainIntakeBand` is
  a discriminated union (`side:false` front box / `side:true` two side bands); `interact` +
  `drawChainIntake` + `RobotPreview` handle both. Side mount holds fewer (`CHAIN_STORE_SIDE_MULT`
  0.6). **The intake is part of the non-ball collision hitbox** (user): `footprintExtents` moves
  the `INTAKE_PRESETS[intake].reach` from the FRONT to the SIDES for a side mount (the Rapier
  collider uses `robotExtents`), so both mounts' rollers collide with walls/robots like DECODE.
  `coerceSpec`/`DEFAULT_SPEC` carry `intakeSide`; Menu has the Front/Side buttons.

## fire rates: turret ~10.5 bps, drum ~27 bps

- **Turret**: `CHAIN_FIRE_INTERVAL = 1/12` → ~10.5 balls/s observed (deterministic). User asked for
  "like 11 bps, slightly faster". 11 is UNREACHABLE at 60 Hz: the achievable rates near it are 10.0
  (1/11), **10.5 (1/12)**, and 12.0 (1/13) — the re-anchor-to-actual fire tick rounds a sub-6-tick
  interval UP, so the values quantize in jumps. 10.5 is the closest to 11 and the "slight" bump from
  the old ~8.8. (Old was `1/9` → 8.8 bps.)
- **Drum**: `CHAIN_DRUM_INTERVAL = 1/37.5` → ~27 balls/s observed (user: "dumper slightly slower at
  ~27" — interpreted as the DRUM, since the actual dumper flings its whole hopper at once with no
  per-ball bps). The NOMINAL is set below 1/27 s to counter the throughput lost to 60 Hz tick
  quantization (a shot fires on the next tick past its due time, so a sub-3-tick interval rounds UP)
  + the symmetric jitter; the OBSERVED cadence measures ~27 balls/s. (Old was `1/41` → ~30 bps.)
  Both verified empirically with a throwaway rate-measurement script (removed).

## PER-GAME loadouts (robots + start positions no longer bleed cross-game)

- **`GameLoadout`** (types.ts) = {spec, savedRobots, startIndex, startPose, startCat,
  savedStartPoses, startMemory}. `GameSettings.loadouts?: Partial<Record<GameId, GameLoadout>>`
  archives the NON-active games; the flat fields are always the ACTIVE game's copy.
- **`switchGame(settings, game)`** (settings.ts) archives the current game's loadout and restores
  the target's (or a fresh `defaultLoadout(game)`), so DECODE and CR each keep their own robot,
  saved-robot library, and start positions. Active assists follow the restored spec's drivetrain.
  App's game switcher (`onGame`) now calls it. `coerceSettings` validates the archive
  (`coerceLoadout`, per-game `coerceSpec`).
- **Fixed a pre-existing bug**: the flat `startIndex` clamp used DECODE's `START_POSES.length`
  even for CR, so CR anchor 3 clamped to 2. Now game-aware via `startPoseCount(game)`.
- Smoke: a DECODE build + saved robot + start survive a CR round-trip; a CR 18"-long build +
  anchor 3 survive; switching hides the other game's saved robots.

## mecanum best on beams, CG range 0.3–1.5, CR length to 18

- **Mecanum is the BEST beam-crosser** (suspension + low CG); swerve worst. `TRACTION` reordered
  (mecanum .91 / tank .90 / xdrive .89 / swerve .87). Crucially the beam CoG penalty now scales
  with the clearance **margin above the beam** (`(clr−beamH)/(MAX−beamH)`), not absolute
  clearance — so a just-clearing chassis (clr≈1) pays NOTHING and the default isn't over-slowed.
  Crossing keeps ~mecanum .70 / tank .69 / swerve .53 / xdrive .42.
- **Ground-clearance range → [0.3, 1.5]** (`CHAIN_CLEARANCE_MIN/MAX`). CR presets' clearance
  lowered under 1.5 (Sniper 1.3, Hauler 1.5). CoG smoke test now checks the 0.3 floor = no penalty.
- **CR chassis length up to 18"** — `coerceSpec(raw, base, game?)` gained a game param; for
  `'chain'` it uses `CHAIN_MIN_LENGTH/CHAIN_MAX_LENGTH` (10–18) instead of the DECODE
  intake-limited range (~15). Threaded from CR spawn ('chain'), the Menu (`settings.game`), and
  settings.ts (active + saved specs). DECODE is byte-identical (no game arg ⇒ old path). The
  Menu length slider mirrors it. (Note: cross-game saved robots use the CURRENT game's range —
  a saved CR-length robot viewed under DECODE would clamp to ~15; acceptable edge.)

## CR storage ceiling 60 + lighter beam drag

- **Storage max raised to 60** (`CHAIN_STORAGE_MAX` 48→60; `CHAIN_STORE_AREA_PER_BALL` 6.5→5.4
  so a full 18×18 open-hopper launcher actually reaches ~60; turret still smaller via its mult).
- **Beams slow you less** (user: "too much"). Raised the per-drivetrain `TRACTION` grips
  (tank .96 / swerve .94 / mecanum .92 / xdrive .93), base cap → .98, `CHAIN_BEAM_MAX_RETAIN`
  .95→.98, `CHAIN_BEAM_MOMENTUM_EASE` .45→.55. Full-sim high-speed crossing now KEEPS ~tank .72
  / swerve .57 / mecanum .58 / xdrive .44 (was ~.53/.32/.32/.34) — still a real slowdown, just
  not crippling. Smoke's per-tick-retain threshold relaxed to `< 0.99`; storage test asserts a
  big launcher hits ~60.

## SPECTATING (watch live matches)

You can now watch any live match read-only, and there's a "Watch Live" list.
- **Server** (`room.ts`): `spectators` map separate from `clients`. `addSpectator(c)` sends the
  current `matchStart` (yourRobotId **-1**) + a snapshot, then every broadcast/snapshot (both
  `broadcast` + `broadcastSnapshot` now iterate spectators with the same delta-priming).
  Spectators never count toward capacity/roster/persistence; their control messages are ignored
  (`onMessage` already returns on unknown ids); `detach` drops them with no grace. `Room.summary()`
  → `LiveRoom` for the list (live versus matches only). `beginMatch` remembers `matchSeed/Setups`
  so a mid-match spectator gets matchStart.
- **`/api/live`** (index.ts, where the `rooms` map lives) lists every live match; the WS
  `{t:'spectate', room}` message routes to `addSpectator`.
- **Protocol**: `spectate` ClientMsg + `LiveRoom` type. `NetSession.spectator`; `ServerSession`
  takes a `spectator` flag (sendInput is a no-op when set). `LobbyClient.spectate(room)`.
- **GameController**: `spectator` mode — `localRobotId` -1, `stepServer` reconciles + steps the
  world with the snapshot's per-robot commands (no predict/send); every robot is interpolated by
  `displayWorld`. Camera from `robots[0]`.
- **UI**: `WatchLive.tsx` polls `/api/live` (4 s) and lists matches; a card → `App.spectateRoom`
  opens a spectator `ServerSession` (not saved as a rejoinable "active game"). Reached via a
  "Watch Live" tile on the mode-select `/watch` route.
- Smoke: a Room accepts a spectator, streams snapshots to it, keeps it off the roster, `summary()`
  reports it, and it leaves cleanly — all without touching the match.

## Archived-season ELO is FROZEN (historical standings)

Even though ELO persists across seasons within an act, viewing a PAST season's leaderboard/career
now shows the rating FROZEN at that season's end (not the moved-on live rating).
- **`0014_elo_history.sql`**: new `elo_history(user_id, mode, game, balance_version, rating, rd,
  vol, games)` — a per-SEASON snapshot. Written on every rated match (`upsertEloHistory` in
  `ranked.ts`, alongside `upsertRating`); while a season is live it tracks the latest rating,
  once it rolls it stays frozen = the end-of-season state.
- **Read routing**: the LIVE season reads the per-ACT board (`elo_ratings` — every currently-
  placed player); an ARCHIVED season reads `elo_history` for that `balance_version`.
  `api.ts /api/elo` branches on `season >= currentSeason` (adds `historical` to the response);
  `getUserStats` (career) picks `elo_ratings` (by act) vs `elo_history` (by season) via the same
  live check. New repo fns: `eloHistoryLeaderboard`, `eloHistoryUserStanding`, `upsertEloHistory`.
- Pre-existing archived seasons (rolled before this feature) have no snapshot rows ⇒ their ELO
  board reads empty; every season that rolls from now on is captured. Not deployed (private branch).

## Global "games played" recorded per game, combined on homepage

`getGlobalStats` (repo.ts) now groups records/matches by `(game, mode)` and returns a new
`byGame: {decode, chain}` split (games recorded SEPARATELY per game) while the headline `games`
and `byCategory` COMBINE across games (summed — note the group-by-game change means `byCategory`
now uses `+=`, not `=`). The homepage (`HomeMenu.tsx`) already renders the combined `stats.games`,
so it stays a single combined total; the per-game split is available in the API for any surface
that wants it. Client `GlobalStats.byGame?` is optional (older servers omit it).

## ELO wipes on ACT reset, records on SEASON reset

Reset semantics split: a **SEASON reset** (new `balance_version`, same act) starts fresh RECORD
boards but ELO carries over; ratings wipe **only on an ACT reset** (act++). Implemented by
keying ELO by ACT instead of season:
- **`0013_elo_by_act.sql`**: `elo_ratings` gains `act` (backfilled from `seasons`), de-dups
  colliding rows (keep highest balance_version per act), re-keys PK to
  `(user_id, mode, game, act)`, DROPS `balance_version`, index → `(game, act, mode, rating)`.
  Records/matches unchanged (still per-season). **Not deployed** (private branch; runs on next deploy).
- **repo.ts**: new `actForSeason(bv, game)`; `getRating(Full)`/`upsertRating`/`eloLeaderboard`/
  `eloUserStanding` now key by `act`; `getUserStats` resolves the season's act for its ELO query
  (records/matches stay per-season).
- **ranked.ts** `persistVersusMatch` resolves `actForSeason(bv, game)` once and rates on the act.
  **matchmaking.ts** `introElo` resolves the current act. **api.ts** `/api/elo` resolves the
  requested season's act (records endpoint stays per-season); response adds `act`.
- Net effect: `startNewSeason(bumpAct=false)` → records reset, ELO persists; `bumpAct=true` →
  both reset (fresh act). No client change needed (the extra `act` field is additive).

## CR ranked & records + per-game periods

Chain Reaction is now RANKED + RECORDED, on its OWN boards and its OWN Act → Season
progression (DECODE and CR never share a leaderboard or a period).
- **CR is scored**: `src/games/chain/sim.ts` `scored: true` — CR versus matches persist ELO +
  history, CR record runs persist to the record board, all keyed by game.
- **DB migration `0012_game_boards.sql`** (additive, `game` defaults to `'decode'`): adds
  `game` to `seasons`/`records`/`matches`/`elo_ratings`/`replays`; re-keys the seasons PK to
  `(game, balance_version)` and the elo PK to `(user_id, mode, game, balance_version)`;
  game-first board indexes; drops+recreates `record_leaderboard` with `game`. `migrate.ts`
  runs the whole file as one query, so the `DO $$` PK-swap blocks are safe. **Private branch —
  the migration has NOT run on the live Fly/Neon DB yet; it applies on next deploy.**
- **Per-game periods**: `repo.ts` season fns (`ensureSeason`/`currentSeasonNumber`/
  `listSeasons`/`startNewSeason`/`purgeSeasonReplays`) all take `game`; the live season + acts
  are resolved per game. **Chain Reaction seeds Act 1 · Season 1** (`ensureSeason(bv, 'chain',
  1)` in persist.ts + the `/api/seasons` read); DECODE keeps its act-0/beta rows.
- **Repo/persist/ranked**: every board read/write fn takes `game` (default `'decode'`) —
  records, ELO, matches, stats, history. `persist.ts`/`ranked.ts` thread `o.game`.
- **Endpoints**: `/api/records|elo|seasons|user/:id/stats|matches` accept `?game=chain`
  (default decode); admin `/api/admin/season/start` + `/records` take `?game=`.
- **Client**: `src/net/api.ts` board fns take `game?` (append `&game=chain` only for CR so
  DECODE URLs are byte-identical); `game` threads App→Records→Leaderboard/Stats→CareerView, so
  the boards/career you see follow `settings.game`. (Public `/profile` pages still default to
  DECODE — a per-profile game toggle is a possible follow-up.)
- **CR replays are now watchable** (done). `Replay.game` added; `ReplayRecorder`/`runRecordMatch`
  stamp it; `ReplayPlayer`/`simulateReplay` re-sim via `simModuleFor(replay.game)` (createWorld +
  step), so a CR replay runs through `chainStep`. `getReplay` returns the stored `game`; the
  server recorder stamps `this.game`. `ReplayView` configures the camera with `moduleFor(r.game).
  bounds` (CR's larger field) and the Renderer already draws game-aware. Old replays lack `game`
  ⇒ DECODE (no REPLAY_FORMAT bump). Smoke: CR replay round-trips byte-identical + differs from a
  same-seed DECODE re-sim.

## CR vs DECODE multiplayer audit

Verified the netcode is game-aware end-to-end and the two games never cross-contaminate:
- **Server**: `room.ts` resolves `simModuleFor(this.game)` for createWorld/step; the G304
  start-legality host gate runs only when `simModuleFor(game).startLegality` (DECODE). `game`
  comes from the staged PendingMatch / RoomConfig.
- **Matchmaking**: `bucketKey` includes `game` → a CR queuer and a DECODE queuer never pair
  (smoke: "chain and decode do NOT pair" / "two chain queuers DO pair").
- **Protocol/snapshots**: `slimWorld` spreads all non-robot/ball fields, so CR's `world.chain`
  (catalysts/scored/endgame) round-trips; `unslimWorld` defaults `game→'decode'` for old
  servers. `staged` balls serialize as full Artifacts. New smoke: CR snapshot keeps
  game='chain', preserves chain state, hash-identical, and re-steps without NaN.
- **Client**: `game.ts` resolves the module from `this.world.game` (`this.mod`) on the
  predict/reconcile hot path; `gameId = session ? session.game : settings.game`. `NetSession.game`
  is carried by ServerSession/lobbyClient.
- **FIXED — the Lobby / MatchStrategy start editor rendered DECODE geometry for CR.** New
  shared `ChainStartSelector` (used by MatchSetup, Lobby, MatchStrategy) shows CR's legal
  lab/ring-stand anchors instead; `startLegal` is forced true for CR (G04 anchors are always
  legal) so "ready up" isn't blocked by DECODE's G304.
- **KNOWN/INTENTIONAL**: CR sim module is `scored: false`, so CR multiplayer PLAYS (custom
  lobby, snapshots, results screen, drop/reconnect) but ranked ELO / records / DB persistence
  are gated OFF (persistMatch short-circuits unscored games). Flip `src/games/chain/sim.ts`
  `scored: true` to enable the ranked/records pipeline for CR (verify the results-screen ELO
  reveal + DB game-keying first).

## Beams always slow you (even at speed)

- **Beams now slow every drivetrain even at high speed** (was: momentum let mecanum/swerve
  power over at ~full speed). `beamDragFactor` (CR beams.ts) rebalanced: momentum eases only a
  LITTLE (`CHAIN_BEAM_MOMENTUM_EASE` 0.45) and the per-tick retain is hard-capped
  (`CHAIN_BEAM_MAX_RETAIN` 0.95), base cap 0.9. Full-sim high-speed crossing now KEEPS ~tank
  0.53 / swerve·mecanum·xdrive ~0.32 (was mecanum 1.00, swerve 0.97) — a clear slowdown, still
  crossable, traction spread preserved (tank best). Smoke: sim-based crossing test asserts a
  real speed loss; the old "momentum powers over" assertion was flipped.

## Wall square-up in CR + diagonal-speed audit

- **CR robots now square up flush to walls** (they didn't before). DECODE's post-Rapier
  `squareUpRobots` was never called in `chainStep`. The wall block of `squareUpStatics`
  (physics.ts) was factored into `squareUpWalls(r, preVel, halfX, halfY)`, and a new export
  `squareUpRobotsWalls(world, preVels, halfX, halfY)` runs robot-robot squaring + wall-only
  statics (no DECODE goal-face/classifier geometry, which is phantom in CR). `chainStep` now
  captures `preVels = solveRobots(...)` and calls it with `CHAIN_HALF_X/Y`.
- **Diagonal-speed bug FIXED (was real — in the ACCEL phase, not top speed).** TOP speed was
  already capped fine (`hypot` demand for swerve, L1 for mecanum/xdrive), which is why a
  peak-speed probe missed it. But `motorStep` was stepping fwd + strafe INDEPENDENTLY, so the
  velocity VECTOR accelerated at √2·accel on a diagonal → over a 0.5 s drive from rest,
  diagonal covered **33-37% more ground** for swerve/xdrive (~10% mecanum). Added
  `motorStepVec` (drivetrain.ts) — caps the accel budget in vector MAGNITUDE, not per-axis;
  robot.ts uses it for translation (angVel still 1-D `motorStep`). After: diagonal/straight
  displacement ratio ≤ 1.0 for all drivetrains. Smoke test now measures DISPLACEMENT (not peak
  speed) so it actually guards the bug. Pure-forward accel/top-speed unchanged (identical to
  the old path when strafe = 0), so the DECODE `driveSummary` calibration holds.
- **High-CG swerve is now way more sluggish** (user request). `cogFactor` (CR beams.ts) is
  drivetrain-aware: swerve uses `CHAIN_COG_SWERVE_PENALTY` (0.6) on a SQUARED clearance curve
  (tippy tall modules), vs the base `CHAIN_COG_PENALTY` (0.16) linear for everyone else — so a
  max-clearance swerve drops to ~40% authority vs ~84% for tank/mecanum.

# HANDOFF — 2026-07-19 (Chain Reaction: start positions + launcher randomization)

## Latest session — start positions, pre-match launcher randomization, fire-rate + spread tuning

- **START POSITIONS (rule G04 — start completely in the Lab Area).** `CHAIN_START_POSES`
  in `config.ts` = 4 legal named anchors (2 Lab-corner FLOOR poses + 2 RING-STAND ascended
  poses), CANONICAL for BLUE (+x), x-mirrored for RED in `spawn.ts` `chainStartPose`.
  `makeChainRobot` honours `setup.startIndex` (2-robot alliance defaults to 0/1 → the two Lab
  corners). Selector: `MatchSetup.tsx` (solo config) now shows CR start buttons (was a
  placeholder) that set `settings.startIndex`. All anchors legal by construction, so G04
  always holds. (No drag-editor yet; multiplayer Lobby/MatchStrategy still render the DECODE
  `StartPositionEditor` for CR — a latent follow-up, not wired for CR start editing.)
- **PRE-MATCH FIELD RANDOMIZATION via the goal launchers** (manual auto-score/reject).
  `createChainWorld` no longer scatters particles — it STAGES 150 per goal (`state: {kind:
  'flight', target, scored:true, staged:true}`, positioned in the goal box). New
  `prematchRandomize` in `play.ts` flings `CHAIN_PRELAUNCH_PER_TICK` (1) per goal per tick
  onto the field with a randomized arc (~2.5 s to clear both goals). Staged balls are inert
  (skipped in the flight loop) until launched; count stays conserved at 300 the whole time.
  `staged?: boolean` added to the flight `BallState` (serializes fine; worldHash unaffected).
- **Fire-rate tuning:** drum `CHAIN_DRUM_INTERVAL` 0.023→0.0115 (2× faster); turret
  `CHAIN_FIRE_INTERVAL` 0.05→0.0714 (70% of the old rate).
- **Eject spread:** `CHAIN_EJECT_SPREAD` 150→80 (narrower width-wise scatter out of the goal;
  used by BOTH the gameplay recycle eject and the pre-match launcher).

# HANDOFF — 2026-07-19 (Chain Reaction: penalty engine + single sweeper intake)

> **Intake designs collapsed to ONE: `ChainIntakeStyle = 'sweeper'`** (the full-width
> roller). Removed `'roller'`/`'funnel'` from the type, `CHAIN_INTAKES`, the Menu picker
> (now a static info row), and the funnel render branches in `drawRobot.ts`/`RobotPreview`.
> Old saves migrate automatically (coerceSpec falls back to sweeper). CR presets all use
> sweeper. Kept the type open (`'sweeper'` union of one) for future designs.


> **Branch: `chain-reaction` (PRIVATE — do NOT push/deploy until the user says so).**
> **GREEN — `npm run build` (client tsc+vite), `npm run server:check`
> (`tsc -p tsconfig.server.json`), and `npm test` (466 checks) all pass. DECODE is 100%
> unchanged.**

## Latest session — CR penalty engine (`src/games/chain/penalties.ts`)

`updateChainPenalties(world)` runs in `chainStep` BEFORE `updateChain` (so a foul awarded
this tick folds into the alliance total `updateChain` writes — it now adds
`+ scores[a].foulPoints`). CR has no `world.rrContacts`, so the engine does its OWN
OBB–OBB SAT contact test (`robotsContact`, via `robotCorners` + `CHAIN_FOUL_SLOP`).
Rules modeled — both MAJOR, awarded to the VICTIM via the shared `awardFoul`,
EDGE-triggered via `chain.foulEdge` (`${rule}-${offender}-${victim}` keys):
- **G06** — in AUTO, contacting an opponent COMPLETELY inside its own alliance section
  (its x-half, excluding the neutral Particle-Zone diamond) → MAJOR on the aggressor.
- **G05** — in END GAME, contacting an ASCENDING opponent (`chain.endgame[id]==='ascended'`)
  → MAJOR on the aggressor.
NOT modeled (deliberate): G02 plowing + G08 "prolonged restriction" (user: hard to do
well) and **G09 accelerator-exit obstruction (user removed it this session)**. G01–G04 are
structurally enforced; G07 (de-score) is legal. HUD `hud.chain.foulPts/oppFoulPts` +
GameView Results now show a CR PENALTIES row (split out of End Game).

## What this branch is

A SECOND selectable, playable game — **Chain Reaction (CR)**, the 2026 Unofficial-FTC
CAD-competition theme (presented by goBILDA) — alongside DECODE, behind the
**game-abstraction seam** in `src/games/`. Both games are playable incl. online
multiplayer. CR is now a **full game** (not the old shell): particles, accelerators,
catalysts/hooks, beams, endgame, scoring — all implemented.

The seam: `GameSimModule` (DOM-free, server-safe, in `src/games/types.ts` + registry
`src/games/sim.ts`) vs `GameModule` (client, adds canvas renderers, `src/games/module.ts`
+ registry `src/games/index.ts`). Both `moduleFor`/`gameOf` default unknown→`'decode'`.
The server tsconfig has NO DOM lib — it must only ever import `simModuleFor`. DECODE's
colliders live byte-identically in `src/games/decode/colliders.ts`.

## Chain Reaction — how it plays (all in `src/games/chain/`)

- **Field** (`config.ts`, `state.ts`, `drawField.ts`): 144" tile field; ACCELERATORS
  protrude out of each side wall (red left / blue right, `CHAIN_ACCEL_*` = manual mm),
  centered in y. FOUR HOOKS/goal at y=±688mm (`hookPos`, 2 positions × 2 stacked). RING
  STANDS near the 4 corners (climb posts). LAB AREAS = corner squares (park/leave). Central
  white PARTICLE-ZONE diamond (`CHAIN_DIAMOND_R`). Red/blue alliance divider on the vertical
  centre line, flush OUTSIDE the beam (no tape overlap). BEAMS: four **1"-wide** (`BEAM_HALF_W
  =0.5`) black tubes on the x/y axes wall→diamond = difficult terrain.
- **Particles** (`play.ts`, `draw.ts`): 300 white 3" balls, bespoke integrator +
  spatial-hash `separateParticles` (never overlap, no Rapier ball-ball). Conserved: ground
  + flight + hoppers === 300 always (ball reuse, no teleport). ACCELERATOR auto-scores an
  entering particle then REJECTS it back onto the field (further out + randomized spread).
- **Beams** (`beams.ts`, called from `step.ts`): CLEARANCE is the only hard gate
  (`groundClearance ≥ CHAIN_BEAM_HEIGHT`). Given clearance, EVERY drivetrain crosses;
  MOMENTUM dominates (a running start powers over), traction only matters creeping.
  `beamDrag` runs BEFORE `solveRobots` (scales across-velocity so the slowdown persists —
  a post-solve change is wiped by `updateRobot` re-setting velocity); `beamBlock` runs
  AFTER for no-clearance robots (hard wall). Raised clearance → `cogFactor` sluggishness.
- **Catalysts** (`play.ts` `catalystAction`): 4 purple rings START on the ring stands.
  A `catalyst` button (key C / pad LB) picks up a free ring OR de-scores a seated one
  (own or opponent goal), and seats a carried ring on a nearby own hook (+1 pt/particle
  multiplier, `accelMultiplier`).
- **Endgame**: park in a lab area (5) / ascend a ring stand (20).

### CR robot configuration (`RobotSpec` CR-only fields; scoring reworked 2026-07-18)

THREE SCORING ARCHETYPES (`RobotSpec.scoreMode`) — turret aims its own turret; **drum +
dumper are TURRETLESS chassis-wide launchers that AIM BY TURNING** (holding fire steers the
robot to face the goal via `chainAimAssist` in step.ts, then it fires once aligned; autofire
fires opportunistically without hijacking the heading). Both fire a **parallel straight-line**
of particles across the chassis width (`launchLine`, NOT converging on a point). The tall
Accelerator opening HANGS over the field, so these score from a STAND-OFF distance:
- **`turret`** (default) — dye-rotor single-shooter: auto-aims + indexes ONE per
  `CHAIN_FIRE_INTERVAL` (0.05 s) from ANYWHERE (`launchToAccel`, solved arc, never short).
- **`drum`** — chassis-wide flywheel ROLLERS streaming SINGLE particles CONTINUOUSLY: one
  every `CHAIN_DRUM_INTERVAL` (0.023 s ≈ 43/s, fast) ± `CHAIN_DRUM_JITTER` from a RANDOM
  lateral position across the width (`launchAt`) — uniform SPEED, but the pattern is never a
  uniform line. Any range. Rendered as full-width rollers (NOT a channelled drum).
- **`dumper`** — chassis-wide catapult: flings the WHOLE hopper at once within
  `CHAIN_DUMP_RANGE` (56", a real stand-off, not point-blank); opposite-side balls leave at
  ±`CHAIN_DUMP_SIDE_VAR` speed ⇒ scatter (< 100% accuracy). Recovers `CHAIN_DUMP_INTERVAL` (0.8 s).

GOAL INTERIOR + THROW-BACK (in `updateChain`'s flight loop): a scored particle KEEPS its
momentum and BOUNCES around inside the goal box (back/side/floor restitution `CHAIN_GOAL_REST`
+ `CHAIN_GOAL_FRICTION`), funneling toward the wall-side launcher (`CHAIN_FUNNEL_DRIFT_ACC`),
which flings it back onto the field once it's funneled back (near the wall, moving fieldward,
after `CHAIN_FUNNEL_MIN`) or `CHAIN_FUNNEL_S` max-dwell expires — NOT a snap-to-one-x instant
eject. A particle that MISSES the opening is thrown back INTO the field by a human
(`throwBack`; FOR NOW, this rule may change).

ROBOT VISUALS + RESULTS: `drawChainRobot` shows the archetype (turret / full-width flywheel
ROLLERS / catapult bucket) + intake design + hopper bar; the intake reads green whenever it
can still collect (`hopper < cap`). The FINAL SCORE screen (both PvP `Results` and solo
`RecordResults` in GameView.tsx) is CR-aware: Particles ×mult + End Game (no DECODE fouls);
`hud.chain` carries per-alliance `particlePts`/`oppMult`/`oppCatalysts`.

A REAR-SHOOTER build (`RobotSpec.shooterRear`, drum/dumper only): the launcher mounts at the
BACK, so the robot turns its BACK to the goal to shoot (`chainGoalAimHeading` += π, `launchAt`
from the rear edge). Menu toggle + preview + in-game render all honor it.

Three INTAKE DESIGNS (`RobotSpec.chainIntake`, `CHAIN_INTAKES` geometry → `interact`, measured
off the ACTUAL chassis so the capture stays ~robot-sized): **roller** (full-width, 3" bite,
all-rounder) · **funnel** (narrow 55%, 6" reach, precise singles) · **sweeper** (widest +2"
overhang, 4" bite, max volume). CR intake is a WIDE band (multi-ball per tick), PLUS a TIGHT
active-intake PULL (`CHAIN_INTAKE_PULL_R` 5" — deliberately small; draws edge particles into
the mouth for a higher rate without a large reach).

RING PICK/PLACE INDICATOR: `chainCatalystPrompt(chain, rob)` reports pickup/place availability
+ the target; the HUD shows a gold `chip prompt` (PICK UP / PLACE RING) and `drawChainBalls`
draws a highlight ring + link line on the target ring/hook. Rings can be seated on EITHER
goal's hooks (own OR opponent) — `catalystAction`/`chainCatalystPrompt` scan both alliances.

SHOOTING ON THE MOVE: a launched Particle INHERITS the chassis velocity (real physics) and the
shooter LEADS to compensate — a TURRET leads by turning its turret (`turretHeading = leadDir`),
a TURRETLESS drum/dumper leads by turning its CHASSIS heading (`chainGoalAimHeading = leadDir`);
both stay accurate while moving. `leadDir` (play.ts) solves the projectile-lead angle; launch
arcs use the NET (muzzle + inherited) velocity.

HOPPER CAPACITY is DERIVED from archetype × size (`chainStorageMax`/`chainHopperCap` in
chain/config.ts), CM-grounded: G01 = unlimited Particles, G02 bounds control to an
**18×24×18 prism**, G03 lets the robot expand into it — so no fixed count; the MAX is the
one-layer volume `CHAIN_STORAGE_MAX = 48` (18×24 ÷ 3" grid = 6×8). The formula scales chassis
footprint / `CHAIN_STORE_AREA_PER_BALL` (6.5 in²/ball — hex packing + G03 deployed-hopper
expansion past the frame) × an archetype factor: TURRET smallest (0.55, dye rotor + shooter
take center volume), DRUM = DUMPER large (1.0). The `ballStorage` slider's MAX is dynamic;
`coerceSpec` resolves scoreMode BEFORE clamping ballStorage to `chainStorageMax`. Plus
**groundClearance** (0.5–3"). `flywheelInertia`/`canSort`/DECODE intake picker hidden for CR.
(The `cm.pdf` at repo root is now READABLE — `pdftotext cm.pdf` works; the old corrupt copy
is replaced.)

ROBOT VISUALS: `GameModule.drawRobot?` hook (renderer.ts: `mod.drawRobot ?? drawRobot`).
CR's `src/games/chain/drawRobot.ts` shares the chassis + `drawWheels`/`roundRect` (exported
from `render/drawRobot.ts`, DECODE byte-identical) and draws the ARCHETYPE launcher (turret
on top · chassis-wide slotted drum · catapult bucket) + the INTAKE DESIGN + a hopper-fill
bar. `RobotPreview` has a CR variant behind a `chain` prop (Menu + MatchStrategy pass it).

FOUR CR PRESETS (`CHAIN_PRESETS`, shown in place of DECODE's `ROBOT_PRESETS` when
`game==='chain'`): **Sniper** (turret/funnel/swerve) · **Drummer** (drum/roller/mecanum) ·
**Hauler** (dumper/sweeper/tank, big storage) · **Skimmer** (dumper/roller/xdrive, fast).
All coerceSpec-stable so a card highlights when active (`chainSpecMatches`). HUD shows a
TURRET/DRUM/DUMPER chip.

## Wiring touchpoints (both games)

- `src/types.ts`: `World.game?`/`World.chain?`, `GameSettings.game`, `RobotSpec.{ballStorage,
  groundClearance,scoreMode,chainIntake}?`, `ChainScoreMode`/`ChainIntakeStyle`,
  `RobotCommand.catalyst?`, `BallState` `flight` variant `{target,scored?}`.
- `src/sim/spawn.ts` `coerceSpec`: clamps/defaults all four CR fields (enum-checks
  scoreMode/chainIntake). `DEFAULT_SPEC` carries turret+roller defaults.
- `src/sim/physicsEngine.ts`: `solveRobots`/`solveBalls` take `FieldColliders`.
- Net: `RobotCommand.catalyst` → buttons bitfield `BTN_CATALYST=4`; `game` on RoomConfig/
  queue/matchStart/strategyStart, caps-gated (`CLIENT_CAPS` has `'game'`); matchmaking
  `bucketKey` includes game. Persistence short-circuits when `!module.scored`.
- `src/ui/Menu.tsx`: CR archetype + intake-design selectors, CR presets, storage/clearance
  sliders (all gated `!isDecode`). `src/ui/GameView.tsx`: CR HUD (score, PARTICLES/MULT/
  CATALYSTS, HOPPER n/cap, TURRET|DUMPER chip). `src/game.ts` `getHud`: CR `chain` readout.

## Verify / gotchas

- `npm test` (`scripts/smoke.ts`, ~445 PASS lines) is the runtime surface — CR spawn,
  300-particle conservation, catalyst ×5 + de-score, beams (canCrossBeams/beamDragFactor/
  beamBlock), particle non-overlap, wide/multi-ball intake, **dumper in/out-of-range**,
  **intake-design funnel-reach/roller-width**, **CR-preset coerce-stability**. Add one per
  behavior change.
- **Electron GUI verify**: needs `ELECTRON=1 npm run build` first (relative base for
  `file://`), then **`npm run build` again to restore the web base** before finishing —
  do not leave the repo on the Electron build. Driver recipe in `.claude/skills/verify`;
  working scripts this session in the scratchpad (`verifyCR.cjs`).
- Determinism holds (commands + `world.rngState` only) — client prediction / server
  authority / replays are safe for CR. `chainStep` deliberately skips DECODE's
  updateRobotActions/goals/gates/penalties/DECODE-scoring.

## Still approximate (flagged in `chain/config.ts`) — awaiting exact manual numbers

`CHAIN_DIAMOND_R` (diamond size → where beams end), ring-stand exact corner positions
(`CHAIN_RINGSTAND_INSET`), lab-area geometry (`CHAIN_LAB`). Beam width (1") and hook/
accelerator dims ARE exact (manual). Archetype/intake/dump tuning values are a reasonable
baseline, not a frozen spec — tune in `chain/config.ts`.
