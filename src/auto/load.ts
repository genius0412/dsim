/**
 * LOAD A ZENITH AUTO for one robot: parse and validate the text with Zenith's own schema, put it
 * into the alliance the robot plays, and plan it against the robot file DSIM derives from the
 * build. LAZY CHUNK (see `types.ts`). Pure: no DOM, no clock, no randomness.
 *
 * ── THE ALLIANCE RULE (the same one the robot runtime and Zenith's `mirrorAuto` use) ──────────
 * A file's `alliance` names the alliance its poses are written for. It is mirrored into the
 * other alliance if and only if the robot plays the other one, by the field's declared symmetry
 * (BIOBUZZ: a point symmetry, `(x, y, h) -> (-x, -y, h + pi)`, which is also DSIM's own
 * `bbMirror`). Headings are mirrored with the poses, `facePoint` points too. A file mirrored in
 * Zenith and saved as BLUE is therefore never mirrored twice.
 *
 * ⚠️ WAYPOINT REFS ARE INLINED FIRST. `mirrorAuto` leaves a `{ "ref": … }` as the reference it
 * is (a mirrored routine wants the other alliance's waypoint of that name), and `waypoints.json`
 * holds canonical poses only, so resolving after the mirror would drive BLUE to RED's waypoint.
 */
import {
  check,
  estimate as estimatePlan,
  loadAuto,
  loadField,
  loadRobot,
  loadWaypoints,
  mirrorAuto,
  mirrorForField,
  mirrorPose,
  plan as planAuto,
  resolve,
  type Estimate,
  type Finding,
  type Plan,
} from '@horizon36596/zenith-core';
import {
  childLists,
  withChildLists,
  type Auto,
  type Field,
  type Pose,
  type PoseSource,
  type Robot,
  type Segment,
  type Step,
  type Waypoints,
} from '@horizon36596/zenith-schema';
import type { Alliance, RobotSpec, StartPose } from '../types';
import type { GameAutoAdapter, ZenithAutoSetup } from './types';

/** An auto that could not be loaded, with a sentence a player can act on. */
export class AutoLoadError extends Error {}

export interface LoadedAuto {
  /** the file as written, waypoint refs inlined */
  written: Auto;
  /** the same routine in the alliance the robot plays */
  running: Auto;
  mirrored: boolean;
  robot: Robot;
  field: Field;
  plan: Plan;
  estimate: Estimate;
  findings: Finding[];
  /** named commands and conditions the file uses that this game does not run */
  unsupported: string[];
}

const DSIM_ALLIANCE: Record<Alliance, Auto['alliance']> = { red: 'RED', blue: 'BLUE' };

/** The first thing the schema refused, as one line, or the error's own message. */
function describe(e: unknown): string {
  if (e && typeof e === 'object' && 'issues' in e && Array.isArray((e as { issues: unknown }).issues)) {
    const issue = (e as { issues: { path: (string | number)[]; message: string }[] }).issues[0];
    if (issue) return `${issue.path.length ? issue.path.join('.') + ': ' : ''}${issue.message}`;
  }
  return e instanceof Error ? e.message : String(e);
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new AutoLoadError(`The ${what} is not valid JSON (${describe(e)}).`);
  }
}

/** Every `{ref}` replaced by its waypoint, in the file's own alliance frame. */
function inlineRefs(auto: Auto, waypoints: Waypoints | null, field: Field): Auto {
  const mode = mirrorForField(field);
  const flip = auto.alliance !== field.frame.canonicalAlliance && mode !== 'none';
  const lookup = (ref: string): Pose => {
    const w = waypoints?.waypoints[ref];
    if (!w) throw new AutoLoadError(`The auto names the waypoint "${ref}", and no waypoints file defines it.`);
    const pose: Pose = { xIn: w.xIn, yIn: w.yIn, headingRad: w.headingRad };
    return flip ? mirrorPose(pose, mode) : pose;
  };
  const source = (s: PoseSource): PoseSource => (s !== 'current' && 'ref' in s ? lookup(s.ref) : s);
  const segment = (s: Segment): Segment => ({ ...s, from: source(s.from), to: source(s.to) }) as Segment;
  const step = (s: Step): Step => {
    if (s.kind === 'path') return { ...s, segments: s.segments.map(segment) };
    if (s.kind === 'sequence' || s.kind === 'parallel' || s.kind === 'branch') {
      return withChildLists(s, childLists(s).map((list) => list.map(step)));
    }
    return s;
  };
  const start = auto.start.pose;
  return {
    ...auto,
    start: { ...auto.start, pose: 'ref' in start ? lookup(start.ref) : start },
    steps: auto.steps.map(step),
  };
}

