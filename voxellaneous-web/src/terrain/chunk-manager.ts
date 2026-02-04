import { vec3, mat4 } from 'gl-matrix';
import { VoxelObject } from '../scene';
import { TERRAIN_PALETTE } from './chunk';
import { Chunk, ChunkCoord, TerrainConfig, DEFAULT_TERRAIN_CONFIG, chunkKey } from './types';
import type {
  WorkerMessage,
  WorkerResultMessage,
} from './terrain-worker';

/** Create a unique key for a chunk at a specific LOD */
function chunkLodKey(coord: ChunkCoord, lod: number): string {
  return `${coord.x},${coord.y},${coord.z},lod${lod}`;
}

/**
 * Manages terrain chunk loading and unloading based on camera position.
 * Uses a Web Worker for terrain generation.
 */
const MAX_PENDING_REQUESTS = 64;

export class ChunkManager {
  private config: TerrainConfig;
  private worker: Worker;
  private chunks: Map<string, Chunk> = new Map();
  private pendingChunks: Set<string> = new Set();
  private nonSurfaceChunks: Set<string> = new Set(); // Chunks confirmed empty or solid
  private lastPlayerChunk: ChunkCoord | null = null;
  private lastPlayerPosition: vec3 | null = null;
  private chunksChanged = true;
  private grassPaletteIndex = 1;
  private requestId = 0;

  constructor(config: Partial<TerrainConfig> = {}) {
    this.config = { ...DEFAULT_TERRAIN_CONFIG, ...config };

    // Create and initialize the worker
    this.worker = new Worker(
      new URL('./terrain-worker.ts', import.meta.url),
      { type: 'module' }
    );

    this.worker.onmessage = this.handleWorkerMessage.bind(this);

    // Initialize worker with config
    const initMsg: WorkerMessage = { type: 'init', config: this.config };
    this.worker.postMessage(initMsg);
  }

  private handleWorkerMessage(e: MessageEvent<WorkerResultMessage>): void {
    const msg = e.data;

    if (msg.type === 'result') {
      const key = chunkLodKey(msg.coord, msg.lod);
      this.pendingChunks.delete(key);

      // If voxels is null, chunk is empty/solid - track it so we don't re-request
      if (!msg.voxels) {
        const coordKey = `${msg.coord.x},${msg.coord.y},${msg.coord.z},lod${msg.lod}`;
        this.nonSurfaceChunks.add(coordKey);
        return;
      }

      // Create VoxelObject from the received data
      const voxelObject = this.createVoxelObject(msg.coord, msg.voxels, msg.lod, msg.lodChunkSize);

      const chunk: Chunk = {
        coord: msg.coord,
        lod: msg.lod,
        voxelObject,
        lastAccessed: Date.now(),
      };

      this.chunks.set(key, chunk);
      this.chunksChanged = true;
    }
  }


  private createVoxelObject(
    coord: ChunkCoord,
    voxels: Uint8Array,
    lod: number,
    lodChunkSize: number,
  ): VoxelObject {
    const { worldScale } = this.config;

    // LOD increases world scale per chunk
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
    this.nonSurfaceChunks.clear();
    this.lastPlayerChunk = null;
    this.chunksChanged = true;
  }

