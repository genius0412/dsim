import type { RobotSpec } from '../../types';
import { clampCosmetics } from '../../cosmetics';
import { bbDeployedHeightIn } from './config';
import { bbIntakeKindOf, bbLauncherOf, bbLiftOf } from './mechs';

/**
 * A BUILD'S GEOMETRY IDENTITY — the fields that change what a BIOBUZZ robot LOOKS like in 3D,
 * joined into one string.
 *
 * ── WHY IT IS ITS OWN (TINY) MODULE ─────────────────────────────────────────────────────────
 * It has two readers on opposite sides of the lazy-chunk boundary:
 *
 *  - `scene/renderRobots.ts` (inside the Three.js chunk) rebuilds a robot's `THREE.Group` only
 *    when this changes, so a driving robot never pays for a teardown every frame.
 *  - `Preview3D.tsx` (the MAIN chunk) keys the saved-robot thumbnail cache on it, and has to be
 *    able to do that BEFORE — and without — loading the scene chunk.
 *
 * One function, so those two can never disagree about whether two specs are the same robot. That
 * is the concrete form of roadmap item 1's "preview and match must not drift": a thumbnail cached
 * under a key that the generator does not rebuild on would show the previous build.
 *
 * ── WHAT IS IN IT, AND WHAT IS NOT ──────────────────────────────────────────────────────────
 * POSE is not in it (position, heading, turret yaw) — that is set on the group every frame and
 * costs nothing. MASS, RPM and the hopper size are not in it either: they change how the robot
 * DRIVES, not what it is shaped like, and putting them in would throw away the group on every
 * drag of a slider that cannot change a single vertex.
 *
 * `heightIn` goes in RESOLVED (`bbDeployedHeightIn`), not raw, so an absent height and an
 * explicit 18 are one key rather than two. The STOWED preview is expressed as a spec whose
 * `heightIn` IS the stow height, which is why the stow toggle rebuilds correctly for free.
 *
 * ⚠️ **`teamNumber` IS IN IT, EVEN THOUGH IT MOVES NO VERTEX.** It became geometry the day the
 * ROBOT SIGNS started printing it (R403, `scene/renderRobots.ts`): the number is rasterised into
 * the sign texture at BUILD time, so a spec whose number changed and whose shape did not would
 * keep the previous number on both plates — on the robot AND in the cached thumbnail, which is
 * the exact "a key the generator does not rebuild on" failure this module exists to prevent. It
 * is the one entry here that is not a shape, and that is why it carries this note.
 *
 * ⚠️ **`accent`/`decal`/`plate` ARE IN IT TOO, FOR THE SAME REASON `chassisColor` IS.** All four
 * are baked into build-time materials/textures (the frame skin, the roller/wheel tint, the deck
 * decal texture, the sign plate frame) — a change to any of them with no matching rebuild would
 * leave the OLD cosmetic on the group. `clampCosmetics` is the one shape-safe reader, same as
 * every renderer uses, so a key computed here and a fill computed in `buildRobotGroup` can never
 * disagree about what an unrecognised or absent value defaults to.
 */
export function bbSpecKey(spec: RobotSpec): string {
  const launcher = bbLauncherOf(spec, 0);
  const lift = bbLiftOf(spec);
  const cosm = clampCosmetics(spec);
  const key = [
    spec.length,
    spec.width,
    bbDeployedHeightIn(spec),
    spec.chassisColor ?? '',
    cosm.accent,
    cosm.decal,
    cosm.plate,
    spec.teamNumber ?? '',
    spec.intakeMount ?? '',
    spec.intake,
    bbIntakeKindOf(spec),
    spec.drivetrain,
    launcher.kind,
    launcher.mount,
    launcher.mount2 ?? '',
    lift?.mount ?? '',
  ].join('|');
  return spec.imported ? `${key}|${importedDigest(spec)}` : key;
}

/**
 * ⚠️ AN IMPORTED ROBOT'S DESCRIPTOR IS ITS GEOMETRY (`docs/robot-import-plan.md` §3.1): two imports
 * with one bounding box — the only shape `length`/`width` above can tell apart — can differ in
 * hull, wheels, bands and every mechanism placement, and re-opening one in the editor keeps its
 * `id` while moving all of those. So the whole descriptor is in the key, as its id plus a digest
 * (FNV-1a of its JSON), computed once per descriptor object, appended only for an import, so a
 * standard robot's key is byte-identical to what it was. Whether the MESH has loaded is
 * NOT in it — that is per device (`renderImported.ts`'s `importedMeshKey`, beside the wheel tier).
 */
const digests = new WeakMap<object, string>();
function importedDigest(spec: RobotSpec): string {
  const imp = spec.imported;
  if (!imp) return '';
  let d = digests.get(imp);
  if (d === undefined) {
    const s = JSON.stringify(imp);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    d = `imp:${imp.id}:${(h >>> 0).toString(16)}`;
    digests.set(imp, d);
  }
  return d;
}
