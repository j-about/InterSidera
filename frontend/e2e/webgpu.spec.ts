import { expect, test } from '@playwright/test';

import {
  appUrl,
  backendOf,
  collectErrors,
  collectForeignRequests,
  runSanityChecks,
  waitReady,
} from './support.ts';

// The WebGPU twin of engine.spec.ts (brief l.407 "tested on both engines", l.540; plan D89):
// only the `chromium-webgpu` project runs this file (full Chromium, `--enable-unsafe-webgpu`).
// The backend assertion is hard: a silent fallback to WebGL2 would leave the WGSL shaders
// untested, which is exactly what this spec exists to catch.

const ENGINE = 'webgpu';

// SwiftShader's WebGPU adapter compiles the WGSL pipelines slowly.
test.describe.configure({ timeout: 240_000 });

for (const refraction of [false, true]) {
  test(`renders on ${ENGINE} and matches /sky/altaz with refraction ${refraction ? 'on' : 'off'}`, async ({
    page,
  }) => {
    const errors = collectErrors(page);
    const foreign = collectForeignRequests(page);
    await page.goto(appUrl(ENGINE, refraction));
    await waitReady(page, 180_000);

    // Hard: the override asks for WebGPU and the project's Chromium must provide it.
    expect(await backendOf(page)).toBe(ENGINE);
    // Recorded, not asserted: SwiftShader's fallback adapter reports no `GPUAdapterInfo` through
    // `requestAdapter({ powerPreference: 'high-performance' })` (docs/testing.md).
    const adapter = await page.evaluate(() => window.__sky?.adapterInfo ?? null);
    test.info().annotations.push({ type: 'adapter', description: JSON.stringify(adapter) });

    await runSanityChecks(page, refraction);

    expect(foreign).toEqual([]);
    expect(errors).toEqual([]);
  });
}
