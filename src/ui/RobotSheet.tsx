import { Fragment, useMemo } from 'react';
import type { AssistConfig, RobotSpec } from '../types';
import type { GameId } from '../games/types';
import { moduleFor } from '../games';
import { coerceSpec } from '../sim/spawn';
import { ChainRobotPreview } from '../games/chain/RobotPreview';
import { FootprintSvg } from './FootprintSvg';
import { RobotPreview } from './RobotPreview';
import { DRIVETRAIN_LABELS, drivingWords, specSheet, teamLine } from './robotLabels';

/**
 * SOMEBODY ELSE'S ROBOT, described — a leaderboard record's build (`RobotSheet`) and the rows a
 * ranked strategy card prints under a partner's name (`SpecList`).
 *
 * Both used to print the build as one sentence of parts joined by ` · `, and on the leaderboard
 * that sentence sat in a stat tile captioned CONFIG beside four on/off assist chips that were the
 * same four for every game. A sheet is the robot's picture, then one row per job it does (what
 * the part is FOR on the left, what it IS on the right), then the chassis numbers, then how it was
 * driven, in the words of the one game it was built for (`specSheet`, `drivingWords`).
 *
 * NOT for a robot CARD (`RobotCard`): the owner keeps those to the name and one line of
 * mechanisms (2026-09-22), and a card sits beside a builder that already shows the rest.
 */

/** the rows of a spec sheet as a definition list. `compact` (a strategy card) drops each row's
 * second line and leads with the drivetrain, which the card has no strip for. */
export function SpecList({ spec, game, compact = false }: { spec: RobotSpec; game: GameId; compact?: boolean }) {
  const rows = specSheet(spec, game);
  if (compact) rows.unshift({ label: 'Drive', value: `${DRIVETRAIN_LABELS[spec.drivetrain]}, ${spec.driveRpm} rpm` });
  return (
    <dl className={`ds-specs${compact ? ' compact' : ''}`}>
      {rows.map((r) => (
        <div key={r.label} className={`ds-spec${r.absent ? ' absent' : ''}`}>
          <dt>{r.label}</dt>
          <dd>
            <span className="v">{r.value}</span>
            {!compact && r.sub ? (
              // a narrow sheet wraps the line at its ` · ` breaks, never inside "POLLEN + NECTAR"
              <span className="s">
                {r.sub.split(' · ').map((part, i) => (
                  <Fragment key={i}>
                    {i > 0 ? ' · ' : null}
                    <span className="nb">{part}</span>
                  </Fragment>
                ))}
              </span>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** the robot's 2D picture: an import's footprint, else the game's own schematic — the same
 * choice `ModeSelect` makes for its stage */
export function RobotPicture({ spec, game, size }: { spec: RobotSpec; game: GameId; size: number }) {
  const mod = moduleFor(game);
  if (spec.imported) return <FootprintSvg imported={spec.imported} drivetrain={spec.drivetrain} size={size} />;
  if (mod.Preview) return <mod.Preview spec={spec} size={size} caption={false} />;
  return mod.id === 'chain' ? (
    <ChainRobotPreview spec={spec} size={size} caption={false} />
  ) : (
    <RobotPreview spec={spec} size={size} caption={false} />
  );
}

/**
 * One robot's full sheet. `assists` is how it was DRIVEN: present for the record's owner, absent
 * for a duo partner, whose assists a record does not store.
 */
export function RobotSheet({ spec, game, assists }: { spec: RobotSpec; game: GameId; assists?: AssistConfig }) {
  // THE PICTURE GETS A COERCED SPEC. A record stores the build it was set with, and a schematic
  // drawn from a spec older than today's fields could throw and take the board down with it. The
  // TEXT reads the stored spec: every resolver `specSheet` calls is safe on a raw one, and the
  // numbers a record was set with are the ones it should print, not today's clamp of them.
  const drawn = useMemo(() => coerceSpec(spec, undefined, game), [spec, game]);
  const team = teamLine(spec);
  const stat = (value: string, label: string) => (
    <div className="ds-sheet-stat">
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
  return (
    <div className="ds-sheet">
      <div className="ds-sheet-top">
        <div className="ds-sheet-pic" aria-hidden>
          <RobotPicture spec={drawn} game={game} size={112} />
        </div>
        <div className="ds-sheet-body">
          <div className="ds-sheet-head">
            <span className="ds-sheet-name">{spec.name || 'Unnamed'}</span>
            {team ? <span className="ds-sheet-team">{team}</span> : null}
          </div>
          <SpecList spec={spec} game={game} />
        </div>
      </div>
      {/* the FOOT spans the whole card, picture column included: the numbers and the chips are
          short items in a row, and beside the picture they wrapped in a two-column board */}
      <div className="ds-sheet-foot">
        <div className="ds-sheet-chassis">
          {stat(DRIVETRAIN_LABELS[spec.drivetrain], 'drivetrain')}
          {stat(String(spec.massLb), 'lb')}
          {stat(String(spec.driveRpm), 'rpm')}
          {stat(`${spec.length}×${spec.width}"`, 'size')}
        </div>
        {assists ? (
          <div className="ds-sheet-drive">
            {drivingWords(assists, spec, game).map((w) => (
              <span key={w} className="ds-chip">
                {w}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
