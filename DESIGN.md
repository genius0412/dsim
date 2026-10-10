---
name: DSIM
description: Driver-practice sim for FTC games (DECODE, Chain Reaction, BIOBUZZ) — a driver-station UI wrapped around a live scored match.
colors:
  bg: "#f9faf7"
  bar: "#f3f4f1"
  panel: "#ffffff"
  tile: "#edeeec"
  ink: "#191c1b"
  ink-dim: "#404945"
  mut: "#5c645f"
  line: "#c0c9c4"
  line-soft: "#d9dad8"
  line-strong: "#8b9691"
  accent: "#366758"
  accent-ink: "#ffffff"
  accent-edge: "#24463b"
  accent-soft: "#b5ead7"
  accent-soft-ink: "#1c4f41"
  accent-soft-mut: "#2f6455"
  staff: "#0e6f8e"
  staff-ink: "#ffffff"
  red-chip: "#d32020"
  blue-chip: "#1f6fe0"
  red-ink: "#b3261e"
  blue-ink: "#175cd3"
  purple-ink: "#6b3fc4"
  gold: "#f5a623"
  gold-ink: "#04222a"
  award: "#a96bff"
  award-ink: "#2a1065"
  podium-gold: "#e8b730"
  podium-silver: "#b9c3cd"
  podium-bronze: "#cd8a4f"
  podium-ink: "#221a08"
  blurple: "#5865f2"
  blurple-ink: "#ffffff"
  ok: "#2f9e5f"
  ok-ink: "#1f7a46"
  danger: "#ba1a1a"
  warn: "#8f5400"
  hud: "rgba(255, 255, 255, 0.94)"
  hud-soft: "rgba(255, 255, 255, 0.86)"
  hud-line: "#c0c9c4"
  on-field: "#f9faf7"
  on-field-dim: "#b9beb8"
  on-field-accent: "#5fb597"
  on-field-accent-ink: "#10241b"
  stage-bg: "#14171c"
  scrim: "rgba(10, 12, 16, 0.55)"
  scrim-strong: "rgba(8, 10, 14, 0.72)"
# [data-theme='dark'] overrides from src/ui/shell.css. Only the INVERTING tokens appear; the
# fixed-ink fills and the canvas-only on-field*/stage/scrim family are absent on purpose.
colorsDark:
  bg: "#20262c"
  bar: "#252b32"
  panel: "#272e35"
  tile: "#1a2026"
  ink: "#e8eae7"
  ink-dim: "#b6bcb8"
  mut: "#949e98"
  line: "#404a52"
  line-soft: "#04070a"
  line-strong: "#727d86"
  accent: "#5fb597"
  accent-ink: "#0f1214"
  accent-edge: "#3f7f69"
  accent-soft: "#22463c"
  accent-soft-ink: "#8fdcc2"
  accent-soft-mut: "#7cc0a8"
  staff: "#6ec8e8"
  staff-ink: "#0f1214"
  red-ink: "#ff9d96"
  blue-ink: "#8cb8ff"
  purple-ink: "#bf8fff"
  ok-ink: "#7bd35a"
  danger: "#f2857f"
  warn: "#e0a437"
  hud: "rgba(39, 46, 53, 0.94)"
  hud-soft: "rgba(39, 46, 53, 0.86)"
  hud-line: "#727d86"
typography:
  ui:
    fontFamily: "Plus Jakarta Sans Variable, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
  data:
    # a PROPORTIONAL grotesk set with tabular-nums, not a monospace; the token is still named
    # --ds-font-mono and its fallbacks are monospace faces
    fontFamily: "Space Grotesk Variable, ui-monospace, SF Mono, Menlo, Consolas, monospace"
rounded:
  sm: "4px"
  DEFAULT: "8px"
  md: "12px"
  lg: "16px"
  full: "9999px"
