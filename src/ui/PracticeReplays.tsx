import { useEffect, useState, useSyncExternalStore } from 'react';
import type { GameId } from '../types';
import type { Replay } from '../sim/replay';
import { fetchPracticeRuns, type PracticeRun } from '../net/api';
import {
  listPracticeRuns,
  loadPracticeReplay,
  deletePracticeRun,
  MAX_LOCAL_RUNS,
  onPracticeUploadBlocked,
  practiceUploadBlocked,
  type PracticeRunMeta,
} from '../net/practiceRuns';
import { VerifyEmailInline } from './VerifyCodeForm';
import { SIM_DT } from '../config';
import { fmtDay } from './fmtDate';

/**
 * SOLO PRACTICE REPLAYS — your own offline matches, on your own Career page.
 *
 * SELF-ONLY, and it hangs off `Stats` rather than the shared `CareerPanel` for the same reason
 * `StandingCard` does: `CareerView` also renders PUBLIC profiles, and these runs are offline
 * and unverified by construction. Beside somebody's real, server-witnessed results they would
 * read as competitive history, which is exactly what they are not.
 *
 * TWO SOURCES, ONE LIST. The account holds what was uploaded; this device holds everything
 * played on it, signed in or not. They are merged so a run appears once whether you were
 * signed in when you played it, whether the upload landed, and whether you are on the machine
 * you played it on.
 */

/** m:ss from a tick count — a practice run's length is its own match clock */
const runLength = (ticks: number): string => {
  const s = Math.max(0, Math.round(ticks * SIM_DT));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};


/** one row, from whichever side has it */
interface Row {
  key: string;
  at: number;
  score: number;
  ticks: number;
  /** the server's replay id, when the account has this run */
  replayId: string | null;
  /** the local id, when this device still holds the log */
  localId: string | null;
  /** which solve ran it (`'2d'` | `'3d'`), or null when the run predates the tag */
  physics: string | null;
  /** which renderer it was watched in, or null when unknown */
  view: string | null;
  /** other robots were on the field (`PracticeRunMeta.others`) — known only for a device copy */
  withRobots: boolean;
}

/** merge the account's runs with this device's, newest first, without double-counting one
 *  that is in both (the local copy records the id it was uploaded as) */
function mergeRuns(remote: PracticeRun[], local: PracticeRunMeta[]): Row[] {
  const rows: Row[] = [];
  const claimed = new Set<string>();
  for (const m of local) {
    if (m.remoteId) claimed.add(m.remoteId);
    const match = m.remoteId ? remote.find((r) => r.id === m.remoteId) : undefined;
    rows.push({
      key: m.id,
      at: m.at,
      score: m.score,
      ticks: m.ticks,
      replayId: match?.replayId ?? null,
      localId: m.id,
      // the DEVICE's copy leads, and the account's fills a gap: a run kept before the local
      // fields existed still has them on the server if it was uploaded after the column landed
      physics: m.physics ?? match?.physics ?? null,
      view: m.view ?? match?.view ?? null,
      withRobots: (m.others ?? 0) > 0,
    });
  }
  for (const r of remote) {
    if (claimed.has(r.id)) continue;
    rows.push({
      key: r.id,
      at: new Date(r.createdAt).getTime(),
      score: r.score,
      ticks: r.ticks,
      replayId: r.replayId,
      localId: null,
      physics: r.physics ?? null,
      view: r.view ?? null,
      withRobots: false,
    });
  }
  return rows.sort((a, b) => b.at - a.at);
}

