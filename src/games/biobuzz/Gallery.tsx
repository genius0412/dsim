import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { RobotCommand, Vec2, World } from '../../types';
import * as C from '../../config';
import { rot } from '../../math';
import { viewAngleOf } from '../../sim/field';
import { Renderer } from '../../render/renderer';
import { InputManager } from '../../input/input';
import { DEFAULT_BINDINGS } from '../../input/bindings';
import { BB_VIEW_MARGIN } from './config';
import { biobuzzColliders } from './colliders';
import { drawBiobuzzField } from './drawField';
import { drawBiobuzzBalls } from './draw';
import { drawBiobuzzRobot } from './drawRobot';
import { biobuzzHud, type BiobuzzHud } from './hudRobot';
import { biobuzzStep } from './step';
import { BiobuzzRobotPreview } from './RobotPreview';
import { BB_SCENES, bbScene, bbSceneStills, type Scene } from './scenes';

/**
 * `/biobuzz/gallery` — the VISUAL FEEDBACK LOOP's front end.
 *
 * A grid of canvases, one per scene per still, every one of them drawn with the REAL module
 * renderers. Click a cell and that scene runs live and drivable.
 *
 * ── THE ONE RULE THIS FILE OBEYS: NO GALLERY-ONLY DRAWING CODE ─────────────
 * Not a single pixel here is drawn by anything the game does not draw with. The cells call
 * `drawBiobuzzField`, `drawBiobuzzRobot`, `drawBiobuzzBalls` and `BiobuzzRobotPreview`; the
 * live view calls the SHARED `Renderer`, which dispatches through the module's slots exactly as
 * the ordinary game view does.
 *
 * The failure this prevents is specific and has happened before: a dev page grows its own
 * renderer, that renderer drifts from the real one, and the gallery becomes a picture of the
 * gallery. Every cell would still look fine and mean nothing. So the only thing this file is
 * allowed to own is LAYOUT — where a canvas goes, how big it is, and what the transform into it
 * is (see `fitCell`, which is arithmetic, not drawing).
 *
 * ── WHY THE FIELD LOOKS THE SAME IN BOTH THEMES ────────────────────────────
 * `shots.cjs` shoots every cell in light and dark. The CANVAS content barely changes between
 * them, and that is correct — the field is drawn on the hardcoded-dark mat in both, because
 * `--ds-on-field*` and `C.COLORS` are tuned for that one ground rather than flipped with the
 * app. What the two shots actually compare is the CHROME (captions, headings, card borders) and
 * the builder PREVIEWS in the archetype sheets, which do read `ds-*` tokens. Both are things
 * `npm run contrast` measures and neither is something it can look at.
 */

/** The BIOBUZZ field's camera bounds — the module's own colliders plus its view margin, so a
 * cell frames exactly what the game frames. */
const BOUNDS = {
  halfX: biobuzzColliders.bounds.halfX,
  halfY: biobuzzColliders.bounds.halfY,
  viewMargin: BB_VIEW_MARGIN,
};

/** Every cell is drawn from BLUE's side. One alliance for the whole gallery, deliberately: a
 * grid where half the cells were rotated 180° would make two pictures of the same situation
 * impossible to compare, and `viewAngleOf` is exercised by the live view (which uses the real
 * camera) and by `field-labelled` (which shows both alliances' anchors in one frame). */
const VIEW_ANGLE = viewAngleOf('blue');

/** cell canvas backing-store size, in device pixels. 420 is enough that a 3" POLLEN is ~4px
 * across at field scale — the smallest thing that has to be countable in a contact sheet. */
const CELL_PX = 420;

/**
 * A sheet is laid out as ONE ROW: the in-match canvas on the left, the three builder previews
 * beside it.
 *
 * Stacked (canvas above previews) the cell came out ~1100px tall, and a screenshot cannot show
 * that: `capturePage` clips to the window's viewport and a BrowserWindow cannot be taller than
 * the display it opens on, so the previews — the half of the comparison the sheet exists for —
 * were sliced off the bottom of every archetype PNG. Side by side the cell is ~460px tall,
 * which fits any screen a shot run happens on, and it puts the two renderings of the same
 * geometry next to each other rather than a scroll apart.
 */
