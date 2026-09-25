# Roadmap — owner priorities (2026-09-18) and next up

Split out of `CLAUDE.md` on 2026-09-16. Orientation, not a rule: nothing here binds a change
you are making today, which is why it is no longer loaded into every session. `CLAUDE.md`'s
**State of play** section is the short version and stays there.

---

## ⚠️ URGENT: multi-core game server (owner, 2026-09-24)

Do this as soon as possible after the BIOBUZZ Act 2 release. The server runs on one core per
machine, so bigger VMs don't add room capacity. Details in `docs/capacity.md`, "MULTI-CORE".

## Owner priorities, 2026-09-18 (plan; branches named; none started unless marked)

Eight items the owner asked for beside BIOBUZZ 3D. Items 1–2 need the 3D renderer and stay on
`biobuzz-3d`; items 3–8 each get their own branch off `alpha` (`feat/<slug>`), land on alpha with the
usual gates (`build` · `npm test` · `uiindex`+`uiaudit` · `docaudit` · `dbtest` when a migration is
touched) and are pushed. Items 3 and 4 are PLANS first: the owner approves the design before code.
Sizes are working days for one agent; "exists" cites what the survey found so nothing is rebuilt.

### Order

| # | item | branch | size | after |
|---|---|---|---|---|
| 5 | Authentication: password reset, email verification, terms acceptance | `feat/auth-flows` (off alpha) | 2–3 d | now |
| 8 | Privacy & cookie settings | `feat/privacy-cookies` (off alpha) | 1.5 d | with 5 (shares the legal version) |
| 7 | Contributors page | `feat/contributors` (off alpha) | 1 d | now (owner supplies handles/avatars) |
| 6 | Game tutorial | `feat/tutorial` (off alpha) | 1 d engine + 2 d per game | now |
| 2 | Download a replay as 2D or 3D | `biobuzz-3d` | 1–2 d | Day 2 lane B (the `project` hook) |
| 1 | 3D robot creator menu — **DONE 2026-09-18**, `feat/3d-builder` | `biobuzz-3d` | 2–3 d | — |
| 3 | Cosmetics — plan, then build | `docs/cosmetics-plan.md` → `feat/cosmetics` | 0.5 d plan, 3–4 d build | plan now; build after owner approval |
| 4 | Rewards for loyal and top players — plan, then build | `docs/rewards-plan.md` → `feat/rewards` | 0.5 d plan, 3–5 d build | plan now; build after owner approval |

### 1. A proper 3D robot creator menu (`biobuzz-3d`) — **DONE 2026-09-18**

> Landed on `feat/3d-builder` off `biobuzz-3d`. Built as designed below, with three deviations,
> all recorded in `HANDOFF.md` and `docs/area/biobuzz.md`:
> **(a)** the component reaches the renderer through a new `GameModule.previewScene` slot rather
> than its own `import()`, so all of a game's dynamic renderer imports stay in one file — and
> both slots name the same module, because two dynamic specifiers would split the scene chunk
> into facades that `bundleaudit` cannot route. **(b)** the saved-robot card needed a second
> slot, `GameModule.savedCard`: thumbnail-or-summary is the game's choice, not the shared
> menu's. **(c)** the Gallery still of the preview was NOT built — the anti-drift claim is held
> structurally instead (one generator, one rebuild key, both asserted in the RENDER lane).
> The colour gap named below turned out to be one of four: the turret and the Box Tube were
> built inside the chassis box, `specKey` did not cover `drivetrain`, and a discarded robot
> group was never disposed. All four were the MATCH's bugs and all four are fixed there.

