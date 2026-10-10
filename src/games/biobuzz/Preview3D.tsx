import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Alliance, RobotSpec } from '../../types';
import type { GamePreviewProps, GameSavedCardProps, RobotPreviewFactory, RobotPreviewScene } from '../module';
import { moduleFor } from '../index';
import { BB3_STOW_MAX, bbDeployedHeightIn, bbStowHeightIn } from './config';
import { getViewPref, setViewPref, subscribeViewPref, type ViewPref } from './graphics/store';
import { BiobuzzRobotPreview } from './RobotPreview';
import { bbSpecKey } from './specKey';

/**
 * THE BUILDER'S ROBOT PREVIEW (`docs/roadmap.md` item 1) — the 2D schematic, the live 3D
 * turntable, and the 2D/3D toggle between them; plus the 3D thumbnail on a saved-robot card.
 *
 * ── NOTHING IN THIS FILE IMPORTS `three`, OR ANYTHING UNDER `scene/` ────────────────────────
 * It reaches the renderer through `moduleFor('biobuzz').previewScene()` — the module slot whose
 * only implementation is a dynamic `import()` inside `index.ts`. That is the same route
 * `Gallery.tsx` takes to the match scene and it is the load-bearing property here: this component
 * is in the MAIN chunk (the builder is a menu screen every player reaches), and a static import of
 * the scene would put Three.js in the bundle a DECODE player downloads. `scripts/smoke-biobuzz/
 * render.ts` asserts it rather than trusting it.
 *
 * ── THE TOGGLE IS THE DEVICE'S OWN VIEW PREFERENCE ──────────────────────────────────────────
 * Not component state: `graphics/store.ts`'s `decodesim.view.v2`, the same preference the match view,
 * the `t` key, the touch layer's button and the Graphics section all read. Building your robot in
 * 3D and then driving it in 2D is not a thing anybody wants, and a second switch that meant
 * something slightly different would be how you end up with it.
 *
 * ── WHAT THE PREVIEW IS SHOWING IS THE MATCH'S ROBOT ────────────────────────────────────────
 * `scene/renderPreview.ts` builds it with `buildRobotGroup`, the function the live match calls for
 * every robot on the field. Nothing is drawn twice, so nothing can drift.
 */

// ───────────────────────────────────────────────────────────── the lazy factory ──

/** the scene chunk's preview factory, or null when this game has no 3D renderer (which cannot
 * happen for BIOBUZZ, and is what the other two games return). Resolved fresh each time: the
 * module registry memoises nothing, but `import()` itself does, so a second call after the first
 * is a resolved promise and not a second download. */
function previewFactory(): Promise<RobotPreviewFactory | null> {
  const load = moduleFor('biobuzz').previewScene;
  return load ? load() : Promise.resolve(null);
}

/** duck-typed, because `SceneUnsupportedError` is DECLARED in the lazy chunk and importing it to
 * do an `instanceof` would drag Three.js into this bundle — which is the one thing this file may
 * not do. The name and the `reason` field are the contract (`scene/renderCore.ts`). */
function unsupportedReason(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { name?: unknown; reason?: unknown };
  if (e.name !== 'SceneUnsupportedError') return null;
  return typeof e.reason === 'string' ? e.reason : 'unsupported';
}

// ───────────────────────────────────────────────────── saved-robot thumbnails ──

/** the captured square, in device pixels. Twice the 96 CSS px the card shows, so the image is
 * crisp on a 2x panel without storing a full-resolution render of a thumbnail. */
const THUMB_CAPTURE_PX = 192;

/**
 * THE THUMBNAIL CACHE — in memory, for the life of the document, keyed on the build's geometry
 * identity plus its alliance.
 *
 * NEVER PERSISTED, deliberately. A data URL of a render is derived data: it would be the largest
 * thing in `localStorage` by an order of magnitude, it would go stale the moment the generator or
 * the light rig changed (silently, and looking plausible), and regenerating it costs one frame.
 */
const thumbs = new Map<string, string>();

function thumbKey(spec: RobotSpec, alliance: Alliance): string {
  return `${bbSpecKey(spec)}|${alliance}`;
}

interface ThumbRequest {
  key: string;
  spec: RobotSpec;
  alliance: Alliance;
  resolve(url: string): void;
}

