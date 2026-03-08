// Terrain generation Web Worker
// @ts-ignore - noisejs uses CommonJS exports
import * as NoiseModule from 'noisejs';
const Noise = (NoiseModule as any).Noise || NoiseModule;

import { TerrainConfig, NoiseLayer } from './types';

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

/** Generate heightmap for a column at (x, z) in LOD coordinates.
 *  Computes optimal Y placement from terrain sampling — no Y input needed. */
function generateColumnHeightmap(
  x: number,
  z: number,
  lod: number,
  config: TerrainConfig,
  generators: Map<number, NoiseGenerator>,
): { heightmap: Uint8Array; chunkY: number; minWorldY: number; worldYExtent: number } {
  const { chunkSize, worldScale } = config;
  const lodScale = Math.pow(2, lod);
  const lodWorldScale = worldScale * lodScale;
  const voxelSize = lodWorldScale / chunkSize;

  const worldX = x * lodWorldScale;
  const worldZ = z * lodWorldScale;

  // Single pass: sample all terrain heights and find min/max
  const heights = new Float64Array(chunkSize * chunkSize);
  let minHeight = Infinity;
  let maxHeight = -Infinity;

  for (let lx = 0; lx < chunkSize; lx++) {
    for (let lz = 0; lz < chunkSize; lz++) {
      const wx = worldX + (lx + 0.5) * voxelSize - lodWorldScale * 0.5;
      const wz = worldZ + (lz + 0.5) * voxelSize - lodWorldScale * 0.5;
      const h = sampleTerrainHeight(wx, wz, config, generators);
      heights[lx + lz * chunkSize] = h;
      minHeight = Math.min(minHeight, h);
      maxHeight = Math.max(maxHeight, h);
    }
  }

  // Non-cubic Y: fits exact height range with padding.
  // Uses full [0,255] range for sub-voxel precision.
  const padding = voxelSize;
  const minWorldY = minHeight - padding;
  const worldYExtent = Math.max(maxHeight - minHeight + 2 * padding, voxelSize);
  const chunkY = Math.floor(minHeight / lodWorldScale);

  // Encode height as fraction of worldYExtent → [0, 255]
  const heightmap = new Uint8Array(chunkSize * chunkSize);
  for (let i = 0; i < chunkSize * chunkSize; i++) {
    const frac = (heights[i] - minWorldY) / worldYExtent;
    heightmap[i] = Math.max(0, Math.min(255, Math.round(frac * 255)));
  }

  return { heightmap, chunkY, minWorldY, worldYExtent };
}

// Message types
export interface WorkerInitMessage {
  type: 'init';
  config: TerrainConfig;
}

export interface WorkerGenerateMessage {
  type: 'generate';
  x: number;
  z: number;
  lod: number;
  grassPaletteIndex: number;
}

export type WorkerMessage = WorkerInitMessage | WorkerGenerateMessage;

export interface WorkerResultMessage {
  type: 'result';
  x: number;
  z: number;
  /** Y chunk coordinate computed from terrain height sampling (for ID) */
  chunkY: number;
  /** Exact world-space Y bottom of the chunk box */
  minWorldY: number;
  /** World-space Y extent of the chunk box (may differ from lodWorldScale) */
  worldYExtent: number;
  lod: number;
  heightmap: Uint8Array;
  lodChunkSize: number;
  grassPaletteIndex: number;
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
    const { heightmap, chunkY, minWorldY, worldYExtent } = generateColumnHeightmap(
      msg.x, msg.z, msg.lod, currentConfig, noiseGenerators,
    );

    const response: WorkerResultMessage = {
      type: 'result',
      x: msg.x,
      z: msg.z,
      chunkY,
      minWorldY,
      worldYExtent,
      lod: msg.lod,
      heightmap,
      lodChunkSize: currentConfig.chunkSize,
      grassPaletteIndex: msg.grassPaletteIndex,
    };

    self.postMessage(response, { transfer: [heightmap.buffer as ArrayBuffer] });
  }
};
