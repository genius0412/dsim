import type { RobotCommand, World } from '../types';

/**
 * FULL (WORLD TIER) RE-RUNS THE PREDICTION ONLY WHEN THE SERVER DISAGREES WITH IT — the rule every
 * client that simulates the whole world lives by (Rocket League re-simulates "whenever there is an
 * error in their prediction", a rollback netcode only when an input it guessed turns out wrong).
 * The client keeps a digest of its own predicted world at every tick (`WorldDigest`); a snapshot
 * whose world matches the digest for its tick — every robot within `AGREE_POS_IN`, every element
 * too, the same element states, hoppers, scores and phase, and every remote robot still on the
 * command it was predicted on — changes nothing a replay would change, so the replay is skipped.
 * Measured before this: re-running the whole field for the lead on every snapshot cost 180–360 ms
 * of a fast core per second of play. A snapshot that disagrees gets the full rewind-and-replay.
 *
 * `FULL_RESYNC_EVERY` forces the full path regardless, so state the digest does not cover (a
 * penalty timer, a server-side flag) is never more than that many snapshots out of date.
 */
export const AGREE_POS_IN = 0.05;
/** an ELEMENT may differ by this much and still agree: they diverge more between rewinds than a
 *  chassis does (0.16–1 in over a 12-tick replay against a fresh engine's 0.45–4.4), and a quarter
 *  inch on a 3 in ball cannot be seen */
export const AGREE_BALL_IN = 0.25;
/** a remote robot's stick may drift this much between snapshots and still count as the command it
 *  was predicted on — a held analog stick is never perfectly still; every button must match */
export const AGREE_STICK = 0.1;
export const AGREE_ANGLE_RAD = 0.003;
export const FULL_RESYNC_EVERY = 6;

/** a compact picture of a predicted world at one tick — see `AGREE_POS_IN` */
export interface WorldDigest {
  /** robots (x, y, z each) first, then elements — `robots` says where one becomes the other */
  robots: number;
  pos: Float64Array;
  ang: Float64Array;
  discrete: string;
}

export function worldDigest(w: World): WorldDigest {
  const pos: number[] = [];
  const ang: number[] = [];
  for (const r of w.robots) {
    pos.push(r.pos.x, r.pos.y, r.z ?? 0);
    ang.push(r.heading);
  }
  for (const b of w.balls) pos.push(b.pos.x, b.pos.y, b.z);
  const bb = (w as { biobuzz?: { hives?: Record<string, { angle?: number }> } }).biobuzz;
  if (bb?.hives) for (const a of ['red', 'blue']) ang.push(bb.hives[a]?.angle ?? 0);
  const discrete =
    w.match.phase +
    '|' + w.robots.map((r) => `${r.id}:${r.hopper.length}`).join(',') +
    '|' + w.balls.map((b) => `${b.id}${b.state.kind[0]}`).join('') +
    '|' + JSON.stringify(w.match.scores);
  return { robots: w.robots.length * 3, pos: Float64Array.from(pos), ang: Float64Array.from(ang), discrete };
}

export function digestsAgree(a: WorldDigest, b: WorldDigest): boolean {
  if (a.discrete !== b.discrete || a.pos.length !== b.pos.length || a.ang.length !== b.ang.length) return false;
  for (let i = 0; i < a.pos.length; i++) if (Math.abs(a.pos[i] - b.pos[i]) > (i < a.robots ? AGREE_POS_IN : AGREE_BALL_IN)) return false;
  for (let i = 0; i < a.ang.length; i++) {
    const d = a.ang[i] - b.ang[i];
    if (Math.abs(Math.atan2(Math.sin(d), Math.cos(d))) > AGREE_ANGLE_RAD) return false;
  }
  return true;
}

const STICKS = ['driveX', 'driveY', 'rotate', 'leftDrive', 'rightDrive'] as const;
/** the same command for prediction's purposes: every button equal, every stick within AGREE_STICK */
export function cmdsAgree(a: RobotCommand | undefined, b: RobotCommand | undefined): boolean {
  if (!a || !b) return a === b;
  for (const k of Object.keys({ ...a, ...b }) as (keyof RobotCommand)[]) {
    const x = a[k];
    const y = b[k];
    if ((STICKS as readonly string[]).includes(k)) {
      if (Math.abs(((x as number) ?? 0) - ((y as number) ?? 0)) > AGREE_STICK) return false;
    } else if (!!x !== !!y) return false;
  }
  return true;
}
