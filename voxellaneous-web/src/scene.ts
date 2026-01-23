import { mat4, vec3 } from 'gl-matrix';

/** RGBA color as [r, g, b, a] with values in 0..255 */
export type RGBA = [number, number, number, number];

export interface VoxelObject {
  id: string;
  model_matrix: mat4;
  inv_model_matrix: mat4;
  dims: vec3;
  voxels: Uint8Array;
}

/** Overall scene definition including a shared 4-color palette and list of voxel objects */
export interface Scene {
  palette: RGBA[];
  objects: VoxelObject[];
}
