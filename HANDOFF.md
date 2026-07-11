# HANDOFF — 2026-07-10 (Act→Season hierarchy; prev: duo-record mixed drivetrains) — READ FIRST

> **GREEN — `npm run build`, `npm test`, `npm run server:check` all pass.** (Server + DB +
> client UI; no `src/sim/` touch.)

## Latest — Act & Season system (competitive periods now Act → Season)

User model: periods form an **Act → Season** hierarchy — MULTIPLE seasons per act, both
1-indexed, plus **Act 0** for the historical beta/pre-season. Before, the leaderboard bucket
was a single flat integer (`balance_version`) auto-labeled `Season N`; since `BALANCE_VERSION`
starts at 3 the first board read "Season 3" (the "weird name"), the picker showed raw ints and
hid itself for one period, and career showed the same. Now everything reads "Act X · Season Y".

Key idea: `balance_version` stays the internal per-record/match/replay key. A NEW `act` column
GROUPS versions; the displayed **season number is the version's 1-indexed ORDINAL WITHIN ITS
ACT** (derived via `row_number`), so it's always contiguous from 1 regardless of the raw bv.

Changes:
- `server/db/migrations/0010_season_acts.sql` — `seasons.act int not null default 0` (all
  existing rows → Act 0 = beta), and `seasons.name` made nullable (null ⇒ use structured label).
- `server/db/repo.ts` — `SeasonRow` gains `act`/`seasonNo`, `name: string|null`; `listSeasons`
  computes `season_no = row_number() over (partition by act order by balance_version)` and
  NULLs legacy auto `"Season N"` names; `ensureSeason` no longer bakes a name; `startNewSeason
  (fallback, name?, bumpAct?)` returns `{season, act, seasonNo}` — `bumpAct` ⇒ act++, season
  ordinal resets to 1, else same act.
- `server/index.ts` — `/api/admin/season/start` reads `act=new`, fires the `'act'` vs
  `'season'` cinematic announcement, returns `{season, act, seasonNo}`. Label via `periodLabel`.
- `src/seasons.ts` — new pure `periodLabel({name, act, seasonNo})` = custom name || "Act X ·
  Season Y" (shared by leaderboard, career, match history, server announcement).
- `src/net/api.ts` — `SeasonInfo` gains `act`/`seasonNo`, `name` nullable; `adminStartSeason
  (name?, {newAct?})`.
- `src/ui/Leaderboard.tsx` + `MatchHistory.tsx` — picker is now `<optgroup>`-per-act
  ("Act 0 · Beta" for act 0), options show "Season Y" / custom title; badges use `periodLabel`.
- `src/ui/CareerPanel.tsx` — maps `stats.season` → full `SeasonInfo` and labels via `periodLabel`.
- `src/ui/Admin.tsx` — "Acts & Seasons" card: START NEW SEASON + START NEW ACT buttons, custom
  title optional (blank ⇒ auto label).

