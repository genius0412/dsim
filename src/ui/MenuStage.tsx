import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Alliance, RobotSpec, World } from '../types';
import type { GameId } from '../games/types';
import type { GameScene, SceneInsets, ScenePose } from '../games/module';
import { moduleFor } from '../games';
import { getViewPref } from '../games/biobuzz/graphics/store';
import { getGraphics } from '../games/biobuzz/graphics/settings';
import { DEFAULT_ASSISTS } from '../sim/spawn';
import { POSES, SHOW, type StageView } from './menuStagePoses';

/**
 * THE MENU STAGE (owner, 2026-10-18: "make the DSIM page something similar" to MoSim's) — the field
 * behind Home and Play. App mounts it behind the shell for both screens, so going Home → Play is a
 * change of `view` and not a remount, and that is what lets the camera FLY from the
 * audience-corner shot down to the player's robot. The poses are in `menuStagePoses.ts`.
 *
 * Two renderings, one contract:
 * - **3D** (BIOBUZZ): the match's own scene (`createBiobuzzScene`, lazy), drawn through a
 *   host-placed camera (`SceneFrame.pose`). It draws on demand, not every frame: nothing on the
 *   field moves, so it renders while the camera moves and once more when a late asset lands.
 *   ⚠️ AT ITS OWN FIXED TIER AND IN ITS OWN ROOM, not the player's match settings (2026-11-01,
 *   owner: Home "still distorted and EXTREMELY laggy on some devices"): see `STAGE_ROOM`.
 * - **2D** (DECODE, Chain Reaction, and BIOBUZZ wherever 3D cannot run): the game's own 2D field,
 *   drawn once and shown FLAT, top-down, the way those games are played; the robot is the page's
 *   own 2D preview.
 *
 * Nothing here steps a world. Owner rulings in `docs/area/ui.md`, "THE MENU STAGE".
 */

export type { StageView };

/**
 * A PHONE'S HOME HAS NO STAGE (owner, 2026-10-18: "restore that page, only that page, to the
 * original one"): it is the pre-stage Home, in the normal shell. The breakpoint is shell.css's phone
 * block. Play keeps its stage on a phone.
 */
const PHONE = '(max-width: 720px)';
export function usePhone(): boolean {
  return useSyncExternalStore(
    (f) => {
      const m = window.matchMedia(PHONE);
      m.addEventListener('change', f);
      return () => m.removeEventListener('change', f);
    },
    () => window.matchMedia(PHONE).matches,
  );
}
type StageMode = '2d' | '3d';

/**
 * THE STAGE'S ROOM AND TIER (2026-11-01). The stage used to draw at the player's own graphics
 * settings, and on a machine Auto had put on High or above that meant the photographed events hall
 * (4k backdrop plus layers, ~45 MB of textures), MSAA 4x, soft or max shadows, reflections, and on
 * Extreme a 150 % supersampled target with SSAO, all of it for a menu. Two problems came with it:
 *  - DISTORTED. A photographed venue is exact only near its lens, and Home's camera is 150 in up at
 *    the corner: the floor around the field drew blurred and the window light smeared across it.
 *    The procedural rooms are geometry, so they are right from every eye. The arena is the darkest
 *    of them, which is what lets the field and the column's scrim read.
 *  - LAGGY. Every fly frame and every orbit drag paid the match's full cost, and Home's own load
 *    (the backdrop decode and upload, the post chain's shaders) stalled the page on a weak GPU. And
 *    the scene's quality governor measured MENU frames and could step the player's stored tier.
 * Medium is MSAA 2x, low shadows and no post. A device whose own tier is Low gets Low. A fixed tier
 * also measures without deciding, so the menu no longer touches the match settings.
 */
const STAGE_ROOM = 'arena';
const stageTier = (): 'low' | 'medium' => (getGraphics().tier === 'low' ? 'low' : 'medium');
/** the stage's device-pixel cap: a menu backdrop at 2x on a 4K panel was 8 MP a frame */
const STAGE_MAX_DPR = 1.5;

/** fly time, Home ↔ Play (owner: "about 1 second"); zero under reduced motion */
const FLY_MS = 1000;
/** the orbit's drift back to the showcase angle after a drag, as a half-life */
const ORBIT_RETURN_S = 0.35;

