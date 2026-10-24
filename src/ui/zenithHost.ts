/**
 * DSIM'S SIDE OF `zenith-host/1` — the protocol Zenith's web editor speaks with the app that
 * opened it (Zenith's `site/docs/host-protocol.md`). "Edit in Zenith" opens the editor in a POPUP
 * with this robot's Zenith robot file, the BIOBUZZ field and the library's autos; Zenith's Save
 * sends an auto back, and its "Simulate in DSIM" asks DSIM to run it.
 *
 * ── WHY A POPUP AND NOT AN IFRAME ─────────────────────────────────────────────────────────────
 * Zenith talks back through `window.opener`, and a gated Zenith deployment's session cookie is
 * `SameSite=Strict`, which a third-party iframe never carries. So `window.open` WITHOUT
 * `noopener` — the one place DSIM does that, on purpose.
 *
 * ── ONE WINDOW, REUSED ────────────────────────────────────────────────────────────────────────
 * A second "Edit in Zenith" while the window is open sends that window a new `open` and focuses
 * it. It used to post `close` and re-navigate the named window, which raised the browser's
 * leave-site prompt over unsaved edits, and either answer lost something (sweep DSIM-4). Zenith
 * asks about unsaved edits itself before a new `open` replaces the project.
 *
 * ── TRUST ─────────────────────────────────────────────────────────────────────────────────────
 * A message is read only when it comes from THE popup this module opened and from Zenith's
 * origin (`VITE_ZENITH_URL`'s), and everything DSIM posts after `ready` goes to that origin and
 * nowhere else. A saved auto is text from another site: the caller validates it with Zenith's
 * own schema (`parseAutoText`) before it is stored, and a refusal goes back as `saved` `ok:false`.
 * Nothing secret is ever posted.
 */

import { openMessage, PROTOCOL, type ZenithOpen } from './zenithOpen';

export type { ZenithOpen, ZenithProject, ZenithStartPose } from './zenithOpen';

/** the public Zenith web app; a deployment (or `npm run dev` beside Zenith's) sets VITE_ZENITH_URL */
export const ZENITH_URL: string = import.meta.env.VITE_ZENITH_URL || 'https://libraries.horizon36596.org/zenith/app/';

export function zenithOrigin(): string {
  return new URL(ZENITH_URL, window.location.href).origin;
}

/**
 * How long Zenith may take to say `ready` before DSIM says why nothing has happened (sweep DSIM-7).
 * A gated Zenith shows its sign-in page first, and nothing comes until the player has signed in, so
 * this is a sentence, not a failure: the session stays open and carries on when `ready` arrives.
 */
const READY_WAIT_MS = 12_000;

/** What DSIM says while it waits past `READY_WAIT_MS`. */
export const ZENITH_NOT_READY =
  'Zenith hasn’t answered yet. If its window asks you to sign in, sign in there. If the window is blank, close it and try again.';

export interface ZenithSessionOptions {
  /**
   * The project and the auto to open, BUILT AT EACH `ready`. A reload inside the popup (or the
   * gate's re-login) says `ready` again; answering it with the project captured at launch handed
   * Zenith the library as it was before this session's own Saves, so a saved edit came back old
   * and a saved new auto vanished from the picker.
   */
  project(): ZenithOpen;
  /** store a saved auto; resolve null when stored, or the sentence to show when refused */
  onSave(name: string, text: string): Promise<string | null>;
  /**
   * run an auto and resolve its trace; absent = no "Simulate in DSIM". A rejection goes back as
   * `runFailed` with the error's message, so Zenith shows the reason at once instead of waiting
   * out its 60 s (sweep W4-2).
   */
  onRun?(name: string, text: string): Promise<unknown>;
  /** the popup went away */
  onClosed?(): void;
  /** Zenith has not said `ready` within `READY_WAIT_MS` (the sentence), or now has (null) */
  onWaiting?(sentence: string | null): void;
  /** a recorded run of `traceAuto`, posted right behind a project that opens it (Zenith waits for the open) */
  trace?: unknown;
  traceAuto?: string;
}

export interface ZenithSession {
  /** lay a recorded run over the plan in the open editor */
  sendTrace(auto: string, trace: unknown): void;
  /** focus the popup */
  focus(): void;
  close(): void;
  readonly closed: boolean;
}

