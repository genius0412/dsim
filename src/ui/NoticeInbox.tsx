import { useEffect, useState } from 'react';
import { authClient, authEnabled } from '../lib/authClient';
import { fetchFiledReports } from '../net/api';
import { filedStatus, filedWhat, noticeView, type FiledReport } from '../notices';
import { NoticeItem } from './NoticeDialog';
import { acknowledgeNotices, ensureNotices, useNotices } from './noticesStore';

/**
 * MESSAGES and YOUR REPORTS — the career page's record of what moderators did (0057).
 *
 * Two lists, after the two things other games give a player here. MESSAGES is every notice
 * the pop-up showed, kept so it can be read again (Riot shows a penalty notice on every login
 * while it lasts; a list is the calmer form of the same promise). YOUR REPORTS is Epic's "My
 * reports": each report the player filed and where it is — waiting, action taken, no action —
 * so a report that has not been looked at yet reads as waiting rather than as ignored.
 *
 * SELF-ONLY, like `StandingCard` beside it: it hangs off the player's own career screen, never
 * the shared panel that also renders public profiles. And like it, it renders NOTHING when
 * there is nothing to say: most players never report anyone or hear from a moderator.
 */
export function NoticeInbox() {
  const session = authEnabled ? authClient!.useSession() : null;
  const userId = session?.data?.user?.id ?? null;
  const s = useNotices();
  const [filed, setFiled] = useState<FiledReport[]>([]);

  useEffect(() => {
    ensureNotices(userId);
    if (!userId) return;
    let dead = false;
    fetchFiledReports()
      .then((r) => {
        if (!dead) setFiled(r);
      })
      .catch((e) => console.warn('[notices] filed reports failed:', e));
    return () => {
      dead = true;
    };
  }, [userId]);

  const shown = s.notices
    .map((n) => ({ n, v: noticeView(n) }))
    .filter((x) => x.v !== null)
    .slice(0, 12);
  const unread = shown.filter((x) => !x.n.readAt).map((x) => x.n.id);
  if (!userId || (shown.length === 0 && filed.length === 0)) return null;

  return (
    <div className="ds-panel nt-inbox">
      {shown.length > 0 && (
        <>
          <div className="ds-panel-h">
            <span className="ds-panel-title">Messages</span>
            {unread.length > 0 && (
              <button className="ds-btn ghost small" onClick={() => void acknowledgeNotices(unread)}>
                Mark all read
              </button>
            )}
          </div>
          <ul className="nt-list ds-panel-body">
            {shown.map(({ n, v }) => (
              <NoticeItem key={n.id} notice={n} view={v!} when={fmtDay(n.createdAt)} />
            ))}
          </ul>
        </>
      )}
      {filed.length > 0 && (
        <>
          <div className="ds-panel-h">
            <span className="ds-panel-title">Your reports</span>
          </div>
          <ul className="nt-filed ds-panel-body">
            {filed.map((r) => {
              const st = filedStatus(r);
              return (
                <li key={`${r.kind}-${r.id}`} className="nt-filed-row">
                  <span className="nt-filed-what">{filedWhat(r)}</span>
                  <span className="nt-meta">{fmtDay(r.createdAt)}</span>
                  <span className={`ds-badge ${BADGE_TONE[st.tone] ?? ''}`}>{st.label}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

/** a status's tone as the house badge tones (`.ds-badge.ok|accent|danger`); "no action" is plain */
const BADGE_TONE: Record<string, string> = { good: 'ok', bad: 'danger', open: 'accent' };

function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
