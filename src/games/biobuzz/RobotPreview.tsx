import type { RobotSpec } from '../../types';
import { WHEEL_INSET } from '../../config';
import {
  BB_HOOD_DEFAULT_DEG,
  BB_LAUNCH_LINE_FRAC,
  BB_LAUNCH_PLATE_GAP,
  BB_LAUNCH_PLATE_OVERHANG,
  BB_POLLEN_R,
} from './config';
import { bbLauncherOf, bbLiftOf } from './mechs';
import { BB_MODE_LABELS } from './labels';
import { BB_PLACE_MARK_R, bbBoxTubeGlyph } from './parts';
import { EDGE_ANGLE, type BbMountPos, bbMouthFrame, bbShooterEdgeOf, edgeGeom, turretLocal, turretRadius } from './mounts';
import { bbFootprint, bbMouths, bbPlacePointLocal } from './robot';

/** dimension-label type size, in the viewBox's inch units */
const DIM_FONT = 1.7;

/**
 * Top-down schematic of a BIOBUZZ robot drawn straight from its `RobotSpec` — the live preview
 * in the My Robot builder. Front faces UP (screen −y). Everything is in inches inside the
 * viewBox so the drawing scales with the real chassis/intake dimensions, and colours reference
 * the `ds-*` design tokens so it themes with the app.
 *
 * Copied and owned from `games/chain/RobotPreview.tsx` with the catalyst mechanism deleted —
 * BIOBUZZ has no second manipulator, so there is no arm/claw/rail branch.
 *
 * ── IT DRAWS FROM THE SIM'S OWN GEOMETRY ───────────────────────────────────
 * The mouths come from `bbMouths`, the viewBox extents from `bbFootprint`, the turrets from
 * `turretLocal`, and the Box Tube's marker from `bbPlacePointLocal` — the same functions the
 * canvas sprite, the capture test and the FLOWER reach test use. The preview and the in-match
 * sprite are therefore the same mechanism drawn twice, not two drawings kept in sync by hand,
 * and the archetype sheets put the two side by side precisely so a divergence is visible.
 *
 * Purely presentational: it reads the spec and nothing else — no world, no clock, no state. So
 * it draws NO held elements (there is no hopper to read) and the placement marker is always the
 * hollow, not-in-reach ring.
 */
/**
 * `fluid` hands the WIDTH to the layout: the svg takes 100% of its container and keeps its own
 * aspect ratio, instead of being `size` pixels wide. It exists because a fixed-width preview in
 * a responsive grid either overflows (clipping the dimension label it just measured its viewBox
 * to fit) or leaves the column half empty, and the gallery's archetype sheets show three of
 * them per cell at whatever width the grid gives.
 */
