import { useState } from 'react';
import { authClient } from '../lib/authClient';
import { AuthPanel } from './AuthPanel';

/** AppShell account slot. Only mounted when auth is enabled, so `authClient` is
 * non-null (keeps the `useSession` hook call unconditional). Shows the signed-in
 * handle (click → account settings) + sign-out, or a sign-in button that opens
 * the auth modal. */
export function AccountButton({ onAccount }: { onAccount?: () => void }) {
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
        <button className="ds-btn ghost" onClick={onAccount} title="Settings — controls & audio">
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
        <b>{user.name ?? user.email ?? 'Player'}</b>
      </button>
      <button className="ds-btn ghost" onClick={() => client.signOut()}>Sign out</button>
    </div>
  );
}
