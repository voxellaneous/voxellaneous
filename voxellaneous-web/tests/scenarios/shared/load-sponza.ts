import { ByteArray } from '../../../src/common/types';
import { importFromArrayBuffer, createSceneFromResult } from '../../../src/converter';
import type { TestContext } from '../../harness/types';

/**
 * Fetches sponza.voxgz from the dev server, parses it, and uploads the
 * objects to the renderer.  The model is placed at the default origin
 * (bounding box spans roughly X[-512,0] Y[-512,0] Z[-512,0], with
 * occupied geometry in X[-512,-1] Y[-512,-299] Z[-512,-198]).
 */
export async function loadSponza(ctx: TestContext): Promise<void> {
  const response = await fetch('/resources/sponza.voxgz');
  if (!response.ok) throw new Error(`Failed to fetch sponza.voxgz: ${response.status}`);

  const compressed = new ByteArray(await response.arrayBuffer());
  const result = await importFromArrayBuffer(compressed, 'sponza.voxgz');
  const scene = createSceneFromResult(result);

  const objects = scene.objects.map((obj) => ({
    ...obj,
    palette: scene.palette,
  }));

  ctx.uploadStaticObjects(objects);
  ctx.uploadScene({ palette: [], objects: [], heightmapObjects: [] });
}
