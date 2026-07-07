import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Absolute base for the WEB build so path-based routes (/leaderboard, /replay/…)
  // still resolve assets on a deep load / refresh (paired with the vercel.json SPA
  // rewrite). The Electron desktop build sets ELECTRON=1 (see the `dist` script) to
  // keep the relative base needed under file:// — it routes by state, not URL.
  base: process.env.ELECTRON === '1' ? './' : '/',
});
