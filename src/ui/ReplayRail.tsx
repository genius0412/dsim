import { useEffect, useState } from 'react';
import { adminCorrectMatchScore, adminFetchMatch, type AdminMatch } from '../net/api';
import { adminFail } from './adminCopy';
import { NOTICE_MESSAGE_MAX, ratingRefund } from '../notices';
import type { PenaltyLine } from '../sim/penaltyLog';
import type { MatchPhase } from '../types';
import { ENDGAME_START } from '../config';

/**
 * THE REPLAY RAIL — what is beside the field rather than on it.
 *
 * Two sections, with very different audiences and one thing in common: both are questions you
 * can only answer by WATCHING, so both belong next to the match rather than on a page
 * somewhere else.
 *
 *  • PENALTY LOG — for everyone. A replay drew the fouls on the field and named none of them,
 *    so a score that jumped nine points in one second had no explanation anywhere in the
 *    viewer. It is not an admin feature and was never gated as one: a driver reviewing their
 *    own match is the person most entitled to know which rule they broke.
 *  • SCORE — for a moderator, on a replay opened from the misscore queue. The claim is "the
 *    server got the arithmetic wrong"; the replay re-simulates the match and shows what it
 *    scores, so the correction is made where the evidence is, not from a form on another
 *    screen with the number copied across by hand.
 */

/** one call, with the moment it landed */
export interface PenaltyEntry {
  tick: number;
  phase: MatchPhase;
  timeLeft: number;
  line: PenaltyLine;
}

/** THE HOUSE WORDS, not shorter ones invented for a narrow column: the live HUD's
 *  (`timerPanel`) and the burned-in video's (`hudLabels`), END GAME split out of teleop the same
 *  way. It said AUTO and POST-MATCH until design review 09-07 — the drift this list exists to
 *  prevent. The row wraps instead. */
const PHASE_LABEL: Record<MatchPhase, string> = {
  pre: 'PRE-MATCH',
  auto: 'AUTONOMOUS',
  transition: 'TRANSITION',
  teleop: 'DRIVER-CONTROLLED',
  post: 'MATCH OVER',
  freeplay: 'FREE DRIVE',
};

/** `AUTONOMOUS 0:12` — the phase and its remaining clock, which is how a match is actually
 *  read. A bare offset into the file tells a watcher nothing about when in the MATCH it happened. */
function whenLabel(e: PenaltyEntry): string {
  const m = Math.floor(e.timeLeft / 60);
  const s = String(e.timeLeft % 60).padStart(2, '0');
  const phase = e.phase === 'teleop' && e.timeLeft <= ENDGAME_START ? 'END GAME' : PHASE_LABEL[e.phase] ?? e.phase;
  return `${phase} ${m}:${s}`;
}

/**
 * THE PENALTY LOG accumulates as the replay plays, rather than being computed up front.
 *
 * Deriving the whole list on open would mean re-simulating the entire match before the first
 * frame — several thousand physics ticks, synchronously, while the watcher stares at a blank
 * canvas — to save them dragging the seek bar. So it fills in as the match runs, exactly like
 * the live event feed it comes from, and a moderator who wants the whole list drags to the
 * end, which costs the same re-simulation at a moment they chose.
 */
