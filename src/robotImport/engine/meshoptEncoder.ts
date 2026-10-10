/**
 * meshoptimizer's encoder behind a facade of its own, so its lazy chunk is named `meshoptEncoder-*.js`
 * (bundleaudit routes it by that name). `storedGlb.ts` reaches it by `import()`, so the encoder is
 * fetched when a robot is saved, not when a file is dropped.
 */
export { MeshoptEncoder } from 'meshoptimizer/encoder';
