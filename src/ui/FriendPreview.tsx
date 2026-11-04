import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { fetchUserStatsByUsername, type FriendRow, type PublicProfile, type UserStats } from '../net/api';
import type { GameId } from '../games/types';
import { playtimeText } from '../playtime';
import { seasonFor } from '../seasons';
import { BadgeMarks } from './BadgeMark';
import { SupporterBadge } from './SupporterBadge';
import { useDialog } from './useDialog';

/** what a friend is doing, already spelled out by the panel: the dot is a second cue, never the only one */
export interface PreviewPresence {
  line: string;
  dot: 'online' | 'busy' | 'dnd' | null;
}

/** the gap between the card and the sheet or the window edge */
const EDGE = 8;

/** first two characters of the display name, as `ProfileMenu`'s avatar glyph (no photos exist) */
const initialsOf = (name: string): string => (name.trim() ? name.trim().slice(0, 2).toUpperCase() : '?');

type Load = { status: 'loading' } | { status: 'ok'; stats: UserStats } | { status: 'error' };

/**
 * THE PROFILE PREVIEW a press on a friends-panel row opens: who they are, what they are doing, their
 * rating and a few headline numbers, and the way to the full profile. It reads the same public stats
 * the profile page does (`fetchUserStatsByUsername`), so there is no endpoint of its own.
 *
 * A DESKTOP POPOVER BESIDE THE SHEET, a bottom sheet under 720px (the sheet is nearly the whole width
 * there, so there is no beside). Either way it is a dialog (`useDialog`): focus moves in, Tab stays in,
 * Esc closes it alone (the sheet's own Esc yields to a consumed one), and focus goes back to the row.
 * An outside press closes it too; a press on a row's name is left to that row, which switches to it
 * or, on the same row, closes.
 *
 * The tiles show a dash while loading and for a player with no games, so the card is one height in
 * every state and never jumps when the numbers land (docs/ui-standard.md, list states).
 */
