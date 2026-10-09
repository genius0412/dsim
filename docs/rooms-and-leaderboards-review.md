# Rooms and leaderboards: review against `alpha`

**Reviewed:** `docs/rooms-and-leaderboards-plan.md` (v1) against `alpha` @ `1f4528f2` (= `origin/alpha` tip,
2026-10-05) and the open PRs (#98–#105). Four passes, all of them read-only and none of them run:

1. integration and fact check
2. netcode and security
3. sim determinism and data
4. product and UX

**Outcome:**
- The plan is sound in shape.
- **Three of its mechanisms were unsafe as written** (§1). Others contradicted code already on alpha or an open PR (§2).
- Every finding marked *applied* has been folded into plan **v2**. The owner's decisions (§6) are in **v3**.
- The decisions only the owner can make are in §6.

---

## 1. Blockers (P0)

| # | Finding | Evidence | Applied in v2 |
|---|---|---|---|
| B1 | **Promoting a spectator skipped every check at the driver door.** `spectate` is anonymous (no `markAuthed`, `sanitizePlayer(undefined)`), so flipping a flag would seat a client without: suspension, the record email gate, lockdown, one-live-game, one-seat-per-account, the Discord `group` guard, channel segregation, the cosmetics entitlement strip, or `vetImportedPatch`. | `server/index.ts:3841-3908, 3566, 3592, 3632, 3711, 3738, 3372`; `room.ts:606-611, 2021` | §2.2: promotion is a **door**. `seatOffer` → `takeSeat {authToken, player, caps}` → a shared `admitSeat()` factored out of `joinRoom`. |
| B2 | **The host controls worked inside staged ranked and competition rooms.** They are "lobby phase" while they wait for joiners (minutes, for `cm`), and the first joiner is host. That host could demote an opponent → `absentRoster` → `cancelPending` charges them a no-show. | `room.ts:834, 1269, 1651, 3112` | §2.2: refuse all new host messages when `pendingMatch \|\| ranked`, as `addBot` does. |
| B3 | **The client's `RoomSettings` would have been stored without validation.** The room config is `{...msg.config}` from the first joiner, and the decode is a bare `JSON.parse`. A client could mint `kind:'record'` at 4/4 with any preset label. | `index.ts:3303`; `protocol.ts:1285` | §2.1: `coerceRoomSettings(kind, record, raw)` at creation (and in the LAN `hostWorker`). Record eligibility is derived at `beginMatch` and at persist from `kind` and the actual setups, **never** from `preset`. |
| B4 | **An auto-only run would keep paying end-of-match points in every game.** DECODE `assessMatchEnd` runs every `post` tick (it double-counts the pattern into `telePattern`, adds depot and base), and `scoredAsAuto` is false in `post`. Chain: `isEndgame` is true in `post`, and robots *start* parked, so an idle run scores endgame. BIOBUZZ: `matchOver` pays CELL and GARDEN. | `src/sim/match.ts:35-38`; `scoring.ts:100-102`; `chain/play.ts:506-520, 1043`; `chain/config.ts:962-967`; `biobuzz/score.ts:342, 489-493` | §4: one `autoOnly(world)` predicate gates each game's `post` scoring. Go **auto → post directly** (no transition). |
| B5 | **BIOBUZZ never captures an AUTO number in an auto-only run.** Its rank facts read AUTO at `teleopStart`, which fires only on entering teleop. | `biobuzz/rankFacts.ts:22-28`; `room.ts:3325` | §5.1: read the AUTO facts at `final` when the run is auto-only. |
| B6 | **The server would lose `runLength`.** `saveReplay`/`getReplay` rebuild the header column by column, and `sanitizeReplay` is an allowlist. A stored auto-only record would re-simulate as a full match, so the proof disagrees with the board. | `repo.ts:2203-2225, 2250-2275`; `sanitize.ts:177-201` | §4: `replays.run_length` column (0061), threaded through all three. `REPLAY_FORMAT` 5 only for auto-only containers, and `replayHasImported` fixed (it treats `format >= 3` as imported, `src/net/imported.ts:80`). |
| B7 | **Total, awards and profile would silently include auto-only runs.** No reader of `records` filters by run length. In v1, auto-only records (M5) also shipped *before* the column existed (M6), so those rows could never be told apart. | `recordLeaderboard`, `personalBest`, `recordRank` (`repo.ts:2967-3052`); `getUserStats` 5527-5537; award job 1694/1702; admin 3075/3093; export 3479; season counts 203; `boardPhysics` 77; persist toasts 194/216 | §5.1: `run_length='full'` inside every `best` CTE and every reader. **Milestones reordered**: 0061 plus the filters ship before any auto-only run can post. |

## 2. Wrong or stale claims in v1 (all corrected in v2)

- **"Removing rated formats from the allowlist refuses old clients" is wrong.**
  - `api.ts:1716` coerces an unknown format to `null` and returns 200. A `rated1v1` from an old client becomes a "Casual 1v1" invite whose "room code" is a party token.
  - Fix: return **410** for retired formats, and drop `'party'` from `SERVER_CAPS`. Old pickers then render those tiles disabled (`ChallengePicker.tsx:43-45`).
- **"M1–M4 need no migration" is wrong if modes are relabelled.**
  - `matches.mode`, `play_counts` and `season_awards` all `check (mode in ('1v1','2v2'))` (`0001:113`, `0050:28`, `0045:40`).
  - v2 keeps `mode` as is and adds a nullable `preset` column instead.
- **"An old client's replay sanitizer rejects >4 setups" is wrong.**
  - `sanitizeReplay` is server-only (`api.ts:429, 1228`).
  - The real old-client risk is an 8-setup `matchStart` to a predictor that never expected it, so the gate covers joins **and spectators**.
- **The sanitizer has two 4-robot limits:** `setups.length > 4` (`sanitize.ts:146`) **and** `id > 3` (152).
- **v1's "M1 caps at 2 per alliance" removed shapes that work today.** Versus already allows 3v1 and 4v0 with bots (`room.ts:826-855, 1435`). v2 keeps any split up to 4 seats until M8.
- **"`maxMatchTicks`/`wireClocks`/`settle` need changes": they don't.**
  - `maxMatchTicks` is an upper bound.
  - The other two only matter if phase durations change.
- **"Chain scores the transition as AUTO" is wrong.** Chain follows INTO THE DEEP: the transition is TELEOP (`chain/rankFacts.ts:12-16`). DECODE and BIOBUZZ count it as AUTO.
- **The roster field name `role` is taken.** `LobbyPlayer.role` is the staff badge (`protocol.ts:328`). v2 uses `seat: 'player' | 'spectator'`.
- **"Invite friend" in the lobby already exists.** It is `FriendsPanel room?: RoomInviteTarget` (`FriendsPanel.tsx:126`, `Lobby.tsx:977`). v2 extends it.
- **Capacity consumers v1 missed:**
  - `roomHost.ts:659` (`new RemoteRoom(..., roomCapacity(cfg))`, fixed at construction)
  - `initialFacts` (`roomHost.ts:199-202`)
  - `Lobby.tsx:210/436/1325/1415`
  - `hostWorker.ts:170`
  - `hostProtocol.ts:86`
  - `lobbySummary().capacity`
- **Rated-challenge consumers v1 missed:**
  - `challengeOf`/`PendingChallenge` (`challenge.ts:14-47`, App.tsx:941, `friendsContext.tsx:5,172`)
  - `lobbyClient.ts:390`
  - `Matchmaking.tsx:124, 1129-1140`
  - `repo.ts:7332`
- **Line drift** (minor):
  - `onJoinInvite` is at App.tsx:932
  - `listSeasonsCached` is at repo.ts:242
  - `RoomFacts` is at roomThreads.ts:69
  - Chain's phase transitions are at `step.ts:119-129` and BIOBUZZ's at `254-278`
  - the BIOBUZZ AUTO park is `bbAssess(world,'auto')`
  - the spectate lockdown check is in the dispatcher at `index.ts:3963`, not in `attachSpectator`

## 3. Integration with in-flight work

| PR | Collides with | Recommendation |
|---|---|---|
| **#103** worker threads | Alpha already has worker rooms (commit `2a7b7ee2`: `roomHost.ts`, `roomThreads.ts`, `roomWorker.ts`). #103 is a **competing** implementation (`roomPool.ts`, `roomWire.ts`). | Close as superseded, or rebase onto alpha's version. The plan targets alpha's. |
| **#104** abuse guards (conflicting) | **Contradicts Browse rooms.** `if (!r \|\| !r.hasWorld)` refuses spectating any lobby. `LOBBY_IDLE_MINUTES` counts only driver actions. It adds `MAX_SPECTATORS_PER_IP`, a 12-rooms-per-IP cap, a cross-machine one-game lock and `ROOM_CODE_RE`, all at the doors M2/M3 change. | Land **before M2/M3, amended**: allow lobby spectating for *listed* rooms, count host and spectator activity toward the idle timer, and route promotion through `remoteLiveConflict`. |
| **#99** shared 60 Hz clock (conflicting) | `room.ts`, `index.ts`, `hostWorker.ts`, `costprobe.ts` | Land before M1. |
| **#98** golden-hash `SIM_VERSION` (conflicting) | `sanitize.ts` (next to `id > 3`). `canonicalWorld` hashes the whole world. | Land before M4/M8. Keep `world.runLength` **absent** for full runs so the golden pins stay byte-identical. |
| **#101** `SIM_VERSION` 5, phases one tick long (draft, on #98) | Alpha is **already at `SIM_VERSION` 5** (swerve, `config.ts:222-229`), so this must become **6**. Same lines as the auto-only exits. It also moves the `autoEnd`/`teleopStart` capture ticks. | Rebase as v6 and land **before M4 and M5**, so auto splits are captured on the corrected boundaries. |
| **#100 / #102** BIOBUZZ prebuilt engine, Chain fixes | `room.ts`, `chain/step.ts`, `chain/play.ts` | #102 before M4; #100 before M8 (measure 8-robot 3D on the prebuilt engine). |
| **#105** Zenith robot file | Autos only | Independent. |

**Recent alpha work** that v2 now accounts for:
- **Competitions:** `cm` rooms share `canJoin`/`roomCapacity`. rankFacts capture is gated at `room.ts:3302/3381/3460`.
- **Solo record:** solo record is not a lobby room. It uses a fresh `rec-` code per run (`RecordRun.tsx:117`, App.tsx:1573) with one-person lock exemptions (`room.ts:1217, 1685`; `index.ts:403`).
- **Discord and LAN:** Discord `group` rooms and LAN have no spectate guard, and LAN's `hostWorker` has **no spectator support at all**.
- **Hidden admin observers:** they must never surface (`room.ts:1479-1494`).

## 4. Security, privacy and abuse (P1/P2, applied)

- **Spectators stay out of the player list.** Spectators go in a separate optional `spectators[]` on `roster`, never in `players`.
  - An old-client host's `allReady = players.every(p => p.ready)` (Lobby.tsx:427) would otherwise block START.
  - Hidden admins are excluded. Their flag is set asynchronously, so filter on both paths.
- **Don't merge the spectator map into `clients`.**
  - About ten loops mean "seat holders": `seatsTaken`, start gate, `startMatch`, `absentRoster`, `passCrown`, teardown, `resolveReport` and others.
  - A role change **moves** the `Client` object between the two maps, keeping its id.
  - Demotion deletes `seatToken`, clears ready/pose/role/swap/zenith, calls `visuals.freeOwner`, and updates the socket `spectating` flag and `spectatorTotal`.
- **`passCrown` hands the crown to players only.** Otherwise a stranger from the public list could become host.
- **Capacity is re-checked inside `Room.add`.** A host shrinking the cap while an add is in flight would otherwise overfill the room on a worker. An over-cap joiner lands as a spectator.
- **Settings below current occupancy are refused** ("move 2 players first"). Nobody is auto-demoted.
- **Readiness and alliance rules:**
  - A move or role change clears that member's `ready`.
  - Any settings change clears everyone's `ready`.
  - The `update` handler drops `patch.alliance` when `teamSwitch` is off or the side is full, which also covers old clients.
- **Mirror `kind` and settings in `RoomFacts`.** `RemoteRoom.config` is a frozen copy (`roomHost.ts:250`), and `index.ts` reads `r.config.kind` at 3452/3460/3711 and `releaseSoloRecordHold` 403. A convert-to-custom inside a worker would otherwise leave the socket thread stale.
- **Listing:**
  - Add a **separate `listing()`** and leave `summary()` and `/api/live` alone.
  - `summary()` has six readers, including presence (`liveRoomsByUser` reads it as "in a match").
  - Old WatchLive clients would spectate lobby rows that never send `matchStart`.
- **Privacy:** rows in the lobby phase show counts, preset and the **host handle only**. Names appear once the match runs, as today. Listing requires sign-in. Every member sees a "Listed" banner.
- **Abuse:**
  - one listed room per account
  - per-IP spectator cap (from #104)
  - spectators get a coalesced, spec-free roster at most 4 Hz (`index.ts:4246-4247`)
  - cooldown on repeated host actions against the same member
  - refuse promotion across a `friend_blocks` block
  - **host `kick` is required** in a public room
  - **no free-text room names**
- **Lockdown and one-live-game at promotion:** lockdown on `start` reads only the host (`index.ts:4345`), and `beginMatch` overwrites `userRoom` (2563). Check both at promotion **and** at start.
- **Rated-challenge leftovers:**
  - Pending rows render as "Retired challenge" with only Dismiss.
  - When the party path is later removed, a `queue` carrying `party` is **refused**, never silently dropped into the open pool (accounts.md:562).

## 5. Product and UX (applied unless marked as an owner call)

- **Joining by code as a player disappears in v1.**
  - Today "Have a code" seats you (`Lobby.tsx:1177-1256`). v1's only code box spectates.
  - v2 keeps the player join-by-code on the room form. Browse stays spectate-first.
- **Solo record goes from 1 click to about 4 in v1.**
  - v2 keeps **Solo record** and **Duo record** quick-start tiles under Online.
  - They run through today's `RecordRun` path, Unlisted, with a "Full match / Auto only" `OptRow` remembered per device.
  - "Create room" puts a Preset `OptRow` on the **existing** form. It is not a new console scaffold, which design-review C33/02-01 calls the second-shell problem.
- **A spectator in a room that hasn't started sees nothing.**
  - `spectateRoom` navigates only on `matchStart` (App.tsx:1353-1371).
  - v2 adds a read-only lobby view, with "Ask to play" and "Waiting for the host to seat you".
- **Naming.**
  - The house rule is that a player-made room is a "Custom room" everywhere (`docs/area/ui.md:560-561`), and v1 broke it, along with sentence case.
  - v2 uses: Room {code} · presets "Solo record", "Duo record", "1v1", "2v2", "Custom setup" · "Unlock settings" (with the cost: "This room stops posting records") · visibility "Public / Unlisted".
  - Requires amending ui.md:561.
- **Locked and host-only controls.**
  - Non-hosts see label/value **Rows**, not disabled controls, which pad and keyboard can't focus.
  - A locked record preset shows one visible sentence.
  - Row actions are `<details>` menus (the FriendsPanel `RowMenu` pattern).
  - Steppers are `.ds-opt.mini` with `aria-pressed`.
  - Moves, demotions and seating are announced in `role="status"`.
- **Browse page.**
  - Reuse `.ds-lobby-row` (`DiscordLobbyList.tsx:186-195`), including its season switch before connecting.
  - Two-line rows at phone width.
  - Render inside AppShell.
  - **No measured CCU exists.** The fleet ceiling is about 90 concurrent players, so the empty state carries a Create room CTA.
- **Leaderboard controls.**
  - Fold the window into the existing Period control as one select: Today · This week · This month · This season · All time.
  - Category is a third seg in the existing panel head. That makes one new control row, not two.
  - The Auto board's empty state teaches auto-only.
- **Play page labels:** "Practice · offline", "Rooms · online", "Ranked · online". Competitions go under Ranked.
- **Rated-challenge removal copy:**
  - Rename the friends-row "Challenge" button to "Invite".
  - Remove the party copy in Matchmaking.
  - The patch note leads with what is removed (patch-notes.md §4).

## 6. Owner decisions (resolved 2026-10-05, applied in plan v3)

1. **Friends in ranked.**
   - **Ranked 2v2 with a friend stays.** The `ranked2v2` premade is always on one alliance.
   - **`rated1v1` is retired.**
   - **The matchmaker never stages friends as opponents**, in 1v1 or 2v2.
   - Casual invites go to rooms.
   - This resolves the PRODUCT.md:14 concern.
   - The new cost is longer waits for friends queued alone at low concurrency (plan §1.1 step 3, §7).
2. **Physics eras.**
   - 2D and 3D runs never share a board.
   - Lifetime spans seasons but is filtered to one physics, and BIOBUZZ gets a 2D/3D switch.
3. **Rollover at 08:00 UTC**: daily, weekly on Monday, monthly on the 1st.
4. **Room creation.**
   - The host picks **Public or Private** and **a preset or Custom** on the create form. Everything else is set inside the room.
   - "Unlisted" is renamed **Private** throughout.
   - Lobby-phase rows still show counts and the host handle only.
5. **Per-period fouls: still open.** v3 assumes net: `auto = max(0, autoGross − autoFouls)`, the same for teleop, and 0 on both for a voided run. Confirm, or switch to gross.

## 7. Revised order (detail in plan v3 §6)

**Prerequisites:** close/rebase #103; land #99; land #98 and #101 (as `SIM_VERSION` 6); land #104 amended.

| # | Milestone |
|---|---|
| M0 | Friends and ranked: retire `rated1v1`, friends never opponents |
| M1 | Room settings, presets and host controls |
| M2 | Roles through the seat door, plus kick |
| M3 | Browse rooms |
| M4 | Auto-only offline |
| M5 | Migration 0061, run-length filters and categories |
| M6 | Auto-only in rooms and records |
| M7 | Time windows |
| M8 | 8-robot rooms |

M8 is last because it needs authored start poses, preload rules, 8-robot `costprobe` rows, and the sanitizer id limit.
