/**
 * WIRE PRECISION — 3 decimal places, applied as a `JSON.stringify` REPLACER.
 *
 * The sim runs in inches and seconds at 60 Hz and serialises whatever float it lands on, so a
 * position goes out as `-31.415926535897932` when the client cannot see, and cannot act on,
 * better than a thousandth of an inch — `worldHash` itself quantises to 1e-3. Rounding here
 * takes ~41% off a DECODE frame and ~54% off a CR one before the deflater ever sees it.
 *
 * ⚠️ A LEAF MODULE, and it has to be one — the same reason `src/net/roomRegion.ts` is.
 * `server/room.ts` sits in an import cycle, so a `const` exported from it reads back
 * `undefined` (or throws a ReferenceError under a different transpile) in a module that
 * imports it without also pulling in `Room` — which is exactly what `scripts/costprobe.ts`
 * does. The probe MUST agree with the server about this number or it is measuring fiction,
 * so the definition lives somewhere both can reach with no cycle at all.
 *
 * ⚠️ NOT in `src/net/protocol.ts`: that is client-bundled, so a server-only wire helper there
 * ships dead code to every browser and widens a shared codec for one consumer.
 *
 * `Number.isInteger` is what makes "ids, counts, scores, ticks and `rngState` are untouched"
 * STRUCTURAL rather than a promise — and it is the whole guard: `Number.isInteger(NaN)` is
 * already false and `JSON.stringify` writes a non-finite number as `null` either way, so a
 * `Number.isFinite` test would be dead code. Module scope ⇒ one closure for the process.
 *
 * WHY THE ERROR CANNOT ACCUMULATE, which is the only real question here. A client holds a
 * rounded value and steps forward from it, so its own copy drifts — but the server re-sends a
 * ball the MOMENT any of its fields crosses a 0.0005 boundary, because the DIFF KEY is the
 * rounded serialisation. So the client is never more than 0.001 per field from the server, for
 * as long as the room runs, with no ratchet. The same holds for the two clocks (`world.time`
 * against `fireReadyAt`): both are rounded by this one replacer, so they are compared in the
 * same units, and a 0.5 ms disagreement can at worst flip a fire-ready test for a single tick
 * — which the next snapshot's snap-and-replay corrects, and which the SERVER decides anyway.
 * (An earlier design tried to exempt the clocks with a `TIME_KEYS` set. It cannot be built: it
 * omits `world.time`, the LEFT side of every one of those comparisons; two more clocks sit
 * under dynamic keys no `Set` reaches — `PenaltyState.episodes` and `ChainState.catalystReadyAt`
 * — and a `JSON.stringify` replacer cannot exempt a subtree in the first place.)
 *
 * NOT a protocol change: no key is added, removed or retyped. `unslimWorld`, `applyBallDelta`
 * and `reconcile` are all value-blind, and `QCommand` is integer-only, so `cmds` is untouched
 * and "remote robots are stepped from `Snapshot.cmds`" still holds exactly. No caps gate, and
 * no stored replay is affected — replays are an INPUT log, not a snapshot stream.
 */
export const round3 = (_k: string, v: unknown): unknown =>
  typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v;