const SHEET_ROW: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'flex-start' };

/** the sprite half of that row: square, fixed, and never the flexible one — the previews take
 * the slack, because they are the half that has detail to gain from extra width. */
const SHEET_CANVAS_STYLE: CSSProperties = {
  display: 'block',
  flex: '0 0 auto',
  width: '380px',
  maxWidth: '100%',
  aspectRatio: '1',
  borderRadius: 'var(--ds-round)',
};

const CANVAS_STYLE: CSSProperties = {
  display: 'block',
  width: '100%',
  aspectRatio: '1',
  borderRadius: 'var(--ds-round)',
};

/**
 * Set a cell's canvas transform so draw calls are in FIELD INCHES, y-up, rotated to the
 * driver's view — the same frame `Camera.apply` establishes.
 *
 * This is LAYOUT, not drawing, which is why it is allowed to live here. It is deliberately NOT
 * `Camera.configure`: that reserves 56px at the top and 96px at the bottom for the match HUD
 * and consults `matchMedia('(pointer: coarse)')`, both of which are right for a full-viewport
 * game view and wrong for a 300px gallery cell — the field would end up small and off-centre
 * with no HUD there to justify it. The FIT ITSELF is the same |cos|/|sin| span calculation
 * `Camera.configure` uses, and for a reason: a cell that framed the field differently from the
 * game would crop or letterbox where the game does not.
 */
function fitCell(ctx: CanvasRenderingContext2D, px: number, half = 0): void {
  // `half` frames a SMALLER square window around the field centre (0 = the whole field). An
  // archetype sheet holds three 15" robots on a 144" field, which at full field scale draws
  // each of them about 20px across — too small to see whether a dumper sits on the right edge,
  // which is the only thing the sheet is for. Zooming is a CAMERA choice and stays here with
  // the rest of the layout; every draw call below it is still the module's own renderer.
  const ex = half > 0 ? half : BOUNDS.halfX + BOUNDS.viewMargin;
  const ey = half > 0 ? half : BOUNDS.halfY + BOUNDS.viewMargin;
  const c = Math.abs(Math.cos(VIEW_ANGLE));
  const s = Math.abs(Math.sin(VIEW_ANGLE));
  const spanW = 2 * (c * ex + s * ey);
  const spanH = 2 * (s * ex + c * ey);
  const scale = Math.min(px / spanW, px / spanH);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle =
    document.documentElement.dataset.theme === 'dark' ? C.COLORS.backdropDark : C.COLORS.backdrop;
  ctx.fillRect(0, 0, px, px);
  ctx.translate(px / 2, px / 2);
  ctx.scale(scale, -scale);
  ctx.rotate(VIEW_ANGLE);
}

/** world-space "up" on this cell's screen — what the module renderers use to lift a POLLEN in
 * flight and to place its shadow. */
const SCREEN_UP: Vec2 = rot({ x: 0, y: 1 }, -VIEW_ANGLE);

/**
 * Draw one world into one canvas, through the module renderers and in the game's own order:
 * field, then robots, then POLLEN.
 *
 * THE ORDER IS PART OF THE PICTURE. POLLEN last is what makes a ball at an intake read as being
 * AT the intake rather than under the chassis, and it is the order `Renderer.render` uses. A
 * cell that drew them first would be a different picture of the same world.
 */
function drawCell(canvas: HTMLCanvasElement, world: World, half = 0): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  fitCell(ctx, CELL_PX, half);
  drawBiobuzzField(ctx, world, SCREEN_UP);
  for (const r of world.robots) {
    // INTAKE STATE FROM THE WORLD, not from a gallery flag: `r.autoIntake` is what the sim
    // itself would read this tick. A cell cannot show a running intake the sim does not have.
    const held = world.balls.filter((b) => b.state.kind === 'held' && b.state.robot === r.id);
    drawBiobuzzRobot(ctx, r, r.autoIntake, held, SCREEN_UP, world);
  }
  drawBiobuzzBalls(ctx, world, SCREEN_UP);
}

