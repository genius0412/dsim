import { useId } from 'react';
import { useDialog } from './useDialog';
import { setShareOwnLook } from '../net/importVisualsPref';

/**
 * "SHARE YOUR ROBOT'S LOOK?" — asked ONCE per device, the first time a player's imported robot is
 * about to go into an online room (`Lobby` decides when; this only asks and records the answer).
 *
 * WHY IT ASKS. A robot's outline and measurements always travel with it: the room needs them to play.
 * Its top picture and, in BIOBUZZ, a lighter copy of its 3D model come straight from the team's CAD, which
 * teams keep private before an event. So those are sent only after a yes, and the answer is a per-device
 * preference (`getShareOwnLook`), not a field of the synced settings.
 *
 * ⚠️ THE SAFE ANSWER IS THE EASY ONE. "Keep it private" is the first control, so it takes the focus
 * `useDialog` gives the first control; Escape, a click outside the card and the pad's B button
 * (`data-padnav-back`) all mean it. Neither button is `.primary`: the pad's Y presses the first primary on
 * the page, and nothing here may be a default yes. Not a dialog that must be answered, so it has an
 * Escape; the answer is recorded either way, which is what stops it asking again.
 */
export function ShareLookDialog({ onAnswered }: { onAnswered?: () => void }) {
  const id = useId();
  const keepPrivate = (): void => {
    setShareOwnLook(false);
    onAnswered?.();
  };
  const share = (): void => {
    setShareOwnLook(true);
    onAnswered?.();
  };
  const ref = useDialog<HTMLDivElement>(keepPrivate);
  return (
    <div className="ds-modal-backdrop" role="presentation" onClick={keepPrivate}>
      <div
        ref={ref}
        className="ds-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ds-modal-h">
          <h2 className="ds-dialog-title" id={id}>
            Share your robot’s look?
          </h2>
        </div>
        <div className="ds-form">
          <p>
            Everyone in this room sees your imported robot’s outline. Sharing also sends them its top picture and, in
            BIOBUZZ, a lighter copy of the 3D model made from your CAD. The room keeps them in memory only while it lasts.
          </p>
          <p className="ds-hint">You can change this in Configure, Network.</p>
        </div>
        <div className="ds-dialog-actions">
          <button type="button" className="ds-btn" data-padnav-back onClick={keepPrivate}>
            Keep it private
          </button>
          <button type="button" className="ds-btn" onClick={share}>
            Share it
          </button>
        </div>
      </div>
    </div>
  );
}
