/**
 * Mesh operations the importer needs and three.js does not provide in an indexed form: welding,
 * compaction, creased normals that stay INDEXED, and merging parts by colour. Plain typed arrays,
 * no three — kept in the engine zone because only the engine needs them.
 */
import type { MeshPart } from '../geometry';

/**
 * Weld vertices closer than `eps` (same units as the positions): CAD exports split every vertex
 * per face, and the simplifier needs shared vertices to see topology. Open-addressed hash on the
 * quantised position; exact compare on collision. Degenerate triangles are dropped.
 *
 * ⚠️ TWO BODIES ARE NEVER WELDED TOGETHER (`MeshPart.body`): a roller touching its axle at one
 * corner would otherwise share a vertex with it, and a triangle's body would depend on which corner
 * it is read from. A part without bodies welds exactly as before.
 */
export function weld(part: MeshPart, eps: number): { positions: Float32Array; indices: Uint32Array; body: Uint32Array | null } {
  const src = part.positions;
  const bodyIn = part.body ?? null;
  const nVert = src.length / 3;
  const inv = 1 / eps;
  let cap = 1;
  while (cap < nVert * 2) cap <<= 1;
  const table = new Int32Array(cap).fill(-1);
  const remap = new Uint32Array(nVert);
  const out = new Float32Array(src.length);
  const bodyOut = bodyIn ? new Uint32Array(nVert) : null;
  let count = 0;
  for (let i = 0; i < nVert; i++) {
    const x = Math.round(src[3 * i] * inv);
    const y = Math.round(src[3 * i + 1] * inv);
    const z = Math.round(src[3 * i + 2] * inv);
    const bd = bodyIn ? bodyIn[i] : 0;
    let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791) ^ (bodyIn ? Math.imul(bd, 40503) : 0)) & (cap - 1);
    for (;;) {
      const slot = table[h];
      if (slot < 0) {
        table[h] = count;
        out[3 * count] = src[3 * i];
        out[3 * count + 1] = src[3 * i + 1];
        out[3 * count + 2] = src[3 * i + 2];
        if (bodyOut) bodyOut[count] = bd;
        remap[i] = count++;
        break;
      }
      // the slot's quantised position is recomputed from the vertex it holds (the same float32, so
      // the same integers; `| 0` is the Int32Array store the old arrays did) instead of being kept
      // in three more arrays: 12 bytes a vertex, 140 MB on an un-indexed 4M-triangle STL
      if (
        (Math.round(out[3 * slot] * inv) | 0) === x &&
        (Math.round(out[3 * slot + 1] * inv) | 0) === y &&
        (Math.round(out[3 * slot + 2] * inv) | 0) === z &&
        (!bodyOut || bodyOut[slot] === bd)
      ) {
        remap[i] = slot;
        break;
      }
      h = (h + 1) & (cap - 1);
    }
  }
  const idxIn = part.indices;
  const nIdx = idxIn ? idxIn.length : nVert;
  const tris = new Uint32Array(nIdx - (nIdx % 3));
  let t = 0;
  for (let k = 0; k + 2 < nIdx; k += 3) {
    const a = remap[idxIn ? idxIn[k] : k];
    const b = remap[idxIn ? idxIn[k + 1] : k + 1];
    const c = remap[idxIn ? idxIn[k + 2] : k + 2];
    if (a === b || b === c || a === c) continue;
    tris[t++] = a;
    tris[t++] = b;
    tris[t++] = c;
  }
  return { positions: out.slice(0, count * 3), indices: tris.slice(0, t), body: bodyOut ? bodyOut.slice(0, count) : null };
}

/** drop vertices no triangle uses, renumbering the indices (and carrying each vertex's body) */
export function compact(
  positions: Float32Array,
  indices: Uint32Array,
  body: Uint32Array | null = null,
): { positions: Float32Array; indices: Uint32Array; body: Uint32Array | null } {
  const n = positions.length / 3;
  const map = new Int32Array(n).fill(-1);
  const out = new Float32Array(positions.length);
  const bodyOut = body ? new Uint32Array(n) : null;
  const idx = new Uint32Array(indices.length);
  let count = 0;
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    let m = map[v];
    if (m < 0) {
      m = map[v] = count;
      out[3 * count] = positions[3 * v];
      out[3 * count + 1] = positions[3 * v + 1];
      out[3 * count + 2] = positions[3 * v + 2];
      if (bodyOut) bodyOut[count] = body![v];
      count++;
    }
    idx[i] = m;
  }
  return { positions: out.slice(0, count * 3), indices: idx, body: bodyOut ? bodyOut.slice(0, count) : null };
}

