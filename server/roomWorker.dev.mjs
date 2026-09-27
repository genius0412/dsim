/**
 * The sim worker's entry when the server runs from SOURCE (`tsx server/index.ts`, the smoke
 * suites). A worker thread does not inherit tsx's module hooks from the main thread, so this
 * registers them in the worker first and then loads the TypeScript entry. The bundled server
 * (`dist-server/`) never touches this file — it loads `roomWorker.js` directly.
 */
import { register } from 'tsx/esm/api';

register();
await import('./roomWorker.ts');
