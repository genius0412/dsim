import { Fragment, type ReactNode } from 'react';
import type { DrivetrainType } from '../../types';
import { OptRow } from '../../ui/OptRow';
import { DRIVETRAIN_LABELS } from '../../ui/labelData';
import { GOBILDA_RATIOS, WHEELS, wheelDiameterMm } from '../drive';
import type { DriveSetup, MotorChoice, WheelChoice } from '../types';
import { COPY } from './copy';
import type { DriveNumbers } from './editorModel';
import { NumberField } from './NumberField';

type Family = MotorChoice['kind'];

/** the UltraPlanetary stacks a team actually builds, motor side first */
const HD_STACKS: readonly (3 | 4 | 5)[][] = [[], [3], [4], [5], [3, 3], [3, 4], [3, 5], [4, 4], [4, 5], [5, 5], [3, 4, 5], [4, 4, 5], [4, 5, 5], [5, 5, 5]];
const stackKey = (c: readonly number[]): string => (c.length ? c.join('-') : 'none');
const stackLabel = (c: readonly number[]): string => (c.length ? c.map((n) => `${n}:1`).join(' × ') : 'No gearbox');

/** which wheels a drivetrain rolls on */
const WHEEL_TYPES: Record<DrivetrainType, readonly string[]> = {
  mecanum: ['mecanum'],
  butterfly: ['mecanum'],
  xdrive: ['omni'],
  tank: ['traction', 'omni'],
  swerve: ['traction'],
};

/** a motor of a family, at its catalogue default */
function motorOf(kind: Family, prev: MotorChoice): MotorChoice {
  if (prev.kind === kind) return prev;
  switch (kind) {
    case 'gobilda':
      return { kind, ratio: '19.2' };
    case 'revHdHex':
      return { kind, cartridges: [4, 5] };
    case 'revCoreHex':
      return { kind };
    case 'neverest':
      return { kind, model: 'orbital20' };
    case 'custom':
      return { kind, freeRpm: 312 };
  }
}

const r0 = (v: number): string => Math.round(v).toString();
const r1 = (v: number): string => (Math.round(v * 10) / 10).toFixed(1);

