import { useEffect, useRef, useState } from 'react';
import type { GameSettings } from '../game';
import { gameServerUrl, gameServerUrlWith, multiServer, selectedServer } from '../net/env';
import { WebSocketTransport } from '../net/transport';
import { LobbyClient, type MatchStart } from '../net/lobbyClient';
import { ServerSession } from '../net/serverSession';
import type { NetSession } from '../net/session';
import type { ErrorCode, RecordKind } from '../net/protocol';
import { loadActiveGame } from '../net/activeGame';
import { moduleFor } from '../games';
import { serverPhysics } from '../games/types';
import { initPhysics3d, physics3dReady } from '../games/biobuzz/sim3d/engine';
import { announcePhysicsReady } from '../net/roomPhysics';
import { preloadRoomView } from '../net/roomView';
import { ConsoleHead } from './ConsoleHead';
import { useEscape } from './useEscape';
import { VerifyEmailInline } from './VerifyCodeForm';

/**
 * Record-chasing launcher (opponent-free score attack). Unlike the custom-room
 * lobby, this is streamlined: connect → create a PRIVATE record room → auto-start
 * (the solo player is the room's host), then hand a ServerSession to the game.
 * The whole run executes on the authoritative server, so it's recorded + (if the
 * player is signed in) persisted to the leaderboard. Retries `start` while the
 * server's Rapier WASM is still loading after an auto-stop cold boot.
 */
