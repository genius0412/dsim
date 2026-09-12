import { COLORS, ENDGAME_START } from '../config';
import type { Camera } from '../render/camera';
import type { FieldBounds } from '../games/types';
import type { Alliance, World } from '../types';
import { SPONSOR, sponsorActive, sponsorLogoWidth } from '../sponsor';

/**
 * THE SCOREBOARD, BURNED INTO A REPLAY VIDEO.
 *
 * The viewer's scoreboard is React DOM sitting ABOVE the canvas (`.ds-replay-score`), and the
 * video is a capture of the canvas — so the export had no score in it at all, and no sign of
 * when the match started or what it finished. On screen that split is invisible, because the
 * page supplies the half the canvas does not; in a file that leaves a match nobody can read.
 * A video is also the one export that outlives the sim (`replayRefusal` retires the container,
 * never the recording), so it is exactly the artifact that has to stand on its own.
 *
 * IT NEVER COVERS THE FIELD, and the camera's reserved bands are not enough to promise that.
 * `HUD_BOTTOM` shrinks to 4px on a compact or short layout, and the field is centred in what
 * is left, so how much clear space sits under it depends on the viewer's aspect ratio — on
 * some it is generous and on others the field runs straight into the bar. So the caller asks
 * `fieldScreenBottom` where the field actually ENDS and gives the frame `HUD_RESERVE` more
 * height when there is not already room. Extra letterbox costs nothing; a scoreboard sitting
 * on top of the match costs the match.
 *
 * ⚠️ IT SETS ITS OWN TRANSFORM, and must. `Renderer.render` leaves the context in FIELD
 * INCHES — translated, scaled and rotated by the driver's view angle — so an overlay that
 * assumed CSS pixels drew its scoreboard somewhere off in the field's coordinate space and
 * produced a video with nothing on it at all. Working in CSS units (`Camera.w`/`Camera.h`
 * scaled by `dpr`) is also what keeps the bar the same SIZE relative to the field at every
 * encode resolution, instead of shrinking as the pixels go up.
 */

const BAR_H = 64;
const PAD = 18;
/** CSS pixels the bar needs BELOW the field: its own height plus breathing room */
export const HUD_RESERVE = BAR_H + 20;

/**
 * How far down the screen the field reaches, in CSS pixels.
 *
 * The camera maps world inches to the screen through the driver's view angle, so this is the
 * only honest way to ask: the answer depends on the alliance, the game's bounds (CR's goals
 * protrude), and how the fit landed. Taking the max over the four corners covers every
 * rotation without caring which one is which.
 */
export function fieldScreenBottom(camera: Camera, bounds: FieldBounds): number {
  const { halfX: hx, halfY: hy } = bounds;
  const corners = [
    { x: -hx, y: -hy },
    { x: hx, y: -hy },
    { x: hx, y: hy },
    { x: -hx, y: hy },
  ];
  return Math.max(...corners.map((c) => camera.worldToScreen(c).y));
}
/**
 * The bar is CENTRED and capped, not stretched edge to edge.
 *
 * The field is square and the frame is not, so a wide layout letterboxes it with a lot of
 * empty backdrop — and a full-width bar puts the two scores out at the far corners of the
 * video with the clock marooned between them, reading as three unrelated things rather than
 * as one scoreboard. Capped, it sits under the field at about the field's own width.
 */
const BAR_MAX_W = 760;

