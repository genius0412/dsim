import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { ServerNoticeBanner } from './ui/ServerNoticeBanner';
import { NoticePoller } from './ui/NoticePoller';
import { initPhysics } from './sim/physicsEngine';
// Self-hosted (not a CDN <link>): the Electron build runs from file:// with
// vite `base: './'`, so fingerprinted woff2 must be bundled to resolve offline.
// Variable cuts, because shell.css asks for weights off the 100 grid (750).
import '@fontsource-variable/plus-jakarta-sans';
import '@fontsource-variable/space-grotesk';
import './ui/styles.css';
import './ui/shell.css';

// Init the Rapier physics WASM (shared src/sim) before the first sim step. It
// inlines its WASM as base64 (no separate asset), so this is a fast local
// decode — block the initial render on it so no GameController steps early.
initPhysics().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
      <ServerNoticeBanner />
      <NoticePoller />
    </StrictMode>,
  );
});
