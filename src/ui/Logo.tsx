/**
 * DSIM mark — a top-down robot with a raised barrel on a mint badge, echoing the
 * sim itself (drive a shooter around a 2D field). Self-contained (literal colors,
 * one gradient) so the same artwork doubles as `public/favicon.svg` — a favicon
 * file can't read the `--ds-*` vars, so these hexes are deliberate. Keep the two
 * files in sync. Scales crisply from a 20px header chip up. `aria-hidden` — the
 * wordmark beside it carries the name.
 */
export function Logo({ size = 24, radius = 7 }: { size?: number; radius?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="dsimGrad" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#8fdcc2" />
          <stop offset="1" stopColor="#366758" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx={radius} fill="url(#dsimGrad)" />
      <g stroke="#14332a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        {/* chassis */}
        <rect x="7" y="10.5" width="18" height="14.5" rx="3.4" fill="none" />
        {/* barrel */}
        <line x1="16" y1="14.6" x2="16" y2="5.5" />
      </g>
      {/* turret */}
      <circle cx="16" cy="17.7" r="3.1" fill="#14332a" />
    </svg>
  );
}
