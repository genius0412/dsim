<!-- governs: src/competition/**, server/competitions.ts, server/competitionRunner.ts, server/db/competitions.ts, server/db/migrations/0059_competitions.sql, src/net/competitions.ts, src/net/myCompetitions.ts, src/ui/Comp*.tsx, src/ui/Competitions.tsx, src/ui/compBits.tsx, src/ui/AdminCompetitions.tsx, src/ui/competitions.css, scripts/compsmoke.ts, scripts/compe2e.ts -->
# Competitions — FTC-style events: registration, qualifications, rankings, alliance selection, playoffs

Migration 0059, built 2026-10-04. Staff run them today; the permission model is already the
one a public release needs. Server rules are in `docs/area/netcode.md` and `accounts.md` too;
this guide is what is true of competitions specifically.

---

## What is stored, and what is derived

The tables hold what was DECIDED: `competitions` (settings jsonb, the frozen `seed_order`, the
alliance-selection `selection` actions, the frozen playoff `alliances`), `competition_entries`,
`competition_matches` + `competition_match_slots`, `competition_series` (the bracket as built),
`competition_staff`, `competition_log`.

**Rankings, the live alliance selection, every series' wins, the next playoff match and the
placements are recomputed from those rows on every read** by the pure modules in
`src/competition/` (`rankings.ts`, `selection.ts`, `bracket.ts`). Never store a derived number:
a corrected result has to move everything downstream of it, and a second copy would not move.
The only exceptions are deliberate freezes, each written once by an organizer's action:
`seed_order` (end of qualifications, so a correction during selection cannot reshuffle captains),
`alliances` (when the bracket is built) and `placement` (when the competition completes).

`settings` is coerced on every read and write (`coerceCompSettings`). An unknown or out-of-range
field falls back to its default; a shape that cannot have a setting folds it (round robin and
swiss need one entry per alliance; alliance selection exists only for 2v2 solo entries).

## Who may do what

- **Creation is ONE policy, `mayCreate`** (`server/competitions.ts`), read from
  `COMPETITION_CREATORS`: unset/`admins` = site admins only (today), `signed-in` = any account in
  good standing, capped at three unfinished competitions. Opening creation up is that env var,
  not code. A competition an admin creates is `official`; anyone else's is not, and the pages say so.
- **Roles per competition** (`roleFor`): site admin (`ADMIN_IDS`) always; the creator when not an
  admin (`created_by`, an organizer); `competition_staff` rows (organizer or referee).
  `canManage` (admin, organizer) is the lifecycle, settings, entries, schedule, selection, staff
  and messages. `canReferee` adds referees, and is calling matches and ruling on them.
- **Every staff action by a site admin also writes `admin_audit`** (`competition.<action>`), per
  the console's rule; every action by anyone writes `competition_log`, public or staff-only.
- Public text (name, summary, team names) goes through `moderateName`, so a community competition
  later is moderated the way usernames are.

## The lifecycle

`draft → published → qualification → selection → playoffs → completed`, any of them `→ cancelled`.
**Every move is an organizer's action, never a timer** (a clock that started qualifications while
the organizer fixed the entrant list would be a bug with no undo). Times on the row (registration
window, check-in, start) GATE player actions and are displayed; they move nothing by themselves.
`quals.kind: 'none'` goes `published → selection` directly.

What locks when (the server refuses, the editor greys): game/format/team mode once anyone has
entered; capacity and the qualification settings at `qualification`; ranking points and
tiebreakers at `selection`; the playoff settings at `playoffs`.

**Starting qualifications needs a schedule drawn for exactly the entries that will play**
(registered, and checked in when check-in is required); an entry list that changed after the draw
is refused with "draw it again". Entries left out at the start become `withdrawn`.

## A called match is a staged room

- **Calling** (`callMatch`) mints `<region>-cm<8 base36>` (`competitionRoomCode`), bumps the
  match's `attempt`, and stores the code on the row. **Nothing goes in `pending_matches`**: that
  table's reaper drops rows after 60 s, and a call waits minutes for its drivers.
- **The first join claims the call, exactly once** (`claimCompetitionRoom` →
  `db.claimRoom`, a conditional `claimed_at` update) and returns a `PendingMatch` with
  `ranked: false` and a `competition` tag (`CompetitionTag`, `server/matchTypes.ts`). The join
  path tries it for any code `isCompetitionRoomCode` recognises; `isStagedRoomCode` recognises the
  shape too, so a gone call is REFUSED (`match_gone`) rather than opened as an empty custom room.
  A failure AFTER the claim gives it back (`unclaimRoom`): the join path retries a read that
  throws, and a retry that found its own claim would refuse the match as over.
- ⚠️ **THE ROOM HOLDS ITS SEATS WHILE IT WAITS** (`Room.detach`, phase `connecting`), clean close or
  not. A staged room used to drop a seat that closed before the strategy window, and with the last
  seat the ROOM — so a driver who reloaded the join screen, or went back to the competition page,
  left the call claimed with no room behind it, and every later join was refused as over (found in
  the browser, 2026-10-04; `scripts/compe2e.ts` now leaves and rejoins before the match). The wait
  is bounded by the call's own grace, and `absentRoster` counts a held seat as absent.
- **In the room** (`server/room.ts`): `applyPending` sets `ranked = !competition`, so nothing is
  rated and no standing is charged; the join grace is what is LEFT of the call's
  (`graceMs`, at least a minute); the strategy window is the ranked one, but **its deadline STARTS
  the match when every driver is present**, ready or not, instead of cancelling it; rematch votes
  and the host's return-to-lobby are ignored (a second match would be a result nobody called); the
  room keeps the server's channel rather than the first client's, so an alpha build in a stable
  competition cannot make its result unpersisted; a legacy client (no `strategy` cap) plays its own
  joined build, not the staged placeholder.
- **A finished match** reaches the competition through `persistMatch`, which archives it like a
  custom game and then calls `competitionMatchPlayed` **in a `finally`**, so no early return or
  failure on the archive path can strand a decided match. The write is conditional on the
  ATTEMPT: a room from a call the referee has since replaced finishes into nothing.
- **A call that never became a match** (no-show at the grace, a bail, unready) reaches it
  through the dodge report: `cancelPending` fires `onDodge` for a competition room even with no
  culprit, carrying the tag, and `persistDodges` routes it to `competitionCallFailed` and returns
  no verdict. `noShow: 'forfeit'` with the fault on one alliance forfeits it; anything else puts
  the match back on the schedule with a `call_note` for the referee.
- `LiveRoom.competition` makes the room public in Watch Live and labels it; the competition page
  joins the live list by room code to show a called match as live.
- **Wire, all additive:** `strategyStart.competition` and `LiveRoom.competition`. An older client
  shows the ranked window with "Unranked" chips; an older server never sends them.

## The runner

`server/competitionRunner.ts` runs `runnerPass` (return dead calls to the schedule, make sure every
ready playoff series has its next match, auto-call where enabled) **on the matchmaker's machine
only, and only while a competition is running**: one read at boot, then any API request that
touches a running competition wakes it, and the first pass that finds nothing running sends it back
to sleep. This is the IDLE MEANS SILENT rule (`server/index.ts`): Neon bills the hours it is
awake. Every call and result write is conditional, so a second runner could only waste queries.

Auto-calling calls the earliest scheduled matches whose drivers are free and rested, up to
`maxConcurrent`, looking a little past the head of the queue (`2 × maxConcurrent`) so one busy
driver does not stall everyone behind them.

## Playoffs

`buildBracket` makes the series (single or double elimination, 2/4/8/16 alliances, best-of per
series and for the final; double elimination has no bracket reset). `afterResult` runs under the
competition's row lock (`lockCompetition`) so the runner, a room's result and a referee cannot
insert the same next match twice. **A playoff result may not change once a later match was
played on it** (`playoffGuard`, refused with a sentence); an UNPLAYED later match whose sides no
longer agree with its series is deleted and re-created. When the final is decided the competition
completes itself: placements from the bracket, everyone else after them in seed order.

## What a referee can and cannot change

Forfeit, enter or correct a result (with a public reason), void, reset (the result AND its archived
match and replay are cleared), disqualify an entry in one match (no ranking points from it). **A
finished or cancelled competition's results are final** (`matchRoute` refuses everything but a
note): its placements were written once from them. The waitlist is capped at the capacity, and
nobody comes off it once qualifications start (they would hold a place and have no matches).

## Privacy, accounts, notices

- **Competition match replays are public** (`replayAccess` kind `competition`, while the
  competition is not a draft). Registration says so beside the button.
- **Account deletion keeps the entry and drops the name**: `user_id`/`partner_id` are SET NULL by
  the cascade so a played schedule keeps both sides, and `deleteAccount` renames the captain's
  entries 'Deleted account'.
- Notices (`src/notices.ts`, `competition.*`): invite, promoted off the waitlist, removed or
  disqualified, a result CHANGED (corrected, forfeited, voided, reset — a first result entered by
  hand is not news, any more than a played one), the final placement, cancelled, and an
  organizer's message. The pop-up says "Competitions", not "From the moderators", for these.
- The account export carries the account's entries and staff rows; `deleteAccount` deletes the
  replays of every match the account played, competition matches included. A CALLED match is not a notice (it is time-critical):
  the call bar says it for exactly as long as it is true.

## Client

- **The pages are ONE lazy chunk** (`Competitions-*.js`, `bundleaudit` route `competitions`). Main
  carries only the call bar (`CompCallBar.tsx`, the queue bar's look), `myCompetitions.ts` and
  `clock.ts`. ⚠️ **A module imported by two lazy chunks becomes a third chunk `bundleaudit` cannot
  route** — which is why the pages have `compBits.tsx` instead of `adminBits`, and the console's
  tab (`AdminCompetitions.tsx`) fetches on its own instead of importing `net/competitions.ts`.
- Routes: `/competitions`, `/competitions/new`, `/competitions/<slug>[/<tab>]`,
  `/competitions/<slug>/edit`, and `/competitions/<slug>/play` (full screen, outside the shell, like
  ranked). A finished match returns to the competition's Matches tab (`compReturnRef`).
- The call bar polls `/api/competitions/me` only while there is something to ask about: once on
  sign-in, every 2 min during registration, every 10 s while a competition is running, every 5 s
  while a match is called; never while hidden or idle.

## Tests

`npm run test:comp` (`scripts/compsmoke.ts`, the pure modules); `npm run dbtest` ("competition:",
the routes through `competitionTestApi`, the room half, the runner, the cascade). Both are kept out
of `npm test` for the matchmaker's reason. **`npx tsx scripts/compe2e.ts`** (about five minutes)
runs the real server on PGlite with two socket clients: a called match played out at real time, a
leave-and-rejoin while it waits, a no-show, a forfeit, completion. `npm run adminharness` seeds a
competition in every state for clicking through.

## Opening creation to the public — what is left

`COMPETITION_CREATORS=signed-in` turns it on. Before that: a report button for a competition page,
a staff "unpublish" that the organizer cannot undo, and a per-creator rate limit on messages wider
than the 30 s one per competition.
