import { DESKTOP_BUILDS, releasesUrl, appVersion, detectOS, OS_LABEL, type DesktopBuild } from '../download';
import { APP_NAME, LINKS } from '../seasons';

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

  const card = (build: DesktopBuild) => (
    <a className="ds-opt" key={build.label} href={build.url} download>
      <span className="ot">{build.label}</span>
      <span className="od">{build.note}</span>
      <span className="go">↓</span>
    </a>
  );

  return (
    <>
      <p className="ds-eyebrow">{APP_NAME} · Desktop</p>
      <h1 className="ds-h1">Download for desktop</h1>
      <p className="ds-sub">The full offline sim in a native window.</p>

      {/* `.ds-dl` owns the gaps: these cards cast hard offset shadows, and headings are
          the only elements in the design system that carry their own bottom margin. */}
      <div className="ds-dl">
        <div className="ds-dl-hero">
          <div className="ds-dl-plat">
            <span className="glyph">🖥️</span>
            {os ? OS_LABEL[os] : 'Windows · macOS · Linux'}
            {os && <span className="ds-chip" style={{ marginLeft: 4 }}>your platform</span>}
          </div>
          <div className="ds-req">
            <span>≈120 MB</span>
            <span>Installer or portable</span>
            <span>{version ? version : 'latest release'}</span>
          </div>
        </div>

        <div className="ds-opts two">{builds.map(card)}</div>

        <a className="ds-btn ghost" href={releasesUrl()} target="_blank" rel="noreferrer">
          All releases →
        </a>

        <div className="ds-panelbox">
          <div className="ds-panel-title">Build it yourself</div>
          <p className="ds-hint" style={{ marginTop: -4 }}>
            Clone the{' '}
            <a href={LINKS.repo} target="_blank" rel="noreferrer" style={{ color: 'var(--ds-accent)' }}>
              repository
            </a>{' '}
            and run <code style={{ fontFamily: 'var(--ds-font-mono)' }}>npm run dist</code>. Artifacts
            land in <code style={{ fontFamily: 'var(--ds-font-mono)' }}>release/</code>.
          </p>
        </div>
      </div>
    </>
  );
}
