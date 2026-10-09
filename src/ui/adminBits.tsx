import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ADMIN_FAIL_WHY } from './adminCopy';
import { saveBlob } from './saveBlob';

/**
 * The small pieces every admin panel needs, written once.
 *
 * There were four copies of "poll this endpoint every N seconds", three of "how long ago was
 * this", and no way at all to get a uuid out of the console and into a message to somebody —
 * which is the single most common thing anybody does here, because every id in this app is a
 * uuid and none of them can be retyped.
 *
 * A LEAF module, for the reason `adminCopy.ts` is one: `Admin.tsx` imports every other panel,
 * so anything shared between them has to live below all of them or the imports cycle.
 */

// ---------------------------------------------------------------- polling ----

/**
 * Poll `load` every `ms`, AND STOP WHILE THE TAB IS HIDDEN.
 *
 * The console polled presence at 5s, maintenance at 5s and finished matches at 30s, on
 * `setInterval`, forever — including while the tab sat behind somebody's editor for an
 * afternoon. Each of those is a database round trip on a machine that bills for being awake
 * and AUTO-STOPS when idle, so an admin tab left open was, by itself, enough to keep the
 * game server from ever going to sleep. That is the actual cost, not the query.
 *
 * Hiding the tab pauses it; showing it again RELOADS IMMEDIATELY rather than waiting out the
 * interval, because the first thing you do on coming back is look at the numbers, and stale
 * ones that silently refresh a few seconds later are worse than a moment's loading.
 *
 * `load` is called through a ref, so a caller may pass an inline closure without restarting
 * the timer on every render — the trap that makes a naive version of this hook re-poll on
 * each keystroke in a filter box.
 */
export function usePolled<T>(
  load: () => Promise<T | null>,
  ms: number,
): { data: T | null; err: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState(false);
  const fn = useRef(load);
  fn.current = load;

  const alive = useRef(true);
  const run = useCallback(() => {
    void fn.current().then((d) => {
      if (!alive.current) return;
      setErr(d === null);
      // a failed poll keeps the LAST GOOD data on screen rather than blanking the panel:
      // one dropped request in a five-second loop is not an outage, and a table that
      // vanishes and comes back reads as one.
      if (d !== null) setData(d);
    });
  }, []);

  useEffect(() => {
    alive.current = true;
    run();
    let t = 0;
    const start = (): void => {
      window.clearInterval(t);
      t = window.setInterval(run, ms);
    };
    const onVis = (): void => {
      if (document.visibilityState === 'hidden') window.clearInterval(t);
      else {
        run();
        start();
      }
    };
    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive.current = false;
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [ms, run]);

  return { data, err, reload: run };
}

// ------------------------------------------------------------------ time ----

/** coarse "how long ago" — an operator wants recency, not a timestamp */
export function ago(iso: string | number | null | undefined): string {
  if (!iso) return '—';
  const t = typeof iso === 'number' ? iso : new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 2_592_000) return `${Math.floor(s / 86_400)}d ago`;
  return new Date(t).toLocaleDateString();
}

/**
 * RELATIVE ON THE PAGE, ABSOLUTE IN THE TOOLTIP — both, always.
 *
 * "3d ago" is what you read a queue with; "2026-09-16 14:02" is what you put in a message to
 * somebody, or line up against a deploy. The console had one or the other per surface and
 * they disagreed about which, so half of it could not answer either question.
 */
export function When({ at }: { at: string | number | null | undefined }) {
  if (!at) return <span className="ds-muted">—</span>;
  const t = typeof at === 'number' ? at : new Date(at).getTime();
  return (
    <time className="ds-muted" dateTime={Number.isFinite(t) ? new Date(t).toISOString() : undefined} title={Number.isFinite(t) ? new Date(t).toLocaleString() : undefined}>
      {ago(at)}
    </time>
  );
}

// -------------------------------------------------------------------- ids ----

/** enough of an id to tell two rows apart without printing a whole uuid */
export function shortId(id: string, keep = 8): string {
  return id.length > keep + 2 ? `${id.slice(0, keep)}…` : id;
}

/**
 * A copyable id.
 *
 * Every subject in this console is a uuid — an account, a match, a replay, a record — and
 * the only thing anyone ever does with one is paste it somewhere else. Selecting it out of a
 * table by hand is error-prone in a way that matters: half a uuid looks like a whole one.
 *
 * The button reports success in its own label for a second rather than through a toast,
 * because the HUD rules ban popups and a control that says nothing leaves you pressing it
 * twice. The label swap must not resize the button (§1.4), which `min-width` on the class
 * takes care of.
 */
export function CopyId({ id, label }: { id: string; label?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(false), 1200);
    return () => window.clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      className="adm-copy"
      title={`Copy ${label ?? 'id'}: ${id}`}
      aria-label={`Copy ${label ?? 'id'}`}
      onClick={() => {
        // `navigator.clipboard` is undefined on a non-secure origin (a LAN host reached by
        // ip, which is exactly how somebody runs this at an event), so the failure is
        // swallowed and the button simply does not confirm.
        void navigator.clipboard?.writeText(id).then(() => setDone(true)).catch(() => {});
      }}
    >
      {done ? 'copied' : 'copy'}
    </button>
  );
}

