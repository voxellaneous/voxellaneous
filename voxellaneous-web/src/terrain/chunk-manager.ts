import { mat4 } from 'gl-matrix';
import type { vec3 } from 'gl-matrix';
import { HeightmapObject } from '../scene';
import { TERRAIN_PALETTE } from './chunk';
import { Chunk, ChunkCoord, TerrainConfig, DEFAULT_TERRAIN_CONFIG, chunkKey } from './types';
import type { WorkerMessage, WorkerResultMessage } from './terrain-worker';

/**
 * Numeric key for a terrain column: (x, z) at a specific LOD.
 * Packs into a single safe integer (46 bits of 53 available).
 * Layout: [x+offset 21 bits][z+offset 21 bits][lod 4 bits]
 */
const COORD_OFFSET = 1 << 20;  // 1048576 — supports coords ±1048576
const COORD_RANGE = 1 << 21;   // 2097152
const LOD_RANGE = 16;

function columnLodKey(x: number, z: number, lod: number): number {
  return ((x + COORD_OFFSET) * COORD_RANGE + (z + COORD_OFFSET)) * LOD_RANGE + lod;
}

function keyToString(key: number): string {
  const lod = key % LOD_RANGE;
  const rest = (key - lod) / LOD_RANGE;
  const z = (rest % COORD_RANGE) - COORD_OFFSET;
  const x = ((rest - (z + COORD_OFFSET)) / COORD_RANGE) - COORD_OFFSET;
  return `(${x},${z},lod${lod})`;
}

const MAX_PENDING_REQUESTS = 64;

export class ChunkManager {
  private config: TerrainConfig;
  private worker: Worker;
  private chunks: Map<number, Chunk> = new Map();
  private pendingChunks: Set<number> = new Set();
  /** Permanent cache of generated chunk data — never regenerate from noise */
  private chunkCache: Map<number, WorkerResultMessage> = new Map();
  private lastPlayerChunkX: number | null = null;
  private lastPlayerChunkZ: number | null = null;
  private lastPlayerPosition: vec3 | null = null;
  private chunksChanged = true;
  private _gapDetectEnabled = false;
  private _frameNum = 0;

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
  private materializeFromCache(key: number, msg: WorkerResultMessage): void {
    const coord: ChunkCoord = { x: msg.x, y: msg.chunkY, z: msg.z };
    const heightmapObject = this.createHeightmapObject(
      coord, msg.heightmap, msg.lod, msg.lodChunkSize,
      msg.minWorldY, msg.worldYExtent,
    );
    const chunk: Chunk = {
      coord,
      lod: msg.lod,
      heightmapObject,
      lastAccessed: Date.now(),
    };
    this.chunks.set(key, chunk);
    this.chunksChanged = true;
  }

  private createHeightmapObject(
    coord: ChunkCoord, heightmap: Uint8Array, lod: number, lodChunkSize: number,
    minWorldY: number, worldYExtent: number,
  ): HeightmapObject {
    const { worldScale } = this.config;

    const lodScale = Math.pow(2, lod);
    const lodWorldScale = worldScale * lodScale;

    const worldX = (coord.x + 0.5) * lodWorldScale;
    const worldZ = (coord.z + 0.5) * lodWorldScale;

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
    };
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

  private isAreaFullyCovered(cx: number, cz: number, parentLod: number): boolean {
    const hx = cx * 2;
    const hz = cz * 2;
    const childLod = parentLod - 1;
    for (let dx = 0; dx < 2; dx++) {
      for (let dz = 0; dz < 2; dz++) {
        if (!this.isSubAreaCovered(hx + dx, hz + dz, childLod)) {
          return false;
        }
      }
    }
    return true;
  }

  private isSubAreaCovered(cx: number, cz: number, lod: number): boolean {
    if (this.chunks.has(columnLodKey(cx, cz, lod))) return true;
    if (lod === 0) return false;
    const hx = cx * 2;
    const hz = cz * 2;
    const childLod = lod - 1;
    for (let dx = 0; dx < 2; dx++) {
      for (let dz = 0; dz < 2; dz++) {
        if (!this.isSubAreaCovered(hx + dx, hz + dz, childLod)) {
          return false;
        }
      }
    }
    return true;
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
      x,
      z,
      lod,
    };