/**
 * THE HUD LINE UNDER A CANVAS — the module's own slice as text.
 *
 * The gallery has no match chrome (`GameController` builds its own world and there is no seam
 * to hand it one; requested in `docs/biobuzz/HANDOFF-shell.md`), so the numbers the score bar
 * and the chips would show are printed instead. They are read from `biobuzzHud`, the SAME
 * function the chrome reads, so a cell and a match can never disagree about a HIVE.
 *
 * The one number that decides what to look at is the up-CELL's `needed`: the field draws the
 * cell's contents as discs and no digits, and the tip threshold is a measured table indexed by
 * the NECTAR count (reference §4.1), so a screenshot of a HIVE does not say how close it is.
 * `tipping` displaces it for the 4 s of the swing, which is what a cell caught mid-tip should
 * say rather than a stale count.
 */
function bbHudLine(hud: BiobuzzHud): string {
  const f = hud.field;
  const cell = (a: 'red' | 'blue'): string => {
    const c = f.cells[a];
    const state = c.tipping > 0 ? 'tipping' : `${c.needed} to tip`;
    return `${a.toUpperCase()} ${f.score[a].total} (${state})`;
  };
  return `${cell('red')} · ${cell('blue')}`;
}

/** one still of one scene. */
function SceneCell({ scene, tick, world, onOpen }: { scene: Scene; tick: number; world: World; onOpen(): void }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (ref.current) drawCell(ref.current, world);
  }, [world]);
  const hud = biobuzzHud(world, world.robots[0]?.id ?? -1);
  return (
    <button className="ds-opt" onClick={onOpen} title={scene.title}>
      <canvas ref={ref} width={CELL_PX} height={CELL_PX} style={CANVAS_STYLE} />
      {/* THE CAPTION IS `<scene>@<tick>`, and it is the same string `shots.cjs` names its PNG
          with and a human quotes in a feedback dump. One identifier for a picture, wherever the
          picture is looked at. */}
      <span className="ot">
        {scene.id}@{tick}
      </span>
      {/* the numbers that explain a cell you are confused by: how many POLLEN are on the field
          at all, how full the first robot's hopper is, and where each HIVE stands. A pile that
          looks empty is a different bug from a pile that got collected, and the count is the
          difference. */}
      <span className="om">
        {world.balls.length} pollen · {hud.robot ? `${hud.robot.hopper}/${hud.robot.cap} held · ${hud.robot.mode}` : 'no robot'}
      </span>
      <span className="om">{bbHudLine(hud)}</span>
    </button>
  );
}

/**
 * An ARCHETYPE SHEET cell: the in-match sprite and the builder preview, side by side, for the
 * three chassis sizes in the scene.
 *
 * THIS IS THE ONLY CELL SHAPE THAT EXISTS FOR A REASON OTHER THAN LOOKING AT THE GAME. The two
 * renderers read one geometry (`bbMouths`, `bbFootprint`, `turretLocal`) and each draws it its
 * own way, so neither picture can be checked against the truth on its own — but they can be
 * checked against EACH OTHER, and a difference between them is always a real divergence. That
 * comparison is only possible if the two are in the same frame, which is what this is.
 */
/**
 * The zoom window an archetype sheet is drawn in, as a half-extent in inches.
 *
 * Sized from the scene: the three robots stand 34" apart along y (`SHEET_Y`) and the largest
 * legal chassis is 17" wide with a 3" sweeper, so ±48" holds all three with a tile of margin.
 * Deliberately a constant here rather than measured off the world — a window that resized
 * itself per sheet would draw each archetype at a different scale, and comparing 26 sheets is
 * the entire point.
 */
const SHEET_HALF = 48;

/**
 * A sheet cell takes the WHOLE GRID ROW.
 *
 * Every other cell is one picture and fits a 200px track; a sheet is FOUR pictures — the
 * in-match canvas plus the three builder previews it has to be compared against — and squeezed
 * into one track those previews came out about 80px wide, which is smaller than the sprite
 * they exist to verify. Full width gives each preview a third of the section instead of a
 * third of a card. It is a `style` rather than a class because `ds-*` has no full-row utility
 * for a grid child and inventing one would be an edit to a shared stylesheet for a dev route.
 */
