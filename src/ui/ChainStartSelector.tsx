import { CHAIN_START_POSES } from '../games/chain/config';

/**
 * Chain Reaction start-position picker (rule G04 — start completely in the Lab Area). CR has
 * no drag/legality editor like DECODE's `StartPositionEditor`; every anchor is legal by
 * construction, so this is just a button list. Shared by the solo MatchSetup and the
 * multiplayer Lobby / MatchStrategy so CR never renders DECODE's field geometry.
 */
export function ChainStartSelector({
  startIndex,
  onPick,
}: {
  startIndex: number;
  onPick: (index: number) => void;
}) {
  return (
    <>
      <p className="ds-hint">
        Your robot starts in the lab area — on the floor or up on a ring stand.
      </p>
      <div className="ds-opts two" style={{ marginTop: 8 }}>
        {CHAIN_START_POSES.map((p, i) => (
          <button
            key={p.name}
            className={`ds-opt ${startIndex === i ? 'on' : ''}`}
            onClick={() => onPick(i)}
          >
            <span className="ot">{p.name}</span>
            <span className="od">
              {p.name.startsWith('RING') ? 'Start up on the ring stand' : 'Start on the floor'}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}
