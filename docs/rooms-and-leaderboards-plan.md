# Online rooms, run length, and leaderboard windows: scope (v3)

**v3, 2026-10-05.** v3 adds the owner's decisions on friends in ranked, physics eras, the rollover hour and room creation. v2 was revised after four reviews against `alpha` @ `1f4528f2`. The findings, the evidence and the decisions still open for the owner are in [rooms-and-leaderboards-review.md](rooms-and-leaderboards-review.md); `R§n` points into it. **Progress (branch `rooms-m0-friends-ranked`): M0 done; M1 server + lobby done (no Play-page split, no Public/Private control until M3, no record→versus unlock). Everything else is not started.**

## Context

Several asks from the owner, bundled:

1. **Split Play into Offline and Online.**
   - Online play means joining a room. Rooms can be any size, and the host controls:
     - the size cap
     - team switching
     - moving players between alliances
     - players per alliance
     - who is a player and who is a spectator
   - Today's fixed room types become **presets**.
2. **Retire the Live page.** Players browse live rooms instead. A player who joins from the list joins **as a spectator only**, and the host decides per user who may play.
3. **Auto-only or full runs.**
4. **Leaderboard categories:** Auto, TeleOp and Total.
5. **Leaderboard windows:** Daily, Weekly, Monthly and Lifetime, Hypixel-style.
6. **Friends are teammates, never ranked opponents.** You can invite a friend onto your alliance for ranked 2v2. You can't play ranked against a friend in 1v1 or 2v2. Every other invite goes to a room.
7. **Creating a room.** The host picks Public or Private, and a preset or Custom (start from scratch), when creating the room. Everything else is changed inside the room.

**Ranked is untouched**, apart from item 6: the rated 1v1 challenge goes, and the matchmaker never puts friends on opposite alliances. That covers the matchmaker, staged `ord-…` codes, Glicko and the queue. Competitions (`cm` staged rooms) are untouched too.

### Decisions

| Question | Decision |
|---|---|
| Which rooms post records | **Preset-locked.** A run posts only if it was a `record` room **and** its actual setups match the record shape: one alliance, 1–2 authed drivers, no bots, standard robots. The server derives this at `beginMatch` and at persist, never from the preset label. |
| Room creation | **Two choices on the create form:**<br>• **Public or Private** (Public preselected)<br>• **a preset, or Custom** (start from scratch)<br>Everything else (size cap, players per alliance, team switching, run length, roles) is set **inside the room**. The host can also flip Public/Private there. |
| Room visibility | **Public** rooms show in Browse rooms. **Private** rooms can only be joined by code or invite. Record quick-starts are Private. Discord-activity and LAN rooms are **never** listed. |
| Size ceiling | **Up to 4 drivers per alliance**, in M8 only. Until then, any split up to 4 seats, as today. Spectators can fill the room up to 24. |
| Friends and ranked | **Ranked 2v2 with a friend stays**: the existing `ranked2v2` party, always on one alliance. **`rated1v1` is retired.** The matchmaker **never stages friends as opponents**, in 1v1 or 2v2. Casual invites go to rooms. |
| Time windows | **Daily, Weekly and Monthly sit inside the current season.** They roll over at **08:00 UTC**: daily, Mondays for weekly, and the 1st for monthly. **Lifetime** spans seasons but **never mixes 2D and 3D runs**: each board shows one physics. |

### What exists today

- **Room kinds.** There are two: `RoomKind = 'versus'|'record'` and `RecordKind = 'solo'|'duo'` (`src/net/protocol.ts:204-255`).
  - Capacity is fixed by `roomCapacity()`: 4, or 1/2 for records.
  - That value is read at more than one point. `roomHost.ts:659` fixes it when a `RemoteRoom` is built, and it is also read by `initialFacts`, `Lobby.tsx` (210, 436, 1325, 1415), the LAN `hostWorker.ts:170`/`hostProtocol.ts:86`, and `lobbySummary`.
- **Host.** The host is the first joiner (`room.ts:1269`), and `passCrown` (1933) moves the role on. The host can only `start`, `addBot`, `removeBot` and `lobby`.
- **Alliances.** Each client picks its own alliance through `PlayerPatch`. Versus rooms already allow 3v1 and 4v0 with bots (`room.ts:826-855`).
- **Spectators.**
  - They live in a separate anonymous map (`room.ts:464`) and are attached by `attachSpectator`, which runs no auth and no seat-door checks (`index.ts:3841`).
  - A spectator can never become a driver (`index.ts:3135`).
  - Caps: 24 per room and 192 per machine (716-717).
