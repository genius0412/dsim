/**
 * DSIM'S SIDE OF `zenith-host/1` — the protocol Zenith's web editor speaks with the app that
 * opened it (`Horizon-36596/zenith` docs/spec/12-host-protocol.md). "Edit in Zenith" opens the
 * editor in a POPUP with this robot's Zenith robot file, the BIOBUZZ field and the library's
 * autos; Zenith's Save sends an auto back, and its "Simulate in DSIM" asks DSIM to run it.
 *
 * ── WHY A POPUP AND NOT AN IFRAME ─────────────────────────────────────────────────────────────
 * Zenith talks back through `window.opener`, and a gated Zenith deployment's session cookie is
 * `SameSite=Strict`, which a third-party iframe never carries. So `window.open` WITHOUT
 * `noopener` — the one place DSIM does that, on purpose.
 *
 * ── TRUST ─────────────────────────────────────────────────────────────────────────────────────
 * A message is read only when it comes from THE popup this module opened and from Zenith's
 * origin (`VITE_ZENITH_URL`'s), and everything DSIM posts after `ready` goes to that origin and
 * nowhere else. A saved auto is text from another site: the caller validates it with Zenith's
 * own schema (`parseAutoText`) before it is stored, and a refusal goes back as `saved` `ok:false`.
 * Nothing secret is ever posted.
 */

/** the public Zenith web app; a deployment (or `npm run dev` beside Zenith's) sets VITE_ZENITH_URL */
export const ZENITH_URL: string = import.meta.env.VITE_ZENITH_URL || 'https://libraries.horizon36596.org/zenith/app/';

const PROTOCOL = 'zenith-host/1';

export function zenithOrigin(): string {
  return new URL(ZENITH_URL, window.location.href).origin;
}

export interface ZenithProject {
  name: string;
  hostLabel?: string;
  robot: unknown;
  field: unknown;
  waypoints?: unknown;
  /** auto name -> file text */
  autos: Record<string, string>;
}

export interface ZenithSessionOptions {
  project: ZenithProject;
  /** the auto to open first */
  open?: string;
  /** store a saved auto; resolve null when stored, or the sentence to show when refused */
  onSave(name: string, text: string): Promise<string | null>;
  /** run an auto and resolve its trace; absent = no "Simulate in DSIM" */
  onRun?(name: string, text: string): Promise<unknown>;
  /** the popup went away */
  onClosed?(): void;
  /** a recorded run to lay over `open`, posted right behind the project (Zenith waits for the open) */
  trace?: unknown;
}

export interface ZenithSession {
  /** lay a recorded run over the plan in the open editor */
  sendTrace(auto: string, trace: unknown): void;
  /** focus the popup (a second "Edit in Zenith" reuses it) */
  focus(): void;
  close(): void;
  readonly closed: boolean;
}

let current: { session: ZenithSession; popup: Window } | null = null;

/**
 * Open (or re-open) Zenith for this project. Returns null when the browser blocked the popup,
 * which the caller says so about.
 */
export function openZenith(o: ZenithSessionOptions): ZenithSession | null {
  // one editor at a time: a second click replaces the first session's project
  if (current && !current.popup.closed) current.session.close();
  const origin = zenithOrigin();
  const url = new URL(ZENITH_URL, window.location.href);
  url.searchParams.set('host', 'dsim');
  // no `noopener`: see the header
  const popup = window.open(url.toString(), 'dsim-zenith', 'popup,width=1440,height=900');
  if (!popup) return null;
  let closed = false;
  let opened = false;

  const post = (msg: Record<string, unknown>): void => {
    if (!closed && !popup.closed) popup.postMessage(msg, origin);
  };
  const sendOpen = (): void => {
    opened = true;
    post({
      type: 'open',
      protocol: PROTOCOL,
      project: o.project,
      ...(o.open ? { open: o.open } : {}),
      readOnlyRobot: true,
      capabilities: { simulate: !!o.onRun },
    });
    if (o.trace !== undefined && o.open) post({ type: 'trace', auto: o.open, trace: o.trace });
  };

  const onMessage = (e: MessageEvent): void => {
    if (e.source !== popup || e.origin !== origin) return;
    const d = e.data as Record<string, unknown> | null;
    if (!d || typeof d !== 'object' || typeof d.type !== 'string') return;
    if (d.type === 'ready' && d.protocol === PROTOCOL) {
      // a reload inside the popup says ready again, and gets the project again
      sendOpen();
      return;
    }
    if (!opened) return;
    if (d.type === 'save' && typeof d.name === 'string' && typeof d.text === 'string') {
      const name = d.name;
      o.onSave(name, d.text).then(
        (error) => post({ type: 'saved', name, ok: error === null, ...(error ? { error } : {}) }),
        (err) => post({ type: 'saved', name, ok: false, error: `Couldn’t save it in DSIM: ${String(err)}` }),
      );
      return;
    }
    if (d.type === 'run' && typeof d.name === 'string' && typeof d.text === 'string' && o.onRun) {
      const name = d.name;
      o.onRun(name, d.text).then(
        (trace) => post({ type: 'trace', auto: name, trace }),
        // eslint-disable-next-line no-console
        (err) => console.warn('[zenith] DSIM could not run the auto', err),
      );
      return;
    }
    if (d.type === 'bye') finish();
  };

  const watch = window.setInterval(() => {
    if (popup.closed) finish();
  }, 1000);

  function finish(): void {
    if (closed) return;
    closed = true;
    window.removeEventListener('message', onMessage);
    window.clearInterval(watch);
    if (current?.popup === popup) current = null;
    o.onClosed?.();
  }

  window.addEventListener('message', onMessage);
  const session: ZenithSession = {
    sendTrace: (auto, trace) => post({ type: 'trace', auto, trace }),
    focus: () => popup.focus(),
    close: () => {
      post({ type: 'close' });
      finish();
    },
    get closed() {
      return closed;
    },
  };
  current = { session, popup };
  return session;
}

/** the session opened last, while its popup is still open (Open run in Zenith reuses it) */
export function currentZenith(): ZenithSession | null {
  return current && !current.popup.closed && !current.session.closed ? current.session : null;
}
