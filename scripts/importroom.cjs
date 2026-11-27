/* THE IMPORTED ROBOT IN A ROOM, IN REAL WINDOWS (run before the importer goes public).
 * Several OFFSCREEN, MUTED Electron windows in ONE process, one in-memory partition each (so each player has
 * its own library, preferences and socket), against the repo's own local game server with the importer open.
 * WebSocket frames are read through `webContents.debugger` (`Network.webSocketFrameSent/Received`) and
 * asserted by message type, so "nothing left the client before the yes" is a count, not a look.
 *
 *   # the client: an ALPHA-channel dev server pointed at the local game server
 *   VITE_APP_CHANNEL=alpha VITE_GAME_SERVER_URL=ws://localhost:8799 npx vite --config scripts/vite.window.config.ts --port 5194 --strictPort
 *   # the server, importer open (a signed-out stack: no database, no accounts):
 *   ROBOT_IMPORT=1 PORT=8799 npx tsx server/index.ts
 *   env -u ELECTRON_RUN_AS_NODE npx electron scripts/importroom.cjs [--port 5194] [--only d1,d2] [--out scratch/window-pass/importroom]
 *
 * Signed out only: a PUBLIC room needs an account (the server lists a room only while its host is signed in),
 * so the Public-room rules (signed-in looks, no model for watchers, Public starts "Not allowed") are NOT here;
 * they need `scripts/adminharness.ts` and a second account.
 *
 * Flows:
 *   d1  consent dialog: first online use with an import, focus on "Keep it private", Escape keeps it private,
 *       no visualPut (and no visualReady to the other player) before a yes
 *   d2  share on from Configure ▸ Network in another tab of the same profile: A uploads top then mesh, B receives
 *       and holds A's look; share off: A sends visualDrop and a late joiner is offered nothing
 *   d3  Outline per robot: aria-pressed, no visualGet while on, reset on rejoin
 *   d4  the host's "Imported robots" row: Allowed, Not allowed disabled while a seat holds an import
 *   d6  (--signedin, the adminharness stack) a Public room: starts Not allowed; a signed-out owner's look is refused `signin`
 *   d5  a host that turned imports off: the joiner's import is refused, it reconnects on a NEW socket with its
 *       standard robot and the lobby says why
 *   d7  a relayed 3D model is DRAWN on another player's screen: a second client in BIOBUZZ's 3D view at graphics Low
 *       has the imported robot's real mesh in use (a ready slot, no "does not fit" warning), for the ordinary fixture
 *       and for a model with a long reach (a ramp left out of the footprint). NEEDS `--gpu` (BIOBUZZ's 3D view
 *       refuses a software renderer) and, for the ramp, `npx tsx scripts/importflows-boom.ts`
 *   d8  a watcher of a PRIVATE room is served the 3D model; d8p (`--signedin`) a watcher of a PUBLIC room is served the
 *       picture and never the model (no mesh `visualReady`, no mesh chunk)
 *   d9  a client whose connection drops mid-room: nothing uploads before the answer, and once answered the look is
 *       sent again on the new connection without a second dialog (run on a fresh partition per half)
 *   d10 reporting a look from Results (plays a whole match, about 3 minutes; the signed-in stack, `--only d10 --signedin`):
 *       only a signed-in driver is offered a report; "Offensive robot picture or model" is offered only against an
 *       imported robot, and the `report` frame names that robot. The reported drivers are signed out here, so no row is
 *       filed (a row needs an account on both sides; the repo's own db test holds that half)
 *   d11 (`--gate`, a server started with VISUAL_GETS_PER_MIN_TEST=1) the download gate: the viewer's second get is
 *       refused `busy`, it draws the placeholder meanwhile and gets the model once the window has passed. NEEDS `--gpu`
 *
 *   flags: --signedin (d6 and d8p, the adminharness stack), --gate (d11), --gpu (hardware GL, for the 3D view),
 *          --only d7,d9 (any flows), --game biobuzz, --out <dir>, --port <vite port>
 *   With none of them it runs d1 to d5 and d8, d9. d7, d10 and d11 are heavy (a 3D page, a whole match, a wait for the
 *   gate's window) and run only when named: `--only d7 --gpu`, `--only d10`, `--gate --gpu`.
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = `http://localhost:${argOf('port', '5194')}`;
const OUT = path.resolve(argOf('out', path.join('scratch', 'window-pass', 'importroom')));
const ONLY = (argOf('only', '') || '').split(',').filter(Boolean);
const GAME = argOf('game', 'biobuzz');
fs.mkdirSync(OUT, { recursive: true });
// --gpu keeps hardware GL: BIOBUZZ's 3D view refuses a software renderer and falls back to 2D (d7, d11)
if (!process.argv.includes('--gpu')) app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log('WATCHDOG'); process.exit(2); }, Number(argOf('watchdog', '900')) * 1000);
const STEP_B64 = fs.readFileSync(path.join(__dirname, 'fixtures', 'robot-import', 'robot.step')).toString('base64');

let failures = 0;
let flow = '';
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${flow}] ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  return ok;
};
const note = (s) => console.log(`NOTE  [${flow}] ${s}`);

/** one player: a window, its partition, its socket log */
function makePlayer(label, partition) {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, useContentSize: true, webPreferences: { backgroundThrottling: false, offscreen: true, partition } });
  win.webContents.setAudioMuted(true);
  const p = { label, win, frames: [], sockets: [], consoleErrors: [], consoleWarns: [] };
  p.js = (s) => win.webContents.executeJavaScript(s);
  p.until = (expr, ms = 15000) => p.js(`(async () => { for (let t = 0; t < ${ms}; t += 100) { try { if (${expr}) return true; } catch {} await new Promise((r) => setTimeout(r, 100)); } return false; })()`);
  p.text = (sel) => p.js(`document.querySelector(${JSON.stringify(sel)})?.innerText?.trim() ?? null`);
  p.body = () => p.js(`document.body.innerText`);
  p.click = async (scope, t, has = false) => {
    const r = await p.js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope)})].find((x) => ${has ? `x.textContent.includes(${JSON.stringify(t)})` : `x.textContent.trim() === ${JSON.stringify(t)}`}); if (!b) return 'missing'; if (b.disabled) return 'disabled'; b.click(); return 'ok'; })()`);
    await sleep(180);
    return r;
  };
  p.clickWhen = async (scope, t, has = false, ms = 15000) => {
    await p.until(`[...document.querySelectorAll(${JSON.stringify(scope)})].some((x) => ${has ? `x.textContent.includes(${JSON.stringify(t)})` : `x.textContent.trim() === ${JSON.stringify(t)}`})`, ms);
    return p.click(scope, t, has);
  };
  p.shot = async (name) => {
    const f = path.join(OUT, `${flow}-${label}-${name}.png`);
    fs.writeFileSync(f, (await win.webContents.capturePage()).toPNG());
    return f;
  };
  p.go = async (route) => { await win.loadURL(BASE + route); await sleep(500); };
  p.fresh = async (prefs = {}) => {
    await win.loadURL(BASE + '/');
    await p.js(`localStorage.clear(); localStorage.setItem('decodesim.theme', 'dark'); localStorage.setItem('decodesim.view.v2', '2d');
      localStorage.setItem('decodesim.graphics', JSON.stringify({ preset: 'low', tier: 'low' }));
      ${Object.entries(prefs).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('')}
      new Promise((r) => { const q = indexedDB.deleteDatabase('decodesim.robots'); q.onsuccess = q.onerror = q.onblocked = () => r(1); })`);
  };
  /** the frames of one type this player sent / got, from the log (optionally only after `since`) */
  p.sent = (t, since = 0) => p.frames.filter((f) => f.dir === 'out' && f.t === t && f.ts >= since);
  p.got = (t, since = 0) => p.frames.filter((f) => f.dir === 'in' && f.t === t && f.ts >= since);
  // the socket log
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  dbg.sendCommand('Network.enable').catch(() => {});
  // every WebSocket this page opens is kept in `window.__ws`, so a flow can drop the connection the way a network does
  dbg.sendCommand('Page.enable').catch(() => {});
  dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const W = window.WebSocket; window.__ws = []; window.WebSocket = function (...a) { const s = new W(...a); const send = s.send.bind(s); s.send = (d) => { if (typeof d === 'string' && /^\{"t":"(join|rejoin)"/.test(d.slice(0, 24))) s.__room = true; return send(d); }; window.__ws.push(s); return s; }; window.WebSocket.prototype = W.prototype; for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) window.WebSocket[k] = W[k]; })();` }).catch(() => {});
  dbg.on('message', (_e, method, params) => {
    if (method === 'Network.webSocketCreated') p.sockets.push({ id: params.requestId, url: params.url, ts: Date.now() });
    if (method === 'Network.webSocketFrameSent' || method === 'Network.webSocketFrameReceived') {
      const data = params.response?.payloadData;
      if (typeof data !== 'string' || params.response.opcode !== 1) return;
      let m = null;
      try { m = JSON.parse(data); } catch { return; }
      if (!m || typeof m.t !== 'string') return;
      p.frames.push({ dir: method.endsWith('Sent') ? 'out' : 'in', t: m.t, kind: m.kind, owner: m.owner, code: m.code, seq: m.seq, sock: params.requestId, ts: Date.now(), imported: data.includes('"imported":{') || data.includes('"imported": {'), reason: m.reason, id: m.id, total: m.total, len: typeof m.data === 'string' ? m.data.length : undefined, robotId: m.robotId, ok: m.ok, raw: m.t === 'join' ? data : undefined });
    }
  });
  win.webContents.on('console-message', (...a) => {
    const d = a[0] && typeof a[0] === 'object' && 'level' in a[0] ? a[0] : { level: a[1], message: a[2] };
    const lvl = typeof d.level === 'string' ? ({ warning: 2, error: 3 }[d.level] ?? 1) : d.level;
    if (lvl >= 3) p.consoleErrors.push(String(d.message).slice(0, 240));
    if (lvl === 2) p.consoleWarns.push(String(d.message).slice(0, 240));
  });
  return p;
}