const FONT = 'system-ui, sans-serif';
const mmss = (sec: number): string => {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** everything the bar says in words — pulled out of the drawing so it can be tested without
 *  a canvas, since this is where the decisions are (endgame, a tie, a solo run) */
export interface HudLabels {
  /** the phase, in the words the bar shows */
  phase: string;
  /** time left in the phase, or null once the match is over */
  clock: string | null;
  /** who won, or null while it is still being played — and for a solo run, which has no
   *  opponent to have beaten */
  result: string | null;
}

/**
 * What the middle of the bar says.
 *
 * ENDGAME is split out of teleop the way the live HUD splits it — it is a different thing to
 * be watching, and a recording that never marked it would lose the moment the match changes
 * character. A TIE says so rather than leaving two equal numbers to be compared by eye.
 */
export function hudLabels(world: World, solo: Alliance | null): HudLabels {
  const m = world.match;
  if (m.phase === 'post') {
    const r = m.scores.red.total;
    const b = m.scores.blue.total;
    return {
      phase: 'FINAL',
      clock: null,
      result: solo ? null : r === b ? 'TIE' : r > b ? 'RED WINS' : 'BLUE WINS',
    };
  }
  const phase =
    m.phase === 'pre'
      ? 'PRE-MATCH'
      : m.phase === 'auto'
        ? 'AUTONOMOUS'
        : m.phase === 'transition'
          ? 'TRANSITION'
          : m.phase === 'teleop'
            ? m.phaseTimeLeft <= ENDGAME_START
              ? 'END GAME'
              : 'DRIVER-CONTROLLED'
            : 'FREE DRIVE';
  return { phase, clock: mmss(m.phaseTimeLeft), result: null };
}

/** a rounded rect, because the score blocks read as chips rather than as bare fills */
function chip(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

/**
 * The pre-match lead-in, over the middle of the field.
 *
 * "MATCH BEGINS IN" before the digits is the same product rule the live HUD follows — a number
 * counting down on its own does not say what it is counting down to. `preCountdown` is the
 * sim's own field, so a replay reproduces the lead-in exactly rather than approximating it.
 */
function drawCountdown(ctx: CanvasRenderingContext2D, world: World, w: number, fieldH: number): void {
  const left = world.match.preCountdown;
  if (left == null || left <= 0) return;
  const cx = w / 2;
  // centred on the FIELD, not on the frame: the frame can be taller than the field to make
  // room for the bar, and a countdown drifting toward the scoreboard reads as misaligned
  const cy = fieldH / 2;
  const h = fieldH;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = COLORS.white;
  ctx.globalAlpha = 0.85;
  ctx.font = `700 ${Math.round(h * 0.035)}px ${FONT}`;
  ctx.fillText('MATCH BEGINS IN', cx, cy - h * 0.09);
  ctx.globalAlpha = 1;
  ctx.font = `700 ${Math.round(h * 0.18)}px ${FONT}`;
  ctx.fillText(String(Math.ceil(left)), cx, cy + h * 0.02);
}

/* ----------------------------------------------- the sponsor's burn-in ---- */

/** logo height in CSS pixels, and the plate that carries it */
const MARK_H = 20;
const MARK_PAD = 8;
const MARK_LABEL = 'PRESENTED BY';
const MARK_LABEL_H = 10;

/**
 * THE SPONSOR'S MARK, BAKED INTO THE FILE.
 *
 * The scoreboard above exists because a video is the one export that outlives the
 * sim; the same sentence is why the presenting sponsor is in it. A clip posted to
 * Discord or YouTube carries this after the patch that produced it is gone, and
 * there is no version of the export that can be configured to leave it out —
 * which is precisely what "burned in" was bought to mean.
 *
 * ⚠️ THE IMAGE MUST ALREADY BE DECODED. `recordFast`'s `draw` callback is
 * synchronous — it is called once per simulated tick with no chance to await — so
 * an `Image` that has not finished loading draws nothing at all and the mark is
 * silently missing from the file. `loadSponsorMark()` below is what the caller
 * awaits BEFORE the capture starts, and the text fallback is what happens if that
 * ever fails. An absent mark is the one outcome this must not have.
 */
let markImg: HTMLImageElement | null = null;
let markReady = false;

/**
 * Decode the sponsor artwork, once. Resolves either way — a decode failure is not
 * a reason to refuse someone their replay, it is a reason to burn the words
 * instead of the logo. Safe to call repeatedly; safe to call when the sponsorship
 * is not live, in which case it does nothing.
 */
export async function loadSponsorMark(): Promise<void> {
  if (markReady || !sponsorActive() || typeof Image === 'undefined') return;
  if (!markImg) {
    /**
     * ⚠️ THE ARTWORK IS IMPORTED DYNAMICALLY, AND IT HAS TO BE. This module is
     * imported by `scripts/smoke.ts` (for `hudLabels`), which runs under `tsx`
     * with no bundler — a top-level `import … from './sponsorAssets'` made the
     * whole suite die with `ERR_UNKNOWN_FILE_EXTENSION: .svg` before a single
     * check ran. The `typeof Image` guard above is what keeps this line from ever
     * being reached headlessly, so the split is real and not just tidiness.
     */
    const { SPONSOR_LOGO_DARK } = await import('./sponsorAssets');
    markImg = new Image();
    // the asset is same-origin (bundled), but the capture canvas is read back as a
    // blob — an image that ever tainted it would fail the export rather than the
    // logo, so the request is explicitly anonymous.
    markImg.crossOrigin = 'anonymous';
    markImg.src = SPONSOR_LOGO_DARK;
  }
  try {
    await markImg.decode();
    markReady = true;
  } catch {
    markReady = false; // the text path takes over
  }
}

/**
 * Draw the mark into the TOP-RIGHT of the frame — the same corner the live chip
 * occupies during play, so a clip is framed like the game it came from rather than
 * like a different product. The plate is the scoreboard's own fill: on a field
 * that is hardcoded dark this is what makes small type and a light-ink logo read
 * at YouTube's compression, and reusing it keeps the two burned-in elements
 * looking like one overlay.
 */
function drawSponsorMark(ctx: CanvasRenderingContext2D, w: number): void {
  if (!sponsorActive()) return;
  const logoW = sponsorLogoWidth(MARK_H);
  const boxW = logoW + MARK_PAD * 2;
  const boxH = MARK_LABEL_H + MARK_H + MARK_PAD * 2;
  const x = w - PAD - boxW;
  const y = PAD;

  ctx.fillStyle = 'rgba(18,21,26,0.86)';
  chip(ctx, x, y, boxW, boxH, 8);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(229,231,235,0.62)';
  ctx.font = `700 ${MARK_LABEL_H - 2}px ${FONT}`;
  ctx.fillText(MARK_LABEL, x + boxW / 2, y + MARK_PAD + MARK_LABEL_H / 2);

  const logoY = y + MARK_PAD + MARK_LABEL_H;
  if (markReady && markImg) {
    ctx.drawImage(markImg, x + MARK_PAD, logoY, logoW, MARK_H);
    return;
  }
  // FALLBACK: the artwork never decoded. The sponsor's NAME still ships — a file
  // with the words in it honours the placement; a file with a gap in it does not.
  ctx.fillStyle = COLORS.white;
  ctx.font = `800 ${Math.round(MARK_H * 0.62)}px ${FONT}`;
  ctx.fillText(SPONSOR.name.toUpperCase(), x + boxW / 2, logoY + MARK_H / 2);
}

/**
 * Draw the live scoreboard (and, at the end, the final one) for `world`.
 *
 * `solo` names the single alliance of a RECORD run, whose opponent never existed — printing a
 * "0" for it would read as a shutout, which is the same reason the viewer collapses to one
 * score. Null means an ordinary two-alliance match.
 */
export function drawReplayHud(
  ctx: CanvasRenderingContext2D,
  world: World,
  view: {
    width: number;
    height: number;
    dpr: number;
    /** where the field ends, so the countdown stays centred on it */
    fieldHeight: number;
    solo: Alliance | null;
  },
): void {
  const { width: w, height: h, solo } = view;
  const m = world.match;
  const labels = hudLabels(world, solo);
  const done = m.phase === 'post';
  const y = h - BAR_H - 10;
  const barW = Math.min(w - PAD * 2, BAR_MAX_W);
  const barX = (w - barW) / 2;

  ctx.save();
  // back to CSS pixels — `render` left this in field inches (see the note above)
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);

  // a dark plate so the type reads over whatever the field happens to be behind it. The field
  // is hardcoded dark (see the THEME note in CLAUDE.md), so this never themes either.
  ctx.fillStyle = 'rgba(18,21,26,0.86)';
  chip(ctx, barX, y, barW, BAR_H, 10);

  ctx.textBaseline = 'middle';
  const midY = y + BAR_H / 2;
  const scoreFont = `700 ${Math.round(BAR_H * 0.46)}px ${FONT}`;
  const labelFont = `700 ${Math.round(BAR_H * 0.19)}px ${FONT}`;

  const side = (alliance: Alliance, x: number, align: 'left' | 'right'): void => {
    const dir = align === 'left' ? 1 : -1;
    ctx.textAlign = align;
    ctx.fillStyle = alliance === 'red' ? COLORS.red : COLORS.blue;
    ctx.font = labelFont;
    ctx.fillText(alliance.toUpperCase(), x, midY - BAR_H * 0.19);
    ctx.font = scoreFont;
    ctx.fillStyle = COLORS.white;
    ctx.fillText(String(m.scores[alliance].total), x + dir * 2, midY + BAR_H * 0.12);
  };

  if (solo) {
    side(solo, barX + 26, 'left');
  } else {
    side('red', barX + 26, 'left');
    side('blue', barX + barW - 26, 'right');
  }

  // the middle: what phase it is and how long is left in it — or the result, once there is one
  ctx.textAlign = 'center';
  ctx.fillStyle = done ? COLORS.white : 'rgba(229,231,235,0.62)';
  ctx.font = labelFont;
  ctx.fillText(labels.phase, w / 2, midY - BAR_H * 0.19);
  if (labels.clock) {
    ctx.font = `700 ${Math.round(BAR_H * 0.34)}px ${FONT}`;
    ctx.fillStyle = COLORS.white;
    ctx.fillText(labels.clock, w / 2, midY + BAR_H * 0.14);
  } else if (labels.result) {
    ctx.font = `700 ${Math.round(BAR_H * 0.24)}px ${FONT}`;
    const r = m.scores.red.total;
    const b = m.scores.blue.total;
    ctx.fillStyle = r === b ? COLORS.white : r > b ? COLORS.red : COLORS.blue;
    ctx.fillText(labels.result, w / 2, midY + BAR_H * 0.16);
  }

  drawCountdown(ctx, world, w, view.fieldHeight);
  // last, so nothing the scoreboard draws can land on top of it
  drawSponsorMark(ctx, w);
  ctx.restore();
}