  /** Reinitialize with new config (e.g., after UI changes) */
  reinitialize(config: Partial<TerrainConfig>): void {
    this.config = { ...DEFAULT_TERRAIN_CONFIG, ...config };
    this.chunks.clear();
    this.pendingChunks.clear();
    this.nonSurfaceChunks.clear();
    this.lastPlayerChunk = null;
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

  private requestChunkGeneration(coord: ChunkCoord, lod: number): void {
    const key = chunkLodKey(coord, lod);
    if (this.pendingChunks.has(key) || this.chunks.has(key)) return;
    if (this.pendingChunks.size >= MAX_PENDING_REQUESTS) return;

    // Skip if we already know this coord is non-surface
    const coordKey = `${coord.x},${coord.y},${coord.z},lod${lod}`;
    if (this.nonSurfaceChunks.has(coordKey)) return;

    this.pendingChunks.add(key);

    const msg: WorkerMessage = {
      type: 'generate',
      id: `${this.requestId++}`,
      coord,
      lod,
      grassPaletteIndex: this.grassPaletteIndex,
    };

    this.worker.postMessage(msg);
  }

  update(playerPosition: vec3): boolean {
    const playerChunk = this.worldToChunkCoord(playerPosition);
    const playerMoved =
      !this.lastPlayerChunk ||
      this.lastPlayerChunk.x !== playerChunk.x ||
      this.lastPlayerChunk.y !== playerChunk.y ||
      this.lastPlayerChunk.z !== playerChunk.z;

    // Always update position for smooth distance calculations
    this.lastPlayerPosition = playerPosition;

    if (playerMoved) {
      this.lastPlayerChunk = playerChunk;

      // Unload distant chunks
      const { lodLevels, renderDistanceV, worldScale } = this.config;
      const playerWorldX = playerPosition[0];
      const playerWorldY = playerPosition[1];
      const playerWorldZ = playerPosition[2];

      for (const [key, chunk] of this.chunks.entries()) {
        const lodScale = Math.pow(2, chunk.lod);
        const lodWorldScale = worldScale * lodScale;

        // Use square distance (consistent with loading logic)
        const playerLodChunkX = Math.floor(playerWorldX / lodWorldScale);
        const playerLodChunkZ = Math.floor(playerWorldZ / lodWorldScale);
        const chunkDistX = Math.abs(chunk.coord.x - playerLodChunkX) * lodWorldScale;
        const chunkDistZ = Math.abs(chunk.coord.z - playerLodChunkZ) * lodWorldScale;
        const worldDistH = Math.max(chunkDistX, chunkDistZ);

        // Max horizontal distance
        const maxWorldDistH = lodLevels[chunk.lod] * worldScale + lodWorldScale * 2;

        // Unload if too far horizontally (Y is based on terrain bounds, not player)
        if (worldDistH > maxWorldDistH) {
          this.chunks.delete(key);
          this.chunksChanged = true;
          continue;
        }

        // Unload low-res when player is close enough for higher-res
        if (chunk.lod > 0) {
          const minWorldDistH = lodLevels[chunk.lod - 1] * worldScale;
          if (worldDistH < minWorldDistH) {
            // For LOD 1-2, check if replacements are ready (prevents flicker near player)
            if (chunk.lod <= 2) {
              const hx = chunk.coord.x * 2;
              const hy = chunk.coord.y * 2;
              const hz = chunk.coord.z * 2;
              const higherLod = chunk.lod - 1;

              let allReady = true;
              for (let dx = 0; dx < 2 && allReady; dx++) {
                for (let dy = 0; dy < 2 && allReady; dy++) {
                  for (let dz = 0; dz < 2 && allReady; dz++) {
                    const hKey = `${hx + dx},${hy + dy},${hz + dz},lod${higherLod}`;
                    if (!this.chunks.has(hKey) && !this.nonSurfaceChunks.has(hKey)) {
                      allReady = false;
                    }
                  }
                }
              }

              if (allReady) {
                this.chunks.delete(key);
                this.chunksChanged = true;
              }
            } else {
              // Higher LODs (2+) unload immediately - they're far enough that brief gap is OK
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

  private queueChunksForLoading(playerPosition: vec3): void {
    const { lodLevels, worldScale } = this.config;

    // Use actual player world position for horizontal distance
    const playerWorldX = playerPosition[0];
    const playerWorldZ = playerPosition[2];

    // Build list of candidates sorted by distance
    const candidates: { coord: ChunkCoord; lod: number; dist: number }[] = [];

    // Process each LOD level separately
    for (let lod = 0; lod < lodLevels.length; lod++) {
      const lodScale = Math.pow(2, lod);
      const lodWorldScale = worldScale * lodScale;

      // Distance thresholds in world units
      const minWorldDist = lod === 0 ? 0 : lodLevels[lod - 1] * worldScale;
      const maxWorldDist = lodLevels[lod] * worldScale;

      // Player chunk in this LOD's coordinate system
      const playerLodChunkX = Math.floor(playerWorldX / lodWorldScale);
      const playerLodChunkZ = Math.floor(playerWorldZ / lodWorldScale);

      // Radius in this LOD's chunk units
      const radiusInLod = Math.ceil(maxWorldDist / lodWorldScale) + 1;

      for (let dx = -radiusInLod; dx <= radiusInLod; dx++) {
        for (let dz = -radiusInLod; dz <= radiusInLod; dz++) {
          // Simple square check using chunk distance
          const chunkDistX = Math.abs(dx) * lodWorldScale;
          const chunkDistZ = Math.abs(dz) * lodWorldScale;
          const maxChunkDist = Math.max(chunkDistX, chunkDistZ);

          // Skip if outside this LOD's range or inside inner LOD's range
          if (maxChunkDist > maxWorldDist) continue;
          if (lod > 0 && maxChunkDist < minWorldDist) continue;

          // Y range based purely on terrain bounds (not player position)
          const { baseTerrainHeight, heightScale } = this.config;
          const terrainMinY = baseTerrainHeight - heightScale;
          const terrainMaxY = baseTerrainHeight + heightScale;

          // Convert to this LOD's chunk coordinates
          const yMin = Math.floor(terrainMinY / lodWorldScale) - 1;
          const yMax = Math.ceil(terrainMaxY / lodWorldScale) + 1;

          for (let y = yMin; y <= yMax; y++) {
            const coord: ChunkCoord = {
              x: playerLodChunkX + dx,
              y: y,
              z: playerLodChunkZ + dz,
            };

            const key = chunkLodKey(coord, lod);
            if (this.chunks.has(key)) continue;
            if (this.pendingChunks.has(key)) continue;

            const coordKey = `${coord.x},${coord.y},${coord.z},lod${lod}`;
            if (this.nonSurfaceChunks.has(coordKey)) continue;

            // Priority: LOD first (lower LOD = higher priority), then distance
            const dist = lod * 10000 + maxChunkDist;
            candidates.push({ coord, lod, dist });
          }
        }
      }
    }

    // Sort by priority (LOD 0 first, then by distance)
    candidates.sort((a, b) => a.dist - b.dist);

    // If queue is full and we have LOD 0 candidates, clear distant higher-LOD pending
    const lod0Candidates = candidates.filter(c => c.lod === 0);
    if (lod0Candidates.length > 0 && this.pendingChunks.size >= MAX_PENDING_REQUESTS) {
      // Clear higher-LOD pending to make room for LOD 0
      for (const key of this.pendingChunks) {
        if (!key.includes('lod0')) {
          this.pendingChunks.delete(key);
          if (this.pendingChunks.size < MAX_PENDING_REQUESTS / 2) break;
        }
      }
    }

    const maxToQueue = MAX_PENDING_REQUESTS - this.pendingChunks.size;
    for (let i = 0; i < Math.min(candidates.length, maxToQueue); i++) {
      this.requestChunkGeneration(candidates[i].coord, candidates[i].lod);
    }
  }

  getVisibleChunks(): VoxelObject[] {
    return Array.from(this.chunks.values()).map((chunk) => chunk.voxelObject);
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
