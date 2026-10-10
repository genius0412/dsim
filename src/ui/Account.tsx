import { useEffect, useState, type FormEvent } from 'react';
import { ToggleRow } from './OptRow';
import { LinkedAccounts } from './LinkedAccounts';
import { StarReward } from './StarReward';
import type { GameSettings } from '../game';
import { defaultSettings } from '../settings';
import { authEnabled, authClient } from '../lib/authClient';
import {
  CODE_MAX,
  hasPasswordLogin,
  PASSWORD_MIN,
  requestPasswordCode,
  setPasswordWithCode,
  SITE_HOST,
} from '../lib/authFlows';
import { inDiscordActivity } from '../net/discordActivity';
import { multiServer, selectedServerId } from '../net/env';
import {
  deleteMyAccount,
  fetchEntitlements,
  fetchReplaysPublic,
  saveReplaysPublic,
  type Entitlements,
} from '../net/api';
import { AuthDisabled } from './AuthDisabled';
import { AuthPanel } from './AuthPanel';
import { copyText } from './copyText';
import { DesktopUpdate } from './DesktopUpdate';
import { fmtDay } from './fmtDate';
import { ProfileTabs, type ProfileTab } from './ProfileTabs';
import { ServerMenu } from './ServerMenu';
import { VerifyEmailBanner } from './VerifyEmailBanner';
import { SUPPORT_ENABLED } from '../net/env';
import { LEGAL_CONTACT } from '../legalText';
import { trackEvent } from '../analytics';

/**
 * ACCOUNT — the account itself: sign in / out (Neon Auth), email and password, the default
 * server region, linked accounts, privacy, membership, a settings reset and deletion.
 *
 * HOW YOU APPEAR TO OTHERS — name, title, badges, rewards, robot look — is the OTHER page of
 * this destination, `Appearance` (owner, 2026-09-22: "Profile account settings should be
 * separated from like profile title and cosmetics settings"). Audio and controls live in
 * `Configure`. Auth is a stable module constant, so the `authEnabled` branch that skips the
 * session hook is safe.
 */
export function Account({
  settings,
  onChange,
  onDonate,
  onTab,
}: {
  settings: GameSettings;
  onChange: (s: GameSettings) => void;
  /** navigate to the Support page — the membership card links to it rather than
   * duplicating the tier pitch here */
  onDonate?: () => void;
  /** the Appearance | Account strip */
  onTab?: (t: ProfileTab) => void;
}) {
  /**
   * ⚠️ EVERY ACCOUNT CONTROL ON THIS PAGE IS OFF INSIDE A DISCORD ACTIVITY. The embed is a
   * cross-origin iframe whose CSP admits only Discord's own URL mappings; the auth host is
   * not one, so the participant is ALWAYS signed out and no panel here can do its job — the
   * signed-out `Identity` offers a sign-in that cannot succeed, and the rest render nothing
   * while each still mounts a session hook that fires a request the frame refuses.
   *
   * The PAGE stays, and says so, rather than 404-ing or vanishing: the rail item is gone
   * (see `NavRail`), but somebody who has an account on the website and went looking for it
   * is owed an answer, and "Reset all settings" below is local-only and works here. That is
   * the whole judgement — remove what cannot work, explain it, keep what can.
   */
  const inActivity = inDiscordActivity();
  const showAuth = authEnabled && !inActivity;
  return (
    <>
      <h1 className="ds-h1">Profile</h1>
      {/* the strip's other page is Appearance — name, title, badges: account-held, every one
          of them — so in the embed it is a second door onto the same dead end */}
      {!inActivity && <ProfileTabs active="account" onPick={onTab} />}

      {/* ABOVE the identity panel, because it is about the address that panel shows,
          and because this is the page the ranked refusal sends people to. */}
      {showAuth && <VerifyEmailBanner />}

      {inActivity ? <AccountInDiscord /> : authEnabled ? <Identity /> : <IdentityDisabled />}

      {multiServer() && (
        // `ds-panel-open` drops the panel's `overflow: hidden` so the region
        // dropdown can escape below the card instead of being clipped by it.
        <div className="ds-panel ds-panel-open">
          <div className="ds-panel-h">
            <h2 className="ds-panel-title">Server</h2>
          </div>
          <div className="ds-panel-body">
            <ServerMenu
              value={settings.preferredServerId ?? selectedServerId()}
              onChange={(id) => onChange({ ...settings, preferredServerId: id })}
            />
          </div>
        </div>
      )}

      <DesktopUpdate />

      {/* ⚠️ `StarReward` ABOVE `LinkedAccounts`, and both facts matter. It has to MOUNT first
          because `LinkedAccounts` strips `?link` from the URL once it has read it, and it has to
          READ first because this is the thing somebody is coming back to see. The reward itself
          arrives through the claim dialog; this panel only says what to do when there is none. */}
      {showAuth && <StarReward />}
      {showAuth && <LinkedAccounts />}
      {showAuth && <ReplayPrivacy />}

      {showAuth && SUPPORT_ENABLED && <Membership onDonate={onDonate} />}

      {/* THE TWO IRREVERSIBLE ACTIONS, grouped under one heading at the foot of the page
          (design review 08-15) rather than as two more peers of Server and Privacy.
          Reset is LOCAL — it rewrites this device's settings blob and needs no account —
          so it is the one thing on this page that still works inside a Discord activity. */}
      <h2 className="ds-h2 ds-danger-head">Danger zone</h2>
      <div className="ds-panel">
        <div className="ds-panel-h">
          <h3 className="ds-panel-title">Reset settings</h3>
        </div>
        <div className="ds-panel-body stack start">
          {/* `danger`: it wipes builds, autos and bindings, which for a local-only player is
              more loss than deleting the account. The confirm names every one of them. */}
          <button
            className="ds-btn danger"
            onClick={() => {
              if (
                confirm(
                  'Reset every setting? This clears your robot build, saved robots, imported autos, ' +
                    'saved start positions, key bindings, audio and mobile layout. It cannot be undone.',
                )
              ) {
                onChange(defaultSettings());
              }
            }}
          >
            Reset all settings
          </button>
        </div>
      </div>

      {showAuth && <DeleteAccount />}
    </>
  );
}

