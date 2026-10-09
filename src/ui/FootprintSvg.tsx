import { useId } from 'react';
import type { DrivetrainType, ImportedRobot, Vec2 } from '../types';
import { COLORS } from '../config';
import { importedWheels, polyBounds, polyGrow } from '../sim/imported';
import { importedTopFrame } from '../render/importedAssets';
import { frontArrowSpot, type EdgeRect } from '../render/drawImported';

/** a mechanism mark on the footprint, robot-local inches */
export interface FootprintMarks {
  /** intake grab areas — the game's own mouth rects (`bbMouths`, `chainIntakeMouths`) */
  mouths?: readonly EdgeRect[];
  /** turret axes and their ring radius; the pointer shows +x (straight ahead) */
  turrets?: readonly { x: number; y: number; r: number }[];
  /** a placement point (BIOBUZZ Box Tube, Chain catalyst reach origin) */
  place?: Vec2 | null;
  /** a turretless launcher's release LINE (BIOBUZZ dumper, Chain drum/catapult) */
  lines?: readonly { x0: number; y0: number; x1: number; y1: number }[];
}

/** dimension-label type size, in the viewBox's inch units (the SVG previews' own) */
const DIM_FONT = 1.7;
/** robot (x, y) → screen (−y, −x): nose up, robot-LEFT on screen LEFT (CLAUDE.md's bird's-eye rule) */
const ROBOT_FRAME = 'matrix(0,-1,-1,0,0,0)';

const pts = (poly: readonly Vec2[]): string => poly.map((p) => `${p.x},${p.y}`).join(' ');

/** the accessible name a preview of an import carries: its measured size, width first */
export function importedFootprintLabel(imp: ImportedRobot): string {
  const b = polyBounds(imp.hull);
  return `Imported robot, ${(b.maxY - b.minY).toFixed(1)} by ${(b.maxX - b.minX).toFixed(1)} inches`;
}

/**
 * AN IMPORTED ROBOT'S FOOTPRINT, as a small SVG — the hull, its wheels, which end is the front, and
 * optionally where the game's accessors put its mechanisms. For a library CARD and the builder
 * HERO when there is no thumbnail, and the Chain Reaction / BIOBUZZ builder preview of an import
 * (their schematics are SVG; DECODE's preview is the real sprite on a canvas).
 *
 * NOSE UP through `ROBOT_FRAME` — `[[0,−1],[−1,0]]`, NOT `rotate(-90)`, which would put the robot's
 * left on the screen's right (the bird's-eye vs mirrored gotcha). The optional top-down PICTURE
 * (`image`, an object URL from `importedTopUrl`) is placed in SCREEN coordinates from the same frame
 * definition the 2D sprite uses (`importedTopFrame`): its pixel (u, v) lands at screen
 * (u·k − cy − side/2, v·k − cx − side/2), unmirrored, clipped to the hull.
 *
 * ON THE FIELD'S DARK MAT, like the other previews, so every colour is category 3 (it never
 * themes, because the ground it sits on never does): `--ds-on-field*` tokens and the field's
 * own greys.
 */