- **Exists.** `GameModule.Builder`/`Preview` slots (`src/games/module.ts`), BIOBUZZ's `Builder.tsx`
  (launcher → Box Tube → intake → frame, clamped in that order), the 2D schematic
  `RobotPreview.tsx`, `RobotSpec.heightIn` (12–29, clamped in `coerceBiobuzzSpec`), the 3D
  generator `scene/renderRobots.ts` (`buildBiobuzzRobots`, chassis/wheels by drivetrain/sweepers/
  turret/dumper/Box Tube/sign panel, rebuilt on `specKey`), `savedRobots` capped at
  `MAX_SAVED_ROBOTS` 3 (`Menu.tsx`).
- **Design.** A `BiobuzzPreview3D` component fills the `Preview` slot: a small Three.js scene
  (`scene/renderPreview.ts`, same lazy chunk, orbit camera, turntable, the scene's lighting) that
  reuses `buildRobotGroup` and re-renders live on spec change; a 2D/3D toggle on the same per-device
  view pref; a height slider (`heightIn`) and the `stowHeightIn ≤ 18` builder check from plan-3d
  §3.3; the cosmetic chassis colour applied in 3D the way 2D does it (fill = `chassisFill`,
  alliance = outline and sign panel — today the 3D chassis is alliance-filled, a gap); saved-robot
  cards get a 3D thumbnail rendered once per `specKey` into a data URL. DECODE/CR keep their 2D
  previews until they have generators.
- **Verify.** RENDER lane (three only under `scene/`), `bundleaudit` (scene ≤ 250 KB gz),
  `uiaudit`/`shiftaudit` for the menu, a Gallery still of the preview, a visual pass in both themes.
- **Risk.** Preview and match must not drift: both draw from `buildRobotGroup`, so a check asserts the
  preview's `specKey` equals the match sprite's for the same spec.

### 2. Download a replay as 2D or 3D (`biobuzz-3d`)

- **Exists.** The export menu (`ReplayView.tsx`, `.ds-dl`), `recordFast` through WebCodecs with its
  own detached canvas and `encodeSize`, the burn-in `drawReplayHud`, the two muxers; 3D-physics
  replays already re-simulate with `initPhysics3d()` but are always DRAWN by the 2D renderer; the
  `GameScene` contract with `insets` and (Day 2 lane B) `project`, and the renderer's `overlayOnly`.
- **Design.** The menu gains "View: 2D / 3D" (3D offered only when the game has a `scene` and WebGL2
  probes OK) and a camera pick (driver / chase / orbit). The 3D capture creates the scene on a
  detached host, `resize(encodeW, encodeH, 1)`, and per frame: `scene.render(world, frame)`, then
  `ctx.drawImage(scene.element, 0, 0)` onto the export canvas in the same task (no
  `preserveDrawingBuffer`), then the 2D renderer in `overlayOnly` with labels through
  `scene.project`, then the burn-in. Insets are 0 (the burn-in reserves its own band). The quality
  preset for exports is fixed High regardless of the device pref.
- **Verify.** A headless check that the 3D export path renders N frames without throwing under a
  stubbed WebGL (or is skipped with a stated reason); a manual export of a 3D practice at 1920 in
  MP4 and WebM played back; PSNR is not the metric here, framing is (the field fits, the HUD band is
  clear).
- **Risk.** WebGL readback cost per frame at 1920 (measure; the fast path re-simulates as fast as it
  can, so a 2× slower frame is acceptable, a 10× one is not).

### 3. Robot customization (cosmetics) — plan first ([docs/cosmetics-plan.md](cosmetics-plan.md) → `feat/cosmetics`)

- **Exists.** `RobotSpec.chassisColor` on a 7-key allowlist (`CHASSIS_COLORS`, `chassisFill`),
  validated in `coerceSpec` (never a free hex on the wire), supporter-gated in the menu, rendered by
  every 2D sprite; NOT rendered in 3D (gap); the sign panel is alliance-coloured; no decals/titles;
  no per-account cosmetic storage (cosmetics ride inside each saved `RobotSpec`).
- **Proposed shape.** One `src/cosmetics.ts` palette/registry read by 2D and 3D: `chassisColor`,
  `accent` (wheels/rollers), `decal` (none / stripe / chevron / a few allowlisted patterns), `plate`
  (sign-panel style). Everything is an allowlisted KEY; the wire never carries colours or images.
  Tiers: free (default + two colours), supporter (all colours + decals), earned (unlocked by
  rewards, item 4). Unlocks are ACCOUNT state (`profiles.cosmetics jsonb`, server-authored like
  `role`): the server strips anything the account has not unlocked when it coerces a spec on join,
  so a client cannot self-declare. Cosmetics never touch physics: a smoke check asserts
  `worldHash` is identical across cosmetic values.
- **Decisions for the owner.** Which decals; whether the team-number plate is editable (moderation:
  numbers only, no free text); whether cosmetics show on the leaderboard rows.

### 4. Rewards for loyal and top players — plan first ([docs/rewards-plan.md](rewards-plan.md) → `feat/rewards`)

- **Exists.** Paid supporter perks (badge, ads-off, saved starts, colours), staff badges, Glicko-2
  ranked with archived Act→Season periods per game, records with PB/WR, `user_activity`
  (games, seconds; aggregated) with the standing rule that NOTHING competitive may read it;
  no achievements, streaks or titles anywhere.
- **Proposed shape.** Two ledgers, both server-authored. *Loyalty*: milestones from server-observed
  play (matches on the authoritative server; practice runs excluded or capped because they are
  client-reported) and a daily activity streak (a `user_days` row per active day, written from the
  server side) → cosmetic unlocks and profile TITLES; never rating, board or ELO effects.
  *Top players*: per-season awards written when the admin archives a period (`season_awards`:
  top 10 per game, record holders at close) → a title and a badge FRAME on the profile and board
  rows. Surfacing: an `AwardBadge` sibling of `SupporterBadge` with a distinct shape, a Career
  "Awards" section, a chip on leaderboard rows. Anti-farm: awards computed at archive time only;
  loyalty counts server-observed ticks only. Paid perks stay separate from earned ones.
- **Decisions for the owner.** Award names and art; whether supporters get exclusive earned
  rewards (recommendation: no — keep paid and earned distinct); milestone thresholds.

### 5. Better authentication (`feat/auth-flows`, off alpha)

- **Exists.** Neon Auth (`@neondatabase/auth` ^0.4.2-beta, Better-Auth based): email+password and
  Google OAuth in `AuthPanel.tsx`; JWT verification on the server (`jose`, JWKS). The SDK already
  exports `forgetPassword`, `resetPassword`, `sendVerificationEmail`, `verifyEmail`,
  `changeEmail` (see `node_modules/@neondatabase/auth/dist/better-auth-react-adapter-*.d.mts`);
  DSIM's hand-typed `AuthClient` interface (`src/lib/authClient.ts`) omits them. No forgot-password,
  no verification step, no terms acceptance; the legal text has one "last updated" date and no
  version.
- **Design.** (a) Forgot password: a link on the sign-in form → `forgetPassword({email,
  redirectTo: '/account/reset'})` → a `/account/reset?token=` screen → `resetPassword`; success
  signs the user in. (b) Email verification: turn on "require verification" in the Neon Auth
  project (owner dashboard action), call `sendVerificationEmail` after sign-up, show a persistent
  "verify your email" banner with resend, gate ranked/records on a verified email server-side
  (the JWT carries `email_verified`; verify in `server/auth.ts`). (c) Terms: a required checkbox
  on sign-up ("I agree to the Terms and Privacy Policy" with links) and a server record
  `profiles.terms_version` + `terms_accepted_at` (migration 0039) via `POST /api/user/accept-terms`;
  OAuth users accept on their first session (a gate in `AccountSync`); when `LEGAL_VERSION` (new,
  in `legalText.ts`) bumps, everyone re-accepts once. Copy per `docs/area/ui.md`; the owner reviews
  the legal wording before it ships.
- **Verify.** `dbtest` for the migration and the accept round-trip; a smoke check of the version
  gate logic; manual end-to-end with a test account (owner) for the three email flows; the Neon
  Auth sender domain configured by the owner.
- **Risk.** Beta SDK drift: pin the exact version; wrap every new call in one module so an API
  rename is a one-file fix.

### 6. Game tutorial (`feat/tutorial`, off alpha)

- **Exists.** The Gallery's `Scene` staging drives the real renderer, input and step (BIOBUZZ
  `scenes.ts`); the muted event log (no popups over the field, `docs/area/ui.md`); the
  per-device seen-flag pattern (`chainDisclaimer.ts`, local, versioned key); rebindable
  `bindings.ts` for key names; solo practice.