- **Live page.** `/api/live` + `isPublicLive` (`index.ts:983, 2542`) list only record, ranked and competition matches already in progress.
  - `summary()` returns null outside a running match, and it has six readers, including the presence heartbeat.
  - The only lobby-phase listing is Discord's `/api/lobbies` (`lobbySummary`).
- **Records.**
  - Only the net total is stored (`records.score`), and boards are keyed per season.
  - Every reader of `records` assumes a full match.
  - The latest migration is `0060`.
  - `matches.mode`, `play_counts` and `season_awards` all `check (mode in ('1v1','2v2'))`.
- **Phases.** There is no exit after AUTO. Each game's `post` assessment also pays endgame and TELEOP lines (R§1 B4).
- **Worker rooms are on alpha** (`roomHost.ts`, `roomThreads.ts`, `roomWorker.ts`). Open PR #103 is a competing version (R§3).

---

## 0. Prerequisites (other PRs)

The reasons are in R§3.

| PR | What to do | Before |
|---|---|---|
| #103 | Close as superseded, or rebase it onto alpha's workers | — |
| #99 | Shared 60 Hz clock | M1 |
| #104 | Land it **amended**, with three changes: <br>• allow lobby spectating for *listed* rooms <br>• count host and spectator activity toward `LOBBY_IDLE_MINUTES` <br>• send promotion through `remoteLiveConflict` | M2 |
| #98 | Golden hash | M4 |
| #101 | Rebase as **`SIM_VERSION` 6** (alpha is already at 5) | M4 |
| #102 | Chain fixes | M4 |
| #100 | BIOBUZZ prebuilt engine | M8 |

## 1. Play page: Offline / Online / Ranked

`ModeSelect.tsx` gets three sections. They keep the existing "· offline/online" kicker style, and every label is in sentence case.

| Section | Tiles |
|---|---|
| **Practice · offline** | Solo practice · Free drive. The new run-length option (§4) goes in `MatchSetup.tsx`. |
| **Rooms · online** | **Solo record** and **Duo record**: quick-starts through today's `RecordRun`/duo path, created Private, with a "Full match / Auto only" `OptRow` remembered per device. <br>**Room**: the existing create/join form (`Lobby.tsx:1129-1266`). Under "New room" it has exactly two `OptRow`s: **Visibility** (Public / Private) and **Setup** (Solo record · Duo record · 1v1 · 2v2 · Custom). "Have a code" still seats you as a **player**. <br>**Browse rooms**: replaces Watch live (§3). |
| **Ranked · online** | Find match · Competitions (gated on `compete`). |
| LAN | As today. LAN rooms are never listed. The LAN `hostWorker` has no spectator support, so roles (§2.2) stay out of scope for LAN. |

**Naming** (R§5). Amend `docs/area/ui.md:560-561` to the noun **"room"**, then use it everywhere:
- the lobby h1 reads "Room {code}"
- the setup options are "Solo record", "Duo record", "1v1", "2v2" and "Custom"
- the visibility options are "Public" and "Private"

### 1.1 Friends: teammates in ranked, never opponents

**Today** there are five challenge formats (`CHALLENGE_FORMATS`, `protocol.ts:639`):

| Format | What it does now | After this change |
|---|---|---|
| `casual1v1` / `casual2v2` / `duorecord` | A room | Unchanged; these are room invites |
| `ranked2v2` | Both friends queue as a party into the open 2v2 pool, on one alliance (`allianceOrder`, `matchmaking.ts:1120`) | **Kept**, unchanged |
| `rated1v1` | A closed pair: the two friends are staged against each other | **Retired** |

**Steps:**
1. **Retire `rated1v1`.**
   - Remove it from `CHALLENGE_FORMATS` and `RATED_FORMATS` (`protocol.ts:660`).
   - `POST /api/friends/invite` returns **410** with a sentence for it. Today `api.ts:1716` silently coerces an unknown format to `null`, which would turn an old client's challenge into a bogus casual invite.
   - Keep `'party'` in `SERVER_CAPS`, because `ranked2v2` still needs it.
   - Old clients that still offer "1v1 · Rated" get the 410 message.