export function FootprintSvg({
  imported,
  drivetrain,
  marks,
  image = null,
  size = 96,
  fluid = false,
  caption = false,
  label,
}: {
  imported: ImportedRobot;
  /** orients the wheels like the sprites do (X-drive across its corner); absent = straight */
  drivetrain?: DrivetrainType;
  marks?: FootprintMarks;
  /** the top-down picture's URL, drawn under the marks and clipped to the hull */
  image?: string | null;
  size?: number;
  fluid?: boolean;
  /** print `W" wide · L" long` (the hull's bounding box) under the robot */
  caption?: boolean;
  /** the accessible name; omitted, the svg is decorative (`aria-hidden`) */
  label?: string;
}) {
  const clipId = useId();
  const hull = imported.hull;
  const b = polyBounds(hull);
  const wide = b.maxY - b.minY;
  const long = b.maxX - b.minX;

  // SCREEN bounds of everything drawn (screen = (−y, −x)), so a mark past the hull is never cut
  let sx0 = -b.maxY;
  let sx1 = -b.minY;
  let sy0 = -b.maxX;
  let sy1 = -b.minX;
  const grow = (x: number, y: number, r = 0): void => {
    sx0 = Math.min(sx0, -y - r);
    sx1 = Math.max(sx1, -y + r);
    sy0 = Math.min(sy0, -x - r);
    sy1 = Math.max(sy1, -x + r);
  };
  for (const m of marks?.mouths ?? []) {
    grow(m.x0, m.y0);
    grow(m.x1, m.y1);
  }
  for (const t of marks?.turrets ?? []) grow(t.x, t.y, t.r + 1.4);
  for (const l of marks?.lines ?? []) {
    grow(l.x0, l.y0, 0.4);
    grow(l.x1, l.y1, 0.4);
  }
  if (marks?.place) grow(marks.place.x, marks.place.y, 1.2);

  const dimLabel = `${wide.toFixed(1)}" wide · ${long.toFixed(1)}" long`;
  const labelHalf = caption ? (dimLabel.length * DIM_FONT * 0.56) / 2 : 0;
  const pad = 1.6;
  const half = Math.max(Math.abs(sx0), Math.abs(sx1), labelHalf) + pad;
  const top = sy0 - pad;
  const labelY = sy1 + 2.6;
  const bottom = caption ? labelY + DIM_FONT + 0.9 : sy1 + pad;
  const vbW = half * 2;
  const vbH = bottom - top;

  const stroke = 'var(--ds-on-field-dim)';
  const accent = 'var(--ds-on-field-accent)';
  const ink = 'var(--ds-on-field)';

  // wheels, in the robot frame, oriented the way the 2D sprite orients them
  const wheels = importedWheels(imported);
  const wcx = wheels.reduce((s, p) => s + p.x, 0) / wheels.length;
  const wcy = wheels.reduce((s, p) => s + p.y, 0) / wheels.length;
  const wheelDeg = (p: Vec2): number =>
    drivetrain === 'xdrive' ? ((p.x - wcx) * (p.y - wcy) >= 0 ? -45 : 45) : 0;

  const inner = polyGrow(hull, -1.15);
  // the deck arrow, clear of any turret ring (the sprites' own rule, `frontArrowSpot`)
  const arrow = frontArrowSpot(hull, marks?.turrets ?? []);

  const f = importedTopFrame(hull);

  return (
    <svg
      className="ds-robot-sprite"
      width={fluid ? '100%' : size}
      height={fluid ? undefined : (size * vbH) / vbW}
      preserveAspectRatio="xMidYMid meet"
      style={fluid ? { display: 'block', aspectRatio: `${vbW} / ${vbH}` } : undefined}
      viewBox={`${-half} ${top} ${vbW} ${vbH}`}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <defs>
        <clipPath id={clipId}>
          <polygon points={pts(hull)} transform={ROBOT_FRAME} />
        </clipPath>
      </defs>
      <rect x={-half} y={top} width={vbW} height={vbH} fill={COLORS.mat} />
      {image ? (
        <image
          href={image}
          x={-f.cy - f.sideIn / 2}
          y={-f.cx - f.sideIn / 2}
          width={f.sideIn}
          height={f.sideIn}
          preserveAspectRatio="none"
          clipPath={`url(#${clipId})`}
        />
      ) : null}
      <g transform={ROBOT_FRAME}>
        {image ? null : (
          <>
            <polygon points={pts(hull)} fill={COLORS.tile} />
            {inner.length >= 3 ? <polygon points={pts(inner)} fill="none" stroke={stroke} strokeWidth={0.2} opacity={0.6} /> : null}
            {wheels.map((p, i) => (
              <rect
                key={i}
                x={-2.2}
                y={-1.1}
                width={4.4}
                height={2.2}
                rx={0.5}
                fill={COLORS.mat}
                stroke={stroke}
                strokeWidth={0.25}
                transform={`translate(${p.x} ${p.y}) rotate(${wheelDeg(p)})`}
              />
            ))}
          </>
        )}
        {(marks?.mouths ?? []).map((m, i) => (
          <rect
            key={`m${i}`}
            x={m.x0}
            y={m.y0}
            width={m.x1 - m.x0}
            height={m.y1 - m.y0}
            fill={accent}
            fillOpacity={0.18}
            stroke={accent}
            strokeWidth={0.3}
          />
        ))}
        {(marks?.turrets ?? []).map((t, i) => (
          <g key={`t${i}`} transform={`translate(${t.x} ${t.y})`}>
            <circle r={t.r} fill="none" stroke={ink} strokeWidth={0.3} />
            <path d={`M ${t.r + 1.2} 0 L ${t.r * 0.25} 0.5 L ${t.r * 0.25} -0.5 Z`} fill={ink} />
          </g>
        ))}
        {(marks?.lines ?? []).map((l, i) => (
          <line key={`l${i}`} x1={l.x0} y1={l.y0} x2={l.x1} y2={l.y1} stroke={accent} strokeWidth={0.5} strokeLinecap="round" />
        ))}
        {marks?.place ? (
          <circle cx={marks.place.x} cy={marks.place.y} r={1.0} fill="none" stroke={ink} strokeWidth={0.3} />
        ) : null}
        {/* WHICH END IS THE FRONT: the arrow on the deck, pointing at it (+x, screen up) */}
        <path
          d={`M ${arrow.x + arrow.len / 2} ${arrow.y} L ${arrow.x - arrow.len / 2} ${arrow.y + arrow.half} L ${arrow.x - arrow.len / 2} ${arrow.y - arrow.half} Z`}
          fill={ink}
          opacity={0.92}
        />
        {/* the silhouette line, inside the hull like the sprites' */}
        <polygon points={pts(hull)} fill="none" stroke={stroke} strokeWidth={0.35} />
      </g>
      {caption ? (
        <text x={0} y={labelY} textAnchor="middle" fill={stroke} fontSize={DIM_FONT} fontFamily="var(--ds-font-mono)">
          {dimLabel}
        </text>
      ) : null}
    </svg>
  );
}
