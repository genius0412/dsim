import { defineConfig } from 'vite';

/**
 * The imported-robot render harness: its own Vite root (`npx vite scripts/robot-import/render
 * --port 5192`). Never built or shipped. `publicDir` serves the importer's fixtures (`/robot.glb`)
 * and the field models the 3D scene asks for are not needed: the turntable draws a robot only.
 */
export default defineConfig({
  publicDir: '../../fixtures/robot-import',
});
