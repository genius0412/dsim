import type {
  Alliance,
  ArtifactColor,
  DrivetrainType,
  GameMode,
  MatchPhase,
  Motif,
  RobotCommand,
  RobotState,
  ScoreBreakdown,
  World,
  GameSettings,
} from './types';
import * as C from './config';
import { createWorld, DEFAULT_ASSISTS, DEFAULT_SPEC, type RobotSetup } from './sim/spawn';
import { step } from './sim/world';
import { startMatch } from './sim/match';
import { robotInLaunchZone } from './sim/robot';
import { InputManager } from './input/input';
import { Renderer } from './render/renderer';
import { MatchAudio } from './audio';
import type { MatchResultInfo, NetSession, NetStatus, Snapshot } from './net/session';
import { localizeCommand } from './net/protocol';
import type { RecordRankInfo } from './net/protocol';

// GameSettings is defined canonically in ./types; re-exported here because many
// modules import it from './game'.
export type { GameSettings };

// Visual error-smoothing on reconcile: EVERY robot stays predicted at present time
// (local for zero input lag; remotes predicted forward from their held command so
// their collisions are simulated, not lagged). The snapshot correction is eased in
// over ~SMOOTH_HALFLIFE as a cosmetic offset, or SNAPs past SMOOTH_MAX_DIST (a real
// desync, not jitter). This replaces the old past-time entity interpolation, which
// drew remotes ~RTT/2+66ms behind where physics actually collided them — the cause
// of phantom robot-robot contacts and visual overlap at high ping. Rendering remotes
// at their predicted-present pose keeps client physics aligned with the server (so
// pushing/pinning doesn't rubberband), and the eased offset hides snapshot jitter.
const SMOOTH_HALFLIFE = 0.06; // s — the offset halves every 60ms (~gone in 200ms)
const SMOOTH_MAX_DIST = 16; // in — larger corrections snap instead of floating

export interface Toast {
  id: number;
  text: string;
  at: number; // performance.now() ms
}

/** one driver's overall-ELO change on the results screen (ranked matches only) */
export interface EloResultRow {
  robotId: number;
  name: string;
  alliance: Alliance;
  before: number;
  after: number;
  isLocal: boolean;
  /** Glicko rating deviation after the game — high ⇒ provisional rating */
  provisional: boolean;
}

/** one driver's pre-match intro card (ranked matches only) */
export interface IntroPlayer {
  robotId: number;
  name: string;
  teamName: string;
  teamNumber: number;
  drivetrain: DrivetrainType;
  alliance: Alliance;
  /** current ranked ELO, or null if unranked / signed out */
  elo: number | null;
  isLocal: boolean;
}

export interface HudSnapshot {
  mode: GameMode;
  phase: MatchPhase;
  timeLeft: number;
  alliance: Alliance;
  motif: Motif;
  score: ScoreBreakdown;
  oppTotal: number;
  /** the opponent alliance's full breakdown (for the match-results screen) */
  oppScore: ScoreBreakdown;
  provisionalPattern: number;
  /** fouls committed BY each alliance (counts, for the HUD chip) */
  fouls: Record<Alliance, { minor: number; major: number }>;
  fieldCentric: boolean;
  aimAssist: boolean;
  autoIntake: boolean;
  autoFire: boolean;
  hopper: ArtifactColor[];
  inLaunchZone: boolean;
  gamepadConnected: boolean;
  /** drive controls reversed so the shooter side leads (robot-centric only) */
  frontFlipped: boolean;
  /** park mode active (speed capped to parkSpeedPct); only activatable in
   * endgame / free drive, per canPark() */
  parked: boolean;
  /** can park mode be TURNED ON right now (endgame or free drive)? drives the
   * HUD hint so the driver knows why the button isn't doing anything yet */
  canPark: boolean;
  gateOpen: boolean;
  rampCount: number;
  classifiedCount: number;
  overflowCount: number;
  /** pre-match "3-2-1" countdown value, or null when not counting down */
  countdown: number | null;
  /** performance.now() ms at which the end-of-match fanfare (whoosh) fires and
   * the results reveal should land; null except during phase 'post' */
  resultRevealAt: number | null;
  toasts: Toast[];
  /** multiplayer status (null in solo): stall target + desync + connection quality */
  net: NetStatus | null;
}

