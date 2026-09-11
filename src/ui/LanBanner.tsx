import { clearLanServer, lanActive, lanServerUrl } from '../net/env';

/**
 * "LAN — unofficial, not ranked", on every screen, for as long as this device is pointed at
 * a self-hosted server.
 *
 * ⚠️ **THIS IS NOT DECORATION.** Somebody who believes they are climbing a leaderboard and
 * is not has been actively misled, and a LAN room looks exactly like a real one: the same
 * lobby, the same field, the same scoreboard. The only thing that distinguishes them is
 * this strip, so it is persistent, it is not dismissible, and it carries the way out rather
 * than leaving the player to find the screen it was set on.
 *
 * It renders nothing at all on the ordinary path, so the cost of being unmissable is paid
 * only by the people it is about.
 */
export function LanBanner({ onLeave }: { onLeave?: () => void }) {
  if (!lanActive()) return null;
  return (
    <div className="ds-maint-wrap">
      <div className="ds-lan-banner" role="status">
        <span aria-hidden>⇄</span>
        <span>
          <b>LAN game</b> · {lanServerUrl().replace(/^ws:\/\//, '')} · unofficial, not ranked
        </span>
        <button
          className="ds-lan-leave"
          onClick={() => {
            clearLanServer();
            onLeave?.();
          }}
        >
          Leave
        </button>
      </div>
    </div>
  );
}
