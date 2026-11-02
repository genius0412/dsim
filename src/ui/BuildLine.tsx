import type { RobotSpec } from '../types';
import type { GameId } from '../games/types';
import { buildParts } from './robotLabels';

/**
 * A BUILD AS TAGS — the drivetrain, then each mechanism, with where it is mounted quiet inside its
 * own tag: `Mecanum` `Double turret right + left` `Box tube back`. What a robot card, the builder
 * hero and the lobby print under a robot's name.
 *
 * It was one line of words joined by ` · `, with the mounts in the builder's capitals, and it read
 * as a parts list (owner, 2026-11-01). A tag per part keeps each one whole when the line wraps, so a
 * narrow card breaks between parts rather than inside one. Spans with list roles, not a `<ul>`:
 * a robot card is a `<button>`, which may only hold phrasing content.
 */
export function BuildLine({ spec, game }: { spec: RobotSpec; game: GameId }) {
  return (
    <span className="ds-build" role="list">
      {buildParts(spec, game).map((p) => (
        <span key={p.value} className="ds-build-tag" role="listitem">
          {p.value}
          {p.sub ? <span className="at">{p.sub}</span> : null}
        </span>
      ))}
    </span>
  );
}
