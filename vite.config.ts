import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';

// a stable build id (git sha, timestamp fallback) baked into the client AND emitted
// to /version.json, so a running client can detect that a newer build has deployed.
const BUILD_ID = (() => {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return String(Date.now());
  }
})();

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
  ],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  // Absolute base for the WEB build so path-based routes (/leaderboard, /replay/…)
  // still resolve assets on a deep load / refresh (paired with the vercel.json SPA
  // rewrite). The Electron desktop build sets ELECTRON=1 (see the `dist` script) to
  // keep the relative base needed under file:// — it routes by state, not URL.
  base: process.env.ELECTRON === '1' ? './' : '/',
});
