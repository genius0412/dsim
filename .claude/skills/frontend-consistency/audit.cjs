/* Frontend-consistency auditor. Loads any URL(s) in Electron, extracts computed
 * styles from the live DOM, and reports whether the frontend behaves like ONE
 * design system or several: bounded typography/color/spacing/shape token sets,
 * same-role components sharing styles, visible focus states, WCAG contrast,
 * heading structure, and a mobile overflow/touch-target pass.
 *
 *   node_modules/.bin/electron .claude/skills/frontend-consistency/audit.cjs -- <url> [url...]
 *
 * The `--` before the URLs is REQUIRED with 2+ URLs (electron.exe exits -1
 * silently on multiple bare URL positionals; see the respawn note below).
 *
 * Env knobs:
 *   FCA_OUT=dir        output dir (default: a fresh temp dir; printed at boot)
 *   FCA_SETTLE=1500    ms to wait after load before measuring
 *   FCA_MAX_FOCUS=12   interactive elements sampled for the focus-visible probe
 *   FCA_MOBILE=0       skip the 375px pass
 *
 * Outputs: report.txt (human), report.json (machine), p<N>-desktop.png /
 * p<N>-mobile.png screenshots per page. Exit 1 if any FAIL-class issue
 * (contrast, missing focus indicator, mobile overflow), else 0.
 *
 * Measures the MAIN FRAME only; styles inside iframes are invisible to it.
 */
/* Agent shells (VS Code / Claude Code) export ELECTRON_RUN_AS_NODE=1, which makes
 * Electron boot as plain Node and `require('electron').app` come back undefined.
 * Detect that and respawn ourselves clean instead of crashing. */
const electronMod = require('electron');
if (typeof electronMod === 'string' || !electronMod.app) {
  const { spawnSync } = require('child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // `--` is load-bearing: electron.exe's shell crashes silently (exit -1) when it
  // sees 2+ bare URL positionals — the separator stops it from trying to open them.
  const r = spawnSync(process.execPath,
    [process.argv[1], '--', ...process.argv.slice(2).filter((a) => a !== '--')],
    { env, stdio: 'inherit' });
  if (r.error) console.error('respawn failed:', r.error.message);
  if (r.status === null || r.status < 0) console.error('respawn status:', r.status, 'signal:', r.signal);
  process.exit(r.status === null || r.status < 0 ? 3 : r.status);
}
const { app, BrowserWindow } = electronMod;
const path = require('path');
const fs = require('fs');
const os = require('os');

const URLS = process.argv.slice(2).filter((a) => /^https?:\/\//.test(a));
if (!URLS.length) {
  console.error('usage: npx electron audit.cjs <url> [url...]');
  process.exit(2);
}
const OUT = process.env.FCA_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'fca-'));
fs.mkdirSync(OUT, { recursive: true });
const SETTLE = Number(process.env.FCA_SETTLE || 1500);
const MAX_FOCUS = Number(process.env.FCA_MAX_FOCUS || 12);
const DO_MOBILE = process.env.FCA_MOBILE !== '0';
const DESKTOP = [1280, 900];
const MOBILE = [375, 812];

const REPORT = path.join(OUT, 'report.txt');
fs.writeFileSync(REPORT, '');
const log = (...a) => {
  const line = a.join(' ');
  fs.appendFileSync(REPORT, line + '\n');
  console.log(line);
};

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { log('WATCHDOG: run exceeded 10 min'); process.exit(3); }, 600000);
process.on('unhandledRejection', (e) => { log('UNHANDLED:', (e && e.stack) || e); process.exit(3); });
process.on('uncaughtException', (e) => { log('UNCAUGHT:', (e && e.stack) || e); process.exit(3); });