2. **Refuse a closed-pair party at the queue.** A `queue` carrying `partyOnly: true` or `partyFormat: 'rated1v1'` is **refused** with a sentence (`verifyParty`, `index.ts:448`). It is never downgraded into the open pool (accounts.md:562).
   - The `partyOnly` branch in `groupUnits`/the search-radius skip can then be deleted.
   - The `allianceOrder` comment about the 1v1 case (`matchmaking.ts:1115-1118`) goes with it.
3. **Never stage friends as opponents.**
   - When the matchmaker forms a group, it rejects any split that puts two accounts from `friendships` on opposite alliances, in 1v1 or 2v2. It tries the next candidate instead.
   - Load the friend pairs for a bucket's queued accounts once per tick (one query against `friendships`, `0016_friends.sql`), not once per candidate.
   - In 2v2 that also covers a premade's opponents and the two halves of an open group.
   - **Cost:** at low concurrency, two friends queued alone in the same bucket can't match each other, so they wait for a third player.
4. **Client cleanup:**
   - Drop the "1v1 · Rated" tile (`ChallengePicker.tsx:43`).
   - `challengeOf`/`formatLabel` (`challenge.ts:14-55`) keep a **retired** branch, so leftover pending `rated1v1` rows show "Retired challenge" with only Dismiss.
   - Rename the friends-row "Challenge" button to **Invite** (`FriendsPanel.tsx:656`). Its picker offers: **Ranked 2v2 (same team)**, then room invites (1v1, 2v2, Duo record, Custom).
5. **Room invites.**
   - The in-lobby invite (`FriendsPanel room?: RoomInviteTarget`, `Lobby.tsx:977`) is extended, not duplicated.
   - Invites carry the room's **current** `kind`, so a converted room isn't refused as "a different game mode" (`index.ts:3460`).
6. **Docs.** Update the PLAY A FRIEND paragraph (`docs/area/accounts.md:545-564`: `rated1v1` gone, plus the friends-never-opponents rule) and `PRODUCT.md:31`. The patch note leads with "rated 1v1 challenges are gone".

## 2. Room model

### 2.1 `RoomSettings`

```ts
interface RoomSettings {
  preset: 'custom' | 'solo-record' | 'duo-record' | 'casual-1v1' | 'casual-2v2'
  maxMembers: number                          // drivers + spectators
  perAlliance: { red: number; blue: number }  // seat total ≤ 4 until M8, then 0..4 each
  teamSwitch: boolean
  listed: boolean                             // Public = true, Private = false
  runLength: 'full' | 'auto'                  // §4; gated on M6
}
```

**Creation vs. in the room.**
- **On the create form** the host sends only `{listed, preset}`.
  - Each preset fills in the rest of the settings.
  - **Custom** starts at 2 / 2, team switching on, full run, with every control unlocked.
- **In the room** the host changes everything else through `roomSettings`: size cap, per-alliance, team switching, run length and roles, plus Public/Private. Presets stay a starting point, never a lock, except for record presets (below).

**Validation.** A new `coerceRoomSettings(kind, record, raw)` builds the settings when a room is created.
- Today the room config is the first joiner's unchecked `{...msg.config}` (`index.ts:3303`), so this must not trust the client.
- The LAN `hostWorker` calls it too.
- Staged codes (ranked, `cm`) ignore settings completely.

**Presets** are the defaults. Record presets lock `perAlliance` and `teamSwitch`.
- **Unlock settings** turns a record room into a versus room. It is one-way, and the confirm says "This room stops posting records."
- It is allowed only before the first run, because record rooms never recycle (`canRecycle` is versus-only, `room.ts:3782`).
- The deliberate `kind === 'versus'` gating stays as it is (imports, Zenith autos, bots).

**Mode labels.**
- Keep `matches.mode` at `1v1`/`2v2`. That column has check constraints.
- Add a nullable `preset` column to `matches`.
- Have `LiveRoom` and the listing carry `preset`, so a 3v1 custom room isn't labelled "2v2" (`eloMode`, `playSourceOf`, `game.ts:3640`, `App.tsx:1509`, `room.ts:1456`).

### 2.2 Members, roles, host controls

**Two maps stay separate.** A role change **moves** the `Client` object between `clients` and `spectators` and keeps its id. About ten loops over `clients` mean "seat holders", so merging the maps would break them (R§4).

