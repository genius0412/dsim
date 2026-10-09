import { useEffect, useMemo, useRef, useState } from 'react';
import type { Alliance, RobotState, StartCat, StartPose, World } from '../../types';
import { DEFAULT_ASSISTS } from '../../sim/spawn';
import { MAX_SAVED_STARTS } from '../../config';
import { samePose, startHandleReach } from '../../ui/startPositions';
import { footprintCorners } from '../../sim/field';
import type { StartEditorProps } from '../module';
import { BB_HALF_X, BB_HALF_Y, BB_START_POSES, BB_VIEW_MARGIN, bbAnchorCat, bbAnchorName, bbRoleLabel } from './config';
import { bbEvalStart, bbSnapStart, bbStartBox } from './start';
import { BIOBUZZ_SIM } from './sim';
import { drawBiobuzzField } from './drawField';
import { drawBiobuzzRobot } from './drawRobot';

/**
 * Drag-and-drop START POSITION editor for BIOBUZZ — the `GameModule.startEditor` slot, and the
 * twin of Chain Reaction's `ChainStartEditor` (same stage, same controls, every `ds-startpos-*`
 * style reused, so nothing new for the contrast or shift audits).
 *
 * WHY IT EXISTS: with the slot empty, Configure fell into Chain Reaction's editor (a CR field and
 * CR's Lab-corner rules) and the 2v2 lobby and strategy screens into DECODE's (a DECODE field,
 * DECODE's G304). BIOBUZZ has its own G304, and this draws the BIOBUZZ field and judges a pose
 * against THAT.
 *
 * ── THE RULE, AND THE REPAIR ────────────────────────────────────────────────
 * `bbEvalStart` (`./start`) is the verdict: fully on the alliance's own side, touching the
 * perimeter wall, clear of every FLOWER, out of the LOADING ZONE. `bbSnapStart` is the repair,
 * the SAME seat the spawn runs (`spawn.ts`), so a placed robot starts exactly where it is drawn.
 * The drawn outline is the footprint's axis-aligned box (`bbStartBox`), because that box is the
 * shape every clause is tested on.
 *
 * ── THE FRAME ───────────────────────────────────────────────────────────────
 * Poses are STORED CANONICAL (the blue frame) and shown in the alliance's ACTUAL frame. This field
 * is POINT-symmetric, so red's version of a pose is a 180° rotation of it (`bbMirror`), not the
 * x-reflection Chain Reaction uses. `mirrorStart` is that rotation in `StartPose` degrees and is
 * self-inverse, so the one function converts both ways.
 *
 * ── ROLES ARE TOP / BOTTOM ──────────────────────────────────────────────────
 * As in Chain Reaction (owner, 2026-09-13): the shared `StartCat` slots carry them (close = TOP,
 * far = BOTTOM, `bbAnchorCat`), each role has two named anchors, and in a 2v2 each robot of an
 * alliance is locked to one role so the two never stack.
 *
 * Snap defaults ON, as in Chain Reaction: the legal set is a thin band along three walls, so a
 * free-dragged robot would sit red almost everywhere.
 */

const SPAN = (Math.max(BB_HALF_X, BB_HALF_Y) + BB_VIEW_MARGIN) * 2;

const norm360 = (d: number): number => ((d % 360) + 360) % 360;

/** canonical (blue) ⇄ actual frame for `a`: identity for blue, a 180° point rotation for red. */
function mirrorStart(p: StartPose, a: Alliance): StartPose {
  return a === 'blue' ? { x: p.x, y: p.y, headingDeg: p.headingDeg } : { x: -p.x, y: -p.y, headingDeg: norm360(p.headingDeg + 180) };
}

const specKey = (s: StartEditorProps['spec']): string =>
  `${s.length}|${s.width}|${s.intake}|${s.drivetrain}|${s.intakeMount}|${s.scoreMode}|${JSON.stringify(s.bbMech ?? null)}`;

