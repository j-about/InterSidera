import { expect, test } from './fixtures.ts';
import type { Page, Route } from '@playwright/test';

import {
  LAT,
  LIT_MIN,
  TT_FIXED,
  afterFrames,
  altAzOf,
  backendOf,
  canvasBox,
  centrePatch,
  collectErrors,
  debugState,
  metaOf,
  openTab,
  required,
  waitReady,
} from './support.ts';

// The rendering layers of M4 (SKY-3 deep-sky objects, SKY-5 constellations, SKY-6 ground and
// cardinal letters, SKY-7 atmosphere, VIEW-3 labels; plan D101-D105, D113) through `window.__sky`
// on WebGL2: catalog counts, the constellation line and boundary chord counts, a pixel probe on
// the Ring Nebula, the planet and cardinal labels in both languages, the non-overlap of the
// layout's own boxes, the opaque ground and the daylight sky; since M6 (plan D163) the DSO type
// filter (`dso=galaxy`), the manual magnitude limit (`maglim=3`), the translucent ground
// (`ground=dim`, a pixel probe between the opaque and off values) and E3, the missing minor-body
// group (UX-6: the layer switch disabled with its reason, no `minor=` request; a `/sky/frame` 503
// with `Retry-After: 60` blocks the shape without a retry). One boot per scenario; every
// page-side function reaches the hook through `window.__sky` directly.

const ENGINE = 'webgl2';
const LAYERS = 'stars,planets,horizon,dso,clines,cnames,cbounds';
/** Stellarium `modern` line pairs whose two HIP ends are in the star catalog. */
const CLINES_SEGMENTS = 695;
/** The IAU boundaries: every ring's point count minus one, drawn as chords (plan D163). */
const CBOUNDS_SEGMENTS = 1570;
/** The Ring Nebula, M57, a planetary nebula of 1.27' drawn at the 4 px minimum symbol radius. */
const RING_NEBULA = 'dso:NGC6720';
/** Canopus (HIP 30438, Dec -52.7): always below the horizon from Greenwich, magnitude -0.7. */
const CANOPUS = 'hip:30438';
/** Sirius, magnitude -1.4: drawn and pickable under any magnitude limit. */
const SIRIUS = 'hip:32349';
/** Delta Geminorum (Wasat), V = 3.50: above the horizon at `TT_FIXED`, culled by `maglim=3`. */
const WASAT = 'hip:35550';
/** Boxes of two labels may not overlap by more than this (CSS pixels). */
const LABEL_OVERLAP_TOLERANCE_PX = 2;
/** The dimmed patch must sit at least this far from both the opaque and the off values. */
const DIM_MARGIN = 5;
const FRAME_ROUTE = '**/api/v1/sky/frame*';
/** Chromium's own console line for a request answered with an error status. */
const RESOURCE_LINE = 'Failed to load resource';

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

async function statsOf(page: Page): Promise<ReturnType<NonNullable<Window['__sky']>['stats']>> {
  return required(await page.evaluate(() => window.__sky?.stats() ?? null), 'stats()');
}

/** The object under the canvas centre after the view settled (two rendered frames). */
async function pickCentre(page: Page): Promise<string | null> {
  await afterFrames(page, 2);
  const box = await canvasBox(page);
  return page.evaluate(({ x, y }) => window.__sky?.pick(x, y) ?? null, {
    x: box.width / 2,
    y: box.height / 2,
  });
}

/** Every `/api/v1/sky/frame` request URL the page issues. */
function collectFrameRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/sky/frame')) {
      urls.push(request.url());
    }
  });
  return urls;
}

/** An RFC 9457 problem answer the E3 frame route serves for a missing data group. */
function dataNotReady(): Parameters<Route['fulfill']>[0] {
  return {
    status: 503,
    headers: { 'Retry-After': '60' },
    contentType: 'application/problem+json',
    body: JSON.stringify({
      type: 'https://github.com/j-about/InterSidera/blob/master/docs/api.md#problem-data-not-ready',
      title: 'Data not ready',
      status: 503,
      detail: 'minor-body data is missing on this server (test route)',
    }),
  };
}

test.describe.configure({ timeout: 180_000 });