export function DrivetrainStep({
  drive,
  numbers,
  onDrive,
  tuning,
}: {
  drive: DriveSetup;
  numbers: DriveNumbers | null;
  onDrive: (patch: Partial<DriveSetup>) => void;
  /** the drive's practice tuning (`TunePanel`), after the numbers */
  tuning?: ReactNode;
}) {
  const m = drive.motor;
  const wheelTypes = WHEEL_TYPES[drive.drivetrain];
  const wheels = WHEELS.filter((w) => wheelTypes.includes(w.type));
  const wheelValue = drive.wheel.kind === 'custom' ? 'custom' : drive.wheel.id;
  const pickWheel = (v: string): void => {
    const next: WheelChoice = v === 'custom' ? { kind: 'custom', diameterMm: wheelDiameterMm(drive.wheel) } : { kind: 'catalogue', id: v };
    onDrive({ wheel: next });
  };
  return (
    <>
      <OptRow<DrivetrainType>
        label={COPY.drivetrain}
        value={drive.drivetrain}
        cols="five"
        mini
        options={(Object.keys(DRIVETRAIN_LABELS) as DrivetrainType[]).map((d) => ({ v: d, t: DRIVETRAIN_LABELS[d] }))}
        onPick={(d) => {
          // a wheel the new drivetrain does not roll on goes to that drivetrain's first catalogue wheel
          const ok = drive.wheel.kind === 'custom' || WHEELS.some((w) => w.id === (drive.wheel as { id: string }).id && WHEEL_TYPES[d].includes(w.type));
          const first = WHEELS.find((w) => WHEEL_TYPES[d].includes(w.type));
          onDrive({ drivetrain: d, ...(ok || !first ? {} : { wheel: { kind: 'catalogue', id: first.id } as WheelChoice }) });
        }}
      />
      <div id="ri-motor">
        <OptRow<Family>
          label={COPY.motor}
          value={m.kind}
          cols="five"
          mini
          options={COPY.motorFamilies.map(([v, t]) => ({ v, t }))}
          onPick={(k) => onDrive({ motor: motorOf(k, m) })}
        />
      </div>
      {m.kind === 'gobilda' ? (
        <OptRow<string>
          label={COPY.gearbox}
          value={m.ratio}
          cols="five"
          mini
          // by ratio: the keys read like numbers, so object order put 1:1, 139:1 and 188:1 first
          options={Object.entries(GOBILDA_RATIOS)
            .sort((x, y) => x[1].ratio - y[1].ratio)
            .map(([k, v]) => ({ v: k, t: `${v.freeRpm} rpm` }))}
          onPick={(ratio) => onDrive({ motor: { kind: 'gobilda', ratio } })}
        />
      ) : m.kind === 'revHdHex' ? (
        <OptRow<string>
          label={COPY.gearbox}
          value={stackKey(m.cartridges)}
          cols="five"
          mini
          options={HD_STACKS.map((c) => ({ v: stackKey(c), t: stackLabel(c) }))}
          onPick={(k) => onDrive({ motor: { kind: 'revHdHex', cartridges: (HD_STACKS.find((c) => stackKey(c) === k) ?? []).slice() } })}
        />
      ) : m.kind === 'neverest' ? (
        <OptRow<'orbital20' | 'orbital3.7'>
          label={COPY.gearbox}
          value={m.model}
          cols="two"
          mini
          options={[
            { v: 'orbital20', t: 'Orbital 20' },
            { v: 'orbital3.7', t: 'Orbital 3.7' },
          ]}
          onPick={(model) => onDrive({ motor: { kind: 'neverest', model } })}
        />
      ) : m.kind === 'custom' ? (
        <div className="ds-fields">
          <NumberField
            label={COPY.freeSpeed}
            unit="rpm"
            value={m.freeRpm}
            min={1}
            max={10000}
            step={1}
            onCommit={(freeRpm) => onDrive({ motor: { kind: 'custom', freeRpm } })}
          />
        </div>
      ) : null}

      <div className="ds-fields">
        <NumberField
          label={COPY.extRatio}
          unit=":1"
          value={drive.externalRatio}
          min={0.1}
          max={10}
          step={0.05}
          onCommit={(externalRatio) => onDrive({ externalRatio })}
        />
        {drive.drivetrain === 'butterfly' ? (
          <NumberField
            id="ri-tank"
            label={COPY.tankRatio}
            unit=":1"
            value={drive.tankExternalRatio ?? drive.externalRatio}
            min={0.1}
            max={10}
            step={0.05}
            onCommit={(tankExternalRatio) => onDrive({ tankExternalRatio })}
          />
        ) : null}
        <NumberField
          id="ri-weight"
          label={COPY.weight}
          unit="lb"
          value={drive.massLb}
          min={1}
          max={60}
          step={0.1}
          onCommit={(massLb) => onDrive({ massLb })}
        />
      </div>

      <OptRow<string>
        label={COPY.wheel}
        value={wheelValue}
        mini
        options={[...wheels.map((w) => ({ v: w.id, t: w.label })), { v: 'custom', t: COPY.custom }]}
        onPick={pickWheel}
      />
      {drive.wheel.kind === 'custom' ? (
        <div className="ds-fields">
          <NumberField
            label={COPY.diameter}
            unit="mm"
            value={drive.wheel.diameterMm}
            min={25}
            max={200}
            step={0.5}
            onCommit={(diameterMm) => onDrive({ wheel: { kind: 'custom', diameterMm } })}
          />
        </div>
      ) : null}

      {numbers ? (
        <>
          <div className="ds-stats" aria-live="polite">
            <div className="ds-stat">
              <span className="sv">{r0(numbers.rpm)}</span>
              <span className="sl">{COPY.statRpm}</span>
            </div>
            <div className="ds-stat">
              <span className="sv">{r0(numbers.topSpeed)} in/s</span>
              <span className="sl">{COPY.statSpeed}</span>
            </div>
            <div className="ds-stat">
              <span className="sv">{r0(numbers.accel)} in/s²</span>
              <span className="sl">{COPY.statAccel}</span>
            </div>
            <div className="ds-stat">
              <span className="sv">{r1(numbers.pushLbf)} lbf</span>
              <span className="sl">{COPY.statPush}</span>
            </div>
          </div>
          <dl className="ds-facts">
            {numbers.lines.map((l) => (
              <Fragment key={l.label}>
                <dt>{l.label}</dt>
                <dd className={l.warn ? 'warn' : undefined}>{l.text}</dd>
              </Fragment>
            ))}
          </dl>
        </>
      ) : null}
      {tuning}
    </>
  );
}
