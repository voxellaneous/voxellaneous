import { columnLodKey } from './chunk-manager';
import type { WorkerResultMessage } from './terrain-worker';
import type { TerrainConfig } from './types';

/** Number of clipmap levels */
export const SHADOW_CLIPMAP_LEVELS = 4;
/** Resolution of each clipmap level (texels per side) */
export const SHADOW_CLIPMAP_SIZE = 512;
/** Texel size in world units per level */
const TEXEL_SIZES = [2, 8, 32, 128] as const;
/** Which LOD range to sample from for each clipmap level */
const LOD_RANGES: readonly [number, number][] = [
  [0, 1],
  [1, 3],
  [3, 5],
  [5, 8],
];
/** Sentinel value for "no data" — terrain here will never cast a shadow */
const NO_DATA = -1e6;
/** Rows to refill per level per frame during amortized background refresh */
const REFILL_ROWS_PER_FRAME = 8;

export class ShadowClipmapManager {
  /** CPU-side height data: 4 levels x 512*512 float32 */
  readonly levels: Float32Array[];
  /** Per-level world origin of texel (0,0), snapped to texel grid */
  readonly originX: number[];
  readonly originZ: number[];
  /** Per-level dirty flag for GPU upload */
  readonly dirty: boolean[];
  /** Last seen cache generation */
  private lastCacheGen = -1;
  /** Whether the initial full fill has happened */
  private initialized = false;
  /** Per-level row cursor for amortized refill; value >= SIZE means idle */
  private refillCursor: number[];

  private readonly chunkCache: ReadonlyMap<number, WorkerResultMessage>;
  private readonly config: Readonly<TerrainConfig>;

  constructor(
    chunkCache: ReadonlyMap<number, WorkerResultMessage>,
    config: Readonly<TerrainConfig>,
  ) {
    this.chunkCache = chunkCache;
    this.config = config;
    this.levels = [];
    this.originX = [];
    this.originZ = [];
    this.dirty = [];
    this.refillCursor = [];
    for (let i = 0; i < SHADOW_CLIPMAP_LEVELS; i++) {
      const arr = new Float32Array(SHADOW_CLIPMAP_SIZE * SHADOW_CLIPMAP_SIZE);
      arr.fill(NO_DATA);
      this.levels.push(arr);
      this.originX.push(0);
      this.originZ.push(0);
      this.dirty.push(true);
      this.refillCursor.push(SHADOW_CLIPMAP_SIZE); // idle
    }
  }

  /**
   * Per-frame update. Returns true if any level was modified (GPU upload needed).
   */
  update(camX: number, camZ: number, cacheGeneration: number): boolean {
    let anyDirty = false;

    // When new chunks arrive, kick off an amortized refill (small batch per frame)
    if (cacheGeneration !== this.lastCacheGen) {
      this.lastCacheGen = cacheGeneration;
      for (let i = 0; i < SHADOW_CLIPMAP_LEVELS; i++) {
        this.refillCursor[i] = 0;
      }
    }

    for (let level = 0; level < SHADOW_CLIPMAP_LEVELS; level++) {
      const texelSize = TEXEL_SIZES[level];
      const half = (SHADOW_CLIPMAP_SIZE / 2) * texelSize;

      // Ideal origin: camera centered, snapped to texel grid
      const idealX = Math.floor((camX - half) / texelSize) * texelSize;
      const idealZ = Math.floor((camZ - half) / texelSize) * texelSize;

      if (!this.initialized) {
        // First call: fill entire level (cache is mostly empty so this is fast)
        this.originX[level] = idealX;
        this.originZ[level] = idealZ;
        this.fillRegion(level, 0, 0, SHADOW_CLIPMAP_SIZE, SHADOW_CLIPMAP_SIZE);
        this.dirty[level] = true;
        anyDirty = true;
      } else {
        const prevX = this.originX[level];
        const prevZ = this.originZ[level];
        const shiftX = Math.round((idealX - prevX) / texelSize);
        const shiftZ = Math.round((idealZ - prevZ) / texelSize);

        if (Math.abs(shiftX) >= SHADOW_CLIPMAP_SIZE || Math.abs(shiftZ) >= SHADOW_CLIPMAP_SIZE) {
          // Teleport: full refill
          this.originX[level] = idealX;
          this.originZ[level] = idealZ;
          this.fillRegion(level, 0, 0, SHADOW_CLIPMAP_SIZE, SHADOW_CLIPMAP_SIZE);
          this.dirty[level] = true;
          anyDirty = true;
        } else if (shiftX !== 0 || shiftZ !== 0) {
          // Incremental toroidal update — edge strips only
          this.originX[level] = idealX;
          this.originZ[level] = idealZ;

          if (shiftX > 0) {
            const count = Math.min(shiftX, SHADOW_CLIPMAP_SIZE);
            this.fillRegion(level, SHADOW_CLIPMAP_SIZE - count, 0, count, SHADOW_CLIPMAP_SIZE);
          } else if (shiftX < 0) {
            const count = Math.min(-shiftX, SHADOW_CLIPMAP_SIZE);
            this.fillRegion(level, 0, 0, count, SHADOW_CLIPMAP_SIZE);
          }

          if (shiftZ > 0) {
            const count = Math.min(shiftZ, SHADOW_CLIPMAP_SIZE);
            this.fillRegion(level, 0, SHADOW_CLIPMAP_SIZE - count, SHADOW_CLIPMAP_SIZE, count);
          } else if (shiftZ < 0) {
            const count = Math.min(-shiftZ, SHADOW_CLIPMAP_SIZE);
            this.fillRegion(level, 0, 0, SHADOW_CLIPMAP_SIZE, count);
          }

          this.dirty[level] = true;
          anyDirty = true;
        }

        // Amortized background refill: process a few rows per frame
        // to pick up newly loaded chunk data without frame spikes
        if (this.refillCursor[level] < SHADOW_CLIPMAP_SIZE) {
          const start = this.refillCursor[level];
          const rows = Math.min(REFILL_ROWS_PER_FRAME, SHADOW_CLIPMAP_SIZE - start);
          this.fillRegion(level, 0, start, SHADOW_CLIPMAP_SIZE, rows);
          this.refillCursor[level] += rows;
          this.dirty[level] = true;
          anyDirty = true;
        }
      }
    }

    this.initialized = true;
    return anyDirty;
  }

