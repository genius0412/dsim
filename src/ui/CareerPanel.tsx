import { type ReactNode } from 'react';
import { AwardList } from './AwardList';
import { compareAwards } from '../awards';
import { type UserStats } from '../net/api';
import { SupporterBadge } from './SupporterBadge';
import { BadgeMarks } from './BadgeMark';
import { averageMatch, playtimeLong, playtimeText } from '../playtime';

/**
 * The competitive-stats panel shared by "My Stats" (own account) and the public
 * `/profile/<username>` page: overall 1v1/2v2 rating + rank, solo/duo record bests +
 * rank, ranked W–L, and recent match history. Purely presentational — the caller
 * (a `CareerView`) fetches the `UserStats` for the selected period and prints the
 * period heading above it. `name` is the chip shown in the panel header;
 * `archived` marks a PAST period, whose numbers are that season's FINAL standings.
 */
export function CareerPanel({
  stats,
  status,
  error,
  name,
  archived,
  headerAction,
}: {
  stats: UserStats | null;
  status: 'loading' | 'ok' | 'error';
  error?: string;
  name: string;
  /** true when viewing a past period ⇒ these are the season's final stats */
  archived?: boolean;
  /** optional control rendered in the panel header (e.g. a Share button) */
  headerAction?: ReactNode;
}) {
  const elo1 = stats?.elo.find((e) => e.mode === '1v1');
  const elo2 = stats?.elo.find((e) => e.mode === '2v2');
  const solo = stats?.records.find((r) => r.mode === 'solo');
  const duo = stats?.records.find((r) => r.mode === 'duo');
  const rankTag = (rank: number | null): string => (rank ? `Rank #${rank}` : 'Unranked');
  /* NO GAMES, NO NUMBERS (design review 07-06). The season tiles used to render "1000 · 1V1
     ELO" and "0–0" right above the empty state saying there was nothing — the 1000 is the
     server's starting value, not a rating the player holds. Empty ⇒ the empty state INSTEAD
     of the tiles; otherwise an absent mode reads "—" / "Unplaced", never 1000. */
  const empty = !!stats && stats.match.played === 0 && solo?.best == null && duo?.best == null;
  const winPct =
    stats && stats.match.played > 0 ? Math.round((stats.match.wins / stats.match.played) * 100) : null;

  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        {/* the period is the h2 above; FINAL was printed twice here (07-08) */}
        <span className="ds-panel-title">{archived ? 'Final standings' : 'Overall'}</span>
        <span className="ds-head-spacer" />
        {/* the name chip is the ONLY place "My Stats" prints who you are — the
            public profile has a header for it, Career does not — so this is where
            a player sees their own badge. `stats` may still be loading; the badge
            simply appears with the rest. */}
        <span className="ds-chip">
          <b>{name}</b>
          <SupporterBadge supporter={stats?.supporter} role={stats?.role} />
          {/* and the equipped title, for the same reason: this chip is the whole of "who
              you are" on this screen, and a title that shows on the board but not here
              reads as having been lost. */}
          <BadgeMarks badges={stats?.badges} />
        </span>
        {headerAction}
      </div>

      {status === 'loading' && <div className="ds-loading">Loading…</div>}
      {status === 'error' && (
        /* never `{error}` as the body: the raw text ("Failed to fetch", "HTTP 502") is not a
           step a player can take (design review 07-04 / 19-03). It stays in the tooltip for
           whoever is debugging. */
        <div className="ds-empty" title={error}>
          <div className="big">Couldn’t load career stats</div>
          Check your connection and reload the page.
        </div>
      )}

      {status === 'ok' && stats && (!empty || stats.activity || (stats.awards?.length ?? 0) > 0) && (
        <div className="ds-panel-body stack">
          {/* PLAYTIME + GAMES PLAYED. Lifetime, not season-scoped like the tiles below —
              "how much have I played" is a question about the account, and an answer that
              reset every season would be meaningless exactly when it got interesting. Hidden
              entirely on a server that doesn't track it yet, rather than printing zeros. */}
          {stats.activity && (
            <div className="ds-stats">
              <div className="ds-stat">
                <span className="sv">{stats.activity.games}</span>
                <span className="sl">Games played</span>
                <span className="sl" title={playtimeLong({ games: stats.activity.allGames, seconds: stats.activity.allSeconds })}>
                  {stats.activity.allGames !== stats.activity.games
                    ? `${stats.activity.allGames} across all games`
                    : 'all time'}
                </span>
              </div>
              <div className="ds-stat">
                <span className="sv">{playtimeText(stats.activity.seconds)}</span>
                <span className="sl">Playtime</span>
                <span className="sl">
                  {stats.activity.games > 0
                    ? `~${playtimeText(averageMatch({ games: stats.activity.games, seconds: stats.activity.seconds }))} a match`
                    : ''}
                </span>
              </div>
            </div>
          )}
          {/* THE TROPHY CASE. Account-wide, not season-scoped like the tiles below, for
              the same reason playtime above is: an award that vanished when a new season
              opened would be the one thing an award must never do. `AwardList` renders
              NOTHING when the account has none — this panel already has an empty state and
              a second "no awards yet" under it would be the panel saying it twice. */}
          {stats.awards && stats.awards.length > 0 && (
            <div className="ds-field">
              <span className="cap">Awards</span>
              <AwardList awards={[...stats.awards].sort(compareAwards)} />
            </div>
          )}
          {!empty && (
          <div className="ds-stats">
            <div className="ds-stat">
              <span className="sv">{elo1 ? elo1.rating : '—'}</span>
              <span className="sl">1v1 rating</span>
              <span className="sl">{elo1 ? `${rankTag(elo1.rank)} · ${elo1.games} games` : 'Unplaced'}</span>
            </div>
            <div className="ds-stat">
              <span className="sv">{elo2 ? elo2.rating : '—'}</span>
              <span className="sl">2v2 rating</span>
              <span className="sl">{elo2 ? `${rankTag(elo2.rank)} · ${elo2.games} games` : 'Unplaced'}</span>
            </div>
            <div className="ds-stat">
              <span className="sv">{solo?.best ?? '—'}</span>
              <span className="sl">Solo best</span>
              <span className="sl">{rankTag(solo?.rank ?? null)}</span>
            </div>
            <div className="ds-stat">
              <span className="sv">{duo?.best ?? '—'}</span>
              <span className="sl">Duo best</span>
              <span className="sl">{rankTag(duo?.rank ?? null)}</span>
            </div>
            <div className="ds-stat">
              <span className="sv">
                {stats.match.wins}–{stats.match.losses}
              </span>
              <span className="sl">Ranked W–L</span>
              <span className="sl">{winPct != null ? `${winPct}% win` : ''}</span>
            </div>
          </div>
          )}
        </div>
      )}

      {/* the panel's EMPTY state, in the same anatomy as the five other lists on
          these screens (`.ds-empty` + a `.big` headline) rather than as a stray
          hint paragraph. A sibling of the body, not a child of it, so it is inset
          by its own padding instead of by the body's as well. */}
      {status === 'ok' && empty && (
        <div className="ds-empty">
          <div className="big">
            {archived ? 'No games were played this period' : 'No games played yet this period'}
          </div>
        </div>
      )}
    </div>
  );
}