**Roster.** `roster` gains `spectators?: {id, name}[]`. Spectators are never added to `players`, so old-client hosts can still START (`Lobby.tsx:427`).
- Hidden admin observers are always excluded.
- Spectators receive a coalesced, spec-free roster at most 4 Hz.
- The new per-member field is `seat: 'player'|'spectator'`. `role` is already taken by the staff badge.

**Promotion is a door, not a flag** (R§1 B1).
1. The host offers a seat, which sends `seatOffer` to the spectator. A spectator who has `canPlay` can also ask with "Ask to play".
2. The spectator answers on the same socket with `takeSeat {authToken, player, caps}`.
3. The server runs **`admitSeat()`**, factored out of `joinRoom`. It covers:
   - suspension
   - lockdown
   - email gate
   - one live game, including #104's cross-machine lock
   - one seat per account
   - the Discord group guard
   - the channel guard
   - the `friend_blocks` check
   - the cosmetics strip
   - `vetImportedPatch`
   - a capacity re-check
4. If it passes, the client moves maps and gets `seated {seatToken}`.
5. The person being promoted must advertise `rooms2`.

**Demotion.** The client moves to `spectators` and loses its seat:
- delete `seatToken`, so an old token can't `reattach`
- clear `ready`, `startPose`, `startRole`, `swapReq` and `zenithAuto`
- call `visuals.freeOwner`
- update the socket `spectating` flag and `spectatorTotal`

**Host messages.**
- `roomSettings {patch}`, `moveMember {id, alliance}`, `setRole {id, seat}`, `setCanPlay {id, canPlay}` and `kick {id}`.
- **Refused** when `pendingMatch || ranked`, and outside the lobby phase (strategy, `ready3d`, `viewready`).
- A cooldown applies to repeated actions against the same member.
- A `perAlliance` value below current occupancy is refused ("move 2 players first").
- Any move or role change clears that member's `ready`. Any settings change clears everyone's.

**Self-service.** The `update` handler drops `patch.alliance` when `teamSwitch` is off or the target side is full, which also enforces it for old clients.

**`passCrown`** only passes to players, preferring connected `rooms2` clients.

**Default `canPlay`.** On for public 1v1, 2v2 and Custom-setup rooms that have an open seat. Off in record rooms.

**Invites.** An invitee who arrives at a full room, or who was invited by someone who isn't the host, lands as a spectator.

### 2.3 Server plumbing

- **Settings-derived capacity.**
  - Replace `roomCapacity(config)` with capacity derived from the settings at every consumer listed in Context.
  - `Room.add` re-checks the total and per-alliance caps. An over-cap joiner becomes a spectator.
- **Worker mirror.**
  - `RoomFacts` (`roomThreads.ts:69`) mirrors `kind` and the settings, with an `Op` and a worker case for each.
  - `index.ts` reads `kind` through the handle. Today it reads the frozen `RemoteRoom.config` at 3452, 3460, 3711 and `releaseSoloRecordHold` 403.
- **Caps.**
  - `SERVER_CAPS` gains `rooms2`, and clients without it fall back to today's flows.
  - Any room or spectator above 4 seats requires every member to advertise `rooms2`. That covers joins **and** the spectate door, because an old spectator would decode an 8-setup `matchStart`.
- **Unchanged.** `ranked` is derived only from staged rows. Every staged-room guard stays.

### 2.4 Lobby UI

- **Host settings panel.** Built from `.ds-panel`/`OptRow`, with steppers as `.ds-opt.mini` + `aria-pressed`.
  - Non-hosts see label/value **Rows**, not disabled controls, because pad and keyboard can't focus a disabled control.
  - A locked record preset shows one visible sentence.
- **Roster.** Grouped Red / Blue / Spectators, with host actions in a `<details>` row menu (the FriendsPanel `RowMenu` pattern).
- **Status line.** Moves, demotions and seating are announced in a `role="status"` line.
- **Public banner.** Every member sees a "Public: anyone can find this room" banner while the room is Public.

## 3. Browse rooms (replaces the Live page)

- **New listing endpoint.**
  - A new **`listing()`** on `Room`, a `RoomFacts.listing` field, a separate heartbeat array, and **`GET /api/rooms`**.
  - It is answered from the primary region, with a 3 s cache.
  - `summary()` and `/api/live` stay **unchanged** while old clients exist, because old WatchLive would spectate lobby rows that never send `matchStart`.