/* ---------------- in-page collector (serialized into the page) ------------- */
/* Self-contained: no closures over driver scope. Returns plain JSON. */
function collect(cfg) {
  const MAXEL = 8000;
  const seen = (m, k, n) => m.set(k, (m.get(k) || 0) + (n || 1));
  const mapObj = (m) => Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
  const px = (v) => Math.round(parseFloat(v) * 2) / 2;

  const parseColor = (s) => {
    const m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+%?))?\s*\)$/.exec(s);
    if (!m) return null;
    let a = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (m[4] && m[4].endsWith('%')) a /= 100;
    return [+m[1], +m[2], +m[3], a];
  };
  const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('') +
    (c[3] < 1 ? '@' + c[3].toFixed(2) : '');
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat([1]);

  const selPath = (el) => {
    const bit = (e) => {
      let s = e.tagName.toLowerCase();
      if (e.id) return s + '#' + e.id;
      const cls = typeof e.className === 'string' ? e.className.trim().split(/\s+/).slice(0, 2) : [];
      return s + (cls[0] ? '.' + cls.join('.') : '');
    };
    const parts = [];
    for (let e = el, i = 0; e && e.tagName && i < 3; e = e.parentElement, i++) parts.unshift(bit(e));
    return parts.join(' > ');
  };
  // effective background: composite ancestor backgroundColors; null if a
  // background-image intervenes before an opaque color (can't know the pixels)
  const effBg = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      const c = parseColor(cs.backgroundColor);
      if (c && c[3] > 0) layers.push(c);
      if (cs.backgroundImage !== 'none') return null;
      if (c && c[3] >= 1) break;
    }
    let bg = [255, 255, 255, 1];
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    return bg;
  };

  const all = [...document.querySelectorAll('*')];
  const truncated = all.length > MAXEL;
  const els = all.slice(0, MAXEL);

  const families = new Map(), sizes = new Map(), weights = new Map(), sizeLH = new Map();
  const textCol = new Map(), bgCol = new Map(), bdCol = new Map();
  const spacing = new Map(), radii = new Map(), shadows = new Map(), zIdx = new Map();
  const contrastFails = [];
  let textEls = 0;

  const SP = ['marginTop', 'marginRight', 'marginBottom', 'marginLeft',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'rowGap', 'columnGap'];

  for (const el of els) {
    if (el.closest('script,style,noscript,svg,head')) continue;
    let vis = true;
    try { vis = el.checkVisibility({ checkOpacity: true, visibilityProperty: true }); } catch { }
    if (!vis) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const cs = getComputedStyle(el);

    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length >= 3);
    if (hasText) {
      textEls++;
      seen(families, cs.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '').toLowerCase());
      const fs2 = px(cs.fontSize);
      seen(sizes, fs2);
      seen(weights, cs.fontWeight);
      const lh = parseFloat(cs.lineHeight);
      if (!isNaN(lh)) {
        if (!sizeLH.has(fs2)) sizeLH.set(fs2, new Set());
        sizeLH.get(fs2).add(Math.round((lh / fs2) * 20) / 20);
      }
      const col = parseColor(cs.color);
      if (col) {
        seen(textCol, hex(col));
        const disabled = el.closest('[disabled],[aria-disabled="true"]');
        const bg = effBg(el);
        if (bg && !disabled) {
          const rr = ratio(over(col, bg), bg);
          const large = fs2 >= 24 || (fs2 >= 18.66 && parseInt(cs.fontWeight) >= 700);
          const need = large ? 3 : 4.5;
          if (rr < need - 0.01) contrastFails.push({
            sel: selPath(el), ratio: Math.round(rr * 100) / 100, need,
            fg: hex(col), bg: hex(bg), text: el.textContent.trim().slice(0, 40),
          });
        }
      }
    }

    const bgc = parseColor(cs.backgroundColor);
    if (bgc && bgc[3] > 0) seen(bgCol, hex(bgc));
    if (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none') {
      const bc = parseColor(cs.borderTopColor);
      if (bc && bc[3] > 0) seen(bdCol, hex(bc));
    }
    for (const p of SP) {
      const v = px(cs[p]);
      if (v > 0 && v <= 400) seen(spacing, v);
    }
    const decorated = (bgc && bgc[3] > 0) || cs.boxShadow !== 'none' ||
      (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none');
    if (decorated) {
      const rad = cs.borderTopLeftRadius;
      if (rad && rad !== '0px') {
        const rv = parseFloat(rad);
        seen(radii, rad.includes('%') || rv >= Math.min(r.width, r.height) / 2 ? 'pill/circle' : px(rad) + 'px');
      }
      if (cs.boxShadow !== 'none') seen(shadows, cs.boxShadow.slice(0, 80));
    }
    if (cs.zIndex !== 'auto') seen(zIdx, parseInt(cs.zIndex));
  }

  // same-role component clusters
  const cluster = (list, sig) => {
    const groups = new Map();
    for (const el of list) {
      if (!el.getBoundingClientRect().width) continue;
      const cs = getComputedStyle(el);
      const key = sig(cs);
      if (!groups.has(key)) groups.set(key, { n: 0, sel: selPath(el), sig: key });
      groups.get(key).n++;
    }
    return [...groups.values()].sort((a, b) => b.n - a.n);
  };
  const buttons = cluster(
    [...document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a[class*="btn" i]')],
    (cs) => [cs.backgroundColor, cs.color, cs.borderRadius, cs.fontSize, cs.fontWeight,
      cs.borderTopWidth + ' ' + cs.borderTopColor, cs.paddingTop + '/' + cs.paddingLeft].join(' | '));
  const inputs = cluster(
    [...document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit]), textarea, select')],
    (cs) => [cs.backgroundColor, cs.color, cs.borderRadius, cs.fontSize,
      cs.borderTopWidth + ' ' + cs.borderTopColor, cs.paddingTop + '/' + cs.paddingLeft].join(' | '));
  const links = cluster(
    [...document.querySelectorAll('a[href]')].filter((a) =>
      [...a.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length >= 3)),
    (cs) => [cs.color, cs.textDecorationLine, cs.fontWeight].join(' | '));

  // heading structure
  const hs = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
    .filter((h) => h.getBoundingClientRect().width > 0).map((h) => +h.tagName[1]);
  let skips = 0;
  for (let i = 1; i < hs.length; i++) if (hs[i] > hs[i - 1] + 1) skips++;

  const lhMulti = [...sizeLH.entries()].filter(([, s]) => s.size > 1).map(([k, s]) => k + 'px×' + s.size);

  return {
    truncated, elements: els.length, textEls,
    families: mapObj(families), sizes: mapObj(sizes), weights: mapObj(weights), lhMulti,
    textCol: mapObj(textCol), bgCol: mapObj(bgCol), bdCol: mapObj(bdCol),
    spacing: mapObj(spacing), radii: mapObj(radii), shadows: mapObj(shadows), zIdx: mapObj(zIdx),
    contrastFails: contrastFails.slice(0, 20),
    buttons: buttons.slice(0, 12), inputs: inputs.slice(0, 12), links: links.slice(0, 12),
    headings: { levels: hs, h1: hs.filter((x) => x === 1).length, skips },
  };
}

