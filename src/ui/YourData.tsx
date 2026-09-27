import { useState } from 'react';
import {
  STORAGE_CATEGORY_BLURB,
  STORAGE_CATEGORY_LABEL,
  STORAGE_CATEGORY_ORDER,
  STORAGE_KEYS,
  storageKeysIn,
  type StorageCategory,
} from '../storageKeys';
import { analyticsEnabled } from '../analytics';
import { analyticsAllowed, setAnalyticsAllowed } from '../analyticsPref';
import { adsConfigured, cmpEnabled, showConsentSettings, AD_TFUAC } from '../ads/adsense';
import { authClient, authEnabled } from '../lib/authClient';
import { ExportUnavailableError, fetchMyExport } from '../net/api';
import { LEGAL_CONTACT } from '../legalText';
import { DeleteAccount } from './Account';
import { saveBlob } from './saveBlob';

/**
 * "YOUR DATA" — the working half of the privacy page.
 *
 * The policy above it says what is collected; this says what you can DO about it, and the two
 * are on one page deliberately. A rights section that ends in "email us" is a promise; the
 * same section with four controls in it is a feature, and the difference is the whole point of
 * this surface.
 *
 * THE INVENTORY IS GENERATED, never typed out. `PRIVACY_MD` used to enumerate the storage keys
 * in prose and had drifted badly — four of the names it listed did not exist and seven real
 * keys were missing — so the policy now describes the CATEGORIES and points here, and the table
 * is rendered straight off `STORAGE_KEYS`. Adding a key publishes it; `npm test` refuses a key
 * that is not in the registry. See `src/storageKeys.ts` for the two rules that hold that up.
 *
 * ⚠️ EVERY ROW RENDERS SIGNED OUT. The whole sim is playable without an account and the
 * AdSense review fetches `/privacy` directly, so nothing here may depend on a session existing.
 * The two rows that genuinely need one — export and delete — SAY they need one, and say what
 * they would do. A control that vanishes tells a visitor nothing; the same control with a
 * reason beside it tells them where they stand.
 */
export function YourData() {
  return (
    <>
      <h2 className="ds-h2 yd-head" id="your-data">
        Your data
      </h2>
      <p className="ds-sub">
        The controls behind the policy above. Everything except the last two works without an
        account.
      </p>

      <StorageInventory />
      <AnalyticsRow />
      <AdsRow />
      <ExportRow />
      <DeleteRow />
    </>
  );
}

/**
 * WHAT THIS BROWSER IS HOLDING, grouped by category, rendered from the registry.
 *
 * One table per category rather than one table with a category column, because the grouping IS
 * the answer to the question a visitor arrives with — "which of these can I refuse and still
 * play" — and a sortable column would hide it behind an interaction. The `analytics` group is
 * printed even though it is EMPTY, with "None" in it: that absence is the most reassuring line
 * on the page, and it stays true by construction because it is derived rather than written.
 */
function StorageInventory() {
  return (
    <section className="ds-panel">
      <div className="ds-panel-h">
        <h3 className="ds-panel-title">Stored on this device</h3>
        <span className="ds-count">{STORAGE_KEYS.length}</span>
      </div>
      <div className="ds-panel-body stack">
        <p className="ds-hint">
          DSIM sets no cookies. These are the keys it writes to your browser’s own storage.
          Clearing your browser data for this site removes all of them; nothing here is
          transmitted unless the row says so.
        </p>
      </div>
      {STORAGE_CATEGORY_ORDER.map((cat) => (
        <StorageGroup key={cat} cat={cat} />
      ))}
    </section>
  );
}

