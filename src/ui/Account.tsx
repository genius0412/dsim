import { useState } from 'react';
import type { GameSettings } from '../game';
import { defaultSettings } from '../settings';
import { authEnabled, authClient } from '../lib/authClient';
import { AuthPanel } from './AuthPanel';
import { APP_NAME } from '../seasons';

/**
 * Account settings — identity (sign in / out via Neon Auth) plus the app-level
 * preferences that aren't part of a robot loadout (audio, a settings reset).
 * Audio lives here rather than in the robot builder because it is global. Auth
 * is a stable module constant, so the `authEnabled` branch that skips the
 * session hook is safe.
 */
export function Account({
  settings,
  onChange,
}: {
  settings: GameSettings;
  onChange: (s: GameSettings) => void;
}) {
  const setAudio = (patch: Partial<GameSettings['audio']>) =>
    onChange({ ...settings, audio: { ...settings.audio, ...patch } });

  return (
    <>
      <p className="ds-eyebrow">{APP_NAME} · Account</p>
      <h1 className="ds-h1">Account settings</h1>
      <p className="ds-sub">
        Your sign-in identity and the app-wide preferences. Robot loadout and match options live on
        the My Robot page.
      </p>

      {authEnabled ? <Identity /> : <IdentityDisabled />}

      <div className="ds-panel" style={{ marginTop: 18 }}>
        <div className="ds-panel-h">
          <span className="ds-panel-title">Audio</span>
        </div>
        <div className="ds-opts two" style={{ padding: 16 }}>
          <button
            className={`ds-opt ${settings.audio.sounds ? 'on' : ''}`}
            onClick={() => setAudio({ sounds: !settings.audio.sounds })}
          >
            <span className="ot">Sounds {settings.audio.sounds ? 'ON' : 'OFF'}</span>
            <span className="od">Match sounds, countdowns, and voice — everything</span>
          </button>
          <button
            className={`ds-opt ${settings.audio.voice ? 'on' : ''}`}
            onClick={() => setAudio({ voice: !settings.audio.voice })}
          >
            <span className="ot">Voice lines {settings.audio.voice ? 'ON' : 'OFF'}</span>
            <span className="od">Announcer countdowns; beeps are used when off</span>
          </button>
        </div>
      </div>

      <div className="ds-panel" style={{ marginTop: 18 }}>
        <div className="ds-panel-h">
          <span className="ds-panel-title">Reset</span>
        </div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
          <p className="ds-hint" style={{ marginBottom: 2 }}>
            Restore every setting — robot, controls, assists, audio — to the defaults.
          </p>
          <button
            className="ds-btn"
            onClick={() => {
              if (confirm('Reset all settings to defaults? This cannot be undone.')) {
                onChange(defaultSettings());
              }
            }}
          >
            Reset all settings
          </button>
        </div>
      </div>
    </>
  );
}

function Identity() {
  const client = authClient!;
  const session = client.useSession();
  const [open, setOpen] = useState(false);
  const user = session.data?.user;

  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        <span className="ds-panel-title">Account</span>
        {session.isPending && <span className="ds-chip">…</span>}
      </div>
      <div style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        {user ? (
          <>
            <div className="ds-hero-name" style={{ fontSize: 20 }}>
              {user.name ?? 'Player'}
            </div>
            <span className="ds-chip">
              <b>{user.email ?? 'signed in'}</b>
            </span>
            <span className="ds-head-spacer" />
            <button className="ds-btn ghost" onClick={() => client.signOut()}>
              Sign out
            </button>
          </>
        ) : (
          <>
            <p className="ds-hint" style={{ margin: 0 }}>
              You’re signed out. Sign in to save records and climb the ranked ladder.
            </p>
            <span className="ds-head-spacer" />
            <button className="ds-btn primary" onClick={() => setOpen(true)}>
              Sign in
            </button>
          </>
        )}
      </div>
      {open && <AuthPanel onClose={() => setOpen(false)} />}
    </div>
  );
}

function IdentityDisabled() {
  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        <span className="ds-panel-title">Account</span>
      </div>
      <div className="ds-empty">
        <div className="big">Accounts are off in this build</div>
        Set <code>VITE_NEON_AUTH_URL</code> to enable sign-in, saved records, and ranked ELO.
      </div>
    </div>
  );
}
