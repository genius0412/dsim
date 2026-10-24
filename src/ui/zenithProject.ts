/**
 * WHAT DSIM TELLS ZENITH ABOUT THE PLAYER'S ROBOT beyond its robot file: the name on Zenith's bar
 * and where the robot starts. DOM-free and `import.meta.env`-free, unlike `zenithHost.ts`, so the
 * AUTOUI smoke lane runs it; `zenithLaunch.ts` is its caller in the app.
 */
import type { Alliance, GameSettings } from '../types';
import { DEFAULT_SPEC } from '../sim/specDefaults';
import { DEFAULT_ASSISTS } from '../sim/spawn';
import { moduleFor } from '../games';
import { simModuleFor } from '../games/sim';
import type { ZenithStartPose } from './zenithOpen';

const ZENITH_ALLIANCE: Record<Alliance, ZenithStartPose['alliance']> = { red: 'RED', blue: 'BLUE' };

/**
 * THE ROBOT'S NAME ON ZENITH'S BAR. Applying a preset keeps the player's own name on purpose (the
 * builder copies name, team and number across), so a StarterBot build went to Zenith as "My Robot"
 * (sweep W4-D12). A build still on the default name that IS a preset's build is called by the
 * preset's name; a name the player typed always wins.
 */
export function hostLabelFor(s: GameSettings): string {
  const name = s.spec.name?.trim();
  const presets = moduleFor(s.game).presets;
  const preset = presets?.list.find((p) => presets.matches(s.spec, p));
  if (preset?.name && (!name || name === DEFAULT_SPEC.name)) return preset.name;
  return name || 'DSIM robot';
}

/**
 * WHERE THE PLAYER'S ROBOT STARTS, for a new auto (`newAutoStart`, sweep W4-7): the pose the robot
 * spawns at for this build, alliance and start setting, read off a world built the way a match
 * builds it, so an anchor re-seated against the wall for this footprint is where the auto starts
 * too. Null when it cannot be worked out (the world could not be built); Zenith then picks a start
 * itself, as before.
 */
export function playerStartPose(s: GameSettings): ZenithStartPose | null {
  try {
    const world = simModuleFor(s.game).createWorld(
      'match',
      1,
      [
        {
          id: 0,
          alliance: s.alliance,
          spec: s.spec,
          assists: { ...DEFAULT_ASSISTS },
          startIndex: s.startIndex,
          ...(s.startPose ? { startPose: s.startPose } : {}),
        },
      ],
      undefined,
      '2d',
    );
    const r = world.robots.find((x) => x.id === 0);
    if (!r) return null;
    const round = (v: number): number => Math.round(v * 1e4) / 1e4;
    return { alliance: ZENITH_ALLIANCE[s.alliance], xIn: round(r.pos.x), yIn: round(r.pos.y), headingRad: round(r.heading) };
  } catch {
    return null;
  }
}
