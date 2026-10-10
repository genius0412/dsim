/**
 * THE ROBOT PAGE'S HALF OF THE IMPORTER'S COPY (Configure ▸ Robot: the Imported robots row, the
 * Imported robot panel, the library dialogs). Its own file because those components are in the
 * MAIN chunk, and importing `copy.ts` from them carried every editor string into it. `copy.ts`
 * spreads this back into `COPY`, so the editor reads one object. Same house rules (docs/area/ui.md).
 */
export const PAGE_COPY = {
  // ---- Configure ▸ Robot ----
  rowCap: 'Imported robots',
  addTitle: 'Import a robot',
  addFormats: 'GLB, STEP, STL, OBJ, 3MF or PLY',
  resumeTitle: 'Resume import',
  resumeSub: (file: string) => `${file} · not saved`,
  badge: 'Imported',
  deleteAria: (name: string) => `Delete ${name}`,
  added: (name: string) => `Added ${name}.`,
  saved: (name: string) => `Saved ${name}.`,
  panelTitle: 'Imported robot',
  panelEdit: 'Edit in the importer',
  factFile: 'File',
  factFootprint: 'Footprint',
  factFootprintVal: (l: string, w: string, n: number) => `${l} in long, ${w} in wide, ${n} sides`,
  factHeight: 'Height',
  factTriangles: 'Triangles',
  rename: 'Rename',
  duplicate: 'Duplicate',
  exportFile: 'Export file',
  del: 'Delete',
  missingBig: 'Model not on this device',
  missingText: 'It drives as its footprint here. Import its exported file to see the model.',
  missingAction: 'Import the file',
  staleText: 'The model on this device is out of date. Import the robot’s newest exported file to update it.',
  renameTitle: 'Rename robot',
  robotName: 'Robot name',
  cancel: 'Cancel',
  deleteTitle: (name: string) => `Delete ${name}?`,
  deleteBody: 'It’s removed from this device. Export it first to keep a copy.',
  deleteFallback: (name: string) => `You’ll drive ${name} instead.`,
  standardOnly: 'Uses your last standard robot',
  exportFailed: (name: string) => `Couldn’t export ${name}. Try again.`,

  dupTitle: (name: string) => `${name} is already on this device`,
  dupBody: 'Replace it, or keep both?',
  keepBoth: 'Keep both',
  replaceIt: 'Replace',
} as const;

export const FORMAT_LABEL: Record<string, string> = {
  glb: 'GLB',
  gltf: 'glTF',
  stl: 'STL',
  obj: 'OBJ',
  '3mf': '3MF',
  ply: 'PLY',
  step: 'STEP',
};

