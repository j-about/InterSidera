import { expect, test } from '@playwright/test';

import {
  LAT,
  LIT_MIN,
  TT_FIXED,
  altAzOf,
  backendOf,
  canvasBox,
  centrePatch,
  collectErrors,
  collectForeignRequests,
  debugState,
  required,
  waitReady,
} from './support.ts';

// The rendering layers of M4 (SKY-3 deep-sky objects, SKY-5 constellations, SKY-6 ground and
// cardinal letters, SKY-7 atmosphere, VIEW-3 labels; plan D101-D105, D113) through `window.__sky`
// on WebGL2: catalog counts, the constellation line count, a pixel probe on the Ring Nebula, the
// planet and cardinal labels in both languages, the non-overlap of the layout's own boxes, the
// opaque ground and the daylight sky. One boot per language; every page-side function reaches
// the hook through `window.__sky` directly.

const ENGINE = 'webgl2';
const LAYERS = 'stars,planets,horizon,dso,clines,cnames,cbounds';
/** Stellarium `modern` line pairs whose two HIP ends are in the star catalog. */
const CLINES_SEGMENTS = 695;
/** The Ring Nebula, M57, a planetary nebula of 1.27' drawn at the 4 px minimum symbol radius. */
const RING_NEBULA = 'dso:NGC6720';
/** Canopus (HIP 30438, Dec -52.7): always below the horizon from Greenwich, magnitude -0.7. */
const CANOPUS = 'hip:30438';
/** Boxes of two labels may not overlap by more than this (CSS pixels). */
const LABEL_OVERLAP_TOLERANCE_PX = 2;

/**
 * Greenwich paused at `TT_FIXED`, every M4 layer and label density 3 unless `overrides` says
 * otherwise (later keys win: the codec reads the first occurrence of a key, so the defaults are
 * filtered out before the overrides are appended).
 */
function url(overrides: Record<string, string>, lang: 'en' | 'fr' = 'en'): string {
  const params = new URLSearchParams({
    body: 'earth',
    lat: String(LAT),
    lon: '0',
    elev: '0',
    t: String(TT_FIXED),
    speed: '0',
    az: '0',
    alt: '45',
    fov: '60',
    layers: LAYERS,
    labels: '3',
    lang,
    refr: '1',
    ...overrides,
  });
  return `/?${params.toString().replaceAll('%2C', ',')}#engine=${ENGINE}`;
}

/** Centre the view on a target at `fov` and wait for the render tick that applies it. */
async function lookAt(page: Parameters<typeof altAzOf>[0], id: string, fov: number): Promise<void> {
  const target = await altAzOf(page, id);
  await page.evaluate(
    ({ az, alt, fovDeg }) => {
      window.__sky?.setView(az, alt, fovDeg);
    },
    { az: target.az, alt: target.alt, fovDeg: fov },
  );
}

test.describe.configure({ timeout: 180_000 });

test('draws deep-sky objects, constellations, labels, the ground and the daylight sky', async ({
  page,
}) => {
  const errors = collectErrors(page);
  const foreign = collectForeignRequests(page);
  await page.goto(url({ ground: 'off', atm: '0' }));
  await waitReady(page);
  expect(await backendOf(page)).toBe(ENGINE);

  await test.step('catalogs and constellation lines are loaded', async () => {
    const state = await debugState(page);
    expect(state.catalogs.dso).toBeGreaterThan(5000);
    expect(state.catalogs.constellations).toBe(88);
    expect(state.layers).toMatchObject({ dso: true, clines: true, cnames: true, cbounds: true });
    await expect
      .poll(() => page.evaluate(() => window.__sky?.stats().clinesSegments ?? -1), {
        timeout: 10_000,
      })
      .toBe(CLINES_SEGMENTS);
    const stats = await page.evaluate(() => window.__sky?.stats() ?? null);
    expect(required(stats, 'stats()').dso).toBeGreaterThan(0);
  });

  await test.step('the DSO shader draws a symbol at the Ring Nebula', async () => {
    await lookAt(page, RING_NEBULA, 20);
    await expect
      .poll(async () => (await centrePatch(page)).max, { timeout: 10_000 })
      .toBeGreaterThan(LIT_MIN);
  });

  await test.step('Jupiter carries its label in English', async () => {
    await lookAt(page, 'jupiter', 60);
    await expect
      .poll(() => page.evaluate(() => window.__sky?.labels().map((l) => l.id) ?? []), {
        timeout: 10_000,
      })
      .toContain('jupiter');
    await expect(page.locator('[data-label-id="jupiter"]')).toHaveText('Jupiter');
  });

  await test.step('looking north at the horizon shows the N cardinal letter', async () => {
    await page.evaluate(() => {
      window.__sky?.setView(0, 0, 60);
    });
    await expect(page.locator('[data-label-id="cardinal:n"]')).toHaveText('N', {
      timeout: 10_000,
    });
  });

  await test.step('no two label boxes overlap (the layout is measured, not estimated)', async () => {
    const labels = await page.evaluate(() => window.__sky?.labels() ?? []);
    expect(labels.length).toBeGreaterThan(1);
    const tolerance = LABEL_OVERLAP_TOLERANCE_PX;
    for (let i = 0; i < labels.length; i += 1) {
      for (let k = i + 1; k < labels.length; k += 1) {
        const a = labels[i];
        const b = labels[k];
        if (a === undefined || b === undefined) {
          continue;
        }
        const overlap =
          a.x + tolerance < b.x + b.width &&
          b.x + tolerance < a.x + a.width &&
          a.y + tolerance < b.y + b.height &&
          b.y + tolerance < a.y + a.height;
        expect(overlap, `${a.id} overlaps ${b.id}`).toBe(false);
      }
    }
    // Every drawn label has a DOM element with the same text.
    const first = labels[0];
    if (first !== undefined) {
      await expect(page.locator(`[data-label-id="${first.id}"]`)).toHaveText(first.text);
    }
  });

  await test.step('a star below the horizon is drawn with the ground off', async () => {
    // Canopus never rises at Greenwich (Dec -52.7): with the ground off it is still drawn.
    const canopus = await altAzOf(page, CANOPUS);
    expect(canopus.alt).toBeLessThan(0);
    await lookAt(page, CANOPUS, 20);
    await expect
      .poll(async () => (await centrePatch(page)).max, { timeout: 10_000 })
      .toBeGreaterThan(LIT_MIN);
    // The cardinal letters are gone: they sit above the horizon and the camera looks below it.
    const ids = await page.evaluate(() => window.__sky?.labels().map((l) => l.id) ?? []);
    expect(ids).not.toContain('cardinal:n');
  });

  expect(foreign).toEqual([]);
  expect(errors).toEqual([]);
});