/** where the page's own chrome sits, so the camera frames the field / robot in what is left. READ
 * OFF THE PAGE: Play's free area is `.ds-setup-view` itself, Home's is everything right of the
 * column. The estimates are for the frame before the page has laid out. On a phone the stage is
 * only the band above the column, so nothing covers it. */
/**
 * A TALL FREE AREA KEEPS THE POSE'S WIDTH (2026-11-01). The poses' FOV is vertical and was set on
 * landscape windows; the scene fits it to the free area (`setViewOffset`), so a portrait tablet's
 * free area (820x1180: ~300px beside Home's column, ~460 beside Play's) narrowed the horizontal view
 * and cut the field and the robot off at the sides. Under `STAGE_MIN_ASPECT` the vertical FOV widens
 * until the horizontal view is what that aspect would show.
 */
const STAGE_MIN_ASPECT = 1.5;
function fitFov(fovDeg: number, w: number, h: number, ins: SceneInsets): number {
  const aspect = Math.max(0.2, (w - ins.left - ins.right) / Math.max(1, h - ins.top - ins.bottom));
  if (aspect >= STAGE_MIN_ASPECT) return fovDeg;
  const halfH = Math.atan((Math.tan((fovDeg * Math.PI) / 360) * STAGE_MIN_ASPECT) / aspect);
  return Math.min(100, (halfH * 360) / Math.PI);
}

function insetsFor(view: StageView, w: number, h: number): SceneInsets {
  if (w < 720) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (view === 'home') {
    const col = document.querySelector('.ds-home')?.getBoundingClientRect();
    // past --ds-wide-max the page keeps to a centred band (shell.css), and the field frames in it
    const wide = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ds-wide-max')) || Infinity;
    // A PORTRAIT WINDOW puts the column on top (shell.css), and the field below it, clear of the
    // scrim's fade and the footer
    if (col && h > w) return { top: col.bottom + 72, right: 0, bottom: 48, left: 0 };
    return {
      top: 0,
      right: Math.max(0, (w - wide) / 2),
      bottom: 0,
      left: col ? col.right + 24 : Math.min(520, w * 0.4),
    };
  }
  const viewEl = document.querySelector<HTMLElement>('.ds-setup-view');
  const free = viewEl?.getBoundingClientRect();
  if (viewEl && free && free.width > 0)
    return {
      top: free.top,
      right: w - free.right,
      bottom: h - free.bottom,
      // its CONTENT box: the rejoin / tutorial cards pad its left edge, and the robot frames beside them
      left: free.left + (parseFloat(getComputedStyle(viewEl).paddingLeft) || 0),
    };
  return {
    top: 63,
    right: Math.min(440, w * 0.36),
    bottom: Math.min(360, h * 0.45),
    left: 0,
  };
}

// ── the stage's mode, for the page (it draws the 2D robot itself when the stage is 2D) ──────────
let mode: StageMode = '2d';
const modeListeners = new Set<() => void>();
function setMode(m: StageMode): void {
  if (m === mode) return;
  mode = m;
  modeListeners.forEach((f) => f());
}
export function useStageMode(): StageMode {
  return useSyncExternalStore(
    (f) => {
      modeListeners.add(f);
      return () => modeListeners.delete(f);
    },
    () => mode,
  );
}

// ── drag to orbit. The stage is BEHIND the shell, so the page owns the drag surface (the free area
// over the robot) and forwards it here. ────────────────────────────────────────────────────────
let orbitSink: { drag(dx: number, dy: number): void; release(): void } | null = null;
export const stageOrbit = {
  drag: (dx: number, dy: number): void => orbitSink?.drag(dx, dy),
  release: (): void => orbitSink?.release(),
};

const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const mix3 = (a: readonly number[], b: readonly number[], t: number): [number, number, number] => [
  mix(a[0], b[0], t),
  mix(a[1], b[1], t),
  mix(a[2], b[2], t),
];
const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** can this device show the 3D stage for `game`? The player's own 2D view choice and a phone both say no. */
function wants3d(game: GameId): boolean {
  if (!moduleFor(game).scene) return false;
  if (getViewPref() !== '3d') return false;
  return !window.matchMedia('(max-width: 640px) and (pointer: coarse)').matches;
}

