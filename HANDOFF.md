# HANDOFF — 2026-09-18 (branch `discord-activity`: alpha merged in, PR ready)

**READ FIRST if you are on `discord-activity`.** `origin/alpha` @ `1237b7f0` (roadmap round 1) is
merged. Conflicts were the Discord additions meeting alpha's refactors, all resolved on alpha's
structure: `Lobby.tsx`'s join flow is alpha's `wire()`/`join()` split with the Discord `group` tag
passed at the one `wire(...).join(...)` call site and the DISCORD_REGION pin inside `join()`;
`clipboard.ts` is GONE in favour of alpha's `copyText.ts` (same fallback, callback style);
`ModeSelect` carries both `compete` and `onTutorial`. Post-merge fixes: `.ds-discord-join` onto the
type scale + house shadow (uiaudit ratchet), and the Embedded App SDK behind `src/net/discordSdk.ts`
so its lazy chunk stops being named `index-*` and billed against main (bundleaudit has a `discord`
route now, 44.30 KB gzip, loaded only in the embed).
- **Green:** `build`, `server:check`, `test:mm` (197), `uiaudit`, `contrast`, `bundleaudit`,
  `docaudit`. `npm test` is 2097/2098 — the ONE failure (`fieldDims.gen.ts is exactly what
  emit-dims.mjs renders…`) **reproduces on a clean `origin/alpha` worktree**, so it is alpha's, not
  this branch's; upstream probably needs an `npm run field-cad` commit.
- `gh` auth is broken on this machine (401), so PR #41's GitHub-side state was not checked here.

---

# HANDOFF — 2026-09-19 (alpha: ROADMAP ROUND 1 LANDED — auth flows, tutorial, contributors, cosmetics/rewards plans, Vercel policy; alpha server redeployed)

**READ FIRST.** Branch **`alpha`** (worktree `.claude/worktrees/pr-alpha`), pushed, every gate green on
the merged tree: `build` · `bundleaudit` · `server:check` · `docaudit` · `uiaudit` · `contrast` ·
`test:mm` · `dbtest` · `npm test` (counts in the log). The ALPHA game server (`dsim-alpha`) was redeployed
from this tree (`./scripts/fly-deploy.sh --alpha`) because auth adds migration `0040` and server routes.
The four sections below this one are each branch's own handoff, written by the agent that built it;
their "NOT merged / NOT pushed" lines are stale — all four ARE merged here. Production is untouched.

## What landed on alpha (each on its own branch, merged in this order)
- `feat/plans-cosmetics-rewards` → `docs/cosmetics-plan.md`, `docs/rewards-plan.md` (roadmap items 3–4;
  the owner approves before code). Two code facts they surfaced: the 3D chassis ignores `chassisColor`
  (paints alliance fill), and `coerceSpec` checks only that a colour KEY is legal, never that the account
  is entitled — enforcement is UI-only today.
- `feat/contributors` → real sections (core team, contributors from `CONTRIBUTORS.md` incl. a missing
  signer, presented-by via `sponsorLink`, third-party credits with versions baked from `package.json`
  at build time, get involved). Owner still fills the `TODO(fill in)` handles/avatars.
- `feat/tutorial` → `src/tutorial/` engine (DOM-free runner, `GameModule.tutorial` slot), BIOBUZZ six
  steps + DECODE four, the step card in the HUD band, a first-run offer on Modes and a Controls entry,
  per-device flag `decodesim.tutorial.v1`; TUTORIAL lane 318 checks (non-vacuous AND completable, both
  physics, both alliances). Runs as FREE DRIVE so nothing is recorded (a staged world is not
  reconstructible from `{seed, setups}`); `startMatch` refuses while a tutorial is live.
- `feat/auth-flows` → `src/lib/authFlows.ts` (one wrapper over the Neon/Better-Auth SDK, pinned exactly
  at 0.4.2-beta): forgot password (`/account/reset`), email verification (banner, resend,
  `/account/verify`), terms acceptance (`LEGAL_VERSION`, migration `0040_terms_acceptance.sql`,
  `POST /api/user/accept-terms`, a blocking `TermsGate` on version mismatch incl. OAuth first sessions).
  ⚠️ The email-verification SERVER GATE (ranked queue, record-room join, `/api/practice`) is OFF until
  `REQUIRE_VERIFIED_EMAIL=1` — every existing password account is unverified and no sender domain is
  configured; the owner's Neon dashboard steps are in `docs/deploy.md` §4. Also fixed in passing:
  `uiaudit`'s component-index staleness check compared CRLF against LF (failed on every fresh Windows
  checkout).
- Vercel: `vercel.json` builds ONLY `main` and `alpha` (`ignoreCommand`) and disables auto-deploy for the
  feature branches; `scripts/vercel-prune.mjs` (owner-run, token via env, dry run by default, waits out
  the 200-deletions-per-10-minutes limit) took the project from 501 to 113 deployments on 2026-09-18.
  Feature-branch pushes had been queueing previews ahead of the alpha build.

## Owner actions
- Neon Auth: sender domain + "require email verification", then `REQUIRE_VERIFIED_EMAIL=1` on the alpha
  app (`docs/deploy.md` §4). Review the terms/privacy copy touched by the acceptance flow.
- Fill the contributors' handles; decide the cosmetics and rewards plans' numbered decisions.
- Test on alpha: sign-up with the terms box, forgot-password screen, the tutorial from Modes, Contributors.

## Next (roadmap)
`feat/privacy-cookies` (item 8; shares `LEGAL_VERSION`), the 3D robot creator (item 1, on
`biobuzz-3d`), replay 2D/3D export is DONE (Day 3), cosmetics/rewards builds after approval. BIOBUZZ 3D
follow-ups are in the Day 3 section: nectar-in-flower scoring ruling, weigh an element set, AI 59/100.

## Gotchas (new)
- The Neon adapter THROWS on any non-2xx (`AuthApiError` with lower_snake codes); the `{data,error}`
  union's `error` is essentially never populated — classify the throw.
- Read the emailed `?token=` at module load (`src/ui/entryToken.ts`): App canonicalises the address bar
  before any screen renders. Spend a verification token once (a ref, not state — StrictMode).
- A tutorial predicate that is already true on the staged world is invisible; the lane's non-vacuity
  check is the only guard. A hand-written `held` ball state without `lx/ly/side` is a NaN into Rapier —
  stage through `capturePollen`. `TutorialRunner.abandon()` is not `finish()` (the recorder check counts
  `.finish()` calls in `game.ts`).
- Vite's dev server refuses to serve files whose real path is outside the worktree (junctioned
  `node_modules` → font 403s in dev only); builds are fine.

---

# HANDOFF — 2026-09-18 (`feat/auth-flows`: password reset, email verification, terms acceptance — roadmap item 5, BUILT, NOT PUSHED)

**(Previously READ FIRST.)** Branch **`feat/auth-flows`**, off `alpha` at `76034a9`. Seven commits, not pushed
and not merged. Gates green on the branch: `build` · `server:check` · `npm test` (1840 shared +
1780 BIOBUZZ) · `dbtest` (ALL PASS, +12 for migration 0040) · `uiindex` then `uiaudit` (all rules
at baseline) · `docaudit` · `contrast` (223, unchanged — no new colour, the banner's tint is
`color-mix` over `--ds-warn`) · `bundleaudit` (main +0.9 KB gz, hostWorker unchanged).

⚠️ **NOTHING IS LIVE UNTIL THE OWNER DOES THE NEON DASHBOARD WORK.** `docs/deploy.md` §4 is the
checklist. The terms half works the moment the game server is deployed (migration 0040 applies at
boot); the two email flows send nothing until a sender domain is configured, and that failure is
SILENT — the forms answer 200 and no mail leaves. Send yourself one before believing it works.

## What is on the branch

- **`src/lib/authFlows.ts`** — the ONE module that calls the SDK. Four functions, each returning a
  discriminated `AuthFlowResult` and never throwing at a component:
  `requestPasswordReset(email)`, `completePasswordReset(token, pw)`,
  `requestEmailVerification(email)`, `completeEmailVerification(token)`. `@neondatabase/auth` is
  pinned to the exact installed `0.4.2-beta` (no `^`).
- **Forgot password** — a `.ds-linkbtn` under the sign-in password field opens a third form in the
  same modal; `/account/reset` handles the emailed link (and offers the request form when it
  arrives without a token).
- **Email verification** — sign-up asks for the email; a per-session banner on Profile with Resend;
  `/account/verify` spends the token on mount, exactly once, and clears the cached JWT.
- **Terms** — `LEGAL_VERSION` derived from `LEGAL_UPDATED`, migration `0040_terms_acceptance.sql`,
  `POST /api/user/accept-terms`, a required checkbox on sign-up and a blocking `TermsGate` that
  WRAPS `UsernameGate`.
- **`REQUIRE_VERIFIED_EMAIL`** gates ranked queueing, joining a record room, and `POST /api/practice`.

## The five things worth knowing before touching any of it

1. ⚠️ **THE SDK THROWS ITS FAILURES.** The Neon adapter installs its own `customFetchImpl` which
   throws a normalized `AuthApiError` on any non-2xx, so the `{data, error}` union the `.d.mts`
   advertises is real but `error` is essentially never populated. The first cut classified every
   throw as `network` and told somebody with an expired reset link to check their connection. The
   throw carries `status` and a lower_snake `code` (`bad_jwt`, `weak_password`,
   `over_email_send_rate_limit` — the adapter's own vocabulary, NOT Better Auth's SCREAMING_SNAKE),
   and `classifySdkError` now speaks both. Rate limiting is tested before the address, because
   EMAIL is a substring of that last code.
2. ⚠️ **`forgetPassword` IS NOT A TOP-LEVEL METHOD** on this build — only `forgetPassword.emailOtp`
   is, and that is a different flow. The top-level request is `requestPasswordReset`. The roadmap
   named the old one; the wrapper's header cites all four real `.d.mts` signatures with line
   numbers.
3. ⚠️ **THE EMAILED TOKEN IS READ AT MODULE LOAD** (`src/ui/entryToken.ts`). `App`'s mount effect
   canonicalizes the address bar with `history.replaceState(pathFor(...))`, and `pathFor` builds a
   path with NO query string on it — so `?token=` is gone before any screen component renders.
4. ⚠️ **THE RECORD-RUN GATE IS AT THE JOIN DOOR IN `server/index.ts`**, not in `Room.startMatch`
   beside the duo-record "both drivers must be signed in" guard it otherwise belongs with.
   `server/room.ts` is bundled into the LAN host worker (`src/lan/hostWorker`) and must not import
   `jose` or read `process.env` — that is why it goes through `./runtimeEnv` for everything.
5. ⚠️ **`REQUIRE_VERIFIED_EMAIL` IS OFF BY DEFAULT AND MUST STAY OFF UNTIL MAIL WORKS.** Every
   email/password account on the live site is unverified today, and the Resend button cannot help
   until the sender domain exists. Deploy → mail works → let people verify → set the secret.
   `emailGateRefusal` is the single predicate; extend it rather than adding a second check.
   `null` (nobody told us) counts as VERIFIED, deliberately — a gate whose unknown case refuses
   would take ranked down silently the first time an upstream stopped sending a field.

## Open, for the owner

- **The dashboard steps are `docs/deploy.md` §4**: sender domain + DNS, the redirect allow-list
  (every origin: prod, alpha, beta, `localhost:5173`), the provider's "require email verification"
  switch, then the Fly secret LAST.
- **Confirm the JWT carries `email_verified` before trusting the gate.** The server reads that
  claim (or `emailVerified`) off the verified token and falls back to ONE cached
  `GET /get-session` per token; if neither answers, the state is `null` and the gate PASSES. Sign
  in as a test account and read `/token`'s payload once.
- **The legal wording is the owner's to review.** One line was added to the Terms' `## Changes`
  section, because continued use after a change now genuinely does require re-acceptance and the
  document did not say so.
- **The three email flows are NOT end-to-end tested** — no mail can be sent from here. What was
  driven in a browser against a stub auth endpoint: the link and the checkbox, the refusal copy,
  the neutral confirmation, `/account/reset?token=fake` and `/account/verify?token=fake` on their
  error paths, the banner and both variants of the terms dialog (forced locally, reverted), light
  and dark, 375px.

## Next

Roadmap item 8 (`feat/privacy-cookies`) shares `LEGAL_VERSION` and should pick it up from here
rather than re-deriving it. If the terms text moves, `LEGAL_UPDATED` is the only line to change —
and moving it prompts every signed-in account once, so it is a deploy of BOTH halves (Vercel for
the dialog, Fly for the route that records the server's own constant).

---

# HANDOFF — 2026-09-18 (feat/tutorial: ROADMAP ITEM 6 LANDED — the game tutorial, engine + BIOBUZZ + DECODE)

**(Previously READ FIRST.)** Branch **`feat/tutorial`**, off `origin/alpha` at 76034a9. NOT pushed, NOT merged.
Every gate green: `build` · `npm test` (1806 shared across 12 shards + 2098 in the BIOBUZZ suite,
which now includes the new `TUTORIAL` lane) · `uiindex` then `uiaudit` (all rules at or under
baseline) · `docaudit` (CLAUDE.md 26,855 / 27,000 bytes) · `server:check`. `shiftaudit` was NOT run
(it needs Electron + a `vite preview` in another shell) — the card's pressables move by
`transform` / `box-shadow` only, which is the rule it enforces.

## What a tutorial IS here

A scripted SOLO PRACTICE. `src/tutorial/` is the shared, DOM-free engine; the CONTENT is per game
on the new `GameModule.tutorial` slot (`src/games/biobuzz/tutorial.ts`, `src/games/decode/tutorial.ts`).
`docs/area/ui.md` carries the rules — read that section before touching any of it. The one that
shapes everything:

⚠️ **A STEP'S SITUATION IS STAGED AT WORLD CONSTRUCTION, NEVER INTO A RUNNING WORLD.** Solo practice
is recorded and a replay rebuilds from `{seed, setups, commands}` alone (`docs/area/netcode.md`), so
`TutorialStep.stage(world)` runs at tick 0 on a freshly built world and moving to the next step
REBUILDS it (`GameController.rebuildForTutorial`, which is `restart()` minus the abort cue and the
harvest). The tutorial runs as FREE DRIVE, which is drivable from tick 0, bills no BIOBUZZ fouls,
and is **never recorded** — the honest answer to "could a replay reproduce a staged world": it
could not, so none is kept.

## Files

- `src/tutorial/{types,runner,hints,flag,index}.ts` — the engine. `TutorialRunner` is a state
  machine the caller drives: `stage` → `tick` per sim tick → `advance` (the caller rebuilds).
  `hints.ts` composes every hint from the player's LIVE `ControlBindings`, naming a pad button when
  a pad is connected and an on-screen button on a coarse pointer. `flag.ts` is
  `decodesim.tutorial.v1`, per device, fail-open both ways (the `chainDisclaimer.ts` pattern).
- `src/ui/TutorialCard.tsx` + `src/ui/tutorial.css` (imported from `main.tsx`, its own file for the
  reason `predict.css` is) — the step card. A `data-hud-band` element at bottom centre, so the 3D
  camera reframes the field above it and it gets the 3D view's dark scrim.
- `src/game.ts` — `tutorial` constructor option, `getTutorial()` on the HUD snapshot, `tutorialSkip`
  / `tutorialReplay` / `tutorialExit`, the per-tick predicate inside `stepSolo`, and the `startMatch`
  guard.
- Surfaces: the first-run card on `/modes` (hidden once the flag is set), a permanent
  "Run the tutorial" block at the top of Controls, and `GameView`'s `tutorial` prop.
- `scripts/smoke-biobuzz/tutorial.ts` — the `TUTORIAL` lane, 318 checks, 1.4 s.

## The content

**BIOBUZZ, six steps** (five for a build without the hardware for the NECTAR one): drive to your
garden · pick up a pollen · shoot into your hive · tip the hive (the cell is staged with the three
NECTAR the field gives it plus two POLLEN, so the measured table's third POLLEN is the shot the
player takes) · place a nectar in a flower **or** take a pollen from a flower · park in your loading
zone. **DECODE, four steps**: drive into your launch zone · pick up an artifact · score in your goal
· return to your base.

⚠️ **THE TWO FLOWER STEPS ARE A PARTITION, and the lane asserts it.** `TutorialStep.applies(spec)`
is resolved once when the runner is built. Placing a NECTAR needs a Box Tube **and** a launcher that
carries NECTAR (`bbCarriesNectar` — a single turret feeds POLLEN only, so **no shipped preset can do
it**); every other build is asked to retrieve a POLLEN instead. Every build is offered exactly one.

## Gotchas this shipped against

- ⚠️ **A PREDICATE THAT IS TRUE ON THE STAGED WORLD TEACHES NOTHING, AND IT IS INVISIBLE** — the card
  flashes past. The SHOOT step shipped as `contents.length > 0`; the field stages three NECTAR in
  every up CELL, so it was true at tick 0 for both alliances. It is `cellPollen(...) > 0` now, and
  the lane asserts non-vacuity for every step of both games under both physics and both alliances.
- ⚠️ **A hand-written `held` ball state is a NaN that reaches Rapier.** `{ kind:'held', robot, slot }`
  omits `lx/ly/side`, `positionHeldBalls` puts `undefined` through `rot()`, and the collider
  translation throws out of the solve. Staging goes through `capturePollen`, which is also what
  enforces the hopper cap, G408 and the NECTAR-capacity rule.
- ⚠️ **A staged pose derived from the CHASSIS is wrong for half the builds.** Both FLOWER steps act
  through a mechanism whose edge is a builder choice, so the pose is derived from
  `bbPlacePointLocal` / `bbMouths` and the robot is turned until that offset points along the wall.
  A front-assumed pose put a relocated Box Tube 10 in off the ring, pointing at open floor.
- ⚠️ **`TutorialRunner.abandon()` is not called `finish()`** — `npm test` counts `.finish()` calls in
  `src/game.ts` and requires exactly one, because the replay RECORDER may only be closed inside
  `harvestPracticeRun`. A second `.finish()` in that file reads as a second save policy to the grep,
  and the grep is the check.
- **Hive frame bars are at x = ±24…25, y = ±19.4.** Three staged poses had to move off them; a pose
  overlapping a static does not throw, it explodes the solve and reads as a position in the hundreds.
- **DECODE's penalty engine runs in `freeplay`** (BIOBUZZ's does not), so a DECODE step staged near
  the gate can bill the player in the one mode where nothing is meant to count against them. The lane
  asserts every scripted DECODE run ends with zero fouls.

