import { useEffect } from 'react';
import { authClient, authEnabled } from '../lib/authClient';
import { noticeView, type Notice, type NoticeView } from '../notices';
import { useDialog } from './useDialog';
import { acknowledgeNotices, ensureNotices, loadNotices, unreadNotices, useNotices } from './noticesStore';
import { currentCard, useRewards } from './rewardsStore';

/**
 * THE NOTICE POP-UP — what a moderator did, shown the next time the player is in the menus
 * (migration 0057, `src/notices.ts`).
 *
 * Riot's penalty notice and VALORANT's ranked-rollback notice both take over the client on the
 * next visit rather than waiting to be found, and that is the point of this one: a score
 * correction, a rating given back, the outcome of a report or a penalty is something the player
 * should not have to go looking for. Everything it showed stays readable afterwards in the
 * career page's Messages list (`NoticeInbox`).
 *
 * WHEN: on the menu shell only, like the reward claim dialog. `App.tsx` mounts it inside
 * `AppShell`, which a match, a lobby and the ranked screen replace, so it never appears over a
 * field. It waits for every other shell modal (`blocked`) and for the reward dialog, so two
 * backdrops are never stacked. One dialog for all unread notices, oldest first, and one button:
 * there is nothing to decide, only something to read. Escape counts as read too — the list on
 * the career page keeps every one.
 */
export function NoticeDialog({ blocked = false }: { blocked?: boolean }) {
  const session = authEnabled ? authClient!.useSession() : null;
  const userId = session?.data?.user?.id ?? null;
  const s = useNotices();
  const rewards = useRewards();

  // every mount is a return to the menus: re-read, so a notice sent while the player was in a
  // match is waiting when they come out
  useEffect(() => {
    void loadNotices(userId);
  }, [userId]);
  // and a tab left open on the menus picks one up when it is looked at again
  useEffect(() => {
    const onShow = (): void => {
      if (document.visibilityState === 'visible') ensureNotices(userId);
    };
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
  }, [userId]);

  // THE REWARD DIALOG GOES FIRST: it is mounted beside this one and loads at the same moment,
  // so this waits until it has loaded and has nothing on screen (or was put off with Esc)
  const rewardsSettled = rewards.status === 'ready' || rewards.status === 'error' || rewards.status === 'idle';
  const rewardUp = rewards.status === 'ready' && !!currentCard(rewards) && !rewards.postponed;
  const unread = unreadNotices(s).slice(0, 10);
  if (blocked || !rewardsSettled || rewardUp || s.status !== 'ready' || unread.length === 0) return null;

  return <NoticeCard notices={unread} onDone={() => void acknowledgeNotices(unread.map((n) => n.id))} />;
}

/** the dialog itself, split out so it can be drawn from fixed data */
export function NoticeCard({ notices, onDone }: { notices: Notice[]; onDone: () => void }) {
  const dialogRef = useDialog(onDone);
  const items = notices
    .map((n) => ({ n, v: noticeView(n) }))
    .filter((x): x is { n: Notice; v: NoticeView } => x.v !== null);
  if (!items.length) return null;
  const single = items.length === 1;
  const headId = `nt-h-${items[0].n.id}`;
  // WHO IS SPEAKING: a competition's notices come from its organizers and its results, not from
  // the moderators, and a pop-up holding both says neither
  const comp = items.filter(({ n }) => n.kind.startsWith('competition.')).length;
  const eyebrow = comp === 0 ? 'From the moderators' : comp === items.length ? 'Competitions' : 'Updates';

  return (
    <div className="ds-modal-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className="ds-modal nt-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headId}
        tabIndex={-1}
      >
        <span className="nt-eyebrow">{eyebrow}</span>
        <h2 className="ds-dialog-title" id={headId}>
          {single ? items[0].v.title : `${items.length} updates`}
        </h2>
        <ul className="nt-list">
          {items.map(({ n, v }) => (
            <NoticeItem key={n.id} notice={n} view={v} showTitle={!single} />
          ))}
        </ul>
        <div className="ds-dialog-actions">
          <button className="ds-btn primary" onClick={onDone}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

/** one notice: its title (when it is one of several), the match it concerns, what happened,
 *  and the moderator's own words, quoted and labelled as theirs */
export function NoticeItem({
  notice,
  view,
  showTitle = true,
  when,
}: {
  notice: Notice;
  view: NoticeView;
  showTitle?: boolean;
  /** a date line for the list on the career page; the pop-up shows only what is new */
  when?: string;
}) {
  return (
    <li className={`nt-item tone-${view.tone}${notice.readAt ? '' : ' unread'}`}>
      {/* the date it was SENT sits beside the title, apart from the match line below, which
          carries the date the match was PLAYED — one line holding both read as a typo */}
      {(showTitle || when) && (
        <div className="nt-head">
          {showTitle && <h3 className="nt-title">{view.title}</h3>}
          {when && <span className="nt-meta">{when}</span>}
        </div>
      )}
      {view.meta && <span className="nt-meta">{view.meta}</span>}
      {view.lines.map((line) => (
        <p className="nt-line" key={line}>
          {line}
        </p>
      ))}
      {notice.message && (
        <figure className="nt-msg">
          <figcaption className="nt-msg-cap">{notice.kind.startsWith('competition.') ? 'From the organizers' : 'Moderator’s note'}</figcaption>
          <blockquote className="nt-msg-text">{notice.message}</blockquote>
        </figure>
      )}
    </li>
  );
}
