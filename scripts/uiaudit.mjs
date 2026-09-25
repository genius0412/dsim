/**
 * UI STANDARD AUDIT — `npm run uiaudit`. Zero dependencies, same shape as
 * `contrast.mjs` and `shiftaudit.cjs`.
 *
 * Enforces docs/ui-standard.md. Deliberately NOT wired into `npm test`, for the reason
 * the repo already applies to contrast and dbtest: a red `npm test` must keep meaning
 * "physics broke".
 *
 * ── WHY A RATCHET ─────────────────────────────────────────────────────────────
 * The standard landed on a codebase with 105 inline spacing declarations and 18 font
 * sizes. A check that simply failed would have to be switched off on day one, and a
 * check that is off is not a check. So each rule carries a BASELINE: the count measured
 * when the rule was written. The audit fails if a count goes UP, and tells you to lower
 * the baseline when it goes down. New code is held to the standard immediately; the
 * existing debt is paid off in whatever order suits, and can never grow back.
 *
 * Several rules have a baseline of 0 and are hard errors, because each describes a bug that
 * shipped silently and cost real time to find:
 *
 *   • UNDEFINED CUSTOM PROPERTY — `--ds-font` was used 13 times and never defined. In a
 *     `font:` shorthand an unresolvable var() voids the WHOLE declaration, so those rules
 *     set no weight, size or line-height at all, for months, with nothing in the console.
 *     `--accent` was the same bug wearing a fallback.
 *
 *   • `inherit` INSIDE A `font:` SHORTHAND — a CSS-wide keyword is only valid as the
 *     WHOLE value, so `font: 600 12px/1 inherit` is invalid and the declaration drops;
 *     five HUD rules set no weight, size or line-height that way. (`font: inherit` alone
 *     and `var(--x, inherit)` are both fine.)
 *
 *   • DUPLICATE SELECTOR — `.ds-dl` was declared twice for two unrelated components. The
 *     later block won and laid the replay export menu out as a column. Both files are one
 *     cascade; source order is the only tiebreak, and nothing warns you.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const UI = 'src/ui';
const css = readdirSync(UI).filter((f) => f.endsWith('.css')).map((f) => join(UI, f));
const tsx = readdirSync(UI).filter((f) => f.endsWith('.tsx')).map((f) => join(UI, f));
// helpers like rangeFill.ts also hand custom properties to a style object
const ts = readdirSync(UI).filter((f) => f.endsWith('.ts')).map((f) => join(UI, f));
const read = (f) => readFileSync(f, 'utf8').split('\n');

/** every finding, grouped by rule id */
const found = new Map();
const hit = (rule, file, line, text) => {
  if (!found.has(rule)) found.set(rule, []);
  found.get(rule).push({ file, line, text: text.trim().slice(0, 110) });
};