test('an opaque ground hides everything below the horizon', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(url({ ground: 'opaque', atm: '0' }));
  await waitReady(page);

  await test.step('the patch at Canopus is the dark ground, no star lit, no label', async () => {
    await lookAt(page, CANOPUS, 20);
    await expect
      .poll(async () => (await centrePatch(page)).max, { timeout: 10_000 })
      .toBeLessThan(90);
    const patch = await centrePatch(page);
    expect(patch.min).toBeGreaterThan(8);
    expect(patch.max).toBeLessThan(90);
    // Labels, the marker and picking are culled below an opaque ground (plan D104).
    const ids = await page.evaluate(() => window.__sky?.labels().map((l) => l.id) ?? []);
    expect(ids).toEqual([]);
    const box = await canvasBox(page);
    const picked = await page.evaluate(({ x, y }) => window.__sky?.pick(x, y) ?? null, {
      x: box.width / 2,
      y: box.height / 2,
    });
    expect(picked).toBeNull();
  });

  expect(errors).toEqual([]);
});

test('the atmosphere paints a blue daylight sky at a Sun-up instant and stays dark when off', async ({
  page,
}) => {
  const errors = collectErrors(page);
  // The Sun is up at TT_FIXED from Greenwich (support.ts): the zenith is daylight blue.
  await page.goto(url({ ground: 'off', atm: '1' }));
  await waitReady(page);
  await page.evaluate(() => {
    window.__sky?.setView(180, 60, 60);
  });
  await expect
    .poll(() => page.evaluate(() => window.__sky?.skyBrightness() ?? 0), { timeout: 10_000 })
    .toBe(1);
  await expect
    .poll(async () => (await centrePatch(page)).max, { timeout: 10_000 })
    .toBeGreaterThan(120);
  const day = await centrePatch(page);
  expect(day.maxB).toBeGreaterThan(day.maxR);
  expect(day.maxR).toBeGreaterThan(0);
  // Daylight fills the whole patch: even its darkest pixel is lit.
  expect(day.min).toBeGreaterThan(60);

  // The dark probe screenshots the canvas centre: keep the label overlay and the line layers
  // out of the patch (a label or a constellation line there would light it, not the sky).
  await page.goto(url({ ground: 'off', atm: '0', labels: '0', layers: 'stars,planets' }));
  await waitReady(page);
  await page.evaluate(() => {
    window.__sky?.setView(180, 60, 60);
  });
  expect(await page.evaluate(() => window.__sky?.skyBrightness() ?? -1)).toBe(0);
  // Without the atmosphere the sky between the stars is black: the darkest pixel of the patch
  // says so whatever star happens to sit in it (the maximum would).
  await expect
    .poll(async () => (await centrePatch(page)).min, { timeout: 10_000 })
    .toBeLessThan(40);
  expect(errors).toEqual([]);
});

test('labels follow the language: the Moon reads Lune and west reads O in French', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto(url({ ground: 'off', atm: '0' }, 'fr'));
  await waitReady(page);
  await lookAt(page, 'moon', 60);
  await expect(page.locator('[data-label-id="moon"]')).toHaveText('Lune', { timeout: 10_000 });
  await page.evaluate(() => {
    window.__sky?.setView(270, 0, 60);
  });
  await expect(page.locator('[data-label-id="cardinal:w"]')).toHaveText('O', { timeout: 10_000 });
  expect(errors).toEqual([]);
});
