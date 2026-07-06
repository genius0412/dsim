import type { Alliance, RobotCommand, RobotState, World } from '../types';
import * as C from '../config';
import {
  baseZone,
  driverSide,
  gateZone,
  loadZone,
  other,
  tunnelStrip,
  inRect,
} from './field';
import type { Rect } from './field';
import { robotCorners, robotIntersectsRect } from './physics';
import { awardFoul } from './scoring';
import { hyp } from '../math';

/**
 * DECODE penalty engine (Competition Manual Section 11). Pure and
 * deterministic: it reads only world.time, robot positions/velocities, the
 * per-tick command map, and world.rrContacts (robot-robot contacts recorded by
 * the collision solver). All state lives in world.penalties as plain JSON, so
 * the sim stays serializable and lockstep-safe for netcode.
 *
 * Fouls are awarded TO the victim alliance (awardFoul in scoring.ts). Most
 * rules trigger on a CROSS-alliance contact pair while a robot sits in a zone;
 * a per-episode debounce (PENALTY_CLEAR) makes a held contact fire once, not
 * every tick. Pinning (G422) owns a per-ordered-pair second-accumulator.
 *
 * Rules modeled here:
 *   GATE  opening the OPPONENT's gate  (MAJOR) — presence in their gate zone
 *   G425  secret tunnel                (MINOR)
 *   G426  own loading zone contact     (MINOR)
 *   G427  base zone, endgame           (MAJOR + counts the victim fully returned)
 *   G402  crossing fully to the opponent's side in AUTO (MAJOR)
 *   G422  pinning ≥3 s                 (MINOR, MAJOR on a repeat by the same pinner)
 *
 * Rules PHYSICALLY PREVENTED by construction (no code needed):
 *   G403/G417  transition freeze — robots are disabled outside auto/teleop.
 *   G416  out-of-zone launching — the shooter simply refuses (see robot.ts).
 * Deferrable (not yet modeled): G408 possession>3 / plowing, and displacing an
 * opponent's pre-staged spike artifacts (the second half of G402).
 */

/** a robot "occupies" a zone if any wheel-corner or its center is inside it */
function robotInRect(r: RobotState, rect: Rect): boolean {
  if (inRect(r.pos, rect)) return true;
  return robotCorners(r).some((c) => inRect(c, rect));
}

const ALLIANCES: Alliance[] = ['red', 'blue'];

export function updatePenalties(
  world: World,
  dt: number,
  commands: Map<number, RobotCommand>,
): void {
  const phase = world.match.phase;
  // fouls are only assessed while robots are competing under match rules
  if (phase !== 'auto' && phase !== 'teleop') return;

  const pen = world.penalties;
  const byId = new Map(world.robots.map((r) => [r.id, r] as const));

  /** EPISODE-debounced foul: fires once when `key`'s condition first holds, then
   * stays quiet for as long as it keeps holding (`episodes[key]` is refreshed to
   * `world.time` every active tick). It re-arms only after the condition has been
   * CLEAR for PENALTY_CLEAR — so continuous contact is ONE foul, a 1-tick SAT
   * flicker never re-fouls, and a real re-entry after the gap does. Idempotent
   * within a tick (duplicate contact pair / two rules on one key award once). */
  const fire = (
    key: string,
    offender: Alliance,
    severity: 'minor' | 'major',
    rule: string,
  ): void => {
    const last = pen.episodes[key];
    if (last === undefined || world.time - last > C.PENALTY_CLEAR) {
      awardFoul(world, offender, severity, rule);
    }
    pen.episodes[key] = world.time;
  };

  const endgame = phase === 'teleop' && world.match.phaseTimeLeft <= C.ENDGAME_START;

  // ---- GATE: a robot working/opening the OPPONENT's gate ------------------
  // The gate is physically openable by anyone (updateGates), but only your own
  // gate is legal — working the opponent's gate zone releases their scored
  // artifacts, a MAJOR foul. Detected with the same SAT test updateGates uses
  // (the gate zone overlaps the classifier, so a corner test would miss it).
  // No robot-robot contact required.
  for (const r of world.robots) {
    if (robotIntersectsRect(r, gateZone(other(r.alliance)))) {
      fire(`GATE:${r.id}`, r.alliance, 'major', 'opponent gate');
    }
  }

  // ---- AUTO interference: fully across the field mid-line in AUTO ----------
  // A robot entirely on the opponent's half during AUTO that contacts an
  // opponent (below) is handled with the contact pairs; the crossing itself is
  // flagged per robot so it fires even if the contact ids differ.
  if (phase === 'auto') {
    for (const r of world.robots) {
      const d = driverSide(r.alliance); // blue +1 (own side +x), red -1
      if (robotCorners(r).every((c) => d * c.x < 0) && touchingOpponent(world, r)) {
        fire(`G402:${r.id}`, r.alliance, 'major', 'G402 auto interference');
      }
    }
  }

  // ---- contact-pair rules (tunnel / loading / base) -----------------------
  for (const { a, b } of world.rrContacts) {
    const ra = byId.get(a);
    const rb = byId.get(b);
    if (!ra || !rb) continue;
    if (ra.alliance === rb.alliance) continue; // same-alliance contact never fouls
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const pairKey = `${lo}-${hi}`;

    // G425 secret tunnel: tunnelStrip(g) sits under goal g but is owned by the
    // OPPOSING drive team (other(g)); the intruder is therefore alliance g.
    for (const g of ALLIANCES) {
      if (robotInRect(ra, tunnelStrip(g)) || robotInRect(rb, tunnelStrip(g))) {
        fire(`G425:${pairKey}`, g, 'minor', 'G425 secret tunnel');
      }
    }

    // G426 loading zone: contact while the VICTIM is in its OWN loading zone
    for (const victim of [ra, rb]) {
      if (robotInRect(victim, loadZone(victim.alliance))) {
        fire(`G426:${pairKey}`, other(victim.alliance), 'minor', 'G426 loading zone');
      }
    }

    // G427 base zone (endgame only): contact while a robot is in a base; the
    // base's owner is the victim and is credited a full return
    if (endgame) {
      for (const X of ALLIANCES) {
        if (robotInRect(ra, baseZone(X)) || robotInRect(rb, baseZone(X))) {
          const victimRobot = ra.alliance === X ? ra : rb;
          victimRobot.baseAwarded = true;
          fire(`G427:${pairKey}`, other(X), 'major', 'G427 base zone');
        }
      }
    }
  }

  // ---- G422 pinning (ordered pairs, own second-accumulator) ---------------
  updatePins(world, dt, commands);
}