const SHEET_CELL: CSSProperties = { gridColumn: '1 / -1' };

/** each preview column, capped. Wider than ~280px buys no legibility and only makes the row
 * taller, which is the one dimension a screenshot cannot spend. */
const SHEET_PREVIEW: CSSProperties = { maxWidth: '280px', margin: '0 auto' };

/** the previews half of the row: takes the slack, and stays three-up until the row wraps. */
const SHEET_PREVIEWS: CSSProperties = { flex: '1 1 480px', minWidth: 0 };

function ArchetypeCell({ scene, world, onOpen }: { scene: Scene; world: World; onOpen(): void }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (ref.current) drawCell(ref.current, world, SHEET_HALF);
  }, [world]);
  return (
    <button className="ds-opt" onClick={onOpen} title={scene.title} style={SHEET_CELL}>
      <span className="ot">{scene.id}@0</span>
      <div style={SHEET_ROW}>
        <canvas ref={ref} width={CELL_PX} height={CELL_PX} style={SHEET_CANVAS_STYLE} />
        {/* THE PREVIEWS ARE FLUID, not a fixed 120px. Three fixed-width SVGs overflowed the
            cell on a narrow grid column and the third one had its own dimension label sliced
            off — in the sheet whose job is to prove nothing is clipped. `fluid` hands the
            width to this grid. */}
        <div className="ds-opts three" style={SHEET_PREVIEWS}>
          {world.robots.map((r) => (
            // NO SEPARATE DIMENSION CAPTION: the preview prints `W" wide · L" long` inside its
            // own viewBox, and a second copy underneath in the other order (L × W) read as a
            // contradiction in the two shots where the numbers differ.
            <div key={r.id} className="ds-opt mini static" style={SHEET_PREVIEW}>
              <BiobuzzRobotPreview spec={r.spec} fluid />
            </div>
          ))}
        </div>
      </div>
    </button>
  );
}

/** a lane's scenes, as one section. */
function LaneSection({
  title,
  scenes,
  stills,
  onOpen,
}: {
  title: string;
  scenes: readonly Scene[];
  stills: Map<string, { tick: number; world: World }[]>;
  onOpen(id: string): void;
}) {
  if (!scenes.length) return null;
  return (
    <section className="ds-sec">
      <h2>
        {title} <span className="ds-count">{scenes.length}</span>
      </h2>
      <div className="ds-opts">
        {scenes.flatMap((scene) => {
          const shots = stills.get(scene.id) ?? [];
          // An archetype sheet is one cell with two renderers in it; every other scene is one
          // cell per still. The split is on the id prefix rather than on a flag in the `Scene`
          // type, because how a scene is PRESENTED is the gallery's business and putting a
          // presentation hint in the registry would leak the gallery into the sim-side type
          // that `smoke-biobuzz` also reads.
          if (scene.id.startsWith('archetype-')) {
            return shots.map((s) => (
              <ArchetypeCell key={scene.id} scene={scene} world={s.world} onOpen={() => onOpen(scene.id)} />
            ));
          }
          return shots.map((s) => (
            <SceneCell
              key={`${scene.id}@${s.tick}`}
              scene={scene}
              tick={s.tick}
              world={s.world}
              onOpen={() => onOpen(scene.id)}
            />
          ));
        })}
      </div>
    </section>
  );
}

/**
 * The LIVE view: one scene, running, drivable with the ordinary controls.
 *
 * ── IT USES THE SHARED RENDERER AND THE SHARED INPUT ───────────────────────
 * `Renderer` dispatches every draw through the module slots, and `InputManager` resolves the
 * player's real key bindings. So this is the game's rendering and the game's controls on a
 * scene's world — which is the whole value of the route: a still tells you what something looks
 * like, and only driving tells you what it FEELS like, which is the question Phase 0.5 exists to
 * answer.
 *
 * ── WHAT IT IS NOT ─────────────────────────────────────────────────────────
 * It has no match HUD, no score bar and no mobile controls, because `GameController` builds its
 * own world from `moduleFor(gameId).createWorld` and there is no seam to hand it one. Adding
 * that seam is an integration-chat change (`game.ts` is integration-only ground); it is
 * requested in `docs/biobuzz/HANDOFF-shell.md`. Until then the HUD numbers are printed as text
 * under the canvas from the module's own `hud()` slice, which is the same data the chrome would
 * render.
 *
 * ── THE SCRIPT KEEPS RUNNING ───────────────────────────────────────────────
 * The scene's `script` still drives every robot EXCEPT the one being driven. That is what makes
 * `squeeze-2robots` playable as a scene rather than as a diorama: the other robot keeps closing
 * while you drive yours, so the situation the scene is about actually happens.
 */
