import { useEffect, useState } from 'react';
import type { GameId } from '../types';
import type { Replay } from '../sim/replay';
import { fetchLanRuns, type LanRun } from '../net/api';
import {
  listLocalLanRuns,
  loadLanReplay,
  deleteLocalLanRun,
  MAX_LOCAL_LAN_RUNS,
  type LanRunMeta,
} from '../net/lanRuns';
import { SIM_DT } from '../config';
import { fmtDay } from './fmtDate';
import { LAN_ENABLED } from '../net/env';

/**
 * SELF-HOSTED (LAN) MATCHES — the ones you hosted, on your own Career page.
 *
 * The twin of `PracticeReplays`, and built to the same shape for the same reasons: two
 * sources merged into one list, self-only, and the local copy preferred for playback. Read
 * that file's header first; only the differences are spelled out here.
 *
 * ⚠️ **IT RENDERS NOTHING WHEN THERE IS NOTHING**, unlike the practice panel, which shows an
 * empty state. Solo practice is the mode most players spend most of their time in and a
 * player who has not tried it benefits from being told it exists. Hosting a LAN game is a
 * thing a handful of people do at a venue, so an empty "Self-hosted matches" panel on every
 * Career page would be furniture explaining a feature to the people not using it.
 *
 * THIS LIST IS THE HOST'S, and nobody else's — only the host keeps a LAN match
 * (`keepLanRun`). A guest who played in the room has nothing here, which is correct and is
 * the owner's rule, not an omission.
 */

/** m:ss from a tick count */
const runLength = (ticks: number): string => {
  const s = Math.max(0, Math.round(ticks * SIM_DT));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** one row, from whichever side has it */
interface Row {
  key: string;
  at: number;
  score: { red: number; blue: number };
  /** how many drivers were in it — a LAN match has no ELO, so this is the size of the thing */
  drivers: number;
  ticks: number;
  replayId: string | null;
  localId: string | null;
}

/** merge the account's matches with this device's, newest first. `matchId` is the identity on
 *  both sides — the local row records the cloud id it was uploaded as, and the cloud row
 *  carries the same `matchId` that minted it, so a match in both places appears once. */
function mergeRuns(remote: LanRun[], local: LanRunMeta[]): Row[] {
  const rows: Row[] = [];
  const claimed = new Set<string>();
  for (const m of local) {
    const match = remote.find((r) => r.matchId === m.matchId);
    if (match) claimed.add(match.matchId);
    rows.push({
      key: m.id,
      at: m.at,
      score: m.score,
      drivers: m.participants.length,
      ticks: m.ticks,
      replayId: match?.replayId ?? null,
      localId: m.id,
    });
  }
  for (const r of remote) {
    if (claimed.has(r.matchId)) continue;
    rows.push({
      key: r.matchId,
      at: new Date(r.createdAt).getTime(),
      score: r.score,
      drivers: r.participants.length,
      // a cloud row carries no tick count of its own — the length is in the replay, which is
      // not fetched to render a list
      ticks: 0,
      replayId: r.replayId,
      localId: null,
    });
  }
  return rows.sort((a, b) => b.at - a.at);
}

interface LanReplaysProps {
  signedIn: boolean;
  game?: GameId;
  /** watch a match the ACCOUNT holds — the ordinary replay route, by id */
  onWatchId?: (replayId: string) => void;
  /** watch a match only this DEVICE holds — the log is handed over directly */
  onWatchLocal?: (replay: Replay) => void;
}

/**
 * The LAN gate, kept in ONE place rather than at the call sites: Career alone renders this
 * four times, and a fifth added later would silently miss a check spread across them.
 *
 * It is a WRAPPER, not an early return inside the panel, because the panel's first statement
 * would otherwise be a conditional `return null` standing in front of its hooks. `LAN_ENABLED`
 * is a build constant, so the hook count could never actually change between renders and it
 * would have worked — but "this is fine because the condition is secretly constant" is a
 * footgun to leave lying in a component, and it stops being true the moment somebody makes the
 * flag dynamic. Rendering a child conditionally has no such caveat.
 */
export function LanReplays(props: LanReplaysProps) {
  if (!LAN_ENABLED) return null;
  return <LanReplaysPanel {...props} />;
}

function LanReplaysPanel({ signedIn, game, onWatchId, onWatchLocal }: LanReplaysProps) {
  const [remote, setRemote] = useState<LanRun[]>([]);
  const [local, setLocal] = useState<LanRunMeta[]>([]);

  const reload = (): void => setLocal(listLocalLanRuns());

  useEffect(() => {
    setLocal(listLocalLanRuns());
    if (!signedIn) return;
    let dead = false;
    void fetchLanRuns(game).then((runs) => {
      if (!dead) setRemote(runs ?? []);
    });
    return () => {
      dead = true;
    };
  }, [signedIn, game]);

  const rows = mergeRuns(remote, local);
  // no loading state on purpose: there is nothing to say while a list that is usually empty
  // loads, and a spinner that resolves to nothing is worse than nothing
  if (rows.length === 0) return null;

  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        <span className="ds-panel-title">Self-hosted matches</span>
      </div>
      <div className="mh-scroll">
        <table className="ds-table">
          <thead>
            <tr>
              <th>Played</th>
              <th className="num">Score</th>
              <th className="num">Drivers</th>
              <th className="num">Length</th>
              <th className="r" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>{fmtDay(r.at)}</td>
                {/* RED then BLUE, the way the scoring display reads it */}
                <td className="num">
                  {r.score.red} – {r.score.blue}
                </td>
                <td className="num">{r.drivers}</td>
                <td className="num">{r.ticks ? runLength(r.ticks) : '—'}</td>
                <td className="r">
                  <span className="pr-actions">
                    <button
                      className="ds-btn small"
                      onClick={() => {
                        // prefer the LOCAL log: no round trip, and it is the copy that exists
                        // whether or not the upload ever landed
                        const body = r.localId ? loadLanReplay(r.localId) : null;
                        if (body && onWatchLocal) onWatchLocal(body);
                        else if (r.replayId && onWatchId) onWatchId(r.replayId);
                      }}
                      disabled={!(r.localId && loadLanReplay(r.localId)) && !r.replayId}
                    >
                      ▶ Watch
                    </button>
                    {r.localId && (
                      <button
                        className="ds-btn small ghost"
                        onClick={() => {
                          deleteLocalLanRun(r.localId!);
                          reload();
                        }}
                        title="Remove from this device"
                      >
                        ✕
                      </button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="ds-panel-foot ds-hint">
        {signedIn
          ? `Matches you hosted on your own network. They are unofficial — never rated, and never on a leaderboard. Last ${MAX_LOCAL_LAN_RUNS} are kept on this computer.`
          : `Matches you hosted on your own network, kept on this computer. Sign in to save them to your account.`}
      </p>
    </div>
  );
}
