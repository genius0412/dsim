import { useId } from 'react';
import type { RobotSpec } from '../types';
import { INTAKE_PRESETS, TURRET_OFFSET_FRAC, VOLLEY_MUZZLE_SPACING, WHEEL_INSET } from '../config';
import { archetypeOf, hasTurret, shooterCount } from '../sim/archetype';

/**
 * Top-down schematic of a robot drawn straight from its `RobotSpec` — the live
 * preview in the My Robot builder. Front faces UP (screen −y). Everything is in
 * inches inside the viewBox so the drawing scales with the real chassis/intake
 * dimensions, and colors reference the Direction A ds- tokens so it themes with
 * the app. Purely presentational; reads nothing but the spec + a few geometry
 * constants (matching the sim's own robotExtents / turret placement rules).
 * A custom `appearance` overrides the themed body/accent colors so the builder
 * shows the paint job live.
 */
export function RobotPreview({ spec, size = 200 }: { spec: RobotSpec; size?: number }) {
  const clipId = useId();
  const w = spec.width;
  const len = spec.length;
  const intake = INTAKE_PRESETS[spec.intake];
  const reach = intake.reach;
  const hw = intake.halfWidth;
  const app = spec.appearance;
  const turret = hasTurret(spec);
  const shooters = shooterCount(spec);

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
  const accent = app?.accent ?? 'var(--ds-accent)';
  const body = app?.body ?? 'var(--ds-panel)';

  // intake geometry
  let intakeEl: JSX.Element;
  if (intake.overhang) {
    // vector / tridexer: a row of vertical compliant wheels ahead of the
    // chassis (the tridexer's bar spans the full front)
    const n = spec.intake === 'tridexer' ? 9 : 5;
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

  // shooter bank: turret (single / spindexer / triangle) or a fixed bank of
  // 1-3 barrels aimed out the front
  let shooterEl: JSX.Element;
  if (turret && shooters === 1) {
    const spin = archetypeOf(spec) === 'spindexer';
    shooterEl = (
      <g>
        <circle cx={0} cy={turretY} r={turretR} fill="var(--ds-bg)" stroke={accent} strokeWidth={0.5} />
        <line x1={0} y1={turretY} x2={0} y2={turretY - turretR - 1.2} stroke={accent} strokeWidth={0.7} strokeLinecap="round" />
        {spec.canSort && <circle cx={0} cy={turretY} r={turretR * 0.4} fill={accent} opacity={0.8} />}
        {spin &&
          [90, 210, 330].map((deg) => (
            <circle
              key={deg}
              cx={Math.cos((deg * Math.PI) / 180) * turretR * 0.5}
              cy={turretY + Math.sin((deg * Math.PI) / 180) * turretR * 0.5}
              r={turretR * 0.16}
              fill={accent}
              opacity={0.7}
            />
          ))}
      </g>
    );
  } else if (turret) {
    // turreted tridexer: three shooters in a triangle on the turret ring
    const verts: [number, number][] = [
      [0, turretY - 0.45 * turretR],
      [0.55 * turretR, turretY + 0.35 * turretR],
      [-0.55 * turretR, turretY + 0.35 * turretR],
    ];
    shooterEl = (
      <g>
        <circle cx={0} cy={turretY} r={turretR} fill="var(--ds-bg)" stroke={accent} strokeWidth={0.5} />
        {verts.map(([vx, vy], i) => (
          <g key={i}>
            <line x1={vx} y1={vy} x2={vx} y2={turretY - turretR - 1.0} stroke={accent} strokeWidth={0.7} strokeLinecap="round" />
            <circle cx={vx} cy={vy} r={0.8} fill={accent} />
          </g>
        ))}
      </g>
    );
  } else {
    // chassis-fixed bank (single / double / tridexer): 1-3 barrels out the front
    const s = VOLLEY_MUZZLE_SPACING;
    const lats = Array.from({ length: shooters }, (_, i) => (i - (shooters - 1) / 2) * s);
    const halfW = ((shooters - 1) / 2) * s + 1.4;
    shooterEl = (
      <g>
        <rect x={-halfW} y={turretY - 1.4} width={2 * halfW} height={2.8} rx={0.6} fill="var(--ds-bg)" stroke={accent} strokeWidth={0.4} />
        {lats.map((lat) => (
          <line key={lat} x1={lat} y1={turretY} x2={lat} y2={frontY + 1.2} stroke={accent} strokeWidth={0.9} strokeLinecap="round" />
        ))}
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
      <defs>
        <clipPath id={clipId}>
          <rect x={-w / 2} y={-len / 2} width={w} height={len} rx={1.4} />
        </clipPath>
      </defs>

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
          fill={app?.wheels ?? '#0c151d'}
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
        fill={body}
        stroke={stroke}
        strokeWidth={0.5}
      />

      {/* cosmetic paint pattern, clipped to the chassis */}
      {app && app.pattern === 'stripes' && (
        <g clipPath={`url(#${clipId})`} fill={accent} opacity={0.55}>
          <rect x={-w * 0.42 - w * 0.12} y={-len / 2} width={w * 0.24} height={len} />
          <rect x={w * 0.42 - w * 0.12} y={-len / 2} width={w * 0.24} height={len} />
        </g>
      )}
      {app && app.pattern === 'diagonal' && (
        <g clipPath={`url(#${clipId})`} stroke={accent} strokeWidth={1.6} opacity={0.55}>
          {Array.from({ length: 9 }, (_, i) => {
            const x = -w + i * 4.2;
            return <line key={i} x1={x} y1={len / 2} x2={x + len} y2={-len / 2} />;
          })}
        </g>
      )}
      {app && app.pattern === 'checker' && (
        <g clipPath={`url(#${clipId})`} fill={accent} opacity={0.55}>
          {Array.from({ length: Math.ceil((w + 3) / 3) }, (_, ix) =>
            Array.from({ length: Math.ceil((len + 3) / 3) }, (_, iy) =>
              (ix + iy) % 2 === 0 ? (
                <rect key={`${ix}-${iy}`} x={-w / 2 + ix * 3} y={-len / 2 + iy * 3} width={3} height={3} />
              ) : null,
            ),
          )}
        </g>
      )}
      {app && app.pattern === 'split' && (
        <g clipPath={`url(#${clipId})`} fill={accent} opacity={0.55}>
          <rect x={-w / 2} y={-len / 2} width={w} height={len / 2} />
        </g>
      )}

      {/* front indicator (a chevron at the front edge) */}
      <polyline
        points={`${-w * 0.18},${frontY + 1.6} 0,${frontY + 0.4} ${w * 0.18},${frontY + 1.6}`}
        fill="none"
        stroke={app?.accent ?? 'var(--ds-accent)'}
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

      {shooterEl}

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
