import { vec3 } from 'gl-matrix';
import { ChunkManager, ShadowClipmapManager } from '../../../src/terrain';
import { DESKTOP_QUALITY } from '../../../src/renderer/types';
import type { TestContext } from '../../harness/types';

/**
 * Initializes terrain at the given world XZ, waits for chunks to load,
 * uploads heightmaps + shadow clipmap, and returns the ground height
 * so the caller can position the camera.
 */
export async function loadTerrain(
  ctx: TestContext,
  worldX: number,
  worldZ: number,
): Promise<{ groundY: number; terrainManager: ChunkManager }> {
  // Match main app: full desktop LOD range for distant mountains
  const terrainManager = new ChunkManager(
    { lodLevels: DESKTOP_QUALITY.lodLevels },
    DESKTOP_QUALITY.maxPendingChunkRequests,
  );

  // Use high initial Y so all nearby chunks are queued
  const initPos = vec3.fromValues(worldX, 5000, worldZ);
  terrainManager.update(initPos);

  // Wait until the worker has finished ALL pending chunks.
  // update() queues work, getPendingCount() tracks in-flight requests.
  // We loop because one update() call may not queue everything at once
  // (capped by maxPendingRequests), so we keep calling update() until
  // nothing new is queued AND nothing is pending.
  await new Promise<void>((resolve) => {
    let stableFrames = 0;
    const poll = () => {
      terrainManager.update(initPos);
      if (terrainManager.getPendingCount() === 0 && terrainManager.getVisibleHeightmapChunks().length > 0) {
        stableFrames++;
        // Wait a few stable polls to be sure no new batches get queued
        if (stableFrames >= 3) {
          resolve();
          return;
        }
      } else {
        stableFrames = 0;
      }
      setTimeout(poll, 50);
    };
    setTimeout(poll, 100);
  });

  const groundY = terrainManager.queryHeight(worldX, worldZ) ?? 0;

  // Shadow clipmap
  const shadowClipmap = new ShadowClipmapManager(
    terrainManager.getChunkCache(),
    terrainManager.getConfig(),
  );
  shadowClipmap.update(worldX, worldZ, terrainManager.cacheGeneration);
  ctx.renderer.uploadShadowClipmap(shadowClipmap);

  // Upload heightmaps
  ctx.uploadScene({
    palette: [],
    objects: [],
    heightmapObjects: terrainManager.getVisibleHeightmapChunks(),
  });

  return { groundY, terrainManager };
}
