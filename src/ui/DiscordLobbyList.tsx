import { useEffect, useState } from 'react';
import { seasonFor } from '../seasons';
import type { GameId } from '../types';
import { ConsoleHead } from './ConsoleHead';
import { useEscape } from './useEscape';
import { fetchLobbies, type DiscordLobby } from '../net/api';
import { preloadRoomPhysics } from '../net/roomPhysics';
import { generateRoomCode } from '../net/roomCode';

/** failed list reads in a row, with no answer yet, before the screen stops saying CHECKING… */
const READ_FAILS_MAX = 2;

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
  /** no read has answered yet and `READ_FAILS_MAX` in a row have failed — see `loading` */
  const [readFailed, setReadFailed] = useState(false);
  useEscape(onBack);

  useEffect(() => {
    let alive = true;
    let inFlight = false;
    let misses = 0;
    const poll = (): void => {
      // a minimised activity has nobody looking at the list; skip the request
      if (document.visibilityState === 'hidden') return;
      // one at a time: a slow answer and a fast one racing each other landed out of order,
      // so the list could go backwards
      if (inFlight) return;
      inFlight = true;
      fetchLobbies(group)
        .then((l) => {
          // ⚠️ `null` is a FAILED READ, not an empty activity. Keep the last good list: a
          // single dropped poll used to repaint the screen as "nobody has opened the main
          // lobby yet" while four people were sitting in it.
          if (alive && l !== null) setLobbies(l);
          if (!alive) return;
          misses = l === null ? misses + 1 : 0;
          setReadFailed(misses >= READ_FAILS_MAX);
        })
        .finally(() => {
          inFlight = false;
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

  /**
   * WARM THE ROOM'S PHYSICS WHILE THEY ARE CHOOSING, not when they have chosen.
   *
   * The preload's whole value is that it costs nothing when it happens while the player is
   * doing something else — and in the activity there is no code to type, so the Lobby's own
   * preload fires in the same commit as its auto-join and the wait is fully exposed. This
   * screen is the one place a participant genuinely pauses. Keyed on the season the main
   * lobby will actually run, which is the ROOM's when one is open.
   */
  useEffect(() => {
    void preloadRoomPhysics(mainGame).catch(() => {});
  }, [mainGame]);
  /**
   * WHAT THE MAIN LOBBY ACTUALLY IS, in the three states a person can be in.
   *
   * `loading` is its own state and not "empty": the first paint used to assert that nobody
   * had opened the lobby before any answer had arrived. `busy` is the one that was missing
   * entirely — a room mid-match simply vanished from the list, so absence was rendered as
   * non-existence with the Join button still enabled, and the click was answered by the
   * server with an error on a different screen.
   *
   * An older server sends no `joinable`, and for it absence really did mean unopened; a row
   * from one is therefore treated as joinable, which is what it meant.
   */
  // ⚠️ A READ THAT KEEPS FAILING IS NOT A LOAD THAT IS STILL COMING. With no answer ever, the
  // button sat disabled on CHECKING… for as long as the list was unreachable, although joining
  // the main lobby needs nothing from it (the server decides the room). So it unlocks, and the
  // poll carries on: the first good read replaces this state.
  const unknown = lobbies === null && readFailed;
  const loading = lobbies === null && !readFailed;
  const mainBusy = !!main && main.joinable === false;
  const busyLabel = (l: DiscordLobby): string =>
    l.state === 'full' ? 'Full'
    : l.state === 'strategy' ? 'Starting'
    : 'Match in progress';

  return (
    <div className="ds-console">
      <div className="ds-console-in narrow">
        <ConsoleHead
          onBack={onBack}
          title="Discord lobbies"
          sub="Everyone in this activity sees the same lobbies."
        />

        <section className="ds-sec">
          <button
            className="ds-cta"
            disabled={loading || mainBusy}
            onClick={() => onEnter(mainCode, mainGame)}
          >
            {loading ? 'CHECKING…'
              : mainBusy ? busyLabel(main as DiscordLobby).toUpperCase()
              : `JOIN MAIN LOBBY · ${seasonFor(mainGame).name.toUpperCase()}`}
          </button>
          <p className="ds-hint">
            {loading ? 'Checking what’s open in this activity…'
              : unknown ? 'Couldn’t check what’s open in this activity. You can still join the main lobby.'
              : mainBusy
                ? `${main?.players}/${main?.capacity} playing ${seasonFor(mainGame).name}. You can join when this match finishes, or open a separate lobby below.`
                : main
                  ? `${main.players}/${main.capacity} in the main lobby.`
                  : `Nobody has opened the main lobby yet. It will run ${seasonFor(game).name}, the season picked on the home page.`}
          </p>
        </section>

        <section className="ds-sec">
          <h2>Open lobbies</h2>
          {/* the house list states, one padding, so the section does not jump when rows land */}
          {loading ? (
            <div className="ds-loading">Loading…</div>
          ) : unknown ? (
            <div className="ds-empty">
              <div className="big">Couldn’t load the lobby list</div>
              It tries again every few seconds.
            </div>
          ) : others.length === 0 ? (
            <div className="ds-empty">
              <div className="big">No other lobbies open</div>
            </div>
          ) : (
            <div className="ds-lobbies">
              {others.map((l) => {
                const busy = l.joinable === false;
                return (
                  <button
                    key={l.code}
                    className="ds-lobby-row"
                    disabled={busy}
                    onClick={() => onEnter(l.code.toUpperCase(), l.game)}
                  >
                    <span className="ll-code">{l.code.toUpperCase()}</span>
                    <span className="ll-game">{seasonFor(l.game).name}</span>
                    <span className="ll-count">
                      {l.players}/{l.capacity}
                    </span>
                    <span className="ll-go">{busy ? busyLabel(l) : 'Join →'}</span>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <section className="ds-sec">
          <button className="ds-btn" onClick={() => onEnter(generateRoomCode(), game)}>
            Create a separate {seasonFor(game).name} lobby
          </button>
          <p className="ds-hint">To run a different season, pick it on the home page first.</p>
        </section>
      </div>
    </div>
  );
}