- **What's listed.**
  - Listed rooms in **both** lobby and match.
  - Plus ranked, competition and record matches already in progress, as `isPublicLive` lists them today.
  - Never Discord-group rooms, LAN rooms or Private rooms.
  - Listing a room requires sign-in, and one listed room per account.
- **Privacy.**
  - Lobby rows show the preset, counts and the **host handle only**. Driver names appear only once a match is running, as today.
  - Rewrite `legalText.ts:268-270`, `WatchLive.tsx:176` and `ModeSelect.tsx:252-256`.
  - Unlisting can take about 8 s to show, and codes already seen stay valid. Say so in the UI.
- **Joining.**
  - A click spectates.
  - In a room that hasn't started, the spectator gets a **read-only lobby view** with "Ask to play" or "Waiting for the host". Today `spectateRoom` only moves on `matchStart` (App.tsx:1353-1371).
  - `/api/room?code=` only finds running matches, so the code lookup needs to find lobby rooms too.
- **Client.**
  - `RoomBrowser.tsx` renders inside AppShell and reuses `.ds-lobby-row`, including the season switch from `DiscordLobbyList.tsx:28-37`.
  - Two-line rows at phone width, and the four list states.
  - The empty state reads "No open rooms right now", with Create room. No CCU has been measured, so expect it to be empty often.
- **Removal checklist.**
  - App.tsx 62, 149, 255-256, 343, 427, 2385, 2572
  - ModeSelect 27, 49, 237-258
  - `robots.txt` `/watch`
  - `.ds-watchcode`
  - `fetchLiveRooms`
  - redirect `/watch` → `/rooms`
  - update the `index.ts:3135` comment and netcode.md (a spectator can now become a driver)
- **Kept as is:** AdminLive, the friends-panel Watch button and the competition Watch button.
- **Capacity.**
  - Every spectator is a full 30 Hz stream, about 175 KB/s.
  - Keep the 24 and 192 caps, plus #104's per-IP cap.
  - Run `npm run costprobe` before raising them.

## 4. Run length: auto-only

**State.**
- `World.runLength?: 'auto'`, **absent for full runs**, so full-run golden pins stay byte-identical and no `SIM_VERSION` bump is needed.
- It is set after `createWorld` in four places, the same way `simPatch` is: `ReplayPlayer`, `runRecordMatch`, the room's `beginMatch` and `game.ts`.
- Old predictors would run the transition, so rooms gate auto-only on a `CLIENT_CAPS` entry.

**Phase exit: AUTO → `post` directly, with no transition.** Rule B's "come to rest" is already the settle (`settle.ts:72-90`), and skipping the transition also avoids the pick-up-controllers announcer (`game.ts:1708-1720`).
- **Every game:** copy the `autoPathActive = false` line.
- **DECODE** (`src/sim/match.ts`):
  - under `autoOnly(world)`, `post` runs the auto-pattern assessment, not `assessMatchEnd`
  - `scoredAsAuto` is true in `post`
- **Chain** (`chain/step.ts:119-129`): under `autoOnly`, `isEndgame` is false, so there's no PARK/ASCEND credit for robots that start parked.
- **BIOBUZZ** (`biobuzz/step.ts:254-278`, which also covers 3D via `step3dImpl.ts:216`):
  - `bbAssess(world,'auto')` and then end
  - under `autoOnly`, `matchOver` pays no CELL, GARDEN or `parkTele`
  - a TIP that is already swinging still pays

**Replays.**
- Add a `replays.run_length` column (0061), threaded through `saveReplay`, `getReplay` and the `sanitizeReplay` allowlist.
- Auto-only containers are stamped **`REPLAY_FORMAT` 5**, so older builds read them as `future`.
- Fix `replayHasImported` (`src/net/imported.ts:80`), which treats `format >= 3` as imported.
- Persist reads run length **from the replay**, never from the settings.

**Offline.** Add a run-length label to the practice runs list (`practiceRuns.ts:44-45, 149`). `replaySavePolicy` already keeps completed short runs.

**Records.** An auto-only record run writes `score = auto_score` with `run_length = 'auto'`, and posts **only** to the Auto board. The human still drives during AUTO; Zenith autos stay refused in record rooms.

## 5. Leaderboards

### 5.1 Data: migration `0061_run_length.sql`

