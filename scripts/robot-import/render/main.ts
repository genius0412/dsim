/**
 * IMPORTED-ROBOT RENDER HARNESS — a throwaway dev page (never built or shipped) that photographs
 * an imported robot through every renderer, beside a standard robot, from a REAL importer run:
 * lane 3's engine loads `scripts/fixtures/robot-import/robot.glb`, normalises and BAKES it, and the
 * baked top PNG and stored GLB are lent to `render/importedAssets.ts` exactly as the editor lends a
 * draft. So the picture frame and the mesh frame are exercised end to end, writer to reader.
 *
 *   npx vite scripts/robot-import/render --port 5192
 *   ?theme=light|dark       the page theme (the field-ground pictures must not change with it)
 *
 * Rows: the 2D sprites of all three games (standard · import without its picture, as a remote
 * player sees it · import with its picture, as its owner does), the builder previews, and the
 * BIOBUZZ 3D turntable (standard · placeholder · mesh · mesh in physical materials). Sets
 * `window.__done` when everything has drawn; `capture.cjs` photographs it offscreen.
 */
import '../../../src/ui/shell.css';
import { createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { initPhysics } from '../../../src/sim/physicsEngine';
import { loadImporterEngine } from '../../../src/robotImport/engineLoader';
import { buildDescriptor, defaultImportSetup } from '../../../src/robotImport/geometry';
import { importedTopImage, registerImportedAssets, subscribeImportedAssets } from '../../../src/render/importedAssets';
import { simModuleFor } from '../../../src/games/sim';
import { DEFAULT_ASSISTS, DEFAULT_SPEC, coerceSpec } from '../../../src/sim/spawn';
import { BB_DEFAULT_SPEC } from '../../../src/games/biobuzz/coerce';
import { drawRobot } from '../../../src/render/drawRobot';
import { drawChainRobot } from '../../../src/games/chain/drawRobot';
import { drawBiobuzzRobot } from '../../../src/games/biobuzz/drawRobot';
import { RobotPreview } from '../../../src/ui/RobotPreview';
import { ChainRobotPreview } from '../../../src/games/chain/RobotPreview';
import { BiobuzzRobotPreview } from '../../../src/games/biobuzz/RobotPreview';
import { FootprintSvg } from '../../../src/ui/FootprintSvg';
import { COLORS } from '../../../src/config';
import type { GameId, ImportedMech, ImportedRobot, RobotSpec, World } from '../../../src/types';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark';
const status = document.getElementById('status') as HTMLElement;
const say = (s: string): void => {
  status.textContent = s;
};
(window as unknown as { __done: boolean }).__done = false;

const OWNER = 'feedfacecafe0001'; // pictures + mesh lent
const REMOTE = 'feedfacecafe0002'; // same robot, nothing on this device

function cell(row: HTMLElement, label: string): HTMLElement {
  const fig = document.createElement('figure');
  fig.className = 'cell';
  const cap = document.createElement('figcaption');
  cap.textContent = label;
  fig.append(cap);
  row.append(fig);
  return fig;
}

function section(title: string): HTMLElement {
  const h = document.createElement('h2');
  h.textContent = title;
  const row = document.createElement('div');
  row.className = 'row';
  document.getElementById('rows')!.append(h, row);
  return row;
}

async function run(): Promise<void> {
  await initPhysics();
  say('baking the fixture through the importer…');
  const eng = await loadImporterEngine();
  const file = new File([await (await fetch('/robot.glb')).arrayBuffer()], 'robot.glb');
  const prepared = await eng.simplifyModel(await eng.loadModel([file]), 100_000);
  const norm = eng.normalise(prepared, defaultImportSetup());
  // PLACED mechanisms (the editor's step 3), so every renderer has to follow the sim's accessors
  // rather than the bounding box: an off-centre front mouth, two placed launcher heads at their own
  // heights, a placed placer base
  const mech: ImportedMech = {
    intakes: [{ edge: 'front', from: -2, to: 5 }],
    shooter: { x: -3, y: 2.5, z: 11 },
    shooter2: { x: -3, y: -3, z: 13 },
    place: { x: -2, y: -1, z: 6 },
  };
  const owner = buildDescriptor({ id: OWNER, measurement: norm.measurement, mech });
  const baked = await eng.bake({ modelParts: norm.modelParts, origin: norm.measurement.origin, descriptor: owner });
  registerImportedAssets(OWNER, { top: baked.top, mesh: baked.mesh });
  const remote: ImportedRobot = { ...owner, id: REMOTE };
  // a turretless launcher's LIP placed on the nose (a drum or a dumper throws over its own edge)
  const remoteLip: ImportedRobot = { ...owner, id: 'feedfacecafe0003', mech: { ...mech, shooter: { x: 7, y: 1, z: 9 } } };

  // ── 2D: the three sprites ──────────────────────────────────────────────────────────────
  const games: [GameId, string, Partial<RobotSpec>, Partial<RobotSpec> | null, (ctx: CanvasRenderingContext2D, w: World) => void][] = [
    ['decode', 'DECODE', {}, null, (ctx, w) => drawRobot(ctx, w.robots[0], true, [], { x: 0, y: 1 }, w)],
    [
      'chain',
      'Chain Reaction',
      { scoreMode: 'turret', catalystType: 'arm', catalystMount: 'back' } as Partial<RobotSpec>,
      { scoreMode: 'drum', catalystType: 'arm', catalystMount: 'back' } as Partial<RobotSpec>,
      (ctx, w) => drawChainRobot(ctx, w.robots[0], true, [], { x: 0, y: 1 }, w),
    ],
    [
      'biobuzz',
      'BIOBUZZ',
      { bbMech: { launcher: { kind: 'twinturret', mount: 'left', mount2: 'right', hoodDeg: 45 }, lift: { kind: 'vslide', mount: 'back' }, intake: { kind: 'sweeper' } } } as Partial<RobotSpec>,
      { intakeMount: 'back', bbMech: { launcher: { kind: 'dumper', mount: 'front', hoodDeg: 45 }, lift: null, intake: { kind: 'sweeper' } } } as Partial<RobotSpec>,
      (ctx, w) => drawBiobuzzRobot(ctx, w.robots[0], true, [], { x: 0, y: 1 }, w),
    ],
  ];
  const redraws: (() => void)[] = [];
  for (const [game, name, patch, turretless, draw] of games) {
    const row = section(`${name} — 2D sprite`);
    const base = game === 'biobuzz' ? BB_DEFAULT_SPEC : DEFAULT_SPEC;
    const cells: [string, ImportedRobot | undefined, Partial<RobotSpec>][] = [
      ['standard', undefined, patch],
      ['import, no picture (remote player)', remote, patch],
      ['import, picture (owner)', owner, patch],
    ];
    if (turretless) cells.push([game === 'chain' ? 'import drum, no picture' : 'import dumper, no picture', remoteLip, turretless]);
    for (const [label, imp, cellPatch] of cells) {
      const spec = coerceSpec({ ...base, ...cellPatch, ...(imp ? { imported: imp } : {}) }, base, game);
      const w = simModuleFor(game).createWorld('free', 5, [{ id: 0, alliance: 'blue', spec, assists: { ...DEFAULT_ASSISTS }, startIndex: 0 }]);
      const r = w.robots[0];
      r.heading = Math.PI / 2;
      r.turretHeading = Math.PI / 2 + 0.6;
      r.hopper = game === 'biobuzz' ? ['yellow', 'blue'] : ['green', 'purple'];
      const canvas = document.createElement('canvas');
      const px = 300;
      canvas.width = px * 2;
      canvas.height = px * 2;
      canvas.style.width = `${px}px`;
      canvas.style.height = `${px}px`;
      cell(row, label).prepend(canvas);
      const paint = (): void => {
        const ctx = canvas.getContext('2d')!;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = COLORS.mat;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const s = (canvas.width / 30);
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.scale(s, -s);
        ctx.translate(-r.pos.x, -r.pos.y);
        draw(ctx, w);
      };
      paint();
      redraws.push(paint);
    }
  }
  subscribeImportedAssets(() => redraws.forEach((p) => p()));

  // ── the builder previews and the card footprint ────────────────────────────────────────
  const prow = section('Builder previews (import with its picture) and the card footprint (no picture)');
  const specFor = (game: GameId, imp: ImportedRobot, patch: Partial<RobotSpec> = {}): RobotSpec => {
    const base = game === 'biobuzz' ? BB_DEFAULT_SPEC : DEFAULT_SPEC;
    return coerceSpec({ ...base, ...patch, imported: imp }, base, game);
  };
  const mount = (label: string, el: ReactElement): void => {
    const host = document.createElement('div');
    cell(prow, label).prepend(host);
    createRoot(host).render(el);
  };
  mount('DECODE preview', createElement(RobotPreview, { spec: specFor('decode', owner), size: 220 }));
  mount('Chain preview', createElement(ChainRobotPreview, { spec: specFor('chain', owner, { scoreMode: 'turret' }), size: 220 }));
  mount('BIOBUZZ preview', createElement(BiobuzzRobotPreview, { spec: specFor('biobuzz', owner, games[2][2]), size: 220 }));
  mount('FootprintSvg, 96 px card', createElement(FootprintSvg, { imported: remote, drivetrain: 'mecanum', size: 96 }));

  // ── 3D: the BIOBUZZ turntable, the same generator the match uses ───────────────────────
  const trow = section('BIOBUZZ 3D — the builder turntable (buildRobotGroup)');
  try {
    const { createRobotPreviewScene } = await import('../../../src/games/biobuzz/scene/renderScene');
    const { importedMeshKey } = await import('../../../src/games/biobuzz/scene/renderImported');
    const turret = games[2][2];
    const shots: [string, RobotSpec, 'high' | 'extreme'][] = [
      ['standard', coerceSpec({ ...BB_DEFAULT_SPEC, ...turret }, BB_DEFAULT_SPEC, 'biobuzz'), 'high'],
      ['import placeholder (no mesh)', specFor('biobuzz', remote, turret), 'high'],
      ['import placeholder, dumper', specFor('biobuzz', remoteLip, games[2][3] ?? {}), 'high'],
      ['import mesh', specFor('biobuzz', owner, turret), 'high'],
      ['import mesh, physical materials', specFor('biobuzz', owner, turret), 'extreme'],
    ];
    for (const [label, spec, quality] of shots) {
      const host = document.createElement('div');
      host.style.width = '300px';
      host.style.height = '300px';
      const fig = cell(trow, `${label} · ${quality}`);
      fig.prepend(host);
      const sc = createRobotPreviewScene(host, { quality, animate: false, interactive: false });
      sc.resize(300, 300, 1);
      sc.setSpec(spec, 'blue');
      // the mesh parses asynchronously: wait for the key to say so (the scene re-keys itself)
      for (let i = 0; i < 100 && spec.imported?.id === OWNER && !importedMeshKey(spec).endsWith(':mesh'); i++) await new Promise((r) => setTimeout(r, 50));
      await sc.ready();
      await new Promise((r) => setTimeout(r, quality === 'extreme' ? 1500 : 300));
      const img = document.createElement('img');
      img.src = sc.capture(300);
      img.width = 300;
      img.height = 300;
      host.replaceWith(img);
      sc.dispose();
    }
  } catch (err) {
    cell(trow, `3D unavailable here: ${String(err)}`);
  }
  // let the decoded top picture land in every 2D cell and preview
  for (let i = 0; i < 40 && !importedTopImage(OWNER); i++) await new Promise((r) => setTimeout(r, 50));
  redraws.forEach((p) => p());
  await new Promise((r) => setTimeout(r, 300));
  // an offscreen capture does not composite accelerated 2D canvases, so each one is handed over
  // as the image it drew (the sprites' own pixels, nothing re-rendered)
  for (const c of [...document.querySelectorAll('canvas')]) {
    const img = document.createElement('img');
    img.src = c.toDataURL('image/png');
    img.style.width = c.style.width || `${c.clientWidth}px`;
    img.style.height = c.style.height || `${c.clientHeight}px`;
    c.replaceWith(img);
  }
  await new Promise((r) => setTimeout(r, 200));
  say(`done · hull ${owner.hull.length} vertices · height ${owner.heightIn} in · ${owner.bands?.length ?? 0} bands · wheels ${JSON.stringify(owner.wheels)}`);
  (window as unknown as { __done: boolean }).__done = true;
}

run().catch((err) => {
  say(`FAILED: ${(err as Error).stack ?? String(err)}`);
  (window as unknown as { __done: boolean }).__done = true;
});
