import type { Alliance, CardColor, PinState } from './types';
import { parsePenaltyEvent, type CardLine, type PenaltyLine } from './sim/penaltyLog';

/**
 * WHAT A SANCTION SOUNDS LIKE, AND WHEN — the client half of the penalty presentation.
 *
 * DOM-free and clock-free (every function takes `now`), so `npm test` drives all of it. The
 * WebAudio half is `MatchAudio.sfxPenalty` (`src/audio.ts`), which plays the `CUE_VOICES` below;
 * `GameController` (live) and `ReplayView` (replays) are the two callers.
 *
 * ── THE INVENTORY, FROM THE SIM'S OWN OUTPUT ───────────────────────────────────────────────────
 * Every sanction any of the three games issues reaches the client as ONE `world.events` line,
 * written by `src/sim/penaltyLog.ts` and read back by `parsePenaltyEvent`:
 *   MINOR FOUL   DECODE (`fire`, G408 over-possession, G422 pinning…), BIOBUZZ (`bbAwardFoul`)
 *   MAJOR FOUL   all three (Chain Reaction bills only majors: G05 / G06)
 *   YELLOW CARD  DECODE and BIOBUZZ, through the shared `awardCard`
 *   RED CARD     the same `awardCard`, on a second card: it VOIDS the alliance's match score.
 *                Nothing in any sim disables a robot as a sanction, so red is the top of the scale.
 *   WARNING      BIOBUZZ's verbal warning (G407, G408, G409): no points, no tally, a line only
 * ...and ONE standing state that is a warning without being a line:
 *   PIN COUNTING `world.penalties.pins`, DECODE G422 and BIOBUZZ G421: a pair whose `seconds` is
 *                running. The FOUL lands at three seconds; the count starting is the warning,
 *                and the entry being deleted (the pin ENDED) is the one "warning cleared" any
 *                game has. BIOBUZZ's CONTROL 5+ line is a held HUD bump over the G407 WARNING
 *                line, so it has no transition of its own beyond that line.
 *
 * ── WHOSE SANCTIONS ────────────────────────────────────────────────────────────────────────────
 * A cue is a call to action, so a DRIVER hears their own ALLIANCE's: the fouls it commits, the
 * cards and warnings its robots draw, the pins its robots hold. The opponent's land on the
 * scoreboard and in the event log. A SPECTATOR (and a replay with no driver) has no side and
 * hears both — `viewer` null.
 *
 * ── NEVER TWICE ────────────────────────────────────────────────────────────────────────────────
 * Lines are fed with an ID — their index in the AUTHORITATIVE log (online: the server's, the
 * same absolute index `collectNetEvents` diffs by; solo: a running count of what the frame
 * drained; a replay: the player's log). An id at or under the high-water mark is ignored, so a
 * reconcile that re-delivers or a prediction that re-emits a tick cannot sound it again. Pins
 * are read from the authoritative world too, and LATCHED per pair: a pin that blinks out for a
 * frame (a misprediction corrected by a snapshot) and back is the same pin.
 */

export type PenaltyCue = 'cleared' | 'warning' | 'minor' | 'major' | 'yellow' | 'red';

export const PENALTY_CUES: readonly PenaltyCue[] = ['cleared', 'warning', 'minor', 'major', 'yellow', 'red'];

/** severity order: a soft tick, a firmer foul, an unmistakable card, red strongest */
export const CUE_RANK: Record<PenaltyCue, number> = {
  cleared: 0,
  warning: 1,
  minor: 2,
  major: 3,
  yellow: 4,
  red: 5,
};

/**
 * THE MINIMUM GAP BETWEEN TWO OF THE SAME CUE, in wall-clock ms. A G408 tariff bills one MINOR
 * per artifact over the limit IN ONE TICK, and its continuing charge every three seconds; a
 * scrum can start a pin, pause it and start another. Cards are never limited: a robot can draw
 * two in a whole match, and the second (red) must never be swallowed.
 */
export const CUE_GAP_MS: Record<PenaltyCue, number> = {
  cleared: 2000,
  warning: 2000,
  minor: 600,
  major: 600,
  yellow: 0,
  red: 0,
};

/** how long each cue sounds — a weaker cue arriving inside a stronger one's span is dropped,
 *  rather than played over it (the minors that ride in behind a card on the next snapshot) */
export const CUE_SPAN_MS: Record<PenaltyCue, number> = {
  cleared: 170,
  warning: 80,
  minor: 200,
  major: 380,
  yellow: 480,
  red: 830,
};

