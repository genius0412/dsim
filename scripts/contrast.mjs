// WCAG 2.x contrast checker for the low-poly palette. No deps; exits 1 on regression.
//   usage: node scripts/contrast.mjs [--list]
//
// Reads the REAL token values out of src/ui/shell.css — both the light `:root` block and
// the `:root[data-theme='dark']` overrides — so a token edit that breaks a documented
// pair fails here instead of in an audit.
// See docs/ui-phase6-accessibility.md and docs/ui-phase7-dark-mode.md.
//
// Two rules this file exists to defend:
//   1. A colour that is both a fill and a text colour will fail one of the two.
//   2. A token whose job is "readable against the surface" INVERTS with the theme.
//      A token whose job is "a fill with fixed ink" does NOT.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------- colour maths (WCAG 2.x relative luminance) ---------- */

const hex = (h) => {
  const s = h.trim().replace('#', '');
  const f = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16));
};

const lum = (h) => {
  const [r, g, b] = hex(h).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const cr = (a, b) => {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};

const to = (n) => Math.round(n).toString(16).padStart(2, '0');

/** composite `fg` at `alpha` over `bg` — for --ds-hud, and for any `opacity` on text.
 *  `opacity` does not create a new colour; it blends toward whatever is behind. */
const composite = (fg, alpha, bg) => {
  const [a, b] = [hex(fg), hex(bg)];
  return '#' + a.map((v, i) => to(v * alpha + b[i] * (1 - alpha))).join('');
};

/* ---------- tokens, read from source ---------- */

const css = readFileSync(join(root, 'src/ui/shell.css'), 'utf8');

const parseBlock = (re, label) => {
  const m = css.match(re);
  if (!m) throw new Error(`could not find the ${label} token block in shell.css`);
  const out = {};
  for (const [, k, v] of m[1].matchAll(/(--ds-[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[k] = v.trim();
  return out;
};

// The FIRST `:root {` block is the light palette (the later ones are --ds-inset and the
// legacy bridge, which holds no --ds-* declarations, so a stray match would be harmless).
const LIGHT = parseBlock(/\n:root \{([\s\S]*?)\n\}/, 'light');
// Only the PALETTE block, not `:root[data-theme='dark'] .ds-select` (note the `\s*\{`).
const DARK = { ...LIGHT, ...parseBlock(/:root\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/, 'dark') };

const getter = (table, themeName) => (name) => {
  const v = table[name];
  if (!v) throw new Error(`token ${name} not found in the ${themeName} palette`);
  return v;
};

/* ---------- grounds ---------- */

// The canvas, which NEVER themes (src/render/, src/config.ts COLORS).
const FIELD = '#14161a'; // the dark tiles the robots drive on
const MAT = '#23262b'; // COLORS.mat, the lightest thing a HUD card can sit on
const TILE = '#2c3038'; // COLORS.tile, the lightest ground an on-field LABEL crosses
/**
 * ⚠️ **THE 3D MAT IS ITS OWN GROUND, AND IT IS MUCH LIGHTER THAN THE 2D ONE.**
 * `TILE_MAT` (`games/biobuzz/scene/renderTiles.ts`) — a real FTC tile is grey EVA foam
 * (AndyMark am-2499, spec “Gray”), not the near-black the 2D board uses, so the 3D field was
 * lifted to one. `COLORS.mat`/`COLORS.tile` above are UNCHANGED: those are the 2D canvas
 * board for all three games, and repainting DECODE's was never the ask.
 *
 * This constant exists so the lift cannot go further without the suite saying so. The
 * binding pair is `--ds-on-field-dim` — canvas text over the field — which at #585858 read
 * 3.77 and was backed out for it; #454545 is the lightest grey where every on-field TEXT
 * token still clears AA.
 */
const TILE3D = '#454545';
/* `TILE_LINE`, the seam's light lip — LIGHTER than the mat, so it is the tighter cap of the
   two and it is measured on its own. #565656 read 3.89 here and was backed out for it. */
const TILE3D_LIP = '#4c4c4c';
const BACKDROP = '#f9faf7'; // COLORS.backdrop — the LIGHT letterbox a far-wall robot's label lands on
// the driver-name labels over remote robots (src/render/renderer.ts, COLORS.*Label)
const LABEL_RED = '#f87171';
const LABEL_BLUE = '#60a5fa';
// their outline, composited over each of the two grounds it has to work on
/**
 * ⚠️ **THE LABEL STROKE IS OPAQUE SINCE 2026-09-21, AND THAT IS WHY IT IS NO LONGER A
 * COMPOSITE.** At `rgba(20,22,26,0.8)` the ground showed through the halo, so a glyph's
 * effective surround was part stroke and part FIELD — which is why the fill had to be
 * measured against the lightest ground a label crosses, and why that pair was the ceiling on
 * how light the field could ever be. Opaque, the halo is a known colour under every glyph
 * whatever it is over, so the governing pair is fill-against-stroke and it does not move when
 * the field does. `render/renderer.ts`'s `LABEL_STROKE` carries the same note.
 */
const LABEL_STROKE_SOLID = '#14161a';
const LABEL_STROKE_ON_TILE = LABEL_STROKE_SOLID;
const LABEL_STROKE_ON_BACKDROP = LABEL_STROKE_SOLID;
// the ranked-intro scrim, and the results/net scrim: dark in BOTH themes
const INTRO_SCRIM = composite('#080a0e', 0.72, FIELD);

/** `rgba(r, g, b, a)` → ['#rrggbb', a]. --ds-hud is translucent, so its real colour
 *  depends on what is behind it, and that is the canvas rather than a themed surface. */
const rgba = (v) => {
  const [r, g, b, a] = v.match(/[\d.]+/g).map(Number);
  return ['#' + [r, g, b].map(to).join(''), a];
};

/** The HUD card composited over its WORST-CASE ground — which is the mat in both
 *  themes: it is the darkest backing for light mode's translucent WHITE card, and the
 *  lightest backing for dark mode's translucent CHARCOAL one. */
const hudCard = (t, token) => {
  const [c, a] = rgba(t(token));
  return composite(c, a, MAT);
};

const AA = 4.5; // 1.4.3 body text (<24px, or <18.66px bold)
const NON_TEXT = 3.0; // 1.4.11 component boundary / meaningful graphic

/* ---------- pairs asserted in EVERY theme ---------- */

/** @param t token getter for the theme under test */
const themedPairs = (t) => {
  const bg = t('--ds-bg');
  const bar = t('--ds-bar');
  const panel = t('--ds-panel');
  const tile = t('--ds-tile');
  return [
    // ink on the four surfaces
    ['--ds-ink on bg', t('--ds-ink'), bg, AA],
    ['--ds-ink on panel', t('--ds-ink'), panel, AA],
    ['--ds-ink-dim on bg', t('--ds-ink-dim'), bg, AA],
    ['--ds-mut on bg', t('--ds-mut'), bg, AA],
    ['--ds-mut on panel', t('--ds-mut'), panel, AA],
    ['--ds-mut on tile', t('--ds-mut'), tile, AA],
    ['--ds-mut on bar', t('--ds-mut'), bar, AA],
    // Select.tsx's listbox trigger button: --ds-ink text on the same --ds-tile
    // "recessed well" .ds-select already used, never explicitly asserted before.
    ['--ds-ink on tile (listbox button)', t('--ds-ink'), tile, AA],

    // semantics that must stay READABLE — these invert
    ['--ds-accent on bg', t('--ds-accent'), bg, AA],
    ['--ds-warn on bg', t('--ds-warn'), bg, AA],
    ['--ds-danger on bg', t('--ds-danger'), bg, AA],
    ['--ds-danger on panel', t('--ds-danger'), panel, AA], // .ds-btn.danger (Admin)
    ['--ds-ok-ink on bg', t('--ds-ok-ink'), bg, AA],
    ['--ds-ok-ink on tile', t('--ds-ok-ink'), tile, AA],
    ['--ds-red-ink on bg', t('--ds-red-ink'), bg, AA],
    ['--ds-blue-ink on bg', t('--ds-blue-ink'), bg, AA],
    ['--ds-purple-ink on bg', t('--ds-purple-ink'), bg, AA],

    // the accent's ink inverts WITH its fill (white on light mint is 2.46:1)
    ['--ds-accent-ink on --ds-accent', t('--ds-accent-ink'), t('--ds-accent'), AA],
    ['--ds-accent-soft-ink on --ds-accent-soft', t('--ds-accent-soft-ink'), t('--ds-accent-soft'), AA],
    ['--ds-ink on --ds-accent-soft', t('--ds-ink'), t('--ds-accent-soft'), AA],

    /* SELECTED rows re-ground their SECONDARY text on --ds-accent-soft. The pairs
       above only ever asserted the PRIMARY ink, so a muted sub-label inherited the
       value tuned for --ds-panel and quietly missed AA on the selected state — the
       "readable against the surface" rule applied to the wrong surface. Found by the
       live-DOM audit (.claude/skills/frontend-consistency), which measures rendered
       pairs rather than token pairs. */
    ['--ds-accent-soft-mut on --ds-accent-soft', t('--ds-accent-soft-mut'), t('--ds-accent-soft'), AA],

    /* QUEUE COUNT CHIP (.ds-qcount) — the same text rides FOUR different grounds,
       which is exactly how it shipped unreadable: the defaults are tuned for the
       header bar and the recessed tile, and on the home menu's PLAY button, an
       --ds-accent FILL, the bold number was --ds-accent on --ds-accent. 1:1. The
       token pairs existed and passed; this pairing had simply never been declared,
       so the suite had nothing to fail on. Every ground it can land on is listed
       here now — adding a fifth placement means adding a fifth pair. */
    ['qcount label on --ds-bar', t('--ds-mut'), t('--ds-bar'), AA],
    ['qcount number on --ds-bar', t('--ds-accent'), t('--ds-bar'), AA],
    ['qcount label on --ds-tile', t('--ds-mut'), t('--ds-tile'), AA],
    ['qcount number on --ds-tile', t('--ds-accent'), t('--ds-tile'), AA],
    ['qcount label on --ds-panel (menu button)', t('--ds-mut'), t('--ds-panel'), AA],
    ['qcount number on --ds-panel (menu button)', t('--ds-accent'), t('--ds-panel'), AA],
    ['qcount on --ds-accent (PLAY primary)', t('--ds-accent-ink'), t('--ds-accent'), AA],
    ['qcount label on --ds-accent-soft (rail selected)', t('--ds-accent-soft-mut'), t('--ds-accent-soft'), AA],
    ['qcount number on --ds-accent-soft (rail selected)', t('--ds-accent-soft-ink'), t('--ds-accent-soft'), AA],

    // FRIENDS PANEL — its ground is --ds-bar (like the nav rail), not bg/panel,
    // so these pairs are genuinely new even where the same token is checked above.
    // The status dots are FILLS carrying no text, hence NON_TEXT: they are only a
    // secondary cue anyway, since every row spells its status out in words (a red
    // DND dot and a green online dot are the same dot to a colourblind player).
    ['--ds-ink on bar (friend name)', t('--ds-ink'), bar, AA],
    ['--ds-ink-dim on bar (friends toggle)', t('--ds-ink-dim'), bar, AA],
    ['--ds-red-ink on bar (friends error)', t('--ds-red-ink'), bar, AA],
    ['--ds-ok-ink on bar (friends note)', t('--ds-ok-ink'), bar, AA],
    ['--ds-ok dot on bar (1.4.11)', t('--ds-ok'), bar, NON_TEXT],
    ['--ds-danger dot on bar (1.4.11)', t('--ds-danger'), bar, NON_TEXT],

    // CONTRIBUTORS cards sit on --ds-panel; the icon links go accent on hover
    ['--ds-accent on panel (contributor icon)', t('--ds-accent'), panel, AA],
    ['--ds-ink-dim on panel (contributor card)', t('--ds-ink-dim'), panel, AA],

    // PATCH NOTES (.ann-panel modal and /changelogs, both on --ds-panel since the notes lost
    // their --ds-tile card): body, bold leads, the mono `##` section label, the date, and the
    // inset focus ring of the scrollable notes region
    ['.ann-md body --ds-ink-dim on panel', t('--ds-ink-dim'), panel, AA],
    ['.ann-md strong --ds-ink on panel', t('--ds-ink'), panel, AA],
    ['.ann-md ## label --ds-accent on panel', t('--ds-accent'), panel, AA],
    ['.ann-item-date --ds-mut on panel', t('--ds-mut'), panel, AA],
    ['.ann-scroll focus ring on panel (1.4.11)', t('--ds-accent'), panel, NON_TEXT],

    // 1.4.11 — interactive boundaries, measured against the card behind them
    ['--ds-line-strong on panel (1.4.11)', t('--ds-line-strong'), panel, NON_TEXT],
    ['focus ring --ds-accent on bg (1.4.11)', t('--ds-accent'), bg, NON_TEXT],

    // fills with fixed white ink — identical in both themes, asserted in both anyway
    ['alliance-red chip', '#ffffff', t('--ds-red-chip'), AA],
    ['alliance-blue chip', '#ffffff', t('--ds-blue-chip'), AA],
    // the results screen's alliance PANEL (a solid fill, not a small chip) — its own
    // token pair, not the literal above, so a future edit to either has to keep them in sync
    ['Results .resx-half.red ink', t('--ds-red-chip-ink'), t('--ds-red-chip'), AA],
    ['Results .resx-half.blue ink', t('--ds-blue-chip-ink'), t('--ds-blue-chip'), AA],
  ];
};

/** Identity fills that must never be small text. On the LIGHT floor that is a
 *  measurable fact — all five land near 3:1 — so we assert they still FAIL: if someone
 *  "fixes" one by darkening it, this fires and points them at an `-ink` sibling instead
 *  (src/render/ and .score-panel depend on these exact values).
 *
 *  On the DARK floor the same hues contrast fine (--ds-red is 4.67:1 on #20262c), so
 *  "fill-only" there is a POLICY, not a measurement, and asserting a failure would be
 *  asserting a falsehood. The `-ink` siblings exist for both themes regardless. */
const FILL_ONLY = ['--ds-red', '--ds-blue', '--ds-green', '--ds-ok', '--ds-purple'];

/** The in-match HUD. Its CARDS theme (--ds-hud is the themed panel over the canvas);
 *  its ON-CANVAS glyphs do not (--ds-on-field*, absent from the dark palette). Both
 *  halves are asserted in both themes.
 *
 *  The load-bearing pair is `--ds-hud-line vs FIELD`: a dark card on the dark field is
 *  ~1.4:1 by fill, so the EDGE is what identifies the card, and it has to read from the
 *  card side AND the field side. That is the check that lets the HUD theme at all. */
const hudPairs = (t) => {
  const card = hudCard(t, '--ds-hud');
  const soft = hudCard(t, '--ds-hud-soft');
  const panel = t('--ds-panel');
  return [
    ['HUD .timer-time', t('--ds-ink'), card, AA],
    ['HUD .timer-phase / .breakdown-row', t('--ds-mut'), soft, AA],
    ['HUD .chip ink', t('--ds-ink'), card, AA],
    ['HUD .chip.on / GATE OPEN', t('--ds-ok-ink'), card, AA],
    ['HUD .chip.off / GATE CLOSED', t('--ds-mut'), t('--ds-tile'), AA],
    ['HUD .chip.warn', t('--ds-warn'), card, AA],
    // .chip.bad is a FILLED red-card chip: fixed ink on --ds-red, so it is audited
    // against its own fill rather than against the HUD card behind it.
    ['HUD .chip.bad (red card)', '#2b0b0b', t('--ds-red'), AA],
    // the forfeit line on the results screen: --ds-red as TEXT on the overlay panel
    ['Results forfeit notice', t('--ds-red-ink'), panel, AA],
    ['HUD .timer-panel.urgent', t('--ds-red-ink'), card, AA],
    ['HUD .robot-status ink', t('--ds-ink-dim'), card, AA],
    ['HUD .game-btn ink', t('--ds-ink-dim'), card, AA],
    ['HUD .eventlog-line ink', t('--ds-ink-dim'), soft, AA],
    ['HUD .hopper-pip / .pg-bar ring (1.4.11)', t('--ds-mut'), card, NON_TEXT],
    // BIOBUZZ's next-out marker: the only cue for which held element leaves next
    ['HUD .hopper-pip.next marker (1.4.11)', t('--ds-ink'), card, NON_TEXT],
    // CR/DECODE HUD ring icons (.mult-badge / .catalyst-pip / .gate-icon). Their
    // outer ring is --ds-mut (already covered by the .hopper-pip entry above) — the
    // ONE state fill that swaps the ring colour instead of just the disc (mult-badge.on)
    // is checked here, since --ds-gold/--ds-green/--ds-red land under 3:1 on the light
    // card as a raw fill (1.81 / 1.70 / 2.92) and are legible only via that ring border.
    ['HUD .mult-badge.on ring (1.4.11)', t('--ds-purple'), card, NON_TEXT],
    ['HUD alliance-red chip', '#ffffff', t('--ds-red-chip'), AA],
    ['HUD alliance-blue chip', '#ffffff', t('--ds-blue-chip'), AA],

    // The standing "you are still queued" chip — the one menu-shell surface that
    // ALSO floats over the field. Its fill is the panel, so its ink is measured
    // there; its EDGE is what identifies it against the field, which
    // `checkCardIdentifiable` already asserts for --ds-hud-line. It is opaque on
    // purpose: fading it would blend ink and fill toward the field together and
    // quietly drop this pair below the floor, where nothing here would see it.
    ['HUD .ds-queuechip ink over the field', t('--ds-ink'), panel, AA],
    ['HUD .ds-queuechip live dot (1.4.11)', t('--ds-accent'), panel, NON_TEXT],

    // the results screen's own alliance-half ink pair is asserted with the other
    // fixed-ink chip pairs, further up in this file (Results .resx-half.{red,blue} ink)

    // ON-CANVAS text: fixed, and measured against the two dark grounds it ever meets
    ['canvas countdown on the field', t('--ds-on-field'), FIELD, AA],
    ['canvas .intro-vs on the scrim', t('--ds-on-field-dim'), INTRO_SCRIM, AA],
    ['canvas .intro-eyebrow on the scrim', t('--ds-on-field-accent'), INTRO_SCRIM, AA],
    ['canvas .mobile-joystick-label', t('--ds-on-field-dim'), FIELD, AA],

    /* THE DRIVER-NAME LABELS over remote robots (`renderer.ts`), in COLORS.redLabel /
       COLORS.blueLabel. Fixed literals rather than tokens: they are canvas colours, and the
       field never themes.

       Measured against the LIGHTEST ground a label crosses — COLORS.tile, not the mat — because
       a label follows its robot and the tiles are what it spends most of a match over. That is
       also the pair that rules out the raw alliance hues: COLORS.red is 3.52:1 there and
       COLORS.blue 3.60:1, fine for the fat shapes they were drawn for and under the floor for a
       name somebody reads mid-match.

       The SECOND ground is the label's own stroke, which sits directly under every glyph. And
       the stroke is measured against the light BACKDROP, because that is the case the fill
       cannot cover: a robot pinned to the far wall pushes its label off the mat entirely, and
       the outline is the only thing holding the text there. */
    /* THE 3D MAT. These are what cap how light the field may go — see `TILE3D`. The
       `-accent` one is a FOCUS RING (the pad-navigation ring over the field), which is
       non-text and takes 1.4.11's 3:1 rather than 4.5. */
    ['canvas countdown on the 3D mat', t('--ds-on-field'), TILE3D, AA],
    ['canvas on-field text on the 3D mat', t('--ds-on-field-dim'), TILE3D, AA],
    ['canvas on-field text on the 3D seam lip', t('--ds-on-field-dim'), TILE3D_LIP, AA],
    ['pad focus ring on the 3D mat', t('--ds-on-field-accent'), TILE3D, NON_TEXT],
    /* ⚠️ THERE IS DELIBERATELY NO “STROKE vs 3D MAT” PAIR, AND IT WAS TRIED. It reads
       1.89:1, and asserting it at 1.4.11's 3:1 is inventing a requirement: the halo's OUTER
       edge blending into the ground is cosmetic, not a legibility failure. What makes a
       12-px bold glyph readable over ANY ground is the same thing that makes a subtitle
       readable — an opaque outline directly around it — and that is the fill-against-stroke
       pair below, at 6.55/7.12. The pair that would matter if the halo ever stopped doing
       its job is stroke-against-the-light-BACKDROP, which is already here. */
    ['canvas driver label (red) on the tiles', LABEL_RED, TILE, AA],
    ['canvas driver label (blue) on the tiles', LABEL_BLUE, TILE, AA],
    ['canvas driver label (red) on the mat', LABEL_RED, MAT, AA],
    ['canvas driver label (blue) on the mat', LABEL_BLUE, MAT, AA],
    ['canvas driver label (red) against its own stroke', LABEL_RED, LABEL_STROKE_ON_TILE, AA],
    ['canvas driver label (blue) against its own stroke', LABEL_BLUE, LABEL_STROKE_ON_TILE, AA],
    ['canvas driver label stroke on the light backdrop', LABEL_STROKE_ON_BACKDROP, BACKDROP, AA],

    // the RESULTS SCREEN's own fixed-dark stage (`--ds-stage-bg`) — a broadcast scoreboard,
    // same non-inverting doctrine as the field above but its own token (see shell.css).
    ['Results stage title/body text', t('--ds-on-field'), t('--ds-stage-bg'), AA],
    ['Results stage muted text (eyebrow/category/note)', t('--ds-on-field-dim'), t('--ds-stage-bg'), AA],
    ['Results stage accent note (saved/recorded)', t('--ds-on-field-accent'), t('--ds-stage-bg'), AA],
    // the 3D LOADING SCREEN (`.game-loading`, GameView) stands on the same stage
    ['.game-loading title', t('--ds-on-field'), t('--ds-stage-bg'), AA],
    ['.game-loading step names / season eyebrow', t('--ds-on-field-dim'), t('--ds-stage-bg'), AA],
    ['.game-loading step "Ready"', t('--ds-on-field-accent'), t('--ds-stage-bg'), AA],
    ['.game-loading-bar track edge (1.4.11)', t('--ds-on-field-dim'), t('--ds-stage-bg'), NON_TEXT],
    // the WINNER/TIE banner flips the relationship (fixed light fill, dark ink) rather
    // than reusing the app's inverting --ds-panel/--ds-ink pair
    ['Results .resx-winbanner ink', t('--ds-stage-bg'), t('--ds-on-field'), AA],
    // the season/act REVEAL (.ann-cinema) stands on the same stage; its keycap is the season's
    // own fill with that fill's ink, and it must read against the stage it sits on (1.4.11)
    ['.ann-cinema-btn (season) ink', t('--ds-gold-ink'), t('--ds-gold'), AA],
    ['.ann-cinema-btn (act) ink', t('--ds-on-field-accent-ink'), t('--ds-on-field-accent'), AA],
    ['.ann-cinema-btn (season) fill on the stage (1.4.11)', t('--ds-gold'), t('--ds-stage-bg'), NON_TEXT],
    ['.ann-cinema-btn (act) fill on the stage (1.4.11)', t('--ds-on-field-accent'), t('--ds-stage-bg'), NON_TEXT],
    ['.ann-cinema eyebrow (season)', t('--ds-gold'), t('--ds-stage-bg'), AA],
  ];
};

/** Screens that only render with a game server configured (Leaderboard, MatchHistory,
 *  Account/Auth). They are the easiest place for a stale literal to hide,
 *  because a `npm run dev` without VITE_GAME_SERVER_URL never draws them. */
const serverPairs = (t) => {
  const panel = t('--ds-panel');
  const bg = t('--ds-bg');
  const tile = t('--ds-tile');
  return [
    ['MatchHistory .mh-player.al-red', t('--ds-red-ink'), panel, AA],
    ['MatchHistory .mh-player.al-blue', t('--ds-blue-ink'), panel, AA],
    ['UsernameField hint / available', t('--ds-ok-ink'), panel, AA],
    ['UsernameField hint / taken', t('--ds-danger'), panel, AA],
    ['Account id <code>', t('--ds-mut'), panel, AA],
    ['Leaderboard .lb-standing-badge', t('--ds-gold-ink'), t('--ds-gold'), AA],
    ['HomeMenu .ds-discord-join (blurple fill, fixed ink)', t('--ds-blurple-ink'), t('--ds-blurple'), AA],
    // The supporter badge is a FILL with fixed ink for exactly this reason: it
    // renders on the leaderboard panel, the lobby roster tile, AND a profile
    // header, and no single coloured-text value clears AA on all three grounds.
    ['SupporterBadge glyph', t('--ds-gold-ink'), t('--ds-gold'), AA],

    // ...and the staff variants of the same badge. Unlike gold, both of these
    // fills INVERT between themes, so checking them in each theme is the whole
    // point: the assertion is that the PAIR stays legible, not that the hex does.
    ['SupporterBadge owner glyph', t('--ds-accent-ink'), t('--ds-accent'), AA],
    ['SupporterBadge admin glyph', t('--ds-staff-ink'), t('--ds-staff'), AA],
    // a 12px disc is a meaningful graphic: each badge FILL has to read against the panel
    ['SupporterBadge admin disc on the panel (1.4.11)', t('--ds-staff'), panel, NON_TEXT],
    ['Award-violet badge (record ribbon, stargazer disc) on the panel (1.4.11)', t('--ds-award'), panel, NON_TEXT],
    // the stargazer ★ (`.badge-mark.tier-stargazer`): yellow on the award violet, and the award-ink
    // outline is what separates the two, so the outline is checked against both
    ['Stargazer star outline on the award disc (1.4.11)', t('--ds-award-ink'), t('--ds-award'), NON_TEXT],
    ['Stargazer star on its outline (1.4.11)', t('--ds-star'), t('--ds-award-ink'), NON_TEXT],
    // on the results roster's alliance halves every badge wears an --ds-on-field ring
    ['Badge ring on the red roster half (1.4.11)', t('--ds-on-field'), t('--ds-red-chip'), NON_TEXT],
    ['Badge ring on the blue roster half (1.4.11)', t('--ds-on-field'), t('--ds-blue-chip'), NON_TEXT],
    // .resx-winbanner.gold, the WORLD RECORD banner, is the podium gold
    ['Results WORLD RECORD banner', t('--ds-podium-ink'), t('--ds-podium-gold'), AA],
    // The AWARD VIOLET (0045). Like gold it does NOT invert, so one pair covers both themes.
    // Its ink is the record ribbon's crown now (the hexagon's rank numeral went with titles,
    // 0049), still held to text contrast so the pair can carry a numeral again.
    ['Award ink on the award violet (record ribbon crown)', t('--ds-award-ink'), t('--ds-award'), AA],
    // THE RANKED PODIUM (0048). Three metal fills with ONE fixed ink, declared in the light
    // block only — so, like the award pair above, each numeral is one pair for both themes.
    ['Podium badge numeral (gold)', t('--ds-podium-ink'), t('--ds-podium-gold'), AA],
    ['Podium badge numeral (silver)', t('--ds-podium-ink'), t('--ds-podium-silver'), AA],
    ['Podium badge numeral (bronze)', t('--ds-podium-ink'), t('--ds-podium-bronze'), AA],
    // ⚠️ THE RIM IS WHAT KEEPS SILVER VISIBLE ON THE LIGHT PANEL (~1.9:1 by fill), so the rim
    // itself has to clear 1.4.11 against the panel in BOTH themes — this is that assertion.
    ['Badge / podium title rim on the panel (1.4.11)', t('--ds-mut'), panel, NON_TEXT],
    ['Badge counter pip', t('--ds-on-field'), t('--ds-stage-bg'), AA],
    // the claim dialog's eyebrow and kicker sit on the tier's GLOW, not on the bare panel —
    // the same color-mix the CSS paints (16% metal / 14% violet over --ds-panel)
    ['Reward card eyebrow on the gold glow', t('--ds-ink-dim'), composite(t('--ds-podium-gold'), 0.16, panel), AA],
    ['Reward card eyebrow on the silver glow', t('--ds-ink-dim'), composite(t('--ds-podium-silver'), 0.16, panel), AA],
    ['Reward card eyebrow on the bronze glow', t('--ds-ink-dim'), composite(t('--ds-podium-bronze'), 0.16, panel), AA],
    ['Reward card eyebrow on the record glow', t('--ds-ink-dim'), composite(t('--ds-award'), 0.14, panel), AA],
    ['Reward item kind label on the recessed list', t('--ds-mut'), tile, AA],
    // .legal-warn paints --ds-warn as TEXT on a 9% tint of itself over the page
    ['Legal unfinished-terms warning', t('--ds-warn'), composite(t('--ds-warn'), 0.09, bg), AA],
    ['Leaderboard .lb-standing.placing text', t('--ds-warn'), composite(t('--ds-gold'), 0.09, panel), AA],
    ['ds-opt-del hover glyph', t('--ds-red-ink'), panel, AA],

    /* TINTED OPTION ROWS + the start-pose legality banner. Each paints a semantic
       hue as TYPE on a 12%-tinted panel — exactly the "a colour that is both a FILL
       and a TEXT colour will fail one of the two" trap called out at the top of
       shell.css. They now use the `-ink` siblings; these pairs keep them honest.
       The ground is the same color-mix the CSS composites. */
    ['.ds-opt.red .ot', t('--ds-red-ink'), panel, AA],
    ['.ds-opt.blue .ot', t('--ds-blue-ink'), panel, AA],
    ['.ds-opt.red.on .ot', t('--ds-red-ink'), composite(t('--ds-red'), 0.12, panel), AA],
    ['.ds-opt.blue.on .ot', t('--ds-blue-ink'), composite(t('--ds-blue'), 0.12, panel), AA],
    ['.ds-startpos-status.ok', t('--ds-ok-ink'), composite(t('--ds-ok'), 0.12, panel), AA],
    ['.ds-startpos-status.bad', t('--ds-red-ink'), composite(t('--ds-red'), 0.12, panel), AA],

    /* ACCOUNT STANDING. The tier is carried by the SEMANTIC tokens (ok / warn / red) rather
       than a ramp of its own — but the card sits on `--ds-tile`, not the panel, so the dots
       and the meter fill need checking against THAT ground (1.4.11 non-text), and the lock
       notice paints red ink on a red tint like the option rows above. The tier NAME is plain
       ink beside the dot, deliberately, so colour is never the only carrier. */
    // the GAUGE arc — a non-text indicator carrying the tier, so 1.4.11's 3:1 against the
    // card it sits on. Same tokens the dot used, since the meaning did not change; the arc
    // simply says how FAR through the tier you are, which a dot never could.
    ['.ds-gauge-fill good on tile (1.4.11)', t('--ds-ok-ink'), tile, NON_TEXT],
    ['.ds-gauge-fill warning on tile (1.4.11)', t('--ds-warn'), tile, NON_TEXT],
    ['.ds-gauge-fill restricted on tile (1.4.11)', t('--ds-red-ink'), tile, NON_TEXT],
    ['.ds-gauge-num on tile', t('--ds-ink'), tile, AA],
    ['.ds-gauge-max on tile', t('--ds-mut'), tile, AA],
    ['.ds-standing-blurb on tile', t('--ds-mut'), tile, AA],
    ['.ds-standing-name on tile', t('--ds-ink'), tile, AA],
    ['.ds-standing-lock', t('--ds-red-ink'), composite(t('--ds-red'), 0.12, panel), AA],
    // admin pills are text + edge on the recessed tile, one ink per MEANING
    ['.ds-badge.danger on tile', t('--ds-danger'), tile, AA],
    ['.ds-badge.warn on tile', t('--ds-warn'), tile, AA],
    ['.ds-badge.ok on tile', t('--ds-ok-ink'), tile, AA],
    ['.ds-badge.accent on tile', t('--ds-accent'), tile, AA],
    ['.ds-badge.staff on tile', t('--ds-staff'), tile, AA],
    // chart series marks (1.4.11) — adminCharts SERIES and .an-line.visitors
    ['--ds-viz-1 on panel (1.4.11)', t('--ds-viz-1'), panel, NON_TEXT],
    ['--ds-viz-2 on panel (1.4.11)', t('--ds-viz-2'), panel, NON_TEXT],
    ['--ds-viz-3 on panel (1.4.11)', t('--ds-viz-3'), panel, NON_TEXT],
    ['--ds-viz-4 on panel (1.4.11)', t('--ds-viz-4'), panel, NON_TEXT],
    // .ds-tut-offer: the heading on the plain panel fill
    ['.ds-tut-offer > b', t('--ds-ink'), panel, AA],
  ];
};

/* ---------- design review 2026-09-22, wave 3: focus rings, field edges, selection ---------- */
/** Pairs added by the colour wave. Each is a colour that had shipped untested — two of them
 *  as alpha mixes this file cannot see, which is why they are solid tokens now. */
const reviewW3Pairs = (t) => {
  const panel = t('--ds-panel');
  const tile = t('--ds-tile');
  return [
    // focus rings on the results stage: the link buttons ring in on-field on the fixed-dark
    // stage, the sign-in offer in its own chip ink on the alliance fill (1.4.11)
    ['Results stage .resx-linkbtn focus ring (1.4.11)', t('--ds-on-field'), t('--ds-stage-bg'), NON_TEXT],
    ['Results sign-in focus ring on red (1.4.11)', t('--ds-red-chip-ink'), t('--ds-red-chip'), NON_TEXT],
    ['Results sign-in focus ring on blue (1.4.11)', t('--ds-blue-chip-ink'), t('--ds-blue-chip'), NON_TEXT],
    // the house ring on the controls that fell back to the UA ring (friends, lobby rows, ...)
    ['House focus ring on the panel (1.4.11)', t('--ds-accent'), panel, NON_TEXT],
    // .ds-input / .ds-username-input: the border IS the control, now on a panel fill
    ['.ds-input / .ds-username-input border on the panel (1.4.11)', t('--ds-line-strong'), panel, NON_TEXT],
    ['.ds-input text on its panel fill', t('--ds-ink'), panel, AA],
    // home primary keycap sub-line: solid accent-ink (was a 74% alpha mix, 4.40:1 in light)
    ['.ds-menu-btn.primary .mh', t('--ds-accent-ink'), t('--ds-accent'), AA],
    // the recommended tile's kicker, on the ordinary tile fill
    ['.ds-tile.primary .k on the tile', t('--ds-accent'), tile, AA],
    // .ds-field readouts: ink (was accent), and the muted channel's value
    ['.ds-field .cap .val readout', t('--ds-ink'), panel, AA],
    ['.ds-field .cap .val.muted', t('--ds-mut'), panel, AA],
    // latched nav / option card selected ink on the soft fill
    ['selected (soft) ink on --ds-accent-soft', t('--ds-accent-soft-ink'), t('--ds-accent-soft'), AA],
    ['selected (soft) edge vs the panel (1.4.11)', t('--ds-accent'), panel, NON_TEXT],
  ];
};

/* ---------- design review 2026-09-22, wave 3: in-match surfaces (3D scrim, prediction panel,
   server notice, touch pad, score bar, replay video) ---------- */
/**
 * THE 3D SCRIM IS READ FROM styles.css, NOT RETYPED HERE. `.game-root.view-3d …` redefines the
 * HUD's themed inks to fixed on-field values inside a dark scrim; before these pairs existed the
 * light theme's DARK inks (warn, red-ink, ok-ink, accent) rode onto that scrim at ~3:1 and "ALL
 * PASS" never looked. Parsing the block means a new token added there is resolved the same way
 * the browser would, and a value edited there is measured here.
 */
const stylesCss = readFileSync(join(root, 'src/ui/styles.css'), 'utf8');
const SCRIM = (() => {
  const m = stylesCss.match(/\.game-root\.view-3d \.eventlog \{([\s\S]*?)\n\}/);
  if (!m) throw new Error('could not find the 3D scrim block (.game-root.view-3d …) in styles.css');
  const out = {};
  for (const [, k, v] of m[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[k] = v.trim();
  return out;
})();
/** a token as it resolves INSIDE the scrim: the scrim's own value first, then the theme's */
const scrimGetter = (t) => {
  const g = (name) => {
    const v = SCRIM[name] ?? t(name);
    const ref = v.match(/^var\((--[a-z0-9-]+)\)$/);
    return ref ? g(ref[1]) : v;
  };
  return g;
};
/* The replay video's plate and dimmed ink — literals in `src/ui/replayOverlay.ts` (PLATE,
   PLATE_DIM_INK); a canvas colour, so there is no token to read. Change the two together. */
const REPLAY_PLATE = ['#12151a', 0.94];
const REPLAY_DIM_INK = ['#e5e7eb', 0.62];
/* the touch pad's ghosted fill for a button that cannot act yet, `.mobile-btn.idle` in styles.css */
const PAD_IDLE_FILL = ['#1c2027', 0.3];

const reviewW3HudPairs = (t) => {
  const s = scrimGetter(t);
  const over = (token, ground) => {
    const [c, a] = rgba(s(token));
    return composite(c, a, ground);
  };
  const card = over('--ds-hud', TILE3D);
  const soft = over('--ds-hud-soft', TILE3D);
  // the worst case: the scrim over a LIGHT backdrop showing through behind the field
  const cardLit = over('--ds-hud', BACKDROP);
  const [tc, ta] = rgba(s('--ds-tile'));
  const well = composite(tc, ta, card);
  const themedCard = hudCard(t, '--ds-hud');
  const plate = composite(REPLAY_PLATE[0], REPLAY_PLATE[1], BACKDROP);
  const padIdle = composite(PAD_IDLE_FILL[0], PAD_IDLE_FILL[1], TILE3D);
  return [
    // 3D scrim over the 3D mat — every themed ink a banded card uses
    ['3D scrim .timer-time / .chip ink', s('--ds-ink'), card, AA],
    ['3D scrim .timer-phase / .breakdown-row', s('--ds-mut'), soft, AA],
    ['3D scrim .timer-panel.warning (END GAME)', s('--ds-warn'), card, AA],
    ['3D scrim .timer-panel.urgent / .chip.desync', s('--ds-red-ink'), card, AA],
    ['3D scrim .perf-ping.ok / .chip.on', s('--ds-ok-ink'), card, AA],
    ['3D scrim .breakdown-row span.warn (PIN)', s('--ds-warn'), soft, AA],
    ['3D scrim .eventlog-line', s('--ds-ink-dim'), soft, AA],
    ['3D scrim .eventlog-pinned', s('--ds-warn'), soft, AA],
    ['3D scrim .eventlog-pinned.bad', s('--ds-red-ink'), soft, AA],
    ['3D scrim .chip.off in its well', s('--ds-mut'), well, AA],
    ['3D scrim .hopper-pip ring (1.4.11)', s('--ds-mut'), card, NON_TEXT],
    ['3D scrim .hopper-pip.next marker (1.4.11)', s('--ds-ink'), card, NON_TEXT],
    ['3D scrim .ds-tut-step counter', s('--ds-accent'), card, AA],
    ['3D scrim .ds-tut-nudge', s('--ds-warn'), card, AA],
    ['3D scrim tutorial focus ring (1.4.11)', s('--ds-accent'), card, NON_TEXT],
    ['3D scrim .game-btn.primary (tutorial card, layout editor)', s('--ds-accent-ink'), s('--ds-accent'), AA],
    ['3D scrim over a light backdrop: accent', s('--ds-accent'), cardLit, AA],
    ['3D scrim over a light backdrop: warn', s('--ds-warn'), cardLit, AA],
    ['3D scrim over a light backdrop: ok-ink', s('--ds-ok-ink'), cardLit, AA],
    ['3D scrim over a light backdrop: red-ink', s('--ds-red-ink'), cardLit, AA],
    ['3D scrim over a light backdrop: muted', s('--ds-mut'), cardLit, AA],

    // the site banners (BannerStack.tsx). The restart row keeps the old notice's fixed-ink
    // fills; the others are a panel card whose KIND label carries an inverting tone.
    ['.ds-banner.restart', t('--ds-gold-ink'), t('--ds-gold'), AA],
    ['.ds-banner.restart.urgent', t('--ds-red-chip-ink'), t('--ds-red-chip'), AA],
    ['.ds-banner body on the panel', t('--ds-ink'), t('--ds-panel'), AA],
    ['.ds-banner.info kind label', t('--ds-accent'), t('--ds-panel'), AA],
    ['.ds-banner.known-bug kind label', t('--ds-warn'), t('--ds-panel'), AA],
    ['.ds-banner.warning kind label', t('--ds-danger'), t('--ds-panel'), AA],
    ['.ds-banner-bypass (staff tone as text)', t('--ds-staff'), t('--ds-panel'), AA],
    // the closed screen: a panel card on the page ground
    ['.ds-closed-note on the panel', t('--ds-mut'), t('--ds-panel'), AA],

    // the touch pad: the joystick label is FULL opacity now, on both field grounds
    ['.mobile-joystick-label on the 3D mat', t('--ds-on-field-dim'), TILE3D, AA],
    // idle: every button's label drops to the dim ink, whatever its own colour. The idle ring
    // and glyph are not held to 1.4.11 — an inactive control is exempt, and receding is the point
    ['.mobile-btn.idle label (ghosted fill over the 3D mat)', t('--ds-on-field-dim'), padIdle, AA],
    ['.mobile-btn ring on the 3D mat (1.4.11)', t('--ds-on-field-dim'), TILE3D, NON_TEXT],
    // DONE is a .game-btn.primary on the themed HUD card (it was a fixed mint pill once)
    ['.mobile-edit-bar primary (.game-btn.primary)', t('--ds-accent-ink'), t('--ds-accent'), AA],

    // the live score bar: flat chip fills, children inherit the chip ink at full strength
    ['.score-panel.red .bb-tip / .you-tag', t('--ds-red-chip-ink'), t('--ds-red-chip'), AA],
    ['.score-panel.blue .bb-tip / .you-tag', t('--ds-blue-chip-ink'), t('--ds-blue-chip'), AA],

    // the replay video scoreboard, plate over a LIGHT ground (a 3D export over a lit scene)
    ['replay video RED label / RED WINS', LABEL_RED, plate, AA],
    ['replay video BLUE label / BLUE WINS', LABEL_BLUE, plate, AA],
    ['replay video dimmed phase label', composite(REPLAY_DIM_INK[0], REPLAY_DIM_INK[1], plate), plate, AA],
  ];
};

/* ---------- run ---------- */

const listOnly = process.argv.includes('--list');
let failed = 0;
let total = 0;

const check = (label, ink, ground, floor) => {
  total++;
  const ratio = cr(ink, ground);
  const pass = ratio >= floor;
  if (!pass) failed++;
  if (listOnly || !pass) {
    console.log(
      `${pass ? 'PASS' : 'FAIL'}  ${ratio.toFixed(2).padStart(5)}:1 (need ${floor})  ${label}  ${ink} on ${ground}`,
    );
  }
};

/** A HUD card must be IDENTIFIABLE against the field (1.4.11) — but a border only has
 *  to do that job when the fill cannot. Light mode's near-white card is ~15:1 on the
 *  field and needs no edge at all; dark mode's card is ~1.4:1, so --ds-hud-line carries
 *  it. Asserting both would demand a light-mode border that reads on a white card. */
const checkCardIdentifiable = (themeName, t, card) => {
  total++;
  const byFill = cr(card, FIELD);
  const byEdge = cr(t('--ds-hud-line'), FIELD);
  const best = Math.max(byFill, byEdge);
  const pass = best >= NON_TEXT;
  if (!pass) failed++;
  if (listOnly || !pass) {
    console.log(
      `${pass ? 'PASS' : 'FAIL'}  ${best.toFixed(2).padStart(5)}:1 (need ${NON_TEXT})  ` +
        `[${themeName}] HUD card identifiable on the field ` +
        `(fill ${byFill.toFixed(2)}, edge ${byEdge.toFixed(2)})`,
    );
  }
};

for (const [themeName, table] of [['light', LIGHT], ['dark', DARK]]) {
  const t = getter(table, themeName);
  if (listOnly) console.log(`\n--- ${themeName.toUpperCase()} ---`);
  for (const group of [themedPairs, hudPairs, serverPairs, reviewW3Pairs, reviewW3HudPairs]) {
    for (const [label, ink, ground, floor] of group(t)) {
      check(`[${themeName}] ${label}`, ink, ground, floor);
    }
  }
  checkCardIdentifiable(themeName, t, hudCard(t, '--ds-hud'));
  // Only assertable on the light floor — see FILL_ONLY.
  if (themeName !== 'light') continue;
  for (const name of FILL_ONLY) {
    total++;
    const ratio = cr(t(name), t('--ds-bg'));
    const stillFails = ratio < AA;
    if (!stillFails) failed++;
    if (listOnly || !stillFails) {
      console.log(
        `${stillFails ? 'PASS' : 'FAIL'}  [${themeName}] ${name} is fill-only (${ratio.toFixed(2)}:1 on bg` +
          `${stillFails ? ', correctly below 4.5 — never use as text)' : ' — now passes as text? add an -ink sibling instead of widening this token)'}`,
      );
    }
  }
}

const cards = ['light', 'dark']
  .map((n, i) => `${n} ${hudCard(getter([LIGHT, DARK][i], n), '--ds-hud')}`)
  .join(', ');

console.log(
  failed === 0
    ? `\nALL PASS — ${total} contrast checks across light + dark (HUD card over the mat: ${cards})`
    : `\n${failed}/${total} FAILED`,
);
process.exit(failed === 0 ? 0 : 1);
