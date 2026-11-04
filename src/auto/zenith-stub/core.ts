/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * STAND-IN FOR `@horizon36596/zenith-core` when it is not installed (`./unavailable.ts` says how
 * it is reached and why nothing here runs). The names are the ones DSIM imports; add one here
 * when DSIM starts importing it.
 *
 * The types are deliberately LOOSE: they exist so `tsc` passes on a clone without Zenith, not to
 * describe Zenith. Where DSIM hands a callback to something (`array.map`, the live run's host)
 * the shape is spelled out, because a callback on an `any` is an implicit-any error under
 * `strict`; everything else is `any`. The real declarations are what a build with the packages
 * checks against, and that build (Vercel alpha) is the one that can fail on a type.
 */
import type { Pose, Robot, Step } from './schema';
import { zenithUnavailable } from './unavailable';

/** one step of a plan, as `flattenSteps` lists it */
export interface PlanStep {
  kind: string;
  id: string;
  step: Step;
  lengthIn: number;
  samples: { pose: Pose }[];
  [key: string]: any;
}
export interface Plan {
  steps: PlanStep[];
  startPose: Pose;
  [key: string]: any;
}
/** `[t, x, y, heading]` and `[t, vx, vy, omega]` rows */
type TraceRow = readonly [number, number, number, number];
export interface SimTrace {
  poses: readonly TraceRow[];
  truthPoses: readonly TraceRow[];
  velocities: readonly TraceRow[];
  simTimeS: number;
  [key: string]: any;
}
export interface LiveHost {
  command(name: string, args: Readonly<Record<string, string | number | boolean>>): any;
  condition(name: string): boolean;
}
export type LiveRun = any;
export type Estimate = any;
export type Finding = any;
export type SeasonRules = any;

export function check(_plan: Plan, _estimate: Estimate | null, _robot: Robot, _field: any, _season?: SeasonRules): Finding[] {
  throw zenithUnavailable('check');
}
export function flattenSteps(_steps: readonly PlanStep[]): PlanStep[] {
  throw zenithUnavailable('flattenSteps');
}
export function estimate(_plan: Plan, _robot: Robot): Estimate {
  throw zenithUnavailable('estimate');
}
export function plan(_resolved: any, _robot: Robot, _field: any, _options?: any): Plan {
  throw zenithUnavailable('plan');
}
export function resolve(_auto: any, _waypoints?: any, _robot?: any, _options?: any): any {
  throw zenithUnavailable('resolve');
}
export function loadAuto(_json: unknown): any {
  throw zenithUnavailable('loadAuto');
}
export function loadField(_json: unknown): any {
  throw zenithUnavailable('loadField');
}
export function loadRobot(_json: unknown): Robot {
  throw zenithUnavailable('loadRobot');
}
export function loadWaypoints(_json: unknown): any {
  throw zenithUnavailable('loadWaypoints');
}
export function mirrorAuto(_auto: any, _mode?: any, _mirrorId?: any, _waypoints?: any): any {
  throw zenithUnavailable('mirrorAuto');
}
export function mirrorForField(_field: any): any {
  throw zenithUnavailable('mirrorForField');
}
export function mirrorPose(_pose: Pose, _mode: any): Pose {
  throw zenithUnavailable('mirrorPose');
}
export function createLiveRun(_plan: Plan, _robot: Robot, _field: any, _host: LiveHost, _options: { tickS: number; [key: string]: any }): LiveRun {
  throw zenithUnavailable('createLiveRun');
}
export function simFollowerParams(_robot: Robot): { maxBrakingPower: number; [key: string]: any } {
  throw zenithUnavailable('simFollowerParams');
}
