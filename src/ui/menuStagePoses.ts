import type { ScenePose } from '../games/module';

/**
 * THE MENU STAGE'S CAMERA (`MenuStage.tsx`), kept DOM-free so the BIOBUZZ RENDER lane can check it
 * against the venues. BIOBUZZ field inches: +x audience right, +y away from the audience, z up.
 */
export type StageView = 'home' | 'setup';

// ponytail: hand-placed and tuned from screenshots; a game with its own 3D field adds its own row.
export const SHOW = { x: -48, y: 30, heading: -Math.PI / 2 + 0.6 };

/** the match seed the stage's world is built from. BIOBUZZ's settled stage poses are baked from a
 * world with this seed (`src/games/biobuzz/menuRest.gen.ts`), so changing it means regenerating them. */
export const STAGE_SEED = 1;

/** HOME IS A HIGH SHOT (150 in up). It stands because every venue is real geometry: the photographed
 * venues (2026-10-10 to 2026-11-04) smeared from up here, which is one reason they were retired. */
export const POSES: Record<StageView, ScenePose> = {
  // high over the audience-LEFT corner, looking diagonally across the field (MoSim's shot)
  home: { eye: [-175, -205, 150], target: [10, 20, 0], fovDeg: 38 },
  // low in front of the robot, the rear wall and the stands behind it
  setup: {
    eye: [SHOW.x + 14, SHOW.y - 46, 22],
    target: [SHOW.x, SHOW.y, 7],
    fovDeg: 34,
  },
};