## Next steps

- Push and merge to `alpha` (not done — the branch is local).
- Chain Reaction has no tutorial and registers none; the slot is there when somebody wants one.
- `shiftaudit` on the card, from an Electron shell with `npx vite preview --port 4173` running.
- Worth considering: an in-match entry point (the tutorial is currently only reachable before a run),
  and a step that teaches the human-player NECTAR entry, which free drive cannot host (`bbHumanPlayerTick`
  is gated to TELEOP).

---

# HANDOFF — 2026-09-18/19 (biobuzz-3d: DAY 3 LANDED — bots, graphics settings, HDRI, 3D export, prediction modes, cutover; merged to ALPHA and the alpha server deployed)

**READ FIRST.** Branch **`biobuzz-3d`** was merged into **`alpha`** at the merge commit named in the
log and the ALPHA game server (`dsim-alpha`, `fly.alpha.toml`, one machine) was deployed from the
alpha worktree with `./scripts/fly-deploy.sh --alpha` for proper testing (owner instruction). Every
gate green on the merged tree: `build` · `bundleaudit` · `server:check` · `docaudit` · `uiaudit` ·
`test:mm` (197) · `dbtest` (266) · `npm test` (1798 shared + the BIOBUZZ suite, count in the log).
Production (`main`, `dohun-sim-decode`) is untouched; promotion is the owner's call (spec §12 q7).

## Day 3 (spec §10) — landed, three OPUS lanes
- **Lane A, bots** (`src/games/biobuzz/ai/`): `GameSimModule.bot = { tiers, defaultTier, coerceTier,
  create(world, robotId, tier, seed) → { step(world): RobotCommand; dispose?() } }` — the caller owns
  the memory, steps a seat once per tick BEFORE the sim step, records the (already quantized) command
  like a driver's; nothing is written to `World`; reads positions and the derived lists only (a Proxy
  check forbids `rngState`; source greps forbid DOM, clocks, `process.`, `import.meta`, `sim3d/` except
  `tilt`). Tiers easy/medium/hard differ in execution only (hesitation, speed cap, aim tolerance, verdict
  strictness, placing, defending, patience, park time). AI lane 47 checks in `npm test` (determinism
  over 3,600 ticks under both physics with equal hashes AND command logs). `npm run test:ai` (150
  matches, ~8 min, outside `npm test`): hard vs idle 102 pts mean (1.93× easy); **hard beats easy 59/100
  head-to-head, NOT the plan's 90** — a BIOBUZZ 1v1 is decided in 20-point tip lumps from one shared
  element pool; the check is a ratchet at the measured rate (`BB_AI_WIN_RATE_FLOOR` 0.55) with the target
  named; levers: fouls (~6 pts/match), element denial, the 99-in drive after a hive flip. Perf with four
  bots: `step3d` 2v2 median 0.345 ms, p95 0.498 — no tuning needed; bots cost 0.004 ms. R102: `bbStowHeightIn`
  (declared `stowHeightIn` or `min(heightIn, 18)`), refused at `startLegal`, deploy = a read of
  `world.match`, the collider rebuilt at the edge with `z` continuous.
- **Lane B, graphics** (`graphics/{settings,auto,environments,viewKey}.ts`, `scene/renderEnvironment.ts`,
  `renderStats.ts`, Configure's Graphics section): presets Auto/Low/Medium/High/Ultra/Custom over the
  sixteen settings, per device (`decodesim.graphics`), 14 live, mesh detail needs a rebuild, SMAA and
  SSAO NOT offered (chunk cost; the UI says why). AA is a scene-owned MSAA target (the renderer is created
  `antialias:false`). Auto: GPU string + cores/memory/DPR → first guess, 2 s warm-up p95 (down > 16.7,
  up < 6), slip ≥ 25 ms sustained 3 s lowers once with one event line; `STALL_MS` 500 discards samples
  after a throttled gap (an alt-tabbed player must not come back to Low). This machine: Ultra. Two CC0
  Poly Haven HDRIs (School Hall; Monochrome Studio 02), 1k `.hdr` on demand via `HDRLoader` + PMREM,
  never bundled; `src/contributors.ts` DERIVES the credits from `BB_ENVIRONMENTS` (a check pins the
  count). Replay export View 2D/3D + camera (roadmap item 2): scene → its own overlay sheet → export
  canvas → burn-in; 3D costs 1.96× the 2D export at 1920; insets = the bottom band. Gallery draws 2D | 3D
  per cell with ONE shared scene (Chrome caps contexts). Phone: overhead default, a 2D/3D button; the
  view key `t` is armed by `InputManager.attach/detach` (`installViewKey`). Scene chunk 192 KB gz; a
  `graphics` route (5.6 KB) in bundleaudit.
- **Lane C, integration**: prediction Off/Light/Full/Auto (`src/net/predictionPref.ts`, Controls
  section + in-match panel): in a 3D online room the client no longer steps the world — the local robot
  advances through the predictor and the reconcile replays through it; measured Light 0.9 in / Full 0.16 in
  headless, Full reconcile p95 0.3–0.4 ms live; Auto picked LIGHT on the dev build (a 45.8 ms cold probe
  vs 0.3 ms steady — re-measure on a production build before tuning `PREDICT_FULL_BUDGET_MS`). Bot seats:
  solo practice (`GameSettings.practiceBots`, "Opponents"), custom lobbies (host `addBot`/`removeBot`,
  roster rows with `bot: tier`, refused in staged/ranked/record rooms, `unrated` latched), LAN via the
  same `Room`; `SERVER_CAPS` `bb3d` + `bots`; the online "Loading 3D physics" panel via
  `onPhysicsPending`; leaderboard era chip + All/3D/2D filter (`/api/records?physics=`), practice runs
  carry `physics`/`view` with the comparability note; the client refuses BIOBUZZ ranked on a server
  without `bb3d`. Migration renumbered **`0039_physics.sql`** (alpha took 0038 for replay privacy;
  idempotent, disjoint). Two Day 2 rejoin bugs fixed (caps and `physics` on `rejoin`). costprobe 2v2 with
  bots: 0.047 cores/room, 7,556 B/snapshot.
- Coordinator: `game.ts` routes `SceneOptions.onQualityEvent` into `world.events`; `RobotSpec.stowHeightIn`
  + its `coerceSpec` carry-across; the main-chunk bundleaudit baseline re-measured (the `ai/` policy is
  in the main chunk by design — a tier is offered before any physics loads).

## Owner actions and rulings pending
- Test on alpha: online 3D rooms (custom lobby, physics 3D, both views), bots in a lobby and in practice,
  prediction modes, the Graphics section, a 3D replay export (one human MP4 export closes the only
  unexercised path), ranked BIOBUZZ (3D) on the alpha server.
- Rulings: the lone-nectar flower score (CAD 3.597 vs floor 3.904); the CAD lower bore 3.222 vs the
  manual's 2.79; weigh a real element set; the AI head-to-head target (59/100 measured vs 90).
- Production promotion when satisfied (`main` from a main worktree; `./scripts/fly-deploy.sh`).

## Next (roadmap) — `docs/roadmap.md`
Own branches off `alpha`: `feat/auth-flows` (password reset, email verification, terms acceptance —
the SDK already exposes the calls), `feat/privacy-cookies`, `feat/contributors`, `feat/tutorial`; on
`biobuzz-3d`: the 3D robot creator (item 1); plans for cosmetics and rewards (items 3–4) for approval.
BIOBUZZ 3D days 4–14: play-testing, tuning, weighing a set, `MAX_SAVED_ROBOTS` 3 → 4, promotion.

## Gotchas (new)
- `setViewport`/`setScissor` take CSS pixels (they multiply by the pixel ratio); `shadow.map` must be
  disposed and nulled for a live map-size change; `renderer.info.render` resets at the START of `render()`.
- A `process.env` read in `ai/` is green in Node and fatal in a browser (the first bot decision unmounts
  the game screen) — the AI lane now greps for it.
- `coerceSettings` must not fold `practiceBots` to `'off'` for a game with no driver (a DECODE visit
  erased a BIOBUZZ tier); coerce at the point of use.
- `Renderer.render(overlayOnly)` clears the whole canvas — right for the live view, fatal for a
  composite export (every frame black); the export draws the overlay on its own sheet.
- A perf watch pinned at 0.75 ms failed at 0.778 the moment the suite ran beside anything else —
  thresholds that close to the measurement report the machine's load, not the code (gate at 1.5 ms).
- `git merge-tree --write-tree` previews conflicts read-only; alpha and a feature branch both prepending
  HANDOFF always conflict there — keep the feature sections on top; regenerate `docs/ui-components.md`.

---

# HANDOFF — 2026-09-18, night (biobuzz-3d: CAD-authoritative dimensions + DAY 2 LANDED — 3D rooms online, dynamic hive, flower tubes, prediction, cameras)

**(Previously READ FIRST.)** Branch **`biobuzz-3d`**, worktree `.claude/worktrees/biobuzz-3d`, clean at the merge
commit named in the log; every gate green there: `build` · `bundleaudit` · `server:check` ·
`docaudit` · `uiaudit` · `test:mm` (197) · `dbtest` (263) · `npm test` (1798 shared + 1615 BIOBUZZ;
lanes CORE/SIM3D/HIVE3D/FLOWER3D/PREDICT/NET3D/RENDER + the 2D lanes).

⚠️ **THE OWNER MUST DEPLOY THE ALPHA APP before anyone joins a 3D room online**: this day adds a
migration (`0038_physics.sql`), a protocol field (`RoomConfig.physics`, `matchStart.physics`, the
`'bb3d'` cap) and a replay header field — three server changes. `./scripts/fly-deploy.sh` (the
owner's wrapper; NEVER a bare `flyctl deploy`), then verify `/health` and `fly machine list`.
Production later from a `main` worktree. Backward compatibility held: `physics` is omitted (never
written as `'2d'`) on the wire and in containers; old clients still join 2D rooms; pre-0038 rows
read `'2d'`; no version bumped.

## Owner rulings this day
- **"The CAD is authoritative for dimensions."** `BB_*` geometry is GENERATED: `npm run field-cad` →
  `scripts/field-cad/emit-dims.mjs` → `src/games/biobuzz/fieldDims.gen.ts` (STEP version + sha, the
  derivation and residual of every value); `config.ts` imports it under the old names. The field is
  141.35 in inside the walls (`BB_HALF_X` 70.674), tiles 23.528 in on centre (`BB_TILE_PITCH`,
  `BB_TILE_SEAMS`), flowers at their bore-fit centres, hive `BB_HIVE_BOTTOM_Z` 31.981, opening
  [53.375, 65.497], tape as 16 CAD strips (`BB_TAPE`). 2D collider = 3D collider = GLB wall to
  0.0000 in (asserted). The manual's figures are history where they differ
  (`docs/biobuzz-reference.md` carries the dated note). `C.TILE`/`src/config.ts` untouched.
  Pre-2026-09-18 BIOBUZZ replays diverge on re-sim (alpha-only, unranked; no version bump).
- Better agents: rounds after the first play-test ran on OPUS with an analysis phase first.

## Day 2 (spec §10) — landed
- **Lane C, online** (`6ac687c`…`4ae3663`): `await initPhysics3d()` at server boot and lazily in
  the LAN host worker (`vite.config.ts` `worker.format = 'es'` was REQUIRED — an IIFE worker cannot
  code-split, and `initPhysics3d` had been tree-shaken out of the worker); `createWorld` gains a
  FIFTH optional `physics` parameter (a room is not a practice); `Room.physics` decided once
  (ranked/record/staged → `'3d'`, host option in the lobby, absent → `'2d'`); `'bb3d'` cap refused
  at `join`/`spectate`/`rejoin`/BIOBUZZ `queue` with "Update DSIM to play this room."; matchmaking
  stages BIOBUZZ `'3d'`; migration 0038 (`physics` on records/matches/replays/practice_runs, `view`
  on practice_runs, `butterfly` in the drivetrain check); recorder/player stamp and honour `physics`
  (`ReplayView` awaits the wasm); `displayWorld` interpolates elements and remote `z` in 3D worlds
  only; `costprobe` `biobuzz3d-*`: 2v2 0.026 cores/room, 7,231 B/snapshot (72 % of budget; 3D is
  cheaper than 2D). Verified locally: two clients, one 2D-view one 3D-view, same room, identical
  scores/positions at the same tick, the replay re-simulated to the server's score exactly.
- **Lane A, sim** (`366e3ce`…`506a890`): **dynamic see-saw ON** (`BB3_HIVE_DYNAMIC = true`): CAD
  tray hulls on a revolute joint (limits via `.setLimits` on the instance), mass 13 lb APPROX with
  the CoM 5.53 in above the pivot (that is the bi-stability), the detent is a HOLD at the stop
  released when the contents' torque beats `restoring + BB3_HIVE_DETENT` (Rapier has no joint
  friction; a capped motor keeps pulling), `npm run hive-calibrate` swept it: detent 3041, ballast
  6 lb at w −9.5, damping 4.466 → 4.00 s swing; all four §12.3 target rows hold with ±0.31
  element-weights of margin (the whole window is 0.60 wide at nectar ratio 1.6 — weighing a real
  set is what widens it); validation 4/7 (no linear weighting fits the owner-measured rows, as the
  reference already says). `hives[a].angle`/`angVel` ride the JSON; `hiveTiltAngle` reads them.
  **Flower tubes** from the CAD plates (lower bore 3.222 at z −0.2…0.35, mid 3.896 at 3.90…5.25,
  top 4.171 at 20.25…21.40; retrieval opening derives to 3.550 = Fig 9-12); elements fall to the
  tiles inside the bottom bore (nothing seats on a ring); G418's intent holds (only pollen exits
  the bottom). G409 (`bb.spill`) and G417 (`bb.hiveRam`, 3D only; the 2D "no robot can move the
  hive" ruling stands) bill from real contacts. **Predictors** in `sim3d/predict.ts`:
  `createLightPredictor(world, localId)` / `createFullPredictor(world, localId)` with
  `reset/step/dispose`, `probeFullReconcileMs(world, id, now)`; convergence 0.57/0.22 in open
  floor, 2.12/0.19 in on a push; Light < 1 ms, Full 2 ms (budget 8). `step3d` 2v2 median 0.255 ms.
- **Lane B, render** (`a0557e1`…`5ec9d40`): reticle at the sim's own landing (`renderLanding.ts`
  duplicates `bbFlightEnters`'s integrator on purpose — matching the sim beats being "accurate");
  fixed dark HUD scrim in 3D (`.game-root.view-3d`, tracks a LIVE scene via a MutationObserver);
  chase and orbit cameras (drag/wheel on the host; pref `decodesim.camera`, keys `c`/`i`/`o`/`t`
  handled inside the scene while mounted); `GameScene.project` + `Renderer.setScene` so labels and
  auto paths project through the scene camera (wired in `game.ts` by the coordinator, `8f7300b`);
  theme change followed live. Scene chunk 187 KB gz.
- Roadmap: `docs/roadmap.md` now leads with the owner's eight priorities (auth, privacy, contributors,
  tutorial, replay 2D/3D export, 3D builder, cosmetics plan, rewards plan) with branches and order.

