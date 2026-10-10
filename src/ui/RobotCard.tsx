import type { ReactNode } from 'react';
import type { RobotSpec } from '../types';
import type { GameId } from '../games/types';
import { buildWords } from './robotLabels';
import { Marquee } from './Marquee';

/**
 * ONE ROBOT CARD — a saved robot and a preset in the builder's `Start from`, and a saved robot in
 * the "Your robot" swap row of the custom-room lobby and the ranked strategy window.
 *
 * ── WHY ONE COMPONENT ─────────────────────────────────────────────────────────────────────
 * Owner, 2026-09-22: "Saved robot display. Robot preview card. All these descriptions add no
 * value. It is visual clutter." There were four spellings of a robot in a tile. A preset card
 * carried a tagline, a spec line AND a loadout chip — three readings of one robot, each repeating
 * the others (`Tank · 18 lb · 286 rpm · FRONT sweeper · 4 pollen` under `Kit robot · 6WD tank`
 * over `DUMPER · FRONT`). A saved card carried a different spec line, and on BIOBUZZ's 3D view no
 * line at all, only a picture — so a thumbnail that did not render left a tall empty block with a
 * name in its corner. The swap rows said a name and a drivetrain.
 *
 * So a card is: the NAME, the TEAM when there is one, and ONE line — `buildWords`, the drivetrain
 * and the mechanisms. The numbers are the hero's; the tagline was flavour. A picture, when the
 * caller passes one (every saved robot in the builder), is the card's LEFT COLUMN, and the name,
 * team and line sit to its right. It never replaces the line.
 *
 * It is a `.ds-opt`, so selection, hover, press and focus are the option card's and cannot drift
 * from every other pick in the app. A real robot says so in a WORD beside its name (`.ds-badge`):
 * it was a 3px accent stripe down the card's left edge, which nothing on screen explained and
 * which read as half-selected (design review C51). "Real robot", not "Real team": the one card
 * that carries it today is BIOBUZZ's StarterBot, a kit shape, not any team's build.
 */
export function RobotCard({
  spec,
  game,
  on,
  team,
  real = false,
  imported = false,
  thumb,
  onPick,
  onDelete,
}: {
  spec: RobotSpec;
  game: GameId;
  /** this card's build is the one being driven */
  on: boolean;
  /** the identity line, or nothing. The CALLER decides: a preset prints a team only when it is a
   * real one, because a demo's `teamName` is a tagline. */
  team?: string;
  /** a documented real-world robot rather than an archetype demo — a "Real robot" badge */
  real?: boolean;
  /** a robot from the CAD importer (`spec.imported`): an "Imported" badge, the same spelling as
   *  `real`. The CALLER says so, because only the caller knows where the card came from. */
  imported?: boolean;
  /** the game's thumbnail, if it draws one; it may render nothing */
  thumb?: ReactNode;
  onPick(): void;
  /** present ⇒ a delete ✕ beside the card, in a `.ds-opt-slot` */
  onDelete?: () => void;
}) {
  const cls = `ds-opt ds-robot-card${on ? ' on' : ''}`;
  const body = (
    <>
      {thumb}
      {/* the NAME and the TEAM are one line each and scroll when they do not fit (`Marquee`, the
          results roster's). The badge is a SIBLING of the clip: the clip is what gets measured. */}
      <span className="ot">
        <Marquee text={spec.name || 'Unnamed'} />
        {real ? <span className="ds-badge">Real robot</span> : null}
        {imported ? <span className="ds-badge">Imported</span> : null}
      </span>
      {team ? (
        <span className="od">
          <Marquee text={team} />
        </span>
      ) : null}
      <span className="om">{buildWords(spec, game).join(' · ')}</span>
    </>
  );
  const card = (
    <button type="button" className={cls} aria-pressed={on} onClick={onPick}>
      {body}
    </button>
  );
  if (!onDelete) return card;
  // the card and its ✕ are SIBLINGS in a slot (design review C09): a button may not hold a
  // button, and a `div role=button` around one had no clean name and swallowed its keys
  return (
    <div className="ds-opt-slot">
      {card}
      <button
        type="button"
        className="ds-opt-del"
        title="Delete this robot"
        aria-label={`Delete ${spec.name || 'this robot'}`}
        onClick={onDelete}
      >
        ✕
      </button>
    </div>
  );
}
