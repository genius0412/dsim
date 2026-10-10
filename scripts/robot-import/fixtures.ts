/**
 * Writes the importer's test fixtures to `scripts/fixtures/robot-import/`: the synthetic robot
 * (`synthRobot.ts`) in every format the importer reads, each in a DIFFERENT unit and axis
 * convention so the detection has something to detect.
 *
 *   robot.glb         metres, +Y up, front +Z          (glTF by the book)
 *   robot.stl         millimetres, +Z up, front −Y     (binary STL, CAD export)
 *   robot.obj + .mtl  inches, +Y up, front +Z          (a Y-up tool; the format default is +Z)
 *   robot.ply         centimetres, +Z up, front −Y     (binary, per-vertex colour)
 *   robot.3mf         millimetres (declared), +Z up    (base materials)
 *   robot.step        millimetres (declared), +Z up    (AP214 B-rep with colours)
 *
 * Run: npx tsx scripts/robot-import/fixtures.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'three/examples/jsm/libs/fflate.module.js';
import { buildGlb } from '../../src/robotImport/shareFile';
import { FRAMES, prismTriangles, synthRobot, type Prism, type V3 } from './synthRobot';

const OUT = join('scripts', 'fixtures', 'robot-import');
const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const hex2 = (c: number): string => Math.round(c * 255).toString(16).padStart(2, '0');

/** each prism's triangles mapped into a file frame */
function triangles(prisms: Prism[], map: (v: V3) => V3): { p: Prism; tris: V3[][] }[] {
  return prisms.map((p) => ({ p, tris: prismTriangles(p).map((t) => t.map(map)) }));
}

export function writeGlb(prisms: Prism[]): Uint8Array {
  const parts = triangles(prisms, FRAMES.gltf);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const json: Record<string, unknown> & { accessors: unknown[]; bufferViews: unknown[]; meshes: unknown[]; nodes: unknown[]; materials: unknown[] } = {
    asset: { version: '2.0', generator: 'dsim robot-import fixtures' },
    scene: 0,
    scenes: [{ nodes: [] as number[] }],
    nodes: [],
    meshes: [],
    materials: [],
    accessors: [],
    bufferViews: [],
    buffers: [],
  };
  parts.forEach(({ p, tris }, i) => {
    const pos = new Float32Array(tris.length * 9);
    tris.forEach((t, a) => t.forEach((v, b) => pos.set(v, a * 9 + b * 3)));
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < pos.length; k++) {
      min[k % 3] = Math.min(min[k % 3], pos[k]);
      max[k % 3] = Math.max(max[k % 3], pos[k]);
    }
    const bytes = new Uint8Array(pos.buffer);
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target: 34962 });
    json.accessors.push({ bufferView: i, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max });
    json.materials.push({ name: p.name, pbrMetallicRoughness: { baseColorFactor: [lin(p.color[0]), lin(p.color[1]), lin(p.color[2]), 1], metallicFactor: 0, roughnessFactor: 0.6 } });
    json.meshes.push({ name: p.name, primitives: [{ attributes: { POSITION: i }, material: i }] });
    json.nodes.push({ name: p.name, mesh: i });
    (json.scenes as { nodes: number[] }[])[0].nodes.push(i);
    chunks.push(bytes);
    offset += bytes.length;
  });
  const bin = new Uint8Array(offset);
  let at = 0;
  for (const c of chunks) {
    bin.set(c, at);
    at += c.length;
  }
  (json.buffers as unknown[]).push({ byteLength: offset });
  return buildGlb(json, bin);
}

export function writeStl(prisms: Prism[]): Uint8Array {
  const tris = triangles(prisms, FRAMES.cadMm).flatMap((x) => x.tris);
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  new Uint8Array(buf).set(strToU8('dsim robot-import fixture, millimetres, Z up'.padEnd(80, ' ')), 0);
  dv.setUint32(80, tris.length, true);
  tris.forEach((t, i) => {
    const o = 84 + i * 50;
    const u = [t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]];
    const w = [t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    for (let k = 0; k < 3; k++) dv.setFloat32(o + 4 * k, n[k] / l, true);
    t.forEach((v, j) => v.forEach((c, k) => dv.setFloat32(o + 12 + 12 * j + 4 * k, c, true)));
  });
  return new Uint8Array(buf);
}

