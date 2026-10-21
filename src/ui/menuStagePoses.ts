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
 * ⚠️ HOME'S EYE IS AT THE PANORAMA'S LENS HEIGHT (62.25 in: 63 in above the photographed floor at
 * −0.75). A photographed venue is projected from its lens (`renderPhotoVenue.ts`), so anything in
 * the photograph that is not floor or wall is drawn where its ray meets the floor, and an eye above
 * the lens sees that smear from above. The first Home eye stood 150 in up (2026-10-18): the school
 * hall's seats, the hangar's clutter and the quad's canopy posts lay across the floor as streaks.
 * At 85 in the seats already stretch. The RENDER lane holds it to the lens.
 */
export const POSES: Record<StageView, ScenePose> = {
  // over the audience-LEFT corner, looking diagonally across the field
  home: { eye: [-150, -170, 62], target: [10, 20, 0], fovDeg: 38 },
  // low in front of the robot, the rear wall and the stands behind it
  setup: {
    eye: [SHOW.x + 14, SHOW.y - 46, 22],
    target: [SHOW.x, SHOW.y, 7],
    fovDeg: 34,
  },
};