/** the world on the stage: the field set for a match, plus the player's robot at the showcase */
function stageWorld(game: GameId, spec: RobotSpec | null, alliance: Alliance, physics: '2d' | '3d'): World {
  const setups = spec
    ? [
        {
          id: 0,
          alliance,
          spec,
          assists: { ...DEFAULT_ASSISTS },
          startIndex: 0,
        },
      ]
    : [];
  const w = moduleFor(game).createWorld('match', 1, setups, undefined, physics);
  const r = w.robots[0];
  if (r) {
    r.pos = { x: SHOW.x, y: SHOW.y };
    r.heading = SHOW.heading;
  }
  return w;
}

export function MenuStage({
  game,
  view,
  spec,
  alliance,
}: {
  game: GameId;
  view: StageView;
  spec: RobotSpec;
  alliance: Alliance;
}) {
  const [use3d, setUse3d] = useState(() => wants3d(game));
  useEffect(() => setUse3d(wants3d(game)), [game]);
  useEffect(() => setMode(use3d ? '3d' : '2d'), [use3d]);
  /**
   * THE 2D FIELD HOLDS THE PLACE UNTIL THE 3D ONE IS IN (2026-11-02). The 3D scene boots on idle and
   * then fetches its chunk and the field (~0.9 MB) and compiles its shaders: 1.3 s on a fast line
   * and 8 s on Slow 4G before it began its fade, and the stage was an empty dark backdrop all that
   * time, on Home's first load and again on every return from a match. The game's own flat field is
   * drawn under it at once (the same picture a 2D device gets), and is dropped once the 3D has faded
   * over it.
   */
  const [covered, setCovered] = useState(false);
  useEffect(() => setCovered(false), [game, use3d]);
  return (
    <div className={`ds-stage ${view}`} aria-hidden="true">
      {(!use3d || !covered) && <Stage2d game={game} view={view} />}
      {use3d && (
        <Stage3d
          game={game}
          view={view}
          spec={spec}
          alliance={alliance}
          onFail={() => setUse3d(false)}
          onCovered={() => setCovered(true)}
        />
      )}
    </div>
  );
}

