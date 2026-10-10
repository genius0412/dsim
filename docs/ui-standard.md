# DSIM UI standard

**This document is STRICT.** Every rule below is a MUST unless it says otherwise. If a rule
is wrong, change the rule here first and then change the code — do not make an exception in
a component. A standard with exceptions scattered through 60 files is what produced the
sprawl this document exists to end.

Read alongside CLAUDE.md's **THEMING** gotcha (colour) and its **UI COPY** section (wording).
Those are not repeated here; this covers geometry, type, anatomy, state and enforcement.

---

## 0. Why this exists — the measured starting point

Counted 2026-09-06 across `src/ui/*.css` and `src/ui/*.tsx`:

| | found | should be |
|---|---|---|
| spacing tokens | **0** | 7 |
| distinct CSS `gap` values | 10 (2,3,4,5,6,7,8,10,12,14) | 7 |
| distinct `font-size` values | **18**, incl. 9.5/10.5/11.5/12.5/13.5/14.5 | 6 |
| distinct `font-weight` values | 7 (400,500,600,700,750,800,900) | 4 |
| inline `marginTop` in JSX | **43**, across 10 values | 0 |
| inline spacing declarations in JSX | **105** | 0 |

Nothing here was decided by taste. Each scale below keeps the value the codebase already
uses most and drops the near-duplicates around it.

---

## 1. Non-negotiables

1. **No spacing, size or colour literal in JSX.** `style={{ marginTop: 12 }}` is banned
   outright. Spacing belongs to a class. There is no exception for "just this one".
2. **Every value comes from a token.** Spacing, radius, type, colour. A raw `px` in CSS is
   allowed only for borders (`1px`), and for geometry that is genuinely one-off and
   documented in a comment saying why.
3. **Every interactive element has `:hover`, `:active`, `:focus-visible` and `:disabled`.**
   The focus ring is ONE base rule in `shell.css`
   (`:where(button, a, summary, [tabindex]:not([tabindex='-1'])):focus-visible`, 2px
   `--ds-accent`, offset 2px), so a new control is ringed without writing one. The browser's
   own ring is NOT suppressed anywhere; the base rule replaces it. Write a `:focus-visible`
   only when the ring must differ: on the field (on-field tokens), on its own accent fill, or
   inset in a tight list. Never `outline: none` without a replacement. The two that exist
   have one: a dialog card focused by script (`[role='dialog'][tabindex='-1']`, not a target
   the user moved to) and `.ds-username-input .ds-input`, whose wrapper rings on
   `:focus-within`.
4. **No state change may move layout.** Pressed, hovered, selected, loading, error and empty
   states must not change an element's box. Use `transform`, `box-shadow` and colour.
   `npm run shiftaudit` enforces this; it is not advisory.
5. **A control explains itself or it is redesigned.** Helper text is not a fix for an unclear
   label. See §8.

---

## 2. Spacing — a 4px grid

```css
--ds-s-1:  4px;   /* hairline: icon↔label, chip internals            */
--ds-s-2:  8px;   /* tight: within a row, between sibling controls   */
--ds-s-3: 12px;   /* default: row↔row, label↔field                   */
--ds-s-4: 16px;   /* panel body padding, section internals           */
--ds-s-5: 24px;   /* section↔section                                 */
--ds-s-6: 32px;   /* page block↔block                                */
--ds-s-7: 48px;   /* page top/bottom margin                          */
```

- **2px is allowed only inside a chip or badge** (`--ds-s-0: 2px`), where 4 is visibly loose.
  Nowhere else.
- **BANNED: 3, 5, 6, 7, 9, 10, 11, 13, 14, 15, 18, 20px.** Round to the nearest token. `10 →
  8` when it separates things inside one component, `10 → 12` when it separates components.
- **The one sanctioned exception: the chrome's 14/18/22 layout rhythm** (owner ruling on the
  2026-09-22 design review, G1). It is the page gutters and the gaps between layout blocks,
  and only these: `.ds-bar` (`14px 22px`), `.ds-main` (`28px 22px 48px`), `.ds-rail`
  (`24px 14px 40px`), `.ds-foot` (`16px 22px`), `.ds-subnav-layout` and `.ds-console-in`
  (gap 22), `.ds-fields` (gap 18), `.ds-tiles`/`.ds-tile` (gap 14, `16px 18px`),
  `.ds-menu-btn` (`16px 18px`) and `.overlay-panel` (gap 14). It is kept because it is the
  most visible spacing in the app and it is consistent. Inside a component, the grid binds.
  A new layout shell may join the list only by being added to it here.
- **Padding is symmetric or it is on the grid.** `13px 15px` and `9px 11px` are banned. A
  horizontal/vertical difference is fine (`8px 12px`); an arbitrary one is not.
- **One owner per gap.** The space between stacked children belongs to the PARENT's `gap`,
  not to a margin on each child, and never to both. Adjacent-sibling margins
  (`.x + .x { margin-top }`) are allowed only where the parent cannot own the gap.
