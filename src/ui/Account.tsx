import { useEffect, useState } from 'react';
import type { GameSettings } from '../game';
import { defaultSettings } from '../settings';
import { authEnabled, authClient } from '../lib/authClient';
import { gameServerConfigured } from '../net/env';
import { fetchProfile, updateHandle } from '../net/api';
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
      <p className="ds-sub">Your sign-in and app-wide preferences.</p>

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
            <span className="od">All audio</span>
          </button>
          <button
            className={`ds-opt ${settings.audio.voice ? 'on' : ''}`}
            onClick={() => setAudio({ voice: !settings.audio.voice })}
          >
            <span className="ot">Voice lines {settings.audio.voice ? 'ON' : 'OFF'}</span>
            <span className="od">Announcer voice · beeps when off</span>
          </button>
        </div>
      </div>

      <div className="ds-panel" style={{ marginTop: 18 }}>
        <div className="ds-panel-h">
          <span className="ds-panel-title">Reset</span>
        </div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
          <p className="ds-hint" style={{ marginBottom: 2 }}>
            Restore all settings to defaults.
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
      {user ? (
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <span className="ds-chip">
              <b>{user.email ?? 'signed in'}</b>
            </span>
            <span className="ds-head-spacer" />
            <button className="ds-btn ghost" onClick={() => client.signOut()}>
              Sign out
            </button>
          </div>
          <DisplayName userId={user.id} fallback={user.name ?? 'Player'} />
          <div>
            <p className="ds-hint" style={{ margin: '0 0 4px' }}>Account ID (for ADMIN_USER_IDS)</p>
            <code
              title="Click to copy"
              onClick={() => void navigator.clipboard?.writeText(user.id)}
              style={{ cursor: 'pointer', fontSize: 12, wordBreak: 'break-all', color: 'var(--muted)' }}
            >
              {user.id}
            </code>
          </div>
        </div>
      ) : (
        <div style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <p className="ds-hint" style={{ margin: 0 }}>
            Sign in to save records and rank up.
          </p>
          <span className="ds-head-spacer" />
          <button className="ds-btn primary" onClick={() => setOpen(true)}>
            Sign in
          </button>
        </div>
      )}
      {open && <AuthPanel onClose={() => setOpen(false)} />}
    </div>
  );
}

/** editable public display name (the leaderboard/profile handle) */
function DisplayName({ userId, fallback }: { userId: string; fallback: string }) {
  const configured = gameServerConfigured();
  const [name, setName] = useState(fallback);
  const [saved, setSaved] = useState(fallback);
  const [status, setStatus] = useState<'idle' | 'saving' | 'ok' | 'error'>('idle');
  const [error, setError] = useState('');

  // load the current handle from the server (may differ from the auth name)
  useEffect(() => {
    if (!configured) return;
    let alive = true;
    fetchProfile(userId)
      .then((p) => {
        if (!alive || !p.handle) return;
        setName(p.handle);
        setSaved(p.handle);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [userId, configured]);

  const trimmed = name.trim();
  const dirty = trimmed !== saved;
  const valid = trimmed.length >= 2 && trimmed.length <= 24;

  const save = (): void => {
    if (!dirty || !valid) return;
    setStatus('saving');
    setError('');
    updateHandle(trimmed)
      .then((r) => {
        setSaved(r.handle);
        setName(r.handle);
        setStatus('ok');
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      });
  };

  return (
    <div className="ds-panelbox">
      <label className="ds-field">
        <span className="cap">
          Display name <span className="val" style={{ color: valid ? undefined : 'var(--ds-danger)' }}>
            {trimmed.length}/24
          </span>
        </span>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="ds-input"
            style={{ flex: '1 1 240px' }}
            type="text"
            maxLength={24}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (status !== 'idle') setStatus('idle');
            }}
            placeholder="Shown on leaderboards"
          />
          <button className="ds-btn primary" disabled={!dirty || !valid || status === 'saving'} onClick={save}>
            {status === 'saving' ? 'Saving…' : 'Save'}
          </button>
        </div>
      </label>
      <p className="ds-hint" style={{ margin: 0 }}>
        Shown on leaderboards and to other drivers. 2–24 characters.
        {!configured && ' Editing needs the game server.'}
        {status === 'ok' && !dirty && <span style={{ color: 'var(--ds-ok)' }}> · Saved.</span>}
        {status === 'error' && <span style={{ color: 'var(--ds-danger)' }}> · {error}</span>}
      </p>
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
