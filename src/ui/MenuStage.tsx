import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Alliance, RobotSpec, World } from '../types';
import type { GameId } from '../games/types';
import type { GameScene, SceneInsets, ScenePose } from '../games/module';
import { moduleFor } from '../games';
import { getViewPref } from '../games/biobuzz/graphics/store';
import { DEFAULT_ASSISTS } from '../sim/spawn';
import { POSES, SHOW, STAGE_SEED, type StageView } from './menuStagePoses';
import { afterBootLeave, bootCovering, holdBoot } from './screenFade';

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
 *   AT THE PLAYER'S OWN GRAPHICS, room included (owner, 2026-11-04): see `tunesTier` below.
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
 * THE STAGE DRAWS AT THE PLAYER'S GRAPHICS (owner, 2026-11-04: "the home/play menu's render should
 * match the graphics selected by the user"): their tier, room, shadows, AA, element detail, render
 * scale and the device's full pixel ratio, and it follows a change to them. From 2026-11-01 to
 * 2026-11-04 it drew at its own Medium tier in the procedural arena, capped at 1.5 dpr, after Home was
 * "still distorted and EXTREMELY laggy on some devices"; that ruling is reversed. The distortion was
 * the photographed venues, retired on 2026-11-04; the cost comes back with the player's choice: the
 * first load and every fly frame pay the player's match cost. What stays: the scene draws on demand, boots on idle, shows no perf
 * overlay, and `tunesTier: false` keeps menu frames from stepping the player's stored tier.
 */

/** fly time, Home ↔ Play (owner: "about 1 second"); zero under reduced motion */
const FLY_MS = 1000;

/**
 * ONE REVEAL (2026-11-04, owner: "there is a loading screen, but then there is another loading
 * animation for the field, and even when the field shows up, the background scene shows up even
 * later"). Measured cold (`npm run firstload`, High, 1920×1080): the stage faded in on its FIRST
 * frame and the modeled room swapped in 0.3 s (full speed) to 1.7 s (CPU ×6) after it, in front of
 * the player. Now the stage draws hidden and shows once it is WHOLE: field, robot, the room its
 * graphics ask for and its light (`assetsSettled`), every program linked. On the first load the boot
 * screen waits for that (`holdBoot`, capped by `HOLD_MAX_MS`) with the stage already at full opacity
 * under it, so the boot screen's own fade is the one reveal. Past the cap the stage shows what it has
 * as the boot screen leaves; on a later mount (back from a match) it waits `PARTIAL_WAIT_MS` after its
 * field. Either way a room that lands after that CROSSFADES in (`crossfade`), never pops.
 */
const PARTIAL_WAIT_MS = 2000;
/** a forced draw keeps this far from the last one, past every frame cap (Low's 60 fps is 16 ms) */
const DRAW_GAP_MS = 60;

/**
 * IS THE CAMERA FLYING? Work that would land inside the fly waits for it (App's match warm-up: the
 * 3D physics chunk's evaluation was a 60–120 ms task in the middle of the first fly at CPU ×4–×6).
 */
let flying = false;
const restWaiters: (() => void)[] = [];
function setFlying(f: boolean): void {
  flying = f;
  if (!f) restWaiters.splice(0).forEach((r) => r());
}
/** resolves once the menu stage's camera is not flying (at once when it is not, or there is no stage) */
export function stageAtRest(): Promise<void> {
  return flying ? new Promise<void>((r) => restWaiters.push(r)) : Promise.resolve();
}
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
/**
 * THE TALLEST BOX PLAY'S CAMERA FRAMES THE ROBOT IN (2026-11-02). The FOV is vertical, so the robot
 * grows with the robot's space's HEIGHT, and since that space is the page's full height (the garage
 * rail, shell.css) a 3440x1300 window drew it ~500px tall beside 420px panels. Past this the extra
 * height is left above and below it.
 */
