import type {
  RobotState,
  World,
  PathPoint,
  PathLine,
  Vec2,
  RobotCommand,
  SequenceItem, // Import SequenceItem
} from '../types';
import {
  dist,
  datan2,
  wrapAngle,
  linearPoint,
  quadraticBezierPoint,
  cubicBezierPoint,
  v,
  sub,
  len,
  clamp,
} from '../math';

const ZERO_CMD: RobotCommand = {
  driveX: 0,
  driveY: 0,
  rotate: 0,
  intake: false,
  fire: false,
};

/**
 * Evaluates a point and its tangent heading along a path segment at parameter t.
 * @param startPoint The starting point of the segment.
 * @param pathLine The PathLine defining the segment.
 * @param t The parameter (0.0 to 1.0) along the segment.
 * @returns An object containing the position (Vec2) and tangent heading (radians).
 */
function evaluatePathSegment(
    startPoint: PathPoint,
    pathLine: PathLine,
    t: number,
): { position: Vec2; tangentHeading: number } {
  let position: Vec2;
  let tangent: Vec2;

  if (pathLine.controlPoints && pathLine.controlPoints.length > 0) {
    if (pathLine.controlPoints.length === 1) {
      // Quadratic Bezier
      position = quadraticBezierPoint(startPoint, pathLine.controlPoints[0], pathLine.endPoint, t);
      // Tangent for quadratic Bezier: B'(t) = 2(1-t)(P1-P0) + 2t(P2-P1)
      const p0 = startPoint;
      const p1 = pathLine.controlPoints[0];
      const p2 = pathLine.endPoint;
      tangent = v(
          2 * (1 - t) * (p1.x - p0.x) + 2 * t * (p2.x - p1.x),
          2 * (1 - t) * (p1.y - p0.y) + 2 * t * (p2.y - p1.y),
      );
    } else if (pathLine.controlPoints.length === 2) {
      // Cubic Bezier
      position = cubicBezierPoint(
          startPoint,
          pathLine.controlPoints[0],
          pathLine.controlPoints[1],
          pathLine.endPoint,
          t,
      );
      // Tangent for cubic Bezier: B'(t) = 3(1-t)^2(P1-P0) + 6(1-t)t(P2-P1) + 3t^2(P3-P2)
      const p0 = startPoint;
      const p1 = pathLine.controlPoints[0];
      const p2 = pathLine.controlPoints[1];
      const p3 = pathLine.endPoint;
      const mt = 1 - t;
      tangent = v(
          3 * mt * mt * (p1.x - p0.x) + 6 * mt * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x),
          3 * mt * mt * (p1.y - p0.y) + 6 * mt * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y),
      );
    } else {
      // Fallback to linear if more than 2 control points (unsupported)
      position = linearPoint(startPoint, pathLine.endPoint, t);
      tangent = sub(pathLine.endPoint, startPoint);
    }
  } else {
    // Linear segment
    position = linearPoint(startPoint, pathLine.endPoint, t);
    tangent = sub(pathLine.endPoint, startPoint);
  }

  // Handle zero-length tangents (e.g., at start/end of Bezier if control points are coincident)
  if (len(tangent) < 1e-6) {
    return { position, tangentHeading: 0 };
  }

  const tangentHeading = datan2(tangent.y, tangent.x);
  return { position, tangentHeading };
}

/**
 * Calculates the desired heading from a PathPoint, interpolating for linear type.
 * @param pathPoint The PathPoint containing heading information.
 * @param currentRobotHeading The robot's current heading (fallback if heading type is 'tangential' or 'linear' without start/end deg).
 * @param t The parameter (0.0 to 1.0) along the segment for interpolation.
 * @param tangentialHeading The tangential heading at 't' if available (for 'tangential' type).
 */
function getHeadingFromPathPoint(
    pathPoint: PathPoint,
    currentRobotHeading: number,
    t: number,
    tangentialHeading?: number,
): number {
  switch (pathPoint.heading) {
    case 'constant':
      return (pathPoint.degrees ?? 0) * Math.PI / 180;
    case 'linear':
      if (pathPoint.startDeg !== undefined && pathPoint.endDeg !== undefined) {
        const startRad = pathPoint.startDeg * Math.PI / 180;
        const endRad = pathPoint.endDeg * Math.PI / 180;
        // Direct linear interpolation of angles
        return wrapAngle(startRad + wrapAngle(endRad - startRad) * t);
      }
      return currentRobotHeading; // Fallback
    case 'tangential':
      let heading = tangentialHeading !== undefined ? tangentialHeading : currentRobotHeading;
      if (pathPoint.reverse) {
        heading = wrapAngle(heading + Math.PI);
      }
      return heading;
    default:
      return currentRobotHeading; // Default fallback
  }
}

/**
 * Initializes the robot's auto pathing state.
 * This should be called once when the match starts if autoPathActive is true.
 */
