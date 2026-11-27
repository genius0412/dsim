// Writes two synthetic robots for the window harnesses (scripts/importflows.cjs, scripts/importroom.cjs), both the
// fixture robot plus one more part reaching out of its front, touching the intake roller:
//   scratch/window-pass/boom.step  a magenta boom 62 in long. Left out of the footprint it still reaches OUTSIDE the box
//                                  a room can draw, so Review's "model reaches outside the robot box" block can be
//                                  reached (importflows f7b).
//   scratch/window-pass/ramp.step  a magenta ramp 22 in long. Left out of the footprint it reaches far (about 30 in
//                                  from the robot's centre) and stays INSIDE the box, so it saves, plays and is relayed
//                                  to a room (importroom d7's long-reach model).
//   npx tsx scripts/importflows-boom.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { writeStep } from './robot-import/fixtures';
import { box, synthRobot } from './robot-import/synthRobot';

mkdirSync('scratch/window-pass', { recursive: true });
const boom = [...synthRobot(), box('boom', [1, 0, 1], 8.5, 70, -0.6, 0.6, 1.8, 3.2)];
writeFileSync('scratch/window-pass/boom.step', writeStep(boom));
const ramp = [...synthRobot(), box('ramp', [1, 0, 1], 8.5, 30.5, -0.6, 0.6, 1.8, 3.2)];
writeFileSync('scratch/window-pass/ramp.step', writeStep(ramp));
console.log('scratch/window-pass/boom.step, scratch/window-pass/ramp.step');
