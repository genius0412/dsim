# UI Phase 7 — Dark Mode

**Status: SHIPPED, then AMENDED by Phase 7b.** `npm run contrast` (**135** checks) +
`npm run build` + `npm test` + `npm run server:check` green; Electron-verified in both themes
(32 in-match DOM assertions + a live canvas pixel probe, + 38 probing the server-gated screens).

> ## ⚠️ §0 BELOW IS SUPERSEDED — the `.game-root` light island was DELETED
>
> Phase 7 kept the in-match HUD permanently light, reasoning that a dark card is 1.19:1 on the
> dark field. **The user overruled it** ("hud elements need to be themed dark also") and was
> right: that measures the FILL, but a floating card is identified by its **EDGE**. WCAG 1.4.11
> measures the boundary — the same argument the user had already accepted for the field mat,
> which separates from the dark letterbox by its outline alone at 1.03:1.
>
> What replaced it: `--ds-hud-line` (light `#c0c9c4` / dark `#727d86`) on every floating
> surface, and the legacy bridge now **aliases** the `--ds-*` tokens instead of holding pinned
> light values. A THIRD token category was introduced for text whose ground is the CANVAS
> (`--ds-on-field` / `-dim` / `-accent`), which is the part of §0's reasoning that survives:
> the field never themes, so *some* things must not. Just far fewer than an entire HUD.
>
> Read `HANDOFF.md` (Phase 7b) for the full list, including ~11 latent light-mode bugs the
> island had been hiding — among them a solo record-run total rendered **white on white**.
>
> §§1–9 below (storage, first paint, the palette, `system` resolution, Electron) are unchanged
> and still accurate.

**Where the control lives:** Configure ▸ **Audio and Visual** (the `audio` section, renamed;
the route key stays `/configure/audio` so old deep links work). Three toggle buttons —
System / Light / Dark. Storage is still D3's own `localStorage['decodesim.theme']`, NOT
`GameSettings` — UI placement and storage are independent.

**Corrections to this plan, all found by measuring:**

1. **§5's `--ds-line-strong: #6b7680` fails 1.4.11.** It was measured against `--ds-bg`
   (3.29), but an input's border sits on the **card behind it** — on `--ds-panel #272e35`
   it is **2.96**. Light mode tunes to panel too (3.06). Shipped **`#727d86`** (3.27 panel).
2. **§6's `Logo.tsx` finding is wrong.** The `<rect>` fills the whole 32×32 viewBox, so the
   `#14332a` strokes sit on the mint badge, never on `--ds-bar`. The mark is self-contained
   and needs no change. Confirmed by eye on the dark top bar.
3. **§6's `.ds-select` chevron: the `mask-image` it prefers is not available.** A `<select>`
   can't carry a `::after` to mask, and masking the element itself would eat its background.
   Shipped as a duplicated rule under `[data-theme='dark']`, kept adjacent to the light one.
4. **`--ds-panel-2` never existed** (`shell.css` `.server-row`) — it silently fell back to a
   3%-white wash from the pre-redesign dark theme, i.e. transparent on the light panel. A
   latent light-mode bug, now `--ds-tile`.
5. ~~**The `.game-root` light island is the real mechanism**~~ — **reverted in Phase 7b**
   (see the banner above). The part that held up: §4's bridge audit was too narrow, because
   `styles.css` reads ~20 `--ds-*` tokens directly, not just the four bridge names.
6. **The letterbox now DOES theme** (`COLORS.backdropDark`), which §10 listed as a non-goal.
   User decision: without it, entering a match from a dark menu flashed a bright screen. The
   FIELD itself is untouched (pixel-probed identical in both themes); only the surround moves,
   and the field's existing outline keeps the board separated from the dark floor.

**Blast radius (as built):** `src/ui/shell.css`, `src/ui/styles.css`, `index.html`,
`electron/main.cjs`, `src/main.tsx`, `src/ui/AudioSection.tsx`, `src/ui/Configure.tsx`,
new `src/theme.ts`, `scripts/contrast.mjs` — plus **`src/config.ts` + `src/render/renderer.ts`**
for the letterbox (see correction 6). `src/sim/` untouched.

---

