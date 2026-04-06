import type { Renderer } from '../../src/renderer';
import type { Scene, VoxelObject } from '../../src/scene';
import type { vec3 } from 'gl-matrix';

/** Environment/lighting parameters that the test harness passes to render(). */
export interface LightingParams {
  sunTime: number;
  sunAngle: number;
  ambient: number;
  sunIlluminance: number;
  sunDiskScale: number;
  sunDiskSize: number;
  hazeDensity: number;
  fogDensity: number;
  fogFalloff: number;
  sunOccSpeed: number;
}

/** Context given to every scenario's setup() function. */
export interface TestContext {
  /** The initialized WebGPU renderer. */
  renderer: Renderer;
  /** Upload static voxel objects (persisted across frames). */
  uploadStaticObjects(objects: VoxelObject[]): void;
  /** Upload dynamic scene (re-uploaded every frame; usually empty for static tests). */
  uploadScene(scene: Scene): void;
  /** Camera position — mutate in place. */
  camera: {
    position: vec3;
    direction: vec3;
  };
  /** Lighting / environment — mutate in place. */
  lighting: LightingParams;
}

/** A self-contained visual test scenario. */
export interface TestScenario {
  /** Unique name (also used as the reference-screenshot filename). */
  name: string;
  /** Fixed canvas width in pixels. */
  width: number;
  /** Fixed canvas height in pixels. */
  height: number;
  /**
   * How many frames to render before capturing a screenshot.
   * Some GPU compute effects (sun occlusion, atmosphere LUTs) need several
   * frames to converge.  Defaults to 10 if omitted.
   */
  settleFrames?: number;
  /** Present target override: 0=Albedo, 1=Normal, 2=LinearZ, 3=Shadow, 4=Lit (default). */
  presentTarget?: number;
  /** Build the scene: place objects, configure camera & lighting. */
  setup(ctx: TestContext): void | Promise<void>;
}
