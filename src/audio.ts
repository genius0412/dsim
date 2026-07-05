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
  muted = false;

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
}
