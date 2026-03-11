import { mat4, vec3 } from 'gl-matrix';
import { ByteArray } from './common/types';

/** RGBA color as [r, g, b, a] with values in 0..255 */
export type RGBA = [number, number, number, number];

export interface VoxelObject {
  id: string;
  modelMatrix: mat4;
  invModelMatrix: mat4;
  dims: vec3;
  voxels: ByteArray;
  palette: RGBA[];  // Per-object palette
}

/** Heightmap-based terrain chunk: stores height + biome per column instead of full 3D volume */
export interface HeightmapObject {
  id: string;
  modelMatrix: mat4;
  invModelMatrix: mat4;
  /** [width, depth] of the heightmap (chunkSize x chunkSize) */
  dims: [number, number];
  /** Interleaved RG data per column: [height, biomeIdx, ...], size = width * depth * 2 */
  heightmap: Uint8Array;
  palette: RGBA[];
}

/** Overall scene definition including a shared 4-color palette and list of voxel objects */
export interface Scene {
  palette: RGBA[];
  objects: VoxelObject[];
  heightmapObjects?: HeightmapObject[];
}
