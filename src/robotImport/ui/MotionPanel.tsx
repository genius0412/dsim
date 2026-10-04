import type { JointAxis, MotionDrive, MotionGroup, MotionPart, MotionRole } from '../types';
import { HINGE_ROLES, JOINT_DEFAULT_AMOUNT, JOINT_ROLES, MOTION_DRIVES, SPIN_ROLES } from '../types';
import { COPY } from './copy';
import { motionNames } from './editorModel';
import { NumberField } from './NumberField';

/** what a click in the preview does while a row is being picked: add its parts, or name its axle */
export type PickTarget = 'bodies' | 'axis';

/** the roles a part can be geared to another part's motion, or ride on another part */
const LINKABLE: readonly MotionRole[] = ['roller', 'flywheel', 'spin', 'swing', 'slide'];

/**
 * THE MOVING PARTS STEP (`docs/area/robot-import.md`, "Moving parts"): what turns, folds or slides
 * in a match. One row per part. Selecting a row shows its parts in the preview and makes a click
 * there add or take out parts (for a wheel, roller or flywheel, everything on its axle); its
 * settings open under it. Hovering a row shows its parts without selecting it. The parts are looked
 * for once on the first visit; Find moving parts again redoes that for every row the player has not
 * edited. For a mechanism no named kind covers, a spinning, swinging or sliding part is moved by
 * one of the robot's signals (`MotionDrive`), about a robot axis or a picked part's axle, or geared
 * to another part at a ratio, and can ride on another (an arm on a slide).
 */