/**
 * ONE WebGL CONTEXT PER BATCH, not one per card.
 *
 * Every saved-robot card that needs an image mounts in the same React commit, so the requests are
 * collected and drained on a microtask: the scene is created once, each spec is set and captured,
 * and the context is thrown away as soon as the batch is done. A context per card would be three
 * of them for a cap of three saved robots — and a context that outlived the screen would be one
 * the match view might want back (browsers cap how many a page may hold, which is the bug
 * `Gallery.tsx` shares one scene across thirty cells to avoid).
 */
let queue: ThumbRequest[] = [];
let draining = false;

/**
 * THE BUILDER'S LIVE TURNTABLE, while one is mounted — and the thumbnails draw through it.
 *
 * On the 3D view the hero's turntable is always up when the cards want pictures, so a scene of the
 * batch's own was a SECOND context, a second environment and a second shader compile for three
 * 96px images (2026-09-26). `capture(size, spec)` shoots a card's build and puts the hero's back
 * inside one task, so the turntable never shows the wrong robot. The offscreen scene below stays
 * as the fallback for a batch with no turntable to borrow.
 */
let liveTurntable: RobotPreviewScene | null = null;

/**
 * WHEN THE BROWSER HAS NOTHING BETTER TO DO — the batch waits for it, and so does each capture.
 *
 * The batch used to start on a microtask, in the same moment the builder's live turntable was
 * creating ITS context, so entering Configure ▸ Robot stacked two WebGL setups, two environment
 * maps and three synchronous captures into one burst: ~130 ms of the ~210 ms of long tasks
 * measured on entry (2026-09-23). The cards show the 2D schematic meanwhile, so waiting costs
 * nothing a player can see except the swap. The timeout is the upper bound on a busy page.
 */
function idle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 2000 });
    else setTimeout(resolve, 300);
  });
}

async function drain(): Promise<void> {
  const batch = queue;
  queue = [];
  let own: RobotPreviewScene | null = null;
  const host = document.createElement('div');
  try {
    const factory = await previewFactory();
    // read AFTER the chunk resolves: the turntable's own `.then` on the same import runs first
    const shared = liveTurntable;
    if (!shared && factory) {
      // off screen rather than `display: none`: a hidden element has no size, and the scene sizes
      // itself from what `capture` asks for anyway — but a laid-out host keeps the canvas real.
      host.setAttribute('aria-hidden', 'true');
      host.className = 'bb-thumb-host';
      document.body.appendChild(host);
      // ⚠️ NO FIXED QUALITY — it FOLLOWS the device's own preference, and that is the opposite of
      // what a replay export does (§4.7 pins those at High so a video is not made at whatever the
      // machine happened to be set to). Two reasons, and they point the same way. A thumbnail sits
      // on the same screen as the live turntable, so one drawn at a tier the device is not on is a
      // second picture of the same robot that does not match the first — the exact drift this
      // whole feature is built to avoid. And High selects the `school-hall` HDRI: pinning it would
      // fetch 1.7 MB to draw three 96px cards, on a menu screen, for somebody whose own setting
      // asked for the procedural room. The cache is per DOCUMENT and regenerated on demand, so a
      // settings change catching up on the next load is the whole of the cost.
      own = factory(host, { interactive: false, animate: false });
    }
    const scene = shared ?? own;
    // ONE CAPTURE PER IDLE SLICE, after the shaders are compiled off the main thread (`ready`):
    // a capture is a synchronous render + PNG encode, and three of them in a row were one task.
    while (scene && batch.length > 0) {
      const req = batch[0];
      // a scene of our own takes the build early so `ready` compiles ITS shaders; the turntable is
      // on screen, so it is handed the build only inside `capture`'s one task
      own?.setSpec(req.spec, req.alliance);
      await scene.ready();
      await idle();
      const url = scene.capture(THUMB_CAPTURE_PX, req.spec, req.alliance);
      if (url) thumbs.set(req.key, url);
      req.resolve(url);
      batch.shift();
    }
  } catch (err) {
    // no WebGL2, a software renderer, a failed chunk — the cards drop their thumbnail
    // eslint-disable-next-line no-console
    console.warn('BIOBUZZ: no 3D thumbnails on this machine.', err);
  } finally {
    own?.dispose();
    host.remove();
    for (const req of batch) req.resolve('');
    draining = false;
    if (queue.length > 0) {
      draining = true;
      void drain();
    }
  }
}

