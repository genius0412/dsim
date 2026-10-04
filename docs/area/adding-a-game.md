<!-- governs: src/games/types.ts, src/games/index.ts, src/games/sim.ts, src/games/module.ts, src/games/importChecks.ts, src/games/importMechChecks.ts, src/seasons.ts, src/seasonVisibility.ts -->
# Adding a game

FOUR registrations, and all four are silent when missed.

*Split out of `CLAUDE.md` on 2026-09-16, **verbatim** — CLAUDE.md is loaded into every
session and this is not needed by most of them. The `governs:` line above is read by
`scripts/docaudit.mjs` and by the editor hook, so keep it accurate when paths move.*

---

## Adding a game

Everything below the four registrations is OPTIONAL — a game that fills nothing behaves
exactly like a game written before the slots existed. **Nothing outside
`src/games/<id>/` should need editing.** If it does, that is a seam bug: generalize the
shared file instead of adding a third arm to a two-valued branch.

**FOUR registrations, and all four are silent when missed:**
1. `src/games/index.ts` — `GAMES` (the CLIENT module: renderers + UI slots).
2. `src/games/sim.ts` — `SIM_GAMES` (the SERVER-SAFE module). Missing here and the
   authoritative server runs your players a DECODE room without saying so.
   ⚠️ Add it as a **GETTER**, like the three already there — there is an import cycle
   through this file (`src/sim/spawn.ts` needs `simModuleFor` for the start-index clamp)
   and a plain `id: MODULE` entry is a module-eval-time read, which is exactly what a
   cycle cannot survive.
3. `src/seasons.ts` — the `SEASONS` entry (name/presenter/program/years/blurb,
   `playable`, and `channels` if it must stay off the stable site).
4. `src/games/types.ts` — the id in `GameId` **and** in `GAME_IDS`. Every "which games
   are there" site reads `GAME_IDS` / `isGameId` / `coerceGameId`; a hand-written
   two-valued literal anywhere is a bug (`npm test`'s biobuzz suite greps for the
   consequences).

Plus `World.<id>?: <Id>State` in `src/types.ts` for the game's own plain-JSON bag, and
`GameSimModule`'s `initialAct` (its first ranked period's act; acts are stored per game, so it
need not differ between games — BIOBUZZ opens at Act 1) and
`startPoseCount` (the legal range of a `startIndex`; every clamp reads it).

**The OPTIONAL UI slots** (`GameModule`, `src/games/module.ts`) — each wired at its
consumer as `mod.X ? <slot> : <the existing branch, unchanged>`, so DECODE's and CR's
inline branches stay untouched:

| slot | consumer |
|---|---|
| `Builder` | `Menu.tsx` (the Customize section) |
| `DrivingRows` | `Menu.tsx` — the end of the robot page's Driving panel (BIOBUZZ: the pass-target picker) |
| `Preview` | `Menu.tsx` + `MatchStrategy.tsx` (the robot schematic) |
| `startEditor` | `MatchSetup.tsx` / `Lobby.tsx` / `MatchStrategy.tsx` |
| `hudChips`, `scoreBar` | `GameView.tsx` (the `.robot-status` row / the whole bottom bar) |
| `resultsRows` | `Results.tsx` — both the versus results and `RecordResults`. Rows are ALLIANCE-RELATIVE (`[label, mine, opp]`) |
| ~~`mobileButtons`~~ | **no longer a slot** — a game's touch buttons are `src/games/<id>/mobile.ts`, merged with the shared set by `src/ui/mobileActions.ts`. The set is DERIVED from `ACTION_GAMES` and `npm test` asserts every action a game uses is reachable on touch, so a new season control fails the suite until it has a button or a written reason. A genuinely new action still needs a protocol bit |
| `labels.configSummary` | `robotLabels.ts` + `Leaderboard.tsx` |
| `devRoutes` | `App.tsx` routing — **alpha channel only** (`devRoutesEnabled()`) |
| `offersAutoFire` | `Menu.tsx` Driver assists — `false` hides the Auto fire toggle (BIOBUZZ: Aim Assist gates the driver's fire instead) |

and, on the DOM-free side, `GameSimModule.hud?(world, robotId)` → `HudSnapshot.gameHud`:
the game's own HUD slice, opaque (`unknown`) because only its own components read it — plus
`GameSimModule.artifactSolids?(r, held, radius)`, the game's own answer to "what on this robot
is SOLID to a ground element". Absent ⇒ the shared `robotSolids`, i.e. DECODE's front funnel;
BIOBUZZ fills it because its sweeper is a roller bar on whichever edge `intakeMount` names, and
DECODE/CR leave it empty so `src/sim/world.ts` is untouched.

An `ImportMechSlot` (`<game>/importChecks.ts`) is what the imported-robot placement editor asks a
game: `handles` (the spans and points the player may drag), `defaults` (the pre-fill, coerced) and
`issues` (plain-language checks, `block` stops Save). **It is NOT a `GameSimModule` slot**: a new game
registers its slot in `src/games/importMechChecks.ts`, whose `validateImportedMech` /
`defaultImportedMech` / `mechHandles` the editor (`robotImport/ui/placement.ts`) and the smoke suite
call; the game-neutral mouth/height checks and pre-fill helpers are `src/games/importChecks.ts`.
It was a slot on the sim module until the bundle audit found the three games' check code in the
entry chunk of every page (~3 KB gzipped) for a screen one player in a hundred opens, so **do not
import `importMechChecks.ts` from the sim registry, the server, a renderer or the robot page**.
Not registered ⇒ DECODE's checks, the same fallback as `simModuleFor`.

`GameUiSpec` (`ui`) is an earlier attempt at the same idea and has never had a reader.
It is left alone deliberately; do not build on it.

**Tests**: game checks go in `scripts/smoke-biobuzz/` (its own `npm test` process), never
appended to `scripts/smoke.ts`. `npm test` chains the two with `&&` — deliberately, so a red
`npm test` keeps meaning "the physics broke" — and both suites are green, so it runs both and
must print `ALL PASS` twice. ⚠️ The corollary: **while the first suite is red the second
does not run at all**, and for the whole of BIOBUZZ Phase 0 (7 accepted contact-physics
failures) that meant `npm test` proved nothing about the second one. `npm run test:bb` runs it
alone — the fast loop inside `src/games/biobuzz/`, and the way to check it when the first
suite is red for an unrelated reason. `docs/biobuzz/baseline-alpha.md` is the gate.

---

