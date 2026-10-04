import type { ReactNode } from 'react';
import type { ImportedEdge, ImportedMech, RobotSpec, Vec2 } from '../../types';
import type { GameId } from '../../games/types';
import { moduleFor } from '../../games';
import { BuiltinMechRows } from '../../ui/builderMechs';
import { rangeFill } from '../../ui/rangeFill';
import { q64 } from '../geometry';
import type { MechCheck, MechHandleDef } from './placement';
import { COPY } from './copy';
import { edgeRange } from './editorModel';
import { NumberField } from './NumberField';
import { TopDownMap, type MapHandle, type MapSpan } from './TopDownMap';

/** the pieces of one intake span the map can drag */
type SpanPart = 'from' | 'to' | 'mid';

/** how far out from its point a launcher's FACING handle sits (in) — far enough to grab apart */
const AIM_REACH = 4;
/** a key's FACING handle: `shooter:aim` */
const AIM = ':aim';

/** whole degrees wrapped to (−180, 180], the coercer's own spelling (`src/sim/imported.ts`) */
function wrapDeg(d: number): number {
  const a = ((Math.round(d) % 360) + 360) % 360;
  return a > 180 ? a - 360 : a;
}

function spanEnds(edge: ImportedEdge, from: number, to: number, hull: readonly Vec2[]): { a: Vec2; b: Vec2; mid: Vec2; axis: 'x' | 'y' } {
  const r = edgeRange(edge, hull);
  if (edge === 'front' || edge === 'back') {
    return { a: { x: r.at, y: from }, b: { x: r.at, y: to }, mid: { x: r.at, y: (from + to) / 2 }, axis: 'y' };
  }
  return { a: { x: from, y: r.at }, b: { x: to, y: r.at }, mid: { x: (from + to) / 2, y: r.at }, axis: 'x' };
}

