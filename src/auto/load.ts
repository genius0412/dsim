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
 *
 * ⚠️ A ROBOT THAT CANNOT STRAFE DRIVES EVERY LEG NOSE-FIRST OR TAIL-FIRST (`tankHeadings`). Zenith
 * plans and follows for a mecanum chassis only (its robot file has no drivetrain kind). A tank
 * asked to hold a constant or sweeping heading along a leg cannot, and Pedro's follower then
 * spends its whole power budget on the heading it will never reach and drives nothing (its
 * allocator puts heading feedback before the drive vector while the heading is off). So for a
 * `holonomic(spec) === false` build each path leg is re-planned `tangent`, or `tangentReversed`
 * where the file's own heading along it points backwards, before the follower sees it.
 */
import {
  check,
  flattenSteps,
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
  FORMAT_VERSIONS,
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
import { datan2, dcos } from '../math';
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
  /** the running routine's plan: what the seat drives, in the robot's alliance */
  plan: Plan;
  estimate: Estimate;
  /**
   * Zenith's findings for the FILE, in its own alliance (a tank's legs re-headed there first), so
   * they name the elements Zenith names for the same file; step ids are the same in both frames.
   * A "robot.json does not register" finding for a name `unsupported` lists is left out.
   */
  findings: Finding[];
  /** named commands and conditions the file uses that this game does not run */
  unsupported: string[];
  /** the path legs re-headed for a robot that cannot strafe (`tankHeadings`), by step id */
  reheaded: string[];
  /** commands the file uses that this game runs and this build cannot, with the reason */
  notOnRobot: { name: string; why: string }[];
}

/** a leg shorter than this is a turn in place or a nudge: it keeps the heading it was written with */
const TANK_MIN_LEG_IN = 2;

/**
 * THE RUNNING ROUTINE FOR A ROBOT THAT CANNOT STRAFE: every path leg long enough to have a
 * direction is headed along it. `tangentReversed` where the heading the file plans at the leg's
 * start points more than 90° off the direction of travel, i.e. the author drew the robot backing
 * along it; `tangent` otherwise. Returns the ids it changed, for the panel.
 */
function tankHeadings(auto: Auto, planned: Plan): { auto: Auto; reheaded: string[] } {
  // keyed by the step object the plan carries (a step's `id` is optional in the file), and by
  // id as well, in case the resolver hands the plan a copy
  const byStep = new Map<Step, 'tangent' | 'tangentReversed'>();
  const byId = new Map<string, 'tangent' | 'tangentReversed'>();
  for (const ps of flattenSteps(planned.steps)) {
    if (ps.kind !== 'path' || ps.lengthIn < TANK_MIN_LEG_IN || ps.samples.length < 2) continue;
    const mode = ps.step.kind === 'path' ? (ps.step.heading?.mode ?? null) : null;
    if (mode === 'tangent' || mode === 'tangentReversed') continue;
    const a = ps.samples[0].pose;
    const b = ps.samples.find((x) => (x.pose.xIn - a.xIn) ** 2 + (x.pose.yIn - a.yIn) ** 2 > 0.25)?.pose;
    if (!b) continue;
    const travel = datan2(b.yIn - a.yIn, b.xIn - a.xIn);
    const heading = a.headingRad ?? travel;
    const m = dcos(heading - travel) < 0 ? 'tangentReversed' : 'tangent';
    byStep.set(ps.step, m);
    byId.set(ps.id, m);
  }
  const step = (s: Step): Step => {
    if (s.kind === 'path') {
      const m = byStep.get(s) ?? (s.id !== undefined ? byId.get(s.id) : undefined);
      return m ? { ...s, heading: { mode: m } } : s;
    }
    if (s.kind === 'sequence' || s.kind === 'parallel' || s.kind === 'branch') {
      return withChildLists(s, childLists(s).map((list) => list.map(step)));
    }
    return s;
  };
  return { auto: { ...auto, steps: auto.steps.map(step) }, reheaded: [...byId.keys()] };
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

/** `detail` with its own closing full stop (and trailing space) taken off. */
const unstopped = (detail: string): string => detail.trim().replace(/[.\s]+$/, '');

/**
 * `head` and a detail from Zenith or the parser as ONE sentence: the detail's own full stop is
 * folded into the one this adds, so a message that already ends in "." never reads "..".
 */
export function sentence(head: string, detail: string): string {
  const d = unstopped(detail);
  return /[?!]$/.test(d) ? `${head}${d}` : `${head}${d}.`;
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new AutoLoadError(`The ${what} is not valid JSON (${unstopped(describe(e))}).`);
  }
}

