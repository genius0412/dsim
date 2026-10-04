/**
 * THE IMPORT WORKER: parse, merge, weld, simplify and crease a dropped model OFF the main thread, and
 * send the prepared model back with its arrays transferred (at Full detail, every triangle and the
 * simplified copy the editor measures). Spawned per import by
 * `importSession.ts` and terminated when it answers or the player cancels, so the meshopt heap a
 * 4M-triangle export grows (hundreds of MB) is given back the moment the import is done.
 *
 * Reads GLB, glTF, STL, OBJ, PLY and 3MF itself (`parse.ts`), from the dropped files or the zip they
 * came in; a STEP file arrives as parts read by its own workers. Every failure comes back as
 * `{ kind: 'error' }` with the `ImportError` code, so the
 * player sees the same sentence the main-thread loader would have given.
 *
 * It also runs the bake's mesh half (`{ kind: 'bake' }`, `bakeMesh.ts`): the robot-local frame, the
 * split into moving parts, the GLB export and its refits, so Save does not block on them either; and the relay's lighter mesh (`{ kind: 'lite' }`,
 * `lite.ts`), which at 250k triangles is most of a second of simplifying.
 */
import { bakeModelHere } from './bakeMesh';
import { ImportError } from './importError';
import type { ImportRequest, ImportResponse } from './importProtocol';
import { partBuffers } from './importProtocol';
import { assembleLoaded, parseFiles } from './parse';
import { simplifyModel } from './prepare';

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<ImportRequest>) => void) | null;
  postMessage(msg: ImportResponse, transfer?: Transferable[]): void;
};

ctx.onmessage = async (e: MessageEvent<ImportRequest>) => {
  const req = e.data;
  const post = (m: ImportResponse, transfer?: Transferable[]): void => ctx.postMessage(m, transfer);
  try {
    if (req.kind === 'bake') {
      const { glb, pictures, refits } = await bakeModelHere(req.input);
      post({ kind: 'baked', glb, pictures, refits }, [glb, ...partBuffers(pictures)]);
      return;
    }
    if (req.kind === 'lite') {
      // its own chunk (the float exporter and the decoder), fetched only when a room needs one
      const { liteMesh } = await import('./lite');
      const glb = await liteMesh(req.glb, req.maxBytes);
      post({ kind: 'lite', glb }, glb ? [glb] : []);
      return;
    }
    let loaded;
    if (req.kind === 'files' || req.kind === 'zip') {
      // the zip reader is its own chunk, fetched only when a zip is dropped
      const files = req.kind === 'zip' ? await (await import('./zip')).unzipFiles(req.pick, (frac) => post({ kind: 'progress', stage: 'unzip', frac })) : req.files;
      const file = req.kind === 'zip' ? files[0] : req.files[req.primary];
      const format = req.kind === 'zip' ? req.pick.format : req.format;
      const parsed = await parseFiles(file, files, format, (stage, frac) => post({ kind: 'progress', stage, frac }), () => import('./meshoptDecoder').then((m) => m.MeshoptDecoder));
      post({ kind: 'progress', stage: 'convert' });
      loaded = assembleLoaded(req.kind === 'zip' ? req.pick.name : file.name, format, parsed);
      // the unmerged parts are not needed past the merge; nothing else here would let them go
      parsed.parts.length = 0;
    } else {
      post({ kind: 'progress', stage: 'convert' });
      loaded = assembleLoaded(req.name, req.format, req.parsed);
      req.parsed.parts.length = 0;
    }
    const tris = loaded.trisIn;
    post({ kind: 'progress', stage: 'simplify', frac: 0, tris });
    let last = 0;
    const model = await simplifyModel(
      loaded,
      req.budget,
      (frac) => {
        if (frac - last < 0.02 && frac < 1) return;
        last = frac;
        post({ kind: 'progress', stage: 'simplify', frac, tris });
      },
      { consume: true },
    );
    post({ kind: 'done', model }, partBuffers([...model.parts, ...(model.full ?? [])]));
  } catch (err) {
    post({
      kind: 'error',
      code: err instanceof ImportError ? err.code : null,
      name: err instanceof Error ? err.name : 'Error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