export function BiobuzzStartEditor({
  spec,
  alliance,
  value,
  startIndex,
  category,
  saved,
  lockedCategory,
  onChange,
  onPickPreset,
  onCategory,
  onSave,
  onDeleteSaved,
  maxSaved = MAX_SAVED_STARTS,
  size = 300,
}: StartEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drag = useRef<'move' | 'rotate' | null>(null);
  const [snapOn, setSnapOn] = useState(true);
  // an in-progress (possibly ILLEGAL) working pose, ACTUAL frame. Drawn live, committed only when legal.
  const [draft, setDraft] = useState<StartPose | null>(null);

  const cat: StartCat = lockedCategory ?? category;
  // anchors keep their ORIGINAL index so a filtered list still selects the true one
  const anchors = BB_START_POSES.map((p, index) => ({ p, index })).filter(({ index }) => bbAnchorCat(index) === cat);
  const savedList = saved[cat] ?? [];

  // the SAVED pose in the actual frame: a custom value mirrored out of canonical, else the
  // selected anchor seated for THIS build exactly as the spawn seats it
  const anchor = BB_START_POSES[startIndex] ?? BB_START_POSES[0];
  const base: StartPose = value
    ? mirrorStart(value, alliance)
    : bbSnapStart(
        spec,
        mirrorStart({ x: anchor.pos.x, y: anchor.pos.y, headingDeg: (anchor.heading * 180) / Math.PI }, alliance),
        alliance,
      );
  const pose = draft ?? base;

  useEffect(() => {
    setDraft(null);
  }, [alliance, startIndex, value]);

  const legality = bbEvalStart(spec, pose, alliance);
  const canon = mirrorStart(pose, alliance);

  // a world + robot TEMPLATE for the real renderers, rebuilt only when the build or alliance changes
  const world: World = useMemo(
    () => BIOBUZZ_SIM.createWorld('free', 1, [{ id: 0, alliance, spec, assists: DEFAULT_ASSISTS, startIndex: 0 }]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [alliance, specKey(spec)],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, size, size);
    // camera: fit the field, +y up, world inches -> css px
    const s = size / SPAN;
    ctx.translate(size / 2, size / 2);
    ctx.scale(s, -s);

    drawBiobuzzField(ctx, world);

    const tpl = world.robots[0];
    const hRad = (pose.headingDeg * Math.PI) / 180;
    const robot: RobotState = { ...tpl, pos: { x: pose.x, y: pose.y }, heading: hRad, turretHeading: hRad };
    drawBiobuzzRobot(ctx, robot, false, [], { x: 0, y: 1 }, world);

    // THE TESTED SHAPE: the footprint's axis-aligned box, which every G304 clause is judged on
    const col = legality.legal ? '#37d67a' : '#ff4d4d';
    const b = bbStartBox(spec, pose);
    ctx.beginPath();
    ctx.rect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    ctx.fillStyle = legality.legal ? 'rgba(55,214,122,0.16)' : 'rgba(255,77,77,0.22)';
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    // AN IMPORT's box is its hull's, which is not a rectangle and need not be centred on the
    // origin: outline the hull itself inside the tested box, so the box reads as the hull's bound
    if (spec.imported) {
      const hull = footprintCorners(spec, { x: pose.x, y: pose.y }, hRad);
      ctx.beginPath();
      hull.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
      ctx.closePath();
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // heading handle, past the robot's front (an import's is its hull's)
    const front = startHandleReach(spec);
    const hx = pose.x + Math.cos(hRad) * front;
    const hy = pose.y + Math.sin(hRad) * front;
    ctx.strokeStyle = col;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pose.x, pose.y);
    ctx.lineTo(hx, hy);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(hx, hy, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = '#0d1720';
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.4;
    ctx.stroke();

    ctx.restore();
  }, [world, pose.x, pose.y, pose.headingDeg, spec, alliance, legality.legal, size]);

  /** commit an ACTUAL-frame pose back to the parent as canonical */
  const commit = (p: StartPose): void => onChange(mirrorStart(p, alliance));

  /** show the working pose always; SAVE it only when legal */
  const edit = (p: StartPose): void => {
    setDraft(p);
    if (bbEvalStart(spec, p, alliance).legal) commit(p);
  };

  /** the same seat the spawn runs, so what the button produces is exactly where the robot starts */
  const snapTo = (p: StartPose): void => {
    commit(bbSnapStart(spec, p, alliance));
    setDraft(null);
  };

  const pointerWorld = (e: React.PointerEvent): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const s = size / SPAN;
    const px = ((e.clientX - rect.left) / rect.width) * size;
    const py = ((e.clientY - rect.top) / rect.height) * size;
    return { x: (px - size / 2) / s, y: -(py - size / 2) / s };
  };

  const handleWorld = (): { x: number; y: number } => {
    const hRad = (pose.headingDeg * Math.PI) / 180;
    const front = startHandleReach(spec);
    return { x: pose.x + Math.cos(hRad) * front, y: pose.y + Math.sin(hRad) * front };
  };

  const onDown = (e: React.PointerEvent): void => {
    const w = pointerWorld(e);
    if (!w) return;
    const h = handleWorld();
    drag.current = Math.hypot(w.x - h.x, w.y - h.y) < 6 ? 'rotate' : 'move';
    (e.target as Element).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const onMove = (e: React.PointerEvent): void => {
    if (!drag.current) return;
    const w = pointerWorld(e);
    if (!w) return;
    if (drag.current === 'move') {
      const target = { x: w.x, y: w.y, headingDeg: pose.headingDeg };
      // snap LIVE: the legal band is a thin strip along the walls, so the robot glides along it
      if (snapOn) snapTo(target);
      else edit(target);
    } else {
      edit({ x: pose.x, y: pose.y, headingDeg: Math.round(norm360((Math.atan2(w.y - pose.y, w.x - pose.x) * 180) / Math.PI)) });
    }
  };
  const endDrag = (e: React.PointerEvent): void => {
    if (!drag.current) return;
    drag.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    const cur = draft ?? base;
    if (bbEvalStart(spec, cur, alliance).legal) setDraft(null);
    else if (snapOn) snapTo(cur);
  };

  const setField = (k: 'x' | 'y' | 'headingDeg', v: number): void => {
    if (!Number.isFinite(v)) return;
    edit({ ...pose, [k]: v });
  };

  return (
    <div className="ds-startpos">
      <div className="ds-startpos-stage">
        <canvas
          ref={canvasRef}
          className="ds-startpos-canvas"
          style={{ width: size, cursor: drag.current === 'move' ? 'grabbing' : 'grab' }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          role="group"
          aria-label="Start position field editor"
        />
      </div>

      <div className="ds-startpos-side">
        <div className={`ds-startpos-status ${legality.legal ? 'ok' : 'bad'}`}>
          {legality.legal ? 'Legal setup ✓' : `Not legal: ${legality.reason}. Won’t save.`}
        </div>

        <div className="ds-startpos-inputs">
          <label>
            <span>X <small>(right +)</small></span>
            <input type="number" value={Math.round(pose.x * 10) / 10} step={0.5} onChange={(e) => setField('x', parseFloat(e.target.value))} />
          </label>
          <label>
            <span>Y <small>(far +)</small></span>
            <input type="number" value={Math.round(pose.y * 10) / 10} step={0.5} onChange={(e) => setField('y', parseFloat(e.target.value))} />
          </label>
          <label>
            <span>Heading°</span>
            <input type="number" value={Math.round(pose.headingDeg)} step={5} onChange={(e) => setField('headingDeg', norm360(parseFloat(e.target.value)))} />
          </label>
        </div>

        <div className="ds-startpos-tools">
          <label className="ds-startpos-toggle" title="When on, the robot follows your cursor along the legal band as you drag. Off = free placement (illegal poses aren't saved).">
            <input type="checkbox" checked={snapOn} onChange={(e) => setSnapOn(e.target.checked)} />
            <span>Snap to legal</span>
          </label>
          {!legality.legal && (
            <button type="button" className="ds-btn ghost small" onClick={() => snapTo(pose)}>
              Snap now
            </button>
          )}
        </div>

        {lockedCategory ? (
          <div className="ds-startpos-role">{bbRoleLabel(lockedCategory, alliance)} robot</div>
        ) : (
          <div className="ds-segs" role="group" aria-label="Start position">
            {/* TOP first for either alliance — which slot that is flips on this point-symmetric field */}
            {((bbRoleLabel('close', alliance) === 'TOP' ? ['close', 'far'] : ['far', 'close']) as StartCat[]).map((c) => (
              <button
                key={c}
                type="button"
                className={`ds-seg${cat === c ? ' on' : ''}`}
                aria-pressed={cat === c}
                onClick={() => {
                  setDraft(null);
                  onCategory(c);
                }}
              >
                {bbRoleLabel(c, alliance)}
              </button>
            ))}
          </div>
        )}

        <div className="ds-startpos-presets">
          {anchors.map(({ p, index }) => (
            <button
              key={p.name}
              type="button"
              className={`ds-opt mini ${!value && startIndex === index ? 'on' : ''}`}
              onClick={() => {
                setDraft(null);
                onPickPreset(index);
              }}
            >
              <span className="ot">{bbAnchorName(index, alliance)}</span>
            </button>
          ))}
          {savedList.map((sp, i) => {
            const active = !!value && samePose(canon, sp);
            return (
              <button
                key={`saved-${i}`}
                type="button"
                className={`ds-opt mini saved ${active ? 'on' : ''}`}
                onClick={() => {
                  setDraft(null);
                  onChange({ x: sp.x, y: sp.y, headingDeg: sp.headingDeg });
                }}
                title="Your saved position"
              >
                <span className="ot">★ {i + 1}</span>
                <span
                  className="ds-startpos-del"
                  role="button"
                  aria-label="Delete saved position"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteSaved(cat, i);
                  }}
                >
                  ×
                </span>
              </button>
            );
          })}
          {savedList.length < maxSaved && (
            <button
              type="button"
              className="ds-opt mini add"
              disabled={!legality.legal}
              title={legality.legal ? 'Save this position' : 'Make the position legal first'}
              onClick={() => onSave(canon)}
            >
              <span className="ot">＋ Save</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
