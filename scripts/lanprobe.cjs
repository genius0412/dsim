/**
 * TWO REAL BROWSERS, ONE TAB-HOSTED LAN ROOM — the check `npm test` structurally cannot do.
 *
 * `scripts/smoke.ts` runs under Node, which has no `RTCPeerConnection`, no `Worker` and no DOM,
 * so everything it knows about this feature is source shape. Source shape pins decisions; it
 * cannot tell you the two peers actually talk. Both bugs found on the day this was written were
 * invisible to it and would have been invisible to any amount more of it:
 *
 *   1. the host tore down the connection that had just succeeded, because a guest closes its
 *      rendezvous socket the moment the channels open and the host read that as the guest
 *      leaving;
 *   2. the guest's `join` — the first frame of the protocol, sent the instant the channel opens
 *      — was dispatched into a DataChannel before the host had attached a listener, and a
 *      DataChannel buffers nothing for a listener that is not there yet. The link came up, the
 *      host counted the guest, and both sides then waited for each other forever.
 *
 * Neither is a typo. Both are ordering, between two processes, and the only instrument that
 * sees them is two real peers doing the real handshake.
 *
 * ## Why Electron rather than the app's own preview browser
 *
 * It needs no permission grant for a private-network origin and it is already a devDependency
 * (`npm run shiftaudit` and `npm run og` are the precedent). `backgroundThrottling: false`
 * matters here beyond convenience: a hidden page is clamped to about one wake a minute
 * (docs/lan-webrtc.md §6), which is the measurement that put the room in a Worker, and a probe
 * whose windows are throttled would be measuring the throttle.
 *
 * Run the rendezvous first, then this:
 *   npm run lan:tab            (leave it running)
 *   npm run lan:probe          (add --url http://host:port to point somewhere else)
 *
 * It drives the REAL screens — clicks the real button, types into the real field — because the
 * wiring between them is exactly what has been wrong twice.
 */
const { app, BrowserWindow } = require('electron');

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  const m = args.map((a) => new RegExp(`^${name}=(.+)$`).exec(a)).find(Boolean);
  return m ? m[1] : fallback;
}
const ORIGIN = (flag('--url', 'http://127.0.0.1:8787') || '').replace(/\/$/, '');

/**
 * `--soak <seconds>` keeps the match running and watches the snapshot rate the GUEST is
 * actually receiving, which is the one number that says whether a host is keeping up.
 *
 * `--throttle` is the experiment it exists for: it lets the host window be background-throttled
 * like an ordinary hidden tab, instead of the `backgroundThrottling: false` every other window
 * here gets. docs/lan-webrtc.md §6 measured a hidden Worker holding 60.08 Hz for 7 minutes — but
 * that was a Worker ALONE, with no peer connections on the page thread beside it, and the page
 * is where every DataChannel actually lives. Run `--throttle --soak 90` to measure the real
 * thing; without it the soak measures a foregrounded host, which is the happy case.
 */
const SOAK_S = Math.max(0, Number(flag('--soak', '0')) || 0);
const THROTTLE_HOST = args.includes('--throttle');

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function open(tag, throttled = false) {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      // see the header: a throttled window measures the throttle, not the feature — unless
      // the throttle IS the measurement, which is what `--throttle` asks for on the host
      backgroundThrottling: throttled,
    },
  });
  /* Both failures this probe was written for were SILENT on the page — no error, two screens
     waiting on each other — so whatever the renderer does say is worth having. Warnings are
     dropped: the client logs a couple on every load and they bury the line that matters. */
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log(`[${tag}] ${message}`);
  });
  win.webContents.on('render-process-gone', (_e, d) => console.log(`[${tag}] renderer gone: ${d.reason}`));
  return win;
}

/**
 * Poll `expr` until it returns something truthy, or give up.
 *
 * Polling rather than waiting on an event because the thing being waited for is React having
 * rendered a state change that arrived over a DataChannel — there is no event to hang on from
 * out here, and the alternative is a fixed sleep long enough to be slow and short enough to be
 * flaky.
 */
