/**
 * Legal page copy — privacy policy + terms of use.
 *
 * Kept as template-literal strings (the `src/contributors.ts` / `src/download.ts`
 * data-module convention) and rendered by the zero-dep `Markdown` component in
 * `src/ui/markdown.tsx`. That renderer downshifts headings (`#` -> h3), so these
 * documents start at `##` and sit under the page's own `.ds-h1`.
 *
 * The supported markdown subset is narrow: headings, paragraphs, bullets, **bold**,
 * *italic*, `code`, [links](url), and `---` rules. No tables, no blockquotes, no
 * code fences — keep to that subset or it renders as literal text.
 *
 * ACCURACY IS LOAD-BEARING. The data inventory below was written against the real
 * schema (`server/db/migrations/`) and the real localStorage keys. If you add a
 * table, a synced field, or a third-party service, update the matching section —
 * a policy that misdescribes what you collect is worse than no policy at all.
 */

/** last substantive revision — shown on both pages */
export const LEGAL_UPDATED = 'July 20, 2026';

/** where privacy / data-deletion requests go */
export const LEGAL_CONTACT = 'genius0412.tech@gmail.com';

export const PRIVACY_MD = `
DSIM is a free FTC driver-practice simulator. This policy explains what the app
collects, why, and what you can do about it. It is written to be read, not to be
skimmed past — it is short because the app genuinely collects very little.

## The short version

You can play the entire single-player simulator **without an account and without
sending us anything**. Signing in is only required for multiplayer, leaderboards,
and saved records. If you never sign in, everything below about accounts simply
does not apply to you.

## What is stored on your own device

These live in your browser's local storage and are never transmitted unless you
sign in and enable account sync:

- **Settings** (\`decodesim.settings.v1\`) — robot builds, control bindings, assists,
  audio and start-position preferences.
- **Theme** (\`decodesim.theme\`) — light or dark.
- **Session scratch** (\`decodesim.active\`, \`decodesim.chain\`, \`decodesim.friends\`,
  \`decodesim.seen\`) — which match you were in, and which announcements you have read.

Clearing your browser data removes all of it. There is no recovery, and we keep no
copy unless you were signed in.

## What is stored on our servers

Only if you create an account:

- **Identity** — your email address and display name, handled by our authentication
  provider. If you sign in with Google, we receive your email and name from Google;
  we never see your Google password.
- **Profile** — your chosen username and public handle.
- **Settings** — the same settings blob described above, so your setup follows you
  between devices.
- **Gameplay records** — scores, game mode, drivetrain, and timestamps for record
  runs and ranked matches.
- **Replays** — the random seed, robot configurations, and per-tick inputs needed to
  reconstruct a match. A replay contains no personal information beyond the robot
  setups and the account it belongs to.
- **Ranking** — your Glicko-2 rating, deviation, and match history.
- **Social** — friend requests, friendships, blocks, room invites, and an online or
  last-seen status if you use those features.
- **Robot presets** — the names and specifications you save.

Our game servers also process your IP address to route your connection, as any
network service must. It is not stored in the database or used to build a profile.

## Advertising

The web version of DSIM shows advertising served by **Google AdSense**. Google and
its partners may use cookies and similar technologies to serve ads and measure
their performance. This may include ads based on your prior visits to this or other
websites.

You can opt out of personalised advertising through
[Google's Ads Settings](https://adssettings.google.com), and review how Google uses
data from sites that use its services at
[policies.google.com/technologies/partner-sites](https://policies.google.com/technologies/partner-sites).

Ads are **not** shown in the desktop application, and are **not** shown to
supporters.

## Payments

Supporter memberships and donations are processed by **Ko-fi**, which in turn uses
**PayPal**. Your payment details go to those services, never to us — we never see
or store a card number. We receive only enough information to associate a
supporter's benefit with an account.

## Who else touches your data

We use a small number of infrastructure providers, each acting on our behalf:

- **Neon** — database and authentication.
- **Fly.io** — the multiplayer game servers.
- **Vercel** — hosting for the website.
- **Google AdSense** — advertising on the web version.
- **Ko-fi** and **PayPal** — payments.

We do not sell your data, and we do not share it with anyone else.

## How long it is kept

Account data is kept while your account exists. Replays and records may be removed
at the end of a competitive season. Delete your account and the associated profile,
records, replays, ratings, presets, and social data are deleted with it.

## Your choices

- **See or correct your data** — most of it is visible on your profile and settings
  pages.
- **Delete everything** — email us and your account and its data will be removed.
- **Play anonymously** — simply do not sign in.

If you are in the UK, EU, or a jurisdiction with comparable law, you have rights of
access, correction, deletion, and portability. Email us and we will action the
request.

## Age

DSIM is intended for players aged **13 and over**. We do not knowingly collect
information from children under 13. If you believe a child under 13 has created an
account, email us and we will delete it.

## Changes

If this policy changes materially, the date at the top of the page changes and the
update is noted in the app's announcements.

## Contact

Questions, corrections, and deletion requests: **${LEGAL_CONTACT}**
`;

export const TERMS_MD = `
These terms cover your use of DSIM — the website, the multiplayer service, and the
desktop application. Using any of them means you accept what follows.

## Who can use DSIM

You must be **13 or older** to create an account. If you are under 18, you should
have a parent or guardian's permission, and they must be the one to make any
purchase.

## Your account

You are responsible for what happens under your account. Pick a username that is
not offensive, not impersonating someone else, and not misleading about your
affiliation with a team or organisation. We may reclaim usernames that break this.

## Fair play

DSIM runs a server-authoritative simulation, and ranked play depends on that being
respected. Do not modify the client to gain an advantage, automate play, exploit
bugs for rating, or deliberately disrupt other players' matches. Accounts that do
may lose their rating, their records, or their access.

## Supporter memberships

Supporter benefits are cosmetic or convenience features. **They do not confer any
competitive advantage**, and they never will — that is a deliberate design rule, not
a current limitation.

Memberships are billed monthly through Ko-fi and you can cancel at any time from
your Ko-fi account; cancelling stops future charges and you keep the benefit until
the paid period ends. Because the benefit is delivered immediately, payments are
generally non-refundable, but if something has gone wrong, email us — we would
rather fix it than argue about it.

## Your content

Robot names, usernames, and anything else you type stay yours. You give us
permission to display them where you would expect: leaderboards, profiles, match
results, and replays.

## What we do not promise

DSIM is provided **as is**, free of charge for the parts that are free. We do not
guarantee it will be available, bug-free, or that records and ratings will survive
a season reset or a balance change. It is a practice tool, not a system of record.

To the fullest extent the law allows, we are not liable for indirect or
consequential loss arising from your use of it.

## Not affiliated with FIRST

DSIM is an independent, unofficial project. It is **not** affiliated with,
endorsed by, or sponsored by *FIRST*, FTC, RTX, or any of their partners. Game
names and rules are referenced for the purpose of simulating the competition.

## Ending things

You can stop using DSIM and delete your account at any time. We may suspend an
account that breaks these terms, and will say why where we reasonably can.

## Changes

Material changes to these terms are announced in the app, and the date at the top of
the page changes.

## Contact

**${LEGAL_CONTACT}**
`;
