/**
 * WHAT THE AUTONOMOUS PANEL AND THE FIELD OVERLAY DRAW, from a loaded auto. LAZY CHUNK: this is
 * where Zenith's plan becomes plain numbers, so no screen imports a Zenith type to draw one.
 */
import { flattenSteps, type Finding } from '@horizon36596/zenith-core';
import type { LoadedAuto } from './load';

export interface AutoView {
  name: string;
  title: string | null;
  /** the alliance the file was written for */
  fileAlliance: 'RED' | 'BLUE';
  mirrored: boolean;
  /** path steps as polylines, running alliance's frame */
  legs: { id: string; points: { x: number; y: number }[] }[];
  /** the start, then each path step's end */
  poses: { x: number; y: number; heading: number }[];
  steps: number;
  /** Zenith's estimate, seconds, or null when a step has no estimate */
  estimateS: number | null;
  /** the estimate is a lower bound (a step it cannot time) */
  atLeast: boolean;
  periodS: number;
  errors: Finding[];
  warnings: Finding[];
  unsupported: string[];
}

export function autoView(l: LoadedAuto): AutoView {
  const all = flattenSteps(l.plan.steps);
  const paths = all.filter((s) => s.kind === 'path' && s.samples.length > 0);
  const start = l.plan.startPose;
  return {
    name: l.written.name,
    title: l.written.title ?? null,
    fileAlliance: l.written.alliance,
    mirrored: l.mirrored,
    legs: paths.map((s) => ({ id: s.id, points: s.samples.map((p) => ({ x: p.pose.xIn, y: p.pose.yIn })) })),
    poses: [
      { x: start.xIn, y: start.yIn, heading: start.headingRad ?? 0 },
      ...paths.map((s) => {
        const p = s.samples[s.samples.length - 1].pose;
        return { x: p.xIn, y: p.yIn, heading: p.headingRad ?? 0 };
      }),
    ],
    steps: all.length,
    estimateS: l.estimate.nominalS,
    atLeast: l.estimate.hasUnknown,
    periodS: l.field.periods?.autoS ?? 30,
    errors: l.findings.filter((f) => f.severity === 'error'),
    warnings: l.findings.filter((f) => f.severity === 'warning'),
    unsupported: l.unsupported,
  };
}
