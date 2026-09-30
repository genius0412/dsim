/**
 * THE GOLDEN LANE — BIOBUZZ's `step()` output, pinned per SIM_VERSION.
 *
 * The same guard `scripts/smoke.ts` runs for DECODE and Chain Reaction (see
 * `scripts/simGolden.ts` for what is hashed and why): fixed seeds, fixed robots, a scripted
 * integer command stream, and the whole world hashed at checkpoints. A failure means BIOBUZZ's
 * sim output moved. If that was meant to be byte-identical it is a regression; if it is a real
 * behaviour change, bump SIM_VERSION in `src/config.ts` (SIM_VERSION is shared by all three
 * games, so the DECODE/CR table in `smoke.ts` gets a new row too) and add a row here.
 */
import type { RobotCommand, World } from '../../src/types';
import { SIM_DT, SIM_VERSION } from '../../src/config';
import { createBiobuzzWorld } from '../../src/games/biobuzz/spawn';
import { biobuzzStep } from '../../src/games/biobuzz/step';
import { BB_PRESET_LIST } from '../../src/games/biobuzz/presets';
import { judgeGolden, runGolden, scriptedCommand, type GoldenScene } from '../simGolden';
import { setup, type Check } from './harness';

const GOLDEN: Record<number, Record<string, string[]>> = {
  4: {
    'biobuzz 2v2 (2d)': ['926a9efb3a6fd405', '5964243fef3a0eef', 'b218de7d9d7aa585', '7c02693b304f497e', '88861b0b6bf62b48', '68a0d4a30bce61db'],
    'biobuzz solo (3d)': ['e8a9e6d3c4cdd1f3', 'b30ba035341ddf1d', '3be4e047934c6014'],
  },
};

/** the shared driver plus BIOBUZZ's own buttons, pulsed on their own rhythms */
const bbCommand = (id: number, tick: number): RobotCommand => ({
  ...scriptedCommand(id, tick),
  bbPlace: (tick + id * 37) % 200 < 12,
  bbPlaceNectar: (tick + id * 53) % 330 < 10,
  bbNectar: (tick + id * 71) % 270 < 8,
  bbRamp: (tick + id * 89) % 600 < 6,
  bbPass: (tick + id * 97) % 410 < 8,
});

const armed = (w: World): World => {
  w.match.preCountdown = 1;
  return w;
};

const preset = (i: number) => BB_PRESET_LIST[i % BB_PRESET_LIST.length];

export function goldenChecks(check: Check): void {
  const scenes: GoldenScene[] = [
    {
      name: 'biobuzz 2v2 (2d)',
      game: 'biobuzz',
      build: () =>
        armed(
          createBiobuzzWorld('match', 31, [
            setup(0, 'blue', preset(0), 0),
            setup(1, 'red', preset(1), 0),
            setup(2, 'blue', preset(2), 1),
            setup(3, 'red', preset(3), 1),
          ]),
        ),
      step: biobuzzStep,
      command: bbCommand,
      ticks: 2400,
      every: 400,
    },
    {
      name: 'biobuzz solo (3d)',
      game: 'biobuzz',
      build: () => armed(createBiobuzzWorld('match', 32, [setup(0, 'blue', preset(0), 0)], undefined, '3d')),
      step: biobuzzStep,
      command: bbCommand,
      ticks: 900,
      every: 300,
    },
  ];
  for (const scene of scenes) {
    const { hashes, world } = runGolden(scene, SIM_DT);
    const [ok, detail] = judgeGolden(scene, hashes, GOLDEN, SIM_VERSION, 'scripts/smoke-biobuzz/golden.ts');
    check(`golden: ${scene.name} re-simulates bit-identically under SIM_VERSION ${SIM_VERSION}`, ok, detail);
    // a scene of robots parked where they spawned pins nothing
    const spawn = scene.build();
    const far = Math.max(...world.robots.map((r, i) => Math.hypot(r.pos.x - spawn.robots[i].pos.x, r.pos.y - spawn.robots[i].pos.y)));
    check(`golden: ${scene.name} is not vacuous (a robot drove away from its spawn)`, world.tick === scene.ticks && far > 12, `tick ${world.tick} · ${world.match.phase} · furthest ${far.toFixed(1)} in`);
  }
}
