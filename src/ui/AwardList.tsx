import { awardBadge, awardSentence, type AwardRow } from '../awards';
import { BadgeArt } from './BadgeMark';

/**
 * The award list on a profile — the "trophy case": every placement this account was paid for,
 * each drawn with the badge it earned (`awardBadge`) beside the sentence that names it.
 *
 * This is where WHICH act or season a badge came from lives. The badge beside a name says
 * "3× Ranked Champion"; this says which three.
 *
 * Ordered by `compareAwards` (newest season first, then rank), which is the order somebody
 * reads their own. An account with none renders NOTHING rather than an empty state: this
 * sits inside a Career panel that already has its own, and a second "no awards yet" under
 * it would be the panel telling you twice.
 */
export function AwardList({ awards }: { awards: readonly AwardRow[] }) {
  if (awards.length === 0) return null;
  return (
    <ul className="award-list">
      {awards.map((a) => (
        <li key={`${a.game}:${a.balanceVersion}:${a.act}:${a.kind}:${a.mode}:${a.drivetrain ?? ''}:${a.rank}`}>
          <BadgeArt id={awardBadge(a)} />
          <span className="award-text">{awardSentence(a)}</span>
        </li>
      ))}
    </ul>
  );
}
