import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { ServerNoticeBanner } from './ui/ServerNoticeBanner';
import { initPhysics } from './sim/physicsEngine';
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
    </StrictMode>,
  );
});
