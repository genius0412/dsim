import type { World } from '../../types';
import { BB_MENU_REST } from './menuRest.gen';
import { biobuzzPhysics } from './state';

/**
 * THE MENU STAGE'S HIVES AND FLOWERS AS A MATCH LEAVES THEM — the `GameModule.restMenuWorld` slot
 * (2026-11-03).
 *
 * Staging places each up-cell NECTAR at the cell opening's mid-height and each FLOWER's POLLEN on
 * the bore axis at `flowerStackZ` (`spawn.ts`), and a 3D match's first seconds of physics drop
 * them onto what holds them. The stage never steps its world, so it drew the staged poses: NECTAR
 * 7.9 in above the cell floor, and each FLOWER a straight column within 0.16 in of its axis (owner:
 * "floating", "too perfectly stacked"). Settled, the NECTAR lies on the floor against the cell's
 * inner wall and each column zig-zags ±0.55 in, against alternate walls of its bore.
 *
 * The poses are that physics, run once offline: the stage's own world (`STAGE_SEED`, `'3d'`)
 * stepped 6 s by the real `step3d`, in `scripts/smoke-biobuzz/menuStage.ts`, which also fails when
 * the table no longer matches a fresh settle. Each FLOWER's POLLEN start that settle rolling
 * sideways, alternating, square to the stage camera that shows that flower: left to the staged
 * scatter, Play's flower zig-zagged toward the camera, where it reads as a straight column (owner,
 * the same day: "no side-to-side variation"). Baked rather than settled here because settling
 * needs the Rapier 3D chunk (~1.1 MB gzipped), which Home never otherwise loads.
 *
 * A `'3d'` world only: the table's `z` is a body's underside, the 3D convention (`sim3d/bodies.ts`),
 * and the 2D stage draws from above, where none of this shows. Matched on `el` and `slot`, which
 * name the same staged element in every world; positions only, so `contents` and `stack` hold.
 */
export function restBiobuzzMenuWorld(world: World): void {
  if (biobuzzPhysics(world) !== '3d') return;
  for (const b of world.balls) {
    if (b.state.kind !== 'element') continue;
    const { el, slot } = b.state;
    const p = BB_MENU_REST.find((q) => q.el === el && q.slot === slot);
    if (!p) continue;
    b.pos = { x: p.x, y: p.y };
    b.z = p.z;
  }
}
