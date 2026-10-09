import { useEffect, useMemo, useRef } from 'react';
import type { RobotSpec, RobotState } from '../types';
import * as C from '../config';
import { coerceSpec, createWorld, DEFAULT_ASSISTS } from '../sim/spawn';
import { DEFAULT_SPEC } from '../sim/specDefaults';
import { footprintExtents } from '../sim/field';
import { polyBounds } from '../sim/imported';
import { drawRobot } from '../render/drawRobot';
import { clampCosmetics } from '../cosmetics';
import { useImportedAssetVersion } from './useImportedAssets';
import { importedFootprintLabel } from './FootprintSvg';

/** clear space around the robot, as a fraction of its longest side */
const PAD = 0.16;
/** the caption's type size in CSS px */
const DIM_FONT = 11;

/**
 * ONE template robot per document, and each preview puts its own build into it.
 *
 * ⚠️ `createWorld` is NOT cheap for a picture: seating robot 0 runs the G304 start-pose search
 * (`snapStartToLegal`), measured at ~30 ms a call and 126 ms of a 152 ms long task on entering
 * Configure ▸ Robot with the hero and three saved cards (2026-09-23). The preview then throws the
 * pose away — position, heading, turret and hopper are all overridden below — so the only thing
 * the build changes in the template is `spec`, which is coerced exactly as `createWorld` would.
 */
let template: RobotState | null = null;
function previewRobot(spec: RobotSpec): RobotState {
  template ??= createWorld('match', 1, [
    { id: 0, alliance: 'blue', spec: DEFAULT_SPEC, assists: { ...DEFAULT_ASSISTS }, startIndex: 0 },
  ]).robots[0];
  return { ...template, spec: coerceSpec(spec) };
}

/**
 * The builder's robot preview — THE REAL SPRITE, not a drawing of one.
 *
 * This used to be a hand-written SVG schematic of the spec: a second implementation
 * of the same robot, in a different technology, maintained by hand. It drifted, which
 * is the only thing two drawings of one object ever do — reported as "the hero robot
 * looks way too different from the actual robot in the field". So it now renders
 * `drawRobot`, the exact function the match uses, from a real `RobotState` built by
 * `createWorld`. Change the sprite and this changes with it, because it IS the sprite.
 *
 * ON THE DARK GROUND, deliberately. The old schematic used `--ds-panel` and themed with
 * the app, and its comment explained why it could not use the chassis colour: every
 * `CHASSIS_COLORS` value is tuned for the hardcoded-dark field, and painting one on a
 * light panel produced the fill-vs-text collision `shell.css` warns about. Drawing the
 * mat here instead of a themed panel answers that at the root — the sprite is in the
 * environment it was designed for, so it needs no translation, and the supporter
 * chassis colour becomes previewable for the first time.
 *
 * NO ALLIANCE. A robot in the builder is not red or blue, so the outline is the
 * app's own accent rather than a side you have not chosen yet — read from
 * `--ds-on-field-accent` so the stylesheet stays the one source of truth.
 *
 * ⚠️ THE ON-FIELD ACCENT, NOT `--ds-accent`. Those are different colours: the plain
 * accent INVERTS with the theme (#366758 light, #5fb597 dark) because it is meant to
 * read against a themed panel, and its light value on this hardcoded-dark mat is
 * almost invisible. `--ds-on-field-accent` is the same mint in both themes, tuned for
 * exactly this ground — see the THEMING note in CLAUDE.md for the three categories.
 */
