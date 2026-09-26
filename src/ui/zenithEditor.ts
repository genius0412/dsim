/**
 * THE CLIENT'S LAZY ENTRY to Zenith autos (docs/area/autos.md): everything behind
 * `../auto/zenithAutos` plus the editor popup (`zenithLaunch.ts`, `zenithHost.ts`). A screen reaches
 * it only through `import('./zenithEditor')`, so none of it is in the main chunk. The server and the
 * smoke suite import `zenithAutos` instead: `zenithHost.ts` reads `import.meta.env` and `window`.
 */
export * from '../auto/zenithAutos';
export { launchZenith, type LaunchOptions } from './zenithLaunch';
