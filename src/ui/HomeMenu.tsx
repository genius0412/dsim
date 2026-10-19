import { useEffect, useId, useState, type ReactNode } from 'react';
import type { GameSettings } from '../game';
import type { GameId } from '../types';
import { APP_NAME, LINKS, seasonFor } from '../seasons';
import { visibleGames } from '../seasonVisibility';
import { fetchGlobalStats, type GlobalStats } from '../net/api';
import { railItems } from './NavRail';
import { QueueCounts } from './QueueCounts';
import { SponsorPresents } from './Sponsor';
import { FootBody, type ShellNav } from './AppShell';
import { discordAvatarUrl, discordDisplayName, inDiscordActivity, type DiscordParticipant } from '../net/discordActivity';
import { Logo } from './Logo';
import { useDialog } from './useDialog';

/**
 * The main menu: ONE LEFT COLUMN over the menu stage (`MenuStage.tsx`, owner 2026-10-18, after
 * MoSim's home) — the wordmark, the sponsor, the game switcher, the keycaps, the social pills and
 * the site stats, top to bottom, with the field to the right. The keycaps read from `RAIL_ITEMS`.
 * The first-run tutorial offer and the "Rejoin match" banner are on the Play page (owner,
 * 2026-10-18), floating over the robot.
 *
 * It is also the site's landing page — a first-time visitor and a crawler both
 * arrive here with no other context — so the season, the app name, the
 * presenting sponsor and the game switcher have to carry that on their own.
 * The `<meta name="description">` (`src/seo.ts`, `APP_BLURB`) is what a search
 * result or a pasted link shows instead of a lead sentence on the page itself.
 */