export function PracticeReplays({
  signedIn,
  game,
  onWatchId,
  onWatchLocal,
}: {
  signedIn: boolean;
  game?: GameId;
  /** watch a run the ACCOUNT holds — opens the ordinary replay route by id */
  onWatchId?: (replayId: string) => void;
  /** watch a run only this DEVICE holds — the log is handed over directly, since there is
   *  no server id to fetch it by */
  onWatchLocal?: (replay: Replay) => void;
}) {
  const [remote, setRemote] = useState<PracticeRun[]>([]);
  const [local, setLocal] = useState<PracticeRunMeta[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = (): void => setLocal(listPracticeRuns());
  /** the account refused the last save for an unverified email — see `practiceRuns.ts` */
  const blocked = useSyncExternalStore(onPracticeUploadBlocked, practiceUploadBlocked);

  useEffect(() => {
    setLocal(listPracticeRuns());
    if (!signedIn) {
      setLoading(false);
      return;
    }
    let dead = false;
    fetchPracticeRuns(game)
      .then((runs) => {
        if (!dead) setRemote(runs ?? []);
      })
      .finally(() => {
        if (!dead) setLoading(false);
      });
    return () => {
      dead = true;
    };
  }, [signedIn, game]);

  const rows = mergeRuns(remote, local);

  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        <span className="ds-panel-title">Practice replays</span>
      </div>
      {loading && rows.length === 0 ? (
        <div className="ds-loading">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="ds-empty">
          <div className="big">No practice runs yet</div>
          Finish a Solo practice match and it is kept here.
        </div>
      ) : (
        <>
          {/* the one table scroller (`.ds-table-scroll`). `.ds-panel` is
              `overflow: hidden` for its rounded corners, so a table wider than the
              panel is CUT rather than scrolled. */}
          <div className="ds-table-scroll">
            <table className="ds-table">
              <thead>
                <tr>
                  <th>Played</th>
                  <th className="num">Score</th>
                  <th className="num">Length</th>
                  {/* TWO COLUMNS, not one (design review 09-22): what was SIMULATED and what it
                      was WATCHED in answer different questions, and only the first one decides
                      whether the score means anything against ranked play (the note under the
                      table). One cell read "2D 3D VIEW". */}
                  <th>Physics</th>
                  <th>View</th>
                  <th className="r" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    {/* WITH ROBOTS: the score beside it was not made alone, so it is not a solo
                        number (owner, 2026-09-23) */}
                    <td>
                      {fmtDay(r.at)}
                      {r.withRobots && (
                        <>
                          {' '}
                          <span className="ds-badge">With robots</span>
                        </>
                      )}
                    </td>
                    <td className="num">{r.score}</td>
                    <td className="num">{runLength(r.ticks)}</td>
                    {/* ABSENT, not '2D'. A run kept before a tag existed genuinely does not
                        know, and writing a default would state something nobody measured —
                        the same reasoning migration 0039 gives for `practice_runs.view`. */}
                    <td>
                      {r.physics ? (
                        <span className="ds-dt">{r.physics.toUpperCase()}</span>
                      ) : (
                        <span className="ds-muted">—</span>
                      )}
                    </td>
                    <td>
                      {r.view ? (
                        <span className="ds-dt">{r.view.toUpperCase()}</span>
                      ) : (
                        <span className="ds-muted">—</span>
                      )}
                    </td>
                    {/* NOT `.num` — this cell holds buttons, and `.ds-btn` is
                        inline-block, so JSX stripping the whitespace between the two
                        of them left them touching at 0px. The flex wrapper owns the
                        gap. */}
                    <td className="r">
                      <span className="pr-actions">
                        <button
                          className="ds-btn small"
                          onClick={() => {
                            // prefer the LOCAL log: it needs no round trip, and it is the copy
                            // that exists whether or not the upload ever landed
                            const body = r.localId ? loadPracticeReplay(r.localId) : null;
                            if (body && onWatchLocal) onWatchLocal(body);
                            else if (r.replayId && onWatchId) onWatchId(r.replayId);
                          }}
                          disabled={!(r.localId && loadPracticeReplay(r.localId)) && !r.replayId}
                        >
                          <span aria-hidden="true">▶</span> Watch
                        </button>
                        {/* ONE CLICK USED TO DELETE, and the button's only name was "✕" (design
                            review 09-01). A local-only run never uploaded is gone for good, so the
                            confirm names the run it is about to remove. */}
                        {r.localId && (
                          <button
                            className="ds-btn small ghost"
                            onClick={() => {
                              const what = `the ${fmtDay(r.at)} run (score ${r.score})`;
                              if (!window.confirm(`Remove ${what} from this device?`)) return;
                              deletePracticeRun(r.localId!);
                              reload();
                            }}
                            aria-label={`Remove the ${fmtDay(r.at)} run, score ${r.score}, from this device`}
                          >
                            <span aria-hidden="true">✕</span>
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* a footer BAND, like `.mh-pager`: `.ds-hint` has `margin: 0` and
              `.ds-panel` has no padding, so this sentence sat flush in the panel's
              rounded bottom-left corner while the cell above it was inset 16. */}
          {blocked && (
            <div className="ds-panel-foot">
              <p className="ds-hint warn">
                These runs are only on this device. Verify your email to save them to your account.
              </p>
              <VerifyEmailInline />
            </div>
          )}
          <p className="ds-panel-foot ds-hint">
            {signedIn
              ? `Last ${MAX_LOCAL_RUNS} runs are saved.`
              : `Last ${MAX_LOCAL_RUNS} runs are saved on this device. Sign in to keep them on your account.`}{' '}
            {/* THE COMPARABILITY NOTE (plan §6/§7). Ranked and record rooms run the 3D solve, so
                a 2D-physics practice score is a score in a different game — close, but not the
                same field. Saying so here is what stops somebody reading a practice number as a
                board number. The VIEW is deliberately not part of that sentence: it changes what
                you see and nothing about what is simulated. */}
            Only 3D-physics runs are comparable with ranked play.
          </p>
        </>
      )}
    </div>
  );
}
