/**
 * Visual-test harness entry point.
 *
 * Usage: navigate to  /tests/harness/index.html?scenario=cornell-box
 *
 * The harness:
 *  1. Creates a fixed-size canvas
 *  2. Boots the Renderer (no network / terrain / editor)
 *  3. Loads and executes the requested TestScenario
 *  4. Renders `settleFrames` frames so GPU compute effects converge
 *  5. Sets  window.__TEST_READY = true  so Playwright can screenshot
 */

import { Renderer } from '../../src/renderer';
import { CameraModule } from '../../src/camera';
import { DESKTOP_QUALITY } from '../../src/renderer/types';
import { vec3 } from 'gl-matrix';
import type { TestScenario, TestContext, LightingParams } from './types';
import type { Scene, VoxelObject } from '../../src/scene';

// ---------------------------------------------------------------------------
// Scenario discovery (Vite glob import — eager so they're available sync)
// Each module exports either a single TestScenario or TestScenario[].
// ---------------------------------------------------------------------------
const scenarioModules = import.meta.glob('../scenarios/*.ts', { eager: true }) as Record<
  string,
  { default: TestScenario | TestScenario[] }
>;

/** Flatten all modules into a name → scenario map. */
const allScenarios = new Map<string, TestScenario>();
for (const mod of Object.values(scenarioModules)) {
  const entries = Array.isArray(mod.default) ? mod.default : [mod.default];
  for (const s of entries) allScenarios.set(s.name, s);
}

// ---------------------------------------------------------------------------
// Sun direction from time-of-day + azimuth (same math as main.ts)
// ---------------------------------------------------------------------------
function computeSunDirection(sunTime: number, sunAngle: number, out: Float32Array): void {
  const tilt = (75 * Math.PI) / 180;
  const phase = ((sunTime - 6) / 24) * 2 * Math.PI;
  const sx = Math.cos(phase);
  const sy = Math.sin(phase) * Math.sin(tilt);
  const sz = -Math.sin(phase) * Math.cos(tilt);
  const azimRad = (sunAngle * Math.PI) / 180;
  out[0] = sx * Math.cos(azimRad) + sz * Math.sin(azimRad);
  out[1] = sy;
  out[2] = -sx * Math.sin(azimRad) + sz * Math.cos(azimRad);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
async function run(): Promise<void> {
  const errorDiv = document.getElementById('error')!;

  // --- Parse URL ---------------------------------------------------------
  const params = new URLSearchParams(window.location.search);
  const scenarioName = params.get('scenario');
  if (!scenarioName) {
    errorDiv.textContent = 'Missing ?scenario= query parameter';
    return;
  }

  const scenario = allScenarios.get(scenarioName);
  if (!scenario) {
    const available = [...allScenarios.keys()].join(', ');
    errorDiv.textContent = `Unknown scenario "${scenarioName}". Available: ${available}`;
    return;
  }

  // --- Canvas & Renderer -------------------------------------------------
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  canvas.width = scenario.width;
  canvas.height = scenario.height;
  canvas.style.width = `${scenario.width}px`;
  canvas.style.height = `${scenario.height}px`;

  const renderer = await Renderer.new(canvas, DESKTOP_QUALITY);

  // --- Camera (headless-safe: event listeners exist but never fire) -------
  const cameraModule = new CameraModule(canvas);

  // --- Lighting defaults --------------------------------------------------
  const lighting: LightingParams = {
    sunTime: 10,
    sunAngle: 260,
    ambient: 0.15,
    sunIlluminance: 10,
    sunDiskScale: 0.8,
    sunDiskSize: 2,
    hazeDensity: 0.0004,
    fogDensity: 0,
    fogFalloff: 0.01,
    sunOccSpeed: 0.5,
  };

  // --- Build TestContext ---------------------------------------------------
  const ctx: TestContext = {
    renderer,
    uploadStaticObjects(objects: VoxelObject[]) {
      renderer.uploadStaticObjects(objects, []);
    },
    uploadScene(scene: Scene) {
      renderer.uploadScene(scene);
    },
    camera: {
      get position() {
        return cameraModule.position;
      },
      set position(v: vec3) {
        cameraModule.setPosition(v);
      },
      get direction() {
        return cameraModule.direction;
      },
      set direction(v: vec3) {
        cameraModule.setDirection(v);
      },
    },
    lighting,
  };

  // --- Run scenario setup -------------------------------------------------
  await scenario.setup(ctx);

  // --- Render settle frames -----------------------------------------------
  const presentTarget = scenario.presentTarget ?? 4;
  const settleFrames = scenario.settleFrames ?? 10;
  const lightDir = new Float32Array(3);

  function renderOneFrame(): void {
    computeSunDirection(lighting.sunTime, lighting.sunAngle, lightDir);

    const mvp = cameraModule.calculateMVP();
    const { inverseView, inverseProjection } = cameraModule.getCameraMatrices();

    renderer.render(
      new Float32Array(mvp),
      new Float32Array(cameraModule.position),
      presentTarget,
      lightDir,
      lighting.ambient,
      false, // showBboxes
      new Float32Array(inverseView),
      new Float32Array(inverseProjection),
      lighting.sunIlluminance,
      lighting.sunDiskScale,
      lighting.sunDiskSize,
      lighting.hazeDensity,
      lighting.fogDensity,
      lighting.fogFalloff,
      1 / 60, // dt
      lighting.sunOccSpeed,
    );
  }

  let framesRendered = 0;

  function loop(): void {
    renderOneFrame();
    framesRendered++;

    if (framesRendered < settleFrames) {
      requestAnimationFrame(loop);
    } else {
      // Signal Playwright that the canvas is ready for a screenshot
      (window as unknown as Record<string, unknown>).__TEST_READY = true;
      console.log(`[test-harness] scenario "${scenarioName}" ready after ${framesRendered} frames`);
    }
  }

  requestAnimationFrame(loop);
}

run().catch((err) => {
  console.error('[test-harness]', err);
  const errorDiv = document.getElementById('error');
  if (errorDiv) errorDiv.textContent = String(err);
});