## 0. ~~The mechanism that actually makes this work: the `.game-root` light island~~ (SUPERSEDED — see the banner at the top)

§4 said "audit which `var(--panel|--text|--muted|--border)` uses in `styles.css` are HUD".
The problem is **larger**: `styles.css` also reads ~20 `--ds-*` tokens directly
(`--ds-warn`, `--ds-ok-ink`, `--ds-accent-ink`, `--ds-ink-dim`, `--ds-tile`, …). Re-pointing
only the bridge would still have inverted all of those underneath the HUD — painting the
amber END GAME warning at ~2.4:1 on a white timer card.

The fix is one selector. The light palette block is declared by:

```css
:root,
:root[data-theme='dark'] .game-root { /* …the entire light palette… */ }

:root[data-theme='dark']            { /* …dark overrides… */ }
```

`:root[data-theme='dark'] .game-root` (0,2,1) outranks `:root[data-theme='dark']` (0,2,0),
so the in-match HUD re-establishes the **whole** light palette for its subtree. Every token
is covered because they all live in that one block — no per-token audit to keep in sync.

Consequences worth knowing:

- `.game-root` is `GameView`'s only wrapper. `ReplayView` draws the field but wears shell
  chrome (`.ds-replay-*`), so it themes normally. That is correct.
- **Never read `--ds-bg` from inside the game screen to decide the theme** — it is always
  `#f9faf7` there. `renderer.ts` reads `document.documentElement.dataset.theme` instead.
- The bridge (`--bg`, `--panel`, `--text`, …) is now **unshared** and stays pinned light:
  the only two non-HUD rules in `styles.css` (`.admin-*`, `.ds-btn.danger`) were moved onto
  `--ds-*` tokens. `body` was moved to `--ds-bg`/`--ds-ink` too (identical in light).

---

---

## 1. Read this first

`DESIGN.md` does not specify a dark theme. It specifies a *light* one — "a warm off-white
floor," "a fixed sun from the top-left," "deep-charcoal (never black) ink." Every structural
choice in `shell.css` follows from that: hard offset block shadows, keycap bottom edges,
recessed inputs carved into a lighter surface.

So this is not a token flip. Three things in the current design system are **direction-
dependent** — they encode "light behind, dark in front" — and each needs a real decision, not
a value swap:

1. **The block shadow** (`--ds-block: 4px 4px 0 var(--ds-line-soft)`). A hard offset shadow
   needs luminance headroom *below* the surface it falls on. On a near-black ground there is
   none. §3, D2.
2. **Every `*-ink` token.** `--ds-accent-ink: #ffffff` reads at 6.49:1 on the dark mint
   `#366758`. On a mint light enough to read against a dark ground (`#5fb597`) white lands at
   **2.46:1**. The ink must invert with the fill. §5.
3. **The HUD.** The field canvas is *always* dark (`renderer.ts:19`, `#14161a`) and
   `src/render/` is out of scope. Today's HUD cards composite to `#f1f1f1` — **16.04:1**
   against the field. A dark HUD card (`#20262c`) is **1.19:1**. There is no dark HUD that
   separates from the field on fill alone. §3, D1.

Everything else is genuinely mechanical, and one thing is better than expected: **37
`color-mix()` sites in `shell.css` re-derive themselves for free**, because they are all
expressed against `--ds-accent` / `--ds-panel` / `--ds-line` rather than literals.
`styles.css` has zero `color-mix` and will need more manual work per line.

---

## 2. Ground truth

Verified by reading the files, not assumed.

