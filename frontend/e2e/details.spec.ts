import { expect, test } from './fixtures.ts';

import {
  ARCMIN_DEG,
  LAT,
  appUrl,
  canvasBox,
  collectErrors,
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
// leaves the URL. The SKY-5 highlight follows the selection's `constellation` field of
// `/sky/altaz` (plan D114) through `stats().clinesHighlight` (plan D163: `'CMa'` while Sirius
// is selected, `null` once nothing is), and a constellation found through the search is centred
// (`screenOf('con:Ori')` within 3 px of the canvas centre) without touching the selection.
// Page-side functions reach the hook through `window.__sky` directly.

const ENGINE = 'webgl2';
const SIRIUS = 'hip:32349';
/** The centred constellation's label point stays within this many CSS pixels of the centre. */
const CENTRE_TOLERANCE_PX = 3;

test.describe.configure({ timeout: 180_000 });

async function highlightOf(page: Parameters<typeof debugState>[0]): Promise<string | null> {
  return page.evaluate(() => window.__sky?.stats().clinesHighlight ?? null);
}

/** Distance of an object from the canvas centre in CSS pixels, `Infinity` when unresolved. */
async function centreDistance(page: Parameters<typeof debugState>[0], id: string): Promise<number> {
  const point = await page.evaluate((target) => window.__sky?.screenOf(target) ?? null, id);
  if (point === null) {
    return Infinity;
  }
  const box = await canvasBox(page);
  return Math.hypot(point.x - box.width / 2, point.y - box.height / 2);
}

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

  await test.step('the selected constellation is highlighted in the line layer (SKY-5)', async () => {
    // The abbreviation comes from the server's `constellation` field (plan D114), never from a
    // client-side polygon test; the layer reports the constellation it draws highlighted.
    await expect.poll(() => highlightOf(page), { timeout: 20_000 }).toBe('CMa');
    expect(await page.evaluate(() => window.__sky?.constellationOf('hip:32349') ?? null)).toBe(
      'CMa',
    );
  });

  await test.step('orion in the search centres the constellation and keeps the selection', async () => {
    const box = page.getByRole('combobox', { name: 'Search the sky' });
    await box.fill('orion');
    const option = page.getByRole('option', { name: /Orion/ }).first();
    await expect(option).toContainText('Constellation');
    // The option is chosen by a click, never by Enter: Enter takes the active option, and an
    // option becomes active when the pointer enters it. Playwright's virtual mouse rests where
    // the Details tab was clicked, and on the phone layout the list opens under that spot, so
    // Enter would take the hovered star of Orion (Alnilam) instead of the constellation.
    await option.click();
    await expect
      .poll(() => centreDistance(page, 'con:Ori'), { timeout: 15_000 })
      .toBeLessThan(CENTRE_TOLERANCE_PX);
    expect((await debugState(page)).sel).toBe(SIRIUS);
    expect(selParam(page)).toBe(SIRIUS);
    expect(await highlightOf(page)).toBe('CMa');
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
    // Nothing selected: no constellation is highlighted (SKY-5).
    await expect.poll(() => highlightOf(page), { timeout: 10_000 }).toBeNull();
  });

  // The unknown `sel` is answered 404 by design; Chromium logs that failed load as a console
  // error of its own, which is not an error of the page.
  expect(errors.filter((line) => !line.startsWith('Failed to load resource'))).toEqual([]);
});
