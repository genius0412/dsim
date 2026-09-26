import { useEffect, useRef, useState } from 'react';
import { authClient, authEnabled } from '../lib/authClient';
import { BADGE_LABELS, BADGE_TIER } from '../badges';
import { starPoints } from '../render/drawRobot';
import { grantBadges, grantCards, rewardEyebrow, rewardHeadline, rewardWhy, type RewardGrant, type RewardItem } from '../rewards';
import { useDialog } from './useDialog';
import { BadgeArt } from './BadgeMark';
import { answerCard, currentCard, loadRewards, postponeRewards, reopenRewards, useRewards } from './rewardsStore';

/**
 * THE CLAIM DIALOG — every reward an account is given is shown here, once, before it is theirs
 * (owner, 2026-09-22: "Create a proper display of congratulating them for earning a title or
 * badge or decal or whatever, why, and a claim button and a equip now button"). Titles have
 * since folded into badges (0049), so a grant is badges and cosmetics.
 *
 * ONE ITEM PER CARD (owner, 2026-09-24): the GitHub star gives a badge AND a decal, and one
 * "Equip now" for two different things does not say which it wears. So a grant is shown as a
 * card per item (`grantCards`: badges, then cosmetics), each with its own Claim and Equip now.
 * The first card's answer claims the whole grant on the server; the rest walk through what it
 * delivered (`answerCard`, `rewardsStore`).
 *
 * WHAT A CARD SHOWS: the item, DRAWN (the badge with the count it is about to reach, the decal
 * on a robot-coloured disc); WHY, as concrete sentences (`rewardWhy` — "#2 in 1v1 ranked,
 * BIOBUZZ Act 2."); and two actions. CLAIM takes it into the account. EQUIP NOW also wears it —
 * a badge beside the name, a decal on the active robot. Several pending rewards queue: the next
 * appears when this one is taken, the prestigious first and the oldest first within a kind
 * (`compareGrants`).
 *
 * WHEN: on the menu shell only. `App.tsx` mounts it inside `AppShell`, which a match, a lobby
 * and the ranked screen all replace outright — so it cannot appear over a field, per the "no
 * popups over the field" rule. It waits for everything else that is modal (the terms and
 * username gates, which wrap it; the announcements, the start guards — `blocked`), and Esc puts
 * it off until the next return to the menus, so a player is never trapped in it. There is no
 * third "dismiss" button because there is nothing to dismiss: claiming costs nothing.
 *
 * ⚠️ THE RANKED PODIUM IS THE SPECIAL ONE, AND IT LOOKS IT (owner: "the most prestigious
 * reward … make it look special"). Its card takes the metal of the placement — the card's edge
 * in the metal, a large crest, the headline a size up (no glow: design review 06-15) — while a
 * record award is the plainer violet card, and anything else is the neutral one. The difference
 * is in the TIER class and nothing else, so the three cannot drift apart structurally.
 */
export function RewardDialog({
  blocked = false,
  onEquipCosmetic,
}: {
  /** another modal is up (an announcement, a start guard) — wait for it */
  blocked?: boolean;
  /** put a claimed cosmetic on the active robot ("Equip now" on a decal) */
  onEquipCosmetic?: (id: string) => void;
}) {
  const session = authEnabled ? authClient!.useSession() : null;
  const userId = session?.data?.user?.id ?? null;
  const r = useRewards();
  const [err, setErr] = useState(false);

  // every mount is a return to the menus: bring a postponed queue back and re-read it, so a
  // reward minted while the player was in a match is waiting for them when they come out
  useEffect(() => {
    reopenRewards();
    void loadRewards(userId);
  }, [userId]);

  const card = currentCard(r);
  const showing = !!card && !blocked && !r.postponed && r.status === 'ready';
  const cardKey = card ? `${card.grant.id}:${card.at}` : '';

  // a new card is a new question — a failure on the last one says nothing about this one
  useEffect(() => setErr(false), [cardKey]);

  if (!showing || !card) return null;

  const take = async (equip: boolean): Promise<void> => {
    setErr(false);
    const out = await answerCard(equip);
    if (!out.ok) {
      setErr(true);
      return;
    }
    if (out.cosmetic) onEquipCosmetic?.(out.cosmetic);
  };

  // the queue as cards: what is left of this grant, then every card of the grants behind it
  const later = (r.state?.pending ?? []).filter((g) => g.id !== card.grant.id).reduce((n, g) => n + Math.max(1, grantCards(g).length), 0);

  return (
    <RewardCard
      grant={card.grant}
      item={card.item}
      first={card.at === 0}
      counts={r.state?.badges ?? {}}
      claimed={card.claimed}
      position={{ at: card.at + 1, of: card.of + later }}
      busy={r.busy}
      error={err}
      onClaim={() => void take(false)}
      onEquip={() => void take(true)}
      onDismiss={postponeRewards}
    />
  );
}

/** the card itself, split out so it can be drawn from fixed data (the appearance page's
 *  preview of an unclaimed reward, and the screenshot harness). */