function LiveScene({ scene, onBack }: { scene: Scene; onBack(): void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hud, setHud] = useState<ReturnType<typeof biobuzzHud> | null>(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const world = scene.build(20260910);
    const renderer = new Renderer();
    const input = new InputManager(DEFAULT_BINDINGS);
    input.attach();
    // THE LOCAL ROBOT IS THE FIRST ONE. A scene with no robots (`field-empty`, `settle-60`) is
    // still worth opening — you watch the pollen — and `-1` matches nothing, so the driver's
    // command goes nowhere rather than to an arbitrary robot.
    const localId = world.robots[0]?.id ?? -1;

    let raf = 0;
    let last = 0;
    let acc = 0;
    let tick = 0;
    let lastCmd: RobotCommand | null = null;

    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame);
      // FIXED-STEP with an accumulator, exactly as the game loop does. Stepping by the frame
      // delta would make the sim's behaviour depend on the display's refresh rate, and this
      // route exists to judge that behaviour.
      const dtMs = last ? Math.min(now - last, 100) : 0;
      last = now;
      const cmd = input.poll();
      lastCmd = cmd;
      if (!pausedRef.current) {
        acc += dtMs / 1000;
        while (acc >= C.SIM_DT) {
          const cmds = new Map<number, RobotCommand>();
          for (const [id, c] of Object.entries(scene.script?.(world, tick) ?? {})) cmds.set(Number(id), c);
          // the DRIVER WINS on their own robot; the script keeps every other one moving
          if (localId >= 0) cmds.set(localId, cmd);
          biobuzzStep(world, C.SIM_DT, cmds);
          acc -= C.SIM_DT;
          tick++;
        }
      }
      renderer.camera.configure(canvas, 'blue', BOUNDS);
      renderer.render(ctx, world, lastCmd, localId);
      setHud(biobuzzHud(world, localId));
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      input.detach();
    };
  }, [scene]);

  return (
    <section className="ds-sec">
      <h2>{scene.id}</h2>
      <div className="ds-opts two">
        <button className="ds-opt mini" onClick={onBack}>
          <span className="ot">← All scenes</span>
        </button>
        <button className="ds-opt mini" onClick={() => setPaused((p) => !p)}>
          <span className="ot">{paused ? 'Resume' : 'Pause'}</span>
        </button>
      </div>
      <div className="ds-panelbox">
        <canvas ref={canvasRef} style={LIVE_STYLE} />
        <p className="ds-note">{scene.title}</p>
        {/* the module's own HUD slice, as text — see the note on the missing chrome above */}
        <p className="ds-note">
          {hud?.robot
            ? `hopper ${hud.robot.hopper}/${hud.robot.cap} · ${hud.robot.mode}`
            : 'no robot in this scene'}
        </p>
        {hud && <p className="ds-note">{bbHudLine(hud)}</p>}
        {/* G410 and the human player's supply: the two field facts a driver acts on that the
            canvas cannot show at all. The lock is stated, not counted down — `nectarIn` is
            null outside TELEOP, and a scene rarely runs a real phase clock. */}
        {hud && (
          <p className="ds-note">
            {hud.field.nectarLocked ? 'nectar locked (G410)' : 'nectar unlocked'} · RED in hand{' '}
            {hud.field.nectarStock.red}, due {hud.field.nectarDue.red} · BLUE in hand{' '}
            {hud.field.nectarStock.blue}, due {hud.field.nectarDue.blue}
          </p>
        )}
        {/* THE TWO SANCTIONS THAT ARE INVISIBLE ON THE CANVAS. A G421 PIN is two robots
            touching, which a still cannot tell from a shove, and its whole content is a clock;
            a G407 warning moves no number at all, so a scene that draws one looks identical to
            a scene that does not. Both are printed unconditionally — "no pins, no warnings" is
            the reading that says the detector ran, and a blank line would not. */}
        {hud && (
          <p className="ds-note">
            {hud.field.pins.length === 0
              ? 'no pins'
              : hud.field.pins
                  .map(
                    (p) =>
                      `pin ${p.pinner}→${p.pinned} ${p.seconds.toFixed(1)}s, ${p.billed} billed, next in ${p.nextIn.toFixed(1)}s`,
                  )
                  .join(' · ')}{' '}
            · G407 warnings RED {hud.field.warnings.red}, BLUE {hud.field.warnings.blue}
          </p>
        )}
      </div>
    </section>
  );
}