const SETUP_FRAME_MAX_H = 840;
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
  const extra = free ? Math.max(0, (free.height - SETUP_FRAME_MAX_H) / 2) : 0;
  if (viewEl && free && free.width > 0)
    return {
      top: free.top + extra,
      right: w - free.right,
      bottom: h - free.bottom + extra,
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

/**
 * the world on the stage: the field set for a match and come to rest, plus the player's robot at
 * the showcase. The stage never steps it, so the game moves what a match's first second of physics
 * would (`restMenuWorld`): BIOBUZZ's hive NECTAR floated 7.9 in above its cell floor without it.
 */
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
  const mod = moduleFor(game);
  const w = mod.createWorld('match', STAGE_SEED, setups, undefined, physics);
  const r = w.robots[0];
  if (r) {
    r.pos = { x: SHOW.x, y: SHOW.y };
    r.heading = SHOW.heading;
  }
  mod.restMenuWorld?.(w);
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
   * WHILE THE 3D STAGE LOADS (2026-11-02). The scene boots on idle, then fetches its chunk, the field
   * (~0.9 MB) and its room, and compiles its shaders, on an empty dark backdrop. On the first load the
   * boot screen stays up until the stage is whole (`holdBoot`, capped; ONE REVEAL above), so Home
   * appears once, whole. Past the cap, and after a match, a loading bar sits where the field will be.
   * NOT the game's 2D field: drawn under the 3D as a placeholder, it was a second picture of the field
   * that the 3D replaced a second later (owner: "the 2d field for a split second").
   */
  const [ready3d, setReady3d] = useState(false);
  useEffect(() => setReady3d(false), [game, use3d]);
  return (
    <div className={`ds-stage ${view}`} aria-hidden="true">
      {use3d ? (
        <Stage3d
          game={game}
          view={view}
          spec={spec}
          alliance={alliance}
          onFail={() => setUse3d(false)}
          onShown={() => setReady3d(true)}
        />
      ) : (
        <Stage2d game={game} view={view} />
      )}
      {use3d && !ready3d && <StageWait view={view} />}
    </div>
  );
}

/**
 * THE 3D FIELD IS STILL LOADING: the boot screen's bar, centred in the free area the camera will
 * frame (`insetsFor`, the scene's own). CSS shows it only after 600 ms, so a quick load never draws it.
 */
function StageWait({ view }: { view: StageView }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const host = el?.parentElement;
    if (!el || !host) return;
    const place = (): void => {
      const r = host.getBoundingClientRect();
      const ins = insetsFor(view, r.width, r.height);
      el.style.left = `${(ins.left + r.width - ins.right) / 2}px`;
      el.style.top = `${(ins.top + r.height - ins.bottom) / 2}px`;
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [view]);
  return (
    <span ref={ref} className="ds-stage-wait">
      <span />
    </span>
  );
}

