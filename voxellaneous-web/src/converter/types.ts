import { VoxelObject, RGBA } from '../scene';

/** Represents a loaded mesh with geometry and material data */
export interface LoadedMesh {
  name: string;
  positions: Float32Array;
  indices: Uint16Array | Uint32Array;
  normals?: Float32Array;
  uvs?: Float32Array;
  colors?: Float32Array;
  material: MeshMaterial;
}

/** Material information extracted from GLTF */
export interface MeshMaterial {
  baseColor?: RGBA;
  texture?: ImageData;
}

/** Configuration for the voxelization process */
export interface VoxelizationConfig {
  /** Uniform grid size (16-256) */
  resolution: number;
  /** Surface mode: only surface voxels. Solid mode: filled interior */
  mode: 'surface' | 'solid';
}

/** Result of the GLTF to voxel conversion */
export interface ConversionResult {
  object: VoxelObject;
  palette: RGBA[];
  stats: ConversionStats;
}

/** Statistics about the conversion process */
export interface ConversionStats {
  triangles: number;
  voxels: number;
  timeMs: number;
  uniqueColors: number;
  quantized: boolean;
}

/** Bounding box in 3D space */
export interface BoundingBox {
  min: [number, number, number];
  max: [number, number, number];
}

/** A triangle with vertex positions and optional color data */
export interface Triangle {
  v0: [number, number, number];
  v1: [number, number, number];
  v2: [number, number, number];
  uv0?: [number, number];
  uv1?: [number, number];
  uv2?: [number, number];
  color0?: RGBA;
  color1?: RGBA;
  color2?: RGBA;
}

/** Intermediate voxel data during conversion */
export interface VoxelData {
  /** 3D array dimensions */
  dims: [number, number, number];
  /** Map from voxel index to color */
  voxelColors: Map<number, RGBA>;
}

/** Export format for JSON serialization */
export interface VoxelExportFormat {
  version: string;
  object: {
    id: string;
    dims: [number, number, number];
    voxels: string; // base64-encoded Uint8Array
  };
  palette: RGBA[];
  metadata: {
    sourceFile: string;
    resolution: number;
    mode: 'surface' | 'solid';
    triangles: number;
    voxels: number;
  };
}