| Fact | Where | Consequence |
|---|---|---|
| Field canvas is hardcoded `#14161a` | `render/renderer.ts:19` | The field never themes. It is a fixed dark constant both modes must sit against. |
| `src/render/` has ~25 hardcoded colours | `drawField.ts`, `drawRobot.ts`, `drawBalls.ts`, `drawGoals.ts` | Out of scope. The field looks identical in both themes. |
| `styles.css:8-18` still declares the **old dark palette** as `:root` | `styles.css:8` | It is dead — `shell.css:96-108` (loaded second) overrides all 11 tokens. The bridge is the seam dark mode hooks. |
| `--ds-hud: rgba(255,255,255,.94)` | `shell.css:81` | Composites to `#f1f1f1` over the field. Five use sites in `styles.css` (`:124,176,191,273,357,458`). |
| 37 `color-mix()` in `shell.css`, **0** in `styles.css` | grep | Shell re-derives; HUD does not. |
| 18 hardcoded hex + 8 `rgba()` in `shell.css` outside `:root` | grep | §6 work list. |
| 24 hardcoded hex + 25 `rgba()` in `styles.css` | grep | §6 work list. Most are already-dark surfaces that stay. |
| No `prefers-color-scheme`, no `color-scheme`, no `<meta name="theme-color">` anywhere | grep across `src/ electron/ index.html public/` | All three need adding. |
| `.ds-app` / `.ds-console` are `overflow-y: scroll` (always-visible track) | `shell.css:122`, `:1397` | Without `color-scheme: dark` these render a **light scrollbar on a dark page**. This is a direct consequence of the scrollbar fix from the last session. |
| `GameSettings` is **synced to Postgres per account** | `server/db/migrations/0003_profile_settings.sql` | A theme pref must *not* live there. §7. |
| `electron/main.cjs:13` hardcodes `backgroundColor: '#f9faf7'` | with a comment saying it tracks `--ds-bg` | Will flash white before first paint in dark mode. §7. |
| The `.ds-select` chevron is a **url-encoded SVG with the literal `%235c645f`** | `shell.css:800` | `var()` does not work inside a `data:` URI. Must be swapped per theme. |
| `Logo.tsx` hardcodes `#14332a` strokes and a `#366758` gradient stop | `Logo.tsx:14,15,19,26` | The dark stroke disappears on a dark bar. |
| `styles.css:1370` — `.ds-btn.danger { color: #ff6b6b }` | a `ds-` rule stranded in `styles.css` | `#ff6b6b` is a *dark-mode* danger colour. On today's light panel it is ~2.6:1. **This is already a light-mode bug** — fold it into Phase 6. |

---

## 3. Decisions to make before writing any CSS

These are the ones I cannot make from the code.

### D1 — Does the HUD follow the theme? **Recommendation: no.**

The user's original theme-scope answers were "Everything, including the HUD" and "Keep the
field dark, HUD light." Those were answers about *light mode*. Read literally, the second one
already answers this question: the HUD is light because the **field** is dark, not because the
**app** is light. The field does not change. Neither should the HUD.

The numbers:

| HUD card fill | vs field `#14161a` |
|---|---|
| today, `--ds-hud` → `#f1f1f1` | **16.04:1** |
| dark card `#252b32` | 1.27:1 |
| dark card `#20262c` | 1.19:1 |
| dark card `#1c2127` | 1.12:1 |

A dark HUD loses ~13× its separation from the field, and the 1px stroke has to carry all of
it. To clear 3:1 against the *field* (WCAG 1.4.11, since `.game-btn` and the chips are
controls) the stroke must be `#6b7680` (3.91 vs field) — but that same stroke is only 3.49:1
against the card it borders, so it reads as a bright outline rather than an edge. It is doable
and it will not look like this design system.

Against that: the HUD's entire job is to be glanceable at 60fps while you are driving.

**If you take the recommendation**, the work in `styles.css` collapses to almost nothing — the
HUD tokens (`--ds-hud`, `--ds-hud-soft`, `--ds-on-field`) simply do not get dark variants, and
the bridge tokens (`--panel`, `--text`, `--muted`, `--border`) must **not** be re-pointed for
the HUD's benefit. That is a real complication, because the bridge is shared: see §4.

**If you reject it**, add these to the work list: `.hopper-pip` empty well (`styles.css:290`),
`.pg-bar` track (`:318`), `.overlay-panel` (`:490`, a dark card on a dark scrim), all five
`--ds-hud` sites, and a `--ds-hud-line` stroke token measured against the field.

### D2 — What happens to the block shadow? **Recommendation: keep the sun, raise the floor.**

The block shadow is the signature of the whole system. It reads at **1.34:1** today
(`--ds-bg #f9faf7` vs `--ds-line-soft #d9dad8`). That is all the separation a hard offset
shadow ever needs — it works because the shape is crisp, not because the contrast is high.

The trap is picking a fashionable near-black ground:

