/**
 * THE PRESENTING SPONSOR — `src/sponsor.ts` and every surface that renders it.
 *
 * ── WHY AN APP-LEVEL LANE LIVES IN THE BIOBUZZ SUITE ───────────────────────
 * It is not a game check, and it does not belong in `scripts/smoke.ts` for the
 * reason that file states about itself: a red `npm test` there must keep meaning
 * "the physics broke". This branch owns the sponsorship, so the sponsorship's
 * checks ride this branch's suite. If the deal outlives BIOBUZZ, move the lane —
 * it imports nothing from `src/games/biobuzz/`.
 *
 * ── WHAT IS WORTH CHECKING, AND WHAT IS NOT ────────────────────────────────
 * Everything here is a CONTRACTED obligation that FAILS SILENTLY. A placement
 * that quietly stops rendering, a link that loses its `utm_medium`, a term whose
 * dates do not cover the season it was sold for, an analytics event the report is
 * read off — none of these break a build, throw, or look wrong on screen, and all
 * of them are things we owe somebody. The way this goes wrong is nobody noticing
 * for a month, which is exactly the shape a crawler check is for.
 *
 * Several of these are STATIC FILE CRAWLS rather than behaviour, and deliberately:
 * `index.html`, `electron/splash.html` and `electron/main.cjs` ship outside the
 * React tree and outside `tsc`, so nothing else in the repo would notice if a
 * refactor dropped the mark from the loading screen or the desktop splash.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SPONSOR,
  SPONSOR_PLACEMENTS,
  sponsorActive,
  sponsorLine,
  sponsorLink,
  sponsorLogoWidth,
  type SponsorPlacement,
} from '../../src/sponsor';
import type { Check } from './harness';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

/**
 * The same file with its COMMENTS removed, for the checks that ask what the code
 * DOES. The ad-gate check below is a grep for four identifiers, and the module it
 * greps explains at length why it does not use them — so read verbatim it fails on
 * its own documentation. Block comments go, then any line that is only a `//` or a
 * JSDoc continuation; nothing here needs to survive a URL in a string literal.
 */
const code = (rel: string): string =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

/** the BIOBUZZ season, which is what the sponsorship was bought for */
const KICKOFF = Date.parse('2026-09-12T12:00:00Z');

