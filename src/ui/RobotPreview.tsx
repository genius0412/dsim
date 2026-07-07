import type { RobotSpec } from '../types';
import { INTAKE_PRESETS, TURRET_OFFSET_FRAC, WHEEL_INSET } from '../config';

/**
 * Top-down schematic of a robot drawn straight from its `RobotSpec` — the live
 * preview in the My Robot builder. Front faces UP (screen −y). Everything is in
 * inches inside the viewBox so the drawing scales with the real chassis/intake
 * dimensions, and colors reference the Direction A ds- tokens so it themes with
 * the app. Purely presentational; reads nothing but the spec + a few geometry
 * constants (matching the sim's own robotExtents / turret placement rules).
 */
export function RobotPreview({ spec, size = 200 }: { spec: RobotSpec; size?: number }) {
  const w = spec.width;
  const len = spec.length;
  const intake = INTAKE_PRESETS[spec.intake];
  const reach = intake.reach;
  const hw = intake.halfWidth;

  const frontY = -len / 2; // chassis front edge (top)
  const tipY = frontY - reach; // intake tip
  // turret sits behind center of rotation, scaled by chassis length
  const turretY = -TURRET_OFFSET_FRAC * len;
  const turretR = Math.min(w, len) * 0.2;

  // viewBox spans the widest of chassis/intake plus a margin, kept square-ish
  const halfSpan = Math.max(w / 2, hw) + 2.5;
  const top = tipY - 2;
  const bottom = len / 2 + 3.5; // room for the width dimension label
  const vbW = halfSpan * 2;
  const vbH = bottom - top;

  const wheelInset = WHEEL_INSET;
  const wx = w / 2 - wheelInset;
  const wy = len / 2 - wheelInset;

  const isTank = spec.drivetrain === 'tank';
  const wheelW = isTank ? 1.9 : 1.5;
  const wheelH = isTank ? 4.2 : 3.2;

  const stroke = 'var(--ds-ink-dim)';
  const accent = 'var(--ds-accent)';

  // intake geometry
  let intakeEl: JSX.Element;
  if (spec.intake === 'vector') {
    // a row of vertical compliant wheels ahead of the chassis (may overhang)
    const n = 5;
    const rw = 1.15;
    const gap = (hw * 2 - rw) / (n - 1);
    intakeEl = (
      <g>
        {Array.from({ length: n }, (_, i) => (
          <rect
            key={i}
            x={-hw + i * gap}
            y={tipY}
            width={rw}
            height={reach + 1}
            rx={0.5}
            fill={accent}
            opacity={0.85}
          />
        ))}
      </g>
    );
  } else {
    // trapezoid mouth recessed between side prongs, opening forward
    const inHalf = hw * 0.55;
    const outHalf = hw;
    intakeEl = (
      <g>
        <polygon
          points={`${-inHalf},${frontY} ${inHalf},${frontY} ${outHalf},${tipY} ${-outHalf},${tipY}`}
          fill={accent}
          opacity={0.28}
          stroke={accent}
          strokeWidth={0.35}
        />
        {/* side prongs */}
        <rect x={outHalf - 0.6} y={tipY} width={0.9} height={reach} rx={0.3} fill={accent} opacity={0.8} />
        <rect x={-outHalf - 0.3} y={tipY} width={0.9} height={reach} rx={0.3} fill={accent} opacity={0.8} />
      </g>
    );
  }

  return (
    <svg
      width={size}
      height={(size * vbH) / vbW}
      viewBox={`${-halfSpan} ${top} ${vbW} ${vbH}`}
      role="img"
      aria-label={`${spec.width} by ${spec.length} inch robot, ${spec.intake} intake`}
    >
      {/* wheels (under the chassis) */}
      {[
        [wx, wy],
        [-wx, wy],
        [wx, -wy],
        [-wx, -wy],
      ].map(([x, y], i) => (
        <rect
          key={i}
          x={x - wheelW / 2}
          y={y - wheelH / 2}
          width={wheelW}
          height={wheelH}
          rx={0.6}
          fill="#0c151d"
          stroke={stroke}
          strokeWidth={0.25}
        />
      ))}

      {intakeEl}

      {/* chassis */}
      <rect
        x={-w / 2}
        y={-len / 2}
        width={w}
        height={len}
        rx={1.4}
        fill="var(--ds-panel)"
        stroke={stroke}
        strokeWidth={0.5}
      />

      {/* front indicator (a chevron at the front edge) */}
      <polyline
        points={`${-w * 0.18},${frontY + 1.6} 0,${frontY + 0.4} ${w * 0.18},${frontY + 1.6}`}
        fill="none"
        stroke={accent}
        strokeWidth={0.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* triangle-intake internal storage hint */}
      {spec.intake === 'triangle' && (
        <polygon
          points={`0,${turretY - 2.4} 1.7,${turretY + 0.6} ${-1.7},${turretY + 0.6}`}
          fill="none"
          stroke={stroke}
          strokeWidth={0.3}
          opacity={0.7}
        />
      )}

      {/* turret ring + barrel toward front */}
      <circle cx={0} cy={turretY} r={turretR} fill="var(--ds-bg)" stroke={accent} strokeWidth={0.5} />
      <line x1={0} y1={turretY} x2={0} y2={turretY - turretR - 1.2} stroke={accent} strokeWidth={0.7} strokeLinecap="round" />
      {spec.canSort && <circle cx={0} cy={turretY} r={turretR * 0.4} fill={accent} opacity={0.8} />}

      {/* width dimension label */}
      <text
        x={0}
        y={len / 2 + 2.6}
        textAnchor="middle"
        fill="var(--ds-mut)"
        fontSize={1.7}
        fontFamily="ui-monospace, monospace"
      >
        {w}" wide · {len}" long
      </text>
    </svg>
  );
}
