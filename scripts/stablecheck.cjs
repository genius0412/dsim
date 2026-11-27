/* THE STABLE CHANNEL, AS PRODUCTION SHOWS IT TODAY: the importer is closed. Asserts in the DOM that nothing of
 * the importer (or of the autonomous panel) is reachable, and photographs Home, Play, Configure ▸ Controls and one
 * solo practice start at 1366x657 and 1920x1080 in both themes, for reading.
 *
 *   # a production build WITHOUT VITE_APP_CHANNEL and VITE_ROBOT_IMPORT (a dev server always opens the importer):
 *   npx vite build --outDir scratch/dist-stable --emptyOutDir
 *   npx vite preview --outDir scratch/dist-stable --port 5195 --strictPort
 *   env -u ELECTRON_RUN_AS_NODE npx electron scripts/stablecheck.cjs [--port 5195] [--out scratch/window-pass/stable] [--shots 0]
 *
 * Offscreen and muted, on an in-memory partition. Exit code 1 on any FAIL.
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = `http://localhost:${argOf('port', '5195')}`;
const OUT = path.resolve(argOf('out', path.join('scratch', 'window-pass', 'stable')));
const SHOTS = argOf('shots', '1') !== '0';
const ALPHA = process.argv.includes('--alpha'); // sanity run against the alpha client: the same probes must see the importer
fs.mkdirSync(OUT, { recursive: true });
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log('WATCHDOG'); process.exit(2); }, 600000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1366, height: 657, show: false, useContentSize: true, webPreferences: { backgroundThrottling: false, offscreen: true, partition: `stable-${Date.now()}` } });
  win.webContents.setAudioMuted(true);
  const js = (s) => win.webContents.executeJavaScript(s);
  let failures = 0;
  const check = (name, ok, detail = '') => {
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  };
  const until = (expr, ms = 15000) =>
    js(`(async () => { for (let t = 0; t < ${ms}; t += 100) { try { if (${expr}) return true; } catch {} await new Promise((r) => setTimeout(r, 100)); } return false; })()`);
  const go = async (route, wait = 1800) => { await win.loadURL(BASE + route); await sleep(wait); };
  const body = () => js(`document.body.innerText`);
  const shot = async (name) => fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const setSize = (w, h) => { win.setContentSize(w, h); return sleep(600); };
  const prefs = async (theme) => {
    await win.loadURL(BASE + '/');
    await js(`localStorage.clear(); localStorage.setItem('decodesim.theme', ${JSON.stringify(theme)}); localStorage.setItem('decodesim.graphics', JSON.stringify({ preset: 'low', tier: 'low' })); true`);
  };

  await prefs('dark');
  // ── the importer is closed ──
  await go('/decode/modes');
  const modes = await body();
  const buttons = await js(`[...document.querySelectorAll('button, a')].map((b) => b.textContent.trim()).filter(Boolean)`);
  const hasImport = buttons.some((t) => /^import\b/i.test(t) || /import a robot/i.test(t));
  check(ALPHA ? 'ALPHA SANITY: Play shows an Import button' : 'Play shows no Import button or way into the importer', ALPHA ? hasImport : !hasImport, JSON.stringify(buttons.filter((t) => /import/i.test(t))));
  check('Play: no mention of imported robots', ALPHA || !/imported|import a robot/i.test(modes), (/.{0,40}imported.{0,40}/i.exec(modes) || [''])[0]);
  await go('/decode/configure/robot/import');
  const route = await js(`({ path: location.pathname, editor: !!document.querySelector('.ds-import'), h1: document.querySelector('h1')?.textContent })`);
  check(ALPHA ? 'ALPHA SANITY: the import route opens the editor' : 'the importer route does not open the editor', ALPHA ? route.editor : !route.editor && !/import/i.test(route.h1 ?? ''), JSON.stringify(route));
  console.log(`NOTE  /decode/configure/robot/import → ${JSON.stringify(route)}`);
  for (const sec of ['robot', 'controls', 'audio', 'network']) {
    await go(`/decode/configure/${sec}`);
    const t = await body();
    const bad = /imported robot|import a robot|robot import|share my imported|robot’s look|robot's look|\.glb|\bimport\b/i.exec(t);
    check(ALPHA ? `ALPHA SANITY: configure/${sec}` : `Configure ▸ ${sec}: nothing about imported robots or sharing a robot's look`, ALPHA || !bad, bad ? bad[0] + ' … ' + t.slice(Math.max(0, bad.index - 40), bad.index + 60).replace(/\n/g, ' / ') : '');
    if (sec === 'robot') {
      const hint = await js(`document.querySelector('.ds-subnav-btn .sh')?.textContent?.trim() ?? null`);
      check(ALPHA ? 'ALPHA SANITY: the Robot sidebar entry names importing' : 'the Robot sidebar entry says nothing of importing (production’s own words)', ALPHA ? /import/i.test(hint ?? '') : hint === 'Presets, build, intake', String(hint));
    }
    if (sec === 'network') console.log('NOTE  network page text: ' + JSON.stringify(t.slice(0, 700)));
  }
  // The Autonomous panel lives in BIOBUZZ's Solo setup popup (Play ▸ Solo ▸ Match setup) and nowhere else: DECODE has
  // no autos, and `/<game>/configure/match` is not a screen (it opens Play), so probing there found nothing on any
  // channel (the ALPHA run failed, the stable run passed for no reason).
  await go('/biobuzz/modes');
  const opened = await js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Match setup'); if (!b) return false; b.click(); return true; })()`);
  await sleep(2500);
  const auto = await js(`(() => { const d = document.querySelector('.ds-solosetup'); const t = d ? d.innerText : ''; const h = d ? [...d.querySelectorAll('h2')].map((x) => x.textContent.trim()).filter((x) => /^Autonomous/.test(x)) : []; return { popup: !!d, heading: h[0] ?? null, panel: /New in Zenith/.test(t), off: /isn’t included in this build/.test(t), mention: (/.{0,30}(autonomous|zenith).{0,30}/i.exec(t) || [''])[0] }; })()`);
  check('BIOBUZZ Match setup opens (the probe is looking at the right screen)', opened && auto.popup, JSON.stringify(auto));
  check(ALPHA ? 'ALPHA SANITY: BIOBUZZ Match setup has the Autonomous panel' : 'BIOBUZZ Match setup says nothing about Autonomous or Zenith (no heading, no panel, no "not included" sentence)', ALPHA ? !!auto.heading && auto.panel && !auto.off : !auto.heading && !auto.panel && !auto.off && !auto.mention, JSON.stringify(auto));
  await go('/decode/modes');
  check(ALPHA ? 'ALPHA SANITY' : 'Play: no Autonomous mention', ALPHA || !/Autonomous/i.test(await body()));
  // the deployed gate: the lobby's setting and the imported card never exist; the presence-less client has no game server here
  const html = await js(`document.documentElement.innerHTML`);
  check('the page has no importer chunk wired in (no ImportEditor script in the DOM)', ALPHA || !/ImportEditor/.test(html));

  // ── shots ──
  if (SHOTS) {
    for (const [w, h] of [[1366, 657], [1920, 1080]]) {
      for (const theme of ['light', 'dark']) {
        await setSize(w, h);
        await prefs(theme);
        const tag = `${w}x${h}-${theme}`;
        await go('/', 2500); await shot(`${tag}-home`);
        await go('/decode/modes', 2500); await shot(`${tag}-play`);
        await go('/decode/configure/controls', 2000); await shot(`${tag}-controls`);
        await go('/decode/configure/robot', 2000); await shot(`${tag}-robot`);
        await go('/decode/modes', 2500);
        const solo = await js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /Solo practice/.test(x.textContent)); if (!b) return 'missing'; b.click(); return 'ok'; })()`);
        const started = await until(`!!document.querySelector('canvas') && !!document.querySelector('.game-btn')`, 30000);
        await sleep(2500);
        check(`${tag}: solo practice starts (${solo})`, solo === 'ok' && started);
        await shot(`${tag}-solo`);
        // START the match (Enter) and photograph the live HUD: the scoreboard sits at the bottom edge
        win.webContents.focus();
        for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: type === 'char' ? '\r' : 'Return' });
        await sleep(3500);
        await shot(`${tag}-solo-running`);
        const hud = await js(`(() => { const e = [...document.querySelectorAll('*')].filter((x) => /score|scoreboard|ds-hud/i.test(x.className?.toString?.() ?? '')).map((x) => { const r = x.getBoundingClientRect(); return { c: x.className.toString().slice(0, 30), b: Math.round(r.bottom), h: Math.round(r.height) }; }).filter((x) => x.h > 20); return { ih: innerHeight, e: e.slice(0, 6) }; })()`);
        console.log(`NOTE  ${tag} HUD boxes ${JSON.stringify(hud)}`);
        const overflow = await js(`({ sw: document.documentElement.scrollWidth, iw: innerWidth, sh: document.documentElement.scrollHeight, ih: innerHeight })`);
        console.log(`NOTE  ${tag} solo overflow ${JSON.stringify(overflow)}`);
      }
    }
  }
  console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
  app.exit(failures ? 1 : 0);
});