/**
 * THE ACCOUNT PANEL INSIDE A DISCORD ACTIVITY — an explanation, not a sign-in.
 *
 * Same shape as `AuthDisabled` (the panel a build with no auth shows) on purpose: this is
 * not a third state, it is the same "there is no account here" answer arrived at for a
 * different reason, and reusing the shape keeps one look for one situation.
 *
 * The copy names the FRAME, never the player's connection: the sign-in fetch is refused by
 * the browser before a packet leaves, so "check your connection and try again" — the
 * sentence that used to arrive here through `describeAuthError` — was advice that could
 * never work. It also does not guess at anything it cannot see; it states where accounts
 * do work and leaves the player to go there. A plain address rather than a link: an anchor
 * with no target would navigate the activity away from itself, and `target="_blank"` is
 * unreliable inside Discord's frame.
 */
function AccountInDiscord() {
  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        <span className="ds-panel-title">Account</span>
      </div>
      <div className="ds-empty">
        <div className="big">Accounts aren’t available inside Discord</div>
        Discord’s activity frame blocks the sign-in service, so records, ranked rating and
        friends aren’t saved here. Open {SITE_HOST} in a browser to use your account.
      </div>
    </div>
  );
}

/**
 * REPLAY PRIVACY — the one account setting that changes what STRANGERS can see.
 *
 * Match replays are private by default (migration 0037). A replay is an input log
 * re-simulated at full fidelity, so it is not a highlight, it is the game plan: where you
 * start, what you go for first, when you leave for the endgame. That is scouting material,
 * and it used to be one click from any leaderboard row.
 *
 * ⚠️ THE COPY MUST SAY THAT ONE PLAYER CANNOT PUBLISH A MATCH. A toggle labelled "make my
 * replays public" that quietly does nothing for most matches is worse than no toggle — the
 * release rule is unanimous consent, because the log shows the opponent's half too. Nobody
 * will infer that from a switch, so the panel states it.
 *
 * It does NOT cover record runs. Those are leaderboard submissions whose replay is the proof
 * behind the number, so they stay watchable and this setting never claims otherwise.
 */