    this.worker.postMessage(msg);
  }

  update(playerPosition: vec3): boolean {
    this._frameNum++;
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
    }

    const { lodLevels } = this.config;
    const playerWorldX = playerPosition[0];
    const playerWorldZ = playerPosition[2];

    // Unload chunks — runs every frame so newly-arrived finer chunks
    // can immediately replace coarse parents (not just on chunk-boundary crossings).
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

      // Unload low-res when higher-res chunks fully cover its area.
      // Recursive quadtree check...
      if (chunk.lod > 0) {
        const minWorldDistH = lodLevels[chunk.lod - 1] * worldScale;
        if (worldDistH < minWorldDistH) {
          if (this.isAreaFullyCovered(chunk.coord.x, chunk.coord.z, chunk.lod)) {
            this.chunks.delete(key);
            this.chunksChanged = true;
          }
        }
      }
    }

    // Detect coverage gaps near the player (when enabled)
    if (this._gapDetectEnabled) {
      this.detectGaps(playerWorldX, playerWorldZ, worldScale, lodLevels);
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

      const radiusInLod = Math.min(Math.ceil(maxWorldDist / lodWorldScale) + 1, 32);

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

    if (candidates.length === 0) return;
    candidates.sort((a, b) => a.dist - b.dist);

    const maxToQueue = MAX_PENDING_REQUESTS - this.pendingChunks.size;
    for (let i = 0; i < Math.min(candidates.length, maxToQueue); i++) {
      this.requestChunkGeneration(candidates[i].x, candidates[i].z, candidates[i].lod);
    }
  }

  getVisibleHeightmapChunks(): HeightmapObject[] {
    const result: HeightmapObject[] = [];
    for (const chunk of this.chunks.values()) {
      if (chunk.heightmapObject) {
        result.push(chunk.heightmapObject);
      }
    }
    return result;
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

  /** Toggle per-frame gap detection. Logs whenever an area near the player has no coverage. */
  toggleGapDetect(): void {
    this._gapDetectEnabled = !this._gapDetectEnabled;
    console.log(`[gap-detect] ${this._gapDetectEnabled ? 'ON — move around, gaps will be logged' : 'OFF'}`);
  }

  /**
   * For each LOD level, scan the ring of chunks that SHOULD exist and check
   * if they (or any coarser chunk) are actually loaded. Logs uncovered areas.
   */
  private detectGaps(
    playerWorldX: number, playerWorldZ: number,
    worldScale: number, lodLevels: number[],
  ): void {
    const gaps: string[] = [];

    for (let lod = 0; lod < lodLevels.length && gaps.length < 12; lod++) {
      const lodScale = 1 << lod;
      const lodWorldScale = worldScale * lodScale;
      const minWorldDist = lod === 0 ? 0 : lodLevels[lod - 1] * worldScale;
      const maxWorldDist = lodLevels[lod] * worldScale;

      const playerLodX = Math.floor(playerWorldX / lodWorldScale);
      const playerLodZ = Math.floor(playerWorldZ / lodWorldScale);
      const radius = Math.min(Math.ceil(maxWorldDist / lodWorldScale) + 1, 32);

      for (let dx = -radius; dx <= radius && gaps.length < 12; dx++) {
        for (let dz = -radius; dz <= radius && gaps.length < 12; dz++) {
          const chunkDist = Math.max(Math.abs(dx), Math.abs(dz)) * lodWorldScale;
          if (chunkDist > maxWorldDist) continue;
          if (lod > 0 && chunkDist < minWorldDist) continue;

          const cx = playerLodX + dx;
          const cz = playerLodZ + dz;

          // Check this chunk and all coarser LODs
          let covered = false;
          for (let checkLod = lod; checkLod < lodLevels.length && !covered; checkLod++) {
            const shift = checkLod - lod;
            if (this.chunks.has(columnLodKey(cx >> shift, cz >> shift, checkLod))) {
              covered = true;
            }
          }

          if (!covered) {
            const pending = this.pendingChunks.has(columnLodKey(cx, cz, lod));
            gaps.push(`  lod${lod}(${cx},${cz}) dist=${chunkDist.toFixed(0)} ${pending ? 'PENDING' : 'MISSING'}`);
          }
        }
      }
    }

    if (gaps.length > 0) {
      console.log(`[gap-detect] f${this._frameNum} ${gaps.length}+ gaps:\n${gaps.join('\n')}`);
    }
  }

  /** Log why coarse chunks near the player aren't being removed */
  debugStuckChunks(): void {
    if (!this.lastPlayerPosition) return;
    const { worldScale, lodLevels } = this.config;
    const px = this.lastPlayerPosition[0];
    const pz = this.lastPlayerPosition[2];

    const stuck: string[] = [];
    for (const [key, chunk] of this.chunks.entries()) {
      if (chunk.lod === 0) continue;

      const lodScale = Math.pow(2, chunk.lod);
      const lodWorldScale = worldScale * lodScale;
      const playerLodX = Math.floor(px / lodWorldScale);
      const playerLodZ = Math.floor(pz / lodWorldScale);
      const distX = Math.abs(chunk.coord.x - playerLodX) * lodWorldScale;
      const distZ = Math.abs(chunk.coord.z - playerLodZ) * lodWorldScale;
      const worldDist = Math.max(distX, distZ);
      const minDist = lodLevels[chunk.lod - 1] * worldScale;

      if (worldDist >= minDist) continue; // not in replacement zone

      const covered = this.isAreaFullyCovered(chunk.coord.x, chunk.coord.z, chunk.lod);
      if (!covered) {
        const missing = this.findUncoveredCells(chunk.coord.x, chunk.coord.z, chunk.lod, 5);
        stuck.push(
          `${keyToString(key)} lod=${chunk.lod} coord=(${chunk.coord.x},${chunk.coord.z}) ` +
          `worldDist=${worldDist.toFixed(0)} < minDist=${minDist.toFixed(0)}\n` +
          missing.map((m) => `  cell(${m.x},${m.z}) uncovered at LOD 0`).join('\n'),
        );
      }
    }

    if (stuck.length === 0) {
      console.log('[debug] No stuck coarse chunks near player.');
    } else {
      console.log(`[debug] ${stuck.length} stuck coarse chunk(s):\n${stuck.join('\n\n')}`);
    }
    console.log(`[debug] total chunks=${this.chunks.size} pending=${this.pendingChunks.size}`);
  }

  /** Find up to `limit` uncovered LOD-0 cells within a parent chunk's area (for debug) */
  private findUncoveredCells(
    cx: number, cz: number, parentLod: number, limit: number,
  ): { x: number; z: number }[] {
    const result: { x: number; z: number }[] = [];
    this.collectUncovered(cx, cz, parentLod, result, limit);
    return result;
  }

  private collectUncovered(
    cx: number, cz: number, lod: number,
    out: { x: number; z: number }[], limit: number,
  ): void {
    if (out.length >= limit) return;
    if (this.chunks.has(columnLodKey(cx, cz, lod))) return;
    if (lod === 0) { out.push({ x: cx, z: cz }); return; }
    const hx = cx * 2;
    const hz = cz * 2;
    for (let dx = 0; dx < 2; dx++) {
      for (let dz = 0; dz < 2; dz++) {
        this.collectUncovered(hx + dx, hz + dz, lod - 1, out, limit);
      }
    }
  }

  /** Query terrain height at a world position. Returns world Y or null if no chunk data covers this point. */
  queryHeight(worldX: number, worldZ: number): number | null {
    const { worldScale, chunkSize, lodLevels } = this.config;

    // Try LOD 0 first for best accuracy, fall back to coarser LODs
    for (let lod = 0; lod < lodLevels.length; lod++) {
      const lodScale = 1 << lod;
      const lodWorldScale = worldScale * lodScale;
      const voxelSize = lodWorldScale / chunkSize;

      const chunkX = Math.floor(worldX / lodWorldScale);
      const chunkZ = Math.floor(worldZ / lodWorldScale);
      const key = columnLodKey(chunkX, chunkZ, lod);

      const cached = this.chunkCache.get(key);
      if (!cached) continue;

      // Invert the worker's sample center formula:
      //   wx = chunkWorldOrigin + (lx + 0.5) * voxelSize
      const chunkWorldX = chunkX * lodWorldScale;
      const chunkWorldZ = chunkZ * lodWorldScale;
      const fx = (worldX - chunkWorldX) / voxelSize - 0.5;
      const fz = (worldZ - chunkWorldZ) / voxelSize - 0.5;

      // Bilinear interpolation sample positions
      const ix = Math.floor(fx);
      const iz = Math.floor(fz);
      const u = fx - ix;
      const v = fz - iz;

      const x0 = Math.max(0, Math.min(chunkSize - 1, ix));
      const x1 = Math.max(0, Math.min(chunkSize - 1, ix + 1));
      const z0 = Math.max(0, Math.min(chunkSize - 1, iz));
      const z1 = Math.max(0, Math.min(chunkSize - 1, iz + 1));

      // Read height values (R channel of interleaved RG data, stride 2)
      const h00 = cached.heightmap[(x0 + z0 * chunkSize) * 2];
      const h10 = cached.heightmap[(x1 + z0 * chunkSize) * 2];
      const h01 = cached.heightmap[(x0 + z1 * chunkSize) * 2];
      const h11 = cached.heightmap[(x1 + z1 * chunkSize) * 2];

      const voxelH = (1 - u) * (1 - v) * h00
                   + u * (1 - v) * h10
                   + (1 - u) * v * h01
                   + u * v * h11;

      return cached.minWorldY + voxelH * voxelSize;
    }

    return null;
  }

  dispose(): void {
    this.worker.terminate();
  }
}