function Stage3d({
  game,
  view,
  spec,
  alliance,
  onFail,
  onCovered,
}: {
  game: GameId;
  view: StageView;
  spec: RobotSpec;
  alliance: Alliance;
  onFail(): void;
  /** the scene has faded in over the 2D placeholder, which can go */
  onCovered(): void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  // the live inputs, read by the frame loop without restarting it
  const live = useRef({ view, spec, alliance, onFail, onCovered });
  live.current = { view, spec, alliance, onFail, onCovered };
  /** the loop's handle on the running scene: set a new target, rebuild the world */
  const ctl = useRef<{ fly(): void; rebuild(): void } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    const load = moduleFor(game).scene;
    if (!host || !load) return;
    let dead = false;
    let scene: GameScene | null = null;
    let raf = 0;
    let world: World | null = null;
    let robotOn = false;
    let size = { w: 1, h: 1, dpr: 1 };
    // the camera as drawn, and the fly in progress
    let pose: ScenePose = POSES[live.current.view];
    let ins: SceneInsets = { top: 0, right: 0, bottom: 0, left: 0 };
    let fly: {
      from: ScenePose;
      fromIns: SceneInsets;
      t0: number;
      ms: number;
    } | null = null;
    let orbit = { yaw: 0, pitch: 0, held: false };
    let lastT = 0;
    let dropRobotAt = 0;
    let wasAnimating = false;
    let settle = 0;
    let covered = 0;
    const onFaded = (e: TransitionEvent): void => {
      if (e.target === host && e.propertyName === 'opacity') live.current.onCovered();
    };

    const buildWorld = (): void => {
      const { spec, alliance } = live.current;
      world = stageWorld(game, robotOn ? spec : null, alliance, '3d');
    };

    const frame = (now: number): void => {
      raf = 0;
      if (dead || !scene || !world) return;
      const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0;
      lastT = now;
      const target = POSES[live.current.view];
      const targetIns = insetsFor(live.current.view, size.w, size.h);
      let moving = false;
      if (fly) {
        const t = fly.ms > 0 ? Math.min(1, (now - fly.t0) / fly.ms) : 1;
        const k = ease(t);
        pose = {
          eye: mix3(fly.from.eye, target.eye, k),
          target: mix3(fly.from.target, target.target, k),
          fovDeg: mix(fly.from.fovDeg, target.fovDeg, k),
        };
        ins = {
          top: mix(fly.fromIns.top, targetIns.top, k),
          right: mix(fly.fromIns.right, targetIns.right, k),
          bottom: mix(fly.fromIns.bottom, targetIns.bottom, k),
          left: mix(fly.fromIns.left, targetIns.left, k),
        };
        if (t >= 1) fly = null;
        else moving = true;
      } else {
        pose = target;
        ins = targetIns;
      }
      // the robot leaves only once the camera is back (it would vanish mid-flight otherwise)
      if (robotOn && dropRobotAt && now >= dropRobotAt) {
        robotOn = false;
        dropRobotAt = 0;
        buildWorld();
      }
      // the orbit, around the showcase target, drifting back once let go
      if (!orbit.held && (orbit.yaw || orbit.pitch)) {
        const k = reducedMotion() ? 1 : 1 - Math.pow(2, -dt / ORBIT_RETURN_S);
        orbit.yaw -= orbit.yaw * k;
        orbit.pitch -= orbit.pitch * k;
        if (Math.abs(orbit.yaw) < 1e-3 && Math.abs(orbit.pitch) < 1e-3) orbit = { yaw: 0, pitch: 0, held: false };
        else moving = true;
      }
      let drawn = pose;
      if (orbit.yaw || orbit.pitch) {
        const [tx, ty, tz] = pose.target;
        const dx = pose.eye[0] - tx;
        const dy = pose.eye[1] - ty;
        const dz = pose.eye[2] - tz;
        const flat = Math.hypot(dx, dy);
        const r = Math.hypot(flat, dz);
        const yaw = Math.atan2(dy, dx) + orbit.yaw;
        const elev = Math.max(0.05, Math.min(1.3, Math.atan2(dz, flat) + orbit.pitch));
        drawn = {
          ...pose,
          eye: [
            tx + Math.cos(yaw) * Math.cos(elev) * r,
            ty + Math.sin(yaw) * Math.cos(elev) * r,
            tz + Math.sin(elev) * r,
          ],
        };
      }
      scene.render(world, {
        alpha: 1,
        viewAngle: 0,
        camera: 'free',
        width: size.w,
        height: size.h,
        dpr: size.dpr,
        insets: ins,
        pose: { ...drawn, fovDeg: fitFov(drawn.fovDeg, size.w, size.h, ins) },
      });
      const animating = moving || orbit.held || !!dropRobotAt;
      if (animating) kick();
      else {
        lastT = 0;
        // THE RESTING POSE IS DRAWN ONCE MORE after a move ends: Low caps the frame rate, and a render
        // that lands inside the cap's interval is skipped, which left the camera a frame short of
        // where the fly ended
        if (wasAnimating) {
          clearTimeout(settle);
          settle = window.setTimeout(kick, 50);
        }
      }
      wasAnimating = animating;
    };
    const kick = (): void => {
      if (!raf && !dead) raf = requestAnimationFrame(frame);
    };

    ctl.current = {
      fly() {
        const v = live.current.view;
        fly = {
          from: pose,
          fromIns: ins,
          t0: performance.now(),
          ms: reducedMotion() ? 0 : FLY_MS,
        };
        if (v === 'setup') {
          dropRobotAt = 0;
          if (!robotOn) {
            robotOn = true;
            buildWorld();
          }
        } else if (robotOn) {
          dropRobotAt = performance.now() + fly.ms;
        }
        kick();
      },
      rebuild() {
        buildWorld();
        kick();
      },
    };
    orbitSink = {
      drag(dx, dy) {
        if (live.current.view !== 'setup') return;
        orbit.held = true;
        orbit.yaw -= dx * 0.008;
        orbit.pitch += dy * 0.006;
        kick();
      },
      release() {
        orbit.held = false;
        kick();
      },
    };

    const resize = (): void => {
      const r = host.getBoundingClientRect();
      size = {
        w: Math.max(1, r.width),
        h: Math.max(1, r.height),
        dpr: Math.min(window.devicePixelRatio || 1, STAGE_MAX_DPR),
      };
      scene?.resize(size.w, size.h, size.dpr);
      kick();
      // and once more after the resize settles: the one frame drawn in the resize could be shown BLANK
      // (measured offscreen, 2026-10-18 — the next draw, or any restyle, brought the field back)
      clearTimeout(settle);
      settle = window.setTimeout(kick, 150);
    };
    const ro = new ResizeObserver(resize);

    robotOn = live.current.view === 'setup';
    buildWorld();
    // THE PAGE FIRST, THE FIELD WHEN THE BROWSER IS IDLE: the scene's chunk, the field's meshes and
    // the shader compile are a few hundred ms of main thread on a weak machine, and Home's keycaps
    // should answer before they run. The 2D field is under it until it has faded in (`covered`).
    const boot = (): Promise<void> =>
      load()
        .then((factory) => factory(host, { interactive: false, quality: stageTier(), environment: STAGE_ROOM }))
        .then((s) => {
          if (dead) {
            s.dispose();
            return;
          }
          scene = s;
          // A LOST CONTEXT DRAWS NOTHING AND THROWS NOTHING (`watchContextLoss`): the stage goes to its
          // 2D field, the way a match goes to its 2D view, instead of showing an empty backdrop
          s.element.addEventListener('webglcontextlost', () => live.current.onFail(), { once: true });
          ro.observe(host);
          resize();
          frame(performance.now());
          setShown(true);
          // the 2D field goes when the fade has ENDED, not on a timer: the scene's first frame is often
          // followed by a long task, and a timer could fire before the fade had begun. None under reduced
          // motion (no transition); the timeout only covers a fade that never reports.
          host.addEventListener('transitionend', onFaded);
          covered = window.setTimeout(() => live.current.onCovered(), reducedMotion() ? 0 : 3000);
          // an imported robot's mesh lands after the first frame
          if (world) void s.assetsSettled?.(world).then(kick);
        })
        .catch(() => {
          if (!dead) live.current.onFail();
        });
    const start = (): void => {
      if (!dead) void boot();
    };
    const idle =
      typeof window.requestIdleCallback === 'function'
        ? window.requestIdleCallback(start, { timeout: 1200 })
        : window.setTimeout(start, 200);

    return () => {
      dead = true;
      if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idle);
      else clearTimeout(idle);
      clearTimeout(settle);
      clearTimeout(covered);
      host.removeEventListener('transitionend', onFaded);
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      orbitSink = null;
      ctl.current = null;
      scene?.dispose();
      host.replaceChildren();
    };
  }, [game]);

  // a new view flies; a new robot or alliance rebuilds the world under the same camera
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    ctl.current?.fly();
  }, [view]);
  useEffect(() => ctl.current?.rebuild(), [spec, alliance]);

  return <div ref={hostRef} className={`ds-stage-3d${shown ? ' shown' : ''}`} />;
}

