import { mat4, vec3 } from 'gl-matrix';
import { ByteArray } from '../../voxellaneous-common/src/byte-array';

/** RGBA color as [r, g, b, a] with values in 0..255 */
export type RGBA = [number, number, number, number];

export interface VoxelObject {
  id: string;
  modelMatrix: mat4;
  invModelMatrix: mat4;
  dims: vec3;
  voxels: ByteArray;
}

/** Overall scene definition including a shared 4-color palette and list of voxel objects */
export interface Scene {
  palette: RGBA[];
  objects: VoxelObject[];
}
