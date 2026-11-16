import { useEffect, useState } from 'react';
import { desktop, type DesktopUpdateCheck } from '../desktop';
import { ToggleRow } from './OptRow';

/**
 * Desktop-app panel: build version, a manual "Check for updates" button, and an
 * "auto-check" toggle. Renders nothing on the web (no `window.dsim`).
 *
 * From shell 0.2 the app installs its own updates (`electron/main.cjs`, `loadUpdater`): a check
 * starts the download, and a downloaded update installs when the app closes or on "Restart to
 * update". Where it cannot (macOS is unsigned, the portable exe, any shell before 0.2) the check
 * answers `mode: 'manual'` or nothing at all, and the panel offers the download page as before.
 */
export function DesktopUpdate() {
  const d = desktop();
  const [version, setVersion] = useState<string | null>(null);
  const [autoCheck, setAutoCheck] = useState(true);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<DesktopUpdateCheck | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!d) return;
    d.version().then(setVersion).catch(() => {});
    d.getAutoCheck().then(setAutoCheck).catch(() => {});
  }, [d]);

  if (!d) return null; // browser / non-desktop

  const check = (): void => {
    setChecking(true);
    setError(false);
    setResult(null);
    d.check()
      .then(setResult)
      .catch(() => setError(true))
      .finally(() => setChecking(false));
  };

  const setAuto = (next: boolean): void => {
    setAutoCheck(next);
    d.setAutoCheck(next)
      .then(setAutoCheck)
      .catch(() => setAutoCheck(!next));
  };

  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        <span className="ds-panel-title">Desktop app</span>
        {version && <span className="ds-chip">v{version}</span>}
      </div>
      {/* `.ds-panel-body.stack` — the four properties written out here
          inline (padding 16, flex column, gap 12, align flex-start) are the same
          four retyped in half a dozen other panel bodies. */}
      <div className="ds-panel-body stack">
        {/* the shared Off/On pick — this was one tile whose label carried the state
            ("Auto-check for updates ON"), the pattern docs/area/ui.md rules out */}
        <ToggleRow label="Auto-check for updates" value={autoCheck} onPick={setAuto} />

        {/* `.ds-actions` already IS this row (flex, wrap, centred) — no need for a
            fourth hand-written copy of it. */}
        <div className="ds-actions">
          <button className="ds-btn" onClick={check} disabled={checking}>
            {checking ? 'Checking…' : 'Check for updates'}
          </button>
          {result?.ready && d.installUpdate ? (
            <button className="ds-btn primary" onClick={() => void d.installUpdate?.()}>
              Restart to update
            </button>
          ) : (
            result?.updateAvailable &&
            result.mode !== 'auto' && (
              <button className="ds-btn primary" onClick={() => void d.openDownload()}>
                Download v{result.latest} ↓
              </button>
            )
          )}
        </div>

        {/* the colour is a CLASS. `.ds-hint` is already `margin: 0`, so both inline
            `margin: 0` were no-ops kept alive next to a colour literal — and
            `.ds-claim-msg.ok/.err` already exist for exactly this status pair. */}
        {error && <p className="ds-hint err">Couldn’t reach the update server. Try again.</p>}
        {result && !result.updateAvailable && (
          <p className="ds-hint ok">You’re on the latest version.</p>
        )}
        {result?.updateAvailable && result.mode === 'auto' && !result.ready && (
          <p className="ds-hint">Downloading v{result.latest}. It installs when you close DSIM.</p>
        )}
      </div>
    </div>
  );
}