interface Current {
  session: ZenithSession;
  popup: Window;
  /** hand the open window a later launch's options, and send it their project if it is listening */
  adopt(o: ZenithSessionOptions): void;
}

let current: Current | null = null;

/** An error as one sentence for Zenith's status line. */
function reasonOf(err: unknown): string {
  const text = (err instanceof Error ? err.message : String(err)).trim();
  return text || 'DSIM could not run it.';
}

/**
 * Open Zenith for this project, or hand the window that is already open this project instead.
 * Returns null when the browser blocked the popup, which the caller says so about.
 */
export function openZenith(first: ZenithSessionOptions): ZenithSession | null {
  if (current && !current.popup.closed && !current.session.closed) {
    current.adopt(first);
    current.session.focus();
    return current.session;
  }
  const origin = zenithOrigin();
  const url = new URL(ZENITH_URL, window.location.href);
  url.searchParams.set('host', 'dsim');
  // no `noopener`: see the header
  const popup = window.open(url.toString(), 'dsim-zenith', 'popup,width=1440,height=900');
  if (!popup) return null;
  let o = first;
  let closed = false;
  /** Zenith has said `ready` at least once, so it is listening */
  let ready = false;
  let waitTimer: number | null = null;

  const post = (msg: Record<string, unknown>): void => {
    if (!closed && !popup.closed) popup.postMessage(msg, origin);
  };
  const sendOpen = (): void => {
    const sent = o.project();
    const { open } = sent;
    post(openMessage(sent, !!o.onRun));
    if (o.trace !== undefined && !sent.newAuto && open && open === o.traceAuto) post({ type: 'trace', auto: open, trace: o.trace });
  };
  const waitForReady = (): void => {
    if (waitTimer !== null) window.clearTimeout(waitTimer);
    waitTimer = window.setTimeout(() => {
      waitTimer = null;
      if (!ready && !closed) o.onWaiting?.(ZENITH_NOT_READY);
    }, READY_WAIT_MS);
  };

  const onMessage = (e: MessageEvent): void => {
    if (e.source !== popup || e.origin !== origin) return;
    const d = e.data as Record<string, unknown> | null;
    if (!d || typeof d !== 'object' || typeof d.type !== 'string') return;
    if (d.type === 'ready' && d.protocol === PROTOCOL) {
      // a reload inside the popup says ready again, and gets the project again
      if (waitTimer !== null) window.clearTimeout(waitTimer);
      waitTimer = null;
      if (!ready) o.onWaiting?.(null);
      ready = true;
      sendOpen();
      return;
    }
    if (!ready) return;
    if (d.type === 'save' && typeof d.name === 'string' && typeof d.text === 'string') {
      const name = d.name;
      o.onSave(name, d.text).then(
        (error) => post({ type: 'saved', name, ok: error === null, ...(error ? { error } : {}) }),
        (err) => post({ type: 'saved', name, ok: false, error: `Couldn’t save it in DSIM: ${reasonOf(err)}` }),
      );
      return;
    }
    if (d.type === 'run' && typeof d.name === 'string' && typeof d.text === 'string') {
      const name = d.name;
      const run = o.onRun;
      if (!run) {
        post({ type: 'runFailed', auto: name, reason: 'Open Zenith from DSIM’s Autonomous panel to simulate in DSIM.' });
        return;
      }
      // a run that throws before its first await rejects the same way
      Promise.resolve()
        .then(() => run(name, d.text as string))
        .then(
          (trace) => post({ type: 'trace', auto: name, trace }),
          (err) => post({ type: 'runFailed', auto: name, reason: reasonOf(err) }),
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
    if (waitTimer !== null) window.clearTimeout(waitTimer);
    waitTimer = null;
    if (current?.popup === popup) current = null;
    o.onClosed?.();
  }

  window.addEventListener('message', onMessage);
  waitForReady();
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
  current = {
    session,
    popup,
    adopt: (next) => {
      o = next;
      if (ready) sendOpen();
      else waitForReady();
    },
  };
  return session;
}

/** the session opened last, while its popup is still open (Open run in Zenith reuses it) */
export function currentZenith(): ZenithSession | null {
  return current && !current.popup.closed && !current.session.closed ? current.session : null;
}
