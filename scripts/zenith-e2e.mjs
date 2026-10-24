/**
 * DSIM <-> ZENITH, END TO END, THROUGH A REAL POPUP (docs/area/autos.md). Headless Chromium drives
 * DSIM's Autonomous panel and the Zenith window it opens: New in Zenith, Save to DSIM, Simulate in
 * DSIM, a second Edit in Zenith, Play it in AUTO, closing Zenith. Nothing opens on screen.
 *
 * Needs, running: DSIM's dev server on :5173 built with VITE_ZENITH_URL=http://localhost:5245/ (put
 * it in .env.development.local), and Zenith's web dev server on :5245 from a Zenith checkout that has
 * `pnpm install` done (its Playwright is the one used here).
 *
 *   node scripts/zenith-e2e.mjs <zenith-checkout> [screenshot-dir]
 *
 * A fresh browser context each run, so DSIM's library starts empty.
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const zenithDir = process.argv[2];
if (!zenithDir) {
  console.error('usage: node scripts/zenith-e2e.mjs <zenith-checkout> [screenshot-dir]');
  process.exit(2);
}
const require = createRequire(join(resolve(zenithDir), 'apps', 'web', 'package.json'));
const { chromium } = require('@playwright/test');

const out = resolve(process.argv[3] ?? 'scratch/zenith-e2e');
mkdirSync(out, { recursive: true });
const log = (...a) => console.log('[e2e]', ...a);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 800 } });
// Zenith's tour and beta notice stay out of the way in the popup
await ctx.addInitScript(() => {
  if (location.port === '5245') {
    if (localStorage.getItem('zenith.ui') === null) {
      localStorage.setItem('zenith.ui', JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
    }
  }
});
const page = await ctx.newPage();
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') log('dsim console', m.type(), m.text().slice(0, 200));
});
await page.goto('http://localhost:5173/biobuzz/modes', { waitUntil: 'networkidle' });
const notNow = page.getByRole('button', { name: 'Not now' });
if (await notNow.isVisible().catch(() => false)) await notNow.click();
const newBtn = page.getByRole('button', { name: /New in Zenith/ });
await newBtn.scrollIntoViewIfNeeded();
await page.screenshot({ path: join(out, '01-dsim-panel-empty.png') });

// 1) New in Zenith
const popupP = page.waitForEvent('popup');
await newBtn.click();
const zenith = await popupP;
zenith.on('console', (m) => {
  if (m.type() === 'error') log('zenith console', m.text().slice(0, 200));
});
await zenith.setViewportSize({ width: 1440, height: 900 });
await zenith.waitForLoadState('domcontentloaded');
const autoName = zenith.getByTestId('toolbar-auto-name');
await autoName.waitFor({ timeout: 30000 });
await zenith.waitForTimeout(1500);
// dismiss any beta notice
for (const label of ['Got it', 'Close', 'OK']) {
  const b = zenith.getByRole('button', { name: label });
  if (await b.first().isVisible().catch(() => false)) await b.first().click().catch(() => {});
}
await zenith.screenshot({ path: join(out, '02-zenith-new-auto.png') });
const nameText = (await autoName.textContent()) ?? '';
check('Zenith opened a new auto from DSIM', /new-auto/.test(nameText), nameText.trim());
const outdated = await zenith.getByTestId('host-outdated').count();
check('Zenith does not call DSIM out of date (host build 2)', outdated === 0, `host-outdated count ${outdated}`);
const dsimNotice = await page.locator('.ds-hint, .ds-form-err').allTextContents();
check('DSIM says Zenith is open', dsimNotice.some((t) => /Zenith is open in another window/.test(t)), dsimNotice.join(' | ').slice(0, 200));

// 2) Save to DSIM (Ctrl S)
await zenith.keyboard.press('Control+s');
await page.waitForTimeout(2500);
await zenith.screenshot({ path: join(out, '03-zenith-saved.png') });
const status = (await zenith.getByTestId('status').textContent().catch(() => '')) ?? '';
check('Zenith reports the save to DSIM', /Saved|saved/.test(status) && !/did not|could not|needs an update/i.test(status), status.trim().slice(0, 160));
await page.bringToFront();
await page.waitForTimeout(800);
const lib = await page.evaluate(() => {
  const raw = localStorage.getItem('decodesim.zenithAutos.v1');
  return raw;
});
const parsed = lib ? JSON.parse(lib) : null;
const entries = parsed?.biobuzz?.entries ?? [];
check('the auto is in DSIM’s library', entries.some((e) => /new-auto/.test(e.name)), entries.map((e) => e.name).join(', '));
const saved = entries.find((e) => /new-auto/.test(e.name));
let startOk = false;
let savedAuto = null;
if (saved) {
  savedAuto = JSON.parse(saved.auto);
  const p = savedAuto.start?.pose ?? {};
  // DSIM default: BLUE, anchor 0 (TOP · REAR WALL) spawns at (34, 63.174, -pi/2); Zenith's field is
  // RED-canonical, so the new auto is RED at the point mirror
  startOk = savedAuto.alliance === 'RED' && Math.abs(p.xIn + 34) < 0.01 && Math.abs(p.yIn + 63.174) < 0.01 && Math.abs(p.headingRad - 1.5708) < 0.01;
  check('the new auto starts where DSIM’s robot starts (newAutoStart, mirrored to RED)', startOk, JSON.stringify({ alliance: savedAuto.alliance, ...p }).slice(0, 220));
  check('the saved auto is format 4 and DSIM accepted it', savedAuto.formatVersion === 4, `formatVersion ${savedAuto.formatVersion}`);
}
await page.screenshot({ path: join(out, '04-dsim-after-save.png') });

// 3) Simulate in DSIM
const sim = zenith.getByTestId('host-host.simulate');
if (await sim.count()) {
  await zenith.bringToFront();
  await sim.first().click();
  await zenith.waitForTimeout(4000);
  const st = (await zenith.getByTestId('status').textContent().catch(() => '')) ?? '';
  await zenith.screenshot({ path: join(out, '05-zenith-simulated.png') });
  check('Simulate in DSIM comes back with a recorded run', !/could not simulate|did not send/i.test(st), st.trim().slice(0, 200));
} else {
  check('Simulate in DSIM button is shown', false, 'no host-host.simulate');
}

// 4) A second Edit in Zenith reuses the window, no leave-site prompt
let dialogs = 0;
zenith.on('dialog', async (d) => {
  dialogs++;
  await d.dismiss();
});
await page.bringToFront();
const edit = page.getByRole('button', { name: 'Edit in Zenith' });
await edit.scrollIntoViewIfNeeded();
const pagesBefore = ctx.pages().length;
await edit.click();
await page.waitForTimeout(2500);
check('a second Edit in Zenith reuses the open window (no new window, no leave-site prompt)', ctx.pages().length === pagesBefore && dialogs === 0 && !zenith.isClosed(), `pages ${pagesBefore}->${ctx.pages().length}, dialogs ${dialogs}`);
const name2 = (await zenith.getByTestId('toolbar-auto-name').textContent().catch(() => '')) ?? '';
check('the reused window shows the auto that was asked for', /new-auto/.test(name2), name2.trim());
await zenith.screenshot({ path: join(out, '06-zenith-reopened.png') });

// 5) Play it in AUTO, then a solo practice: the HUD names the auto
await page.getByRole('button', { name: 'On', exact: true }).last().click();
await page.waitForTimeout(500);
const startNote = (await page.locator('.ds-hint').allTextContents()).find((t) => /plays in AUTO, so the robot starts/.test(t));
check('Start position says the auto decides the start', !!startNote, startNote ?? '');
await page.screenshot({ path: join(out, '07-dsim-play-in-auto.png') });

await zenith.close();
await page.waitForTimeout(1500);
const after = await page.locator('.ds-hint, .ds-form-err').allTextContents();
check('closing Zenith drops DSIM’s “open in another window” line', !after.some((t) => /Zenith is open in another window/.test(t)), after.join(' | ').slice(0, 200));

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