export function RecordRun({
  settings,
  mode,
  onStart,
  onCancel,
  onRejoinActive,
}: {
  settings: GameSettings;
  mode: RecordKind;
  onStart: (s: NetSession) => void;
  onCancel: () => void;
  /** go to the game this account is already in — offered only when the server refuses
   *  with `active_game` AND this browser still knows which match that is. Optional so
   *  nothing breaks for a caller that does not wire it. */
  onRejoinActive?: () => void;
}) {
  const [status, setStatus] = useState('Connecting to the record server…');
  /**
   * WAITING ON THE 3D PHYSICS CHUNK, as a state and not as a reading of `status`.
   *
   * It decides which BODY the card shows — the loading line, or the cold-boot note — and the
   * two are different situations with different waits. Deriving it by comparing `status`
   * against its own sentence would make the copy load-bearing, which is how a wording change
   * becomes a behaviour change.
   */
  const [loading3d, setLoading3d] = useState(false);
  const [error, setError] = useState('');
  /** the server's machine-readable reason, when it gave one (older servers give none —
   *  see the message fallback where this is set) */
  const [errorCode, setErrorCode] = useState<ErrorCode | ''>('');
  /** the code was accepted on this card, after an `email_unverified` refusal */
  const [verifiedHere, setVerifiedHere] = useState(false);
  /**
   * EVERY FAILURE HERE USED TO BE A DEAD END. The card offered one control — BACK TO HOME —
   * so a cold-boot timeout, a busy region and a dropped connection all cost a trip through
   * the menu to try the same thing again. Bumping this re-runs the connect effect, which is
   * the whole of a retry: the room code is minted inside it.
   */
  const [attempt, setAttempt] = useState(0);
  const startedRef = useRef(false);

  useEscape(onCancel); // Esc backs out, same as ← Back

  // Connect straight away. The region picker used to gate this screen on EVERY
  // run, which made a one-time preference into a per-run prompt; it now lives in
  // the top bar (`ServerMenu`) and the run just uses the current selection.
  useEffect(() => {
    if (!gameServerUrl()) {
      setError('The game server isn’t configured.');
      return;
    }
    /**
     * A RECORD RUN NEVER FALLS BACK TO 2D — it refuses (owner ruling, 2026-09-18).
     *
     * Solo practice degrades when the 3D chunk will not load: `GameView` catches it and plays
     * the session on the 2D physics, because a practice reaches no board and a player on a
     * flaky connection should still get to drive. A record run is the opposite case — its
     * score IS the board — so the same failure has to stop it, and it has to stop it HERE,
     * before a room is opened and a seat spent on a client that cannot step the world the
     * server will build (`Room.physics`).
     *
     * Only for a game whose server rooms are 3D; DECODE and Chain Reaction never enter this
     * branch and their record runs start exactly as they always did. Idempotent — a second run
     * in the same tab finds `physics3dReady()` and connects with no await at all.
     */
    let cancelled = false;
    /** whatever `connect()` opened, so the effect's own cleanup can close it — the connect may
     *  land AFTER this effect returns (the await above), so it cannot be the returned value. */
    let close: (() => void) | null = null;

    const connect = (): void => {
      if (cancelled) return;
      setLoading3d(false);
      setStatus('Connecting to the record server…');
      const room = 'rec-' + Math.random().toString(36).slice(2, 9); // private, ephemeral
      // route to the picked region (one-app multi-region); solo, so no cross-region concern
      const region = selectedServer()?.region ?? '';
      const url = multiServer() && region ? gameServerUrlWith({ region }) : gameServerUrl();
      let transport: WebSocketTransport;
      try {
        transport = new WebSocketTransport(url);
      } catch {
        setError('Couldn’t reach the game server.');
        return;
      }
      const lobby = new LobbyClient(transport);
      let tries = 0;
      let timer: number | undefined;

      const tryStart = (): void => {
        if (startedRef.current) return;
        lobby.start();
        // keep nudging: a cold-booted server refuses 'start' until physics is ready
        if (++tries < 25) timer = window.setTimeout(tryStart, 700);
        else setError('The server took too long to start. Try again.');
      };

      lobby.on('roster', () => {
        if (!startedRef.current && tries === 0) {
          setStatus('Starting your run…');
          tryStart();
        }
      });
      lobby.on('matchStart', (m: MatchStart) => {
        startedRef.current = true;
        if (timer) window.clearTimeout(timer);
        onStart(new ServerSession(transport, lobby.isHost(), m, lobby.clientId, room, false, lobby.seatToken));
      });
      lobby.on('error', (msg, code) => {
        if (/starting up/i.test(msg)) return; // startup ⇒ the retry loop handles it
        /**
         * NAME THE REFUSAL WE CAN ACT ON. `active_game` is the single-game lock — the
         * account is in a match somewhere — and it is the one refusal with a way out that
         * is not "try the same thing again". Falling back to the sentence keeps that true
         * against a server deployed before the code existed, which is most of the fleet on
         * the day this ships; the two are read together, never one or the other.
         */
        const active = code === 'active_game' || /already have a game in progress/i.test(msg);
        setErrorCode(active ? 'active_game' : (code ?? ''));
        setError(msg);
      });
      lobby.on('closed', () => {
        // NEVER OVERWRITE A REASON WITH A SYMPTOM. A refusal is followed by the socket
        // going away, so this fired second and replaced "you already have a game in
        // progress" with "lost connection" — a different card, about a connection that
        // was fine, with the wrong way out on it.
        if (!startedRef.current) setError((e) => e || 'Lost connection to the game server.');
      });

      lobby.join(
        room,
        {
          name: settings.spec.teamName || 'Player',
          teamName: settings.spec.teamName,
          teamNumber: settings.spec.teamNumber,
          alliance: 'blue', // record runs are forced to one alliance server-side
          startIndex: settings.startIndex,
          startPose: settings.startPose ?? null,
          ready: true,
          spec: settings.spec,
          assists: settings.assists,
        },
        { kind: 'record', record: mode, game: settings.game },
      );
      // the server holds a 3D room's start until every seat reports in (`READY3D_CAP`). This
      // page only dials once the chunk has resolved, so the announcement goes out behind the
      // join frame and the room starts with no wait — but the SERVER-SIDE gate is what makes
      // that a guarantee rather than an ordering the client happens to keep.
      announcePhysicsReady(lobby, settings.game);

      close = () => {
        if (timer) window.clearTimeout(timer);
        if (!startedRef.current) lobby.dispose();
      };
    };

    // the view downloads beside the physics; the room holds the run until it is built
    preloadRoomView(settings.game);
    if (serverPhysics(moduleFor(settings.game)) === '3d' && !physics3dReady()) {
      setLoading3d(true);
      setStatus('Loading 3D physics…');
      void initPhysics3d().then(connect, (err: unknown) => {
        if (cancelled) return;
        setLoading3d(false);
        // eslint-disable-next-line no-console
        console.warn('BIOBUZZ 3D physics failed to load; refusing to start a record run.', err);
        setError(
          'Couldn’t load the 3D physics that record runs need. Check your connection and try again.',
        );
      });
    } else {
      connect();
    }

    return () => {
      cancelled = true;
      close?.();
    };
    // `attempt` is the retry: bumping it tears this effect down and dials again with a
    // fresh room code. Nothing else here may go in the deps — the rest is read once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  /** dial again from the top: clear the card, mint a new room, reset the nudge loop. */
  const retry = (): void => {
    startedRef.current = false;
    setError('');
    setErrorCode('');
    setVerifiedHere(false);
    setAttempt((n) => n + 1);
  };

  /** the console scaffold every full-screen setup surface shares (Lobby,
   * Matchmaking, MatchStrategy) — back control + brand mark, then a titled panel. */
  const page = (title: JSX.Element, sub: string, body: JSX.Element): JSX.Element => (
    <div className="ds-console">
      <div className="ds-console-in narrow">
        <ConsoleHead onBack={onCancel} title={title} sub={sub} />
        <div className="ds-panel ds-panel-body stack">{body}</div>
      </div>
    </div>
  );

  const kind = mode === 'duo' ? 'Duo 2v0' : 'Solo 1v0';

  if (error) {
    /**
     * THE CARD HAS TO OFFER A WAY FORWARD, and which one depends on the refusal.
     *
     * `active_game` is the only one where trying again is pointless — the lock is held by
     * a match that is really there, and the way out is to go to it. That offer is made
     * only when this browser still holds the record of which match it is; with no record
     * (a cleared storage, another device, an expired entry) there is nothing to go to, so
     * the card says so and stops rather than promising a button that does nothing.
     *
     * Everything else — a cold-boot timeout, a busy region, a dropped connection — retries
     * in place. It used to be BACK TO HOME or nothing.
     */
    const stuckInAnother = errorCode === 'active_game';
    // the code, or the sentence from a server deployed before the code existed
    const unverified = errorCode === 'email_unverified' || /verify your email/i.test(error);
    const canRejoin = stuckInAnother && !!onRejoinActive && !!loadActiveGame();
    // plain ink, no accent word and no ⚠: a failure is not a place for decoration (06-22)
    return page(
      <>Couldn’t start</>,
      kind,
      <>
        {verifiedHere ? (
          <p className="ds-hint ok">Email verified. Start your run.</p>
        ) : (
          // the server's sentence points at the Profile page; the code form is right here
          <p className="ds-form-err">{unverified ? 'Verify your email to save a record run.' : error}</p>
        )}
        {/* TRY AGAIN would only be refused the same way: the code form is the way out */}
        {unverified && !verifiedHere && <VerifyEmailInline onVerified={() => setVerifiedHere(true)} />}
        {stuckInAnother && !canRejoin && (
          <p className="ds-hint">
            Open that game from wherever you left it, or wait a minute for it to end on its own.
          </p>
        )}
        <div className="ds-actions">
          {canRejoin ? (
            <button className="ds-cta" onClick={onRejoinActive}>
              GO TO THAT GAME
            </button>
          ) : (
            !stuckInAnother &&
            (!unverified || verifiedHere) && (
              <button className="ds-cta" onClick={retry}>
                {verifiedHere ? 'START RUN' : 'TRY AGAIN'}
              </button>
            )
          )}
          <button className="ds-cta secondary" onClick={onCancel}>
            BACK TO HOME
          </button>
        </div>
      </>,
    );
  }

  // the status is said ONCE, in the body; the sub is the kind only (06-22 — "Loading 3D
  // physics…" used to print in both)
  return page(
    <>Record run</>,
    kind,
    <>
      {/* TWO WAITS, TWO SENTENCES. The 3D chunk is this machine downloading ~1.1 MB and the
          run cannot be requested until it lands (a record run never falls back to 2D); the
          cold boot is the server waking. Saying "the server is waking" while the hold-up is
          local sends somebody to check a connection that is fine. */}
      {/* a line in the stack, not `.ds-loading`: that one's 32px padding is for an empty
          panel, and inside this 16px body it read as a hollow card */}
      <p className="ds-hint">{status}</p>
      {!loading3d && (
        <p className="ds-hint">
          First run after a quiet spell waits a few seconds for the server to wake.
        </p>
      )}
      <div className="ds-actions">
        <button className="ds-cta secondary" onClick={onCancel}>
          BACK TO HOME
        </button>
      </div>
    </>,
  );
}
