/**
 * THE PLATFORM'S SCROLLBAR WIDTH, as `--ds-scrollbar` on `:root`, for `.ds-bar` (shell.css).
 *
 * Every shell screen keeps an always-on scroll track (`.ds-app` is `overflow-y: scroll`) except Play and
 * its popups, which sit over the stage with no track (`.ds-app.on-stage` is `auto`). The bar is laid out
 * inside that track, so on Play it was one track wider, and the sections, right-aligned in it, jumped
 * 15px sideways every time you went between Play and Configure or Records. The bar now pads itself by
 * the track its screen is missing, and CSS cannot read a scrollbar's width, so it is measured here:
 * 15-17px for a classic scrollbar, 0 for an overlay one (macOS, phones), where nothing moved anyway.
 * Again on resize, because a browser zoom changes a classic track's width in CSS pixels.
 */
export function initScrollbarWidth(): void {
  const root = document.documentElement;
  const measure = (): void => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;top:0;left:0;width:100px;height:100px;overflow:scroll;visibility:hidden';
    document.body.appendChild(probe);
    const w = probe.offsetWidth - probe.clientWidth;
    probe.remove();
    root.style.setProperty('--ds-scrollbar', `${w}px`);
  };
  measure();
  window.addEventListener('resize', measure);
}
