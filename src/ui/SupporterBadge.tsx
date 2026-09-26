import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { StaffRole } from '../net/protocol';

export type { StaffRole };

/**
 * The badge beside a player's name — supporter, admin, or owner.
 *
 * ONE component for all three, used everywhere a name appears (leaderboards,
 * public profiles, the lobby roster), so a badge cannot end up meaning slightly
 * different things in different places.
 *
 * EXACTLY ONE badge renders, in rank order: owner > admin > supporter. Staff are
 * entitled to supporter perks (the server folds the role into the supporter
 * predicate, so `supporter` arrives true for them), which means without this
 * precedence every admin would wear two badges saying overlapping things. The
 * staff badge is the more specific claim, so it wins.
 *
 * All three are deliberately SMALL and quiet. A badge that shouts makes the
 * leaderboard look pay-to-win, and the tier rests on the promise — stated in the
 * terms — that supporters get nothing affecting driving or scoring. Looking like
 * an advantage is nearly as bad as being one, and that goes double for a badge
 * that says the holder runs the place.
 *
 * Every prop is optional-tolerant: both arrive as `undefined` from a server older
 * than the feature, which must render exactly like "no badge" rather than like a
 * missing field somewhere upstream.
 */
export function SupporterBadge({
  supporter,
  role,
  size = 'sm',
}: {
  /** `null` is accepted alongside `undefined` because these come straight off a
   * SQL row, where "no role" is a NULL column rather than a missing key. */
  supporter?: boolean | null;
  role?: StaffRole | null;
  /** `sm` inline beside a name; `md` on a profile header. Rendered as
   * `sup-sm`/`sup-md`, NOT as bare `sm`/`md` — `.md` is already the
   * rendered-Markdown class (announcement bodies), and a bare `md` here silently
   * inherited its 13.5px font-size AND its `--ds-ink-dim` colour, which is why
   * the profile-header badge came out a third of its intended size. */
  size?: 'sm' | 'md';
}) {
  const kind = role === 'owner' ? 'owner' : role === 'admin' ? 'admin' : supporter ? 'supporter' : null;
  return kind ? <BadgeIcon kind={kind} size={size} /> : null;
}

type BadgeKind = keyof typeof BADGES;

/**
 * THE ONE WAY A STATUS DISC IS DRAWN — owner, admin, supporter. Same markup, same
 * sizing, same hover tip for all three; only the glyph, the two colours and the tip's
 * words differ by kind. (The stargazer ★ disc is an EARNED badge and is drawn by
 * `BadgeArt`, `BadgeMark.tsx`, with the rest of the ledger's badges.)
 */
function BadgeIcon({ kind, size = 'sm' }: { kind: BadgeKind; size?: 'sm' | 'md' }) {
  const ref = useRef<SVGSVGElement>(null);
  // viewport coords of the hovered badge; null = no tip on screen
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);

  // A tip anchored to a viewport position goes stale the moment anything scrolls,
  // and `.ds-app` — not the window — is the scroll container, so this listens in
  // the CAPTURE phase to catch scrolls on any ancestor. Only ever armed while a
  // tip is actually showing.
  useEffect(() => {
    if (!tip) return;
    const hide = (): void => setTip(null);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [tip]);

  const { label, title, glyph } = BADGES[kind];

  const show = (e: React.PointerEvent): void => {
    // Mouse only. On touch, `pointerenter` fires on tap and there is no matching
    // leave, so a tapped badge would leave its tip stranded on screen.
    if (e.pointerType !== 'mouse') return;
    const r = ref.current?.getBoundingClientRect();
    if (r) setTip({ x: r.left + r.width / 2, y: r.top });
  };

  return (
    <>
      <svg
        ref={ref}
        viewBox="0 0 128 128"
        className={`sup-badge ${kind} sup-${size}`}
        aria-label={label}
        role="img"
        focusable="false"
        onPointerEnter={show}
        onPointerLeave={() => setTip(null)}
      >
        <circle cx="64" cy="64" r="64" />
        <path className="sup-glyph" d={glyph} />
      </svg>
      {tip &&
        createPortal(
          // PORTALLED to <body> and `position: fixed` because the badge lives
          // inside `.ds-panel`, which is `overflow: hidden` for its rounded
          // corners — a tip positioned within that subtree is simply clipped away
          // on the top row of every leaderboard. Fixed + portal escapes it.
          <span className="sup-tip" style={{ left: tip.x, top: tip.y }} role="tooltip">
            {title}
          </span>,
          document.body,
        )}
    </>
  );
}

/**
 * ONE 128×128 SVG PER BADGE — the disc and its glyph in the same coordinate space.
 *
 * The first cut used ♥ / ◆ / ★ characters, whose size and position come from the
 * FONT (a star riding high, a heart overflowing the circle). The second put a 24×24
 * glyph SVG inside a CSS disc, centred by flexbox at 58% — two layout systems that
 * drifted apart per surface, so the glyph read as shifted. Now the disc is
 * `<circle r=64>` and each glyph below is drawn in the same 128 box, centred by its
 * own bounding box: where it sits is geometry, and nothing in CSS can move it.
 */
const BADGES = {
  owner: {
    label: 'Owner',
    title: 'Owner · builds and runs DSIM',
    glyph: 'M64 35 71.2 57.1 94.4 57.1 75.6 70.8 82.8 92.9 64 79.2 45.2 92.9 52.4 70.8 33.6 57.1 56.8 57.1Z',
  },
  admin: {
    label: 'Admin',
    title: 'Admin · helps run DSIM',
    glyph: 'M64 34 94 64 64 94 34 64Z',
  },
  supporter: {
    label: 'Supporter',
    title: 'Supporter · helps pay for the servers',
    glyph:
      'M64 88.7C64 88.7 38 71.4 38 55 38 46.1 45.1 39.3 53.5 39.3 58.4 39.3 62.1 41.7 64 44.5 65.9 41.7 69.6 39.3 74.5 39.3 82.9 39.3 90 46.1 90 55 90 71.4 64 88.7 64 88.7Z',
  },
} as const;