| `--ds-bg` | darkest possible shadow (`#000000`) |
|---|---|
| `#101317` | 1.13:1 — *shadow is invisible* |
| `#161a1f` | 1.20:1 |
| `#1c2127` | 1.30:1 |
| **`#20262c`** | **1.38:1** ← brackets the light-mode 1.34 |

So: set `--ds-bg: #20262c` and `--ds-line-soft: #04070a`, and the block shadow reads at
**1.32:1** — within 0.02 of light mode. The design language survives intact, the sun stays in
the top-left, and nothing about the shadow *rules* changes. Only the values.

The alternative (invert the sun: the offset block becomes a light rim) is a different visual
language and I do not recommend it — it turns extruded cards into embossed ones, and the
keycap `:active` press, which collapses a shadow, would instead have to collapse a highlight.

Note the pleasant side effect: `#20262c` is **lighter** than the field `#14161a` (1.19:1), so
the game canvas reads as a recessed well in the app surface. That is correct.

⚠️ `--ds-line-soft` is not shadow-only. It is also a **border** at `shell.css:918, 1804, 1851`
and a **grid pattern** at `:705-706`. `#04070a` as a border on `#20262c` is a black hairline —
probably fine, possibly too heavy. Check those four sites by eye; they may want `--ds-line`.

### D3 — Where does the preference live? **Recommendation: its own localStorage key.**

Not in `GameSettings`. Two reasons, both verified:

1. `GameSettings` is **round-tripped through Postgres per account**
   (`0003_profile_settings.sql`). A display preference should not follow you to another
   machine with a different monitor, and should not require being signed in.
2. `loadSettings()` is called from inside React, which mounts *after* first paint. A theme read
   from there guarantees a flash of the wrong theme. §7.

Use `localStorage['decodesim.theme']` holding `'system' | 'light' | 'dark'`, read by a
blocking inline script in `index.html`.

---

## 4. Mechanism

**Resolve `system` in JS, stamp the result, and let CSS see only two states.** Do *not* write
`@media (prefers-color-scheme: dark)` blocks — you would have to duplicate the entire dark
palette to let an explicit choice override the OS.

```html
<!-- index.html <head>, before the stylesheet link -->
<script>
  (function () {
    var p = 'light';
    try { p = localStorage.getItem('decodesim.theme') || 'system'; } catch (e) {}
    if (p === 'system') {
      p = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.dataset.theme = p;
  })();
</script>
```

`src/theme.ts` (new) owns the rest: read/write the key, `applyTheme(resolved)`, and — only
while the pref is `'system'` — a `matchMedia(...).addEventListener('change', …)` listener that
re-stamps. It must be removed when the pref stops being `'system'`.

Then in `shell.css`:

```css
:root { /* light — the existing block, unchanged */ }

:root[data-theme='dark'] {
  color-scheme: dark;   /* scrollbars, native <select> popups, range thumbs */
  /* … the dark values from §5 … */
}
```

`color-scheme` is load-bearing here, not a nicety — see §2 on `overflow-y: scroll`.

### The bridge is the sharp edge

`shell.css:96-108` re-points `styles.css`'s 11 un-prefixed tokens (`--bg`, `--panel`, `--text`,
`--muted`, `--border`, `--amber`, …). Those tokens drive **both** the in-match HUD *and* a few
stranded shell rules (`.ds-btn.danger` at `styles.css:1370`).

If D1 is "the HUD stays light," the bridge **cannot** simply be re-pointed dark, because
`--panel` / `--text` / `--muted` / `--border` are what the HUD cards are made of. The clean
move is to make the bridge *stop being shared*:

- Give the HUD its own explicit values (it is a fixed light-on-dark surface; it does not need
  indirection at all), and
- let `:root[data-theme='dark']` re-point the bridge freely for whatever non-HUD rules remain.

Concretely: audit which of the ~40 `var(--panel|--text|--muted|--border)` uses in `styles.css`
are HUD (`.chip`, `.timer-*`, `.robot-status`, `.hopper-pip`, `.power-gauge`, `.game-btn`,
`.eventlog`, `.breakdown-row`) versus overlay/results (`.overlay-panel`, `.score-table`,
`.elo-*`), and hardcode the HUD group against `--ds-hud`. **Do this audit before touching the
palette** — it is the only structural change in this phase, and getting it wrong makes the
timer illegible mid-match.