export function PenaltyLog({
  entries,
  done,
  solo,
  onSeek,
}: {
  entries: PenaltyEntry[];
  /** the replay has played out, so an empty list means there were none */
  done: boolean;
  /**
   * ONE alliance was on the field (a record run). Its fouls are still "awarded" to the other
   * side by the sim, because that is how scoring works — but naming an opponent that never
   * existed is the same phantom the score strip refuses to print a 0 for, so the row reports
   * the deduction instead. It is the same subtraction the record results screen makes.
   */
  solo: boolean;
  /** jump the replay to the tick a call landed on — the reason this is a list of buttons */
  onSeek: (tick: number) => void;
}) {
  return (
    <section className="rr-sec">
      <h2 className="rr-h">Penalties</h2>
      {entries.length === 0 ? (
        <p className="rr-none">{done ? 'No fouls in this match.' : 'No fouls yet.'}</p>
      ) : (
        <ol className="rr-pen">
          {entries.map((e, i) => (
            <li key={`${e.tick}-${i}`}>
              <button className="rr-pen-row" onClick={() => onSeek(e.tick)} title="Jump to this call">
                <span className="rr-when">{whenLabel(e)}</span>
                {e.line.kind === 'foul' ? (
                  <>
                    {/* the OFFENDER is the headline. The sim's line names the alliance that
                        GAINED the points, which is the scoring truth and the wrong half of it
                        to lead with: a watcher asking about a foul is asking who committed it. */}
                    <span className={`rr-side ${e.line.offender}`}>
                      {e.line.offender === 'red' ? 'RED' : 'BLUE'}
                    </span>
                    <span className={`rr-sev ${e.line.severity}`}>
                      {e.line.severity === 'major' ? 'MAJOR' : 'MINOR'}
                    </span>
                    <span className="rr-rule">{e.line.rule}</span>
                    <span className="rr-pts">
                      {solo
                        ? `\u2212${e.line.points}`
                        : `${e.line.awardedTo === 'red' ? 'RED' : 'BLUE'} +${e.line.points}`}
                    </span>
                  </>
                ) : e.line.kind === 'card' ? (
                  <>
                    <span className={`rr-side ${e.line.alliance}`}>
                      {e.line.alliance === 'red' ? 'RED' : 'BLUE'}
                    </span>
                    <span className={`rr-sev card-${e.line.colour}`}>
                      {e.line.colour === 'red' ? 'RED CARD' : 'YELLOW CARD'}
                    </span>
                    <span className="rr-rule">
                      {e.line.who} · {e.line.rule}
                    </span>
                    <span className="rr-pts" />
                  </>
                ) : (
                  <>
                    <span className={`rr-side ${e.line.alliance}`}>
                      {e.line.alliance === 'red' ? 'RED' : 'BLUE'}
                    </span>
                    <span className="rr-sev warning">WARNING</span>
                    <span className="rr-rule">{e.line.rule}</span>
                    <span className="rr-pts" />
                  </>
                )}
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * THE SCORE EDITOR — a moderator correcting what a finished match is recorded as having
 * scored, while watching the match.
 *
 * The design problem is that there are TWO numbers and they are easy to confuse: what the
 * database says (`stored`), and what the replay in front of you is computing right now
 * (`live`). So both are on screen at once, side by side, with the difference called out — and
 * the primary action is not "type a number", it is TAKE FROM REPLAY, because the replay
 * re-simulating the match IS the evidence the claim is about. Typing is still there for the
 * case the replay cannot settle (a match whose recording never finished, a sim version that
 * has moved under it), but it is the fallback, not the flow.
 *
 * NOTHING SAVES WITHOUT A VISIBLE CONSEQUENCE: the winner line re-derives from the edited
 * numbers as they are typed, so "this makes it a tie" or "this flips the match" is on screen
 * before the button is pressed rather than discovered afterwards in someone's history.
 *
 * EVERY PLAYER IN THE MATCH IS TOLD (0057), with the old and new totals and the message typed
 * here, and on a ranked match whose result flips, the rating the wrong result cost is given
 * back (`ratingRefund`). The refund is previewed per player before saving, like the winner.
 */
export function ScoreEditor({
  matchId,
  live,
  onSeekEnd,
}: {
  matchId: string;
  /** the score the replay is showing at this tick */
  live: { red: number; blue: number };
  /** play the replay through to its end, so `live` is the final score */
  onSeekEnd: () => void;
}) {
  const [match, setMatch] = useState<AdminMatch | null>(null);
  const [missing, setMissing] = useState(false);
  const [red, setRed] = useState('');
  const [blue, setBlue] = useState('');
  const [note, setNote] = useState('');
  /** the moderator UNticked the refund; it is on by default wherever one is owed */
  const [noRefund, setNoRefund] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const load = (): void => {
    void adminFetchMatch(matchId).then((m) => {
      setMissing(m === null);
      if (m) {
        setMatch(m);
        setRed(String(m.red));
        setBlue(String(m.blue));
      }
    });
  };
  useEffect(load, [matchId]);

  if (missing) {
    return (
      <section className="rr-sec">
        <h2 className="rr-h">Score</h2>
        <p className="rr-none">
          This replay isn’t attached to a stored match, so there is no result to correct.
        </p>
      </section>
    );
  }
  if (!match) return <div className="ds-loading">Loading the result…</div>;

  const nextRed = Math.max(0, Math.round(Number(red) || 0));
  const nextBlue = Math.max(0, Math.round(Number(blue) || 0));
  const valid = red.trim() !== '' && blue.trim() !== '' && Number.isFinite(Number(red)) && Number.isFinite(Number(blue));
  const changed = valid && (nextRed !== match.red || nextBlue !== match.blue);
  const winner = nextRed === nextBlue ? 'Tie' : nextRed > nextBlue ? 'Red wins' : 'Blue wins';
  const storedWinner = match.red === match.blue ? 'Tie' : match.red > match.blue ? 'Red wins' : 'Blue wins';

  /* WHO WOULD GET RATING BACK — judged against what the match was FIRST recorded as (the rating
     came from that), never against an earlier correction, and never twice for one player. The
     server re-derives all of it; this is the preview. An older server sends no `original`, and
     then nothing is offered. */
  const already = new Set((match.refunds ?? []).map((r) => r.userId));
  const owed = match.original
    ? match.participants
        .map((p) => ({ p, points: ratingRefund(p, match.original!, { red: nextRed, blue: nextBlue }) }))
        .filter((x) => x.points > 0 && !already.has(x.p.userId))
    : [];
  const refundOn = changed && match.liveBoard === true && owed.length > 0 && !noRefund;
  const nameOf = (p: { username: string | null; handle: string }): string => (p.username ? `@${p.username}` : p.handle);

  const save = async (): Promise<void> => {
    if (
      !window.confirm(
        `Record this match as RED ${nextRed} — BLUE ${nextBlue}? ` +
          `It changes ${match.participants.length === 1 ? 'the player’s' : 'every player’s'} match history, and they are told. ` +
          (refundOn
            ? `Rating given back: ${owed.map((x) => `${nameOf(x.p)} +${x.points}`).join(', ')}.`
            : 'No rating changes.'),
      )
    )
      return;
    setBusy(true);
    const done = await adminCorrectMatchScore(matchId, nextRed, nextBlue, note.trim() || undefined, refundOn);
    setBusy(false);
    if (!done) {
      setStatus({ ok: false, text: adminFail('correct the score') });
      return;
    }
    const back = done.refunds ?? [];
    setStatus({
      ok: true,
      text:
        `Saved. Red ${done.redBefore} → ${done.redAfter}, blue ${done.blueBefore} → ${done.blueAfter}.` +
        (back.length ? ` Rating given back to ${back.length} player${back.length === 1 ? '' : 's'}.` : '') +
        (typeof done.notified === 'number' ? ` ${done.notified} told.` : ''),
    });
    setNote('');
    setNoRefund(false);
    load();
  };

  return (
    <section className="rr-sec">
      <h2 className="rr-h">Score</h2>

      {/* THE TWO NUMBERS, side by side, because the whole judgement is the comparison. */}
      <div className="rr-cmp">
        <div className="rr-cmp-col">
          <span className="rr-cap">Recorded</span>
          <span className="rr-cmp-num">
            <b className="red">{match.red}</b> — <b className="blue">{match.blue}</b>
          </span>
          <span className="rr-cmp-sub">{storedWinner}</span>
        </div>
        <div className="rr-cmp-col">
          <span className="rr-cap">Replay now</span>
          <span className="rr-cmp-num">
            <b className="red">{live.red}</b> — <b className="blue">{live.blue}</b>
          </span>
          <button className="ds-btn ghost small" onClick={onSeekEnd}>
            Play to the end
          </button>
        </div>
      </div>

      <div className="rr-actions">
        <button
          className="ds-btn small"
          onClick={() => {
            setRed(String(live.red));
            setBlue(String(live.blue));
          }}
        >
          Take from replay
        </button>
        <button
          className="ds-btn ghost small"
          disabled={!changed}
          onClick={() => {
            setRed(String(match.red));
            setBlue(String(match.blue));
          }}
        >
          Reset
        </button>
      </div>

      <div className="rr-edit">
        <label className="rr-field red">
          <span className="rr-cap">Red</span>
          <input
            type="number"
            min={0}
            inputMode="numeric"
            className="ds-input"
            value={red}
            onChange={(e) => setRed(e.target.value)}
          />
        </label>
        <label className="rr-field blue">
          <span className="rr-cap">Blue</span>
          <input
            type="number"
            min={0}
            inputMode="numeric"
            className="ds-input"
            value={blue}
            onChange={(e) => setBlue(e.target.value)}
          />
        </label>
      </div>

      <p className={`rr-outcome${changed ? ' changed' : ''}`}>
        {valid ? winner : 'Both scores are required.'}
        {changed && storedWinner !== winner && '. This changes the result.'}
      </p>

      {/* SHOWN TO THE PLAYERS (0057), quoted as the moderator's note on the notice every player
          in the match gets. It is also the correction's audit reason. */}
      <label className="rr-field wide">
        <span className="rr-cap">Why (the players see this)</span>
        <textarea
          className="ds-input"
          rows={2}
          value={note}
          maxLength={NOTICE_MESSAGE_MAX}
          placeholder="What the replay shows"
          onChange={(e) => setNote(e.target.value)}
        />
      </label>

      {/* THE REFUND, offered only where one is owed: a ranked match on the live ladder whose
          corrected result is better for somebody who lost rating in it. Ticked by default,
          because that is the case it exists for; the names and amounts are on screen. */}
      {changed && match.liveBoard === true && owed.length > 0 && (
        <label className="ds-checkline rr-refund">
          <input type="checkbox" checked={!noRefund} onChange={(e) => setNoRefund(!e.target.checked)} />
          Give back rating: {owed.map((x) => `${nameOf(x.p)} +${x.points}`).join(', ')}
        </label>
      )}

      <button className="ds-btn primary" disabled={!changed || busy} onClick={() => void save()}>
        {busy ? 'Saving…' : 'Save score'}
      </button>

      {/* SAID OUT LOUD, every time. Glicko-2 is sequential — every match since this one was
          rated against the numbers it produced — so correcting one match in the middle cannot
          re-rate it without re-rating everything after it for everyone involved. What it CAN
          do is give a wrongly-recorded loss back, which is what VALORANT and lichess do. */}
      <p className="rr-note">
        Ratings are not recalculated. A player whose result gets better can be given back the
        rating this match cost them, once. Nobody loses rating. Every player is told.
      </p>

      {/* a failed save in the error colour, not the success one (design review 09-11) */}
      {status && (
        <p className={`ds-hint ${status.ok ? 'ok' : 'err'}`} role="status">
          {status.text}
        </p>
      )}

      <h3 className="rr-h4">Who played</h3>
      <ul className="rr-players">
        {match.participants.map((p) => (
          <li key={p.userId}>
            <span className={`rr-side ${p.alliance}`}>{p.alliance === 'red' ? 'RED' : 'BLUE'}</span>
            <span className="rr-name">{p.username ? `@${p.username}` : p.handle}</span>
            <span className="rr-dt ds-muted">{p.drivetrain}</span>
            {p.ratingAfter !== null && (
              <span className="rr-elo ds-muted">
                {p.ratingBefore} → {p.ratingAfter}
                {already.has(p.userId) &&
                  ` · +${match.refunds!.find((r) => r.userId === p.userId)!.points} given back`}
              </span>
            )}
          </li>
        ))}
      </ul>

      {match.corrections.length > 0 && (
        <>
          <h3 className="rr-h4">Already corrected</h3>
          <ul className="rr-hist">
            {match.corrections.map((c) => (
              <li key={c.id}>
                <span className="ds-muted">
                  {c.redBefore}–{c.blueBefore} → {c.redAfter}–{c.blueAfter} ·{' '}
                  {new Date(c.at).toLocaleString()}
                </span>
                {c.note && <span className="rr-hist-note">{c.note}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