/**
 * A FILE FROM A NEWER ZENITH. Zenith's own migration refuses it as "this build of Zenith knows N",
 * which in DSIM names the wrong program. Read before the schema runs, against the newest format
 * the vendored schema reads (`FORMAT_VERSIONS`), never a typed number.
 */
function refuseNewer(json: unknown, kind: 'auto' | 'waypoints'): void {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return;
  const v = (json as { formatVersion?: unknown }).formatVersion;
  const max = FORMAT_VERSIONS[kind];
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= max) return;
  const what = kind === 'auto' ? 'This auto was' : 'This waypoints file was';
  throw new AutoLoadError(
    `${what} saved by a newer Zenith (file format ${v}), and this DSIM reads up to format ${max}. Reload DSIM; if it still says this, DSIM needs an update.`,
  );
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
  // a `transfer` (format 4) is planner-only: it names ledger locations, never a command or condition
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
    const json = parseJson(text, 'auto file');
    refuseNewer(json, 'auto');
    return loadAuto(json);
  } catch (e) {
    if (e instanceof AutoLoadError) throw e;
    throw new AutoLoadError(sentence('This is not a Zenith auto file: ', describe(e)));
  }
}

/** Zenith's SCHEMA finding for a name the robot file does not register (`checkRegistry`): the name, or null. */
function unregisteredName(f: Finding): string | null {
  if (f.code !== 'SCHEMA') return null;
  const m = /names the (?:command|condition) ("(?:[^"\\]|\\.)*"), which robot\.json does not register\.$/.exec(f.message);
  if (!m) return null;
  try {
    const name: unknown = JSON.parse(m[1]);
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
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
      const json = parseJson(setup.waypoints, 'waypoints file');
      refuseNewer(json, 'waypoints');
      waypoints = loadWaypoints(json);
    } catch (e) {
      if (e instanceof AutoLoadError) throw e;
      throw new AutoLoadError(sentence('The waypoints file is not valid: ', describe(e)));
    }
  }
  const written = inlineRefs(auto, waypoints, field);
  const mode = mirrorForField(field);
  const mirrored = written.alliance !== DSIM_ALLIANCE[alliance] && mode !== 'none';
  // THE FILE'S OWN FRAME FIRST: the routine as written (a tank's legs re-headed here), which is
  // what the findings describe, so DSIM names the elements Zenith names for this file. Re-heading
  // is a property of each leg's own shape, so doing it before the mirror drives what doing it
  // after did.
  let inFile = written;
  let fileResolved = resolve(inFile);
  let filePlan = planAuto(fileResolved, robot, field);
  let reheaded: string[] = [];
  if (adapter.holonomic?.(spec) === false) {
    const t = tankHeadings(written, filePlan);
    if (t.reheaded.length > 0) {
      inFile = t.auto;
      reheaded = t.reheaded;
      fileResolved = resolve(inFile);
      filePlan = planAuto(fileResolved, robot, field);
    }
  }
  const fileEst = estimatePlan(filePlan, robot);
  // THE ROBOT'S ALLIANCE: what the seat drives
  const running = mirrored ? mirrorAuto(inFile, mode) : inFile;
  const thePlan = mirrored ? planAuto(resolve(running), robot, field) : filePlan;
  const est = mirrored ? estimatePlan(thePlan, robot) : fileEst;
  const used = namesUsed(written);
  const unsupported = [
    ...used.commands.filter((n) => !adapter.commands.includes(n)),
    ...used.conditions.filter((n) => !adapter.conditions.includes(n)),
  ];
  // A NAME DSIM DOES NOT RUN IS LISTED, NOT A PROBLEM. Zenith reads it against DSIM's robot file,
  // which registers only what DSIM runs, and calls it an error; DSIM runs it as done at once and
  // `unsupported` already names it, so Zenith's sentence would say it a second time, wrongly.
  const findings = [...fileResolved.findings, ...check(filePlan, fileEst, robot, field, adapter.rules?.(field))].filter((f) => {
    const name = unregisteredName(f);
    return name === null || !unsupported.includes(name);
  });
  const cannot = adapter.notOnRobot?.(spec) ?? {};
  const notOnRobot = used.commands.filter((n) => Object.hasOwn(cannot, n)).map((name) => ({ name, why: cannot[name] }));
  return { written, running, mirrored, robot, field, plan: thePlan, estimate: est, findings, unsupported, reheaded, notOnRobot };
}
