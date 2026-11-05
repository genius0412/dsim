# Custom rooms redesign plan

Plan 2026-11-04, built the same day (below). Cues: Brawl Stars friendly rooms (all slots on one
screen, tap to move) and Valorant customs (team columns, observer list, host settings beside them).

## Audit

Local harness, five offscreen clients, DECODE, 1366×768.

| Path | Clicks | Dialogs | Time |
|---|---|---|---|
| New room ▸ Public ▸ 2v2 ▸ Create | 4 | 2 | 350 ms |
| Browse ▸ row, or ▸ code | 2 | 1 | 370–380 ms |
| Full or playing room | 2 | 1 | 660 ms to watch, 790 ms to the field |
| Seat ⇄ Spectate | 1 | 0 | up to 350 ms, new socket |
| Watch box on a lobby | 2 | 1 | nothing, until the match |

1. READY UP is at y=1089 in a 768 px window, y=1802 on a 390×844 phone.
2. Spectators are unlisted. After a match one returns with dead RED/BLUE buttons, and its
   reconnect sends `join`. Its HUD says YOU.
3. Two dialogs before a room exists; two code boxes on Browse.
4. No seats drawn: both guests landed on BLUE, three rows read "Player", each join shifts 52 px.
5. Only the host can leave results; others see MENU, which quits. A Public room handed to a
   signed-out host silently unlists.

## Layout model

Height binds (465 px short, width spare). Desktop: one unscrolled screen, RED seats, room panel,
BLUE seats, fixed action bar. Phone: stacked, bar pinned. On a short window the seats scroll inside
their row and the bar stays. Robot and start position move to a Setup drawer.

```
+----------------------------------------------------------------------------+
| <- Leave  Private room  K5JJBW  [Copy code] [Invite]              US East   |
+------------------------+--------------------------+------------------------+
| RED                    | ROOM          (host only)| BLUE                   |
| +--------------------+ | Seats   red  [-] 2 [+]   | +--------------------+ |
| | Alice *     READY  | |         blue [-] 2 [+]   | | You . Close  READY | |
| | Tank . Close       | | Sides  [Drivers][Host]   | | My Robot   [Setup] | |
| +--------------------+ | Run    [Full][Auto]      | +--------------------+ |
| +--------------------+ | Show   [Private][Public] | + - - - - - - - - - -+ |
| | Bot . Medium   [x] | |                          | | Open seat          | |
| | Far       [tier v] | | SPECTATORS 2/8  [Watch]  | | [Take]   [+ Bot]   | |
| +--------------------+ | Dana, Eli                | + - - - - - - - - - -+ |
|                        | [GG] [Ready?] [One sec]  |                        |
+------------------------+--------------------------+------------------------+
| 3/4 ready                               [ START MATCH ]      [ READY ]      |
+----------------------------------------------------------------------------+
```

```
+--------------------------+
| <- Private room  K5JJBW  |
| [Copy code] [Invite]     |
| RED                      |
| | Alice *         READY  |
| | Bot . Medium      [x]  |
| BLUE                     |
| | You . Close   [Setup]  |
| | Open seat [Take][+Bot] |
| Spectators 2/8  [Watch]  |
| Room settings (host)     |
+--------------------------+
| 3/4 ready                |
| [ START ]   [ READY ]    |
+--------------------------+
```

## Moves

- Click an open seat to take it; the card moves at once and a refusal moves it back.
- Host places drivers: drag or menu. Drivers pick a side: host moves bots only.
- "+ Bot" on open seats; bot cards have tier and remove. Close/Far swaps sit on the cards.

## Spectators

- A row, code or invite into a full or playing room watches (no Watch button on entry). Inside,
  Watch moves you without reconnecting.
- Listed in the lobby; take open seats between matches, never mid-match; return as spectators.
  In a match: today's spectator view and cameras, minus YOU and the drive prompt.
- Cap 8. A watcher costs a driver's stream (costprobe): 24 KiB/s DECODE 2v2, 20 BIOBUZZ, 83 Chain
  Reaction; $2.2, $1.8, $7.7 per 1,000 watcher-hours. Nothing in a lobby.

## Smoothness

- Browse rooms keeps its **Private room** and **Public room** buttons (owner ruling, 2026-11-04);
  each creates the room and opens it, one click, no dialog. Play's New room opens a Private one.
  The title says Private room or Public room, and follows the host's switch in Room settings.
- Open seats hold their space, so nothing shifts. Cards ease 150 ms.
- After a match the room returns 30 s after the result saves, or on any member's press, with a
  countdown for all. Seats, bots and robots stay.
- Six fixed reactions (no moderation, ~40 bytes); no free chat. Default names get numbers.

## Protocol and server

Additive, behind cap `rooms3` both ways. Nothing per tick.

- `{t:'seat', to}` (red, blue, watch), lobby only, through the `join`/`spectate` checks. Worker
  rooms: the existing `detach`/`add`/`addSpectator` ops, in order.
- `spectate` carries `name`; `roster.watchers` lists them on change.
- `{t:'react', k}`, 1 a second per socket.
- `lobby` gains `spectator`; `returnIn` announces the countdown. `runLength` patchable given
  `autoOnly` all round.
- Old clients see today's lobby; new clients on old servers keep today's controls. Alpha deploy.

## Removed

The New room dialog and form, the Watch box (into Join with a code), Your alliance (Spectate stays
a seat-map choice), the bot row.

## Checks

- `npm test`: lobbyRules, `seat` doors, watchers, recycle, names, reactions; keep "rooms:",
  "spectate:", "move lock:", "shrink:".
- `test:workers` for `seat`; `test:mm` untouched.
- `shiftaudit` (`DSIM_ROOM`): empty and full rooms, a watcher joining and leaving, ready, crown,
  drawer; both themes, 1366×768 and 390×844.
- `costprobe` bytes unchanged; `uiaudit`, `contrast`, `docaudit`, `build`, `server:check`.

## Built (2026-11-04)

Same harness, before → after:

| Path | Clicks | Dialogs | Time | Layout shift |
|---|---|---|---|---|
| Create (Play, or Browse's two buttons) | 4 → 1 | 2 → 0 | 350 → 340 ms | 0 |
| Full or playing room | 2 → 2 | 1 → 1 | 660 → 370 ms to watch, 790 → 490 to the field | 0 |
| Watch, or take a seat | 1 | 0 | 350 ms → 50 ms (same socket) | 52 px → 0 for others |
| Back to the room | host only → anyone, or 30 s | 0 | 60 ms | 0 |

READY/START: y=1089 → 702 at 1366×768 (no page scroll), y=1802 → 725 at 390×844 (bar pinned).
`DSIM_ROOM=only npm run shiftaudit`: 376 probes and 18 room transitions, 0 shifts, both themes.

Departures: no copy-link (the code and Invite cover it); START sits left of READY, so a crown
arriving never moves READY; on a phone the two share the bar's width.
