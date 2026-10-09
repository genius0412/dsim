/**
 * THE SNAPSHOT ENCODER'S HOT HALF: which balls changed since the last broadcast, and the
 * snapshot body built from them. `Room.broadcastSnapshot` decides WHO gets WHICH baseline; this
 * file only makes the two expensive steps cheap, and its output is BYTE-IDENTICAL to what the room
 * produced before (`npm test`, "snapshot wire:", drives real rooms of every game through both).
 *
 * WHY IT EXISTS (measured, `docs/capacity.md` "Snapshot encode"): the diff key used to be
 * `JSON.stringify(ball, round3)` for EVERY ball on EVERY broadcast, and a replacer function
 * turns V8's fast serializer off and calls back into JS for every key and value. On a Chain
 * Reaction room that was 0.81 ms of a 0.97 ms broadcast, i.e. ~40% of the room's whole CPU, to
 * find that ~37 of 300 particles had moved. Then the body stringified the changed balls AGAIN.
 *
 * 1. **A SHADOW, NOT A STRING, DECIDES "CHANGED".** Each ball keeps `JSON.parse` of its last
 *    rounded serialization, and `sameR3` walks the live ball against it applying the SAME
 *    rounding the replacer applies. Equal walk ⇔ equal string, so the change set is the one the
 *    string compare produced (asserted on every ball of every smoke frame). Only a ball that DID
 *    change is stringified — and it had to be anyway, because it is going on the wire.
 * 2. **THE BODY SPLICES THOSE STRINGS.** After the diff, `wire(id)` is exactly
 *    `JSON.stringify(ball, round3)` for every ball in the world (a changed one was just
 *    re-stringified; an unchanged one is, by the definition of unchanged, the same bytes), so
 *    `upd` for ANY baseline is a join of cached strings. The replacer is still applied to the
 *    slim world, the only part of the body whose numbers it can touch: `serverTick` and the id
 *    `order` are integers, and `cmds` goes through it anyway (it is a few integers).
 *
 * ⚠️ A LEAF (imports only `wire.ts` and types), and free of `node:` imports: `server/room.ts`
 * is bundled for a browser tab too (`src/lan/hostWorker.ts`).
 */
import { round3 } from './wire';
import type { Artifact } from '../src/types';
import type { QCommand } from '../src/net/protocol';

const hasOwn = Object.prototype.hasOwnProperty;

/** what `round3` does to a number, spelled out so `sameR3` cannot drift from it */
const r3 = (n: number): number => (Number.isInteger(n) ? n : Math.round(n * 1000) / 1000);

/**
 * Would `cur` serialize under `round3` to the same bytes as the value `shadow` was PARSED from?
 * (`shadow` is `JSON.parse(JSON.stringify(x, round3))` for some earlier `x`.)
 *
 * Mirrors `JSON.stringify`'s rules exactly where they matter for equality: non-finite ⇒ `null`;
 * `undefined`/function/symbol properties are OMITTED from an object and become `null` in an
 * array; keys compare in ENUMERATION order (a reordered object is a different string); and
 * `JSON.parse(String(n)) === n` for every finite double, so number equality is string equality
 * (`-0` serializes as `0`, and `0 === -0`). Allocation-free apart from `Object.keys(shadow)`.
 */
export function sameR3(shadow: unknown, cur: unknown): boolean {
  switch (typeof cur) {
    case 'number': {
      const n = r3(cur);
      return Number.isFinite(n) ? shadow === n : shadow === null;
    }
    case 'string':
    case 'boolean':
      return shadow === cur;
    case 'object': {
      if (cur === null) return shadow === null;
      if (shadow === null || typeof shadow !== 'object') return false;
      if (Array.isArray(cur)) {
        if (!Array.isArray(shadow) || shadow.length !== cur.length) return false;
        for (let i = 0; i < cur.length; i++) {
          const e: unknown = cur[i];
          const t = typeof e;
          if (e === undefined || t === 'function' || t === 'symbol') {
            if (shadow[i] !== null) return false;
          } else if (!sameR3(shadow[i], e)) {
            return false;
          }
        }
        return true;
      }
      if (Array.isArray(shadow)) return false;
      const keys = Object.keys(shadow);
      let j = 0;
      for (const k in cur) {
        if (!hasOwn.call(cur, k)) continue;
        const e = (cur as Record<string, unknown>)[k];
        const t = typeof e;
        if (e === undefined || t === 'function' || t === 'symbol') continue;
        if (keys[j] !== k || !sameR3((shadow as Record<string, unknown>)[k], e)) return false;
        j++;
      }
      return j === keys.length;
    }
    default:
      // undefined / function / symbol serialize to nothing; a ball never is one
      return shadow === undefined;
  }
}