/**
 * BODIES FOR A MODEL THAT HAS NONE: one per CONNECTED PIECE of a welded mesh (an STL, a PLY, a glTF
 * exported as one mesh). A CAD export keeps its solids apart, so a roller, its axle and each wheel
 * come out as pieces of their own. Ids start at `first`; returns the per-vertex ids and how many.
 */
export function componentBodies(nVert: number, indices: Uint32Array, first = 0): { body: Uint32Array; count: number } {
  const parent = new Int32Array(nVert);
  for (let i = 0; i < nVert; i++) parent[i] = i;
  const find = (v: number): number => {
    while (parent[v] !== v) {
      parent[v] = parent[parent[v]];
      v = parent[v];
    }
    return v;
  };
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = find(indices[t]);
    const b = find(indices[t + 1]);
    if (a !== b) parent[b] = a;
    const r = find(a);
    const c = find(indices[t + 2]);
    if (r !== c) parent[c] = r;
  }
  const id = new Int32Array(nVert).fill(-1);
  const body = new Uint32Array(nVert);
  let count = 0;
  for (let v = 0; v < nVert; v++) {
    const r = find(v);
    if (id[r] < 0) id[r] = count++;
    body[v] = first + id[r];
  }
  return { body, count };
}

/**
 * A BODY THAT IS SEVERAL LUMPS GETS AN ID PER LUMP (2026-10-03, owner: "the auto-detector combines a
 * static channel and a gear into one component that cannot be separated"). A reader's body is a mesh
 * instance or a STEP solid, and an exporter can put a channel and the gear beside it in ONE (a merged
 * sub-assembly, a multi-lump solid): picking works on bodies, so the two could only move together.
 * A lump is a connected piece of the welded mesh; a body whose faces are in two colours lives in two
 * parts, so lumps are joined ACROSS parts where the same body has a vertex within `eps` (a two-colour
 * wheel stays one). The lump holding a body's first vertex keeps its id and the rest take new ids
 * after the largest, in the order they first appear, so a body that is one lump keeps its id and a
 * mesh split once splits the same way again (a saved robot's moving parts still name the same parts).
 * Measured on REV's starter bot: 7 of 2,150 solids are more than one lump. Rewrites `body` in place;
 * returns how many lumps were given new ids.
 */
export function splitLumps(parts: readonly { positions: Float32Array; indices: Uint32Array; body: Uint32Array | null }[], eps: number): number {
  const offs: number[] = [];
  let total = 0;
  let maxId = -1;
  for (const p of parts) {
    offs.push(total);
    total += p.positions.length / 3;
    if (p.body) for (let i = 0; i < p.body.length; i++) if (p.body[i] > maxId) maxId = p.body[i];
  }
  if (maxId < 0) return 0;
  const parent = new Int32Array(total);
  for (let i = 0; i < total; i++) parent[i] = i;
  const find = (v: number): number => {
    while (parent[v] !== v) {
      parent[v] = parent[parent[v]];
      v = parent[v];
    }
    return v;
  };
  const join = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  // within a part: the triangles
  parts.forEach((p, pi) => {
    const o = offs[pi];
    const ix = p.indices;
    for (let t = 0; t + 2 < ix.length; t += 3) {
      join(o + ix[t], o + ix[t + 1]);
      join(o + ix[t], o + ix[t + 2]);
    }
  });
  // across parts: the same body at the same place (only bodies that are in more than one part)
  const partsOf = new Map<number, number>();
  const many = new Set<number>();
  parts.forEach((p, pi) => {
    if (!p.body) return;
    const seen = new Set<number>();
    for (let i = 0; i < p.body.length; i++) seen.add(p.body[i]);
    for (const b of seen) {
      const was = partsOf.get(b);
      if (was === undefined) partsOf.set(b, pi);
      else if (was !== pi) many.add(b);
    }
  });
  if (many.size) {
    const inv = 1 / eps;
    const cells = new Map<string, number>();
    parts.forEach((p, pi) => {
      if (!p.body) return;
      const a = p.positions;
      for (let v = 0; v < p.body.length; v++) {
        const b = p.body[v];
        if (!many.has(b)) continue;
        const key = `${b},${Math.round(a[3 * v] * inv)},${Math.round(a[3 * v + 1] * inv)},${Math.round(a[3 * v + 2] * inv)}`;
        const g = offs[pi] + v;
        const at = cells.get(key);
        if (at === undefined) cells.set(key, g);
        else join(at, g);
      }
    });
  }
  // each body's lumps, in the order they first appear: the first keeps the id
  const lumpId = new Map<number, number>(); // root vertex → id
  const firstLump = new Map<number, number>(); // body → its first lump's root
  let next = maxId + 1;
  let made = 0;
  parts.forEach((p, pi) => {
    if (!p.body) return;
    const o = offs[pi];
    for (let v = 0; v < p.body.length; v++) {
      const r = find(o + v);
      let id = lumpId.get(r);
      if (id === undefined) {
        const b = p.body[v];
        if (!firstLump.has(b)) {
          firstLump.set(b, r);
          id = b;
        } else {
          id = next++;
          made++;
        }
        lumpId.set(r, id);
      }
      p.body[v] = id;
    }
  });
  return made;
}