```sql
set local lock_timeout = '5s';
alter table records add column if not exists auto_score   integer;
alter table records add column if not exists teleop_score integer;
alter table records add column if not exists run_length   text not null default 'full';
alter table records add constraint records_run_length_chk
  check (run_length in ('full','auto')) not valid;
alter table replays add column if not exists run_length text;   -- null = full
alter table matches add column if not exists preset text;       -- §2.1
create index if not exists records_window_idx on records (game, balance_version, mode, created_at);
```

Migrations run as one transaction each (`migrate.ts:44-56`), so `CONCURRENTLY` is impossible. Hence `not valid` and the lock timeout.

The dead-prefix rule in dbtest passes against `records_board_idx`. The proposed lifetime index was dropped: `DISTINCT ON (user_id)` can't use it. Revisit only after an `EXPLAIN`.

**Capture.** Widen the competition-only gate at `room.ts:3302/3381/3460` to record rooms.
- The AUTO points come from each game's `rankFacts`: DECODE `final`, Chain `autoEnd`, BIOBUZZ `teleopStart`, or `final` when the run is auto-only.
- Snapshot the opponent's `foulPoints` at the same instant.
- Store:
  - `auto = max(0, autoGross − autoFouls)`
  - `teleop = max(0, teleGross − teleFouls)`
  - both 0 when the run was voided by a card
- Chain counts the transition as TELEOP. DECODE and BIOBUZZ count it as AUTO.
- Old rows have null splits and stay off the Auto and TeleOp boards. An optional backfill re-simulates replays still on file; `ReplayPlayer.log` stamps each foul's phase.

**Every reader filters on `run_length = 'full'`**, inside the `best` CTE (the same place as physics). Readers:
- `recordLeaderboard`, `personalBest`, `recordRank`
- `getUserStats` (5527-5537)
- the award job (1694/1702, through `recordLeaderboard`)
- `userMatchHistory`, `recentMatches` (label only)
- admin 3075/3093, export 3479 (label only)
- season counts 203, `boardPhysics` 77
- the persist toasts 194/216

The one exception is the Auto category, which reads every row by `auto_score`.

### 5.2 API and query

`/api/records` gains two parameters:

- **`category`:**
  - `total`: full runs, ranked by `score`
  - `auto`: all rows, ranked by `auto_score`
  - `teleop`: full runs, ranked by `teleop_score`
- **`window`:**
  - `day`, `week` and `month`: the current season, plus `created_at >= windowStart`
  - `season`: the default
  - `all` (Lifetime): every season, filtered to **one physics** (`2d` or `3d`) inside the `best` CTE, so 2D and 3D runs never share a board
    - The default physics is the live era's; BIOBUZZ gets a 2D / 3D switch on Lifetime because both eras exist
    - Rows with no `physics` read as `2d`, as `boardPhysics` already treats them (`repo.ts:67-82`)
    - Day, week and month already sit inside one season, so one era; they keep `boardPhysics`
- **Server-computed times.**
  - The server computes `windowStart` and `resetsAt` and returns them, and the client counts down against them.
  - **Rollover at 08:00 UTC**: daily, weekly on Monday, monthly on the 1st (about 3–4 am Eastern).
    - `windowStart` = the latest 08:00 UTC boundary of that kind.
    - `play_counts` keeps its UTC midnight days; only the boards move.

**Cache.** About 30 s, keyed by `(game, mode, drivetrain, category, window, windowStart)`. Including `windowStart` stops a rollover from serving the old window.

**Personal rank.** One query returns the player's rank in every window at once, using `max(x) filter (where created_at >= …)`. This replaces 15 separate `recordRank` scans.

**Unchanged.** The award job keeps reading **Total / Season / full**. Add a smoke check that pins it.

### 5.3 UI (`Leaderboard.tsx`)

- **Category.** Total · Auto · TeleOp, a third seg group in the existing panel head. Records only.
- **Window.** Fold it into the existing **Period** control as one select:
  - Today · This week · This month · This season · All time
  - past seasons stay in `PeriodPicker`
  - default: This season
- **Copy.**
  - Name the window boards as best runs ("Best run today"), not tallies.
  - "Resets in …" is static text, refreshed every minute and not `aria-live`.
  - The Auto board's empty state teaches the feature: "Run 'Auto only' from Solo record to post here."
- **Lifetime** shows a subtitle "All seasons · 3D" (or 2D). BIOBUZZ gets a 2D / 3D `OptRow` on Lifetime only.
- **Ranked** boards get no category or window.

## 6. Milestones

