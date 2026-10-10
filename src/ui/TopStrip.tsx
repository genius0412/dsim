import { useEffect, useRef, useState } from 'react';
import { sponsorActive } from '../sponsor';
import { AdSlot, TOP_NARROW_PX, useAdUnitActive } from './AdSlot';
import { SponsorStripMark } from './Sponsor';

/** how long an ad gets to report a status before the banner takes the strip back */
const FILL_WAIT_MS = 5000;

/**
 * The strip above every shell screen. It RESERVES its height whenever it has anything to show, so
 * a late or missing ad never moves the page: the ad when one fills, the sponsor's banner when ads
 * are off (blocked, a supporter, no slot id) or AdSense answers `unfilled`.
 *
 * The ad is mounted first and the banner only replaces it on a definite "no": AdSense stamps
 * `data-ad-status` on the `<ins>` when it settles, and a unit that stays silent past
 * `FILL_WAIT_MS` is treated as unfilled too (an extension that eats the script never answers).
 *
 * BOTH FILL THE SAME FRAME, and that is what makes it a banner rather than two different things:
 * a 728x90 box (320x50 on a phone) with its label above it, outlined by a hairline. The ad's label
 * is "Advertisement" (an AdSense requirement) and the sponsor's is "Sponsored", because the sponsor
 * is a placement we sold, not an AdSense unit. Same box, so the swap moves nothing.
 *
 * Renders nothing, and so reserves nothing, once the sponsor term is over and there is no ad:
 * an empty strip is a gap, not a placeholder. It is never rendered on Home (`AppShell`).
 */
export function TopStrip() {
  const adOn = useAdUnitActive('top');
  const [unfilled, setUnfilled] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!adOn) return;
    const ins = box.current?.querySelector('ins');
    if (!ins) return;
    const settle = () => {
      const status = ins.getAttribute('data-ad-status');
      if (status === 'unfilled') setUnfilled(true);
      return !!status;
    };
    if (settle()) return;
    const mo = new MutationObserver(() => settle() && mo.disconnect());
    mo.observe(ins, { attributes: true, attributeFilter: ['data-ad-status'] });
    const t = setTimeout(() => {
      if (!ins.getAttribute('data-ad-status')) setUnfilled(true);
    }, FILL_WAIT_MS);
    return () => {
      mo.disconnect();
      clearTimeout(t);
    };
  }, [adOn]);

  const narrow = useNarrow();
  const showAd = adOn && !unfilled;
  const sponsor = sponsorActive();
  if (!showAd && !sponsor) return null;
  return (
    <div className="ds-topstrip" ref={box}>
      {showAd ? (
        <AdSlot unit="top" />
      ) : (
        <div className="ds-adframe">
          <span className="ad-slot-label">Sponsored</span>
          <div className="ds-adframe-box">
            <SponsorStripMark h={narrow ? 24 : 44} />
          </div>
        </div>
      )}
    </div>
  );
}

/** the phone-sized unit (320x50) below `TOP_NARROW_PX`, tracked live so a resize swaps the creative */
function useNarrow(): boolean {
  const query = `(max-width: ${TOP_NARROW_PX - 1}px)`;
  const [narrow, setNarrow] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const m = matchMedia(query);
    const on = (): void => setNarrow(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return narrow;
}