export function writeObj(prisms: Prism[]): { obj: string; mtl: string } {
  const parts = triangles(prisms, FRAMES.yUpIn);
  let obj = '# dsim robot-import fixture: inches, +Y up, front +Z\nmtllib robot.mtl\n';
  let mtl = '# dsim robot-import fixture\n';
  let base = 1;
  parts.forEach(({ p, tris }, i) => {
    mtl += `newmtl m${i}\nKd ${p.color.map((c) => c.toFixed(4)).join(' ')}\n`;
    obj += `o ${p.name}\nusemtl m${i}\n`;
    for (const t of tris) for (const v of t) obj += `v ${v.map((c) => c.toFixed(5)).join(' ')}\n`;
    for (let k = 0; k < tris.length; k++) obj += `f ${base + 3 * k} ${base + 3 * k + 1} ${base + 3 * k + 2}\n`;
    base += tris.length * 3;
  });
  return { obj, mtl };
}

export function writePly(prisms: Prism[]): Uint8Array {
  const parts = triangles(prisms, FRAMES.cadCm);
  const nV = parts.reduce((s, x) => s + x.tris.length * 3, 0);
  const nF = nV / 3;
  const header = strToU8(
    `ply\nformat binary_little_endian 1.0\ncomment dsim robot-import fixture: centimetres, +Z up\nelement vertex ${nV}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face ${nF}\nproperty list uchar int vertex_indices\nend_header\n`,
  );
  const body = new ArrayBuffer(nV * 15 + nF * 13);
  const dv = new DataView(body);
  let o = 0;
  for (const { p, tris } of parts) {
    for (const t of tris) {
      for (const v of t) {
        dv.setFloat32(o, v[0], true);
        dv.setFloat32(o + 4, v[1], true);
        dv.setFloat32(o + 8, v[2], true);
        dv.setUint8(o + 12, Math.round(p.color[0] * 255));
        dv.setUint8(o + 13, Math.round(p.color[1] * 255));
        dv.setUint8(o + 14, Math.round(p.color[2] * 255));
        o += 15;
      }
    }
  }
  for (let f = 0; f < nF; f++) {
    dv.setUint8(o, 3);
    dv.setInt32(o + 1, 3 * f, true);
    dv.setInt32(o + 5, 3 * f + 1, true);
    dv.setInt32(o + 9, 3 * f + 2, true);
    o += 13;
  }
  const out = new Uint8Array(header.length + body.byteLength);
  out.set(header, 0);
  out.set(new Uint8Array(body), header.length);
  return out;
}