---

## 5. The dark palette

Candidates, not gospel — every ratio below is measured (WCAG 2.x relative luminance), but hue
and warmth are taste. Ratios are quoted against `--ds-bg #20262c` and `--ds-panel #272e35`.

### Surfaces

| Token | Light | Dark | Check |
|---|---|---|---|
| `--ds-bg` | `#f9faf7` | `#20262c` | 1.19 vs field — canvas reads recessed |
| `--ds-bar` | `#f3f4f1` | `#252b32` | 1.07 vs bg (light ref 1.05) |
| `--ds-panel` | `#ffffff` | `#272e35` | 1.11 vs bg |
| `--ds-tile` | `#edeeec` | `#1a2026` | 1.20 vs panel (light ref 1.16) — recessed is darker in **both** modes |
| `--ds-line` | `#c0c9c4` | `#404a52` | 1.69 vs bg (light ref 1.62) |
| `--ds-line-soft` | `#d9dad8` | `#04070a` | block shadow 1.32 vs bg (light ref 1.34) — see D2's warning |

### Ink

| Token | Light | Dark | bg / panel |
|---|---|---|---|
| `--ds-ink` | `#191c1b` | `#e8eae7` | 12.62 / 11.35 |
| `--ds-ink-dim` | `#404945` | `#b6bcb8` | 7.91 / 7.11 |
| `--ds-mut` | `#5c645f` | `#949e98` | 5.53 / 4.97 |

> `#8d9691` was the obvious mirror of `--ds-mut` but lands at **4.52** on `--ds-panel` — a
> rounding error from failing. `#949e98` is the safe pick. This is the same trap as light
> mode, where `DESIGN.md`'s `#707975` had to be darkened to `#5c645f`.

### Accent — **the inks invert**

| Token | Light | Dark | Check |
|---|---|---|---|
| `--ds-accent` | `#366758` | `#5fb597` | 6.21 bg / 5.59 panel |
| `--ds-accent-ink` | `#ffffff` | `#0f1214` | **7.65** on the fill. White would be 2.46 — the single most dangerous swap in this phase. |
| `--ds-accent-edge` | `#24463b` | `#3f7f69` | keycap edge stays *darker* than the fill in both modes |
| `--ds-accent-soft` | `#b5ead7` | `#22463c` | a mint-tinted dark, not a pale blob |
| `--ds-accent-soft-ink` | `#1c4f41` | `#8fdcc2` | 6.56 on the soft fill |
| `--ds-you` | `rgba(54,103,88,.1)` | `rgba(95,181,151,.14)` | alpha tint; re-hue to the light mint |

### Semantics — some fail, some are already fine

| Token | Light | on dark bg | Verdict |
|---|---|---|---|
| `--ds-warn` | `#8f5400` | **3.05** | **fails.** → `#e0a437` (6.93) |
| `--ds-danger` | `#ba1a1a` | **2.88** | **fails.** → `#f2857f` (6.14) |
| `--ds-sky-ink` | `#0e6f8e` | **3.27** | **fails.** → `#6ec8e8` (8.07) |
| `--ds-ok` | `#2f9e5f` | **4.49** | fails by 0.01 as text → `#4ec27f` (6.80) |
| `--ds-red` | `#ff4d4d` | 4.67 | keep (it is a fill; see below) |
| `--ds-blue` | `#3d8bff` | 4.61 | keep |
| `--ds-purple` | `#a96bff` | 4.53 | keep as fill; as *text* prefer `#bf8fff` (6.25) |
| `--ds-green` | `#37d67a` | high | keep |

Note the irony: `--ds-warn: #8f5400` is burnt amber precisely *because* Phase 1 had to darken
it for the light ground. Its dark-mode value is essentially the pre-redesign `--amber: #fbbf24`.

The pastels (`--ds-blush`, `--ds-sage`, `--ds-lavender`, `--ds-sky`) are **fills that carry
dark ink**. On a dark ground they are four bright rectangles. Either give each a tinted-dark
variant (`#22463c`-style, as `--ds-accent-soft` does) or drop their use in dark mode. Decide
per site; there are few.

