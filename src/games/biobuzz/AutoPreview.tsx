import { useEffect, useMemo, useRef } from 'react';
import type { RobotState, World } from '../../types';
import { DEFAULT_ASSISTS } from '../../sim/spawn';
import type { AutoPreviewProps } from '../module';
import { BB_HALF_X, BB_HALF_Y, BB_VIEW_MARGIN } from './config';
import { BIOBUZZ_SIM } from './sim';
import { drawBiobuzzField } from './drawField';
import { drawBiobuzzRobot } from './drawRobot';

/**
 * A ZENITH AUTO ON THE BIOBUZZ FIELD — the `GameModule.autoPreview` slot. Drawn with the same
 * field and robot renderers and the same fit-the-field camera as `BiobuzzStartEditor`, so the
 * preview, the start editor and the match agree on where everything is. Read-only: the routine
 * is edited in Zenith.
 *
 * The robot is drawn solid where the auto starts, and as an outline at the end of every path
 * step, so the footprint's travel reads at a glance. The planned path is one colour and the
 * DRIVEN path, when a run has been recorded, another, dashed. Colours are category 3
 * (`CLAUDE.md` theming): the field is dark in both themes, so they do not theme.
 */

const SPAN = (Math.max(BB_HALF_X, BB_HALF_Y) + BB_VIEW_MARGIN) * 2;
/** the plan: the warm accent the start editor's handle uses */
const PLAN = '#ffd166';
const PLAN_DIM = 'rgba(255,209,102,0.45)';
/** the driven path */
const DRIVEN = '#6ec1ff';

const specKey = (s: AutoPreviewProps['spec']): string =>
  `${s.length}|${s.width}|${s.intake}|${s.drivetrain}|${s.intakeMount}|${s.scoreMode}|${JSON.stringify(s.bbMech ?? null)}`;

export function BiobuzzAutoPreview({ spec, alliance, legs, poses, driven, focus, size = 300 }: AutoPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
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
    const s = size / SPAN;
    ctx.translate(size / 2, size / 2);
    ctx.scale(s, -s);
    drawBiobuzzField(ctx, world);

    const tpl = world.robots[0];
    // the footprint at each leg end, as an outline
    ctx.lineWidth = 1.2 / s;
    for (const p of poses.slice(1)) {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.heading);
      ctx.strokeStyle = PLAN_DIM;
      ctx.strokeRect(-spec.length / 2, -spec.width / 2, spec.length, spec.width);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(spec.length / 2, 0);
      ctx.stroke();
      ctx.restore();
    }
    // the planned path
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const leg of legs) {
      if (leg.points.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(leg.points[0].x, leg.points[0].y);
      for (const q of leg.points.slice(1)) ctx.lineTo(q.x, q.y);
      ctx.strokeStyle = PLAN;
      ctx.lineWidth = (focus && leg.id === focus ? 3.2 : 2) / s;
      ctx.stroke();
    }
    // the driven path
    if (driven && driven.length > 1) {
      ctx.beginPath();
      ctx.moveTo(driven[0].x, driven[0].y);
      for (const q of driven.slice(1)) ctx.lineTo(q.x, q.y);
      ctx.setLineDash([4 / s, 3 / s]);
      ctx.strokeStyle = DRIVEN;
      ctx.lineWidth = 1.6 / s;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // the robot where the auto starts
    const start = poses[0];
    if (start) {
      const robot: RobotState = { ...tpl, pos: { x: start.x, y: start.y }, heading: start.heading, turretHeading: start.heading };
      drawBiobuzzRobot(ctx, robot, false, [], { x: 0, y: 1 }, world);
    }
    ctx.restore();
  }, [world, legs, poses, driven, focus, spec, size]);

  return (
    <canvas
      ref={canvasRef}
      className="ds-autoprev-canvas"
      width={size}
      height={size}
      role="img"
      aria-label="The autonomous routine on the field: the planned path, and where the robot starts and ends each leg"
    />
  );
}
