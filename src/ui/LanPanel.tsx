import { useCallback, useEffect, useRef, useState } from 'react';
import { APP_NAME, LINKS } from '../seasons';
import { desktop, type LanHostStatus } from '../desktop';
import { useEscape } from './useEscape';
import { appBuild, clearLanServer, lanActive, lanServerUrl, setLanServer } from '../net/env';
import { LAN_DEFAULT_PORT, mixedContentBlock, parseLanAddress } from '../net/lanAddress';

/**
 * LAN PLAY — host a game on this machine, or join one on this network.
 *
 * Matches on a self-hosted server are UNOFFICIAL: never rated, never on a leaderboard. Their
 * replays are still saved to the host's account, which is the whole reason hosting is gated
 * on being signed in. See docs/lan-selfhost.md.
 *
 * TWO CONSTRAINTS SHAPE THIS SCREEN, and neither is obvious from looking at it:
 *
 * 1. **HOSTING IS DESKTOP-ONLY.** A web page cannot start a server. The host controls are
 *    ABSENT rather than disabled in a browser, because a disabled button is a promise that
 *    something would enable it, and nothing here would.
 *
 * 2. **AN https PAGE CANNOT OPEN A `ws://` SOCKET.** The browser drops it as mixed content
 *    with no catchable error, so a guest who types a LAN address into the app on
 *    playdsim.com would watch it fail forever with nothing to go on. The Join box detects
 *    that BEFORE connecting and says the one thing that works: open the host's URL in a
 *    browser instead. `localhost` is exempt, which is why the host themselves can play from
 *    the live site.
 */
/**
 * THE FOUR COMMANDS, in the order a person types them.
 *
 * `git clone` rather than `npx github:...`, which would be one line instead of four. The
 * one-liner needs this package to carry a `prepare` script so npm builds it after cloning,
 * and `prepare` ALSO runs on every ordinary `npm install` — so every contributor would pay a
 * full client build on every install to save a host three lines once. The `bin` entry
 * (`dsim-lan`) exists so the one-liner can be added later if that trade ever changes.
 *
 * `npm ci` rather than `npm install`: the lockfile is committed, and a host is not trying to
 * resolve new versions, they are trying to run the thing.
 */
