import { useState } from 'react';

/**
 * The FORMAT a "Play a friend" challenge is issued in. Only the three below are
 * buildable on today's pipes:
 *  - `casual1v1` / `casual2v2` → a custom `versus` room (up to 4 drivers; the
 *    1v1-vs-2v2 split is emergent from how many join + alliance choice in the
 *    lobby, not a server flag). Unrated — a code/invite-joined room never rates.
 *  - `duorecord` → a `record`/`duo` co-op run (2v0, opponent-free score attack).
 *
 * Rated 1v1 and ranked-with-a-friend 2v2 are DELIBERATELY absent (shown disabled):
 * rating is only applied to matchmaker-staged rooms and there is no premade/party
 * concept in the matchmaker yet (see HANDOFF's feasibility map). They need server
 * work, not a UI toggle.
 */
export type ChallengeFormat = 'casual1v1' | 'casual2v2' | 'duorecord';

interface FormatTile {
  format: ChallengeFormat;
  title: string;
  desc: string;
}

const TILES: FormatTile[] = [
  {
    format: 'casual1v1',
    title: '1v1 · Casual',
    desc: 'A head-to-head practice match against your friend. Unrated.',
  },
  {
    format: 'casual2v2',
    title: '2v2 · Team up',
    desc: 'Play on the same alliance — set teams and add drivers in the lobby. Unrated.',
  },
  {
    format: 'duorecord',
    title: '2v0 · Co-op record',
    desc: 'Team up for a score-attack record run — no opponent.',
  },
];

// Formats the current server can't produce (rated invite rooms / premade ranked
// parties). Listed so the picker reads complete, but disabled.
const SOON: { title: string; desc: string }[] = [
  { title: '1v1 · Rated', desc: 'Ranked head-to-head with a friend.' },
  { title: '2v2 · Ranked', desc: 'Queue ranked together as a team.' },
];

/**
 * The "Play a friend" format picker (chess.com's "New game" chooser, DECODE-shaped).
 * Success NAVIGATES away (host the room), which unmounts this modal — so only a
 * failed invite (`onPick` rejects) ever lands back here, where we surface the reason
 * and re-enable the tiles.
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

  const pick = (format: ChallengeFormat): void => {
    setBusy(format);
    setError(null);
    void onPick(format).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : 'Could not send the challenge.');
      setBusy(null);
    });
  };

  return (
    <div
      className="ds-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Play a friend — @${username}`}
      onClick={busy ? undefined : onClose}
    >
      <div className="ds-modal ds-chal" onClick={(e) => e.stopPropagation()}>
        <div className="ds-modal-h">
          <span className="ds-panel-title">Play @{username}</span>
          <button className="ds-btn ghost" onClick={onClose} aria-label="Close" disabled={!!busy}>
            ✕
          </button>
        </div>

        <div className="ds-chal-list">
          {TILES.map((t) => (
            <button
              key={t.format}
              className="ds-opt"
              disabled={!!busy}
              onClick={() => pick(t.format)}
            >
              <span className="ot">{t.title}</span>
              <span className="od">{busy === t.format ? 'Sending challenge…' : t.desc}</span>
            </button>
          ))}
          {SOON.map((t) => (
            <button key={t.title} className="ds-opt" disabled title="Coming soon">
              <span className="ot">{t.title}</span>
              <span className="od">{t.desc}</span>
              <span className="oz soon">Soon</span>
            </button>
          ))}
        </div>

        {error && <p className="ds-form-err">{error}</p>}
      </div>
    </div>
  );
}
