<!-- governs: src/sponsor.ts, src/ui/sponsorAssets.ts, src/ui/Sponsor.tsx, electron/**, src/assets/sponsors/** -->
# Presenting sponsor — DSIM presented by Offset Robotics

A signed sponsorship: every placement here is a contracted obligation that fails SILENTLY. `docs/sponsor.md` is the contract's operational half.

*Split out of `CLAUDE.md` on 2026-09-16, **verbatim** — CLAUDE.md is loaded into every
session and this is not needed by most of them. The `governs:` line above is read by
`scripts/docaudit.mjs` and by the editor hook, so keep it accurate when paths move.*

---

## Presenting sponsor (branch `biobuzz`) — DSIM presented by Offset Robotics

A LAUNCH + SEASON sponsorship of the APP, sold for the BIOBUZZ season with exclusivity.
**`docs/sponsor.md` is the contract's operational half** — the placement inventory, the
artwork swap, the kill switch, and the monthly attribution recipe. Read it before touching
any of this.

- **`src/sponsor.ts` is the single source of truth** (name, URL, artwork footprint, term)
  and is DOM-free, so the headless smoke suite imports it. `src/ui/Sponsor.tsx` is the ONE
  component that builds the link and fires the events — nothing else may. `sponsorAssets.ts`
  is split off it because an image import would choke the `tsx` suite.
- ⚠️ **`Season.presenter` IS A DIFFERENT FACT.** That is FIRST's sponsor of the GAME (DECODE
  presented by RTX), not ours and not for sale. Both lines are true on the home menu at once;
  never fold one into the other. The home menu reads `DSIM`, then the Offset line
  (`SponsorPresents`), then the game switcher, then the social pills and the menu. There is NO
  season line on home or in the footer any more (owner, 2026-09-23 — the `.ds-home-season` and
  `.ds-foot-season` lines are gone), so the season's presenter is not printed on the shell at
  all; the footer's brand run is `DSIM` + `SponsorFooterMark` (`.ds-foot-brand`) alone. If a
  season line ever comes back, keep it a separate item: inside the brand run, "DSIM · BIOBUZZ …
  PRESENTED BY OFFSET" read as Offset presenting the game (design review 22-04).
- ⚠️ **THE IN-GAMEPLAY CHIP IS NOT AN AD, AND MUST NEVER BE ROUTED THROUGH `src/ads/`.** That
  gate renders nothing on touch, nothing under Electron and nothing for a supporter — i.e.
  it would be invisible on every phone, in the desktop app, and to the most engaged players
  on the service. "Rendered independently of the ad system" is written into the deal, so
  `Sponsor.tsx` imports nothing from `src/ads/` and `GameView.tsx` renders `<SponsorGameChip
  />` outside the `ads &&` branch. Both are smoke-checked, because re-routing it is a
  one-line refactor.
- **Six placements**, each with its own `utm_medium` so the report can break them down:
  `home`, `footer`, `game`, `download`, `splash` (`electron/splash.html`, shown by
  `showSplash()` in `main.cjs` and handed over on `ready-to-show`), and `replay` — the mark
  BURNED INTO every exported video (`drawSponsorMark` in `replayOverlay.ts`). ⚠️ The capture
  `draw` callback is SYNCHRONOUS, so `ReplayView` must `await loadSponsorMark()` BEFORE
  `recordFast`, and the burn-in falls back to the wordmark in text if the image never decodes
   — a clip missing the placement is a breach, an ugly one is not.
  The LOADING SCREEN is `#seo-home` in `index.html` and carries the line as TEXT: the bundled
  artwork is fingerprinted and an absolute path 404s under Electron's `file://`.
  The DISCORD server logo is not a repo change at all.
- **The term is a window** (`SPONSOR.term`, `until` EXCLUSIVE) and an unparseable date fails
  toward SHOWING the mark — a wrong clock must not void a placement somebody paid for.
  `VITE_SPONSOR=0` is the kill switch, exact-string matched for the same reason.
- **Artwork is FOUR files** (`src/assets/sponsors/offset-on-*.png` + `electron/sponsor-on-*.png`,
  the Electron pair duplicated because a `file://` page cannot resolve a Vite hash). The names
  say which SURFACE, not which ink — the sponsor calls the black cut "the dark logo" and the
  site calls it `OffsetLogoLight.png`, so place a new file by looking at the pixels. Sizes are
  declared in `SPONSOR.logoW/logoH` and every placement reserves its box from that ratio
  before the image loads (`shiftaudit`); the smoke lane reads all four PNG headers.
- **The report is DSIM's own analytics** (the admin Analytics tab's Sponsor report panel) —
  `sponsor_shown` (the denominator), `sponsor_click` (per placement), our own sessions, and
  `player_joined` (fired in `UsernameGate`, the last step of signing up; it over-counts legacy
  accounts ONCE and `docs/sponsor.md` footnotes it). No identifiers. Vercel Web Analytics was
  removed in September 2026; its history is imported (`analytics_imported`, migration 0052).
- **Tests**: the `SPONSOR` lane of `scripts/smoke-biobuzz/` (`npm run test:bb`). Everything it
  covers is a contracted obligation that FAILS SILENTLY — a placement that stops rendering, a
  link that loses its UTM tag, a term that does not cover the season it was sold for.

---


## Desktop shell: Google sign-in is a pop-up window

(owner, 2026-09-24: the Google screen took over the desktop app's window.) `AuthPanel`'s Google
button, when `window.dsim.oauth` exists, asks Neon Auth for the provider URL with
`disableRedirect`, and `dsim:oauth` (`electron/main.cjs`) opens it in a CHILD WINDOW that shares
the app's cookie store. The pop-up is closed the moment the flow redirects to the callback (a URL
on the SITE, `?dsim_oauth=1`, never loaded), and the `neon_auth_session_verifier` Neon Auth
appended there is handed back. The app then reloads its own address with that verifier, which is
the same exchange a returning web redirect ends in. Three things that look wrong and are not:
- **Not a tab in the user's browser.** The session would be in that browser's cookie jar, and
  this SDK has no one-time-token handoff to bring it back.
- **The pop-up's user agent drops `Electron/…` and the app token; the main window's does not.**
  Google refuses sign-in in a recognised embedded browser, and `src/ads/adsense.ts` reads
  "Electron" in the main window's UA to know it is the desktop app.
- **The callback is on the site even from the offline bundle** (`file://` is not an address Neon
  Auth will redirect to).
A shell older than this has no `oauth` and keeps the in-window redirect. ⚠️ **It ships with a
DESKTOP RELEASE**: the site half deploys with Vercel, but `main.cjs` and `preload.cjs` are inside
the installed app.
