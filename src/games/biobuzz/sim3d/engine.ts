/**
 * BIOBUZZ 3D PHYSICS — engine bootstrap (Day 1 seam, `docs/biobuzz/plan-3d.md` §2.5, §3.2).
 *
 * The deterministic Rapier 3D wasm module is reached ONLY through a dynamic `import()` inside
 * `initPhysics3d()` — exactly the pattern `scripts/spike3d.ts` (the Day 0 spike) used, and the
 * same reason the shared 2D `initPhysics()` (`src/sim/physicsEngine.ts`) awaits its own module
 * before any step: a client that never steps a 3D world must never pay for the ~1.1 MB gzipped
 * chunk (`docs/biobuzz/spike3d-results.md`).
 *
 * ── THIS FILE IS THE LIGHT SEAM, AND THAT IS ITS WHOLE JOB ─────────────────────────────────
 * ⚠️ **NOTHING HEAVY MAY BE STATICALLY IMPORTED HERE.** Every module that builds bodies, steps
 * a world, derives state or predicts one (`engineImpl.ts`, `bodies.ts`, `step3dImpl.ts`,
 * `derive.ts`, `elements3d.ts`, `hive3d.ts`, `flower3d.ts`, `flowerTube.ts`, `contacts3d.ts`,
 * `robot3d.ts`, `math3.ts`, `fieldColliders(.gen).ts`, `predict.ts`) hangs off ONE re-export
 * barrel, `./impl`, and `initPhysics3d()` below is the only thing that imports it — dynamically,
 * beside the wasm. The loader and `./tilt` are the only two sim3d modules the rest of `src/`
 * may import.
 *
 * It used to be otherwise: the persistent world sat below the loader in THIS file, and
 * `step.ts` imported `step3d` directly, so the whole 3D implementation was statically reachable
 * from the entry and landed in the MAIN chunk — ~225 KB of source that every player of every
 * game downloaded to run a 2D match. `npm run bundleaudit` is what measures it, and the RENDER
 * lane's import-boundary check is what stops it coming back.
 *
 * DETERMINISM (plan §2.5): `@dimforge/rapier3d-deterministic-compat` is the ONE package this
 * module may import — never the non-compat `-deterministic` build (Day 0 measured it as not a
 * drop-in on this toolchain: no Node/tsx entry point, and Vite's optimizer refuses its wasm
 * import outright) and never the 2D `@dimforge/rapier2d-compat`, which is a different engine
 * for a different solve.
 */

// TYPE-ONLY, so it costs the chunk nothing — the light-seam rule above is about VALUE imports.
import type { World } from '../../../types';
import { biobuzzPhysics } from '../state';

/** the resolved module's shape — `typeof import(...)`, so every caller gets the package's own
 * types without a second, hand-maintained copy of them. */
export type Rapier3d = typeof import('@dimforge/rapier3d-deterministic-compat');

/** the 3D implementation's shape — same trick, over this game's own lazy barrel. */
export type Physics3dImpl = typeof import('./impl');

let mod: Rapier3d | null = null;
let impl: Physics3dImpl | null = null;
let inFlight: Promise<void> | null = null;

/**
 * Resolve the wasm module AND the 3D implementation, exactly once per process.
 *
 * IDEMPOTENT and safe to call from every site that might need to be first — the server at
 * boot (beside `initPhysics()`), the smoke suite, a solo 3D practice start, LAN hosting a 3D
 * room: a second call while the first is still in flight awaits the SAME promise rather than
 * importing (and re-initializing) the module twice.
 *
 * The two imports are kicked off TOGETHER (one round trip each, in parallel) but `mod` is
 * published first: nothing in `./impl` calls `rapier3d()` at module-evaluation time, and
 * ordering it this way keeps that a property of the loader rather than of every module the
 * barrel pulls in.
 */
export async function initPhysics3d(): Promise<void> {
  if (mod && impl) return;
  if (!inFlight) {
    inFlight = (async () => {
      // matches the spike's exact call: the compat build needs `init()` before any world uses it.
      const wasm = import('@dimforge/rapier3d-deterministic-compat');
      const barrel = import('./impl');
      const resolved: Rapier3d = await wasm;
      await resolved.init();
      mod = resolved;
      impl = await barrel;
    })();
  }
  return inFlight;
}

/** has `initPhysics3d()` resolved — BOTH the wasm and the implementation? */
export function physics3dReady(): boolean {
  return mod !== null && impl !== null;
}

/**
 * The resolved module.
 *
 * Throws rather than lazily initializing: a call before `initPhysics3d()` has resolved is a
 * bug at the CALL SITE (every step-capable entry point is supposed to await it first, exactly
 * like the 2D `initPhysics()` contract), not a state this function should paper over by
 * kicking off a second, unawaited load.
 */
export function rapier3d(): Rapier3d {
  if (!mod) throw new Error('3D physics not initialised: await initPhysics3d() first');
  return mod;
}

/**
 * The resolved 3D IMPLEMENTATION — the lazy barrel, and the only way anything in the main
 * chunk may reach it. Same contract (and the same message) as `rapier3d()` above: a call
 * before `initPhysics3d()` has resolved is a bug at the call site.
 *
 * `sim3d/step3d.ts` is the thin gate that turns `step3d(world, dt, commands)` into
 * `physics3dImpl().step3d(...)`, so `step.ts` can dispatch without importing a byte of the
 * implementation. THE PREDICTORS (`predict.ts`) are reached the same way and ONLY that way —
 * `physics3dImpl().createFullPredictor(world, id)` / `.createLightPredictor(...)` after the
 * await — because a predictor builds Rapier bodies, so there is no honest world in which a
 * caller has one and has not initialised physics.
 */
export function physics3dImpl(): Physics3dImpl {
  if (!impl) throw new Error('3D physics not initialised: await initPhysics3d() first');
  return impl;
}

/**
 * FREE the Rapier world a finished match was solved in — see `disposeEngineFor`
 * (`engineImpl.ts`) for why a `WeakMap` cannot do it and what is leaked when nobody does.
 *
 * ⚠️ THIS ONE IS A NO-OP WHEN 3D WAS NEVER LOADED, and that is the point of routing it through
 * the light gate instead of through `physics3dImpl()`. Every teardown path — the controller's
 * `dispose`, a world swap, `Room.stop()` — runs for 2D matches too, and the barrel's accessor
 * THROWS before `initPhysics3d()` resolves. A teardown that has to ask "was this a 3D room"
 * first is a teardown that gets skipped on the path where someone forgets to ask.
 */
export function disposePhysics3dFor(world: World): void {
  if (!impl) return;
  impl.disposeEngineFor(world);
}

/**
 * BUILD A 3D MATCH'S ENGINE WHEN THE ROOM BUILDS ITS WORLD, not inside its first tick. The
 * engine is persistent per `World` (`engineImpl.ts`), so building it here is the same build
 * `step3d` would do on tick 1 from the same JSON — measured byte-identical — moved out of the
 * 60 Hz loop that every room on the server shares. A no-op for a 2D world, for any other game,
 * and before `initPhysics3d()` has resolved (the light gate, like `disposePhysics3dFor`).
 */
export function prebuildPhysics3dFor(world: World): void {
  if (!impl || world.game !== 'biobuzz' || biobuzzPhysics(world) !== '3d') return;
  impl.engineFor(world);
}