spacing:
  s-0: "2px"
  s-1: "4px"
  s-2: "8px"
  s-3: "12px"
  s-4: "16px"
  s-5: "24px"
  s-6: "32px"
  s-7: "48px"
  # the sanctioned chrome rhythm, off the 4px grid on purpose; where it applies is docs/ui-standard.md §2
  chrome: "14px / 18px / 22px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.DEFAULT}"
    padding: "8px 16px"
  button-secondary:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.DEFAULT}"
    padding: "8px 16px"
  button-small:
    rounded: "{rounded.sm}"
    padding: "4px 12px"
  chip:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    typography: "{typography.data}"
    rounded: "{rounded.full}"
    padding: "4px 12px"
---

# Design System: DSIM

## Overview

**Creative North Star: "The Driver Station"**

DSIM's chrome is built to feel like the physical control box a real FTC team stands behind during a match, not a generic web app shell. Every interactive surface reads as a keycap — a flat colored cap sitting on a slightly darker edge, sinking on hover and pressing flush on click via `transform`, never layout-shifting margin. Data that a driver would glance at mid-match (scores, timers, coordinates, ping) is set in a technical grotesk with tabular numerals; everything else — labels, menu copy, prose — is set in a rounded-geometric sans. The palette spends most of its area in quiet desaturated neutrals so that the two colors reserved for competition state — alliance red and alliance blue — read as genuinely alarming the instant they appear, the way a real field-control light does.

The system is explicitly **dual-theme** (light/dark, user-toggled, WCAG-audited both ways via `npm run contrast`) and explicitly **three-zone**: chrome surfaces invert between themes (ink-on-light becomes ink-on-dark), fixed-hue fills keep one ink regardless of theme (alliance chips, gold), and anything drawn on the game canvas itself uses a third, non-inverting family (`on-field*`) because the field mat is hardcoded dark in both themes. Confusing these three is the single most common contrast bug in this codebase — see the Colors Named Rule below.

