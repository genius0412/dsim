import { useEffect, useRef, useState } from 'react';
import { adminEditStanding, adminFetchStanding, type AdminStanding as AdminStandingData } from '../net/api';
import { adminFail } from './adminCopy';
import { ListState, confirmed } from './adminBits';
import {
  STANDING_MAX,
  lockRemaining,
  standingDelta,
  standingEventLabel,
  tierOf,
} from '../standing';

/**
 * ACCOUNT STANDING, as a MODERATOR edits it.
 *
 * Standing is charged entirely by a server watching sockets: a dodge, an AFK, a walk-out, a
 * brigade of reports. Every one of those is a judgement about a person made from a connection,
 * and some of them are wrong — a router died mid-match, a room crashed and billed everyone in
 * it, four friends reported someone they lost to. Until this panel the honest answer to "that
 * penalty was not mine" was a shrug, which is the single fastest way to make a behaviour
 * system feel arbitrary.
 *
 * THE COMMON CASE IS ONE BUTTON. Almost every time this panel is opened the decision is
 * already made — the penalties were wrong, clear them — so CLEAR ALL INFRACTIONS does the
 * whole thing in one press: every offence voided, the score back to full, the ranked lock
 * lifted. Building that out of three separate controls would mean every pardon is three
 * chances to leave someone half-pardoned, which in practice means locked out with a full
 * score and no idea why.
 *
 * A PARDON VOIDS RATHER THAN DELETES (migration 0036). The offence stops counting toward
 * escalation and stops costing points, and stays in the ledger struck through. Both halves
 * matter: a pardon that left the ladder intact is a pardon in name only, and one that erased
 * the row leaves the next moderator unable to see that this is the fourth.
 */
