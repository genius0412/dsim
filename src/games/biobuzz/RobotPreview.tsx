import type { RobotSpec } from '../../types';
import { WHEEL_INSET } from '../../config';
import {
  BB_HOOD_DEFAULT_DEG,
  BB_LAUNCH_LINE_FRAC,
  BB_LAUNCH_PLATE_GAP,
  BB_LAUNCH_PLATE_OVERHANG,
  BB_POLLEN_R,
  BB_TWIN_BARREL_OFFSET,
} from './config';
import { bbLauncherOf, bbLiftOf } from './mechs';
import { BB_LIFT_MAST_R, bbLiftMastLocal } from './parts';
import { EDGE_ANGLE, bbMouthFrame, bbShooterEdgeOf, edgeGeom, turretLocal, turretRadius } from './mounts';
import { bbFootprint, bbMouths } from './robot';

/** dimension-label type size, in the viewBox's inch units */
const DIM_FONT = 1.7;

/**
 * Top-down schematic of a BIOBUZZ robot drawn straight from its `RobotSpec` — the live preview
 * in the My Robot builder. Front faces UP (screen −y). Everything is in inches inside the
 * viewBox so the drawing scales with the real chassis/intake dimensions, and colours reference
 * the `ds-*` design tokens so it themes with the app.
 *
 * Copied and owned from `games/chain/RobotPreview.tsx` with the catalyst mechanism deleted —
 * BIOBUZZ has no second manipulator, so there is no arm/claw/rail/launcher branch, and with it
 * goes the corner-protrusion arithmetic the viewBox needed to keep a claw tip on screen.
 *
 * ── IT DRAWS FROM THE SIM'S OWN GEOMETRY ───────────────────────────────────
 * The mouths come from `bbMouths` and the viewBox extents from `bbFootprint` — the same two
 * functions the canvas sprite and the capture test use. The preview and the in-match sprite are
 * therefore the same mechanism drawn twice, not two drawings kept in sync by hand. That is the
 * whole reason `robot.ts` exists as a contract surface, and the item-4 archetype sheets put
 * the two side by side precisely so a divergence is visible rather than inferred.
 *
 * Purely presentational: it reads the spec and nothing else — no world, no clock, no state.
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
  // THE MECHANISM LOADOUT (`docs/biobuzz/plan-mechanisms.md`) — a build may carry a LAUNCHER, a
  // LIFT, both, or neither. `bbLauncherOf`/`bbLiftOf` (`mechs.ts`) are the one place that reads
  // `spec.bbMech`, safe to call on the RAW spec this live builder preview is handed (the same
  // reason `footprintExtents` calls `bbLauncherOf` rather than reading `spec.scoreMode` cold):
  // a launcher-less build (Studica's StarterBot) must draw NOTHING here, and `scoreMode` alone
  // cannot say that — the shared coercer defaults it on every spec, launcher or not.
  const launcher = bbLauncherOf(spec, BB_HOOD_DEFAULT_DEG);
  const lift = bbLiftOf(spec);

  // viewBox spans the widest of chassis/intake plus a margin, kept square-ish. The dimension
  // label is centred and can be WIDER than a narrow chassis, so it has to be measured in too —
  // an <svg> clips to its viewport, and a 14.5"-wide robot would otherwise lop the ends off
  // `17" wide · 15" long`.
  const dimLabel = `${w}" wide · ${len}" long`;
  const labelHalf = (dimLabel.length * DIM_FONT * 0.56) / 2; // ~0.56em avg advance
  const halfSpan = Math.max(w / 2, half, labelHalf) + 2.5;
  const top = tipY - 2;
  // The label clears whatever hangs off the BACK — a rear or front+back sweeper. It used to sit
  // at the chassis half-length, so a rear mount printed the dimensions over its own rollers.
  const labelY = rearY + 2.6;
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

  // BIOBUZZ archetype launcher: drum = one cylinder along the mounted edge; dumper = a tray on
  // a pivot; turret/twinturret = ring + flywheel plates (top-mounted, so they ignore the
  // firing edge and use the mount POSITION instead). Drum/dumper are authored along robot +x
  // and rotated onto their mounted edge, so a left/right mount spans the chassis LENGTH —
  // matching how `bbLaunch` spreads the shot.
  //
  // Geometry is keyed off `launcher`'s OWN resolved mount when this build has one, rather than
  // `spec.shooterMount` read cold: on a live, not-yet-coerced builder spec the two can disagree
  // (`bbLauncherOf` is `mechs.ts`'s one migration/validation authority for the field), and
  // falling back to `spec` itself when there is no launcher costs nothing — every value below
  // goes unused the moment `launcherEl` resolves to `null`.
  const mountSpec = launcher
    ? { ...spec, shooterMount: launcher.mount, shooterRear: launcher.mount === 'back' }
    : spec;
  const sEdge = bbShooterEdgeOf(mountSpec); // drum/dumper fire over a SIDE, never a corner
  const sGeom = edgeGeom(mountSpec, sEdge);
  // where a TURRET is bolted (it aims itself, so its mount is a position, not a facing)
  const tOrigin = turretLocal(mountSpec); // the SAME point the sim launches from
  const tR = turretRadius(mountSpec); // ...and the same ring size
  const teeth = Math.max(14, Math.round(tR * 6)); // slew-ring teeth, as in the sprite
  // THE DRUM is ONE CYLINDER across (almost) the whole mounted edge on a single shaft — not a
  // row of separate wheels, which is a different machine. Bearing blocks at both ends, and
  // traction bands wrapped along its length.
  const drumHalf = sGeom.span * 0.9;
  const drumDia = 3.3;
  const drumX = sGeom.dist - drumDia / 2 - 0.55; // its axis, just inside the frame line
  const drumRings = Math.max(4, Math.round((drumHalf * 2) / 2.1));
  const lineHalf = sGeom.span * BB_LAUNCH_LINE_FRAC; // dumper tray width
  const dumpPivot = sGeom.dist - 7.4;
  const dumpLip = sGeom.dist - 0.9;
  // `launcher === null` (a real, shipping launcher-less build — Studica's StarterBot publishes
  // none) draws NOTHING here: no ring, no plates, no barrel. That absence is the point, not a
  // fallback — see the file header.
  const launcherEl = !launcher
    ? null
    : launcher.kind === 'drum' ? (
      <g transform={`${ROBOT_FRAME} rotate(${deg(EDGE_ANGLE[sEdge])})`}>
        {/* the HOOD a POLLEN is pinched against, behind the barrel */}
        <rect
          x={drumX - drumDia / 2 - 1.15}
          y={-drumHalf - 0.5}
          width={1.15}
          height={(drumHalf + 0.5) * 2}
          rx={0.35}
          fill={stroke}
          opacity={0.55}
        />
        <rect
          x={drumX - drumDia / 2}
          y={-drumHalf}
          width={drumDia}
          height={drumHalf * 2}
          rx={drumDia * 0.34}
          fill="var(--ds-bg)"
          stroke={stroke}
          strokeWidth={0.3}
        />
        {Array.from({ length: drumRings - 1 }, (_, i) => {
          const y = -drumHalf + ((i + 1) * (drumHalf * 2)) / drumRings;
          return (
            <line
              key={i}
              x1={drumX - drumDia / 2 + 0.22}
              y1={y}
              x2={drumX + drumDia / 2 - 0.22}
              y2={y}
              stroke={stroke}
              strokeWidth={0.16}
              opacity={0.85}
            />
          );
        })}
        {[1, -1].map((sg) => (
          <g key={sg}>
            <rect
              x={drumX - 0.95}
              y={sg > 0 ? drumHalf : -drumHalf - 1.5}
              width={1.9}
              height={1.5}
              rx={0.3}
              fill={stroke}
              opacity={0.8}
            />
            <circle cx={drumX} cy={sg * (drumHalf + 0.72)} r={0.42} fill={stroke} />
          </g>
        ))}
      </g>
    ) : launcher.kind === 'dumper' ? (
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
    ) : (
      // The turret sits where it is BOLTED. Authored in SCREEN space (unlike the chassis-frame
      // groups above), so the robot-frame offset is mapped by hand: ROBOT_FRAME sends robot
      // (x,y) → screen (−y,−x). Radius is the SIM's `turretRadius`, so a corner turret can
      // never hang off the chassis here while sitting comfortably inboard in the match.
      <g transform={`translate(${-tOrigin.y},${-tOrigin.x})`}>
        {/* the SLEW RING it turns on, toothed like the sprite's */}
        <circle cx={0} cy={0} r={tR} fill="var(--ds-bg)" stroke={stroke} strokeWidth={0.35} />
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
        {/* the FEED HOLE a POLLEN rises through, dead centre on the turret axis — the reason
            the launcher straddles the ring instead of hanging off one side of it */}
        <circle cx={0} cy={0} r={BB_POLLEN_R + 0.15} fill="var(--ds-bg)" stroke={stroke} strokeWidth={0.2} />
        {/* THE SHOOTER HEAD: two parallel PLATES with a flywheel between them, no barrel — the
            gap is left empty because that gap is what reads as the POLLEN's path, and it is
            `BB_LAUNCH_PLATE_GAP` wide because a 3" POLLEN has to fit down it. A TWIN draws both
            channels at the offsets the sim launches from. The preview shows the turret stowed
            forward, so the head points UP. */}
        {(launcher.kind === 'twinturret' ? [BB_TWIN_BARREL_OFFSET, -BB_TWIN_BARREL_OFFSET] : [0]).map((o) => {
          const gap = BB_LAUNCH_PLATE_GAP;
          const plate = 0.42;
          // CENTRED on the ring: a POLLEN is fed up the hole in the MIDDLE of the turret, so
          // the plates straddle that axis. Front is up here, so the muzzle is −y.
          const y0 = tR + BB_LAUNCH_PLATE_OVERHANG; // plate rear
          const y1 = -y0; // ...and the muzzle end
          const wheelY = -tR * 0.6; // the flywheel: past the feed hole, before the muzzle
          return (
            <g key={o}>
              {[1, -1].map((sg) => (
                <rect
                  key={sg}
                  x={o + sg * (gap / 2) - (sg > 0 ? 0 : plate)}
                  y={y1}
                  width={plate}
                  height={y0 - y1}
                  rx={0.16}
                  fill={stroke}
                  opacity={0.85}
                />
              ))}
              {/* standoffs: what says "two plates and a gap", not one solid block */}
              {[0.12, 0.92].map((f) => {
                const y = y0 + (y1 - y0) * f;
                return (
                  <line key={f} x1={o - gap / 2} y1={y} x2={o + gap / 2} y2={y} stroke={stroke} strokeWidth={0.2} opacity={0.7} />
                );
              })}
              {/* the flywheel on its axle, spanning the gap */}
              <rect
                x={o - gap / 2 + 0.1}
                y={wheelY - 0.75}
                width={gap - 0.2}
                height={1.5}
                rx={0.4}
                fill="var(--ds-bg)"
                stroke={stroke}
                strokeWidth={0.22}
              />
              <line x1={o - gap / 2 + 0.15} y1={y1 + 0.3} x2={o + gap / 2 - 0.15} y2={y1 + 0.3} stroke={accent} strokeWidth={0.3} />
            </g>
          );
        })}
      </g>
    );

  /**
   * THE LIFT — a vertical extension slide's mast, in SVG. A build with `lift !== null` gets a
   * bolted COLLAR at `bbLiftMastLocal` (`parts.ts`, the SAME shared point the in-match sprite
   * draws its mast at) plus a small STOWED carriage marker. Stowed, and only ever stowed: this
   * preview reads a `RobotSpec`, not a `RobotState`, so there is no `bbLiftZ` to grow the
   * carriage from — that live reading is the in-match sprite's job (`drawRobot.ts`). Authored in
   * SCREEN space, exactly like the turret above, because `bbLiftMastLocal`'s point is a ROBOT
   * frame offset that has to be hand-mapped the same way: `ROBOT_FRAME` sends robot (x,y) to
   * screen (−y,−x).
   */
  const liftEl = !lift
    ? null
    : (() => {
        const local = bbLiftMastLocal(spec, lift.mount);
        const mastR = BB_LIFT_MAST_R;
        return (
          <g transform={`translate(${-local.y},${-local.x})`}>
            <rect
              x={-mastR}
              y={-mastR}
              width={mastR * 2}
              height={mastR * 2}
              rx={mastR * 0.3}
              fill="var(--ds-bg)"
              stroke={stroke}
              strokeWidth={0.3}
            />
            {[1, -1].flatMap((sx) =>
              [1, -1].map((sy) => (
                <circle key={`${sx}_${sy}`} cx={sx * (mastR - 0.4)} cy={sy * (mastR - 0.4)} r={0.22} fill={stroke} />
              )),
            )}
            {/* the carriage, STOWED — see the note above on why this preview never grows it */}
            <rect
              x={-mastR * 0.28}
              y={-mastR * 0.28}
              width={mastR * 0.56}
              height={mastR * 0.56}
              rx={mastR * 0.1}
              fill={stroke}
              opacity={0.5}
            />
          </g>
        );
      })();

  return (
    <svg
      width={fluid ? '100%' : size}
      height={fluid ? undefined : (size * vbH) / vbW}
      // a fluid svg needs the intrinsic ratio to keep its height; a sized one already has both
      preserveAspectRatio="xMidYMid meet"
      style={fluid ? { display: 'block', aspectRatio: `${vbW} / ${vbH}` } : undefined}
      viewBox={`${-halfSpan} ${top} ${vbW} ${vbH}`}
      role="img"
      aria-label={`${spec.width} by ${spec.length} inch robot, sweeper intake${
        launcher ? `, ${launcher.kind} scorer` : ', no launcher'
      }${lift ? ', vertical lift' : ''}`}
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

      {/* scoring mechanism — the BIOBUZZ archetype launcher. Drawn LAST so a top-mounted
          turret sits over the deck it is bolted to, exactly as the sprite draws it. `null` for
          a real launcher-less build. */}
      {launcherEl}

      {/* the LIFT mast, if this build has one — independent of the launcher slot above, so a
          build can show both, either, or neither. */}
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
