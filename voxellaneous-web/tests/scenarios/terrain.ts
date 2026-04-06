import { vec3 } from 'gl-matrix';
import type { TestScenario } from '../harness/types';
import { loadTerrain } from './shared/load-terrain';

const scenarios: TestScenario[] = [
  {
    name: 'terrain',
    width: 800,
    height: 600,
    settleFrames: 20,
    async setup(ctx) {
      const { groundY } = await loadTerrain(ctx, 0, 0);
      ctx.camera.position = vec3.fromValues(0, groundY + 30, 0);
      ctx.camera.direction = vec3.normalize(vec3.create(), [1, -0.35, 1]);
      ctx.lighting.sunTime = 10;
      ctx.lighting.ambient = 0.3;
      ctx.lighting.sunIlluminance = 14;
      ctx.lighting.hazeDensity = 0.0001;
      ctx.lighting.fogDensity = 0;
    },
  },
  {
    name: 'terrain-above',
    width: 800,
    height: 600,
    settleFrames: 20,
    async setup(ctx) {
      const { groundY } = await loadTerrain(ctx, 0, 0);
      ctx.camera.position = vec3.fromValues(0, groundY + 300, 0);
      ctx.camera.direction = vec3.normalize(vec3.create(), [0.01, -1, 0.01]);
      ctx.lighting.sunTime = 11;
      ctx.lighting.ambient = 0.3;
      ctx.lighting.sunIlluminance = 14;
      ctx.lighting.hazeDensity = 0;
      ctx.lighting.fogDensity = 0;
    },
  },
  {
    name: 'terrain-biomes',
    width: 800,
    height: 600,
    settleFrames: 20,
    async setup(ctx) {
      // ~50k units from origin: crosses multiple biome periods for color variation
      const wx = 50000, wz = 30000;
      const { groundY } = await loadTerrain(ctx, wx, wz);
      ctx.camera.position = vec3.fromValues(wx, groundY + 30, wz);
      ctx.camera.direction = vec3.normalize(vec3.create(), [-0.5, -0.35, 1]);
      ctx.lighting.sunTime = 10;
      ctx.lighting.ambient = 0.3;
      ctx.lighting.sunIlluminance = 14;
      ctx.lighting.hazeDensity = 0.0001;
      ctx.lighting.fogDensity = 0;
    },
  },
  {
    name: 'terrain-sunset',
    width: 800,
    height: 600,
    settleFrames: 20,
    async setup(ctx) {
      const { groundY } = await loadTerrain(ctx, 5000, 5000);
      ctx.camera.position = vec3.fromValues(5000, groundY + 30, 5000);
      ctx.camera.direction = vec3.normalize(vec3.create(), [1, -0.25, 0.3]);
      ctx.lighting.sunTime = 17; // golden hour
      ctx.lighting.ambient = 0.2;
      ctx.lighting.sunIlluminance = 10;
      ctx.lighting.hazeDensity = 0.0002;
      ctx.lighting.fogDensity = 0;
    },
  },
  {
    name: 'terrain-shadow',
    width: 800,
    height: 600,
    settleFrames: 20,
    presentTarget: 3, // Shadow buffer — for debugging cascade seams
    async setup(ctx) {
      const { groundY } = await loadTerrain(ctx, 0, 0);
      ctx.camera.position = vec3.fromValues(0, groundY + 8, 0);
      ctx.camera.direction = vec3.normalize(vec3.create(), [0.5, -0.15, 0.85]);
      ctx.lighting.sunTime = 10;
      ctx.lighting.ambient = 0.3;
      ctx.lighting.sunIlluminance = 14;
      ctx.lighting.hazeDensity = 0;
      ctx.lighting.fogDensity = 0;
    },
  },
];

export default scenarios;
