# UI Phase 6 — Accessibility & contrast audit

**Status:** partially landed · **Blast radius:** `src/ui/shell.css`, `src/ui/styles.css`, a few `.tsx`
· **Sim:** untouched

Part of the low-poly UI redesign. Phase 1 inverted a dark theme to a light pastel one,
which invalidates every contrast assumption the old palette carried. This is the sweep.

---

## 1. What's already done

| Item | Where | Note |
|---|---|---|
| Responsive rail + sub-nav + tabs | `shell.css` `@media (max-width:900px)` | rail/sub-nav become horizontal scroll strips; `.rh`/`.sh` hints hidden |
| Reduced-motion gating | `shell.css`, `styles.css` | **duration alone is not enough** — the keycap `translateY` had to be zeroed explicitly, or the cap still snaps down |
| `--ds-mut` darkened | `shell.css:24` | DESIGN.md's `outline #707975` is **3.9:1** on the floor. Shipped `#5c645f` = 5.82:1 |
| `--ds-warn` split from the accent | `shell.css:73` | `--amber` meant *caution* in 4 places and *brand* in 12; collapsing both made warnings read as decoration |
| `--ds-on-field` | `shell.css:82` | the 3-2-1 countdown paints straight on the dark canvas with no card — charcoal ink would have erased it |
| `--ds-sky-ink` | `shell.css:44` | `#38bdf8` was 2.0:1 as text on white |
| Alliance chips → filled | `styles.css:205-215` | were 11.5px tinted text under 4.5:1 |
| Focus-visible group | `shell.css` | extended to `.ds-mark, .ds-menu-btn, .ds-rail-btn, .ds-rail-home, .ds-subnav-btn, .ds-tab, .ds-cta, .ds-opt` |

**What remains is everything below.**

---

## 2. Method

Contrast is computed on the WCAG 2.x relative-luminance formula. Thresholds:

- **1.4.3 body text** — 4.5:1. "Large" (≥24px, or ≥18.66px **bold**) relaxes to 3:1.
  Note most chips here are **11.5px bold**, which is *not* large. Bold does not help.
- **1.4.11 non-text** — 3:1 for the visual boundary of a UI component and for meaningful
  graphics, *unless* the component is inactive or the boundary is purely decorative.

Translucent surfaces are composited before measuring. The HUD's `--ds-hud`
(`rgba(255,255,255,.94)`) over a dark field (≈`#0e1116`) resolves to **`#f0f0f1`**;
`--ds-hud-soft` (.86) resolves to **`#ddddde`**. `opacity` on text multiplies against
whatever is behind it and is measured the same way.

Reproduce with `scripts/contrast.mjs` (§7).

### The palette, measured

Ink on the four surfaces — `bg #f9faf7` / `bar #f3f4f1` / `panel #fff` / `tile #edeeec`:

| Token | bg | bar | panel | tile | verdict |
|---|---|---|---|---|---|
| `--ds-ink` `#191c1b` | 16.39 | 15.55 | 17.17 | 14.75 | ✅ |
| `--ds-ink-dim` `#404945` | 8.88 | 8.43 | 9.30 | 7.99 | ✅ |
| `--ds-mut` `#5c645f` | 5.82 | 5.52 | 6.10 | 5.24 | ✅ |
| `--ds-accent` `#366758` | 6.19 | 5.87 | 6.49 | 5.57 | ✅ |
| `--ds-warn` `#8f5400` | 5.83 | 5.54 | 6.11 | 5.25 | ✅ |
| `--ds-danger` `#ba1a1a` | 6.17 | 5.85 | 6.46 | 5.55 | ✅ |
| `--ds-sky-ink` `#0e6f8e` | 5.44 | 5.16 | 5.70 | 4.90 | ✅ |
| **`--ds-ok` `#2f9e5f`** | **3.25** | **3.08** | **3.40** | **2.92** | ❌ **F1** |
| **`--ds-red` `#ff4d4d`** | 3.12 | 2.96 | 3.27 | 2.81 | ❌ as text |
| **`--ds-blue` `#3d8bff`** | 3.16 | 3.00 | 3.31 | 2.85 | ❌ as text |
| `--ds-green` `#37d67a` | 1.81 | — | 1.90 | — | fill only |
| `--ds-purple` `#a96bff` | 3.22 | 3.05 | 3.37 | 2.89 | ❌ as text |
| `--ds-line` `#c0c9c4` | 1.62 | 1.53 | 1.69 | 1.46 | ❌ as boundary — **F4** |