async function until(win, expr, ms, step = 250) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await win.webContents.executeJavaScript(expr).catch(() => null);
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(step);
  }
}

/**
 * Type into a REACT-CONTROLLED input.
 *
 * Assigning `.value` does not work: React tracks the last value it wrote on the DOM node and
 * swallows the `input` event as a no-op change, so the field shows the text and the component's
 * state never sees it — the button stays disabled and the probe "types" into nothing. Going
 * through the prototype's setter is what makes React's own listener believe the user did it.
 */
const typeInto = (selector, text) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  set.call(el, ${JSON.stringify(text)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;

const clickByText = (selector, text) => `(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
    .find((b) => b.textContent.toUpperCase().includes(${JSON.stringify(text.toUpperCase())}));
  if (!el || el.disabled) return false;
  el.click();
  return true;
})()`;

async function main() {
  const host = open('host', THROTTLE_HOST);
  /* ONE GUEST BY DEFAULT, up to three — a room seats four drivers, so three guests plus the
     host is a full 2v2 and the most this feature is ever asked to do. Every check below is
     written for N, because the interesting failures (a second and third peer connection, four
     seats, three snapshot streams off one Worker) only appear past one. */
  const wanted = Math.max(1, Math.min(3, Number(flag('--guests', '1')) || 1));
  const guests = Array.from({ length: wanted }, (_, i) => open(`guest${wanted > 1 ? i + 1 : ''}`));
  const one = guests[0];
  const N = (label) => (wanted > 1 ? `${label} (×${wanted})` : label);

  console.log(`[lanprobe] ${ORIGIN}${wanted > 1 ? ` — ${wanted} guests` : ''}`);
  await host.loadURL(`${ORIGIN}/lan`);

  // ---- the server said hosting needs no account here, so the button is live
  const live = await until(host, clickByText('button', 'START HOSTING'), 15_000);
  check('host: START HOSTING is reachable on a server with no accounts', !!live);
  if (!live) return;

  /* NOT the first `.ds-lan-url` on the page. The terminal-host block below uses the same
     copy-button class for `git clone ...`, so a positional selector reads a shell command out
     as a room code and every check after it fails for the wrong reason. Match the SHAPE. */
  const code = await until(
    host,
    `[...document.querySelectorAll('.ds-lan-url .u')]
       .map((e) => e.textContent.trim())
       .find((t) => /^[A-Z0-9]{6}$/.test(t)) || ''`,
    20_000,
  );
  check('host: the rendezvous issued a room code', !!code && code.length === 6, code || 'none');
  if (!code) return;

  /* ---- the guests join by that code, ONE AT A TIME. Sequential on purpose: each arrival has
     to be seen on the host before the next is let in, or a failure to admit the third is
     indistinguishable from a slow second. */
  const counted = `(document.body.innerText.match(/([0-9]+) players? ha[sv]e? joined/) || [0, '0'])[1]`;
  let typedAll = true;
  let clickedAll = true;
  let arrived = 0;
  for (const g of guests) {
    await g.loadURL(`${ORIGIN}/lan`);
    const typed = await until(g, typeInto('.ds-input[placeholder="BCDFGH"]', code), 15_000);
    typedAll = typedAll && !!typed;
    if (!typed) break;
    const clicked = await until(g, clickByText('button', 'JOIN'), 5_000);
    clickedAll = clickedAll && !!clicked;
    if (!clicked) break;
    /* ---- BUG 1 lives here. A guest closes its rendezvous socket the moment the channels
       open; the host used to read that as the guest leaving and close the connection. The
       symptom was this counter going up and straight back down. */
    const seen = await until(host, `Number(${counted}) >= ${arrived + 1} || null`, 25_000);
    if (!seen) break;
    arrived++;
  }
  check(N('guest: the code field takes the code'), typedAll);
  check(N('guest: JOIN is enabled once the code is complete'), clickedAll);
  check(N('link: the host sees the guest arrive over WebRTC'), arrived === wanted, `${arrived}/${wanted}`);

  const stillThere = await until(host, `Number(${counted}) >= ${wanted} || null`, 6_000);
  check('link: and still sees them after the rendezvous sockets close (not torn down)', !!stillThere);

  /* ---- BUGS 2 AND 3 both live here, and they are the same bug at two layers.
     `join` is the first frame a client sends and `LobbyClient.join` sends it from `onOpen`
     and from nowhere else — correct for a WebSocket, which is still dialling when it is
     handed over, and wrong for a LAN transport, which is ALREADY OPEN by the time the lobby
     adopts it. Both the frame (BUG 2) and the open EVENT (BUG 3) were being delivered to a
     listener that did not exist yet. Reaching the DRIVERS list is proof the round trip
     completed: join → room → welcome → roster. */
  const seatedStates = [];
  for (const g of guests) {
    seatedStates.push(
      await until(
        g,
        `(() => {
          const t = document.body.innerText;
          if (/Lost connection|Couldn.t reach/i.test(t)) return 'error';
          return document.querySelectorAll('.ds-players .ds-player').length ? 'roster' : null;
        })()`,
        30_000,
      ),
    );
  }
  check(
    N('room: the guest is seated — its join reached the room and came back'),
    seatedStates.every((s) => s === 'roster'),
    seatedStates.map((s) => s || 'timed out').join(', '),
  );

  const guestText = await one.webContents.executeJavaScript('document.body.innerText').catch(() => '');
  check('room: and it was not dropped on the way in', !/Lost connection/i.test(guestText));

  /* ---- THE HOST TAKES ITS OWN SEAT THROUGH THE SAME DOOR, over a LoopbackTransport whose
     `open` fired when the Worker said the room was ready — long before this click. It is the
     same latch as the guest's and it failed the same way, leaving a host on "waiting for
     players" beside a guest already sitting in the room. A full roster is the proof that both
     sides of the seam seated themselves. */
  const wentIn = await until(host, clickByText('button', 'GO TO THE ROOM'), 10_000);
  check('host: GO TO THE ROOM takes it into its own room', !!wentIn);
  const seated = await until(
    host,
    `document.querySelectorAll('.ds-players .ds-player').length >= ${wanted + 1}
       ? document.querySelectorAll('.ds-players .ds-player').length : null`,
    20_000,
  );
  check(
    'room: and the host is seated there too, beside the guests',
    seated === wanted + 1,
    `${seated || 0}/${wanted + 1} player(s)`,
  );

  /* ---- AND THE MATCH ITSELF. Everything above proves the LOBBY round trip, which is a
     handful of reliable control frames; a match is the hot lane, 30 times a second, for as
     long as anybody is playing. A guest is the honest end to measure: it simulates nothing
     authoritative, so a clock that moves on a guest's HUD is a clock being delivered from the
     host's Worker, through the page, over the DataChannel, into the stock `ServerSession`
     that has no idea it is not talking to Fly. */
  let allReady = true;
  for (const g of guests) allReady = (await until(g, clickByText('button', 'READY UP'), 10_000)) && allReady;
  allReady = (await until(host, clickByText('button', 'READY UP'), 10_000)) && allReady;
  check('match: every player can ready up', !!allReady);

  const started = await until(host, clickByText('button', 'START MATCH'), 15_000);
  check('match: START unlocks for the host once everyone is ready', !!started);

  if (started) {
    const fields = [];
    for (const g of guests) fields.push(await until(g, `document.querySelector('canvas') ? 'yes' : null`, 20_000));
    check(N('match: the guest is on the field'), fields.every((f) => f === 'yes'), fields.map((f) => f || 'no').join(', '));

    /* THE CLOCK, ON BOTH SCREENS, AND THEY ANSWER DIFFERENT QUESTIONS. The host's clock
       moving says the Worker's room is stepping at all; a guest's moving says those steps are
       reaching the far end. A single reading proves neither — it only proves a HUD rendered —
       and an immediate one reads the MATCH BEGINS IN lead-in, which carries no clock, so both
       are waited for and then watched for a CHANGE. */
    const CLOCK = `(document.body.innerText.match(/[0-9]+:[0-9][0-9]/) || [''])[0]`;
    const moved = async (win, ms) => {
      const first = await until(win, `${CLOCK} || null`, 25_000);
      if (!first) return 'no clock';
      const changed = await until(win, `(${CLOCK} && ${CLOCK} !== ${JSON.stringify(first)}) ? ${CLOCK} : null`, ms);
      return changed ? `${first} → ${changed}` : `stuck at ${first}`;
    };

    const hostClock = await moved(host, 15_000);
    check('match: the host’s room is stepping — its own clock moves', hostClock.includes('→'), hostClock);

    const clocks = [];
    for (const g of guests) clocks.push(await moved(g, 15_000));
    check(
      N('match: and the guest’s clock moves with it — snapshots are crossing the DataChannel'),
      clocks.every((c) => c.includes('→')),
      clocks.join(' | '),
    );
  }

  if (started && SOAK_S > 0) {
    /* THE RATE THE GUEST IS ACTUALLY RECEIVING, sampled off the connection-quality readout the
       HUD already computes. It is the honest number: a host can believe it is stepping at 60 Hz
       and still be delivering nothing, and a room that has quietly stopped looks exactly like
       one that is fine from the host's own screen. */
    const HZ = `(document.body.innerText.match(/([0-9]+)Hz/) || [0, ''])[1]`;
    const samples = [];
    const t0 = Date.now();
    /* ⚠️ A MATCH ENDS. Auto plus driver-controlled is 2:30, so a soak longer than that outlives
       the thing it is measuring — the HUD goes with the field and every later sample reads 0,
       which is a failure the run invented for itself. Sampling stops when the field does. */
    let ended = false;
    while ((Date.now() - t0) / 1000 < SOAK_S) {
      await sleep(5000);
      const live = await one.webContents.executeJavaScript(`document.querySelector('canvas') ? 1 : 0`).catch(() => 0);
      if (!live) {
        ended = true;
        break;
      }
      samples.push(Number(await one.webContents.executeJavaScript(HZ).catch(() => 0)) || 0);
    }
    const soaked = Math.round((Date.now() - t0) / 1000);
    const worst = samples.length ? Math.min(...samples) : 0;
    const mean = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
    console.log(
      `[soak] ${soaked}s${ended ? ' (the match ended)' : ''}, ` +
        `host ${THROTTLE_HOST ? 'BACKGROUND-THROTTLED' : 'not throttled'} — ` +
        `snapshots at the guest: mean ${mean.toFixed(1)} Hz, worst ${worst} Hz, samples [${samples.join(' ')}]`,
    );
    /* 30 Hz is the design rate (SNAPSHOT_INTERVAL, 2 ticks). Two thirds of it is the line
       between "a busy machine" and "this match has stopped being playable". */
    check(
      `soak: the guest kept receiving snapshots for ${soaked}s`,
      worst >= 20,
      `worst ${worst} Hz, mean ${mean.toFixed(1)} Hz`,
    );
  }

  if (failures) {
    console.log('\n--- guest screen ---\n' + String(guestText).slice(0, 900));
    const hostText = await host.webContents.executeJavaScript('document.body.innerText').catch(() => '');
    console.log('\n--- host screen ---\n' + String(hostText).slice(0, 900));
  }
}

app.whenReady().then(async () => {
  try {
    await main();
  } catch (e) {
    failures++;
    console.log(`FAIL  the probe itself threw — ${e && e.message ? e.message : e}`);
  }
  console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
  app.exit(failures ? 1 : 0);
});
