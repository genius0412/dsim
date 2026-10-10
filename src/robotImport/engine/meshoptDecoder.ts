/**
 * The glTF meshopt decoder behind a facade of its own, so the import worker's lazy chunk for it is
 * named `meshoptDecoder-*.js` (bundleaudit routes it by that name) rather than after three's
 * `meshopt_decoder.module.js`, which is the name the main build's shared three.js chunk carries.
 */
export { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
