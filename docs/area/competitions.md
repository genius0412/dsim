<!-- governs: src/competition/**, server/competitions.ts, server/competitionRunner.ts, server/db/competitions.ts, server/db/migrations/0059_competitions.sql, server/db/migrations/0060_competition_rp.sql, src/net/competitions.ts, src/net/myCompetitions.ts, src/ui/Comp*.tsx, src/ui/Competitions.tsx, src/ui/compBits.tsx, src/ui/AdminCompetitions.tsx, src/ui/competitions.css, scripts/compsmoke.ts, scripts/compe2e.ts -->
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
`rp_table` (start of qualifications, see "Ranking points"), `seed_order` (end of qualifications,
so a correction during selection cannot reshuffle captains), `alliances` (when the bracket is
built) and `placement` (when the competition completes).

Per match, 0060 adds what the ranking points are computed FROM, never the points themselves:
`facts` (what the game measured per alliance), `rp_rulings` (a referee's bonus-RP rulings),
`cards` (the sim's, per entry, from the played match) and `ref_cards` (a referee's). A null is
UNKNOWN, never zero: a forfeit, a result typed without them, or a row from before 0060.

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
entered; capacity, the qualification settings and the ranking-point scheme (`settings.rp`) at
`qualification`; a custom scheme's points and tiebreakers at `selection`; the playoff settings at
`playoffs`. The editor merges `rp` one level deep, so a partial edit keeps the stored scheme.

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
- **What the game measured rides with it.** A competition room asks the game's
  `GameSimModule.rankFacts` at three instants — the first tick after AUTO (`autoEnd`), the first
  TELEOP tick (`teleopStart`) and finalize — and merges them per alliance, the earliest instant
  winning a key (`Room.captureRankFacts`). Each game reports a number when its manual assesses
  it: INTO THE DEEP (Chain Reaction) counts the transition as TELEOP, DECODE and BIOBUZZ as AUTO.
  Every read is in a try/catch after the tick is recorded, so a hook that throws costs the facts
  (unknown), never a replay tick or the result. `MatchOutcome.rankFacts` and `.cards` (every
  carded driver) exist on competition outcomes only; neither is in `ReplayResult`, which is the
  client's wire shape.
- **A call that never became a match** (no-show at the grace, a bail, unready) reaches it
  through the dodge report: `cancelPending` fires `onDodge` for a competition room even with no
  culprit, carrying the tag, and `persistDodges` routes it to `competitionCallFailed` and returns
  no verdict. `noShow: 'forfeit'` with the fault on one alliance forfeits it, and disqualifies the
  entries that never connected or left (G208/G203: a no-show is DQ'd from the match; a driver who
  connected and did not ready up is G301, so not); anything else puts the match back on the
  schedule with a `call_note` for the referee.
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

## Ranking points — the Competition Manual

`src/competition/manual.ts` holds each game's table: win/tie/loss, the bonus RPs with their
thresholds per event level (Table 10-3), and the Table 13-1 tiebreakers. Its header says where
every reading comes from (manual text, an official Q&A answer, or arithmetic). DECODE and BIOBUZZ
use their own manuals; **Chain Reaction's manual has no ranking rules, so DSIM uses INTO THE DEEP's**
(win 2, tie 1, no bonus RPs).

- **Two schemes** (`settings.rp.scheme`). `cm` applies the game's table; `custom` is the
  organizer's win/tie/loss and tiebreakers with no bonus RPs. **A settings object without `rp` is
  `custom`** — every competition before 0060, and a create from an older client — so nothing that
  existed re-ranks. A new competition starts at `cm`. A game with no table is `custom`.
- **Frozen at the start.** Moving to `qualification` under `cm` writes the resolved table
  (`effectiveRanking`) into `competitions.rp_table`, and every later read ranks by that copy. It
  is built from the row under its lock: a settings edit saved after the request read them refuses
  the start ("Refresh and try again"), so the table always matches the stored settings. A
  Team Update edit of `manual.ts` reaches only events that start after it; a finished event keeps
  agreeing with its placements. A malformed frozen copy is ignored whole (`frozenOf`).
- **Bonus RPs come from `facts`.** `bonusEarned`: an "ineligible" ruling beats everything (Table
  10-4), then an award (a referee's, or the sim's own `patternAward` from DECODE's G417), then the
  measure against the threshold. Unknown facts earn nothing. Rulings are offered only where the
  manual has a rule that makes them: DECODE Pattern (award, ineligible) and Goal (ineligible).
- **DQ.** `effectiveDq` (derived on read) decides who takes nothing from a match: `match.dq` (a
  referee, a no-show, an entry not registered when the match was played — written with the
  result), a red card, two yellows in one match, a yellow while carrying one (§10.6.1, ordered by
  `finished_at`, which is the FIRST decision and survives a correction), or a card from a surrogate
  appearance, which lands on the entry's previous counted match (the next, when there is none
  earlier). A DQ'd entry takes 0 RP and its partner keeps the alliance's (T601). Under `cm` a DQ
  "contributes 0 to all sort criteria": a 0 in every average, counted in the denominator. Under
  `custom` it stays out of the averages, as before.
- **A forfeit** is DSIM's, not the manual's (the manual plays the match). The side present takes
  the win RP only; no bonus, no facts, out of every average.
- **One robot an alliance cannot reach** DECODE's Movement or BIOBUZZ's Swarm threshold (13 points
  is one robot's most, below 16). `unreachableBonus` lets the editor and the overview say so;
  nothing changes behind the organizer's back, and `custom` thresholds are there for it.
- **The in-match results screen stays RP-free**, competition matches included (owner, 2026-09-21).

## What a referee can and cannot change

Forfeit (optionally disqualifying the absent entries), enter or correct a result (with a public
reason; fouls given cannot exceed the score), void, reset (the result, its facts, rulings and both
kinds of card, AND its archived match and replay are cleared; the log names the referee cards
dropped), disqualify an entry in one match. On a decided qualification match a referee can also
patch the `facts` (one key at a time, null deletes), rule on a bonus RP, and show or withdraw a
card. Each of those needs a reason, is conditional on the match's `attempt` and status ("The match
changed. Refresh."; a reset and a void each start a new attempt, so a ruling from before one never
lands on a result entered after it), writes a log line, and tells the drivers whose ranking points changed
(`competition.rp`) or who were carded (`competition.card`). **A finished or cancelled
competition's results are final** (`matchRoute` refuses everything but a note): its placements
were written once from them. The waitlist is capped at the capacity, and nobody comes off it once
qualifications start (they would hold a place and have no matches).

**A moderator's misscore correction does not reach a competition match.** `/api/admin/match`
refuses it with "<label> of <name> is corrected by its referees, from the match desk." and the
replay rail says the same: the archived row and the competition's result would disagree.

## Privacy, accounts, notices

- **Competition match replays are public** (`replayAccess` kind `competition`, while the
  competition is not a draft). Registration says so beside the button.
- **Account deletion keeps the entry and drops the name**: `user_id`/`partner_id` are SET NULL by
  the cascade so a played schedule keeps both sides, and `deleteAccount` renames the captain's
  entries 'Deleted account'.
- Notices (`src/notices.ts`, `competition.*`): invite, promoted off the waitlist, removed or
  disqualified, a result CHANGED (corrected, forfeited, voided, reset — a first result entered by
  hand is not news, any more than a played one), a card (a referee's, or the sim's when it cost a
  match), ranking points for a match changed by a ruling or a facts edit, the final placement,
  cancelled, and an organizer's message. The pop-up says "Competitions", not "From the moderators", for these.
- The account export carries the account's entries and staff rows, and every card and DQ against
  its entries (`competitionDiscipline`); `deleteAccount` deletes the replays of every match the
  account played, competition matches included.
- **Deletion also takes the name out of the competition log.** A line about an entry carries its
  id and the accounts it is about (`entry`, `users`); `deleteAccount` finds the account's entries
  by both, so an entry row deleted before the start (removed, a pending duo withdrawn, replaced by
  a re-add) is found too, and an entry still captained by someone else is not. It replaces `name`
  (a rename's `from`/`to`), and by position against their ids a forfeit's `dq` (`dqEntries`), a
  failed call's `who` (`whoEntries`), the champions (`championEntries`) and a reset's `cards`. A
  failed call's public match note names the alliance only ("Blue did not connect."); its staff-only
  `call_note` names the drivers until the next call, a reset or a void. Lines written before these ids existed keep
  their names. `users` never leaves the server (`detailOf` drops it).
- A CALLED match is not a notice (it is time-critical): the call bar says it for exactly as long as
  it is true.

## Client

- **The pages are ONE lazy chunk** (`Competitions-*.js`, `bundleaudit` route `competitions`). Main
  carries only the call bar (`CompCallBar.tsx`, the queue bar's look), `myCompetitions.ts` and
  `clock.ts`. ⚠️ **A module imported by two lazy chunks becomes a third chunk `bundleaudit` cannot
  route** — which is why the pages have `compBits.tsx` instead of `adminBits`, and the console's
  tab (`AdminCompetitions.tsx`) fetches on its own instead of importing `net/competitions.ts`.
- Routes: `/competitions`, `/competitions/new`, `/competitions/<slug>[/<tab>]`,
  `/competitions/<slug>/edit`, and `/competitions/<slug>/play` (full screen, outside the shell, like
  ranked). A finished match returns to the competition's Matches tab (`compReturnRef`).
- `manual.ts`, `rankings.ts` and `copy.ts` are imported only from the pages and `src/competition/`;
  the games report their numbers with string-literal keys, and `scripts/smoke.ts` checks they match
  the tables. The rankings table (`.ds-comp-rank`) has a width floor and folds the bonus columns
  into a sub-line on phones. The match desk's ranking form sends only what changed, keyed on the
  match's attempt.
- The call bar polls `/api/competitions/me` only while there is something to ask about: once on
  sign-in, every 2 min during registration, every 10 s while a competition is running, every 5 s
  while a match is called; never while hidden or idle.

## Tests

`npm run test:comp` (`scripts/compsmoke.ts`, the pure modules: the manual tables, every bonus at
its threshold edge, card escalation, both DQ rules); `npm run dbtest` ("competition:" and
"competition rp": the routes through `competitionTestApi`, the room half, the runner, the cascade,
the freeze, the new actions); `npm test` (the three games' `rankFacts`, a competition room's
captured facts and cards, the new notices). Both are kept out
of `npm test` for the matchmaker's reason. **`npx tsx scripts/compe2e.ts`** (about five minutes)
runs the real server on PGlite with two socket clients: a called match played out at real time, a
leave-and-rejoin while it waits, a no-show, a forfeit, completion. `npm run adminharness` seeds a
competition in every state for clicking through.

## Opening creation to the public — what is left

`COMPETITION_CREATORS=signed-in` turns it on. Before that: a report button for a competition page,
a staff "unpublish" that the organizer cannot undo, and a per-creator rate limit on messages wider
than the 30 s one per competition.
