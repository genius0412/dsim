import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Alliance, RobotSpec, World } from '../types';
import type { GameId } from '../games/types';
import type { GameScene, SceneInsets, ScenePose } from '../games/module';
import { moduleFor } from '../games';
import { getViewPref } from '../games/biobuzz/graphics/store';
import { DEFAULT_ASSISTS } from '../sim/spawn';

/**
 * THE MENU STAGE (owner, 2026-10-18: "make the DSIM page something similar" to MoSim's) — the field
 * behind Home and Play. App mounts it behind the shell for both screens, so going Home → Play is a
 * change of `view` and not a remount, and that is what lets the camera FLY from the high
 * audience-corner shot down to the player's robot.
 *
 * Two renderings, one contract:
 * - **3D** (BIOBUZZ): the match's own scene (`createBiobuzzScene`, lazy), drawn through a
 *   host-placed camera (`SceneFrame.pose`). It draws on demand, not every frame: nothing on the
 *   field moves, so it renders while the camera moves and once more when a late asset lands.
 * - **2D** (DECODE, Chain Reaction, and BIOBUZZ wherever 3D cannot run): the game's own 2D field,
 *   drawn once and tilted in CSS. Play zooms the tilt; the robot is the page's own 2D preview.
 *
 * Nothing here steps a world. Owner rulings in `docs/area/ui.md`, "THE MENU STAGE".
 */

export type StageView = 'home' | 'setup';

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

/** fly time, Home ↔ Play (owner: "about 1 second"); zero under reduced motion */
const FLY_MS = 1000;
/** the orbit's drift back to the showcase angle after a drag, as a half-life */
const ORBIT_RETURN_S = 0.35;

// ── the showcase (BIOBUZZ field inches: +x audience right, +y away from the audience, z up) ──
// ponytail: hand-placed and tuned from screenshots; a game with its own 3D field adds its own row.
const SHOW = { x: -48, y: 30, heading: -Math.PI / 2 + 0.6 };
const POSES: Record<StageView, ScenePose> = {
  // high over the audience-LEFT corner, looking diagonally across the field (MoSim's shot)
  home: { eye: [-175, -205, 150], target: [10, 20, 0], fovDeg: 38 },
  // low in front of the robot, the rear wall and the stands behind it
  setup: {
    eye: [SHOW.x + 14, SHOW.y - 46, 22],
    target: [SHOW.x, SHOW.y, 7],
    fovDeg: 34,
  },
};

/** where the page's own chrome sits, so the camera frames the field / robot in what is left. READ
 * OFF THE PAGE: Play's free area is `.ds-setup-view` itself, Home's is everything right of the
 * column. The estimates are for the frame before the page has laid out. On a phone the stage is
 * only the band above the column, so nothing covers it. */
function insetsFor(view: StageView, w: number, h: number): SceneInsets {
  if (w < 720) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (view === 'home') {
    const col = document.querySelector('.ds-home')?.getBoundingClientRect();
    return {
      top: 0,
      right: 0,
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
  return (
    <div className={`ds-stage ${view}`} aria-hidden="true">
      {use3d ? (
        <Stage3d game={game} view={view} spec={spec} alliance={alliance} onFail={() => setUse3d(false)} />
      ) : (
        <Stage2d game={game} view={view} />
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
}: {
  game: GameId;
  view: StageView;
  spec: RobotSpec;
  alliance: Alliance;
  onFail(): void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  // the live inputs, read by the frame loop without restarting it
  const live = useRef({ view, spec, alliance, onFail });
  live.current = { view, spec, alliance, onFail };
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
      // the robot leaves only once the camera is back up (it would vanish mid-flight otherwise)
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
        pose: drawn,
      });
      if (moving || orbit.held || dropRobotAt) kick();
      else lastT = 0;
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
        dpr: Math.min(window.devicePixelRatio || 1, 2),
      };
      scene?.resize(size.w, size.h, size.dpr);
      kick();
      // and once more after the resize settles: the one frame drawn in the resize could be shown BLANK
      // (measured offscreen, 2026-10-18 — the next draw, or any restyle, brought the field back)
      clearTimeout(settle);
      settle = window.setTimeout(kick, 150);
    };
    let settle = 0;
    const ro = new ResizeObserver(resize);

    robotOn = live.current.view === 'setup';
    buildWorld();
    load()
      .then((factory) => factory(host, { interactive: false }))
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
        // a photographed venue or an imported robot's mesh lands after the first frame
        if (world) void s.assetsSettled?.(world).then(kick);
      })
      .catch(() => {
        if (!dead) live.current.onFail();
      });

    return () => {
      dead = true;
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

/** the 2D field's canvas size in CSS px (`.ds-stage-2d canvas` states it too); the tilt scales it */
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
  return <div className={`ds-stage-2d ${view}`}>{src && <img src={src} alt="" />}</div>;
}