export function RobotPreview({
  spec,
  size = 200,
  caption = true,
}: {
  spec: RobotSpec;
  size?: number;
  /** print the `18" wide · 15" long` line under the robot. The builder hero turns it off: at the
   * hero's 88px it rendered at 5px, and the hero states the size in its own stat grid. */
  caption?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // a real RobotState — turret, wheels, hopper and all (`previewRobot`). Rebuilt only when
  // the BUILD changes; the spec object identity churns on every keystroke in the name field.
  const key = specKey(spec);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tpl: RobotState = useMemo(() => previewRobot(spec), [key]);
  // an IMPORT's top-down picture decodes AFTER the first draw — this moves when it lands, and the
  // draw effect below re-runs on it (the match canvas redraws every frame and needs no such hook)
  const assets = useImportedAssetVersion(spec.imported?.id);

  const fx = footprintExtents(spec);
  // NOSE UP: the robot is drawn at heading +90°, so its forward axis (+x in the robot
  // frame) maps to world +y, which the camera's y-flip puts at the top of the canvas.
  const worldW = fx.half * 2;
  const worldH = fx.front + fx.rear;
  const pad = Math.max(worldW, worldH) * PAD;
  const boxW = worldW + pad * 2;
  const boxH = worldH + pad * 2;
  const height = Math.round(size * (boxH / boxW));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);
    // the field's own ground, so the sprite renders in the environment it is tuned for
    ctx.fillStyle = C.COLORS.mat;
    ctx.fillRect(0, 0, size, height);

    // camera: fit the footprint, +y up, world inches → css px
    const s = Math.min(size / boxW, height / boxH);
    ctx.translate(size / 2, height / 2);
    ctx.scale(s, -s);
    // the chassis origin is not the footprint's centre when an intake extends one end
    ctx.translate(0, -(fx.front - fx.rear) / 2);

    const robot: RobotState = {
      ...tpl,
      pos: { x: 0, y: 0 },
      heading: Math.PI / 2,
      // straight ahead: a turret slewed at some goal it cannot see reads as a fault
      turretHeading: Math.PI / 2,
      // EMPTY. `createWorld` hands robot 0 the match PRELOAD, and `drawRobot` rings
      // the turret in artifact green while the hopper has anything in it — so the
      // builder was previewing a robot mid-match, with a second green that had
      // nothing to do with the chassis. You are configuring a robot here, not a
      // loaded one; the ring draws its empty grey instead.
      hopper: [],
    };
    drawRobot(ctx, robot, false, [], undefined, undefined, onFieldAccent());
    ctx.restore();

    if (!caption) return;
    // the caption, in SCREEN space — inside the flipped camera it would be mirrored
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.font = `600 ${DIM_FONT}px ui-monospace, monospace`;
    ctx.fillStyle = C.COLORS.white;
    ctx.globalAlpha = 0.75;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    // an import's size is its hull's (its `length` is a clamped parametric mirror)
    const hb = spec.imported ? polyBounds(spec.imported.hull) : null;
    const dims = hb
      ? `${(hb.maxY - hb.minY).toFixed(1)}" wide · ${(hb.maxX - hb.minX).toFixed(1)}" long`
      : `${spec.width}" wide · ${spec.length}" long`;
    ctx.fillText(dims, size / 2, height - 6);
    ctx.restore();
  }, [tpl, spec, size, height, boxW, boxH, fx.front, fx.rear, caption, assets]);

  return (
    <canvas
      ref={canvasRef}
      className="ds-robot-sprite"
      style={{ width: size, height }}
      role="img"
      aria-label={spec.imported ? importedFootprintLabel(spec.imported) : `${spec.width} by ${spec.length} inch robot, ${spec.intake === 'none' ? 'no intake' : `${spec.intake} intake`}`}
    />
  );
}

/**
 * The app's accent as the canvas should draw it.
 *
 * Read from the stylesheet rather than copied into `config.ts`, so the preview
 * follows the palette instead of drifting from it the way the old SVG schematic did.
 * The literal is the fallback for a context with no computed style (a test renderer,
 * or a canvas built before the sheet lands) — it is the token's own value, not a
 * second opinion about what the accent should be.
 */
function onFieldAccent(): string {
  if (typeof getComputedStyle !== 'function') return '#5fb597';
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue('--ds-on-field-accent')
    .trim();
  return v || '#5fb597';
}

/** the BUILD, not the identity: renaming a robot must not respawn a world */
function specKey(s: RobotSpec): string {
  const cosm = clampCosmetics(s);
  return [
    s.length, s.width, s.intake, s.drivetrain, s.driveRpm,
    s.massLb, s.flywheelInertia, s.canSort, s.chassisColor,
    cosm.accent, cosm.decal, cosm.plate,
    // an imported robot's descriptor (hull, wheels, mechanism placements) is its geometry
    s.imported ? JSON.stringify(s.imported) : '',
  ].join('|');
}
