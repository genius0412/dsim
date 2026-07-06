import type { Vec2 } from './types';

export const v = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
/** 2D magnitude via sqrt(x²+y²). Deliberately NOT Math.hypot: hypot's internal
 * scaling varies across JS engines/versions, breaking lockstep determinism;
 * sqrt is IEEE-754 correctly-rounded, so identical inputs give identical bits
 * everywhere. Our magnitudes never overflow, so no scaling is needed. */
export const hyp = (x: number, y: number): number => Math.sqrt(x * x + y * y);
export const len = (a: Vec2): number => hyp(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => hyp(a.x - b.x, a.y - b.y);

export function norm(a: Vec2): Vec2 {
  const l = len(a);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
}

// ---- deterministic trig ----------------------------------------------------
// Math.sin/cos/tan/atan2 are NOT required by the spec to be correctly-rounded,
// so they differ by an ULP or two ACROSS JS ENGINES/browser versions. In a
// lockstep sim that drift forks the state within seconds (and the basin's gate
// RNG then amplifies it into totally different games). These replacements use
// ONLY +,-,*,/ and Math.round/sqrt — all IEEE-754 exact — so every peer, in any
// browser, computes bit-identical results. Accuracy is ~1e-9, far tighter than
// gameplay needs. Keep ALL sim-reachable trig on these, never Math.*.
const PI = Math.PI;
const HALF_PI = PI / 2;
const TWO_PI = PI * 2;

/** deterministic sine (Taylor to x¹⁵ on a folded range; ~1e-11 max error) */
export function dsin(x: number): number {
  x -= TWO_PI * Math.round(x / TWO_PI); // reduce to [-PI, PI]
  if (x > HALF_PI) x = PI - x; // fold to [-PI/2, PI/2] via sin(PI-x)=sin(x)
  else if (x < -HALF_PI) x = -PI - x;
  const x2 = x * x;
  return (
    x *
    (1 +
      x2 *
        (-1 / 6 +
          x2 *
            (1 / 120 +
              x2 *
                (-1 / 5040 +
                  x2 *
                    (1 / 362880 +
                      x2 * (-1 / 39916800 + x2 * (1 / 6227020800 + x2 * (-1 / 1307674368000))))))))
  );
}

/** deterministic cosine */
export function dcos(x: number): number {
  return dsin(x + HALF_PI);
}

/** deterministic tangent */
export function dtan(x: number): number {
  return dsin(x) / dcos(x);
}

const ATAN_T = 0.5773502691896257; // tan(PI/6) = 1/sqrt(3)
const ATAN_LIM = 0.2679491924311227; // tan(PI/12)

/** atan on a small argument via fast-converging Taylor (|z| ≤ tan(PI/12)) */
function atanUnit(z: number): number {
  const z2 = z * z;
  return z * (1 + z2 * (-1 / 3 + z2 * (1 / 5 + z2 * (-1 / 7 + z2 * (1 / 9 + z2 * (-1 / 11))))));
}

/** deterministic atan (two-stage range reduction, ~1e-9 max error) */
export function datan(x: number): number {
  const sign = x < 0 ? -1 : 1;
  let a = x < 0 ? -x : x;
  const recip = a > 1;
  if (recip) a = 1 / a; // atan(a) = PI/2 - atan(1/a)
  let shift = 0;
  if (a > ATAN_LIM) {
    a = (a - ATAN_T) / (1 + a * ATAN_T); // atan(a) = PI/6 + atan(a')
    shift = PI / 6;
  }
  let r = atanUnit(a) + shift;
  if (recip) r = HALF_PI - r;
  return sign * r;
}

/** deterministic atan2 matching Math.atan2's quadrant conventions */
export function datan2(y: number, x: number): number {
  if (x === 0) return y > 0 ? HALF_PI : y < 0 ? -HALF_PI : 0;
  const a = datan(y / x);
  if (x > 0) return a; // right half-plane
  return y >= 0 ? a + PI : a - PI; // left half-plane
}

/** rotate vector by angle (CCW positive) — deterministic trig */
export function rot(a: Vec2, ang: number): Vec2 {
  const c = dcos(ang);
  const s = dsin(ang);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
}

export const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

/** wrap angle to (-PI, PI] */
export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

/** move angle `from` toward `to` by at most `maxDelta` */
export function approachAngle(from: number, to: number, maxDelta: number): number {
  const d = wrapAngle(to - from);
  return from + clamp(d, -maxDelta, maxDelta);
}

export const approach = (from: number, to: number, maxDelta: number): number =>
  from + clamp(to - from, -maxDelta, maxDelta);

/** distance from point p to segment ab */
export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const l2 = abx * abx + aby * aby;
  const t = l2 > 0 ? clamp(((p.x - a.x) * abx + (p.y - a.y) * aby) / l2, 0, 1) : 0;
  return hyp(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}

/** deterministic PRNG (mulberry32). Returns next float in [0,1) and new state. */
export function nextRandom(state: number): { value: number; state: number } {
  let s = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, state: s };
}
