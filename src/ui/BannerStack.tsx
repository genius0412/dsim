import { useEffect, useMemo, useState } from 'react';
import { useServerNotice } from '../net/notice';
import { bypassLine, useSiteState, visibleBanners } from '../net/siteStatus';
import type { SiteBanner } from '../net/protocol';
import { appChannel } from '../net/env';
import { BANNERS_DISMISSED_KEY } from '../storageKeys';
import { useShellState } from './shellState';
import { MarkdownInline } from './markdown';
import { CloseGlyph } from './FriendsPanel';

/**
 * THE SITE BANNERS — the strip at the top where the restart countdown has always appeared,
 * now also carrying admin-authored notices (info, known bugs, warnings) and the "you are
 * bypassing a lockdown" line for staff and testers. Mounted once beside `<App/>`.
 *
 * ── IT NEVER BURIES THE PAGE ──────────────────────────────────────────────────────────────
 * One row shows: the most important banner (restart, then warning, known bug, info). The rest
 * sit behind a "N more" toggle. In a match only the restart countdown shows; the notices wait
 * for the menus. The strip is `position: fixed`, so appearing never moves the layout.
 *
 * ── DISMISSAL ─────────────────────────────────────────────────────────────────────────────
 * Per banner id AND revision, in this browser (`BANNERS_DISMISSED_KEY`). An edit bumps the
 * revision on the server, so a changed banner shows again. A restart cannot be dismissed.
 */

type Dismissed = Record<string, number>;

function readDismissed(): Dismissed {
  try {
    const raw = localStorage.getItem(BANNERS_DISMISSED_KEY);
    const v: unknown = raw ? JSON.parse(raw) : {};
    return v && typeof v === 'object' ? (v as Dismissed) : {};
  } catch {
    return {};
  }
}
function writeDismissed(d: Dismissed): void {
  try {
    localStorage.setItem(BANNERS_DISMISSED_KEY, JSON.stringify(d));
  } catch {
    /* storage off: the dismissal lasts this page */
  }
}

const KIND_LABEL: Record<SiteBanner['kind'], string> = {
  restart: 'Restart',
  warning: 'Warning',
  'known-bug': 'Known bug',
  info: 'Notice',
};

export function BannerStack() {
  const site = useSiteState();
  const legacy = useServerNotice();
  const shell = useShellState();
  const [dismissed, setDismissed] = useState<Dismissed>(readDismissed);
  const [open, setOpen] = useState(false);
  const [, tick] = useState(0);

  // AN OLDER SERVER only sends the restart countdown as `serverNotice`: show it as a banner
  const all = useMemo<SiteBanner[]>(() => {
    const list = site.banners;
    if (legacy?.kind === 'restart' && !list.some((b) => b.kind === 'restart')) {
      return [
        ...list,
        { id: -1, kind: 'restart', message: legacy.message, startsAt: null, endsAt: legacy.until ?? null, game: null, channel: null, revision: 1 },
      ];
    }
    return list;
  }, [site.banners, legacy]);

  const now = Date.now() + site.skew;
  const shown = visibleBanners(all, { game: shell.game, channel: appChannel(), dismissed, now }).filter(
    (b) => !shell.inMatch || b.kind === 'restart',
  );
  const bypass = shell.inMatch ? null : bypassLine(site);
  const restart = shown.find((b) => b.kind === 'restart');

  // tick once a second while a countdown is on screen
  useEffect(() => {
    if (!restart?.endsAt) return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [restart?.endsAt]);

  // forget dismissals of banners that no longer exist, once the server has answered
  useEffect(() => {
    if (!site.loaded || !site.reachable || site.unsupported) return;
    const live = new Set(site.banners.map((b) => String(b.id)));
    const kept = Object.fromEntries(Object.entries(dismissed).filter(([id]) => live.has(id)));
    if (Object.keys(kept).length !== Object.keys(dismissed).length) {
      setDismissed(kept);
      writeDismissed(kept);
    }
  }, [site.loaded, site.reachable, site.unsupported, site.banners, dismissed]);

  if (!shown.length && !bypass) return null;

  const dismiss = (b: SiteBanner): void => {
    const next = { ...dismissed, [String(b.id)]: b.revision };
    setDismissed(next);
    writeDismissed(next);
  };

  const [first, ...rest] = shown;
  return (
    <div className="ds-banners" role="region" aria-label="Site notices">
      {bypass && (
        <p className="ds-banner-bypass" role="status">
          {bypass}
        </p>
      )}
      {first && <BannerRow b={first} now={now} onDismiss={dismiss} />}
      {open && rest.map((b) => <BannerRow key={`${b.id}.${b.revision}`} b={b} now={now} onDismiss={dismiss} />)}
      {rest.length > 0 && (
        <button className="ds-banner-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Show less' : `${rest.length} more`}
        </button>
      )}
    </div>
  );
}

export function BannerRow({ b, now, onDismiss }: { b: SiteBanner; now: number; onDismiss: (b: SiteBanner) => void }) {
  if (b.kind === 'restart') return <RestartRow b={b} now={now} />;
  return (
    <div className={`ds-banner ${b.kind}`}>
      <span className="ds-banner-kind">{KIND_LABEL[b.kind]}</span>
      <span className="ds-banner-msg">
        <MarkdownInline text={b.message} />
      </span>
      <button className="ds-banner-x" aria-label={`Dismiss ${KIND_LABEL[b.kind].toLowerCase()}`} onClick={() => onDismiss(b)}>
        <CloseGlyph size={12} />
      </button>
    </div>
  );
}

/**
 * The restart countdown. The LIVE part is the stable sentence only: the m:ss changes every
 * second and would re-announce the whole row, so it is aria-hidden and a screen reader gets
 * the wall-clock time instead.
 */
function RestartRow({ b, now }: { b: SiteBanner; now: number }) {
  let at: string | null = null;
  let clock: string | null = null;
  let restarting = false;
  if (b.endsAt) {
    const leftMs = b.endsAt - now;
    if (leftMs <= 0) {
      restarting = true;
    } else {
      const left = Math.round(leftMs / 1000);
      clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      at = new Date(b.endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
  }
  return (
    <div className={`ds-banner restart${restarting ? ' urgent' : ''}`}>
      <span className="ds-banner-kind">{KIND_LABEL.restart}</span>
      <span className="ds-banner-msg">
        <span role="status">
          {b.message}
          {restarting && ' · restarting now…'}
          {at && <span className="ds-sr"> at {at}</span>}
        </span>
        {clock && <span aria-hidden> in {clock}</span>}
      </span>
    </div>
  );
}