## Owner rulings PENDING (raised by this day's measurements; nothing moved)
1. **A lone NECTAR in a flower does not reach the scoring floor by the CAD geometry** (tops out at
   3.597 vs `BB_FLOWER_VOL_Z` floor 3.904): by the 2D model it always scored. 0.30 in, worth 7
   points and an ownership. `flowerScoreZ` is the extraction that measures it. The 2026-09-12
   sorter ruling is what a change would overturn.
2. The CAD lower bore is 3.222, the manual's Fig 9-12 says 2.79 — CAD wins by the standing ruling;
   noted because the manual's sorting story (nectar seats on the middle ring) is not what the CAD
   does.
3. Weigh a real element set: `BB3_ELEMENT_MASS` 0.2 and the nectar ratio 1.6 are APPROX and the
   tip margin depends on them.

## Next: Day 3 (spec §10) — not started
A: perf tuning, heights in coercion, AI policy and tiers (`GameSimModule.bot`), bots in practice and
lobbies. B: Graphics section with presets and Auto detection (`SceneQuality` is ready), HDRI
environments, export compositing (roadmap item 2), gallery 3D stills, the mobile overhead default,
the 2D→3D key. C: wire the predictors into `game.ts`'s reconcile with the Off/Light/Full/Auto
setting (Lane A's API above), the online-room "Loading 3D physics" panel (`GameView` `need3d` is
`!session && …`; the controller latches `physicsPending` meanwhile), leaderboard `physics` badge and
filter, ranked cutover on the alpha server, smoke lanes filled, docs. Then the alpha ship.
DONE at the end of Day 2 (`20d0194`, `634d749`): `sim3d/` loads ONLY through `initPhysics3d()` —
`sim3d/engine.ts` is the light loader, `sim3d/tilt.ts` the light `hiveTiltAngle`/`hiveTrayRefTheta`
seam the scene imports, `sim3d/step3d.ts` a thin gate over `step3dImpl`, and `sim3d/impl.ts` the
heavy re-export the loader `import()`s (predictors included: `physics3dImpl().createFullPredictor`
after init). Main chunk 917 → 907.88 KB gz (seam 904.17 + the loader/tilt), hostWorker 700.84,
physics3d 1123 (the impl rides with the wasm), scene 187.27; bundleaudit baselines re-measured; a
CORE check forbids static imports of heavy sim3d modules outside `sim3d/` (only `engine` and `tilt`).

## Gotchas (new)
- `setAdditionalMassProperties` on a BODY is discarded by the collider mass recompute — set it on
  the desc; `body.mass()` is stale until the first step. A pinned tray SLEEPS and gravity does not
  wake it: `wakeUp()` at breakaway. The tray and its frame overlap at the bearing: separate
  collision groups; the joint limits are the damper.
- `atan2` is (−π, π]: wrap corner rays into [0, 2π) before sorting an annulus, or the ring closes
  across its bore. A convex hull of a C-bracket fills the C (visual-only parts stay visual-only).
- A `Date.now` DEFAULT PARAMETER trips the sim source guard, and should.
- `Client.send` hands out a live view of the world (`slimWorld` spreads one level): a test sink
  must encode/decode as the transport does. `physics: cond ? '3d' : undefined` CREATES the key:
  test "absent" on `JSON.stringify`, not `in`.
- `w.balls.length = 0` does not clear `rob.hopper`; a fired-out robot ends with an EMPTY hopper
  (measure the peak).
- `npm run dev` was broken by a Day 0 spike file importing an uninstalled package (`scripts/
  spike3d-browser/noncompat.*`, deleted). Orphaned `esbuild.exe`/`node.exe` from a dead Vite lock
  `npm ci` (taskkill first). Never `Remove-Item -Recurse` a directory containing a junction.

---

# HANDOFF — 2026-09-18, later (biobuzz-3d: play-test round 2 — true CAD geometry, CAD colours and tape, HUD-safe framing)

**(Previously READ FIRST.)** Branch **`biobuzz-3d`**, worktree `.claude/worktrees/biobuzz-3d`, clean at the merge
commit named in the log; all gates green there (`npm test` 1798 + the BIOBUZZ suite with a 105-check
SIM3D lane). This round was done by OPUS agents with an analysis phase first, at the owner's request;
the audit is `docs/biobuzz/field-cad-audit.md` — read it before touching the field pipeline.

## The owner's five sentences → root cause → fix (all verified)
1. *Balls on a different plane than the hive bottom* — `convert.py` exported tray hulls as WORLD-frame
   bounding boxes at the 30° tilt and the sim read them as tray-LOCAL; the collider floor sat 3.26 in
   above the mesh floor. Now every tray point is un-tilted about the pivot before export
   (`captureTheta` ±30.000° exactly), `hiveTrayRefTheta` is 0, the body rotation is plain
   `hiveTiltAngle`, and a headless check plus a dev-only raycast at GLB load assert the mesh and
   collider floors coincide (Δ ≤ 0.017 in) with a resting element 1.275 in above the plane.
2. *Hive back gone* — `convert.py`'s `other` group (25 parts: ACM logo panel, A-frame top bar, top
   corners, axle holders, feet, AprilTag plates) was never emitted. Unknown parts now go to a `misc`
   node and are printed; `assemble-gltf.mjs` refuses to finish with an unclaimed STL.
3. *Support structures missing* — the fastener regex matched the word "rivet" and dropped the 24
   perimeter rails and 16 corner hinges. `RE_FASTENER` is an explicit list of fastener families.
4. *Flowers wrong colour* — `XCAFDoc_ColorTool` returns nothing on this STEP; the colours live in the
   styled-item chain, now parsed from the STEP text and carried in the glTF material name
   `<finish>#<rrggbb>` (flowers: amber top ring, green HIPS pipes, purple backstop; the hive's
   alliance colour is the RIBS, not the white skins). Runtime overrides only surface params, forces
   `glass` transparent, and forces `tile` to `COLORS.mat` (the CAD tile grey is a placeholder).
5. *Tape wrong* — the GLB's 16 real tape strips were hidden behind procedural `strokeRect` outlines.
   The CAD tape is shown: all strips 1.000 in wide; loading zones taped on three edges (wall edge
   bare), gardens are two side-by-side 1-in strips, alliance areas on the gym floor; every on-tile
   strip stops 0.573 in clear of the wall face (asserted).
