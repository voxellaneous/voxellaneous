// Terrain generation Web Worker
// @ts-ignore - noisejs uses CommonJS exports
import * as NoiseModule from 'noisejs';
const Noise = (NoiseModule as any).Noise || NoiseModule;

import { TerrainConfig, NoiseLayer } from './types';
import { biomePaletteIndex, biomeHeightModifier, BIOME_NOISE } from './biomes';

type NoiseGenerator = InstanceType<typeof Noise>;

let noiseGenerators: Map<number, NoiseGenerator> = new Map();
let tempNoise: NoiseGenerator | null = null;
let humNoise: NoiseGenerator | null = null;
let localNoise: NoiseGenerator | null = null;
let ridgeNoise: NoiseGenerator | null = null;
let currentConfig: TerrainConfig | null = null;

/** Create noise generators for each layer with unique seeds */
function createNoiseGenerators(baseSeed: number, layers: NoiseLayer[]): Map<number, NoiseGenerator> {
  const generators = new Map<number, NoiseGenerator>();
  for (const layer of layers) {
    generators.set(layer.seedOffset, new Noise(baseSeed + layer.seedOffset));
  }
  return generators;
}

/** Create biome noise generators (temperature, humidity, local variation, ridges) */
function createBiomeNoiseGenerators(baseSeed: number): void {
  tempNoise = new Noise(baseSeed + BIOME_NOISE.temperatureSeedOffset);
  humNoise = new Noise(baseSeed + BIOME_NOISE.humiditySeedOffset);
  localNoise = new Noise(baseSeed + BIOME_NOISE.localSeedOffset);
  ridgeNoise = new Noise(baseSeed + BIOME_NOISE.ridgeSeedOffset);
}

/** Sample ridged multifractal noise: each octave feeds back into the next
 *  for sharper, more dramatic mountain ridges than simple 1-|noise| */
