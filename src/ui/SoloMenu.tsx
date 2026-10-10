import { useState } from 'react';
import { APP_NAME } from '../seasons';
import { markTutorialSeen, tutorialSeen } from '../tutorial/flag';
import type { GameId } from '../games/types';
import { PAGE_COPY as IMPORT_COPY } from '../robotImport/ui/pageCopy';
import { MenuTile } from './MenuTile';

/**
 * The on-your-own half of what PLAY used to be: practice and free drive (offline, always
 * available) and the two record runs (online). Every start is wrapped in App's `guardStart()` by
 * the caller.
 */
export function SoloMenu({
  multiplayer,
  compete = true,
  importedActive = false,
  game,
  onSoloMatch,
  onFreeDrive,
  onRecordRun,
  onDuoRecord,
  onTutorial,
}: {
  multiplayer: boolean;
  /** show the record runs. Off inside a Discord Activity, which has no account to record to. */
  compete?: boolean;
  /** the active robot is an IMPORT, which record runs refuse: their tiles say they play the last
   *  standard robot instead (the server enforces it; this is the player being told first) */
  importedActive?: boolean;
  /** the season the tutorial offer is for: the seen flag is kept PER GAME */
  game?: GameId;
  onSoloMatch: () => void;
  onFreeDrive: () => void;
  onRecordRun: () => void;
  onDuoRecord: () => void;
  /**
   * START THE TUTORIAL — absent when the active game has none, in which case nothing here mentions
   * one. The CARD is offered only to a device that has not been through it (`tutorialSeen`,
   * per-device and fail-open): once you have played, an offer to be taught is clutter, and Controls
   * keeps an entry that runs it again.
   */
  onTutorial?: () => void;
}) {
  /** READ ONCE, at mount: the tutorial sets the flag itself, so re-reading on every render would
   *  make the card vanish mid-interaction if the page re-rendered while a run was finishing */
  const [seen, setSeen] = useState(() => tutorialSeen(game));
  const recordHint = importedActive ? IMPORT_COPY.standardOnly : undefined;
  return (
    <div className="ds-menupage">
      {onTutorial && !seen && (
        <div className="ds-tut-offer">
          {/* NO SUB-LINE and NO STEP COUNT: the count is resolved per game and per ROBOT
              (`TutorialStep.applies`), so the only honest place to print it is the card itself,
              which does print it. NOT NOW sets the flag that finishing or exiting a run sets, so
              an experienced driver on a new device is not made to start it to be rid of the offer. */}
          <b>New to {APP_NAME}?</b>
          <span className="ds-tut-offer-acts">
            <button
              className="ds-btn ghost"
              onClick={() => {
                markTutorialSeen(game);
                setSeen(true);
              }}
            >
              Not now
            </button>
            <button className="ds-btn primary" onClick={onTutorial}>
              Start the tutorial
            </button>
          </span>
        </div>
      )}
      <nav className="ds-tilestack" aria-label="Solo">
        <MenuTile
          title="Solo practice"
          mono="PRC"
          hue="violet"
          hint="A full match on your own"
          onClick={onSoloMatch}
        />
        <MenuTile title="Free drive" mono="FD" hue="blue" hint="The field, no match clock" onClick={onFreeDrive} />
        {compete && (
          <>
            <MenuTile
              title="Solo record"
              mono="REC"
              hue="coral"
              disabled={!multiplayer}
              hint={recordHint ?? 'A scored run for the leaderboard'}
              onClick={onRecordRun}
            />
            <MenuTile
              title="Duo record"
              mono="2P"
              hue="amber"
              disabled={!multiplayer}
              hint={recordHint ?? 'A scored run with a partner'}
              onClick={onDuoRecord}
            />
          </>
        )}
      </nav>
    </div>
  );
}