/** does robot r share a recorded contact with any opposing robot this tick? */
function touchingOpponent(world: World, r: RobotState): boolean {
  for (const { a, b } of world.rrContacts) {
    if (a !== r.id && b !== r.id) continue;
    const otherId = a === r.id ? b : a;
    const o = world.robots.find((x) => x.id === otherId);
    if (o && o.alliance !== r.alliance) return true;
  }
  return false;
}

function updatePins(world: World, dt: number, commands: Map<number, RobotCommand>): void {
  const pen = world.penalties;
  // contacts this tick, as an undirected id-pair set
  const contacts = new Set(world.rrContacts.map(({ a, b }) => `${a}-${b}`));
  const inContact = (i: number, j: number): boolean =>
    contacts.has(`${Math.min(i, j)}-${Math.max(i, j)}`);

  for (const pinner of world.robots) {
    for (const pinned of world.robots) {
      if (pinner.id === pinned.id || pinner.alliance === pinned.alliance) continue;
      const key = `${pinner.id}-${pinned.id}`;
      const cmd = commands.get(pinned.id);
      const commandingMove =
        !!cmd && (hyp(cmd.driveX, cmd.driveY) > 0.1 || Math.abs(cmd.rotate) > 0.1);

      if (!inContact(pinner.id, pinned.id) || !commandingMove) {
        delete pen.pins[key]; // condition broken — reset the accumulator
        continue;
      }

      let st = pen.pins[key];
      if (!st) {
        st = { seconds: 0, ox: pinned.pos.x, oy: pinned.pos.y, px: pinned.pos.x, py: pinned.pos.y };
        pen.pins[key] = st;
      }
      if (st.fired) continue; // already fouled this pin — hold until it breaks

      // actual (post-solver) speed from the position delta — robust whether or
      // not a blocked robot's velocity has been zeroed
      const speed = hyp(pinned.pos.x - st.px, pinned.pos.y - st.py) / dt;
      const disp = hyp(pinned.pos.x - st.ox, pinned.pos.y - st.oy);
      st.px = pinned.pos.x;
      st.py = pinned.pos.y;

      if (disp > C.PIN_ESCAPE_DIST) {
        delete pen.pins[key]; // got away — no pin
      } else if (speed < C.PIN_STUCK_SPEED) {
        st.seconds += dt;
        if (st.seconds >= C.PIN_SECONDS) {
          const prior = pen.pinFouls[pinner.id] ?? 0;
          awardFoul(world, pinner.alliance, prior > 0 ? 'major' : 'minor', 'G422 pinning');
          pen.pinFouls[pinner.id] = prior + 1;
          // don't re-fire on the SAME pin — require a separation first (that's a
          // genuine "repeat pin", which then escalates to MAJOR)
          st.fired = true;
        }
      } else {
        st.seconds = 0; // moving freely though not yet escaped — pause the clock
      }
    }
  }
}
