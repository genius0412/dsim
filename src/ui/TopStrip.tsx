import { useEffect, useRef, useState } from 'react';
import { sponsorActive } from '../sponsor';
import { AdSlot, useAdUnitActive } from './AdSlot';
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
 * Renders nothing, and so reserves nothing, once the sponsor term is over and there is no ad:
 * an empty strip is a gap, not a placeholder.
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

  const showAd = adOn && !unfilled;
  const sponsor = sponsorActive();
  if (!showAd && !sponsor) return null;
  return (
    // `compact` when no ad can ever arrive (blocked build, supporter, touch, desktop app): the
    // banner alone does not need the 90px an ad box does
    <div className={adOn ? 'ds-topstrip' : 'ds-topstrip compact'} ref={box}>
      {showAd ? <AdSlot unit="top" /> : <SponsorStripMark />}
    </div>
  );
}