/** Every command and condition name the routine uses, in file order, once each. */
export function namesUsed(auto: Auto): { commands: string[]; conditions: string[] } {
  const commands: string[] = [];
  const conditions: string[] = [];
  const add = (list: string[], name: string): void => {
    if (!list.includes(name)) list.push(name);
  };
  const walk = (s: Step): void => {
    if (s.kind === 'command') add(commands, s.name);
    if (s.kind === 'path') {
      for (const m of s.markers ?? []) add(commands, m.command.name);
      if (s.endCondition) add(conditions, s.endCondition.condition);
    }
    if (s.kind === 'wait' && s.until !== undefined) add(conditions, s.until);
    if (s.kind === 'branch') add(conditions, s.condition);
    if (s.kind === 'sequence' || s.kind === 'parallel' || s.kind === 'branch') childLists(s).forEach((l) => l.forEach(walk));
  };
  auto.steps.forEach(walk);
  return { commands, conditions };
}

/**
 * The canonical `StartPose` that seats `alliance`'s robot where the auto starts: the running
 * routine's start pose, handed back through the game's own inverse mirror.
 */
export function autoStartPose(loaded: LoadedAuto, alliance: Alliance, adapter: GameAutoAdapter): StartPose {
  const p = loaded.plan.startPose;
  return adapter.canonicalStart({ x: p.xIn, y: p.yIn, heading: p.headingRad ?? 0 }, alliance);
}

/** Parse an auto file's text on its own, for the library: its name, alliance and any error. */
export function parseAutoText(text: string): Auto {
  try {
    return loadAuto(parseJson(text, 'auto file'));
  } catch (e) {
    if (e instanceof AutoLoadError) throw e;
    throw new AutoLoadError(`This is not a Zenith auto file: ${describe(e)}.`);
  }
}

/**
 * Load `setup` for a robot built as `spec` playing `alliance`. Throws `AutoLoadError` with a
 * sentence for anything that stops the auto running; findings (a path through a wall, an
 * over-long routine) do not stop it, they are reported.
 */
export function loadZenithAuto(
  setup: ZenithAutoSetup,
  alliance: Alliance,
  spec: RobotSpec,
  adapter: GameAutoAdapter,
): LoadedAuto {
  const field = loadField(adapter.field());
  const robot = loadRobot(adapter.robot(spec));
  const auto = parseAutoText(setup.auto);
  let waypoints: Waypoints | null = null;
  if (setup.waypoints !== undefined) {
    try {
      waypoints = loadWaypoints(parseJson(setup.waypoints, 'waypoints file'));
    } catch (e) {
      if (e instanceof AutoLoadError) throw e;
      throw new AutoLoadError(`The waypoints file is not valid: ${describe(e)}.`);
    }
  }
  const written = inlineRefs(auto, waypoints, field);
  const mirrored = written.alliance !== DSIM_ALLIANCE[alliance] && mirrorForField(field) !== 'none';
  const running = mirrored ? mirrorAuto(written, mirrorForField(field)) : written;
  const resolved = resolve(running);
  const thePlan = planAuto(resolved, robot, field);
  const est = estimatePlan(thePlan, robot);
  const findings = [...resolved.findings, ...check(thePlan, est, robot, field, adapter.rules?.(field))];
  const used = namesUsed(written);
  const unsupported = [
    ...used.commands.filter((n) => !adapter.commands.includes(n)),
    ...used.conditions.filter((n) => !adapter.conditions.includes(n)),
  ];
  return { written, running, mirrored, robot, field, plan: thePlan, estimate: est, findings, unsupported };
}
