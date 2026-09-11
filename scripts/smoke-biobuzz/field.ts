/**
 * BIOBUZZ FIELD checks — lane A's file (field geometry, zones, scoring elements).
 *
 * Placeholder: it holds ONE check so the wiring is proven end to end before the
 * lane has anything to assert. Lane A owns everything in here from T0 on; the
 * shared-core seam's own checks live in `core.ts` and are not lane property.
 */
import { simModuleFor } from '../../src/games/sim';
import { check, section } from './harness';

export function fieldChecks(): void {
  section('biobuzz field');
  // the placeholder shell is a 72 x 72 in half-extent box with four walls; the
  // real geometry lands with lane A's first pass over the manual
  const bounds = simModuleFor('biobuzz').bounds;
  check(
    'biobuzz bounds are the square 12ft field',
    bounds.halfX === 72 && bounds.halfY === 72,
    `${bounds.halfX} x ${bounds.halfY}`,
  );
}