Ink on the pastel fills (all comfortably pass, no action):

| Fill | white ink | `--ds-ink` | `--ds-accent-soft-ink` `#1c4f41` |
|---|---|---|---|
| `--ds-accent` `#366758` | **6.49** ✅ | 2.65 | 1.44 |
| `--ds-accent-soft` `#b5ead7` | 1.34 | **12.85** ✅ | **7.00** ✅ |
| `--ds-blush` `#fdd9c0` | 1.32 | **12.97** ✅ | 7.07 |
| `--ds-sage` `#d6e4c0` | 1.34 | **12.85** ✅ | 7.00 |
| `--ds-lavender` `#c9c3f0` | 1.67 | **10.26** ✅ | 5.59 |
| `--ds-sky` `#b6dcf0` | 1.45 | **11.84** ✅ | 6.45 |

> The rule the palette already encodes: **a pastel is a fill, never type.** Its ink is
> `--ds-ink`, or a dedicated dark sibling. Keep it.

---

## 3. Findings

### F1 — `--ds-ok` repeats the `--amber` two-meanings bug · **high**

`--ds-ok #2f9e5f` is used as **both a fill and a text colour**, exactly the mistake that
forced `--ds-warn` to be split out of `--amber` in Phase 1.

As a fill it's fine. As text it is **3.25:1 on the floor, 2.99:1 on a HUD card,
2.92:1 on a tile** — it fails 4.5:1 everywhere it appears, and every site is small type.

| Site | Use | Measured | |
|---|---|---|---|
| `shell.css:1461` `.ds-season .dot` | fill | — | ✅ ok |
| `shell.css:2126` | fill | — | ✅ ok |
| `styles.css:326` `.pg-bar`/`.pg-fill` | fill | — | ✅ ok |
| `shell.css:2146` `.ds-chip.on` | **text** (12px) | 3.25 on bg | ❌ |
| `styles.css:218` `.chip.on` | **text** (11.5px) | 2.99 on HUD card | ❌ |
| `styles.css:1139` `@keyframes elo-flash-up` | **text** | 2.99 | ❌ |
| `styles.css:1167` `.elo-delta.up` | **text** | 2.99 | ❌ |

`.chip.on` is the HUD's **GATE OPEN** indicator and `.ds-chip.on` is the lobby's
**★ HOST** / **READY** badge. These are status, not decoration.

**Fix.** Add a text sibling and repoint the four text sites:

```css
--ds-ok: #2f9e5f;       /* FILL only — gauges, dots, bars */
--ds-ok-ink: #1f7a46;   /* TEXT — 5.10 bg · 4.69 HUD card · 4.59 tile */
```

`#1f7a46` clears 4.5:1 on all three grounds while staying recognisably the same green.
Leave the three fill sites on `--ds-ok`. Add a comment on the pair mirroring the
`--ds-warn` one, or this regresses the next time someone "simplifies" the tokens.

`.ds-chip.on`'s `border-color: color-mix(… var(--ds-ok) 55% …)` is a boundary, not text —
it may stay, but see **F4**.

### F2 — Alliance chips: white on saturated red/blue is 3.3:1 · **high**

Phase 1 fixed these by making them **fills with white ink** (`styles.css:205-215`), with
a comment saying it "clears AA". It does not, quite:

- white on `--ds-red #ff4d4d` = **3.27:1**
- white on `--ds-blue #3d8bff` = **3.31:1**

`.chip` type is **11.5px** — not large text — so the bar is 4.5:1. Both fail. (They pass
the 3:1 large-text bar, which is presumably where the original "clears AA" came from.)

Note the inversion: `--ds-ink` on those same fills scores **5.25** (red) and **5.18**
(blue) and *passes*. But charcoal on saturated alliance red reads muddy and undercuts the
"alliance colour commands attention" intent.