export function MechanismsStep({
  game,
  spec,
  onSpec,
  hull,
  heightIn,
  mech,
  home,
  defs,
  checks,
  selected,
  onSelect,
  onMech,
  onReset,
  cadNote,
  tuning,
}: {
  game: GameId;
  /** the built spec (coerced), which the game's mechanism controls read */
  spec: RobotSpec;
  onSpec: (patch: Partial<RobotSpec>) => void;
  /** MODEL frame */
  hull: readonly Vec2[];
  heightIn: number;
  /** MODEL frame */
  mech: ImportedMech;
  /** the game's own placements for this build (MODEL frame): where Home puts a handle back */
  home: ImportedMech;
  defs: readonly MechHandleDef[];
  checks: readonly MechCheck[];
  selected: string | null;
  onSelect: (key: string) => void;
  onMech: (next: ImportedMech) => void;
  onReset: () => void;
  /** what a new import's mechanisms were set to from its model (`EditorDoc.cadBuild`), in words */
  cadNote?: string;
  /** the mechanisms' practice tuning (`TunePanel`), after the placements */
  tuning?: ReactNode;
}) {
  const mod = moduleFor(game);
  const Builder = mod.Builder;
  const handles: MapHandle[] = [];
  const spans: MapSpan[] = [];
  const bad = new Set(checks.map((c) => c.key).filter(Boolean));
  for (const d of defs) {
    if (d.field === 'intake' && d.edge) {
      const s = mech.intakes?.find((i) => i.edge === d.edge);
      if (!s) continue;
      const e = spanEnds(d.edge, s.from, s.to, hull);
      spans.push({ key: d.key, a: e.a, b: e.b, bad: bad.has(d.key) });
      handles.push({ key: `${d.key}:from`, label: `${d.label}, end`, ...e.a, shape: 'end', axis: e.axis, bad: bad.has(d.key) });
      handles.push({ key: `${d.key}:to`, label: `${d.label}, other end`, ...e.b, shape: 'end', axis: e.axis, bad: bad.has(d.key) });
      handles.push({ key: `${d.key}:mid`, label: d.label, ...e.mid, shape: 'mid', axis: e.axis, bad: bad.has(d.key) });
    } else if (d.field !== 'intake') {
      const p = mech[d.field];
      if (p) handles.push({ key: d.key, label: d.label, x: p.x, y: p.y, z: p.z, shape: 'point', bad: bad.has(d.key) });
      // a FIXED launcher's facing: a second handle out along it, and the ray between the two
      if (p && d.field === 'shooter' && d.facingDeg !== undefined) {
        const a = ((mech.shooterYawDeg ?? d.facingDeg) * Math.PI) / 180;
        const tip = { x: p.x + Math.cos(a) * AIM_REACH, y: p.y + Math.sin(a) * AIM_REACH };
        spans.push({ key: `${d.key}${AIM}`, a: { x: p.x, y: p.y }, b: tip });
        handles.push({ key: `${d.key}${AIM}`, label: COPY.facingHandle(d.label), ...tip, shape: 'aim' });
      }
    }
  }

  /** a handle moved: write it back into the placement */
  const move = (key: string, p: Vec2): void => {
    if (key.endsWith(AIM)) {
      // the FACING handle: the direction from the launcher's point to where it was dragged
      const at = mech.shooter;
      if (!at || Math.hypot(p.x - at.x, p.y - at.y) < 0.5) return;
      onMech({ ...mech, shooterYawDeg: wrapDeg((Math.atan2(p.y - at.y, p.x - at.x) * 180) / Math.PI) });
      return;
    }
    const [base, part] = key.split(':').length === 3 ? [key.slice(0, key.lastIndexOf(':')), key.slice(key.lastIndexOf(':') + 1) as SpanPart] : [key, null];
    const def = defs.find((d) => d.key === base);
    if (!def) return;
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
      onMech({ ...mech, intakes });
      return;
    }
    const field = def.field;
    if (field === 'intake') return;
    const old = mech[field];
    if (!old) return;
    onMech({ ...mech, [field]: { x: q64(p.x), y: q64(p.y), z: old.z } });
  };

  /** Home on a handle: that placement (a span: the whole span) back to the game's pre-fill */
  const goHome = (key: string): void => {
    if (key.endsWith(AIM)) {
      onMech({ ...mech, shooterYawDeg: home.shooterYawDeg ?? 0 });
      return;
    }
    const base = key.split(':').length === 3 ? key.slice(0, key.lastIndexOf(':')) : key;
    const def = defs.find((d) => d.key === base);
    if (!def) return;
    if (def.field === 'intake') {
      const h = home.intakes?.find((i) => i.edge === def.edge);
      if (h) onMech({ ...mech, intakes: (mech.intakes ?? []).map((i) => (i.edge === def.edge ? { ...h } : i)) });
      return;
    }
    const h = home[def.field];
    if (h) onMech({ ...mech, [def.field]: { ...h } });
  };

  // the selected handle's own controls (a FACING handle's are its launcher's)
  const selKey = selected?.endsWith(AIM) ? selected.slice(0, -AIM.length) : selected;
  const selBase = selKey && selKey.split(':').length === 3 ? selKey.slice(0, selKey.lastIndexOf(':')) : selKey;
  const selDef = defs.find((d) => d.key === selBase) ?? null;
  const selCheck = checks.find((c) => c.key === selBase);
  let status = defs.length ? '' : COPY.noHandles;
  let controls: JSX.Element | null = null;
  if (selDef?.field === 'intake' && selDef.edge) {
    const s = mech.intakes?.find((i) => i.edge === selDef.edge);
    if (s) {
      const r = edgeRange(selDef.edge, hull);
      const w = s.to - s.from;
      const c = (s.from + s.to) / 2;
      status = selCheck?.text ?? COPY.span(selDef.label, w, c);
      const setSpan = (from: number, to: number): void =>
        onMech({ ...mech, intakes: (mech.intakes ?? []).map((i) => (i.edge === selDef.edge ? { ...i, from: q64(from), to: q64(to) } : i)) });
      controls = (
        <div className="ds-fields">
          <NumberField
            label={COPY.width}
            unit="in"
            value={w}
            min={0.5}
            max={r.hi - r.lo}
            step={0.25}
            onCommit={(nw) => {
              const cc = Math.max(r.lo + nw / 2, Math.min(r.hi - nw / 2, c));
              setSpan(cc - nw / 2, cc + nw / 2);
            }}
          />
          <NumberField
            label={COPY.centre}
            unit="in"
            value={c}
            min={r.lo + w / 2}
            max={r.hi - w / 2}
            step={0.25}
            onCommit={(nc) => setSpan(nc - w / 2, nc + w / 2)}
          />
        </div>
      );
    }
  } else if (selDef && selDef.field !== 'intake') {
    const field = selDef.field;
    const p = mech[field];
    if (p) {
      status = selCheck?.text ?? COPY.placed(selDef.label, p.x, p.y, p.z);
      const set = (patch: Partial<{ x: number; y: number; z: number }>): void => onMech({ ...mech, [field]: { ...p, ...patch } });
      // the release heights the game accepts (lane 2), else the floor to the top of the robot
      const zLo = Math.max(0, selDef.zMin ?? 0);
      const top = Math.max(zLo + 0.25, Math.round(Math.min(heightIn, selDef.zMax ?? heightIn) * 4) / 4);
      const facing = field === 'shooter' && selDef.facingDeg !== undefined ? (mech.shooterYawDeg ?? selDef.facingDeg) : null;
      if (facing !== null && selected?.endsWith(AIM)) status = COPY.facingPlaced(selDef.label, facing);
      controls = (
        <div className="ds-fields">
          <NumberField label={COPY.forward} unit="in" value={p.x} min={-12} max={12} step={0.25} onCommit={(x) => set({ x })} />
          <NumberField label={COPY.left} unit="in" value={p.y} min={-12} max={12} step={0.25} onCommit={(y) => set({ y })} />
          {facing !== null && (
            <NumberField
              label={COPY.facing}
              unit="°"
              value={facing}
              min={-180}
              max={180}
              step={15}
              onCommit={(deg) => onMech({ ...mech, shooterYawDeg: wrapDeg(deg) })}
            />
          )}
          <label className="ds-field">
            <span className="cap">
              {COPY.height} <span className="val">{p.z.toFixed(2)} in</span>
            </span>
            <input
              className="ds-range"
              type="range"
              min={zLo}
              max={top}
              step={0.25}
              value={Math.max(zLo, Math.min(top, p.z))}
              aria-valuetext={`${p.z.toFixed(2)} inches`}
              style={rangeFill(Math.max(zLo, Math.min(top, p.z)), zLo, top)}
              onChange={(e) => set({ z: Number(e.target.value) })}
            />
          </label>
        </div>
      );
    }
  }

  return (
    <>
      {cadNote ? <p className="ds-hint">{cadNote}</p> : null}
      {Builder ? (
        <Builder spec={spec} onChange={onSpec} game={game} hideFrame />
      ) : (
        <BuiltinMechRows spec={spec} setSpec={onSpec} game={game} hideFrame />
      )}
      <h3 className="ds-subh" id="ri-placement" tabIndex={-1}>
        {COPY.placement}
      </h3>
      <TopDownMap
        hull={hull}
        handles={handles}
        spans={spans}
        selected={selected}
        ariaLabel={COPY.mechAria}
        status={status}
        onSelect={onSelect}
        onMove={(k, p) => move(k, p)}
        onHome={goHome}
      />
      {controls}
      <div>
        <button type="button" className="ds-btn ghost small" onClick={onReset}>
          {COPY.resetPlacement}
        </button>
      </div>
      {tuning}
    </>
  );
}