export function FriendPreview({
  person,
  presence,
  game,
  anchor,
  onClose,
  onOpenProfile,
}: {
  person: PublicProfile | FriendRow;
  presence: PreviewPresence | null;
  /** whose stats: the viewer's selected game */
  game: GameId;
  /** the pressed `.fr-who`, which the card sits beside */
  anchor: HTMLElement;
  /** `outside` is the element an outside press landed on, so the panel can tell a press on its own scrim */
  onClose: (outside?: Element) => void;
  /** absent while leaving this screen would abandon a live room: the card then has no profile link */
  onOpenProfile?: (username: string) => void;
}) {
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const card = useDialog<HTMLDivElement>(() => closeRef.current());
  const username = person.username;
  const [load, setLoad] = useState<Load>({ status: 'loading' });

  // The one primary action takes focus: Enter on a row and Enter again is the profile. An effect
  // after `useDialog`'s rather than `autoFocus`: switching from another row unmounts that card
  // after this one mounts, and its focus-return would take an autoFocus away.
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => primary.current?.focus(), []);

  useEffect(() => {
    if (!username) return;
    let alive = true;
    setLoad({ status: 'loading' });
    fetchUserStatsByUsername(username, undefined, game)
      .then((stats) => alive && setLoad({ status: 'ok', stats }))
      .catch(() => alive && setLoad({ status: 'error' }));
    return () => {
      alive = false;
    };
  }, [username, game]);

  // BESIDE THE ROW'S SHEET, clamped to the window. A poll can move the row between sections, which
  // replaces its button, so the live one is looked up by user id rather than trusting `anchor`.
  useLayoutEffect(() => {
    const place = (): void => {
      const el = card.current;
      if (!el) return;
      const sheet = anchor.closest('.ds-friends-overlay') ?? document.querySelector('.ds-friends-overlay');
      const row = anchor.isConnected
        ? anchor
        : (sheet?.querySelector<HTMLElement>(`.fr-who[data-uid="${CSS.escape(person.userId)}"]`) ?? anchor);
      const top = row.getBoundingClientRect().top - EDGE;
      const room = window.innerHeight - el.offsetHeight - EDGE;
      el.style.setProperty('--fr-pv-top', `${Math.round(Math.min(Math.max(top, EDGE), Math.max(room, EDGE)))}px`);
      el.style.setProperty(
        '--fr-pv-right',
        `${Math.round(window.innerWidth - (sheet?.getBoundingClientRect().left ?? window.innerWidth) + EDGE)}px`,
      );
    };
    place();
    window.addEventListener('resize', place);
    // capture: the sheet scrolls, not the window, and scroll does not bubble
    document.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
    };
  }, [anchor, card, person.userId, load]);

  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      const t = e.target instanceof Element ? e.target : null;
      if (!t || card.current?.contains(t) || t.closest('.fr-who')) return;
      closeRef.current(t);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [card]);

  const stats = load.status === 'ok' ? load.stats : null;
  const elo1 = stats?.elo.find((e) => e.mode === '1v1');
  const elo2 = stats?.elo.find((e) => e.mode === '2v2');
  const played = stats?.match.played ?? 0;
  // the career panel's words: no rating at all is Unplaced, a rating with no rank yet is Unranked
  const rank = (e: UserStats['elo'][number] | undefined): string =>
    !e ? 'Unplaced' : e.rank ? `Rank #${e.rank}` : 'Unranked';
  // a sub-line that is empty still holds its line, so the tiles keep one height
  const sub = (s: string | null | undefined): string => s || ' ';
  const handle = person.handle ?? (username ? `@${username}` : 'Player');

  return (
    <div
      ref={card}
      className="fr-pv"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-busy={load.status === 'loading'}
      tabIndex={-1}
    >
      <div className="fr-pv-head">
        <span className="ds-avatar md" aria-hidden="true">
          {initialsOf(handle.replace(/^@/, ''))}
        </span>
        <div className="fr-pv-who">
          {/* the badge and the title are SIBLINGS of the name, which ellipsises (see `.fr-nameline`) */}
          <div className="fr-nameline">
            <h3 id={titleId} className="fr-pv-name">
              {handle}
            </h3>
            <SupporterBadge supporter={person.supporter} role={person.role} />
            <BadgeMarks badges={person.badges} />
          </div>
          <span className="fr-sub">{username ? `@${username}` : ''}</span>
        </div>
      </div>

      {presence && (
        <p className="fr-pv-presence">
          {presence.dot && <span className={`fr-dot${presence.dot === 'online' ? '' : ` ${presence.dot}`}`} aria-hidden />}
          {presence.line}
        </p>
      )}

      <div className="fr-pv-body" role="group" aria-label="Stats">
        <p className="fr-pv-cap" role="status">
          {load.status === 'error' ? 'Stats unavailable' : `${seasonFor(game).name} · current period`}
        </p>
        <div className="ds-stats">
          <div className="ds-stat">
            <span className="sv">{elo1 ? elo1.rating : '—'}</span>
            <span className="sl">1v1 rating</span>
            <span className="sl">{sub(stats && rank(elo1))}</span>
          </div>
          <div className="ds-stat">
            <span className="sv">{elo2 ? elo2.rating : '—'}</span>
            <span className="sl">2v2 rating</span>
            <span className="sl">{sub(stats && rank(elo2))}</span>
          </div>
          <div className="ds-stat">
            <span className="sv">{stats && played > 0 ? `${stats.match.wins}–${stats.match.losses}` : '—'}</span>
            <span className="sl">Ranked W–L</span>
            <span className="sl">{sub(stats && played > 0 ? `${Math.round((stats.match.wins / played) * 100)}% win` : null)}</span>
          </div>
          {/* absent on a server older than the tracker: no tile rather than a zero */}
          {(stats?.activity || load.status !== 'ok') && (
            <div className="ds-stat">
              <span className="sv">{stats?.activity?.games ? playtimeText(stats.activity.seconds) : '—'}</span>
              <span className="sl">Playtime</span>
              <span className="sl">{sub(stats?.activity?.games ? `${stats.activity.games} games` : null)}</span>
            </div>
          )}
        </div>
      </div>

      <div className="fr-pv-foot">
        <button className="ds-btn small ghost" onClick={() => onClose()}>
          Close
        </button>
        {onOpenProfile && username && (
          <button ref={primary} className="ds-btn small primary" onClick={() => onOpenProfile(username)}>
            View profile
          </button>
        )}
      </div>
    </div>
  );
}
