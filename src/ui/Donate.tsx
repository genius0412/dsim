import { useState } from 'react';
import { APP_NAME, LINKS } from '../seasons';
import { claimKofiPayment } from '../net/api';
import { useAds } from '../ads/AdsProvider';
import { authEnabled } from '../lib/authClient';

/**
 * Donate / supporter page.
 *
 * Payment happens entirely on Ko-fi — we never touch card details, and there is
 * no checkout to build. What lives here is the CLAIM step: Ko-fi identifies a
 * buyer by the email they paid with, which frequently is not the email on their
 * DSIM account (a student paying through a parent's PayPal is the ordinary case,
 * not the edge case). Rather than guess at a match, the buyer pastes the
 * transaction id Ko-fi gave them and the server attaches the payment.
 *
 * Perks are deliberately cosmetic or convenience. Nothing here may affect how a
 * robot drives or scores — that is a product rule, stated in the terms, and it
 * is the reason a ranked opponent never has to wonder whether they were outspent.
 */
export function Donate({ signedIn }: { signedIn: boolean }) {
  const { supporter, checked } = useAds();
  const [txn, setTxn] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const claim = async (): Promise<void> => {
    const id = txn.trim();
    if (!id || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await claimKofiPayment(id);
      const until = r.supporterUntil ? new Date(r.supporterUntil).toLocaleDateString() : null;
      setMsg({
        kind: 'ok',
        text: until
          ? `Thank you — you're a supporter until ${until}. Ads are off.`
          : 'Thank you — your supporter benefits are active.',
      });
      setTxn('');
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : 'Something went wrong.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="ds-eyebrow">{APP_NAME} · Support</p>
      <h1 className="ds-h1">Support DSIM</h1>
      <p className="ds-sub">
        DSIM is free and stays free. Servers and a database are not — this is what keeps them
        running.
      </p>

      {checked && supporter && (
        <section className="ds-panel">
          <div className="ds-panel-h">
            <span className="ds-panel-title">You're a supporter</span>
            <span className="ds-count">thank you</span>
          </div>
          <div style={{ padding: 16 }}>
            <p className="ds-hint">
              Ads are off across the site and your badge is live. Manage or cancel the membership
              any time from your Ko-fi account.
            </p>
          </div>
        </section>
      )}

      <section className="ds-panel">
        <div className="ds-panel-h">
          <span className="ds-panel-title">Supporter</span>
          <span className="ds-count">monthly</span>
        </div>
        <div style={{ padding: 16 }}>
          <ul className="ds-perks">
            <li>No advertising, anywhere on the site</li>
            <li>A supporter badge on your profile and the leaderboards</li>
            <li>Extra saved start-position slots</li>
            <li>Cosmetic robot colours</li>
          </ul>
          <p className="ds-hint" style={{ marginTop: 12 }}>
            Supporter perks are cosmetic or convenience only. They never affect how a robot drives
            or scores — ranked stays decided by driving.
          </p>
          <a
            className="ds-cta"
            href={LINKS.kofi}
            target="_blank"
            rel="noreferrer"
            style={{ marginTop: 16 }}
          >
            Support on Ko-fi ↗
          </a>
        </div>
      </section>

      <section className="ds-panel">
        <div className="ds-panel-h">
          <span className="ds-panel-title">Already paid?</span>
          <span className="ds-count">claim it</span>
        </div>
        <div style={{ padding: 16 }}>
          <p className="ds-hint">
            Ko-fi bills through PayPal, so the email on your payment often isn't the one on your
            DSIM account. Paste the transaction ID from your Ko-fi receipt and we'll attach it.
          </p>
          {!authEnabled || !signedIn ? (
            <p className="ds-hint" style={{ marginTop: 12 }}>
              Sign in first — a membership has to attach to an account.
            </p>
          ) : (
            <>
              <div className="ds-claim-row">
                <input
                  className="ds-input"
                  value={txn}
                  onChange={(e) => setTxn(e.target.value)}
                  placeholder="Ko-fi transaction ID"
                  aria-label="Ko-fi transaction ID"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void claim();
                  }}
                />
                <button className="ds-btn primary" onClick={() => void claim()} disabled={busy || !txn.trim()}>
                  {busy ? 'Checking…' : 'Claim'}
                </button>
              </div>
              {msg && (
                <p className={`ds-claim-msg ${msg.kind}`} role="status">
                  {msg.text}
                </p>
              )}
            </>
          )}
        </div>
      </section>

      <section className="ds-panel">
        <div className="ds-panel-h">
          <span className="ds-panel-title">One-off</span>
          <span className="ds-count">no account needed</span>
        </div>
        <div style={{ padding: 16 }}>
          <p className="ds-hint">
            Prefer to just buy the project a coffee? One-off tips go through the same Ko-fi page and
            take 0% in fees. No membership, nothing to claim.
          </p>
        </div>
      </section>
    </>
  );
}
