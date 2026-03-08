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

/** Heightmap-based terrain chunk: stores height per column instead of full 3D volume */
export interface HeightmapObject {
  id: string;
  modelMatrix: mat4;
  invModelMatrix: mat4;
  /** [width, depth] of the heightmap (chunkSize x chunkSize) */
  dims: [number, number];
  /** Per-column height values (0 to chunkSize), layout: x + z * width */
  heightmap: Uint8Array;
  palette: RGBA[];
  paletteIndex: number;
}

/** Overall scene definition including a shared 4-color palette and list of voxel objects */
export interface Scene {
  palette: RGBA[];
  objects: VoxelObject[];
  heightmapObjects?: HeightmapObject[];
}
