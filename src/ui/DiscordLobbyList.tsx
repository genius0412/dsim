import { useEffect, useState } from 'react';
import { APP_NAME } from '../seasons';
import { Logo } from './Logo';
import { useEscape } from './useEscape';
import { fetchLobbies, type DiscordLobby } from '../net/api';
import { generateRoomCode } from '../net/roomCode';

/**
 * The Discord Activity LOBBY BROWSER. Opened by the home "Join Discord Lobby"
 * button, it lists the open rooms of THIS activity (scoped by `group`, the
 * instance id) so a voice channel with more than four players can split into
 * several games cleanly instead of colliding in one four-seat room.
 *
 * - "Join main lobby" enters the deterministic `mainCode` (join-or-create), so two
 *   people arriving at the same instant still converge on one room.
 * - each listed lobby has its own Join, showing how full it is.
 * - "Create a separate lobby" mints a fresh random code for a parallel game.
 *
 * Every path calls `onEnter(code)`, which navigates to the real lobby with that
 * code tagged to this group — so a room created here shows up in everyone else's
 * browser on their next poll (every 3s).
 */
export function DiscordLobbyList({
  group,
  mainCode,
  onEnter,
  onBack,
}: {
  group: string;
  mainCode: string;
  onEnter: (code: string) => void;
  onBack: () => void;
}) {
  const [lobbies, setLobbies] = useState<DiscordLobby[] | null>(null);
  useEscape(onBack);

  useEffect(() => {
    let alive = true;
    const poll = (): void => {
      fetchLobbies(group).then((l) => {
        if (alive) setLobbies(l);
      });
    };
    poll();
    const t = window.setInterval(poll, 3000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [group]);

  // the main lobby has its own button, so don't also list it as an "other" room
  const others = (lobbies ?? []).filter((l) => l.code.toLowerCase() !== mainCode.toLowerCase());

  return (
    <div className="ds-console">
      <div className="ds-console-in" style={{ maxWidth: 520 }}>
        <div className="ds-head">
          <button className="ds-back" onClick={onBack}>
            ← Back
          </button>
          <span className="ds-mark">
            <Logo size={24} />
            {APP_NAME}
          </span>
          <span className="ds-head-spacer" />
        </div>
        <div className="ds-title">
          <h1>
            Discord <span className="accent">lobbies</span>
          </h1>
        </div>
        <p className="ds-sub" style={{ marginTop: -10 }}>
          Everyone in this activity sees the same lobbies. Join one, or start another game.
        </p>

        <section className="ds-sec">
          <button className="ds-cta" onClick={() => onEnter(mainCode)}>
            JOIN MAIN LOBBY ▶
          </button>
        </section>

        <section className="ds-sec">
          <h2>Open lobbies</h2>
          {lobbies === null ? (
            <p className="ds-hint">Loading…</p>
          ) : others.length === 0 ? (
            <p className="ds-hint">No other lobbies open — join the main one, or start a separate game below.</p>
          ) : (
            <div className="ds-lobbies">
              {others.map((l) => {
                const full = l.players >= l.capacity;
                return (
                  <button
                    key={l.code}
                    className="ds-lobby-row"
                    disabled={full}
                    onClick={() => onEnter(l.code)}
                  >
                    <span className="ll-code">{l.code}</span>
                    <span className="ll-count">
                      {l.players}/{l.capacity}
                    </span>
                    <span className="ll-go">{full ? 'FULL' : 'Join →'}</span>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <section className="ds-sec">
          <button className="ds-btn" onClick={() => onEnter(generateRoomCode())}>
            + Create a separate lobby
          </button>
        </section>
      </div>
    </div>
  );
}