export function initializePathTraversal(robot: RobotState) {
  const autoPath = robot.autoPath;
  if (!autoPath) {
    // console.warn(`[PathTraversal] Robot ${robot.id}: No autoPath data found for initialization.`);
    robot.autoPathActive = false;
    return;
  }

  // // console.log(`[PathTraversal] Initializing auto path for robot ${robot.id} with path: ${autoPath.fileName}`);
  robot.autoPathActive = true;
  robot.currentPathSegmentIndex = 0;
  robot.pathSegmentProgress = 0; // This will be 't' along the current path segment
  robot.pathWaitTimer = 0;
  robot.pathSequenceIndex = 0;
  robot.pathTargetPoint = null;
  robot.pathTargetHeading = null;

  // Set initial position and heading from the autoPath's startPoint
  robot.pos = { x: autoPath.startPoint.x, y: autoPath.startPoint.y };
  // Use the refined getHeadingFromPathPoint for initial heading, assuming the first line exists
  const firstPathLine = autoPath.lines.find((line) => line.id === autoPath.sequence?.[0]?.lineId);
  if (firstPathLine) {
    robot.heading = getHeadingFromPathPoint(autoPath.startPoint, robot.heading, 0, evaluatePathSegment(autoPath.startPoint, firstPathLine, 0).tangentHeading);
  } else {
    robot.heading = (autoPath.startPoint.degrees ?? 0) * Math.PI / 180; // Fallback if no lines
  }
  // Do NOT set robot.turretHeading here. It will be set by updateRobotActions using aimSolution.
  // robot.turretHeading = robot.heading;
}

/**
 * Updates the robot's position and heading directly based on its progress along the path.
 * This function should be called every tick during the auto phase.
 */
