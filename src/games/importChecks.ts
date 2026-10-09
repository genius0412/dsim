import type { ImportedEdge, ImportedMech, ImportedRobot, RobotSpec, Vec2 } from '../types';
import { coerceImported } from '../sim/imported';
import { vToSpan, type ImportMouth } from '../sim/importedMech';
import type { ImportMechHandle, ImportMechIssue } from './types';

/**
 * The game-neutral half of the imported-robot placement checks (`GameSimModule.importMech`): the
 * mouth checks every game runs, the release-height check, and the pre-fill helpers. Copy follows
 * `docs/area/ui.md` (sentence case, typographic punctuation, a full stop rather than a dash).
 */

/** a length for a message: one decimal, a thin "in" */
export function inches(v: number): string {
  return `${(Math.round(v * 10) / 10).toFixed(1)} in`;
}

const EDGE_WORD: Record<ImportedEdge, string> = { front: 'front', back: 'back', left: 'left', right: 'right' };

export function edgeLabel(edge: ImportedEdge): string {
  const w = EDGE_WORD[edge];
  return `${w[0].toUpperCase()}${w.slice(1)} intake`;
}

/** an intake handle per mounted edge */
export function spanHandles(edges: readonly ImportedEdge[]): ImportMechHandle[] {
  return edges.map((edge) => ({ key: `intake:${edge}` as const, kind: 'span' as const, label: edgeLabel(edge), edge }));
}

/**
 * The mouth checks: a mounted edge with no room for the game's narrowest mouth (BLOCK), a placed
 * span the sim had to move or resize (warn), and a span on an edge this build's intake is not on
 * (warn, with `ignoredHint` — DECODE's says to turn the front instead).
 */
export function mouthIssues(
  imp: ImportedRobot,
  mouths: readonly ImportMouth[],
  minHalf: number,
  ignoredHint: string,
): ImportMechIssue[] {
  const out: ImportMechIssue[] = [];
  for (const m of mouths) {
    const handle = `intake:${m.edge}` as const;
    if (m.cramped) {
      out.push({
        level: 'block',
        code: 'mouth-no-room',
        text: `The ${EDGE_WORD[m.edge]} edge has room for a ${inches(2 * m.half)} intake. It needs ${inches(2 * minHalf)}: move the intake to a wider edge or widen the robot there.`,
        handle,
      });
    } else if (m.clamped) {
      out.push({
        level: 'warn',
        code: 'mouth-clamped',
        text: `The ${EDGE_WORD[m.edge]} intake was fitted to the robot: it is ${inches(2 * m.half)} wide where it meets the frame.`,
        handle,
      });
    }
  }
  for (const it of imp.mech?.intakes ?? []) {
    if (mouths.some((m) => m.edge === it.edge)) continue;
    out.push({
      level: 'warn',
      code: 'mouth-ignored',
      text: `The ${EDGE_WORD[it.edge]} intake span isn’t used. ${ignoredHint}`,
      handle: `intake:${it.edge}`,
    });
  }
  return out;
}

/** a placed release height outside the range the sim accepts (it is clamped there; warn) */
export function heightIssue(
  key: 'shooter' | 'shooter2',
  what: string,
  z: number | undefined,
  min: number,
  max: number,
): ImportMechIssue[] {
  if (z === undefined) return [];
  if (z < min - 1e-9) {
    return [{ level: 'warn', code: 'height-clamped', text: `${what} release height raised to ${inches(min)}. Lower releases aren’t modelled in this game.`, handle: key }];
  }
  if (z > max + 1e-9) {
    return [{ level: 'warn', code: 'height-clamped', text: `${what} release height lowered to ${inches(max)}.`, handle: key }];
  }
  return [];
}

/** a launcher that has not been placed plays from its default spot (warn) */
export function unplacedIssue(key: 'shooter' | 'shooter2' | 'place', what: string): ImportMechIssue {
  return { level: 'warn', code: `${key}-default`, text: `${what} isn’t placed yet, so it sits at its default spot. Drag it onto the model.`, handle: key };
}

/** the default span of each mouth, as stored */
export function defaultSpans(mouths: readonly ImportMouth[]): NonNullable<ImportedMech['intakes']> {
  return mouths.map((m) => ({ edge: m.edge, ...vToSpan(m.edge, m.vc - m.half, m.vc + m.half) }));
}

/** the spec with no placements at all — what every default is resolved against */
export function withoutMech(spec: RobotSpec): RobotSpec {
  const imp = { ...spec.imported! };
  delete imp.mech;
  return { ...spec, imported: imp };
}

/** a point `back` inches inside the hull from where it was, along `-dir` (a placer's default base) */
export function inward(p: Vec2, dir: Vec2, back: number): Vec2 {
  return { x: p.x - dir.x * back, y: p.y - dir.y * back };
}

/** finish a pre-fill through the real coercion, so what the editor shows is what will be saved */
export function coercedMech(imp: ImportedRobot, mech: ImportedMech): ImportedMech {
  return coerceImported({ ...imp, mech })?.mech ?? {};
}