/* mobile pass: overflow + touch targets only */
function collectMobile() {
  const doc = document.documentElement;
  const overflowPx = Math.max(0, doc.scrollWidth - window.innerWidth);
  const small = [];
  const inter = document.querySelectorAll('a[href], button, [role="button"], input:not([type=hidden]), select, textarea');
  for (const el of inter) {
    const cs = getComputedStyle(el);
    if (cs.display === 'inline') continue; // inline text links are WCAG-exempt
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.width < 24 || r.height < 24) {
      let s = el.tagName.toLowerCase();
      if (el.id) s += '#' + el.id;
      else if (typeof el.className === 'string' && el.className.trim()) s += '.' + el.className.trim().split(/\s+/)[0];
      small.push(s + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    }
  }
  return { overflowPx, small: small.slice(0, 15), interCount: inter.length };
}

/* ------------------------------- driver ----------------------------------- */
const nearDupes = (colorMaps) => {
  const parse = (h) => h.length >= 7 ? [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) : null;
  const all = new Map();
  for (const m of colorMaps) for (const [k, n] of Object.entries(m)) {
    if (!k.includes('@')) all.set(k, (all.get(k) || 0) + n);
  }
  const keys = [...all.keys()];
  const dupes = [];
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    const a = parse(keys[i]), b = parse(keys[j]);
    if (!a || !b) continue;
    const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    if (d > 0 && d < 16) dupes.push(keys[i] + ' ~ ' + keys[j]);
  }
  return { total: keys.length, dupes: dupes.slice(0, 12) };
};

