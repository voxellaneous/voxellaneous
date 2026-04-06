/**
 * Visual regression tests.
 *
 * Modes:
 *   npm run test        — compare screenshots against references (local GPU)
 *   npm run test:update — accept current output as new references
 *   npm run test:ci     — smoke test: verify rendering works, save screenshots,
 *                         skip pixel comparison (SwiftShader can't render correctly)
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scenariosDir = path.join(__dirname, 'scenarios');
const smokeMode = !!process.env.SMOKE;

// In smoke mode, save screenshots here for the CI artifact upload
const ciScreenshotsDir = path.join(__dirname, 'ci-screenshots');
if (smokeMode) {
  fs.mkdirSync(ciScreenshotsDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Auto-discover scenario names by parsing `name: '...'` from scenario files.
// ---------------------------------------------------------------------------
const scenarioNames: string[] = [];
for (const file of fs.readdirSync(scenariosDir).filter((f: string) => f.endsWith('.ts'))) {
  const content = fs.readFileSync(path.join(scenariosDir, file), 'utf-8');
  for (const match of content.matchAll(/name:\s*'([^']+)'/g)) {
    scenarioNames.push(match[1]);
  }
}

// ---------------------------------------------------------------------------
// One test per scenario
// ---------------------------------------------------------------------------
for (const name of scenarioNames) {
  test(`visual: ${name}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => {
      errors.push(err.message);
      console.error(`[page error] ${err.message}`);
    });

    await page.goto(`/tests/harness/index.html?scenario=${name}`);

    // Wait for the harness to complete rendering
    await page.waitForFunction(
      () => (window as unknown as Record<string, unknown>).__TEST_READY === true,
      null,
      { timeout: 30_000 },
    );

    // Read canvas pixels exported by the harness via toBlob()
    const dataUrl = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__TEST_SCREENSHOT as string,
    );

    expect(dataUrl, 'harness should export canvas screenshot').toBeTruthy();
    const screenshot = Buffer.from(dataUrl.split(',')[1], 'base64');

    if (smokeMode) {
      // Smoke mode: save screenshot for manual review, skip comparison
      fs.writeFileSync(path.join(ciScreenshotsDir, `${name}.png`), screenshot);
      // Fail only on JS errors (WebGPU init failures, shader compile, etc.)
      expect(errors, 'no page errors during rendering').toEqual([]);
    } else {
      // Full mode: pixel comparison against reference
      expect(screenshot).toMatchSnapshot(`${name}.png`, {
        maxDiffPixelRatio: 0.02,
      });
    }
  });
}
