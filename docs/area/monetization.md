<!-- governs: src/ads/**, server/kofi.ts, src/legalText.ts, src/analytics.ts, src/analyticsPref.ts, src/pageviews.ts, src/pathScrub.ts, src/storageKeys.ts, server/analytics.ts, server/analyticsImport.ts -->
# Monetization — ads and the supporter tier

Perks are cosmetic or convenience ONLY — never anything affecting how a robot drives or scores.

*Split out of `CLAUDE.md` on 2026-09-16, **verbatim** — CLAUDE.md is loaded into every
session and this is not needed by most of them. The `governs:` line above is read by
`scripts/docaudit.mjs` and by the editor hook, so keep it accurate when paths move.*

---

## Monetization (branch `monetization`) — ads + supporter tier

Not yet deployed. `HANDOFF.md` has the full write-up; the load-bearing rules:

- **`src/ads/adsense.ts` is the single gate.** Ads are OFF unless `VITE_ADSENSE_CLIENT`
  is set, and are suppressed unconditionally in the Electron build (AdSense forbids app
  wrappers), on touch, and for supporters. `AdsProvider` FAILS CLOSED — ads stay off
  until the entitlement check settles, so a supporter never sees a flash of them.
- **Ads are NON-PERSONALIZED by default and tagged TFUAC.** DSIM simulates FTC
  (grades 7–12) and the sim is fully playable SIGNED OUT, so most impressions carry no
  age signal. `VITE_ADSENSE_PERSONALIZED=1` is a deliberate opt-in. TFCD (COPPA) stays
  off: the terms set 13+, so asserting child-directed would be inaccurate, not cautious.
- **A CMP (Google Funding Choices) is REQUIRED, not optional** — without a certified CMP
  Google serves EEA/UK/CH users no ads at all. It loads with the client id; the message
  itself is authored in the AdSense dashboard. The footer "Data" (was "Privacy & cookie settings")
  link must keep existing (consent you can't withdraw isn't consent).
- **Three ad units, each with its own slot id**: `menu` (shell pages) and `results`
  (post-match) are SAFE; `game` (columns flanking the live field) is the risky one —
  60 Hz canvas + AdSense's 150px game-clearance rule. **Do not enable
  `VITE_ADSENSE_SLOT_GAME` without first comparing p95 frame time via `?perf=1`**
  (`GameController.getFrameStats`).
- **`/ads.txt` is GENERATED** from `VITE_ADSENSE_CLIENT` in `vite.config.ts` — never
  commit one, it would drift.
- **Supporter tier is Ko-fi.** `server/kofi.ts` is a PURE policy module (no DB, no
  import-time env) deciding what a payment buys: a subscription payment is always
  exactly 1 month; a one-off buys `floor(amount/price)` months, capped; a foreign
  currency buys nothing. Months are priced ONCE at webhook time and stored on the row.
- **`profiles.kofi_email` is what makes a membership RENEW.** The first manual claim
  links the payer address; every later webhook from it grants automatically. The UNIQUE
  index is also the only thing stopping one subscription covering many accounts.
- **Every write to `supporter_until` logs a `supporter_grants` audit row** (source =
  kofi/admin/revoke). Two actors can move that column; "why does this account have a
  membership?" has to stay answerable.
- **Perks are cosmetic/convenience ONLY** — never anything affecting how a robot drives
  or scores. That is a product rule AND a statement in the terms. All four advertised
  perks are BUILT (badge, ads-off, 6 saved starts, and — since the cosmetics registry,
  `src/cosmetics.ts` — the six premium chassis colours, every accent, the four patterned
  decals, and the bold plate); **do not list a perk on the Donate page before it
  exists.**
- **The saved-start PERSIST cap is the SUPPORTER ceiling**
  (`MAX_SAVED_STARTS_SUPPORTER`), in `coerceSettings` AND `saveStart`. Only the editor's
  Save button applies the free cap. Sanitizing to the free cap would DELETE a supporter's
  poses before the entitlement resolved, and on every lapse.
- **The chassis colour is an ALLOWLIST key** (`CHASSIS_COLORS`), never a free colour
  string on the wire, and it recolours only the FILL — alliance identity is the OUTLINE.
- **`LobbyPlayer.supporter` is SERVER-AUTHORED** (set at join). `sanitizePlayer` is an
  allowlist and `PlayerPatch` is a `Pick`, so a client cannot self-declare a paid badge.
- **`LEGAL_VERSION` is DERIVED from `LEGAL_UPDATED`** (`legalVersionOf`), not written beside it:
  two hand-kept spellings of one date is how the version everybody re-accepts ends up disagreeing
  with the date on the page they are accepting. ⚠️ **Moving `LEGAL_UPDATED` prompts EVERY
  signed-in account to accept again, once** (`termsGateState`, `src/ui/TermsGate.tsx`) — that is
  the point of it, so move it for a material change and not for a typo. It is a CLIENT change AND
  a SERVER change (the accept route records the server’s own constant), so deploy both.
- ⚠️ **`LEGAL_OPERATOR`/`LEGAL_JURISDICTION` in `src/legalText.ts` are PLACEHOLDERS.**
  Until filled, the Terms page shows a visible warning to every visitor. Fill them
  before taking a payment; do not guess them from a timezone or an email domain.
- **FIRST-PARTY ANALYTICS — the admin console's Analytics tab.** DSIM measures itself now
  (`server/analytics.ts`, migration `0042`, `src/pageviews.ts`, `src/ui/AdminAnalytics.tsx`),
  and since September 2026 ONLY itself: the host's analytics script was dropped once the tab
  covered everything it showed. The first reason to build it was the thing a third party structurally
  cannot do is put traffic beside the PRODUCT tables — matches per game × mode × physics,
  signups, D1/D7/D30 retention, the ranked distribution, replay storage, moderation load,
  Ko-fi conversions. Every one of those is a query over tables that already existed; the
  feature added no column to any of them.
  - **COLLECTED, per page view**: the scrubbed path, the game, the referrer's HOST, the three
    UTM parameters, a two-letter country, device/OS/browser family, a screen BUCKET
    (`sm`/`md`/`lg`/`xl`), the primary language subtag, `web`/`electron`, the release channel
    and the build id. Named events land beside them with at most four bounded properties.
  - ⚠️ **NEVER COLLECTED, and this is a SCHEMA guarantee rather than a discipline**: no IP
    address, no full user agent, no account id, no exact viewport, no click or input. `dbtest`
    asserts against `information_schema` that no `analytics_*` table has such a column, because
    a column somebody adds later for a good reason is exactly how this would be lost.
  - **THE VISITOR KEY IS `sha256(daily salt || ip || ua || site)` truncated to 16 hex**, and
    the salt is DESTROYED at two days (`analytics_salt`). That deletion is the guarantee: past
    it, nobody can recompute yesterday's hash from an address. The consequence is stated on the
    dashboard and in the policy rather than hidden — **a visitor count over a range is a SUM OF
    DAILY UNIQUES**, and the same person on two days is two visitors. Sessions are DERIVED in
    SQL from a 30-minute gap; there is no session identifier to store.
  - **COUNTRY** comes from `fly-client-country` (or `cf-ipcountry` / `x-vercel-ip-country`)
    when the edge sets one, else from the browser's coarse IANA timezone mapped by a table in
    `server/analytics.ts`. The timezone string is used for that line and discarded. **Never a
    third-party geo-IP service.**
  - **SCRUBBING HAPPENS ON THE CLIENT**, in `normalizePath`: the query string goes
    unconditionally (`?token=` is how a password reset arrives) and `/replay/<id>`,
    `/profile/<name>` and room codes become placeholders, so an id never leaves the browser.
    `npm test` exercises the scrubbers headlessly, which is why `src/pageviews.ts` reads
    `import.meta.env` through a guard and reaches `net/env` by dynamic import.
  - **RETENTION**: raw rows 30 days, `analytics_hourly` 35 days, `analytics_daily` kept,
    `analytics_concurrency` 120 days, the salt 2 days. The rollup and the sweep run on a
    five-minute interval under `pg_try_advisory_lock`, so exactly one Fly machine does the
    work — and the interval is **started by the first beacon**, never at boot, because Neon
    bills the wall-clock time the compute is awake and an unconditional timer costs the month.
  - **GATES**: `VITE_ANALYTICS=1` **and** a configured cloud game server, plus
    `analyticsAllowed()` (the in-app switch). Browser `doNotTrack`/GPC do NOT gate it (owner,
    2026-09-25: count all traffic; no identifier, first-party only). A self-hosted, LAN or offline build sends
    nothing. The ingest route needs `DATABASE_URL` on the Fly side and nothing else.
  - **The dashboard is a LAZY chunk** and is gated on `isStaffUser` — `profiles.role`, the
    projection of `ADMIN_USER_IDS`, not a second env read. A range inside the raw window is
    exact and cross-filterable; one reaching further back is served from the daily rollups and
    the panel SAYS so rather than silently degrading. Events and their properties are rolled
    up too (`dim = 'event'` / `'evprop'`, val `name|key|value`), so a month-old sponsor report
    still breaks down by placement. The **Sponsor report** panel lays out `docs/sponsor.md`'s
    lines; the **Last month** range is the report period.
  - **VERCEL HISTORY IS FOLDED IN, ONE SOURCE PER DAY.** `analytics_imported` (0053) holds Vercel
    Web Analytics' daily aggregates from before it was removed, loaded by
    `scripts/vercel-analytics-export.mjs` + `scripts/import-vercel-analytics.ts` (dry run unless
    `--write`; replaces the file's days, so re-runs are safe; a preview export is stored as
    `vercel-preview`). Paths go through `normalizePath` on import. The READ decides, in
    `server/analytics.ts` (`importContext`, `importWindow`, `importMode`):
    - **The boundary is derived from the data.** `ownFirst` = the earliest day our own tables
      hold traffic on the import's channel (`vercel` = `stable`, `vercel-preview` = `alpha`). That
      day is partial (the pipeline was switched on during it), so if the import holds it too, ours
      starts the day after (`ownFrom`); if not, ours starts on it. Days before `ownFrom` are
      read from the import, days from it on from ours. **Imported rows on or after `ownFrom` are
      never read** — never a sum on the overlap. Loading overlapping days is harmless.
    - **Folded into** the tiles (views, visitors), the chart, every breakdown the import has
      (pages, referrers, countries, devices, OS, browsers, UTM if present; its "Others" row shows
      as "Other"), the channel and surface panels (imported rows count as `stable`/`alpha` +
      `web`), events and their properties, and so the sponsor report. Top N is taken AFTER the
      sum. Visitors are a sum of daily uniques on both sides.
    - **Ours alone:** sessions, bounce rate, session length, entry pages, screen, language, build,
      online now. The page says "from Sep N" beside them when the range reaches imported days.
    - **Filters:** a game pick leaves imported days out (no game split). A channel/surface chip
      keeps them if it names what they are, else leaves them out. ONE chip on a dimension the
      import has is answered from that breakdown's row (totals, chart, that panel); two such
      chips, or a chip on screen/language/build, leave them out. Events ignore chips on both
      sides. The note under the range says which applies (`history` in the response).
    - Imported days are whole UTC days: range ends round to the nearest midnight, and an hourly
      range that reaches them is returned by day (`grain`). The chart marks the boundary.
    - `imported` stays in the response as `null` so a pre-change admin page does not break.
  - **`LEGAL_UPDATED` moved to September 25, 2026** (owner) for first-party analytics, the host's
    count removed and browser DNT/GPC no longer gating it: every signed-in account accepts once.
- Analytics events (`src/analytics.ts`, `VITE_ANALYTICS=1`, cookieless, one sink: our own).
  **Rule: no identifiers in any event payload** — counts and enums only.
  It has an **OFF SWITCH**, `src/analyticsPref.ts`, read by `trackEvent` on EVERY call
  (not cached: it is an opt-OUT, so a second tab turning it off must stop a session already
  running). DEFAULT ON, and storage that THROWS answers on — failing closed would mute every
  locked-down browser and bias the numbers the sponsor report is read off. It lives in its own
  leaf module because `analytics.ts` reads `import.meta.env` at module scope and therefore
  cannot be imported from `scripts/smoke.ts` at all.

---

## Privacy: the storage registry, "Your data", and the export

Built on branch `feat/privacy-cookies` for roadmap item 8.

- ⚠️ **`src/storageKeys.ts` IS THE ONLY PLACE A `decodesim.` KEY MAY BE WRITTEN DOWN**, and
  `npm test` enforces exactly that: no such literal anywhere in `src/` outside that file
  (comments stripped), every storage call site naming its key by identifier or a documented
  `…Key(id)` accessor, every file touching storage importing from the registry, and no dead
  entries. It exists because `PRIVACY_MD` used to enumerate the keys in prose and had drifted
  to FOUR names that did not exist plus SEVEN keys missing — undetectable by reading, because
  the list and the code were different files.
- **`PRIVACY_MD` NAMES NO KEY, and must not start again.** It describes the three categories
  (`necessary` / `preference` / `analytics`) and points at the live table, which
  `src/ui/YourData.tsx` renders off `STORAGE_KEYS`. The `analytics` group is printed EMPTY
  on purpose: "none" is the most reassuring line on the page and it stays true by construction.
- **ONE LITERAL LIVES OUTSIDE THE REGISTRY**: `index.html`'s blocking theme stamp, which runs
  before any module loads. A smoke check pins it to `THEME_KEY`.
- ⚠️ **THE FOOTER CONSENT LINK MUST NEVER DELETE ITSELF.** `ConsentLink` used to `return null`
  once `showConsentSettings()` answered false — the NORMAL case outside the EEA/UK/CH — so the
  one control the privacy policy names by name vanished for most of the world. It now falls back
  to `/privacy#your-data`, where the row says why no dialog opened. A smoke check greps for the
  early return coming back.
- **`GET /api/user/export`** (`exportAccount` in `server/db/repo.ts`, written NEXT TO
  `deleteAccount` so a table added to one list and not the other is one screenful apart).
  Rate-limited to **one per minute per account** — seventeen queries on compute that bills by
  the minute. **Only rows keyed to the caller**, plus a match's own facts: the other players in
  a versus match are absent entirely, and `dbtest` asserts that against the SERIALIZED
  document, because the leak to fear is a join somebody adds later for a good reason. Replay
  BODIES are out (ids and metadata only); no email address is selected at all. A missing profile
  row is a **404**, which is what a just-deleted account gets.
- ⚠️ **AN OLD SERVER ANSWERS `/api/user/export` WITH A 200.** That path also matches the older
  build's `/api/user/<id>` profile route, which cheerfully reports a profile for the user id
  `"export"`. One Fly app serves every client version, so `fetchMyExport` guards on the
  payload (`format`), not on the status — handing that object to somebody as their personal
  data would be the worst failure this route has available to it.
- **`DeleteAccount` is ONE component rendered in two places** (Profile and "Your data"). The
  typed confirmation and the paragraph about what SURVIVES a deletion are the load-bearing
  parts; two copies of that copy would drift.

---