/** the counts on the day each rule was written. LOWER these as debt is paid; never raise. */
const BASELINE = {
  'undefined-token': 0,
  'duplicate-selector': 0,
  'var-literal-fallback': 0,
  'font-inherit-mix': 0,
  'ghost-primary': 0,
  // 29 → 5, 2026-09-19: the admin console rebuild took its 24 out. `.admin-card` is a flex
  // column with a gap of its own and eleven of its children carried an inline margin too,
  // so the space between a status line and the buttons above it was the gap PLUS a number
  // somebody typed; §2's "one owner per gap" now holds there. The rest became `.adm-sub`,
  // `.adm-gap` and `.adm-sec`.
  // 5 → 4, 2026-09-22: design review wave 3.
  'inline-spacing': 0,
  'fractional-font-size': 0,
  'banned-font-weight': 0,
  // 155 → 152, 2026-09-19: the three HUD read-outs became one. `.ping-graph`'s `8px 10px`
  // and `18px 0`, its `5px` margin and its `6px` gap went with the graph that opened on a
  // click that never landed; `.perf-hud` is on the token scale.
  // 152 → 149, 2026-09-21: the Configure redesign. `.ds-robot` and `.ds-subnav-body` both
  // spelled the gap between a section's cards as `22px`, and a comment in one of them pointed
  // at the other to keep them agreeing; both are `--ds-s-5` now, so they agree by construction.
  // `.ds-binds`'s own `14px` went the same way when the gamepad split gave it a sibling that
  // would otherwise have had to copy the number.
  // 149 → 146, 2026-09-21: the results screen went to a viewport-driven display scale, and
  // all three of its off-grid values were off-grid because they were sized for 15px type —
  // `.resx-roster-name` and `.resx-roster-meta`'s `6px` gaps and `.resx-breakdown`'s `3px`
  // cell padding. They are `em` now, so they scale with the row they sit in and there is no
  // number left to round.
  // 146 → 144, 2026-09-22: merging main's LAN Screen Redesign lost the `.net-corner` /
  // `.chip.net-quality.clickable` rules along with the dead ping-graph feature they served
  // (superseded by `.perf-hud`, owner ruling 2026-09-19); two of their off-grid literals
  // went with them.
  // 144 → 143, 2026-09-22: the Controls overhaul. `.ds-keys` spaced its keycaps `6px` apart; it
  // is `--ds-s-2`, the within-a-row step, now that the rows are a grid the keycaps can wrap in.
  // 143 → 133, 2026-09-22: design review wave 3. 141 on arrival (two went elsewhere in the
  // wave); the typography pass took eight more — `.ds-empty`/`.ds-loading`'s shared 30px 20px,
  // the replay export menu's 10px pads, `.legal-warn`, `.ann-item-head`, `.ds-replay-saving`.
  // 133 → 122, 2026-09-22: design review wave 4 (the keycap/card consolidation, the LAN move and
  // `.ds-dl-hero`'s 22px pad, which is --ds-s-5 now).
  // → 120, 2026-09-23: merged upstream's builder-hero rebuild onto design review wave 5.
  // → 117, 2026-09-23: design review wave 7x (replay rail/builder polish, dead server-picker CSS).
  // → 112, 2026-09-23: queue pages on the spacing tokens (console column, head, actions, strategy cards, players).
  // → 110, 2026-09-23: the phone footer's 14px/16px pad and the breakdown chip's 2px 8px on tokens.
  // → 106, 2026-09-25: the patch-note modal and /changelogs on the spacing tokens.
  // → 105, 2026-09-25: the lockdown/banner merge put one more gap on the tokens.
  'off-grid-gap': 105,
  // 143 → 141, 2026-09-22: the builder hero's rebuild. Its narrow-screen card was spaced in
  // `18px` twice (gap and padding); the one card it became is on the token scale throughout.
  // measured 2026-09-16, when these three rules were written. §4's own ruling ("10px … rounds
  // to --ds-round-md") was executed in the same commit, which is why radius starts at 17 and
  // not the 31 first measured. The other two start where they stand: paying them down needs a
  // visual decision per site, and a baseline is how that gets paid off in any order without
  // being able to grow back.
  // 46 → 45, 2026-09-22: `.ds-home-lead`'s `15px` went with the home page's lead sentence,
  // removed once the homepage no longer needed a line saying DSIM is "2D".
  // 45 → 13, 2026-09-22: design review 14-06/07/08. The scale was amended to the code: 14px is
  // `--ds-t-control` (17 control/body literals became the token), the h1/h2 clamps are
  // `--ds-t-h1`/`--ds-t-h2`, and every 10px chrome label moved UP to `--ds-t-xs`, the floor.
  // What is left is display type (16/18/19/22/24) and the standing gauge's SVG user units.
  // → 11, 2026-09-23: merged upstream's builder-hero rebuild onto design review wave 5.
  'off-scale-font-size': 11,
  // 45 → 43, 2026-09-22: the builder hero's `24px` name and the `10px` CUSTOM chip beside it.
  // The name is `--ds-t-xl`, and the chip is gone: the preset cards right under the hero
  // already show whether the build is one of them.
  // 14 → 13, 2026-09-19: `.perf-readout`'s `border-radius: 6px` went with the `?perf=1` line.
  // 13 → 12, 2026-09-22: `.net-overlay-card`'s `14px` is `--ds-round-lg`, which is what it was
  // approximating — it sat beside `.overlay-panel`, which already used the token.
  // 12 → 9, 2026-09-22: `.rec-track`'s 3px and `.md-code`'s 5px are `--ds-round-sm` (and one
  // went elsewhere in the wave).
  // 9 → 3, 2026-09-22: design review wave 4 — the tutorial's private button went, and the keycap
  // families that had spelled their radius out now share the one block.
  'literal-radius': 3,
  // 14 → 12, 2026-09-22: design review wave 4. The cinema button's glow and the presence dot's
  // halo are gone (No-Blur Rule); every keycap edge is one `--cap-edge` declaration.
  // 12 → 11, 2026-09-23: design review wave 6 — the `.ds-opt.real` stripe's shadow went with it.
  'shadow-sprawl': 11,
  // measured 2026-09-22 (design review 13-11), when the rule was written. The scrims among them
  // (styles.css .overlay/.net-overlay and friends) have --ds-scrim / --ds-scrim-strong waiting.
  // 29 → 26, 2026-09-22: design review wave 3.
  // 26 → 14, 2026-09-22: design review wave 4. The cinema's #05070b stage is --ds-stage-bg, the
  // alliance chips take their -chip-ink tokens and the prompt chip --ds-gold-ink.
  'raw-colour': 14,
  // measured 2026-09-22 (design review 14-12), when the rule and the --ds-lh-* tokens landed.
  // 78 on the day; the value-identical ones (1, 1.2, 1.45) and the off-standard 1.5 became
  // tokens in the same commit, leaving the odd values (1.02, 1.3, 1.35, 16px …) and the `/n`
  // inside `font:` shorthands.
  // 33 → 32, 2026-09-22: `.as-field input` restated .ds-input with its own `/ 1.4`; it is gone.
  // → 29, 2026-09-23: merged upstream's builder-hero rebuild onto design review wave 5.
  'literal-line-height': 28,
  // measured 2026-09-22 (design review 13-12), when the tip, the banners, the danger button and
  // the LAN panel moved to shell.css. The four left are deliberate: `.ds-dialog-title` is the one
  // title contract the match overlays share with the shell dialogs, `.ds-key.capturing` sits in
  // styles.css's reduced-motion list, and two are admin-page compounds (`.adm-sub` / `.adm-sec`).
  // 4 → 2, 2026-09-23: the whole admin block moved to shell.css, the two compounds with it.
  'ds-outside-shell': 2,
  // measured 2026-09-22 (design review 21-09/21-16), when --ds-dur-press / --ds-dur-fade landed
  // and every colour fade moved onto them. What is left animates DATA, not state — gauge fills,
  // progress widths, a ring's dashoffset, a gate icon's swing — plus one joystick fade.
  // 7 → 4 the same day: the fill bars dropped their width transitions (§7) and the disclosure
  // carets rotate at --ds-dur-fade.
  'literal-duration': 4,
  'stale-component-index': 0,
};