- **Panel body padding is `--ds-s-4`, always**, applied by a class. It is currently inlined
  as `style={{ padding: 16 }}` in several files; those are bugs, not style.

## 3. Type — seven sizes, two display clamps, seven weights

```css
--ds-t-xs: 11px;       /* eyebrows, mono labels, tick marks — the FLOOR, HUD included */
--ds-t-sm: 12px;       /* hints, sub-lines, table meta, ALL-CAPS panel titles        */
--ds-t-md: 13px;       /* body — the default                                         */
--ds-t-control: 14px;  /* buttons, inputs, tabs, table cells, Markdown body          */
--ds-t-lg: 15px;       /* emphasis                                                   */
--ds-t-xl: 20px;       /* dialog titles, sub-heads                                   */
--ds-t-2xl: 28px;      /* badge glyphs, reward headings                              */
--ds-t-h2: clamp(19px, 2.4vw, 24px);  /* .ds-h2                                      */
--ds-t-h1: clamp(26px, 4vw, 38px);    /* .ds-h1, .ds-title h1                        */

--ds-lh-tight: 1;      /* single-line UI           */
--ds-lh-heading: 1.2;  /* wrapped display type     */
--ds-lh-prose: 1.45;   /* paragraphs               */
--ds-lh-long: 1.65;    /* legal/Markdown at 68ch   */

--ds-track-tight: -0.015em; /* display headings    */
--ds-track-caps: 0.06em;    /* uppercase labels    */
```

Amended 2026-09-22 (design review C42) to match the code: 14px was the real control size
(110 live uses) and the h1/h2 rendered 38/24, not the 28/20 this table used to claim.
Nothing renders below `--ds-t-xs`: the 8–10px HUD and eyebrow labels were raised to it.

- **Weights: 400, 500, 600, 700, 750, 800, 900 — and no eighth.** Both families are
  VARIABLE cuts, which the `--ds-font-*` comment in `shell.css` `:root` documents, so
  half-steps like 750 are real type rather than a rounding accident, and 500 is a genuine de-emphasis. An earlier draft of
  this document banned 500/750/900 without reading that comment; the rule now guards
  against a NEW weight appearing instead of churning three deliberate ones.
- **No fractional PIXEL sizes.** 8.5, 9.5, 10.5, 11.5, 12.5, 13.5, 14.5, 15.5 and 16.5 were
  all in use; they are gone. If 11 is too big and 12 too small, the problem is the layout,
  not the type. Fractional `em` on rendered Markdown is fine — that is relative sizing, not
  a picked number.
- **Families are `--ds-font-ui` and `--ds-font-mono`.** There is no `--ds-font`; it never
  existed, and because an unresolvable `var()` in a `font:` shorthand voids the WHOLE
  declaration, thirteen rules silently set nothing for months. Grep a token before using it.
- **Prefer the longhands.** `font:` shorthand also resets `font-family` and `line-height`,
  which is how that bug stayed invisible.
- **Line height comes from a `--ds-lh-*` token**: `--ds-lh-tight` (1) for single-line UI,
  `--ds-lh-heading` (1.2) for wrapped display type, `--ds-lh-prose` (1.45) for paragraphs,
  `--ds-lh-long` (1.65) for legal/Markdown at a 68ch measure. `uiaudit`
  (`literal-line-height`) ratchets the literals that remain.
- **Big numbers are mono with tabular figures** (`.ds-num`, DESIGN.md Digits-Are-Mono).

## 4. Radius and borders

- Use `--ds-round-sm|--ds-round|--ds-round-md|--ds-round-lg|--ds-round-full`. **No literal
  radius.** Today 10px appears 14 times with no token; it rounds to `--ds-round-md`.
- Borders are `1px`. A "heavier" edge is a colour change, not a width change — a width
  change moves layout (§1.4).
- **One radius per component.** A card and the button inside it may differ; two buttons in
  the same row may not.

## 5. Colour

Governed by CLAUDE.md's THEMING gotcha — the three token categories, `--ds-hud-line` on
floating surfaces, category-3 tokens on anything drawn on the canvas. Additionally:

- **No hex, `rgb()` or `hsl()` literal in CSS or JSX.** Today's offenders are documented
  debt (§10), not precedent.
- **No `var(--token, #fallback)`.** A fallback hides a missing token: `--accent` was
  undefined for months and every site silently used its literal.
- `npm run contrast` must stay ALL PASS. A new colour pair means a new entry in
  `scripts/contrast.mjs`, not an untested colour.

## 6. Component anatomy

These skeletons are fixed. A screen that needs something else needs a discussion, not a
variant.

**Page** — `ds-eyebrow` → `ds-h1` → optional `ds-sub` → panels, `--ds-s-5` between panels.