/**
 * Creased normals that keep the mesh INDEXED: each triangle corner averages the (area-weighted)
 * normals of the triangles round its vertex that are within `creaseDeg` of its own, and corners
 * with the same vertex and the same resulting normal share one output vertex. A CAD part comes
 * out smooth across fillets and sharp at its edges, and the vertex count grows only along
 * creases — `toCreasedNormals` would de-index the whole mesh and triple it.
 */
export function creasedNormals(
  positions: Float32Array,
  indices: Uint32Array,
  creaseDeg = 40,
  body: Uint32Array | null = null,
): { positions: Float32Array; normals: Float32Array; indices: Uint32Array; body: Uint32Array | null } {
  const nV = positions.length / 3;
  const nT = indices.length / 3;
  const fn = new Float32Array(nT * 3); // area-weighted face normal (unnormalised)
  const fu = new Float32Array(nT * 3); // unit face normal
  for (let t = 0; t < nT; t++) {
    const a = indices[3 * t] * 3;
    const b = indices[3 * t + 1] * 3;
    const c = indices[3 * t + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    fn[3 * t] = nx;
    fn[3 * t + 1] = ny;
    fn[3 * t + 2] = nz;
    const l = Math.hypot(nx, ny, nz) || 1;
    fu[3 * t] = nx / l;
    fu[3 * t + 1] = ny / l;
    fu[3 * t + 2] = nz / l;
  }
  // vertex → incident triangles (CSR)
  const start = new Uint32Array(nV + 1);
  for (let i = 0; i < indices.length; i++) start[indices[i] + 1]++;
  for (let v = 0; v < nV; v++) start[v + 1] += start[v];
  const fill = start.slice(0, nV);
  const inc = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) inc[fill[indices[i]]++] = Math.floor(i / 3);
  const cosC = Math.cos((creaseDeg * Math.PI) / 180);
  // the output in typed arrays grown by doubling (a vertex per corner at most), and each vertex's
  // output vertices so far in one scratch, not JS number arrays and an object per output vertex: half
  // the memory on a 5.7M-triangle robot, and 1.47 → 1.28 s. The same arithmetic in the same order,
  // so the same arrays out.
  let cap = Math.max(16, Math.min(indices.length, nV + (nV >> 1)));
  let outPos = new Float32Array(cap * 3);
  let outNrm = new Float32Array(cap * 3);
  let outBody = body ? new Uint32Array(cap) : null;
  let nOut = 0;
  const outIdx = new Uint32Array(indices.length);
  let maxDeg = 0;
  for (let v = 0; v < nV; v++) maxDeg = Math.max(maxDeg, start[v + 1] - start[v]);
  const madeN = new Float64Array(maxDeg * 3);
  const madeId = new Uint32Array(maxDeg);
  for (let v = 0; v < nV; v++) {
    // the output vertices made for v so far (their normals), to share between its corners
    let made = 0;
    for (let k = start[v]; k < start[v + 1]; k++) {
      const t = inc[k];
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (let j = start[v]; j < start[v + 1]; j++) {
        const o = inc[j];
        const d = fu[3 * t] * fu[3 * o] + fu[3 * t + 1] * fu[3 * o + 1] + fu[3 * t + 2] * fu[3 * o + 2];
        if (d >= cosC) {
          sx += fn[3 * o];
          sy += fn[3 * o + 1];
          sz += fn[3 * o + 2];
        }
      }
      const l = Math.hypot(sx, sy, sz) || 1;
      sx /= l;
      sy /= l;
      sz /= l;
      let id = -1;
      for (let m = 0; m < made; m++) {
        if (madeN[3 * m] * sx + madeN[3 * m + 1] * sy + madeN[3 * m + 2] * sz > 0.9999) {
          id = madeId[m];
          break;
        }
      }
      if (id < 0) {
        if (nOut === cap) {
          cap = Math.min(indices.length, cap * 2);
          const p = new Float32Array(cap * 3);
          p.set(outPos);
          outPos = p;
          const q = new Float32Array(cap * 3);
          q.set(outNrm);
          outNrm = q;
          if (outBody) {
            const b = new Uint32Array(cap);
            b.set(outBody);
            outBody = b;
          }
        }
        id = nOut++;
        outPos[3 * id] = positions[3 * v];
        outPos[3 * id + 1] = positions[3 * v + 1];
        outPos[3 * id + 2] = positions[3 * v + 2];
        outNrm[3 * id] = sx;
        outNrm[3 * id + 1] = sy;
        outNrm[3 * id + 2] = sz;
        if (outBody) outBody[id] = body![v];
        madeN[3 * made] = sx;
        madeN[3 * made + 1] = sy;
        madeN[3 * made + 2] = sz;
        madeId[made++] = id;
      }
      // which corner of t is v
      const c = indices[3 * t] === v ? 0 : indices[3 * t + 1] === v ? 1 : 2;
      outIdx[3 * t + c] = id;
    }
  }
  return { positions: outPos.slice(0, 3 * nOut), normals: outNrm.slice(0, 3 * nOut), indices: outIdx, body: outBody ? outBody.slice(0, nOut) : null };
}

