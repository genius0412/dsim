import { BADGE_LABELS, BADGE_TIER, coerceEquippedBadges, isBadgeId, type BadgeId } from '../badges';

/**
 * A BADGE — what the rewards ledger puts beside a name (`src/badges.ts`), drawn.
 *
 * ── SHAPE CARRIES THE KIND ──────────────────────────────────────────────────────────────────
 * Beside a name there is already ★ / ◆ / ♥ in a DISC (`SupporterBadge`), and
 * `docs/area/accounts.md` requires every mark there to be told apart by SHAPE as well as hue. So:
 *   · the ranked PODIUM is a CREST (a shield), in gold / silver / bronze by placement, with the
 *     placement's numeral on it — the prestigious one, and it looks it;
 *   · the RECORD HOLDER badge is a BOOKMARK RIBBON in the award violet with a small crown —
 *     deliberately the plainer of the two (owner: "less special and cool than the ranked one");
 *   · the STARGAZER badge is the one disc: a yellow ★ on the award violet, which the owner asked
 *     for by name (2026-09-24). A disc like the owner's ★, told apart from it by the violet, the
 *     yellow and the star's outline — and by being a much bigger star.
 * Both carry a 1px `--ds-mut` rim. That is the lesson of the lavender pastel the accounts guide
 * records: a silver fill is ~1.9:1 on the light panel and would vanish there, and the rim is
 * what separates it — the same "an edge identifies a floating surface" rule the HUD follows.
 *
 * ── THE COUNTER ─────────────────────────────────────────────────────────────────────────────
 * A pip at the corner with the times earned, from 2 up — a badge earned once needs no "1".
 * It is a fixed dark disc with light ink (`--ds-stage-bg` / `--ds-on-field`), ringed in the
 * panel colour so it lifts off whatever badge it sits on in either theme.
 */

const CREST = 'M12 1.6 20.6 4.8V11.3C20.6 16.6 17 20.4 12 22.4 7 20.4 3.4 16.6 3.4 11.3V4.8Z';
const RIBBON = 'M5.5 1.8H18.5V22.2L12 17.6 5.5 22.2Z';
/** a three-point crown, the "top of the board" mark on the record ribbon */
const CROWN = 'M8 12.6 8.6 7.8 10.6 9.8 12 6.8 13.4 9.8 15.4 7.8 16 12.6Z';
/**
 * THE PODIUM NUMERALS, stroked centrelines in the crest's 24 box. They were HTML text laid over
 * the SVG, and the font put them off centre: Space Grotesk's "1" carries its flag to the left, so
 * its ink sat a unit left of the crest's axis, the digits sat high at the small sizes, and the
 * numeral was 60% of the crest at `sm` but 30% at `lg` because its size followed the text size
 * and not the crest. As geometry, each numeral's ink box is centred on (12, 11.5): the inner
 * shield's axis, and a touch above its middle, where a tapering shield's visual weight is.
 */
const NUMERAL: Record<'gold' | 'silver' | 'bronze', string> = {
  gold: 'M10.1 9.9 12 8.5V14.5M10 14.5H14',
  silver: 'M10.1 10.4C10.1 9.2 11 8.5 12 8.5 13.1 8.5 13.9 9.2 13.9 10.3 13.9 11.2 13.3 11.8 12.6 12.4L10.1 14.5H13.9',
  bronze:
    'M10.1 9.4C10.5 8.8 11.2 8.5 12 8.5 13.1 8.5 13.9 9.2 13.9 10 13.9 10.9 13.1 11.5 12 11.5H11.3M12 11.5C13.2 11.5 14 12.2 14 13 14 13.9 13.1 14.5 12 14.5 11.1 14.5 10.4 14.2 9.9 13.6',
};
/**
 * THE STARGAZER DISC, in a 128 box (the one `SupporterBadge`'s discs use, where it was first
 * drawn): the disc and the star in one coordinate space, the star centred on its own bounding
 * box, so where it sits is geometry and nothing in CSS can move it. r = 61 leaves room inside the
 * box for the family's `--ds-mut` rim.
 */
const STAR_DISC_R = 61;
const STAR = 'M64 25.5 73.4 54.5 103.9 54.5 79.3 72.5 88.7 101.5 64 83.5 39.3 101.5 48.7 72.5 24.1 54.5 54.6 54.5Z';

export type BadgeSize = 'sm' | 'md' | 'lg' | 'xl';

export function BadgeArt({ id, n = 1, size = 'sm' }: { id: BadgeId; n?: number; size?: BadgeSize }) {
  const tier = BADGE_TIER[id];
  const label = BADGE_LABELS[id];
  const said = n > 1 ? `${label} badge, earned ${n} times` : `${label} badge`;
  const podium = tier === 'gold' || tier === 'silver' || tier === 'bronze';
  return (
    <span className={`badge-mark badge-${size} tier-${tier}`} role="img" aria-label={said} title={said}>
      <span className="badge-glyph" aria-hidden="true">
        {tier === 'stargazer' ? (
          <svg viewBox="0 0 128 128">
            <circle className="badge-body" cx="64" cy="64" r={STAR_DISC_R} />
            <path className="badge-star" d={STAR} />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24">
            <path className="badge-body" d={podium ? CREST : RIBBON} />
            {podium ? (
              <>
                <path className="badge-inner" d="M12 4.4 18 6.7V11.3C18 15.1 15.5 17.9 12 19.4 8.5 17.9 6 15.1 6 11.3V6.7Z" />
                <path className="badge-num" d={NUMERAL[tier]} />
              </>
            ) : (
              <path className="badge-crown" d={CROWN} />
            )}
          </svg>
        )}
      </span>
      {/* beside a name the count TRAILS the glyph (`×2`) — a pip on a 16px crest covers it;
          at the large sizes it is the corner pip */}
      {n > 1 && <span className="badge-count" aria-hidden="true">×{n}</span>}
    </span>
  );
}

/**
 * THE WORN BADGES beside a name, in the order the player chose. Tolerant of whatever the wire
 * carried: an older server sends nothing, a newer build's badge is skipped (`coerceEquippedBadges`),
 * and none of it can throw inside a leaderboard row.
 */
export function BadgeMarks({ badges }: { badges?: unknown }) {
  const list = coerceEquippedBadges(badges);
  if (list.length === 0) return null;
  return (
    <>
      {list.map((b) => (isBadgeId(b.id) ? <BadgeArt key={b.id} id={b.id} n={b.n} /> : null))}
    </>
  );
}
