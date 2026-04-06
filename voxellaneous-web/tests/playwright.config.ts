import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** The voxellaneous-web project root (one level up from tests/). */
const projectRoot = path.resolve(__dirname, '..');

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: '.',
  testMatch: 'run.spec.ts',

  /* Fail fast in CI — no retries by default. */
  retries: 0,
  /* Single worker: we only have one GPU and tests share the Vite server. */
  workers: 1,
  /* Per-test timeout — WebGPU init + terrain chunk gen can be slow. */
  timeout: 120_000,

  /* Artifact output directory (diffs, traces, etc.) */
  outputDir: './output',

  /* Store reference screenshots alongside the test. */
  snapshotPathTemplate: '{testDir}/references/{arg}{ext}',

  expect: {
    toHaveScreenshot: {
      /*
       * CI uses SwiftShader (software renderer) which produces slightly
       * different output than real GPUs.  Allow a generous threshold in CI
       * so tests catch real regressions without failing on driver differences.
       */
      maxDiffPixelRatio: isCI ? 0.05 : 0.01,
    },
  },

  use: {
    browserName: 'chromium',
    /* WebGPU requires headed Chromium (not the headless shell). */
    headless: false,
    launchOptions: {
      args: [
        '--enable-unsafe-webgpu',
        '--enable-features=Vulkan',
        /*
         * In CI (no physical GPU), use SwiftShader for software-rendered WebGPU.
         * Locally, use the real GPU.
         */
        ...(isCI
          ? ['--use-angle=swiftshader', '--use-gl=angle', '--disable-gpu-sandbox']
          : []),
      ],
    },
    /* No animations / transitions to wait for. */
    actionTimeout: 10_000,
  },

  webServer: {
    command: 'npx vite --port 5174',
    port: 5174,
    /* Vite must serve from the project root so /tests/harness/… URLs work. */
    cwd: projectRoot,
    /* Reuse a running dev server when iterating locally. */
    reuseExistingServer: !isCI,
  },
});
