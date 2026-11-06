import type { ReactNode } from 'react';
import type { ImportedMech, RobotSpec, Vec2 } from '../../types';
import type { GameId } from '../../games/types';
import { moduleFor } from '../../games';
import { BuiltinMechRows } from '../../ui/builderMechs';
import { rangeFill } from '../../ui/rangeFill';
import { q64 } from '../geometry';
import { AIM, buildHandles, moveHandle, splitKey, wrapDeg, zRange } from './mechMove';
import type { MechCheck, MechHandleDef } from './placement';
import { COPY } from './copy';
import { edgeRange } from './editorModel';
import { NumberField } from './NumberField';
import { TopDownMap } from './TopDownMap';

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
  const { handles, spans } = buildHandles(defs, mech, hull, checks);

  /** a handle moved: write it back into the placement */
  const move = (key: string, p: Vec2): void => {
    const next = moveHandle(mech, defs, hull, key, p);
    if (next) onMech(next);
  };

  /** Home on a handle: that placement (a span: the whole span) back to the game's pre-fill */
  const goHome = (key: string): void => {
    if (key.endsWith(AIM)) {
      onMech({ ...mech, shooterYawDeg: home.shooterYawDeg ?? 0 });
      return;
    }
    const [base] = splitKey(key);
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
  const selBase = selKey ? splitKey(selKey)[0] : selKey;
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
      const { lo: zLo, hi: top } = zRange(selDef, heightIn);
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