**Fix — pick one, and only for the CHIP:**

| Option | red | blue | trade-off |
|---|---|---|---|
| **(a)** deepen the chip fill: `--ds-red-chip #d32020`, `--ds-blue-chip #1f6fe0` | 5.25 | 4.76 | ✅ recommended. White ink, AA clear, still unmistakably alliance-coloured |
| (b) charcoal ink on the existing fill | 5.25 | 5.18 | passes; looks muddy |
| (c) bump `.chip` to 14px bold | — | — | still not "large" (needs 18.66px bold). **Does not fix it.** |

**Do not** change `--ds-red` / `--ds-blue` themselves. They are the alliance identity used
by `src/render/` on the dark field and by `.score-panel` gradients (white text on a *dark*
gradient there — that one is fine). Introduce chip-scoped tokens.

Also audit `.final-score.alliance-red` / `.alliance-blue` (`styles.css:597,601`) — large
display type, likely passes at 3:1, but confirm the actual `font-size`.

### F3 — `.ds-chip.red` / `.ds-chip.blue` / `--ds-purple` as text · **medium**

`shell.css:2142` sets `.ds-chip.blue { color: var(--ds-blue) }` (3.16:1) and there is a
matching `.red`. `--ds-purple` (3.22:1) is used the same way elsewhere. Same class of bug
as F1: a saturated hue used as small type on a light ground.

**Fix.** Either give each an `-ink` sibling (`#175cd3` = 5.71 · `#b3261e` = 6.24 ·
`#6b3fc4` = 6.40) or convert these chips to the filled treatment from F2. Prefer filled —
it matches the alliance chips and reuses one pattern.

### F4 — Control boundaries fail 1.4.11 · **medium**

`--ds-line #c0c9c4` scores **1.69:1 on panel**, **1.46 on tile**. For a *card* stroke
that's fine (decorative; the card is separated by fill and shadow anyway). For a **UI
component boundary** it isn't, and one control depends on it entirely:

`.ds-input` (`shell.css:1320`) is `background: var(--ds-tile) #edeeec` on a
`var(--ds-panel) #ffffff` card. Fill-vs-fill contrast is **1.16:1** — invisible. The 1px
`--ds-line` border **is** the field's only boundary, at 1.69:1 against the card.

Same reasoning applies to `.ds-select`, the `.ds-range` track, and unselected `.ds-opt`
cards.

**Fix.** Do not darken `--ds-line` globally — it strokes every card and the pastel look
depends on it staying soft. Add:

```css
--ds-line-strong: #8b9691;   /* 3.06:1 on panel — the 1.4.11 floor */
```

and use it only on interactive boundaries: `.ds-input`, `.ds-select`, the range track,
`.ds-opt` (unselected). Leave `.ds-panel`, `.ds-tile`, `.ds-stat` on `--ds-line`.

`#8b9691` clears 3:1 on `--ds-panel` (3.06) but lands at **2.63 on `--ds-tile`** and
**2.92 on `--ds-bg`**. Since `.ds-input`'s border is measured against the *card behind
it*, panel is the relevant ground and 3.06 is the number that matters — but if you place
a recessed input directly on `--ds-bg` or inside a `--ds-tile` well anywhere, it needs a
darker value (`#7d8883` ≈ 3.4 on bg). Check before assuming.

### F5 — `opacity` on status text · **medium**

Two chips dim their text with `opacity`, which multiplies the contrast down:

| Site | Declared | Effective |
|---|---|---|
| `styles.css:223` `.chip.off` | `--muted` @ **0.6** on HUD card | **2.45:1** ❌ |
| `shell.css:2151` `.ds-chip.off` | `--ds-mut` @ **0.7** on bg | **3.07:1** ❌ |

`.chip.off` is the HUD's **GATE CLOSED**; `.ds-chip.off` is the lobby's **NOT READY**.
Both are meaningful state, both fail 4.5:1. WCAG's "inactive component" exemption does
not apply — these aren't disabled controls, they're status readouts whose *content* is
the information.