/**
 * WHO AN ACCOUNT IS, INCLUDING WHEN THE ANSWER IS "WE DO NOT KNOW YET".
 *
 * ⚠️ THIS IS THE "(no profile)" FIX, and it is one function so the answer cannot differ
 * between the four places a name appears. A signed-in session with no display name is not
 * one situation, it is three, and the console printed all of them as "(no profile)":
 *
 *  - `known: false` — there really is no `profiles` row. That is NORMAL for a few seconds
 *    after a first sign-in (the row is created by `ensureProfile` on the API routes a client
 *    hits, not when its socket authenticates), and it is the one case where the account id
 *    is the only identity there is. It says so, and prints the id.
 *  - a row with a handle and no `username` — they have never been through the username gate.
 *    Their display name is perfectly good and goes on the row; the missing @ is a footnote.
 *  - `known` absent entirely — an older server that does not send the field. Then a missing
 *    handle means "not looked up", which is not something to assert anything about.
 *
 * ⚠️ `username` HAS THE SAME THREE STATES AS `handle`, AND MISSING ONE OF THEM IS THE SAME BUG
 * ONE LEVEL DOWN. `null` is "this account has never claimed one" and is worth saying;
 * `undefined` is "the row this came from does not carry the column", which is not. They were
 * both rendered as "no username yet", so the Moderation tab's record list — whose rows are
 * `AdminRecordRow`, which projects a handle and no username — printed it beside every name on
 * the board, including accounts whose username is on the public leaderboard two clicks away.
 * A label that is FALSE for most of the rows it appears on is worse than no label.
 */
export function AccountName({
  userId,
  handle,
  username,
  known,
  role,
  onOpen,
}: {
  userId: string;
  handle?: string | null;
  username?: string | null;
  known?: boolean;
  role?: 'owner' | 'admin' | null;
  /** open the user detail panel; omitted where there is nowhere to open it */
  onOpen?: (userId: string) => void;
}) {
  const name = handle?.trim() || null;
  const body = name ? (
    <>
      <span className="adm-name">{name}</span>
      {username ? (
        <span className="ds-muted"> @{username}</span>
      ) : username === null ? (
        <span className="adm-nouser" title="This account has never claimed a username">
          no username yet
        </span>
      ) : null}
    </>
  ) : known === false ? (
    <>
      <code className="adm-guest-id">{shortId(userId, 12)}</code>
      <span className="adm-nouser" title="Signed in, but no profile row exists for this account yet">
        no profile yet
      </span>
    </>
  ) : (
    <code className="adm-guest-id">{shortId(userId, 12)}</code>
  );
  return (
    <span className="adm-who">
      {onOpen ? (
        <button type="button" className="adm-wholink" onClick={() => onOpen(userId)}>
          {body}
        </button>
      ) : (
        body
      )}
      {role && <span className={`ds-badge ${role === 'owner' ? 'accent' : 'staff'}`}>{role === 'owner' ? 'owner' : 'admin'}</span>}
      <CopyId id={userId} label="account id" />
    </span>
  );
}

// ------------------------------------------------------------------- csv ----

/**
 * Hand the browser a CSV of whatever list is on screen.
 *
 * The console can show a queue; it could not get one OUT, and "paste me the list" is half of
 * what moderation coordination actually is. Written here rather than per panel because the
 * escaping is the only hard part and it is the same escaping every time: a field is quoted
 * and its own quotes doubled, unconditionally, so a display name containing a comma, a quote
 * or a newline cannot shift every column after it.
 */
export function downloadCsv(filename: string, headers: string[], rows: (string | number | null | undefined)[][]): void {
  const cell = (v: string | number | null | undefined): string =>
    `"${String(v ?? '').replace(/"/g, '""')}"`;
  const body = [headers.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))].join('\r\n');
  // BOM: Excel reads a CSV as the system codepage without one, and every non-ASCII display
  // name in the file comes out mojibake.
  saveBlob(new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8' }), filename);
}

// ------------------------------------------------------------ list states ----

/**
 * The three non-populated states of a list (§6), ONE way.
 *
 * The presence error was a full `ds-empty` block and the Recent-games error a screen lower was
 * a one-line hint in different words; every "no rows" was a bare `ds-hint`. All three states
 * here share `.ds-empty`/`.ds-loading`'s padding, so a panel does not jump when data lands.
 *
 *  - `loading` — the line to show while the first read is in flight.
 *  - `error`   — the action that failed (`load the audit log`); the wording is `adminFail`'s.
 *  - `empty`   — the headline, no period; `children` is the one sentence under it.
 */
export function ListState({
  loading,
  error,
  empty,
  children,
}: {
  loading?: string;
  error?: string;
  empty?: string;
  children?: ReactNode;
}) {
  if (loading) return <div className="ds-loading">{loading}</div>;
  return (
    <div className="ds-empty">
      <div className="big">{error ? `Couldn’t ${error}` : empty}</div>
      {error ? ADMIN_FAIL_WHY : children}
    </div>
  );
}

// --------------------------------------------------------------- dialogs ----

/**
 * A destructive confirmation that NAMES ITS TARGET (§6).
 *
 * `window.confirm` with the target spelled into the sentence, which is what the console
 * already does everywhere and is genuinely the right control for this: it is modal, it is
 * keyboard-dismissable, and it cannot be mis-styled into looking non-destructive. What was
 * missing is that half the call sites did not name what they were about to act on.
 */
export function confirmed(action: string, target: string, consequence: string): boolean {
  return window.confirm(`${action} ${target}?\n\n${consequence}`);
}