The prerequisites are in §0.

| # | Milestone | Migration |
|---|---|---|
| M0 | Friends and ranked: retire `rated1v1` (410, queue refusal, retired rows, picker), the matchmaker's friends-never-opponents rule, the Invite rename. `ranked2v2` unchanged | – |
| M1 | `RoomSettings` + `coerceRoomSettings`, presets, quick-starts, host panel, `moveMember`, settings-derived capacity, RoomFacts mirror, new Play page. Seat total still ≤ 4 | `matches.preset` (0061a) |
| M2 | Roles: `seatOffer`/`takeSeat`/`admitSeat`, `seated`, `canPlay`, kick, spectator lobby view | – |
| M3 | Browse rooms: `listing()`, `/api/rooms`, Live page removed, legal copy | – |
| M4 | Auto-only **offline** (World flag, phase exits, practice label) | – |
| M5 | 0061 columns + `run_length` filters on every reader + Auto/TeleOp/Total categories (full runs only) | 0061 |
| M6 | Auto-only **in rooms and records** (`REPLAY_FORMAT` 5, `replays.run_length`, the `CLIENT_CAPS` gate) | (in 0061) |
| M7 | Time windows + cache + one-query personal rank | `records_window_idx` |
| M8 | Rooms of 3–4 per alliance | – |

**What M8 needs:**
- authored start **slots** per game (DECODE's and Chain's anchors are alternatives about 5–10 in apart, `config.ts:3024-3030`, `chain/config.ts:962-967`)
- preload rules for robots 3–4 (`sim/spawn.ts:943`, `biobuzz/spawn.ts:376, 506`)
- sanitizer limits `setups ≤ 8`, `id ≤ 7` (`sanitize.ts:146, 152`)
- 8-robot `costprobe` rows
- capacity of 4 lifted at `protocol.ts:185/252` and `hostWorker.ts:170`

**Deploys.** Every milestone needs a server deploy. Claude writes the migrations; the owner deploys (`docs/deploy.md`).

## 7. Risks and open items

- **Owner decisions:** all resolved 2026-10-05 (R§6), except **net vs gross per-period fouls**. v2 assumes net.
- **Friends-never-opponents slows queues at low concurrency.** If wait times suffer, it can become a "prefer not" rule once a wait time passes. That would be a separate owner call.
- **Eight robots:**
  - server Rapier and Chain particle cost scales per robot
  - snapshot and replay sizes roughly double
  - every spectator pays that
  - scoring tuned for 2 robots (DECODE BASE bonus, BIOBUZZ SWARM) is acceptable for casual play only
- **Public rooms are a privacy change.** They need the legal copy and a patch-note line.

## 8. Verification

**`npm test`, with new smoke checks:**
- settings coercion and the preset lock
- host messages refused in staged and ranked rooms
- a promotion that fails each `admitSeat` door
- demotion invalidating the old seat token
- `passCrown` skipping spectators
- for each game: the auto-only exit, and no TELEOP or endgame points in `post`
- full-run golden pins unchanged
- the auto/teleop split, including a voided run
- the award job reading Total / Season / full

**Other suites:**
- `npm run dbtest`: the 0061 invariants, every `records` reader excluding auto runs, the retired-format 410, and the updated fixtures `dbtest.ts:5568` and `smoke.ts:10276`
- `test:mm`: `ranked2v2` premade still lands on one alliance; a `rated1v1`/`partyOnly` queue is refused; two friends are never staged as opponents in 1v1 or 2v2 (premade vs. a friend, and open groups); non-friends match as before
- `test:workers` (RoomFacts mirror, convert-to-custom on a worker)
- `test:comp` (`compe2e.ts:195` still sees `/api/live`)
- `server:check`, `build`, `uiaudit`, `bundleaudit`, `docaudit`, `costprobe` (before M8)

**Manual, on `npm run dev` with three tabs:**
1. Create a Public room with the Custom setup, then lock team switching inside it.
2. Move a player.
3. Browse to the room from the third tab and spectate.
4. As the spectator, ask to play. As the host, seat them. Then demote and kick them.
5. Run an auto-only Solo record and check that it appears only on the Auto board under Today, and that the profile PB is unchanged.
6. Create a Private room and confirm it never shows in Browse. Flip it to Public in the room and confirm it appears within about 8 s.
7. On BIOBUZZ Lifetime, switch 2D/3D and confirm no row crosses eras.
