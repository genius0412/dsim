/**
 * HOW A DRAGGED PLACEMENT HANDLE BECOMES AN `ImportedMech` — the one writer both editors share: the
 * top-down map (`TopDownMap`, x/y only) and the 3D gizmo in the preview (`engine/preview.ts`, x/y/z).
 * MODEL frame throughout. Pure and DOM-free, so `npm test` can hold it.
 *
 * A handle's key: a point is its field (`shooter`, `shooter2`, `place`); a span has three,
 * `intake:<edge>:from`, `:to` and `:mid`; a fixed launcher's FACING handle is `shooter:aim`.
 */
import type { ImportedEdge, ImportedMech, Vec2 } from '../../types';
import { q64 } from '../geometry';
import { COPY } from './copy';
import { edgeRange } from './editorModel';
import type { MechCheck, MechHandleDef } from './placement';
import type { MapHandle, MapSpan } from './TopDownMap';

/** the pieces of one intake span a handle can drag */
export type SpanPart = 'from' | 'to' | 'mid';

/** how far out from its point a launcher's FACING handle sits (in), far enough to grab apart */
export const AIM_REACH = 4;
/** a key's FACING handle: `shooter:aim` */
export const AIM = ':aim';
/** the height a span's handles are drawn at in 3D: along the bumper line, a little off the floor */
export const SPAN_Z = 0.5;
/** the farthest a placement can be put from the footprint's centre, the number fields' own limit */
export const REACH_IN = 12;

/** whole degrees wrapped to (−180, 180], the coercer's own spelling (`src/sim/imported.ts`) */
export function wrapDeg(d: number): number {
  const a = ((Math.round(d) % 360) + 360) % 360;
  return a > 180 ? a - 360 : a;
}

export function spanEnds(edge: ImportedEdge, from: number, to: number, hull: readonly Vec2[]): { a: Vec2; b: Vec2; mid: Vec2; axis: 'x' | 'y' } {
  const r = edgeRange(edge, hull);
  if (edge === 'front' || edge === 'back') {
    return { a: { x: r.at, y: from }, b: { x: r.at, y: to }, mid: { x: r.at, y: (from + to) / 2 }, axis: 'y' };
  }
  return { a: { x: from, y: r.at }, b: { x: to, y: r.at }, mid: { x: (from + to) / 2, y: r.at }, axis: 'x' };
}

/** `intake:front:mid` → [`intake:front`, 'mid']; a point's or an aim's key has no part */
export function splitKey(key: string): [string, SpanPart | null] {
  return key.split(':').length === 3 ? [key.slice(0, key.lastIndexOf(':')), key.slice(key.lastIndexOf(':') + 1) as SpanPart] : [key, null];
}

/** every draggable thing for the current placements: the same list the map and the 3D view draw */
export function buildHandles(defs: readonly MechHandleDef[], mech: ImportedMech, hull: readonly Vec2[], checks: readonly MechCheck[]): { handles: MapHandle[]; spans: MapSpan[] } {
  const handles: MapHandle[] = [];
  const spans: MapSpan[] = [];
  const bad = new Set(checks.map((c) => c.key).filter(Boolean));
  for (const d of defs) {
    if (d.field === 'intake' && d.edge) {
      const s = mech.intakes?.find((i) => i.edge === d.edge);
      if (!s) continue;
      const e = spanEnds(d.edge, s.from, s.to, hull);
      spans.push({ key: d.key, a: e.a, b: e.b, bad: bad.has(d.key) });
      handles.push({ key: `${d.key}:from`, label: `${d.label}, end`, ...e.a, z: SPAN_Z, shape: 'end', axis: e.axis, bad: bad.has(d.key) });
      handles.push({ key: `${d.key}:to`, label: `${d.label}, other end`, ...e.b, z: SPAN_Z, shape: 'end', axis: e.axis, bad: bad.has(d.key) });
      handles.push({ key: `${d.key}:mid`, label: d.label, ...e.mid, z: SPAN_Z, shape: 'mid', axis: e.axis, bad: bad.has(d.key) });
    } else if (d.field !== 'intake') {
      const p = mech[d.field];
      if (p) handles.push({ key: d.key, label: d.label, x: p.x, y: p.y, z: p.z, shape: 'point', bad: bad.has(d.key) });
      // a FIXED launcher's facing: a second handle out along it, and the ray between the two
      if (p && d.field === 'shooter' && d.facingDeg !== undefined) {
        const a = ((mech.shooterYawDeg ?? d.facingDeg) * Math.PI) / 180;
        const tip = { x: p.x + Math.cos(a) * AIM_REACH, y: p.y + Math.sin(a) * AIM_REACH };
        spans.push({ key: `${d.key}${AIM}`, a: { x: p.x, y: p.y }, b: tip });
        handles.push({ key: `${d.key}${AIM}`, label: COPY.facingHandle(d.label), ...tip, z: p.z, shape: 'aim' });
      }
    }
  }
  return { handles, spans };
}

/**
 * A handle moved to `p`: the placements with it written back, or null when nothing can be written
 * (an unknown key, a facing handle dragged onto its own point). `p.z` is read only by a point;
 * the 2D map has none, and the point keeps its height.
 */
export function moveHandle(
  mech: ImportedMech,
  defs: readonly MechHandleDef[],
  hull: readonly Vec2[],
  key: string,
  p: { x: number; y: number; z?: number },
): ImportedMech | null {
  if (key.endsWith(AIM)) {
    // the FACING handle: the direction from the launcher's point to where it was dragged
    const at = mech.shooter;
    if (!at || Math.hypot(p.x - at.x, p.y - at.y) < 0.5) return null;
    return { ...mech, shooterYawDeg: wrapDeg((Math.atan2(p.y - at.y, p.x - at.x) * 180) / Math.PI) };
  }
  const [base, part] = splitKey(key);
  const def = defs.find((d) => d.key === base);
  if (!def) return null;
  if (def.field === 'intake' && def.edge && part) {
    const r = edgeRange(def.edge, hull);
    const lateral = def.edge === 'front' || def.edge === 'back';
    const v = lateral ? p.y : p.x;
    const intakes = (mech.intakes ?? []).map((s) => {
      if (s.edge !== def.edge) return s;
      if (part === 'mid') {
        const w = s.to - s.from;
        const c = Math.max(r.lo + w / 2, Math.min(r.hi - w / 2, v));
        return { ...s, from: q64(c - w / 2), to: q64(c + w / 2) };
      }
      const minW = 0.5;
      if (part === 'from') return { ...s, from: q64(Math.max(r.lo, Math.min(s.to - minW, v))) };
      return { ...s, to: q64(Math.min(r.hi, Math.max(s.from + minW, v))) };
    });
    return { ...mech, intakes };
  }
  const field = def.field;
  if (field === 'intake') return null;
  const old = mech[field];
  if (!old) return null;
  const lim = (v: number): number => Math.max(-REACH_IN, Math.min(REACH_IN, v));
  const zLo = Math.max(0, def.zMin ?? 0);
  const z = p.z === undefined ? old.z : Math.max(zLo, Math.min(def.zMax ?? Infinity, p.z));
  return { ...mech, [field]: { x: q64(lim(p.x)), y: q64(lim(p.y)), z: p.z === undefined ? z : q64(z) } };
}
