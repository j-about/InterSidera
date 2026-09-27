import { expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

import {
  collectErrors,
  collectForeignRequests,
  debugState,
  metaOf,
  openTab,
  waitReady,
} from './support.ts';

// The observer panel (OBS-1..OBS-7, brief l.190-196; plan D95-D97, D113): a granted geolocation
// moves the observer (stored unrounded, rounded to 0.01 degree in the URL and in every
// `/sky/frame` request), a denial keeps Greenwich and opens the panel, a DMS entry lands in the
// URL, the Nominatim search is mocked at the configured origin (one jsonv2 request with the
// documented parameters, the typed text only, the attribution shown, a pick moving the observer,
// the toggle hiding the form) and a body switch plus a preset write the four observer keys. Three
// boots: a prompt that is never answered (the explanation must be visible on its own, on the phone
// layout too, with the sky uncovered), then the granted flow, then the denied flow through an
// `addInitScript` stub (headless Chromium's handling of an un-granted prompt is undocumented,
// plan R65). E4 (plan D163, UX-6): a second geocoder submit answered 429 shows `geocoder.blocked`
// and is never retried by the page (OSMF usage policy, brief l.554).

const ENGINE = 'webgl2';
const PARIS = { latitude: 48.8566, longitude: 2.3522 };
/** No observer keys: the geolocation request starts with the boot (plan D95). */
const NO_OBSERVER_URL = `/?atm=0#engine=${ENGINE}`;
/** At most two decimals (OBS-7). */
const TWO_DECIMALS = /^-?\d+(\.\d{1,2})?$/;
/** Chromium's own console line for a request answered with an error status. */
const RESOURCE_LINE = 'Failed to load resource';

interface GeocoderMeta {
  enabled: boolean;
  url: string;
  email?: string | null;
}

function geocoderOf(meta: unknown): GeocoderMeta {
  if (typeof meta !== 'object' || meta === null || !('geocoder' in meta)) {
    throw new Error('/meta has no geocoder');
  }
  const geocoder: unknown = meta.geocoder;
  if (
    typeof geocoder !== 'object' ||
    geocoder === null ||
    typeof (geocoder as { enabled?: unknown }).enabled !== 'boolean' ||
    typeof (geocoder as { url?: unknown }).url !== 'string'
  ) {
    throw new Error('unexpected /meta.geocoder');
  }
  return geocoder as GeocoderMeta;
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

function param(page: Page, key: string): string | null {
  return new URL(page.url()).searchParams.get(key);
}

test.use({ geolocation: PARIS, permissions: ['geolocation'] });

test.describe.configure({ timeout: 240_000 });

test('the explanation is visible while the browser prompt is up, the sky uncovered', async ({
  page,
}) => {
  const errors = collectErrors(page);
  const foreign = collectForeignRequests(page);
  await page.addInitScript(() => {
    // A prompt the user never answers: the banner stands on its own (plan D95, backlog B-69).
    navigator.geolocation.getCurrentPosition = () => undefined;
  });
  await page.goto(NO_OBSERVER_URL);
  // Before the first frame: the request starts on the boot tick, not on the ready state.
  const region = page.getByRole('status', { name: 'Your location' });
  await expect(region).toBeVisible({ timeout: 30_000 });
  await expect(region).toHaveText(/rounded to 0\.01/);
  await waitReady(page);
  const state = await debugState(page);
  expect(state.geo).toBe('prompting');
  expect(state.ui.panel).toBeNull();
  expect(state.ui.dialog).toBeNull();
  // The observer keys are withheld while prompting (plan D95); Greenwich is rendered meanwhile.
  expect(param(page, 'lat')).toBeNull();
  expect(state.observer).toEqual({ body: 'earth', lat: 51.48, lon: 0, elev: 0 });
  await expect(region).toBeVisible();
  await expect(region).toHaveCount(1);
  expect(foreign).toEqual([]);
  expect(errors).toEqual([]);
});

test('geolocation, manual coordinates, the mocked geocoder, a body switch and a preset', async ({
  page,
  foreignRequests,
}) => {
  const meta = geocoderOf(await metaOf(page));
  const geocoderHost = meta.url === '' ? null : new URL(meta.url).hostname;
  if (geocoderHost !== null) {
    // The one foreign host a test may reach: the geocoder, routed and fulfilled below (a
    // `page.route` fulfilment still fires `page.on('request')`); the fixture asserts the rest.
    foreignRequests.allow(geocoderHost);
  }
  const errors = collectErrors(page);
  const frameRequests = collectFrameRequests(page);

  await test.step('a granted fix moves the observer, rounded only in the URL and the requests', async () => {
    await page.goto(NO_OBSERVER_URL);
    await waitReady(page);
    await expect
      .poll(async () => (await debugState(page)).geo, { timeout: 20_000 })
      .toBe('granted');
    const state = await debugState(page);
    expect(state.observer).toEqual({
      body: 'earth',
      lat: PARIS.latitude,
      lon: PARIS.longitude,
      elev: 0,
    });
    // Two fields, one 250 ms debounce each and a 2 Hz URL writer: poll both keys.
    await expect.poll(() => param(page, 'lat'), { timeout: 3000 }).toBe('48.86');
    await expect.poll(() => param(page, 'lon'), { timeout: 3000 }).toBe('2.35');
    expect(param(page, 'body')).toBe('earth');
    expect(frameRequests.length).toBeGreaterThan(0);
    for (const url of frameRequests) {
      const query = new URL(url).searchParams;
      expect(query.get('lat')).toMatch(TWO_DECIMALS);
      expect(query.get('lon')).toMatch(TWO_DECIMALS);
    }
  });

  await test.step('a denial keeps Greenwich, records the status and opens the observer panel', async () => {
    await page.addInitScript(() => {
      navigator.geolocation.getCurrentPosition = (_success, error) => {
        error?.({
          code: 1,
          message: 'denied',
          PERMISSION_DENIED: 1,
          POSITION_UNAVAILABLE: 2,
          TIMEOUT: 3,
        });
      };
    });
    await page.goto(NO_OBSERVER_URL);
    await waitReady(page);
    await expect.poll(async () => (await debugState(page)).geo, { timeout: 20_000 }).toBe('denied');
    const state = await debugState(page);
    expect(state.observer).toEqual({ body: 'earth', lat: 51.48, lon: 0, elev: 0 });
    expect(state.ui.panel).toBe('observer');
    await expect(page.getByRole('status', { name: 'Your location' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Use my location' })).toBeVisible();
    await expect.poll(() => param(page, 'lat'), { timeout: 3000 }).toBe('51.48');
  });

  await test.step('a DMS entry reaches the URL rounded to 0.01 degree', async () => {
    await openTab(page, 'Observer');
    await page.getByRole('textbox', { name: 'Latitude' }).fill('48°51\'24"N');
    await page.getByRole('textbox', { name: 'Longitude' }).fill('2°21\'03"E');
    await expect.poll(() => param(page, 'lat'), { timeout: 3000 }).toBe('48.86');
    await expect.poll(() => param(page, 'lon'), { timeout: 3000 }).toBe('2.35');
    const state = await debugState(page);
    expect(Math.abs(state.observer.lat - (48 + 51 / 60 + 24 / 3600))).toBeLessThan(1e-9);
    expect(Math.abs(state.observer.lon - (2 + 21 / 60 + 3 / 3600))).toBeLessThan(1e-9);
  });

  if (meta.enabled && geocoderHost !== null) {
    await test.step('the geocoder receives one documented request and a pick moves the observer', async () => {
      const origin = new URL(meta.url).origin;
      const fulfilled = new Set<string>();
      const referers: (string | undefined)[] = [];
      await page.route(`${origin}/**`, async (route) => {
        fulfilled.add(route.request().url());
        referers.push(route.request().headers().referer);
        // E4: the second query is refused by the service (Nominatim answers 429 over its
        // policy); the first one is the documented Paris row.
        if (new URL(route.request().url()).searchParams.get('q') === 'Lyon') {
          await route.fulfill({
            status: 429,
            contentType: 'text/html',
            body: '<html><body>Too Many Requests</body></html>',
          });
          return;
        }
        await route.fulfill({
          json: [
            {
              place_id: 71525,
              licence: 'Data (c) OpenStreetMap contributors, ODbL 1.0.',
              osm_type: 'relation',
              osm_id: 7444,
              lat: '48.8588897',
              lon: '2.3200410217200766',
              category: 'boundary',
              type: 'administrative',
              place_rank: 15,
              importance: 0.88,
              addresstype: 'city',
              name: 'Paris',
              display_name: 'Paris, Île-de-France, France métropolitaine, France',
              boundingbox: ['48.8155755', '48.9021560', '2.2241220', '2.4697602'],
            },
          ],
        });
      });
      await page.getByRole('textbox', { name: 'Place name' }).fill('Paris');
      await page.getByRole('button', { name: 'Search' }).click();
      await expect.poll(() => fulfilled.size, { timeout: 10_000 }).toBe(1);
      const requested = new URL([...fulfilled][0] ?? '');
      expect(requested.pathname).toBe('/search');
      expect(requested.searchParams.get('format')).toBe('jsonv2');
      expect(requested.searchParams.get('limit')).toBe('5');
      expect(requested.searchParams.get('accept-language')).toBe('en');
      expect(requested.searchParams.get('q')).toBe('Paris');
      expect(requested.searchParams.has('lat')).toBe(false);
      expect(requested.searchParams.has('lon')).toBe(false);
      if (typeof meta.email === 'string' && meta.email !== '') {
        expect(requested.searchParams.get('email')).toBe(meta.email);
      } else {
        expect(requested.searchParams.has('email')).toBe(false);
      }
      // `strict-origin-when-cross-origin` sends the origin of the page (brief l.554).
      expect(referers[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/?$/);

      const result = page.getByRole('button', { name: /Paris, Île-de-France/ });
      await expect(result).toBeVisible();
      // Scoped to the observer tab: the About dialog (closed) carries the same attribution.
      await expect(
        page.getByRole('tabpanel', { name: 'Observer' }).getByText(/OpenStreetMap contributors/),
      ).toBeVisible();
      await expect(page.getByRole('link', { name: 'OpenStreetMap copyright' })).toHaveAttribute(
        'href',
        'https://www.openstreetmap.org/copyright',
      );
      await result.click();
      await expect.poll(() => param(page, 'lon'), { timeout: 3000 }).toBe('2.32');
      expect(param(page, 'lat')).toBe('48.86');
      expect((await debugState(page)).observer.elev).toBe(0);

      // E4 (UX-6, plan D163): the service refuses the next query with 429. The panel says so,
      // the results are cleared, the page never retries on its own (exactly one more request,
      // still none after the cooldown), and the submit control is released after the policy's
      // one-second interval so the user may try again by hand.
      const submit = page.getByRole('button', { name: 'Search' });
      await expect(submit).not.toHaveAttribute('aria-disabled', { timeout: 5000 });
      await page.getByRole('textbox', { name: 'Place name' }).fill('Lyon');
      await submit.click();
      const blocked = page.getByRole('tabpanel', { name: 'Observer' }).getByRole('alert');
      await expect(blocked).toHaveText(
        'The place search service refused the request; wait a moment before trying again.',
        { timeout: 10_000 },
      );
      expect(fulfilled.size).toBe(2);
      const refused = new URL([...fulfilled][1] ?? '');
      expect(refused.searchParams.get('q')).toBe('Lyon');
      await expect(page.getByRole('button', { name: /Paris, Île-de-France/ })).toHaveCount(0);
      await expect(submit).not.toHaveAttribute('aria-disabled', { timeout: 5000 });
      await page.waitForTimeout(1500);
      expect(fulfilled.size).toBe(2);
      await expect(blocked).toBeVisible();

      await page.getByRole('switch', { name: 'Online place search (Nominatim)' }).click();
      await expect(page.getByRole('textbox', { name: 'Place name' })).toHaveCount(0);
      // Scoped to the observer tab: the About dialog (closed) carries the same attribution.
      await expect(
        page.getByRole('tabpanel', { name: 'Observer' }).getByText(/OpenStreetMap contributors/),
      ).toBeVisible();
    });
  }

  await test.step('a body switch keeps the coordinates and a preset writes the four keys', async () => {
    await page.getByRole('combobox', { name: 'Observed from' }).selectOption('mars');
    await expect.poll(() => param(page, 'body'), { timeout: 3000 }).toBe('mars');
    expect(param(page, 'lat')).toBe('48.86');
    await page.getByRole('button', { name: /Jezero/ }).click();
    await expect.poll(() => param(page, 'lat'), { timeout: 3000 }).toBe('18.41');
    expect(param(page, 'lon')).toBe('77.69');
    expect(param(page, 'elev')).toBe('0');
    expect((await debugState(page)).observer).toEqual({
      body: 'mars',
      lat: 18.41,
      lon: 77.69,
      elev: 0,
    });
    // The coverage line names both bounds as signed years.
    await expect(page.getByTestId('observer-coverage')).toHaveText(/-?\d{4,}.*-?\d{4,}/);
  });

  expect(foreignRequests.urls).toEqual([]);
  // The E4 answer is Chromium's own "Failed to load resource ... 429" console line (logged for
  // a route-fulfilled response as well): exactly one when the geocoder step ran, none otherwise;
  // the page itself logs nothing.
  const resourceLines = errors.filter((line) => line.startsWith(RESOURCE_LINE));
  expect(resourceLines).toHaveLength(meta.enabled && geocoderHost !== null ? 1 : 0);
  expect(resourceLines.every((line) => line.includes('429'))).toBe(true);
  expect(errors.filter((line) => !line.startsWith(RESOURCE_LINE))).toEqual([]);
});
