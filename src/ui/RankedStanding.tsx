import { useEffect, useState } from 'react';
import type { GameId } from '../types';
import type { QueueMode } from '../net/protocol';
import { fetchUserStats, type UserStats } from '../net/api';

/**
 * YOUR RANKED STANDING, at the top of the ranked screen: the rating for the format you have picked,
 * where it ranks, how many games it is over, and your overall win-loss. It answers "what am I
 * playing for" before the FIND MATCH button asks for a commitment.
 *
 * One read (`fetchUserStats`, the same one Career makes), kept across mode switches, so flipping 1v1
 * and 2v2 changes the number without a request. An empty RESERVED box until it has an answer, and on
 * any failure: the page below is complete without it, and a standing that says "Couldn't load" on the
 * screen you queue from would be a worse sentence than none.
 */
export function RankedStanding({
  myUserId,
  game,
  mode,
}: {
  myUserId: string | null | undefined;
  game: GameId;
  mode: QueueMode;
}) {
  const [stats, setStats] = useState<UserStats | null>(null);

  useEffect(() => {
    if (!myUserId) return;
    let alive = true;
    fetchUserStats(myUserId, undefined, game)
      .then((s) => alive && setStats(s))
      .catch(() => alive && setStats(null));
    return () => {
      alive = false;
    };
  }, [myUserId, game]);

  if (!myUserId) return null;
  /* the box is RESERVED while the read is in flight, so the answer arriving moves nothing below it */
  if (!stats) return <div className="ds-rankedstanding" aria-hidden="true" />;
  const elo = stats.elo.find((e) => e.mode === mode);
  const { played, wins, losses } = stats.match;
  return (
    <div className="ds-rankedstanding" aria-label={`Your ${mode} standing`}>
      <div className="rs-main">
        <span className="rs-num">{elo ? elo.rating : '—'}</span>
        <span className="rs-cap">{mode} rating</span>
      </div>
      <div className="rs-side">
        <span>{elo ? (elo.rank ? `Rank #${elo.rank}` : 'Unranked') : 'Unplaced'}</span>
        <span>{elo ? `${elo.games} games` : 'No games yet'}</span>
        <span>{played > 0 ? `${wins}W · ${losses}L overall` : 'No matches yet'}</span>
      </div>
    </div>
  );
}
