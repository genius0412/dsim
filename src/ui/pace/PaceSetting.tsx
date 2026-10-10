import type { GameSettings, PaceSource } from '../../types';
import { PACE_SOURCES } from '../../settings';
import { seasonFor } from '../../seasons';
import { OptRow } from '../OptRow';

const LABEL: Record<PaceSource, string> = {
  off: 'Off',
  pb: 'Your best',
  wr: 'World record',
  replay: 'Replay',
};

/** what each source is measured against — the part the label cannot say (§8) */
const BLURB: Record<PaceSource, string> = {
  off: 'No pace line',
  pb: 'Follows your new bests',
  wr: 'Top of the record board',
  replay: 'One replay you pick',
};

/**
 * THE PACE SETTING, beside the other in-match read-outs (Audio and Visual). One pick, like the
 * performance read-out: what the line under your score is measured against. The replay pick
 * itself is made from the replay viewer (Use as pace), so here it is named, with a way to clear it.
 */
export function PaceSetting({
  settings,
  onChange,
}: {
  settings: GameSettings;
  onChange: (s: GameSettings) => void;
}) {
  const source = settings.pace ?? 'off';
  const picked = settings.paceReplays?.[settings.game];
  const game = seasonFor(settings.game).name;
  return (
    <>
      <OptRow<PaceSource>
        label="Pace"
        hint="Solo practice and records"
        value={source}
        cols="four"
        onPick={(pace) => onChange({ ...settings, pace })}
        options={PACE_SOURCES.map((v) => ({ v, t: LABEL[v], d: BLURB[v] }))}
      />
      {source === 'replay' && (
        <div className="ds-field">
          <span className="cap">
            {game} replay
            <span>{picked ? picked.label : 'None yet. Open a replay and choose Use as pace.'}</span>
          </span>
          {picked && (
            <div className="ds-opts two">
              <button
                className="ds-btn small"
                onClick={() => {
                  const rest = { ...settings.paceReplays };
                  delete rest[settings.game];
                  onChange({ ...settings, paceReplays: rest });
                }}
              >
                Clear
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
