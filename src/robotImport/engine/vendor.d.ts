/**
 * Types for the two engine dependencies that ship none: three's bundled meshoptimizer simplifier
 * and occt-import-js. Only the calls the engine makes are declared.
 */
declare module 'three/examples/jsm/libs/meshopt_simplifier.module.js' {
  type Flag = 'LockBorder' | 'Sparse' | 'ErrorAbsolute' | 'Prune' | 'Regularize' | 'Permissive' | 'RegularizeLight';
  export const MeshoptSimplifier: {
    ready: Promise<void>;
    supported: boolean;
    simplify(
      indices: Uint32Array,
      positions: Float32Array,
      stride: number,
      targetIndexCount: number,
      targetError: number,
      flags?: Flag[],
    ): [Uint32Array, number];
    simplifySloppy(
      indices: Uint32Array,
      positions: Float32Array,
      stride: number,
      lock: Uint8Array | null,
      targetIndexCount: number,
      targetError: number,
    ): [Uint32Array, number];
    getScale(positions: Float32Array, stride: number): number;
  };
}

declare module 'occt-import-js' {
  export interface OcctMesh {
    name: string;
    color?: [number, number, number];
    brep_faces: { first: number; last: number; color: [number, number, number] | null }[];
    attributes: { position: { array: number[] }; normal?: { array: number[] } };
    index: { array: number[] };
  }
  export interface OcctNode {
    name: string;
    meshes: number[];
    children: OcctNode[];
  }
  export interface OcctResult {
    success: boolean;
    root: OcctNode;
    meshes: OcctMesh[];
  }
  export interface OcctParams {
    linearUnit?: 'millimeter' | 'centimeter' | 'meter' | 'inch' | 'foot';
    linearDeflectionType?: 'bounding_box_ratio' | 'absolute_value';
    linearDeflection?: number;
    angularDeflection?: number;
  }
  export interface Occt {
    ReadStepFile(content: Uint8Array, params: OcctParams | null): OcctResult;
  }
  const occtimportjs: (moduleArg?: { locateFile?: (path: string, dir: string) => string }) => Promise<Occt>;
  export default occtimportjs;
}
