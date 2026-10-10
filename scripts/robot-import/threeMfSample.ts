/**
 * A 3MF THAT EXERCISES THE XML, for holding `miniDom.ts` (the import worker's `DOMParser`) to the
 * browser's: two namespaces with a prefixed colour group, base materials, per-vertex colours,
 * components with transforms, two build items, metadata with entity and character references, a
 * comment, a processing instruction, a tab inside an attribute (normalised to a space), numbers in
 * exponent form, and a CRLF line end. `npm test` parses it with the small DOM; the browser harness
 * parses it with both and compares (`harness/main.ts`).
 */
import { strToU8, zipSync } from 'three/examples/jsm/libs/fflate.module.js';

export function threeMfSample(): Uint8Array {
  const v = (x: number, y: number, z: number): string => `<vertex x="${x}" y="${y}" z="${z}"/>`;
  // a 2 × 1 × 0.5 box, one corner written in exponent form
  const verts = [v(0, 0, 0), v(2, 0, 0), v(2, 1, 0), v(0, 1, 0), v(0, 0, 0.5), '<vertex x="2.0E0" y="0" z="5e-1"/>', v(2, 1, 0.5), v(0, 1, 0.5)];
  const faces = [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [1, 2, 6],
    [1, 6, 5],
    [2, 3, 7],
    [2, 7, 6],
    [3, 0, 4],
    [3, 4, 7],
  ];
  const tris = faces.map((f, i) =>
    i < 4 ? `<triangle v1="${f[0]}" v2="${f[1]}" v3="${f[2]}" pid="2" p1="0" p2="1" p3="${i % 2}"/>` : `<triangle v1="${f[0]}" v2="${f[1]}" v3="${f[2]}"/>`,
  );
  const model = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!-- written for the importer\'s checks -->',
    '<model unit="inch" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">',
    '  <metadata name="Title">Box &amp; frame &#x2014; &quot;sample&quot;</metadata>',
    '  <resources>',
    '    <basematerials id="1"><base name="red" displaycolor="#C0392BFF"/><base name="blue" displaycolor="#2E86C1"/></basematerials>',
    '    <m:colorgroup id="2"><m:color color="#27AE60"/><m:color color="#F1C40F"/></m:colorgroup>',
    `    <object id="3" type="model" pid="1" pindex="0"><mesh><vertices>${verts.join('')}</vertices><triangles>${tris.join('')}</triangles></mesh></object>`,
    '    <object id="4" type="model"><components>',
    '      <component objectid="3" transform="1 0 0 0 1 0 0 0 1 2.5 0 0"/>',
    '      <component objectid="3" transform="0 1 0\t-1 0 0 0 0 1 0 3 1"/>',
    '    </components></object>',
    '  </resources>',
    '  <build>',
    '    <?dsim ignored?>',
    '    <item objectid="4" transform="1 0 0 0 1 0 0 0 1 0 0 0.5"/>',
    '    <item objectid="3"/>',
    '  </build>',
    '</model>',
  ].join('\r\n');
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
    ),
    '3D/3dmodel.model': strToU8(model),
  });
}

/** a short fingerprint of parts: every float and index, and each colour, in order */
export function partsHash(parts: readonly { positions: Float32Array; indices: Uint32Array | null; color: readonly number[] }[]): string {
  let h = 0x811c9dc5;
  const mix = (u: number): void => {
    h = Math.imul(h ^ (u & 0xff), 0x01000193);
    h = Math.imul(h ^ ((u >>> 8) & 0xff), 0x01000193);
    h = Math.imul(h ^ ((u >>> 16) & 0xff), 0x01000193);
    h = Math.imul(h ^ (u >>> 24), 0x01000193);
  };
  const f = new Float32Array(1);
  const u = new Uint32Array(f.buffer);
  for (const p of parts) {
    mix(p.positions.length);
    for (const x of p.positions) {
      f[0] = x;
      mix(u[0]);
    }
    for (const i of p.indices ?? []) mix(i);
    for (const c of p.color) {
      f[0] = c;
      mix(u[0]);
    }
  }
  return `${parts.length}:${(h >>> 0).toString(16)}`;
}
