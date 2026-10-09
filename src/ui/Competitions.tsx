/**
 * COMPETITIONS — the lazy chunk's entry (0059, `docs/area/competitions.md`).
 *
 * `App.tsx` `React.lazy`s this module, so the pages, their sheet and the competition client never
 * reach the bundle a player downloads to drive a robot; the call bar (`CompCallBar.tsx`) is the
 * one competition surface in the main chunk.
 *
 * ROUTES, under the game prefix like every screen (`/decode/competitions/…`):
 *   /competitions                  the list
 *   /competitions/new              create (staff today, `mayCreate` on the server)
 *   /competitions/<slug>[/<tab>]   one competition, a tab of it
 *   /competitions/<slug>/edit      its editor
 *   /competitions/<slug>/play      joining its called match (a FULL-SCREEN route; App renders
 *                                  it outside the shell, like the ranked screen)
 */
import './competitions.css';
import type { GameId } from '../games/types';
import { CompList } from './CompList';
import { CompDetail, COMP_TABS, type CompTab } from './CompDetail';
import { CompEditor } from './CompEditor';

export { CompMatchPlay } from './CompMatchPlay';

export function Competitions({
  sub,
  game,
  signedIn,
  onRoute,
  onPlay,
  onWatch,
  onWatchReplay,
  onProfile,
  onSignIn,
}: {
  /** the part of the path after `/competitions/`, or null for the list */
  sub: string | null;
  game: GameId;
  signedIn: boolean;
  onRoute: (sub: string | null) => void;
  onPlay: (slug: string) => void;
  onWatch: (room: string, region?: string) => void;
  onWatchReplay: (replayId: string) => void;
  onProfile: (username: string) => void;
  onSignIn: () => void;
}) {
  const [slug, rest] = (sub ?? '').split('/');
  if (!slug) return <CompList signedIn={signedIn} onOpen={(s) => onRoute(s)} onCreate={() => onRoute('new')} />;
  if (slug === 'new') return <CompEditor slug={null} game={game} onDone={(s) => onRoute(s)} onCancel={() => onRoute(null)} />;
  if (rest === 'edit') return <CompEditor slug={slug} game={game} onDone={(s) => onRoute(`${s}/manage`)} onCancel={() => onRoute(`${slug}/manage`)} />;
  const tab: CompTab = COMP_TABS.includes(rest as CompTab) ? (rest as CompTab) : 'overview';
  return (
    <CompDetail
      // a different competition is a different page: no state carries over
      key={slug}
      slug={slug}
      tab={tab}
      onTab={(t) => onRoute(t === 'overview' ? slug : `${slug}/${t}`)}
      onBack={() => onRoute(null)}
      onPlay={onPlay}
      onWatch={onWatch}
      onWatchReplay={onWatchReplay}
      onProfile={onProfile}
      onEdit={() => onRoute(`${slug}/edit`)}
      onSignIn={onSignIn}
      onGone={() => onRoute(null)}
    />
  );
}

export default Competitions;