- **Design.** A tutorial is a scripted solo practice: a list of STEPS, each a staged `Scene`, a
  goal predicate over the world (drove into the zone, captured a pollen, scored a shot, placed a
  nectar, parked), a hint line naming the bound keys/pad buttons, and a step card in the HUD band
  (never over the field). Skip and replay; completes into normal practice. Per-device
  `decodesim.tutorial.v1` seen flag; offered on the first Practice and from Controls. Engine
  shared (`src/tutorial/`), content per game (BIOBUZZ first, DECODE second, CR later).
- **State (2026-09-23).** BIOBUZZ and DECODE ship one (`tutorial:` on their `GameModule`).
  **Chain Reaction has NO tutorial**: its module leaves the slot absent, and every tutorial
  surface (the Modes card, the Controls row) hides itself for it. The seen flag is per game now
  (`docs/area/ui.md`).
- **Verify.** A smoke lane runs each step's predicate against scripted commands (every step is
  completable and none completes vacuously); `uiaudit`/`shiftaudit` for the card; a manual run on
  keyboard and gamepad.

### 7. Contributors page (`feat/contributors`, off alpha)

- **Exists.** `Contributors.tsx` over a hand-kept `CONTRIBUTORS` array (6 entries, most fields
  `TODO(fill in)`), live handle lookup; no sponsor, supporter or third-party credit sections; the 3D
  plan expects HDRI attribution here on Day 3.