  /**
   * Fill a rectangle of texels in the CPU array from chunk cache data.
   * texelX/texelZ are in [0, SHADOW_CLIPMAP_SIZE) and represent logical positions;
   * the actual array index wraps toroidally.
   */
  private fillRegion(level: number, texelX: number, texelZ: number, w: number, h: number): void {
    const data = this.levels[level];
    const texelSize = TEXEL_SIZES[level];
    const ox = this.originX[level];
    const oz = this.originZ[level];
    const { chunkSize, worldScale } = this.config;
    const [lodMin, lodMax] = LOD_RANGES[level];

    for (let dz = 0; dz < h; dz++) {
      const tz = texelZ + dz;
      const worldZ0 = oz + tz * texelSize;
      // Absolute addressing: array index from world position, NOT from origin-relative offset
      const absZ = Math.floor(worldZ0 / texelSize);
      const wrapZ = ((absZ % SHADOW_CLIPMAP_SIZE) + SHADOW_CLIPMAP_SIZE) % SHADOW_CLIPMAP_SIZE;

      for (let dx = 0; dx < w; dx++) {
        const tx = texelX + dx;
        const worldX0 = ox + tx * texelSize;
        const absX = Math.floor(worldX0 / texelSize);
        const wrapX = ((absX % SHADOW_CLIPMAP_SIZE) + SHADOW_CLIPMAP_SIZE) % SHADOW_CLIPMAP_SIZE;

        // Sample max height across all LODs in range for this texel footprint
        let maxH = NO_DATA;

        for (let lod = lodMin; lod <= lodMax; lod++) {
          const lodScale = 1 << lod;
          const lodWorldScale = worldScale * lodScale;
          const voxelSize = lodWorldScale / chunkSize;

          // Which chunk(s) does this texel overlap?
          const cxMin = Math.floor(worldX0 / lodWorldScale);
          const cxMax = Math.floor((worldX0 + texelSize - 0.001) / lodWorldScale);
          const czMin = Math.floor(worldZ0 / lodWorldScale);
          const czMax = Math.floor((worldZ0 + texelSize - 0.001) / lodWorldScale);

          for (let cx = cxMin; cx <= cxMax; cx++) {
            for (let cz = czMin; cz <= czMax; cz++) {
              const key = columnLodKey(cx, cz, lod);
              const cached = this.chunkCache.get(key);
              if (!cached) continue;

              const chunkWorldX = cx * lodWorldScale;
              const chunkWorldZ = cz * lodWorldScale;

              // Sample heightmap voxels that fall within the texel footprint
              const lxMin = Math.max(0, Math.floor((worldX0 - chunkWorldX) / voxelSize));
              const lxMax = Math.min(chunkSize - 1, Math.floor((worldX0 + texelSize - chunkWorldX) / voxelSize));
              const lzMin = Math.max(0, Math.floor((worldZ0 - chunkWorldZ) / voxelSize));
              const lzMax = Math.min(chunkSize - 1, Math.floor((worldZ0 + texelSize - chunkWorldZ) / voxelSize));

              for (let lx = lxMin; lx <= lxMax; lx++) {
                for (let lz = lzMin; lz <= lzMax; lz++) {
                  const worldH = cached.floatHeights[lx + lz * chunkSize];
                  if (worldH > maxH) maxH = worldH;
                }
              }
            }
          }
        }

        data[wrapX + wrapZ * SHADOW_CLIPMAP_SIZE] = maxH;
      }
    }
  }
}
