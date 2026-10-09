import type { RobotSpec } from '../../types';
import { COPY } from './copy';
import type { ReviewItem } from './editorModel';

const GLYPH: Record<ReviewItem['level'], string> = { block: '✕', warn: '!', info: 'i', ok: '✓' };

/** the Review step's list and identity fields; the actions live in the editor's footer */
export function ReviewStep({
  items,
  spec,
  onIdentity,
  onFix,
}: {
  items: readonly ReviewItem[];
  spec: RobotSpec;
  onIdentity: (patch: Partial<Pick<RobotSpec, 'name' | 'teamName' | 'teamNumber'>>) => void;
  onFix: (item: ReviewItem) => void;
}) {
  return (
    <>
      <ul className="ds-import-checks">
        {items.map((it) => (
          <li key={it.id} className={it.level === 'block' ? 'bad' : it.level === 'ok' ? 'ok' : 'warn'}>
            <span className="g" aria-hidden="true">
              {GLYPH[it.level]}
            </span>
            <span className="t">
              <span className="ds-sr">{COPY.levelNames[it.level]}: </span>
              {it.text}
            </span>
            {it.fix && it.level !== 'ok' ? (
              <button type="button" className="ds-btn ghost small" aria-label={COPY.fixAria(it.text)} onClick={() => onFix(it)}>
                {COPY.fix}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="ds-fields">
        <label className="ds-field">
          <span className="cap">{COPY.robotName}</span>
          <input
            id="ri-name"
            className="ds-input"
            type="text"
            maxLength={24}
            value={spec.name}
            onChange={(e) => onIdentity({ name: e.target.value })}
          />
        </label>
        <label className="ds-field">
          <span className="cap">{COPY.teamName}</span>
          <input
            className="ds-input"
            type="text"
            maxLength={48}
            value={spec.teamName}
            onChange={(e) => onIdentity({ teamName: e.target.value })}
          />
        </label>
        <label className="ds-field narrow">
          <span className="cap">{COPY.teamNumber}</span>
          <input
            className="ds-input"
            type="number"
            min={0}
            max={99999}
            value={spec.teamNumber || ''}
            onChange={(e) => onIdentity({ teamNumber: Math.max(0, Math.min(99999, Math.round(Number(e.target.value) || 0))) })}
          />
        </label>
      </div>
    </>
  );
}
