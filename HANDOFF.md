# HANDOFF — 2026-07-10 (multiplayer held-ball render fix; prev: Markdown announcements + scoring-timing) — READ FIRST

> **GREEN — `npm run build`, `npm test` pass.**

## Latest — held balls of REMOTE robots didn't move with the robot (multiplayer)

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
