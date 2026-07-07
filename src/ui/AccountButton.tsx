import { useState } from 'react';
import { authClient } from '../lib/authClient';
import { AuthPanel } from './AuthPanel';

/** AppShell account slot. Only mounted when auth is enabled, so `authClient` is
 * non-null (keeps the `useSession` hook call unconditional). Shows the signed-in
 * handle + sign-out, or a sign-in button that opens the auth modal. */
export function AccountButton() {
  const client = authClient!;
  const session = client.useSession();
  const [open, setOpen] = useState(false);

  if (session.isPending) return <span className="ds-chip">…</span>;

  const user = session.data?.user;
  if (!user) {
    return (
      <>
        <button className="ds-btn" onClick={() => setOpen(true)}>Sign in</button>
        {open && <AuthPanel onClose={() => setOpen(false)} />}
      </>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <span className="ds-chip">
        <b>{user.name ?? user.email ?? 'Player'}</b>
      </span>
      <button className="ds-btn ghost" onClick={() => client.signOut()}>Sign out</button>
    </div>
  );
}
