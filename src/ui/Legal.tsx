import { Markdown } from './markdown';
import { PRIVACY_MD, TERMS_MD, LEGAL_UPDATED, LEGAL_IDENTIFIED, LEGAL_CONTACT } from '../legalText';
import { YourData } from './YourData';

/**
 * Privacy policy + terms pages. Both are the same shape — a title, a
 * "last updated" line, and one long Markdown body — so they share `LegalPage` and
 * differ only in their copy (`src/legalText.ts`).
 *
 * These render inside the app shell's `.ds-main`, so they return page content only.
 * The `.legal-md` class widens and enlarges the base `.md` type, which is tuned for
 * short announcement cards and reads too tight for a document this long.
 *
 * A live privacy policy is a prerequisite for the AdSense application, so this page
 * must stay reachable without an account and without JavaScript-gated routing.
 */
function LegalPage({ title, sub, body }: { title: string; sub?: string; body: string }) {
  return (
    <>
      <h1 className="ds-h1">{title}</h1>
      {/* `sub` is OPTIONAL, because most of the time it is the title said again
          as a sentence. Only keep one where it carries something the heading
          cannot — Privacy's "how to get rid of it" does; Terms' did not. The
          "Updated" date is the part that always earns the line. */}
      <p className="ds-sub">
        {sub ? `${sub} ` : ''}Updated {LEGAL_UPDATED}.
      </p>

      <section className="ds-panel ds-legal-card">
        {/* `.ds-panel-body`, not the one-off `.ds-legal` — the two were the same
            16px, written twice. `.legal-md` still owns the DOCUMENT's own rhythm
            inside it; only the container padding is shared. */}
        <div className="ds-panel-body">
          {/* baseLevel 1: the body's `##` sections are h2 under this page's h1 */}
          <Markdown text={body} className="md legal-md" baseLevel={1} />
        </div>
      </section>
    </>
  );
}

/**
 * The policy, then the CONTROLS (`src/ui/YourData.tsx`): the storage inventory generated from
 * `src/storageKeys.ts`, the analytics switch, the ad-consent door, an export and a delete.
 *
 * One page rather than a settings screen of its own, for two reasons. The policy makes promises
 * ("there is a Delete account button", "you have a right of portability") and the shortest
 * distance between a promise and the thing that keeps it is nothing at all. And this is the URL
 * a reviewer, a regulator or a parent is given — it is already the page people arrive at with a
 * question, so it should be the page that answers it.
 */
export function Privacy() {
  // A DEEP LINK to a section (`/privacy#your-data`, the documented fallback for the footer's "Data"
  // link) is followed by the shell (`pageScroll.ts`): the browser looks for the anchor on the initial
  // load, before React has rendered it, and finds nothing.
  return (
    <div className="ds-legal-col">
      <LegalPage
        title="Privacy Policy"
        sub="What DSIM collects, why, and how to get rid of it."
        body={PRIVACY_MD}
      />
      <YourData />
    </div>
  );
}

export function Terms() {
  return (
    <>
      {/* A contract that names no party and no governing law is not finished, and
          the failure mode is silent — it renders as a perfectly normal-looking
          page with two bracketed placeholders that everyone's eye slides past.
          This makes it impossible to miss, and it is deliberately visible to
          EVERY visitor rather than dev-only: if it ships unfilled, the person who
          most needs to see it is whoever is about to pay. */}
      {!LEGAL_IDENTIFIED && (
        <p className="legal-warn" role="alert">
          These terms are incomplete: the operator and governing law have not been
          filled in yet. Don’t rely on them. Email {LEGAL_CONTACT} with any question
          about your account or a payment.
        </p>
      )}
      <div className="ds-legal-col">
        <LegalPage title="Terms of Use" body={TERMS_MD} />
      </div>
    </>
  );
}
