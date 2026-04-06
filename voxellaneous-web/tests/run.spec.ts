/**
 * Visual regression tests.
 *
 * For each scenario defined in tests/scenarios/*.ts, this spec:
 *  1. Navigates the harness to that scenario
 *  2. Waits for the renderer to finish settle frames
 *  3. Reads canvas pixels via toBlob() (reliable even with SwiftShader in CI)
 *  4. Compares against the reference image
 *
 * First run (no references):  npx playwright test --update-snapshots
 * Subsequent runs:            npx playwright test
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Auto-discover scenario names by parsing `name: '...'` from scenario files.
// Each file may export a single scenario or an array.
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scenariosDir = path.join(__dirname, 'scenarios');
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
    page.on('pageerror', (err) => {
      console.error(`[page error] ${err.message}`);
    });

    await page.goto(`/tests/harness/index.html?scenario=${name}`);

    // Wait for the harness to signal that all settle frames have rendered
    // and canvas pixels have been exported via toBlob()
    await page.waitForFunction(
      () => (window as unknown as Record<string, unknown>).__TEST_READY === true,
      null,
      { timeout: 30_000 },
    );

    // Read the canvas pixels exported by the harness via toBlob().
    // This is reliable even in CI where Playwright's compositor-based
    // screenshot captures blank white (SwiftShader doesn't composite).
    const dataUrl = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__TEST_SCREENSHOT as string,
    );

    const screenshot = Buffer.from(dataUrl.split(',')[1], 'base64');
    expect(screenshot).toMatchSnapshot(`${name}.png`, {
      maxDiffPixelRatio: process.env.CI ? 0.05 : 0.02,
    });
  });
}