export function write3mf(prisms: Prism[]): Uint8Array {
  const parts = triangles(prisms, FRAMES.cadMm);
  const bases = parts.map(({ p }, i) => `<base name="c${i}" displaycolor="#${p.color.map(hex2).join('').toUpperCase()}" />`).join('');
  let objects = '';
  let items = '';
  parts.forEach(({ tris }, i) => {
    const id = i + 2;
    let verts = '';
    let faces = '';
    tris.forEach((t, k) => {
      for (const v of t) verts += `<vertex x="${v[0].toFixed(4)}" y="${v[1].toFixed(4)}" z="${v[2].toFixed(4)}" />`;
      faces += `<triangle v1="${3 * k}" v2="${3 * k + 1}" v3="${3 * k + 2}" />`;
    });
    objects += `<object id="${id}" type="model" pid="1" pindex="${i}"><mesh><vertices>${verts}</vertices><triangles>${faces}</triangles></mesh></object>`;
    items += `<item objectid="${id}" />`;
  });
  const model = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><basematerials id="1">${bases}</basematerials>${objects}</resources><build>${items}</build></model>`;
  const types = '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" /><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" /></Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" /></Relationships>';
  return zipSync({ '[Content_Types].xml': strToU8(types), '_rels/.rels': strToU8(rels), '3D/3dmodel.model': strToU8(model) });
}

/**
 * An AP214 STEP file: one MANIFOLD_SOLID_BREP per prism (planar faces, straight edges, exact),
 * each with a STYLED_ITEM colour, in millimetres, CAD Z-up.
 */
export function writeStep(prisms: Prism[]): string {
  const lines: string[] = [];
  let id = 0;
  const e = (s: string): number => {
    lines.push(`#${++id}=${s};`);
    return id;
  };
  const f = (v: number): string => {
    const r = Math.round(v * 1e4) / 1e4;
    const s = String(r);
    return s.includes('.') || s.includes('e') ? s : `${s}.`;
  };
  const pt = (v: V3): number => e(`CARTESIAN_POINT('',(${f(v[0])},${f(v[1])},${f(v[2])}))`);
  const dir = (v: V3): number => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return e(`DIRECTION('',(${f(v[0] / l)},${f(v[1] / l)},${f(v[2] / l)}))`);
  };
  const appCtx = e("APPLICATION_CONTEXT('automotive design')");
  e(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${appCtx})`);
  const prodCtx = e(`PRODUCT_CONTEXT('',#${appCtx},'mechanical')`);
  const prod = e(`PRODUCT('robot','robot','',(#${prodCtx}))`);
  const pdf = e(`PRODUCT_DEFINITION_FORMATION('','',#${prod})`);
  const pdc = e(`PRODUCT_DEFINITION_CONTEXT('part definition',#${appCtx},'design')`);
  const pd = e(`PRODUCT_DEFINITION('design','',#${pdf},#${pdc})`);
  const pds = e(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`);
  const lenU = e('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))');
  const angU = e('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))');
  const solU = e('(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())');
  const unc = e(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#${lenU},'distance_accuracy_value','confusion accuracy')`);
  const ctx = e(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${unc}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lenU},#${angU},#${solU}))REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY'))`);
  const origin = e(`AXIS2_PLACEMENT_3D('',#${pt([0, 0, 0])},#${dir([0, 0, 1])},#${dir([1, 0, 0])})`);
  const solids: number[] = [];
  const styled: number[] = [];
  for (const p of prisms) {
    const n = p.base.length;
    const B = p.base.map(FRAMES.cadMm);
    const T = p.base.map((v) => FRAMES.cadMm([v[0] + p.extrude[0], v[1] + p.extrude[1], v[2] + p.extrude[2]]));
    const all = [...B, ...T];
    const vp = all.map((v) => e(`VERTEX_POINT('',#${pt(v)})`));
    const cpOf = (k: number): number => {
      // the CARTESIAN_POINT a VERTEX_POINT names was written just before it
      return vp[k] - 1;
    };
    const edges = new Map<string, number>();
    const edge = (a: number, b: number): { ec: number; same: boolean } => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let ec = edges.get(key);
      const s = Math.min(a, b);
      const t = Math.max(a, b);
      if (ec === undefined) {
        const d = [all[t][0] - all[s][0], all[t][1] - all[s][1], all[t][2] - all[s][2]] as V3;
        const len = Math.hypot(d[0], d[1], d[2]);
        const vec = e(`VECTOR('',#${dir(d)},${f(len)})`);
        const line = e(`LINE('',#${cpOf(s)},#${vec})`);
        ec = e(`EDGE_CURVE('',#${vp[s]},#${vp[t]},#${line},.T.)`);
        edges.set(key, ec);
      }
      return { ec, same: a === s };
    };
    const face = (loop: number[]): number => {
      const P = loop.map((k) => all[k]);
      // Newell normal of the loop = outward normal (loops are CCW from outside)
      const nrm: V3 = [0, 0, 0];
      for (let i = 0; i < P.length; i++) {
        const a = P[i];
        const b = P[(i + 1) % P.length];
        nrm[0] += (a[1] - b[1]) * (a[2] + b[2]);
        nrm[1] += (a[2] - b[2]) * (a[0] + b[0]);
        nrm[2] += (a[0] - b[0]) * (a[1] + b[1]);
      }
      const ref: V3 = [P[1][0] - P[0][0], P[1][1] - P[0][1], P[1][2] - P[0][2]];
      const oes = loop.map((k, i) => {
        const { ec, same } = edge(k, loop[(i + 1) % loop.length]);
        return e(`ORIENTED_EDGE('',*,*,#${ec},${same ? '.T.' : '.F.'})`);
      });
      const el = e(`EDGE_LOOP('',(${oes.map((o) => `#${o}`).join(',')}))`);
      const fb = e(`FACE_OUTER_BOUND('',#${el},.T.)`);
      const ax = e(`AXIS2_PLACEMENT_3D('',#${cpOf(loop[0])},#${dir(nrm)},#${dir(ref)})`);
      const pl = e(`PLANE('',#${ax})`);
      return e(`ADVANCED_FACE('',(#${fb}),#${pl},.T.)`);
    };
    // the mapping into the CAD frame is a proper rotation × scale, so CCW-from-outside survives
    const faces: number[] = [];
    faces.push(face(Array.from({ length: n }, (_, k) => n + k))); // top
    faces.push(face(Array.from({ length: n }, (_, k) => (n - k) % n))); // bottom, reversed
    for (let k = 0; k < n; k++) faces.push(face([k, (k + 1) % n, n + ((k + 1) % n), n + k]));
    const shell = e(`CLOSED_SHELL('',(${faces.map((x) => `#${x}`).join(',')}))`);
    const solid = e(`MANIFOLD_SOLID_BREP('${p.name}',#${shell})`);
    solids.push(solid);
    const col = e(`COLOUR_RGB('',${f(p.color[0])},${f(p.color[1])},${f(p.color[2])})`);
    const fac = e(`FILL_AREA_STYLE_COLOUR('',#${col})`);
    const fas = e(`FILL_AREA_STYLE('',(#${fac}))`);
    const ssf = e(`SURFACE_STYLE_FILL_AREA(#${fas})`);
    const sss = e(`SURFACE_SIDE_STYLE('',(#${ssf}))`);
    const ssu = e(`SURFACE_STYLE_USAGE(.BOTH.,#${sss})`);
    const psa = e(`PRESENTATION_STYLE_ASSIGNMENT((#${ssu}))`);
    styled.push(e(`STYLED_ITEM('color',(#${psa}),#${solid})`));
  }
  const rep = e(`ADVANCED_BREP_SHAPE_REPRESENTATION('',(#${origin},${solids.map((s) => `#${s}`).join(',')}),#${ctx})`);
  e(`SHAPE_DEFINITION_REPRESENTATION(#${pds},#${rep})`);
  e(`MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(${styled.map((s) => `#${s}`).join(',')}),#${ctx})`);
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('dsim robot-import fixture'),'2;1');",
    "FILE_NAME('robot.step','2026-10-01T00:00:00',(''),(''),'dsim','dsim','');",
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    'ENDSEC;',
    'DATA;',
    ...lines,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

if (process.argv[1] && /fixtures\.ts$/.test(process.argv[1])) {
  mkdirSync(OUT, { recursive: true });
  const robot = synthRobot();
  const files: [string, Uint8Array | string][] = [
    ['robot.glb', writeGlb(robot)],
    ['robot.stl', writeStl(robot)],
    ['robot.ply', writePly(robot)],
    ['robot.3mf', write3mf(robot)],
    ['robot.step', writeStep(robot)],
  ];
  const { obj, mtl } = writeObj(robot);
  files.push(['robot.obj', obj], ['robot.mtl', mtl]);
  for (const [name, data] of files) {
    writeFileSync(join(OUT, name), data);
    console.log(name.padEnd(12), typeof data === 'string' ? data.length : data.byteLength, 'bytes');
  }
}
