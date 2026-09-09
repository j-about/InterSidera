import { expect, test } from '@playwright/test';

import {
  BRIGHT_STAR,
  PROBE_FOV,
  altAzOf,
  appUrl,
  centrePatch,
  collectErrors,
  debugState,
  waitReady,
} from './support.ts';

// Night mode (UX-3, plan D108, D113): `night=0.6` marks the document, the star shader keeps the
// luminance in the red channel alone (green and blue exactly 0 in the shader, below 16 after the
// 8-bit quantisation of the probe), `night=0` renders Sirius white, and the level round-trips
// through the URL. The atmosphere is off (`appUrl`): the Sun is up at the probe instant.

const ENGINE = 'webgl2';

test.describe.configure({ timeout: 180_000 });

/** Centre Sirius at the probe field of view and wait for it to be lit. */
async function aimAtSirius(page: Parameters<typeof altAzOf>[0]): Promise<void> {
  const sirius = await altAzOf(page, BRIGHT_STAR);
  await page.evaluate(
    ({ az, alt, fov }) => {
      window.__sky?.setView(az, alt, fov);
    },
    { az: sirius.az, alt: sirius.alt, fov: PROBE_FOV },
  );
  await expect
    .poll(async () => (await centrePatch(page)).max, { timeout: 10_000 })
    .toBeGreaterThan(100);
}

test('night mode renders in red only, at the level the URL carries', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(appUrl(ENGINE, false).replace('#engine', '&night=0.6#engine'));
  await waitReady(page);

  await test.step('the document and the store carry the night level', async () => {
    expect(await page.evaluate(() => document.documentElement.dataset.mode ?? null)).toBe('night');
    const state = await debugState(page);
    expect(state.night).toBe(true);
    expect(state.nightLevel).toBeCloseTo(0.6, 6);
  });

  await test.step('Sirius is red: green and blue stay below 16', async () => {
    await aimAtSirius(page);
    const patch = await centrePatch(page);
    expect(patch.maxR).toBeGreaterThan(100);
    expect(patch.maxG).toBeLessThan(16);
    expect(patch.maxB).toBeLessThan(16);
  });

  await test.step('the URL keeps night=0.6 after a view change', async () => {
    await page.evaluate(() => {
      window.__sky?.setView(120, 30, 45);
    });
    await expect
      .poll(() => new URL(page.url()).searchParams.get('az'), { timeout: 3000 })
      .toBe('120');
    expect(new URL(page.url()).searchParams.get('night')).toBe('0.6');
  });

  await test.step('night=0 renders Sirius with a bright green channel', async () => {
    await page.goto(appUrl(ENGINE, false).replace('#engine', '&night=0#engine'));
    await waitReady(page);
    expect(await page.evaluate(() => document.documentElement.dataset.mode ?? null)).not.toBe(
      'night',
    );
    await aimAtSirius(page);
    const patch = await centrePatch(page);
    expect(patch.maxG).toBeGreaterThan(100);
  });

  expect(errors).toEqual([]);
});