export function StandingEditor({
  userId,
  /** shown instead of the uuid while the server's own name is loading */
  handleHint,
}: {
  userId: string;
  handleHint?: string;
}) {
  const [data, setData] = useState<AdminStandingData | null>(null);
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [score, setScore] = useState('');
  const [note, setNote] = useState('');

  // a late answer for another account must not replace this one's (same guard as `AdminUser`);
  // the callers key this editor on the account, so it also remounts
  const latest = useRef(0);
  const load = (): void => {
    const mine = ++latest.current;
    void adminFetchStanding(userId).then((d) => {
      if (mine !== latest.current) return;
      setErr(d === null);
      if (d) {
        setData(d);
        setScore(String(d.standing?.score ?? STANDING_MAX));
      }
    });
  };
  useEffect(() => {
    load();
    return () => {
      latest.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const run = async (
    opts: Parameters<typeof adminEditStanding>[1],
    said: (out: { scoreBefore: number; scoreAfter: number; pardoned: number }) => string,
  ): Promise<void> => {
    setBusy(true);
    const out = await adminEditStanding(userId, { ...opts, note: note.trim() || opts.note });
    setBusy(false);
    if (!out) {
      setStatus(adminFail('update the standing'));
      return;
    }
    setStatus(said(out));
    setNote('');
    load();
  };

  if (err && !data) return <ListState error="load the standing" />;
  if (!data) return <ListState loading="Loading standing…" />;

  const current = data.standing?.score ?? STANDING_MAX;
  const tier = tierOf(current);
  const until = data.standing?.restrictedUntil ?? null;
  const locked = until !== null && until > Date.now();
  const live = data.events.filter((e) => !e.voidedAt && e.kind !== 'adjustment');
  const name = data.username ? `@${data.username}` : data.handle ?? handleHint ?? userId;
  const target = Math.max(0, Math.min(STANDING_MAX, Math.round(Number(score) || 0)));
  const scoreChanged = score.trim() !== '' && target !== current;

  return (
    <div className="adm-standing">
      <div className="as-head">
        <span className="as-name">{name}</span>
        <span className={`as-tier ${tier.key}`}>{tier.name}</span>
        <span className="as-score">
          {current}
          <em>/{STANDING_MAX}</em>
        </span>
        {locked && (
          <span className="as-lock">Ranked locked · {lockRemaining(until as number, Date.now())}</span>
        )}
      </div>
      <p className="as-blurb">{tier.blurb}</p>

      {/* the note applies to WHATEVER button is pressed next, which is why it sits above them
          rather than inside one action's form: the player reads it on the ledger row, and a
          pardon with no reason recorded is the kind that gets re-litigated in six weeks */}
      <label className="as-field">
        <span className="as-cap">Reason (recorded, and shown to the player)</span>
        <input
          type="text"
          className="ds-input"
          value={note}
          maxLength={120}
          placeholder="Why this is being changed"
          onChange={(e) => setNote(e.target.value)}
        />
      </label>

      <div className="as-actions">
        {/* DANGER, not primary: it is the most sweeping reset in the editor and there is no
            un-pardon, so it takes the irreversible style rather than the most inviting one */}
        <button
          className="ds-btn danger small"
          disabled={busy}
          onClick={() => {
            if (
              !confirmed(
                'Clear every infraction on',
                name,
                `Their standing goes back to ${STANDING_MAX}, any ranked lock is lifted, and none of it counts toward escalation again.`,
              )
            )
              return;
            void run({ pardonAll: true, score: STANDING_MAX, lock: false }, (o) =>
              `Cleared. ${o.pardoned} infraction${o.pardoned === 1 ? '' : 's'} voided, standing ${o.scoreBefore} → ${o.scoreAfter}.`,
            );
          }}
        >
          Clear all infractions
        </button>
        <button
          className="ds-btn ghost small"
          disabled={busy || !locked}
          onClick={() => void run({ lock: false }, () => 'Ranked lock lifted.')}
        >
          Lift ranked lock
        </button>
      </div>

      <div className="as-set">
        <label className="as-field">
          <span className="as-cap">Set score</span>
          <input
            type="number"
            className="ds-input"
            min={0}
            max={STANDING_MAX}
            inputMode="numeric"
            value={score}
            onChange={(e) => setScore(e.target.value)}
          />
        </label>
        <button
          className="ds-btn small"
          disabled={busy || !scoreChanged}
          onClick={() =>
            void run({ score: target }, (o) => `Standing ${o.scoreBefore} → ${o.scoreAfter}.`)
          }
        >
          Apply
        </button>
        {/* SETTING A SCORE IS NOT A PARDON, and saying so here is cheaper than a moderator
            finding out from the next escalation. The offences still count: the player gets
            their points back and the following dodge is still priced as their third. */}
        <p className="as-hint">
          Points only. The offences below keep counting toward escalation until they are
          pardoned.
        </p>
      </div>

      {status && <p className="as-status">{status}</p>}

      <h4 className="as-h4">
        Infractions
        {live.length > 0 && <span className="ds-muted"> · {live.length} still counting</span>}
      </h4>
      {data.events.length === 0 ? (
        <ListState empty="Nothing on the record" />
      ) : (
        <ul className="as-log">
          {data.events.map((e) => (
            <li key={e.id} className={e.voidedAt ? 'voided' : ''}>
              <span className="as-what">{standingEventLabel(e.kind, e.points)}</span>
              <span className="as-cost ds-muted">
                {standingDelta(e.points)}
                {e.cooldownMin > 0 && ` · ${e.cooldownMin}min lock`}
                {e.ratingCharge > 0 && ` · −${e.ratingCharge} rating`}
                {' · '}
                {new Date(e.at).toLocaleString()}
                {e.voidedAt && ' · pardoned'}
              </span>
              {e.note && <span className="as-note">{e.note}</span>}
              {/* an ADJUSTMENT is a moderator's own act, not an offence — there is nothing to
                  pardon and a button offering to would be pardoning the pardon */}
              {!e.voidedAt && e.kind !== 'adjustment' && (
                <button
                  className="ds-btn ghost small"
                  disabled={busy}
                  onClick={() =>
                    void run({ pardonIds: [e.id] }, () => 'Pardoned. It no longer escalates.')
                  }
                >
                  Pardon
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
