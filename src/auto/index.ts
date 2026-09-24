/**
 * THE LAZY ENTRY to Zenith autos (docs/area/autos.md). The client reaches it only through
 * `import('./auto')` when a setup carries an auto; the server and the smoke suite import it
 * directly. Everything that needs `@horizon36596/zenith-*` is behind this file.
 */
export { autoAdapterFor } from './games';
export { createAutoSeat, type AutoSeat } from './seat';
export { AutoLoadError, autoStartPose, loadZenithAuto, parseAutoText, namesUsed, type LoadedAuto } from './load';
export { powersToCommand } from './drive';
