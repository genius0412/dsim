<!-- governs: server/db/**, server/ranked.ts, server/matchmaking.ts, server/persist.ts, server/standing.ts, src/lib/**, src/standing.ts, src/awards.ts, src/badges.ts, src/rewards.ts, src/dodge.ts, src/report.ts, src/playtime.ts, src/ui/Leaderboard.tsx, src/ui/Admin.tsx -->
# Accounts, ranked, leaderboards, records, staff roles

Glicko-2, per-game boards and periods, the badge rules, challenges and the party token, and the background ranked queue.

*Split out of `CLAUDE.md` on 2026-09-16, **verbatim** — CLAUDE.md is loaded into every
session and this is not needed by most of them. The `governs:` line above is read by
`scripts/docaudit.mjs` and by the editor hook, so keep it accurate when paths move.*

---

## Accounts / ranked / leaderboards / records

Neon Postgres via `server/db/` (`repo.ts` + `migrations/`), written at match end OFF the hot
path. **Ranked is Glicko-2** (`server/ranked.ts`: rating + RD + volatility, `SCALE 173.7178`,
`CENTER 1500`, provisional RD shown with "?"), decided AFTER the score SETTLES
(the match finalizes only once the field has come to REST — `src/sim/settle.ts`, each game's
`GameSimModule.settled`, a 0.5 s hold and a 10 s cap — and the results screen reveals only on
that finalized score); an opponent who
LEAVES mid-match is retained (`departed`) so the match still rates. **SOLO RECORD RUNS**
(score-attack): results show NET score (earned − own penalties), no opponent/winner, and
PB / WR / global rank per **mode × drivetrain × season**. Boards, records, and Act→Season
periods are **keyed per game**, so DECODE and CR never share a leaderboard.
**A RECORD BOARD IS ALSO ONE PHYSICS** (owner ruling, 2026-09-18): every server-connected match
of a game that can step 3D runs 3D (`Room.physics` / `serverPhysics`), so the board shows 3D runs
only. `boardPhysics` in `repo.ts` is the single predicate and it is applied by the DATA LAYER,
not by a caller — `recordLeaderboard`, `personalBest`, `recordRank` and `getUserStats`'s record
half all read it, because the era filter used to be an optional argument that `/api/records`
filled from a QUERY PARAMETER and every path that forgot to ask silently mixed both eras. The
filter sits INSIDE the per-player `best` CTE: filtering after it would find a player's 2D
personal best, reject it, and leave them off a board they have a legitimate 3D score on.
**THE ERA IS PER SEASON** (owner, 2026-09-24: "BIOBUZZ Act 1's 2D records should NOT get
filtered off the boards"). The LIVE season is the live solve; an ARCHIVED season is the solve
most of its rows were played on, so Act 1 reads as a 2D board and pays its record awards off it.
Reading it as `'3d'` emptied the board and claimed the period with zero winners, permanently.
`/api/records` echoes the era and `Leaderboard.tsx` keeps rows of that era.
`submitRecord` refuses a 2D container at the table, read off the replay and never off a body.
Pre-ruling 2D rows are KEPT (no season reset); they just stop appearing. Covered in
`npm run dbtest`.
**ADMIN MENU** (`src/ui/Admin.tsx`, `/admin`) gated on the signed-in UUID (`ADMIN_USER_IDS`;
the server enforces every action independently). **VERSION GATE**: a new build is detected
(`__BUILD_ID__` → `/version.json` poll) and forces a refresh when a player STARTS a run
(never mid-run) — no "play anyway", everyone must be on the same version for multiplayer.

### The admin console's own rules

Seven tabs — Live, Users, Moderation, Content, Server, Audit, Analytics — and the order is the
order of an incident. **APPEND a new tab, never reorder.** Tab + open account live in the URL
HASH (`#tab=users&user=<id>`), not the path or the query: `App.tsx` owns routing and
canonicalizes `pathname + search` on mount, so anything put there is stripped.

- ⚠️ **THE CANONICALIZE MUST CARRY THE HASH FORWARD** (`App.tsx`, `replaceState(canonical +
  location.hash)`). "The hash is ignored by all of it" was the design and was NOT true:
  `pathFor` emits neither a query nor a hash, so replacing the URL with it alone DELETED the
  fragment. The unprefixed `/admin` canonicalizes to `/decode/admin`, which is never equal, so
  every pasted console link was rewritten to a bare path before `Admin` mounted and opened on
  Live — the one thing the hash exists for. The QUERY still goes; `?token=` is captured at
  module load and must not survive.
- ⚠️ **THE WHOLE CONSOLE IS A LAZY CHUNK.** `App.tsx` `React.lazy`s `Admin`, which is the only
  boundary between this graph and the bundle a player downloads to drive a robot — `Admin.tsx`
  statically imports `AdminLive`, `AdminReports`, `AdminAudit`, `AdminUser`, `AdminStanding`
  and `adminBits`, so an eager import put all of them in `main` for everyone. `npm run
  bundleaudit` has an `admin` route so the console's growth is measured where it lands instead
  of falling into `other`, whose near-zero baseline means something else.

- ⚠️ **"(no profile)" WAS THREE DIFFERENT SITUATIONS WEARING ONE LABEL, and it is now one
  function** — `AccountName` (`src/ui/adminBits.tsx`), fed by `profileNames` in repo.ts. The
  bug: `adminPresence()` resolves handles by joining `profiles` over the HEARTBEAT rows, but
  `operatorSnapshot()` in `server/index.ts` assembles this machine's own snapshot from live
  socket state and `PresencePlayer` carries no name field at all (deliberately — a name on a
  5-second heartbeat goes stale the first time somebody is renamed). `mergeMachines` then
  REPLACES the database row for the local machine with that fresher, nameless one, throwing
  away the only names it had. On a single-region deploy that is every signed-in session, all
  the time. The route now resolves names for the local snapshot too, `known: false` says "there
  genuinely is no `profiles` row yet" (it is created lazily by `ensureProfile` on the API
  routes a client hits, not when its socket authenticates), and the client merge keeps the
  database row's names as a fallback for an OLDER SERVER — one Fly app serves every client.
- **EVERY MUTATING ADMIN ROUTE WRITES TO `admin_audit`** (migration 0041), in addition to
  whatever domain record it already keeps (`supporter_grants`, `standing_events.voided_by`,
  `match_score_corrections`, `player_reports.reviewed_by`). Those four carry the before/after a
  reversal needs; this one answers "what has this moderator done", "what has been done to this
  account", "what happened on Tuesday". No foreign key either side — an admin is an env id and
  a target may be deleted — so the log outlives the account it names. `writeAudit` NEVER
  THROWS into a route (same rule as `server/standing.ts`), the tab is read-only by
  construction, and the `secret` actor is the `ADMIN_SECRET` deploy-script path, not a person.
- **`admin_notes`** is a moderator's private note on an account. It could not go in
  `standing_events`, which is read BACK to the player (0036).
- **SUSPENSION (`profiles.suspended_until` / `suspended_reason`, migration 0043) IS THE ONLY
  LEVER THAT STOPS SOMEBODY PLAYING.** Everything else stops short: a forced rename takes a
  word off them, clearing their records takes the scores off the boards, and a standing charge
  locks RANKED only — by design, since it is the automatic penalty for leaving matches and is
  sized to heal on its own. **It is a DEADLINE, not a flag**, so a temporary suspension ends by
  ARRIVING rather than by a second human action nothing schedules; a permanent ban is a
  far-future date, which reads as a decision instead of an omission. `null` and an EXPIRED date
  both mean "not suspended" (`getSuspension`), and the gate fails OPEN for an unknown id, the
  same rule `emailGateRefusal` states. Enforced at TWO doors in `server/index.ts` — the room
  `join` and the ranked `queue` — with **no staged-room exemption**, unlike maintenance: the
  custom rooms are the point of it. The join door reads the database rather than a cache
  (maintenance is cached, deliberately) because the moment it matters most is the moment after
  a moderator presses the button. **The `reason` IS SHOWN TO THE PLAYER** at the door, so it is
  not the place for a private note — that is `admin_notes`, and the console says so beside the
  box. Format it with `suspensionLeft`, never `lockRemaining`: that one is the standing lock's
  minutes-and-hours scale and rendered a one-week ban as "168 hours".
- **The other four things a moderator can now do**, all on the account panel, all audited:
  **clear an abusive @username** (`clearUsername` — CLEARED, not set, so the account goes back
  through `UsernameGate` and the moderator is not choosing somebody's permanent public name);
  **delete an account** (the same `deleteAccount` the player's own button calls, refused for a
  staff id because `syncStaffRoles` would re-create the row at the next boot; the audit row is
  written BEFORE the delete, since afterwards there is no `profiles` row for the log's join to
  name); **read the reports it filed and received** (`listReportsBy` — ⚠️ `player_reports`
  cascades on BOTH parties, so a "filed" count is a FLOOR, not a total); and **flag a Ko-fi
  payment charged back** (`listKofiPayments` — the refund route is keyed by the TRANSACTION and
  the panel only ever showed GRANTS, which is why it had no caller at all; flagging does not
  revoke, which stays a second decision).
- **`GET /api/admin/user?id=` is the one read behind the user detail** — nine bounded queries
  in parallel. It answers for an id with NO profile row (`known: false`) rather than 404ing:
  that is the state somebody is looking at when they arrive from a session that said it was
  signed in.
- **EVERY LIST IS PAGED AND HARD-CAPPED IN THE DATA LAYER**, not by the route (the
  `boardPhysics` argument: a default a new call site cannot forget). `listAudit` caps at 200;
  `searchProfiles` takes an offset and is tie-broken on `user_id`, because `handle` is not
  unique and two people called "Player" otherwise page one row twice. Both `ilike` searches
  ESCAPE `% _ \` — a bare `%` used to enumerate every account on the service, and those rows
  carry the membership and the staff role.
- **POLLING PAUSES WHILE THE TAB IS HIDDEN** (`usePolled`). The console polled presence and
  maintenance at 5s and matches at 30s on bare intervals, forever: an admin tab left open
  behind an editor was by itself enough to keep the game server — which auto-stops when idle —
  permanently awake.

### Lockdown and access groups (0023, 0051)

The one `maintenance` row is the LOCKDOWN. `server/siteState.ts` caches it (10 s) and owns the
rule; `lockdownPasses` in repo.ts is the pure form smoke and dbtest pin.

- **SCOPE.** `matches` is the old window: no new matches, menus stay. `site` closes the app:
  the client shows the closed screen, and the server also refuses spectating, LAN joins and
  every `/api` POST. A POST without `scope` means `matches` (older console, release curls).
- **WHO PASSES.** Admins (`ADMIN_USER_IDS`, the owner included) always. Otherwise membership
  of a group the lockdown lists in `bypass`. Nobody else, signed in or not.
- **WINDOW.** `startsAt` null = now, `endsAt` null = until lifted. Open-ended is allowed for
  both scopes; the alpha closure is one. A scheduled one announces itself and bites at its start.
- **THE DOORS** (all `lockdownRefusal`, `match` = either scope, `site` = site scope only):
  room `join` (match, staged rooms exempt), ranked `queue` (match), a room `start`/`restart`/
  rematch vote (match, staged rooms exempt; a lobby formed before the window cannot play
  through it), `lanHost` (match), `spectate` and `lanJoin` (site; `lanJoin` now carries an
  optional token), every non-GET in `handleApi` (site; exempt: the Ko-fi webhook and
  `/api/user/delete`). `rejoin` and `abandon` stay open: a match already running finishes and
  persists. Reads stay open.
- **ACCESS GROUPS** (`access_members`): `beta`, `dev`, `contributor`, keyed by USER ID and
  cascading with the profile. Granted by player tag (`resolvePlayerTag`: id, then @username,
  then display name; a shared display name is an error naming the @usernames), listed with
  today's handle. `POST /api/admin/access` (grant / revoke / bulk), each grant and revoke in
  `admin_audit` as `access.grant` / `access.revoke`. Cached 30 s per account; the granting
  machine drops its entry at once. **Each deployment has its own list**: alpha reads the alpha
  database. A tag that has never signed in on that site does not resolve: `GET /api/status`
  creates the profile, so signing in once on the closed screen is enough.
- **Not built:** a badge for testers on profiles or rosters. `profiles.role` is untouched.

**STAFF ROLES — owner + admin badges, and perks, DONE.** `profiles.role`
(`0020_staff_roles.sql`) is null | 'owner' | 'admin'. It is a **PROJECTION** of
`ADMIN_USER_IDS` / `OWNER_USER_ID` (`OWNER_USER_ID` defaults to the FIRST id in
`ADMIN_USER_IDS`), reconciled by `syncStaffRoles` once per boot after `migrate()` — the
env stays the source of truth; the column exists so the badge can be JOINED by the
leaderboard/roster queries instead of post-processed row by row (or the admin list
leaked to clients). **The sweep is SYMMETRIC** — an id removed from the env loses the
badge and the perks. **THE PERK IS ONE PREDICATE**: `SUPPORTER_COL` in repo.ts is read
by the ad gate, the cosmetic chassis colours, the saved-start cap, `/api/user/
entitlements` AND the badge, so `role in ('owner','admin')` is folded into that single
expression — never add a second "is staff entitled" check, extend that one. TWO places
deliberately keep the PAID predicate instead, because the entitled one would mislead
there: `searchProfiles` (the admin console's grant/revoke row — a colleague must not
read as a supporter with no expiry when you are deciding whether to comp months) and
the Donate page (staff get their own panel; the supporter one would say "through -"
and nag them to link a Ko-fi account that will never pay). `getSupporter` returns
`supporter: true` with `supporterUntil: null` for staff — that shape is intentional.
`LobbyPlayer.role` is **server-authored** exactly like `supporter` (a self-declared
"owner" beside a driver's name is an impersonation primitive). UI: ONE
`SupporterBadge` renders owner ★ > admin ◆ > supporter ♥ — exactly one, since staff are
also `supporter: true`. All three are ONE 128×128 SVG each drawn by `BadgeIcon` (disc and
glyph in one coordinate space; a CSS disc holding a separate glyph drifted); the earned
`stargazer` disc is drawn the same way, by `BadgeArt`. **Badge colours must be SATURATED IN BOTH THEMES**: the audit
checks the glyph against its own fill, NOT the badge against the card behind it, so the
lavender pastel (#34305c in dark) passed contrast while being invisible on the dark
panel. Distinguish by SHAPE as well as hue.
**ADMIN IS `--ds-staff`** (`shell.css` `:root`, cyan `#0e6f8e` light / `#6ec8e8` dark, with
`--ds-staff-ink`): off every other job — not alliance blue (admin was `--ds-blue-chip` once and
vanished on the results board's blue half), not the owner's `--ds-accent`, not the supporter's
`--ds-gold`. It INVERTS with its ink like the accent, so the ◆ disc (`.sup-badge.admin`) stays
saturated on both panels. The admin console's role label is the same hue as a text badge:
`.ds-badge.staff` (admin) / `.ds-badge.accent` (owner), in `AdminUser.tsx` and `adminBits.tsx`.
**THE BADGE GOES ON EVERY NAME**, and the failure mode is SILENT — a query that just
doesn't project the two columns still compiles and still renders, only bare, which is how
the ranked board sat badge-less next to a record board that was fine. So: `badgeCols(alias
[, prefix])` in repo.ts writes the pair once (the `prefix` form names a SECOND person in
the same row — a duo partner — as `partnerRole`/`partnerSupporter`, and `coalesce(…,false)`
is load-bearing on the LEFT JOIN a solo run takes), and client-side every row type
`extends BadgeFields` (`src/net/api.ts`) instead of re-declaring the fields. Surfaces
covered: both leaderboards (records incl. the duo partner + ranked, live AND archived),
career/profile (the `CareerPanel` name chip — the ONLY place My Stats prints who you are),
match history (every participant + record-run partners), friends/requests/challenges (both
directions), and username search. The friends poll used to skip the columns deliberately;
it no longer does — same already-joined row, and a badge that shows on the leaderboard but
not beside the same person in your friends list reads as a bug.
**A BADGE IS DECORATION BESIDE A NAME, NEVER PART OF ONE**: render it as a SIBLING of the
name element, because the name carries the hover underline (`.lb-name-h`, `.mh-player.link`)
and the ellipsis (`.fr-name`) — nested inside, it gets underlined with the name or
truncated with it. `.fr-nameline` exists for the stacked name-over-subline rows.
Tests: covered in `npm run dbtest` (which prints its own count — an exact number written
into this file goes stale the first time anyone adds a check, as the three that said 36 and
~61 had).

**AND THE WORN BADGES GO WITH IT.** Every surface that prints a name prints
`<SupporterBadge …/><BadgeMarks badges={…}/>`, in that order, as siblings of the name element:
both leaderboards, career, profile header, match history, friends + the request toast, the
lobby roster, the ranked strategy reveal and the Appearance preview. `BadgeMarks` is a component
for the reason the status disc is one: a surface that omits it still compiles and still renders,
only bare. `getProfile` projects `equipped_badges` (the profile row the room join already
reads), so `LobbyPlayer.badges` is server-authored beside `supporter`/`role` — a badge is a claim
to have won something. `sanitizePlayer` is an allowlist and `PlayerPatch` is a `Pick`, neither of
which names it, so a client cannot put it on the wire. `MatchDriver` carries `supporter`/`role`
for the results roster but deliberately **not** the badges: that row is one line with a
marqueeing name — see the note beside `.resx-roster-name` in `src/ui/styles.css`.
Two surfaces print no badge because they print no person: `DiscordLobbyList` (room codes and
seat counts) and `ChallengePicker` (a `@username` in its own dialog title, reached from a
friends row that already carries both).

**TITLES ARE GONE (migration 0049, owner 2026-09-24): "titles are now essentially the same thing
as badges … remove titles completely".** Every competitive grant had delivered a title AND a
badge for one finish. 0049 stripped title items from `reward_grants`, turned the star's
`title:stargazer` into the `stargazer` badge, moved whoever was WEARING a title onto its badge
(if held, and if a slot was free), and nulled `profiles.title` — the column stays, unread.
Which act or season a badge came from is its grant's `reason`, shown in the profile's trophy
case (`AwardList`, each row drawn with `awardBadge`). ⚠️ **One Fly app serves every client**, so
`/api/user/title` still answers (GET: nothing; POST: `null` only) and the reward routes still
send `title: null, earnedTitles: []` (`RETIRED_TITLE_FIELDS`, `server/api.ts`) — an old client
calls `earnedTitles.includes` unguarded. Remove both once no pre-0049 client can connect.

**REWARDS — EVERY GRANT IS CLAIMED, NEVER SILENT (migration 0048, 2026-09-22).** Owner: "Titles
should not ever silently get added UNLESS specified." Every badge and cosmetic an account is
given is a row in `reward_grants`, unique on `(user_id, grant_key)` where the key names the
reward and its period (`ranked:<game>:act<N>:<mode>`, `record:<game>:bv<N>`, `stargazer`).
- **PENDING DELIVERS NOTHING.** A pending grant's badge is not in `badgeCounts` and its cosmetic
  is not in `profiles.cosmetics`. `claimReward` applies it in one transaction. The claim dialog
  (`src/ui/RewardDialog.tsx`) is the only way in, mounted inside `AppShell` (never over a match),
  behind `TermsGate`/`UsernameGate` (its parents) and every other shell modal (`blocked`).
- **ONE CARD PER ITEM** (owner, 2026-09-24): the star gives a badge AND a decal, and one "Equip
  now" for both did not say which it wears. `grantCards` (`src/rewards.ts`) orders a grant's
  items, badges first; each is a card with its own Claim / Equip now. The FIRST card's answer
  claims the whole grant (`answerCard`, `rewardsStore.ts`, with `equip: false`); Equip now then
  wears that card's item only (a badge via `/api/user/badges`, a decal on the active robot). The
  claimed grant is held in `revealing` so its later cards still show once it leaves `pending`.
- **`grantReward` IS THE ONE DOOR.** Silent is a per-source CODE flag (`REWARD_SOURCES`, off unless
  a row says so); the only silent source is `legacy`. `grantCosmetic` is now the inventory write a
  claim makes, not a grant path. A revoked grant keeps its row (`revoked_at`), so a re-star re-opens
  the same key as pending instead of minting a second grant.
- **BADGES COUNT** (`src/badges.ts`). Five closed ids: `ranked-gold|silver|bronze` (act podium),
  `record-holder` (season records) and `stargazer` (the GitHub star; revocable, never past 1). The
  count is claimed, unrevoked grants carrying the id. `profiles.equipped_badges` (`[{id,n}]`, at
  most 3 — the owner kept 3 when titles folded in) is a PROJECTION of that count, rewritten only by
  `refreshEquippedBadges` on every claim, revoke and equip, and projected by `badgeCols` so every
  name surface gets it free. No evolving art by count yet (owner, 2026-09-24: not now).
- **THE CRITERIA** (`runRewardJob`, owner 2026-09-22). End of every ranked ACT: top 3 of each ladder
  via `eloLeaderboard` (placed players, `user_id` last on ties) → a podium badge. End of every
  SEASON: the SOLO record board's overall top 3 and each drivetrain's #1 via `recordLeaderboard`
  (its `boardPhysics` default) → one grant per player per season, every placement on its
  `reason`, ONE `record-holder` badge.
  **Act 0 is never paid**, ranked or records. Duo boards are out (`RECORD_AWARD_MODES`); adding
  `'duo'` there is the whole change.
- **ONE JOB FOR THE BACKFILL AND THE ROLLOVER.** `runRewardJob` pays every CLOSED period not yet in
  `reward_periods` (a season is closed once `currentSeasonNumber` is past it; an act once a seasons
  row exists in a later act). It runs at every boot on every machine and after every
  `startNewSeason`, outside the roll's transaction so it can never fail the roll. The period row is
  claimed in the same transaction as its grants: the first machine pays, the rest skip, and a period
  is never re-paid when its board later changes (a deleted record, a deleted account).
- **WHERE PAST STANDINGS COME FROM.** Nothing snapshotted an act's final ladder before this job. A
  closed act's final standings are its `elo_ratings` rows (keyed by act since 0013; nothing writes a
  closed act's row except `chargeRatingForBehaviour`, which targets a player's most recent board).
  Season records are `records` rows stamped with `balance_version`. Each grant's `reason` now stores
  the rank and the rating or score it closed on.
- **`season_awards` (0045) IS RETIRED**: nothing writes it; its rows stay in the trophy case. A
  placement both hold is one trophy-case row (`trophyCase` dedupes by `awardKey`).
- **THE STAR**: `STARGAZER_ITEMS` (`repo.ts`) is the badge and `decal:star` on ONE grant, so they
  arrive and leave together. The sweep's "already holds it" reads a live grant or the decal in the
  inventory (the badge has no inventory entry). A revoke re-counts the worn badges, so the disc
  comes off the name in the same transaction.
- **OLD CLIENTS** never call `/api/user/rewards`, so they never see a pending grant. An older server
  404s the new routes, which the client reads as "nothing pending". Tests: `npm run dbtest` (the
  job, Act 0, ties, per-drivetrain #1, pending → claimed → equipped, the counter, silent, 0049,
  the cascade) and `npm test` (keys, words, cards, queue order).

**COSMETICS — TWO SEPARATE LEDGERS, DONE** (`docs/cosmetics-plan.md`). `chassisColor` /
`accent` / `decal` / `plate` (`src/cosmetics.ts`) are four closed-set axes on `RobotSpec`;
`coerceSpec` clamps their SHAPE only (see `docs/area/physics.md`). Entitlement is enforced
separately, at the server's live ingress: `stripUnentitledCosmetics(spec, supporter, earned)`
runs AFTER `coerceSpec`, at every point a client DECLARES a spec — `server/index.ts` (join,
the ranked queue player, since its spec feeds the staged roster's pre-match build preview)
and `server/room.ts` (the `update` patch, off `Client.earnedCosmetics` cached at join so a
re-pick costs no DB round trip). It NEVER runs over replay re-simulation or `createWorld` —
an old replay must keep the look it was recorded with, whoever watches it and whatever their
entitlements are today; see physics.md's note on why that check cannot live in `coerceSpec`.
A supporter's palette is the existing `SUPPORTER_COL` predicate, unlocking all at once — this
ledger holds only EARNED, permanent unlocks: `profiles.cosmetics jsonb` (migration `0044`),
`"<axis>:<key>"` strings, written only by `grantCosmetic`/`revokeCosmetic` (repo.ts, id
validated against `COSMETIC_AXES`) and logged to `admin_audit` (0041) like a supporter grant
— never by a client. The two ledgers are deliberately kept apart: a lapsed membership must
never delete something earned, and an earned unlock must never quietly become something sold.
`GET /api/user/entitlements` carries the account's unlocks as `unlockedCosmetics` (decorative
only — the server independently strips regardless of what a client remembers this said).
Tests: `npm run dbtest` (migration, grant/revoke round-trip incl. idempotent re-grant, the
audit rows, and the strip's three cases — free downgrade, supporter keeps a paid key, earned
survives a lapsed/absent membership); `npm test` for `coerceSpec`'s shape clamp, its
replay-safety invariant, and the `worldHash` non-interference check.

**MATCH REPLAYS ARE PRIVATE BY DEFAULT — THEY BELONG TO THE PEOPLE WHO PLAYED THEM**
(`profiles.replays_public`, migration `0038`). A replay is an input log re-simulated at full
fidelity, so it does not show a score, it shows the GAME PLAN — where you start, what you go for
first, when you leave for the endgame. `/api/replay/<id>` used to serve any of them to anyone and
the public profile hands out the ids, so every leaderboard row was one click from a stranger's
scouting feed.
**`replayAccess(replayId, viewerId)` in repo.ts is the ONE decision**, and the api route calls it
BEFORE `getReplay` — a refused viewer must not cost two jsonb blobs the size of a match. It
returns the refusal's KIND as well as its verdict, because a private match, somebody else's
practice run and a self-hosted event are three different answers to "why can I not watch this"
and one generic line is wrong about two of them (`replayRefusalMessage` owns the sentences, beside
the rule rather than in the route). Per owner:
- **versus** — EVERYONE WHO PLAYED IN IT, from either alliance, always. It is as much the
  opponent's match as the subject's and they watched the whole thing live, so there is nothing
  left to withhold; the Watch button therefore has to survive being reached from somebody
  ELSE's profile page, not just from your own history. Outside that roster, only when every
  participant has opted in.
- **record** — public. A record run is a leaderboard submission and its replay is the PROOF,
  which is what keeps a score checkable by the people it ranks; score-attack also has no
  opponent in it to expose.
- **practice** — owner only, matching `/api/practice`, which was already self-scoped on both
  verbs and had only an unguessable uuid protecting the replay itself.
- **lan** — THE HOST ONLY, plus staff. A self-hosted match is somebody's own event on somebody's
  own machine and `lan_runs` already exposes exactly one read path (one host's own matches,
  0033). Its drivers are NAMES rather than accounts, so there is nobody else `replays_public`
  could speak for — which is an argument for keeping it shut, not for leaving it open. It still
  lands in the database, where staff can reach it.

**UNANIMITY is the load-bearing choice for a versus match** — the log shows both alliances, so a
unilateral opt-in publishes the opponent's strategy as surely as the opter's own, and an opt-out
your opponent can defeat is not one. The consequence is real and intended: almost nothing is
public, and the account toggle says so in its own copy rather than letting somebody infer it
from a switch.
⚠️ **UNANIMITY IS OVER THE ROSTER, NOT OVER THE ROWS THAT SURVIVE.** `match_participants` holds a
row only for an AUTHED player (`persistMatch` drops the rest) and cascades away with a deleted
profile, so "every row says yes" is NOT "everyone who played said yes". A 1v1 against a
signed-out opponent stores ONE row, and publishing on that row alone publishes a match against
somebody who was never asked and has no account to ask with. So the count is checked against what
`matches.mode` says the roster was — `ROSTER_SIZE`, 2 for a 1v1 and 4 for a 2v2 — and short of
that the match never goes public. A departed or anonymous player is a permanent no, which is the
safe direction for a consent check to fail in.
**DEFAULT DENY**: a replay nothing points at is refused. Every table with a `replay_id` is named
in `replayAccess` (`grep replay_id server/db/migrations/`), so an unrecognised owner is an orphan
— a gate whose unknown case is "allow" is one a later migration opens by accident. A MISSING
replay is still a 404, though, because a season purge deletes replays and telling somebody their
dead bookmark is *private* sends them asking a player to publish something that no longer exists.
**STAFF ARE EXEMPT AND THAT IS NOT OPTIONAL** — `AdminReports` reaches a match through this same
route (`watchReplay` → `/replay/<id>`), and moderation that cannot see the match is not
moderation. It reads `profiles.role`, the projection of `ADMIN_USER_IDS` that exists so exactly
this kind of question can be answered in SQL, so the exemption is SYMMETRIC with the env like
every other staff perk; the lookup runs only for a signed-in caller who has already been refused,
never on the happy path.
**EVERY CUSTOM GAME IS KEPT, ONE-SIDED OR NOT** (owner, 2026-09-24: "users can't see their
custom room games"). `persistVersusMatch` used to drop any room without an authed player on
BOTH alliances (vs a guest, alone, two accounts on one side), and a room that had seated a bot
wrote nothing. So the game never reached anyone's history. Now only a RANKED room needs both
sides. A custom one writes its row whatever the roster, and a bot room (`MatchOutcome.bots`)
does too but credits no `user_activity`. The Career panel's "Ranked W–L" is `m.ranked` only,
so these add no free wins. A short roster never goes public (see UNANIMITY above), so a
one-sided game is watchable by its players and staff only.
**THE HOMEPAGE COUNTS GAMES AT THE SOURCE, NOT FROM `records`/`matches`** (owner, 2026-09-25:
count custom, practice, LAN and Discord games too). `play_counts` (migration 0050) is a counter
per UTC day × game × source (`record`/`ranked`/`custom`/`discord`/`practice`/`lan`) × mode.
Server rooms count in `persistMatch` BEFORE the anonymous drop (`playSourceOf`), so a room with
no signed-in player still counts. Practice and LAN run off the cloud, so the client reports them
to the public `POST /api/played` when it is online (LAN: the host only); the route is throttled
per hashed address and always answers 204. `getGlobalStats` folds the split for the homepage:
Solo = record solo + practice, 1v1/2v2 = ranked only, Custom = custom + Discord + LAN. Do not
derive the headline from the history tables again: they drop exactly the games this counts.
**THE MATCH HISTORY LIST STAYS PUBLIC** — results, scores, W/L and rating deltas are the
leaderboard's substance. What comes off the page is the WATCH BUTTON: `userMatchHistory` takes a
`viewerId` and nulls `replayId` on a row that reader may not watch, so the button is absent rather
than present and answering 403. The flag rides along on the participant fan-out's existing
`profiles` join, so the gate costs no extra query there.
⚠️ **THE FLAG COULD NOT LIVE IN `profiles.settings`.** That blob is client-shaped,
client-validated and opaque to the server — nothing in SQL reads it — so a privacy bit stored
there would be enforced only by asking the client, which is not enforcement. It is a real column,
and it is on `profiles` rather than in a skinny table like `user_presence` (0016) because it is
written when somebody changes their mind, not on every heartbeat, and because the bit is not
itself a secret. Every public read of `profiles` projects an explicit allowlist (`ProfileCols`),
so it cannot join a payload by accident.
⚠️ **`/api/replay/<id>` AND THE TWO HISTORY ROUTES ARE NOW OPTIONALLY AUTHED** (`viewerId(req)`
server-side, `maybeAuthedJson` client-side): the token rides along when there is one and its
absence is anonymous rather than a 401. The server helper short-circuits on a missing header
instead of letting `verifyAuthToken(undefined)` answer null, because that function LOGS on the
way out and these are the routes a signed-out visitor hits. **A replay change is a SERVER change
— deploy it**, and this one is also a CLIENT change: the server half closes the hole for every
client version including stale tabs, the account toggle and the viewer's refusal copy need
Vercel. Tests: a block of its own in `npm run dbtest`, mutation-checked BOTH WAYS — reverting
to the pre-0038 world reds every assertion about access being REFUSED while the ones about
access being GRANTED (participants, the opponent, staff, the record proof, the 404, the refusal
wording) stay green, which is the point of having both halves; and dropping the roster term
from `versusReleased` reds exactly the history row whose roster is short.

**AUTHENTICATION FLOWS — password reset, email verification, terms acceptance, BUILT.**
`src/lib/authFlows.ts` is the ONE module that calls Neon Auth for any of them, because
`@neondatabase/auth` is a BETA SDK whose client surface is generated from Better Auth’s route
table — a dependency bump can rename a method nobody here touched, and this way that is a
one-file fix. It is pinned to the EXACT installed version for the same reason. Every function
returns a discriminated result and NEVER throws at a component.
⚠️ **THE SDK THROWS ITS FAILURES RATHER THAN RETURNING THEM.** The Neon adapter installs its own
`customFetchImpl` which throws a normalized `AuthApiError` on any non-2xx, so the `{data, error}`
union the `.d.mts` advertises is real but `error` is essentially never populated — everything
arrives in a `catch`. Classifying a throw as "the network failed" told somebody holding an
expired reset link to check their connection. The throw carries `status` and a lower_snake
`code` (`bad_jwt`, `weak_password`, `over_email_send_rate_limit`), which is the ADAPTER’s
vocabulary and not Better Auth’s SCREAMING_SNAKE one; `classifySdkError` speaks both, and tests
rate limiting BEFORE the address because EMAIL is a substring of that last code.
⚠️ **NEON AUTH VERIFIES AN ADDRESS WITH A CODE, NOT A LINK** (2026-09-25). `sendVerificationEmail`
sends it, but the email carries a one-time code, and the SDK's own adapter refuses link-style
verification ("Use email OTP authentication instead"). For months the app knew only the link
path, so the email arrived and there was nowhere to type the code. It is completed through
`emailOtp.verifyEmail({ email, otp })` (`verifyEmailCode`), rendered by `VerifyCodeForm` in the
Profile banner, the sign-up dialog's code step, and `/account/verify`. A refused code (INVALID_OTP,
OTP_EXPIRED, TOO_MANY_ATTEMPTS) is `invalid-code`, never the expired-LINK sentence. **No copy may
say what an unverified address is refused**: that depends on `REQUIRE_VERIFIED_EMAIL`, which the
client cannot see, and the banner claimed "ranked needs it" while the gate was off.
**A GOOGLE ACCOUNT SETS A PASSWORD BY CODE** (2026-09-25, Profile ▸ Account ▸ Password). The
client cannot call Better Auth's `setPassword` (server-scoped), but `/email-otp/reset-password`
CREATES the `credential` account when there is none, so `requestPasswordCode`
(`sendVerificationOtp` type `forget-password`) + `setPasswordWithCode` give a Google user an
email+password login, and change an existing password the same way. The row reads
`listAccounts()` (`credential` = has a password); an unreadable list is `null` and the row says
nothing definite. The same route also marks the address verified.
⚠️ **`forgetPassword` IS NOT A TOP-LEVEL METHOD** on this build — only `forgetPassword.emailOtp`,
a different flow. The top-level request is `requestPasswordReset`.
⚠️ **THE EMAILED TOKEN IS CAPTURED AT MODULE LOAD** (`src/ui/entryToken.ts`): App’s mount effect
canonicalizes the address bar with a path that has no query string, so `?token=` is gone before
a screen renders.
**THE VERIFIED-EMAIL GATE IS ONE PREDICATE** — `emailGateRefusal` (`server/auth.ts`), read by the
ranked queue door, the record-room join door and `POST /api/practice`. Extend it; never add a
second "is this account allowed" check. It is OFF unless `REQUIRE_VERIFIED_EMAIL=1`, because every
email/password account that exists today is unverified and the sender domain is an owner dashboard
action (`docs/deploy.md` §4) — default-on would refuse ranked to everybody with no way to fix it.
`null` (nobody told us) counts as VERIFIED: a gate whose unknown case refuses goes dark silently. When the JWT carries no claim, the answer comes from Neon Auth's own `neon_auth."user"` row in the game DB (`authEmailVerified`), then `/get-session`. ON on `dsim-alpha` since 2026-09-25.
⚠️ **THE RECORD GATE LIVES IN `server/index.ts`, NOT `Room.startMatch`** beside the duo-record
guard it belongs with — `server/room.ts` is bundled into the LAN host worker and may not import
`jose` or read `process.env`.
**TERMS ACCEPTANCE** is `profiles.terms_version` + `terms_accepted_at` (0040, both nullable and
deliberately NOT back-filled: recording an acceptance that never happened is the thing the columns
exist to prevent). `POST /api/user/accept-terms` takes NO body — the version is the server’s own
`LEGAL_VERSION`, so a client cannot accept a revision that does not exist or pre-accept the next
one. `termsGateState` (`src/legalText.ts`) is the pure rule and `undefined` — a server older than
the route — must never block. `TermsGate` WRAPS `UsernameGate` rather than sitting beside it: an
OAuth sign-up trips both, and two modal backdrops show one dialog dimmed behind the other.
Tests: `npm run dbtest` for the migration and the round trip; `npm test` for `termsGateState` and
the wrapper’s result shapes against a stub client.

**BACKGROUND RANKED QUEUE, LIVE (no flag).** The queue used to die when you left the
matchmaking screen — that screen owned the socket (`useEffect(() => teardown, [])`),
so queueing locked you out of the rest of the app, which is what stopped people
queueing at all. Now `Matchmaking` PARKS the live `LobbyClient` in `queueKeeper.ts`
(a module singleton — it must outlive the tree that made it) on unmount mid-search,
and ADOPTS it back on remount. **Nothing about how the socket is opened, queued or
handed to a match changed — only how long it lives**; that was the design constraint,
because this path costs real ELO when it breaks. `LobbyClient.on()` REPLACES, so both
hand-overs are plain re-registration. Two cases still tear down for real rather than
park: a match that already STARTED (the session owns the transport) and an in-flight
reconnect to the host region (`assigning`). `QueueBar` shows bucket/elapsed/cancel
while parked; match-found takes the screen back WITHOUT asking (the server forfeits
the slot after `RANKED_JOIN_GRACE_MS`, so a dialog is just a slower way to lose) and
DISCARDS any run in progress. An assignment arriving while parked is remembered on
the parked state — its event has already fired and won't fire again for the adopting
screen. **`updateQueue` must return a NEW object**: it mutated in place at first, so
`useSyncExternalStore` re-read an identical snapshot, skipped the render, and the
takeover silently never fired (the bar still looked right — it repaints on its own
1s timer). A smoke check asserts snapshot IDENTITY changes. `exposeForTesting` is
`import.meta.env.DEV`-only; a shipped bundle must never carry a handle that can
cancel a stranger's queue. **NOT yet validated end-to-end** — that needs two
signed-in accounts completing a rated match.

**PLAY A FRIEND — challenges (chess.com's model), DONE.** A challenge (`room_invites` +
migration `0019`) carries a **`format`**: `casual1v1`/`casual2v2` (a `versus` room),
`duorecord` (a `record`/`duo` room), or the two RATED ones. Rating is only ever applied to a
matchmaker-STAGED room (`Room.ranked` ← `pending_matches`), so a code-joined room can NEVER
rate — the rated formats therefore resolve through the MATCHMAKER, not through a room code.
The challenge's `room` column doubles as a **party token** both sides send on `queue`
(`party`/`partyOnly`/`partyFormat`; `RATED_FORMATS` in protocol.ts maps format → mode +
partyOnly). The matchmaker pairs on **UNITS** (`groupUnits`), never individual entries:
`rated1v1` is a CLOSED party (the token IS the match — no strangers, and the search radius is
skipped since they chose each other; the channel+build bucket still applies), `ranked2v2` is a
PREMADE that queues into the OPEN pool and is kept on one alliance by `allianceOrder`. That
same ordering needs NO 1v1 exception: there the party is the two opponents and half=1 splits
them correctly. **`partySize` (2) is load-bearing** — the members enqueue seconds apart, and
without it the first arrival reads as a complete unit and is swallowed by an open group.
**The token is VERIFIED, never trusted** (`challengeParty` → `verifyParty`): it resolves
against the real challenge row and only answers for an account named on it, so two clients
can't agree on a string and stage themselves a rated match, and a guessed token can't join a
pair. A token that fails is REFUSED, never downgraded to an open queue. Rated formats are
gated on **`SERVER_CAPS`** (`/api/presence` `caps`, read via `serverCaps()`) — the first
server→client capability, and NOT optional: an older server IGNORES the party fields rather
than rejecting them, silently matching two friends against strangers. Lifecycle is
Accept/**Decline** (decline MARKS `declined` so the sender is told once, then their client
cancels the row; dismiss stays a silent clear), the sender SEES their outgoing challenge
(`listFriends`'s `snt` CTE → `sent`) and can cancel it, and one live challenge per direction
(`inviteToRoom` replaces — stacked rated rows would let someone accept an abandoned token).
`src/ui/challenge.ts` `challengeOf` is the ONE place deciding lobby-vs-queue. Tests:
**`npm run test:mm`** (`scripts/mmsmoke.ts`, 186 checks, injected clock + `stage`, no DB) —
party pairing fails SILENTLY, so it is covered there rather than by a live two-account run.
NOTE `enqueue` matches synchronously but STAGES asynchronously; assertions must await a
microtask flush. Rated friend games are farmable by a colluding pair and deliberately
unmitigated (as chess.com); damp repeat-opponent deltas in `ranked.ts` if it shows up.


---

