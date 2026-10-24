import type { ScenePose } from '../games/module';

/**
 * THE MENU STAGE'S CAMERA (`MenuStage.tsx`), kept DOM-free so the BIOBUZZ RENDER lane can check it
 * against the photographed venues. BIOBUZZ field inches: +x audience right, +y away from the
 * audience, z up.
 */
export type StageView = 'home' | 'setup';

// ponytail: hand-placed and tuned from screenshots; a game with its own 3D field adds its own row.
export const SHOW = { x: -48, y: 30, heading: -Math.PI / 2 + 0.6 };

/**
 * ⚠️ HOME IS A HIGH SHOT, 87 in above the panorama's lens, which a photographed venue drawn on its
 * box cannot take: everything in the photograph that is not floor or wall is drawn flat on the
 * floor, and from up here the school hall's seats, the hangar's clutter and the quad's canopy posts
 * lay across it as streaks (2026-10-21). It stands because every photographed venue is drawn as its
 * LAYERED ROOM (`renderPhotoVenue.ts`), which draws nothing flat; the RENDER lane holds both. Only a
 * venue whose layer files fail to load falls back to the box and smears from here.
 */
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
