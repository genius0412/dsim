import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { fetchReplay, ReplayPrivateError } from '../net/api';
import {
  ReplayPlayer,
  replayFidelity,
  replayRefusal,
  replayViewpoint,
  type Replay,
  type ReplayRefusal,
} from '../sim/replay';
import { moduleFor } from '../games';
import type { GameScene, SceneCamera, SceneFrame } from '../games/module';
import {
  getCameraPref,
  getViewPref,
  resolveSceneCamera,
  subscribeViewPref,
  type ViewPref,
} from '../games/biobuzz/graphics/store';
import { installViewKey, toggleViewPref, viewKeyName } from '../games/biobuzz/graphics/viewKey';
// the lazy 3D physics chunk — fetched only for a `'3d'` container (see `ensurePhysics`)
import { disposePhysics3dFor, initPhysics3d, physics3dReady } from '../games/biobuzz/sim3d/engine';
import { Renderer } from '../render/renderer';
import { rangeFill } from './rangeFill';
import { resolveReplayView } from './replayViewMode';
import { clamp } from '../math';
import { drawReplayHud, fieldScreenBottom, HUD_RESERVE, hudLabels, loadSponsorMark, type HudLabels } from './replayOverlay';
import { trackEvent } from '../analytics';
import { sponsorActive } from '../sponsor';
import {
  availableVideoFormats,
  videoFormat,
  recordFast,
  realtimeMime,
  encodeSize,
  saveBlob,
  ENCODE_SHARE,
  type VideoFormat,
  type VideoFormatId,
} from './replayVideo';
import { SIM_DT, BALANCE_VERSION, SIM_VERSION } from '../config';
import { parsePenaltyEvent } from '../sim/penaltyLog';
import { PenaltyLog, ScoreEditor, type PenaltyEntry } from './ReplayRail';

/** how many times faster than real time the WebCodecs path encodes, measured across VP9, VP8
 *  and H.264 at a 1920 long edge (5.2-5.7×; the low end is the honest one to quote) */
const FAST_ENCODE_SPEED = 5;

/** one alliance's sanctions SO FAR: what it committed, what its opponent's fouls handed it,
 *  and its cards. `awarded` is the points term of the total, which is the half a watcher is
 *  usually trying to account for. */
interface FoulTally {
  minor: number;
  major: number;
  awarded: number;
  yellow: number;
  red: number;
}
const NO_FOULS: FoulTally = { minor: 0, major: 0, awarded: 0, yellow: 0, red: 0 };
const EMPTY_FOULS: Record<'red' | 'blue', FoulTally> = { red: NO_FOULS, blue: NO_FOULS };

/** playback rates. Only the wall-clock dt fed to the accumulator is scaled, so every tick is
 *  still one `stepOnce()` — a 2× replay is the same match, reached sooner (design review 09-03) */
const SPEEDS = [0.5, 1, 2] as const;
/** how far ←/→ jump: five seconds of ticks */
const SEEK_JUMP = Math.round(5 / SIM_DT);

/** m:ss from seconds. Rounds ONCE, before splitting — rounding the two halves separately
 *  prints "1:00" for 119.7 s, because the minutes half floors the unrounded value. */
const mmss = (sec: number): string => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * WHY this build won't play that replay, said in the terms the watcher cares about.
 *
 * Each `ReplayRefusal` is a different situation and only one of them is "it got old" — a
 * FUTURE container means THEY are behind and a refresh fixes it, and an UNSTAMPED one means
 * nobody knows. The old copy said "recorded on an older version of the sim (Season N)" for
 * every case, using `balanceVersion`, which is not the season at all: the season is the
 * leaderboard period, and in the replays table it is the `balance_version` COLUMN that holds
 * it while `sim_version` holds this (see repo.ts + migration 0031).
 */
const DIFFERENT_MATCH = 'so the same inputs would play back as a different match.';

const REFUSAL_TEXT: Record<ReplayRefusal, (r: Replay) => string> = {
  future: () => 'Recorded by a newer version of DSIM. Refresh the page, then open it again.',
  balance: (r) =>
    `Played on balance v${r.balanceVersion}; this build runs v${BALANCE_VERSION}. ` +
    `Robots drive and score differently now, ${DIFFERENT_MATCH}`,
  behaviour: (r) =>
    `Played on sim v${r.sim}; this build runs v${SIM_VERSION}. The physics or the rules have ` +
    `changed, ${DIFFERENT_MATCH}`,
  unstamped: () =>
    'Recorded before DSIM tracked which sim version produced a replay, so there is no way to ' +
    'tell whether it would play back correctly.',
  tank: () =>
    'Recorded in an early format that had nowhere to store tank drive input, so the robot ' +
    'would not move.',
};

/**
 * ...and WHY a replay that still plays may not finish on the number beside it. Only the two
 * “the sim moved” reasons reach this — the fatal three take the stale screen above — and each
 * says which one it is, because “we know the sim changed” and “we have no idea what it ran”
 * are different admissions. Every one of them ends on the same sentence: the leaderboard
 * figure is the authority, so nothing here can restate a record.
 */
const DRIFT_TEXT: Record<'behaviour' | 'unstamped', (r: Replay) => string> = {
  behaviour: (r) =>
    `Recorded on sim v${r.sim}; this build runs v${SIM_VERSION}. It plays, but the ending may ` +
    'not land on exactly the saved score. The leaderboard figure is the real one.',
  unstamped: () =>
    'Recorded before DSIM tracked which sim version produced a replay. It plays, but the ' +
    'ending may not land on exactly the saved score. The leaderboard figure is the real one.',
};

/**
 * Replay viewer: fetches a deterministic input-log replay and re-simulates it in
 * the browser, drawing with the same Renderer the live game uses. Physics WASM is
 * already inited (main.tsx) before any screen renders, so `ReplayPlayer` is safe.
 * Playback is cosmetic — the authoritative score lives on the board — so cross-
 * machine float drift (if any) can't move standings.
 */