function thumbFor(spec: RobotSpec, alliance: Alliance): Promise<string> {
  const key = thumbKey(spec, alliance);
  const hit = thumbs.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  return new Promise<string>((resolve) => {
    queue.push({ key, spec, alliance, resolve });
    if (draining) return;
    draining = true;
    void idle().then(drain);
  });
}

/** the device's view preference, as React state. One hook, three readers in this file. */
function useViewPref(): ViewPref {
  const [pref, setPref] = useState<ViewPref>(() => getViewPref());
  useEffect(() => subscribeViewPref(setPref), []);
  return pref;
}

// ─────────────────────────────────────────────────────────── the live turntable ──

/**
 * The 3D half, mounted only while the 3D view is picked. Split out so that switching back to 2D
 * UNMOUNTS it — that is what disposes the WebGL context, and leaving a context alive behind a
 * `display: none` is how a menu screen ends up holding the one the match wanted.
 */
function LiveTurntable({
  spec,
  alliance,
  onUnsupported,
}: {
  spec: RobotSpec;
  alliance: Alliance;
  onUnsupported(reason: string): void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<RobotPreviewScene | null>(null);
  /** the latest build, for the creation effect to apply the moment the chunk lands — it resolves
   * after this render, so it cannot read the props from its own closure. */
  const specRef = useRef(spec);
  specRef.current = spec;
  const allianceRef = useRef(alliance);
  allianceRef.current = alliance;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let dead = false;
    let live: RobotPreviewScene | null = null;
    let ro: ResizeObserver | null = null;
    void previewFactory()
      .then((factory) => {
        if (dead) return;
        if (!factory) {
          onUnsupported('no 3D renderer for this game');
          return;
        }
        const sc = factory(host, {
          onContextLost: () => {
            if (!dead) onUnsupported('the graphics context was lost');
          },
        });
        live = sc;
        sceneRef.current = sc;
        liveTurntable = sc;
        sc.setSpec(specRef.current, allianceRef.current);
        const fit = (): void => {
          const r = host.getBoundingClientRect();
          sc.resize(r.width, r.height, window.devicePixelRatio || 1);
        };
        fit();
        if (typeof ResizeObserver === 'function') {
          ro = new ResizeObserver(fit);
          ro.observe(host);
        }
      })
      .catch((err: unknown) => {
        if (dead) return;
        // eslint-disable-next-line no-console
        console.warn('BIOBUZZ: the 3D robot preview could not start.', err);
        onUnsupported(unsupportedReason(err) ?? 'the 3D preview could not start');
      });
    return () => {
      dead = true;
      ro?.disconnect();
      sceneRef.current = null;
      if (liveTurntable === live) liveTurntable = null;
      live?.dispose();
    };
  }, [onUnsupported]);

  // every edit, straight through. Cheap by contract: a spec whose geometry identity is unchanged
  // re-fits the camera (three multiplications) and rebuilds nothing.
  useEffect(() => {
    sceneRef.current?.setSpec(spec, alliance);
  }, [spec, alliance]);

  return <div className="bb-prev-host" ref={hostRef} />;
}

// ───────────────────────────────────────────────────────────────── the slot ──

/**
 * `GameModule.Preview` for BIOBUZZ.
 *
 * WITHOUT `allow3d` it is exactly the 2D schematic this slot used to be — no toggle, no context,
 * no behaviour change for the match-strategy cards that render four of these at once. The builder
 * hero passes it.
 */