export class GameController {
  private world: World;
  private readonly input: InputManager;
  private readonly renderer = new Renderer();
  private readonly ctx: CanvasRenderingContext2D;
  private readonly audio = new MatchAudio();
  private raf = 0;
  private lastT = 0;
  private acc = 0;
  private lastCmd: RobotCommand | null = null;
  private toasts: Toast[] = [];
  private toastId = 0;
  private disposed = false;
  private prevPhase: MatchPhase;
  private warningPlayed = false;
  /** performance.now() ms when the match entered phase 'post' (drives the
   * whoosh-synced results reveal); null until the match ends */
  private matchOverAt: number | null = null;
  /** world.time when the pre-match countdown began (null = not started) */
  private countdownStart: number | null = null;
  private lastBeepAt = -1;
  private lastTransitionBeep = -1;
  private hudCountdown: number | null = null;
  /** drive controls reversed so the shooter side leads (robot-centric only) */
  private frontFlipped = false;
  /** park mode: caps drive command magnitude to settings.parkSpeedPct while on */
  private parked = false;
  // action-SFX edge trackers per robot id (seeded in seedActionAudio)
  private prevFireAt: Record<number, number> = {};
  private prevIntakeAt: Record<number, number> = {};
  private prevGateOpen: Record<Alliance, boolean> = { red: false, blue: false };

  /** the local player's robot id (slot 0 in solo; assigned by the lobby in
   * multiplayer) */
  readonly localRobotId: number;
  /** null in solo; the server-authoritative session in multiplayer */
  private readonly session: NetSession | null;
  /** multiplayer sim-step timer (survives tab backgrounding); 0 = solo */
  private simTimer = 0;
  private lastSimT = 0;
  /** predict/reconcile input buffer: local commands not yet folded into a server
   * snapshot, replayed forward after each reconcile (keyed by the tick produced) */
  private inputBuf: { tick: number; cmd: RobotCommand }[] = [];
  /** VISUAL-only offset for the local robot, set on each reconcile so a snapshot
   * correction is eased in (render loop decays it) instead of snapping — hides
   * rubberbanding from jittery snapshots. Never affects `this.world`. */
  private localSmooth = { x: 0, y: 0, heading: 0 };
  /** VISUAL-only per-remote-robot correction offset, same role as `localSmooth` but
   * keyed by robot id: each remote is predicted forward at present time and its
   * snapshot correction is eased in here (render loop decays it). Rendering remotes
   * at present (predicted+offset) rather than interpolated-in-the-past is what keeps
   * seen positions == collided positions. Never affects `this.world`. */
  private remoteSmooth = new Map<number, { x: number; y: number; heading: number }>();
  /** each remote robot's latest command (from the newest snapshot), held to
   * PREDICT it forward so its collisions are simulated, not faked */
  private remoteCmds = new Map<number, RobotCommand>();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private settings: GameSettings,
    session: NetSession | null = null,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.session = session;
    this.localRobotId = session ? session.localRobotId : 0;
    this.audio.soundsEnabled = settings.audio.sounds;
    this.audio.voiceEnabled = settings.audio.voice;
    this.input = new InputManager(settings.bindings);

    // Mobile Mode: enable assists by default if touch-capable
    if (window.matchMedia('(pointer: coarse)').matches) {
      this.settings.assists.aimAssist = true;
      this.settings.assists.autoFire = true;
      this.settings.assists.autoIntake = true;
    }