- **Design.** Sections: Core team; Contributors (CLA, from `CONTRIBUTORS.md`); Presented by
  (sponsor mark and link, from `sponsorAssets.ts`); Third-party (Rapier, Three.js, fonts, CC0
  HDRIs with author links when Day 3 lands, and the FIRST field CAD note from plan-3d §8);
  Supporters — opt-in only via a `profiles.show_on_supporters` flag (privacy; owner decides
  whether to offer it). The owner supplies handles, avatars and links for the TODOs.
- **Verify.** `uiindex`/`uiaudit`, `contrast`, both themes, phone width.

### 8. Privacy & cookie settings (`feat/privacy-cookies`, off alpha)

- **Exists.** Google Funding Choices CMP for ad consent (`loadCmp`, `showConsentSettings`), the
  footer "Privacy & cookie settings" link that hides itself when the CMP offers no revocation
  entry, `/privacy` and `/terms` from `legalText.ts`, cookieless Vercel analytics (counts only; removed Sept 2026 for first-party analytics),
  `ads.txt` generated at build; DSIM sets no cookies of its own; 15 `decodesim.*` localStorage
  keys of which the privacy text lists a subset; no in-app data export; account deletion
  described in the text (the server cascade exists and is dbtested).
- **Design.** (a) A single `STORAGE_KEYS` registry in code that every `localStorage` use imports,
  and a privacy-page inventory generated from it (a check fails if a key is used outside the
  registry) so the text cannot drift. (b) A "Your data" panel on `/privacy`: storage inventory,
  analytics on/off (honoured by `analytics.ts`), ads personalisation → the CMP, "Export my data"
  (`GET /api/user/export`: profile, settings, records, practice runs, replay ids as JSON),
  "Delete my account" (the existing flow, surfaced). (c) The CMP: confirm the EEA/UK/CH message is
  configured and that the revocation control appears from an EU vantage; if the entry point never
  exists, the footer link should say so rather than vanish. (d) `LEGAL_VERSION` shared with item 5;
  a CCPA line stating nothing is sold. (e) The privacy text's processor list re-checked against
  the deploy (Neon, Fly, Vercel, AdSense, Ko-fi/PayPal).