**Fix.** Drop the `opacity` and express "off" with a distinct colour at full alpha, e.g.
`color: var(--ds-mut)` (5.82 bg / 5.36 HUD card) plus a lighter border. If the visual
hierarchy needs "off" to recede further, recede the **border and fill**, not the type.

Sweep the other sub-0.8 opacities on text while you're here — `shell.css:547, 703, 1575,
1605, 1964, 2077`, `styles.css:157, 639, 779, 907, 1359`, and the inline
`Matchmaking.tsx:271` (`opacity: 0.6` on "Checking who's online…") and
`Matchmaking.tsx:305` (0.75). Several are on genuinely decorative elements; check each,
don't bulk-edit.

### F6 — `role="tab"` without the rest of the pattern · **medium**

`Records.tsx:42-47` declares `role="tablist"`, `role="tab"`, `aria-selected` — and then
stops. There is no `role="tabpanel"`, no `aria-controls`, no `id` linkage, and no roving
`tabindex` / arrow-key handling.

A partial ARIA tab pattern is **worse than none**: a screen reader announces "tab, 1 of
2, selected", the user presses `→` expecting to move between tabs, and nothing happens.
Native buttons with no roles at least behave predictably under `Tab`.

**Fix — pick one:**

- **(a) Complete it.** Add `id`/`aria-controls`/`aria-labelledby` pairing, wrap each
  panel in `role="tabpanel"` with `tabIndex={0}`, and implement roving tabindex with
  `←`/`→`/`Home`/`End`. Per the APG tabs pattern.
- **(b) Remove the roles.** Keep the buttons plain, and keep `aria-current="page"` if the
  tabs change the URL — which they do (`/records` vs `/records/career`), so these are
  arguably **links**, not tabs. `Configure.tsx:50-55` already models this correctly with
  `<nav aria-label>` + `aria-current="page"`, and `Configure`'s sub-nav is the same kind
  of thing.

**(b) is recommended** — it makes `Records` consistent with `Configure` and `NavRail`,
which both already use `aria-current="page"` on URL-changing buttons. The tabs *are*
navigation.

### F7 — The game canvas is unlabelled and unannounced · **low (won't fix now)**

`GameView.tsx:111` renders a bare `<canvas>`. All match state — score, timer, gate,
penalties — is painted or lives in chips that never announce changes.

A blind-accessible driving sim is out of scope. But two cheap wins:

- Give the canvas `role="img"` + an `aria-label` describing the field, so it isn't an
  unlabelled interactive region. (`RobotPreview.tsx:116` already does exactly this.)
- Add `aria-live="polite"` to the event log (`.eventlog`) and `role="status"` to the
  timer's endgame warning. `ServerNoticeBanner.tsx:40` already uses `role="status"` —
  follow it.

Record the decision either way; an undocumented "we didn't try" is what audits punish.

---

## 4. Verified-OK (do not "fix")

- **Focus ring on a mint button.** `.ds-btn.primary` fills with `--ds-accent`, and the
  ring is `outline: 2px solid var(--ds-accent)`. It looks like mint-on-mint, but
  `outline-offset: 2px` places the ring on the **page background** (`--ds-bg`), where it
  scores **6.19:1**. Passes 1.4.11. Do not add a halo.
- **The dark field canvas.** `--ds-on-field #f9faf7` on `≈#0e1116` = **18.05:1**. The
  field staying dark under a light HUD is a deliberate product decision, not an oversight.
- **`--ds-accent-soft-ink` on `--ds-accent-soft`** = 7.00:1.
- **`.ds-block` / `.ds-edge` shadows.** Purely decorative depth; 1.4.11 exempts them.
- **`html lang="en"`** is set (`index.html:2`).

---

## 5. Token changes, consolidated

