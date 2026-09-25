import { useEffect, useMemo, useState } from 'react';
import type { Announcement, AnnouncementKind } from '../net/api';
import { useAnnouncements } from '../net/announcements';
import { Markdown } from './markdown';
import { useDialog } from './useDialog';

/**
 * Shows unseen announcements once, the first time a player opens the app after one
 * is published. `season`/`act` announcements get a full-screen cinematic reveal
 * first; then a "What's New" modal lists the patch notes. Dismissing marks
 * everything seen (localStorage). Mounted on the menu shell only — never over a
 * live match (respects the "no popups over the field" rule).
 */

const KIND_LABEL: Record<AnnouncementKind, string> = {
  patch: 'Patch notes',
  season: 'New season',
  act: 'New act',
};

/** a short celebratory swell for the cinematic reveal. Best-effort + self-contained
 * (no dependency on the game audio manager); silently no-ops if audio is blocked. */
function playRevealCue(): void {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.22, now + 0.15);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 1.9);
    master.connect(ctx.destination);
    // a rising major triad → a bright, hopeful "new chapter" chord
    [392, 494, 587, 784].forEach((f, i) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(f * 0.5, now);
      osc.frequency.exponentialRampToValueAtTime(f, now + 0.5 + i * 0.06);
      g.gain.setValueAtTime(0.25, now);
      osc.connect(g).connect(master);
      osc.start(now + i * 0.05);
      osc.stop(now + 2.0);
    });
    setTimeout(() => ctx.close().catch(() => {}), 2200);
  } catch {
    /* audio blocked / unsupported — the reveal is still visual */
  }
}

/** the kind pill, shared by the modal, the changelog page and the admin list. A new season
 *  is the one kind that WARNS (it resets ranked); patches and acts carry the accent. */
export function KindBadge({ kind }: { kind: AnnouncementKind }): JSX.Element {
  return <span className={`ds-badge ${kind === 'season' ? 'warn' : 'accent'}`}>{KIND_LABEL[kind]}</span>;
}

/** one published announcement as the modal and the changelog page both render it — ONE copy,
 *  because the two were written out verbatim and would have drifted (design review 11-18) */
export function AnnouncementItem({ a }: { a: Announcement }): JSX.Element {
  return (
    <article className={`ann-item ${a.kind}`}>
      <header className="ann-item-head">
        <KindBadge kind={a.kind} />
        {/* "Sep 25, 2026", not "9/25/2026": the numeric form reads day-first or month-first
            depending on where the reader is from */}
        <time className="ann-item-date" dateTime={a.publishedAt}>
          {new Date(a.publishedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}
        </time>
      </header>
      <h2 className="ann-item-title">{a.title}</h2>
      {a.tagline && <p className="ann-item-tag">{a.tagline}</p>}
      {a.body.trim() && <Markdown text={a.body} className="ann-md" />}
    </article>
  );
}

/** the full-screen cinematic reveal for a new season / act */
function CinematicReveal({
  ann,
  muted,
  onContinue,
}: {
  ann: Announcement;
  muted: boolean;
  onContinue: () => void;
}): JSX.Element {
  // Escape → CONTINUE, plus focus in / Tab trap / focus restore (design review C07)
  const ref = useDialog(onContinue);
  useEffect(() => {
    if (!muted) playRevealCue();
    // allow Enter/Space to advance too (Escape is `useDialog`'s, above)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onContinue();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [muted, onContinue]);

  return (
    <div
      ref={ref}
      className={`ann-cinema ${ann.kind}`}
      role="dialog"
      aria-modal="true"
      aria-label={`${KIND_LABEL[ann.kind]}: ${ann.title}`}
      tabIndex={-1}
    >
      <div className="ann-cinema-inner">
        <p className="ann-cinema-eyebrow">
          {ann.kind === 'act' ? 'A NEW ACT' : 'A NEW SEASON'}
        </p>
        <h1 className="ann-cinema-title">{ann.title}</h1>
        {ann.tagline && <p className="ann-cinema-tag">{ann.tagline}</p>}
        <div className="ann-cinema-rule" aria-hidden>
          <span />
        </div>
        <button className="ann-cinema-btn" onClick={onContinue}>
          CONTINUE
        </button>
      </div>
    </div>
  );
}

/** the "What's New" modal listing all unseen announcements */
function WhatsNew({ items, onClose }: { items: Announcement[]; onClose: () => void }): JSX.Element {
  // Escape → "Got it", plus focus in / Tab trap / focus restore (design review C07)
  const ref = useDialog(onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Enter on a focused control (a link in the notes) must activate IT, not dismiss the dialog
      const onControl =
        e.target instanceof Element && e.target.closest('a, button, input, textarea, select') !== null;
      if (e.key === 'Enter' && !onControl) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="overlay ann-overlay" onClick={onClose}>
      <div
        ref={ref}
        className="ann-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="What’s new"
        tabIndex={-1}
      >
        {/* tabIndex 0: the notes can be longer than the panel, and a keyboard user scrolls
            them with the arrows once focus is here (Tab from "Got it" wraps to it) */}
        <div className="ann-scroll" tabIndex={0} role="region" aria-label="Notes">
          {items.map((a) => (
            <AnnouncementItem key={a.id} a={a} />
          ))}
        </div>
        <div className="ann-actions">
          {/* focus HERE, not on the first link in the notes — Enter must dismiss */}
          <button className="ds-btn" onClick={onClose} autoFocus>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

export function Announcements({
  muted = false,
  onActiveChange,
}: {
  muted?: boolean;
  /** told whether an announcement is on screen, so the reward claim dialog can wait for it
   *  instead of stacking a second backdrop over this one */
  onActiveChange?: (active: boolean) => void;
}): JSX.Element | null {
  const { unseen, dismiss } = useAnnouncements();
  const active = unseen.length > 0;
  useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);
  // the newest season/act drives the cinematic reveal (shown before the notes)
  const cinematic = useMemo(
    () => unseen.find((a) => a.kind === 'season' || a.kind === 'act') ?? null,
    [unseen],
  );
  const [revealDone, setRevealDone] = useState(false);

  // reset the reveal phase whenever a fresh batch appears
  useEffect(() => {
    setRevealDone(false);
  }, [unseen]);

  if (unseen.length === 0) return null;
  if (cinematic && !revealDone) {
    return <CinematicReveal ann={cinematic} muted={muted} onContinue={() => setRevealDone(true)} />;
  }
  return <WhatsNew items={unseen} onClose={dismiss} />;
}
