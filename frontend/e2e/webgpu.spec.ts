import { expect, test } from './fixtures.ts';

import {
  BRIGHT_STAR,
  LAT,
  LIT_MIN,
  PROBE_FOV,
  TT_FIXED,
  altAzOf,
  appUrl,
  backendOf,
  centrePatch,
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

// The M4 shader twins on WebGPU (plan D101, D108, D113): the WGSL deep-sky shader draws a symbol
// at the Ring Nebula and the WGSL night path keeps Sirius red alone. Both mirror the WebGL2
// probes of layers.spec.ts and night.spec.ts, so a divergence between the twins shows up here.

test(`draws a deep-sky symbol on ${ENGINE}`, async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(
    `/?body=earth&lat=${String(LAT)}&lon=0&elev=0&t=${String(TT_FIXED)}&speed=0&az=0&alt=45&fov=60` +
      `&layers=stars,planets,horizon,dso,clines&ground=off&atm=0&refr=1#engine=${ENGINE}`,
  );
  await waitReady(page, 180_000);
  expect(await backendOf(page)).toBe(ENGINE);
  const ring = await altAzOf(page, 'dso:NGC6720');
  await page.evaluate(
    ({ az, alt }) => {
      window.__sky?.setView(az, alt, 20);
    },
    { az: ring.az, alt: ring.alt },
  );
  await expect
    .poll(async () => (await centrePatch(page)).max, { timeout: 10_000 })
    .toBeGreaterThan(LIT_MIN);
  expect(await page.evaluate(() => window.__sky?.stats().clinesSegments ?? 0)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test(`renders night mode in red only on ${ENGINE}`, async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(appUrl(ENGINE, false).replace('#engine', '&night=0.6#engine'));
  await waitReady(page, 180_000);
  expect(await backendOf(page)).toBe(ENGINE);
  const sirius = await altAzOf(page, BRIGHT_STAR);
  await page.evaluate(
    ({ az, alt, fov }) => {
      window.__sky?.setView(az, alt, fov);
    },
    { az: sirius.az, alt: sirius.alt, fov: PROBE_FOV },
  );
  await expect
    .poll(async () => (await centrePatch(page)).maxR, { timeout: 10_000 })
    .toBeGreaterThan(100);
  const patch = await centrePatch(page);
  expect(patch.maxG).toBeLessThan(16);
  expect(patch.maxB).toBeLessThan(16);
  expect(errors).toEqual([]);
});