function Stage3d({
  game,
  view,
  spec,
  alliance,
  onFail,
  onShown,
}: {
  game: GameId;
  view: StageView;
  spec: RobotSpec;
  alliance: Alliance;
  onFail(): void;
  /** the scene is shown (ONE REVEAL): at once under the boot screen, or fading in */
  onShown(): void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const veilRef = useRef<HTMLCanvasElement>(null);
  /** '' hidden; 'now' shown at once (under the boot screen, whose fade is the reveal); 'fade' fading in */
  const [shown, setShown] = useState<'' | 'now' | 'fade'>('');
  // the live inputs, read by the frame loop without restarting it
  const live = useRef({ view, spec, alliance, onFail, onShown });
  live.current = { view, spec, alliance, onFail, onShown };
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
    let wasAnimating = false;
    let settle = 0;
    // when the last frame was drawn (a forced draw keeps `DRAW_GAP_MS` from it), and the fly's target
    // insets, read ONCE per fly: `insetsFor` reads the page's layout, and in the first fly that was a
    // forced layout in every frame while Play's new page was still settling
    let lastDraw = -Infinity;
    let flyIns: SceneInsets | null = null;
    // ONE REVEAL (above): the first load's boot screen waits for the whole stage (or its failure)
    const underBoot = bootCovering();
    const releaseBoot = holdBoot();
    let fieldDrawn = false;
    let revealed = false;
    let partialTimer = 0;
    /** a room that landed after the reveal, waiting for the camera to rest (`crossfade`) */
    let pendingSwap: (() => void) | null = null;
    let veilTimer = 0;

    /**
     * THE ROBOT IS ON THE FIELD ON HOME TOO (owner, 2026-11-03: "so that it doesn't just suddenly appear
     * and disappear"). It joined the world when the fly to Play began and left when the camera was back,
     * so it popped in at the start of one fly and out at the end of the other. Now the camera flies to
     * the robot standing where it was all along.
     */
    const buildWorld = (): void => {
      const { spec, alliance } = live.current;
      world = stageWorld(game, spec, alliance, '3d');
      settleAssets();
    };
    /**
     * DRAW AGAIN ONCE AN IMPORTED ROBOT'S MESH HAS LANDED. The stage draws on demand, not every frame,
     * so a mesh still parsing when its world was built left the robot on its outline until something
     * else redrew: picking an import on Play, and an import joining for the fly, showed the outline
     * until the player picked another robot and came back (owner, 2026-11-02). `assetsSettled` never
     * rejects; the kick redraws whatever world is current by then.
     */
    function settleAssets(): void {
      const w = world;
      if (scene && w) void scene.assetsSettled?.(w).then(() => {
        if (!dead) kick();
      });
    }

    const frame = (now: number): void => {
      raf = 0;
      if (dead || !scene || !world) return;
      const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0;
      lastT = now;
      const target = POSES[live.current.view];
      let targetIns: SceneInsets;
      if (fly) targetIns = flyIns ??= insetsFor(live.current.view, size.w, size.h);
      else {
        flyIns = null;
        targetIns = insetsFor(live.current.view, size.w, size.h);
      }
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
        if (t >= 1) {
          fly = null;
          setFlying(false);
        } else moving = true;
      } else {
        pose = target;
        ins = targetIns;
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
        // nothing on the stage's field ever moves: a world it handed over is never changed (a new
        // robot is a new world), so the scene keeps the sun's shadow map between frames
        still: true,
      });
      lastDraw = performance.now();
      const animating = moving || orbit.held;
      if (animating) kick();
      else {
        lastT = 0;
        // THE RESTING POSE IS DRAWN ONCE MORE after a move ends: Low caps the frame rate, and a render
        // that lands inside the cap's interval is skipped, which left the camera a frame short of
        // where the fly ended
        if (wasAnimating) {
          clearTimeout(settle);
          settle = window.setTimeout(kick, 50);
          // a room that landed during the move goes in now that the camera rests
          if (pendingSwap) crossfade();
        }
      }
      wasAnimating = animating;
    };
    /** draw the current pose now, cancelling a queued frame */
    function drawNow(): void {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      frame(performance.now());
    }
    /** draw now, at least `DRAW_GAP_MS` after the last draw so no frame cap skips it, then `f` */
    function drawThen(f: () => void): void {
      if (dead) return;
      const wait = lastDraw + DRAW_GAP_MS - performance.now();
      if (wait > 0) {
        window.setTimeout(() => drawThen(f), wait);
        return;
      }
      drawNow();
      f();
    }
    function reveal(kind: 'whole' | 'partial'): void {
      if (revealed || dead) return;
      revealed = true;
      clearTimeout(partialTimer);
      performance.mark?.(`dsim:stage-${kind}`);
      // under the boot screen the stage is there at once: the boot screen's own fade is the reveal
      setShown(bootCovering() ? 'now' : 'fade');
      live.current.onShown();
      releaseBoot();
    }
    /** short of whole: show what there is once the boot screen has gone (the first load), or
     * `PARTIAL_WAIT_MS` after the field (a later mount) */
    function partial(): void {
      if (revealed || dead || !fieldDrawn) return;
      if (underBoot) {
        if (!bootCovering()) drawThen(() => reveal('partial'));
        return;
      }
      if (!partialTimer) partialTimer = window.setTimeout(() => drawThen(() => reveal('partial')), PARTIAL_WAIT_MS);
    }
    /** `SceneOptions.onLateSwap`: a room that lands while the stage is hidden goes in at once (it is
     * then part of the one reveal); after the reveal it crossfades */
    const onLateSwap = (commit: () => void): void => {
      if (dead || !revealed) return commit();
      // an older room still waiting goes first (stale by now, it only frees itself)
      pendingSwap?.();
      pendingSwap = commit;
      crossfade();
    };
    const inMotion = (): boolean => !!fly || orbit.held || !!orbit.yaw || !!orbit.pitch;
    /**
     * A ROOM THAT LANDS AFTER THE REVEAL FADES IN. The last frame is copied onto the veil (a canvas
     * over the scene's, read in the task that drew it, before the browser clears it), the room goes
     * in under it, the next frame is drawn, and the veil fades out over `--ds-dur-fly`. Only at rest:
     * a moving camera under a frozen copy would smear, so a room that lands mid-move waits for the
     * move's end (`frame`).
     */
    function crossfade(): void {
      const veil = veilRef.current;
      const s = scene;
      if (!pendingSwap || dead || !s || inMotion()) return;
      const commit = pendingSwap;
      if (!veil || reducedMotion()) {
        pendingSwap = null;
        commit();
        kick();
        return;
      }
      drawThen(() => {
        if (pendingSwap !== commit || dead || inMotion()) return;
        pendingSwap = null;
        veil.width = s.element.width;
        veil.height = s.element.height;
        veil.getContext('2d')?.drawImage(s.element, 0, 0);
        clearTimeout(veilTimer);
        veil.classList.remove('out');
        veil.hidden = false;
        commit();
        drawThen(() =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              veil.classList.add('out');
              veilTimer = window.setTimeout(() => {
                veil.hidden = true;
                veil.classList.remove('out');
                veil.width = 0;
                veil.height = 0;
              }, FLY_MS + 100);
            }),
          ),
        );
      });
    }
    const kick = (): void => {
      if (!raf && !dead) raf = requestAnimationFrame(frame);
    };

    ctl.current = {
      fly() {
        fly = {
          from: pose,
          fromIns: ins,
          t0: performance.now(),
          ms: reducedMotion() ? 0 : FLY_MS,
        };
        // only a fly that is drawn holds back the work waiting for it (`stageAtRest`)
        if (scene && fly.ms > 0) setFlying(true);
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
        dpr: window.devicePixelRatio || 1,
      };
      scene?.resize(size.w, size.h, size.dpr);
      kick();
      // and once more after the resize settles: the one frame drawn in the resize could be shown BLANK
      // (measured offscreen, 2026-10-18 — the next draw, or any restyle, brought the field back)
      clearTimeout(settle);
      settle = window.setTimeout(kick, 150);
    };
    const ro = new ResizeObserver(resize);

    buildWorld();
    // THE PAGE FIRST, THE FIELD WHEN THE BROWSER IS IDLE: the scene's chunk, the field's meshes and
    // the shader compile are a few hundred ms of main thread on a weak machine, and Home's keycaps
    // should answer before they run. Until it fades in, `StageWait` (and on the first load the boot
    // screen) stands in for it.
    const boot = (): Promise<void> =>
      load()
        .then((factory) => factory(host, { interactive: false, tunesTier: false, onLateSwap }))
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
          // THE FIELD, DRAWN HIDDEN: what `warmShaders` did not link links here, out of sight
          drawNow();
          fieldDrawn = true;
          performance.mark?.('dsim:stage-field');
          // WHOLE once every asset of this world has settled: the room (committed at once while
          // hidden), its light, an imported robot's mesh. `assetsSettled` never rejects.
          const w = world;
          const whole = w && s.assetsSettled ? s.assetsSettled(w) : Promise.resolve();
          void whole.then(() => drawThen(() => reveal('whole')));
          // short of whole: the first load's boot screen leaving at its cap, or the wait after the field
          if (underBoot) void afterBootLeave().then(partial);
          partial();
        })
        .catch(() => {
          releaseBoot();
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
      clearTimeout(partialTimer);
      clearTimeout(veilTimer);
      releaseBoot();
      setFlying(false);
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      orbitSink = null;
      ctl.current = null;
      scene?.dispose();
      // a room still waiting is committed into the disposed scene, which frees it
      const waiting = pendingSwap;
      pendingSwap = null;
      waiting?.();
      host.replaceChildren();
      const veil = veilRef.current;
      if (veil) {
        veil.hidden = true;
        veil.classList.remove('out');
        veil.width = 0;
        veil.height = 0;
      }
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

  return (
    <>
      <div ref={hostRef} className={`ds-stage-3d${shown ? ' shown' : ''}${shown === 'now' ? ' now' : ''}`} />
      {/* the last frame, over the scene while a late room fades in (`crossfade`) */}
      <canvas ref={veilRef} className="ds-stage-veil" hidden />
    </>
  );
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
