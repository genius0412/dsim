import { useState } from 'react';
import { authClient } from '../lib/authClient';
import { AuthPanel } from './AuthPanel';

/** AppShell account slot. Only mounted when auth is enabled, so `authClient` is
 * non-null (keeps the `useSession` hook call unconditional). Shows the signed-in
 * handle (click → account settings) + sign-out, or a sign-in button that opens
 * the auth modal.
 *
 * `handle` is the app's own mutable display name, owned by App and refreshed the
 * moment Profile saves a new one. It must WIN over `user.name` (the Neon Auth
 * sign-up name), which is never updated after sign-up and is what used to leave
 * this pill disagreeing with the Profile page and leaderboards. `undefined` means
 * the fetch is still in flight — show a placeholder rather than the auth name, or
 * every page load flashes the stale name for a moment. */
export function AccountButton({
  handle,
  onAccount,
}: {
  handle?: string | null;
  onAccount?: () => void;
}) {
  const client = authClient!;
  const session = client.useSession();
  const [open, setOpen] = useState(false);

  if (session.isPending) return <span className="ds-chip">…</span>;

  const user = session.data?.user;
  if (!user) {
    // signed out: still expose Settings (controls / audio) — it lives on the account
    // page, which doesn't require an account. Sign-in sits beside it.
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="ds-btn" onClick={onAccount} title="Settings — controls & audio">
          Settings
        </button>
        <button className="ds-btn" onClick={() => setOpen(true)}>Sign in</button>
        {open && <AuthPanel onClose={() => setOpen(false)} />}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <button
        className="ds-chip"
        onClick={onAccount}
        title="Account settings"
        style={{ cursor: onAccount ? 'pointer' : 'default' }}
      >
        <b>{handle === undefined ? '…' : (handle ?? user.name ?? user.email ?? 'Player')}</b>
      </button>
      <button className="ds-btn ghost" onClick={() => client.signOut()}>Sign out</button>
    </div>
  );
}