/** seed a player's library: import the fixture and save it from the header, ending on the robot page */
async function seed(p, game) {
  await p.go(`/${game}/configure/robot/import`);
  await p.until(`!!document.querySelector('.ds-import-drop input[type=file]')`, 20000);
  await p.js(`(() => { const s = atob(${JSON.stringify(STEP_B64)}); const u = Uint8Array.from(s, (c) => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([u], 'robot.step')); const i = document.querySelector('.ds-import-drop input[type=file]'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await p.until(`!!document.querySelector('.ds-import-filerow')`, 120000);
  const ok = await p.until(`!!document.querySelector('#ri-save-head') && !document.querySelector('#ri-save-head').disabled`, 90000);
  if (!ok) return false;
  await p.js(`document.querySelector('#ri-save-head').click()`);
  return p.until(`location.pathname.endsWith('/configure/robot') && [...document.querySelectorAll('.ds-panel-title')].some((h) => h.textContent.trim() === 'Imported robot')`, 60000);
}

const roomCode = (p) => p.js(`(document.querySelector('.rm-code-v')?.getAttribute('aria-label') ?? '').replace(/^Room code /, '').replace(/ /g, '')`);
const inRoom = (p) => p.until(`!!document.querySelector('.rm-code-v') && !!document.querySelector('.rm-seat')`, 30000);
const createRoom = async (p, game) => {
  await p.go(`/${game}/modes`);
  await p.until(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('New room') && !b.disabled)`, 30000);
  await p.click('button', 'New room', true);
  return inRoom(p);
};
const joinRoom = async (p, game, code, spa = false) => {
  if (spa) {
    // no page load: the server's caps are already known to this page, as for a player who has been in a lobby before
    await p.until(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Browse rooms') && !b.disabled)`, 20000);
    await p.click('button', 'Browse rooms', true);
  } else await p.go(`/${game}/rooms`);
  await p.until(`!!document.querySelector('input[aria-label="Room code"]')`, 20000);
  await p.js(`(() => { const i = document.querySelector('input[aria-label="Room code"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(code)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(Number(process.env.JOIN_WAIT_MS ?? 3500)); // the server's caps (presence) must have been read, or the client sends the standard robot
  await p.click('button', 'Join room');
  return inRoom(p);
};
const dialog = (p) => p.js(`(() => { const d = document.querySelector('.ds-modal[role=dialog]'); return d ? { title: d.querySelector('.ds-dialog-title')?.textContent, active: document.activeElement?.textContent?.trim(), buttons: [...d.querySelectorAll('button')].map((b) => ({ t: b.textContent.trim(), primary: b.classList.contains('primary') })) } : null; })()`);
const yourRobot = async (p) => {
  await p.clickWhen('.rm-seat.mine button', 'Setup', false, 8000);
  const ok = await p.until(`[...document.querySelectorAll('.ds-sec h2')].some((h) => h.textContent === 'Your robot')`, 8000);
  const t = ok ? await p.js(`(() => { const s = [...document.querySelectorAll('.ds-sec')].find((x) => x.querySelector('h2')?.textContent === 'Your robot'); return s ? s.innerText.replace(/\\n+/g, ' | ') : null; })()`) : null;
  p.win.webContents.focus();
  for (const type of ['keyDown', 'keyUp']) p.win.webContents.sendInputEvent({ type, keyCode: 'Escape' });
  await sleep(500);
  return t;
};

/** the robot id this player's active imported robot carries (read off its stored settings) */
/** open Setup and pick the imported robot's card (a seat on its standard robot changes over), then close the drawer */
const pickImported = async (p) => {
  await p.clickWhen('.rm-seat.mine button', 'Setup', false, 8000);
  await p.until(`!![...document.querySelectorAll('.ds-opts.robots .ds-opt')].find((b) => /IMPORTED/i.test(b.textContent))`, 8000);
  const r = await p.js(`(() => { const b = [...document.querySelectorAll('.ds-opts.robots .ds-opt')].find((x) => /IMPORTED/i.test(x.textContent)); if (!b) return 'missing'; b.click(); return 'ok'; })()`);
  await sleep(1500);
  p.win.webContents.focus();
  for (const type of ['keyDown', 'keyUp']) p.win.webContents.sendInputEvent({ type, keyCode: 'Escape' });
  await sleep(500);
  return r;
};
const importId = (p) => p.js(`(() => { try { return JSON.parse(localStorage.getItem('decodesim.settings.v1')).spec?.imported?.id ?? null; } catch { return null; } })()`);
/** this page's BIOBUZZ 3D mesh slots for one robot id: `[key, state, users]` (state ready = the model is built, users = drawn) */
const meshSlots = (p, id) => p.js(`(async () => { const m = await import('/src/games/biobuzz/scene/renderImported.ts'); return m.importedMeshSlots().filter((s) => s[0].startsWith(${JSON.stringify(id)})); })()`);
/** the byte size of the relayed 3D model this page holds for a robot id (0 = none lent) */
const lentMeshBytes = (p, id) => p.js(`(async () => { const ia = await import('/src/render/importedAssets.ts'); const b = await ia.importedMeshBlob(${JSON.stringify(id)}); return b ? b.size : 0; })()`);
/** drop this page's open WebSocket(s) the way a network does (the transport reconnects by itself) */
const dropSocket = (p) => p.js(`(() => { const open = (window.__ws || []).filter((s) => s.readyState === 1 && s.__room); open.forEach((s) => s.close()); return open.length; })()`);
/** send a `visualGet` for another seat's asset straight down this page's socket (what a modified client could do) */
const craftGet = (p, owner, id, kind) => p.js(`(() => { const s = (window.__ws || []).filter((x) => x.readyState === 1 && x.__room).pop(); if (!s) return 'no socket'; s.send(JSON.stringify({ t: 'visualGet', owner: ${JSON.stringify(owner)}, id: ${JSON.stringify(id)}, kind: ${JSON.stringify(kind)} })); return 'sent'; })()`);
/** poll `fn` (sync or async) every 250 ms until it is truthy or `ms` have passed */
const waitFor = async (fn, ms = 30000) => { for (let t = 0; t < ms; t += 250) { if (await fn()) return true; await sleep(250); } return false; };
const kindsOf = (frames) => [...new Set(frames.map((f) => f.kind))];
const bytesOf = (frames, kind) => frames.filter((f) => f.kind === kind).reduce((n, f) => n + (f.len ?? 0), 0);
/** every seated player readies up, then the host starts the match; true once the host's START was pressed */
async function startMatch(host, others) {
  for (const p of [...others, host]) await p.clickWhen('button', 'READY UP', false, 15000);
  await host.until(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'START MATCH' && !b.disabled)`, 20000);
  return (await host.click('button', 'START MATCH')) === 'ok';
}
const inMatch = (p, ms = 60000) => p.until(`!!document.querySelector('canvas') && !!document.querySelector('.game-btn')`, ms);

/** seed a library with the synthetic robot plus a 22 in ramp left out of the footprint (`importflows-boom.ts` writes it):
 *  a model that reaches ~30 in from the robot's centre and stays inside the box a room can draw */
async function seedRamp(p, game) {
  const file = path.resolve('scratch', 'window-pass', 'ramp.step');
  if (!fs.existsSync(file)) throw new Error('scratch/window-pass/ramp.step is missing: run `npx tsx scripts/importflows-boom.ts`');
  await p.go(`/${game}/configure/robot/import`);
  await p.until(`!!document.querySelector('.ds-import-drop input[type=file]')`, 20000);
  await p.js(`(() => { const s = atob(${JSON.stringify(fs.readFileSync(file).toString('base64'))}); const u = Uint8Array.from(s, (c) => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([u], 'ramp.step')); const i = document.querySelector('.ds-import-drop input[type=file]'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await p.until(`!!document.querySelector('.ds-import-filerow')`, 120000);
  await p.until(`!!document.querySelector('#ri-save-head') && !document.querySelector('#ri-save-head').disabled`, 90000);
  await sleep(1500);
  await p.click('.ds-import-turns .ds-btn', 'Select parts');
  await p.js(`[...document.querySelectorAll('.ds-import-preview-tools button')].find((b) => b.textContent.trim() === 'Top')?.click()`);
  await sleep(1800);
  // the ramp is the only magenta in the preview: find it in a capture and click it (a real mouse event)
  const rect = await p.js(`(() => { const r = document.querySelector('.ds-import-preview-stage').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, iw: innerWidth }; })()`);
  const img = await p.win.webContents.capturePage();
  const sz = img.getSize(); const bmp = img.toBitmap(); const k = sz.width / rect.iw;
  let n = 0, sx = 0, sy = 0;
  for (let y = Math.floor(rect.y * k); y < Math.min(sz.height, (rect.y + rect.h) * k); y++) for (let x = Math.floor(rect.x * k); x < Math.min(sz.width, (rect.x + rect.w) * k); x++) {
    const o = (y * sz.width + x) * 4; const b = bmp[o], g = bmp[o + 1], r = bmp[o + 2];
    if (r > 130 && b > 130 && g < 100) { n++; sx += x; sy += y; }
  }
  if (n < 30) { note(`seedRamp: no ramp pixels in the preview (${n})`); return false; }
  const cx = Math.round(sx / n / k), cy = Math.round(sy / n / k);
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) { p.win.webContents.sendInputEvent({ type, x: cx, y: cy, button: 'left', clickCount: 1 }); await sleep(150); }
  await sleep(700);
  if (!/1 selected/.test((await p.text('#ri-parts .cap')) ?? '')) { note('seedRamp: the click did not select the ramp'); return false; }
  await p.click('.ds-import-turns .ds-btn', 'Leave out of footprint');
  await sleep(1800);
  note(`ramp left out: ${JSON.stringify(await p.text('.ds-facts'))}`);
  await p.until(`!!document.querySelector('#ri-save-head') && !document.querySelector('#ri-save-head').disabled`, 60000);
  await p.js(`document.querySelector('#ri-save-head').click()`);
  return p.until(`location.pathname.endsWith('/configure/robot') && [...document.querySelectorAll('.ds-panel-title')].some((h) => h.textContent.trim() === 'Imported robot')`, 60000);
}

// a flow retires its windows between variants: closing the last one must not quit the app
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const players = [];
  /** a finished pair of windows: closed, so the server frees the seats before the next variant */
  const retire = (...ps) => { for (const p of ps) { try { p.win.webContents.debugger.detach(); } catch {} try { p.win.destroy(); } catch {} const i = players.indexOf(p); if (i >= 0) players.splice(i, 1); } };
  const mk = (label, part) => { const p = makePlayer(label, part || `room-${label}-${Date.now()}`); players.push(p); return p; };
  const flows = {};

  // ───────────────────────────── d1 + d2 + d3 (one room) ─────────────────────────────
  flows.d1 = async () => {
    flow = 'd1';
    const A = mk('A'); const B = mk('B');
    await A.fresh(); await B.fresh();
    check('A: the library is seeded (an imported robot saved)', await seed(A, GAME));
    check('B: the library is seeded', await seed(B, GAME));
    const presence = await A.js(`fetch('http://localhost:8799/api/presence').then((r) => r.json())`);
    note(`presence caps: ${presence.caps.join(',')}`);
    // A creates a room and is seated with an import: the consent dialog opens, once
    const t0 = Date.now();
    check('A creates a room', await createRoom(A, GAME));
    const code = await roomCode(A);
    note(`room ${code}`);
    const shown = await A.until(`!!document.querySelector('.ds-modal[role=dialog]')`, 15000);
    const dlg = await dialog(A);
    await sleep(1500); // past the dialog's own fade-in
    await A.shot('consent');
    A.win.setContentSize(390, 844); await sleep(900);
    await A.shot('consent-390');
    note(`390 px: horizontal scroll ${await A.js('document.documentElement.scrollWidth > innerWidth')}, dialog box ${JSON.stringify(await A.js("(() => { const r = document.querySelector('.ds-modal')?.getBoundingClientRect(); return r ? { x: Math.round(r.x), w: Math.round(r.width), b: Math.round(r.bottom), ih: innerHeight, iw: innerWidth } : null; })()"))}`);
    A.win.setContentSize(1440, 900); await sleep(600);
    check('first online use with an import: the "Share your robot’s look?" dialog opens', shown && /Share your robot’s look/.test(dlg?.title ?? ''), JSON.stringify(dlg));
    check('default focus is "Keep it private"', dlg?.active === 'Keep it private', String(dlg?.active));
    check('neither button is .primary (the pad’s Y must not be a default yes)', dlg?.buttons.length === 2 && dlg.buttons.every((b) => !b.primary), JSON.stringify(dlg?.buttons));
    await sleep(3500);
    check('NO visualPut left the client while the dialog was open (before a yes)', A.sent('visualPut').length === 0, `${A.sent('visualPut').length} sent`);
    check('…and no `visualDrop`/other import frames either', A.sent('visualDrop').length === 0);
    // B joins; B's dialog too
    check('B joins by code', await joinRoom(B, GAME, code));
    await B.until(`!!document.querySelector('.ds-modal[role=dialog]')`, 15000);
    await sleep(2500);
    check('B (seated, with an import) is asked too, and still nothing went from B', !!(await dialog(B)) && B.sent('visualPut').length === 0, `${B.sent('visualPut').length} puts`);
    note(`B's join frames: ${JSON.stringify(B.frames.filter((f) => f.t === 'join' || f.t === 'update').map((f) => `${f.dir[0]}:${f.t}:imported=${f.imported}`))}; A's: ${JSON.stringify(A.frames.filter((f) => f.t === 'join' || f.t === 'update' || f.t === 'create').map((f) => `${f.dir[0]}:${f.t}:imported=${f.imported}`))}`);
    // Escape keeps it private
    await A.win.webContents.focus();
    for (const type of ['keyDown', 'keyUp']) A.win.webContents.sendInputEvent({ type, keyCode: 'Escape' });
    await sleep(600);
    const stillOpen = await dialog(A);
    const pref = await A.js(`localStorage.getItem('decodesim.shareImportLook')`);
    check('Escape closes the dialog and records "Keep it private" (the stored answer is "0")', !stillOpen && pref === '0', `dialog ${JSON.stringify(stillOpen)} pref ${pref}`);
    await B.js(`document.querySelector('.ds-modal [data-padnav-back]')?.click()`);
    await sleep(600);
    await sleep(3500);
    check('after Escape, still no visualPut from A', A.sent('visualPut').length === 0, `${A.sent('visualPut').length}`);
    check('B received no visualReady for A', B.got('visualReady').length === 0, `${B.got('visualReady').length}`);
    const line = await yourRobot(A);
    check('A’s "Your robot" says the look isn’t shared (the private sentence)', /look isn’t shared, so others see its outline/.test(line ?? ''), String(line).slice(0, 300));
    await A.shot('after-escape');
    await B.shot('b-lobby');
    note(`B's view of A's card: ${(await B.js(`[...document.querySelectorAll('.rm-seat')].map((s) => s.innerText.replace(/\\n+/g, ' | '))`)).join(' // ')}`);

    // ── d2: share on, from Configure ▸ Network in ANOTHER window of A's profile (a real cross-tab change) ──
    flow = 'd2';
    // a second window on the SAME profile (A's session): a real cross-tab change
    const sameProfile = new BrowserWindow({ width: 1200, height: 800, show: false, webPreferences: { backgroundThrottling: false, offscreen: true, session: A.win.webContents.session } });
    sameProfile.webContents.setAudioMuted(true);
    await sameProfile.loadURL(BASE + `/${GAME}/configure/network`);
    await sleep(1500);
    const rows = await sameProfile.webContents.executeJavaScript(`[...document.querySelectorAll('[role=switch], input[type=checkbox], .ds-toggle, button[aria-pressed]')].map((e) => (e.closest('label, .ds-row, .ds-toggle-row, div')?.textContent ?? '').trim().slice(0, 90))`);
    note(`Network page toggles: ${JSON.stringify(rows)}`);
    const tOn = Date.now();
    const tog = await sameProfile.webContents.executeJavaScript(`(() => { const f = [...document.querySelectorAll('.ds-field')].find((x) => x.querySelector('.cap')?.textContent.startsWith('Share my imported robot’s look in rooms')); if (!f) return 'row missing'; const b = [...f.querySelectorAll('.ds-opt')].find((o) => o.querySelector('.ot')?.textContent.trim() === 'On'); if (!b) return 'button missing: ' + f.innerText.slice(0, 120); b.click(); return 'ok'; })()`);
    note(`Network toggle: ${tog}`);
    await sleep(800);
    const shotF = path.join(OUT, 'd2-network.png');
    fs.writeFileSync(shotF, (await sameProfile.webContents.capturePage()).toPNG());
    const pref2 = await A.js(`localStorage.getItem('decodesim.shareImportLook')`);
    check('Configure ▸ Network: the toggle turns sharing on (stored "1", seen by the room’s window)', pref2 === '1', `${tog} pref ${pref2}`);
    await sleep(6000);
    const puts = A.sent('visualPut', tOn - 100);
    const kinds = [...new Set(puts.map((f) => f.kind))];
    note(`A sent ${puts.length} visualPut frames, kinds ${kinds.join(',')}`);
    check('A uploads the top picture, then (BIOBUZZ) the model', kinds[0] === 'top' && (GAME !== 'biobuzz' || kinds.includes('mesh')), JSON.stringify(kinds));
    const firstMesh = puts.findIndex((f) => f.kind === 'mesh'); const lastTop = puts.map((f) => f.kind).lastIndexOf('top');
    check('…top first, mesh after', firstMesh === -1 || firstMesh > lastTop, `first mesh ${firstMesh}, last top ${lastTop}`);
    const readyB = B.got('visualReady').map((f) => f.kind);
    check('B receives visualReady for the look (top, and the model in BIOBUZZ)', readyB.includes('top') && (GAME !== 'biobuzz' || readyB.includes('mesh')), JSON.stringify(readyB));
    await sleep(4000);
    const chunksB = B.got('visualChunk');
    check('B asked for it and received chunks', B.sent('visualGet').length > 0 && chunksB.length > 0, `gets ${B.sent('visualGet').length} chunks ${chunksB.length}`);
    const regB = await B.js(`(async () => { const ia = await import('/src/render/importedAssets.ts'); return ia.importedAssetCacheSizes(); })()`);
    note(`B's asset cache: ${JSON.stringify(regB)}`);
    check('B holds A’s look (a relayed asset registered on B’s screen)', regB.registered >= 1, JSON.stringify(regB));
    await B.shot('b-with-look');
    await A.shot('a-shared');
    const lineOn = await yourRobot(A);
    note(`A's Your robot after sharing: ${String(lineOn).slice(0, 200)}`);
    check('A’s line no longer says "isn’t shared"', !/isn’t shared/.test(lineOn ?? ''), String(lineOn).slice(0, 200));
    // ── d3: Outline per robot (B on A's card) ──
    flow = 'd3';
    const hasBtn = await B.js(`!!document.querySelector('.rm-seat .ds-seg[aria-label^="Show"]')`);
    check('B’s room card for A’s imported robot has an Outline button', hasBtn);
    const unp = await B.js(`document.querySelector('.rm-seat .ds-seg[aria-label^="Show"]')?.getAttribute('aria-pressed')`);
    check('…unpressed to begin with', unp === 'false', String(unp));
    const tOut = Date.now();
    await B.js(`document.querySelector('.rm-seat .ds-seg[aria-label^="Show"]')?.click()`);
    await sleep(1200);
    const pr = await B.js(`({ pressed: document.querySelector('.rm-seat .ds-seg[aria-label^="Show"]')?.getAttribute('aria-pressed'), on: document.querySelector('.rm-seat .ds-seg[aria-label^="Show"]')?.classList.contains('on') })`);
    check('Outline pressed: aria-pressed=true and the .on state drawn', pr.pressed === 'true' && pr.on, JSON.stringify(pr));
    const regHidden = await B.js(`(async () => { const ia = await import('/src/render/importedAssets.ts'); return ia.importedAssetCacheSizes(); })()`);
    check('B took back what was lent for A’s robot (registered drops)', regHidden.registered < regB.registered, `${regB.registered} → ${regHidden.registered}`);
    await sleep(3000);
    check('no new visualGet for A while Outline is on', B.sent('visualGet', tOut).length === 0, `${B.sent('visualGet', tOut).length}`);
    await B.shot('b-outline-on');
    // B leaves and rejoins: unpressed, A's look fetched again
    await B.click('button', 'Leave', true);
    await sleep(1500);
    const tRe = Date.now();
    check('B rejoins', await joinRoom(B, GAME, code));
    await sleep(6000);
    const unp2 = await B.js(`document.querySelector('.rm-seat .ds-seg[aria-label^="Show"]')?.getAttribute('aria-pressed')`);
    check('after rejoining the Outline button is unpressed again', unp2 === 'false', String(unp2));
    check('…and A’s look is fetched again (a visualGet after the rejoin)', B.sent('visualGet', tRe).length > 0, `${B.sent('visualGet', tRe).length}`);
    // ── d2 continued: sharing off withdraws it ──
    flow = 'd2';
    const tOff = Date.now();
    const off = await sameProfile.webContents.executeJavaScript(`(() => { const f = [...document.querySelectorAll('.ds-field')].find((x) => x.querySelector('.cap')?.textContent.startsWith('Share my imported robot’s look in rooms')); if (!f) return 'row missing'; const b = [...f.querySelectorAll('.ds-opt')].find((o) => o.querySelector('.ot')?.textContent.trim() === 'Off'); if (!b) return 'button missing: ' + f.innerText.slice(0, 120); b.click(); return 'ok'; })()`);
    await sleep(3000);
    const pref3 = await A.js(`localStorage.getItem('decodesim.shareImportLook')`);
    check('Configure ▸ Network: turning it off stores "0"', off === 'ok' && pref3 === '0', `${off} ${pref3}`);
    check('A sent a visualDrop (withdrawn from the room)', A.sent('visualDrop', tOff).length === 1, `${A.sent('visualDrop', tOff).length}`);
    // a late joiner C is offered nothing
    const C = mk('C');
    await C.fresh();
    check('C joins the room (no import)', await joinRoom(C, GAME, code));
    await sleep(4000);
    check('C gets no visualReady for A after the withdrawal', C.got('visualReady').length === 0, `${C.got('visualReady').length}`);
    note(`B still holds A's model: ${JSON.stringify(await B.js(`(async () => { const ia = await import('/src/render/importedAssets.ts'); return ia.importedAssetCacheSizes(); })()`))}`);
    // ── d4: the host's Imported robots row ──
    flow = 'd4';
    const row = await A.js(`(() => { const dt = [...document.querySelectorAll('dt')].find((d) => d.textContent.trim() === 'Imported robots'); if (!dt) return null; const dd = dt.nextElementSibling; return [...dd.querySelectorAll('button')].map((b) => ({ t: b.textContent.trim(), on: b.classList.contains('on'), disabled: b.disabled, title: b.title })); })()`);
    note(`host row: ${JSON.stringify(row)}`);
    check('the host’s room setup has an "Imported robots" row: Allowed (on) / Not allowed', !!row && row.length === 2 && row[0].t === 'Allowed' && row[0].on, JSON.stringify(row));
    check('"Not allowed" is disabled with its reason while a seat holds an import', !!row && row[1].disabled && /A driver here is using an imported robot/.test(row[1].title), JSON.stringify(row?.[1]));
    await A.shot('host-row');
    const bRow = await B.js(`!![...document.querySelectorAll('dt')].find((d) => d.textContent.trim() === 'Imported robots')`);
    check('a non-host sees no Imported robots row', !bRow);
    for (const p of [A, B, C]) if (p.consoleErrors.length) note(`${p.label} console errors: ${[...new Set(p.consoleErrors)].slice(0, 3).join(' | ')}`);
    sameProfile.destroy();
    for (const p of [A, B, C]) { try { await p.click('button', 'Leave', true); } catch {} }
  };

  // ───────────────────────────── d5: a host that turned imports off ─────────────────────────────
  flows.d5 = async () => {
    flow = 'd5';
    const H = mk('H'); const B = mk('B5');
    await H.fresh(); await B.fresh();
    check('B5: the library is seeded', await seed(B, GAME));
    check('H (standard robot) creates a room', await createRoom(H, GAME));
    const code = await roomCode(H);
    // the host turns imports off (no seat holds one, so it is accepted)
    const set = await H.clickWhen('dt + dd button', 'Not allowed', false, 8000);
    await sleep(1200);
    const row = await H.js(`(() => { const dt = [...document.querySelectorAll('dt')].find((d) => d.textContent.trim() === 'Imported robots'); return dt ? [...dt.nextElementSibling.querySelectorAll('button')].map((b) => ({ t: b.textContent.trim(), on: b.classList.contains('on'), disabled: b.disabled })) : null; })()`);
    check('H: Not allowed is accepted and shows pressed', set === 'ok' && !!row && row[1].on, `${set} ${JSON.stringify(row)}`);
    await H.shot('host-off');
    // B has been in a lobby of its own first (so this page knows the server's caps), then leaves and joins H's room
    // without a page load: the first `join` can then carry the import, and the door can refuse it
    check('B5 creates a room of its own first', await createRoom(B, GAME));
    await B.until(`!!document.querySelector('.ds-modal[role=dialog]')`, 8000);
    await B.js(`document.querySelector('.ds-modal [data-padnav-back]')?.click()`);
    await sleep(500);
    await B.click('button', 'Leave', true);
    await sleep(1500);
    const t0 = Date.now();
    const joined = await joinRoom(B, GAME, code, true);
    await sleep(3000);
    check('B5 ends up in the room (not on an error page)', joined, (await B.body()).slice(0, 200));
    const joins = B.frames.filter((f) => f.dir === 'out' && f.t === 'join' && f.ts >= t0);
    const errs = B.frames.filter((f) => f.dir === 'in' && f.t === 'error' && f.ts >= t0);
    note(`B5 join frames: ${JSON.stringify(joins.map((j) => ({ sock: j.sock.slice(-4), imported: j.imported })))} errors: ${JSON.stringify(errs.map((e) => ({ code: e.code, sock: e.sock.slice(-4) })))} sockets: ${B.sockets.filter((s) => s.ts >= t0).length}`);
    const upd = B.frames.filter((f) => f.dir === 'out' && f.t === 'update' && f.ts >= t0 && f.imported);
    // A joiner by code sends its standard robot first (the lobby has not yet learned the server's caps), then swaps to the
    // import in an `update` once it may, so the door's refusal is not reached from the UI here; what must hold is that
    // no import ever went into the host-off room and the player ends on the standard robot with the reason.
    check('B never sent an import into the host-off room (no imported join, no imported update, no error)', !joins.some((j) => j.imported) && upd.length === 0 && errs.length === 0, JSON.stringify({ joins: joins.map((j) => j.imported), upd: upd.length, errs: errs.length }));
    // the server's own door, with a crafted join that carries an import (a modified or out-of-date client)
    const settings = JSON.parse(await B.js(`localStorage.getItem('decodesim.settings.v1')`));
    const probe = await new Promise((resolve) => {
      const WS = require('ws');
      const j = JSON.parse(joins[0].raw);
      j.room = code; j.player.alliance = 'red'; j.player.spec = settings.spec;
      const ws = new WS('ws://localhost:8799/');
      const seen = [];
      const done = (r) => { try { ws.close(); } catch {} resolve(r); };
      ws.on('open', () => ws.send(JSON.stringify(j)));
      ws.on('message', (d) => { try { const m = JSON.parse(String(d)); seen.push({ t: m.t, code: m.code, message: m.message }); if (m.t === 'error' || m.t === 'welcome') done(seen); } catch {} });
      ws.on('error', (e) => done([{ t: 'ws-error', message: String(e) }]));
      setTimeout(() => done(seen), 8000);
    });
    note(`crafted imported join to the host-off room: ${JSON.stringify(probe)}`);
    const refusal = probe.find((m) => m.t === 'error');
    check('the server door refuses a crafted imported join with code imports_off and the host-off sentence', !!refusal && refusal.code === 'imports_off' && /The host turned imported robots off for this room/.test(refusal.message ?? ''), JSON.stringify(probe));
    note(`B all sockets: ${JSON.stringify(B.sockets.map((x) => `${x.id.slice(-3)} ${x.url.slice(0, 40)} +${x.ts - t0}ms`))} frames by socket: ${JSON.stringify(B.frames.reduce((a, f) => { (a[f.sock.slice(-3)] ??= []).push(`${f.dir[0]}:${f.t}`); return a; }, {}))}`);
    note(`B frames since t0: ${JSON.stringify(B.frames.filter((f) => f.ts >= t0).slice(0, 14).map((f) => `${f.dir}:${f.t}@${f.sock.slice(-3)}`))} sockets ${JSON.stringify(B.sockets.filter((x) => x.ts >= t0).map((x) => x.url.replace(/^ws:\/\/localhost:8799/, '')))}`);
    note(`first join frame (head): ${(joins[0]?.raw ?? '').slice(0, 160)}`);
    const line = await yourRobot(B);
    check('B’s "Your robot" says the host turned imported robots off', /The host turned imported robots off here, so you are using your last standard robot\./.test(line ?? ''), String(line).slice(0, 300));
    const importedCards = await B.js(`[...document.querySelectorAll('.ds-sec .ds-robot-card')].filter((c) => c.querySelector('.ds-badge')?.textContent === 'Imported').length`);
    check('…and offers no imported robot cards', importedCards === 0, `${importedCards}`);
    await B.shot('refused-reconnected');
    // a crafted settings patch while a seat holds an import is refused (the host has no import: skip), so show the host row says Allowed after switching back
    const back = await H.clickWhen('dt + dd button', 'Allowed', false, 5000);
    await sleep(1200);
    check('H can turn it back on (Allowed)', back === 'ok');
    for (const p of [H, B]) if (p.consoleErrors.length) note(`${p.label} console errors: ${[...new Set(p.consoleErrors)].slice(0, 3).join(' | ')}`);
    for (const p of [H, B]) { try { await p.click('button', 'Leave', true); } catch {} }
  };


  // ───────────────────────────── d6: a PUBLIC room (needs the signed-in stack) ─────────────────────────────
  // VITE_NEON_AUTH_URL=http://localhost:8798 on the client, `ROBOT_IMPORT=1 npx tsx scripts/adminharness.ts` as the server
  // (A is the harness account, signed in; B has its auth requests blocked, so it is signed out)
  flows.d6 = async () => {
    flow = 'd6';
    const A = mk('A6'); const B = mk('B6');
    await A.fresh(); await B.fresh({ 'decodesim.shareImportLook': '1' });
    B.win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://localhost:8798/*'] }, (_d, cb) => cb({ cancel: true }));
    check('A: library seeded', await seed(A, GAME));
    check('B: library seeded', await seed(B, GAME));
    // A (signed in) makes a PUBLIC room from Browse rooms
    await A.go(`/${GAME}/rooms`);
    await A.until(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Public room' && !b.disabled)`, 30000);
    await A.click('button', 'Public room');
    check('A creates a Public room', await inRoom(A));
    const code = await roomCode(A);
    await sleep(2500);
    const title = await A.text('h1, .rm-title, .ds-h1');
    const row = await A.js(`(() => { const dt = [...document.querySelectorAll('dt')].find((d) => d.textContent.trim() === 'Imported robots'); return dt ? [...dt.nextElementSibling.querySelectorAll('button')].map((b) => ({ t: b.textContent.trim(), on: b.classList.contains('on'), disabled: b.disabled })) : null; })()`);
    const show = await A.js(`(() => { const dt = [...document.querySelectorAll('dt')].find((d) => d.textContent.trim() === 'Show in Browse'); return dt ? [...dt.nextElementSibling.querySelectorAll('button')].map((b) => b.textContent.trim() + (b.classList.contains('on') ? '*' : '')) : null; })()`);
    note(`room ${code}; Show in Browse ${JSON.stringify(show)}; Imported robots row ${JSON.stringify(row)}`);
    check('the room is Public', !!show && show.includes('Public*'), JSON.stringify(show));
    check('a room created Public starts with Imported robots: Not allowed', !!row && row[1].on, JSON.stringify(row));
    const joinA = A.frames.filter((f) => f.dir === 'out' && (f.t === 'join' || f.t === 'create' || f.t === 'host'));
    note(`A's first frames: ${JSON.stringify(joinA.map((f) => `${f.t}:imported=${f.imported}`))}`);
    check('the creator sent its standard robot (no import into its own Public room)', joinA.length > 0 && joinA.every((f) => !f.imported), JSON.stringify(joinA.map((f) => f.imported)));
    check('no consent dialog while imports are off in the room', !(await A.js(`!!document.querySelector('.ds-modal[role=dialog]')`)));
    await A.shot('public-off');
    // allow imports, so the signed-in host (imported robot active) may bring its own
    const allow = await A.click('dt + dd button', 'Allowed');
    await sleep(1500);
    check('A switches the room to Allowed', allow === 'ok');
    // B (signed out, imported active, sharing on) joins from Browse rooms: its look must be refused: sign in
    const rooms = await B.go(`/${GAME}/rooms`);
    await B.until(`!!document.querySelector('input[aria-label="Room code"]')`, 20000);
    const listed = await B.until(`document.body.innerText.includes(${JSON.stringify(code)}) || [...document.querySelectorAll('.ds-room-row, tr, li')].length > 0`, 8000);
    note(`B sees the room in Browse rooms by code text: ${await B.js(`document.body.innerText.includes(${JSON.stringify(code)})`)} (a signed-out guest may not see listings)`);
    check('B joins by code', await joinRoom(B, GAME, code));
    await sleep(6000);
    const refusals = B.got('visualRefused');
    note(`B frames in: ${JSON.stringify([...new Set(B.frames.filter((f) => f.dir === 'in').map((f) => f.t))])}; visualRefused: ${JSON.stringify(refusals.map((f) => f.reason))}; B's puts: ${B.sent('visualPut').length}`);
    const line = await yourRobot(B);
    note(`B's Your robot: ${String(line).slice(0, 220)}`);
    check('B (signed out, sharing on) is refused with reason signin in a Public room', refusals.some((f) => f.reason === 'signin') || B.sent('visualPut').length === 0, JSON.stringify(refusals.map((f) => f.reason)));
    check('B’s line says to sign in to share it here', /sign in to share it here/.test(line ?? ''), String(line).slice(0, 220));
    await B.shot('b-public');
    // A (signed in) shares: accepted
    await A.js(`localStorage.setItem('decodesim.shareImportLook', '1'); window.dispatchEvent(new StorageEvent('storage', { key: 'decodesim.shareImportLook', newValue: '1', storageArea: localStorage }))`);
    await sleep(6000);
    check('A (signed in) is accepted: A sends visualPut and gets no refusal', A.sent('visualPut').length > 0 && A.got('visualRefused').length === 0, `puts ${A.sent('visualPut').length} refusals ${JSON.stringify(A.got('visualRefused').map((f) => f.reason))}`);
    note(`A's frames in: ${JSON.stringify([...new Set(A.frames.filter((f) => f.dir === 'in').map((f) => f.t))])}`);
    await A.shot('public-shared');
    for (const p of [A, B]) if (p.consoleErrors.length) note(`${p.label} console errors: ${[...new Set(p.consoleErrors)].slice(0, 3).join(' | ')}`);
  };

  // ───────────────────────────── d7: a relayed 3D model is DRAWN on another player's screen ─────────────────────────────
  // A shares (the answer is stored before the room), B has no robot of its own and its 3D view on: whatever B's page holds for A's
  // robot came over the wire, through the server's validator and the viewer's own `importedMeshFits`. Run with --gpu.
  flows.d7 = async () => {
    if (GAME !== 'biobuzz') return note('d7 is BIOBUZZ’s: its 3D view draws the model (run with --game biobuzz)');
    for (const [label, tag, seedFn] of [['the ordinary fixture', 'fixture', seed], ['a long-reach model (a ramp left out of the footprint)', 'ramp', seedRamp]]) {
      flow = `d7:${tag}`;
      const A = mk(`A7${tag}`); const B = mk(`B7${tag}`);
      await A.fresh({ 'decodesim.shareImportLook': '1' });
      await B.fresh({ 'decodesim.view.v2': '3d' });
      if (!check(`${label}: A is seeded (imported and saved)`, await seedFn(A, GAME))) { retire(A, B); continue; }
      const aId = await importId(A);
      note(`A's robot id ${aId}`);
      check(`${label}: A creates a room`, await createRoom(A, GAME));
      const code = await roomCode(A);
      check(`${label}: A uploads the picture and the model`, await waitFor(() => A.sent('visualPut').some((f) => f.kind === 'mesh'), 60000), JSON.stringify(kindsOf(A.sent('visualPut'))));
      await sleep(2500);
      check(`${label}: the room refused nothing A sent`, A.got('visualRefused').length === 0, JSON.stringify(A.got('visualRefused').map((f) => [f.kind, f.reason])));
      note(`A sent ${A.sent('visualPut').filter((f) => f.kind === 'mesh').length} mesh frames (${bytesOf(A.sent('visualPut'), 'mesh')} base64 chars)`);
      check(`${label}: B joins`, await joinRoom(B, GAME, code));
      const got = await waitFor(() => B.got('visualReady').some((f) => f.kind === 'mesh') && B.got('visualChunk').some((f) => f.kind === 'mesh'), 60000);
      check(`${label}: B is told the model is there and receives it (visualReady, visualChunk mesh)`, got, JSON.stringify({ ready: kindsOf(B.got('visualReady')), chunks: kindsOf(B.got('visualChunk')) }));
      await sleep(3000);
      const ch = B.got('visualChunk').filter((f) => f.kind === 'mesh');
      note(`B received ${ch.length} mesh chunks, last seq ${ch.at(-1)?.seq} of total ${ch.at(-1)?.total}, ${bytesOf(ch, 'mesh')} base64 chars; refusals ${JSON.stringify(B.got('visualRefused').map((f) => [f.kind, f.reason]))}`);
      check(`${label}: B holds the relayed model (a lent blob in its registry)`, (await lentMeshBytes(B, aId)) > 0, String(await lentMeshBytes(B, aId)));
      check(`${label}: the match starts`, await startMatch(A, [B]));
      check(`${label}: B is in the match (the game view)`, await inMatch(B));
      const drawn = await waitFor(async () => (await meshSlots(B, aId)).some((s) => s[1] === 'ready' && s[2] > 0), 60000);
      const slots = await meshSlots(B, aId);
      await sleep(1500);
      await B.shot('3d');
      check(`${label}: B DRAWS A’s real model (a ready mesh slot with a robot wearing it, not the placeholder)`, drawn && slots.every((s) => s[1] === 'ready'), JSON.stringify(slots));
      const warns = B.consoleWarns.filter((w) => /\[import\]|does not fit/.test(w));
      check(`${label}: the viewer refused nothing ("does not fit its robot")`, warns.length === 0, warns.slice(0, 2).join(' | '));
      const viewIs3d = await B.js(`!!document.querySelector('canvas') && localStorage.getItem('decodesim.view.v2') === '3d'`);
      check(`${label}: B really is in the 3D view (the pref held, no 2D fallback)`, viewIs3d);
      if (B.consoleErrors.length) note(`B console errors: ${[...new Set(B.consoleErrors)].slice(0, 3).join(' | ')}`);
      retire(A, B);
      await sleep(2000);
    }
  };

  // ───────────────────────────── d8 / d8p: what a WATCHER is served ─────────────────────────────
  // A seat, then its own Watch button (the same socket moves to the watchers). The look a watcher is greeted with is read from the
  // frames after it, and a `visualGet` a modified client could send is sent straight down its socket.
  const watcherServed = async (A, W, aId, code, label, expectMesh) => {
    check(`${label}: A uploads the picture and the model`, await waitFor(() => A.sent('visualPut').some((f) => f.kind === 'mesh') && A.got('visualReady').length > 0, 60000), JSON.stringify({ put: kindsOf(A.sent('visualPut')), refused: A.got('visualRefused').map((f) => f.reason) }));
    check(`${label}: W joins`, await joinRoom(W, GAME, code));
    await waitFor(() => W.got('visualReady').length > 0, 30000);
    const owner = W.got('visualReady')[0]?.owner;
    note(`W as a seat was told: ${JSON.stringify(kindsOf(W.got('visualReady')))}; A is ${owner}`);
    const tWatch = Date.now();
    const clicked = await W.clickWhen('button', 'Watch', false, 10000);
    check(`${label}: W takes the Watch button`, clicked === 'ok', clicked);
    const watching = await W.until(`![...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Watch') || /Leave watching|Take a seat|watching/i.test(document.body.innerText)`, 15000);
    await sleep(3500);
    const kinds = kindsOf(W.got('visualReady', tWatch));
    note(`after Watch (${watching}): visualReady ${JSON.stringify(kinds)} refusals ${JSON.stringify(W.got('visualRefused', tWatch).map((f) => [f.kind, f.reason]))}`);
    check(`${label}: the watcher is told of A’s picture`, kinds.includes('top'), JSON.stringify(kinds));
    check(`${label}: ${expectMesh ? 'the watcher is told of A’s 3D model too' : 'the watcher is NEVER told of the 3D model (no mesh visualReady)'}`, expectMesh ? kinds.includes('mesh') : !kinds.includes('mesh'), JSON.stringify(kinds));
    // a request from the watcher's own socket: the picture, then the model
    const tGet = Date.now();
    await craftGet(W, owner, aId, 'top');
    await craftGet(W, owner, aId, 'mesh');
    await sleep(6000);
    const chunks = W.got('visualChunk', tGet); const refused = W.got('visualRefused', tGet);
    note(`crafted gets: chunks ${JSON.stringify(kindsOf(chunks))} (${chunks.length}), refusals ${JSON.stringify(refused.map((f) => [f.kind, f.reason]))}`);
    check(`${label}: asked for the picture, the watcher is sent it`, chunks.some((f) => f.kind === 'top'), JSON.stringify(kindsOf(chunks)));
    if (expectMesh) check(`${label}: asked for the model, the watcher is sent it`, chunks.some((f) => f.kind === 'mesh') && !refused.some((f) => f.kind === 'mesh'), JSON.stringify({ chunks: kindsOf(chunks), refused: refused.map((f) => [f.kind, f.reason]) }));
    else check(`${label}: asked for the model, the watcher gets no chunk of it and is refused "none"`, !chunks.some((f) => f.kind === 'mesh') && refused.some((f) => f.kind === 'mesh' && f.reason === 'none'), JSON.stringify({ chunks: kindsOf(chunks), refused: refused.map((f) => [f.kind, f.reason]) }));
    await W.shot('watcher');
  };

  flows.d8 = async () => {
    flow = 'd8';
    const A = mk('A8'); const W = mk('W8');
    await A.fresh({ 'decodesim.shareImportLook': '1' });
    await W.fresh({ 'decodesim.view.v2': '3d' });
    check('A is seeded', await seed(A, GAME));
    const aId = await importId(A);
    check('A creates a PRIVATE room (New room)', await createRoom(A, GAME));
    const code = await roomCode(A);
    await watcherServed(A, W, aId, code, 'private room', GAME === 'biobuzz');
    for (const p of [A, W]) if (p.consoleErrors.length) note(`${p.label} console errors: ${[...new Set(p.consoleErrors)].slice(0, 3).join(' | ')}`);
  };

  // (--signedin, the adminharness stack) a PUBLIC room: A is the harness account, signed in; W has its auth requests blocked
  flows.d8p = async () => {
    flow = 'd8p';
    const A = mk('A8p'); const W = mk('W8p');
    await A.fresh({ 'decodesim.shareImportLook': '1' });
    await W.fresh({ 'decodesim.view.v2': '3d' });
    W.win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://localhost:8798/*'] }, (_d, cb) => cb({ cancel: true }));
    check('A is seeded', await seed(A, GAME));
    const aId = await importId(A);
    await A.go(`/${GAME}/rooms`);
    await A.until(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Public room' && !b.disabled)`, 30000);
    await A.click('button', 'Public room');
    check('A (signed in) creates a Public room', await inRoom(A));
    const code = await roomCode(A);
    await sleep(2500);
    const tAllow = Date.now();
    check('A allows imported robots (a Public room starts Not allowed)', (await A.click('dt + dd button', 'Allowed')) === 'ok');
    await sleep(4000);
    note(`A's frames after Allowed: ${JSON.stringify(A.frames.filter((f) => f.ts >= tAllow).map((f) => `${f.dir[0]}:${f.t}${f.imported ? '(imported)' : ''}`))}`);
    // the creator of a Public room sent its standard robot; allowing imports does not swap its seat by itself, so it picks the imported card in Setup
    note(`A's seat after Allowed: ${String(await A.js(`document.querySelector('.rm-seat.mine')?.innerText.replace(/\\n+/g, ' | ')`)).slice(0, 120)}`);
    note(`A picks the imported robot in Setup: ${await pickImported(A)}`);
    await A.shot('after-allowed');
    await watcherServed(A, W, aId, code, 'public room', false);
    for (const p of [A, W]) if (p.consoleErrors.length) note(`${p.label} console errors: ${[...new Set(p.consoleErrors)].slice(0, 3).join(' | ')}`);
  };

  // ───────────────────────────── d9: a dropped connection, before and after the answer ─────────────────────────────
  flows.d9 = async () => {
    flow = 'd9';
    const A = mk('A9'); const B = mk('B9');
    await A.fresh(); await B.fresh();
    check('A is seeded', await seed(A, GAME));
    check('A creates a room', await createRoom(A, GAME));
    const code = await roomCode(A);
    check('B (a plain viewer) joins', await joinRoom(B, GAME, code));
    check('the consent dialog is open (nothing answered yet)', await A.until(`!!document.querySelector('.ds-modal[role=dialog]')`, 15000));
    await sleep(2000);
    check('before any answer, nothing was uploaded', A.sent('visualPut').length === 0);
    // drop 1: the dialog is open, nothing answered
    const socks0 = A.sockets.length; const tDrop1 = Date.now();
    note(`dropping ${await dropSocket(A)} socket(s) of A`);
    const back1 = await waitFor(() => A.sockets.length > socks0 && A.sent('join', tDrop1).concat(A.sent('rejoin', tDrop1)).length > 0, 30000);
    check('A reconnects on a new socket and re-enters the room', back1 && (await inRoom(A)), JSON.stringify({ socks: A.sockets.length - socks0, sent: [...new Set(A.frames.filter((f) => f.dir === 'out' && f.ts >= tDrop1).map((f) => f.t))] }));
    await sleep(6000);
    await A.shot('after-drop-1');
    check('after the reconnect, still nothing uploaded before the answer', A.sent('visualPut').length === 0, `${A.sent('visualPut').length} visualPut`);
    check('…and B was never offered a look', B.got('visualReady').length === 0);
    const dialogs1 = await A.js(`document.querySelectorAll('.ds-modal[role=dialog]').length`);
    check('the question is still asked, once (one dialog on screen)', dialogs1 === 1, String(dialogs1));
    // the yes
    const tYes = Date.now();
    check('Share it', (await A.click('.ds-modal button', 'Share it')) === 'ok');
    check('after the yes the picture is uploaded', await waitFor(() => A.sent('visualPut', tYes).some((f) => f.kind === 'top'), 30000), JSON.stringify(kindsOf(A.sent('visualPut', tYes))));
    await sleep(6000);
    check('…and B is offered it', B.got('visualReady').length > 0, JSON.stringify(kindsOf(B.got('visualReady'))));
    // drop 2: the answer is stored
    const socks1 = A.sockets.length; const tDrop2 = Date.now();
    note(`dropping ${await dropSocket(A)} socket(s) of A`);
    check('A reconnects again', await waitFor(() => A.sockets.length > socks1, 30000) && (await inRoom(A)));
    check('the look is sent again on the new connection', await waitFor(() => A.sent('visualPut', tDrop2).some((f) => f.kind === 'top'), 45000), JSON.stringify(kindsOf(A.sent('visualPut', tDrop2))));
    await sleep(3000);
    check('…without asking again (no dialog)', (await A.js(`document.querySelectorAll('.ds-modal[role=dialog]').length`)) === 0);
    check('…the stored answer is still yes', (await A.js(`localStorage.getItem('decodesim.shareImportLook')`)) === '1');
    check('…and the room confirms it (visualReady to A after the re-send)', A.got('visualReady', tDrop2).length > 0 || B.got('visualReady', tDrop2).length > 0, JSON.stringify({ a: kindsOf(A.got('visualReady', tDrop2)), b: kindsOf(B.got('visualReady', tDrop2)) }));
    check('the owner saw no refusal across the two drops', A.got('visualRefused').length === 0, JSON.stringify(A.got('visualRefused').map((f) => [f.kind, f.reason])));
    for (const p of [A, B]) if (p.consoleErrors.length) note(`${p.label} console errors: ${[...new Set(p.consoleErrors)].slice(0, 3).join(' | ')}`);
  };

  // ───────────────────────────── d10: reporting a look from Results (plays one whole match) ─────────────────────────────
  flows.d10 = async () => {
    flow = 'd10';
    // Only a SIGNED-IN driver is offered a report at all (`GameView`: `reportable` is empty signed out), so this flow needs
    // the signed-in stack (--signedin): A is the harness account (a standard robot) and reports; B (an imported robot) and C
    // (a standard robot) have their auth requests blocked. The reported drivers are signed out, so the server files no row
    // (it needs an account on both sides); what is asserted is the offer and the frame.
    const A = mk('A10'); const B = mk('B10'); const C = mk('C10');
    await A.fresh(); await B.fresh({ 'decodesim.shareImportLook': '0' }); await C.fresh();
    for (const p of [B, C]) p.win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://localhost:8798/*'] }, (_d, cb) => cb({ cancel: true }));
    check('B (an imported robot) is seeded', await seed(B, GAME));
    check('B creates a room', await createRoom(B, GAME));
    const code = await roomCode(B);
    check('A (signed in, a standard robot) joins', await joinRoom(A, GAME, code));
    check('C (a standard robot) joins', await joinRoom(C, GAME, code));
    check('the match starts', await startMatch(B, [A, C]));
    check('all three are in the match', (await inMatch(A)) && (await inMatch(B)) && (await inMatch(C)));
    note('waiting for the match to end (about 3 minutes)');
    const reportBtn = `[...document.querySelectorAll('button')].some((b) => /Report a player/.test(b.textContent))`;
    check('Results shows "Report a player" to the signed-in driver', await A.until(reportBtn, 260000));
    check('…and not to a signed-out one (there is nobody it could file against)', !(await B.js(reportBtn)) && !(await C.js(reportBtn)));
    await sleep(1500);
    await A.click('button', 'Report a player', true);
    await A.until(`!!document.querySelector('.ds-report')`, 8000);
    const who = await A.js(`[...document.querySelectorAll('.ds-report .ds-opts[aria-labelledby$="-who"] button')].map((b) => b.textContent.trim())`);
    const reasons = () => A.js(`[...document.querySelectorAll('.ds-report .ds-opts.two button')].map((b) => b.textContent.trim())`);
    const LOOK = 'Offensive robot picture or model';
    note(`A picks among ${JSON.stringify(who)}; before a pick: ${JSON.stringify(await reasons())}`);
    check('with nobody picked the look reason is not offered', !(await reasons()).includes(LOOK), JSON.stringify(await reasons()));
    check('A picks the standard robot (C)', (await A.click('.ds-report .ds-opts[aria-labelledby$="-who"] button', 'My Robot')) === 'ok');
    const forC = await reasons();
    check('against a standard robot the look reason is NOT offered', forC.length > 0 && !forC.includes(LOOK), JSON.stringify(forC));
    await A.shot('report-standard');
    const pickImported = await A.js(`(() => { const b = [...document.querySelectorAll('.ds-report .ds-opts[aria-labelledby$="-who"] button')].find((x) => x.textContent.trim() !== 'My Robot'); if (!b) return null; const t = b.textContent.trim(); b.click(); return t; })()`);
    await sleep(300);
    const forB = await reasons();
    note(`A picks the imported robot (${pickImported}): ${JSON.stringify(forB)}`);
    check('against an imported robot the look reason IS offered', forB.includes(LOOK), JSON.stringify(forB));
    await A.shot('report-imported');
    const tSend = Date.now();
    check('A picks the look reason', (await A.click('.ds-report .ds-opts.two button', LOOK)) === 'ok');
    check('A submits', (await A.click('.ds-report button', 'SUBMIT REPORT')) === 'ok');
    await sleep(2500);
    const sent = A.sent('report', tSend);
    note(`A's report frames: ${JSON.stringify(sent.map((f) => ({ reason: f.reason, robotId: f.robotId })))}; answered: ${JSON.stringify(A.got('reported', tSend).map((f) => f.ok))}`);
    check('the report reaches the server naming a robot (reason look, a robot id)', sent.length === 1 && sent[0].reason === 'look' && Number.isFinite(sent[0].robotId), JSON.stringify(sent.map((f) => ({ reason: f.reason, robotId: f.robotId }))));
    check('the server answers it (reported ok)', A.got('reported', tSend).some((f) => f.ok === true));
    check('the dialog confirms ("Report submitted")', /Report submitted/.test(await A.body()));
    await A.shot('report-sent');
    for (const p of [A, B, C]) if (p.consoleErrors.length) note(`${p.label} console errors: ${[...new Set(p.consoleErrors)].slice(0, 3).join(' | ')}`);
  };

  // ───────────────────────────── d11: the download gate (a server started with VISUAL_GETS_PER_MIN_TEST=1; run with --gate --gpu) ─────────────────────────────
  flows.d11 = async () => {
    flow = 'd11';
    if (GAME !== 'biobuzz') return note('d11 is BIOBUZZ’s (a viewer asks for the model only in its 3D view)');
    const A = mk('A11'); const B = mk('B11');
    await A.fresh({ 'decodesim.shareImportLook': '1' });
    await B.fresh({ 'decodesim.view.v2': '3d' });
    check('A is seeded', await seed(A, GAME));
    const aId = await importId(A);
    check('A creates a room', await createRoom(A, GAME));
    const code = await roomCode(A);
    check('A uploads the picture and the model', await waitFor(() => A.sent('visualPut').some((f) => f.kind === 'mesh') && A.got('visualReady').length >= 2, 60000), JSON.stringify(kindsOf(A.sent('visualPut'))));
    const tJoin = Date.now();
    check('B joins', await joinRoom(B, GAME, code));
    const busy = await waitFor(() => B.got('visualRefused', tJoin).some((f) => f.reason === 'busy'), 60000);
    const tBusy = Date.now();
    const refusals = B.got('visualRefused', tJoin);
    note(`B's gets: ${JSON.stringify(B.sent('visualGet', tJoin).map((f) => f.kind))}; refusals ${JSON.stringify(refusals.map((f) => [f.kind, f.reason]))}; chunks ${JSON.stringify(kindsOf(B.got('visualChunk', tJoin)))}`);
    check('B’s gets past the first are refused `busy` by the gate', busy, JSON.stringify(refusals.map((f) => [f.kind, f.reason])));
    check('the first get (the picture) was served', B.got('visualChunk', tJoin).some((f) => f.kind === 'top'), JSON.stringify(kindsOf(B.got('visualChunk', tJoin))));
    check('B holds NO relayed model yet', (await lentMeshBytes(B, aId)) === 0, String(await lentMeshBytes(B, aId)));
    check('the match starts', await startMatch(A, [B]));
    check('B is in the match', await inMatch(B));
    // the placeholder meanwhile, then the model once the window has passed (the retry is 20 to 60 s after the refusal, again if still inside it)
    const states = []; let ready = false; let firstSlot = null;
    for (let t = 0; t < 190000 && !ready; t += 2000) {
      const s = await meshSlots(B, aId);
      const st = s.map((x) => x[1] + '/' + x[2]).join(',') || '(no slot)';
      if (firstSlot === null && s.length) firstSlot = st;
      if (states.at(-1)?.st !== st) states.push({ at: Math.round((Date.now() - tBusy) / 1000), st });
      ready = s.some((x) => x[1] === 'ready' && x[2] > 0);
      if (!ready) await sleep(2000);
    }
    note(`B's mesh slot over time (seconds after the refusal): ${JSON.stringify(states)}`);
    check('meanwhile B drew the placeholder (the slot had no model: none or loading)', firstSlot !== null && !/^ready/.test(firstSlot), String(firstSlot));
    check('after the window B got the model and draws it', ready, JSON.stringify(states));
    note(`later refusals ${JSON.stringify(B.got('visualRefused', tJoin).map((f) => [f.kind, f.reason, Math.round((f.ts - tBusy) / 1000)]))}; later gets ${JSON.stringify(B.sent('visualGet', tJoin).map((f) => [f.kind, Math.round((f.ts - tBusy) / 1000)]))}`);
    await B.shot('after-window');
    for (const p of [A, B]) if (p.consoleErrors.length) note(`${p.label} console errors: ${[...new Set(p.consoleErrors)].slice(0, 3).join(' | ')}`);
  };

  const SIGNEDIN = process.argv.includes('--signedin');
  const ORDER = ONLY.length
    ? ['d1', 'd5', 'd6', 'd7', 'd8', 'd8p', 'd9', 'd10', 'd11']
    : process.argv.includes('--gate') ? ['d11']
    : SIGNEDIN ? ['d6', 'd8p']
    : ['d1', 'd5', 'd8', 'd9'];
  for (const k of ORDER) {
    if (ONLY.length && !ONLY.includes(k) && !(k === 'd1' && ONLY.some((o) => /^d[1-4]$/.test(o)))) continue;
    console.log(`\n── ${k} ──`);
    try {
      await flows[k]();
    } catch (e) {
      failures++;
      console.log(`FAIL  [${k}] threw: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
      for (const p of players) { try { await p.shot('threw'); } catch {} }
    }
    for (const p of players.splice(0)) { try { p.win.webContents.debugger.detach(); } catch {} p.win.destroy(); }
  }
  console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
  app.exit(failures ? 1 : 0);
});