/** the 2D field's drawn size in CSS px; `.ds-stage-2d img` scales it to the free area */
const FIELD_PX = 900;

function Stage2d({ game, view }: { game: GameId; view: StageView }) {
  const [src, setSrc] = useState<string | null>(null);
  // the field is static, so it is drawn ONCE into a detached canvas and shown as an image: a canvas
  // left in the page went blank after any window resize (measured offscreen, 2026-10-18 — pixels still
  // in it, nothing on screen, redrawing did not bring it back), and an image did not
  useEffect(() => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const mod = moduleFor(game);
    const world = stageWorld(game, null, 'blue', '2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = FIELD_PX * dpr;
    canvas.height = FIELD_PX * dpr;
    const span = Math.max(mod.bounds.halfX, mod.bounds.halfY) * 2 * 1.04;
    const s = FIELD_PX / span;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(FIELD_PX / 2, FIELD_PX / 2);
    ctx.scale(s, -s);
    const up = { x: 0, y: 1 };
    mod.drawField(ctx, world, up);
    mod.drawOverlays?.(ctx, world);
    mod.drawBalls(ctx, world, up);
    let url: string | null = null;
    let dead = false;
    canvas.toBlob((b) => {
      if (!b || dead) return;
      url = URL.createObjectURL(b);
      setSrc(url);
    });
    return () => {
      dead = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [game]);
  // keyed on the picture, so a new game's field fades in (`ds-screen-in`) rather than swapping
  return <div className={`ds-stage-2d ${view}`}>{src && <img key={src} src={src} alt="" />}</div>;
}