/** the crease angle every importer normal is computed at, degrees */
export const CREASE_DEG = 40;

/** give every indexed part creased normals (new arrays; parts that have them are kept) */
export function creaseParts(parts: readonly MeshPart[]): MeshPart[] {
  return parts.map((p) => {
    if (p.normals || !p.indices) return p;
    const c = creasedNormals(p.positions, p.indices, CREASE_DEG, p.body ?? null);
    return { positions: c.positions, indices: c.indices, normals: c.normals, color: p.color, name: p.name, body: c.body };
  });
}

/** a part's node name in a stored GLB: word characters only, 40 at most, and its index */
export const safePartName = (s: string, i: number): string => `${(s || 'part').replace(/[^\w.-]+/g, '_').slice(0, 40)}_${i}`;

/** colour key at `bits` bits per channel */
const colourKey = (c: readonly number[], bits: number): number => {
  const m = (1 << bits) - 1;
  const q = (v: number): number => Math.max(0, Math.min(m, Math.round(v * m)));
  return (q(c[0]) << (2 * bits)) | (q(c[1]) << bits) | q(c[2]);
};

/**
 * Merge parts that share a colour, so a CAD assembly of 900 bodies in 6 colours becomes 6 draw
 * calls. At most `maxParts` survive; past that the colours are bucketed more coarsely.
 */
export function mergeByColour(parts: readonly MeshPart[], maxParts = 48): MeshPart[] {
  return colourGroups(
    parts.map((p) => p.color),
    maxParts,
  ).map((g) => concatParts(g.map((i) => parts[i])));
}

/**
 * `mergeByColour`'s grouping on the colours alone: indices into `colors`, per group, in first-seen
 * order, at the finest quantisation (6 bits a channel, down to 2) that leaves at most `maxParts`.
 * The glTF reader groups by it BEFORE it reads a vertex, so it can write each part straight into its
 * group (`parse.ts`, `mergedPartsFromObject`).
 */
