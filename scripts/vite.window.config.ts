// The window harnesses' dev server config (importflows.cjs, importroom.cjs): the repo's own config, plus
// a watcher that ignores `scratch/` (the harness writes screenshots and downloads there while it runs;
// vite's watcher died with EBUSY on a download that was still being written).
//   npx vite --config scripts/vite.window.config.ts --port 5194 --strictPort
import { defineConfig, mergeConfig, type ConfigEnv, type UserConfig } from 'vite';
import base from '../vite.config';

export default defineConfig(async (env: ConfigEnv) => {
  const b = typeof base === 'function' ? await base(env) : await base;
  return mergeConfig(b as UserConfig, { server: { watch: { ignored: ['**/scratch/**'] } } });
});
