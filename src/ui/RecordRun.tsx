import { useEffect, useRef, useState } from "react";
import type { GameSettings } from "../game";
import { gameServerUrl, gameServerUrlWith, multiServer, selectedServer } from "../net/env";
import { WebSocketTransport } from "../net/transport";
import { LobbyClient, type MatchStart } from "../net/lobbyClient";
import { ServerSession } from "../net/serverSession";
import type { NetSession } from "../net/session";
import type { RecordKind } from "../net/protocol";
import { loadActiveGame, type ActiveGameRef } from "../net/activeGame";
import { APP_NAME } from "../seasons";
import { Logo } from "./Logo";
import { useEscape } from "./useEscape";

export function RecordRun({
  settings,
  mode,
  onStart,
  onCancel,
  onRejoin,
}: {
  settings: GameSettings;
  mode: RecordKind;
  onStart: (s: NetSession) => void;
  onCancel: () => void;
  onRejoin?: (ref: ActiveGameRef) => void;
}) {
  const [status, setStatus] = useState("Connecting to the record server…");
  const [error, setError] = useState("");
  const startedRef = useRef(false);

  useEscape(onCancel);

  useEffect(() => {
    if (!gameServerUrl()) {
      setError("The game server isn’t configured.");
      return;
    }
    const room = "rec-" + Math.random().toString(36).slice(2, 9);
    const region = selectedServer()?.region ?? "";
    const url = multiServer() && region ? gameServerUrlWith({ region }) : gameServerUrl();
    let transport: WebSocketTransport;
    try {
      transport = new WebSocketTransport(url);
    } catch {
      setError("Couldn’t reach the game server.");
      return;
    }
    const lobby = new LobbyClient(transport);
    let tries = 0;
    let timer: number | undefined;

    const tryStart = (): void => {
      if (startedRef.current) return;
      lobby.start();
      if (++tries < 25) timer = window.setTimeout(tryStart, 700);
      else setError("The server took too long to start. Try again.");
    };

    lobby.on("roster", () => {
      if (!startedRef.current && tries === 0) {
        setStatus("Starting your run…");
        tryStart();
      }
    });
    lobby.on("matchStart", (m: MatchStart) => {
      startedRef.current = true;
      if (timer) window.clearTimeout(timer);
      onStart(new ServerSession(transport, lobby.isHost(), m, lobby.clientId, room));
    });
    lobby.on("error", (msg) => {
      if (/game in progress/i.test(msg)) {
        const active = loadActiveGame();
        // Ensure that an active game exists and matches the current season/game mode
        if (active && onRejoin) {
          startedRef.current = true;
          if (timer) window.clearTimeout(timer);
          lobby.dispose();
          // If the cached match was under another game, keep the target settings game
          if (active.start && !active.start.game) {
            active.start.game = settings.game;
          }
          onRejoin(active);
          return;
        }
      }
      if (!/starting up/i.test(msg)) setError(msg);
    });
    lobby.on("closed", () => {
      if (!startedRef.current) setError("Lost connection to the game server.");
    });

    lobby.join(
      room,
      {
        name: settings.spec.teamName || "Player",
        teamName: settings.spec.teamName,
        teamNumber: settings.spec.teamNumber,
        alliance: "blue",
        startIndex: settings.startIndex,
        startPose: settings.startPose ?? null,
        ready: true,
        spec: settings.spec,
        assists: settings.assists,
      },
      { kind: "record", record: mode, game: settings.game },
    );

    return () => {
      if (timer) window.clearTimeout(timer);
      if (!startedRef.current) lobby.dispose();
    };
  }, []);

  const page = (title: JSX.Element, sub: string, body: JSX.Element): JSX.Element => (
    <div className="ds-console">
      <div className="ds-console-in" style={{ maxWidth: 520 }}>
        <div className="ds-head">
          <button className="ds-back" onClick={onCancel}>
            ← Back
          </button>
          <span className="ds-mark">
            <Logo size={24} />
            {APP_NAME}
          </span>
        </div>
        <div className="ds-title">
          <h1>{title}</h1>
        </div>
        <p className="ds-sub" style={{ marginTop: -10 }}>
          {sub}
        </p>
        <div className="ds-panelbox">{body}</div>
      </div>
    </div>
  );

  const kind = mode === "duo" ? "Duo 2v0" : "Solo 1v0";

  if (error) {
    return page(
      <>
        Couldn’t <span className="accent">start</span>
      </>,
      kind,
      <>
        <p className="ds-form-err">⚠ {error}</p>
        <div className="ds-actions">
          <button className="ds-cta ghost" onClick={onCancel}>
            BACK TO HOME
          </button>
        </div>
      </>,
    );
  }

  return page(
    <>
      Record <span className="accent">Run</span>
    </>,
    `${kind} · ${status}`,
    <>
      <p className="ds-hint">
        First run after a quiet spell waits a few seconds for the server to wake.
      </p>
      <div className="ds-actions">
        <button className="ds-cta ghost" onClick={onCancel}>
          BACK TO HOME
        </button>
      </div>
    </>,
  );
}