export function ReplayView({
  replayId,
  preloadReplay,
  viewerRobotId,
  adminMatchId,
  onClose,
}: {
  replayId?: string;
  /** a replay already in hand (just-played run) — skips the fetch */
  preloadReplay?: Replay;
  /** the robot the WATCHER drove, so the camera sits behind their own driver
   * station rather than whichever alliance happens to be first on the roster.
   * See `replayViewpoint` — getting this wrong mirrors the whole field. */
  viewerRobotId?: number | null;
  /**
   * The MATCH this replay belongs to, when an admin opened it from a moderation surface.
   *
   * Present ⇒ the rail offers the score editor. It is passed IN rather than looked up, because
   * "which match is this" is only knowable from where the replay was opened: a replay id is
   * the only thing the viewer's own URL carries, and the same replay reached from a player's
   * own history is not an invitation to edit a result. The server re-checks the admin gate on
   * every call regardless — this decides what is OFFERED, never what is allowed.
   */
  adminMatchId?: string | null;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'stale' | 'private'>(
    'loading',
  );
  const [error, setError] = useState('');
  // WHICH refusal, so the stale screen can give the real reason instead of one guess
  const [refusal, setRefusal] = useState<ReplayRefusal | null>(null);
  /** set when the replay PLAYS but the sim has moved under it, so the note can name which of
   *  the two “the sim moved” reasons it is. Null while it re-simulates exactly. */
  const [drift, setDrift] = useState<'behaviour' | 'unstamped' | null>(null);
  /** a real-time canvas capture is running; playback controls are locked while it is */
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<BlobPart[]>([]);
  /** set when the user cancels, so `onstop` throws the partial file away instead of saving it */
  const discard = useRef(false);
  /** detaches the visibilitychange listener that pauses the encoder with the render loop */
  const stopVisibility = useRef<(() => void) | null>(null);
  /** the download menu, and the byte count measured when it opened (see `openMenu`) */
  const [menuOpen, setMenuOpen] = useState(false);
  const [dataBytes, setDataBytes] = useState(0);
  const menuRoot = useRef<HTMLDivElement>(null);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const [playing, setPlaying] = useState(true);
  const [tick, setTick] = useState(0);
  const [total, setTotal] = useState(1);
  // live scoreboard, sampled with the progress readout (never per frame)
  const [score, setScore] = useState({ red: 0, blue: 0 });
  /** the middle of the scoreboard, in the HUD's own words — `hudLabels` is what the burned-in
   *  video draws too, so the screen and the file cannot name a phase two ways (09-07) */
  const [labels, setLabels] = useState<HudLabels>({ phase: 'PRE-MATCH', clock: null, result: null });
  const [speed, setSpeed] = useState<number>(1);
  const speedRef = useRef(1);
  /**
   * PENALTIES, ON EVERY REPLAY AND FOR EVERYBODY.
   *
   * The viewer used to draw the fouls on the field and name none of them: a score that moved
   * nine points in one second had no explanation anywhere on the screen. This is the summary
   * (always on) and, in the rail, the timeline. It was never an admin feature — the driver
   * reviewing their own match is the person most entitled to know which rule they broke.
   */
  const [fouls, setFouls] = useState(EMPTY_FOULS);
  const [penalties, setPenalties] = useState<PenaltyEntry[]>([]);
  /** how much of the player's log has been parsed, so the 10 Hz readout does not re-parse an
   *  unchanged list — and so a REBUILD (which resets the log to empty) is noticed */
  const logLen = useRef(-1);
  /** the rail: the penalty timeline, and the score editor when an admin opened a match */
  const [railOpen, setRailOpen] = useState(false);

  const renderer = useRef<Renderer | null>(null);
  const player = useRef<ReplayPlayer | null>(null);
  const replay = useRef<Replay | null>(null);
  const playingRef = useRef(true);
  /** a BACKWARD drag's target, held until the pointer lets go. Going back re-simulates from tick
   *  0 (`seek`), up to several thousand ticks, and doing that on every input event made the
   *  thumb lag the pointer; forward drags stay live because they only step onward. */
  const scrubTo = useRef<number | null>(null);
  const lastPointer = useRef(-1);
  /** probed ONCE: what this browser can actually encode decides what the menu offers, and this
   *  component re-renders 10 times a second off the progress readout. It is ASYNC because the
   *  real question is not "is there a VideoEncoder" but "will it take this codec at this size",
   *  which only `isConfigSupported` can answer — and that also decides whether MP4 saves in
   *  seconds or has to be filmed in real time, which the menu says out loud. */
  const [formats, setFormats] = useState<VideoFormat[]>([]);
  /** 0..1 while a FAST capture runs; the real-time path uses the replay's own progress */
  const [capturePct, setCapturePct] = useState(0);
  /** the format being written, so the bar can say what it is doing and how long it will take */
  const [capturing, setCapturing] = useState<VideoFormatId | null>(null);
  /** set to stop a fast capture between frames */
  const abortCapture = useRef(false);
  /**
   * WHAT THE VIDEO IS OF (`docs/roadmap.md` item 2, `docs/biobuzz/plan-3d.md` §4.7): the flat
   * map, or the 3D scene, and from which camera.
   *
   * The default follows the DEVICE's own view preference, because the one thing a person
   * exporting a clip of their own match almost always wants is the picture they were just
   * looking at. 3D is offered only where the game HAS a scene and this browser can run one —
   * a menu entry that produced a black video would be worse than no entry.
   *
   * The CAMERA default follows the same rule, one level down: whichever of the four the
   * on-screen scene is actually rendering right now. Both are set together in `openMenu`, off
   * the same read — see it for where the camera value comes from.
   */
  const [exportView, setExportView] = useState<'2d' | '3d'>('2d');
  const [exportCam, setExportCam] = useState<SceneCamera>('driver');
  /** measured when the menu opens — see `probe3d`. */
  const [can3d, setCan3d] = useState(false);
  /** re-fits the canvas backing store to its box; owned by the render loop, called by the
   *  recording effect (see it for why the canvas stops matching) */
  const refit = useRef<(() => void) | null>(null);
  /**
   * THE ON-SCREEN 3D VIEW (`docs/roadmap.md` item 2) — a replay opens in the graphics the
   * player defined, not a hardcoded 2D map, mirroring `GameController.scene`/`syncScene`.
   * Owned entirely by the render-loop effect below (created and disposed there); `view` is
   * only the DEVICE PREFERENCE for the toggle button's own label, exactly like
   * `MobileControls`' view button — it does not track whether a scene actually mounted, so a
   * failed load (no WebGL2) still shows "3D" selected with a console warning, same as the live
   * game and the Graphics section.
   */
  const scene = useRef<GameScene | null>(null);
  /** the element the on-screen scene mounts its canvas into, under the 2D one. */
  const sceneHostRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ViewPref>(() => getViewPref());
  /**
   * RE-RUN the on-screen scene sync from OUTSIDE the render-loop effect. The realtime capture
   * below (`startRealtime`) films the VISIBLE 2D canvas (`canvas.captureStream`) — which, in a
   * 3D view, is a transparent overlay with no field drawn on it at all, because the scene draws
   * the field on its own canvas underneath. So a realtime recording has to force the on-screen
   * view back to 2D for its length, and this is how it reaches a sync function that lives
   * inside an effect scoped to `[status, viewerRobotId]`, not `recording`. Same cross-effect-ref
   * pattern as `refit`, for the same reason.
   */
  const syncSceneRef = useRef<(() => void) | null>(null);
  /** true while a realtime capture is filming the visible canvas — read (not subscribed to) by
   *  the render-loop effect's `syncScene`, set directly (not through React state) so forcing the
   *  view back to 2D cannot lag a state-update round trip and let the recorder catch a
   *  transparent frame. See `syncSceneRef` above. */
  const realtimeCapture = useRef(false);

  // fetch the replay (or use a preloaded one) + build the player
  useEffect(() => {
    let dead = false;
    setStatus('loading');
    setError('');
    /**
     * A `'3d'` CONTAINER NEEDS ITS PHYSICS BEFORE THE PLAYER IS CONSTRUCTED, not before the
     * first frame is drawn.
     *
     * `ReplayPlayer`'s constructor builds the world and the render loop steps it on the very
     * next tick, so the await has to sit between the container arriving and the player being
     * made — which is what this wrapper is. The header above says "physics WASM is already
     * inited (main.tsx)", and that is still true of the 2D module; the 3D one is a lazy chunk
     * by design (a viewer watching a DECODE replay must never pay for it), so it is fetched
     * here, once, on the one kind of container that needs it.
     *
     * A FAILED load becomes the `error` state rather than a silent 2D re-simulation: re-running
     * a 3D log against the 2D pipeline would produce a different match from the same inputs and
     * show something that never happened, which is the exact failure `replayRefusal` exists to
     * prevent for a version mismatch.
     */
    const ensurePhysics = (r: Replay): Promise<void> =>
      (r.physics ?? '2d') !== '3d' || physics3dReady() ? Promise.resolve() : initPhysics3d();
    const use = (r: Replay): void => {
      replay.current = r;
      // A replay is a deterministic INPUT log, and whether this build can re-run it —
      // exactly, approximately, or not at all — is `replayFidelity`, which is deliberately
      // three-valued. A SIM_VERSION move must NOT make every match recorded before it
      // vanish: it means only that the ending may not land on precisely the saved number,
      // so it PLAYS, with a note, and both exports stay available. A refusal is reserved
      // for a container this build cannot parse, a different SEASON, and the format-1 tank
      // replay whose drive input was never stored. `replayRefusal` supplies the reason for
      // whichever of the two it turns out to be.
      const why = replayRefusal(r, BALANCE_VERSION, SIM_VERSION);
      if (replayFidelity(r, BALANCE_VERSION, SIM_VERSION) === 'stale') {
        setRefusal(why);
        setStatus('stale');
        return;
      }
      setDrift(why === 'behaviour' || why === 'unstamped' ? why : null);
      ensurePhysics(r).then(
        () => {
          if (dead) return;
          replacePlayer(new ReplayPlayer(r));
          renderer.current = new Renderer();
          setTotal(Math.max(1, r.ticks));
          setTick(0);
          setStatus('ready');
        },
        (e: unknown) => {
          if (dead) return;
          setError(
            e instanceof Error
              ? `Couldn’t load the 3D physics this replay needs. ${e.message}`
              : 'Couldn’t load the 3D physics this replay needs. Check your connection and try again.',
          );
          setStatus('error');
        },
      );
    };
    if (preloadReplay) {
      use(preloadReplay);
      // the 3D chunk may still be loading when the viewer is left: the `dead` guard in `use`
      // only works if something sets it
      return () => {
        dead = true;
      };
    }
    if (!replayId) {
      setError('No replay specified.');
      setStatus('error');
      return;
    }
    fetchReplay(replayId)
      .then((r) => {
        if (!dead) use(r);
      })
      .catch((e: unknown) => {
        if (dead) return;
        // A REFUSAL IS NOT A FAILURE. "Couldn't load the replay - Server returned 403" says
        // the link is broken, which is the one thing it is not; the replay is fine and the
        // people in it have not published it.
        if (e instanceof ReplayPrivateError) {
          // the SERVER says which refusal it is (`replayRefusalMessage`) — a private match,
          // somebody else's practice run and a self-hosted event are three different answers
          setError(e.message);
          setStatus('private');
          return;
        }
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      });
    return () => {
      dead = true;
    };
  }, [replayId, preloadReplay]);

  // render loop + a 10 Hz progress readout (no per-frame React churn)
  useEffect(() => {
    if (status !== 'ready') return;
    let dead = false;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const r = replay.current!;
    const rend = renderer.current!;
    // watch it from the seat the WATCHER actually sat in — see `replayViewpoint`
    const { robotId: localId, alliance } = replayViewpoint(r.setups, viewerRobotId);
    // CR's field is larger (protruding goals) — configure the camera with the game's
    // bounds so a CR replay isn't cropped to DECODE's field.
    const bounds = moduleFor(r.game).bounds;
    const sceneFn = moduleFor(r.game).scene;
    const mqCoarse = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null;

    const resize = (): void => {
      rend.camera.configure(canvas, alliance, bounds);
      scene.current?.resize(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1);
    };
    resize();
    window.addEventListener('resize', resize);
    // ...and let the recording effect below re-fit too; it is the same operation, run at the
    // other moment the canvas can stop matching its box
    refit.current = resize;

    /**
     * MOUNT/DROP THE ON-SCREEN 3D SCENE (`docs/roadmap.md` item 2) — mirrors
     * `GameController.syncScene`/`teardownScene` almost exactly, one screen over: same
     * insertBefore-decides-the-stack rule, same epoch guard against a late resolve landing
     * after a second toggle, same "no `interactive` option" (this scene IS the one somebody is
     * watching, so it takes the keys/pointer — camera cycling, drag-to-orbit — exactly like
     * the live match). The only addition is `realtimeCapture`: forced OFF for the length of a
     * realtime video capture, which films this canvas and would otherwise film a transparent
     * overlay with no field drawn on it. No HUD insets: unlike the live match, nothing is
     * absolutely positioned over this canvas (the score/foul rows sit in their own flow above
     * it), so a scene fits the whole box.
     */
    let sceneEpoch = 0;
    const teardownScene = (): void => {
      sceneEpoch++;
      const s = scene.current;
      if (!s) return;
      scene.current = null;
      rend.setScene(null);
      try {
        s.element.remove();
      } catch {
        /* not attached, or already gone */
      }
      try {
        s.dispose();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('BIOBUZZ 3D scene threw disposing; continuing on the 2D view.', err);
      }
    };
    const syncScene = (): void => {
      const host = sceneHostRef.current;
      const want =
        resolveReplayView(getViewPref(), !!sceneFn) === '3d' && !!host && !realtimeCapture.current;
      if (!want || !sceneFn) {
        teardownScene();
        return;
      }
      if (scene.current) return; // already showing one
      const epoch = ++sceneEpoch;
      (async () => {
        const factory = await sceneFn();
        const s = await factory(host!);
        // the view may have switched away, a realtime capture may have started, or the
        // component may have unmounted WHILE this load was in flight
        if (dead || epoch !== sceneEpoch) {
          s.dispose();
          return;
        }
        host!.insertBefore(s.element, host!.firstChild);
        s.resize(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1);
        scene.current = s;
        rend.setScene(s);
      })().catch((err: unknown) => {
        if (epoch !== sceneEpoch) return;
        // eslint-disable-next-line no-console
        console.warn('BIOBUZZ 3D scene failed to load; staying on the 2D view.', err);
      });
    };
    syncScene();
    syncSceneRef.current = syncScene;
    const unsubView = subscribeViewPref(syncScene);

    let raf = 0;
    let lastT = performance.now();
    let acc = 0;
    const loop = (t: number): void => {
      const p = player.current!;
      const dt = Math.min((t - lastT) / 1000, 0.25);
      lastT = t;
      if (playingRef.current && scrubTo.current === null) {
        acc += dt * speedRef.current;
        let n = 0;
        while (acc >= SIM_DT && n < 8 && !p.done) {
          p.stepOnce();
          acc -= SIM_DT;
          n++;
        }
        /**
         * NEVER CARRY MORE THAN A FEW TICKS OF DEBT.
         *
         * `n < 8` caps the work in one frame but the arrears keep accruing, so a frame that
         * arrives late makes the next one step harder, which makes IT late — the classic
         * spiral, and it is visible as judder rather than as slowness. It shows up whenever
         * the main thread is busy, which now includes saving a video while watching. Dropping
         * the debt means the replay runs a hair slow under load instead of lurching, and a
         * replay is a thing you watch, not a clock you set your watch by.
         */
        if (acc > SIM_DT * 4) acc = SIM_DT * 4;
        if (p.done && playingRef.current) {
          playingRef.current = false;
          setPlaying(false);
          // the END of the replay is what ends the recording — a ref, not the `recording`
          // state, because this loop closes over the render that started it
          if (recorder.current?.state === 'recording') recorder.current.stop();
        }
      }
      if (scene.current) {
        try {
          const frame: SceneFrame = {
            alpha: clamp(acc / SIM_DT, 0, 1),
            viewAngle: rend.camera.viewAngle,
            camera: mqCoarse?.matches ? 'overhead' : 'driver',
            localRobotId: localId,
            width: canvas.clientWidth,
            height: canvas.clientHeight,
            dpr: window.devicePixelRatio || 1,
          };
          scene.current.render(p.world, frame);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('BIOBUZZ 3D scene failed to render; falling back to the 2D view.', err);
          teardownScene();
        }
      }
      // a mounted scene draws the field/robots/balls beneath this canvas — the 2D pass then
      // stays transparent and draws only its cheap overlay (name labels), never the field.
      rend.render(ctx, p.world, null, localId, !!scene.current);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const readout = window.setInterval(sync, 100);

    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      window.clearInterval(readout);
      window.removeEventListener('resize', resize);
      unsubView();
      teardownScene();
      syncSceneRef.current = null;
      refit.current = null;
    };
  }, [status, viewerRobotId]);

  /**
   * RE-FIT THE CANVAS WHENEVER THE ROW BELOW IT CHANGES.
   *
   * The recording bar REPLACES the transport row at a different height, so the canvas's box
   * resizes around it without a window resize ever firing — and the backing store, set once at
   * mount, then no longer matches: the field drew into a 1280×545 element at 1280×516 and came
   * out squashed for the length of the recording.
   *
   * It belongs in an effect rather than in the render loop, because React has committed the
   * row by the time this runs — so the element is at its final size — while reading
   * `clientWidth` on each of 60 frames a second would force a layout flush for something that
   * changes twice a match.
   *
   * ⚠️ NOT while a REAL-TIME capture is running: that one is literally filming this canvas
   * through `captureStream`, and resizing it mid-recording is a resolution change partway
   * through the file. The fast path is unaffected either way — it owns a canvas of its own.
   */
  useEffect(() => {
    if (recorder.current) return;
    refit.current?.();
  }, [recording, status, railOpen]);

  /**
   * A RECORDING MUST NOT OUTLIVE THE SCREEN THAT STARTED IT. Leaving the viewer mid-capture
   * would otherwise leave a live `MediaRecorder` holding a stream off a canvas that no longer
   * exists, plus a document-level listener with nothing to detach it. Discard, don't save: a
   * video of a match the watcher walked out of is not a file anyone asked for.
   */
  useEffect(
    () => () => {
      // the on-screen player's 3D world, if it has one (see `replacePlayer`)
      replacePlayer(null);
      abortCapture.current = true;
      discard.current = true;
      const cur = recorder.current;
      if (cur && cur.state !== 'inactive') cur.stop();
      stopVisibility.current?.();
      stopVisibility.current = null;
    },
    [],
  );

  // ask the browser what it can encode, once
  useEffect(() => {
    let dead = false;
    void availableVideoFormats().then((f) => {
      if (!dead) setFormats(f);
    });
    return () => {
      dead = true;
    };
  }, []);

  // THE VIEW TOGGLE: follow the device's preference (a Graphics-section change while this
  // screen is open takes effect live, exactly like the live match), and arm the `t` key —
  // reference-counted, so a mounted scene holding it too (see the render-loop effect) never
  // double-toggles a press. Unconditional, like `MobileControls`': a no-op on a game with no
  // 3D scene at all.
  useEffect(() => subscribeViewPref(setView), []);
  useEffect(() => installViewKey(), []);

  /** The menu closes on Escape and on a press anywhere outside it. A popover that only closes
   *  by re-clicking its own button is one people leave open by accident — and this one covers
   *  the corner of the field. */
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent): void => {
      if (!menuRoot.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      // a DISCLOSURE, not an ARIA menu (design review 09-10): Escape hands focus back to the
      // trigger, so a keyboard user is not dropped on <body> when the options unmount
      if (e.key === 'Escape') {
        setMenuOpen(false);
        menuBtn.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  /**
   * TRANSPORT KEYS (design review 09-03): Space plays/pauses, ←/→ jump five seconds. Window-
   * level, like the `t` view key, because the canvas is not focusable. Off while a real-time
   * capture runs (the transport is locked then), under any modifier, and while typing. Space on
   * a focused button is left to the button — its own activation already does what was pressed,
   * and handling it here too would toggle twice. On the seek bar ←/→ are taken over: its native
   * step is one tick, which cannot scrub a 9,000-tick match.
   */
  useEffect(() => {
    if (status !== 'ready' || recording) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(textarea|select)$/i.test(el.tagName))) return;
      if (el?.tagName === 'INPUT' && !el.classList.contains('ds-replay-seek')) return;
      const p = player.current;
      if (!p) return;
      // a held key auto-repeats: Space would flicker play/pause, and every ← re-steps from tick 0
      if (e.repeat) return;
      if (e.key === ' ') {
        if (el?.closest('button, a')) return;
        e.preventDefault();
        setPlay(!playingRef.current);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        seek(clamp(p.world.tick + (e.key === 'ArrowLeft' ? -SEEK_JUMP : SEEK_JUMP), 0, total));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [status, recording, total]);

  /** pull tick + scoreboard off the sim in one go, so seeking/restarting can't
   *  leave the score showing a different moment than the field does. */
  const sync = (): void => {
    const p = player.current;
    const w = p?.world;
    if (!p || !w || scrubTo.current !== null) return;
    setTick(w.tick);
    setScore({ red: w.match.scores.red.total, blue: w.match.scores.blue.total });
    setLabels(hudLabels(w, null, p.done));
    const cards = w.match.cards;
    setFouls({
      red: {
        ...w.match.fouls.red,
        awarded: w.match.scores.red.foulPoints,
        yellow: cards?.red.yellow ?? 0,
        red: cards?.red.red ?? 0,
      },
      blue: {
        ...w.match.fouls.blue,
        awarded: w.match.scores.blue.foulPoints,
        yellow: cards?.blue.yellow ?? 0,
        red: cards?.blue.red ?? 0,
      },
    });
    // LENGTH, not content: the log only ever grows within one player, and a seek backwards
    // builds a NEW player whose log starts empty — which this catches as a length that went
    // down. Re-parsing an unchanged list ten times a second would be the only cost of not
    // checking, and the list is re-rendered from state either way.
    if (p.log.length !== logLen.current) {
      logLen.current = p.log.length;
      const out: PenaltyEntry[] = [];
      for (const e of p.log) {
        const line = parsePenaltyEvent(e.text);
        if (line) out.push({ tick: e.tick, phase: e.phase, timeLeft: e.timeLeft, line });
      }
      setPenalties(out);
    }
  };

  const setPlay = (v: boolean): void => {
    // replaying from the end restarts
    if (v && player.current?.done) rebuild();
    playingRef.current = v;
    setPlaying(v);
  };
  /**
   * SWAP THE PLAYER, FREEING THE ONE IT REPLACES.
   *
   * A `'3d'` replay's world is solved in a Rapier world that lives in wasm linear memory, and
   * only `disposePhysics3dFor` returns it — the `WeakMap` holding it cannot (see
   * `disposeEngineFor`). Every backward scrub, "play again" and restart used to build a fresh
   * player and drop the old one, leaking a whole 3D world each time for the life of the tab.
   * A no-op for a 2D replay, and before the 3D chunk has ever loaded.
   */
  const replacePlayer = (next: ReplayPlayer | null): void => {
    const prev = player.current;
    player.current = next;
    if (prev && prev !== next) disposePhysics3dFor(prev.world);
  };
  const rebuild = (): void => {
    if (!replay.current) return;
    scrubTo.current = null;
    replacePlayer(new ReplayPlayer(replay.current));
    sync();
  };
  /** run it out to the recorded end — how a moderator gets the FINAL score the misscore claim
   *  is about, and what the seek bar's right edge does anyway */
  const playToEnd = (): void => {
    if (!player.current) return;
    seek(total);
    playingRef.current = false;
    setPlaying(false);
  };
  const seek = (target: number): void => {
    scrubTo.current = null;
    const r = replay.current;
    if (!r) return;
    let p = player.current!;
    if (target < p.world.tick) {
      p = new ReplayPlayer(r);
      replacePlayer(p);
    }
    while (p.world.tick < target && !p.done) p.stepOnce();
    sync();
  };

  const commitScrub = (): void => {
    const t = scrubTo.current;
    scrubTo.current = null;
    if (t !== null) seek(t);
  };

  const pct = Math.round((tick / total) * 100);
  /** match time, not a percentage (09-04): "37%" does not say where AUTO ends */
  const timeText = `${mmss(tick * SIM_DT)} / ${mmss(total * SIM_DT)}`;
  const setRate = (v: number): void => {
    speedRef.current = v;
    setSpeed(v);
  };
  /**
   * SAVE THE REPLAY WHILE IT IS STILL EXACT — as a VIDEO, mainly.
   *
   * `replayRefusal` retires a replay the moment SIM_VERSION moves, deliberately: a changed sim
   * re-simulates the same inputs into a different game. So the container is perishable, and the
   * only moment it is provably the real match is while this build can still play it. Both
   * exports therefore live on `status === 'ready'`, which IS playable — neither is ever offered
   * for something we could not reproduce anyway.
   *
   * The VIDEO is the one that lasts: it stops being a re-simulation and becomes a recording, so
   * it outlives every patch, needs no sim to watch, and can be sent to someone without DSIM.
   * It is captured off the live canvas in REAL TIME (see `replayVideo.ts`), so a full match
   * takes a full match — the replay restarts from tick 0 and plays through while it records.
   *
   * The JSON stays as the secondary export because it is the only form that is still a REPLAY:
   * re-playable in-sim at full fidelity by any build whose versions match, and the shape the
   * server stores. A video cannot be stepped, seeked in-sim, or verified.
   */
  /**
   * A VIDEO CARRYING THE SPONSOR'S BURN-IN LEFT THE APP.
   *
   * The `replay` placement was declared from the start and counted nothing, so
   * the one surface with reach BEYOND our own traffic — a clip posted to Discord
   * or YouTube, watched by people who never opened DSIM — was the only placement
   * missing from the report. It is not an on-screen impression and `docs/sponsor.md`
   * reports it on its own line: this counts FILES PRODUCED with the mark in them,
   * which is a floor on the views they go on to earn, not an estimate of them.
   *
   * `sponsorActive()` is re-checked because `drawSponsorMark` is what actually
   * decides whether the frames carry the mark — counting an export made after the
   * term ended would bill Offset for a file with no Offset in it.
   */
  const countBurnIn = (ext: string): void => {
    if (sponsorActive()) trackEvent('sponsor_shown', { placement: 'replay', format: ext });
  };

  const filename = (ext: string): string => {
    const r = replay.current;
    const id = replayId ?? r?.seed ?? 0;
    return `dsim-${r?.game ?? 'decode'}-s${r?.balanceVersion ?? 0}-v${r?.sim ?? 0}-${id}.${ext}`;
  };

  const downloadData = (): void => {
    const r = replay.current;
    if (!r) return;
    saveBlob(new Blob([JSON.stringify(r)], { type: 'application/json' }), filename('json'));
  };

  /**
   * SAVE AS A VIDEO, as fast as the machine will go.
   *
   * The FAST path does not touch the live playback at all: it builds its OWN `ReplayPlayer`,
   * steps it frame by frame, draws each frame to the canvas and hands it to `VideoEncoder`
   * stamped at its true 1/60s position. Because the timestamp is carried on the frame rather
   * than taken from the clock, the file comes out the real length of the match however quickly
   * it was produced — measured at 10-19× real time, so a full match saves in about ten seconds.
   *
   * That also deletes the whole class of problem the old capture had. It never used
   * `requestAnimationFrame`, so a backgrounded tab cannot starve it (there is no
   * `visibilitychange` dance any more), and it is not a recording OF the visible canvas, so
   * scrubbing or pausing while it runs cannot end up in the file.
   */
  const startCapture = async (id: VideoFormatId): Promise<void> => {
    const canvas = canvasRef.current;
    const r = replay.current;
    const fmt = videoFormat(id);
    if (!canvas || !r) return;

    // only where this browser has no H.264 encoder at all — see `availableVideoFormats`
    if (!fmt.fast) {
      startRealtime(id);
      return;
    }

    /**
     * PLAYBACK IS NOT TOUCHED, and that is the point of the fast path having its own
     * everything. It runs its own `ReplayPlayer`, its own `Renderer` and its own canvas, so
     * there is nothing on screen for it to disturb — the viewer keeps playing, seeking and
     * pausing while the file encodes behind it. Only the real-time fallback has to lock the
     * screen, because that one is literally filming it.
     */
    abortCapture.current = false;
    setCapturing(id);
    setCapturePct(0);

    /**
     * DECODE THE SPONSOR MARK BEFORE THE FIRST FRAME, not during it. `recordFast`'s
     * `draw` is synchronous and runs once per simulated tick, so an image still
     * loading draws nothing and the burn-in is silently absent from the file — the
     * one failure the placement cannot have. This resolves either way (it falls back
     * to the wordmark), so it can never block or fail an export.
     */
    await loadSponsorMark();

    // its OWN player and renderer, so the capture is the whole match from tick 0 regardless of
    // where the viewer had scrubbed to, and the one on screen is left alone
    const shot = new ReplayPlayer(r);
    const rend = new Renderer();
    const { robotId: localId, alliance } = replayViewpoint(r.setups, viewerRobotId);
    const bounds = moduleFor(r.game).bounds;
    /**
     * RENDER AT THE VIDEO'S RESOLUTION, rather than at the screen's and shrinking each frame.
     *
     * `configure` reads the viewer's LAYOUT (CSS pixels) and the camera works in those, with
     * `dpr` as the only thing tying them to pixels — so retargeting `dpr` makes every frame a
     * real render at the encode size. It used to draw 2496×1074 and `drawImage` it down to
     * 1280, which was both slower and worse looking: a canvas downscale past 2× is a cheap
     * bilinear filter, and what it ruins is exactly the thin tape lines and the small
     * scoreboard type.
     *
     * ⚠️ IT DRAWS INTO ITS OWN CANVAS, NOT THE VISIBLE ONE, and that is not tidiness.
     * Resizing the viewer's canvas here put it in a tug-of-war it could only lose: the click
     * sets `recording`, React then swaps the transport row for the taller recording bar, the
     * canvas's BOX shrinks, and anything re-fitting the backing store to that box (the effect
     * above, a window resize, a rotation) resets it out from under a capture already running.
     * The encoder is configured once, so every frame after that is a smaller canvas scaled up
     * into the same file — the field visibly shrank mid-recording and the video came out of it
     * blurred. Owning a canvas nobody else can touch removes the whole class.
     */
    rend.camera.configure(canvas, alliance, bounds);
    const cssW = rend.camera.w;
    /**
     * ROOM FOR THE SCOREBOARD, when the layout does not already leave it. The camera reserves
     * a bottom band, but it collapses on a short or touch layout and the field is centred in
     * whatever is left, so how much clear space sits under the field depends on the viewer's
     * aspect. Where there is not enough, the FRAME grows rather than the bar moving onto the
     * field: extra letterbox costs nothing and a scoreboard over the match costs the match.
     */
    const cssH = Math.max(rend.camera.h, fieldScreenBottom(rend.camera, bounds) + HUD_RESERVE);
    const { width, height } = encodeSize(cssW, cssH);
    rend.camera.dpr = width / cssW;
    const frame = document.createElement('canvas');
    frame.width = width;
    frame.height = height;
    const ctx = frame.getContext('2d')!;

    const view = {
      width: cssW,
      height: cssH,
      dpr: rend.camera.dpr,
      fieldHeight: rend.camera.h,
      solo: soloSide,
    };

    /**
     * THE 3D CAPTURE (`docs/roadmap.md` item 2, `docs/biobuzz/plan-3d.md` §4.7).
     *
     * A whole second scene, on a HOST OF ITS OWN that is in the document but off-screen. Off
     * -screen because a WebGL canvas in the layout would be a second live renderer competing
     * with the viewer's for the GPU; in the document rather than fully detached because the
     * scene reads `--ds-bg` off `documentElement` at construction and a node outside the tree
     * still resolves it, but an attached host is the case every other code path exercises.
     *
     * `quality: 'high'` FIXES the preset (§4.7): a video must not come out at whatever the
     * machine that made it happened to be set to, and — just as important — a settings change
     * made while the encode runs cannot change the resolution of a file that is half written.
     * `interactive: false` binds no keys and no pointer handlers: an off-screen scene that
     * installed the view key would have the player's `t` press swap a view they cannot see.
     */
    let scene: GameScene | null = null;
    let sceneHost: HTMLDivElement | null = null;
    /**
     * ⚠️ THE OVERLAY GETS ITS OWN CANVAS, AND IT HAS TO.
     *
     * `Renderer.render(..., overlayOnly = true)` opens with `clearRect` over the WHOLE canvas —
     * correct in the live game, where the 2D canvas is a separate transparent sheet ABOVE the
     * WebGL one and has to be wiped every frame. In an export both passes would be aiming at
     * the same canvas, so the overlay pass erased the 3D frame that had just been drawn onto
     * it and every exported frame came out black. (Measured exactly that way: a composite whose
     * average luminance was 0.)
     *
     * So the labels and auto paths are drawn onto a transparent sheet of their own and
     * composited, which is the same stack the live view has, one canvas later.
     */
    let overlay: HTMLCanvasElement | null = null;
    let overlayCtx: CanvasRenderingContext2D | null = null;
    const sceneFn = exportView === '3d' ? moduleFor(r.game).scene : undefined;
    if (sceneFn) {
      try {
        sceneHost = document.createElement('div');
        sceneHost.style.position = 'fixed';
        sceneHost.style.left = '-20000px';
        sceneHost.style.top = '0';
        sceneHost.style.width = `${cssW}px`;
        sceneHost.style.height = `${cssH}px`;
        sceneHost.setAttribute('aria-hidden', 'true');
        document.body.appendChild(sceneHost);
        const factory = await sceneFn();
        scene = await factory(sceneHost, { quality: 'high', interactive: false });
        // CSS units are the viewer's, the DPR carries it up to the encode size — the same two
        // numbers `rend.camera` was retargeted with above, so the scene's pixels and the 2D
        // overlay's land on exactly the same grid and `scene.project` reports CSS pixels the
        // overlay can draw in without a second scale factor.
        scene.resize(cssW, cssH, rend.camera.dpr);
        rend.setScene(scene);
        overlay = document.createElement('canvas');
        overlay.width = width;
        overlay.height = height;
        overlayCtx = overlay.getContext('2d');
      } catch (err) {
        // a scene that will not build is not a failed export: fall through to the 2D path,
        // which is what the menu would have written a minute ago
        // eslint-disable-next-line no-console
        console.warn('3D export unavailable; writing the 2D view instead.', err);
        scene?.dispose();
        scene = null;
        sceneHost?.remove();
        sceneHost = null;
      }
    }

    /**
     * WHAT THE FIELD IS FITTED INTO, when there is a 3D scene.
     *
     * The roadmap's design note says "insets are 0 (the burn-in reserves its own band)". That
     * is true of the 2D path, where the CAMERA reserved the band by being shorter than the
     * frame (`cssH` above is grown past `camera.h` precisely so the scoreboard has clear space
     * under the field). A 3D camera has no such notion: it fits the field into whatever
     * rectangle it is given, so handed the full frame it would put the field UNDER the burn-in.
     * `SceneInsets` is the mechanism that already exists for exactly this, so the bottom band
     * is declared as one and the framing comes out matching the 2D export's.
     */
    const sceneInsets = { top: 0, right: 0, bottom: Math.max(0, cssH - rend.camera.h), left: 0 };
    const sceneFrame = {
      alpha: 0,
      viewAngle: rend.camera.viewAngle,
      camera: exportCam,
      localRobotId: localId,
      width: cssW,
      height: cssH,
      dpr: rend.camera.dpr,
      insets: sceneInsets,
    };

    let blob: Blob | null = null;
    try {
      blob = await recordFast({
        format: id,
        width,
        height,
        fps: Math.round(1 / SIM_DT),
        frames: Math.max(1, r.ticks),
        source: frame,
        draw: () => {
          shot.stepOnce();
          if (scene && overlayCtx && overlay) {
            // THE ORDER IS THE COMPOSITE (§4.7): the scene, then the overlay pass on its own
            // sheet, then both flattened onto the export canvas IN THE SAME TASK (no
            // `preserveDrawingBuffer` — a WebGL backbuffer is only guaranteed readable before
            // the next paint, and `recordFast`'s `draw` is synchronous, which is what makes
            // this legal), then the burn-in on top.
            scene.render(shot.world, sceneFrame);
            rend.render(overlayCtx, shot.world, null, localId, true);
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, width, height);
            ctx.drawImage(scene.element, 0, 0, width, height);
            ctx.drawImage(overlay, 0, 0);
          } else {
            rend.render(ctx, shot.world, null, localId);
          }
          // the scoreboard is DOM in the viewer, so the canvas alone carries no score, no
          // clock and no match start — see `drawReplayHud`. It draws in CSS units, which is
          // why the transform is left where the camera put it.
          drawReplayHud(ctx, shot.world, { ...view, final: shot.done });
        },
        onProgress: setCapturePct,
        cancelled: () => abortCapture.current,
      });
    } catch {
      blob = null;
    } finally {
      // the scene outlives neither a finished export nor a cancelled one
      rend.setScene(null);
      scene?.dispose();
      sceneHost?.remove();
      // ...and nor does the export's own player: a 3D replay's world is wasm memory that only
      // this returns (see `replacePlayer`)
      disposePhysics3dFor(shot.world);
    }

    setCapturing(null);
    setCapturePct(0);
    // an MP4 the encoder would not produce is still an MP4 the browser can FILM, and that is a
    // better answer than silently handing back the JSON
    if (!blob && !abortCapture.current && id === 'mp4' && realtimeMime()) {
      startRealtime(id);
      return;
    }
    // a cancelled capture is not a failure and must not claim to be one
    if (blob) {
      saveBlob(blob, filename(fmt.ext));
      countBurnIn(fmt.ext);
    }
    else if (!abortCapture.current) downloadData();
    // playback is left exactly where the viewer had it — it was never taken away
  };

  /** the REAL-TIME path, for MP4 — `MediaRecorder` over the live canvas. It cannot go faster:
   *  it stamps frames by when they arrive, not by the timestamp they carry. */
  const startRealtime = (id: VideoFormatId): void => {
    const canvas = canvasRef.current;
    const mime = realtimeMime();
    if (!canvas || !mime) {
      downloadData();
      return;
    }
    /**
     * FORCE THE ON-SCREEN VIEW BACK TO 2D, SYNCHRONOUSLY, BEFORE ANYTHING ELSE HERE.
     *
     * This path films the VISIBLE canvas (`captureStream` below): a mounted 3D scene draws the
     * field on its OWN canvas underneath and leaves this one transparent, so a capture taken
     * while the on-screen view is 3D would record nothing but name labels over blank frames.
     * Set directly on a ref rather than through `setRecording`/React state — a state-driven
     * effect lags a render, and any frame captured in that gap is a frame the file keeps.
     */
    realtimeCapture.current = true;
    syncSceneRef.current?.();
    const fmt = videoFormat(id);
    const rec = new MediaRecorder(canvas.captureStream(60), {
      mimeType: mime,
      videoBitsPerSecond: 8_000_000,
    });
    chunks.current = [];
    discard.current = false;
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.current.push(e.data);
    };
    rec.onstop = () => {
      const parts = chunks.current;
      chunks.current = [];
      recorder.current = null;
      stopVisibility.current?.();
      stopVisibility.current = null;
      setRecording(false);
      setCapturing(null);
      // release the forced 2D view and let the on-screen scene follow the preference again
      realtimeCapture.current = false;
      syncSceneRef.current?.();
      if (!discard.current && parts.length) {
        saveBlob(new Blob(parts, { type: mime }), filename(fmt.ext));
        countBurnIn(fmt.ext);
      }
    };
    /**
     * HIDE THE TAB AND A REAL-TIME CAPTURE STARVES — so pause the encoder with it.
     *
     * The render loop is `requestAnimationFrame`, which a browser stops for a background tab.
     * The sim stops advancing but the RECORDER keeps running on the wall clock, holding the
     * last painted frame — measured, a capture of a canvas whose rAF never fired produced a
     * 110-byte file with zero frames in it. Only this path can suffer it; the fast one drives
     * its own loop and never yields to rAF at all.
     */
    const onVisibility = (): void => {
      const cur = recorder.current;
      if (!cur) return;
      if (document.hidden && cur.state === 'recording') cur.pause();
      else if (!document.hidden && cur.state === 'paused') cur.resume();
    };
    document.addEventListener('visibilitychange', onVisibility);
    stopVisibility.current = () => document.removeEventListener('visibilitychange', onVisibility);

    recorder.current = rec;
    /**
     * SWAP THE ROW, RE-FIT, THEN FILM (design review 09-13). The recording bar is taller than
     * the transport row it replaces (its note wraps), and the refit effect deliberately skips
     * while a capture runs — so it has to happen HERE, after React has committed the bar
     * (`flushSync`) and before the first frame is recorded. Otherwise the field is squashed for
     * the whole file. On stop, `onstop` clears `recorder` first, so the effect re-fits then.
     */
    flushSync(() => {
      setCapturing(id);
      setRecording(true);
    });
    refit.current?.();
    setRate(1); // a real-time capture IS real time: the file and the "left" readout assume 1×; left at 1× after, on purpose
    rebuild(); // record the whole match, not from wherever the viewer is paused
    rec.start();
    playingRef.current = true;
    setPlaying(true);
  };

  const cancelRecording = (): void => {
    abortCapture.current = true;
    discard.current = true;
    const cur = recorder.current;
    if (!cur) return; // a fast capture stops between frames and never held playback
    // a PAUSED recorder still has to be stopped to fire `onstop` and release the stream
    if (cur.state !== 'inactive') cur.stop();
    playingRef.current = false;
    setPlaying(false);
  };

  /**
   * CAN THIS REPLAY BE EXPORTED IN 3D? Two independent questions, both cheap, both answered on
   * the frame the menu opens rather than on every render.
   *
   *   1. Does the GAME have a scene at all (`GameModule.scene`)? DECODE and Chain Reaction do
   *      not, and never will from this menu — they have no 3D renderer.
   *   2. Will this browser give us WebGL2? The probe is a throwaway canvas that is never
   *      attached; `loseContext` hands the context straight back, so opening the menu twenty
   *      times does not exhaust the page's context budget.
   *
   * Deliberately NOT the same probe `renderScene.ts` runs: that one lives in the renderer chunk
   * and importing it here would drag Three.js into the main bundle to answer a yes/no question.
   */
  const probe3d = (): boolean => {
    const r = replay.current;
    if (!r || !moduleFor(r.game).scene) return false;
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      if (!gl) return false;
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return true;
    } catch {
      return false;
    }
  };

  /**
   * WHAT THE ON-SCREEN SCENE WOULD PICK IF LEFT TO THE DEVICE (`mqCoarse` in the render-loop
   * effect, reproduced here rather than shared through a ref: it's one `matchMedia` read, and
   * the render-loop effect only exists while a scene might be mounted). This is the `hostPick`
   * half of `resolveSceneCamera` — the other half, the device's own camera preference, is
   * `getCameraPref()` below.
   */
  const hostCameraPick = (): SceneCamera =>
    typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
      ? 'overhead'
      : 'driver';

  /** Measure the container ONCE, on open. Stringifying it is cheap, but this component
   *  re-renders 10 times a second off the progress readout, and a menu that re-serializes the
   *  whole replay on every one of those is a menu that stutters while it is open. */
  const openMenu = (): void => {
    const r = replay.current;
    if (r && !menuOpen) {
      setDataBytes(new Blob([JSON.stringify(r)]).size);
      const can3d = probe3d();
      setCan3d(can3d);
      // the device's own view preference is the default, but only where it is possible
      setExportView(resolveReplayView(getViewPref(), can3d));
      /**
       * THE CAMERA DEFAULTS TO WHAT THE ON-SCREEN SCENE IS ACTUALLY SHOWING, not a hardcoded
       * literal. `renderScene.ts`'s own `resolvedCamera` runs exactly this — `resolveSceneCamera
       * (this.interactive, hostPick, this.cameraPref)` — every frame, against the SAME
       * `graphics/store.ts` camera preference the scene reads at construction and rewrites on
       * every `c` key press (`setCameraPref`). Reading that store here, rather than asking the
       * mounted `GameScene` for its camera (the interface has no such getter, and adding one
       * would mean editing `games/module.ts` and the scene's own file, both outside this fix),
       * means there is still exactly one owner of "which camera" — the store — and this menu
       * just reads it the same way the scene does. The on-screen scene is always constructed
       * interactive (see the render-loop effect), so `interactive` is `true` here too.
       */
      setExportCam(resolveSceneCamera(true, hostCameraPick(), getCameraPref()));
    }
    setMenuOpen((v) => !v);
  };
  const pick = (fn: () => void): void => {
    setMenuOpen(false);
    fn();
  };

  // a record run has one alliance on the field — showing "0" for an opponent that
  // never existed reads as a shutout, so those get a single score instead.
  const alliances = new Set((replay.current?.setups ?? []).map((s) => s.alliance));
  const solo = alliances.size < 2;
  const soloSide = solo ? ([...alliances][0] ?? 'blue') : null;
  // FINAL only at the recorded end: a replay runs up to the tick its match was FINALIZED, and
  // between the buzzer and that tick the score can still change
  const done = player.current?.done ?? false;
  // the REAL-TIME capture runs at 1×, so what is left of the replay is what is left of it
  const runtime = total * SIM_DT;
  /** a fast save is running in the background; the viewer stays fully usable */
  const saving = capturing !== null && !recording;
  /**
   * FLOORED, and never 100 while there is still work. The frame loop only owns `ENCODE_SHARE`
   * of the bar — the flush, the muxer and handing a blob of tens of megabytes to the browser
   * all come after it — and rounding UP put the readout at 100% with all of that still to
   * come, which reads as a hang.
   */
  const savePct = Math.min(99, Math.floor(capturePct * 100));
  const finishing = capturePct >= ENCODE_SHARE;
  /**
   * What a FAST save costs, in the menu, from the match's own length.
   *
   * It used to read a flat "~10s", which was true of the clip it was written against and a lie
   * about a full match — the point of the label is that the formats differ in cost, so it has
   * to track the thing that actually varies. `FAST_ENCODE_SPEED` is the measured multiple of
   * real time (5.2-5.7× across every codec and quantizer tried at 1920), rounded DOWN to be
   * the pessimistic end of that range rather than the flattering one.
   */
  // PHASE OVER CLOCK, in the live HUD's words (09-07). `hudLabels` says FINAL only at the
  // recorded end and MATCH OVER in the settling window before it, as the old ternary did.
  const mid = (
    <span className="rs-mid">
      <span className="rs-phase">{labels.phase}</span>
      {labels.clock && <span className="rs-clock">{labels.clock}</span>}
    </span>
  );
  const fastEta = `~${Math.max(5, Math.round(runtime / FAST_ENCODE_SPEED))}s`;
  const remaining = Math.max(0, total - tick) * SIM_DT;


  return (
    <div className="ds-replay">
      <div className="ds-replay-top">
        <button className="ds-btn ghost" onClick={onClose}><span aria-hidden="true">←</span> Back</button>
        {/* THE SAVE STATUS LIVES IN THE HEADER, and that is not a cosmetic choice: a strip of
            its own above the transport row steals height from the canvas, which then re-fits
            to a shorter box and SQUASHES the field halfway through a recording. A background
            job must not reflow the thing it is running behind. This row is already here and
            its height is set by the buttons in it, so nothing below it moves. */}
        {saving ? (
          <div className="ds-replay-saving">
            <span className="rec-dot" aria-hidden="true" />
            <span className="rec-label">
              {finishing ? 'Finishing' : `Saving ${videoFormat(capturing!).label}`}
            </span>
            <div
              className="rec-track"
              role="progressbar"
              aria-label="Save progress"
              aria-valuenow={savePct}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="rec-fill" style={{ width: `${Math.max(savePct, 2)}%` }} />
            </div>
            <span className="rec-eta">{savePct}%</span>
            <button className="ds-btn ghost" onClick={cancelRecording}>Cancel</button>
          </div>
        ) : (
          <h1 className="ds-panel-title">Replay</h1>
        )}
        {/* DOWNLOAD BELONGS HERE, not in the transport row below: it is an action on the
            replay, not on playback, and two ghost buttons wedged between the seek bar and the
            clock read as two more transport controls. The header is a 1fr/auto/1fr grid, so
            the title is centred whatever sits either side of it (design review 09-14). */}
        {status === 'ready' && (
          <div className="ds-replay-actions">
            {/* SHOW THE MATCH IN THE GRAPHICS THE PLAYER DEFINED (`docs/roadmap.md` item 2):
                starts from the device's own view preference (`getViewPref`, see the
                render-loop effect's `syncScene`) and lets them switch without leaving the
                replay, exactly like the live match's own `t` key. Hidden for DECODE/Chain
                Reaction, which have no 3D renderer to switch to. */}
            {replay.current && moduleFor(replay.current.game).scene && (
              // BOTH choices on screen, not one button whose label is the current state: that
              // said "2D, toggle button, not pressed" to a screen reader while showing 2D.
              <div className="ds-segs" role="group" aria-label="View">
                {(['2d', '3d'] as const).map((v) => (
                  <button
                    key={v}
                    className={`ds-seg${view === v ? ' on' : ''}`}
                    aria-pressed={view === v}
                    disabled={recording}
                    title={viewKeyName('viewToggle') ? `Press ${viewKeyName('viewToggle')} to switch` : undefined}
                    onClick={() => {
                      if (view !== v) toggleViewPref();
                    }}
                  >
                    {v.toUpperCase()}
                  </button>
                ))}
              </div>
            )}
            <div className="ds-dl" ref={menuRoot}>
              <button
                className={`ds-btn${menuOpen ? ' primary' : ''}`}
                ref={menuBtn}
                onClick={openMenu}
                disabled={recording || saving}
                aria-expanded={menuOpen}
                aria-controls="ds-dl-pop"
              >
                <span aria-hidden="true">↓</span> Download
              </button>
              {menuOpen && (
                <div className="ds-dl-pop" id="ds-dl-pop" role="group" aria-label="Download options">
                  {/* Each option states its COST as well as its name — the formats differ by how
                      long they take and where they will play, and a menu of bare nouns hides
                      exactly the difference that decides which you want. */}
                  {/* WHAT THE VIDEO IS OF, before what file it goes into. Two compact rows rather
                      than two more full-width options: they modify every format below them, and a
                      card that looked like the MP4 card would read as a third thing to download.
                      The 3D button is DISABLED, not hidden, where it is unavailable — its title
                      then says which of the two reasons it is, because "this game has no 3D
                      renderer" and "this browser has no WebGL2" want different answers from the
                      person reading it. */}
                  <div className="ds-dl-row">
                    <span className="rl">View</span>
                    <div className="ds-segs" role="group" aria-label="View">
                      <button
                        className={`ds-seg${exportView === '2d' ? ' on' : ''}`}
                        aria-pressed={exportView === '2d'}
                        onClick={() => setExportView('2d')}
                      >
                        2D
                      </button>
                      <button
                        className={`ds-seg${exportView === '3d' ? ' on' : ''}`}
                        aria-pressed={exportView === '3d'}
                        disabled={!can3d}
                        title={
                          can3d
                            ? undefined
                            : replay.current && moduleFor(replay.current.game).scene
                              ? 'This browser has no WebGL2.'
                              : 'This season has no 3D renderer.'
                        }
                        onClick={() => setExportView('3d')}
                      >
                        3D
                      </button>
                    </div>
                  </div>
                  {exportView === '3d' && (
                    <div className="ds-dl-row">
                      <span className="rl">Camera</span>
                      <div className="ds-segs" role="group" aria-label="Camera">
                        {(['driver', 'chase', 'orbit', 'free'] as const).map((c) => (
                          <button
                            key={c}
                            className={`ds-seg${exportCam === c ? ' on' : ''}`}
                            aria-pressed={exportCam === c}
                            onClick={() => setExportCam(c)}
                          >
                            {c[0].toUpperCase() + c.slice(1)}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {formats.length === 0 && <p className="ds-dl-note">This browser can’t save video.</p>}
                  {formats.map((f) => (
                    <button
                      key={f.id}
                      className="ds-dl-opt"
                      onClick={() => pick(() => void startCapture(f.id))}
                    >
                      <span className="dl-h">
                        {f.label}
                        <em>{f.fast ? fastEta : mmss(runtime)}</em>
                      </span>
                      <span className="dl-d">{f.note}</span>
                    </button>
                  ))}
                  <button className="ds-dl-opt" onClick={() => pick(downloadData)}>
                    <span className="dl-h">
                      Replay data
                      <em>{dataBytes ? `${Math.max(1, Math.round(dataBytes / 1024))} KB` : '.json'}</em>
                    </span>
                    <span className="dl-d">
                      The input log. Plays in DSIM on balance v{BALANCE_VERSION}, sim v
                      {SIM_VERSION}.
                    </span>
                  </button>
                  <p className="ds-dl-note">
                    Replays only play on the version that recorded them. Videos always play.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {status === 'loading' && <div className="ds-loading">Loading replay…</div>}
      {status === 'error' && (
        <div className="ds-empty">
          <div className="big">Couldn’t load the replay</div>
          {error}
        </div>
      )}
      {status === 'private' && (
        <div className="ds-empty">
          <div className="big">This replay is private</div>
          {error}
          {/* only the MATCH case has a setting behind it, so only that one points at it */}
          {error.includes('played in the match') &&
            ' A replay shows both alliances’ strategy, so it stays with the people who played' +
              ' it. You can publish your own from Profile › Privacy.'}
        </div>
      )}
      {status === 'stale' && (
        <div className="ds-empty">
          <div className="big">Replay unavailable</div>
          {refusal && replay.current ? REFUSAL_TEXT[refusal](replay.current) : ''}
          {/* a FUTURE container is not a retired one — the score line would read as consolation
              for something a refresh fixes */}
          {refusal !== 'future' && ' The score on the leaderboard still stands.'}
        </div>
      )}
      {status === 'ready' && drift && replay.current && (
        <p className="ds-replay-drift">{DRIFT_TEXT[drift](replay.current)}</p>
      )}
      {status === 'ready' && (
        <div className={`ds-replay-score${done ? ' final' : ''}`}>
          {solo ? (
            <>
              <span className={`rs-side ${soloSide}`}>{soloSide === 'red' ? 'RED' : 'BLUE'}</span>
              <b className="rs-num">{soloSide === 'red' ? score.red : score.blue}</b>
            </>
          ) : (
            <>
              <span className="rs-side red">RED</span>
              <b className="rs-num">{score.red}</b>
              {mid}
              <b className="rs-num">{score.blue}</b>
              <span className="rs-side blue">BLUE</span>
            </>
          )}
          {solo && mid}
        </div>
      )}
      {/* PENALTIES, ON THE FACE OF IT. One always-present row under the scoreboard, mirroring
          its RED · middle · BLUE order, saying what each alliance has been called for and what
          those calls are worth. A clean match says so — "no fouls" is an answer, and hiding
          the row when there are none would mean a watcher could never tell the difference
          between a clean match and a viewer that does not show fouls. The TIMELINE is behind
          the button, because a list of calls does not need to cost the field its height. */}
      {status === 'ready' && (
        <div className="ds-replay-pen">
          {/* A RECORD RUN HAS ONE ALLIANCE ON THE FIELD, and its fouls are "awarded" to an
              opponent that never existed — the same phantom the score strip already refuses
              to print a 0 for. So a solo replay gets ONE chip, and what it reports is what
              those fouls COST: the record screen's net score is exactly this subtraction. */}
          {solo ? (
            <FoulChip side={soloSide as 'red' | 'blue'} t={fouls[soloSide as 'red' | 'blue']} cost={fouls[soloSide === 'red' ? 'blue' : 'red'].awarded} />
          ) : (
            <FoulChip side="red" t={fouls.red} />
          )}
          <button
            // NOT `ghost primary`: `.ds-btn.ghost` is declared after `.ds-btn.primary` and
            // wins on `background: none` while primary's white `color` stays, so the label
            // goes invisible on a light bar. One or the other, never both.
            className={railOpen ? 'ds-btn small primary' : 'ds-btn ghost small'}
            onClick={() => setRailOpen((v) => !v)}
            aria-expanded={railOpen}
          >
            {railOpen ? 'Hide details' : 'Details'}
            {penalties.length > 0 && ` (${penalties.length})`}
          </button>
          {!solo && <FoulChip side="blue" t={fouls.blue} />}
        </div>
      )}

      {/* the field and the rail share a row, so opening the rail narrows the canvas instead of
          shortening it — the camera fits the field to the SHORTER of its two spans, and height
          is the one the HUD bands are already eating into */}
      <div className="ds-replay-stage">
        {/* BIOBUZZ 3D SEAM, one screen over from `.game-viewport` (styles.css), reused here:
            the box a live scene mounts its own canvas into, UNDER the 2D one — whichever lands
            LAST in the DOM wins the stack (both `position:absolute`, `z-index:auto`), and the
            render-loop effect inserts the scene's canvas BEFORE this one. A replay with no
            scene (DECODE, Chain Reaction, or a WebGL2-less browser) never gets a second
            canvas, so this box holds exactly the one canvas it always did. */}
        <div ref={sceneHostRef} className="ds-replay-viewport game-viewport">
          <canvas ref={canvasRef} className="ds-replay-canvas" style={{ display: status === 'ready' ? 'block' : 'none' }} />
        </div>
        {status === 'ready' && railOpen && (
          <aside className="ds-replay-rail">
            <PenaltyLog entries={penalties} done={done} solo={solo} onSeek={seek} />
            {adminMatchId && (
              <ScoreEditor matchId={adminMatchId} live={score} onSeekEnd={playToEnd} />
            )}
          </aside>
        )}
      </div>

      {/* THE REAL-TIME FALLBACK REPLACES THE TRANSPORT ROW rather than greying it out: it is
          filming this canvas, so scrubbing mid-record would scrub the file, and a row of dead
          controls beside a "● REC 12%" label does not explain that. */}
      {status === 'ready' && recording && (
        <div className="ds-replay-rec">
          <span className="rec-dot" aria-hidden="true" />
          <span className="rec-label">Recording video</span>
          <div
            className="rec-track"
            role="progressbar"
            aria-label="Recording progress"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="rec-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="rec-eta">{mmss(remaining)} left</span>
          <button className="ds-btn ghost" onClick={cancelRecording}>Cancel</button>
          <p className="rec-note">
            This browser can only film the match in real time, so playback is locked until it
            finishes. Keep this tab in front: a hidden tab stops drawing and the recording
            pauses with it.
          </p>
        </div>
      )}

      {status === 'ready' && !recording && (
        <div className="ds-replay-controls">
          {/* BOTH labels are always rendered, stacked in one cell with the idle one hidden, so the
              button is as wide as the wider label in every state — it sits beside the flex seek
              bar, and a label change used to resize the slider under the pointer. "Play" from
              the end restarts (`setPlay`), so it needs no "again" of its own. */}
          <button className="ds-btn primary ds-replay-play" onClick={() => setPlay(!playing)}>
            <span className={playing ? undefined : 'off'}>
              <span aria-hidden="true">❚❚</span> Pause
            </span>
            <span className={playing ? 'off' : undefined}>
              <span aria-hidden="true">▶</span> Play
            </span>
          </button>
          <button className="ds-btn" onClick={rebuild}><span aria-hidden="true">⟲</span> Restart</button>
          {/* the segmented idiom the header's 2D/3D uses: every rate on screen, the live one on */}
          <div className="ds-segs" role="group" aria-label="Playback speed">
            {SPEEDS.map((v) => (
              <button
                key={v}
                className={`ds-seg${speed === v ? ' on' : ''}`}
                aria-pressed={speed === v}
                onClick={() => setRate(v)}
              >
                {v}×
              </button>
            ))}
          </div>
          <input
            type="range"
            className="ds-replay-seek"
            min={0}
            max={total}
            value={tick}
            style={rangeFill(tick, 0, total)}
            onChange={(e) => {
              const t = Number(e.target.value);
              if (e.target.hasPointerCapture(lastPointer.current) && t < player.current!.world.tick) {
                scrubTo.current = t;
                setTick(t);
              } else {
                scrubTo.current = null;
                seek(t);
              }
            }}
            onPointerDown={(e) => {
              lastPointer.current = e.pointerId;
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onLostPointerCapture={commitScrub}
            aria-label="Seek"
            aria-valuetext={timeText}
            title="Space plays or pauses. ← and → jump 5 seconds."
          />
          <span className="ds-replay-time">{timeText}</span>
        </div>
      )}
    </div>
  );
}

/**
 * One alliance's penalty chip.
 *
 * It reports TWO different things and has to keep them apart, because they belong to opposite
 * alliances: the fouls this alliance COMMITTED (a count) and the points its opponent's fouls
 * AWARDED it (part of its own total). Printing one number would be printing whichever of the
 * two the reader did not mean.
 */
function FoulChip({ side, t, cost }: { side: 'red' | 'blue'; t: FoulTally; cost?: number }) {
  // on a SOLO run there is no opponent to award anything to, so `awarded` is always 0 and the
  // number that matters is what this alliance's own fouls took OFF its net
  const solo = cost !== undefined;
  const clean =
    t.minor === 0 && t.major === 0 && t.yellow === 0 && t.red === 0 && t.awarded === 0 && !cost;
  return (
    <span className="pen-chip">
      <span className={`pen-side ${side}`}>{side === 'red' ? 'RED' : 'BLUE'}</span>
      {clean ? (
        <span className="pen-clean">No fouls</span>
      ) : (
        <>
          {(t.minor > 0 || t.major > 0) && (
            <span className="pen-count ds-num">
              {t.minor} MIN · {t.major} MAJ
            </span>
          )}
          {solo
            ? (cost as number) > 0 && <span className="pen-awarded"><span className="ds-num">−{cost}</span> from the score</span>
            : t.awarded > 0 && <span className="pen-awarded"><span className="ds-num">+{t.awarded}</span> awarded</span>}
          {/* the card's NAME is on the chip, not just its colour (design review 09-02, WCAG 1.4.1) */}
          {t.yellow > 0 && <span className="pen-card yellow"><span aria-hidden="true">■ {t.yellow} YC</span><span className="ds-sr">{t.yellow} yellow card{t.yellow > 1 ? 's' : ''}</span></span>}
          {t.red > 0 && <span className="pen-card red"><span aria-hidden="true">■ {t.red} RC</span><span className="ds-sr">{t.red} red card{t.red > 1 ? 's' : ''}</span></span>}
        </>
      )}
    </span>
  );
}
