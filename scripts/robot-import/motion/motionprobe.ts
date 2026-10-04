/**
 * MOVING PARTS ON A REAL CAD READ (`stepnames.ts` output; `docs/area/robot-import.md`, "Moving
 * parts"): the editor's own pipeline (merge, weld, lumps, simplify to 250k or keep every triangle,
 * crease, measure) and its own finders, every body labelled with its STEP part name. Per found group:
 * the names, a click (`coaxialBodies`) on its biggest body, and offscreen pictures (`softrender.ts`:
 * the robot with the group highlighted, close up along and across its axle, and the group alone).
 *
 *   npx tsx scripts/robot-import/motion/motionprobe.ts --model DIR --out DIR [--budget 250000|full]
 *       [--cfg draft.json]     the editor's draft (`motioneditor.cjs`): setup, placements, spec; the
 *                              groups it found are compared with these
 *       [--nobody 1]           read as the editor did before 2026-10-04 (STEP body ids dropped)
 *       [--compare report.json] the groups of another run, over the bodies both meshes have
 *       [--clickall 1]         a click on every body of every spinning group
 *       [--show regex] [--axle id | --axlename regex] [--pics 0]
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readPiece } from './stepnames';
import { Canvas, type View } from './softrender';
import { assembleLoaded } from '../../../src/robotImport/engine/parse';
import { simplifyModel } from '../../../src/robotImport/engine/prepare';
import { simplifyParts } from '../../../src/robotImport/engine/simplify';
import { creaseParts, splitLumps, weld } from '../../../src/robotImport/engine/meshOps';
import { bbox, defaultImportSetup, measureParts, type MeshPart } from '../../../src/robotImport/geometry';
import * as motion from '../../../src/robotImport/motion';
import { wheelDiameterMm } from '../../../src/robotImport/drive';
import type { ImportSetup, MotionGroup } from '../../../src/robotImport/types';
import type { ImportedMech, RobotSpec, Vec2 } from '../../../src/types';
import { coerceSpec } from '../../../src/sim/spawn';
import { bbIntakeKindOf, bbIsTurreted, bbLauncherOf } from '../../../src/games/biobuzz/mechs';
import { BB_HOOD_DEFAULT_DEG } from '../../../src/games/biobuzz/config';
import { decodeFixedLauncher } from '../../../src/sim/fixedShot';

type V3 = [number, number, number];
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const modelDir = resolve(args.get('model')!);
const out = resolve(args.get('out')!);
const budgetArg = args.get('budget') ?? '250000';
const full = budgetArg === 'full';
const budget = full ? 1e12 : Number(budgetArg);
const cfgFile = args.get('cfg');
const noPics = args.get('pics') === '0';
mkdirSync(out, { recursive: true });

const t = (): number => performance.now();
const ms = (a: number): string => `${Math.round(t() - a)} ms`;

// ---- the model ---------------------------------------------------------------------------------
const T0 = t();
const { parts: raw, meta } = readPiece(join(modelDir, 'model'));
const names: string[] = meta.names;
// --nobody 1: as the editor read a STEP before the fix (`readStepFile` dropped `body`)
const noBody = args.get('nobody') === '1';
const loaded = assembleLoaded('robot.step', 'step', { parts: (noBody ? raw.map((p) => ({ ...p, body: undefined })) : raw) as MeshPart[], bytes: existsSync(meta.file) ? statSync(meta.file).size : 0, notes: [], fileUnit: 'mm', trisIn: meta.trisIn });
console.log(`read ${ms(T0)}: ${loaded.parts.length} parts, ${meta.trisIn} tris in, ${names.length} bodies`);

// which body each lump came from: the same weld and split the simplifier makes
const lumpOf = new Map<number, number>();
if (!noBody) {
  const T = t();
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (const p of loaded.parts) for (let i = 0; i < p.positions.length; i += 3) for (let k = 0; k < 3; k++) {
    const v = p.positions[i + k];
    if (v < mn[k]) mn[k] = v;
    if (v > mx[k]) mx[k] = v;
  }
  const extent = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2], 1e-9);
  const welded = loaded.parts.map((p) => weld(p, extent * 1e-6));
  const before = welded.map((w) => w.body!.slice());
  splitLumps(welded, extent * 1e-5);
  welded.forEach((w, i) => {
    for (let v = 0; v < w.body!.length; v++) if (w.body![v] !== before[i][v]) lumpOf.set(w.body![v], before[i][v]);
  });
  console.log(`lumps ${ms(T)}: ${lumpOf.size} extra lumps`);
}
let nameOf = (b: number): string => {
  const src = lumpOf.get(b);
  return src !== undefined ? `${names[src] || '?'} (lump)` : names[b] || '?';
};

const T1 = t();
let prepared: MeshPart[];
if (full) {
  const s = await simplifyParts(loaded.parts, budget);
  prepared = creaseParts(s.parts);
} else prepared = (await simplifyModel(loaded, budget)).parts;
const tris = prepared.reduce((s, p) => s + (p.indices ? p.indices.length / 3 : 0), 0);
console.log(`prepared ${ms(T1)}: ${tris} tris`);
if (noBody) {
  // names by position: each body's vertices looked up among the read's, by their exact floats
  const key = (a: Float32Array, v: number): string => `${a[3 * v]},${a[3 * v + 1]},${a[3 * v + 2]}`;
  const want = new Map<string, number[]>();
  const per = new Map<number, number>();
  for (const p of prepared) for (let v = 0; v < (p.body?.length ?? 0); v++) {
    const b = p.body![v];
    const k = per.get(b) ?? 0;
    if (k >= 400) continue;
    per.set(b, k + 1);
    const s = key(p.positions, v);
    const l = want.get(s);
    if (l) l.push(b);
    else want.set(s, [b]);
  }
  const got = new Map<number, Map<string, number>>();
  for (const p of raw) for (let v = 0; v < (p.body?.length ?? 0); v++) {
    const l = want.get(key(p.positions, v));
    if (!l) continue;
    const n = names[p.body![v]] || '?';
    for (const b of l) {
      let m = got.get(b);
      if (!m) got.set(b, (m = new Map()));
      m.set(n, (m.get(n) ?? 0) + 1);
    }
  }
  nameOf = (b: number): string => {
    const m = got.get(b);
    return m ? [...m.entries()].sort((x, y) => y[1] - x[1]).map(([n]) => n).join(' + ') : '?';
  };
}

// ---- the setup and the measurement --------------------------------------------------------------
interface Cfg {
  game: string;
  setup?: ImportSetup;
  mech?: ImportedMech | null;
  spec?: RobotSpec;
  turret?: boolean;
  ramp?: boolean;
}
const cfg: Cfg = cfgFile ? JSON.parse(readFileSync(cfgFile, 'utf8')) : { game: 'decode' };
// a draft from the editor: the build's turret and ramp as the editor's `findAll` reads them
if (cfg.spec) {
  const spec = coerceSpec(cfg.spec, undefined, cfg.game as never);
  if (cfg.turret === undefined) cfg.turret = cfg.game === 'biobuzz' ? bbIsTurreted(bbLauncherOf(spec, BB_HOOD_DEFAULT_DEG)) : cfg.game === 'chain' ? spec.scoreMode === 'turret' || spec.scoreMode === 'twinturret' : !decodeFixedLauncher(spec);
  if (cfg.ramp === undefined) cfg.ramp = cfg.game === 'biobuzz' && bbIntakeKindOf(spec) === 'ramp';
}
const editorFound: MotionGroup[] = cfg.setup?.motion ?? [];
let setup: ImportSetup = cfg.setup ? { ...cfg.setup, motion: undefined } : defaultImportSetup();
const T2 = t();
let measured = measureParts(prepared.map((p) => ({ ...p, positions: p.positions.slice() })), setup, { format: 'step', fileUnit: 'mm' });
if (!cfg.setup && measured.measurement.front?.detected && measured.measurement.front.yaw !== setup.yaw) {
  setup = { ...setup, yaw: measured.measurement.front.yaw };
  measured = measureParts(prepared.map((p) => ({ ...p, positions: p.positions.slice() })), setup, { format: 'step', fileUnit: 'mm' });
}
const m = measured.measurement;
const modelParts = measured.modelParts;
console.log(`measured ${ms(T2)}: units ${m.units} up ${m.up} yaw ${setup.yaw}, ${m.size.length.toFixed(2)} x ${m.size.width.toFixed(2)} x ${m.size.height.toFixed(2)} in`);
const rectangleWheels = (hull: readonly Vec2[]): Vec2[] => {
  const b = bbox(hull);
  return [
    { x: b.maxX - 1.5, y: b.maxY - 1.5 },
    { x: b.maxX - 1.5, y: b.minY + 1.5 },
    { x: b.minX + 1.5, y: b.maxY - 1.5 },
    { x: b.minX + 1.5, y: b.minY + 1.5 },
  ];
};
// the measurement's wheels are robot-local (shifted by the origin); the editor's are MODEL frame
const baseWheels: Vec2[] = m.wheelsUsed ?? rectangleWheels(m.hull);
console.log(`wheels (model): ${baseWheels.map((w) => `(${w.x.toFixed(2)}, ${w.y.toFixed(2)})`).join(' ')}; ${m.wheelSource}`);

// ---- the finders, as the editor's `findAll` ----------------------------------------------------
const timing: Record<string, number> = {};
const time = <T>(k: string, f: () => T): T => {
  const a = t();
  const r = f();
  timing[k] = Math.round(t() - a);
  return r;
};
const st = time('bodyStats', () => motion.bodyStats(modelParts));
const found: MotionGroup[] = [];
const taken = (): Set<number> => new Set(found.flatMap((g) => g.bodies));
const wheelDia = wheelDiameterMm(setup.drive.wheel) / 25.4;
found.push(...time('wheels', () => motion.findWheelGroups(modelParts, baseWheels, setup.drive.drivetrain, wheelDia)));
// what the model is built with, before any placement (`readBuild`): the editor's defaults for a new import
const build = time('build', () => motion.readBuild(modelParts, taken()));
console.log(`build: ${JSON.stringify(build)}`);
const intakes = cfg.mech?.intakes ?? [];
if (intakes.length) found.push(...time('rollers', () => motion.findRollerGroups(modelParts, intakes, taken())));
const shooter = cfg.mech?.shooter;
if (shooter) {
  const at: V3 = [shooter.x, shooter.y, shooter.z];
  if (cfg.turret) {
    const tg = time('turret', () => motion.findTurretGroup(modelParts, at, taken()));
    if (tg) found.push(tg);
  }
  found.push(...time('flywheels', () => motion.findFlywheelGroups(modelParts, at, taken())));
}
if (intakes.length) {
  const dep = time('deployed', () => motion.findDeployedGroup(modelParts, intakes, cfg.ramp ? 'ramp' : 'fold', taken()));
  if (dep) found.push(dep);
}
timing.total = Object.entries(timing).reduce((s, [, v]) => s + v, 0);
console.log(`finders: ${JSON.stringify(timing)}`);
// --compare report-250000.json: the same groups on this mesh, over the bodies both meshes have
if (args.has('compare')) {
  const other = JSON.parse(readFileSync(args.get('compare')!, 'utf8')) as { groups: { role: string; bodies: number[] }[] };
  const here = new Set(motion.bodyStats(modelParts).ids);
  const there = new Set(other.groups.flatMap((g) => g.bodies));
  const otherAll = new Set<number>(JSON.parse(readFileSync(args.get('compare')!.replace('report-', 'bodies-'), 'utf8')).map((x: { b: number }) => x.b));
  let same = 0;
  const diffs: string[] = [];
  for (const g of other.groups) {
    const mine = found.find((f) => f.role === g.role && f.bodies.some((b) => g.bodies.includes(b)));
    const a = g.bodies.filter((b) => here.has(b)).sort((x, y) => x - y);
    const b = (mine?.bodies ?? []).filter((x) => otherAll.has(x)).sort((x, y) => x - y);
    if (JSON.stringify(a) === JSON.stringify(b)) same++;
    else diffs.push(`${g.role}: 250k ${a.length} vs here ${b.length} (only 250k: ${a.filter((x) => !b.includes(x)).slice(0, 8).join(',')}; only here: ${b.filter((x) => !a.includes(x)).slice(0, 8).join(',')})`);
  }
  const extra = found.filter((f) => !f.bodies.some((b) => there.has(b)));
  console.log(`compare: ${same}/${other.groups.length} groups the same over the shared bodies; groups only here: ${extra.length}${diffs.length ? '\n  ' + diffs.join('\n  ') : ''}`);
}
if (editorFound.length) {
  const key = (g: MotionGroup): string => `${g.role}:${[...g.bodies].sort((a, b) => a - b).join(',')}`;
  const mine = new Set(found.map(key));
  const theirs = new Set(editorFound.map(key));
  const same = [...theirs].filter((k) => mine.has(k)).length;
  console.log(`editor's draft: ${editorFound.length} groups, ${same} identical here; editor only: ${editorFound.filter((g) => !mine.has(key(g))).map((g) => `${g.role}(${g.bodies.length})`).join(' ') || '-'}; here only: ${found.filter((g) => !theirs.has(key(g))).map((g) => `${g.role}(${g.bodies.length})`).join(' ') || '-'}`);
}

// ---- report ------------------------------------------------------------------------------------
const ext = (b: number): number => Math.max(st.max[3 * b] - st.min[3 * b], st.max[3 * b + 1] - st.min[3 * b + 1], st.max[3 * b + 2] - st.min[3 * b + 2]);
const centre = (b: number): V3 => [0, 1, 2].map((k) => (st.min[3 * b + k] + st.max[3 * b + k]) / 2) as V3;
const f2 = (x: number): string => x.toFixed(2);
const describe = (b: number): string => `#${b} ${nameOf(b)} [${f2(ext(b))} in @ ${centre(b).map(f2).join(',')}]`;
const hist = (bodies: readonly number[]): string => {
  const c = new Map<string, number>();
  for (const b of bodies) c.set(nameOf(b), (c.get(nameOf(b)) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1]).map(([n, k]) => `${k}× ${n}`).join('; ');
};
const lines: string[] = [];
const report: any = { budget: budgetArg, tris, timing, size: m.size, wheels: baseWheels, groups: [] as any[] };
const derived = motion.deriveMotion(modelParts, found, [], [0, 0, 0]);
found.forEach((g, gi) => {
  const dp = derived.find((p) => p.group === gi);
  const fit = dp ? { axis: dp.axis, radius: dp.radius, pivot: dp.pivot } : motion.fitRound(modelParts, g.bodies);
  // a click on the group's biggest body, as the Pick parts button would take it
  const seed = [...g.bodies].sort((a, b) => ext(b) - ext(a) || st.n[b] - st.n[a])[0];
  const role = g.role;
  const pick = motion.isSpin(role) ? motion.coaxialBodies(modelParts, seed, role) : motion.mountedBodies(modelParts, seed);
  const gs = new Set(g.bodies);
  const ps = new Set(pick);
  lines.push(`\n[${gi}] ${role}${g.corner !== undefined ? ` corner ${g.corner}` : ''}: ${g.bodies.length} bodies${fit ? `, axis ${fit.axis.map(f2).join(',')} r ${f2(fit.radius)} @ ${fit.pivot.map(f2).join(',')}` : ''}`);
  lines.push(`    names: ${hist(g.bodies)}`);
  for (const b of g.bodies) lines.push(`      ${describe(b)}`);
  lines.push(`    click on #${seed} (${nameOf(seed)}): ${pick.length} bodies; not in group: ${pick.filter((b) => !gs.has(b)).map(describe).join(' | ') || '-'}; group not picked: ${g.bodies.filter((b) => !ps.has(b)).length}`);
  if (args.get('clickall') === '1' && motion.isSpin(role)) {
    // a click on EVERY body of the group: what it takes from outside the group
    const outside = new Map<number, number>();
    let full = 0;
    const culprits: string[] = [];
    for (const b of g.bodies) {
      const p = motion.coaxialBodies(modelParts, b, role);
      if (p.length === g.bodies.length && p.every((x) => gs.has(x))) full++;
      const o = p.filter((x) => !gs.has(x));
      if (o.length) culprits.push(`${describe(b)} → ${o.length}`);
      for (const x of o) outside.set(x, (outside.get(x) ?? 0) + 1);
    }
    if (culprits.length) lines.push(`    clicks taking outside bodies: ${culprits.join(' | ')}`);
    report.clicks = (report.clicks ?? 0) + g.bodies.length;
    report.outside = (report.outside ?? 0) + outside.size;
    lines.push(`    clicks on all ${g.bodies.length}: ${full} take the whole group; bodies from outside it: ${[...outside.keys()].map(describe).join(' | ') || '-'}`);
  }
  report.groups.push({ role, corner: g.corner, bodies: g.bodies, names: g.bodies.map(nameOf), pick, seed });
});
console.log(lines.join('\n'));
writeFileSync(join(out, `report-${budgetArg}.txt`), `tris ${tris}\ntiming ${JSON.stringify(timing)}\n` + lines.join('\n'));
writeFileSync(join(out, `report-${budgetArg}.json`), JSON.stringify(report));
// every body's name, for lookups
writeFileSync(join(out, `bodies-${budgetArg}.json`), JSON.stringify(st.ids.map((b) => ({ b, name: nameOf(b), ext: +f2(ext(b)), c: centre(b).map((x) => +f2(x)), n: st.n[b] }))));

// ---- the bodies on one body's axle: --axle <body id> (or --axlename "regex": the biggest match) ----
{
  let seed = args.has('axle') ? Number(args.get('axle')) : -1;
  if (args.has('axlename')) {
    const re = new RegExp(args.get('axlename')!);
    seed = st.ids.filter((b) => re.test(nameOf(b))).sort((a, b) => ext(b) - ext(a))[0] ?? -1;
  }
  if (seed >= 0) {
    const fit = motion.fitRound(modelParts, [seed])!;
    const ax = fit.axis;
    const pv = fit.pivot;
    console.log(`\naxle of #${seed} ${nameOf(seed)}: axis ${ax.map(f2)} pivot ${pv.map(f2)} r ${f2(fit.radius)}`);
    const rows: { b: number; lo: number; hi: number; r: number; off: number }[] = [];
    for (const b of st.ids) {
      const c = centre(b);
      const d: V3 = [c[0] - pv[0], c[1] - pv[1], c[2] - pv[2]];
      const al = d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2];
      const off = Math.hypot(d[0] - ax[0] * al, d[1] - ax[1] * al, d[2] - ax[2] * al);
      if (off > 0.5 || Math.abs(al) > 12) continue;
      rows.push({ b, lo: Infinity, hi: -Infinity, r: 0, off });
    }
    const byB = new Map(rows.map((r) => [r.b, r]));
    for (const p of modelParts) {
      if (!p.body) continue;
      for (let v = 0; v < p.body.length; v++) {
        const r = byB.get(p.body[v]);
        if (!r) continue;
        const d: V3 = [p.positions[3 * v] - pv[0], p.positions[3 * v + 1] - pv[1], p.positions[3 * v + 2] - pv[2]];
        const al = d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2];
        const rr = Math.hypot(d[0] - ax[0] * al, d[1] - ax[1] * al, d[2] - ax[2] * al);
        r.lo = Math.min(r.lo, al);
        r.hi = Math.max(r.hi, al);
        r.r = Math.max(r.r, rr);
      }
    }
    rows.sort((a, b) => a.lo - b.lo);
    for (const r of rows) console.log(`   ${f2(r.lo).padStart(6)} .. ${f2(r.hi).padStart(6)}  r ${f2(r.r).padStart(5)} off ${f2(r.off)}  ${describe(r.b)}`);
  }
}

// ---- a look at named bodies: --show "regex" ----------------------------------------------------
const showRe = args.get('show');
if (showRe) {
  const re = new RegExp(showRe);
  const sel = new Set(st.ids.filter((b) => re.test(nameOf(b))));
  console.log(`show ${showRe}: ${sel.size} bodies; ${hist([...sel])}`);
  for (const b of [...sel].slice(0, 40)) console.log(`   ${describe(b)}`);
  const lo = [0, 1, 2].map((k) => Math.min(...[...sel].map((b) => st.min[3 * b + k])));
  const hi = [0, 1, 2].map((k) => Math.max(...[...sel].map((b) => st.max[3 * b + k])));
  const c0: V3 = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2) as V3;
  const c = new Canvas(1600, 800);
  const col = (b: number): V3 | null => (sel.has(b) ? [1, 0.2, 0.6] : null);
  c.draw(modelParts, { dir: [-1, -0.8, -0.7], up: [0, 0, 1], centre: [0, 0, 6], half: 14, w: 800, h: 800 }, col, 0, 0, 800, 800);
  const half = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 + 1;
  c.draw(filterBodies(modelParts, sel), { dir: [-1, -0.6, -0.5], up: [0, 0, 1], centre: c0, half, w: 800, h: 800 }, () => null, 800, 0, 800, 800);
  c.png(join(out, `${budgetArg}-show-${showRe.replace(/[^\w]+/g, '_')}.png`));
}

// ---- pictures ----------------------------------------------------------------------------------
if (!noPics) {
  const ORANGE: V3 = [1, 0.45, 0.05];
  const BLUE: V3 = [0.35, 0.6, 1];
  const inAny = new Set(found.flatMap((g) => g.bodies));
  const robotBox = { min: [0, 1, 2].map((k) => Math.min(...st.ids.map((b) => st.min[3 * b + k]))), max: [0, 1, 2].map((k) => Math.max(...st.ids.map((b) => st.max[3 * b + k]))) };
  const rc: V3 = [0, 1, 2].map((k) => (robotBox.min[k] + robotBox.max[k]) / 2) as V3;
  // overview: every group, from above-front-left and above-back-right
  {
    const c = new Canvas(1600, 800);
    const col = (b: number): V3 | null => (inAny.has(b) ? ORANGE : null);
    c.draw(modelParts, { dir: [-1, -0.8, -0.7], up: [0, 0, 1], centre: rc, half: 14, w: 800, h: 800 }, col, 0, 0, 800, 800);
    c.draw(modelParts, { dir: [1, 0.8, -0.7], up: [0, 0, 1], centre: rc, half: 14, w: 800, h: 800 }, col, 800, 0, 800, 800);
    c.png(join(out, `${budgetArg}-overview.png`));
  }
  found.forEach((g, gi) => {
    const gs = new Set(g.bodies);
    const lo = [0, 1, 2].map((k) => Math.min(...g.bodies.map((b) => st.min[3 * b + k])));
    const hi = [0, 1, 2].map((k) => Math.max(...g.bodies.map((b) => st.max[3 * b + k])));
    const gc: V3 = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2) as V3;
    const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    const fit = motion.fitRound(modelParts, g.bodies);
    const axis: V3 = fit ? fit.axis : [0, 1, 0];
    // outward: from the robot's centre toward the group, along the axle's line
    const sgn = (gc[0] - rc[0]) * axis[0] + (gc[1] - rc[1]) * axis[1] + (gc[2] - rc[2]) * axis[2] >= 0 ? 1 : -1;
    const look: V3 = [-axis[0] * sgn, -axis[1] * sgn, -axis[2] * sgn];
    const side: V3 = Math.abs(axis[2]) > 0.7 ? [1, 0, 0] : [0, 0, 1];
    const sq: V3 = Math.abs(axis[2]) > 0.7 ? [0, -1, 0.0001] : [-0.0001, 0, -1];
    const half = span / 2 + 1.5;
    const c = new Canvas(1600, 800);
    const col = (b: number): V3 | null => (gs.has(b) ? ORANGE : inAny.has(b) ? BLUE : null);
    const only = (b: number): V3 | null => (gs.has(b) ? null : null);
    // 1 the robot, group highlighted
    c.draw(modelParts, { dir: [look[0] * 0.7 - 0.3, look[1] * 0.7 - 0.3, -0.6], up: [0, 0, 1], centre: rc, half: 13, w: 400, h: 400 }, col, 0, 0, 800, 800);
    // 2 close: along the axle from outside
    c.draw(modelParts, { dir: look, up: side, centre: gc, half, w: 400, h: 400 }, col, 800, 0, 400, 400);
    // 3 close: square to the axle, a slab about it (nothing in front hides it)
    c.draw(modelParts, { dir: sq, up: axis[2] > 0.7 ? [1, 0, 0] : [axis[0], axis[1], 0], centre: gc, half, w: 400, h: 400, near: -(half + 0.5), far: half + 0.5 }, col, 1200, 0, 400, 400);
    // 4 the group alone, in its own colours, from the side and from the axle
    const alone = modelParts.map((p) => p); // same parts; skip others with a far clip via colour test below
    const c2 = new Canvas(800, 400);
    const onlyParts = filterBodies(alone, gs);
    c2.draw(onlyParts, { dir: [look[0] * 0.8 + sq[0] * 0.3, look[1] * 0.8 + sq[1] * 0.3, look[2] * 0.8 - 0.3], up: side, centre: gc, half, w: 400, h: 400 }, only, 0, 0, 400, 400);
    c2.draw(onlyParts, { dir: sq, up: axis[2] > 0.7 ? [1, 0, 0] : [axis[0], axis[1], 0], centre: gc, half, w: 400, h: 400 }, only, 400, 0, 400, 400);
    for (let y = 0; y < 400; y++) for (let x = 0; x < 800; x++) {
      const o = (400 + y) * 1600 + 800 + x;
      const q = y * 800 + x;
      c.rgb[3 * o] = c2.rgb[3 * q];
      c.rgb[3 * o + 1] = c2.rgb[3 * q + 1];
      c.rgb[3 * o + 2] = c2.rgb[3 * q + 2];
    }
    c.rect(800, 398, 800, 3, [0.2, 0.2, 0.2]);
    c.rect(1198, 0, 3, 800, [0.2, 0.2, 0.2]);
    c.rect(798, 0, 3, 800, [0.2, 0.2, 0.2]);
    c.png(join(out, `${budgetArg}-g${gi}-${g.role}${g.corner !== undefined ? g.corner : ''}.png`));
  });
}
console.log(`total ${ms(T0)}`);

/** only the triangles of `keep`'s bodies */
function filterBodies(parts: readonly MeshPart[], keep: ReadonlySet<number>): MeshPart[] {
  const outP: MeshPart[] = [];
  for (const p of parts) {
    if (!p.body || !p.indices) continue;
    const idx: number[] = [];
    for (let i = 0; i < p.indices.length; i += 3) if (keep.has(p.body[p.indices[i]])) idx.push(p.indices[i], p.indices[i + 1], p.indices[i + 2]);
    if (idx.length) outP.push({ ...p, indices: Uint32Array.from(idx) });
  }
  return outP;
}
