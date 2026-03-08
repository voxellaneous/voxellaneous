import { VoxelObject, HeightmapObject } from '../scene';

/** Chunk coordinate in chunk-space (3D) */
export interface ChunkCoord {
  x: number;
  y: number;
  z: number;
}

/** Configuration for a single noise layer */
export interface NoiseLayer {
  /** Name for display in UI */
  name: string;
  /** Whether this layer is enabled */
  enabled: boolean;
  /** Base frequency for this layer */
  frequency: number;
  /** Amplitude (contribution strength) */
  amplitude: number;
  /** Number of octaves for fractal noise */
  octaves: number;
  /** Persistence (amplitude decay per octave) */
  persistence: number;
  /** Offset for seed variation between layers */
  seedOffset: number;
}

/** Configuration for terrain generation */
export interface TerrainConfig {
  /** Voxels per chunk in all dimensions (cubic) */
  chunkSize: number;
  /** World units per chunk */
  worldScale: number;
  /** Horizontal render distance in chunks */
  renderDistanceH: number;
  /** Vertical render distance in chunks (up and down from camera) */
  renderDistanceV: number;
  /** LOD levels: render distance per level */
  lodLevels: number[];
  /** Base seed for noise generation */
  seed: number;
  /** Noise layers for terrain generation */
  noiseLayers: NoiseLayer[];
  /** Base terrain height in world units (before noise) */
  baseTerrainHeight: number;
  /** Scale factor for noise contribution to height */
  heightScale: number;
}

/** Storage type for a terrain chunk */
export type ChunkDataType = 'voxel' | 'heightmap';

/** A loaded terrain chunk */
export interface Chunk {
  coord: ChunkCoord;
  lod: number;
  dataType: ChunkDataType;
  voxelObject?: VoxelObject;
  heightmapObject?: HeightmapObject;
  lastAccessed: number;
}

/** Default noise layers */
export const DEFAULT_NOISE_LAYERS: NoiseLayer[] = [
  {
    name: 'Mountains',
    enabled: true,
    frequency: 0.0001,
    amplitude: 5,
    octaves: 2,
    persistence: 0.4,
    seedOffset: 0,
  },
  {
    name: 'Hills',
    enabled: true,
    frequency: 0.001,
    amplitude: 0.5,
    octaves: 1,
    persistence: 0.4,
    seedOffset: 1000,
  },
  {
    name: 'Details',
    enabled: true,
    frequency: 0.008,
    amplitude: 0.05,
    octaves: 1,
    persistence: 0.3,
    seedOffset: 2000,
  },
];

/** Default terrain configuration */
export const DEFAULT_TERRAIN_CONFIG: TerrainConfig = {
  chunkSize: 32,
  worldScale: 32,
  renderDistanceH: 12,
  renderDistanceV: 6,
  lodLevels: [8, 16, 32, 64, 128, 256, 512, 1024, 2048],
  seed: 1812,
  noiseLayers: DEFAULT_NOISE_LAYERS,
  baseTerrainHeight: 0,
  heightScale: 256,
};

/** Utility to create a chunk key for Map storage */
export function chunkKey(coord: ChunkCoord): string {
  return `${coord.x},${coord.y},${coord.z}`;
}
