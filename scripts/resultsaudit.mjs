/**
 * RESULTS-SCREEN LAYOUT AUDIT — `npm run resultsaudit` (~1 min, no build, no game server).
 *
 * Renders the real `<Results>` with the app's real stylesheets on fixture props
 * (`scripts/results-fixture/main.tsx`): BIOBUZZ, DECODE and Chain Reaction, versus and one-panel,
 * both themes, at seven window sizes from 1920x1080 down to the two phones, and fails on:
 *
 *   no-scroll        the stage scrolls (docs/area/ui.md, "THE RESULTS SCREEN MUST NOT SCROLL")
 *   alliance-fill    a half is not its alliance's chip colour
 *   section-whole    a section broke across the two columns, so rows sit under no heading
 *   heading-centred  a section heading is off the centre of its own rows
 *   one-column       the breakdown flowed into two columns on a window that holds one
 *   anatomy          on one column, a red value is not at the red edge, a blue value not at the
 *                    blue edge, or value | label | value overlap
 *
 * WHY IT EXISTS (2026-11-04). The owner opened a BIOBUZZ results screen on alpha and read it as
 * broken: two loose columns, headings flush left, no board. Nothing had changed that day. It was
 * the short-window layout from 2026-10-10, met on an ordinary laptop browser (it started at 640px
 * tall), and it had three faults no review caught because every check of this screen was a
 * picture at 1366x768 or 1920x1080, where it never appears. These checks fail on that layout and
 * pass on the fix (`styles.css`, "THE BREAKDOWN IN TWO COLUMNS").
 *
 * Deliberately NOT in `npm test`, for the reason `contrast` and `uiaudit` are not: a red
 * `npm test` must keep meaning "physics broke". Run it after any change to `Results.tsx` or the
 * `.resx-*` rules, and to the shared rules they sit in.
 *
 *   npm run resultsaudit
 *   npm run resultsaudit -- --cases=bbVersus --themes=dark --sizes=1366x625
 *   npm run resultsaudit -- --shots=scratch/results     # and a PNG of every board
 *
 * Its own Vite dev server on the repo's config, with its OWN dep cache (`node_modules/.vite-
 * resultsaudit`) so it never contends with a dev server already running here; Electron offscreen
 * and muted. The first run pre-bundles the fixture's dependencies, which takes a while once.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electron = createRequire(import.meta.url)('electron');

const server = await createServer({
  configFile: join(ROOT, 'vite.config.ts'),
  root: ROOT,
  cacheDir: join(ROOT, 'node_modules', '.vite-resultsaudit'),
  logLevel: 'error',
  // the fixture is the only entry, so its whole dependency graph is found BEFORE the first page
  // asks for it: with no HMR client there is no reload to rescue a late discovery
  optimizeDeps: { entries: ['scripts/results-fixture/index.html'] },
  server: { port: 5207, strictPort: false, hmr: false, open: false },
});
let code = 2;
try {
  await server.listen();
  const port = server.httpServer.address().port;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const passthrough = process.argv.slice(2).filter((a) => /^--(cases|themes|sizes|shots)=|^--verbose$/.test(a));
  // ⚠️ ASYNC, never `spawnSync`: the Vite server lives in THIS process, and a synchronous child
  // blocks the event loop it serves from — the page waited on a server that could not answer.
  const child = spawn(electron, [join(ROOT, 'scripts', 'results-fixture', 'run.cjs'), `--port=${port}`, ...passthrough], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  // Chromium's own stderr noise (GPU cache, sandbox) is not the audit's; only our lines are printed
  child.stdout.on('data', (d) => process.stdout.write(d));
  child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
  code = await new Promise((res) => child.on('close', (c) => res(c ?? 2)));
  if (code !== 0 && code !== 1) console.log(stderr.split('\n').slice(-20).join('\n'));
} finally {
  await server.close();
}
process.exit(code);
