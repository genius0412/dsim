import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { authClient, authEnabled, clearAuthToken } from '../lib/authClient';
import { appChannel } from '../net/env';
import { ACCESS_GROUP_LABEL, type AccessGroup, ACCESS_GROUPS } from '../net/protocol';
import { BUILD_CLOSED, loadSiteStatus, recheckAccess, useSiteState } from '../net/siteStatus';
import { AuthPanel } from './AuthPanel';
import { Logo } from './Logo';

/** where a closed alpha sends people when the lockdown names nowhere itself */
export const PROD_URL = 'https://playdsim.com';

/**
 * THE CLOSED SCREEN — what every page shows while the site is closed to this viewer: a site
 * lockdown, or a build baked closed (the alpha). Rendered by `main.tsx` IN PLACE OF the app,
 * before the menus, the lobby socket or any lazy chunk, and for every URL (deep links too).
 *
 * The PRIMARY action is the way out (the redirect, focused on arrival). The second is the way
 * in for somebody allowed: sign in here, the status is asked again with the new token, and the
 * app replaces this screen without a reload.
 */
export function ClosedScreen() {
  const site = useSiteState();
  const alpha = appChannel() === 'alpha';
  const lock = site.lockdown?.scope === 'site' && site.lockdown.biting ? site.lockdown : null;

  const title = alpha ? 'Alpha is closed' : 'DSIM is closed';
  const message =
    lock?.message?.trim() ||
    (alpha ? 'The alpha is open to testers only. DSIM itself is open as usual.' : 'DSIM is closed for now. Check back soon.');
  const redirect = lock?.redirectUrl || (alpha || BUILD_CLOSED ? PROD_URL : null);
  const redirectLabel = lock?.redirectLabel || 'Go to DSIM';
  const back = lock?.endsAt
    ? `Back around ${new Date(lock.endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
    : null;
  const groups: AccessGroup[] = lock ? lock.bypass : BUILD_CLOSED ? [...ACCESS_GROUPS] : [];

  const primary = useRef<HTMLAnchorElement & HTMLButtonElement>(null);
  useEffect(() => {
    primary.current?.focus();
  }, []);

  return (
    <main className="ds-closed" aria-labelledby="ds-closed-title">
      <div className="ds-closed-card">
        <div className="ds-closed-brand">
          <Logo size={40} radius={10} />
          <span className="ds-closed-word">DSIM</span>
          {alpha && <span className="ds-badge">Alpha</span>}
        </div>
        <h1 id="ds-closed-title" className="ds-closed-title">
          {title}
        </h1>
        <p className="ds-closed-msg">
          {message}
          {back && <> {back}</>}
        </p>
        <div className="ds-closed-actions">
          {redirect ? (
            <a ref={primary} className="ds-btn primary" href={redirect}>
              {redirectLabel}
            </a>
          ) : null}
        </div>
        {authEnabled && <AccessRow groups={groups} focusFirst={!redirect ? primary : null} />}
      </div>
    </main>
  );
}

/** the way in: sign in, who you are signed in as, or that the server could not be asked */
function AccessRow({
  groups,
  focusFirst,
}: {
  groups: AccessGroup[];
  focusFirst: RefObject<HTMLAnchorElement & HTMLButtonElement> | null;
}) {
  const site = useSiteState();
  const session = authClient!.useSession();
  const user = session.data?.user ?? null;
  const [authOpen, setAuthOpen] = useState(false);

  // THE ACCOUNT CHANGED (a sign-in here, a Google return, a sign-out): ask the server again
  // with a fresh token. The first render is skipped; boot already asked.
  const uid = user?.id ?? null;
  const seen = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (session.isPending) return;
    if (seen.current === undefined) {
      seen.current = uid;
      if (uid && site.access === undefined) void recheckAccess();
      return;
    }
    if (seen.current !== uid) {
      seen.current = uid;
      void recheckAccess();
    }
  }, [uid, session.isPending, site.access]);

  const who = groups.length
    ? `${listOf(groups.map((g) => ACCESS_GROUP_LABEL[g].toLowerCase() + 's'))} can sign in to continue.`
    : 'Admins can sign in to continue.';

  let body: ReactNode;
  if (site.checking || session.isPending) {
    body = <p className="ds-closed-note">Checking your account…</p>;
  } else if (!site.reachable && site.loaded) {
    body = (
      <>
        <p className="ds-closed-note">Couldn’t reach the DSIM server to check your access.</p>
        <button className="ds-btn ghost small" onClick={() => void loadSiteStatus({ forceToken: true })}>
          Try again
        </button>
      </>
    );
  } else if (user) {
    body = (
      <>
        <p className="ds-closed-note">
          Signed in as <b>{user.name || 'your account'}</b>. This account doesn’t have access.
        </p>
        <button
          className="ds-btn ghost small"
          onClick={() => {
            clearAuthToken();
            void Promise.resolve(authClient!.signOut()).then(() => recheckAccess());
          }}
        >
          Sign out
        </button>
      </>
    );
  } else {
    body = (
      <>
        <p className="ds-closed-note">{sentenceCase(who)}</p>
        <button ref={focusFirst} className="ds-btn small" onClick={() => setAuthOpen(true)}>
          Sign in
        </button>
      </>
    );
  }
  return (
    <div className="ds-closed-access">
      {body}
      {authOpen && <AuthPanel onClose={() => setAuthOpen(false)} />}
    </div>
  );
}

function listOf(xs: string[]): string {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}
const sentenceCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