export function BiobuzzPreview3D({
  spec,
  size = 200,
  alliance = 'red',
  allow3d = false,
  caption = true,
}: GamePreviewProps) {
  const pref = useViewPref();
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const [stowed, setStowed] = useState(false);
  const onUnsupported = useCallback((reason: string) => setUnsupported(reason), []);

  // R102: a build inside the starting cube has no stowed configuration to show, so the toggle is
  // absent rather than disabled — there is nothing it could do.
  const deployed = bbDeployedHeightIn(spec);
  const folds = deployed > BB3_STOW_MAX;
  const showStowed = stowed && folds;
  const stowHeight = bbStowHeightIn(spec);

  /** the spec the SCENE is given. Stowing is expressed as a build whose `heightIn` IS the stow
   * height, which is why it rebuilds correctly for free: the height is part of `bbSpecKey`. */
  const shown = useMemo(
    () => (showStowed ? { ...spec, heightIn: stowHeight } : spec),
    [spec, showStowed, stowHeight],
  );

  if (!allow3d) return <BiobuzzRobotPreview spec={spec} size={size} caption={caption} />;

  const live = pref === '3d' && unsupported === null;
  // WHAT IS SHOWN, not what was asked for. When the scene cannot start, the schematic is on screen,
  // so 2D is the segment that reads as pressed and 3D reads as unavailable (dashed, the chassis
  // map's TAKEN spelling) with the reason in its title. The reason used to be a sentence inside
  // the preview column, which in the hero's 96px strip widened that column until the robot's name
  // was cut to "My Ro…" and the stats beside it scrolled both ways.
  const failed = pref === '3d' && unsupported !== null;
  const shows2d = pref === '2d' || failed;
  return (
    <div className="bb-prev">
      <div className="ds-segs bb-prev-tabs" role="group" aria-label="Robot preview">
        <button
          type="button"
          className={`ds-seg${shows2d ? ' on' : ''}`}
          aria-pressed={shows2d}
          onClick={() => setViewPref('2d')}
        >
          2D
        </button>
        <button
          type="button"
          className={`ds-seg${live ? ' on' : ''}${failed ? ' off' : ''}`}
          aria-pressed={live}
          title={failed ? 'Couldn’t start the 3D preview on this device. Click to try again.' : undefined}
          onClick={() => {
            // a retry as well as a pick: somebody who was sent back to 2D by a failed context gets
            // to try again without a reload, exactly as the Graphics section's 3D button does
            setUnsupported(null);
            setViewPref('3d');
          }}
        >
          3D
        </button>
        {live && folds ? (
          <button
            type="button"
            className={`ds-seg bb-prev-stow${showStowed ? ' on' : ''}`}
            aria-pressed={showStowed}
            title={`Show the ${showStowed ? `${deployed}" deployed` : `${stowHeight}" starting`} configuration`}
            onClick={() => setStowed((v) => !v)}
          >
            Stowed
          </button>
        ) : null}
      </div>
      {live ? (
        <LiveTurntable spec={shown} alliance={alliance} onUnsupported={onUnsupported} />
      ) : (
        <BiobuzzRobotPreview spec={spec} size={size} caption={caption} />
      )}
      {/* the same fact for a screen reader, which cannot see a dashed border */}
      <span className="ds-sr" role="status">
        {failed ? 'Couldn’t start the 3D preview on this device.' : ''}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────── the saved-robot thumbnail ──

/**
 * `GameModule.savedThumb` for BIOBUZZ — the picture in one saved build's card.
 *
 * On the 3D view it is a render of the robot, made once per build through the same scene the
 * builder preview uses. Everywhere else it is the 2D SCHEMATIC, in the same box: on the 2D view,
 * while the render is still being made, and on a machine that cannot make one (no WebGL2, a
 * software renderer). Every saved card in every game carries a picture (owner, 2026-09-23), and at
 * 96px the schematic reads — it was a smudge only at the old 48.
 *
 * The box is a fixed size whichever picture is in it, so the card does not jump when the render
 * lands (§1.4 of `docs/ui-standard.md`).
 */
export function BiobuzzSavedThumb({ spec, alliance }: GameSavedCardProps) {
  const pref = useViewPref();
  // undefined: still rendering · '': this machine cannot · a data URL: the picture
  const [url, setUrl] = useState<string | undefined>(() => thumbs.get(thumbKey(spec, alliance)));

  useEffect(() => {
    if (pref !== '3d') return;
    let dead = false;
    void thumbFor(spec, alliance).then((next) => {
      if (!dead) setUrl(next);
    });
    return () => {
      dead = true;
    };
  }, [pref, spec, alliance]);

  return (
    <span className="ds-robot-card-thumb">
      {/* DECORATIVE: the card already names the robot and its team beside this, so an alt text
          would be a third reading of the same thing for a screen reader. */}
      {pref === '3d' && url ? <img src={url} alt="" /> : <BiobuzzRobotPreview spec={spec} size={88} caption={false} />}
    </span>
  );
}
