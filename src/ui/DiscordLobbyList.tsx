import { useEffect, useState } from 'react';
import { APP_NAME, seasonFor } from '../seasons';
import type { GameId } from '../types';
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
 * Every path calls `onEnter(code, game)`, which navigates to the real lobby with that
 * code tagged to this group — so a room created here shows up in everyone else's
 * browser on their next poll (every 3s).
 *
 * A ROOM HAS ONE SEASON, AND THE CREATOR PICKS IT. Rooms used to be pinned to DECODE
 * here, so the activity could not play Chain Reaction or BIOBUZZ at all — and worse,
 * the Lobby draws its start editor and robot summary from the PLAYER's selected
 * season, so a BIOBUZZ player joining a pinned room saw a BIOBUZZ lobby for a match
 * that ran DECODE. Now a new room (the main lobby while nobody has opened it, or a
 * separate one) takes the season the player picked on the home page, and joining an
 * EXISTING room hands back THAT room's season, which `App` switches to before the
 * join — the same rule an accepted invite follows. The server refuses a joiner whose
 * config disagrees with the room's, so the two must be reconciled here, before the
 * socket opens, not discovered as an error after.
 */
export function DiscordLobbyList({
  group,
  mainCode,
  game,
  onEnter,
  onBack,
}: {
  group: string;
  mainCode: string;
  /** the player's currently selected season — what a room CREATED from here will run */
  game: GameId;
  /** enter a room; `game` is the season that room runs (its own if it exists, else the
   * creator's pick), so the caller can switch to it before joining */
  onEnter: (code: string, game: GameId) => void;
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
  const main = (lobbies ?? []).find((l) => l.code.toLowerCase() === mainCode.toLowerCase());
  const others = (lobbies ?? []).filter((l) => l.code.toLowerCase() !== mainCode.toLowerCase());
  // an open main lobby runs ITS season; an unopened one will run the player's pick
  const mainGame: GameId = main?.game ?? game;
  const mainFull = !!main && main.players >= main.capacity;

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
          <button className="ds-cta" disabled={mainFull} onClick={() => onEnter(mainCode, mainGame)}>
            {mainFull ? 'MAIN LOBBY FULL' : `JOIN MAIN LOBBY · ${seasonFor(mainGame).name.toUpperCase()} ▶`}
          </button>
          <p className="ds-hint">
            {main
              ? `${main.players}/${main.capacity} in the main lobby.`
              : `Nobody has opened the main lobby yet. It will run ${seasonFor(game).name}, the season picked on the home page.`}
          </p>
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
                    onClick={() => onEnter(l.code.toUpperCase(), l.game)}
                  >
                    <span className="ll-code">{l.code.toUpperCase()}</span>
                    <span className="ll-game">{seasonFor(l.game).name}</span>
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
          <button className="ds-btn" onClick={() => onEnter(generateRoomCode(), game)}>
            + Create a separate {seasonFor(game).name} lobby
          </button>
          <p className="ds-hint">To run a different season, pick it on the home page first.</p>
        </section>
      </div>
    </div>
  );
}
