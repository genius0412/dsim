import type {
  Alliance,
  ArtifactColor,
  AssistConfig,
  GameMode,
  MatchPhase,
  Motif,
  RobotCommand,
  RobotSpec,
  ScoreBreakdown,
  World,
} from './types';
import * as C from './config';
import { createWorld } from './sim/spawn';
import { step } from './sim/world';
import { startMatch } from './sim/match';
import { robotInLaunchZone } from './sim/robot';
import { InputManager } from './input/input';
import type { ControlBindings } from './input/bindings';
import { Renderer } from './render/renderer';
import { MatchAudio } from './audio';

export interface GameSettings {
  mode: GameMode;
  alliance: Alliance;
  assists: AssistConfig;
  spec: RobotSpec;
  audio: { sounds: boolean; voice: boolean };
  bindings: ControlBindings;
}

export interface Toast {
  id: number;
  text: string;
  at: number; // performance.now() ms
}

export interface HudSnapshot {
  mode: GameMode;
  phase: MatchPhase;
  timeLeft: number;
  alliance: Alliance;
  motif: Motif;
  score: ScoreBreakdown;
  oppTotal: number;
  provisionalPattern: number;
  fieldCentric: boolean;
  aimAssist: boolean;
  autoIntake: boolean;
  autoFire: boolean;
  hopper: ArtifactColor[];
  inLaunchZone: boolean;
  gamepadConnected: boolean;
  /** drive controls reversed so the shooter side leads (robot-centric only) */
  frontFlipped: boolean;
  gateOpen: boolean;
  rampCount: number;
  classifiedCount: number;
  overflowCount: number;
  /** pre-match "3-2-1" countdown value, or null when not counting down */
  countdown: number | null;
  toasts: Toast[];
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
  /** world.time when the pre-match countdown began (null = not started) */
  private countdownStart: number | null = null;
  private lastBeepAt = -1;
  private lastTransitionBeep = -1;
  private hudCountdown: number | null = null;
  /** drive controls reversed so the shooter side leads (robot-centric only) */
  private frontFlipped = false;
  // action-SFX edge trackers (seeded from the fresh world, see seedActionAudio)
  private prevFireAt = 0;
  private prevIntakeAt = 0;
  private prevGateOpen: Record<Alliance, boolean> = { red: false, blue: false };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private settings: GameSettings,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.audio.soundsEnabled = settings.audio.sounds;
    this.audio.voiceEnabled = settings.audio.voice;
    this.input = new InputManager(settings.bindings);
    this.world = this.makeWorld();
    this.prevPhase = this.world.match.phase;
    this.seedActionAudio();
    this.input.attach();
    window.addEventListener('resize', this.onResize);
    this.onResize();
    this.raf = requestAnimationFrame(this.loop);
  }

  private makeWorld(): World {
    const seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
    return createWorld(
      this.settings.mode,
      this.settings.alliance,
      seed,
      this.settings.spec,
      this.settings.assists,
    );
  }

  private onResize = (): void => {
    this.renderer.camera.configure(this.canvas, this.settings.alliance);
  };

  private handlePhaseAudio(): void {
    const phase = this.world.match.phase;
    if (phase !== this.prevPhase) {
      if (phase === 'auto') this.audio.play('start');
      if (phase === 'transition') this.audio.play('end');
      if (phase === 'teleop' && this.prevPhase === 'transition') this.audio.play('resume');
      if (phase === 'post') {
        this.audio.play('end');
        window.setTimeout(() => {
          if (!this.disposed && this.world.match.phase === 'post') this.audio.play('match_result');
        }, 2200);
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
    const r = this.world.robots[0];
    this.prevFireAt = r.lastFireAt;
    this.prevIntakeAt = r.lastIntakeAt;
    this.prevGateOpen = {
      red: this.world.goals.red.gateOpen,
      blue: this.world.goals.blue.gateOpen,
    };
  }

  /** shoot / intake / gate effects, edge-detected from world state (the sim
   * core stays event-free for these — same pattern as handlePhaseAudio) */
  private handleActionAudio(): void {
    const r = this.world.robots[0];
    if (r.lastFireAt !== this.prevFireAt) {
      this.prevFireAt = r.lastFireAt;
      this.audio.sfxShoot();
    }
    if (r.lastIntakeAt !== this.prevIntakeAt) {
      this.prevIntakeAt = r.lastIntakeAt;
      this.audio.sfxIntake();
    }
    for (const a of ['red', 'blue'] as Alliance[]) {
      const open = this.world.goals[a].gateOpen;
      if (open && !this.prevGateOpen[a]) this.audio.sfxGate();
      this.prevGateOpen[a] = open;
    }
  }

  /** announcer: "Match begins in 3, 2, 1" — runs after start is pressed */
  private updateCountdown(): number | null {
    if (this.world.match.phase !== 'pre' || this.countdownStart === null) return null;
    const remaining = C.PRE_COUNTDOWN - (this.world.time - this.countdownStart);
    if (remaining <= 0) {
      this.countdownStart = null;
      startMatch(this.world);
      return null;
    }
    const n = Math.ceil(remaining);
    if (n !== this.lastBeepAt) {
      this.lastBeepAt = n;
      // numbers interrupt any in-flight speech so the spoken count always
      // lands exactly on the visual digit
      if (n === C.PRE_COUNTDOWN) this.audio.say('Match begins in');
      else this.audio.say(String(n), true);
    }
    return n; // > 3 means the "Match begins in" lead-in
  }

  private loop = (t: number): void => {
    if (this.disposed) return;
    const dtMs = this.lastT ? t - this.lastT : 16;
    this.lastT = t;

    const cmd = this.input.poll();
    // "flip front": reverse robot-centric drive so the shooter side leads.
    // Meaningless in field-centric (translation is driver-frame there).
    if (!this.world.robots[0].fieldCentric) {
      if (this.input.flipPressed) this.frontFlipped = !this.frontFlipped;
      if (this.frontFlipped) {
        cmd.driveX = -cmd.driveX;
        cmd.driveY = -cmd.driveY;
      }
    }
    this.lastCmd = cmd;
    if (
      this.input.startPressed &&
      this.world.match.phase === 'pre' &&
      this.countdownStart === null
    ) {
      this.countdownStart = this.world.time;
      this.lastBeepAt = -1;
    }
    if (this.input.restartPressed) this.restart();

    this.acc += Math.min(dtMs / 1000, 0.25);
    let steps = 0;
    const commands = new Map<number, RobotCommand>([[0, cmd]]);
    while (this.acc >= C.SIM_DT && steps < C.MAX_STEPS_PER_FRAME) {
      step(this.world, C.SIM_DT, commands);
      this.acc -= C.SIM_DT;
      steps++;
    }
    if (steps === C.MAX_STEPS_PER_FRAME) this.acc = 0;

    this.hudCountdown = this.updateCountdown();
    this.handlePhaseAudio();
    this.handleActionAudio();

    for (const e of this.world.events) {
      this.toasts.push({ id: ++this.toastId, text: e, at: performance.now() });
    }
    this.toasts = this.toasts.filter((x) => performance.now() - x.at < 2500).slice(-5);
    this.world.events.length = 0;

    this.renderer.render(this.ctx, this.world, this.lastCmd);
    this.raf = requestAnimationFrame(this.loop);
  };

  /** restart with the same settings (new random seed / motif) */
  restart(): void {
    this.audio.stopSpeech();
    if (this.world.match.phase === 'auto' || this.world.match.phase === 'teleop') {
      this.audio.play('abort');
    }
    this.world = this.makeWorld();
    this.prevPhase = this.world.match.phase;
    this.warningPlayed = false;
    this.countdownStart = null;
    this.hudCountdown = null;
    this.frontFlipped = false;
    this.seedActionAudio();
    this.toasts = [];
  }

  getHud(): HudSnapshot {
    const w = this.world;
    const r = w.robots[0];
    const a = this.settings.alliance;
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
      provisionalPattern: w.match.provisionalPattern[a],
      fieldCentric: r.fieldCentric,
      aimAssist: r.aimAssist,
      autoIntake: r.autoIntake,
      autoFire: r.autoFire,
      hopper: [...r.hopper],
      inLaunchZone: w.mode === 'free' || robotInLaunchZone(r),
      gamepadConnected: this.input.gamepadConnected,
      frontFlipped: this.frontFlipped,
      gateOpen: goal.gateOpen,
      rampCount: w.balls.filter(
        (b) => b.state.kind === 'rail' && b.state.goal === a && !b.state.overflow,
      ).length,
      classifiedCount: goal.classifiedCount,
      overflowCount: goal.overflowCount,
      countdown: this.hudCountdown,
      toasts: [...this.toasts],
    };
  }

  dispose(): void {
    this.disposed = true;
    this.audio.stopSpeech();
    cancelAnimationFrame(this.raf);
    this.input.detach();
    window.removeEventListener('resize', this.onResize);
  }
}