export function sponsorChecks(check: Check): void {
  // ── the term ──────────────────────────────────────────────────────────────
  // The placement comes down on its own when the term lapses (that is the point —
  // the deal renews on the monthly numbers, not by default), so the dates have to
  // actually cover the season. A term that ends before the season does is a
  // contract breach nothing else in the repo would catch.
  check(
    'sponsor: the term is live at BIOBUZZ kickoff',
    sponsorActive(KICKOFF),
    `from=${SPONSOR.term.from} until=${SPONSOR.term.until}`,
  );
  check(
    'sponsor: the term still covers the season eleven months in',
    sponsorActive(KICKOFF + 330 * 24 * 3600e3),
    'a season sponsorship that expires mid-season is a breach, not a lapse',
  );
  check(
    'sponsor: the term is not live the day before it starts',
    !sponsorActive(Date.parse(`${SPONSOR.term.from}T00:00:00Z`) - 1),
    SPONSOR.term.from,
  );
  check(
    'sponsor: `until` is EXCLUSIVE — the placement is gone on that date',
    !sponsorActive(Date.parse(`${SPONSOR.term.until}T00:00:00Z`)),
    SPONSOR.term.until,
  );
  // a wrong clock must not hide a placement somebody paid for — see `sponsorActive`
  check(
    'sponsor: an unparseable term fails toward SHOWING the mark',
    sponsorActive(NaN),
    'NaN compares false both ways, which is the safe direction here',
  );

  // ── the link ──────────────────────────────────────────────────────────────
  // A placement whose click cannot be told apart from another placement's is one
  // the monthly report cannot break down, which is the whole basis of a renewal.
  const links = SPONSOR_PLACEMENTS.map((p) => sponsorLink(p));
  check(
    'sponsor: every placement produces a distinct link',
    new Set(links).size === SPONSOR_PLACEMENTS.length,
    `${SPONSOR_PLACEMENTS.length} placements, ${new Set(links).size} distinct URLs`,
  );
  const tagged = SPONSOR_PLACEMENTS.every((p) => {
    const u = new URL(sponsorLink(p));
    return (
      u.origin === new URL(SPONSOR.url).origin &&
      u.searchParams.get('utm_source') === 'dsim' &&
      u.searchParams.get('utm_medium') === p &&
      !!u.searchParams.get('utm_campaign')
    );
  });
  check('sponsor: every link carries source/medium/campaign and points at the sponsor', tagged);
  // the privacy rule from src/analytics.ts, applied to the query string: constants
  // and a placement name, nothing that could identify a person
  const paramsClean = SPONSOR_PLACEMENTS.every((p) => {
    const keys = [...new URL(sponsorLink(p)).searchParams.keys()];
    return keys.every((k) => k.startsWith('utm_'));
  });
  check('sponsor: the link carries NOTHING but utm params — no ids, ever', paramsClean);

  // ── the artwork's footprint ───────────────────────────────────────────────
  // Every placement reserves its box from this ratio BEFORE the image loads, which
  // is what keeps `npm run shiftaudit` green. A zero or inverted intrinsic size
  // would silently make every reserved box wrong.
  const ratio = SPONSOR.logoW / SPONSOR.logoH;
  check(
    'sponsor: the artwork has a real horizontal footprint',
    SPONSOR.logoW > 0 && SPONSOR.logoH > 0 && ratio > 1,
    `${SPONSOR.logoW}x${SPONSOR.logoH} (${ratio.toFixed(2)}:1)`,
  );
  check(
    'sponsor: logo width scales with height at the artwork ratio',
    sponsorLogoWidth(20) === Math.round(20 * ratio) && sponsorLogoWidth(40) === Math.round(40 * ratio),
    `h=20 -> ${sponsorLogoWidth(20)}, h=40 -> ${sponsorLogoWidth(40)}`,
  );
  check(
    'sponsor: the plain-text line names the sponsor',
    sponsorLine().includes(SPONSOR.name),
    sponsorLine(),
  );

  // ── the placements actually exist ─────────────────────────────────────────
  // `SponsorMark` is the ONE component that knows the URL and fires the events, so
  // a placement is present iff something renders it with that placement id.
  const ui = read('src/ui/Sponsor.tsx');
  for (const p of ['home', 'footer', 'game', 'download'] as SponsorPlacement[]) {
    check(
      `sponsor: the ${p} placement is wired to SponsorMark`,
      ui.includes(`placement="${p}"`),
      'src/ui/Sponsor.tsx',
    );
  }
  const consumers: [string, string, string][] = [
    ['home menu', 'src/ui/HomeMenu.tsx', 'SponsorPresents'],
    ['shell footer', 'src/ui/AppShell.tsx', 'SponsorFooterMark'],
    ['download page', 'src/ui/Download.tsx', 'SponsorDownloadMark'],
    ['game screen', 'src/ui/GameView.tsx', 'SponsorGameChip'],
  ];
  for (const [where, file, component] of consumers) {
    check(`sponsor: the ${where} renders <${component} />`, read(file).includes(`<${component}`), file);
  }

  // ⚠️ THE IN-GAMEPLAY PLACEMENT IS NOT AN AD, AND THIS IS THE CHECK THAT SAYS SO.
  // `AdSlot`/`useAds` render nothing on touch, nothing under Electron and nothing
  // for a supporter — so a chip routed through that path would be invisible on
  // every phone, in the desktop app, and to the most engaged players on the
  // service. That was written into the deal explicitly ("rendered independently of
  // the ad system"), and it is a one-line refactor away from being undone.
  check(
    'sponsor: NOTHING in Sponsor.tsx touches the ad gate',
    !/useAds|useAdUnitActive|adsConfigured|AdSlot/.test(code('src/ui/Sponsor.tsx')),
    'the in-gameplay mark must render on touch, under Electron, and for supporters',
  );
  const gameView = code('src/ui/GameView.tsx');
  // the chip must sit AFTER the ad branch has closed, not inside it — measured as
  // "the `)}` that ends `{ads && (` comes first", which is a structural fact rather
  // than a distance in characters (the two are neighbours in the tree, so any
  // proximity test just measures how many comments happen to sit between them)
  const adStart = gameView.indexOf('{ads && (');
  const chipAt = gameView.indexOf('<SponsorGameChip');
  check(
    'sponsor: the in-game chip is not rendered inside the `ads &&` branch',
    /<SponsorGameChip\s*\/>/.test(gameView) &&
      adStart >= 0 &&
      chipAt > adStart &&
      gameView.slice(adStart, chipAt).includes(')}'),
    'src/ui/GameView.tsx',
  );

  // ── the loading screen ────────────────────────────────────────────────────
  // index.html IS the loading screen: React clears #root on mount, so this markup
  // is what a visitor looks at while the bundle parses and the Rapier WASM decodes.
  // It ships outside tsc and outside the React tree, so nothing else notices it.
  const html = read('index.html');
  check(
    'sponsor: the loading screen names the sponsor',
    html.includes(SPONSOR.name),
    'index.html (#seo-home is what shows before React mounts)',
  );
  check(
    'sponsor: the loading screen links to the sponsor',
    html.includes(SPONSOR.url),
    'index.html',
  );

  // ── the desktop build ─────────────────────────────────────────────────────
  const splash = read('electron/splash.html');
  check('sponsor: the desktop splash names the sponsor', splash.includes(SPONSOR.name), 'electron/splash.html');
  check(
    'sponsor: the desktop splash carries both artwork cuts',
    splash.includes('sponsor-on-light.png') && splash.includes('sponsor-on-dark.png'),
    'electron/splash.html',
  );
  const main = read('electron/main.cjs');
  check(
    'sponsor: the splash is actually shown at launch and taken down again',
    main.includes('showSplash()') && main.includes('closeSplash'),
    'electron/main.cjs',
  );
  // a frameless always-on-top window that outlives its handover is one the user
  // cannot get rid of — every exit path has to close it
  check(
    'sponsor: the splash has a timeout as well as a ready-to-show handover',
    main.includes('SPLASH_MAX_MS') && main.includes("once('ready-to-show'"),
    'a hung site load must not strand the splash on screen',
  );

  // ── the burned-in replay mark ─────────────────────────────────────────────
  // "Every clip a team posts carries it, and it outlives every patch" — so the
  // export path must draw it, and must DECODE the artwork before the synchronous
  // capture loop starts, or the mark is silently absent from the file.
  const overlay = read('src/ui/replayOverlay.ts');
  check(
    'sponsor: the replay overlay draws the mark',
    overlay.includes('drawSponsorMark(ctx'),
    'src/ui/replayOverlay.ts',
  );
  check(
    'sponsor: the burn-in falls back to the wordmark if the artwork never decodes',
    overlay.includes('SPONSOR.name.toUpperCase()'),
    'a file with the words in it honours the placement; a gap does not',
  );
  const replayView = read('src/ui/ReplayView.tsx');
  check(
    'sponsor: the capture awaits loadSponsorMark() before the first frame',
    /await loadSponsorMark\(\)/.test(replayView) &&
      replayView.indexOf('await loadSponsorMark()') < replayView.indexOf('await recordFast'),
    'recordFast`s draw callback is synchronous — a still-loading Image draws nothing',
  );

  // ── the attribution report ────────────────────────────────────────────────
  // The monthly numbers are read off these three events (docs/sponsor.md says
  // which filter produces which line). An event that stops firing makes a line of
  // the report silently read zero.
  const analytics = read('src/analytics.ts');
  for (const ev of ['sponsor_shown', 'sponsor_click', 'player_joined']) {
    check(`sponsor: '${ev}' is a declared analytics event`, analytics.includes(`'${ev}'`), 'src/analytics.ts');
  }
  check(
    'sponsor: impressions and clicks are both fired, per placement',
    ui.includes("trackEvent('sponsor_shown', { placement })") &&
      ui.includes("trackEvent('sponsor_click', { placement })"),
    'a click count with no impression count has no scale attached to it',
  );
  check(
    'sponsor: new players are counted where signup COMPLETES',
    read('src/ui/UsernameGate.tsx').includes("trackEvent('player_joined')"),
    'src/ui/UsernameGate.tsx — a sign-in fires on every return visit; this does not',
  );
  check(
    'sponsor: the report recipe is documented',
    read('docs/sponsor.md').includes('sponsor_click'),
    'docs/sponsor.md',
  );

  // ── the artwork files ─────────────────────────────────────────────────────
  // FOUR of them carry the same two cuts: two bundled through Vite, two beside
  // the Electron splash, which is a `file://` page and cannot resolve a
  // fingerprinted name. Replacing one pair and forgetting the other is the
  // obvious way to get a re-brand half-right, so all four are listed here and in
  // the swap procedure.
  const artwork = [
    'src/assets/sponsors/offset-on-light.png',
    'src/assets/sponsors/offset-on-dark.png',
    'electron/sponsor-on-light.png',
    'electron/sponsor-on-dark.png',
  ];
  /** width/height straight out of the PNG's IHDR — 8-byte signature, then a chunk
   *  carrying two big-endian u32s at offsets 16 and 20. Reading the file rather
   *  than trusting its name is what makes "the declared footprint is the real one"
   *  a check at all: every placement reserves its box from `SPONSOR.logoW/logoH`
   *  BEFORE the image loads, so a mismatch is a layout shift nothing else sees. */
  const pngSize = (rel: string): { png: boolean; w: number; h: number } => {
    const b = readFileSync(join(ROOT, rel));
    return { png: b.subarray(1, 4).toString('latin1') === 'PNG', w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  };
  for (const f of artwork) {
    const s = pngSize(f);
    check(`sponsor: ${f} exists and is a real image`, s.png, 'the placement has nothing to draw without it');
  }
  const sameBox = artwork.every((f) => {
    const s = pngSize(f);
    return s.w === SPONSOR.logoW && s.h === SPONSOR.logoH;
  });
  check(
    'sponsor: all four artwork files are the footprint SPONSOR declares',
    sameBox,
    `expected ${SPONSOR.logoW}x${SPONSOR.logoH} in each`,
  );
  check(
    'sponsor: the swap procedure lists all four files',
    artwork.every((f) => read('docs/sponsor.md').includes(f)),
    'docs/sponsor.md',
  );
}