Behavior on the live prod DB (bv3, name "Season 3", beta): migration adds act 0 → the board
now reads **"Act 0 · Season 1"**. When ready to launch, admin clicks START NEW ACT → bv4,
**"Act 1 · Season 1"**. Non-destructive: underlying balance_version stamps are untouched; only
the DISPLAY is derived. Deploy: server + migration ⇒ `flyctl deploy --remote-only` (migration
runs at boot; verify `/health`), Vercel auto-deploys clients. Protocol unchanged, backward-compat
(old clients that don't send `act=new` just start a same-act season).

## Prev — duo record now allows DIFFERENT drivetrains (mixed ⇒ overall board only)

User: duo record mode should let the pair run different drivetrains — such a run counts
on the OVERALL record ranking but NOT any drivetrain-specific board. Previously the server
hard-refused to start a mismatched duo. This mirrors ranked ELO's existing rule
(`computeGlicko`: the per-drivetrain board updates only when all participants share one
drivetrain; mixed teams hit `overall` only).

Changes (server + DB + client copy — NO protocol shape change, backward-compatible):
- `server/room.ts` `startMatch` — DELETED the `dts.size > 1` block that broadcast an error
  and refused to start a mismatched duo. No drivetrain gate remains.
- `server/persist.ts` — a duo whose participants ran different drivetrains keys the
  `'overall'` sentinel instead of `primary.drivetrain`
  (`new Set(o.participants.map(p=>p.drivetrain)).size > 1 ? 'overall' : primary.drivetrain`).
  Uses ALL participants (incl. an unauthed partner) so the mix reflects the robots that played.
- `server/db/repo.ts` — `personalBest` + `recordRank` now treat `drivetrain === 'overall'`
  as NO drivetrain filter (matching `recordLeaderboard`'s existing 'overall' semantics), so a
  mixed run's PB/rank is computed on the cross-drivetrain board it actually lands on.
- `server/db/migrations/0009_record_overall_drivetrain.sql` — relaxes the `records.drivetrain`
  CHECK to also allow `'overall'` (elo_ratings already permitted it). WITHOUT this the INSERT
  throws 23514 and the run is silently dropped (results screen hangs on "computing rank").
- `src/net/protocol.ts`, `src/ui/Lobby.tsx` — copy updated (no longer says "same drivetrain").
- `src/ui/GameView.tsx` — `DRIVETRAIN_LABEL.overall = 'Mixed'` so the results line reads
  "Duo · Mixed" not lowercase "overall".

Deploy: server + migration ⇒ `flyctl deploy --remote-only` (migration runs at boot; verify
`/health`), then Vercel auto-deploys clients. Protocol unchanged → old clients keep working
(they'd just render a received `drivetrain:'overall'` via their `?? d` fallback).

Design note: matched-drivetrain duos are UNCHANGED — they still rank both that drivetrain's
board and (via best-any) the overall board. Only mixed pairs are new, and they land on
overall alone.

## Prev — rejoin worked "weirdly" for duo-record + multiplayer (reconnect race)

> `npm run build`, `npm test` (5 new reconnect checks), `npm run server:check` passed then.

Symptom: after a transient drop, rejoining a live match often failed to a "Connection
lost" panel (or the reconnected player mysteriously went offline / got dropped).

Root cause: on a transient network partition the client reconnects fast (~1s) and sends
`rejoin`, but the server hasn't reaped the OLD socket yet (a partitioned TCP connection
lingers for tens of seconds, so `c.connected` is still true). `Room.reattach` REFUSED a
reclaim whenever `c.connected` — so the fast reconnect was rejected (`rejoined:false` →
hard fail). Naively allowing it introduced the mirror bug: the stale old socket's
eventual `close` → `detach` would then knock the freshly-reconnected player offline.

Fix (server only, sim/protocol untouched):
- `server/room.ts` — each slot carries a monotonic owning-connection stamp
  `Client.conn` (bumped by `add`/`reattach` from `connSeq`). `reattach` now takes over
  even a still-`connected` slot (the correct clientId proves ownership; the old socket is
  orphaned — its `send` is replaced) and returns the new conn (or `null` only when the
  slot is truly gone → grace lapsed). `detach(id, conn?)` ignores a close whose `conn`
  doesn't match the current owner (the stale old socket).
- `server/index.ts` — the connection tracks its `conn` (set on join/rejoin) and passes it
  to `detach` on close; the rejoin branch adopts the conn `reattach` returns.
- `scripts/smoke.ts` — +5 checks: fast rejoin reclaims a still-connected slot, resync
  snapshot sent, stale old-close ignored (no roster churn), current-close honoured,
  unknown slot → null.

Deploy: server change ⇒ needs `flyctl deploy --remote-only` (verify `/health`). Protocol
is unchanged (no new caps), so it's backward-compatible with old clients.

## Prev — held balls of REMOTE robots didn't move with the robot (multiplayer)

Symptom: balls held inside *other* robots in a room floated/lagged relative to the
robot body. Cause: remote robots render at an **interpolated** pos (`displayWorld` in
`game.ts`), but balls are NOT interpolated (render from the predicted sim). `drawRobot`
recovered each held ball's local offset via `b.pos - r.pos` — the interpolated `r.pos`
and the sim-built `b.pos` diverge, so the ball was misplaced.

Fix (`src/render/drawRobot.ts`, render-only — sim/netcode untouched): held balls carry
their true robot-frame offset in state (`b.state.lx/ly`, already synced in the ball
delta), so draw them from that directly instead of the world round-trip. They now track
the body rigidly regardless of interpolation. No smoke change (render layer).

---

## Prev session — Markdown announcements + scoring-timing per manual 9.x A–F

> Was GREEN incl. `npm run contrast`; deployed (Fly server + pushed to alpha for Vercel).

## This session, part 2 — Markdown announcement bodies

Announcement bodies (patch notes / season / act) now render as **Markdown** instead of
being flattened into flat bullets. New self-contained renderer (NO deps — project rule),
React elements only (no `dangerouslySetInnerHTML`), so admin-authored bodies can use
structure with no HTML-injection surface. Unsafe link schemes (e.g. `javascript:`) → `#`.
Supported: `#`..`######` headings, paragraphs, `-`/`*`/`•`/`+` + `1.` lists (nested by
indent), `**bold**`/`*italic*`/`` `code` ``, `[label](url)`, `---` rules.

- `src/ui/markdown.tsx` (NEW) — `<Markdown text=… className=… />`. Block parser +
  earliest-match inline tokenizer; nested lists via an indent stack; safe-href guard.
  Verified with a `react-dom/server` render harness (9 structure/security asserts).
- `src/ui/Announcements.tsx` — "What's new" list renders `<Markdown>`; dropped the old
  `bulletLines` flattener.
- `src/ui/Admin.tsx` — composer advertises Markdown + shows a **live preview**; textarea
  `maxLength` 4000→8000, `rows` 5→8.
- `server/index.ts` — announcement body cap `slice(0,4000)`→**8000** (long patch notes).
  *This is the only server change → needed a redeploy (done).*
- `src/ui/styles.css` — replaced `.ann-list*` with themed `.md*` classes (headings, lists,
  code, links, hr). `npm run contrast` still 135/135 in both themes.
- `PATCHNOTES.md` (repo root) — user-facing patch notes for the whole alpha-vs-main delta
  (written this session; ready to paste into an announcement).

## This session, part 1 — scoring-assessment TIMING per manual 9.x A–F

> Sim change in `src/sim` (`scoring.ts` + `match.ts`), no protocol/DB/config change,
> no `BALANCE_VERSION` bump. Server-authoritative + identical everywhere; deployed.
> Determinism holds (pure functions of world state).

## What shipped this session — WHEN each score is assessed (manual rules A–F)

The manual specifies exactly when each score is locked in. Three of the six were being
assessed on the buzzer tick, before artifacts/robots came to rest. Fixed all three; the
sim already keeps stepping through the `transition` and post-match settle windows (solo
`stepSolo` + server), so the scores just needed to be (re)computed as things settle.

- **Rule A** (CLASSIFIED/OVERFLOW throughout, and *anything before TELEOP starts counts
  as AUTO*): `addClassified`/`addOverflow` now bucket `auto` **OR `transition`** as AUTO
  (new `scoredAsAuto` helper in `scoring.ts`). A ball that commits during the post-auto
  transition settle was previously mis-billed TELEOP. Everything from teleop onward
  (incl. the post-match settle) is TELEOP.
- **Rule B** (AUTO PATTERN at rest-after-auto OR teleop-start, whichever first): no
  longer snapshotted on the auto buzzer. `assessAutoPattern` (idempotent, no events) is
  recomputed every `transition` tick and **locked at TELEOP start** (that's where the
  `AUTO PATTERN +N` event now fires). A ball still in flight/on the rail at the auto
  buzzer is counted once it settles.
- **Rules C/D/F** (TELEOP PATTERN / DEPOT / BASE at rest-after-match): `assessMatchEnd`
  is now **idempotent** (base is reset + recomputed, not accumulated) and `stepMatch`
  calls it **every tick during phase `post`**, so late-draining ramp balls, still-rolling
  depot balls, and a robot coasting into its base during the settle window are all folded
  in; the value locks when motion ceases.
- **Rule E** (LEAVE at end of AUTO): unchanged behavior — split out into `assessLeave`,
  still called once on the auto→transition edge.

`assessEndOfAuto` is GONE (was leave+pattern in one); replaced by `assessLeave` +
`assessAutoPattern`. Only `match.ts` and `smoke.ts` referenced the scoring exports.

### Files touched
- `src/sim/scoring.ts` — `scoredAsAuto`; `addClassified`/`addOverflow` bucket by it;
  `assessEndOfAuto` → `assessLeave` + `assessAutoPattern` (idempotent); `assessMatchEnd`
  now resets `s.base` (idempotent, safe to recompute each tick).
- `src/sim/match.ts` — `stepMatch`: `post` recomputes `assessMatchEnd` each tick;
  `transition` recomputes `assessAutoPattern` each tick; auto-end calls `assessLeave` +
  seeds pattern; teleop-start locks the final auto pattern + fires the event.
- `scripts/smoke.ts` — imports `addClassified`/`addOverflow`; +2 checks: (1) an artifact
  scored in `transition` banks as AUTO; (2) BASE is re-assessed as a robot settles into
  base during the `post` window (0 at buzzer → 10 after it rests).

## Gotchas / notes
- `assessMatchEnd` is now safe to call repeatedly (idempotent). Smoke calls it directly
  on fresh worlds — still fine.
- Nothing gates balls by phase in `step()`, so they keep flowing/scoring in `transition`
  and `post` — that's what makes the deferred assessment work. Don't add a phase gate to
  ball physics or you'll re-break rules A/B/C/D.
- The `AUTO PATTERN +N` event now fires at TELEOP start (was auto end). Cosmetic (event
  log only).

## Prev session (still true) — gate "easier to open"
Ram-speed-scaled gate lift (`gateLiftRate`) + anticipated collider retract
(`gateColliderPos` → `buildGateArms`) so no 1-tick jolt. `GATE_OPEN_HOLD` 0,
`GATE_OPEN_RATE` 10, new `GATE_OPEN_RATE_SPEED`/`_MAX`. See git log for detail.