export function colourGroups(colors: readonly (readonly number[])[], maxParts = 48): number[][] {
  let groups = new Map<number, number[]>();
  for (const bits of [6, 5, 4, 3, 2]) {
    groups = new Map<number, number[]>();
    colors.forEach((c, i) => {
      const k = colourKey(c, bits);
      let g = groups.get(k);
      if (!g) groups.set(k, (g = []));
      g.push(i);
    });
    if (groups.size <= maxParts) break;
  }
  return [...groups.values()];
}

/** one part from many: positions appended, indices offset, colour = area-weighted mean */
export function concatParts(g: readonly MeshPart[]): MeshPart {
  if (g.length === 1) return g[0];
  let nPos = 0;
  let nIdx = 0;
  for (const p of g) {
    nPos += p.positions.length;
    nIdx += p.indices ? p.indices.length : p.positions.length / 3;
  }
  const positions = new Float32Array(nPos);
  const indices = new Uint32Array(nIdx - (nIdx % 3));
  // bodies when any part has them (a part without any is body 0)
  const body = g.some((p) => p.body) ? new Uint32Array(nPos / 3) : null;
  let po = 0;
  let io = 0;
  const col = [0, 0, 0];
  let w = 0;
  for (const p of g) {
    positions.set(p.positions, po);
    if (body && p.body) body.set(p.body, po / 3);
    const base = po / 3;
    if (p.indices) {
      for (let i = 0; i < p.indices.length && io < indices.length; i++) indices[io++] = p.indices[i] + base;
    } else {
      for (let i = 0; i < p.positions.length / 3 && io < indices.length; i++) indices[io++] = base + i;
    }
    const weight = Math.max(1, p.positions.length);
    for (let k = 0; k < 3; k++) col[k] += p.color[k] * weight;
    w += weight;
    po += p.positions.length;
  }
  return { positions, indices, color: [col[0] / w, col[1] / w, col[2] / w], name: g[0].name, body };
}

/**
 * Split one part whose triangles carry their own colours (vertex colours: PLY, 3MF colour groups,
 * coloured STL) into one part per colour, at 5 bits a channel. `colors` is rgb per vertex.
 */
export function splitByVertexColour(part: MeshPart, colors: Float32Array, stride = 3): MeshPart[] {
  const idx = part.indices;
  const nT = Math.floor((idx ? idx.length : part.positions.length / 3) / 3);
  const groups = new Map<number, number[]>();
  const sums = new Map<number, [number, number, number, number]>();
  for (let t = 0; t < nT; t++) {
    const v = [0, 1, 2].map((c) => (idx ? idx[3 * t + c] : 3 * t + c));
    const r = (colors[v[0] * stride] + colors[v[1] * stride] + colors[v[2] * stride]) / 3;
    const g = (colors[v[0] * stride + 1] + colors[v[1] * stride + 1] + colors[v[2] * stride + 1]) / 3;
    const b = (colors[v[0] * stride + 2] + colors[v[1] * stride + 2] + colors[v[2] * stride + 2]) / 3;
    const k = colourKey([r, g, b], 5);
    let list = groups.get(k);
    if (!list) {
      groups.set(k, (list = []));
      sums.set(k, [0, 0, 0, 0]);
    }
    list.push(v[0], v[1], v[2]);
    const s = sums.get(k)!;
    s[0] += r;
    s[1] += g;
    s[2] += b;
    s[3]++;
  }
  if (groups.size <= 1) {
    const s = sums.values().next().value;
    return [{ ...part, color: s ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : part.color }];
  }
  const out: MeshPart[] = [];
  for (const [k, list] of groups) {
    const s = sums.get(k)!;
    out.push({ positions: part.positions, indices: Uint32Array.from(list), color: [s[0] / s[3], s[1] / s[3], s[2] / s[3]], name: part.name, body: part.body ?? null });
  }
  // each split part shares the whole position array; compact so sizes are honest
  return out.map((p) => ({ ...p, ...compact(p.positions, p.indices!, p.body ?? null) }));
}
