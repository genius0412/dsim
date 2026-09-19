import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// a stable build id (git sha, timestamp fallback) baked into the client AND emitted
// to /version.json, so a running client can detect that a newer build has deployed.
const BUILD_ID = (() => {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return String(Date.now());
  }
})();

/**
 * The Contributors page's third-party credit table cites a package VERSION next to its
 * name, and a hand-typed one drifts the first time `package.json` bumps without anyone
 * remembering the credits page. Read once here (the same `readFileSync` + `JSON.parse`
 * `scripts/smoke.ts` already uses for a package.json check) and baked in as a build-time
 * constant, the same technique as `__BUILD_ID__` above: `src/contributors.ts` never touches
 * the filesystem itself, and its `declare const` falls back to a literal if this is ever
 * absent (a non-Vite consumer), matching `net/version.ts`'s `__BUILD_ID__` guard.
 */
const THIRD_PARTY_VERSIONS = (() => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const versionOf = (name: string): string =>
    (pkg.dependencies[name] ?? pkg.devDependencies[name] ?? '').replace(/^[\^~]/, '');
  return {
    rapier2d: versionOf('@dimforge/rapier2d-compat'),
    rapier3d: versionOf('@dimforge/rapier3d-deterministic-compat'),
    three: versionOf('three'),
    react: versionOf('react'),
    plusJakartaSans: versionOf('@fontsource-variable/plus-jakarta-sans'),
    spaceGrotesk: versionOf('@fontsource-variable/space-grotesk'),
  };
})();