**Panel** — `.ds-panel` > `.ds-panel-h` (title + optional action) > body at `--ds-s-4`.
The title is a **short noun phrase**, no trailing period, no full sentences. `.ds-panel-title`
RENDERS in ALL-CAPS mono (`text-transform: uppercase`, `--ds-mut`, 0.12em tracking), and that
is a sanctioned exception to sentence case (G3), the fifth beside the four in
`docs/area/ui.md`'s copy rules. Write the SOURCE text in sentence case ("Touch controls") so
it reads correctly to a screen reader and anywhere the transform does not apply. It may be an
`<h2>`: the class resets the margin and the heading weight.

**Row** — label left, value right, both vertically centred, `--ds-s-3` between rows. Values
in one column share an alignment and a format.

**Option grid** (`.ds-opts`/`.ds-opt`) — every tile in a grid is the **same height whether or
not it has a sub-line**. A grid that re-flows when one option gains a description is broken.

**Dialog** — title, body, actions last. The title is `.ds-dialog-title` (`--ds-t-xl`, sentence
case) on every shell dialog, `.ds-modal` included; the behaviour is `useDialog`
(`docs/area/ui.md`). **Primary action is rightmost, always.** Destructive
actions are `danger` and confirm; a confirm must name the target and the effect.

**List states** — every list has four: loading (`.ds-loading`), empty (`.ds-empty` with a
`.big` headline, no period, plus one sentence with one), error, and populated. **All four
share the same padding**, so the panel does not jump height when data lands.

## 7. Motion

- Transitions ≤ 150ms, and only on `transform`, `opacity`, `background`, `border-color`,
  `box-shadow`.
- `prefers-reduced-motion` must cap **`animation-iteration-count: 1`** as well as duration.
  Capping only the duration makes an infinite animation loop faster, not stop.
- No animation on first paint of a list or panel.
- **Named exception: the results reveal** (`Results.tsx`, the `.resx-*` keyframes in
  `styles.css`; design review 06-14). Its sections and rows land in sequence on first paint
  because the order carries information: the breakdown before the totals, the totals before
  the verdict. The allowance is the stagger, not the style. It settles on ease-out and never
  scales past 1 (the old overshoot and `brightness()` punches are gone), and under
  `prefers-reduced-motion` every element is one short cross-fade with the sting removed.

## 8. Copy

The wording rules are CLAUDE.md's **UI COPY** section. The one addition, which is stricter:

> **Descriptions are deleted, not shortened.** A sub-line, hint or tooltip must teach
> something the label cannot. If it restates the label, narrates what will happen, or
> reassures, it goes. "Free Drive" does not need a sentence explaining free driving.

Keep a blurb only where it names a real trade-off the user is choosing between — the robot
builder's drivetrain and archetype descriptions are the legitimate case, because picking
between them IS the task.

## 9. Enforcement

Before claiming UI work done:

```bash
npm run contrast && npm run build && npm run shiftaudit
```

And these must return nothing but comments:

```bash
grep -rnE "style=\{\{[^}]*(margin|padding|gap)" src/ui/*.tsx
grep -rnE "font-size: *[0-9]+\.[0-9]+px" src/ui/*.css
grep -rnE "font-weight: *[0-9]+" src/ui/*.css | grep -vE ": *(400|500|600|700|750|800|900)\b"
grep -rn "var(--[a-z-]*, *#" src/ui/*.css
```

`npm run uiaudit` runs these and more as a ratchet (`scripts/uiaudit.mjs`). Its zero-baseline
rules are hard errors. One of them, `font-inherit-mix`, flags a CSS-wide keyword (`inherit`,
`initial`, `unset`, `revert`) used inside a `font:` shorthand next to other values. Such a
keyword is only valid as the WHOLE value, so `font: 600 12px/1 inherit` is invalid and the
declaration is silently dropped: no weight, no size, no line-height. Write the longhands
instead. A bare `font: inherit` and `var(--x, inherit)` are both fine.

## 10. Known debt

Recorded so it is not mistaken for precedent. These predate the standard; **new code does not
get to match them.**

Re-counted 2026-09-23 by `npm run uiaudit` (the baselines are the live numbers):

- Inline spacing in JSX: **0** (was 105). Fractional sizes and stray weights: cleared.
- 117 off-grid gap/padding values (was 237), the chrome rhythm in §2 among them.
- 3 literal radii; 11 font sizes off the scale; 29 literal line-heights; 14 raw colours.
- The `:focus-visible` gap is closed: the base ring in §1.3 covers every button, link,
  summary and tabbable element, `button.ds-key` included, and `.game-btn` /
  `.overlay-buttons button` carry their own on-field rings.
- Deleted dead rule families: `.server-picker*`, `.server-row*`, `.ping-dot*`,
  `.final-score*`, `.ds-status`, `.ds-season*`, `.ds-kick`, and the pastel palette tokens.
- `styles.css` claims to be in-match-only; 2 `.ds-*` shell rules still live in it
  (`ds-outside-shell`).