function sampleRidgedNoise(worldX: number, worldZ: number): number {
  if (!ridgeNoise) return 0;

  let frequency = BIOME_NOISE.ridgeFrequency;
  let value = 0.0;
  let weight = 1.0;
  let totalWeight = 0.0;

  for (let o = 0; o < BIOME_NOISE.ridgeOctaves; o++) {
    let n = ridgeNoise.perlin2(worldX * frequency, worldZ * frequency);
    // Ridge transform: broad peaks where noise crosses zero (no squaring = rounder)
    n = 1 - Math.abs(n);
    // Weight by previous octave (mild feedback — detail concentrates near peaks)
    n *= weight;
    weight = Math.min(1, Math.max(0, n * BIOME_NOISE.ridgeFeedback));

    const octaveWeight = Math.pow(BIOME_NOISE.ridgePersistence, o);
    value += n * octaveWeight;
    totalWeight += octaveWeight;
    frequency *= 2;
  }

  return (value / totalWeight) * BIOME_NOISE.ridgeAmplitude;
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

/** Sample base climate (temperature, humidity) at a world coordinate */
function sampleClimate(worldX: number, worldZ: number): { temperature: number; humidity: number } {
  if (!tempNoise || !humNoise) return { temperature: 0.5, humidity: 0.5 };

  // Perlin output is roughly [-0.7, 0.7], so * 0.5 + 0.5 never reaches 0 or 1.
  // Use wider multiplier + clamp to spread biomes across the full range.
  const rawT = tempNoise.perlin2(
    worldX * BIOME_NOISE.temperatureFrequency,
    worldZ * BIOME_NOISE.temperatureFrequency,
  );
  const rawH = humNoise.perlin2(
    worldX * BIOME_NOISE.humidityFrequency,
    worldZ * BIOME_NOISE.humidityFrequency,
  );

  const temperature = Math.max(0, Math.min(1, rawT * 1.2 + 0.5));
  const humidity = Math.max(0, Math.min(1, rawH * 1.2 + 0.5));

  return { temperature, humidity };
}

/** Sample terrain height at a world coordinate, modulated by biome climate */
function sampleTerrainHeight(
  worldX: number,
  worldZ: number,
  temperature: number,
  humidity: number,
  config: TerrainConfig,
  generators: Map<number, NoiseGenerator>,
): number {
  const { noiseLayers, baseTerrainHeight } = config;
  const { scale, detail, ridge, offset } = biomeHeightModifier(temperature, humidity);

  let baseNoise = 0;
  let detailNoise = 0;
  for (let i = 0; i < noiseLayers.length; i++) {
    const layer = noiseLayers[i];
    if (!layer.enabled) continue;

    const noise = generators.get(layer.seedOffset);
    if (!noise) continue;

    if (layer.detail) {
      detailNoise += sampleNoiseLayer(worldX, worldZ, layer, noise);
    } else {
      baseNoise += sampleNoiseLayer(worldX, worldZ, layer, noise);
    }
  }

  // Ridged noise adds sharp mountain peaks, modulated by biome
  const ridgeContribution = ridge > 0 ? sampleRidgedNoise(worldX, worldZ) * ridge : 0;

  return baseTerrainHeight + offset + (baseNoise * scale + detailNoise * detail + ridgeContribution) * config.heightScale;
}

// Altitude lapse: above this height, temperature starts dropping toward cold (stone/snow)
const LAPSE_START = 500;   // world units — below this, no altitude effect
const LAPSE_FULL  = 1500;  // world units — at this height, temperature is fully cold

/** Sample biome palette index from base climate + local perturbation + altitude lapse */
function sampleBiomePalette(temperature: number, humidity: number, worldX: number, worldZ: number, height: number): number {
  // Altitude cools temperature: high terrain → stone/snow
  const lapseFactor = Math.max(0, Math.min(1, (height - LAPSE_START) / (LAPSE_FULL - LAPSE_START)));
  const altTemp = temperature * (1 - lapseFactor);

  if (!localNoise) return biomePaletteIndex(altTemp, humidity);

  // Local detail perturbation for within-biome color variation
  const localT = localNoise.perlin2(
    worldX * BIOME_NOISE.localFrequency,
    worldZ * BIOME_NOISE.localFrequency,
  ) * BIOME_NOISE.localStrength;

  const localH = localNoise.perlin2(
    worldX * BIOME_NOISE.localFrequency + 1000,
    worldZ * BIOME_NOISE.localFrequency + 1000,
  ) * BIOME_NOISE.localStrength;

  return biomePaletteIndex(
    Math.max(0, Math.min(1, altTemp + localT)),
    Math.max(0, Math.min(1, humidity + localH)),
  );
}

/** Generate heightmap + biome data for a column at (x, z) in LOD coordinates.
 *  Returns interleaved RG data: [height0, biome0, height1, biome1, ...] */
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

  // Single pass: sample all terrain heights, biome indices, and find min/max
  const heights = new Float64Array(chunkSize * chunkSize);
  const biomeIndices = new Uint8Array(chunkSize * chunkSize);
  let minHeight = Infinity;
  let maxHeight = -Infinity;

  for (let lx = 0; lx < chunkSize; lx++) {
    for (let lz = 0; lz < chunkSize; lz++) {
      const wx = worldX + (lx + 0.5) * voxelSize;
      const wz = worldZ + (lz + 0.5) * voxelSize;
      const { temperature, humidity } = sampleClimate(wx, wz);
      const h = sampleTerrainHeight(wx, wz, temperature, humidity, config, generators);
      const idx = lx + lz * chunkSize;
      heights[idx] = h;
      biomeIndices[idx] = sampleBiomePalette(temperature, humidity, wx, wz, h);
      minHeight = Math.min(minHeight, h);
      maxHeight = Math.max(maxHeight, h);
    }
  }

  // Snap to global voxel grid: minWorldY on grid, Y-voxel = voxelSize.
  // worldYExtent grows to fit actual range (not clamped to lodWorldScale).
  // Edge alignment guaranteed: round(worldH / voxelSize) is chunk-independent.
  const minWorldY = Math.floor(minHeight / voxelSize) * voxelSize - voxelSize;
  const numYVoxels = Math.ceil((maxHeight - minWorldY) / voxelSize) + 1;
  const worldYExtent = numYVoxels * voxelSize;
  const chunkY = Math.floor(minHeight / lodWorldScale);

  // Encode interleaved RG data: [height, biomeIdx, height, biomeIdx, ...]
  const heightmap = new Uint8Array(chunkSize * chunkSize * 2);
  for (let i = 0; i < chunkSize * chunkSize; i++) {
    const voxelH = Math.round((heights[i] - minWorldY) / voxelSize);
    heightmap[i * 2] = Math.max(0, Math.min(255, voxelH));
    heightmap[i * 2 + 1] = biomeIndices[i];
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
  /** Interleaved RG data: [height, biomeIdx, ...], size = chunkSize * chunkSize * 2 */
  heightmap: Uint8Array;
  lodChunkSize: number;
}

// Handle messages from main thread
self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;

  if (msg.type === 'init') {
    currentConfig = msg.config;
    noiseGenerators = createNoiseGenerators(msg.config.seed, msg.config.noiseLayers);
    createBiomeNoiseGenerators(msg.config.seed);
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
    };

    self.postMessage(response, { transfer: [heightmap.buffer as ArrayBuffer] });
  }
};