/** the live canvas fills its panel and is square, like the field. */
const LIVE_STYLE: CSSProperties = {
  display: 'block',
  width: '100%',
  aspectRatio: '1',
  borderRadius: 'var(--ds-round)',
};

/** the URL a cell links to. Exported so `shots.cjs` and the handoff can name the same path
 * without hard-coding the shape of it in three places. */
export function bbGalleryPath(sceneId?: string): string {
  return sceneId ? `/biobuzz/gallery/${sceneId}` : '/biobuzz/gallery';
}

/** the scene id in a `/biobuzz/gallery/<id>` path, or null for the grid. */
function sceneIdOf(pathname: string): string | null {
  const m = /^\/biobuzz\/gallery\/([a-z0-9-]+)\/?$/.exec(pathname);
  return m ? m[1] : null;
}

export function BiobuzzGallery() {
  // THE SELECTION IS REACT STATE, MIRRORED TO THE URL — not read from it every render.
  // Deliberate: it means a cell click works whether or not the host router knows the
  // `/gallery/<id>` sub-path (P0-core owns the router), while the URL is still the shareable
  // thing a feedback dump pastes. `popstate` keeps the back button honest.
  const [sceneId, setSceneId] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : sceneIdOf(window.location.pathname),
  );
  useEffect(() => {
    const sync = (): void => setSceneId(sceneIdOf(window.location.pathname));
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  const open = (id: string | null): void => {
    setSceneId(id);
    const path = bbGalleryPath(id ?? undefined);
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
  };

  /**
   * EVERY SCENE, STEPPED ONCE, ON MOUNT.
   *
   * `bbSceneStills` runs a scene forward a single time and clones at each still, so the whole
   * gallery costs the sum of the scenes' last stills — a couple of thousand ticks — rather
   * than the sum over every still. It is synchronous and it blocks the first paint for a
   * fraction of a second, which is the right trade for a dev page: an incrementally-filling
   * grid is a page `shots.cjs` can screenshot half-drawn.
   *
   * Rapier is already initialised by the time this mounts (`main.tsx` awaits `initPhysics()`
   * before rendering the app), which is why this can step at all.
   */
  const stills = useMemo(() => {
    const m = new Map<string, { tick: number; world: World }[]>();
    for (const s of BB_SCENES) m.set(s.id, bbSceneStills(s));
    return m;
  }, []);

  const live = sceneId ? bbScene(sceneId) : undefined;
  if (sceneId && live) return <LiveScene scene={live} onBack={() => open(null)} />;

  return (
    <>
      {/* An UNKNOWN id is said out loud rather than silently redirected to the grid: it almost
          always means a feedback dump quotes a scene that has since been renamed, and knowing
          that is more useful than a page that looks like it worked. */}
      {sceneId && !live ? <p className="ds-note">No scene named {sceneId}.</p> : null}
      <LaneSection
        title="Field"
        scenes={BB_SCENES.filter((s) => s.lane === 'field')}
        stills={stills}
        onOpen={open}
      />
      <LaneSection
        title="Robot"
        scenes={BB_SCENES.filter((s) => s.lane === 'robot')}
        stills={stills}
        onOpen={open}
      />
    </>
  );
}