function StorageGroup({ cat }: { cat: StorageCategory }) {
  const rows = storageKeysIn(cat);
  return (
    <>
      <div className="yd-group">
        <span className="yd-group-name">{STORAGE_CATEGORY_LABEL[cat]}</span>
        <span className="ds-hint">{STORAGE_CATEGORY_BLURB[cat]}</span>
      </div>
      {rows.length === 0 ? (
        <div className="ds-panel-body">
          <p className="ds-hint">None. DSIM stores nothing on your device for this purpose.</p>
        </div>
      ) : (
        /* `.ds-panel` clips for its rounded corners, so a table wider than a phone needs its
           own scroller or its right-hand columns are simply gone — the same fix `.ds-table-scroll`
           carries on match history. */
        <div className="ds-table-scroll">
          <table className="ds-table yd-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>What it is for</th>
                <th>Kept until</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.key}>
                  <td>
                    <code className="yd-key">{e.key}</code>
                    <span className="yd-store">
                      {e.storage === 'session' ? 'Session storage' : 'Local storage'}
                    </span>
                  </td>
                  <td>{e.purpose}</td>
                  <td className="yd-keep">{e.retention}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/**
 * ANALYTICS — on by default, and the row says why rather than leaving somebody to wonder.
 *
 * Reads through `analyticsAllowed()` on mount and writes through `setAnalyticsAllowed`, both in
 * `src/analytics.ts`, which is also where `trackEvent` reads it — so the switch and the thing it
 * switches cannot disagree. No round trip and no optimistic state: it is a local write, so it
 * either happened or storage is unavailable, and in the second case the live session still
 * honours the value for as long as the tab is open.
 *
 * `analyticsEnabled()` is the BUILD constant. A self-hosted or desktop build sends nothing at
 * all, and the row says that instead of offering a switch over nothing.
 */
function AnalyticsRow() {
  const [on, setOn] = useState(() => analyticsAllowed());
  const built = analyticsEnabled();

  return (
    <section className="ds-panel">
      <div className="ds-panel-h">
        <h3 className="ds-panel-title">Analytics</h3>
      </div>
      <div className="ds-panel-body stack start">
        <label className="ds-checkline">
          <input
            type="checkbox"
            checked={on}
            disabled={!built}
            onChange={(e) => {
              setAnalyticsAllowed(e.target.checked);
              setOn(e.target.checked);
            }}
          />
          <span>Send anonymous usage counts</span>
        </label>
        <p className="ds-hint">
          On by default, because it is cookieless and carries no identifiers: no user id,
          username, email or ad id, nothing that could link two visits. It counts pages reached,
          downloads taken and whether an ad rendered, which is what the presenting sponsor’s
          monthly numbers are read off. Your browser’s Do Not Track or Global Privacy Control
          signal switches it off on its own.
        </p>
        {/* the mechanism, folded (design review 08-20): true and worth publishing, but it is
            the answer to a second question, not what the switch does */}
        <details className="ds-fold inset">
          <summary>How a visit is counted</summary>
          <div className="ds-fold-body">
            <p className="ds-hint">
              Your browser is given nothing to remember: our server mixes your address and browser
              with a secret that is regenerated every day, keeps a short one-way fingerprint, and
              destroys the secret two days later. The same person on two days is two visitors,
              and nothing we hold can join them.
            </p>
          </div>
        </details>
        {!built && (
          <p className="ds-hint">
            This build sends no analytics at all, so the switch above does nothing here. The
            desktop app and self-hosted builds are never measured.
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * THE COPY FOR "there is no consent dialog to reopen", in one place.
 *
 * Exported because the footer's "Data" link (was "Privacy & cookie settings") used to DELETE ITSELF when
 * `showConsentSettings()` answered false, which is the normal case outside the EEA/UK/CH — so
 * the one control the privacy policy names by name would silently not exist for most of the
 * world, and the only way to find that out was to read the source. The link now lands here
 * instead, and this is the sentence it lands on.
 */
export const CONSENT_UNAVAILABLE =
  'Consent settings are provided by Google’s consent tool, and there is no consent to withdraw in your region or on this build. Where the tool does apply (the UK, the EEA and Switzerland), this button reopens it.';

/**
 * ADS PERSONALISATION — a door to Google's consent tool, plus the facts that are true whether
 * or not the tool opens.
 *
 * Three states, and the point of the row is that NONE of them is "nothing here":
 *
 *  1. this build ships no ads at all (desktop, touch, or no publisher id) — say so;
 *  2. a CMP is loaded and has a revocation entry — the button reopens it;
 *  3. a CMP is loaded and has none, because the visitor is outside the regions the message
 *     targets — the button was pressed, nothing opened, and the row says why.
 *
 * `showConsentSettings()` is the only way to find out which of 2 and 3 you are in: the entry
 * point exists only once Funding Choices has loaded AND the visitor is in a targeted region, so
 * it cannot be known before the click. Hence a button that reports its own failure rather than a
 * button that is disabled on a guess.
 */
function AdsRow() {
  const [tried, setTried] = useState(false);
  const cmp = cmpEnabled();

  return (
    <section className="ds-panel">
      <div className="ds-panel-h">
        <h3 className="ds-panel-title">Ads and cookies</h3>
      </div>
      <div className="ds-panel-body stack start">
        <p className="ds-hint">
          DSIM sets no cookies of its own. Where the web version shows advertising, Google
          AdSense and its partners may set cookies or read a device identifier to serve and
          measure ads. Ads are <strong>non-personalised by default</strong>
          {AD_TFUAC ? ', and every request is tagged as being for a user below the age of consent'
            : ''}
          , because this is a simulator for a school competition and most of the people driving
          it are not signed in. No ads are shown in the desktop app, on touch devices, or to
          supporters.
        </p>
        {!adsConfigured() && !cmp && (
          <p className="ds-hint">
            This build shows no advertising, so there is nothing here to consent to.
          </p>
        )}
        {cmp && (
          <button
            className="ds-btn"
            onClick={() => {
              if (!showConsentSettings()) setTried(true);
            }}
          >
            Open consent settings
          </button>
        )}
        {cmp && tried && (
          <p className="ds-hint" role="status">
            {CONSENT_UNAVAILABLE}
          </p>
        )}
        <p className="ds-hint">
          You can review Google’s own ad settings at{' '}
          <a href="https://adssettings.google.com" target="_blank" rel="noreferrer">
            adssettings.google.com
          </a>
          .
        </p>
      </div>
    </section>
  );
}

/** `YYYY-MM-DD` in the viewer's own timezone — a filename, not a timestamp, so local is right */
function today(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * EXPORT — one authenticated GET, handed to the browser as a file.
 *
 * `URL.createObjectURL` over a Blob, matching `src/ui/replayVideo.ts`, rather than pointing an
 * `<a href>` at the route: the request needs a Bearer token, and a plain link cannot carry one.
 * The URL is revoked in a `finally` — an object URL pins its Blob in memory for the life of the
 * document, and this Blob is the whole of somebody's account history.
 *
 * The three failures are distinguished because they need three different next steps: a rate
 * limit means wait (the server's own message says so), an old server means this deploy cannot do
 * it yet, and anything else falls back to the promise that can always be kept — a person
 * answering the mailbox. That is the same ladder `DeleteAccount` climbs, for the same reason.
 */
function ExportRow() {
  const session = authEnabled ? authClient!.useSession() : null;
  const signedIn = !!session?.data?.user;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; err: boolean } | null>(null);

  const run = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const data = await fetchMyExport();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      // `saveBlob` owns the object URL's lifetime: revoking it here, right after the click,
      // could cut the download off before the browser had taken the blob
      saveBlob(blob, `dsim-export-${today()}.json`);
      setMsg({ text: 'Downloaded.', err: false });
    } catch (e) {
      // Only the rate limit's own sentence is written for a person; anything else is logged
      // and answered with the mailbox.
      const raw = e instanceof Error ? e.message : '';
      if (!(e instanceof ExportUnavailableError)) console.warn('[export] failed:', raw);
      const text =
        e instanceof ExportUnavailableError
          ? `This server can’t build an export yet. Email ${LEGAL_CONTACT} and you will be sent one.`
          : /^One export a minute/.test(raw)
            ? raw
            : `Couldn’t build the export. Email ${LEGAL_CONTACT} and you will be sent one.`;
      setMsg({ text, err: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ds-panel">
      <div className="ds-panel-h">
        <h3 className="ds-panel-title">Export my data</h3>
      </div>
      <div className="ds-panel-body stack start">
        <p className="ds-hint">
          Everything the servers hold for your account, as one JSON file. Other players are left
          out: a match you played is in there as your own result and the final score.
        </p>
        {signedIn ? (
          <>
            <button className="ds-btn primary" disabled={busy} onClick={() => void run()}>
              {busy ? 'Building…' : 'Export my data'}
            </button>
            {msg && (
              <p className={msg.err ? 'ds-hint err' : 'ds-hint ok'} role="status">
                {msg.text}
              </p>
            )}
          </>
        ) : (
          <p className="ds-hint">
            Sign in to export. Signed out, everything DSIM has is the browser storage listed
            above.
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * DELETE — the real flow when there is a session, an explanation when there is not.
 *
 * ⚠️ THE SESSION CHECK IS HERE AND NOT INSIDE `DeleteAccount`, which is the bug this shape
 * exists to avoid. That component returns null without a session — correct on the Profile page,
 * where the whole page is already behind a sign-in panel — so gating on `authEnabled` alone
 * left a signed-out visitor to an auth-ENABLED build with no delete row at all: not the flow,
 * not the explanation, just a missing section. That is the same disappearing act the footer
 * consent link was doing, one panel further down the page.
 */
function DeleteRow() {
  const session = authEnabled ? authClient!.useSession() : null;
  return session?.data?.user ? <DeleteAccount /> : <DeleteUnavailable />;
}

/** what the delete row says to somebody who is not signed in — what it WOULD do, and the
 *  mailbox for anyone who cannot get back into the account they want removed. */
function DeleteUnavailable() {
  return (
    <section className="ds-panel">
      <div className="ds-panel-h">
        <h3 className="ds-panel-title">Delete account</h3>
      </div>
      <div className="ds-panel-body stack start">
        <p className="ds-hint">
          Sign in to delete your account. It removes your profile, username, settings, robot
          presets, records and practice runs with their replays, rating and rating history, and
          every friendship, block and invite, immediately and permanently. Email{' '}
          {LEGAL_CONTACT} if you cannot sign in and it will be done by hand.
        </p>
      </div>
    </section>
  );
}
