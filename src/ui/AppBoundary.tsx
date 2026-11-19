import { Component, type ReactNode } from 'react';
import { replaceRoute } from './pageScroll';

/**
 * A RENDER ERROR NEVER LEAVES A BLANK SCREEN (owner, 2026-11-04: a tester left a room and was stuck on
 * Play's field with no menu and no way out). Only the lazy pages had a boundary (`LoadBoundary`), so a
 * throw anywhere else unmounted the whole app and left an empty page that only a reload fixed.
 *
 * Two placements:
 * - `resetKey` + `onHome`: around the routed content inside `AppShell`. The bar stays, the page says it
 *   could not be shown, and moving to another page (a new `resetKey`) clears the failure.
 * - `full`: around the whole app in `main.tsx`, for a throw outside the shell (a match, the replay
 *   viewer, the shell itself). The app's own state is what failed, so its button is a fresh load of Home.
 */
interface Props {
  children: ReactNode;
  /** the page this guards; a different one renders the children again */
  resetKey?: string;
  /** the shell's own way to Home (the in-shell placement) */
  onHome?: () => void;
  /** the outermost placement: a full-page card, and Home by reloading */
  full?: boolean;
}

interface State {
  failed: boolean;
  key: string | undefined;
}

/** Home by a fresh load: `/` resolves to the saved game's Home (a `file:` build routes in state, so a reload is Home) */
export function reloadHome(): void {
  try {
    replaceRoute('/'); // nothing under a `file:` build, which routes in state
  } catch {
    /* a reload of the current address still clears the failure */
  }
  window.location.reload();
}

/**
 * THE PHYSICS ENGINE DID NOT LOAD (`main.tsx`). Nothing renders until `initPhysics()` has answered, so a
 * rejection (a browser or mode that refuses WebAssembly) left the boot screen up for good: the mark and
 * a sweeping bar, no message, nothing to press. A render error has a card; so does this. It names the
 * likely cause and reloads, which is also all a transient failure needs.
 */
export function StartFailed() {
  return (
    <main className="ds-closed" role="alert" aria-labelledby="ds-start-fail-title">
      <div className="ds-closed-card">
        <h1 id="ds-start-fail-title" className="ds-closed-title">
          Couldn’t start the simulator.
        </h1>
        <p className="ds-closed-msg">
          The physics engine didn’t load. Reload the page. If it keeps happening, this browser may be blocking WebAssembly
          (Lockdown Mode does): try another browser.
        </p>
        <div className="ds-closed-actions">
          <button type="button" className="ds-btn primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    </main>
  );
}

export class AppBoundary extends Component<Props, State> {
  state: State = { failed: false, key: this.props.resetKey };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.key ? null : { failed: false, key: props.resetKey };
  }

  componentDidCatch(err: unknown): void {
    // eslint-disable-next-line no-console
    console.warn('[app] Couldn’t render this screen.', err);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    if (this.props.full) {
      return (
        <main className="ds-closed" role="alert" aria-labelledby="ds-fail-title">
          <div className="ds-closed-card">
            <h1 id="ds-fail-title" className="ds-closed-title">
              Couldn’t show this screen.
            </h1>
            <div className="ds-closed-actions">
              <button type="button" className="ds-btn primary" onClick={reloadHome}>
                Back to Home
              </button>
            </div>
          </div>
        </main>
      );
    }
    return (
      <div className="ds-loading" role="alert">
        <p>Couldn’t show this page.</p>
        <button type="button" className="ds-btn small" onClick={this.props.onHome ?? reloadHome}>
          Back to Home
        </button>
      </div>
    );
  }
}
