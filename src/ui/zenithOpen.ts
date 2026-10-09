/**
 * THE `open` MESSAGE DSIM SENDS ZENITH (`zenith-host/1`, Zenith's host protocol), and DSIM's host
 * build. DOM-free and `import.meta.env`-free, unlike `zenithHost.ts`, so the AUTO smoke lane checks
 * the exact message; `zenithHost.ts` is its one caller in the app.
 */

export const PROTOCOL = 'zenith-host/1';

/**
 * DSIM'S HOST BUILD, sent as `hostBuild` in every `open`. A DSIM tab stays open for days, so the
 * page someone uses may be older than the latest deploy and hand Zenith an old field or robot;
 * Zenith compares this with the lowest build it expects from DSIM and says "DSIM is out of date".
 * ⚠️ RAISE IT BY ONE whenever what DSIM sends in `open` changes (a project field, the robot or field
 * file's shape, a flag), in the same commit. A whole number from 0 up, or Zenith drops the `open`.
 */
export const HOST_BUILD = 1;

export interface ZenithProject {
  name: string;
  hostLabel?: string;
  robot: unknown;
  field: unknown;
  waypoints?: unknown;
  /** auto name -> file text */
  autos: Record<string, string>;
}

/** what one `open` carries: the project, and the auto to open first or a new one */
export interface ZenithOpen {
  project: ZenithProject;
  open?: string;
  /**
   * start a new auto although `autos` is not empty; Zenith names it so it clashes with none of
   * them (`new-auto`, `new-auto-2`, …) and ignores `open`
   */
  newAuto?: boolean;
}

/** The `open` message for one project; `simulate` offers "Simulate in DSIM". */
export function openMessage(o: ZenithOpen, simulate: boolean): Record<string, unknown> {
  return {
    type: 'open',
    protocol: PROTOCOL,
    project: o.project,
    ...(o.newAuto ? { newAuto: true } : o.open ? { open: o.open } : {}),
    readOnlyRobot: true,
    capabilities: { simulate },
    hostBuild: HOST_BUILD,
  };
}
