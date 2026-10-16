import type { ReactNode } from 'react';
import { APP_NAME } from '../seasons';
import { Logo } from './Logo';

/**
 * THE CONSOLE HEADER — Back + the DSIM mark, then the page title with its sub-line — for every
 * full-screen queue/join surface (Ranked, Record run, Custom room, Match strategy, LAN, Discord
 * lobbies). It was hand-copied into each of them (design review 02-01), and the copies had
 * drifted: some subs carried `.ds-sub-tight`, some did not, so title→sub was 12px on one page
 * and 22px on the next, and every sub's own 24px bottom margin stacked on the column's gap.
 *
 * The title and its sub are ONE group (`.ds-title`, its own small gap), so the column's gap
 * spaces the header block from the content the same on every page, with or without a sub.
 * `title` absent ⇒ the header row alone (the builder takeovers, which render `Menu` under it).
 */
export function ConsoleHead({
  onBack,
  backLabel = '← Back',
  title,
  sub,
  subRow,
  reserveSub,
}: {
  /** absent ⇒ no head row: a shell page, whose app bar and trail are the way back */
  onBack?: () => void;
  backLabel?: string;
  title?: ReactNode;
  /** the one muted line under the title */
  sub?: ReactNode;
  /** the sub is a flex row (a label + a chip) */
  subRow?: boolean;
  /** keep one line for the sub even when it is empty, so a sub that comes and goes (Ranked's
   *  "searching…") never moves the panel under it */
  reserveSub?: boolean;
}) {
  const hasSub = sub !== undefined && sub !== null && sub !== '' && sub !== false;
  return (
    <>
      {onBack && (
        <div className="ds-head">
          <button className="ds-back" onClick={onBack}>
            {backLabel}
          </button>
          <span className="ds-mark">
            <Logo size={24} />
            {APP_NAME}
          </span>
        </div>
      )}
      {title !== undefined && (
        <div className="ds-title">
          <h1>{title}</h1>
          {(hasSub || reserveSub) && (
            <p className={`ds-sub${subRow ? ' ds-sub-row' : ''}${reserveSub ? ' reserve' : ''}`}>
              {hasSub ? sub : null}
            </p>
          )}
        </div>
      )}
    </>
  );
}
