/** Official FIRST field-management sounds (as played at FTC/FRC events).
 * Files live in public/sounds/. */
export type Cue = 'start' | 'end' | 'resume' | 'warning' | 'match_result' | 'abort';

const FILES: Record<Cue, string> = {
  start: 'sounds/start.wav', // "Charge" — AUTO start
  end: 'sounds/end.wav', // buzzer — end of AUTO / end of match
  resume: 'sounds/resume.wav', // three bells — TELEOP start
  warning: 'sounds/warning.wav', // 30-second warning
  match_result: 'sounds/match_result.wav',
  abort: 'sounds/abort.wav', // foghorn — match reset
};

export class MatchAudio {
  private sounds = new Map<Cue, HTMLAudioElement>();
  /** master switch: no audio at all when false */
  soundsEnabled = true;
  /** announcer voice lines; when off, countdowns fall back to beeps */
  voiceEnabled = true;

  private get muted(): boolean {
    return !this.soundsEnabled;
  }

  constructor() {
    const base = import.meta.env.BASE_URL ?? './';
    for (const [cue, file] of Object.entries(FILES) as [Cue, string][]) {
      const a = new Audio(base + file);
      a.preload = 'auto';
      a.volume = 0.55;
      this.sounds.set(cue, a);
    }
  }

  play(cue: Cue): void {
    if (this.muted) return;
    const a = this.sounds.get(cue);
    if (!a) return;
    a.currentTime = 0;
    void a.play().catch(() => {
      /* browser blocks audio before first interaction — fine */
    });
  }

  private ctx: AudioContext | null = null;

  /** short countdown beep — fires instantly, always in sync with the visual */
  beep(freq = 780, dur = 0.14, vol = 0.35): void {
    if (this.muted) return;
    try {
      this.ctx ??= new AudioContext();
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(vol, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(t);
      osc.stop(t + dur);
    } catch {
      /* no audio available */
    }
  }

  private voice: SpeechSynthesisVoice | null = null;
  private voicePicked = false;

  private pickVoice(): SpeechSynthesisVoice | null {
    if (this.voicePicked) return this.voice;
    try {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length === 0) return null; // list not loaded yet — retry later
      this.voicePicked = true;
      // prefer the higher-quality natural voices when available
      this.voice =
        voices.find((v) => /Google US English/i.test(v.name)) ??
        voices.find((v) => /Natural|Online/i.test(v.name) && v.lang.startsWith('en')) ??
        voices.find((v) => /Mark|David|Guy/i.test(v.name) && v.lang.startsWith('en')) ??
        voices.find((v) => v.lang === 'en-US') ??
        null;
    } catch {
      this.voice = null;
    }
    return this.voice;
  }

  /** announcer voice, like the emcee at a real match ("3... 2... 1...").
   * `interrupt` cancels anything still being spoken so timing stays exact —
   * countdown numbers must land on the visual beat, never queue. */
  say(text: string, interrupt = false): void {
    if (this.muted) return;
    try {
      if (!this.voiceEnabled || !('speechSynthesis' in window)) {
        if (interrupt) this.beep();
        return;
      }
      if (interrupt) window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const v = this.pickVoice();
      if (v) u.voice = v;
      u.rate = 1.1;
      u.pitch = 0.95;
      u.volume = 0.9;
      window.speechSynthesis.speak(u);
    } catch {
      /* speech unavailable */
    }
  }

  stopSpeech(): void {
    try {
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
  }
}