// ── 1. undefined custom properties ───────────────────────────────────────────
// definitions can come from either stylesheet, or from JS setting a property inline
const defined = new Set();
for (const f of [...css, ...tsx, ...ts]) {
  for (const l of read(f)) {
    for (const m of l.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(m[1]);
    // JSX sets custom properties two ways: `'--x':` and the computed
    // `['--x' as string]:` form React needs for a typed style object
    for (const m of l.matchAll(/\[?\s*['"](--[a-zA-Z0-9-]+)['"]/g)) defined.add(m[1]);
  }
}
for (const f of css) {
  read(f).forEach((l, i) => {
    for (const m of l.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
      if (!defined.has(m[1])) hit('undefined-token', f, i + 1, `${m[1]} — ${l}`);
    }
  });
}

// ── 2. a var() fallback hides a missing token ────────────────────────────────
// `var(--accent, #6ea8ff)` looked fine and used the literal 100% of the time.
for (const f of css) {
  read(f).forEach((l, i) => {
    if (/var\(\s*--[a-zA-Z0-9-]+\s*,\s*(#|rgb|hsl)/.test(l)) hit('var-literal-fallback', f, i + 1, l);
  });
}

// ── 2b. a CSS-wide keyword inside a `font:` shorthand ─────────────────────────
// `inherit`/`initial`/`unset`/`revert` are only valid as the ENTIRE value; beside other
// values the whole shorthand is invalid and silently dropped. var() fallbacks are stripped
// first, because `var(--ds-font-ui, inherit)` is valid.
for (const f of css) {
  read(f).forEach((l, i) => {
    const code = l.replace(/\/\*.*?\*\//g, '');
    for (const m of code.matchAll(/(?:^|[\s;{])font\s*:\s*([^;}]+)/g)) {
      const v = m[1].replace(/var\([^()]*\)/g, 'V').trim();
      if (/\b(inherit|initial|unset|revert)\b/.test(v) && !/^(inherit|initial|unset|revert)(\s*!important)?$/.test(v)) {
        hit('font-inherit-mix', f, i + 1, l);
      }
    }
  });
}

// ── 3. one selector, one owner ───────────────────────────────────────────────
// Only top-level blocks: a @media re-declaring a selector is the point of a @media.
const owner = new Map();
for (const f of css) {
  let depth = 0;
  // A SELECTOR LIST SPANS LINES. Matching only `^sel {` treats the LAST line of
  //   .fr-empty,
  //   .fr-note,
  //   .fr-error {
  // as a standalone rule, which is a false positive — and acting on that one is what
  // collapsed that group into a single block and turned `.fr-empty` red. So the
  // prelude is accumulated across lines and only single-selector rules own a name.
  let prelude = '';
  read(f).forEach((l, i) => {
    const code = l.replace(/\/\*.*?\*\//g, '');
    if (depth === 0) {
      const open = code.indexOf('{');
      if (open === -1) {
        prelude += ' ' + code;
      } else {
        prelude = (prelude + ' ' + code.slice(0, open)).trim();
        const sels = prelude.split(',').map((x) => x.trim()).filter(Boolean);
        // `.a, .b { }` is a shared BASE; `.a { }` after it is a per-variant override,
        // which is the normal shape, not the bug. Only a lone selector owns itself.
        if (sels.length === 1 && /^[.#]/.test(sels[0]) && !sels[0].startsWith('@')) {
          const sel = sels[0];
          const prev = owner.get(sel);
          if (prev) hit('duplicate-selector', f, i + 1, `${sel} — also at ${prev}`);
          else owner.set(sel, `${f}:${i + 1}`);
        }
        prelude = '';
      }
    }
    depth += (code.match(/\{/g) || []).length - (code.match(/\}/g) || []).length;
    if (depth < 0) depth = 0;
    if (depth === 0 && code.includes('}')) prelude = '';
  });
}

// ── 3b. `ghost` and `primary` on one button ──────────────────────────────────
// `.ds-btn.ghost` is declared AFTER `.ds-btn.primary`, so it wins on `background: none`
// while primary's white `color: var(--ds-accent-ink)` survives — a button whose label is
// white on the page's own surface. It reads as a missing control rather than a broken one,
// which is why it gets a rule rather than a fix: the two modifiers are alternatives.
for (const f of tsx) {
  read(f).forEach((l, i) => {
    for (const m of l.matchAll(/(?:className|class)=[^\n]*?['"`]([^'"`]*ds-btn[^'"`]*)['"`]/g)) {
      // a TEMPLATE literal spans the whole attribute, so test the line's ds-btn runs
      if (/\bghost\b/.test(m[1]) && /\bprimary\b/.test(m[1])) hit('ghost-primary', f, i + 1, l);
    }
    // the common template form: `ds-btn ghost ...${cond ? ' primary' : ''}`
    if (/ds-btn[^`'"]*\bghost\b/.test(l) && /'\s*primary/.test(l)) hit('ghost-primary', f, i + 1, l);
  });
}

// ── 4. spacing literals in JSX ───────────────────────────────────────────────
for (const f of tsx) {
  read(f).forEach((l, i) => {
    if (/style=\{\{/.test(l) || /^\s*(margin|padding|gap)[A-Za-z]*:\s*['"]?[0-9]/.test(l)) {
      if (/(margin|padding|gap)[A-Za-z]*:\s*['"]?[0-9]/.test(l)) hit('inline-spacing', f, i + 1, l);
    }
  });
}

// ── 5. type scale ────────────────────────────────────────────────────────────
for (const f of css) {
  read(f).forEach((l, i) => {
    if (/font-size:\s*[0-9]+\.[0-9]+px/.test(l)) hit('fractional-font-size', f, i + 1, l);
    if (/font:\s*[0-9]+\s+[0-9]+\.[0-9]+px/.test(l)) hit('fractional-font-size', f, i + 1, l);
    // both families are VARIABLE cuts (shell.css:164), so 750 and 500 are real type,
    // not drift. Guard against an EIGHTH weight appearing rather than banning three.
    const wm = l.match(/font-weight:\s*([0-9]{3})/) ?? l.match(/font:\s*([0-9]{3})\s/);
    if (wm && !/^(400|500|600|700|750|800|900)$/.test(wm[1])) hit('banned-font-weight', f, i + 1, l);
  });
}

// ── 5b. the type SCALE, not just its fractions ───────────────────────────────
// §3 declares six sizes and the audit only ever checked that a size was not FRACTIONAL, so
// 23 whole-pixel sizes accumulated against a six-step scale — 17px, 19px, 26px, 34px, 58px
// and the rest, each one invisible on its own. A live-DOM audit across five routes measured
// 12 distinct sizes actually rendering, with 19/64/10px each appearing on exactly one page.
// That is the drift the scale exists to prevent, and the reason it went unnoticed is that
// the rule enforcing it was never written.
// 14 is `--ds-t-control` (design review 14-07): every button, input and table cell used it,
// so the scale was amended to sanction it rather than ratchet against its own core controls.
const TYPE_SCALE = new Set([11, 12, 13, 14, 15, 20, 28]);
/**
 * SCOPED TO THE CHROME. `styles.css` is the in-match overlay drawn over the dark field
 * canvas, and it is a different surface with different needs — its 160px countdown digits
 * are display type doing exactly their job, not drift. §3's six steps were written about the
 * `ds-` chrome. Blessing the overlay's sizes to make one rule cover both would make the rule
 * vacuous; condemning them would make it wrong. It needs a display tier of its own, decided
 * on its own terms, and until §3 has one this rule does not reach it.
 */
for (const f of css.filter((x) => x.endsWith('shell.css'))) {
  read(f).forEach((l, i) => {
    const m = l.match(/font-size:\s*([0-9]+)px/) ?? l.match(/font:\s*[0-9]{3}\s+([0-9]+)px/);
    if (m && !TYPE_SCALE.has(Number(m[1]))) hit('off-scale-font-size', f, i + 1, l);
  });
}

// ── 5c. literal radii ────────────────────────────────────────────────────────
// §4 says "No literal radius" in those words. Eight distinct literals are in use (3, 5, 6,
// 7, 8, 9, 10, 14) and only 8px coincides with a token, so seven of them are values nobody
// chose twice. 7px reaches the live DOM on exactly one route.
for (const f of css) {
  read(f).forEach((l, i) => {
    if (/border-radius:\s*[0-9]+px/.test(l) && !/var\(--ds-round/.test(l)) hit('literal-radius', f, i + 1, l);
  });
}

// ── 5d. one depth model ──────────────────────────────────────────────────────
// DESIGN.md commits to ONE: a hard offset "block" shadow with a keycap edge, explicitly not
// blurry realistic elevation. 45 distinct box-shadow declarations is not one model, and the
// live audit sees 9 of them rendering at once. Counted per DISTINCT declaration rather than
// per occurrence — reusing the same shadow is the point.
{
  // same scoping, and the same reason: the overlay's depth is drawn over a canvas.
  const seen = new Map();
  for (const f of css.filter((x) => x.endsWith('shell.css'))) {
    read(f).forEach((l, i) => {
      const m = l.match(/box-shadow:\s*([^;]+);/);
      if (!m) return;
      const decl = m[1].trim().replace(/\s+/g, ' ');
      if (decl === 'none' || decl.startsWith('var(')) return;
      // a focus/selection RING (`0 0 0 Npx …`, no offset, no blur) is not an elevation
      // model, and neither is an `inset` highlight — counting them as depth would flag
      // exactly the code that is doing the right thing
      if (/^(inset\s+)?0 0 0 /.test(decl) || decl.startsWith('inset ')) return;
      if (!seen.has(decl)) seen.set(decl, { f, i });
    });
  }
  for (const [decl, at] of seen) hit('shadow-sprawl', at.f, at.i + 1, decl);
}

// ── 5e. raw colour literals ──────────────────────────────────────────────────
// A hex/rgb/hsl literal outside a custom-property DEFINITION is a colour that does not theme
// and that contrast.mjs cannot see. Defining a token (`--x: #…`) is where literals belong, in
// the :root blocks or a scoped re-definition like the 3D scrim, so those lines are exempt.
// Comments are stripped first: a hex in prose is documentation, not paint.
for (const f of css) {
  let inComment = false;
  read(f).forEach((l, i) => {
    let code = l;
    if (inComment) {
      const end = code.indexOf('*/');
      if (end === -1) return;
      code = code.slice(end + 2);
      inComment = false;
    }
    code = code.replace(/\/\*.*?\*\//g, '');
    const open = code.indexOf('/*');
    if (open !== -1) { code = code.slice(0, open); inComment = true; }
    if (/^\s*--[a-zA-Z0-9-]+\s*:/.test(code)) return;
    if (/#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?)\(/.test(code)) hit('raw-colour', f, i + 1, l);
  });
}

// ── 5f. literal line-heights ────────────────────────────────────────────────
// §3 once said "1 or 1.45, no other values" and nothing checked it, so seventeen values
// accumulated (1.02, 1.05, 1.1, 1.3, 1.35, 1.5, 1.55, 16px …). The --ds-lh-* tokens name the
// four the design actually uses; a bare number in `line-height:` or after the `/` of a `font:`
// shorthand is a finding. `0` (an icon's collapsed line box), `normal`, `inherit` and var() are not.
for (const f of css) {
  read(f).forEach((l, i) => {
    const code = l.replace(/\/\*.*?\*\//g, '');
    if (/(?:^|[\s;{])line-height:\s*[0-9.]+(px|em|rem|%)?\s*(;|}|$)/.test(code) && !/line-height:\s*0\s*(;|}|$)/.test(code)) hit('literal-line-height', f, i + 1, l);
    else if (/(?:^|[\s;{])font:[^;]*\/\s*[0-9.]+(px|em)?\s/.test(code)) hit('literal-line-height', f, i + 1, l);
  });
}

// ── 6. the 4px grid ──────────────────────────────────────────────────────────
// 2px is allowed inside chips/badges only; every other off-grid value is a finding.
const ON_GRID = new Set([0, 2, 4, 8, 12, 16, 24, 32, 48]);
for (const f of css) {
  read(f).forEach((l, i) => {
    const m = l.match(/^\s*(gap|row-gap|column-gap):\s*([0-9]+)px/);
    if (m && !ON_GRID.has(Number(m[2]))) hit('off-grid-gap', f, i + 1, l);
    const p = l.match(/^\s*padding:\s*([0-9]+)px(?:\s+([0-9]+)px)?/);
    if (p) {
      for (const v of [p[1], p[2]].filter(Boolean)) {
        if (!ON_GRID.has(Number(v))) { hit('off-grid-gap', f, i + 1, l); break; }
      }
    }
  });
}

// ── 6b. shell rules live in shell.css ────────────────────────────────────────
// styles.css is the in-match sheet (tutorial.css owns its surface). A `.ds-*` rule
// anywhere else is a shell rule in the wrong file, where a grep of shell.css never finds it.
for (const f of css.filter((x) => !/shell\.css$/.test(x))) {
  read(f).forEach((l, i) => {
    if (/^\s*\.ds-(?!tut)/.test(l)) hit('ds-outside-shell', f, i + 1, l);
  });
}

// ── 6c. motion timing comes from the tokens ──────────────────────────────────
// --ds-dur-press (a keycap's sink) and --ds-dur-fade (every colour-only state change). A literal
// duration on a transition is one more speed; the reduced-motion kill-switch is exempt.
for (const f of css) {
  read(f).forEach((l, i) => {
    const code = l.replace(/\/\*.*?\*\//g, '');
    if (/^\s*transition(-duration)?:.*\b[0-9.]+m?s\b/.test(code) && !/0\.001ms/.test(code)) hit('literal-duration', f, i + 1, l);
  });
}

// ── 7. the component index is current ────────────────────────────────────────
// `docs/ui-components.md` is generated from the CSS by `scripts/uiindex.mjs`, and its whole
// value is answering "does a class for this already exist?". A STALE index answers that with
// a confident no, which is worse than having none — so it is regenerated here and compared.
{
  const OUT = 'docs/ui-components.md';
  const before = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  /**
   * ⚠️ COMPARE CONTENT, NOT LINE ENDINGS. `core.autocrlf` is true on Windows, so this
   * file is CHECKED OUT as CRLF while `uiindex.mjs` writes LF — which made this rule
   * fire on every run of a fresh Windows checkout, whether or not the CSS had moved. A
   * check that is always red is worse than no check: it stops meaning anything, and the
   * real staleness it exists to catch hides inside it. Same bug class as the CRLF split
   * in the BIOBUZZ smoke source guards.
   */
  const eol = (s) => s.replace(/\r\n/g, '\n');
  try {
    execFileSync(process.execPath, ['scripts/uiindex.mjs'], { stdio: 'pipe' });
    const after = readFileSync(OUT, 'utf8');
    // restore byte-for-byte whenever anything changed, EOLs included: the run is the
    // report, and it must not leave the working tree dirty either way
    if (before !== after) writeFileSync(OUT, before);
    if (eol(before) !== eol(after)) {
      hit('stale-component-index', OUT, 1, 'run `npm run uiindex` and commit the result');
    }
  } catch (e) {
    hit('stale-component-index', OUT, 1, `uiindex failed: ${String(e).slice(0, 80)}`);
  }
}

// ── report ───────────────────────────────────────────────────────────────────
const DESC = {
  'undefined-token': 'var() names a custom property that is defined nowhere',
  'duplicate-selector': 'one selector declared by two top-level blocks',
  'var-literal-fallback': 'var(--x, #literal) — the fallback hides a missing token',
  'font-inherit-mix': 'inherit/initial beside other values in font: — the whole declaration drops',
  'ghost-primary': 'ghost + primary on one button — the label goes white on the page surface',
  'inline-spacing': 'spacing literal in JSX; it belongs to a class',
  'fractional-font-size': 'fractional font-size; the scale has six whole steps',
  'banned-font-weight': 'weight outside the seven the variable cuts actually use',
  'off-grid-gap': 'gap/padding off the 4px grid',
  'off-scale-font-size': 'font-size outside the type scale (§3)',
  'literal-radius': 'literal border-radius; §4 says use a --ds-round token',
  'shadow-sprawl': 'distinct box-shadow declarations; DESIGN.md commits to ONE depth model',
  'raw-colour': 'hex/rgb/hsl literal outside a --token definition; it neither themes nor is contrast-checked',
  'literal-line-height': 'literal line-height; use a --ds-lh-* token (§3)',
  'ds-outside-shell': 'a .ds-* shell rule outside shell.css',
  'literal-duration': 'literal transition duration; use --ds-dur-press / --ds-dur-fade',
  'stale-component-index': 'docs/ui-components.md is out of date with the CSS',
};

let failed = 0;
let ratcheted = 0;
const rules = Object.keys(BASELINE);
console.log('UI STANDARD AUDIT — docs/ui-standard.md\n');
for (const rule of rules) {
  const n = (found.get(rule) ?? []).length;
  const base = BASELINE[rule];
  const state = n > base ? 'FAIL' : n < base ? 'IMPROVED' : 'ok';
  if (n > base) failed++;
  if (n < base) ratcheted++;
  const pad = rule.padEnd(21);
  console.log(`${state === 'FAIL' ? '✗' : state === 'IMPROVED' ? '↓' : '·'} ${pad} ${String(n).padStart(3)} / ${String(base).padStart(3)}  ${DESC[rule]}`);
  if (n > base || base === 0) {
    for (const v of (found.get(rule) ?? []).slice(0, 25)) {
      console.log(`    ${v.file}:${v.line}  ${v.text}`);
    }
    const extra = n - 25;
    if (extra > 0) console.log(`    … and ${extra} more`);
  }
}
console.log();
if (failed) {
  console.log(`${failed} rule(s) got WORSE than the recorded baseline. Fix them, or change`);
  console.log('the standard in docs/ui-standard.md first and say so in the commit.');
  process.exit(1);
}
if (ratcheted) {
  console.log(`${ratcheted} rule(s) IMPROVED — lower the BASELINE in scripts/uiaudit.mjs to lock it in.`);
  process.exit(1);
}
console.log('ALL RULES AT OR UNDER BASELINE');
