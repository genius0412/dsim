import type { HudCard } from '../game';
import { ruleCode } from '../penaltyFeed';

/**
 * THE CARD SIGNAL — a referee's card, raised, in the top-right status cluster, for the rest of
 * the match. Every game mounts it (the cluster is shared chrome); Chain Reaction never issues a
 * card, so there it never draws.
 *
 * It replaced a 12×16 tile holding a "Y" or an "R" beside the word CARD, in the `.sub-hud`
 * among REVERSED and the flywheel's READY: it read "Y CARD", never said YELLOW, named neither
 * the rule nor the robot (only a 2.5 s toast did), wore the SUPPORTER gold and the ALLIANCE red,
 * showed the local robot's card only, and on a landscape phone (where the sub-hud's words are
 * dropped) it was a lone "Y" in a pill.
 *
 * NOW: a card-shaped glyph in the card's own colour (`--ds-card-yellow` / `--ds-card-red`, fixed
 * fills that do not theme), the colour in WORDS beside it, and one short line naming the rule's
 * code and the robot (`YOU` for the driver's own). A red adds SCORE VOID, because that is what a
 * red card does here and the score panel only shows the zero. Every carded robot on the viewed
 * alliance gets a row, the driver's first: a partner's red voids this score too.
 *
 * Not a live region: the card's event line is announced by the event log's polite region as it
 * lands, and a second announcement would say it twice. It fades in once per card (`ds-arrive`,
 * keyed on robot and colour, so a yellow turning red arrives again) and never moves after.
 */
export function CardSignal({ cards }: { cards: readonly HudCard[] }) {
  if (cards.length === 0) return null;
  return (
    <div className="card-signal">
      {cards.map((c) => {
        const who = c.mine ? 'YOU' : c.who;
        return (
          <div key={`${c.who}:${c.colour}`} className={`card-sig ${c.colour} ds-arrive`}>
            <span className="card-sig-card" aria-hidden="true" />
            <span className="card-sig-text">
              {/* the colour word stands alone on a landscape phone, whose gutter has height for
                  one line beside the game's card (`.card-sig-word` and the sub-lines go to a
                  screen reader only there, styles.css) */}
              <span className="card-sig-head">
                {c.colour === 'red' ? 'RED' : 'YELLOW'}
                <span className="card-sig-word"> CARD</span>
              </span>
              <span className="card-sig-sub">{c.rule ? `${ruleCode(c.rule)} · ${who}` : who}</span>
              {c.colour === 'red' && <span className="card-sig-sub void">SCORE VOID</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}