### The rule this all follows

> **A token whose job is "readable against the surface" inverts. A token whose job is "a fill
> with fixed ink" does not.**

`--ds-ink`, `--ds-mut`, `--ds-accent`, `--ds-warn`, `--ds-danger`, `--ds-sky-ink`,
`--ds-ok-ink`, `--ds-line`, `--ds-line-strong` all invert. `--ds-red`, `--ds-blue`,
`--ds-green`, `--ds-red-chip`, `--ds-blue-chip` do not — white on `#d32020` is 5.25:1
regardless of what is behind the chip.

---

## 6. Site work list — the things tokens will not reach

**`shell.css`**

| Line | What | Action |
|---|---|---|
| `800` | `.ds-select` chevron, url-encoded `%235c645f` | `var()` is illegal inside `data:`. Duplicate the rule under `[data-theme='dark']` with `%23949e98`, or switch to a `mask-image` + `background-color: var(--ds-mut)`. **Prefer the mask** — one source of truth. |
| `805, 1328, 1351, 1744` | `inset 0 2px 0 rgba(25,28,27,.07)` — the recessed-input inner shadow | A 7%-black inset on a `#1a2026` tile is invisible. Tokenize as `--ds-inset` and give dark `rgba(0,0,0,.35)`. |
| `821, 851, 852` | `var(--ds-panel, #141c26)`, `var(--ds-line, rgba(255,255,255,.12))` | Dead fallbacks left over from the *old* dark theme. Delete — they will silently mislead the next reader into thinking dark is already handled. |
| `886-895` | `.ping-dot` `#22c55e / #eab308 / #f97316 / #6b7280` | Semantic signal colours; all read on both grounds. Keep. |
| `1108-1159` | `#f5a623` gold + `#04222a` badge ink (×5, podium/placement) | Gold reads at ~6.9 on the dark bg. Keep the gold, keep the dark ink on it. |
| `1284` | `rgba(6,10,15,.68)` modal scrim | Already dark. Keep. |
| `1298` | `box-shadow: 6px 6px 0 rgba(25,28,27,.28)` (`.ds-modal`) | An alpha-black block on a dark scrim ≈ nothing. Point at `--ds-line-soft`. |
| `1656, 1662` | alliance block shadows via `color-mix(… var(--ds-line-soft))` | Auto-adapt. No work. |
| `705-706, 918, 1804, 1851` | `--ds-line-soft` used as **grid pattern** and **border** | D2's warning. Re-check by eye once `--ds-line-soft` goes to `#04070a`. |

**`styles.css`** (assuming D1 = HUD stays light)

| Line | What | Action |
|---|---|---|
| `8-18` | the stale dark `:root` | Leave or delete, but do not "revive" it — it is the *old* cool-steel theme, not this one. |
| `88, 92, 598, 602, 646, 649` | `.score-panel` red/blue gradients | Already dark with white ink. No change. |
| `484, 860, 1228, 1293` | scrims and dark panels | No change. |
| `1151` | `.mobile-joystick-*` | Draws on the canvas. No change (this was already a Phase 1 rule). |
| `1370` | `.ds-btn.danger { color: #ff6b6b }` | **Pre-existing light-mode bug** (~2.6:1). Fix in Phase 6 as `--ds-danger`; it then inverts for free. |
| `709, 716-717, 831-837, 1168-1209, 1272-1281` | amber/sky/elo alpha tints | Only if D1 is rejected, or if these surfaces (results screens) are shell rather than HUD. Audit per §4. |

**`.tsx`**

| File | What | Action |
|---|---|---|
| `Logo.tsx:14,15,19,26` | `#14332a` strokes, `#366758` gradient stop | The stroke vanishes on a dark bar. Drive from `currentColor` + a `--ds-accent` stop, or accept a fixed light-on-dark mark. |
| `RobotPreview.tsx:133` | `#0c151d` mini-field | Stays dark by design; on a dark panel it loses its boundary. Give it a `--ds-line` stroke. |
| `GameView.tsx:25` | net-quality dot array | Semantic, and it renders over the field. Keep. |
| `AppShell.tsx` | — | Already fully tokenized (Phase 1). No hex remains. |

---

## 7. First paint, Electron, and the OS

