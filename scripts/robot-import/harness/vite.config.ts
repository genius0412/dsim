import { defineConfig, type Plugin } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The importer's dev harness: its own Vite root (`npx vite scripts/robot-import/harness --port
 * 5191`, `.claude/launch.json`'s `robot-import-harness`). Never built or shipped. `publicDir`
 * serves the fixtures at `/robot.glb` etc., and `POST /__out/<name>` writes what the page baked
 * to `$ROBOT_IMPORT_OUT` (default: the OS temp dir), so the outputs can be inspected on disk.
 */
const OUT = process.env.ROBOT_IMPORT_OUT || join(tmpdir(), 'dsim-robot-import');

const writeOut: Plugin = {
  name: 'robot-import-harness-out',
  configureServer(server) {
    server.middlewares.use('/__out/', (req, res) => {
      const name = (req.url ?? '').replace(/^\/+/, '').replace(/[^\w.-]/g, '_');
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        mkdirSync(OUT, { recursive: true });
        writeFileSync(join(OUT, name), Buffer.concat(chunks));
        res.statusCode = 200;
        res.end(join(OUT, name));
      });
    });
  },
};

export default defineConfig({
  publicDir: '../../fixtures/robot-import',
  plugins: [writeOut],
});
