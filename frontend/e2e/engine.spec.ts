import { expect, test } from '@playwright/test';

import {
  appUrl,
  backendOf,
  collectErrors,
  collectForeignRequests,
  runSanityChecks,
  waitReady,
} from './support.ts';

// Rendering sanity checks on the WebGL2 backend through `window.__sky` (brief l.410, l.466;
// plan D89): Greenwich at a fixed instant, Polaris within 1 degree of the latitude, a planet
// within 1 arcmin of `/sky/altaz` with and without refraction, and pixel probes on both shaders.
// The backend is forced through the dev/e2e `#engine` hash so the run is deterministic on any
// runner (a SwiftShader WebGPU adapter would otherwise flip it).

const ENGINE = 'webgl2';

// A first frame under SwiftShader compiles the shaders and uploads the whole catalog.
test.describe.configure({ timeout: 180_000 });

for (const refraction of [false, true]) {
  test(`renders on ${ENGINE} and matches /sky/altaz with refraction ${refraction ? 'on' : 'off'}`, async ({
    page,
  }) => {
    const errors = collectErrors(page);
    const foreign = collectForeignRequests(page);
    await page.goto(appUrl(ENGINE, refraction));
    await waitReady(page);

    expect(await backendOf(page)).toBe(ENGINE);
    await runSanityChecks(page, refraction);

    expect(foreign).toEqual([]);
    expect(errors).toEqual([]);
  });
}