app.whenReady().then(async () => {
  log(`== frontend-consistency audit · ${URLS.length} page(s) · out: ${OUT} ==`);
  const win = new BrowserWindow({
    width: DESKTOP[0], height: DESKTOP[1], show: true,
    webPreferences: { backgroundThrottling: false },
  });
  const js = (s) => win.webContents.executeJavaScript(s);
  const shoot = async (file) => {
    win.show(); win.focus();
    await sleep(150);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, file), img.toPNG());
  };

  // Attach CDP only after a real document is loaded (on a blank target DOM.enable
  // never resolves — same trap shiftaudit.cjs documents).
  await win.loadURL(URLS[0]);
  await sleep(SETTLE);
  const dbg = win.webContents.debugger;
  try { dbg.attach('1.3'); } catch (e) { log('CDP ATTACH FAILED: ' + e.message); process.exit(3); }
  const cmd = (method, params) => Promise.race([
    dbg.sendCommand(method, params),
    new Promise((_, rej) => setTimeout(() => rej(new Error('CDP timeout: ' + method)), 10000)),
  ]);
  await cmd('DOM.enable');
  await cmd('CSS.enable');

  const FOCUS_SEL = 'a[href], button, [role="button"], input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])';
  const FOCUS_PROPS = ['outlineStyle', 'outlineWidth', 'outlineColor', 'boxShadow', 'backgroundColor', 'borderTopColor', 'textDecorationLine'];
  const focusProbe = async () => {
    const { root } = await cmd('DOM.getDocument', { depth: -1 });
    let nodeIds = [];
    try {
      nodeIds = (await cmd('DOM.querySelectorAll', { nodeId: root.nodeId, selector: FOCUS_SEL })).nodeIds || [];
    } catch { return { sampled: 0, bare: [] }; }
    const readSel = (i) => js(`(() => {
      const e = document.querySelectorAll(${JSON.stringify(FOCUS_SEL)})[${i}];
      if (!e || !e.getBoundingClientRect().width) return null;
      const cs = getComputedStyle(e);
      const v = ${JSON.stringify(FOCUS_PROPS)}.map(p => cs[p]).join('|');
      let s = e.tagName.toLowerCase();
      if (e.id) s += '#' + e.id;
      else if (typeof e.className === 'string' && e.className.trim()) s += '.' + e.className.trim().split(/\\s+/)[0];
      return { v, s };
    })()`);
    // sample evenly across the page, not just the header
    const stride = Math.max(1, Math.floor(nodeIds.length / MAX_FOCUS));
    const bare = [];
    let sampled = 0;
    for (let i = 0; i < nodeIds.length && sampled < MAX_FOCUS; i += stride) {
      const base = await readSel(i);
      if (!base) continue;
      await cmd('CSS.forcePseudoState', { nodeId: nodeIds[i], forcedPseudoClasses: ['focus', 'focus-visible'] });
      await sleep(40);
      const focused = await readSel(i);
      await cmd('CSS.forcePseudoState', { nodeId: nodeIds[i], forcedPseudoClasses: [] });
      await sleep(40);
      sampled++;
      if (focused && focused.v === base.v) bare.push(base.s);
    }
    return { sampled, bare };
  };

  const pages = [];
  for (let p = 0; p < URLS.length; p++) {
    const url = URLS[p];
    log(`\n-- page ${p}: ${url}`);
    win.setContentSize(DESKTOP[0], DESKTOP[1]);
    if (p > 0) { await win.loadURL(url); await sleep(SETTLE); }
    const desktop = await js(`(${collect.toString()})({})`);
    const focus = await focusProbe();
    await shoot(`p${p}-desktop.png`);
    let mobile = null;
    if (DO_MOBILE) {
      win.setContentSize(MOBILE[0], MOBILE[1]);
      await sleep(600);
      mobile = await js(`(${collectMobile.toString()})()`);
      await shoot(`p${p}-mobile.png`);
      win.setContentSize(DESKTOP[0], DESKTOP[1]);
      await sleep(300);
    }
    pages.push({ url, desktop, focus, mobile });
    log(`   ${desktop.elements} elements (${desktop.textEls} text)${desktop.truncated ? ' TRUNCATED at 8000' : ''}`);
  }

  /* ----------------------------- aggregate --------------------------------- */
  const merge = (key) => {
    const m = new Map();
    for (const pg of pages) for (const [k, n] of Object.entries(pg.desktop[key])) m.set(k, (m.get(k) || 0) + n);
    return m;
  };
  const fmtTop = (m, n, unit) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, c]) => `${k}${unit || ''}(${c})`).join(' ');
  // values seen on exactly one page = cross-page drift candidates
  const pageLocal = (key) => {
    if (pages.length < 2) return [];
    const where = new Map();
    for (const pg of pages) for (const k of Object.keys(pg.desktop[key])) {
      if (!where.has(k)) where.set(k, new Set());
      where.get(k).add(pg.url);
    }
    return [...where.entries()].filter(([, s]) => s.size === 1).map(([k]) => k);
  };

  let warns = 0, fails = 0;
  const WARN = (s) => { warns++; log('   WARN ' + s); };
  const FAIL = (s) => { fails++; log('   FAIL ' + s); };

  log('\n== TYPOGRAPHY ==');
  const fam = merge('families'), siz = merge('sizes'), wgt = merge('weights');
  log(`   families: ${fam.size} — ${fmtTop(fam, 6)}`);
  if (fam.size > 3) WARN(`${fam.size} font families (a system usually has 1-2 + mono)`);
  log(`   sizes: ${siz.size} distinct — ${fmtTop(siz, 12, 'px')}`);
  if (siz.size > 10) WARN(`${siz.size} font sizes (a type scale is usually 6-9 steps)`);
  log(`   weights: ${fmtTop(wgt, 8)}`);
  const lhm = [...new Set(pages.flatMap((pg) => pg.desktop.lhMulti))];
  if (lhm.length) log(`   info: sizes with >1 line-height: ${lhm.join(' ')}`);

  log('\n== COLOR ==');
  const tc = merge('textCol'), bc = merge('bgCol'), dc = merge('bdCol');
  log(`   text: ${tc.size} — ${fmtTop(tc, 8)}`);
  log(`   background: ${bc.size} — ${fmtTop(bc, 8)}`);
  log(`   border: ${dc.size} — ${fmtTop(dc, 6)}`);
  const nd = nearDupes([Object.fromEntries(tc), Object.fromEntries(bc), Object.fromEntries(dc)]);
  log(`   total distinct (opaque): ${nd.total}`);
  if (nd.total > 25) WARN(`${nd.total} distinct colors (token-driven UIs usually stay under ~25)`);
  if (nd.dupes.length) WARN(`near-duplicate colors (ΔRGB<16): ${nd.dupes.join(', ')}`);

  log('\n== SPACING & SHAPE ==');
  const sp = merge('spacing');
  let on4 = 0, tot = 0;
  for (const [k, n] of sp) { tot += n; if (Math.abs(k % 4) < 0.3 || Math.abs((k % 4) - 4) < 0.3) on4 += n; }
  const adh = tot ? Math.round((on4 / tot) * 100) : 100;
  log(`   spacing: ${sp.size} distinct values · 4px-grid adherence ${adh}% (by usage) — ${fmtTop(sp, 12, 'px')}`);
  if (adh < 70) WARN(`only ${adh}% of spacing usage is on a 4px grid`);
  const rad = merge('radii'), sh = merge('shadows'), zi = merge('zIdx');
  log(`   radii: ${rad.size} — ${fmtTop(rad, 8)}`);
  if (rad.size > 6) WARN(`${rad.size} corner radii (systems usually use 2-4)`);
  log(`   shadows: ${sh.size} distinct · z-indices: ${[...zi.keys()].sort((a, b) => a - b).join(',') || 'none'}`);
  if (sh.size > 6) WARN(`${sh.size} distinct box-shadows (an elevation scale is usually 2-4)`);

  log('\n== COMPONENTS (per page) ==');
  for (const pg of pages) {
    const b = pg.desktop.buttons, i = pg.desktop.inputs, l = pg.desktop.links;
    const ones = b.filter((x) => x.n === 1);
    log(`   ${pg.url}`);
    log(`     buttons: ${b.length} style cluster(s) [${b.map((x) => x.n).join(',')}] · inputs: ${i.length} · link styles: ${l.length}`);
    if (b.length > 5) WARN(`${b.length} distinct button styles on one page — ${ones.slice(0, 3).map((x) => x.sel).join(' ; ')}`);
    if (i.length > 3) WARN(`${i.length} distinct input styles on one page — ${i[i.length - 1].sel}`);
    if (l.length > 4) WARN(`${l.length} distinct link styles on one page`);
  }

  log('\n== STATES & ACCESSIBILITY FLOOR ==');
  for (const pg of pages) {
    const f = pg.focus;
    if (f.bare.length) FAIL(`${pg.url} — ${f.bare.length}/${f.sampled} sampled interactive elements show NO visible :focus-visible change: ${f.bare.slice(0, 5).join(', ')}`);
    else log(`   focus-visible ok (${f.sampled} sampled) — ${pg.url}`);
    const cf = pg.desktop.contrastFails;
    if (cf.length) {
      FAIL(`${pg.url} — ${cf.length} WCAG contrast failure(s):`);
      cf.slice(0, 6).forEach((c) => log(`         ${c.ratio}:1 (needs ${c.need}) ${c.fg} on ${c.bg} — ${c.sel} "${c.text}"`));
    } else log(`   contrast ok — ${pg.url}`);
    const h = pg.desktop.headings;
    if (h.h1 !== 1 || h.skips) WARN(`${pg.url} — headings: ${h.h1} h1, ${h.skips} skipped level(s) [${h.levels.join(',')}]`);
  }

  if (DO_MOBILE) {
    log('\n== MOBILE (375px) ==');
    for (const pg of pages) {
      const m = pg.mobile;
      if (!m) continue;
      if (m.overflowPx > 1) FAIL(`${pg.url} — horizontal overflow ${m.overflowPx}px at 375px`);
      else log(`   no overflow — ${pg.url}`);
      if (m.small.length) WARN(`${pg.url} — ${m.small.length} touch target(s) under 24px: ${m.small.slice(0, 5).join(', ')}`);
    }
  }

  if (pages.length > 1) {
    log('\n== CROSS-PAGE DRIFT (values used on exactly one page) ==');
    for (const [key, label] of [['families', 'families'], ['sizes', 'font sizes'], ['radii', 'radii']]) {
      const loc = pageLocal(key);
      if (loc.length) log(`   ${label}: ${loc.slice(0, 10).join(', ')}`);
    }
  }

  log(`\n== verdict: ${fails} FAIL · ${warns} WARN · report: ${REPORT} ==`);
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ urls: URLS, pages, warns, fails }, null, 1));
  dbg.detach();
  process.exit(fails ? 1 : 0);
});
app.on('window-all-closed', () => process.exit(0));