// The desktop (Electron) build gets NO Vercel env injection, so without this the
// bundled offline-fallback bundle would ship with multiplayer + accounts disabled
// (`VITE_GAME_SERVERS`/`VITE_NEON_AUTH_URL` absent → SERVERS=[] → the Multiplayer
// menu is hidden). Bake the PUBLIC client config into the Electron build only
// (`ELECTRON=1`). These EXACT values already ship in the deployed web bundle —
// nothing secret (server DB/auth secrets are never VITE_-prefixed). The web build
// (ELECTRON unset) is untouched: it still reads these from Vercel's env, and an
// explicitly-set env var wins here too (Vite: process.env VITE_* overrides), so a
// local `ELECTRON=1` build can still point at localhost by exporting its own.
if (process.env.ELECTRON === '1') {
  process.env.VITE_GAME_SERVERS ??=
    '[{"id":"iad","label":"US East","region":"iad","url":"wss://dohun-sim-decode.fly.dev"},' +
    '{"id":"ord","label":"US Central","region":"ord","url":"wss://dohun-sim-decode.fly.dev"},' +
    '{"id":"sjc","label":"US West","region":"sjc","url":"wss://dohun-sim-decode.fly.dev"},' +
    '{"id":"lhr","label":"Europe","region":"lhr","url":"wss://dohun-sim-decode.fly.dev"},' +
    '{"id":"gru","label":"South America","region":"gru","url":"wss://dohun-sim-decode.fly.dev"},' +
    '{"id":"jnb","label":"Africa","region":"jnb","url":"wss://dohun-sim-decode.fly.dev"},' +
    '{"id":"syd","label":"Oceania","region":"syd","url":"wss://dohun-sim-decode.fly.dev"},' +
    '{"id":"nrt","label":"Asia","region":"nrt","url":"wss://dohun-sim-decode.fly.dev"}]';
  process.env.VITE_NEON_AUTH_URL ??=
    'https://ep-lingering-pine-ahq640vd.neonauth.c-3.us-east-1.aws.neon.tech/neondb/auth';
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'emit-version-json',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'version.json',
          source: JSON.stringify({ build: BUILD_ID }),
        });
      },
    },
    // ads.txt — the IAB authorized-sellers file. AdSense flags an account with no
    // ads.txt as "earnings at risk" and some demand simply will not bid without
    // it, so it is not optional once ads are live.
    //
    // GENERATED rather than committed to `public/`, for two reasons: it must
    // contain the real publisher id (which lives in env, not in git), and a stale
    // hand-written copy pointing at the wrong pub- id is worse than none at all.
    // With VITE_ADSENSE_CLIENT unset no file is emitted — a 404 is the correct
    // answer for a site that serves no ads.
    // AdSense SITE VERIFICATION.
    //
    // The review is a chicken-and-egg step that the ad code alone does not cover:
    // Google issues the publisher id at SIGNUP, then needs to confirm you own the
    // site before it will approve (or serve) anything. But `<AdSlot>` only loads
    // the ad tag once a UNIT has a slot id, and you cannot create ad units until
    // you are approved — so with `VITE_ADSENSE_CLIENT` set and no slots, nothing
    // whatsoever appears on the page and there is nothing for Google to find.
    //
    // This meta tag is Google's own no-ads verification method, and it is the
    // right one here: it proves ownership without pulling a third-party script
    // into a 60 Hz game for zero user benefit. Together with the generated
    // ads.txt below, it satisfies verification twice over.
    {
      name: 'adsense-verification-meta',
      transformIndexHtml(html: string) {
        // ---- 1. the desktop build must never carry the ad tag ---------------
        // index.html hardcodes the adsbygoogle script so AdSense's crawler finds
        // it on every route of this client-rendered SPA. That is right for the
        // WEB, and a policy violation for the DESKTOP app: AdSense does not
        // permit serving inside a non-browser application wrapper, and the
        // Electron build ships this exact file. `src/ads/adsense.ts` already
        // refuses to render units under Electron, but a hardcoded <script> tag
        // sails straight past every runtime gate, so it is stripped at build.
        let out = html;
        if (process.env.ELECTRON === '1') {
          out = out.replace(
            /\s*<script[^>]*data-dsim-adsense[^>]*>\s*<\/script>/g,
            '\n    <!-- AdSense tag stripped: not permitted in an app wrapper -->',
          );
        }

        // ---- 2. the publisher id must not disagree with itself --------------
        // The id now lives in TWO places: the hardcoded tag above, and
        // VITE_ADSENSE_CLIENT (which drives ads.txt, the runtime loader, and the
        // CMP). If they ever drift, ads.txt would authorize a different seller
        // than the tag requesting the ads - which is precisely the mismatch
        // ads.txt exists to detect, and it silently kills fill rate. Fail the
        // build instead of shipping it.
        const client = (process.env.VITE_ADSENSE_CLIENT ?? '').trim();
        const inTag = html.match(/adsbygoogle\.js\?client=(ca-pub-\d+)/)?.[1];
        if (client && inTag && client !== inTag) {
          throw new Error(
            `AdSense publisher id mismatch: VITE_ADSENSE_CLIENT is "${client}" but ` +
              `index.html hardcodes "${inTag}". They must match.`,
          );
        }

        // The meta tag is a SECOND verification signal, and free: Google accepts
        // the script snippet, this tag, or ads.txt. Belt and braces while the
        // review is pending; harmless afterwards.
        const tags =
          /^ca-pub-\d{10,}$/.test(client) && process.env.ELECTRON !== '1'
            ? [
                {
                  tag: 'meta',
                  attrs: { name: 'google-adsense-account', content: client },
                  injectTo: 'head' as const,
                },
              ]
            : [];
        return { html: out, tags };
      },
    },
    {
      name: 'emit-ads-txt',
      generateBundle() {
        const client = (process.env.VITE_ADSENSE_CLIENT ?? '').trim();
        // the file wants the bare publisher id; the tag wants the `ca-` prefix
        const pub = client.replace(/^ca-/, '');
        if (!/^pub-\d{10,}$/.test(pub)) return;
        this.emitFile({
          type: 'asset',
          fileName: 'ads.txt',
          // f08c47fec0942fa0 is Google's fixed certification-authority id — the
          // same literal for every AdSense publisher, not a per-account secret.
          source: `google.com, ${pub}, DIRECT, f08c47fec0942fa0\n`,
        });
      },
    },
  ],
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
    __THIRD_PARTY_VERSIONS__: JSON.stringify(THIRD_PARTY_VERSIONS),
  },
  /**
   * WORKERS ARE BUILT AS ES MODULES, because the LAN host worker code-splits.
   *
   * Vite's default is `'iife'`, and an IIFE bundle cannot be code-split — the first dynamic
   * `import()` anywhere in a worker's graph fails the build outright with
   * `Invalid value "iife" for option "worker.format"`. `src/lan/hostWorker.ts` hosts the
   * authoritative room in a tab and calls `initPhysics3d()` for a 3D BIOBUZZ room, which
   * reaches the ~1.1 MB rapier3d wasm through exactly such an import. The alternative —
   * importing the package statically — would put that megabyte in the worker chunk for every
   * host, including the 2D ones, which is the cost the lazy load exists to avoid.
   *
   * This is not a new runtime requirement: `hostRuntime.ts` already constructs the worker with
   * `{ type: 'module' }`, so the only thing that was out of step was the BUILD format. Module
   * workers are supported everywhere DSIM hosts from (Chromium — and therefore Electron —
   * since 80, Safari 15, Firefox 114).
   */
  worker: { format: 'es' },
  // Absolute base for the WEB build so path-based routes (/leaderboard, /replay/…)
  // still resolve assets on a deep load / refresh (paired with the vercel.json SPA
  // rewrite). The Electron desktop build sets ELECTRON=1 (see the `dist` script) to
  // keep the relative base needed under file:// — it routes by state, not URL.
  base: process.env.ELECTRON === '1' ? './' : '/',
  // Vite 6 only answers requests whose Host header is localhost (DNS-rebinding
  // protection). A Cloudflare quick tunnel forwards the browser's request with the
  // tunnel hostname as Host, so without this every tunnelled page load is a 403
  // "Blocked request. This host is not allowed". The leading dot matches every
  // random quick-tunnel subdomain, so a fresh tunnel never needs a config edit.
  server: { allowedHosts: ['.trycloudflare.com'] },
  preview: { allowedHosts: ['.trycloudflare.com'] },
});