export function updatePathTraversal(
    robot: RobotState,
    _world: World,
    dt: number,
): RobotCommand {
  if (!robot.autoPathActive) {
    return ZERO_CMD;
  }

  const autoPath = robot.autoPath;
  if (!autoPath) {
    console.error(`[PathTraversal] Robot ${robot.id}: autoPath data is missing during update.`);
    robot.autoPathActive = false;
    return ZERO_CMD;
  }

  // --- Handle active waits (from waitBeforeMs, waitAfterMs, or sequence 'wait' item) ---
  if (robot.pathWaitTimer > 0) {
    robot.pathWaitTimer -= dt * 1000; // dt is in seconds, waitBeforeMs/waitAfterMs/durationMs are in milliseconds
    if (robot.pathWaitTimer <= 0) {
      robot.pathWaitTimer = 0;
      // Wait finished. The sequence index was already advanced when the timer was set
      // for a 'wait' sequence item. For waitBeforeMs/waitAfterMs, the index is advanced later.
    }
    // During a wait, movement is zero, but intake/fire should be active
    return {
      driveX: 0,
      driveY: 0,
      rotate: 0,
      intake: true, // Force intake active during auto
      fire: true,   // Force fire active during auto
    };
  }

  // --- Check if path is finished ---
  if (!autoPath.sequence || robot.pathSequenceIndex >= autoPath.sequence.length) {
    robot.autoPathActive = false; // Path finished
    // console.log(`[PathTraversal] Robot ${robot.id}: Path finished.`);
    return ZERO_CMD;
  }

  let currentSequenceItem: SequenceItem = autoPath.sequence[robot.pathSequenceIndex];

  // --- Handle sequence 'wait' item ---
  if (currentSequenceItem.kind === 'wait') {
    if (currentSequenceItem.durationMs !== undefined && currentSequenceItem.durationMs > 0) {
      robot.pathWaitTimer = currentSequenceItem.durationMs;
      // console.log(`[PathTraversal] Robot ${robot.id}: Waiting for ${currentSequenceItem.durationMs}ms (sequence wait).`);
      robot.pathSequenceIndex++; // Advance immediately to process next item on next tick after wait
      return {
        driveX: 0,
        driveY: 0,
        rotate: 0,
        intake: true,
        fire: true,
      };
    } else {
      // Invalid wait item, just skip it and try to process the next item immediately
      console.warn(`[PathTraversal] Robot ${robot.id}: Invalid 'wait' item with no durationMs or durationMs <= 0. Skipping.`);
      robot.pathSequenceIndex++;
      // To avoid infinite loop if many invalid wait items, let's return ZERO_CMD for this tick
      // and the next tick will re-evaluate the new currentSequenceItem.
      return ZERO_CMD;
    }
  }

  // If we reach here, it must be a 'path' kind or an 'action' kind (which we don't handle yet for movement)
  // For now, assume it's 'path'
  if (currentSequenceItem.kind !== 'path') {
      console.warn(`[PathTraversal] Robot ${robot.id}: Unknown sequence item kind '${currentSequenceItem.kind}'. Skipping.`);
      robot.pathSequenceIndex++;
      return ZERO_CMD;
  }

  const currentPathLine = autoPath.lines.find((line) => line.id === currentSequenceItem.lineId);

  if (!currentPathLine) {
    robot.autoPathActive = false; // Invalid path data
    console.error(`[PathTraversal] Robot ${robot.id}: Invalid path data, line not found for sequence item ${robot.pathSequenceIndex}.`);
    return ZERO_CMD;
  }

  // --- Apply waitBeforeMs if not already applied ---
  if (robot.pathSegmentProgress === 0 && currentPathLine.waitBeforeMs && currentPathLine.waitBeforeMs > 0) {
    robot.pathWaitTimer = currentPathLine.waitBeforeMs;
    // console.log(`[PathTraversal] Robot ${robot.id}: Waiting for ${currentPathLine.waitBeforeMs}ms (before segment).`);
    return {
      driveX: 0,
      driveY: 0,
      rotate: 0,
      intake: true, // Force intake active during auto
      fire: true,   // Force fire active during auto
    };
  }

  // --- Determine the start point for the current path segment ---
  let segmentStartPoint: PathPoint = autoPath.startPoint; // Default to the overall path start point

  // If we are not at the very beginning of the sequence, find the end point of the *last path segment*
  // that was executed. This correctly handles 'wait' items in between path segments.
  if (robot.pathSequenceIndex > 0) {
    for (let i = robot.pathSequenceIndex - 1; i >= 0; i--) {
      const prevSequenceItem = autoPath.sequence[i];
      if (prevSequenceItem.kind === 'path' && prevSequenceItem.lineId) {
        const prevPathLine = autoPath.lines.find(line => line.id === prevSequenceItem.lineId);
        if (prevPathLine) {
          segmentStartPoint = prevPathLine.endPoint;
          break; // Found the last path segment's end point, so we can stop
        }
      }
    }
  }

  // --- Advance robot's progress along the segment (t) ---
  // We need a way to define speed. Let's assume a constant speed for now.
  // This is a simplification, as real paths might have varying speeds.
  const PATH_TRAVERSAL_SPEED = 100; // inches per second (example value)
  const segmentLength = getSegmentLength(segmentStartPoint, currentPathLine);
  let delta_t = 0;
  if (segmentLength > 1e-6) { // Avoid division by zero
    delta_t = (PATH_TRAVERSAL_SPEED * dt) / segmentLength;
  }
  robot.pathSegmentProgress = clamp(robot.pathSegmentProgress + delta_t, 0, 1);

  // --- Update Robot's Position and Heading Directly ---
  const { position: targetPathPosition, tangentHeading: tangentialHeadingAtTarget } =
      evaluatePathSegment(segmentStartPoint, currentPathLine, robot.pathSegmentProgress);

  robot.pos = targetPathPosition;
  robot.pathTargetPoint = targetPathPosition; // Store for rendering/debugging

  const targetHeading = getHeadingFromPathPoint(
      currentPathLine.endPoint, // The heading definition for the segment is typically at its end.
      robot.heading, // Fallback if no specific heading defined
      robot.pathSegmentProgress, // Use current progress for interpolation
      tangentialHeadingAtTarget // Pass tangential heading
  );
  robot.heading = targetHeading;
  // Do NOT set robot.turretHeading here. It will be set by updateRobotActions using aimSolution.
  // robot.turretHeading = targetHeading;
  robot.pathTargetHeading = targetHeading; // Store for rendering/debugging

  // --- Check for Segment Completion ---
  // Segment is considered complete when pathSegmentProgress reaches 1.0
  if (robot.pathSegmentProgress >= 1.0) {
    robot.pathSegmentProgress = 1.0; // Ensure it's exactly 1.0
    if (currentPathLine.waitAfterMs && currentPathLine.waitAfterMs > 0) {
      robot.pathWaitTimer = currentPathLine.waitAfterMs;
      // console.log(`[PathTraversal] Robot ${robot.id}: Waiting for ${currentPathLine.waitAfterMs}ms (after segment).`);
    } else {
      robot.pathSequenceIndex++;
      robot.pathSegmentProgress = 0; // Reset for next sequence item
      // console.log(`[PathTraversal] Robot ${robot.id}: Segment ${currentPathLine.id} completed. Advancing to sequence item ${robot.pathSequenceIndex}.`);
    }
  }

  // If path is finished after advancing, deactivate
  if (robot.pathSequenceIndex >= autoPath.sequence.length) {
    robot.autoPathActive = false;
    // console.log(`[PathTraversal] Robot ${robot.id}: All sequence items completed. Path deactivated.`);
    return ZERO_CMD;
  }

  // Return a command with intake/fire active, but no drive commands
  return {
    driveX: 0,
    driveY: 0,
    rotate: 0,
    intake: true, // Force intake active during auto
    fire: true,   // Force fire active during auto
  };
}

/**
 * Helper to approximate the length of a path segment.
 * Used to advance 't' based on desired speed.
 */
function getSegmentLength(startPoint: PathPoint, pathLine: PathLine): number {
  const numSteps = 100; // Number of linear segments to approximate the curve
  let totalLength = 0;
  let prevPoint = evaluatePathSegment(startPoint, pathLine, 0).position;

  for (let i = 1; i <= numSteps; i++) {
    const t = i / numSteps;
    const currentPoint = evaluatePathSegment(startPoint, pathLine, t).position;
    totalLength += dist(prevPoint, currentPoint);
    prevPoint = currentPoint;
  }
  return totalLength;
}