function ReplayPrivacy() {
  const session = authClient!.useSession();
  const userId = session.data?.user?.id ?? null;
  const [value, setValue] = useState<boolean | null>(null);
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle');

  useEffect(() => {
    if (!userId) {
      setValue(null);
      return;
    }
    let cancelled = false;
    void fetchReplaysPublic()
      .then((r) => {
        if (!cancelled) setValue(r.replaysPublic);
      })
      .catch(() => {
        if (!cancelled) setValue(null);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (!userId) return null;

  const toggle = (next: boolean): void => {
    // OPTIMISTIC, and it rolls back on failure. The alternative is a switch that does not
    // move until a round trip lands, which reads as a dead control.
    const prev = value;
    setValue(next);
    setStatus('saving');
    void saveReplaysPublic(next)
      .then(() => setStatus('idle'))
      .catch(() => {
        setValue(prev);
        setStatus('error');
      });
  };

  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        <h2 className="ds-panel-title">Privacy</h2>
      </div>
      <div className="ds-panel-body stack start">
        {value === null ? (
          <p className="ds-hint">Checking…</p>
        ) : (
          <>
            <ToggleRow
              label="Match replays"
              value={value}
              onPick={toggle}
              off="Private"
              on="Anyone can watch"
            />
            <p className="ds-hint">
              A replay shows both alliances, so a match only becomes public when everyone who
              played in it has turned this on. Turning it off again hides every match of yours
              that was shared this way.
            </p>
          </>
        )}
        {status === 'error' && (
          <p className="ds-hint warn">Couldn’t save that. Check your connection and try again.</p>
        )}
      </div>
    </div>
  );
}

/**
 * Membership status.
 *
 * Lives here rather than only on the Donate page because "when does my
 * subscription run out, and is it going to renew?" is an ACCOUNT question, and
 * making someone visit a page titled "Support DSIM" to answer it reads as a
 * second sales pitch. It also surfaces the one state a supporter genuinely needs
 * warning about: a membership that is active but NOT linked to a Ko-fi address,
 * which will simply stop at the end of the period with no renewal.
 */
function Membership({ onDonate }: { onDonate?: () => void }) {
  const [ent, setEnt] = useState<Entitlements | null>(null);
  const session = authClient!.useSession();
  const userId = session.data?.user?.id ?? null;

  useEffect(() => {
    if (!userId) {
      setEnt(null);
      return;
    }
    let cancelled = false;
    void fetchEntitlements().then((e) => {
      if (!cancelled) setEnt(e);
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (!userId) return null;
  const until = ent?.supporterUntil ? new Date(ent.supporterUntil) : null;

  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        <h2 className="ds-panel-title">Membership</h2>
        {ent?.supporter && <span className="ds-count">supporter</span>}
      </div>
      <div className="ds-panel-body stack start">
        {!ent ? (
          <p className="ds-hint">Checking…</p>
        ) : ent.supporter ? (
          <>
            <p className="ds-hint">
              Supporter{until ? ` until ${fmtDay(until)}` : ''} ·{' '}
              {ent.autoRenews ? 'renews automatically' : 'will not renew'}
            </p>
            {!ent.autoRenews && (
              <p className="ds-hint warn">
                This membership isn’t linked to a Ko-fi account, so it will stop at the end of the
                period. Claim a payment on the Support page to link it.
              </p>
            )}
          </>
        ) : (
          <p className="ds-hint">No membership.</p>
        )}
        {onDonate && (
          <button className="ds-btn ghost" onClick={onDonate}>
            {ent?.supporter ? 'Manage membership' : 'Support DSIM'}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Account deletion.
 *
 * The privacy policy promises this, which means it has to be a button rather
 * than an inbox commitment someone honours by hand when they get round to it.
 *
 * Two guards, because it is irreversible and cascades across every table: a
 * typed confirmation (not an OK/Cancel dialog anyone can dismiss by muscle
 * memory) and an explicit note about what SURVIVES — a promise to erase
 * everything would be a lie, since a completed match's result still involves the
 * other players and financial records have to outlive the account.
 */
/**
 * ⚠️ EXPORTED, and rendered in TWO places: here, and in the privacy page's "Your data" panel
 * (`src/ui/YourData.tsx`). Deliberately the same component rather than a second button that
 * posts to the same route: the typed confirmation and the paragraph about what SURVIVES a
 * deletion are the load-bearing parts, and two copies of that copy would drift — which is the
 * exact failure the storage registry exists to stop one file over.
 */
export function DeleteAccount() {
  const session = authClient!.useSession();
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!session.data?.user) return null;

  const doDelete = async (): Promise<void> => {
    if (confirm !== 'DELETE' || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await deleteMyAccount();
      trackEvent('account_deleted');
      // Sign out AFTER the server confirms: signing out first would drop the very
      // token the delete request needs.
      await authClient!.signOut();
      location.href = '/';
    } catch (e) {
      // The route can be MISSING rather than broken: one Fly app serves every
      // client version, so a client deployed ahead of the server gets a 404 here.
      // The privacy policy promises deletion either way, so a failure has to fall
      // back to the promise we can always keep - a human answering the mailbox -
      // rather than leaving someone stuck on a button that does nothing.
      // The server's wording is logged, not shown: it is not written for a person.
      const msg = e instanceof Error ? e.message : '';
      console.warn('[account] delete failed:', msg);
      setErr(
        /404|not found|unavailable/i.test(msg)
          ? `Self-service deletion isn’t available on this server yet. Email ${LEGAL_CONTACT} and your account will be deleted.`
          : `Couldn’t delete the account. Try again, or email ${LEGAL_CONTACT} and it will be deleted for you.`,
      );
      setBusy(false);
    }
  };

  return (
    // `danger`: the frame itself marks the one irreversible panel (design review 08-05), and the
    // key sentence leads rather than closing an eleven-item list
    <div className="ds-panel danger">
      <div className="ds-panel-h">
        <h3 className="ds-panel-title">Delete account</h3>
      </div>
      <div className="ds-panel-body stack">
        <p>
          <strong>This cannot be undone.</strong>
        </p>
        <p className="ds-hint">
          Permanently deletes your profile, username, saved settings and robot presets, records
          and practice runs with their replays, ranked rating and history, your playtime and
          account standing, and every friendship, block, and invite.
        </p>
        <p className="ds-hint">
          Matches you played stay on other players' history without your name, and payment records
          are kept (without your email) because they are financial records. Your sign-in identity
          itself lives with our authentication provider. Delete it there too if you want it gone.
        </p>
        <div className="ds-claim-row">
          <input
            className="ds-input"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Type DELETE to confirm"
            aria-label="Type DELETE to confirm account deletion"
          />
          <button
            className={`ds-btn danger${busy ? ' busy' : ''}`}
            disabled={busy || confirm !== 'DELETE'}
            aria-busy={busy}
            onClick={() => void doDelete()}
          >
            Delete my account
          </button>
        </div>
        {err && (
          <p className="ds-hint err" role="status">
            {err}
          </p>
        )}
      </div>
    </div>
  );
}

function Identity() {
  const client = authClient!;
  const session = client.useSession();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const user = session.data?.user;

  /** the flash is driven by whether the text ACTUALLY landed — see `copyText`: the
   *  clipboard API is absent on a plain-http LAN page, and "Copied" over a copy that
   *  never happened is worse than no button. */
  const copyId = (): void => {
    if (!user?.id) return;
    copyText(user.id, (ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        <h2 className="ds-panel-title">Account</h2>
        {session.isPending && <span className="ds-chip">…</span>}
      </div>
      {user ? (
        <div className="ds-panel-body stack">
          {/* TWO ROWS OF ONE SHAPE — label · value · action (design review 08-15). The email
              was bold ink, "Password" a hint, and the Account ID a hint over a code line. */}
          <div className="ds-acct-row">
            <span className="lbl">Email</span>
            <span className="ds-acct-email">{user.email ?? 'signed in'}</span>
            <button className="ds-btn ghost small" onClick={() => client.signOut()}>
              Sign out
            </button>
          </div>
          {user.email && <PasswordRow email={user.email} />}
          {/* a SUPPORT identifier, not an identity fact — it folds (ui.md "rare controls fold") */}
          <details className="ds-fold inset">
            <summary>Support details</summary>
            <div className="ds-fold-body ds-acct-id">
            <p className="ds-hint">Account ID</p>
            <div className="ds-field-row">
              {/* not clickable: the Copy button beside it is the control (a click-only
                  <code> was mouse-only) */}
              <code className="ds-acct-uuid">
                {user.id}
              </code>
              <button
                type="button"
                className="ds-btn ghost small"
                onClick={copyId}
                title="Copy Account ID"
                aria-label="Copy Account ID"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            </div>
          </details>
        </div>
      ) : (
        <div className="ds-panel-body row">
          <p className="ds-hint">Sign in to save records and rank up.</p>
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

/**
 * PASSWORD — set one, or change it, with a code emailed to the account's own address
 * (`requestPasswordCode` / `setPasswordWithCode`, `src/lib/authFlows.ts`).
 *
 * THIS IS HOW A GOOGLE ACCOUNT GETS A PASSWORD, so it can sign in with its email as
 * well: the route creates the password login when there is none. The row reads the
 * account list to say which case it is in ("Set a password" vs "Change password"), and
 * says nothing definite while it cannot tell. A code rather than a form holding the old
 * password, because a Google account has no old password to type.
 */
function PasswordRow({ email }: { email: string }) {
  /** does the account have a password login? null while unknown */
  const [has, setHas] = useState<boolean | null>(null);
  const [step, setStep] = useState<'idle' | 'sending' | 'code' | 'saved'>('idle');
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let live = true;
    void hasPasswordLogin().then((v) => {
      if (live) setHas(v);
    });
    return () => {
      live = false;
    };
  }, []);

  const send = async (): Promise<void> => {
    // a resend from inside the form keeps the form (and the password typed into it)
    const resend = step === 'code';
    if (resend) setBusy(true);
    else setStep('sending');
    setMsg('');
    const r = await requestPasswordCode(email);
    setBusy(false);
    if (r.ok) {
      setCode('');
      if (!resend) setPw('');
      setStep('code');
    } else {
      setMsg(r.message);
      if (!resend) setStep('idle');
    }
  };

  const save = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMsg('');
    const r = await setPasswordWithCode(email, code, pw);
    setBusy(false);
    if (r.ok) {
      setHas(true);
      setStep('saved');
    } else {
      setMsg(r.message);
    }
  };

  const value =
    step === 'saved'
      ? 'Saved'
      : has === true
        ? 'Set'
        : has === false
          ? 'Not set'
          : '';
  return (
    <>
      <div className="ds-acct-row">
        <span className="lbl">Password</span>
        <span className="ds-hint">{value}</span>
        {step !== 'code' && (
          <button
            className={`ds-btn ghost small${step === 'sending' ? ' busy' : ''}`}
            disabled={step === 'sending'}
            aria-busy={step === 'sending'}
            onClick={() => void send()}
          >
            {has === false && step !== 'saved' ? 'Set a password' : 'Change password'}
          </button>
        )}
      </div>
      {has === false && step === 'idle' && (
        <p className="ds-hint">You sign in with Google. Set a password to sign in with {email} too.</p>
      )}
      {step === 'saved' && (
        <p className="ds-hint ok">You can now sign in with {email} and this password.</p>
      )}
      {step === 'code' && (
        <form className="ds-form ds-pwform" onSubmit={save}>
          <p className="ds-hint">We sent a code to {email}.</p>
          {/* the account's own address, for the password manager saving what is typed below */}
          <input className="ds-sr" type="email" autoComplete="username" value={email} readOnly tabIndex={-1} aria-hidden="true" />
          <label>
            <span>Code</span>
            <input
              className="ds-input code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={CODE_MAX}
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <label>
            <span>New password</span>
            <input
              className="ds-input"
              type="password"
              autoComplete="new-password"
              minLength={PASSWORD_MIN}
              required
              value={pw}
              onChange={(e) => setPw(e.target.value)}
            />
          </label>
          <div className={`ds-form-hint${msg ? ' err' : ''}`} role="alert">
            {msg || `At least ${PASSWORD_MIN} characters.`}
          </div>
          <div className="ds-field-row">
            <button className={`ds-btn primary${busy ? ' busy' : ''}`} type="submit" disabled={busy} aria-busy={busy}>
              {busy ? 'Saving…' : 'Save password'}
            </button>
            <button type="button" className="ds-btn ghost" onClick={() => void send()} disabled={busy}>
              Send a new code
            </button>
            <button type="button" className="ds-btn ghost" onClick={() => setStep('idle')} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {step !== 'code' && msg && <p className="ds-hint warn">{msg}</p>}
    </>
  );
}

/** the same panel the reset and verify screens show — see `AuthDisabled`. */
function IdentityDisabled() {
  return <AuthDisabled />;
}