```css
:root {
  /* --- F1: --ds-ok is a FILL. Text needs its own, like --ds-warn vs --amber. --- */
  --ds-ok: #2f9e5f;          /* gauges, dots, bars */
  --ds-ok-ink: #1f7a46;      /* text: 5.10 bg · 4.69 hud-card · 4.59 tile */

  /* --- F2/F3: saturated identity hues are FILLS. These are their chip fills, deep
         enough for white ink at 11.5px. --ds-red/--ds-blue themselves are unchanged:
         src/render/ and .score-panel depend on them. --- */
  --ds-red-chip: #d32020;    /* white ink 5.25 */
  --ds-blue-chip: #1f6fe0;   /* white ink 4.76 */

  /* --- F4: interactive boundaries only (1.4.11 = 3:1). NOT for card strokes —
         --ds-line stays soft, the pastel look depends on it. --- */
  --ds-line-strong: #8b9691; /* 3.06 on --ds-panel */
}
```

Every one of these carries the same lesson, and it should be the comment at the top of
the palette:

> **A colour that is both a fill and a text colour will fail one of the two.**
> `--amber` did. `--ds-ok` does. Split it before you reuse it.

---

## 6. Ordering

1. **F1** (`--ds-ok-ink`) — 4 sites, mechanical, highest severity.
2. **F2** (alliance chips) — 2 sites; corrects a comment that currently asserts something
   false, which is worse than no comment.
3. **F5** (`opacity` on status) — 2 definite + a sweep.
4. **F3** (`.ds-chip` hues) — folds into F2's filled pattern.
5. **F4** (`--ds-line-strong`) — touches more selectors; visually the most conservative.
6. **F6** (Records tabs) — a `.tsx` change, independent of the palette.
7. **F7** — decide and document; implement the two cheap wins if time.

---

## 7. Verification

Add `scripts/contrast.mjs` — a standalone luminance checker that reads the token block
and asserts the pairs above. It has no deps and can run in CI:

```js
// usage: node scripts/contrast.mjs   → exits 1 on any regression
const lum = (h) => { /* WCAG relative luminance */ };
const cr  = (a, b) => { /* (L1+.05)/(L2+.05) */ };
const composite = (fg, alpha, bg) => { /* for --ds-hud, and any opacity on text */ };

// each entry: [label, ink, ground, floor]
const PAIRS = [
  ['chip.on / GATE OPEN',   '#1f7a46', '#f0f0f1', 4.5],  // hud card = white@.94 on field
  ['ds-chip.on / HOST',     '#1f7a46', '#f9faf7', 4.5],
  ['alliance-red chip',     '#ffffff', '#d32020', 4.5],
  ['alliance-blue chip',    '#ffffff', '#1f6fe0', 4.5],
  ['ds-input border',       '#8b9691', '#ffffff', 3.0],  // 1.4.11 non-text
  ['chip.off (no opacity)', '#5c645f', '#f0f0f1', 4.5],
  // …
];
```

Then:

```sh
export PATH="$HOME/.nvm/versions/node/v26.5.0/bin:$PATH"
node scripts/contrast.mjs
npm run build
npm test                 # ~205 sim checks — canary. Nothing here touches src/sim/
```

Visual regression: re-run `<scratchpad>/shiftaudit.cjs` (435 state changes, 10 routes +
the live HUD). Colour changes shouldn't shift layout — but `.chip.off` losing `opacity`
in favour of a border change *could*, so re-run it rather than assuming.

Manual, with real assistive tech:

- Tab through `/`, `/configure/robot`, `/records` — every stop must show a visible ring.
- macOS VoiceOver on `/records`: confirm the tab/link decision from **F6** announces
  sensibly.
- `System Settings → Accessibility → Reduce Motion` on, then hover a `.ds-btn`: the
  keycap must not translate. (Duration-only gating does **not** achieve this — the
  transform still applies instantly. The explicit `transform: none` override is why.)
- Force `prefers-contrast: more` and check nothing disappears. There is currently **no**
  `prefers-contrast` block; adding one is optional, but the pastel fills are the obvious
  candidate.

---

## 8. Non-goals

- WCAG AAA (7:1). The mint accent at 6.19:1 on the floor cannot reach it without
  abandoning the brand colour.
- Screen-reader-playable driving. See F7.
- Colour-blind alliance identity. Red/blue alliance is imposed by the FTC game, and the
  HUD already carries redundant text labels (`RED` / `BLUE`) alongside the fills, which
  is the right mitigation. Worth stating explicitly in the audit record so a reviewer
  doesn't flag it.
