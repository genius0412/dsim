import { DESKTOP_BUILDS, releasesUrl, appVersion, hasDesktopBuilds } from '../download';
import { APP_NAME, LINKS } from '../seasons';

/**
 * Download page — where users get the Electron desktop build of the sim.
 * Renders as a child inside the app shell's `.ds-main`, so it returns only the
 * page content (no `.ds-app`/`.ds-main` scaffolding).
 */
export function Download() {
  const releases = releasesUrl();
  const version = appVersion();
  const configured = hasDesktopBuilds();

  return (
    <>
      <p className="ds-eyebrow">{APP_NAME} · Desktop</p>
      <h1 className="ds-h1">Download for desktop</h1>
      <p className="ds-sub">
        The desktop build is the full offline sim in a native Windows window — no
        browser needed.
      </p>

      <div className="ds-dl-hero">
        <div className="ds-dl-plat">
          <span className="glyph">🪟</span> Windows 10 / 11 · 64-bit
        </div>
        <div className="ds-req">
          <span>≈120 MB</span>
          <span>No install for portable</span>
          {version && <span>{version}</span>}
        </div>
      </div>

      {!configured && (
        <p className="ds-hint">
          Hosted downloads aren't configured for this deployment yet — use the
          build-it-yourself steps below to produce the desktop app from source.
        </p>
      )}

      <div className="ds-opts two">
        {DESKTOP_BUILDS.map((build) =>
          build.url ? (
            <a className="ds-opt" key={build.label} href={build.url} download>
              <span className="ot">{build.label}</span>
              <span className="od">{build.note}</span>
              <span className="go">↓</span>
            </a>
          ) : (
            <div className="ds-opt" key={build.label} style={{ opacity: 0.5 }}>
              <span className="ot">{build.label}</span>
              <span className="od">Not available yet</span>
              <span className="go">↓</span>
            </div>
          ),
        )}
      </div>

      {releases && (
        <p>
          <a className="ds-btn ghost" href={releases} target="_blank" rel="noreferrer">
            All releases →
          </a>
        </p>
      )}

      <div className="ds-panelbox">
        <div className="ds-panel-title">Build it yourself</div>
        <p className="ds-hint" style={{ marginTop: -4 }}>
          You can build the desktop app straight from source. Clone the{' '}
          <a href={LINKS.repo} target="_blank" rel="noreferrer" style={{ color: 'var(--ds-accent)' }}>
            repository
          </a>
          , then with Node installed run:
        </p>
        <p style={{ margin: 0 }}>
          <code
            style={{
              fontFamily: 'var(--ds-font-mono)',
              background: 'var(--ds-bg)',
              padding: '4px 10px',
              borderRadius: 6,
              border: '1px solid var(--ds-line)',
            }}
          >
            npm run dist
          </code>
        </p>
        <p className="ds-hint">
          electron-builder produces the Windows NSIS installer and a portable exe in{' '}
          <code style={{ fontFamily: 'var(--ds-font-mono)' }}>release/</code>.
        </p>
      </div>
    </>
  );
}