export function RewardCard({
  grant,
  item,
  first = true,
  counts,
  claimed = false,
  position,
  busy = false,
  error = false,
  onClaim,
  onEquip,
  onDismiss,
}: {
  grant: RewardGrant;
  /** the ONE thing this card is about; null only for a grant with nothing this build draws */
  item: RewardItem | null;
  /** the grant's first card, which carries its headline; later cards name their own item */
  first?: boolean;
  /** badge id → times earned so far */
  counts: Record<string, number>;
  /** the grant is already claimed, so `counts` already includes this badge */
  claimed?: boolean;
  position?: { at: number; of: number };
  busy?: boolean;
  error?: boolean;
  onClaim: () => void;
  onEquip: () => void;
  /** Escape: not now — the queue comes back on the next return to the menus */
  onDismiss?: () => void;
}) {
  // declared BEFORE the equip focus below, so it records the opener before focus moves
  const dialogRef = useDialog(onDismiss);
  const equipRef = useRef<HTMLButtonElement>(null);
  // focus the primary action when a card appears — a keyboard or pad user lands on it
  const key = `${grant.id}:${item?.kind ?? ''}:${item?.id ?? ''}`;
  useEffect(() => equipRef.current?.focus(), [key]);

  // the card's loudness comes from the GRANT, so every card of one reward looks alike: a
  // podium's metal, the record violet, or the neutral card for anything else (the GitHub
  // star's disc is a badge, but not a competitive one)
  const lead = grantBadges(grant)[0] ?? null;
  const leadTier = lead ? BADGE_TIER[lead] : null;
  const tier = leadTier === 'stargazer' || (!leadTier && grant.reason.kind === 'stargazer') ? 'plain' : leadTier ?? 'record';
  const headId = `rw-h-${grant.id}`;

  // the count THIS badge reaches — the one it is about to reach until the claim lands
  const count = item?.kind === 'badge' ? (counts[item.id] ?? 0) + (claimed ? 0 : 1) : 0;
  const hero =
    item?.kind === 'badge' ? (
      <BadgeArt id={item.id} n={Math.max(1, count)} size="xl" />
    ) : item?.kind === 'cosmetic' ? (
      <DecalPreview id={item.id} size="xl" />
    ) : null;
  const headline = first || !item ? rewardHeadline(grant) : item.kind === 'badge' ? BADGE_LABELS[item.id] : cosmeticName(item.id);
  const lines = [...rewardWhy(grant), ...(item?.kind === 'cosmetic' ? [cosmeticWords(item.id)] : [])];

  return (
    <div className="ds-modal-backdrop rw-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className={`ds-modal rw-card tier-${tier}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headId}
        tabIndex={-1}
      >
        <div className="rw-top">
          <span className="rw-eyebrow">{rewardEyebrow(grant)}</span>
          {position && position.of > 1 && (
            <span className="rw-queue" aria-label={`Reward ${position.at} of ${position.of}`}>
              {position.at} of {position.of}
            </span>
          )}
        </div>

        {/* THE HERO — the one thing this card is about, drawn large */}
        <div className="rw-hero" aria-hidden="true">
          {hero}
        </div>

        {/* no "Reward earned" kicker: the eyebrow and the headline already say it (06-15) */}
        <h2 className="ds-dialog-title rw-h" id={headId}>
          {headline}
        </h2>
        <ul className="rw-why">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>

        {error && <p className="ds-hint warn rw-err">Couldn’t claim that. Check your connection and try again.</p>}

        <div className="rw-actions">
          <button className="ds-btn" disabled={busy} onClick={onClaim}>
            Claim
          </button>
          <button ref={equipRef} className="ds-btn primary" disabled={busy} onClick={onEquip}>
            Equip now
          </button>
        </div>
      </div>
    </div>
  );
}

/** a delivered cosmetic's name, for the headline of its own card */
function cosmeticName(id: string): string {
  if (id === 'decal:star') return 'Star decal';
  const [axis, key] = id.split(':');
  return `${key} ${axis}`;
}

/** how a delivered cosmetic reads under its card's headline — where it is picked */
function cosmeticWords(id: string): string {
  if (id === 'decal:star') return 'A star decal for your robot. Pick it in the robot builder, or Equip now.';
  const [axis, key] = id.split(':');
  return `${key} ${axis === 'decal' ? 'decal' : axis}`;
}

/**
 * THE DECAL, FROM THE SPRITE'S OWN GEOMETRY (`starPoints`), on a dark disc — so the shape reads
 * as the thing that goes ON a robot rather than as another chip. The same construction the
 * builder swatch uses; a traced-by-eye path would be the one place the star being given is not
 * the star that is got.
 */
export function DecalPreview({ id, size = 'sm' }: { id: string; size?: 'sm' | 'xl' }) {
  if (id !== 'decal:star') return null;
  const d =
    starPoints(12, 12, 9, -Math.PI / 2)
      .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`)
      .join(' ') + ' Z';
  return (
    <span className={`rw-decal rw-decal-${size}`} role="img" aria-label="Star decal">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d={d} />
      </svg>
    </span>
  );
}