**Web.** CSS is a `<link>` in the built HTML and React mounts after first paint, so the
`index.html` inline script from §4 is the only thing standing between the user and a white
flash. It must run *before* the stylesheet and must not import anything.

**`<meta name="theme-color">`** does not exist today. Add two, with `media` attributes, so the
mobile browser chrome matches.

**Electron.** `electron/main.cjs:13` sets `backgroundColor: '#f9faf7'` in the **main** process,
at `createWindow()` — which cannot read the renderer's `localStorage`. Two options:

- *Simple:* `require('electron').nativeTheme.shouldUseDarkColors ? '#20262c' : '#f9faf7'`.
  Correct whenever the pref is `'system'` (the default); mismatched for one frame if the user
  has forced a theme against their OS.
- *Correct:* have `src/theme.ts` write the resolved theme to a JSON file in
  `app.getPath('userData')` on every change, and read it in `createWindow()`. One extra IPC
  surface for one frame of polish.

Take the simple one unless the flash is visible in practice.

The `verify` skill drives the real Electron build — check the launch flash there, not in
`vite preview`, since `vite dev` injects CSS via JS and has a different first-paint story.

---

## 8. Ordering: Phase 6 must land first

Phase 6 introduces four tokens (`docs/ui-phase6-accessibility.md` §5). Re-measured against the
dark ground `#20262c`, they split cleanly:

| Phase 6 token | Purpose | On dark bg | Dark-mode action |
|---|---|---|---|
| `--ds-ok-ink: #1f7a46` | green **text** | **3.49** ✗ | re-value → `#4ec27f` |
| `--ds-line-strong: #8b9691` | control **borders** | 6.09 (a glaring hairline) | re-value → `#6b7680` (3.29 vs bg, clears 1.4.11) |
| `--ds-red-chip: #d32020` | **fill**, white ink | — | unchanged (white ink 5.25 either way) |
| `--ds-blue-chip: #1f6fe0` | **fill**, white ink | — | unchanged (white ink 4.76 either way) |

This is the §5 rule in miniature, and it is why the order matters: Phase 6 *creates* the
`fill` vs `ink` distinction that dark mode depends on. Doing dark mode first means splitting
`--ds-ok` twice, and it means shipping a dark theme whose green chips fail contrast in the
light theme you already had.

Phase 5 is independent — it moves JSX between scaffolds and touches no colour.

---

## 9. Verification

- `npm run build` (tsc strict + vite) and `npm test`. Smoke must stay green: **nothing here
  touches `src/sim/` or `src/config.ts`**, so a failure means the blast radius escaped.
- **Extend `scripts/contrast.mjs`** (proposed in Phase 6 §7) with a `THEMES` dimension: the
  `PAIRS` table becomes `theme × pair`, and every pair asserts in both. This is the only way
  the invariant in §5 stays true a year from now. It is dependency-free and CI-runnable.
- **Re-run `shiftaudit.cjs`** (scratchpad; 435 state changes across 10 routes + the live HUD →
  0 shifts). Dark mode must not change a single `border-width`, `font-weight`, or `padding`.
  If the audit reports a shift, a theme rule changed geometry — which is always a bug.
  Add `data-theme` stamping to the harness so it runs both themes.
- The `verify` skill (Electron) for: the launch flash (§7), the always-visible **scrollbar**
  colour (§2 — the single most likely thing to look broken), native `<select>` popups, and the
  in-match HUD over the dark field.
- By eye, in dark: the block shadow (D2), the four `--ds-line-soft` non-shadow sites, the
  `.ds-select` chevron, and `Logo.tsx` on `--ds-bar`.

---

## 10. Non-goals

- **The field canvas.** `src/render/` stays hardcoded dark. There is no light-mode field, and
  a light field would break the alliance/artifact colour semantics the game rules impose.
- **A third theme** (high-contrast, sepia, per-alliance). The `data-theme` mechanism admits
  one later; do not build for it now.
- **Theming `RobotPreview`'s mini-field or the score-panel gradients.** They are dark surfaces
  by design in both modes.
- **AAA contrast.** Same ceiling as Phase 6: the mint accent tops out around 6:1.
- **Syncing the pref across devices.** Explicitly rejected in D3.