/** one sanction line → its cue for this viewer, or null when it is the other alliance's */
export function cueForLine(line: PenaltyLine, viewer: Alliance | null): PenaltyCue | null {
  switch (line.kind) {
    case 'foul':
      return viewer && line.offender !== viewer ? null : line.severity;
    case 'card':
      return viewer && line.alliance !== viewer ? null : line.colour;
    case 'warning':
      return viewer && line.alliance !== viewer ? null : 'warning';
  }
}

/** an event line → its cue, or null (not a sanction, or not this viewer's) */
export function cueForEvent(text: string, viewer: Alliance | null): PenaltyCue | null {
  const line = parsePenaltyEvent(text);
  return line ? cueForLine(line, viewer) : null;
}

/** the most severe of a batch: one tick can bill six MINORs and the card they earned */
export function strongestCue(cues: Iterable<PenaltyCue | null>): PenaltyCue | null {
  let best: PenaltyCue | null = null;
  for (const c of cues) if (c && (best === null || CUE_RANK[c] > CUE_RANK[best])) best = c;
  return best;
}

/** the rate limit: per-cue gaps, and no weaker cue over a stronger one still sounding */
export class PenaltyCueGate {
  private lastAt: Partial<Record<PenaltyCue, number>> = {};
  private last: { cue: PenaltyCue; at: number } | null = null;

  /** true when `cue` may play at `now` (and records that it did) */
  offer(cue: PenaltyCue, now: number): boolean {
    const prev = this.lastAt[cue];
    if (prev !== undefined && now - prev < CUE_GAP_MS[cue]) return false;
    const l = this.last;
    if (l && now - l.at < CUE_SPAN_MS[l.cue] && CUE_RANK[cue] <= CUE_RANK[l.cue]) return false;
    this.lastAt[cue] = now;
    this.last = { cue, at: now };
    return true;
  }

  reset(): void {
    this.lastAt = {};
    this.last = null;
  }
}

/** one pinner→pinned pair as the watcher needs it */
export interface PinView {
  key: string;
  pinnerAlliance: Alliance;
  /** has the count started (`seconds > 0`)? A pair can be tracked before it counts */
  counting: boolean;
}

/** read the pins out of a world's penalty state (keys are `${pinnerId}-${pinnedId}`) */
export function pinViews(
  pins: Record<string, PinState> | undefined,
  allianceOf: (robotId: number) => Alliance | undefined,
): PinView[] {
  const out: PinView[] = [];
  for (const [key, st] of Object.entries(pins ?? {})) {
    const a = allianceOf(Number(key.split('-')[0]));
    if (a) out.push({ key, pinnerAlliance: a, counting: st.seconds > 0 });
  }
  return out;
}

/** how long a latched pin must stay GONE before it counts as ended — longer than any gap a
 *  corrected misprediction leaves, shorter than a driver would wait to hear it */
export const PIN_CLEAR_HOLD_MS = 1000;

/** pin count started → `warning`; a latched pin gone for `PIN_CLEAR_HOLD_MS` → `cleared` */
export class PinWatch {
  /** latched pin → when it went missing, or null while present */
  private latched = new Map<string, number | null>();

  update(pins: readonly PinView[], viewer: Alliance | null, now: number): PenaltyCue[] {
    const out: PenaltyCue[] = [];
    const present = new Set<string>();
    for (const p of pins) {
      present.add(p.key);
      if (this.latched.has(p.key)) {
        this.latched.set(p.key, null);
        continue;
      }
      if (!p.counting || (viewer && p.pinnerAlliance !== viewer)) continue;
      this.latched.set(p.key, null);
      out.push('warning');
    }
    for (const [key, goneAt] of this.latched) {
      if (present.has(key)) continue;
      if (goneAt === null) this.latched.set(key, now);
      else if (now - goneAt >= PIN_CLEAR_HOLD_MS) {
        this.latched.delete(key);
        out.push('cleared');
      }
    }
    return out;
  }

  /** latch every counting pin of this viewer's WITHOUT a cue — a mid-match join, whose pins
   *  were already counting before it arrived. Its end still sounds. */
  adopt(pins: readonly PinView[], viewer: Alliance | null): void {
    for (const p of pins) {
      if (p.counting && (!viewer || p.pinnerAlliance === viewer)) this.latched.set(p.key, null);
    }
  }

  reset(): void {
    this.latched.clear();
  }
}

/** one authoritative event line with its id (see "NEVER TWICE" above) */
export interface FedEvent {
  id: number;
  text: string;
}