export function MotionPanel({
  rampOk,
  groups,
  parts,
  active,
  target,
  playing,
  onHover,
  onActive,
  onChange,
  onRefind,
  onPlay,
}: {
  /** this build has a deployable ramp (BIOBUZZ's `ramp` intake) */
  rampOk: boolean;
  groups: readonly MotionGroup[];
  /** the moving parts as measured (`MotionPart.group` names the row) */
  parts: readonly MotionPart[];
  /** the selected row, or null, and what a click in the preview does for it */
  active: number | null;
  target: PickTarget;
  playing: boolean;
  /** a row under the pointer (null: none), shown in the preview while nothing is selected */
  onHover: (i: number | null) => void;
  onActive: (i: number | null, target?: PickTarget) => void;
  onChange: (next: MotionGroup[]) => void;
  /** look again for every moving part, keeping the rows the player has edited */
  onRefind: () => void;
  onPlay: (on: boolean) => void;
}) {
  // the measured part for each group (a group with no parts, or none it could fit, has none)
  const measured = new Map(parts.map((p) => [p.group, p]));
  const names = motionNames(groups);
  // an edit is the player's: the row is no longer "found"
  const set = (i: number, patch: Partial<MotionGroup>): void => onChange(groups.map((g, j) => (j === i ? { ...g, ...patch, found: undefined } : g)));
  const remove = (i: number): void => {
    onActive(null);
    onHover(null);
    // the rows after it move up one: what named them by index follows, and what named it goes
    const shift = (k: number | undefined): number | undefined => (k === undefined || k === i ? undefined : k > i ? k - 1 : k);
    onChange(
      groups
        .filter((_, j) => j !== i)
        .map((g) => {
          const out: MotionGroup = { ...g };
          const f = g.follows ? shift(g.follows.group) : undefined;
          if (g.follows && f !== undefined) out.follows = { ...g.follows, group: f };
          else delete out.follows;
          const r = shift(g.rideOn);
          if (r !== undefined) out.rideOn = r;
          else delete out.rideOn;
          return out;
        }),
    );
  };
  const add = (role: MotionRole): void => {
    onChange([...groups, { role, bodies: [] }]);
    onActive(groups.length, 'bodies');
  };
  const roles: MotionRole[] = ['roller', 'flywheel', 'turret', ...(rampOk ? (['ramp'] as const) : []), 'fold', ...JOINT_ROLES];
  const anyParts = groups.some((g) => g.bodies.length);
  return (
    <>
      <p className="ds-hint">{groups.length ? COPY.movingHint : COPY.movingNone}</p>
      <div className="ds-import-turns">
        {anyParts ? (
          <button type="button" className={`ds-btn small${playing ? ' primary' : ''}`} aria-pressed={playing} onClick={() => onPlay(!playing)}>
            {playing ? COPY.motionStop : COPY.motionPlay}
          </button>
        ) : null}
        <button type="button" className="ds-btn ghost small" onClick={onRefind}>
          {COPY.motionFind}
        </button>
      </div>
      {groups.length ? (
        <ul className="ds-import-moving" onMouseLeave={() => onHover(null)}>
          {groups.map((g, i) => {
            const p = measured.get(i);
            const on = active === i;
            const spin = SPIN_ROLES.includes(g.role);
            const hinge = HINGE_ROLES.includes(g.role);
            const joint = JOINT_ROLES.includes(g.role) ? (g.role as 'spin' | 'swing' | 'slide') : null;
            const pose = g.filePose ?? 'deployed';
            const others = groups.map((_, j) => j).filter((j) => j !== i && LINKABLE.includes(groups[j].role));
            const axis: JointAxis = g.axis ?? (joint === 'swing' ? 'left' : joint === 'slide' ? 'up' : 'part');
            const summary = g.bodies.length ? COPY.motionSummary(g.role, g.bodies.length, p, !!g.found) : COPY.motionEmpty;
            return (
              <li key={i} className={on ? 'on' : undefined} onMouseEnter={() => onHover(i)}>
                <button type="button" className="ds-import-moving-row" aria-expanded={on} onClick={() => onActive(on ? null : i, 'bodies')}>
                  <span className="what">
                    {names[i]}
                    <small>{summary}</small>
                  </span>
                  {on ? null : <span className="go">{COPY.motionEdit}</span>}
                </button>
                {on ? (
                  <div className="ds-import-moving-edit">
                    <p className="ds-hint">{target === 'axis' ? COPY.motionPickAxisHint : COPY.motionPickHint(g.role)}</p>
                    {spin || g.role === 'turret' || joint ? (
                      <label className="ds-checkline">
                        <input type="checkbox" checked={!!g.flip} onChange={(e) => set(i, { flip: e.target.checked })} />
                        {COPY.motionReverse(g.role)}
                      </label>
                    ) : null}
                    {hinge ? (
                      <div className="ds-import-moving-hinge">
                        <div className="ds-segs" role="group" aria-label={COPY.motionFileAria}>
                          {(['deployed', 'folded'] as const).map((v) => (
                            <button key={v} type="button" className={`ds-seg${pose === v ? ' on' : ''}`} aria-pressed={pose === v} onClick={() => set(i, { filePose: v })}>
                              {COPY.motionFile[v]}
                            </button>
                          ))}
                        </div>
                        {pose === 'deployed' ? (
                          <NumberField
                            label={COPY.motionFoldBy}
                            unit="°"
                            value={g.foldDeg ?? Math.round(((p?.deploy ?? 0) * 180) / Math.PI)}
                            min={0}
                            max={180}
                            step={5}
                            onCommit={(v) => set(i, { foldDeg: v })}
                          />
                        ) : (
                          <NumberField
                            label={COPY.motionDeployBy}
                            unit="°"
                            value={g.deployDeg ?? Math.round(((p?.deploy ?? 0) * 180) / Math.PI)}
                            min={0}
                            max={180}
                            step={5}
                            onCommit={(v) => set(i, { deployDeg: v })}
                          />
                        )}
                      </div>
                    ) : null}
                    {joint ? (
                      <div className="ds-import-moving-hinge">
                        <label className="ds-field narrow">
                          <span className="cap">{COPY.motionDriveLabel}</span>
                          <select
                            className="ds-select"
                            value={g.follows ? '' : (g.drive ?? (joint === 'spin' ? 'always' : 'intake'))}
                            disabled={!!g.follows}
                            onChange={(e) => set(i, { drive: e.target.value as MotionDrive })}
                          >
                            {g.follows ? <option value="">{COPY.motionGearedShort}</option> : null}
                            {MOTION_DRIVES.map((d) => (
                              <option key={d} value={d}>
                                {COPY.motionDrives[d]}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="ds-field">
                          <span className="cap">{joint === 'slide' ? COPY.motionAlong : COPY.motionAbout}</span>
                          <div className="ds-segs" role="group" aria-label={joint === 'slide' ? COPY.motionAlong : COPY.motionAbout}>
                            {(['forward', 'left', 'up', 'part'] as const).map((a) => (
                              <button
                                key={a}
                                type="button"
                                className={`ds-seg${axis === a ? ' on' : ''}`}
                                aria-pressed={axis === a}
                                onClick={() => (a === 'part' ? onActive(i, 'axis') : set(i, { axis: a, axisBody: undefined }))}
                              >
                                {a === 'part' && g.axis === 'part' && g.axisBody !== undefined ? COPY.motionAxisPicked : COPY.motionAxes[a]}
                              </button>
                            ))}
                          </div>
                        </div>
                        {g.follows ? null : (
                          <NumberField
                            label={COPY.motionAmount[joint].label}
                            unit={COPY.motionAmount[joint].unit}
                            value={g.amount ?? JOINT_DEFAULT_AMOUNT[joint]}
                            min={0}
                            max={joint === 'spin' ? 50 : joint === 'swing' ? 720 : 60}
                            step={joint === 'spin' ? 0.5 : joint === 'swing' ? 5 : 0.25}
                            onCommit={(v) => set(i, { amount: v })}
                          />
                        )}
                      </div>
                    ) : null}
                    {LINKABLE.includes(g.role) && others.length ? (
                      <div className="ds-import-moving-hinge">
                        <label className="ds-field narrow">
                          <span className="cap">{COPY.motionGeared}</span>
                          <select
                            className="ds-select"
                            value={g.follows ? String(g.follows.group) : ''}
                            onChange={(e) => set(i, { follows: e.target.value === '' ? undefined : { group: Number(e.target.value), ratio: g.follows?.ratio ?? 1 } })}
                          >
                            <option value="">{COPY.motionNone}</option>
                            {others.map((j) => (
                              <option key={j} value={String(j)}>
                                {names[j]}
                              </option>
                            ))}
                          </select>
                        </label>
                        {g.follows ? (
                          <NumberField label={COPY.motionRatio} unit="×" value={g.follows.ratio} min={-100} max={100} step={0.05} onCommit={(v) => set(i, { follows: { group: g.follows!.group, ratio: v } })} />
                        ) : null}
                        <label className="ds-field narrow">
                          <span className="cap">{COPY.motionRides}</span>
                          <select className="ds-select" value={g.rideOn !== undefined ? String(g.rideOn) : ''} onChange={(e) => set(i, { rideOn: e.target.value === '' ? undefined : Number(e.target.value) })}>
                            <option value="">{COPY.motionNone}</option>
                            {others.map((j) => (
                              <option key={j} value={String(j)}>
                                {names[j]}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    ) : null}
                    <div className="ds-import-turns">
                      <button type="button" className="ds-btn small primary" onClick={() => onActive(null)}>
                        {COPY.motionDone}
                      </button>
                      <button type="button" className="ds-btn ghost small" aria-label={COPY.motionRemoveAria(names[i])} onClick={() => remove(i)}>
                        {COPY.motionRemove}
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <label className="ds-field narrow">
        <span className="cap">{COPY.motionAddCap}</span>
        <select
          className="ds-select"
          value=""
          onChange={(e) => {
            if (e.target.value) add(e.target.value as MotionRole);
          }}
        >
          <option value="">{COPY.motionAddPick}</option>
          {roles.map((r) => (
            <option key={r} value={r}>
              {COPY.motionAddKind(r)}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
