import { useEffect, useRef, useState } from 'react';
import { authClient, authEnabled, clearAuthToken } from '../lib/authClient';
import {
  completeEmailVerification,
  requestEmailVerification,
  type AuthFlowResult,
} from '../lib/authFlows';
import { AuthDisabled } from './AuthDisabled';
import { ENTRY_TOKEN } from './entryToken';
import { VerifyCodeForm } from './VerifyCodeForm';

/**
 * `/account/verify` — where the verification email's link lands, and where the
 * CODE is entered when there is no link. Neon Auth sends a code (see
 * `authFlows.ts`), so without a token this page is the code form, not a dead end.
 *
 * It verifies on MOUNT rather than behind a button: the person already clicked
 * something, and a screen that asks them to click a second time to do the thing
 * the first click was for is a worse version of the same page.
 *
 * ⚠️ IT RUNS EXACTLY ONCE. The token is spent by the first call, so React 18's
 * StrictMode double-invoked effect would fire a second one against a token that no
 * longer exists and paint the success screen red. A ref, not a state flag — state
 * is reset with the remount, a ref is not.
 *
 * On success the cached JWT is dropped: it was minted before the address was
 * verified and still says so, and it is the token the ranked gate reads. Without
 * this, somebody who verified mid-session would keep being refused for up to an
 * hour by a claim that had already stopped being true.
 */
export function AccountVerify({ onAccount }: { onAccount: () => void }) {
  return (
    <>
      <h1 className="ds-h1">Verify your email</h1>
      {!authEnabled ? <AuthDisabled /> : <Verify onAccount={onAccount} />}
    </>
  );
}

function Verify({ onAccount }: { onAccount: () => void }) {
  const session = authClient!.useSession();
  const email = session.data?.user?.email ?? '';
  const [result, setResult] = useState<AuthFlowResult | null>(null);
  const [resend, setResend] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [resendError, setResendError] = useState('');
  /** the code form succeeded on this page */
  const [coded, setCoded] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current || !ENTRY_TOKEN) return;
    started.current = true;
    void completeEmailVerification(ENTRY_TOKEN).then((r) => {
      if (r.ok) clearAuthToken(); // the cached JWT predates the verified flag
      setResult(r);
    });
  }, []);

  const sendAgain = async (): Promise<void> => {
    if (resend === 'sending' || !email) return;
    setResend('sending');
    setResendError('');
    const r = await requestEmailVerification(email);
    if (r.ok) setResend('sent');
    else {
      setResendError(r.message);
      setResend('error');
    }
  };

  const sendAgainButton = email && resend !== 'sent' && (
    <button
      className={`ds-btn${resend === 'sending' ? ' busy' : ''}`}
      onClick={sendAgain}
      disabled={resend === 'sending'}
      aria-busy={resend === 'sending'}
    >
      Send a new code
    </button>
  );
  const resendStatus = (
    <>
      {resend === 'sent' && <p className="ds-hint ok">A new code is on its way to {email}.</p>}
      {resend === 'error' && <p className="ds-hint err">{resendError}</p>}
    </>
  );

  // no token: the code path, which is the one Neon Auth actually sends
  if (!ENTRY_TOKEN && !coded) {
    if (session.isPending) return <div className="ds-loading">Loading…</div>;
    if (!email) {
      return (
        <div className="ds-panel">
          <div className="ds-panel-h">
            <span className="ds-panel-title">Sign in to verify</span>
          </div>
          <div className="ds-panel-body stack start">
            <p className="ds-hint">Sign in, then enter the code from the verification email.</p>
          </div>
        </div>
      );
    }
    if (session.data?.user?.emailVerified !== false) return <Verified email={email} onAccount={onAccount} />;
    return (
      <div className="ds-panel">
        <div className="ds-panel-h">
          <span className="ds-panel-title">Enter your code</span>
        </div>
        <div className="ds-panel-body stack start">
          <p className="ds-hint">We sent a code to {email}.</p>
          <VerifyCodeForm email={email} onVerified={() => setCoded(true)} />
          {sendAgainButton}
          {resendStatus}
        </div>
      </div>
    );
  }
  if (coded) return <Verified email={email} onAccount={onAccount} />;

  if (!result) {
    return (
      <div className="ds-panel">
        <div className="ds-panel-h">
          <span className="ds-panel-title">Verifying</span>
        </div>
        <div className="ds-loading">Checking your link…</div>
      </div>
    );
  }

  if (result.ok) return <Verified email={email} onAccount={onAccount} />;

  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        <span className="ds-panel-title">Couldn’t verify that link</span>
      </div>
      <div className="ds-panel-body stack start">
        <p className="ds-hint err">{result.message}</p>
        {result.reason === 'invalid-token' && (
          <p className="ds-hint">
            Verification links work once. If you have already followed this one, your address is
            verified.
          </p>
        )}
        {email && <VerifyCodeForm email={email} onVerified={() => setCoded(true)} />}
        {sendAgainButton}
        {resendStatus}
        <button className="ds-btn ghost" onClick={onAccount}>
          Go to Profile
        </button>
      </div>
    </div>
  );
}

function Verified({ email, onAccount }: { email: string; onAccount: () => void }) {
  return (
    <div className="ds-panel">
      <div className="ds-panel-h">
        <span className="ds-panel-title">Email verified</span>
      </div>
      <div className="ds-panel-body stack start">
        <p className="ds-hint">{email ? `${email} is verified.` : 'Your address is verified.'}</p>
        <button className="ds-btn primary" onClick={onAccount}>
          Go to Profile
        </button>
      </div>
    </div>
  );
}