test('draws deep-sky objects, constellations, labels, the ground and the daylight sky', async ({
  page,
}) => {
  const errors = collectErrors(page);
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
    const stats = await statsOf(page);
    expect(stats.dso).toBeGreaterThan(0);
    // The boundary layer draws every IAU edge as chords (the pixel probe of docs/testing.md l.78
    // is replaced by the layer's own count, plan D163).
    expect(stats.cboundsSegments).toBe(CBOUNDS_SEGMENTS);
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
  // The constellation layers are off (nothing of theirs reaches the patch). Their two counters
  // are catalog counts that stand whatever the flags (the catalog loads at boot), so the flags
  // are the evidence here, not `stats().clinesSegments` / `cboundsSegments`.
  expect((await debugState(page)).layers).toMatchObject({
    clines: false,
    cbounds: false,
    cnames: false,
    dso: false,
  });
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

test('the DSO type filter, the manual magnitude limit and the translucent ground', async ({
  page,
}) => {
  const errors = collectErrors(page);

  await test.step('dso=galaxy draws fewer deep-sky objects than every type, and some', async () => {
    await page.goto(url({ ground: 'off', atm: '0', dso: 'galaxy' }));
    await waitReady(page);
    expect((await debugState(page)).layers.dso).toBe(true);
    const galaxies = (await statsOf(page)).dso;
    expect(galaxies).toBeGreaterThan(0);
    await page.goto(url({ ground: 'off', atm: '0' }));
    await waitReady(page);
    const all = (await statsOf(page)).dso;
    expect(all).toBeGreaterThan(galaxies);
  });

  await test.step('maglim=3 culls a magnitude 3.5 star from the picture and the picking, Sirius stays', async () => {
    // The pixel probes read the canvas centre: no labels and no line layers (Wasat is a vertex
    // of the Gemini figure; a constellation line through the patch would light it, not a star).
    await page.goto(
      url({ ground: 'off', atm: '0', maglim: '3', layers: 'stars,planets', labels: '0' }),
    );
    await waitReady(page);
    const wasat = await altAzOf(page, WASAT);
    expect(wasat.alt).toBeGreaterThan(0);
    await lookAt(page, WASAT, 20);
    expect(await pickCentre(page)).toBeNull();
    await lookAt(page, SIRIUS, 20);
    expect(await pickCentre(page)).toBe(SIRIUS);
    // The limit also holds in the picture: the patch at Wasat is dark, the one at Sirius lit.
    await lookAt(page, WASAT, 20);
    await afterFrames(page, 2);
    expect((await centrePatch(page)).max).toBeLessThan(LIT_MIN);
    await lookAt(page, SIRIUS, 20);
    await expect
      .poll(async () => (await centrePatch(page)).max, { timeout: 10_000 })
      .toBeGreaterThan(LIT_MIN);
  });

  await test.step('ground=dim shows Canopus through the ground: between the opaque and off values', async () => {
    const maxAtCanopus = async (ground: 'opaque' | 'dim' | 'off'): Promise<number> => {
      // Stars and the ground alone in the patch (the ground quad follows `ground`, not a layer
      // flag): a label or a line there would move the compared values.
      await page.goto(url({ ground, atm: '0', layers: 'stars,planets', labels: '0' }));
      await waitReady(page);
      await lookAt(page, CANOPUS, 20);
      await afterFrames(page, 2);
      return (await centrePatch(page)).max;
    };
    const opaque = await maxAtCanopus('opaque');
    const off = await maxAtCanopus('off');
    const dim = await maxAtCanopus('dim');
    // The three readings, for the record of docs/testing.md (the JSON and HTML reports carry them).
    test.info().annotations.push({
      type: 'ground-probe',
      description: `centrePatch max at Canopus: opaque ${String(opaque)}, dim ${String(dim)}, off ${String(off)}`,
    });
    expect(opaque).toBeLessThan(90);
    expect(off).toBeGreaterThan(LIT_MIN);
    // A 60 % ground over the star (sky/math/atmosphere.ts::groundAlpha): dimmer than the bare
    // star, brighter than the ground alone.
    expect(dim).toBeGreaterThan(opaque + DIM_MARGIN);
    expect(dim).toBeLessThan(off - DIM_MARGIN);
    // Labels and picking are not culled by a translucent ground (only an opaque one, plan D104).
    expect(await pickCentre(page)).toBe(CANOPUS);
  });

  expect(errors).toEqual([]);
});

test('a missing minor-body group disables the layer with its reason and blocks the shape (UX-6, E3)', async ({
  page,
}) => {
  const errors = collectErrors(page);
  const frameRequests = collectFrameRequests(page);
  const minorRequests = (): string[] => frameRequests.filter((u) => u.includes('minor='));
  const minorSwitch = page.getByRole('switch', { name: 'Asteroids and comets' });

  await test.step('without the MPC tables the switch is disabled with the reason and no minor= request leaves', async () => {
    // The CI data set, forced on any server: `/meta` without `catalogs.minor_bodies` (a missing
    // data group, brief l.280). That is the whole path: the switch is disabled from `/meta` alone
    // (ui/panels/LayersPanel.tsx) and the defaults are never requested for an absent group
    // (state/minorBodies.ts), so no `/minor-bodies/*` route is stubbed here; a defaults 503
    // mapping to `missing` is minorBodies.test.ts's business.
    await page.route('**/api/v1/meta', async (route) => {
      const response = await route.fetch();
      const body: unknown = await response.json();
      const meta = body as { catalogs: Record<string, unknown> };
      meta.catalogs.minor_bodies = null;
      await route.fulfill({ response, json: meta });
    });
    // The layer asked for in the URL, with a pin: neither may produce a `minor=` request.
    await page.goto(url({ ground: 'off', atm: '0', layers: `${LAYERS},minor`, minor: 'a:1' }));
    await waitReady(page);
    await openTab(page, 'Layers');
    await expect(minorSwitch).toBeDisabled();
    await expect(minorSwitch).toHaveAttribute('aria-describedby', 'layers-reason-minor');
    await expect(page.locator('#layers-reason-minor')).toHaveText(
      'Minor-body data is missing on this server.',
    );
    expect(minorRequests()).toEqual([]);
    expect((await statsOf(page)).minorDrawn).toBe(0);
    expect(frameRequests.length).toBeGreaterThan(0);
    await page.unroute('**/api/v1/meta');
  });

  const meta = await metaOf(page);
  const catalogs =
    typeof meta === 'object' && meta !== null && 'catalogs' in meta
      ? (meta as { catalogs: Record<string, unknown> }).catalogs
      : {};
  const hasMinor = catalogs.minor_bodies !== undefined && catalogs.minor_bodies !== null;

  if (hasMinor) {
    await test.step('a /sky/frame 503 with Retry-After 60 on the minor shape blocks it without a retry', async () => {
      // The full local data set: the defaults load, the composed `minor=` request is refused
      // for good and the controller blocks that shape (plan D76): one request, none within the
      // next three seconds, the picture without minor bodies stays.
      frameRequests.length = 0;
      await page.route(FRAME_ROUTE, (route) =>
        route.request().url().includes('minor=') ? route.fulfill(dataNotReady()) : route.continue(),
      );
      await page.goto(url({ ground: 'off', atm: '0' }));
      await waitReady(page);
      await openTab(page, 'Layers');
      await expect(minorSwitch).toBeEnabled();
      await minorSwitch.click();
      await expect(minorSwitch).toHaveAttribute('aria-checked', 'true');
      await expect.poll(() => minorRequests().length, { timeout: 30_000 }).toBe(1);
      await page.waitForTimeout(3000);
      expect(minorRequests().length).toBe(1);
      const state = await debugState(page);
      expect(state.layers.minor).toBe(true);
      expect(state.frame).not.toBeNull();
      expect(state.failing).toBeNull();
      expect((await statsOf(page)).minorDrawn).toBe(0);
      await expect(page.getByRole('alert', { name: 'Sky service unreachable' })).toHaveCount(0);
      await page.unroute(FRAME_ROUTE);
    });
  }

  // The 503 answers are Chromium's own resource lines; the page logs nothing of its own.
  expect(errors.filter((line) => !line.startsWith(RESOURCE_LINE))).toEqual([]);
});
