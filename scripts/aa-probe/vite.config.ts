import { defineConfig } from 'vite';

/** `scripts/aa-probe` is its own Vite root (see `run.cjs`); `/models/...` comes from the real `public/`.
 * No HMR: a sweep loads a fresh window per tier, and a reload in the middle of one would lose it. */
export default defineConfig({
  publicDir: '../../public',
  server: { hmr: false },
});