Rejected direction: the original (July 2025) pastel "low-poly indie game" identity — mint/blush/lavender fills, no dark mode, single flat palette. That system is superseded, and its `--ds-blush`/`--ds-sage`/`--ds-lavender` tokens are deleted from the code (see Don'ts).

**Key Characteristics:**

- Flat "keycap" pressables — offset hard shadow, no blur in the chrome, moves via `transform`
- Data-face-for-numbers / sans-for-copy split, enforced per component
- Alliance red/blue are the only saturated, non-inverting accent — spend them like an alarm
- Dual-theme by design token, not by override; a color either inverts, stays fixed, or belongs to the canvas — never guess which

## Colors

Mostly quiet, warm-neutral surfaces; color is spent deliberately, not decoratively. The frontmatter lists every light value, and `colorsDark` lists every dark override (both from `src/ui/shell.css`).

### Primary

- **Driver Green** (`accent` #366758 light / #5fb597 dark): the one brand accent — primary buttons, links, focus rings, active states. Inverts between themes but stays saturated on both sides (deep green in light, mint in dark) so it never washes out. `accent-soft` is its selected-state fill, and `accent-soft-ink`/`accent-soft-mut` are the text on that fill.

### State / Alliance

- **Alliance Red** (`red-chip` #d32020) / **Alliance Blue** (`blue-chip` #1f6fe0): fixed-hue, fixed-ink fills reserved for red/blue alliance identity and win/loss framing. Never invert with theme — an alliance's color must mean the same thing in both themes. Filled, not tinted-text, so they clear contrast as a block of color. When alliance colour has to be TEXT, use the themed `red-ink`/`blue-ink`.
- **Signal Gold** (`gold` #f5a623, under `gold-ink`): the supporter mark and reward fills. It is fixed-ink. As TYPE, gold is under 2:1 on the light panel, so amber text uses `warn`.
- **Staff** (`staff` #0e6f8e light / #6ec8e8 dark, with `staff-ink`): the admin badge. It inverts like the accent and is distinct from both gold (supporter) and the green accent.
- **Award** (`award`, under `award-ink`): the season-award badge. It is a fixed fill in one saturated violet, and the rank is carried as a numeral. The podium gold/silver/bronze tokens are for the results podium only.
- **Status Green** (`ok`/`ok-ink`): "ready" / "on" states, distinct from the brand accent so a ready-chip and a primary button are never visually confused.
- **Danger / Warn** (`danger`, `warn`): destructive actions and caution states; `warn` is burnt amber in light, gold-adjacent in dark — a fill/text split, not a fixed hex.

### Canvas-only (`on-field` family)

- **On-Field** (#f9faf7) / **On-Field Dim** / **On-Field Accent** (#5fb597): the ONLY colors allowed on the game canvas itself. The field mat is hardcoded dark in both app themes, so canvas text/lines never invert with the UI theme — they're a closed, separate set. Never reach for `ink`/`mut`/`accent` when drawing on the canvas. `stage-bg` (the results screen) and `scrim`/`scrim-strong` (the veils over the field or behind a dialog) are in the same non-inverting zone.

### Neutral

- **Ink** (#191c1b light / #e8eae7 dark): primary text, inverts.
- **Mut** (#5c645f light / #949e98 dark): secondary/muted text, inverts, deliberately tuned to clear ~5.4:1 against the panel in both themes.
- **Line / Line Soft / Line Strong**: border hierarchy from barely-there dividers to emphasized card edges. `line-soft` doubles as the keycap's drop-shadow color, which is why it goes near-black in dark mode rather than staying a pale gray.
- **Panel / Bar / Tile / Bg**: surface layering from the page background up through the top bar, cards, and recessed tiles (a "tile" sits darker than its panel in both themes — recession is a lightness relationship, not a fixed color).

### Named Rules

**The Three-Zone Rule.** Every color token belongs to exactly one of three zones: *inverting* (reads against a themed surface — most of `ink`/`mut`/`accent`/`warn`), *fixed-ink* (a filled chip whose hue must mean the same thing regardless of theme — alliance red/blue, gold), or *canvas-only* (`on-field*`, because the field mat never themes). Reach for the wrong zone and the color either disappears in dark mode or silently changes what it signals.
**The Fill-Is-Not-Text Rule.** A color that works as a solid fill and a color that works as text on a surface are not the same token. Category collisions (`--ds-ok` doing both) are split into a fill token and an `-ink` sibling (`--ds-ok`/`--ds-ok-ink`).

## Typography

**UI Font:** Plus Jakarta Sans Variable (with system-ui, -apple-system, Segoe UI, Roboto fallbacks)
**Data Font:** Space Grotesk Variable (with ui-monospace, SF Mono, Menlo, Consolas fallbacks)

**Character:** A rounded, friendly geometric sans for everything a driver reads as language, paired with a squared-off technical grotesk for everything they read as a number — the same split a real telemetry dashboard makes, not a stylistic flourish. Space Grotesk is a PROPORTIONAL display/data face, not a monospace. Its token is still named `--ds-font-mono` and its fallbacks are monospace faces, but the fixed-width digits come from `tabular-nums`, not from the face itself.

### Hierarchy

- **Body** (Plus Jakarta Sans, 400–600): menu copy, labels, descriptions, buttons.
- **Data** (Space Grotesk, tabular-nums): scores, timers, coordinates, ping, any live-updating number. The tabular numerals keep digits from reflowing their neighbors as they change. The same face also sets the small ALL-CAPS labels (chips, badges, `.ds-panel-title`).
- The type scale (`--ds-t-*`), line heights and tracking are in `docs/ui-standard.md` §3.

### Named Rules

**The Digits-Are-Tabular Rule.** Any number that updates during a match (score, clock, RTT) renders in `--ds-font-mono` with `font-variant-numeric: tabular-nums`. A body-font number that ticks is a tell that it was bolted on rather than designed as telemetry.
**Sentence case.** Buttons, headings and tiles are sentence case. The sanctioned ALL-CAPS exceptions are listed in `docs/area/ui.md`, and `.ds-panel-title` is one of them: CSS renders it ALL-CAPS mono, while its source text stays sentence case.

## Layout

Spacing runs on a **4px grid**: the `--ds-s-0..7` tokens (2/4/8/12/16/24/32/48px). Alongside it, one **sanctioned chrome rhythm** of 14/18/22px sets the app shell's own padding and gaps: the bar, main column, rail, footer, the home tiles and menu buttons, and the field grids. That list is exact and lives in `docs/ui-standard.md` §2. Anything not on the list takes the grid, and `npm run uiaudit` ratchets the off-grid count. Panels and forms are flex-based, not a fixed column grid; field rows wrap via `flex: 1 1 150px`. The HUD reserves top/bottom bands (`HUD_TOP`/`HUD_BOTTOM` on the canvas, `--hud-bottom` in CSS) so chips and score bars never overlap the field regardless of viewport. The phone layout and the `(pointer: coarse)` touch-target rules are in `docs/area/ui.md`.

## Elevation & Depth

Flat by default, with a hard-edged "block" shadow standing in for real elevation. Three vocabularies:

- **Block** (`--ds-block` / `--ds-block-sm`, `4px 4px 0` / `2px 2px 0` in `line-soft`): the resting shadow under panels and cards — a flat offset, not a diffuse glow.
- **Edge** (`--ds-edge` / `--ds-edge-soft`, `0 3px 0`): the keycap's own "thickness" — a solid-color rim that a pressable sinks into on click.
- **Inset** (`box-shadow: inset 0 2px 0 var(--ds-inset)`): recessed fields (inputs) read as carved into the surface rather than sitting on it.

### Named Rules

**The No-Blur Rule — chrome only.** No CHROME surface uses a soft or blurred shadow. Depth comes from hard offset shadows (block, edge) or insets, never a `box-shadow` blur radius > 0, which reads as generic-web rather than driver-station hardware. Things that float ON THE CANVAS are exempt, because they have to separate from an arbitrary, moving field:
- the touch controls (`.mobile-btn`, `.mobile-joystick-handle`) have a soft drop shadow;
- the countdown digits have a text shadow;
- the match `.overlay` and the ranked `.intro-overlay` blur the field behind their scrim (`backdrop-filter`).

**The Transform-Only Press Rule.** A pressable element must move via `transform`, never `margin` or `border`-width changes, so nothing in its neighborhood reflows on hover/press (enforced by `npm run shiftaudit`).

## Shapes

Corners run a small defined scale: `--ds-round-sm` / `--ds-round` / `--ds-round-md` / `--ds-round-lg` at 4 / 8 / 12 / 16px, plus `--ds-round-full` (9999px). There is no 24px radius.

- **Pills are the keycap shape.** The home menu's `.ds-menu-btn`, `.ds-home-link` and `.ds-cta` are full pills, and so are chips and badges.
- The workhorse controls are 8px: `.ds-btn`, `.ds-seg`, `.ds-input` and `.ds-panel`.
- Compact controls step down to 4px: `.ds-btn.small`, and `.ds-key`, the literal keyboard cap shown in hints.
- `.ds-modal` is 12px.

There are no sharp (0px) corners anywhere in the chrome.

## Components

### Buttons (`.ds-btn`)

- **Shape:** 8px radius, 1px border, `8px 16px` padding. The `.small` variant has a 4px radius and `4px 12px` padding.
- **Default:** panel background, ink text, `edge-soft` shadow.
- **Primary:** accent fill, accent-ink text, no border, `edge` shadow (the accent-colored keycap edge).
- **Ghost:** no fill, no shadow, no press-transform — a flat text action, not a keycap.
- **Hover / Press:** sinks 1px on hover, 3px (flush with its own edge) on press, via `transform` only; disabled drops to 0.5 opacity and never presses.

### Chips (`.ds-chip`) and badges (`.ds-badge`)

- **Chip style:** full pill, data face, panel background, 1px border, `4px 12px` padding.
- **Alliance variants:** filled solid (`red-chip`/`blue-chip`) with white text — identity is the fill, not a tint, because the raw hue alone doesn't clear contrast as small text.
- **Status variants (`.on`/`.off`):** text-carries-the-meaning, not opacity-fade — an "off" chip stays full-alpha and recedes through border+fill instead of dimming (dimming a status reads as disabled, and this isn't disabled, it's just not-ready).
- **`.ds-badge`:** the one inline status tag. It is a neutral pill on `tile`, and its tones colour only the text and the edge. See `docs/area/ui.md`.

### Selected states

Selection has one vocabulary, written down in the comment above `.ds-rail-btn.on` in `shell.css`:

- **Latched nav** ("you are here": `.ds-rail-btn.on`, `.ds-subnav-btn.on`): soft fill and an accent border, flat.
- **Option card** (`.ds-opt.on`): the same, plus the keycap's accent-edge shadow.
- **Segmented** (`.ds-seg.on`): solid accent fill.
- **Tab** (`.ds-tab.on`): accent ink and an underline.
- **Toggle key** (`.game-btn.on`): solid accent fill, held flush on its edge.
- **Recommended** (`.ds-tile.primary`) is NOT a selection. It is the ordinary tile with an accent edge and a kicker.

### Cards / Panels (`.ds-panel`)

- **Corner Style:** 8px.
- **Background:** `panel`.
- **Shadow Strategy:** `--ds-block` (flat 4px offset, no blur).
- **Border:** 1px `line`.
- **Internal Padding:** `12px 16px` in the header (`.ds-panel-h`) and 16px in the body (`.ds-panel-body`).
- **Title:** `.ds-panel-title` is ALL-CAPS mono, a sanctioned exception to sentence case. It may be an `h2`.
- The career tiles are hidden until the player has played a match or holds a best, because a row of zeros tells a new player nothing.

### Inputs (`.ds-input`)

- **Style:** panel-toned but visually recessed via an inset top shadow (`inset 0 2px 0 var(--ds-inset)`), with a `line-strong` border because the border IS the control.
- **Focus:** a 2px `accent` outline at a 1px offset. The border goes transparent under it.

### Home

- The home screen reads DSIM, then the sponsor line, then the game switcher. Under the switcher sits ONE muted season line (`.ds-home-season`: full season name · program years). See `docs/area/sponsor.md`.

### HUD (game-screen chrome)

- **Style:** semi-opaque `hud`/`hud-soft` panels (94%/86% alpha) over the field, edged with `hud-line` — never `line`, which is tuned against `panel` and drops below 3:1 on the translucent HUD card.
- **Placement:** red|timer|blue bar pinned to the bottom, mirroring a real FTC field-control display; muted event log at the left edge; zone-status chips top-right. No popup toasts over the live field.
- **Ghosted assists** (touch controls whose auto-assist is on) stay ghosted. The ghosting is carried by the fill, the ring and the glyph, never by opacity on the button, so the label keeps its full on-field ink.

## Do's and Don'ts

### Do:

- **Do** keep every new color token in exactly one zone — inverting, fixed-ink, or canvas-only (see the Three-Zone Rule) — and name which zone it's in when you add it.
- **Do** use `--ds-hud-line` (not `--ds-line`) for any border drawn on a floating HUD card over the field.
- **Do** move pressables with `transform`/`box-shadow` only; run `npm run shiftaudit` after touching any interactive element's hover/active state.
- **Do** run `npm run contrast` after any token edit. It runs 393 checks across light and dark, and every one must stay AA.
- **Do** set live-updating numbers in `--ds-font-mono` with tabular numerals.
- **Do** read `docs/ui-standard.md` before touching a component; `npm run uiaudit` enforces it.

### Don't:

- **Don't** revive `--ds-blush`, `--ds-sage`, or `--ds-lavender`. They were the pre-dark-mode pastel identity and are deleted. `--ds-lavender` specifically failed the "reads as an object against its own panel" test in dark mode and was rejected for the staff badge, which is `--ds-staff` now.
- **Don't** add a blurred `box-shadow` anywhere in the chrome. This system has no soft-shadow vocabulary, so use `--ds-block`/`--ds-edge`/inset instead. Controls floating on the canvas are the one exemption (see No-Blur).
- **Don't** tint alliance identity with text color alone — red/blue alliance meaning is carried by a filled chip, not a colored label.
- **Don't** use `--ds-ink`/`--ds-mut`/`--ds-accent` for anything drawn directly on the game canvas — use the `on-field*` family, which deliberately does not invert with the app theme.
