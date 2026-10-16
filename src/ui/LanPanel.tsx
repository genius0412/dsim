import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { LINKS } from '../seasons';
import type { GameId } from '../games/types';
import { desktop, type LanHostStatus } from '../desktop';
import { LanHost, type HostHealth } from '../lan/hostRuntime';
import { joinLanRoom } from '../lan/joinLan';
import { setPendingLanRoom } from '../lan/pending';
import { setTabHosting } from '../lan/hosting';
import { keepHostedRoom, takeHostedRoom } from '../lan/hostKeeper';
import { generateRoomCode, normalizeRoomCode } from '../net/roomCode';
import { serverCaps } from '../net/api';
import { useEscape } from './useEscape';
import { appBuild, clearLanServer, lanActive, lanServerUrl, setLanServer } from '../net/env';
import { LAN_DEFAULT_PORT, mixedContentBlock, parseLanAddress } from '../net/lanAddress';
import { copyText } from './copyText';
import { ConsoleHead } from './ConsoleHead';

/**
 * LAN PLAY — host a game on this machine, or join one on this network.
 *
 * Matches on a self-hosted server are UNOFFICIAL: never rated, never on a leaderboard. Their
 * replays are still saved to the host's account, which is the whole reason hosting is gated
 * on being signed in. See docs/lan-selfhost.md.
 *
 * It renders inside `AppShell` (the `shell` prop), so the app bar's breadcrumb is the way back and
 * `LanBanner` shows above it.
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
 *
 * ⚠️ **NO REGION PICKER, ON PURPOSE** — unlike the custom-room entry screen this one is
 * modeled on (`Lobby.tsx`'s `phase === 'entry'`). LAN has one machine; offering a region
 * would be offering a choice that does not exist.
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
  { what: 'Clone the code', cmd: `git clone ${LINKS.repo}` },
  { what: 'Open the code root', cmd: 'cd dsim' },
  { what: 'Install once', cmd: 'npm ci' },
  { what: 'Host', cmd: 'npm run lan' },
] as const;
export function LanPanel({
  signedIn,
  game,
  displayName,
  shell,
  onConnected,
  onBack,
}: {
  /** hosting requires an account: the match data has to land somewhere */
  signedIn: boolean;
  /**
   * The game a room hosted from this tab is built for — the player's current pick.
   *
   * ⚠️ It has to be THIS, not the protocol default. A room built with no game is a DECODE
   * room, and the host's own lobby then joins it as whatever game their settings say. With
   * BIOBUZZ selected that put a BIOBUZZ lobby in front of a DECODE room: every READY UP was
   * judged against DECODE's start rules, cleared by the room, and nothing on screen said why.
   */
  game: GameId;
  /** Saved DSIM display name — the same pre-fill `Lobby`'s own Your name field uses. */
  displayName?: string | null;
  /** wraps the page in the app shell (App's `shell`) */
  shell: (body: ReactNode) => JSX.Element;
  /** connected to a LAN server — take the player to the room screen */
  /**
   * Go to the room screen. The CODE is passed when this navigation already knows which room
   * to open — both WebRTC paths do, because the handshake that just happened was FOR that
   * code, and making somebody type it again on the next screen (having just typed it here)
   * is a second chance to get it wrong for no information gained. The two ADDRESS paths pass
   * nothing: reaching a LAN server is not choosing a room on it.
   *
   * `game` rides along for the tab-hosted HOST, because it is the room's game and not
   * necessarily the setting any more: a host who parks the room, changes game and comes back
   * must still re-enter the room they are running, as the game it runs.
   *
   * `name` is what was typed into this screen's own Your name field, handed to `Lobby` as a
   * one-shot `initialName` the same way `code`/`game` seed the room it opens.
   */
  onConnected: (code?: string, game?: GameId, name?: string) => void;
  /** leave the LAN screen without connecting to anything — see the note on `.ds-back` below */
  onBack: () => void;
}) {
  const bridge = desktop();

  /**
   * Pre-filled from the account's display name, exactly like `Lobby`'s own Your name field —
   * and guarded the same way against a `displayName` that resolves AFTER mount clobbering a
   * deliberate edit (`nameEditedRef`).
   */
  const [name, setName] = useState(displayName || 'Player');
  const nameEditedRef = useRef(false);
  useEffect(() => {
    if (displayName && !nameEditedRef.current) setName(displayName);
  }, [displayName]);

  /** Host room / Join room — replaces the old always-both-visible stacked sections. */
  const [entryMode, setEntryMode] = useState<'host' | 'join'>('host');
  /** the address-join field is a secondary, tucked-away option under Join room: most
   *  players join a tab-hosted room by code, and the address path is for the no-internet
   *  terminal-hosted case (see `HOST_STEPS` below). */
  const [addrOpen, setAddrOpen] = useState(false);

  /**
   * HOSTING FROM THIS TAB — the WebRTC path (`docs/lan-webrtc.md`).
   *
   * Distinct from the two host paths above it in every way that matters to the person reading
   * the screen: no download, no terminal, and it works on a Chromebook. What it costs is the
   * one thing the others do not need — a working internet connection for the HANDSHAKE, about
   * a second of it, after which the match runs entirely on the LAN. The copy says so plainly
   * rather than letting somebody discover it at a venue.
   */
  const [tabHost, setTabHost] = useState<LanHost | null>(null);
  const [tabCode, setTabCode] = useState('');
  const [tabErr, setTabErr] = useState('');
  const [tabBusy, setTabBusy] = useState(false);
  const [tabGuests, setTabGuests] = useState(0);
  const [tabHealth, setTabHealth] = useState<HostHealth | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [joinCodeErr, setJoinCodeErr] = useState('');
  const [joinCodeBusy, setJoinCodeBusy] = useState(false);

  /**
   * MAY THIS PERSON HOST WHILE SIGNED OUT?
   *
   * Normally no, and the reason is on screen: the match is filed to the host's account
   * afterwards. But a server with no accounts configured — somebody's laptop running the
   * rendezvous on a LAN with no cloud at all — cannot verify anyone, so "sign in first" there
   * asks for something that does not exist and disables the button forever. The server says
   * which kind it is (`lanAnon`, see `LAN_ANON_HOSTS`); until the read lands this stays FALSE,
   * so the stricter copy is what appears a beat early rather than a button that dies under a
   * cursor already moving toward it.
   */
  const [anonHostOk, setAnonHostOk] = useState(false);
  useEffect(() => {
    let alive = true;
    void serverCaps().then((c) => {
      if (alive) setAnonHostOk(c.includes('lanAnon'));
    });
    return () => {
      alive = false;
    };
  }, []);
  const mayTabHost = signedIn || anonHostOk;

  /**
   * LEAVING THIS SCREEN STOPS HOSTING — **unless the host is leaving it to go and PLAY.**
   *
   * The room lives in this tab, so wandering off and abandoning it would strand every guest on
   * a room nobody is stepping, and that is what the cleanup is for. But the host's own route
   * into the match unmounts this component too, and stopping there terminated the Worker on
   * the way to the room: the host clicked GO TO THE ROOM and arrived at a lobby waiting on a
   * room that no longer existed, with the guest already in it. So a handed-off room is PARKED
   * (`hostKeeper.ts`) and this cleanup leaves it alone.
   */
  const handedOff = useRef(false);
  useEffect(
    () => () => {
      if (!handedOff.current) tabHost?.stop();
    },
    [tabHost],
  );

  /* Coming BACK to this screen adopts the parked room, so the host still sees the code they
     read out and still has a way to stop it. The events it was built with belong to a
     component that no longer exists, so they are re-pointed at this one. */
  useEffect(() => {
    const kept = takeHostedRoom();
    if (!kept) return;
    kept.setEvents({
      onGuests: setTabGuests,
      onHealth: setTabHealth,
      onStopped: () => {
        setTabHosting(false);
        setTabHost(null);
        setTabCode('');
        setTabGuests(0);
        setTabHealth(null);
      },
    });
    setTabHost(kept);
    setTabCode(kept.code);
    setTabGuests(kept.guests);
  }, []);

  const startTabHost = (): void => {
    setTabErr('');
    setTabBusy(true);
    const code = generateRoomCode();
    const host = new LanHost({
      onGuests: setTabGuests,
      onHealth: setTabHealth,
      onStopped: () => {
        /* The flag goes down the moment hosting ends, however it ended. It is what tells
           `App.tsx` to KEEP the match (`keepLanRun`), so leaving it up on a tab that is no
           longer running a room would make an ordinary cloud match look self-hosted. */
        setTabHosting(false);
        setTabHost(null);
        setTabCode('');
        setTabGuests(0);
        setTabHealth(null);
      },
    });
    void host
      .start(code, { kind: 'versus', game })
      .then((live) => {
        /* ⚠️ RAISED HERE, NOT WHERE THE ROOM IS ADOPTED. The match has to be kept by this tab
           and by no other (`src/lan/hosting.ts`), and the only tab that can know that is the
           one that just started the room. */
        setTabHosting(true);
        setTabHost(host);
        setTabCode(live);
        setTabBusy(false);
      })
      .catch((e: Error) => {
        host.stop();
        setTabErr(e.message || 'Couldn’t start hosting. Try again.');
        setTabBusy(false);
      });
  };

  const playTabHost = (): void => {
    if (!tabHost || !tabCode) return;
    /* ⚠️ BOTH LINES, IN THIS ORDER, BEFORE THE NAVIGATION. The room is handed to the keeper
       so this screen's unmount does not stop it, and the flag tells the cleanup that this is
       a hand-off rather than an abandonment. */
    handedOff.current = true;
    keepHostedRoom(tabHost);
    // `transport` is a fresh loopback if the last visit's was disposed — see `LanHost.transport`
    setPendingLanRoom({ transport: tabHost.transport, code: tabCode, hosting: true });
    onConnected(tabCode, tabHost.game, name);
  };

  const joinByCode = (): void => {
    const code = normalizeRoomCode(joinCode);
    if (!code) return;
    setJoinCodeErr('');
    setJoinCodeBusy(true);
    void joinLanRoom(code)
      .then((r) => {
        setPendingLanRoom({ transport: r.transport, code: r.code, hosting: false });
        setJoinCodeBusy(false);
        onConnected(r.code, undefined, name);
      })
      .catch((e: Error) => {
        setJoinCodeErr(e.message || 'Couldn’t reach that room. Check the code and try again.');
        setJoinCodeBusy(false);
      });
  };
  useEscape(onBack);
  const [host, setHost] = useState<LanHostStatus | null>(null);
  const [hostBusy, setHostBusy] = useState(false);
  const [hostErr, setHostErr] = useState('');
  const [addr, setAddr] = useState(() => lanServerUrl().replace(/^wss?:\/\//, ''));
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
   * ⚠️ THIS IS THE PAGE WHERE THE CLIPBOARD API IS NOT THERE.
   *
   * A LAN guest is served from `http://192.168.x.x:8787` — plain http, not `localhost`, so not
   * a secure context and `navigator.clipboard` is `undefined`. The join URL and the host
   * commands are the two things anyone comes to this screen to copy, so the fallback matters
   * here more than anywhere else. It lives in `copyText` now, which every copy button shares;
   * the host's own window is on `localhost`, which IS exempt, so it takes the modern path.
   *
   * The flash is keyed to whether the text ACTUALLY landed, not to the click.
   */
  const flash = (text: string): void => {
    setCopied(text);
    window.setTimeout(() => alive.current && setCopied(''), 1600);
  };
  const copy = (text: string): void => {
    copyText(text, (ok) => (ok ? flash(text) : setCopied('')));
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
          ? 'Enter the address shown on the host’s screen.'
          : hit.error === 'not-private'
            ? 'That address isn’t on your local network.'
            : 'Couldn’t read that address. It should look like 192.168.1.5:8787.',
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
    onConnected(undefined, undefined, name);
  };

  const leave = (): void => {
    clearLanServer();
    setActive(false);
    setAddr('');
  };

  const running = !!host?.running;
  const port = host?.port || LAN_DEFAULT_PORT;
  const joinUrls = (host?.addresses ?? []).map((a) => `http://${a.address}:${port}`);

  return (
    shell(
        <div className="ds-console-in narrow">
          <ConsoleHead title="LAN play" />

          {active && (
            <div className="ds-panel ds-panel-body stack">
              <p className="ds-lan-state">
                Connected to <b>{lanServerUrl().replace(/^wss?:\/\//, '')}</b>
              </p>
              <div className="ds-actions">
                <button className="ds-btn" onClick={leave}>
                  Disconnect
                </button>
              </div>
            </div>
          )}

          <div className="ds-panel ds-panel-body stack">
            <label className="ds-field">
              <span className="cap">Your name</span>
              <input
                className="ds-input"
                value={name}
                onChange={(e) => {
                  nameEditedRef.current = true;
                  setName(e.target.value);
                }}
                maxLength={20}
              />
            </label>

            <div className="ds-opts two">
              <button
                className={`ds-opt ${entryMode === 'host' ? 'on' : ''}`}
                aria-pressed={entryMode === 'host'}
                onClick={() => setEntryMode('host')}
              >
                <span className="ot">Host room</span>
              </button>
              <button
                className={`ds-opt ${entryMode === 'join' ? 'on' : ''}`}
                aria-pressed={entryMode === 'join'}
                onClick={() => setEntryMode('join')}
              >
                <span className="ot">Join room</span>
              </button>
            </div>

            {entryMode === 'host' ? (
              <>
                {/* THE ONE HOST PATH WITH NOTHING TO INSTALL. It is first because for most
                    people it is the only one they can use: the desktop app needs a download
                    and the terminal needs Node and git, and neither exists on a school
                    Chromebook. */}
                {!tabHost && (
                  <>
                    <p className="ds-hint">
                      Needs internet for a moment at the start so players can find each other. After
                      that the match stays on your network.
                    </p>
                    {!signedIn && !anonHostOk && (
                      <p className="ds-hint warn">Sign in to host. Matches are saved to your account.</p>
                    )}
                    {!signedIn && anonHostOk && (
                      <p className="ds-hint warn">This server has no accounts. Matches stay on this device.</p>
                    )}
                    {tabErr && <p className="ds-form-err">⚠ {tabErr}</p>}
                    <div className="ds-actions">
                      <button className="ds-cta" onClick={startTabHost} disabled={!mayTabHost || tabBusy}>
                        {tabBusy ? 'STARTING…' : 'HOST ROOM'}
                      </button>
                    </div>
                  </>
                )}
                {tabHost && (
                  <>
                    <p className="ds-hint">Share this code with your players.</p>
                    <button className="ds-lan-url" onClick={() => copy(tabCode)} title="Copy">
                      <span className="u">{tabCode}</span>
                      <span className="c">{copied === tabCode ? 'Copied' : 'Copy'}</span>
                    </button>
                    <p className="ds-hint">
                      {tabGuests === 0
                        ? 'Waiting for players…'
                        : `${tabGuests} ${tabGuests === 1 ? 'player' : 'players'} joined.`}
                    </p>
                    {/* THE HOST LOOP'S OWN HEALTH. A throttled tab does not announce itself — it
                        just runs the match slowly for everyone else — so the one person who can
                        fix it is told. See docs/lan-webrtc.md §6. */}
                    {tabHealth && tabHealth.behind > 250 && (
                      <p className="ds-hint warn">Your browser is slowing this tab. Keep it visible while you host.</p>
                    )}
                    <div className="ds-actions">
                      <button className="ds-cta" onClick={playTabHost}>
                        GO TO THE ROOM
                      </button>
                      <button className="ds-btn" onClick={() => tabHost.stop()}>
                        Stop hosting
                      </button>
                    </div>
                  </>
                )}
              </>
            ) : (
              <>
                {/* Two ways in, and they are not interchangeable: a CODE reaches a tab-hosted
                    room and an ADDRESS reaches a machine running the server. The code is
                    primary because it is the one that needs nothing explained; the address
                    path is tucked behind the disclosure below for the no-internet case. */}
                <label className="ds-field">
                  <span className="cap">Room code</span>
                  <input
                    className="ds-input"
                    value={joinCode}
                    onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                    onKeyDown={(e) => e.key === 'Enter' && joinByCode()}
                    placeholder="6 characters"
                    spellCheck={false}
                    autoCapitalize="characters"
                    maxLength={6}
                  />
                </label>
                <p className="ds-hint">Both players must be on the same network.</p>
                {joinCodeErr && <p className="ds-form-err">⚠ {joinCodeErr}</p>}
                <div className="ds-actions">
                  <button className="ds-cta" onClick={joinByCode} disabled={joinCode.length < 6 || joinCodeBusy}>
                    {joinCodeBusy ? 'CONNECTING…' : 'JOIN'}
                  </button>
                </div>

                <button className="ds-btn ghost small" onClick={() => setAddrOpen((v) => !v)}>
                  {addrOpen ? 'Hide' : 'Joining a terminal-hosted server instead?'}
                </button>
                {addrOpen && (
                  <>
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
                    {/* THE MIXED-CONTENT DIAGNOSIS. Not an error about the address — the
                        address is fine and the server is fine; THIS PAGE is the thing that
                        cannot reach it, and no amount of retrying will change that. So it
                        says what to do instead. */}
                    {openInstead && (
                      <p className="ds-hint warn">
                        Your browser blocks this page from reaching a local server. Open <b>{openInstead}</b>{' '}
                        in a new tab instead.
                      </p>
                    )}
                    <div className="ds-actions">
                      <button className="ds-cta" onClick={join}>
                        CONNECT
                      </button>
                      {openInstead && (
                        <button className="ds-btn" onClick={() => copy(openInstead)}>
                          {copied === openInstead ? 'Copied' : 'Copy address'}
                        </button>
                      )}
                    </div>
                  </>
                )}
              </>
            )}
          </div>

          {entryMode === 'host' && (
            <>
              {/* ---- HOST WITHOUT THE APP ------------------------------------------------
                  Why this is on the page AT ALL, and why it is not apologetic about the
                  terminal:

                  A browser tab still cannot be a SERVER — there is no web API that opens a
                  listening socket, so nothing a guest types into an address bar will ever
                  reach a tab. What changed is that guests no longer have to dial one: the
                  tab-hosted path above reaches them through WebRTC, introduced by a cloud
                  rendezvous. `docs/lan-webrtc.md`.

                  ⚠️ So this block is NOT the fallback for people who cannot use the button
                  above. It is the path for a venue with NO INTERNET AT ALL, which the tab
                  path needs for about a second to make the introduction. That is a real gym,
                  and it is the reason this stays on the page rather than being deleted now
                  that hosting has a button.

                  GUESTS ARE UNAFFECTED either way, which is the part people assume wrong:
                  only the HOST needs any of this. `docs/lan-selfhost.md` carries the long
                  version. ---------------------------------------------------------------- */}
              <div className="ds-panel ds-panel-body stack">
                <p className="ds-lan-state">Host without browser</p>
                <p className="ds-hint">
                  Runs the game server from a terminal, so it works with no internet at all. Players
                  join by address instead of a code. Needs Node.js and Git, on macOS, Windows or Linux.
                </p>
                <ol className="ds-lan-steps">
                  {HOST_STEPS.map((step) => (
                    <li key={step.cmd}>
                      <span className="s">{step.what}</span>
                      <button className="ds-lan-url compact" onClick={() => copy(step.cmd)} title="Copy">
                        <span className="u">{step.cmd}</span>
                        <span className="c">{copied === step.cmd ? 'Copied' : 'Copy'}</span>
                      </button>
                    </li>
                  ))}
                </ol>
                <p className="ds-hint">
                  It prints the addresses to share and hosts until you press Ctrl-C. The first run takes
                  a minute to build. Players don’t install anything.
                </p>
              </div>

              {bridge?.lan && (
                <div className="ds-panel ds-panel-body stack">
                  {!running && (
                    <>
                      <p className="ds-hint">
                        Starts a game server on this computer. Players open the address it shows in a
                        browser.
                      </p>
                      {!signedIn && (
                        <p className="ds-hint warn">Sign in to host. Matches are saved to your account.</p>
                      )}
                      {hostErr && <p className="ds-form-err">⚠ {hostErr}</p>}
                      <div className="ds-actions">
                        <button className="ds-cta" disabled={hostBusy || !signedIn} onClick={startHost}>
                          {hostBusy ? 'STARTING…' : 'HOST ROOM'}
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
                          This computer isn’t on a network other players can reach. Connect to Wi-Fi or
                          ethernet, then start hosting again.
                        </p>
                      ) : (
                        <>
                          <p className="ds-hint">Players open this in a browser on the same network:</p>
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
                            <p className="ds-hint">If the first address doesn’t work, try the next.</p>
                          )}
                        </>
                      )}
                      {skew && (
                        <p className="ds-hint warn">
                          Your server runs a different DSIM build ({skew}) than this window ({appBuild()}).
                          Play from <b>http://localhost:{port}</b> so everyone is on the same build.
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
                              onConnected(undefined, undefined, name);
                            }}
                          >
                            PLAY ON MY SERVER
                          </button>
                        )}
                        <button className="ds-btn" disabled={hostBusy} onClick={stopHost}>
                          Stop hosting
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
)
  );
}
