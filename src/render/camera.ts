import type { Alliance, Vec2 } from '../types';
import { FIELD_HALF, VIEW_MARGIN } from '../config';
import { viewAngleOf } from '../sim/field';
import { rot } from '../math';

/** field-frame <-> screen transform, including the alliance 180° rotation so
 * each driver sees their own goal at the top */
export class Camera {
  w = 0; // CSS pixels
  h = 0;
  dpr = 1;
  scale = 1; // px per inch
  viewAngle = 0;

  configure(canvas: HTMLCanvasElement, alliance: Alliance): void {
    this.dpr = window.devicePixelRatio || 1;
    this.w = canvas.clientWidth;
    this.h = canvas.clientHeight;
    canvas.width = Math.round(this.w * this.dpr);
    canvas.height = Math.round(this.h * this.dpr);
    const span = 2 * (FIELD_HALF + VIEW_MARGIN);
    this.scale = Math.min(this.w / span, this.h / span);
    // view from the driver's alliance wall (blue = right wall, red = left)
    this.viewAngle = viewAngleOf(alliance);
  }

  /** set the canvas transform so draw calls use field inches */
  apply(ctx: CanvasRenderingContext2D): void {
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.translate(this.w / 2, this.h / 2);
    ctx.scale(this.scale, -this.scale);
    ctx.rotate(this.viewAngle);
  }

  worldToScreen(p: Vec2): Vec2 {
    const r = rot(p, this.viewAngle);
    return { x: this.w / 2 + r.x * this.scale, y: this.h / 2 - r.y * this.scale };
  }

  /** world-space direction that points "up" on the driver's screen */
  screenUpWorld(): Vec2 {
    return rot({ x: 0, y: 1 }, -this.viewAngle);
  }
}
