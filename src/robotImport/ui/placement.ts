/**
 * THE EDITOR'S VIEW OF A GAME'S PLACEMENTS — lane 2's `ImportMechSlot` per game (`src/games/
 * importMechChecks.ts`: `mechHandles`, `defaultImportedMech`, `validateImportedMech`), adapted to the
 * editor's frames.
 *
 * The game speaks ROBOT-LOCAL (origin at the wheelbase centre). The editor keeps placements in the
 * MODEL frame, which does not move when a wheel is dragged (`docs/area/robot-import.md`), so the
 * defaults come back through the measured origin. Lazy: only the editor imports this.
 */
import type { GameId } from '../../games/types';
import type { ImportMechHandle, ImportMechHandleKey } from '../../games/types';
import { defaultImportedMech, mechHandles, validateImportedMech } from '../../games/importMechChecks';
import type { ImportedEdge, ImportedMech, RobotSpec, Vec2 } from '../../types';

export type PointField = 'shooter' | 'shooter2' | 'place';

/** one thing the placement editor lets the player drag */
export interface MechHandleDef {
  /** `intake:front`, `shooter`, `shooter2`, `place` */
  key: ImportMechHandleKey;
  kind: 'span' | 'point';
  label: string;
  field: 'intake' | PointField;
  /** spans: the bounding-box edge it rides */
  edge?: ImportedEdge;
  /** points: the release heights the sim accepts */
  zMin?: number;
  zMax?: number;
  /** a turretless launcher's point also has a FACING (`mech.shooterYawDeg`): the direction it
   *  fires now, degrees CCW from forward */
  facingDeg?: number;
}

/** a plain-language check on a placement */
export interface MechCheck {
  level: 'block' | 'warn';
  text: string;
  /** the handle it is about, for "Fix" */
  key?: ImportMechHandleKey;
}

const fieldOf = (h: ImportMechHandle): MechHandleDef['field'] =>
  h.kind === 'span' ? 'intake' : (h.key as PointField);

/** the handles this game and build place on an imported robot (`spec` must carry `imported`) */
export function mechHandlesFor(game: GameId, spec: RobotSpec): MechHandleDef[] {
  if (!spec.imported) return [];
  return mechHandles(game, spec).map((h) => ({
    key: h.key,
    kind: h.kind,
    label: h.label,
    field: fieldOf(h),
    edge: h.edge,
    zMin: h.zMin,
    zMax: h.zMax,
    facingDeg: h.facingDeg,
  }));
}

/** robot-local placements → the MODEL frame (the inverse of `mechModelToRobot`) */
export function mechRobotToModel(mech: ImportedMech, origin: Vec2): ImportedMech {
  const out: ImportedMech = {};
  const pt = (p: { x: number; y: number; z: number }) => ({ x: p.x + origin.x, y: p.y + origin.y, z: p.z });
  if (mech.shooter) out.shooter = pt(mech.shooter);
  // a direction, so a shift of origin leaves it as it is
  if (mech.shooterYawDeg !== undefined) out.shooterYawDeg = mech.shooterYawDeg;
  if (mech.shooter2) out.shooter2 = pt(mech.shooter2);
  if (mech.place) out.place = pt(mech.place);
  if (mech.intakes) {
    out.intakes = mech.intakes.map((m) => {
      const lateral = m.edge === 'front' || m.edge === 'back' ? origin.y : origin.x;
      return { edge: m.edge, from: m.from + lateral, to: m.to + lateral };
    });
  }
  return out;
}

/**
 * The game's pre-fills, MODEL frame, for whatever this build places and `have` lacks — and only
 * those: a placement the player made is never moved. Anything `have` holds that this build no
 * longer places (an intake edge its mount dropped, a Box Tube taken off) is dropped.
 */
export function defaultMechFor(game: GameId, spec: RobotSpec, origin: Vec2, have: ImportedMech | null): ImportedMech {
  if (!spec.imported) return have ?? {};
  const defs = mechHandlesFor(game, spec);
  const d = mechRobotToModel(defaultImportedMech(game, spec), origin);
  const out: ImportedMech = {};
  const intakes: NonNullable<ImportedMech['intakes']> = [];
  for (const def of defs) {
    if (def.field === 'intake' && def.edge) {
      const span = have?.intakes?.find((i) => i.edge === def.edge) ?? d.intakes?.find((i) => i.edge === def.edge);
      if (span) intakes.push(span);
    } else if (def.field !== 'intake') {
      const p = have?.[def.field] ?? d[def.field];
      if (p) out[def.field] = p;
      // the FACING rides with its point: the player's if they turned it, else the game's
      if (def.field === 'shooter' && def.facingDeg !== undefined && p) {
        const yaw = have?.shooterYawDeg ?? d.shooterYawDeg ?? def.facingDeg;
        out.shooterYawDeg = yaw;
      }
    }
  }
  if (intakes.length) out.intakes = intakes;
  return out;
}

/** the game's checks on a built spec's placements */
export function validateMechFor(spec: RobotSpec, game: GameId): MechCheck[] {
  if (!spec.imported) return [];
  return validateImportedMech(spec, game).map((i) => ({ level: i.level, text: i.text, key: i.handle }));
}
