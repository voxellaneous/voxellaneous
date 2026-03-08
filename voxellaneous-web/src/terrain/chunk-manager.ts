import { vec3, mat4 } from 'gl-matrix';
import { VoxelObject, HeightmapObject } from '../scene';
import { TERRAIN_PALETTE } from './chunk';
import { Chunk, ChunkCoord, TerrainConfig, DEFAULT_TERRAIN_CONFIG, chunkKey } from './types';
import type { WorkerMessage, WorkerResultMessage } from './terrain-worker';

/** Key for a terrain column: (x, z) at a specific LOD — no Y */
function columnLodKey(x: number, z: number, lod: number): string {
  return `${x},${z},lod${lod}`;
}

const MAX_PENDING_REQUESTS = 64;

export class ChunkManager {
  private config: TerrainConfig;
  private worker: Worker;
  private chunks: Map<string, Chunk> = new Map();
  private pendingChunks: Set<string> = new Set();
  /** Permanent cache of generated chunk data — never regenerate from noise */
  private chunkCache: Map<string, WorkerResultMessage> = new Map();
  private lastPlayerChunkX: number | null = null;
  private lastPlayerChunkZ: number | null = null;
  private lastPlayerPosition: vec3 | null = null;
  private chunksChanged = true;
  private grassPaletteIndex = 1;
  private requestId = 0;

