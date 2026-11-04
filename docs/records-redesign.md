# Records redesign plan

Built 2026-11-04. Measured: first row at 217px on desktop (15 rows) and 280px on a phone, no sideways
scroll. Two departures: the row expansion shows the robots and the date but no Auto/TeleOp split
(the board's rows do not carry one, and the API is unchanged), and a phone's tabs read Boards ·
My records · Badges.

## Purpose

One glance answers:

1. Who leads this board, and by how much?
2. Where am I on it?
3. How did they do it (replay, robot)?

## Layout model

Height binds, not width. At 1366×768 the first row sits at 503px under seven stacked controls, so four rows show; on a phone, three, at 629px. Target: first row by 230px on desktop (12+ rows), 300px on a phone.

Hierarchy: tabs, board picker, one filter line, table.

## Changes

Removed:

- **Window** (Today to All time) on the board and the feed, and its 2D/3D toggle. At DSIM's player count a day or week board is the season's top few or empty, All time mixes balance versions, and it was a second time control hiding the period picker.
- The hub and its link cards: a click before every board.
- The period heading, Robot column, DUO tag and click-row-to-watch.

Merged:

- High scores/Ranked and the mode toggle: one picker, Solo · Duo · 1v1 · 2v2.
- Act and Season selects: one period select, Final chip on a past one.
- The feed: Latest records (8, this season), a right column from 1200px, a closed disclosure below that.
- Search: into the tab row.

Behind a disclosure: robot sheets and the Auto/TeleOp split, in the row expansion.

## Interaction

`/records` opens Leaderboards: Solo, Total, Overall, current period, last pick remembered per game. Ranked by and Drivetrain are two selects, score boards only. A game select swaps the URL prefix, as `/chain/records` already does. Filters live in the query string.

Row: name opens the profile, ▶ plays the replay, the rest expands. Your row is highlighted, or pinned at the foot when off the page (Ranked: placement progress).

## My records

Keeps four tiles (Solo best, Duo best, 1v1, 2v2, with rank; each opens that board at your row) and one history list: type All, Solo, Duo, Ranked, Custom, Practice (LAN when hosted), 20 per page, ranked W–L as its summary.

Cut: account standing, Messages and Your reports (to Account), the Practice replays panel (now a type), Games played and Playtime (public profile), Awards (on Achievements), name chip, Share, Result filter, page-size select. The public profile keeps `CareerView`.

## Phone

Tabs and picker are one segmented row each; filters collapse to a summary button. No sideways scroll.

## Server and API

None. The client stops sending `window`/`era` (the server defaults to season). Optional later: `/api/records` returns the viewer's row, as `/api/elo` does; until then a score board pins it for Overall · Total only, from `fetchUserStats`.

## Wireframes

Before:

```
+------------------------------------------+
| Leaderboards                             |
| Act 1 · Season 2                         |
| WINDOW [This season v]                   |
| PERIOD [Act 1 v] [Season 2 v]            |
| [High scores|Ranked]         [Solo|Duo]  |
| RANKED BY         [Total|Auto|TeleOp]    |
| DRIVETRAIN [Overall|Mec|Tank|Swv|X|Bfly] |
| #  Driver        Robot   Score           |
| 1  Ada  @ada     -       180  [Watch]    |  <- y=503
+------------------------------------------+
```

After:

```
+------------------------------------------------+-------------+
| [Leaderboards|My records|Achievements] [search]              |
| [DECODE v] [Solo|Duo|1v1|2v2] [Total v] [Overall v] [S2 v]   |
| #   Driver                    Score            | LATEST      |
| 1   Ada Lovelace               180  [>]        | No.1 Ada 412|
| 2   Grace Hopper               169  [>]        | No.2 Dee 398|
| ... 12+ rows                                   |             |
| 14  You                        132  [>]        |             |
+------------------------------------------------+-------------+
```

After, phone:

```
+--------------------------+
| [Leaderboards|Mine|Ach.] |
| [Solo|Duo|1v1|2v2]       |
| [Total · Overall · S2 v] |
| 1  Ada Lovelace  180 [>] |
| 2  Grace Hopper  169 [>] |
| 14 You           132 [>] |
+--------------------------+
```
