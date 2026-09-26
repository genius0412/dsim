import { useState, type FormEvent } from 'react';
import { authClient, clearAuthToken } from '../lib/authClient';
import {
  CODE_MAX,
  normalizeCode,
  requestEmailVerification,
  verifyEmailCode,
} from '../lib/authFlows';

/**
 * Fired on `window` when a code is accepted, wherever the form was. The App listens and
 * drains the practice-upload backlog, which a refused save left waiting.
 */
export const EMAIL_VERIFIED_EVENT = 'dsim:email-verified';

/**
 * The code from the verification email, and the button that spends it.
 *
 * Neon Auth sends a CODE, not a link (see `authFlows.ts`), so this is the one
 * place an address actually gets verified: the Profile banner, the dialog right
 * after sign-up, and `/account/verify` all render it.
 *
 * On success the cached JWT is dropped, for the reason `AccountVerify` gives: it
 * was minted before the address was verified and still says so, and it is the
 * token the server's gate reads. The session itself refreshes on its own —
 * the SDK's email-OTP client signals the session store on this route — which is
 * what makes the banner disappear.
 */
export function VerifyCodeForm({
  email,
  onVerified,
  id = 'ds-verify-code',
}: {
  email: string;
  onVerified?: () => void;
  /** the input's id; two forms can be on one screen (the banner and the dialog) */
  id?: string;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const r = await verifyEmailCode(email, code);
    setBusy(false);
    if (r.ok) {
      clearAuthToken();
      window.dispatchEvent(new Event(EMAIL_VERIFIED_EVENT));
      onVerified?.();
    } else {
      setError(r.message);
    }
  };

  return (
    <form className="ds-verifycode" onSubmit={submit}>
      <label htmlFor={id} className="ds-sr">
        Verification code
      </label>
      <div className="ds-field-row">
        <input
          id={id}
          className="ds-input code grow"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="Code"
          maxLength={CODE_MAX}
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            if (error) setError('');
          }}
          aria-invalid={!!error}
          aria-describedby={`${id}-msg`}
        />
        <button
          className={`ds-btn primary${busy ? ' busy' : ''}`}
          type="submit"
          disabled={busy || !normalizeCode(code)}
          aria-busy={busy}
        >
          {busy ? 'Verifying…' : 'Verify'}
        </button>
      </div>
      <div id={`${id}-msg`} className={`ds-form-hint${error ? ' err' : ''}`} role="alert">
        {error}
      </div>
    </form>
  );
}

/**
 * THE CODE FORM WHERE A REFUSAL HAPPENS — the ranked queue, the record card, Practice replays.
 *
 * With a Send button, because a verification code expires in minutes: somebody refused
 * today most likely signed up days ago, and the only code they have is dead. Renders
 * nothing when accounts are off or nobody is signed in.
 */
export function VerifyEmailInline({ onVerified }: { onVerified?: () => void }) {
  return authClient ? <Inline onVerified={onVerified} /> : null;
}

function Inline({ onVerified }: { onVerified?: () => void }) {
  const session = authClient!.useSession();
  const email = session.data?.user?.email ?? '';
  const [send, setSend] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [sendError, setSendError] = useState('');
  if (!email) return null;

  const sendCode = async (): Promise<void> => {
    if (send === 'sending') return;
    setSend('sending');
    setSendError('');
    const r = await requestEmailVerification(email);
    if (r.ok) setSend('sent');
    else {
      setSendError(r.message);
      setSend('error');
    }
  };

  return (
    <div className="ds-verifyinline">
      <p className="ds-hint">
        {send === 'sent'
          ? `A new code is on its way to ${email}.`
          : `Enter the code we emailed to ${email}, or send a new one.`}
      </p>
      <VerifyCodeForm email={email} onVerified={onVerified} id="ds-inline-code" />
      <div className="ds-field-row">
        <button
          type="button"
          className={`ds-btn ghost small${send === 'sending' ? ' busy' : ''}`}
          onClick={() => void sendCode()}
          disabled={send === 'sending'}
          aria-busy={send === 'sending'}
        >
          Send a new code
        </button>
        {send === 'error' && <span className="ds-hint err">{sendError}</span>}
      </div>
    </div>
  );
}