export function BiobuzzRobotPreview({
  spec,
  size = 200,
  fluid = false,
}: {
  spec: RobotSpec;
  size?: number;
  fluid?: boolean;
}) {
  const w = spec.width;
  const len = spec.length;

  const frontY = -len / 2; // chassis front edge (top)

  // The SAME intake mouths the sim captures with, one per mounted edge, in ROBOT coords (+x
  // forward). The collision footprint moves with the mount, so the viewBox extents come from
  // `bbFootprint` (the sim's own hitbox) rather than from the chassis front.
  const mouths = bbMouths(spec);
  const ext = bbFootprint(spec);
  const half = ext.half; // ±y half-span (grown by a flank mount)
  const tipY = -ext.front; // front-most in SCREEN y (robot +x → screen −y), for the viewBox
  const rearY = ext.rear; // rear-most in SCREEN y
  // THE LOADOUT — a mandatory launcher and an optional Box Tube, read through `mechs.ts`, which is
  // safe on the RAW spec this live builder preview is handed.
  const launcher = bbLauncherOf(spec, BB_HOOD_DEFAULT_DEG);
  const lift = bbLiftOf(spec);
  // THE PLACEMENT POINT lies OUTSIDE the footprint by construction, so the viewBox has to grow to
  // include it — in SCREEN coords, ROBOT_FRAME sends robot (x,y) to (−y,−x).
  const place = bbPlacePointLocal(spec);
  const markSX = place ? -place.y : 0;
  const markSY = place ? -place.x : 0;
  const markR = BB_PLACE_MARK_R + 0.9; // the ring plus its crosshair ticks

  // viewBox spans the widest of chassis/intake/marker plus a margin. The dimension label is
  // centred and can be WIDER than a narrow chassis, so it has to be measured in too — an <svg>
  // clips to its viewport, and a 14.5"-wide robot would otherwise lop the ends off
  // `17" wide · 15" long`.
  const dimLabel = `${w}" wide · ${len}" long`;
  const labelHalf = (dimLabel.length * DIM_FONT * 0.56) / 2; // ~0.56em avg advance
  const halfSpan = Math.max(w / 2, half, labelHalf, place ? Math.abs(markSX) + markR : 0) + 2.5;
  const top = Math.min(tipY, place ? markSY - markR : tipY) - 2;
  // The label clears whatever hangs off the BACK — a rear sweeper, or a marker behind the robot.
  const labelY = Math.max(rearY, place ? markSY + markR : rearY) + 2.6;
  const bottom = labelY + DIM_FONT + 0.9;
  const vbW = halfSpan * 2;
  const vbH = bottom - top;

  // bumper thickness — the SAME rule the in-game body uses (`drawChassisBody`), kept just
  // under the wheel inset so the wheels read as inside the frame
  const bumpW = Math.min(WHEEL_INSET - 0.5, Math.max(0.95, Math.min(w, len) * 0.085));
  const wx = w / 2 - WHEEL_INSET;
  const wy = len / 2 - WHEEL_INSET;

  const isTank = spec.drivetrain === 'tank';
  const wheelW = isTank ? 1.9 : 1.5;
  const wheelH = isTank ? 4.2 : 3.2;

  const stroke = 'var(--ds-ink-dim)';
  const accent = 'var(--ds-accent)';

  const ROBOT_FRAME = 'matrix(0,-1,-1,0,0,0)';
  const deg = (rad: number): number => (rad * 180) / Math.PI;

  /**
   * INTAKE — the same sweeper the match renderer draws (`drawBiobuzzIntake`), in SVG: two side
   * plates bolted at the frame line, a roller across the tip, and a transfer roller at the
   * frame when the mouth is deep enough. Authored through `bbMouthFrame`, so the preview and
   * the sprite are one mechanism drawn twice.
   */
  const roller = (cx: number, spanHalf: number, dia: number, key: string) => {
    const flaps = Math.max(3, Math.round((spanHalf * 2) / 2.3));
    return (
      <g key={key}>
        <rect
          x={cx - dia / 2}
          y={-spanHalf}
          width={dia}
          height={spanHalf * 2}
          rx={dia * 0.42}
          fill="var(--ds-bg)"
          stroke={stroke}
          strokeWidth={0.22}
        />
        {Array.from({ length: flaps }, (_, i) => {
          const y = -spanHalf + 0.45 + ((i + 0.5) * (spanHalf * 2 - 0.9)) / flaps;
          return (
            <line
              key={i}
              x1={cx - dia * 0.3}
              y1={y - 0.3}
              x2={cx + dia * 0.3}
              y2={y + 0.3}
              stroke={stroke}
              strokeWidth={0.18}
              opacity={0.9}
            />
          );
        })}
      </g>
    );
  };
  const intakeEl = mouths.length ? (
    <g transform={ROBOT_FRAME}>
      {mouths.map((m) => {
        const f = bbMouthFrame(m, len / 2, w / 2);
        const outer = f.depth - 0.95;
        const inner = f.rail - 0.2;
        const deep = f.depth - f.rail > 2.2;
        return (
          <g key={m.edge} transform={`translate(${f.ox},${f.oy}) rotate(${deg(f.rot)})`}>
            {/* the open throat, neutral: the builder has no run/idle state to colour */}
            <rect x={f.rail} y={-f.half} width={f.depth - f.rail} height={f.half * 2} fill={stroke} opacity={0.14} />
            {[1, -1].map((sg) => (
              <rect
                key={sg}
                x={f.rail - 0.6}
                y={sg > 0 ? f.half - 0.55 : -f.half}
                width={f.depth - f.rail + 0.6}
                height={0.55}
                rx={0.2}
                fill={stroke}
                opacity={0.75}
              />
            ))}
            {deep ? roller(inner, f.half - 1.35, 0.8, 'in') : null}
            {roller(outer, f.half - 0.75, 1.5, 'out')}
          </g>
        );
      })}
    </g>
  ) : null;

  // THE DUMPER: a tray on a pivot, authored along robot +x and rotated onto its mounted edge, so a
  // left/right mount spans the chassis LENGTH — matching how `bbLaunch` spreads the shot. Keyed
  // off the launcher's OWN resolved mount rather than `spec.shooterMount` read cold.
  const sEdge = bbShooterEdgeOf({ shooterMount: launcher.mount }); // a dumper fires over a SIDE
  const sGeom = edgeGeom(spec, sEdge);
  const lineHalf = sGeom.span * BB_LAUNCH_LINE_FRAC; // dumper tray width
  const dumpPivot = sGeom.dist - 7.4;
  const dumpLip = sGeom.dist - 0.9;
  const tR = turretRadius(spec); // the sim's ring size, for every turret
  const teeth = Math.max(14, Math.round(tR * 6)); // slew-ring teeth, as in the sprite

  /**
   * ONE TURRET at `pos`, stowed facing forward. Authored in SCREEN space (unlike the chassis-frame
   * groups), so the robot-frame offset is mapped by hand: ROBOT_FRAME sends robot (x,y) → screen
   * (−y,−x). A DOUBLE turret draws this twice; its NECTAR turret carries an accent rim and a second
   * inner rim, the same SHAPE cue the in-match sprite gives it (the preview has no alliance, so the
   * accent token stands in for the alliance colour there).
   */
  const turretEl = (pos: BbMountPos, nectar: boolean) => {
    const t = turretLocal(spec, pos); // the SAME point the sim launches from
    const gap = BB_LAUNCH_PLATE_GAP;
    const plate = 0.42;
    // CENTRED on the ring: the feed is on the turret axis, so the plates straddle it. Front is up.
    const y0 = tR + BB_LAUNCH_PLATE_OVERHANG; // plate rear
    const y1 = -y0; // ...and the muzzle end
    const wheelY = -tR * 0.6; // the flywheel: past the feed hole, before the muzzle
    return (
      <g key={`t-${pos}`} transform={`translate(${-t.y},${-t.x})`}>
        {/* the SLEW RING it turns on, toothed like the sprite's */}
        <circle
          cx={0}
          cy={0}
          r={tR}
          fill="var(--ds-bg)"
          stroke={nectar ? accent : stroke}
          strokeWidth={nectar ? 0.55 : 0.35}
        />
        {Array.from({ length: teeth }, (_, i) => {
          const a = (i / teeth) * Math.PI * 2;
          return (
            <line
              key={i}
              x1={Math.cos(a) * (tR - 0.32)}
              y1={Math.sin(a) * (tR - 0.32)}
              x2={Math.cos(a) * tR}
              y2={Math.sin(a) * tR}
              stroke={stroke}
              strokeWidth={0.2}
              opacity={0.8}
            />
          );
        })}
        {nectar ? <circle cx={0} cy={0} r={tR - 0.75} fill="none" stroke={accent} strokeWidth={0.32} /> : null}
        {/* the FEED HOLE an element rises through, dead centre on the turret axis */}
        <circle cx={0} cy={0} r={BB_POLLEN_R + 0.15} fill="var(--ds-bg)" stroke={stroke} strokeWidth={0.2} />
        {/* THE SHOOTER HEAD: two parallel PLATES with a flywheel between them, no barrel */}
        {[1, -1].map((sg) => (
          <rect
            key={sg}
            x={sg * (gap / 2) - (sg > 0 ? 0 : plate)}
            y={y1}
            width={plate}
            height={y0 - y1}
            rx={0.16}
            fill={stroke}
            opacity={0.85}
          />
        ))}
        {[0.12, 0.92].map((f) => {
          const y = y0 + (y1 - y0) * f;
          return <line key={f} x1={-gap / 2} y1={y} x2={gap / 2} y2={y} stroke={stroke} strokeWidth={0.2} opacity={0.7} />;
        })}
        <rect
          x={-gap / 2 + 0.1}
          y={wheelY - 0.75}
          width={gap - 0.2}
          height={1.5}
          rx={0.4}
          fill="var(--ds-bg)"
          stroke={stroke}
          strokeWidth={0.22}
        />
        <line x1={-gap / 2 + 0.15} y1={y1 + 0.3} x2={gap / 2 - 0.15} y2={y1 + 0.3} stroke={accent} strokeWidth={0.3} />
      </g>
    );
  };

  const launcherEl =
    launcher.kind === 'dumper' ? (
      // a TRAY on a pivot: the shaft it swings about, two throwing arms, and the release lip
      <g transform={`${ROBOT_FRAME} rotate(${deg(EDGE_ANGLE[sEdge])})`}>
        <polygon
          points={`${dumpPivot},${-lineHalf * 0.72} ${dumpLip},${-lineHalf} ${dumpLip},${lineHalf} ${dumpPivot},${lineHalf * 0.72}`}
          fill={accent}
          opacity={0.12}
        />
        {[1, -1].map((sg) => (
          <line
            key={sg}
            x1={dumpPivot}
            y1={sg * lineHalf * 0.72}
            x2={dumpLip}
            y2={sg * lineHalf}
            stroke={stroke}
            strokeWidth={0.62}
            strokeLinecap="round"
          />
        ))}
        <line x1={dumpPivot} y1={-lineHalf * 0.72} x2={dumpPivot} y2={lineHalf * 0.72} stroke={stroke} strokeWidth={0.7} />
        {[1, -1].map((sg) => (
          <circle key={sg} cx={dumpPivot} cy={sg * lineHalf * 0.72} r={0.45} fill={stroke} />
        ))}
        <rect x={dumpLip - 0.45} y={-lineHalf} width={0.9} height={lineHalf * 2} rx={0.3} fill={accent} opacity={0.8} />
      </g>
    ) : launcher.kind === 'twinturret' ? (
      <g>
        {turretEl(launcher.mount, false)}
        {turretEl(launcher.mount2 ?? launcher.mount, true)}
      </g>
    ) : (
      turretEl(launcher.mount, false)
    );

  /**
   * THE BOX TUBE — the same hollow rectangle the sprite draws (`bbBoxTubeGlyph`, `parts.ts`), in
   * the robot frame, plus the reach line and the placement-point marker at `bbPlacePointLocal`.
   * The marker is always hollow here: "in reach of a FLOWER" is a state of a match, and this
   * preview has none.
   */
  const liftEl = (() => {
    if (!lift || !place) return null;
    const g = bbBoxTubeGlyph(spec, lift.mount);
    const R = BB_PLACE_MARK_R;
    const dist = Math.hypot(place.x - g.outer.x, place.y - g.outer.y);
    const k = dist > R ? (dist - R) / dist : 0;
    return (
      <g transform={ROBOT_FRAME}>
        <g transform={`translate(${g.cx},${g.cy}) rotate(${deg(Math.atan2(g.uy, g.ux))})`}>
          <rect x={-g.len / 2} y={-g.w / 2} width={g.len} height={g.w} fill={stroke} opacity={0.85} />
          <rect x={-g.len / 2 + 0.28} y={-g.w / 2 + 0.28} width={g.len - 0.56} height={g.w - 0.56} fill="var(--ds-bg)" />
        </g>
        <line
          x1={g.outer.x}
          y1={g.outer.y}
          x2={g.outer.x + (place.x - g.outer.x) * k}
          y2={g.outer.y + (place.y - g.outer.y) * k}
          stroke={accent}
          strokeWidth={0.28}
          strokeLinecap="round"
        />
        <circle cx={place.x} cy={place.y} r={R} fill="none" stroke={accent} strokeWidth={0.3} />
        {[
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ].map(([dx, dy]) => (
          <line
            key={`${dx}_${dy}`}
            x1={place.x + dx * (R + 0.2)}
            y1={place.y + dy * (R + 0.2)}
            x2={place.x + dx * (R + 0.75)}
            y2={place.y + dy * (R + 0.75)}
            stroke={accent}
            strokeWidth={0.28}
            strokeLinecap="round"
          />
        ))}
      </g>
    );
  })();

  const ariaLabel = `${spec.width} by ${spec.length} inch robot, sweeper intake, ${BB_MODE_LABELS[
    launcher.kind
  ].toLowerCase()}${lift ? ', box tube with a placement point' : ''}`;

  return (
    <svg
      width={fluid ? '100%' : size}
      height={fluid ? undefined : (size * vbH) / vbW}
      // a fluid svg needs the intrinsic ratio to keep its height; a sized one already has both
      preserveAspectRatio="xMidYMid meet"
      style={fluid ? { display: 'block', aspectRatio: `${vbW} / ${vbH}` } : undefined}
      viewBox={`${-halfSpan} ${top} ${vbW} ${vbH}`}
      role="img"
      aria-label={ariaLabel}
    >
      {intakeEl}

      {/* chassis.

          DELIBERATELY still `--ds-panel`, not the supporter chassis colour. This preview lives
          on a THEMED UI panel, while the in-game sprite sits on the hardcoded-dark field — and
          every `CHASSIS_COLORS` value is tuned for that dark ground. Painting one here would
          put `--ds-accent` wheels and pods (a DARK green in light theme) on a dark chassis
          fill, which is the exact fill-vs-text collision shell.css warns about. The colour is
          previewed by its swatch in the builder instead. */}
      {/* BUMPER BAND + DECK, mirroring the in-game `drawChassisBody` so the builder previews
          the same OBJECT rather than a plain outline. Neutral, not alliance-coloured: a
          preview has no alliance to show, and the fill note above rules out a strong fill
          here anyway. */}
      <rect
        x={-w / 2}
        y={-len / 2}
        width={w}
        height={len}
        fill="var(--ds-line)"
        stroke={stroke}
        strokeWidth={0.35}
      />
      <rect
        x={-w / 2 + bumpW}
        y={-len / 2 + bumpW}
        width={w - bumpW * 2}
        height={len - bumpW * 2}
        fill="var(--ds-panel)"
        stroke={stroke}
        strokeWidth={0.24}
      />
      {/* control hub — the box every FTC robot has. Pushed WELL back (0.62 of the deck,
          matching `drawChassisBody`): rear-of-centre is exactly where a turret parks, so a hub
          any further forward is just something for the turret to sit on top of. */}
      {(() => {
        const dl = len / 2 - bumpW;
        const dw = w / 2 - bumpW;
        const hubW = Math.min(4.6, dw * 1.24);
        const hubH = Math.min(3, dl * 0.52);
        return (
          <rect
            x={-hubW / 2}
            y={dl * 0.62 - hubH / 2}
            width={hubW}
            height={hubH}
            rx={0.45}
            fill="var(--ds-bg)"
            stroke={stroke}
            strokeWidth={0.28}
          />
        );
      })()}

      {/* wheels ON TOP of the chassis (like the in-game `drawWheels`) — per drivetrain:
          mecanum/tank forward, SWERVE steering pods, X-drive omnis canted 45° into an X.
          Front = UP. */}
      {(() => {
        const corners: [number, number][] = [
          [wx, wy],
          [-wx, wy],
          [wx, -wy],
          [-wx, -wy],
        ];
        const wheelRect = (x: number, y: number, rotDeg: number, ww: number, wh: number, fill: string) => (
          <rect
            key={`w${x}_${y}`}
            x={-ww / 2}
            y={-wh / 2}
            width={ww}
            height={wh}
            rx={0.5}
            fill={fill}
            stroke={stroke}
            strokeWidth={0.25}
            transform={`translate(${x} ${y}) rotate(${rotDeg})`}
          />
        );
        if (spec.drivetrain === 'swerve') {
          return corners.flatMap(([x, y]) => [
            <rect key={`h${x}_${y}`} x={x - 2.6} y={y - 2.6} width={5.2} height={5.2} rx={1} fill="#0c1016" stroke={accent} strokeWidth={0.3} />,
            wheelRect(x, y, 0, wheelW, wheelH, '#1b212b'),
            <line key={`t${x}_${y}`} x1={x} y1={y} x2={x} y2={y - 2.4} stroke={accent} strokeWidth={0.5} />,
          ]);
        }
        if (spec.drivetrain === 'xdrive') {
          const long = Math.min(Math.hypot(wx, wy) * 1.1, 7.2);
          return corners.map(([x, y]) => wheelRect(x, y, x * y >= 0 ? 45 : -45, 2.0, long, '#2b333e'));
        }
        // MECANUM (and BUTTERFLY, which shows its mecanum set — the half it spawns on):
        // rollers at 45°, ALTERNATING by diagonal so they read as an X. Same rule as the
        // in-game renderer: the alternation is what makes the lateral components add instead
        // of cancel, i.e. what makes strafing possible. The preview maps robot (x,y) →
        // screen (−y,−x), which preserves the sign of the product, so the very same
        // `x * y >= 0` test picks the two diagonals here too.
        const rollered = spec.drivetrain === 'mecanum' || spec.drivetrain === 'butterfly';
        return corners.flatMap(([x, y]) => {
          const base = wheelRect(x, y, 0, wheelW, wheelH, '#0c151d');
          if (!rollered) return [base];
          const s = x * y >= 0 ? 1 : -1;
          const h = wheelW / 2;
          return [
            base,
            ...[-0.8, 0, 0.8].map((o) => (
              <line
                key={`r${x}_${y}_${o}`}
                x1={x - h}
                y1={y + o - s * h}
                x2={x + h}
                y2={y + o + s * h}
                stroke={stroke}
                strokeWidth={0.22}
                opacity={0.75}
              />
            )),
          ];
        });
      })()}

      {/* front indicator (a chevron at the front edge) */}
      <polyline
        points={`${-w * 0.18},${frontY + 1.6} 0,${frontY + 0.4} ${w * 0.18},${frontY + 1.6}`}
        fill="none"
        stroke={accent}
        strokeWidth={0.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* the launcher — drawn after the deck so a top-mounted turret sits over what it is bolted
          to, exactly as the sprite draws it */}
      {launcherEl}

      {/* the Box Tube and its placement point, if this build has one */}
      {liftEl}

      {/* dimension label */}
      <text
        x={0}
        y={labelY}
        textAnchor="middle"
        fill="var(--ds-mut)"
        fontSize={DIM_FONT}
        fontFamily="var(--ds-font-mono)"
      >
        {dimLabel}
      </text>
    </svg>
  );
}