- **Verify.** The registry check in `npm test`; `dbtest` for the export route; `uiaudit`; a manual
  pass of the CMP from an EU proxy or the Funding Choices preview.

## Next up (not started)

1. **Rapier slice 3 — the AUTO-PATH robot as a DYNAMIC body** driven toward its path target,
   so a chassis crushed between a kinematic path robot and a wall has somewhere to go (today
   the perimeter invariant is what saves it, and it saves it by refusing the push). Then **CR
   particles** to Rapier if 300 bodies a tick is affordable, KEEPING the scripted accelerator
   loop. ONLY after that: drop the `dsin/dcos/datan2` discipline.
2. **DECODE penalty hitbox audit** — G408 and G422 have now been rewritten against the manual's
   own text; what is left is the ZONE GEOMETRY each of the OTHER rules tests
   (`gateZone`/`gateTapeSegments`, `tunnelStrip`, `allianceArea`, `pinnedAgainstWall` slop, the
   SAT `rrContacts` test) versus the manual figures. Tighten with smoke cases.
   **Get the rule text from `/ftc/archive/2026/game/manual-NN`** — the live `/ftc/game/manual`
   now serves the 2026-27 pre-season manual and `manual-11` 404s there. WebFetch's own PDF
   extractor returns binary garbage on these; download the PDF and run `pdftotext -layout`
   (`pdftotext` without `-layout` for the glossary, whose two columns interleave otherwise).
   **Check every quoted definition against the real glossary before trusting it** — G408 shipped
   for months against two definitions that are not in this manual at all.
3. **Chain Reaction manual refinement** — replace the `APPROX` constants (ring-stand inset,
   Lab-Area size/geometry, exact zone coordinates) with measured manual values. This is the
   last real gap in CR; everything else there is feature-complete.
4. **Multi-core — DESIGNED, NOT BUILT (`docs/scaling-multicore.md`).** One server process is
   capped at about one core, because Node runs JavaScript on one thread; a 16-vCPU machine runs
   the same single thread as a 1-vCPU one, which is why the VM sweep found `shared-cpu-1x`
   through `8x` barely differ. Profiled, **~75% of a busy server is simulation that can leave
   the socket thread and ~6% is socket work that cannot**, and `server/room.ts` imports no `ws`
   and no `pg` — every way out of a room is already a callback — so the seam a worker needs
   exists. Recommended: `worker_threads` behind **`SIM_WORKERS`, default 0**, taking a machine
   from ~13 driven rooms to ~100 and 1,000 concurrent from 70–90 machines to single digits.
   ⚠️ **`UV_THREADPOOL_SIZE` must be raised with it** — `permessage-deflate` runs zlib on the
   libuv threadpool, that pool is PER PROCESS and defaults to 4, and left alone it becomes the
   new bottleneck and presents as LATENCY rather than as CPU. Sequence: Linux baseline first,
   then `SIM_WORKERS=1` (slower than none, on purpose — it prices the hop in isolation), then
   sweep 2/4/8. **Until a prototype exists, do not buy multi-core hardware for DSIM: nothing
   in the repo uses a second core.** `grep SIM_WORKERS` finds nothing today.
5. Deferred: WebTransport (needs TLS-deploy validation + an ACK-keyed delta), full-reload
   reconnect, obelisk AprilTag visuals, DECODE deferred fouls (G408 possession>3 / plowing),
   matchmaking polish, replay UI, leaderboard tiers.

