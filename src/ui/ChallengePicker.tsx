import { useEffect, useId, useState } from 'react';
import { serverCaps } from '../net/api';
import type { ChallengeFormat } from '../net/protocol';
import { useDialog } from './useDialog';

export type { ChallengeFormat };

/**
 * The FORMAT a "Play a friend" challenge is issued in, and how each one resolves:
 *
 *  - `casual1v1` / `casual2v2` → a custom `versus` room (up to 4 drivers; the
 *    1v1-vs-2v2 split is emergent from how many join + alliance choice in the
 *    lobby, not a server flag). Unrated — a code-joined room never rates.
 *  - `duorecord` → a `record`/`duo` co-op run (2v0, opponent-free score attack).
 *  - `ranked2v2` → NOT a room. Both sides hand the matchmaker the challenge token and the two of you queue into the OPEN ranked
 *    2v2 pool as a premade and are kept on one alliance. You wait for two more
 *    like anybody else.
 *
 * The ranked one needs a server that understands parties, which is not a given: one
 * Fly app serves every client build. They stay disabled until it says otherwise —
 * see `serverCaps`.
 */
interface FormatTile {
  format: ChallengeFormat;
  title: string;
  /** server capability this format needs, if any */
  needs?: string;
}

/**
 * NO sub-labels. Every one of these five carried a `.od` line that opened by
 * restating its own title — "Unrated." under "· Casual", "Counts for ELO." under
 * "· Rated", "No opponent." under "2v0" — and this was the last place in the app
 * still doing it: the same 1v1/2v2 tiles one click away in `Matchmaking` describe
 * themselves. The `.od` slot survives ONLY for the two transient states below,
 * which say something the title cannot.
 */
const TILES: FormatTile[] = [
  { format: 'ranked2v2', title: '2v2 · Ranked, same team', needs: 'party' },
  { format: 'casual1v1', title: '1v1 · Room' },
  { format: 'casual2v2', title: '2v2 · Room' },
  { format: 'duorecord', title: '2v0 · Co-op record' },
];

/**
 * The "Play a friend" challenge picker — chess.com's "New game" chooser, DECODE-
 * shaped. Sending NAVIGATES away (into the lobby, or into the queue for a rated
 * format), which unmounts this modal — so only a failed send ever lands back
 * here, where the reason is shown and the tiles re-enable.
 */
export function ChallengePicker({
  username,
  onPick,
  onClose,
}: {
  username: string;
  onPick: (format: ChallengeFormat) => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<ChallengeFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  // null until the capability read lands. The gated tiles render DISABLED
  // meanwhile rather than hidden — appearing a beat late is fine, appearing out
  // of nowhere under a cursor that's already moving is not.
  const [caps, setCaps] = useState<string[] | null>(null);
  // Escape is the ✕, and like the ✕ it does nothing while a challenge is being sent
  const ref = useDialog(busy ? undefined : onClose);
  const titleId = useId();

  useEffect(() => {
    let alive = true;
    void serverCaps().then((c) => {
      if (alive) setCaps(c);
    });
    return () => {
      alive = false;
    };
  }, []);

  const pick = (format: ChallengeFormat): void => {
    setBusy(format);
    setError(null);
    void onPick(format).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : 'Couldn’t send the challenge.');
      setBusy(null);
    });
  };

  return (
    <div className="ds-modal-backdrop" role="presentation" onClick={busy ? undefined : onClose}>
      {/* the dialog is the CARD, not the scrim, labelled by its visible title */}
      <div
        ref={ref}
        className="ds-modal ds-chal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ds-modal-h">
          <h2 className="ds-dialog-title" id={titleId}>
            Invite @{username}
          </h2>
          <button className="ds-btn ghost" onClick={onClose} aria-label="Close" disabled={!!busy}>
            ✕
          </button>
        </div>

        <div className="ds-chal-list">
          {TILES.map((t, i) => {
            const pendingCaps = !!t.needs && caps === null;
            const unsupported = !!t.needs && caps !== null && !caps.includes(t.needs);
            return (
              <button
                key={t.format}
                className="ds-opt"
                // first focus on the first real option, not the ✕ `useDialog` would pick;
                // tile 0 needs no capability, so it is enabled on mount
                autoFocus={i === 0}
                disabled={!!busy || pendingCaps || unsupported}
                onClick={() => pick(t.format)}
              >
                <span className="ot">{t.title}</span>
                {/* rendered only when it has something to say, so an idle tile keeps
                    `.ds-opt:not(:has(.od))`'s 62px floor and the row does not reflow
                    when one appears (title + gap + one line fits inside it) */}
                {(busy === t.format || unsupported) && (
                  <span className="od">
                    {busy === t.format ? 'Sending challenge…' : 'Not available on this server'}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {error && <p className="ds-form-err">{error}</p>}
      </div>
    </div>
  );
}
