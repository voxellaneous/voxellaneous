import { vec3 } from 'gl-matrix';
import type { TestScenario } from '../harness/types';
import { loadSponza } from './shared/load-sponza';

// Sponza world coords: X[-512,-1] Y[-512,-299] Z[-512,-198]

const scenarios: TestScenario[] = [
  {
    name: 'sponza-interior',
    width: 800,
    height: 600,
    settleFrames: 20,
    async setup(ctx) {
      await loadSponza(ctx);
      // Looking straight down the passage at the lion head on the far +X wall
      ctx.camera.position = vec3.fromValues(-150, -462, -355);
      ctx.camera.direction = vec3.normalize(vec3.create(), [1, 0, 0]);
      ctx.lighting.sunTime = 10;
      ctx.lighting.ambient = 0.4;
      ctx.lighting.sunIlluminance = 14;
    },
  },
  {
    name: 'sponza-entrance',
    width: 800,
    height: 600,
    settleFrames: 20,
    async setup(ctx) {
      await loadSponza(ctx);
      // Exterior 3/4 view: outside the corner, looking at two faces
      ctx.camera.position = vec3.fromValues(80, -350, -100);
      ctx.camera.direction = vec3.normalize(vec3.create(), [-1, -0.3, -0.8]);
      ctx.lighting.sunTime = 10;
      ctx.lighting.ambient = 0.2;
      ctx.lighting.sunIlluminance = 12;
    },
  },
  {
    name: 'sponza-above',
    width: 800,
    height: 600,
    settleFrames: 20,
    async setup(ctx) {
      await loadSponza(ctx);
      // Well above the roof, looking straight down at center
      ctx.camera.position = vec3.fromValues(-257, -100, -355);
      ctx.camera.direction = vec3.normalize(vec3.create(), [0.01, -1, 0.01]);
      ctx.lighting.sunTime = 12;
      ctx.lighting.ambient = 0.25;
      ctx.lighting.sunIlluminance = 14;
    },
  },
  {
    name: 'sponza-side',
    width: 800,
    height: 600,
    settleFrames: 20,
    async setup(ctx) {
      await loadSponza(ctx);
      // Near the +X wall, looking diagonally across and down the hall
      ctx.camera.position = vec3.fromValues(-100, -462, -355);
      ctx.camera.direction = vec3.normalize(vec3.create(), [-1, 0.1, -0.3]);
      ctx.lighting.sunTime = 8;
      ctx.lighting.ambient = 0.15;
      ctx.lighting.sunIlluminance = 10;
    },
  },
];

export default scenarios;