/**
 * THE WHOLE CLIENT SIDE OF A PENALTY CUE: dedupe by id, map to a cue, add the pins, pick the
 * strongest of the frame, rate-limit it, play it. One per match screen (or replay player).
 */
export class PenaltyCuePlayer {
  /** null hears both alliances (a spectator, a replay with no driver) */
  viewer: Alliance | null = null;
  private highWater = -1;
  private readonly gate = new PenaltyCueGate();
  private readonly pins = new PinWatch();

  constructor(private readonly play: (cue: PenaltyCue) => void) {}

  /** the log restarted (a new world: restart, rematch, rejoin keyframe, a replay rebuilt) */
  reset(): void {
    this.highWater = -1;
    this.gate.reset();
    this.pins.reset();
  }

  /** skip everything up to and including `id` without sounding it (a seek, a mid-match join) */
  skipTo(id: number): void {
    this.highWater = Math.max(this.highWater, id);
  }

  /** latch the pins already counting without sounding them (a mid-match join, a seek) */
  adoptPins(pins: readonly PinView[]): void {
    this.pins.adopt(pins, this.viewer);
  }

  /** one frame's input. `pins` null = no new authoritative pin reading this frame. Returns the
   *  cue it played, or null. */
  frame(events: readonly FedEvent[], pins: readonly PinView[] | null, now: number): PenaltyCue | null {
    const cues: (PenaltyCue | null)[] = [];
    for (const e of events) {
      if (e.id <= this.highWater) continue;
      this.highWater = e.id;
      cues.push(cueForEvent(e.text, this.viewer));
    }
    if (pins) cues.push(...this.pins.update(pins, this.viewer, now));
    const cue = strongestCue(cues);
    if (!cue || !this.gate.offer(cue, now)) return null;
    this.play(cue);
    return cue;
  }
}

/* ------------------------------------------------------------------------------------------------
 * THE CARD SIGNAL'S RULE. `world.penalties.carded` holds a robot's card COLOUR and nothing else;
 * the rule that drew it is only in the event line. So the client keeps the lines it has seen,
 * keyed the way the line names the robot (`cardSubject`), and the HUD looks the rule up from the
 * robot it is drawing. A mid-match joiner seeds it from the log history it adopted silently.
 * --------------------------------------------------------------------------------------------- */

export class CardLedger {
  private rules = new Map<string, string>();

  private static key(alliance: Alliance, who: string, colour: CardColor): string {
    return `${alliance}|${colour}|${who}`;
  }

  note(line: CardLine): void {
    this.rules.set(CardLedger.key(line.alliance, line.who, line.colour), line.rule);
  }

  /** feed any lines; the card ones are kept */
  noteText(text: string): void {
    const line = parsePenaltyEvent(text);
    if (line?.kind === 'card') this.note(line);
  }

  ruleFor(alliance: Alliance, who: string, colour: CardColor): string | null {
    return this.rules.get(CardLedger.key(alliance, who, colour)) ?? null;
  }

  clear(): void {
    this.rules.clear();
  }
}

/** a rule's code for a two-word line: `G408 excessive control` → `G408`, `G05 …` → `G05` */
export function ruleCode(rule: string): string {
  const m = /^[A-Z]{1,2}\d{2,3}(?:\.[A-Z])?/.exec(rule.trim());
  return m ? m[0] : rule.trim().split(/\s+/)[0] ?? '';
}

/* ------------------------------------------------------------------------------------------------
 * THE CUES THEMSELVES, as data, so the live player and the offline WAV render are one source.
 *
 * Synthesised, like every other effect in `audio.ts`: no sample, nothing recorded, and nothing
 * shaped like a FIRST field cue (those are the WAVs: the charge, the end buzzer, the three bells,
 * the foghorn). The SHAPE carries the severity before the level does:
 *   cleared  two soft falling notes        — the count stopped
 *   warning  one high soft tick            — a count is running
 *   minor    one low "thud" that bends down
 *   major    the same thud TWICE, the second lower
 *   yellow   a bright two-strike stab
 *   red      three falling tritone strikes over a low floor, the longest and loudest
 * ------------------------------------------------------------------------------------------------ */

export interface CueVoice {
  kind: 'tone' | 'noise';
  /** start and end frequency (Hz): the oscillator's pitch, or the noise band's centre */
  f0: number;
  f1: number;
  /** seconds, attack to the end of the exponential decay */
  dur: number;
  /** peak level, before the player's category level and master */
  vol: number;
  /** seconds after the cue starts */
  at: number;
  wave?: OscillatorType;
  /** band-pass Q for a noise voice */
  q?: number;
}