Also: the scoreboard/field overlap — `GameController.refreshHudInsets()` measures every
`data-hud-band` element (score bar, breakdown, status, buttons, BIOBUZZ's own score bar) into
`SceneFrame.insets`; both 3D cameras fit the field into the safe rect via `setViewOffset`; the 2D
camera already reserved matching bands (unchanged). A game that fills the `scoreBar` slot must mark
it `data-hud-band` or it gets the old overlapping fit.

## Physics now
Statics are true per-part convex hulls incl. the frame's diagonal legs, uprights, dampers and
crossbar (73 hulls); tray colliders are planar-facet oriented boxes (a hull of an open shell fills
the cell; the perforated Goal Rib gets none). 18-in AND 29-in robots pass under the down cell (CAD
floor 31.98; a 34.98-in robot is stopped); retention 20/20 at 24/48/72 in; the load table matches;
containment 0; two-run hash equal; perf median 0 ms / p95 1 ms. Sizes: `field.glb` 474 KB br,
`field-low.glb` 137 KB, colliders 31 KB; scene chunk 184 KB gz.

## OPEN findings (owner ruling pending; in the coordinator's memory) — now TWO facts, not four
- The real field is **141.35 in inside the walls** (tiles 23.528 in on centre): that one fact is the
  wall delta (±70.67 vs 72) AND the flower delta (~1.54 in vs `BB_FLOWERS`; `BB_FLOWER_D` itself is
  right to 0.09 in). Deciding the sim's field size is a 2D gameplay change — the owner's call.
- `BB_HIVE_BOTTOM_Z` 25.5 vs the CAD's 31.98.
- CLOSED: the up-cell opening matches the manual within 0.13 in (the old delta was the bbox artifact).

## Gotchas (new)
- **Never `Remove-Item -Recurse` a directory that contains a junction** — it follows the junction; an
  agent deleted 12 entries of this worktree's `node_modules` that way and restored them by copy;
  `npm ci` was re-run afterwards.
- A flat CAD face tessellates to its corners only: measure meshes by triangle/raycast, never by
  vertex scan. `MeshoptSimplifier.compactMesh` rewrites indices in place and returns `[remap, n]`.
  The LOW LOD needs `simplifySloppy` (honeycomb plates plateau). The determinism guard greps
  `sim3d/` by TEXT — do not name a trig function even in a comment.
- The scene preview's `scene.render` is what rotates the trays; a frozen frame loop draws them
  level, which looks exactly like the tilt bug.
- The near wall-top corners pin the driver FOV at 95° below ~21:9; the field fills the safe rect
  horizontally and leaves vertical slack at 16:9 (inherent).

---

# HANDOFF — 2026-09-18 (biobuzz-3d: owner's first 3D play-test fixes — hive tilt/spill, visuals, driver POV)

**(Previously READ FIRST.)** Branch **`biobuzz-3d`**, worktree `.claude/worktrees/biobuzz-3d`, clean at the merge
commit named in the log; all gates green there (`npm test` 1798 + 1413, SIM3D lane 83). The owner
reported four things after playing the Day 1 build; all four are fixed and verified:

1. **Hive visually tilted more than the physics.** The GLB tray node is captured at its rest pose, and
   the scene applied the ABSOLUTE tilt on top of it (double tilt). The scene now imports the physics'
   `hiveTiltAngle(world, a)` (`sim3d/hive3d.ts`) and `hiveTrayRefTheta(a)` (`sim3d/bodies.ts`) and
   rotates the tray by `hiveTiltAngle − hiveTrayRefTheta` — 0 at rest, 60° after a tip — the same
   expression `engine.ts`'s `applyHiveTilt` gives the kinematic body. ONE angle authority; never
   re-derive it in a renderer.
2. **Elements spilled out of the up cell.** Root cause in the PHYSICS: the CAD-sized tray collider was
   built from the box captured at the tray's own tilt without re-inclining it, so at rest the up-cell
   floor was FLAT (mouth and divider at the same z) and every landed element rolled out. Fix:
   `obliqueBoxCollider` bakes the capture angle into each collider's fixed local rotation (never a
   per-tick collider rotation — that destabilises the kinematic body); tray colliders use a `Min`
   restitution combine rule (floor/sides 0.15, back 0). Retention 20/20 at 24/48/72 in; the load table
   (3, 7, 3+2 stay; 8, 3+3 tip) now matches the manual in physics; an unchanged kinematic target does
   not wake resting elements. Consequence: the down-cell clearance is now ~22.7–29.8 in (mid 26.2, vs
   the manual's 25.5) so a 29-in robot IS stopped; the up-cell opening top reads 68.85 vs the manual's
   65.6 — a new OPEN finding beside the bottom one (see below).
3. **Rendering too dark, bad shadows, opaque panels, grey flowers.** ACES exposure 1.2, hemisphere
   1.3 + key 1.9, `RoomEnvironment` IBL via PMREM, `VSMShadowMap` (PCFSoft is deprecated in three
   0.186) with a shadow camera fitted to ±92 in, bias −0.0012 / normalBias 0.035 / radius 3; walls and
   station panels are transparent polycarbonate (opacity 0.22, depthWrite off, DoubleSide, renderOrder
   10); room backdrop lightened to gym grey. The GLB now carries one primitive PER PART CLASS with a
   named material (`flower_ring/pipe/base`, `hive_frame_metal`, `tray_metal`, `tray_panel_red/blue`,
   `wall_panel/extrusion`, `tile`, `tape_*`); `renderFieldGlb.ts` assigns PBR by material NAME.
   `convert.py` writes one STL per class per node; `assemble-gltf.mjs` builds the primitives.
   Colliders/measurements stayed byte-identical through the regeneration.
4. **Driver POV missed the near edge.** `fitDriverCamera(alliance, viewAngle, aspect)` in
   `renderCameras.ts` solves pitch analytically and the setback by search so all four corners, both
   wall tops and the hive tops fit with a 4 % margin: 16:9 → eye 72 in, setback 24 in, pitch 37.5°,
   FOV 95° (the near corners pin the FOV at `DRIVER_FOV_MAX`; raising the eye is preferred over
   pulling back). If it reads too wide in play, `DRIVER_EYE_H_*`/`DRIVER_SETBACK_*`/`DRIVER_FOV_MAX`
   are the knobs.

**OPEN findings (owner ruling pending, move nothing; in the coordinator's memory):** flower ring
centres ~1.4 in off `BB_FLOWERS`/`BB_FLOWER_D`; wall inner faces ±70.67 vs 72 (3D walls stay at 72);
hive up-cell opening [47.05, 68.85] vs `BB_HIVE_OPEN_Z` [53.5, 65.6] and down-cell clearance ~26.2
vs 25.5. The measurements check prints them under wide, commented tolerances.

**Gotchas added:** `PCFSoftShadowMap` is gone in three 0.186 (use `VSMShadowMap`); in the app the
`computer` tool's key presses may not reach the game's listeners (dispatch a synthetic
`KeyboardEvent`); `coerceAssists` forces `aimAssist` on, so a synthetic firing test sets
`r.aimAssist = false` on the spawned robot; `releasePollen`/`takeHeld` need a matching `held` ball
in `world.balls`, not just a hopper entry; the "Goal Rib" parts are treated as tray metal and only
the Top/Back/Bottom skins as the alliance panel (a judgement from part names, unverified against a
photo). Day 2 (spec §10) remains next; see the section below for the plan.

**Owner re-test 2026-09-18, after these fixes: STILL WRONG.** Elements sit on a different plane than the
tray floor; the hive's back and some support structures are missing from the GLB; flower colours still
wrong; tape layout and widths incorrect (wall-bounded zones carry no tape on the wall side; tape widths
are documented); the scoreboard overlaps the field. Diagnosis: the collider export used per-part AABB
corners (so the physics tray floor is not the mesh floor and the frame legs were dropped), the GLB
assembly drops/mis-classes structural parts, and colours/tape/tiles were procedural guesses. Round 2 is
running on OPUS agents (owner asked for better agents and more thorough analysis): a CAD audit doc,
true per-part hull colliders in each tray's un-tilted local frame, CAD (XCAF) colours and CAD tape,
and HUD-safe camera framing.

---

# HANDOFF — 2026-09-17, night (biobuzz-3d: Day 1 LANDED — 3D physics, 3D renderer, CAD field)

**(Previously READ FIRST.)** Branch **`biobuzz-3d`**, worktree `.claude/worktrees/biobuzz-3d`. Tree clean at the
merge commit named in the log; every gate green at that commit: `build` · `server:check` · `docaudit`
(CLAUDE.md 26,850 / 27,000 bytes) · `uiaudit` · `bundleaudit` · `npm test` (1798 shared + the
BIOBUZZ suite incl. the SIM3D and RENDER lanes, count in the log). The owner play-tested the first
3D view mid-day, found field parts misplaced and the graphics too plain, and ruled "the field should be
CAD derived" — both are addressed below. Day 2 (spec §10) is next; nothing of it is started.

## What Day 1 delivered (spec `docs/biobuzz/plan-3d.md` §10, all three lanes, merged)

- **Seam** (`941a598`): `Physics` type; `World.biobuzz.physics` + `biobuzzPhysics()`; `step2d`/`step3d`
  dispatch; `RobotState.z/vz`; `RobotSpec.heightIn` (+ the `coerceSpec` carry-across fix in
  `src/sim/spawn.ts`); `GameSettings.practicePhysics` (default `'3d'`); `GameModule.scene` and the
  `GameScene`/`SceneFrame` contract; `GameSimModule.bot?`/`physicsOptions`; `sim3d/engine.ts` loader
  (`initPhysics3d()`, dynamic import of the wasm); `graphics/store.ts` view pref; `worldHash` mixes `r.z`.
- **Lane A, sim** (`src/games/biobuzz/sim3d/`): persistent Rapier 3D world per `World` (WeakMap),
  id-ordered bodies, sync-before/readback-after, robots on the SHARED wrench (parity 1.000 in open
  field), elements with CCD, capture/launch/place/human player reusing the 2D bookkeeping (pure
  extractions: `hiveTimerStep`, `bbHumanPlayerTick`, exported `placeInFlower`/`biobuzzStepMatch`),
  KINEMATIC tray on the shared timer with PHYSICAL spill, `derive.ts` (contents/stacks/tags), containment
  net with `containmentFixes === 0` asserted. SIM3D lane: 34+ checks incl. two-run hash and perf
  (`step3d` 2v2 median ≈ 0 ms, p95 1 ms vs the 1.5 ms gate).
- **Lane B, renderer** (`scene/render*.ts`, lazy chunk 182 KB gz of 250): field, robots generated from
  spec (chamfered chassis, drivetrain wheels, sweepers, mechanisms, team sign), 56 instanced spheres
  with rolling spin, driver-station + overhead cameras, ACES + sRGB, PCF-soft 2048 shadows, procedural
  room. Geometry proven against `drawField.ts` with a side-by-side page (`scripts/scene-preview`, in-page
  named-object check) — four real errors fixed (flower pipes sideways, up-cell 3 in high, wall
  thickness, flower-parked element height); conventions (y direction, heading, alliance walls) were right.
- **Lane C, client**: Practice setup gains **Physics 2D/3D** (`practicePhysics`) and **View 2D/3D**
  (per device); `GameView` awaits `initPhysics3d()` before a 3D practice (fallback to 2D with an
  event-log line); the scene mounts UNDER the 2D canvas (`renderer.ts` `overlayOnly`), created/disposed
  live on view switch; `scripts/bundleaudit.mjs` ratchet (main, hostWorker, physics3d, scene).
- **CAD field** (owner decision): `npm run field-cad` → `public/models/biobuzz/` (`field.glb` 359 KB br,
  `field-low.glb` 242 KB, `field-colliders.json` 23 KB, `field-measurements.json`, README with source,
  sha256 and node names). Scene draws the CAD walls, hive frames, trays and flowers over the procedural
  tile/tape floor (constants fallback on any load failure). Physics: floor and walls analytic at the
  CONSTANTS; tray cells sized from the CAD cell; flower supports CAD trimesh (`FIX_INTERNAL_EDGES`);
  hive-frame legs/uprights EXCLUDED (their hulls are loose AABBs that sealed the drive-under). Twelve
  probe points agree between the CAD and constants engines.
- **Verified in the real app** (Physics 3D): drive, capture (HUD pips), a real parabolic shot, tray tip
  with physical spill, View 2D↔3D mid-match, resize; console clean.

## OPEN findings — owner ruling pending; MOVE NOTHING (also in the coordinator's memory)

CAD vs constants: flower ring centres ~1.4 in off `BB_FLOWERS`/`BB_FLOWER_D` (pipe-centroid proxy;
a bore fit would settle it); wall inner faces ±70.67 vs `BB_HALF_X` 72 (3D walls kept at 72 for
parity with the 2D pipeline and the staging); hive up-cell opening [47.05, 65.65] vs `BB_HIVE_OPEN_Z`
[53.5, 65.6] and down-cell lowest point 31.96 vs `BB_HIVE_BOTTOM_Z` 25.5 (one rigid bar cannot meet
both manual figures; the CAD says 25.5 is not the tray floor). The measurements check prints all of
them under wide, commented tolerances.

## Next: Day 2 (spec §10)

A: dynamic see-saw on a revolute joint + `scripts/hive-calibrate.ts` against the field-guide rows
(`BB3_HIVE_DYNAMIC` flips to true; kinematic stays the fallback); flower TUBES (the CAD rings are
excluded from the collider file because a hull of an annulus fills its hole — export ring trimeshes
from `convert.py`); derived flower stacks by z; G409/G417 tags; Light/Full prediction worlds + Auto
probe. B: reticle, HUD scrim, chase/orbit cameras, interpolation of balls and remotes (the scene
ignores `frame.alpha` today), labels through the scene camera, theme change mid-scene (backdrop read
once). C: `await initPhysics3d()` at server boot, `RoomConfig.physics`, `'bb3d'` cap gate, matchmaking
`3d`, the `physics` migration, `costprobe` scenarios, replay header + re-sim check, LAN lazy init.
Cleanups queued: move `sim3d/` behind `initPhysics3d()` (it is statically imported by `step.ts`, so
the main chunk carries ≈ +4.5 KB gz); tight per-part hulls for the hive frame in `convert.py`; Aim
Assist's landing prediction is an alignment gate under 3D; elements can marginally perturb a robot
(collision groups); the GLB's tiles/tape node is unused (no per-region colour); courtesy note to FIRST
(owner sends). Days 4-14: weigh a real element set (`BB3_ELEMENT_MASS` is APPROX).

## Gotchas (new this day)

- **Sonnet subagents obey the session's cwd over the prompt** when the Edit/Write tools refuse
  cross-worktree paths: two of six lanes worked in the session's own worktree. State the path in every
  command and check `git log` for where a commit landed. Lane worktrees shared ONE `node_modules`
  through junctions (`New-Item -ItemType Junction`; remove with `cmd /c rmdir`, never `rm -rf`).
- **Never route base64 image data through a tool call** (a `toDataURL` write blew the 64k output
  limit twice). Describe screenshots; the browser pane is visible to the owner anyway.
- **The in-app browser pane**: `requestAnimationFrame` only advances when a paint is forced
  (alternate `wait` and `screenshot`); the pane is shared between concurrent agents (always
  `tabs_create` and pass `tabId`); Enter does advance the countdown. Fastest way to drive the game
  from a script: walk the React fiber from the canvas to `GameView`'s third ref (the `GameController`)
  and edit `world` JSON directly — the next tick reconciles the bodies.
- **Rapier 3D**: forces persist across steps (`resetForces`/`resetTorques` per tick); a collider's
  `setTranslation` offset rotates with the BODY, so a per-collider rotation offset needs its
  translation rotated too; `RigidBodyDesc.enabledRotations`; `TriMeshFlags.FIX_INTERNAL_EDGES`.
- **CAD pipeline**: `BRepMesh_IncrementalMesh` caches on the shape (call `BRepTools.Clean_s`
  first); flat STL normals block meshoptimizer's simplifier (drop normals, recompute in the loader);
  GLTFLoader strips `/` from node names (use `userData.name`); `.cmd` shims cannot be `execFileSync`'d
  on Windows (call `node <cli.js>`); the standalone `scene-preview` needed its own `vite.config.ts`
  (`publicDir`) to serve `/models/biobuzz/*`.
- Pre-existing: `uiaudit` `stale-component-index` after a merge — `npm run uiindex`; `smoke.ts` is 1798
  checks, not the 1765 CLAUDE.md still says; a dev-only "Invalid hook call" cascade in `AdsProvider`
  on cold loads (both physics; not investigated).

---

# HANDOFF — 2026-09-17, later (biobuzz-3d: Day 0 physics spike results)

**(Previously READ FIRST.)** Branch **`biobuzz-3d`**, worktree `.claude/worktrees/biobuzz-3d`. Tree is clean
except for the files this session adds/commits: `scripts/spike3d.ts` (new, throwaway CLI),
`scripts/spike3d-browser/` (new, throwaway browser+Electron harness), `docs/biobuzz/spike3d-
results.md` (new), this HANDOFF section, and `package.json`/`package-lock.json` (three new
pinned installs, `src/` and `docs/area/` untouched). `npm ci` ran clean (560 packages). `npm run
docaudit` passes (CLAUDE.md 26,670 / 27,000 bytes, unchanged).

## Installed this session (all pinned `-E`, `@dimforge/rapier2d-compat` untouched at 0.19.3)

`@dimforge/rapier3d-deterministic-compat@0.20.0` (dependencies), `three@0.186.0` +
`@types/three@0.186.0` (devDependencies). `@dimforge/rapier3d-deterministic@0.20.0` (the
non-compat build) was installed once with `--no-save` to probe it and is **not** in
`package.json`/`package-lock.json` — confirmed by grep after the probe.

## Results: the Day 0 spike PASSED the gate

Full numbers, the runtime matrix, and the tray/joint gotcha are in
`docs/biobuzz/spike3d-results.md`. Summary:

- **Hashes equal across two Node runs** (`1971098706` both times) — the mandatory check.
  **Also equal in Chromium (Electron)** — `1971098706` there too, which the gate did not
  require but the plan hoped for. The deterministic build's cross-platform promise held on
  this scene, this machine.
- **Step time far under budget**: 0.020 ms median, 0.046 ms p95 against a ≤ 1.5 ms target — but
  this scene (4 robots, 56 elements, 2 tray bodies, no CAD trimesh, no real gameplay reads) is
  smaller than a real 2v2 room will be, so treat this as a floor, not a prediction; re-run with
  `costprobe`'s `biobuzz3d-*` scenarios once `step3d` is real.
- **Runtime matrix**: `-deterministic-compat` initialises and matches hashes in both Node/tsx
  and browser (Vite dev + Electron). The non-compat `-deterministic` package **fails in both**
  Node/tsx and Vite/browser as published on this Vite version (6.4.3) — it has no `init()` and
  its glue does a bare `import * as wasm from "*.wasm"`, which Vite explicitly rejects without
  `vite-plugin-wasm` and Node's ESM resolver rejects on the extensionless imports before it even
  gets that far. **Stay on compat, as the plan already defaults to** — do not spend Day 1/2 time
  trying to swap packages without adding a wasm plugin, which is a separate decision.
- **Tray/joint gotcha, worth remembering for the real `sim3d/`**: `JointData.limitsEnabled` /
  `.limits` set before `createImpulseJoint` were **not enough** — the tray span past the
  intended ±30° to ~177° before something else stopped it. Fix: call `.setLimits(min, max)` on
  the `ImpulseJoint` **instance** `createImpulseJoint` returns. With that, both trays sat
  exactly at `30.0000448913582°` for the full run (the ballast pins the empty/lightly-loaded
  tray at one stop, matching the intended start condition) — not a calibrated see-saw yet,
  which is `hive-calibrate.ts`'s job on a later day per plan §3.6.
- **Chunk size**: the physics chunk is 2,891,032 B raw / 1,089,268 B gzip-9 (matches the plan's
  ~1.1 MB gzip estimate); the main chunk grows by a noise-level 110 B raw when the loader is
  merely reachable. **Methodology gotcha**: an exported-but-never-referenced function is
  tree-shaken away entirely before Rollup code-splits it — the first attempt (exactly what the
  spec asked for) produced a byte-identical build and no new chunk at all. Had to add one
  module-scope side-effecting reference (`globalThis.__x = theFn`) to keep the declaration alive
  for the measurement, then revert everything (`git checkout --`) and rebuild to confirm the
  tree was clean again (it was — byte-identical to the pre-spike baseline). Worth remembering
  for whoever writes `bundleaudit` (spec §2.5/§7): it needs the same trick, or a real call site,
  to measure an as-yet-unused dynamic import honestly.

## Next: Day 1 (spec §10) — the whole game on 3D physics in the 2D view

Not started. Per the spec: `sim3d/engine.ts` (persistent Rapier world, `initPhysics3d()` behind
a dynamic import), `step3d` (§3.1's nine-step tick), `derive.ts` (§3.5, fills
`hives[a].contents`/`flowers[i].stack` from body positions so `score.ts`/`hud.ts`/the 2D
renderers work unchanged), the real hive frame + tray (§3.6, starting from this spike's geometry
but calibrated against the manual's two published tip rows via `hive-calibrate.ts`), flowers
(§3.7), and the `World.biobuzz.physics: '2d' | '3d'` dispatch in `biobuzzStep`. Also queued at
Day 0 but not run by this session: the CAD pipeline (`scripts/field-cad.mjs` +
`scripts/field-cad/convert.py`) and the courtesy note to FIRST (owner sends it; draft is in the
demoted section below).

## Gotchas (carried forward + new)

- **`JointData`'s `limitsEnabled`/`limits` fields alone did not clamp a revolute joint** in
  `@dimforge/rapier3d-deterministic-compat` 0.20.0 — call `.setLimits(min, max)` on the created
  `ImpulseJoint` instance too. Untested whether this is a compat-wrapper quirk or true of raw
  Rapier 0.35; did not have time to check upstream, and it does not block Day 1 since the
  workaround is one line.
- **An exported function with no call site or reference is dead-code-eliminated**, `import()`
  inside it and all — do not trust "add an unused export, build, measure" for a chunk-size
  check without also keeping the declaration reachable (see above).
- Two Rapier packages coexist on purpose: 2D on `rapier2d-compat` 0.19.3, 3D on
  `rapier3d-deterministic-compat` 0.20.0. Never upgrade the 2D package as a side effect.
- The 3D wasm must load through a **dynamic import** inside `initPhysics3d()`, same reasoning
  as before — this spike's own chunk-size measurement is the number that makes that concrete
  (≈1.09 MB gzip if it ever leaked into a chunk every player loads).
- Other sessions have worktrees here (`main-merge`, `alpha-ui`, `nice-morse-…`, a
  `claude/biobuzz-3d-worktree-…` that is unrelated). Do not `cd` into them; the stash stack is
  shared.
- CLAUDE.md still has headroom (26,670 / 27,000 bytes) — unchanged this session, nothing here
  touched it.

---

# HANDOFF — 2026-09-17, late (biobuzz-3d: Day 0 begun, alpha carries the split, PAUSED before the physics spike)

**(Previously READ FIRST.)** Branch **`biobuzz-3d`**, worktree `.claude/worktrees/biobuzz-3d`, now based on
**`alpha` 7e268dd**. The branch carries `docs/biobuzz/plan-3d.md` (draft 3 with the owner's eleven
decisions, §12) and this HANDOFF. **No code has been written.** The owner asked for cheap
subagents and a pause with a detailed handoff before any step that could use a whole session;
this is that pause.

## Done this session (Day 0, part 1)

- **`efficiency-audit` merged into `alpha`** (1ecc3f2; the owner's Q10). No conflicts: the two
  branches touched disjoint files (`git merge-tree` preview, then the merge). `npm run uiindex`
  regenerated the component index alpha's six UI commits had outdated (7e268dd). **Every gate on
  the merged alpha is green**: `build` · `docaudit` (CLAUDE.md 26,670 / 27,000 bytes) · `uiaudit`
  · `npm test` **1765 + 1321 ALL PASS**. Pushed to `origin/alpha`.
  ⚠️ **Migration 0037 is a SERVER change**: until the alpha app is redeployed (owner's wrapper,
  `fly-deploy.sh --alpha`), its six indexes do not exist in production. Same for main later.
- `biobuzz-3d` merged with the new alpha. HANDOFF conflict resolved by keeping the biobuzz-3d
  sections on top of alpha's log. The spec's status line records the base.
- `npm ci` ran in `.claude/worktrees/pr-alpha` (it has `node_modules` now); **the biobuzz-3d
  worktree still has none**, and neither do the other worktrees.

## PAUSED HERE: the next step is the Day 0 physics spike (spec §10)

Run it as **one sonnet subagent** in the biobuzz-3d worktree. Estimated: 30 to 60 minutes wall,
moderate tokens, no shared-file edits. The plan, in order, with the acceptance it must report:

1. `npm ci` in the worktree (a few minutes; Electron is a dependency).
2. Install, pinned exactly like the 2D physics: `npm i -E @dimforge/rapier3d-deterministic-compat@0.20.0`
   (in `dependencies`: the server needs it) and `npm i -D -E three@0.186.0 @types/three@0.186.0`.
   Nothing imports them yet except the spike. (Registry checked 2026-09-17: all three at those
   versions; the compat package unpacks to 10.3 MB, wasm about 2.05 MB / 767 KB gz.)
3. `scripts/spike3d.ts` (throwaway, run with `tsx`, never in `npm test`): `await import(...)` the
   compat module and `init()`; build a z-up world (gravity `{x:0, y:0, z:-386}` in inches);
   statics: floor, four walls at ±72, two frame base bars (x in [24,25] and [-25,-24], y ±19.4);
   four dynamic 18-in boxes with yaw-only rotation (`setEnabledRotations(false,false,true)`),
   z free; 56 dynamic spheres (40 × r 1.4, 16 × r 1.8, mass 0.2 lb, CCD on); one dynamic tray per
   hive on a revolute joint about x at (±12.75, 0, 43.95) with limits ±30° and a trial ballast
   (or kinematic first if the joint fights); a scripted push on one box for 600 ticks; step 3,600
   ticks at 1/60. Every 60 ticks hash all positions rounded to 1e-4 (FNV-1a, the `worldHash`
   shape). Print: median and p95 ms/step, body count, sleeping count, the final hash.
4. **Run it twice in Node**: the two final hashes must be equal (the deterministic build's whole
   promise). If they differ, stop and report; do not tune.
5. Cross-runtime: run the same spike in Chromium (a throwaway Vite page or the Electron shot
   runner) and compare the final hash with Node's. Report equal / not equal.
6. Try the non-compat `@dimforge/rapier3d-deterministic@0.20.0` with the raw `.wasm` (Vite `?url`
   in browser and worker; `fs.readFileSync` in Node and `tsx`). Record which of the four runtimes
   initialise; if all four, it saves about 300 KB gzipped per §2.5. Do not switch packages in
   this spike; just report.
7. Add a dynamic `import()` of the compat module behind an unused function, `npm run build`, and
   record the emitted chunk sizes (`dist/assets`), then remove it. `bundleaudit` does not exist
   yet; this is the baseline number for it.
8. Commit the spike script and a `docs/biobuzz/spike3d-results.md` (numbers only, the runtime
   matrix, the hash outcome) on `biobuzz-3d`; prepend a HANDOFF section.

**Gate (spec §10 Day 0):** hashes equal across two runs; median step at or under 1.5 ms for the
2v2-equivalent world. **Kill/adjust:** step over 3 ms after enabling sleeping and limiting CCD to
fast bodies → the "freeze far elements" fallback in spec §11; hashes unequal on the deterministic
build → stop, the vendor's promise failed, report before anything else is written.

Also on Day 0, as separate cheap agents once the spike passes: **the CAD pipeline**
(`scripts/field-cad.mjs` + `scripts/field-cad/convert.py`; needs Python and `pip install cadquery`,
a heavy install: run it in its own agent and report the measurements file first, the GLB second),
and the **courtesy note to FIRST** (the owner sends it; draft below).

## Draft note to FIRST (for the owner to send)

> Hello. I run DSIM (playdsim.com), a free driver-practice simulator for FTC teams. For the
> BIOBUZZ season I am building a 3D mode and would like to use the published field CAD (the STEP
> release on ftc-resources) as the source for a simplified, decimated field mesh and collision
> geometry, served from the site and committed to the project's public repository, with
> attribution to FIRST and the manual's CAD credit. Your terms of use grant personal use; could
> you confirm this use is acceptable, or tell me what attribution or limits you would want?
> Thank you for publishing the CAD; it is what makes an accurate simulator possible.

## Gotchas

- **Two Rapier packages coexist**: 2D on `rapier2d-compat` 0.19.3, 3D on
  `rapier3d-deterministic-compat` 0.20.0 (Rapier 0.35: new sleeping, sweep CCD on for fixed
  colliders, changed contact defaults). Never upgrade the 2D package as a side effect.
- The 3D wasm must load through a **dynamic import** inside `initPhysics3d()`; a static import
  anywhere reachable from `src/games/index.ts` or the LAN `hostWorker` puts about 1.1 MB gzipped
  into chunks every player pays for. `bundleaudit` (to write) is the ratchet.
- CLAUDE.md has **330 bytes of headroom**: the spec's two sentences (game table row, the
  client-bundle rule) must fit or the rule moves to `docs/area/biobuzz.md` with a pointer.
- Other sessions have worktrees here (`main-merge`, `alpha-ui`, `nice-morse-…`, a
  `claude/biobuzz-3d-worktree-…` that is a main-merge branch unrelated to this work). Do not
  `cd` into them; the stash stack is shared.
- The spec compares against a comparable third-party 3D sim only generically; keep it that way.
- The CAD-derived field files SHIP by owner decision (Q9); keep the constants fallback complete.

---

# HANDOFF — 2026-09-17, night (biobuzz-3d: draft 3 of the spec, ONE game with a 3D deterministic authority)

**(Previously READ FIRST.)** Branch **`biobuzz-3d`**, a worktree at `.claude/worktrees/biobuzz-3d`, based on
`alpha` **1ecc3f2** (`efficiency-audit` merged into alpha on 2026-09-17, the first Day 0 step). The branch carries only **`docs/biobuzz/plan-3d.md`** and this HANDOFF. No
code has been written. Every gate is alpha's, unchanged.

⚠️ **Drafts 1 and 2 were REJECTED by the owner.** Draft 1 kept the 2D sim authoritative under a
3D view; draft 2 made 3D a separate `biobuzz3d` game. The owner's direction (2026-09-17, verbatim
in spirit): BIOBUZZ stays ONE game; every ranked or record match runs on a 3D deterministic
server; players render in 2D or 3D and the 2D path stays very fast; practice offers the old 2D
physics, 3D physics with a 2D view, or 3D physics with 3D rendering, each with or without AI;
prediction is a player option; graphics have presets and detailed settings; GPU acceleration is
on automatically. Draft 3 is that. Read it, not the commit history.

## What draft 3 decides

- **One game id.** `World.biobuzz.physics: '2d' | '3d'` (absent `'2d'`); `biobuzzStep` dispatches.
  The 2D pipeline is untouched and stays selectable for practice and casual rooms; deleting it
  later is one branch of one function (owner Q11).
- **Rapier 3D, deterministic build** (`@dimforge/rapier3d-deterministic-compat` 0.20) in
  `src/games/biobuzz/sim3d/`, authoritative for ranked, record and matchmade rooms and their
  replays. Persistent server world, JSON readback each tick, spill and flower stacking from
  physics, the manual's tip table kept.
- **Derived lists** (`sim3d/derive.ts`) fill `hives[a].contents` and `flowers[i].stack` from body
  positions, so the shared `score.ts`, HUD, results and the 2D renderers work under both physics.
- **Same wire for 2D and 3D clients** (robots gain `z/vz`; elements already carry them). Two
  renderers over one world: the canvas (no WebGL, no wasm) and a lazy Three.js chunk.
- **Prediction: Off / Light / Full** (Light = drive model + walls, no wasm, the 2D default).
- **Graphics: Auto / Low / Medium / High / Ultra / Custom** over sixteen settings, per device;
  Auto = GPU detection + a 2 s warm-up; software GL → 2D view; `high-performance` power
  preference; hardware acceleration never disabled in the app.
- **Practice**: physics 2D/3D, view 2D/3D, AI opponents off or a tier. Runs upload with
  `physics` + `view` tags. One migration adds `physics` to records/matches/replays/practice_runs
  (default `'2d'`), no season reset (owner rule).
- **CAD import**: `scripts/field-cad.mjs` (STEP → CadQuery → glTF + collider meshes +
  measurements); constants fallback; licence unresolved (ask FIRST, owner Q9).
- **Build plan in days**: Day 0 spike gate (hash equal across runtimes, 2v2 step ≤ 1.5 ms);
  Day 1 the whole game on 3D physics in the 2D view; Day 2 3D rooms online; Day 3 the 3D
  renderer, graphics settings and the alpha ranked cutover. Three lanes.

## Owner decisions (2026-09-17, recorded in §12)

Lobbies/LAN default 3D with a host 2D option · deterministic build everywhere (Day 0 speed gate) ·
robots yaw-only now, pitch/roll designed for later (3.3) · **dynamic see-saw calibrated to the
field-guide rows** (3.6; kinematic fallback) · realism then rulebook for opponent shots · prediction
Auto-calibrated (5) · ranked cutover on alpha Day 3, production when the owner says · Force-GPU
toggle offered, off by default, auto-cleared after a GPU crash · **ship the CAD-derived field files**
(owner accepts the licence risk; courtesy note to FIRST) · merge `efficiency-audit` first · **the 2D
physics is a permanent light practice option, never deleted**.

## Next steps

1. Merge `efficiency-audit` into `alpha` (a real merge, +14/+6), rebase `biobuzz-3d`.
2. Day 0 per §10: deterministic 3D package spike (hash across runtimes, 2v2 step ≤ 1.5 ms),
   CAD pipeline run, courtesy note to FIRST.
3. Weigh a real element set when possible; mass and the nectar ratio are APPROX until then.

## Gotchas

- The base now carries the CLAUDE.md split: `docs/area/` guides, `npm run docaudit`, the sharded
  `npm test` and migration 0037. CLAUDE.md is at 26,670 of its 27,000-byte budget, so the spec's
  two sentences must fit or move to a guide. Spec line refs are as of `efficiency-audit` e0ce598.
- The spec compares against a comparable third-party 3D sim only generically; keep it that way.
- The CAD-derived field files SHIP by owner decision (Q9); keep the constants fallback complete so they can be pulled in one commit.
- `V` is Chain Reaction's `fling`; the view-cycle key is `t`.
- Under 3D physics, `state.kind === 'element'` means "a body inside a structure", not "not
  solved": the 2D readers only read the tag; do not port the 2D assumption into `sim3d/`.

---

# HANDOFF — 2026-09-17 (match replays are private, and one player cannot publish a match)

**(Previously READ FIRST.)** Branch **`feat/replay-privacy`**, PR **#74**, merged into `alpha` and **NOT
DEPLOYED**. Gates on the merge: `npm test` ALL PASS ×2 (1798 + 1321) · `dbtest` ALL PASS ·
`build` · `server:check` · `docaudit` · `uiaudit` (at baseline) · `contrast`.

⚠️ **THE DB MIGRATION (0038) IS A SERVER CHANGE AND NEEDS A DEPLOY**, and so does the gate
itself — until Fly is deployed `/api/replay/<id>` is still open to anyone. **`0037` (the FK and
feed indexes) is still undeployed too**, so one Fly deploy now owes two migrations. The account
toggle and the viewer's refusal copy need **Vercel**, which is owner-only.

## What landed

`/api/replay/<id>` served any replay to anyone, and the public profile hands out the ids — so
every leaderboard row was one click from a stranger's full-fidelity match replay, which is not
a score, it is the game plan. The default is now private.

- **`replayAccess(replayId, viewerId)`** (repo.ts) is the ONE decision, called BEFORE
  `getReplay` so a refused viewer costs no jsonb. Per owner: **versus** = everyone who played,
  either alliance, then unanimous opt-in; **record** = public (it is the board's proof);
  **practice** = owner; **LAN** = the host, plus staff. Orphans are DENIED, a missing replay is
  a 404 rather than a refusal, and staff are exempt because `AdminReports` moderates through
  this route.
- **`profiles.replays_public`** (migration **0038**) + `GET/POST /api/user/privacy` + a Privacy
  panel in Account. It could not live in `profiles.settings` — that blob is opaque to the
  server, so a bit in it is enforced by asking the client.
- **The history LIST stays public**; `userMatchHistory` nulls `replayId` for a reader who may
  not watch, so the Watch button is absent rather than present and answering 403.
- ⚠️ **Unanimity is over the ROSTER, not the surviving rows.** `match_participants` stores only
  AUTHED players and cascades on deletion, so the stored count is checked against
  `matches.mode` (2 / 4). An anonymous or departed player is a permanent no.
- `/api/replay/<id>` and both history routes are **optionally authed** now (`viewerId(req)`
  server-side, `maybeAuthedJson` client-side).

## Gotchas this cost

- **`verifyAuthToken(undefined)` LOGS**, so the optional-auth helper short-circuits on a
  missing header instead of letting it answer null — these are the routes a signed-out visitor
  hits.
- **`syncStaffRoles(owner, admins)` keeps its FIRST argument as owner** whatever the list says,
  so the demote test has to name a different owner to demote anybody.
- **`saveLanRun` takes positional args** and builds its own replay row; `savePracticeRun`
  returns a row, not an id; the record writer is `submitRecord`, not `saveRecordRun`.
- Alpha took **0037** mid-branch, so the migration renumbered to 0038 — and CLAUDE.md was split
  while this was open, so the write-up is in **`docs/area/accounts.md`**. CLAUDE.md is at 26.7k
  of a 27k budget `docaudit` enforces; new rules go in the area guide for the path they govern.

## Next steps

1. **Deploy Fly** (`./scripts/fly-deploy.sh`, never a bare `flyctl deploy`) — it owes 0037 and
   0038. Then Vercel for the toggle and the refusal copy.
2. **Not exercised end to end.** The Privacy panel needs a signed-in account against a live
   server and DB; it is typechecked, audited and unit-tested, not clicked.
3. One flake seen once and not reproduced: the BIOBUZZ lane reported `1 FAILURES of 1321` on a
   run that shared the machine with a build and a dbtest (lanes 37.3s against 20.7s idle), then
   passed four times in a row. Not identified — if it recurs, capture the FAIL line.

# HANDOFF — 2026-09-16, later (efficiency audit: the test loop, the indexes, the render path)

**READ FIRST.** Branch **`efficiency-audit`** off `alpha`, 12 commits, **not merged and not
deployed**. Every gate green: `npm test` ALL PASS ×2 (1765 + 1321) · `test:mm` 186 · `dbtest`
ALL PASS · `build` · `server:check` · `uiaudit` · `contrast` · **`docaudit`** (new).

⚠️ **The DB migration (0037) is a SERVER change and needs a deploy** to take effect, like
0035/0036 before it. Until then the indexes do not exist in production.

## What landed

| # | commit | what |
|---|---|---|
| 1 | `test:` | **`npm test` 237s → 39s.** `smoke.ts` sharded across 12 processes by `scripts/smokeshard.mjs`. |
| 2 | `db:` | migration **0037**: six missing indexes, two dead ones dropped, and the two RULES asserted in `dbtest`. |
| 3 | `render:` | held-artifact grouping, the per-ball highlight hoisted, `useCoarsePointer`. |
| 4 | `docs:` | HANDOFF archived, and the check counts in CLAUDE.md corrected. |
| 5 | `server:` | LAN roster moderation parallelised, `/api/stats` memoized. |
| 6 | `docs:` | HANDOFF entry for the session. |
| 7 | `docs:` | search with `rg`, not `grep -r` — `.claude/worktrees/` is 810 MB of repo copies. |
| 8 | `docs:` | **CLAUDE.md split: 43.7k tokens → 6.6k**, plus `docaudit` and the area hook. |

### 0. CLAUDE.md is now a routed core, and the routing is enforced

It was 2,206 lines (~43,700 tokens) and it is loaded into EVERY session, so a session fixing a
button paid in full for DECODE's gate-lever geometry and the Ko-fi webhook policy. It is now
~6,600 tokens: what is true everywhere, plus a routing table to ten guides in `docs/area/`
read on demand.

**Nothing was rewritten.** 2,035 of the original 2,042 non-trivial lines are byte-identical in
their new homes; the 7 that differ are the reworded opening blockquote and five
cross-references that pointed at sections now in another file. Verified by a line-level diff
against git HEAD, not by assertion.

⚠️ **The risk here is not size, it is SILENCE** — a rule in a guide nobody opens has been
deleted, not relocated. Two defences:
- **`npm run docaudit`** — every guide routed, every link resolving, every `governs:` glob
  still matching real files (catches a RENAME, which otherwise leaves a guide governing
  nothing), every source file owned, and CLAUDE.md inside a token budget that is a **RATCHET**
  (only ever lowered, so the file cannot grow back). All five rules were tested by breaking
  them. Writing it found a `governs:` line already wrong and sixteen unowned top-level modules.
- **`scripts/areahook.mjs`** — a PostToolUse hook naming the guide for the file just edited,
  once per area per session. Reminder, never a block; always exit 0.

**If you add a rule to CLAUDE.md, the test is whether a session working somewhere else needs
it.** If not, it belongs in the guide for the path it governs.

### 1. The test loop was the single biggest thing wrong with this repo to work in

`scripts/smoke.ts` was **220s** of the 237s `npm test` took, and CLAUDE.md called it "fast".
Everything else combined is 12.5s (`tsc` 6.3 · `vite build` 3.8 · `server:check` 2.3 ·
`uiaudit` 0.1 · `contrast` 0.07). The memory note "don't run full npm test" is what that had
already cost.

It turned out to be trivially parallel. `smoke.ts`'s top level is 360 statements, **257 of them
bare blocks** — closed scopes declaring nothing anyone else sees — over a 103-statement
preamble whose only mutable is `failures`, which every block writes and none reads.
`smokeshard.mjs` parses it with the TypeScript parser, copies the preamble verbatim into each
shard, deals the blocks out, and bin-packs them longest-first from a measured cost table keyed
by block CONTENT. **smoke.ts is untouched.**

Proved rather than assumed: serial and sharded produce **the same 1765 check names with the
same outcomes**. The only three textual differences are a UUID and two world hashes that
`Room` seeds from `Date.now() ^ Math.random()` (room.ts:1281) — different on every run either
way.

⚠️ **The guard matters more than the speed.** A shard runner that loses a block still prints
ALL PASS. So: the assignment is asserted to be a partition (set equality, not a count), a shard
that dies without a verdict fails the run, and an **independence guard** refuses to shard at
all if smoke.ts grows a top-level `let` or a stray side effect. `npm run test:serial` is the
way out; `npm run test:calibrate` re-measures.

**~22s is the floor at any width** — one block costs 22.4s alone and a block cannot be split.
4 shards 54.6s · 8 28.6s · 12 23.4s · 16 24.5s.

### 2. The indexes, and the rule that found one the sweep had missed

`records.replay_id` and `matches.replay_id` are `references replays(id) on delete set null`
and **neither was indexed since 0001**, so every replay delete scanned both tables in full —
and the practice/LAN prunes that delete replays run on **every upload**. Same for
`records.partner_id` and `kofi_payments.claimed_by`. The pattern was already understood here:
`practice_replay_idx` (0032) and `lan_replay_idx` (0033) exist for exactly this reason. The two
oldest tables missed out.

Also: `recentMatches` unions all of `matches` and all of `records` and orders by `created_at`
with nothing indexed on it; `challengeParty` filters `room_invites` on an unindexed `room`,
and that gates every rated friend match. Dropped two indexes that can never be chosen
(`user_activity(user_id)` and `friend_requests(from_user_id)`, each already a prefix of a
constraint's index).

**`dbtest` now asserts the RULES, not the columns** — every FK indexed, no index a dead prefix
of another — against the live schema after every migration. That is not decoration: **the FK
rule found a fifth unindexed key on its first run** (`score_reports.match_id`) that the manual
sweep had missed.

### 3. Render, server, docs

`renderer.ts` filtered `world.balls` for held artifacts **inside** the per-robot loop —
O(robots × balls) per frame, ~173,000 predicate calls/s in a 2v2 CR room at 144 Hz. Grouped
once. `drawBalls` rebuilt an `rgb(...)` string per artifact per frame for one of two possible
colours. `GameView` called `matchMedia('(pointer: coarse)')` five times per render at the 10 Hz
poll — and reading a media query during render is **not subscribing to it**, so a 2-in-1 that
changed pointer kept whichever controls it booted with. `useCoarsePointer` fixes both; verified
live in both layouts.

Server: the LAN roster moderated names **one at a time** against a hosted API with a 4s timeout
— up to 16 sequential calls per upload. `/api/stats` is public and ran three unbounded
aggregates per homepage load; memoized 60s, with dbtest asserting it is a memo and not a
freeze.

Docs: HANDOFF.md was **5,888 lines (~97k tokens)** with "read at session start" beside it. The
29 oldest sections moved **unedited** to `docs/handoff-archive.md`; all 37 survive. CLAUDE.md
said smoke was "~1240 checks" (1765), `test:mm` 36 (186), `dbtest` ~61 and elsewhere 36 (232).

## Next steps

1. **Merge to `alpha`**, then promote + deploy from a `main` worktree — 0037 applies at boot.
2. `npm run test:calibrate` after adding or deleting an expensive block.

## Found and NOT fixed — ranked, all verified, none started

1. **The client bundle is 2.54 MB and 1.57 MB of it is base64-inlined WASM** (62%), duplicated
   again in `hostWorker` (1.89 MB). `@dimforge/rapier2d-compat` inlines its wasm, and base64
   costs 33% over the raw binary. The non-compat `@dimforge/rapier2d` loads a separate,
   cacheable `.wasm`. ⚠️ **But Rapier is pinned EXACTLY on purpose** — a different physics
   build changes `step()` with no version bump, making every replay stamp a lie — so this is a
   SIM_VERSION-bump decision, not a dependency swap. And note `main.tsx` awaits `initPhysics()`
   before the first render, so code-splitting alone buys nothing without reordering boot.
2. ~~`persistVersusMatch` is 16 sequential round trips~~ — **FIXED.** Batched to about four.
3. ~~`getStanding` is a write transaction on a read path~~ — **FIXED** with a read-only fast
   path. Note the SURROUNDING item is still open: `chargeStanding` is still ~7 round trips per
   offender and still serialized ACROSS offenders in `persist.ts:220`.
4. **`broadcastSnapshot` stringifies every ball individually just to detect change** (30×/s per
   room, 300 balls in CR), then stringifies the changed ones again into the body. A dirty
   epoch stamped by the sim would remove the first pass. The broadcast itself is already well
   optimized — this is the remaining hot allocation.
5. **`matchStart` and `strategyStart` are encoded per recipient** though they vary only in
   `yourRobotId` — the shared-prefix trick `broadcastSnapshot` already uses.
6. **`MobileControls` re-renders at touch-event rate** (60–120 Hz while a thumb is on a stick,
   on the device class with the least headroom) and has no `memo`/`useCallback` anywhere:
   every render rebuilds the button array and 4 fresh closures per button.
7. **`useCountUp` drives React state at rAF** for ~1s after every match, three concurrently,
   each re-render rebuilding the whole `sections` structure in `Results`.
8. **`GameView.tsx:259` builds a full `HudSnapshot` 4×/s to read two booleans**, and the timer
   is created even in solo where its body can never do anything.
9. **`App.tsx:740` creates a 400ms interval outside an effect** — the only timer in `src/ui/`
   or `src/net/` with no unmount cleanup. Self-limiting at 30s.
10. **`profileEnsured` (repo.ts:288) is never pruned** — bounded only by Fly's scale-to-zero
    restarting the process, which is not a bound on a machine that stays warm.
11. **Correlated per-row subqueries in both moderation queues** (repo.ts:2138, :2421); the
    second aggregates the entire `player_reports` table with no `WHERE` at all.
12. **47 exports with zero importers and zero string references**, incl. `simGameOf`,
    `adminRefundPayment` (a whole HTTP client call), `useAnyoneQueued` (a whole React hook),
    and the `listPresets`/`savePreset`/`deletePreset` trio with no route. `chain/config.ts:633`
    says outright "Nothing reads these at runtime any more".
13. **Large duplication between `chain/` and `biobuzz/`**: `parts.ts` (120 identical lines, doc
    comments included), `mounts.ts` (9 same-named functions), `drawRobot.ts`,
    `RobotPreview.tsx`. Three near-identical start editors; `specKey` defined 4 times with 4
    different field sets.
14. ⚠️ **Four m:ss formatters, and two disagree** — `replayOverlay.ts:67` uses `Math.ceil`,
    `ReplayView.tsx:52` uses `Math.round`. The clock burned into an exported video and the one
    in the viewer header can therefore read a second apart for the same frame. Smallest real
    bug in this list.
15. **`ago()` is byte-identical in three files** (`AdminLive`, `AdminReports`, `StandingCard`)
    while `src/ui/fmtDate.ts` exists and is the obvious owner.
16. **`scripts/zz-accept.ts` is superseded by `zz-accept-clean.ts`** by its own header — the
    original measures against artifacts it thinks it removed. Both say "throwaway".
    `zz-mm-quality.ts:4` references a `zz-mm-marginal.ts` that does not exist.

### The game engine: measured, and deliberately left alone

Profiled per game and then actually tried an optimization, which is how I know not to ship
one. Inside `step()`: Rapier's rebuild-per-tick is ~23% of CPU, `separateParticles` (CR only)
7.6%, the possession/control penalty passes ~4.4%, everything else diffuse.

The 23% is the stateless Rapier world, which is a deliberate architecture choice — rebuilt
every tick so reconcile and determinism hold — so it is not available without the port CLAUDE.md
already has on the roadmap.

`separateParticles` rebuilds its whole spatial grid (a `Map` plus one array per occupied cell)
twice a tick for 300 particles, so pooling the memory looked free. **It was bit-identical and
21% SLOWER** — 0.222 → 0.267 ms/tick for CR, three runs each, low variance, verified
bit-identical by `worldHash` over 3,000 ticks across all three games before the timing was
even taken. V8's nursery beats manual pooling for short-lived small objects. Reverted.

The conclusion to carry forward: **the sim has no cheap safe win left.** Its allocation
pattern is not the bottleneck, and the thing that is, is deliberate.

⚠️ **Snapshot change detection was measured and deliberately NOT changed.** The per-ball
`JSON.stringify` in `broadcastSnapshot` is 45% of a Chain Reaction snapshot's cost (0.093 of
0.208 ms), but that is only ~0.28% of a core per room, and the alternative — a hand-written
field comparator — fails by MISSING a change, which is a silent client desync. The payoff does
not cover that failure mode.

Measured for reference, per-tick `step()` cost (32-thread box, 2v2): DECODE 0.50ms
(cores/room 0.030) · CR 0.28ms (0.017) · BIOBUZZ 0.37ms (0.022). Inside `step`, Rapier's
rebuild-per-tick is ~23% of CPU, `separateParticles` (CR only) 7.6%, the possession/control
penalty passes ~4.4%.

---

# HANDOFF — 2026-09-16 (alpha: the admin panel merged, five PRs merged, main backported)

**(Superseded as READ FIRST by the efficiency-audit session above; still the state of
`alpha` itself, which that branch has not been merged into.)** `alpha` and `main` are both
green and both pushed. **NOTHING IS DEPLOYED.**

`npm test` prints **ALL PASS twice** for the first time in a while — PR #69 fixed the stale
lan-gate asserts that had been failing on a clean tree since LAN went on in production on
2026-09-13, which (because the suites chain with `&&`) meant the BIOBUZZ suite had not been
running at all.

## Merged into alpha

| PR | what |
|---|---|
| #69 | the lan-gate asserts follow the config that moved under them — **this is what unblocked the second suite** |
| #58 | `stageBiobuzz` is idempotent: the hopper is cleared with the ball array, so a re-stage stops refusing its own preloads |
| #61 | a lossy LAN guest's snapshot delta is keyed to its **ACK**, not the last broadcast — **server** |
| #68 | a rematch cannot field a seat nobody is in; the format comes from the room, not a head count — **server** |
| #67 | a backgrounded ranked queue cannot lose the match it was given — client only |

Plus the **admin-panel** batch (its own section below).

Gates on alpha: `npm test` ALL PASS ×2 (BIOBUZZ 1317) · `test:mm` 186 · `dbtest` ALL PASS ·
`build` · `server:check` · `uiaudit` · `contrast`.

## main was CHERRY-PICKED, not promoted

`main` took those six changes only and is still **~28 commits behind alpha** (settle-based
finalize, the standing repricing, room recycle, the LAN tab host, the BIOBUZZ hive work). Same
gates, all green there (BIOBUZZ 1299 — fewer checks because main lacks the alpha-only features
those checks cover).

⚠️ **`src/standing.ts` conflicted and the two branches now price behaviour DIFFERENTLY ON
PURPOSE.** main keeps `afk: 12` / `leave: 15` / `card: 20`; alpha has the repricing (8 / 8,
yellow 5 with `RED_CARD_MULT` for red). Only the new `adjustment` kind was backported. **On the
next promotion this file will conflict again and ALPHA should win** — the repricing is the later
decision.

## Next steps

1. **Deploy the game server** from a **main** worktree (`./scripts/fly-deploy.sh`, never a bare
   `flyctl deploy`). Migrations 0035/0036 apply at boot; until then the admin panel's two new
   endpoints 404 and #61/#68 are inert.
2. Vercel picks up the client half on push (#67, the replay penalties).
3. Still outstanding: clear every infraction on `018fdc59-4e80-4a16-908c-682be86bfee8` —
   after the deploy, one press of CLEAR ALL INFRACTIONS in Admin → Moderation.
4. Neither #61's LAN path nor #68's rematch gate has been exercised against a live server; both
   are covered by driven smoke checks only.

---

# HANDOFF — 2026-09-15 (the admin-panel batch: misscore replays, score editing, replay penalties, standing edits)

**(MERGED into `alpha` and cherry-picked onto `main` on 2026-09-16 — see the section above.
Still NOT deployed.)** It is a SERVER change AND a MIGRATION change — two new migrations
(0035, 0036) that apply at game-server boot, so nothing here works until the Fly server is
redeployed.

Build green: `npm run build`, `npm run server:check`, `npm run contrast`, `npm run uiaudit`,
`npm run dbtest` (ALL PASS, +29 checks). `scripts/smoke.ts` passes +23 new checks.

⚠️ ~~**`npm test` is RED on alpha already, and not from this work.**~~ **FIXED by PR #69**,
merged 2026-09-16. Left below because the reasoning is why it mattered. Two stale checks —
`lan gate: alpha opens it; production does not mention it at all` and `lan gate: and
production still opens neither door` — assert that production's `fly.toml` mentions neither
`LAN_UPLOADS` nor `LAN_SIGNALLING`. Both were deliberately turned ON in production on
2026-09-13 (see that section below), and nobody updated the checks. They fail on `alpha` with
no changes at all. **The consequence is the one CLAUDE.md warns about: while the first suite
is red the BIOBUZZ suite never runs.** Either update the two checks to the fleet as deployed
or revert the config; it is a policy call, not a bug fix, so it was left alone here.

## What landed

1. **The misscore queue's WATCH button 404'd on every claim.** `listScoreReports` returned a
   MATCH id and the button passed it to `/api/replay/<id>`, which serves `replays.id`. It now
   carries `replayId`, joined through `matches.replay_id`; a claim with no stored match says
   "no replay" rather than offering a dead button. `onWatchReplay` is
   `(replayId, matchId?) => void` everywhere (`WatchReplay` in `AdminReports.tsx`).
2. **Score correction** — `GET/POST /api/admin/match`, `correctMatchScore`, migration
   **0035** (`match_score_corrections`). `won` is re-derived; **ratings are deliberately not**
   (Glicko-2 is sequential). The editor is `ScoreEditor` in `src/ui/ReplayRail.tsx`, offered
   only when `ReplayView` gets an `adminMatchId`, which only ever comes from the admin panel
   via in-memory state in `App.tsx` — never from the URL, which is shareable.
3. **Penalties on every replay, for everyone.** `src/sim/penaltyLog.ts` is the ONE place a
   sanction line is written and read (`awardFoul`/`awardCard` and BIOBUZZ's tariff wrapper
   both format through it); `ReplayPlayer.log` stamps each line with its tick and phase clock.
   The viewer has an always-on summary row and a seekable timeline in the rail. A solo record
   run shows one chip and reads its fouls as a deduction.
4. **Standing editing** — `GET/POST /api/admin/standing`, `adminEditStanding`, migration
   **0036** (`voided_at`/`voided_by`/`admin_id`/`note` on `standing_events`). A pardon VOIDS:
   `recentStandingCount` filters voided rows so escalation forgets them, and the row stays on
   the record. `src/standing.ts` gained an `adjustment` kind with a SIGNED cost — render every
   ledger row through `standingDelta`, never a hard-coded minus.

## Next steps

- **Nothing is deployed.** Merge to `alpha`, then promote and deploy the Fly server from a
  **main** worktree (see the 2026-09-13 note). The migrations run at boot.
- **Not yet exercised against a live server**: the two new admin endpoints have unit coverage
  in `dbtest` and typecheck against the server, but no request has been made to a running
  instance. First deploy, then open `/admin` → Moderation → search a player → STANDING.
- The owner asked to clear every infraction on `018fdc59-4e80-4a16-908c-682be86bfee8`. **Not
  done** — production DB and production HTTP reads are blocked in this environment, and the
  admin endpoint that would do it is on this undeployed branch. Once deployed it is one press
  of CLEAR ALL INFRACTIONS on that uuid.

## Gotchas found on the way

- **`ghost` + `primary` on one `.ds-btn` makes the label white on the page's own surface.**
  `.ds-btn.ghost` is declared after `.ds-btn.primary`, so it wins on `background: none` while
  primary's `color: var(--ds-accent-ink)` survives. It reads as a missing control. There is a
  `uiaudit` rule for it now at baseline 0.
- A replay's penalty list is built from `world.events`, so **the foul strings are now parsed,
  not just displayed** — changing one is still a server change, and now also breaks a reader.
  `npm test` round-trips the formatter against the parser.
- The default robot's start anchor faces its own goal: a full-throttle `driveX: 1` holds it
  flush against the goal for the whole match. Crossing the field from anchor 0 is `driveX: -1`.
  Cost several throwaway scenes before it was noticed; worth knowing when writing any headless
  scene that needs the robot to actually go somewhere.

---

# HANDOFF — 2026-09-14, later (account standing: behaviour charges WIRED, repriced — alpha only)

**(superseded as READ FIRST by the 2026-09-15 section above; still current for its own subject.)** On `alpha`, NOT deployed, NOT on `main`. It is a SERVER change: it does nothing
until the Fly game server is redeployed (from a main worktree — see below).

- **`persistBehaviour` was never wired into production rooms** (`server/index.ts` passed 7 of
  `Room`'s 8 args; `docs/multiplayer-architecture.md` §17.1 had flagged it). So in production
  the clean-match heal (+2), AFK, leave and card standing charges had NEVER fired — only dodges
  did. Now wired. ⚠️ Deploying it turns ALL of those on at once, for the first time against real
  matches.
- **Repriced (owner):** AFK 8 (was 12), leave 8 (was 15), yellow card 5 (was 20), red card 15
  (was a flat 40 override). A red is now `severity: RED_CARD_MULT` (3) through the ladder, so it
  rides the repeat multiplier like every other kind (a 2nd red in the week costs 23, a 2nd
  yellow 8). Cooldown/rating ladders unchanged.
- **Leaving a 1v1 is not charged** (`chargedForParticipation`, `src/standing.ts`); leaving a 2v2
  is. AFK is charged in both. An excused 1v1 leaver is NOT credited clean either. The 1v1 match
  is still rated, so the leaver still takes the loss.
- Verified: `server:check` and client `tsc` clean; the changed standing checks run green through
  the real functions in a scratch script. Full `npm test` NOT run (owner preference); the smoke
  checks in `scripts/smoke.ts` were updated to the new values.

---

# HANDOFF — 2026-09-14 (branch `discord-activity`, PR #41 into alpha): the activity plays all three seasons

**READ FIRST if you are on `discord-activity`.** This branch is `origin/alpha` @ `7000931` merged in
(one conflict, `server/room.ts`: the Discord `lobbySummary` and upstream's `canSeat` both landed at
the same spot — both kept) plus the fixes below. Everything in the section after this one is
upstream's state and still true here.

- **The instance id survives a reload** (`src/net/discordActivity.ts` `discordInstanceId`). It arrives
  only on the launch URL, the router canonicalizes that URL to a bare path on first load, and every
  navigation pushes a bare path — so ANY reload inside the activity (Vite's reconnect reload after a
  dev-server restart, the REFRESH button, a manual refresh) came back with no `instance_id`, the home
  page lost its Join Discord Lobby button and the reloaded participant could no longer see the party.
  Reported as "others who join my activity can't see the join discord button". Remembered per TAB in
  sessionStorage; the URL wins whenever it carries one, so a fresh launch always overwrites.
- **A room has one season and the creator picks it** (`DiscordLobbyList.tsx`, `App.tsx`
  `enterDiscordRoom`). Rooms were pinned to `versus/decode`, so the activity could not play Chain
  Reaction or BIOBUZZ — and the Lobby draws its start editor and build summary from the PLAYER's
  season, so a BIOBUZZ player joining a pinned room saw a BIOBUZZ lobby for a DECODE match. Now the
  browser reports each room's season (the server's `lobbySummary` already carried `game`), an unopened
  main lobby / a separate lobby takes the season picked on the home page, and `enterDiscordRoom`
  `selectGame`s BEFORE queueing the auto-join — the same rule an accepted invite follows, because the
  server refuses a config-mismatched joiner. Rows now show the season and pass the code UPPERCASE so the
  Lobby heading matches the host's.
- **E2E-tested in a browser on 2026-09-13**, emulating the activity with `?instance_id=` in two tabs of
  one dev server behind the quick tunnel: a reload to a bare path keeps the button; BIOBUZZ main lobby
  created by a BIOBUZZ tab and joined by a tab configured for DECODE (button read `JOIN MAIN LOBBY ·
  BIOBUZZ`, create read `DECODE`) → both in a BIOBUZZ match, driving works; a separate Chain Reaction
  lobby listed as `Chain Reaction 1/4` in a BIOBUZZ-configured tab → joined → CR match; DECODE main
  lobby joined from a Chain-configured tab → DECODE match. No console errors.
- **Not emulable here:** the real `.discordsays.com` host (`/.proxy/gs`, the Embedded App SDK
  participants/avatars). Unchanged by this branch.
- **Tests:** 12 new `discord activity:` checks in `scripts/smoke.ts` (4 behavioural on
  `discordInstanceId` with a fake `window`, 8 structural on the season plumbing). The two upstream
  `lan gate:` checks were updated to the owner's 2026-09-13 decision (LAN on in production — both
  flags in `fly.toml`); they were red on alpha itself. `npm run uiaudit` is back at its baseline (the
  branch's `.dj-more` 11.5px and two off-grid paddings were the slips). Green: `npm test` (both
  suites), `test:mm`, `server:check`, `build`, `uiaudit`, `contrast`.
- **Known edge, deliberately left:** two people pressing JOIN MAIN LOBBY in the same 3 s poll window
  with different seasons — the second is refused with the server's "different game mode" error and
  has to go back and press it again (the browser then shows the room's season).
- **Not committed:** `package-lock.json` drift (`npm install` adds the `dsim-lan` bin that upstream's
  lockfile lacks) — upstream's to regenerate.

---

# HANDOFF — 2026-09-14, early (settle-based finalize LIVE, PR 65 landed, all night fixes shipped)

**What production is running.** Fly release **v111** = `main` @ `b09f12e`, deployed
from a main WORKTREE (never this alpha tree — `fly-deploy.sh` builds whatever tree it runs in).
Everything below the line is on BOTH `main` and `alpha`.

- **LIVE: a match is finalized when the field comes to rest, and the score is shown only then**
  (`34bf3a2` main / `6326a6b` alpha). New `src/sim/settle.ts`: `settleStep` finalizes once the
  game's `GameSimModule.settled` has held for `MATCH_SETTLE_HOLD_S` 0.5 s, capped at
  `MATCH_SETTLE_MAX_S` **10 s — the owner's absolute maximum, do not raise it**. DECODE
  (`decodeSettled`): nothing in flight, nothing pending or moving on a rail, ground/basin
  artifacts and robots at rest. CR (`chainSettled`): no non-staged particle in flight, ground
  particles and robots at rest. BIOBUZZ (`bbSettled`, `src/games/biobuzz/settle.ts`): nothing in
  flight, no hive swinging or loaded past its tip, ground elements and robots at rest. The server
  (`room.ts` `stepOnce`) and solo practice (`game.ts`) share the clock, in ticks.
  `MATCH_SETTLE_S` / `MATCH_RESULT_REVEAL_MS` are DELETED. Client: the results screen reveals only
  on `HudSnapshot.resultFinal` (online = the server's `matchResult` arrived; practice = its own
  settle) and shows the SERVER's totals; the live HUD, replay viewer and burned-in video say
  MATCH OVER until then and FINAL only on the finalized score; `resultLost` says so if the result
  never comes. `maxMatchTicks` carries the 10 s cap. Measured: an idle DECODE or CR run finalizes
  on the 0.5 s hold (no jitter); a rolling artifact held it to 116 ticks.
  ⚠️ **Known to bind:** a BIOBUZZ tip that sets off a SECOND tip can outlast 10 s; PR 65's rule
  (below) still pays a swing the cap cuts off.
- **LIVE: PR 65, a BIOBUZZ tip caught by the buzzer scores and its load is not deducted**
  (`7d0331c` main / `04ce456` alpha; its check moved onto the settle clock in `b09f12e` /
  `41865e7`). Landed as CLEAN commits and the PR CLOSED, not merged: its own commits were
  authored `Claude <noreply@anthropic.com>` with `Co-Authored-By`/`Claude-Session` trailers, and
  the owner wants no attribution anywhere. No `BALANCE_VERSION` bump (owner's call).
- **LIVE (since v110): a cancelled ranked match cannot be cancelled again** — no longer held; see
  the section below. **LIVE: a solo record run left after the buzzer is still saved** (the room
  keeps stepping with nobody connected until it finalizes).
- ⚠️ **A gated shell chain lied once tonight:** `grep -c` exits 1 on a count of 0, so
  `X=$(… | grep -c …) && cd worktree && …` stopped before the `cd` and the "main" tests ran on
  alpha. The push gate caught it. Use `|| true` on counts and guard every `cd`.
- `npm test`'s shared suite still ends at the 2 pre-existing `lan gate` failures. Alpha still
  carries unreviewed BIOBUZZ commits that are not on main (see the review note below).

# HANDOFF — 2026-09-13, night (production hotfixes: record-room reap LIVE, dodge double-cancel shipped in v110)

Superseded by the section above. Deploys go from a MAIN worktree, never this alpha tree; killing
a background deploy does NOT kill its `flyctl` child, so run deploys in the foreground. (v108,
built from alpha by mistake, was live for about 5 minutes around 01:19Z and was replaced.)

- **LIVE: a solo record run closed on purpose frees its room at once** (`f0e0430` main /
  `df5872d` alpha, `server/room.ts` `detach(id, conn, clean)`, `server/index.ts` close code).
  Record-run restarts used to hold the old `rec-` room for the 45 s reconnect grace, still
  simulating. At the BIOBUZZ launch spike iad sat at 24/24 with 8-12 real runs and refused new
  ones as `region_full`, which the Record Run screen shows as "Couldn’t start". A close with
  code 1000/1005 on a solo record room now reaps immediately. 1006 (network) and 1001 (tab)
  keep the grace, and so does every room with a second driver.
- **SHIPPED in v110 (was held earlier that night): a cancelled ranked match can no longer be
  cancelled a second time** (`28575be` on alpha, `406f506` on main).
  `cancelPending` left `pendingMatch`/`phase` set, and a socket's `room` is never cleared. So
  the first player to leave the cancelled screen re-ran the cancel from `detach` and was billed
  a STRATEGY BAIL. The innocent driver was shown "Nothing was charged to you" and then lost
  standing anyway; the player who never readied was billed twice. Smoke reproduces it: 3
  charges without the fix, 1 with it. **Standing already lost this way is not refunded:** the
  false rows are `standing_events` kind `dodge` whose `room_code` also carries a legitimate
  charge to the other player.
- `npm test`'s shared suite still ends at the 2 pre-existing `lan gate` failures (below).
- Unreviewed alpha content not on main (review summary): BIOBUZZ hive tip rate / spill / miss
  bounce and LEAVE-from-start-wall change scoring and RNG draw counts with no `SIM_VERSION`
  bump; `startWalls` is read without a guard, so an alpha client against a main server throws in
  online BIOBUZZ. Deploy the server before clients, or guard it, before promoting.

# HANDOFF — 2026-09-13, later (BIOBUZZ hive feel: tip rate, spill scatter, miss bounce, canopy)

Branch **`claude/hive-physics-rendering-tjz7mj`**. Four owner-reported HIVE items, all inside
`src/games/biobuzz/` (nothing shared touched). Gates: `npx tsc --noEmit -p .` clean,
`server:check` clean, `test:bb` **1289 ALL PASS**, `npm run build` ok. Full `npm test` run to the
end: the shared suite reports **2 FAILURES, both PRE-EXISTING and not this branch's** — `lan gate:
alpha opens it; production does not mention it at all` and `lan gate: and production still opens
neither door`. They assert `fly.toml` carries no `LAN_UPLOADS` / `LAN_SIGNALLING`, and the
2026-09-13 promotion (below) deliberately put both in `fly.toml [env]` to turn LAN on for
production. The check is stale against that owner decision; the files it reads are untouched by
this commit. Whoever owns the LAN policy should either retire those two checks or drop the flags.

**MERGED INTO `alpha`** (`f3f74dc`), no conflicts: alpha's own `state.ts` change adds `startWalls`
to `BiobuzzState` while this one adds `swingRate` to `BbHiveState`, and alpha's HUD change only
moves the `tipping > 0` readout from a chip to the score bar's `cellLine`, which this preserves.
Gates on the MERGED tree: `tsc` / `server:check` / `build` / `uiaudit` clean, `test:bb` **1294 ALL
PASS**.

⚠️ **A SEPARATE ALPHA BUG WAS FIXED TO GET A GATE AT ALL** (`scripts/smoke.ts`, own commit). Alpha's
LAN commit `d14895b` added a check reading `roomSrc` ~126 lines ABOVE the `const roomSrc` in the same
block, so it threw `ReferenceError: Cannot access 'roomSrc' before initialization` and **aborted the
whole shared suite** — which, being `&&`-chained, also meant the BIOBUZZ suite never ran under
`npm test` at all. The read is hoisted to its first use. The two checks involved now run and pass,
and the shared suite completes at its 2 pre-existing LAN gate failures. Nothing else moved.

- **A heavier tray tips faster** (`hive.ts` `hiveSwingRate`, `hiveSurplus`). The 4 s swing is
  the swing of a tray at EXACTLY its tip-table threshold; each element over the threshold adds
  `BB_TIP_RATE_PER_EXTRA` 0.35 to the rate, capped at `BB_TIP_RATE_MAX` 3. The surplus is
  measured against `BB_TIP_POLLEN`, so every row's threshold load still takes 4.0 s and every
  existing timing check is untouched. Pre-release the rate reads the live contents (the cell
  keeps taking, so feeding a swinging tray speeds it up — measured: 2 pollen dropped in at
  0.5 s settle it at 2.57 s instead of 4.0); post-release the rate is carried in the NEW
  optional `BbHiveState.swingRate` (absent when settled and on old snapshots = nominal).
  `tipping` stays in nominal seconds, so `tipProjection` / `tipProgress` are unchanged.
- **Spill scatter** (`hive.ts`): `BB_SPILL_SPEED` [35,62] → **[30,62]**, `BB_SPILL_FAN` 18° →
  **40°**, plus a new all-directions **`BB_SPILL_KICK`** 12 in/s. Every pose still leaves
  outboard by construction (23 in/s outboard minimum vs a 12 kick). `spillPoses` now draws SIX
  rng values per pose. `docs/biobuzz/feedback/001-spill-kinematics.md` has the addendum.
- **A miss bounces off the structure** (`hive.ts` `hiveDeflect`, called from `play.ts` after
  the capture loop for BOTH hives). The assembly is an APPROX box (`BB_HIVE_W` × `BB_HIVE_LEN`,
  `BB_HIVE_BOTTOM_Z`..`BB_HIVE_OPEN_Z[1]`) with: the two long sides, the DOWN cell's outer end
  and the underside solid; an interior PIVOT PLANE (y = 0) solid; **no top** (a descent from
  above is the capture test's business, and a top is a shelf a ball could rest on); and the
  **TAKING cell's outer end OPEN at every height** (`hiveTakingSide`, so it follows the
  release). ⚠️ That mouth exemption is load-bearing: with the face solid, the dumper parked at
  the lip and Aim Assist's flat lobs (which cross the lip a hair before apex, still climbing)
  were ALL refused — 8 checks red. Bounce is `BB_HIVE_MISS_REST` 0.3 on the normal,
  `BB_HIVE_MISS_TANGENT` 0.5 on the rest, vz kept on a side hit. Measured: a 150 in/s shot into
  the red hive's flank lands 18.8 in short of the face on the side it came from; the same shot
  at 70 in clears the top and lands downrange.
- **Translucent canopy** (`drawField.ts` `drawHiveCanopy`, called from `draw.ts` between the
  low and high element passes). The renderer draws field → robots → elements, so a robot under
  the hive was painted OVER it. The canopy repaints the body, the up cell's fill and its
  contents row at `CANOPY_A` 0.42 over the assembly's own footprint, after the robots and the
  ground/low-flight elements and before the airborne ones (split at `BB_HIVE_BOTTOM_Z`). The
  contents row is now `drawCellContents`, shared by the field pass and the canopy. Not a
  `globalAlpha` on the sprite — the ruling is the PORTION under the hive, not the robot.
- No `SIM_VERSION` bump was made (owner's standing call on this branch); spill RNG draw count
  and the miss bounce both change sim output for the same inputs.

---

# HANDOFF — 2026-09-13, late (DEPLOYED: alpha is production, BIOBUZZ is public)

- **`main` is `088addb`** (alpha fast-forwarded onto it and pushed; this handoff note is on alpha
  only, so a docs commit does not rebuild the site). Vercel production serves it
  (`https://www.playdsim.com/version.json` → `088addb`, `/biobuzz` in the sitemap).
- **BIOBUZZ is public**: `src/seasons.ts` has no `channels` for it. The crawler files were edited to
  match (`public/sitemap.xml`, `public/robots.txt`, the static nav and the four home-description
  copies in `index.html`), as the BIOBUZZ suite requires. `test:bb` 1272 PASS, `npm run build` ok.
- **Production game server deployed** with `./scripts/fly-deploy.sh` (the owner said to skip the
  in-game warning; the countdown was cancelled before it deployed anything). Verified after:
  every machine on one image; iad `performance-2x`/4096; ord, sjc, lhr `performance-1x`/2048;
  gru, jnb, syd, nrt `shared-cpu-4x`/1024 (stopped until someone connects); `/health` ok;
  `/api/perf` `admitting:true` on every started machine; `/api/presence` caps `party,lan`;
  `/api/seasons`: DECODE Act 2 · S1 (bv 7), Chain Reaction Act 2 · S1 (bv 5), BIOBUZZ Act 1 · S1 (bv 4).
- **Alpha preview deployed** too (`--alpha`), healthy, caps `party,lan`.
- **Announcements published** from `docs/announcements/biobuzz-act1-season1.md`: a `season` reveal
  and the `patch` notes.
- The room-leak fix (`8e2ea2b`) is now live in production, so `iad` should no longer need restarts.
- `ADMIN_SECRET` lives in `D:\Projects\2ddecodesim\.env`; load it into one command, never print it.

---

# HANDOFF — 2026-09-13 (preparing the alpha → production promotion)

Branch **alpha**, pushed. `npm run server:check` clean; the new room-leak smoke check was run in
isolation and mutation-checked (fails without the fix). The full `npm test` was NOT run (owner).
**Nothing deployed to production — the owner said not to until the promotion is ready.**

## (was READ FIRST) — production `iad` was refusing every new room

`/api/perf` on the always-warm primary read `rooms: 0, admitting: false`, and its log was a wall
of `[admit] refused room rec-…: at cap (24/24)` from at least 04:53 UTC. US-East players could not
start a record run or a custom room at all.

**Cause:** `finalizeMatch` stops the room's loop and keeps the room for the results screen, but
the reconnect grace is only ever checked BY that loop. A driver who closed the tab from the
results screen was held forever and the room never deleted — one leaked room per finished match
someone walked away from. Satellites auto-stop and start clean; `iad` never does, so only it
filled up.

- **Mitigated:** `iad` (6836e6dc0e2348) restarted 2026-09-13 with the owner's go; it read
  `admitting: true` 43 s later.
- **Fixed on alpha only:** `8e2ea2b` (`Room.armGraceReap`). The owner chose to ship it WITH the
  promotion, so **production will leak again until then.** If `/api/perf` on `iad` shows
  `admitting: false` with few live `rooms`, restart that machine (ask first). The scheduled
  checkup below flags exactly this as URGENT.

## Update, later the same day: PRs merged, main merged, LAN on, launch fleet sized

All on alpha, **still not deployed**.

- **main merged into alpha** (`a335bb0`). One conflict, the HUD chip block in `GameView.tsx`,
  kept as alpha had it. `fly-deploy.sh`, `fly.toml` and `.env.example` now carry main's fleet.
- **PRs #45, #60 and #57 merged** (`a4dd082`, `7d301f5`, `3b1d3c9`). #57's three conflicts kept
  both sides. Its replay start-pose snap was gated on `startLegality`, which BIOBUZZ sets too, so
  it became a per-game hook, **`GameSimModule.startSnap`**: DECODE fills it with the same G304
  snap; BIOBUZZ and Chain Reaction keep their field-clamped pose. **No `SIM_VERSION` bump**
  (owner): some pre-deploy replays may play back differently from what happened.
- **LAN is ON for production**: `LAN_UPLOADS` and `LAN_SIGNALLING` in `fly.toml [env]`. The client
  lights LAN from the server's `lan` capability, so Vercel needs nothing. Migration
  **`0034_lan_runs_biobuzz.sql`** widens `lan_runs.game` to accept BIOBUZZ, which 0033 refused.
- **Launch fleet, from `docs/capacity.md`** (one machine per region is a hard rule, and one
  process uses about one core, so a dedicated core is the only size step that adds rooms):

  | region | size | why | $/mo if never stopped |
  |---|---|---|---|
  | iad (primary, matchmaker, API) | `performance-2x` / 4096 | dedicated core for the loop; 2nd core for GC and every socket's deflate | 64.39 |
  | ord, sjc, lhr | `performance-1x` / 2048 | real traffic; ~8–10 driven rooms, never throttled | 32.19 each |
  | gru, jnb, syd, nrt | `shared-cpu-4x` / 1024 | rarely host; 4x's baseline held 2 rooms / 8 players | 8.08 each |

  Satellites auto-stop and bill only rootfs while stopped, so their real cost is only while
  someone plays. Worst case, all eight never stopping: **~$193/mo** (today's worst case ~$31).
  Rough ceiling with margin: ~60 driven rooms fleet-wide, roughly 90 concurrent players at the
  real solo/1v1/2v2 mix, ~130 at redline. Past that, the fix is `SIM_WORKERS`
  (`docs/scaling-multicore.md`), not bigger VMs or a second machine per region.
  `fly.toml [[vm]]` is the primary's size; `scripts/fly-deploy.sh` `SATELLITE_SIZES` puts each
  satellite on its own after the deploy. Checked with `bash -n` and a dry run of the lookup.
- ⚠️ **gru and jnb still do not host CROSS-region matches** (`DEPLOY_REGIONS` unchanged). Adding
  them failed 8 `test:mm` checks: their real distances to syd/nrt and to each other (315–395 ms)
  are above `RTT_UNKNOWN` (300), so a real far pair looked like a missing row. They do host every
  room their own players open.
- Gates run for this: `npx tsc --noEmit -p .` clean, `server:check` clean, `test:bb` 1270 PASS,
  `test:mm` 186 PASS, `uiaudit` at baseline, `dbtest` ALL PASS (0034 applied). Full `npm test` NOT run (owner).

## Promotion checklist

1. **BIOBUZZ is still hidden on stable.** `src/seasons.ts` has `channels: ['alpha']` and the blurb
   "Rules land at kickoff on 2026-09-12." Both must change for it to appear in production. The
   CLAUDE.md BIOBUZZ section still describes a placeholder, alpha-only, unscored shell — stale.
2. **Open PRs to alpha** (reviewed 2026-09-13, nothing merged):
   | PR | verdict | why |
   |---|---|---|
   | #45 | **URGENT** | any socket can send a malformed `input` (NaN, `ld: 1e9`) into the authoritative world broadcast to the room. Server-only, merges clean, `test:mm` 186 pass on a trial merge |
   | #57 | recommended | real client/sim fixes (auto-path waits, replay `coerceSetup`); CONFLICTS in 3 files (trivial). Changes sim output for two narrow inputs without a `SIM_VERSION` bump — decide. Its `coerceSetup` gate keys on `startLegality`, which BIOBUZZ now sets, so BIOBUZZ replays still get DECODE's snap |
   | #60 | recommended | solo practice saves its score before the 2.8 s settle; practice-only, clean |
   | #58 | defer | `stageBiobuzz` idempotency; no shipped path calls it twice |
   | #61 | defer | LAN guest ack-keyed deltas; LAN is off in production; the shared WebSocket path measured byte-identical |
3. **Merge `origin/main` into alpha before promoting.** main has 10 commits alpha lacks (the
   ord/gru/jnb fleet, satellites at 512 MB, `fly-deploy.sh` re-shrinking all 7 satellites, fly.toml
   notes, the 8-region `.env.example`, a replay fix, controls copy). ⚠️ Deploying production from
   alpha's current `scripts/fly-deploy.sh` would re-shrink only 4 satellites, leaving ord/gru/jnb on
   fly.toml's `shared-cpu-4x`, and put the rest back on 1024 MB. A trial merge has ONE conflict:
   the HUD chip block in `src/ui/GameView.tsx` (both sides removed the pose readout) — take alpha's.
4. **Seasons.** Production: DECODE Act 2 · Season 1 (bv 7), Chain Reaction Act 2 · Season 1 (bv 5).
   `BALANCE_VERSION` is 4 on both branches and `currentSeasonNumber` returns each game's existing
   max, so **the deploy does not advance DECODE or Chain Reaction.** BIOBUZZ has no production rows
   (today's prod server coerces `biobuzz` to DECODE, so `/api/seasons?game=biobuzz` shows DECODE's
   list); the new server seeds `(biobuzz, 4, act 1)` on first use — alpha's database already holds
   exactly that. **Do not use the admin season/act roll for this launch.**
5. **Migrations:** none differ between main and alpha. `lan_runs` has `check (game in ('decode',
   'chain'))`, harmless while LAN is off in production, but it refuses a BIOBUZZ LAN upload on alpha.
6. **Announcements:** `docs/announcements/biobuzz-act1-season1.md` (a `season` reveal + `patch`
   notes), with a pre-publish checklist. Publish only after the deploy is verified.
7. **Order:** merge #45 (and any other chosen PRs) → merge main into alpha → full gates (`npm test`,
   `test:mm`, `dbtest`, `build`, `server:check`, `uiaudit`) → alpha into main →
   `scripts/announce-deploy.sh` (players are online) → verify `/health`, `fly machine list` sizes,
   `/api/perf` `admitting` on every started machine, `/api/seasons` per game → Vercel production →
   publish the announcements.

## Capacity — recommendation, NOT applied

Load today is tiny: 3 online; `iad` 0.02–0.04 cores; alpha ran 2 rooms / 8 players at 0.17 cores.
`npm run costprobe` (sim-only, laptop): a BIOBUZZ solo room costs 0.0245 cores (same as DECODE), a
2v2 0.0345; 10.2 / 38.4 KiB/s per client on the wire. Size on `docs/capacity.md`'s driven 0.075.

- **`iad`: `shared-cpu-4x`/1024 ($8.08/mo) → `performance-1x`/2048 ($32.19/mo).** The only size step
  that adds rooms: a dedicated core never throttles (~8–10 driven rooms against 5–8), and two rooms
  with 8 players already sat on the 4x sustained baseline (0.244 of ~0.25 cores, 2026-09-06).
  `shared-cpu-8x` buys nothing — one process uses one core.
- **`ord` and `sjc`: `shared-cpu-1x`/512 → `shared-cpu-4x`/1024 for the launch.** A 1x baseline is
  about one busy room. They auto-stop, so the extra ~$4.76/mo each is only paid while awake.
  Needs per-region sizes in `scripts/fly-deploy.sh` (today one `SATELLITE_SIZE` for all seven).
- Everything else stays `shared-cpu-1x`/512. Never a second machine in a region (room codes route
  by region); past `performance-2x` the fix is `SIM_WORKERS` (`docs/scaling-multicore.md`).

**Scheduled checkup:** the Claude desktop task `dsim-capacity-checkup` runs every 3 hours while the
app is open. It is read-only (machine list, `/api/perf` per started machine via
`fly-force-instance-id`, presence, log signals), recommends only, and keeps a history in
`C:\Users\geniu\.claude\scheduled-tasks\dsim-capacity-checkup\history.jsonl` so a downscale is only
ever suggested after 7 days of low readings.

---


---

# Older sessions

Sessions before 2026-09-12g are in **`docs/handoff-archive.md`** — moved there on
2026-09-16, unedited. This file had reached 5,888 lines and is read at the start of every
session; the archive keeps the history without charging every session for it.
