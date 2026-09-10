/**
 * BIOBUZZ ROBOT checks — lane B's file (archetypes, mechanisms, builder limits).
 *
 * Placeholder: it holds ONE check so the wiring is proven end to end before the
 * lane has anything to assert. Lane B owns everything in here from T0 on.
 */
import { simModuleFor } from '../../src/games/sim';
import { check, section } from './harness';

export function robotChecks(): void {
  section('biobuzz robot');
  // the placeholder shell has no scoring and no start legality yet, so nothing
  // persists to a board and the server's G304 gate stays off for it
  const mod = simModuleFor('biobuzz');
  check('biobuzz is not scored yet', mod.scored === false);
  check('biobuzz has no start legality yet', mod.startLegality === false);
}