/**
 * Per-ball wire strings for ONE room's broadcast stream. `reset()` wherever the room starts a
 * fresh baseline (a new match, a return to the lobby) — the same places `prevBalls` was reset.
 */
export class BallWireCache {
  private readonly str = new Map<number, string>();
  private readonly shadow = new Map<number, unknown>();

  reset(): void {
    this.str.clear();
    this.shadow.clear();
  }

  /**
   * The ids whose rounded wire form differs from the previous call's, in `balls` order — the
   * set `cur.get(id) !== prevBalls.get(id)` produced — refreshing each one's string. A ball
   * seen for the first time (or first since it left the world) counts as changed.
   */
  diff(balls: readonly Artifact[]): number[] {
    const changed: number[] = [];
    for (const b of balls) {
      const sh = this.shadow.get(b.id);
      if (sh !== undefined && sameR3(sh, b)) continue;
      const s = JSON.stringify(b, round3);
      this.str.set(b.id, s);
      this.shadow.set(b.id, JSON.parse(s));
      changed.push(b.id);
    }
    // ⚠️ FORGET BALLS THAT LEFT THE WORLD. `prevBalls` was rebuilt from the live list every
    // frame, so an id that disappeared and later came back (ids are `max(id)+1`, and the human
    // player splices balls out) read as CHANGED. A stale shadow would call it unchanged if it
    // returned with identical data, and the client — which dropped it — would never be sent it.
    // Every live id is in the map after the loop, so a map larger than the world means a leaver.
    if (this.str.size > balls.length) {
      const live = new Set<number>();
      for (const b of balls) live.add(b.id);
      for (const id of this.str.keys()) {
        if (!live.has(id)) {
          this.str.delete(id);
          this.shadow.delete(id);
        }
      }
    }
    return changed;
  }

  /** `JSON.stringify(ball, round3)` for a ball in the world at the last `diff` */
  wire(id: number): string {
    return this.str.get(id) as string;
  }
}

/**
 * The shared snapshot body — `{"t":"snapshot",…,"cmds":[…]` WITHOUT its closing brace, so each
 * recipient's `ackInputTick` tail can be appended. Byte-identical to
 * `JSON.stringify({ t, serverTick, w: slim, balls: { order, upd }, cmds }, round3).slice(0, -1)`.
 * `upd` must be balls present at the last `cache.diff`, carrying their current data.
 */
export function snapshotBody(
  serverTick: number,
  slimJson: string,
  orderJson: string,
  upd: readonly Artifact[],
  cmdsJson: string,
  cache: BallWireCache,
): string {
  let u = '';
  for (let i = 0; i < upd.length; i++) u += (i ? ',' : '') + cache.wire(upd[i].id);
  return `{"t":"snapshot","serverTick":${serverTick},"w":${slimJson},"balls":{"order":${orderJson},"upd":[${u}]},"cmds":${cmdsJson}`;
}

/** the three per-broadcast JSON fragments `snapshotBody` splices, computed once per frame */
export function snapshotParts(slim: unknown, order: readonly number[], cmds: readonly QCommand[]): {
  slimJson: string;
  orderJson: string;
  cmdsJson: string;
} {
  return {
    slimJson: JSON.stringify(slim, round3),
    orderJson: JSON.stringify(order),
    cmdsJson: JSON.stringify(cmds, round3),
  };
}

// ─── TEST-ONLY REFERENCE ─────────────────────────────────────────────────────
// The encoder exactly as `Room.broadcastSnapshot` wrote it before this file existed. Nothing in
// production calls these; `npm test` ("snapshot wire:") runs real rooms with the check switched
// on (`Room.checkWireForTest`) and asserts every change set and every body matches them.

/** the old diff: a fresh rounded string per ball, compared against last frame's map */
export function referenceChanged(
  prev: Map<number, string>,
  balls: readonly Artifact[],
): { cur: Map<number, string>; changed: number[] } {
  const cur = new Map<number, string>();
  for (const b of balls) cur.set(b.id, JSON.stringify(b, round3));
  const changed: number[] = [];
  for (const b of balls) if (cur.get(b.id) !== prev.get(b.id)) changed.push(b.id);
  return { cur, changed };
}

/** the old body: one `JSON.stringify` of the whole partial message under the replacer */
export function referenceBody(
  serverTick: number,
  slim: unknown,
  order: readonly number[],
  upd: readonly Artifact[],
  cmds: readonly QCommand[],
): string {
  return JSON.stringify({ t: 'snapshot', serverTick, w: slim, balls: { order, upd }, cmds }, round3).slice(0, -1);
}