    this.world = this.makeWorld();
    this.prevPhase = this.world.match.phase;
    this.seedActionAudio();
    session?.onRestart(() => this.rebuildFromNet());
    this.input.attach();
    window.addEventListener('resize', this.onResize);
    this.onResize();
    // Multiplayer must keep simulating + producing inputs even when the tab is
    // unfocused (else every peer stalls waiting on it), so drive the sim from a
    // timer (+ audio keepalive to defeat background throttling) and use rAF for
    // RENDER only. Solo stays on the plain rAF loop.
    if (session) {
      this.audio.startKeepAlive();
      this.lastSimT = performance.now();
      this.simTimer = window.setInterval(this.simStep, 1000 * C.SIM_DT);
    }
    this.raf = requestAnimationFrame(this.loop);
  }

  /** expose input manager for mobile controls */
  getInputManager() {
    return this.input;
  }

  private localRobot() {
    return this.world.robots.find((r) => r.id === this.localRobotId) ?? this.world.robots[0];
  }

  /** the alliance whose viewpoint the camera + HUD use — the LOCAL robot's
   * alliance (in multiplayer this is the lobby pick, which can differ from the
   * menu's settings.alliance; in solo they are the same) */
  private viewAlliance(): Alliance {
    return this.localRobot().alliance;
  }

  private makeWorld(): World {
    // multiplayer: everyone builds the identical world the host authored and
    // runs a SIM-DRIVEN countdown (transition lives in stepMatch, so it fires
    // on the same tick for every peer — no controller-local start/seed)
    if (this.session) {
      const w = createWorld('match', this.session.seed, this.session.setups, this.settings);
      w.match.preCountdown = C.PRE_COUNTDOWN;
      return w;
    }
    const seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
    const s = this.settings;
    const setups: RobotSetup[] = [
      {
        id: 0,
        alliance: s.alliance,
        spec: s.spec,
        assists: s.assists,
        startIndex: s.startIndex,
        autoPath: s.autoPath ?? undefined,
        autoPathEnabled: s.autoPathEnabled,
      },
    ];
    if (s.mode === 'free' && s.practiceDummies) {
      // three idle default robots as physical obstacles / parking practice
      const opp: Alliance = s.alliance === 'blue' ? 'red' : 'blue';
      const dummy = (id: number, alliance: Alliance, startIndex: number): RobotSetup => ({
        id,
        alliance,
        spec: { ...DEFAULT_SPEC, name: `Dummy ${id}`, teamName: 'Practice', teamNumber: 0 },
        assists: { ...DEFAULT_ASSISTS, autoIntake: false, autoFire: false },
        startIndex,
      });
      setups.push(
        dummy(1, s.alliance, s.startIndex === 1 ? 2 : 1),
        dummy(2, opp, 0),
        dummy(3, opp, 1),
      );
    }
    return createWorld(s.mode, seed, setups, this.settings);
  }

  private onResize = (): void => {
    this.renderer.camera.configure(this.canvas, this.viewAlliance());
  };

  private handlePhaseAudio(): void {
    const phase = this.world.match.phase;
    if (phase !== this.prevPhase) {
      if (phase === 'auto') this.audio.play('start');
      if (phase === 'transition') this.audio.play('end');
      if (phase === 'teleop' && this.prevPhase === 'transition') this.audio.play('resume');
      if (phase === 'post') {
        this.audio.play('end');
        // record the moment the match ended so the results screen can hold its
        // score reveal until the whoosh lands (both use MATCH_RESULT_REVEAL_MS)
        this.matchOverAt = performance.now();
        window.setTimeout(() => {
          if (!this.disposed && this.world.match.phase === 'post') this.audio.play('match_result');
        }, C.MATCH_RESULT_REVEAL_MS);
      }
      this.prevPhase = phase;
    }
    if (
      phase === 'teleop' &&
      !this.warningPlayed &&
      this.world.match.phaseTimeLeft <= C.ENDGAME_START
    ) {
      this.warningPlayed = true;
      this.audio.play('warning');
    }
    // announcer during the transition, like a real event:
    // "Drivers, pick up your controllers" ... "3, 2, 1" -> firebell
    if (phase === 'transition') {
      const left = this.world.match.phaseTimeLeft;
      if (left <= 6.5 && this.lastTransitionBeep === -1) {
        this.lastTransitionBeep = 4;
        this.audio.say('Drivers, pick up your controllers');
      }
      const n = Math.ceil(left);
      if (n <= 3 && n >= 1 && n < this.lastTransitionBeep) {
        this.lastTransitionBeep = n;
        this.audio.say(String(n), true); // interrupt: land exactly on the beat
      }
    } else {
      this.lastTransitionBeep = -1;
    }
  }

  /** align the SFX edge trackers with a freshly created world so world
   * creation/restart never plays a phantom shoot/intake/gate cue */
  private seedActionAudio(): void {
    this.prevFireAt = {};
    this.prevIntakeAt = {};
    for (const r of this.world.robots) {
      this.prevFireAt[r.id] = r.lastFireAt;
      this.prevIntakeAt[r.id] = r.lastIntakeAt;
    }
    this.prevGateOpen = {
      red: this.world.goals.red.gateOpen,
      blue: this.world.goals.blue.gateOpen,
    };
  }

  /** shoot / intake / gate effects, edge-detected from world state (the sim
   * core stays event-free for these — same pattern as handlePhaseAudio).
   * All robots share the small field, so everyone's actions are audible. */
  private handleActionAudio(): void {
    for (const r of this.world.robots) {
      if (r.lastFireAt !== this.prevFireAt[r.id]) {
        this.prevFireAt[r.id] = r.lastFireAt;
        this.audio.sfxShoot();
      }
      if (r.lastIntakeAt !== this.prevIntakeAt[r.id]) {
        this.prevIntakeAt[r.id] = r.lastIntakeAt;
        this.audio.sfxIntake();
      }
    }
    for (const a of ['red', 'blue'] as Alliance[]) {
      const open = this.world.goals[a].gateOpen;
      if (open && !this.prevGateOpen[a]) this.audio.sfxGate();
      this.prevGateOpen[a] = open;
    }
  }

  /** announcer: "Match begins in 3, 2, 1". Multiplayer mirrors the deterministic
   * sim countdown (world.match.preCountdown); solo runs off a keypress. */
  private updateCountdown(): number | null {
    if (this.world.match.phase !== 'pre') return null;

    // multiplayer: the sim owns the countdown + the pre→auto transition; the
    // controller only voices/announces it (audio is non-authoritative)
    if (this.session) {
      const left = this.world.match.preCountdown;
      if (left == null) return null;
      return this.voiceCountdown(left);
    }

    // solo: controller-driven, transitions the match itself
    if (this.countdownStart === null) return null;
    const remaining = C.PRE_COUNTDOWN - (this.world.time - this.countdownStart);
    if (remaining <= 0) {
      this.countdownStart = null;
      startMatch(this.world);
      return null;
    }
    return this.voiceCountdown(remaining);
  }

  /** shared: emit the spoken count on each new digit, return the HUD value */
  private voiceCountdown(remaining: number): number {
    const n = Math.ceil(remaining);
    if (n !== this.lastBeepAt) {
      this.lastBeepAt = n;
      // numbers interrupt any in-flight speech so the spoken count always
      // lands exactly on the visual digit
      if (n >= C.PRE_COUNTDOWN) this.audio.say('Match begins in');
      else this.audio.say(String(n), true);
    }
    return n; // > 3 means the "Match begins in" lead-in
  }

  /** can park mode be turned ON right now? Last ENDGAME_START seconds of
   * teleop, or anywhere in free drive (which has no match clock) */
  private canPark(): boolean {
    const m = this.world.match;
    return m.phase === 'freeplay' || (m.phase === 'teleop' && m.phaseTimeLeft <= C.ENDGAME_START);
  }

  /** everything a frame does EXCEPT render: sample input, step, audio, toasts */
  private frameLogic(dtMs: number): void {
    const cmd = this.input.poll();
    // "flip front": reverse robot-centric drive so the shooter side leads.
    // Meaningless in field-centric (translation is driver-frame there).
    if (!this.localRobot().fieldCentric) {
      if (this.input.flipPressed) this.frontFlipped = !this.frontFlipped;
      if (this.frontFlipped) {
        cmd.driveX = -cmd.driveX;
        cmd.driveY = -cmd.driveY;
      }
    }
    // park mode: toggle on press. Turning it ON is gated to endgame/free drive;
    // turning it back OFF is always allowed. While on, cap the drive command's
    // magnitude to the configured percentage for precision, low-speed control.
    if (this.input.parkPressed) {
      if (this.parked) this.parked = false;
      else if (this.canPark()) this.parked = true;
    }
    if (this.parked) {
      const k = Math.max(0, Math.min(100, this.settings.parkSpeedPct)) / 100;
      cmd.driveX *= k;
      cmd.driveY *= k;
      cmd.rotate *= k;
    }
    this.lastCmd = cmd;

    this.acc += Math.min(dtMs / 1000, 0.25);
    if (this.session) this.stepServer(cmd);
    else this.stepSolo(cmd);

    this.hudCountdown = this.updateCountdown();
    this.handlePhaseAudio();
    this.handleActionAudio();

    for (const e of this.world.events) {
      this.toasts.push({ id: ++this.toastId, text: e, at: performance.now() });
    }
    this.toasts = this.toasts.filter((x) => performance.now() - x.at < 2500).slice(-5);
    this.world.events.length = 0;
  }

  /** rAF loop: solo advances + renders here; multiplayer only RENDERS (the sim
   * is driven by simStep so it survives tab backgrounding — rAF pauses then) */
  private loop = (t: number): void => {
    if (this.disposed) return;
    const dtMs = this.lastT ? t - this.lastT : 16;
    this.lastT = t;
    if (!this.session) this.frameLogic(dtMs);
    // decay the local robot's error-smoothing offset toward 0 (frame-rate independent)
    const dtSec = Math.min(dtMs / 1000, 0.1);
    const k = Math.pow(2, -dtSec / SMOOTH_HALFLIFE);
    this.localSmooth.x *= k;
    this.localSmooth.y *= k;
    this.localSmooth.heading *= k;
    for (const o of this.remoteSmooth.values()) {
      o.x *= k;
      o.y *= k;
      o.heading *= k;
    }
    // solo renders the predicted world directly; the networked path renders EVERY
    // robot at its predicted-present pose plus its eased correction offset (smooth)
    const world = this.session ? this.displayWorld() : this.world;
    this.renderer.render(this.ctx, world, this.lastCmd, this.localRobotId);
    this.raf = requestAnimationFrame(this.loop);
  };

  /** multiplayer sim driver — a timer (not rAF) so a backgrounded tab keeps
   * stepping and feeding inputs to its peers instead of freezing the match */
  private simStep = (): void => {
    if (this.disposed) return;
    const now = performance.now();
    const dtMs = this.lastSimT ? now - this.lastSimT : 8;
    this.lastSimT = now;
    this.frameLogic(dtMs);
  };

  /** solo stepping: local keypress start/restart, one local command per tick */
  private stepSolo(cmd: RobotCommand): void {
    if (
      this.input.startPressed &&
      this.world.match.phase === 'pre' &&
      this.countdownStart === null
    ) {
      this.countdownStart = this.world.time;
      this.lastBeepAt = -1;
    }
    if (this.input.restartPressed) this.restart();

    let steps = 0;
    const commands = new Map<number, RobotCommand>([[this.localRobotId, cmd]]);
    while (this.acc >= C.SIM_DT && steps < C.MAX_STEPS_PER_FRAME) {
      step(this.world, C.SIM_DT, commands);
      this.acc -= C.SIM_DT;
      steps++;
    }
    if (steps === C.MAX_STEPS_PER_FRAME) this.acc = 0;
  }

  /** server-authoritative stepping (predict + reconcile): every tick we apply
   * our OWN command locally for instant response and send it to the server; when
   * an authoritative snapshot arrives we snap the world to it and replay the
   * local inputs it hadn't folded in yet. A dropped/laggy peer never blocks us —
   * only our own robot is predicted, remote robots are corrected by snapshots. */
  private stepServer(cmd: RobotCommand): void {
    const s = this.session!;
    if (this.input.restartPressed && s.isHost()) s.requestRestart();

    // reconcile to the freshest server snapshot BEFORE predicting this frame
    const snap = s.takeSnapshot();
    if (snap) {
      this.remoteCmds = snap.cmds; // hold each robot's command to predict it forward
      this.reconcile(snap);
    }

    // predict a small amount ahead in real time (the local robot stays responsive;
    // the server accepts our slightly-late inputs by applying our latest command,
    // so we do NOT fast-forward the whole world — that flung the balls around)
    if (this.acc > 0.25) this.acc = 0.25;
    let steps = 0;
    while (this.acc >= C.SIM_DT && steps < 30) {
      const tick = this.world.tick + 1;
      const local = localizeCommand(cmd);
      s.sendInput(tick, cmd);
      this.inputBuf.push({ tick, cmd: local });
      step(this.world, C.SIM_DT, this.cmdMap(local));
      this.acc -= C.SIM_DT;
      steps++;
    }
    // bound the buffer (only recent, unacked inputs ever matter)
    if (this.inputBuf.length > 600) this.inputBuf.splice(0, this.inputBuf.length - 600);
  }

  /** the command map to step: the local robot's live command + every remote
   * robot's held command (so remotes move + collide in the predicted world) */
  private cmdMap(local: RobotCommand): Map<number, RobotCommand> {
    const m = new Map(this.remoteCmds);
    m.set(this.localRobotId, local);
    return m;
  }

  /** the world to RENDER (networked path): EVERY robot is drawn at its predicted-
   * present pose plus its eased correction offset — the local robot for zero input
   * lag, remotes because their pose in `this.world` is predicted forward from their
   * held command (reconcile replays them to present), so what you SEE matches what
   * physics COLLIDES against. Balls render straight from the predicted sim. */
  private displayWorld(): World {
    const shift = (r: RobotState, o: { x: number; y: number; heading: number }): RobotState => ({
      ...r,
      pos: { x: r.pos.x + o.x, y: r.pos.y + o.y },
      heading: r.heading + o.heading,
    });
    const robots = this.world.robots.map((r) => {
      if (r.id === this.localRobotId) return shift(r, this.localSmooth);
      const o = this.remoteSmooth.get(r.id);
      return o ? shift(r, o) : r;
    });
    return { ...this.world, robots };
  }

  /** adopt the authoritative world, discard inputs it already reflects, and
   * re-predict forward by replaying the local inputs (and held remote commands)
   * past the snapshot tick */
  private reconcile(snap: Snapshot): void {
    // VISUAL error smoothing (rubberbanding fix): capture where EVERY robot is
    // currently rendered (predicted pos + its decaying offset). After we snap to the
    // authoritative world and re-predict below, we set each robot's offset so the
    // RENDERED position stays continuous, then it eases to the real position over ~1
    // decay in the render loop — so a late/uneven snapshot glides instead of
    // teleporting. Purely cosmetic: it never touches `this.world`, so determinism/
    // anti-cheat are intact.
    const preRender = new Map<number, { x: number; y: number; heading: number }>();
    for (const r of this.world.robots) {
      const o = r.id === this.localRobotId ? this.localSmooth : this.remoteSmooth.get(r.id);
      preRender.set(r.id, {
        x: r.pos.x + (o?.x ?? 0),
        y: r.pos.y + (o?.y ?? 0),
        heading: r.heading + (o?.heading ?? 0),
      });
    }

    this.world = snap.world;
    this.inputBuf = this.inputBuf.filter((b) => b.tick > snap.serverTick);
    for (const b of this.inputBuf) {
      step(this.world, C.SIM_DT, this.cmdMap(b.cmd));
    }

    const nextRemote = new Map<number, { x: number; y: number; heading: number }>();
    for (const post of this.world.robots) {
      const pr = preRender.get(post.id);
      if (!pr) continue; // just appeared this snapshot — render at the authoritative pose
      let dx = pr.x - post.pos.x;
      let dy = pr.y - post.pos.y;
      let dh = Math.atan2(Math.sin(pr.heading - post.heading), Math.cos(pr.heading - post.heading));
      // a genuinely large correction (desync/teleport) should SNAP, not float far
      // behind for a beat — only smooth sub-robot-scale errors
      if (Math.hypot(dx, dy) > SMOOTH_MAX_DIST) {
        dx = 0;
        dy = 0;
        dh = 0;
      }
      if (post.id === this.localRobotId) this.localSmooth = { x: dx, y: dy, heading: dh };
      else nextRemote.set(post.id, { x: dx, y: dy, heading: dh });
    }
    this.remoteSmooth = nextRemote;
  }

  /** host-authored restart arrived over the net: rebuild from the new seed */
  private rebuildFromNet(): void {
    this.audio.stopSpeech();
    this.world = this.makeWorld();
    this.prevPhase = this.world.match.phase;
    this.warningPlayed = false;
    this.matchOverAt = null;
    this.countdownStart = null;
    this.hudCountdown = null;
    this.frontFlipped = false;
    this.parked = false;
    this.acc = 0;
    this.inputBuf = [];
    this.remoteCmds = new Map();
    this.remoteSmooth = new Map();
    this.localSmooth = { x: 0, y: 0, heading: 0 };
    this.seedActionAudio();
    this.toasts = [];
  }

  /** trigger the pre-match countdown (e.g. from a UI button) */
  startMatch(): void {
    if (this.world.match.phase === 'pre' && this.countdownStart === null) {
      this.countdownStart = this.world.time;
      this.lastBeepAt = -1;
    }
  }

  /** restart with the same settings (new random seed / motif) */
  restart(): void {
    this.audio.stopSpeech();
    if (this.world.match.phase === 'auto' || this.world.match.phase === 'teleop') {
      this.audio.play('abort');
    }
    this.world = this.makeWorld();
    this.prevPhase = this.world.match.phase;
    this.warningPlayed = false;
    this.matchOverAt = null;
    this.countdownStart = null;
    this.hudCountdown = null;
    this.frontFlipped = false;
    this.parked = false;
    this.seedActionAudio();
    this.toasts = [];
  }

  /** REMATCH: in multiplayer ONLY the host re-authors the match for everyone (a
   * local rebuild would desync — the host broadcasts a fresh seed and every peer
   * rebuilds via rebuildFromNet); in solo it just rebuilds locally. */
  rematch(): void {
    if (this.session) {
      // host only: the server re-authors the match for everyone (picks the seed)
      if (this.session.isHost()) this.session.requestRestart();
      // non-host: no-op — only the host restarts
    } else {
      this.restart();
    }
  }

  /** multiplayer session? (UI gates RESET / host-only REMATCH on this) */
  isNetworked(): boolean {
    return this.session !== null;
  }

  /** the server's authoritative end-of-match result (score + recorded replay),
   * or null in solo / before phase 'post' */
  getMatchResult(): MatchResultInfo | null {
    return this.session?.getMatchResult() ?? null;
  }

  /** a record run's leaderboard standing (PB / WR / rank), or null until the
   * server's recordResult lands (record runs only) */
  getRecordResult(): RecordRankInfo | null {
    return this.session?.getRecordResult?.() ?? null;
  }

  /** ranked pre-match intro roster (name/team/drivetrain + ELO per driver), or
   * null for solo / free drive / non-ranked custom rooms. Drives the RankedIntro
   * overlay. Static after matchStart, so the UI reads it once. */
  getIntro(): IntroPlayer[] | null {
    const s = this.session;
    if (!s || !s.ranked) return null;
    return s.setups.map((su) => ({
      robotId: su.id,
      name: su.spec.name,
      teamName: su.spec.teamName,
      teamNumber: su.spec.teamNumber,
      drivetrain: su.spec.drivetrain,
      alliance: su.alliance,
      elo: s.intros.find((it) => it.id === su.id)?.elo ?? null,
      isLocal: su.id === this.localRobotId,
    }));
  }

  /** ranked results-screen ELO changes (before → after per driver), or null until
   * the server's `eloResult` lands after the match is scored. Sorted red-then-blue
   * to match the intro/results layout. */
  getEloResults(): EloResultRow[] | null {
    const s = this.session;
    if (!s || !s.ranked || s.eloResults.length === 0) return null;
    const rows = s.eloResults.map((d) => {
      const su = s.setups.find((x) => x.id === d.robotId);
      return {
        robotId: d.robotId,
        name: su?.spec.name ?? 'Driver',
        alliance: su?.alliance ?? ('red' as Alliance),
        before: d.before,
        after: d.after,
        isLocal: d.robotId === this.localRobotId,
        provisional: d.games < C.PLACEMENT_GAMES, // still in placements (games-based)
      };
    });
    return rows.sort((a, b) => (a.alliance === b.alliance ? 0 : a.alliance === 'red' ? -1 : 1));
  }

  getHud(): HudSnapshot {
    const w = this.world;
    const r = this.localRobot();
    const a = this.viewAlliance();
    const opp: Alliance = a === 'blue' ? 'red' : 'blue';
    const goal = w.goals[a];
    return {
      mode: w.mode,
      phase: w.match.phase,
      timeLeft: Math.max(0, w.match.phaseTimeLeft),
      alliance: a,
      motif: w.motif,
      score: w.match.scores[a],
      oppTotal: w.match.scores[opp].total,
      oppScore: w.match.scores[opp],
      provisionalPattern: w.match.provisionalPattern[a],
      fouls: { red: { ...w.match.fouls.red }, blue: { ...w.match.fouls.blue } },
      fieldCentric: r.fieldCentric,
      aimAssist: r.aimAssist,
      autoIntake: r.autoIntake,
      autoFire: r.autoFire,
      hopper: [...r.hopper],
      inLaunchZone: w.mode === 'free' || robotInLaunchZone(r),
      gamepadConnected: this.input.gamepadConnected,
      frontFlipped: this.frontFlipped,
      parked: this.parked,
      canPark: this.canPark(),
      gateOpen: goal.gateOpen,
      rampCount: w.balls.filter(
        (b) => b.state.kind === 'rail' && b.state.goal === a && !b.state.overflow,
      ).length,
      classifiedCount: goal.classifiedCount,
      overflowCount: goal.overflowCount,
      countdown: this.hudCountdown,
      resultRevealAt:
        w.match.phase === 'post' && this.matchOverAt !== null
          ? this.matchOverAt + C.MATCH_RESULT_REVEAL_MS
          : null,
      toasts: [...this.toasts],
      net: this.session ? this.session.status() : null,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.audio.stopSpeech();
    this.audio.stopKeepAlive();
    cancelAnimationFrame(this.raf);
    if (this.simTimer) window.clearInterval(this.simTimer);
    this.input.detach();
    window.removeEventListener('resize', this.onResize);
  }
}