  constructor(config: Partial<TerrainConfig> = {}) {
    this.config = { ...DEFAULT_TERRAIN_CONFIG, ...config };

    this.worker = new Worker(new URL('./terrain-worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = this.handleWorkerMessage.bind(this);

    const initMsg: WorkerMessage = { type: 'init', config: this.config };
    this.worker.postMessage(initMsg);
  }

  private handleWorkerMessage(e: MessageEvent<WorkerResultMessage>): void {
    const msg = e.data;

    if (msg.type === 'result') {
      const key = columnLodKey(msg.x, msg.z, msg.lod);
      this.pendingChunks.delete(key);

      // Cache permanently (even across unload/reload cycles)
      this.chunkCache.set(key, msg);

      this.materializeFromCache(key, msg);
    }
  }

  /** Create a visible Chunk from cached worker data */
  private materializeFromCache(key: string, msg: WorkerResultMessage): void {
    const coord: ChunkCoord = { x: msg.x, y: msg.chunkY, z: msg.z };
    const heightmapObject = this.createHeightmapObject(
      coord, msg.heightmap, msg.lod, msg.lodChunkSize, msg.grassPaletteIndex,
      msg.minWorldY, msg.worldYExtent,
    );
    const chunk: Chunk = {
      coord,
      lod: msg.lod,
      dataType: 'heightmap',
      heightmapObject,
      lastAccessed: Date.now(),
    };
    this.chunks.set(key, chunk);
    this.chunksChanged = true;
  }

  private createHeightmapObject(
    coord: ChunkCoord, heightmap: Uint8Array, lod: number, lodChunkSize: number, paletteIndex: number,
    minWorldY: number, worldYExtent: number,
  ): HeightmapObject {
    const { worldScale } = this.config;

    const lodScale = Math.pow(2, lod);
    const lodWorldScale = worldScale * lodScale;

    const worldX = coord.x * lodWorldScale;
    const worldZ = coord.z * lodWorldScale;

    // Non-uniform Y: box fits exact height range, not a cube
    const modelMatrix = mat4.create();
    mat4.translate(modelMatrix, modelMatrix, [worldX, minWorldY + worldYExtent / 2, worldZ]);
    mat4.scale(modelMatrix, modelMatrix, [lodWorldScale, worldYExtent, lodWorldScale]);

    const invModelMatrix = mat4.create();
    mat4.invert(invModelMatrix, modelMatrix);

    return {
      id: `terrain_hm_${chunkKey(coord)}_lod${lod}`,
      modelMatrix,
      invModelMatrix,
      dims: [lodChunkSize, lodChunkSize],
      heightmap,
      palette: TERRAIN_PALETTE,
      paletteIndex,
    };
  }

  private createVoxelObject(coord: ChunkCoord, voxels: Uint8Array, lod: number, lodChunkSize: number): VoxelObject {
    const { worldScale } = this.config;

    const lodScale = Math.pow(2, lod);
    const lodWorldScale = worldScale * lodScale;

    const worldX = coord.x * lodWorldScale;
    const worldY = coord.y * lodWorldScale;
    const worldZ = coord.z * lodWorldScale;

    const modelMatrix = mat4.create();
    mat4.translate(modelMatrix, modelMatrix, [worldX, worldY, worldZ]);
    mat4.scale(modelMatrix, modelMatrix, [lodWorldScale, lodWorldScale, lodWorldScale]);

    const invModelMatrix = mat4.create();
    mat4.invert(invModelMatrix, modelMatrix);

    return {
      id: `terrain_${chunkKey(coord)}_lod${lod}`,
      modelMatrix,
      invModelMatrix,
      dims: vec3.fromValues(lodChunkSize, lodChunkSize, lodChunkSize),
      voxels,
      palette: TERRAIN_PALETTE,
    };
  }

  setGrassPaletteIndex(index: number): void {
    this.grassPaletteIndex = index;
    this.chunks.clear();
    this.pendingChunks.clear();
    this.chunkCache.clear();
    this.lastPlayerChunkX = null;
    this.lastPlayerChunkZ = null;
    this.chunksChanged = true;
  }

  /** Reinitialize with new config (e.g., after UI changes) */
  reinitialize(config: Partial<TerrainConfig>): void {
    this.config = { ...DEFAULT_TERRAIN_CONFIG, ...config };
    this.chunks.clear();
    this.pendingChunks.clear();
    this.chunkCache.clear();
    this.lastPlayerChunkX = null;
    this.lastPlayerChunkZ = null;
    this.chunksChanged = true;

    const initMsg: WorkerMessage = { type: 'init', config: this.config };
    this.worker.postMessage(initMsg);
  }

  worldToChunkCoord(position: vec3): ChunkCoord {
    const { worldScale } = this.config;
    return {
      x: Math.floor(position[0] / worldScale),
      y: Math.floor(position[1] / worldScale),
      z: Math.floor(position[2] / worldScale),
    };
  }

  private requestChunkGeneration(x: number, z: number, lod: number): void {
    const key = columnLodKey(x, z, lod);
    if (this.pendingChunks.has(key) || this.chunks.has(key)) return;

    // Restore from cache instantly — no worker roundtrip
    const cached = this.chunkCache.get(key);
    if (cached) {
      this.materializeFromCache(key, cached);
      return;
    }

    if (this.pendingChunks.size >= MAX_PENDING_REQUESTS) return;

    this.pendingChunks.add(key);

    const msg: WorkerMessage = {
      type: 'generate',
      id: `${this.requestId++}`,
      x,
      z,
      lod,
      grassPaletteIndex: this.grassPaletteIndex,
    };

    this.worker.postMessage(msg);
  }

  update(playerPosition: vec3): boolean {
    const { worldScale } = this.config;
    const playerChunkX = Math.floor(playerPosition[0] / worldScale);
    const playerChunkZ = Math.floor(playerPosition[2] / worldScale);

    const playerMoved =
      this.lastPlayerChunkX !== playerChunkX ||
      this.lastPlayerChunkZ !== playerChunkZ;

    this.lastPlayerPosition = playerPosition;

    if (playerMoved) {
      this.lastPlayerChunkX = playerChunkX;
      this.lastPlayerChunkZ = playerChunkZ;

      const { lodLevels } = this.config;
      const playerWorldX = playerPosition[0];
      const playerWorldZ = playerPosition[2];

      // Unload distant chunks (keyed by xz column)
      for (const [key, chunk] of this.chunks.entries()) {
        const lodScale = Math.pow(2, chunk.lod);
        const lodWorldScale = worldScale * lodScale;

        const playerLodChunkX = Math.floor(playerWorldX / lodWorldScale);
        const playerLodChunkZ = Math.floor(playerWorldZ / lodWorldScale);
        const chunkDistX = Math.abs(chunk.coord.x - playerLodChunkX) * lodWorldScale;
        const chunkDistZ = Math.abs(chunk.coord.z - playerLodChunkZ) * lodWorldScale;
        const worldDistH = Math.max(chunkDistX, chunkDistZ);

        const maxWorldDistH = lodLevels[chunk.lod] * worldScale + lodWorldScale * 2;

        if (worldDistH > maxWorldDistH) {
          this.chunks.delete(key);
          this.chunksChanged = true;
          continue;
        }

        // Unload low-res when player is close enough for higher-res
        if (chunk.lod > 0) {
          const minWorldDistH = lodLevels[chunk.lod - 1] * worldScale;
          if (worldDistH < minWorldDistH) {
            // Check if 4 higher-LOD children (2x2 in xz) are ready
            const hx = chunk.coord.x * 2;
            const hz = chunk.coord.z * 2;
            const higherLod = chunk.lod - 1;

            let allReady = true;
            for (let dx = 0; dx < 2 && allReady; dx++) {
              for (let dz = 0; dz < 2 && allReady; dz++) {
                const hKey = columnLodKey(hx + dx, hz + dz, higherLod);
                if (!this.chunks.has(hKey)) {
                  allReady = false;
                }
              }
            }

            if (allReady) {
              this.chunks.delete(key);
              this.chunksChanged = true;
            }
          }
        }
      }
    }

    // Always try to queue more chunks if there's capacity
    if (this.lastPlayerPosition) {
      this.queueChunksForLoading(this.lastPlayerPosition);
    }

    const changed = this.chunksChanged;
    this.chunksChanged = false;
    return changed;
  }

  /** Queue chunks for loading — iterates only (x, z) per LOD, no Y loop */
  private queueChunksForLoading(playerPosition: vec3): void {
    const { lodLevels, worldScale } = this.config;

    const playerWorldX = playerPosition[0];
    const playerWorldZ = playerPosition[2];

    const candidates: { x: number; z: number; lod: number; dist: number }[] = [];

    for (let lod = 0; lod < lodLevels.length; lod++) {
      const lodScale = Math.pow(2, lod);
      const lodWorldScale = worldScale * lodScale;

      const minWorldDist = lod === 0 ? 0 : lodLevels[lod - 1] * worldScale;
      const maxWorldDist = lodLevels[lod] * worldScale;

      const playerLodChunkX = Math.floor(playerWorldX / lodWorldScale);
      const playerLodChunkZ = Math.floor(playerWorldZ / lodWorldScale);

      const radiusInLod = Math.ceil(maxWorldDist / lodWorldScale) + 1;

      for (let dx = -radiusInLod; dx <= radiusInLod; dx++) {
        for (let dz = -radiusInLod; dz <= radiusInLod; dz++) {
          const chunkDistX = Math.abs(dx) * lodWorldScale;
          const chunkDistZ = Math.abs(dz) * lodWorldScale;
          const maxChunkDist = Math.max(chunkDistX, chunkDistZ);

          if (maxChunkDist > maxWorldDist) continue;
          if (lod > 0 && maxChunkDist < minWorldDist) continue;

          const x = playerLodChunkX + dx;
          const z = playerLodChunkZ + dz;

          const key = columnLodKey(x, z, lod);
          if (this.chunks.has(key)) continue;
          if (this.pendingChunks.has(key)) continue;

          const dist = lod * 100000 + maxChunkDist;
          candidates.push({ x, z, lod, dist });
        }
      }
    }

    // Sort by priority (LOD 0 first, then by horizontal distance)
    candidates.sort((a, b) => a.dist - b.dist);

    // If queue is full and we have LOD 0 candidates, clear distant higher-LOD pending
    const lod0Candidates = candidates.filter((c) => c.lod === 0);
    if (lod0Candidates.length > 0 && this.pendingChunks.size >= MAX_PENDING_REQUESTS) {
      for (const key of this.pendingChunks) {
        if (!key.includes('lod0')) {
          this.pendingChunks.delete(key);
          if (this.pendingChunks.size < MAX_PENDING_REQUESTS / 2) break;
        }
      }
    }

    const maxToQueue = MAX_PENDING_REQUESTS - this.pendingChunks.size;
    for (let i = 0; i < Math.min(candidates.length, maxToQueue); i++) {
      this.requestChunkGeneration(candidates[i].x, candidates[i].z, candidates[i].lod);
    }
  }

  getVisibleChunks(): VoxelObject[] {
    return Array.from(this.chunks.values())
      .filter((c) => c.dataType === 'voxel' && c.voxelObject)
      .map((c) => c.voxelObject!);
  }

  getVisibleHeightmapChunks(): HeightmapObject[] {
    return Array.from(this.chunks.values())
      .filter((c) => c.dataType === 'heightmap' && c.heightmapObject)
      .map((c) => c.heightmapObject!);
  }

  getLoadedChunkCount(): number {
    return this.chunks.size;
  }

  getPendingCount(): number {
    return this.pendingChunks.size;
  }

  getConfig(): Readonly<TerrainConfig> {
    return this.config;
  }

  dispose(): void {
    this.worker.terminate();
  }
}
