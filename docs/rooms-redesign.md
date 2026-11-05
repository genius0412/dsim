# Custom rooms redesign plan

Plan, 2026-11-04. Cues: Brawl Stars friendly rooms (all slots on one screen, tap to move) and
Valorant customs (team columns, observer list, host settings beside them).

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
BLUE seats, fixed action bar. Phone: stacked, bar pinned. Under 640 px tall, one-line cards.
Robot and start position move to a Setup drawer.

```
+----------------------------------------------------------------------------+
| <- Leave  Room K5JJBW  [Copy code] [Copy link] [Invite]   Private  US East  |
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
| 3/4 ready                               [ READY ]      [ START MATCH ]      |
+----------------------------------------------------------------------------+
```

```
+--------------------------+
| <- Room K5JJBW  [Share]  |
| Private . 2v2 . US East  |
| RED                      |
| | Alice *         READY  |
| | Bot . Medium      [x]  |
| BLUE                     |
| | You . Close   [Setup]  |
| | Open seat [Take][+Bot] |
| Spectators 2/8  [Watch]  |
| [Room settings >] host   |
+--------------------------+
| [ READY ]   [ START ]    |
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

- New room opens the lobby (Private, 2v2): 1 click, 0 dialogs.
- Open seats hold their space, so nothing shifts. Cards ease 150 ms.
- After a match the room returns 30 s after the result saves, or on the host's press, with a
  countdown for all. Seats, bots and robots stay.
- Six fixed reactions (no moderation, ~40 bytes); no free chat. Default names get numbers.

## Protocol and server

Additive, behind cap `rooms3` both ways. Nothing per tick.

- `{t:'seat', to}` (red, blue, watch), lobby only, through the `join`/`spectate` checks. Worker
  rooms: an `Op` and in-flight counts.
- `spectate` carries `name`; `roster.watchers` lists them on change.
- `{t:'react', k}`, 1 a second per socket.
- `lobby` gains `recycleAt`, `spectator`. `runLength` patchable given `autoOnly` all round.
- Old clients see today's lobby; new clients on old servers keep today's controls. Alpha deploy.

## Removed

The New room dialog and form, Browse's Private/Public buttons, the Watch box (into Join with a
code), Your alliance (Spectate stays a seat-map choice), the bot row.

## Checks

- `npm test`: lobbyRules, `seat` doors, watchers, recycle, names, reactions; keep "rooms:",
  "spectate:", "move lock:", "shrink:".
- `test:workers` for `seat`; `test:mm` untouched.
- `shiftaudit`: empty/full rooms, host/guest/watcher, ready, crown, drawer; both themes, 1366×768,
  1024×640, 390×844.
- `costprobe` bytes unchanged; `uiaudit`, `contrast`, `docaudit`, `build`, `server:check`.