const HOST_STEPS = [
  { what: 'Get the code', cmd: `git clone ${LINKS.repo}` },
  { what: 'Go into it', cmd: 'cd dsim' },
  { what: 'Install once', cmd: 'npm ci' },
  { what: 'Host', cmd: 'npm run lan' },
] as const;
export function LanPanel({
  signedIn,
  onConnected,
  onBack,
}: {
  /** hosting requires an account: the match data has to land somewhere */
  signedIn: boolean;
  /** connected to a LAN server — take the player to the room screen */
  onConnected: () => void;
  /** leave the LAN screen without connecting to anything — see the note on `.ds-back` below */
  onBack: () => void;
}) {
  const bridge = desktop();
  useEscape(onBack);
  const [host, setHost] = useState<LanHostStatus | null>(null);
  const [hostBusy, setHostBusy] = useState(false);
  const [hostErr, setHostErr] = useState('');
  const [addr, setAddr] = useState(() => lanServerUrl().replace(/^ws:\/\//, ''));
  const [joinErr, setJoinErr] = useState('');
  /** the URL a blocked guest must open in a browser instead — see constraint 2 above */
  const [openInstead, setOpenInstead] = useState('');
  const [copied, setCopied] = useState('');
  /** the build id the LOCAL server hands out, when it differs from this page's — see `skew` */
  const [skew, setSkew] = useState('');
  const [active, setActive] = useState(lanActive());
  const alive = useRef(true);

  const refresh = useCallback(() => {
    if (!bridge?.lan) return;
    void bridge.lan.status().then((s) => alive.current && setHost(s));
  }, [bridge]);

  useEffect(() => {
    alive.current = true;
    refresh();
    // A SLOW POLL, not a subscription. The only thing that changes without us asking is the
    // server dying, and a host staring at this screen wants to be told when it does — but an
    // IPC round trip a second, for a panel nobody is interacting with, is noise.
    const t = window.setInterval(refresh, 4000);
    return () => {
      alive.current = false;
      window.clearInterval(t);
    };
  }, [refresh]);

  /**
   * DOES THE SERVER WE JUST STARTED HAND OUT THE SAME BUILD THIS PAGE IS?
   *
   * ⚠️ It routinely does not, and the consequence is a desync rather than an error. The
   * desktop shell loads the LIVE site whenever it is reachable, so the host is usually
   * running whatever Vercel deployed today, while the server it just started serves the
   * `dist/` that shipped inside the installer. Guests get that copy; the host does not.
   * Two different `src/sim` builds in one authoritative match is exactly the mismatch the
   * matchmaker's build segregation exists to prevent — and a CODE-JOINED room has no such
   * segregation, so nothing else catches it.
   *
   * It is a WARNING, not a block: the two builds are usually the same, the check needs the
   * server to be up to answer at all, and the fix is one click (play through the local URL,
   * which is served by the same machine as everyone else's).
   */
  const checkSkew = (port: number): void => {
    void fetch(`http://localhost:${port}/version.json?t=${Date.now()}`, { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<{ build?: string }>) : null))
      .then((v) => {
        if (!alive.current) return;
        const served = v?.build ?? '';
        setSkew(served && served !== appBuild() ? served : '');
      })
      .catch(() => alive.current && setSkew(''));
  };

  const startHost = (): void => {
    if (!bridge?.lan) return;
    setHostBusy(true);
    setHostErr('');
    void bridge.lan.start({ port: LAN_DEFAULT_PORT }).then((r) => {
      if (!alive.current) return;
      setHostBusy(false);
      if ('error' in r) {
        setHostErr(r.error);
        return;
      }
      setHost(r);
      checkSkew(r.port);
    });
  };

  const stopHost = (): void => {
    if (!bridge?.lan) return;
    setHostBusy(true);
    void bridge.lan.stop().then((s) => {
      if (!alive.current) return;
      setHostBusy(false);
      setHost(s);
      setSkew('');
    });
  };

  /**
   * ⚠️ `navigator.clipboard` DOES NOT EXIST ON THE PAGE THIS SCREEN MATTERS MOST ON.
   *
   * The Clipboard API is gated on a SECURE CONTEXT. A LAN guest is served from
   * `http://192.168.x.x:8787`, which is plain http and not `localhost`, so it is not secure and
   * `navigator.clipboard` is `undefined` there — measured, not assumed. The optional chain meant
   * the whole call evaporated and every copy button on this page was a button that did nothing,
   * silently, with no error to notice. It is exactly the wrong page for that: the join URL and
   * the host commands are the two things anyone comes here to copy.
   *
   * So there is a fallback, and it is the old `execCommand('copy')` one. It is deprecated and it
   * is also the only thing that works without a secure context, which is the situation. The
   * textarea is off-screen rather than `display:none` because a hidden element cannot be
   * selected, and `readOnly` keeps a mobile keyboard from opening over the page.
   *
   * The host's own window is on `localhost`, which IS exempt and secure, so the modern path is
   * the normal one and this is the guest's path.
   */
  const flash = (text: string): void => {
    setCopied(text);
    window.setTimeout(() => alive.current && setCopied(''), 1600);
  };
  const copyFallback = (text: string): boolean => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  };
  const copy = (text: string): void => {
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).then(
        () => flash(text),
        // a rejection here is usually "the document is not focused" rather than "not allowed",
        // and the fallback copes with both — so try it before giving up.
        () => {
          if (copyFallback(text)) flash(text);
          else setCopied('');
        },
      );
      return;
    }
    if (copyFallback(text)) flash(text);
  };

  /**
   * Join a server on this network.
   *
   * The mixed-content test runs BEFORE the address is stored, so a blocked guest is never
   * left pointed at a server they cannot reach. Everything else is `parseLanAddress`, whose
   * refusals are worth spelling out rather than collapsing into "invalid address": somebody
   * who typed a public IP and somebody who typed nothing need different things said to them.
   */
  const join = (): void => {
    setJoinErr('');
    setOpenInstead('');
    const hit = parseLanAddress(addr);
    if (!hit.ok) {
      setJoinErr(
        hit.error === 'empty'
          ? 'Enter the address the host is showing on their screen.'
          : hit.error === 'not-private'
            ? 'That isn’t an address on this network. LAN play only connects to servers on the network you’re on.'
            : 'Couldn’t read that address. It should look like 192.168.1.5 or 192.168.1.5:8787.',
      );
      return;
    }
    const blocked = mixedContentBlock(hit.value, window.location.protocol);
    if (blocked) {
      setOpenInstead(blocked);
      return;
    }
    setLanServer(hit.value.url);
    setActive(true);
    onConnected();
  };

  const leave = (): void => {
    clearLanServer();
    setActive(false);
    setAddr('');
  };

  const running = !!host?.running;
  const port = host?.port || LAN_DEFAULT_PORT;
  const joinUrls = (host?.addresses ?? []).map((a) => `http://${a.address}:${port}`);

  // A SHELL PAGE, the same shape as `ModeSelect` beside it — an eyebrow, a heading and
  // sections. NOT a `ds-console`: this screen renders inside `AppShell`, which already
  // carries the top bar and the left rail, so a console in here would draw a second header.
  //
  // ⚠️ IT STILL NEEDS ITS OWN BACK. An earlier version of this comment said the shell's own
  // Back made one here a duplicate — it does not: `AppShell` renders a top bar and a rail and
  // NO back control at all, and its docstring hands that responsibility to the screen ("own
  // their own back/Esc semantics"). `WatchLive`, the other screen of this shape, takes an
  // `onBack` for exactly this reason. Without one the only way off this page was the left
  // rail, which is not where anyone looks after typing an address into a field — reported from
  // a real session, on the join step.
  return (
    <>
      <button className="ds-back" onClick={onBack}>
        ← Back
      </button>
      <p className="ds-eyebrow">{APP_NAME} · LAN</p>
      <h1 className="ds-h1">LAN play</h1>

      <p className="ds-page-note">
        Play on one network with no internet in the middle. LAN matches are unofficial —
        they’re never rated and never reach a leaderboard. The host’s replays are still saved
        to their account.
      </p>

      {active && (
        <div className="ds-panelbox">
          <p className="ds-lan-state">
            Connected to <b>{lanServerUrl().replace(/^ws:\/\//, '')}</b>
          </p>
          <p className="ds-hint">
            Matches you play here are unofficial. Leaderboards, records and your account still
            come from the DSIM servers.
          </p>
          <div className="ds-actions">
            <button className="ds-btn" onClick={leave}>
              Play on the DSIM servers instead
            </button>
          </div>
        </div>
      )}

      {/* ---- HOST ---- */}
      <p className="ds-tileset-label">Host · this computer</p>
      {bridge?.lan && (
        <>
          <div className="ds-panelbox">
            {!running && (
              <>
                <p className="ds-hint">
                  Starts a game server on this computer. Everyone else opens the address it
                  shows — no download, nothing to install.
                </p>
                {!signedIn && (
                  <p className="ds-hint warn">
                    Sign in first. The matches played on your server are saved to your
                    account, and there’s nowhere for them to go otherwise.
                  </p>
                )}
                {hostErr && <p className="ds-form-err">⚠ {hostErr}</p>}
                <div className="ds-actions">
                  <button className="ds-cta" disabled={hostBusy || !signedIn} onClick={startHost}>
                    {hostBusy ? 'STARTING…' : 'START HOSTING ▶'}
                  </button>
                </div>
              </>
            )}

            {running && (
              <>
                <p className="ds-lan-state">
                  Hosting on port <b>{port}</b>
                </p>
                {joinUrls.length === 0 ? (
                  <p className="ds-hint warn">
                    This computer isn’t on a network anyone else can reach. Connect to the
                    venue’s Wi-Fi or an ethernet switch, then start hosting again.
                  </p>
                ) : (
                  <>
                    <p className="ds-hint">
                      Everyone else opens this in a browser on the same network:
                    </p>
                    <div className="ds-lan-urls">
                      {joinUrls.map((u, i) => (
                        <button
                          key={u}
                          className={`ds-lan-url${i === 0 ? ' primary' : ''}`}
                          onClick={() => copy(u)}
                          title="Copy"
                        >
                          <span className="u">{u}</span>
                          <span className="c">{copied === u ? 'Copied' : 'Copy'}</span>
                        </button>
                      ))}
                    </div>
                    {joinUrls.length > 1 && (
                      <p className="ds-hint">
                        More than one is listed because this computer is on more than one
                        network. If the first doesn’t work, try the next.
                      </p>
                    )}
                  </>
                )}
                {skew && (
                  <p className="ds-hint warn">
                    Your server is handing out a different build of DSIM than this window is
                    running ({skew} vs {appBuild()}), which would desync a match. Open{' '}
                    <b>http://localhost:{port}</b> in this app or a browser and play from
                    there — that’s the same copy everyone else gets.
                  </p>
                )}
                <div className="ds-actions">
                  {!active && (
                    <button
                      className="ds-cta"
                      onClick={() => {
                        // THE HOST CONNECTS THROUGH `localhost`, not through the address the
                        // guests use. It is the one host a browser exempts from the mixed-
                        // content rule, so this works from the live https site as well as
                        // from the bundled copy — see `mixedContentBlock`.
                        setLanServer(`localhost:${port}`);
                        setActive(true);
                        onConnected();
                      }}
                    >
                      PLAY ON MY SERVER ▶
                    </button>
                  )}
                  <button className="ds-btn" disabled={hostBusy} onClick={stopHost}>
                    Stop hosting
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      )}

      {/* ---- HOST WITHOUT THE APP ------------------------------------------------------
          Why this is on the page AT ALL, and why it is not apologetic about the terminal:

          A browser tab cannot be a server. Not "does not yet" — there is no web API that
          opens a listening socket, so no amount of DSIM code makes this button work. Before
          this block existed the whole host half was hidden behind `bridge?.lan`, which meant
          a player on the web saw a page titled "LAN play" whose only control asked for
          somebody ELSE's address. That reads as "hosting is missing", and the first question
          it produced was exactly the right one: where do I find my address?

          So the page now answers it in the two places it can be answered, and says plainly
          why there is no third. `docs/lan-selfhost.md` carries the long version, including
          the one design (WebRTC) that could remove the terminal later.

          GUESTS ARE UNAFFECTED and that is worth saying out loud here, because it is the
          part people assume wrong: only the HOST needs any of this. -------------------- */}
      <div className="ds-panelbox">
        <p className="ds-lan-state">
          {bridge?.lan ? 'Or host from a terminal' : 'Hosting needs one command'}
        </p>
        <p className="ds-hint">
          A browser tab can’t be a server — no web page can open the kind of connection other
          computers dial into, so this has to run outside the tab. The steps are the same on
          macOS, Windows and Linux. You need Node.js (nodejs.org) and Git (git-scm.com); if you
          already write code on this machine you almost certainly have both.
        </p>
        <ol className="ds-lan-steps">
          {HOST_STEPS.map((step) => (
            <li key={step.cmd}>
              <span className="s">{step.what}</span>
              <button
                className="ds-lan-url compact"
                onClick={() => copy(step.cmd)}
                title="Copy"
              >
                <span className="u">{step.cmd}</span>
                <span className="c">{copied === step.cmd ? 'Copied' : 'Copy'}</span>
              </button>
            </li>
          ))}
        </ol>
        <p className="ds-hint">
          It prints the addresses to put on a projector, and keeps hosting until you press
          Ctrl-C. The first run builds the app once, so give it a minute.
        </p>
        <p className="ds-hint">
          <b>Your guests install nothing.</b> They open the address you read out, in whatever
          browser is already on their laptop. Only the host needs the command above — or the
          desktop app, which does the same thing with a button.
        </p>
      </div>

      {/* ---- JOIN ---- */}
      <p className="ds-tileset-label">Join · someone else’s computer</p>
      <div className="ds-panelbox">
        <label className="ds-field">
          <span className="cap">Host address</span>
          <input
            className="ds-input"
            value={addr}
            onChange={(e) => setAddr(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && join()}
            placeholder={`192.168.1.5:${LAN_DEFAULT_PORT}`}
            spellCheck={false}
            autoCapitalize="off"
          />
        </label>
        {joinErr && <p className="ds-form-err">⚠ {joinErr}</p>}
        {/* THE MIXED-CONTENT DIAGNOSIS. Not an error about the address — the address is fine
            and the server is fine; THIS PAGE is the thing that cannot reach it, and no amount
            of retrying will change that. So it says what to do instead. */}
        {openInstead && (
          <p className="ds-hint warn">
            This page is loaded over a secure connection, so your browser won’t let it reach a
            server on your local network. Open <b>{openInstead}</b> in a browser tab instead —
            the host is serving DSIM there.
          </p>
        )}
        <div className="ds-actions">
          <button className="ds-cta" onClick={join}>
            CONNECT ▶
          </button>
          {openInstead && (
            <button className="ds-btn" onClick={() => copy(openInstead)}>
              {copied === openInstead ? 'Copied' : 'Copy that address'}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
