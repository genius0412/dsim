import type { GameHudProps } from '../module';

/**
 * Chain Reaction's top-right HUD, two columns — mirrors BIOBUZZ's `BiobuzzHudChips`
 * dot/icon layout (`.bb-hud`) rather than the plain-text chips this replaces
 * (`HOPPER n/storage`, `×N`, `CARRYING CATALYST`, the pick-up/place/throw prompts).
 * Every icon carries no text of its own, so each row gets a spoken `aria-label` (no `title`: `.hud` is
 * `pointer-events: none`, so a tooltip could never show).
 *
 * LEFT: the ×N multiplier badge, the 4 catalyst pips (filled left-to-right by count —
 * there's no per-hook identity in `HudSnapshot`, same by-count idiom BIOBUZZ uses for its
 * NECTAR dots), then a holding indicator that only exists while there's something to say
 * about it (gold = an action is available now, green = carrying but out of range, absent
 * otherwise). RIGHT: a vertical fill for the hopper's storage capacity, reading near-white
 * (neutral `--ds-ink`) when full and draining toward red as it empties, with a numeric
 * n/storage fraction underneath for an exact reading (the bar's `aria-label` already says it aloud,
 * so the fraction is `aria-hidden`, same relationship as `.pg-num` to `.power-gauge`'s label).
 */
export function ChainHudChips({ hud }: GameHudProps) {
  const chain = hud.chain;
  if (!chain) return null;

  const multSaid = `Multiplier ×${chain.mult}.`;
  const catalystsSaid = `${chain.catalysts} of 4 catalysts seated.`;
  // `ringAction` is ALSO 'fling' — carrying, nothing seatable in reach, but a catapult can
  // throw it — and that is not "in reach": it keeps the carrying pip and says so.
  const inReach = chain.ringAction === 'pickup' || chain.ringAction === 'place';
  const holdSaid = inReach
    ? 'Catalyst in reach — pick up or place available.'
    : chain.carrying
      ? chain.ringAction === 'fling'
        ? 'Carrying a catalyst, out of range to place. Throw available.'
        : 'Carrying a catalyst, out of range to place.'
      : null;
  const storage = chain.storage > 0 ? Math.min(1, hud.hopper.length / chain.storage) : 0;
  const storageSaid = `Storage ${hud.hopper.length} of ${chain.storage}.`;

  return (
    <div className="cr-hud">
      <div className="cr-hud-left">
        <span className={`mult-badge${chain.mult > 1 ? ' on' : ''}`} role="img" aria-label={multSaid}>
          {/* ×, the notation the rest of the product prints a multiplier in (design review 22-11) */}
          ×{chain.mult}
        </span>
        <div className="hopper vertical" role="img" aria-label={catalystsSaid}>
          {Array.from({ length: 4 }, (_, i) => (
            <span key={i} className={`catalyst-pip${i < chain.catalysts ? ' filled' : ''}`} />
          ))}
        </div>
        {holdSaid && (
          <span
            className={`catalyst-pip${inReach ? ' prompt' : ' carrying'}`}
            role="img"
            aria-label={holdSaid}
          />
        )}
      </div>
      <div className="cr-hud-right">
        <span className="v-gauge" role="img" aria-label={storageSaid}>
          <span className="v-gauge-fill storage" style={{ ['--vg' as string]: String(storage) }} />
        </span>
        <span className="v-frac" aria-hidden="true">
          <span className="v-frac-num">{hud.hopper.length}</span>
          <span className="v-frac-bar" />
          <span className="v-frac-den">{chain.storage}</span>
        </span>
      </div>
    </div>
  );
}