export function HomeMenu({
  settings,
  multiplayer,
  discord,
  onNav,
  onGame,
  stage = false,
}: {
  settings: GameSettings;
  /**
   * OVER THE MENU STAGE (desktop): the left column, the logo in the wordmark, the pills under the
   * keycaps. Off it (a phone) this is the pre-stage Home as it was on alpha (owner, 2026-10-18:
   * "restore that page, only that page, to the original one"): no logo, the pills above the keycaps.
   */
  stage?: boolean;
  /** the game server is configured — gates the live player counters */
  multiplayer: boolean;
  /** running as a Discord Activity: the shared-lobby join button (top-left) with
   * the activity's current participants (empty until the SDK reports them) */
  discord: { people: DiscordParticipant[]; onJoin: () => void } | null;
  onNav: (n: ShellNav) => void;
  /** switch the selected game (DECODE / Chain Reaction) */
  onGame: (g: GameId) => void;
}) {
  // only the games whose modules are registered AND whose season is visible on
  // this release channel are selectable; the switcher hides itself until there are
  // ≥2 to choose between.
  const games = visibleGames();

  // site-wide counters (players + games played), when the server is configured
  const [stats, setStats] = useState<GlobalStats | null>(null);
  useEffect(() => {
    if (!multiplayer) return;
    let alive = true;
    fetchGlobalStats()
      .then((s) => alive && setStats(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [multiplayer]);

  // the labelled social pills: UNDER the keycaps on the stage (owner, 2026-10-18), between the game
  // switcher and the keycaps off it (alpha's order, owner 2026-09-23)
  const links = (
    <div className="ds-home-links">
      <a className="ds-home-link" href={LINKS.discord} target="_blank" rel="noreferrer">
        <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="currentColor">
          <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
        </svg>
        <span className="hl">Discord</span>
      </a>
      <a className="ds-home-link" href={LINKS.instagram} target="_blank" rel="noreferrer">
        <svg
          viewBox="0 0 24 24"
          width="17"
          height="17"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" />
          <circle cx="12" cy="12" r="4.25" />
          <circle cx="17.6" cy="6.4" r="1.1" fill="currentColor" stroke="none" />
        </svg>
        <span className="hl">Instagram</span>
      </a>
      <a className="ds-home-link" href={LINKS.repo} target="_blank" rel="noreferrer">
        <svg viewBox="0 0 16 16" width="17" height="17" aria-hidden="true" fill="currentColor">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
        </svg>
        <span className="hl">GitHub</span>
      </a>
    </div>
  );

  // two lines: the runs with no opponent, then the versus formats. Sentence case, digits in the
  // mono utility (01-21). In the column on the stage; in the "More" sheet on a phone.
  const breakdown = stats && (
    <div className="ds-homestats-break">
      {(
        [
          [
            ['Solo', stats.byCategory.solo],
            ['Duo', stats.byCategory.duo],
          ],
          [
            ['1v1', stats.byCategory['1v1']],
            ['2v2', stats.byCategory['2v2']],
            // custom rooms + Discord rooms + LAN; absent from an older server
            ...(stats.byCategory.custom != null ? [['Custom', stats.byCategory.custom]] : []),
          ],
        ] as [string, number][][]
      ).map((line, i) => (
        <span key={i} className="hb-line">
          {line.map(([label, n]) => (
            <span key={label}>
              {label} <span className="ds-num">{n.toLocaleString()}</span>
            </span>
          ))}
        </span>
      ))}
    </div>
  );

  return (
    <div className="ds-home">
      {/* the scrim the column reads on: dark to clear, left to right, so the field stays clear */}
      {stage && <div className="ds-home-scrim" aria-hidden="true" />}
      {discord && (
        <button
          className="ds-discord-join"
          onClick={discord.onJoin}
          title={
            discord.people.length
              ? `In this activity: ${discord.people.map(discordDisplayName).join(', ')}`
              : 'Everyone in this activity lands in the same lobby'
          }
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">
            <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
          </svg>
          <span className="dj-label">Join Discord Lobby</span>
          {discord.people.length > 0 && (
            <span className="dj-avs" aria-hidden="true">
              {discord.people.slice(0, 4).map((p) => (
                <img
                  key={p.id}
                  className="dj-av"
                  src={discordAvatarUrl(p)}
                  alt=""
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              ))}
              {discord.people.length > 4 && <span className="dj-more">+{discord.people.length - 4}</span>}
            </span>
          )}
        </button>
      )}
      <h1 className="ds-home-title">
        {stage && <Logo size={52} />}
        {APP_NAME}
      </h1>

      {/* The APP's presenting sponsor, directly under the app's name. The SEASON
          also has its own presenter (RTX presents BIOBUZZ; that is FIRST's, not
          ours to sell) — this mark is the app's own and a different fact. */}
      <SponsorPresents />

      {games.length > 1 && (
        // Toggle buttons, not a tablist: there is no tabpanel, and a tablist owes roving
        // tabindex + arrow keys — half that pattern is worse than none (OptRow's ruling).
        <div className="ds-segs ds-home-games" role="group" aria-label="Game">
          {games.map((g) => (
            <button
              key={g.id}
              aria-pressed={settings.game === g.id}
              className={`ds-seg${settings.game === g.id ? ' on' : ''}`}
              onClick={() => onGame(g.id)}
            >
              {seasonFor(g.id).name}
            </button>
          ))}
        </div>
      )}
      {!stage && links}

      <nav className="ds-menu" aria-label="Main">
        {/* PROFILE IS NOT HERE: it lives in the top-right menu (`ProfileMenu`). And the keycaps are
            the FIRST thing a participant sees in a Discord activity, so `railItems` drops the entry
            that only ever reaches a sign-in the embed cannot perform */}
        {railItems(inDiscordActivity())
          .filter((it) => it.id !== 'profile')
          .map((it, i) => (
          <button
            key={it.id}
            className={`ds-menu-btn${i === 0 ? ' primary' : ''}`}
            onClick={() => onNav(it.id)}
          >
            <span className="ml">
              {it.label}
              {it.id === 'play' && <QueueCounts className="menu" />}
            </span>
            <span className="mh">{it.hint}</span>
          </button>
        ))}
      </nav>

      {stage && links}

      {stats && (
        <div className="ds-homestats">
          <div className="ds-stat">
            <span className="sv">{stats.users.toLocaleString()}</span>
            <span className="sl">Players</span>
          </div>
          <div className="ds-stat">
            <span className="sv">{stats.games.toLocaleString()}</span>
            <span className="sl">Games played</span>
          </div>
          {stage && breakdown}
        </div>
      )}
      {!stage && <HomeMore extra={breakdown || null} />}
    </div>
  );
}

/**
 * A PHONE'S FOOTER (owner, 2026-10-18: the Home fits the screen with no scroll). The shell's footer
 * is hidden on a phone's Home (`.ds-app.is-home`), and this link opens a sheet with the same
 * contents (`FootBody`: the sponsor's footer credit, the destinations, the consent link) and the
 * stats breakdown the one-line stats drop.
 */
function HomeMore({ extra }: { extra: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="ds-foot-link ds-home-more" onClick={() => setOpen(true)}>
        More
      </button>
      {open && <MoreSheet extra={extra} onClose={() => setOpen(false)} />}
    </>
  );
}

function MoreSheet({ extra, onClose }: { extra: ReactNode; onClose: () => void }) {
  const ref = useDialog(onClose);
  const titleId = useId();
  return (
    <div className="ds-modal-backdrop ds-more-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={ref}
        className="ds-modal ds-more-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ds-modal-h">
          <h2 className="ds-dialog-title" id={titleId}>
            More
          </h2>
          <button className="ds-btn ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {extra}
        <div className="ds-foot ds-more-foot">
          <FootBody />
        </div>
      </div>
    </div>
  );
}
