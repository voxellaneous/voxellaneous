// Terrain generation Web Worker
// @ts-ignore - noisejs uses CommonJS exports
import * as NoiseModule from 'noisejs';
const Noise = (NoiseModule as any).Noise || NoiseModule;

import { ChunkCoord, TerrainConfig, NoiseLayer } from './types';
import { ByteArray } from '../common/types';

type NoiseGenerator = InstanceType<typeof Noise>;

let noiseGenerators: Map<number, NoiseGenerator> = new Map();
let currentConfig: TerrainConfig | null = null;

/** Create noise generators for each layer with unique seeds */
function createNoiseGenerators(baseSeed: number, layers: NoiseLayer[]): Map<number, NoiseGenerator> {
  const generators = new Map<number, NoiseGenerator>();
  for (const layer of layers) {
    generators.set(layer.seedOffset, new Noise(baseSeed + layer.seedOffset));
  }
  return generators;
}

/** Sample a single noise layer with fractal octaves */
function sampleNoiseLayer(worldX: number, worldZ: number, layer: NoiseLayer, noise: NoiseGenerator): number {
  if (!layer.enabled) return 0;

  let amplitude = 1.0;
  let frequency = layer.frequency;
  let noiseValue = 0.0;
  let maxAmplitude = 0.0;

  for (let o = 0; o < layer.octaves; o++) {
    noiseValue += amplitude * noise.perlin2(worldX * frequency, worldZ * frequency);
    maxAmplitude += amplitude;
    amplitude *= layer.persistence;
    frequency *= 2;
  }

  return (noiseValue / maxAmplitude) * layer.amplitude;
}

/** Sample terrain height at a world coordinate */
function sampleTerrainHeight(
  worldX: number,
  worldZ: number,
  config: TerrainConfig,
  generators: Map<number, NoiseGenerator>,
): number {
  const { noiseLayers, baseTerrainHeight } = config;

  let height = baseTerrainHeight;

  for (let i = 0; i < noiseLayers.length; i++) {
    const layer = noiseLayers[i];
    if (!layer.enabled) continue;

    const noise = generators.get(layer.seedOffset);
    if (!noise) continue;

    const layerNoise = sampleNoiseLayer(worldX, worldZ, layer, noise);
    height += layerNoise * config.heightScale;
  }

  return height;
}

/** Check chunk terrain type */
function getChunkTerrainType(
  coord: ChunkCoord,
  config: TerrainConfig,
  generators: Map<number, NoiseGenerator>,
  lod: number,
): 'empty' | 'solid' | 'surface' {
  const { worldScale } = config;

  const lodScale = Math.pow(2, lod);
  const lodWorldScale = worldScale * lodScale;

  // Apply same offset as terrain generation
  const lodHeightOffset = lodWorldScale * 0.5;

  const chunkMinY = coord.y * lodWorldScale;
  const chunkMaxY = chunkMinY + lodWorldScale;

  const worldX = coord.x * lodWorldScale;
  const worldZ = coord.z * lodWorldScale;
  const step = lodWorldScale / 4;

  let minHeight = Infinity;
  let maxHeight = -Infinity;

  for (let sx = 0; sx <= 4; sx++) {
    for (let sz = 0; sz <= 4; sz++) {
      const h = sampleTerrainHeight(worldX + sx * step, worldZ + sz * step, config, generators);
      minHeight = Math.min(minHeight, h);
      maxHeight = Math.max(maxHeight, h);
    }
  }

  // Apply LOD offset
  maxHeight += lodHeightOffset;
  minHeight += lodHeightOffset;

  if (chunkMinY >= maxHeight) return 'empty';
  if (chunkMaxY <= minHeight) return 'solid';

  return 'surface';
}

/** Generate voxel data for a chunk */
function generateChunkVoxels(
  coord: ChunkCoord,
  config: TerrainConfig,
  generators: Map<number, NoiseGenerator>,
  grassPaletteIndex: number,
  lod: number,
): ByteArray {
  const { chunkSize, worldScale } = config;

  const lodScale = Math.pow(2, lod);
  const lodWorldScale = worldScale * lodScale;

  const total = chunkSize * chunkSize * chunkSize;
  const voxels = new Uint8Array(total);

  const chunkWorldX = coord.x * lodWorldScale;
  const chunkWorldY = coord.y * lodWorldScale;
  const chunkWorldZ = coord.z * lodWorldScale;

  const voxelSize = lodWorldScale / chunkSize;

  // Compensate for LOD quantization
  const lodHeightOffset = lodWorldScale * 0.5;

  for (let lx = 0; lx < chunkSize; lx++) {
    for (let lz = 0; lz < chunkSize; lz++) {
      const worldX = chunkWorldX + (lx + 0.5) * voxelSize;
      const worldZ = chunkWorldZ + (lz + 0.5) * voxelSize;

      const terrainHeight = sampleTerrainHeight(worldX, worldZ, config, generators) + lodHeightOffset;

      for (let ly = 0; ly < chunkSize; ly++) {
        const voxelCenterY = chunkWorldY + (ly + 0.5) * voxelSize;

        if (voxelCenterY <= terrainHeight) {
          const index = lx + ly * chunkSize + lz * chunkSize * chunkSize;
          voxels[index] = grassPaletteIndex;
        }
      }
    }
  }

  return voxels;
}

// Message types
export interface WorkerInitMessage {
  type: 'init';
  config: TerrainConfig;
}

export interface WorkerGenerateMessage {
  type: 'generate';
  id: string;
  coord: ChunkCoord;
  lod: number;
  grassPaletteIndex: number;
}

export type WorkerMessage = WorkerInitMessage | WorkerGenerateMessage;

export interface WorkerResultMessage {
  type: 'result';
  id: string;
  coord: ChunkCoord;
  lod: number;
  voxels: ByteArray | null; // null if chunk is empty/solid
  lodChunkSize: number;
}

// Handle messages from main thread
self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;

  if (msg.type === 'init') {
    currentConfig = msg.config;
    noiseGenerators = createNoiseGenerators(msg.config.seed, msg.config.noiseLayers);
    return;
  }

  if (!currentConfig) {
    console.error('Worker not initialized');
    return;
  }

  if (msg.type === 'generate') {
    // Check if this chunk contains terrain surface
    const terrainType = getChunkTerrainType(msg.coord, currentConfig, noiseGenerators, msg.lod);

    if (terrainType !== 'surface') {
      // Return null for empty/solid chunks
      const response: WorkerResultMessage = {
        type: 'result',
        id: msg.id,
        coord: msg.coord,
        lod: msg.lod,
        voxels: null,
        lodChunkSize: currentConfig.chunkSize,
      };
      self.postMessage(response);
      return;
    }

    const voxels = generateChunkVoxels(msg.coord, currentConfig, noiseGenerators, msg.grassPaletteIndex, msg.lod);

    const response: WorkerResultMessage = {
      type: 'result',
      id: msg.id,
      coord: msg.coord,
      lod: msg.lod,
      voxels,
      lodChunkSize: currentConfig.chunkSize,
    };

    // Transfer the buffer for efficiency
    self.postMessage(response, { transfer: [voxels.buffer as ArrayBuffer] });
  }
};
