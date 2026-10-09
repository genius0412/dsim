import type { ImportTuning } from '../../types';
import { COPY } from './copy';
import { NumberField } from './NumberField';
import { setTune, type TuneField } from './tuneFields';

/**
 * PRACTICE TUNING (`ImportTuning`): one field per number the build has, showing what the sim
 * derives until the player types over it, and a Reset beside a tuned one. Tuned numbers play in
 * solo practice, Free Drive and the test drive; a room plays the calculated ones (`stripTune`).
 */
export function TunePanel({
  id,
  title,
  fields,
  tune,
  onTune,
}: {
  id: string;
  title: string;
  fields: readonly TuneField[];
  tune: ImportTuning | undefined;
  onTune: (next: ImportTuning | undefined) => void;
}) {
  if (!fields.length) return null;
  const tuned = fields.some((f) => tune?.[f.key] !== undefined);
  return (
    <>
      <h3 className="ds-subh" id={id} tabIndex={-1}>
        {title}
      </h3>
      <p className="ds-hint">{COPY.tuneHint}</p>
      <div className="ds-import-tune">
        {fields.map((f) => {
          const v = tune?.[f.key];
          return (
            <div key={f.key} className={`ds-import-tune-row${v !== undefined ? ' on' : ''}`}>
              <NumberField label={f.label} unit={f.unit} value={v ?? f.calculated} min={f.min} max={f.max} step={f.step} onCommit={(n) => onTune(setTune(tune, f.key, n))} />
              {v !== undefined ? (
                <button type="button" className="ds-btn ghost small" aria-label={COPY.tuneResetAria(f.label)} onClick={() => onTune(setTune(tune, f.key, undefined))}>
                  {COPY.tuneReset}
                </button>
              ) : (
                <span className="ds-hint">{COPY.tuneCalculated}</span>
              )}
            </div>
          );
        })}
      </div>
      {tuned ? (
        <div>
          <button type="button" className="ds-btn ghost small" onClick={() => onTune(fields.reduce<ImportTuning | undefined>((t, f) => setTune(t, f.key, undefined), tune))}>
            {COPY.tuneResetAll}
          </button>
        </div>
      ) : null}
    </>
  );
}
