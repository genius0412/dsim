import { DESKTOP_BUILDS, releasesUrl, appVersion, detectOS, isMobile, OS_LABEL, type DesktopBuild } from '../download';
import { inDiscordActivity } from '../net/discordActivity';
import { SponsorDownloadMark } from './Sponsor';
import { trackEvent } from '../analytics';

/**
 * Download page — where users get the Electron desktop build of the sim (Windows
 * / macOS / Linux). Renders inside the app shell's `.ds-main`, so it returns only
 * page content. Build links point at the latest GitHub Release assets (published
 * by the release workflow on each `v*` tag). The visitor's detected OS is
 * featured first.
 */
export function Download() {
  const version = appVersion();
  const os = detectOS();

  // order builds so the visitor's platform leads
  const builds = [...DESKTOP_BUILDS].sort(
    (a, b) => (a.os === os ? -1 : 0) - (b.os === os ? -1 : 0),
  );

  /**
   * THE ELECTRON SPLASH'S ONLY PROXY.
   *
   * The splash (`electron/splash.html`) carries the mark on the slowest frame the
   * app has, and it is unmeasurable by construction — the desktop build does not
   * beacon a host it does not run on, which is the rule the whole analytics module
   * is gated by. So the report counts the DOWNLOAD instead and says so: one
   * download is at least one splash, and the `os` property is the only property —
   * no id, no version, no filename (`src/analytics.ts`).
   */
  const taken = (build: DesktopBuild) => (): void => {
    trackEvent('desktop_download', { os: build.os });
  };

  // A ROW per build, grouped under its platform (design review 11-13): "Windows · Installer" as
  // a card title wrapped at 375px, and the arrow sat in the tile's far corner away from its
  // label. The platform is the group's label once, so a row only has to say which variant.
  // ponytail: rides on src/download.ts writing labels as "Platform · Variant"
  const row = (build: DesktopBuild) => (
    <a className="ds-opt ds-dlpage-build" key={build.label} href={build.url} download onClick={taken(build)}>
      <span className="ot">{build.label.split(' · ').slice(1).join(' · ') || build.label}</span>
      <span className="od">{build.note}</span>
      <span className="go" aria-hidden="true">↓</span>
    </a>
  );
  const groups: { os: DesktopBuild['os']; name: string; list: DesktopBuild[] }[] = [];
  for (const b of builds) {
    const g = groups.find((x) => x.os === b.os);
    if (g) g.list.push(b);
    else groups.push({ os: b.os, name: b.label.split(' · ')[0], list: [b] });
  }

  const mobile = isMobile();
  // ⚠️ INSIDE THE DISCORD ACTIVITY THERE IS NO SHARE MENU. The page is a cross-origin iframe in
  // Discord's own webview, which has no browser chrome to open and nothing to add to a home
  // screen, so the mobile panel's one sentence was an instruction nobody could follow. The
  // reader still has a way to get what the sentence was offering; it is just a different one.
  const embedded = inDiscordActivity();
  // when we recognise the visitor's desktop OS, feature its PRIMARY build (the
  // first DESKTOP_BUILDS entry for that OS — Windows Installer / mac dmg / Linux
  // AppImage) as a one-click card at the top. `builds` still lists everything below.
  const featured = os && !mobile ? DESKTOP_BUILDS.find((b) => b.os === os) ?? null : null;
  const osName = featured ? featured.label.split(' · ')[0] : '';

  return (
    <>
      <h1 className="ds-h1">{mobile ? 'Play on your phone' : 'Download for desktop'}</h1>
      {mobile ? (
        // no inline margin: `.ds-main > .ds-panel` owns the panel stack now.
        <div className="ds-panel">
          <div className="ds-panel-h">
            <h2 className="ds-panel-title">{embedded ? 'Runs inside Discord' : 'Runs in your browser'}</h2>
          </div>
          <div className="ds-panel-body">
            {/* one sentence — the one the reader can act on. "No download needed.
                DSIM runs in your mobile browser" restated the panel title, and
                "The desktop builds below are for Windows, macOS, and Linux"
                described the section directly beneath it, which is already headed
                by its own platform labels. */}
            {embedded ? (
              <p className="ds-hint">
                To run full-screen, open <b>playdsim.com</b> in your phone’s browser.
              </p>
            ) : (
              <p className="ds-hint">
                To run full-screen, open your browser’s <b>Share</b> menu and tap{' '}
                <b>Add to Home Screen</b>.
              </p>
            )}
          </div>
        </div>
      ) : (
        <p className="ds-sub">DSIM in its own window. Plays offline when you have no connection.</p>
      )}

      {/* `.ds-dl` owns the gaps: these cards cast hard offset shadows, and headings are
          the only elements in the design system that carry their own bottom margin. */}
      <div className="ds-dlpage">
        <div className="ds-dl-hero">
          {/* No 🖥️ and no "your platform" chip. The emoji is the only element on
              this page rendered in the OS font — it ignores the theme and
              `currentColor` and looks different per platform — decorating a line
              that already NAMES the platform. And the chip was a third signal for
              one fact: the line prints the detected OS, the button below reads
              "Download for Windows ↓", and the build list is sorted to put it
              first. */}
          <div className="ds-dl-plat">{os ? OS_LABEL[os] : 'Windows · macOS · Linux'}</div>
          <div className="ds-req">
            {/* "Installer or portable" was a caption restating the labels of the
                cards 40px below it ("Windows · Installer", "Windows · Portable"). */}
            <span>≈120 MB</span>
            <span>{version ? version : 'latest release'}</span>
          </div>
          {featured && (
            <a
              className="ds-btn primary ds-dl-get"
              href={featured.url}
              download
              onClick={taken(featured)}
            >
              Download for {osName} ↓
            </a>
          )}
        </div>

        <div className="ds-dlpage-builds">
          {groups.map((g) => (
            <div key={g.os} className="ds-dlpage-group">
              <p className="ds-tileset-label">{g.name}</p>
              {g.list.map(row)}
            </div>
          ))}
        </div>

        <a className="ds-btn ghost" href={releasesUrl()} target="_blank" rel="noreferrer">
          All releases →
        </a>

        {/* BELOW the builds, not above them. The visitor came here for a binary and
            the page's job is to hand them one; the sponsor credit belongs where the
            desktop-app handoff finishes, and it is the same mark the app's own
            splash shows a few seconds later when they run it. */}
        <SponsorDownloadMark />
      </div>
    </>
  );
}
