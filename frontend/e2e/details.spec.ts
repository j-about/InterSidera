import { expect, test } from '@playwright/test';

import {
  ARCMIN_DEG,
  LAT,
  appUrl,
  collectErrors,
  collectForeignRequests,
  debugState,
  definitionOf,
  isAltAzRow,
  openPanelTab,
  parseDegrees,
  separationDeg,
  waitReady,
} from './support.ts';

// The details panel (INFO-1, plan D106, D113): a `sel` in the URL names Sirius with its
// designations and constellation (Latin in English, "Grand Chien" in French), the horizontal
// coordinates agree with `/sky/altaz` at the rendered instant within an arcminute, the
// equatorial coordinates of both epochs are shown, and an unknown `sel` raises the toast and
// leaves the URL. Page-side functions reach the hook through `window.__sky` directly.

const ENGINE = 'webgl2';
const SIRIUS = 'hip:32349';

test.describe.configure({ timeout: 180_000 });

function withParams(url: string, params: string): string {
  return url.replace('#engine', `&${params}#engine`);
}

function selParam(page: Parameters<typeof debugState>[0]): string | null {
  return new URL(page.url()).searchParams.get('sel');
}

test('Sirius: names, constellation, authoritative coordinates; an unknown sel is cleared', async ({
  page,
}) => {
  const errors = collectErrors(page);
  const foreign = collectForeignRequests(page);
  await page.goto(withParams(appUrl(ENGINE, true), `sel=${SIRIUS}`));
  await waitReady(page);

  const panel = await openPanelTab(page, 'Details');

  await test.step('names, designations, type and constellation', async () => {
    await expect(panel.getByRole('heading', { level: 3 })).toHaveText('Sirius');
    await expect(panel).toContainText('α CMa');
    await expect(panel).toContainText('HIP 32349');
    await expect(definitionOf(panel, 'Type')).toHaveText('Star');
    await expect(definitionOf(panel, 'Constellation')).toContainText('Canis Major');
    await expect(definitionOf(panel, 'Constellation')).toContainText('Canis Majoris');
  });

  await test.step('the server values arrive: RA/Dec of both epochs', async () => {
    await expect(panel.getByText(/Server values at/)).toBeVisible({ timeout: 20_000 });
    await expect(definitionOf(panel, 'Right ascension (ICRS)')).toHaveText(
      /^\d\dh \d\dm \d\d\.\ds$/,
    );
    await expect(definitionOf(panel, 'Declination (ICRS)')).toHaveText(/^-?\d+° \d\d′ \d\d″$/);
    await expect(definitionOf(panel, 'Right ascension (of date)')).toHaveText(/^\d\dh \d\dm/);
    await expect(definitionOf(panel, 'Declination (of date)')).toHaveText(/″$/);
    await expect(definitionOf(panel, 'Magnitude')).toHaveText(/^-1\.4/);
  });

  await test.step('altitude and azimuth agree with /sky/altaz within an arcminute', async () => {
    const state = await debugState(page);
    expect(state.sel).toBe(SIRIUS);
    const query = new URLSearchParams({
      body: 'earth',
      lat: String(LAT),
      lon: '0',
      elev: '0',
      tt: String(state.tt),
      targets: SIRIUS,
      refraction: '1',
    });
    const res = await page.request.get(`/api/v1/sky/altaz?${query.toString()}`);
    expect(res.ok()).toBeTruthy();
    const body: unknown = await res.json();
    if (!Array.isArray(body) || !body.every(isAltAzRow) || body[0] === undefined) {
      throw new Error('unexpected /sky/altaz body');
    }
    const row = body[0];
    const alt = parseDegrees(await definitionOf(panel, 'Altitude').innerText());
    const az = parseDegrees(await definitionOf(panel, 'Azimuth').innerText());
    // Two decimals of a degree on each channel add at most 0.42 arcmin of rounding.
    expect(separationDeg({ alt, az }, { alt: row.alt_deg, az: row.az_deg })).toBeLessThanOrEqual(
      ARCMIN_DEG,
    );
  });

  await test.step('the French panel names the constellation Grand Chien', async () => {
    await page.goto(withParams(appUrl(ENGINE, true), `sel=${SIRIUS}&lang=fr`));
    await waitReady(page);
    const panelFr = await openPanelTab(page, 'Détails');
    await expect(panelFr.getByRole('heading', { level: 3 })).toHaveText('Sirius');
    await expect(definitionOf(panelFr, 'Constellation')).toContainText('Grand Chien');
    await expect(definitionOf(panelFr, 'Constellation')).toContainText('Canis Major');
    await expect(definitionOf(panelFr, 'Type')).toHaveText('Étoile');
    await expect(definitionOf(panelFr, 'Hauteur')).toHaveText(/°$/);
  });

  await test.step('an unknown sel raises the toast and leaves the URL', async () => {
    await page.goto(withParams(appUrl(ENGINE, true), 'sel=hip:99999999'));
    await waitReady(page);
    await expect(page.getByRole('status', { name: 'Notifications' })).toContainText(
      'unknown to the sky service',
      { timeout: 20_000 },
    );
    await expect.poll(() => selParam(page), { timeout: 5000 }).toBeNull();
    expect((await debugState(page)).sel).toBeNull();
    const panelEn = await openPanelTab(page, 'Details');
    await expect(panelEn).toContainText('Nothing selected');
  });

  expect(foreign).toEqual([]);
  // The unknown `sel` is answered 404 by design; Chromium logs that failed load as a console
  // error of its own, which is not an error of the page.
  expect(errors.filter((line) => !line.startsWith('Failed to load resource'))).toEqual([]);
});