const thud = (at: number, hi: number, lo: number, len: number, vol: number): CueVoice[] => [
  { kind: 'noise', f0: 900, f1: 420, dur: 0.045, vol: vol * 0.55, at, q: 1.4 },
  { kind: 'tone', f0: hi, f1: lo, dur: len, vol: vol * 0.55, at, wave: 'square' },
  { kind: 'tone', f0: hi / 2, f1: lo / 2, dur: len + 0.03, vol, at, wave: 'sine' },
];

const strike = (at: number, a: number, b: number, len: number, vol: number, wave: OscillatorType): CueVoice[] => [
  { kind: 'tone', f0: a, f1: a, dur: len, vol, at, wave },
  { kind: 'tone', f0: b, f1: b, dur: len, vol: vol * 0.85, at, wave },
];

/** IEC 61672 A-weighting as a linear gain, 1 at 1 kHz: the ear is deaf to a low sine */
const aWeight = (f: number): number => {
  const r = (x: number): number => {
    const x2 = x * x;
    return (12194 ** 2 * x2 * x2) / ((x2 + 20.6 ** 2) * Math.sqrt((x2 + 107.7 ** 2) * (x2 + 737.9 ** 2)) * (x2 + 12194 ** 2));
  };
  return r(f) / r(1000);
};
const WAVE_RMS: Record<OscillatorType, number> = { sine: 0.707, triangle: 0.577, square: 1, sawtooth: 0.577, custom: 0.707 };

/**
 * A CUE'S PERCEIVED WEIGHT — an estimate, so `npm test` can hold the scale in order without ears.
 * A-weighted energy: each voice's RMS at its level, weighted by the ear's response at its pitch
 * (a square or saw spreads into its harmonics, so its third counts too), times its length. Naive
 * energy put a 165 Hz sine sub-thump above a 1 kHz square stab, which no listener would.
 */
export function cueLoudness(cue: PenaltyCue): number {
  let e = 0;
  for (const v of CUE_VOICES[cue]) {
    const f = Math.sqrt(v.f0 * v.f1);
    if (v.kind === 'noise') {
      e += (v.vol * 0.35 * aWeight(f)) ** 2 * v.dur;
      continue;
    }
    const wave = v.wave ?? 'sine';
    const w = wave === 'square' || wave === 'sawtooth' ? Math.max(aWeight(f), aWeight(3 * f) * 0.6) : aWeight(f);
    e += (v.vol * WAVE_RMS[wave] * w) ** 2 * v.dur;
  }
  return e;
}

export const CUE_VOICES: Record<PenaltyCue, readonly CueVoice[]> = {
  cleared: [
    { kind: 'tone', f0: 1175, f1: 1175, dur: 0.06, vol: 0.07, at: 0, wave: 'triangle' },
    { kind: 'tone', f0: 880, f1: 880, dur: 0.09, vol: 0.07, at: 0.075, wave: 'triangle' },
  ],
  warning: [
    { kind: 'noise', f0: 3200, f1: 3200, dur: 0.018, vol: 0.05, at: 0, q: 6 },
    { kind: 'tone', f0: 1568, f1: 1480, dur: 0.055, vol: 0.12, at: 0, wave: 'triangle' },
  ],
  minor: thud(0, 392, 330, 0.15, 0.22),
  major: [...thud(0, 392, 330, 0.13, 0.25), ...thud(0.17, 330, 262, 0.17, 0.27)],
  yellow: [
    { kind: 'noise', f0: 2400, f1: 1800, dur: 0.03, vol: 0.1, at: 0, q: 2 },
    ...strike(0.02, 988, 1319, 0.11, 0.09, 'square'),
    ...strike(0.17, 988, 1319, 0.3, 0.1, 'square'),
    { kind: 'tone', f0: 494, f1: 494, dur: 0.3, vol: 0.14, at: 0.17, wave: 'sine' },
  ],
  red: [
    { kind: 'noise', f0: 1800, f1: 500, dur: 0.07, vol: 0.16, at: 0, q: 1.2 },
    ...strike(0, 784, 1109, 0.15, 0.13, 'square'),
    ...strike(0.17, 659, 932, 0.15, 0.13, 'square'),
    ...strike(0.34, 554, 784, 0.46, 0.13, 'square'),
    { kind: 'tone', f0: 277, f1: 262, dur: 0.46, vol: 0.12, at: 0.34, wave: 'sawtooth' },
    { kind: 'tone', f0: 131, f1: 110, dur: 0.48, vol: 0.3, at: 0.34, wave: 'sine' },
  ],
};
