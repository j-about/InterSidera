import { expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';
import type { SkyDebugApi } from '../src/debug/skyDebugApi.ts';

// URL round trip (UX-2, brief l.246, l.574; OBS-8, l.197; plan D79, D89): every M3 parameter
// reaches the store, a view change rewrites the query within the 2 Hz budget, a reload restores
// it from the browser-cached catalogs (acceptance l.573, plan D137: a 304 each, the same body),
// the language is applied to the document, the dev/e2e hash stays out of the query, and no
// browser storage is touched. Page-side functions reach the hook through `window.__sky`.

const TT = 2460409.25;
const LOADED =
  '/?body=earth&lat=48.86&lon=2.35&elev=35&t=2460409.25&speed=0&az=180&alt=30&fov=45' +
  '&layers=stars,planets,horizon,azgrid,eqgrid,ecliptic,meridian&ground=off&atm=0&refr=0' +
  '&maglim=5.5&dso=galaxy,nebula&minor=a:1&labels=1&lang=fr&night=1&sel=hip:11767#engine=webgl2';

type DebugState = ReturnType<SkyDebugApi['state']>;

async function waitReady(page: Page): Promise<void> {
  // The hook exists once the engine is created; `state().tt` needs a first render tick.
  await page.waitForFunction(() => window.__sky?.isReady === true, undefined, {
    timeout: 120_000,
    polling: 250,
  });
}

async function debugState(page: Page): Promise<DebugState> {
  const state = await page.evaluate(() => window.__sky?.state() ?? null);
  if (state === null) {
    throw new Error('window.__sky is missing: not an e2e build');
  }
  return state;
}

/** Resource Timing of the catalog requests of the current document, by path. */
async function catalogRows(
  page: Page,
): Promise<Map<string, { transferSize: number; decodedBodySize: number }>> {
  const rows = await page.evaluate(() => window.__sky?.resources() ?? []);
  return new Map(
    rows
      .filter((row) => row.name.startsWith('/api/v1/catalogs/'))
      .map((row) => [
        row.name,
        { transferSize: row.transferSize, decodedBodySize: row.decodedBodySize },
      ]),
  );
}

/** A revalidation answered 304 costs headers alone (about 300 B); a heuristic cache hit costs 0 and is refused below. */
const REVALIDATION_MAX_BYTES = 1000;

test.describe.configure({ timeout: 180_000 });

test('every M3 parameter round-trips through the store, the URL and a reload', async ({ page }) => {
  await page.goto(LOADED);
  await waitReady(page);

  const loaded = await debugState(page);
  expect(loaded.observer).toEqual({ body: 'earth', lat: 48.86, lon: 2.35, elev: 35 });
  expect(loaded.view).toEqual({ az: 180, alt: 30, fov: 45 });
  expect(loaded.mode).toBe('paused');
  expect(loaded.speed).toBe(0);
  expect(Math.abs(loaded.tt - TT)).toBeLessThan(1e-6);
  expect(loaded.refr).toBe(false);
  // The language of the URL is applied before the first render (plan D87).
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('fr');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('InterSidera');

  // A view change lands in the query within the <= 2 Hz budget (brief l.552).
  await page.evaluate(() => {
    window.__sky?.setView(120, 30, 45);
  });
  await expect
    .poll(() => new URL(page.url()).searchParams.get('az'), { timeout: 3000 })
    .toBe('120');
  const written = new URL(page.url());
  const params = written.searchParams;
  expect(params.get('alt')).toBe('30');
  expect(params.get('fov')).toBe('45');
  expect(params.get('t')).toBe(String(TT));
  // Paused: `speed` is omitted (plan D79); the other parameters survive in canonical form.
  expect(params.get('speed')).toBeNull();
  expect(params.get('body')).toBe('earth');
  expect(params.get('lat')).toBe('48.86');
  expect(params.get('lon')).toBe('2.35');
  expect(params.get('elev')).toBe('35');
  expect(params.get('layers')).toBe('stars,planets,azgrid,eqgrid,ecliptic,meridian,horizon');
  expect(params.get('ground')).toBe('off');
  expect(params.get('atm')).toBe('0');
  expect(params.get('refr')).toBe('0');
  expect(params.get('maglim')).toBe('5.5');
  expect(params.get('dso')).toBe('galaxy,nebula');
  expect(params.get('minor')).toBe('a:1');
  expect(params.get('labels')).toBe('1');
  expect(params.get('lang')).toBe('fr');
  expect(params.get('night')).toBe('1');
  expect(params.get('sel')).toBe('hip:11767');
  // The dev/e2e backend override is never serialized and the hash is preserved (plan D79).
  expect(params.get('engine')).toBeNull();
  expect(written.hash).toBe('#engine=webgl2');

  // A reload of the written URL restores the view and the paused instant (brief l.574).
  const cold = await catalogRows(page);
  expect(cold.get('/api/v1/catalogs/stars')?.transferSize ?? 0).toBeGreaterThan(1_000_000);
  await page.reload();
  await waitReady(page);
  const restored = await debugState(page);
  expect(restored.view).toEqual({ az: 120, alt: 30, fov: 45 });
  expect(restored.mode).toBe('paused');
  expect(Math.abs(restored.tt - TT)).toBeLessThan(1e-6);
  expect(restored.observer).toEqual({ body: 'earth', lat: 48.86, lon: 2.35, elev: 35 });
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('fr');

  // The catalogs are cached by the browser (acceptance l.573, plan D137): `cache: 'no-cache'`
  // revalidates each with `If-None-Match`, the API answers 304, so the second load moves headers
  // alone while the body the page parsed is the cached one, the same size byte for byte. A
  // revalidation costs a few hundred bytes of headers on the wire; a heuristic cache hit (no
  // request at all) reports `transferSize` 0, which is not the 304 the acceptance row claims.
  const warm = await catalogRows(page);
  expect([...warm.keys()].sort()).toEqual([...cold.keys()].sort());
  for (const [name, row] of warm) {
    expect(row.transferSize, `${name} transferSize`).toBeGreaterThan(0);
    expect(row.transferSize, `${name} transferSize`).toBeLessThan(REVALIDATION_MAX_BYTES);
    expect(row.decodedBodySize, `${name} decodedBodySize`).toBe(cold.get(name)?.decodedBodySize);
  }

  // OBS-8: the URL is the only state; no cookie, no Web Storage, no IndexedDB database.
  const storage = await page.evaluate(async () => ({
    cookie: document.cookie,
    local: localStorage.length,
    session: sessionStorage.length,
    databases: (await indexedDB.databases()).length,
  }));
  expect(storage).toEqual({ cookie: '', local: 0, session: 0, databases: 0 });
});

// M4 additions (UX-1, UX-2, UX-3; plan D108-D110): the copy-link button writes the serialised
// state (origin + path + query, never the dev/e2e hash) to the clipboard on Chromium and falls
// back to a selectable field elsewhere; the language toggle writes `lang=fr` and `<html lang>`;
// `night=0.6` round-trips through a view change.
const PAUSED =
  '/?body=earth&lat=51.48&lon=0&elev=0&t=2460409.25&speed=0&az=0&alt=45&fov=60&atm=0&refr=0&night=0.6#engine=webgl2';

test('copy link, language toggle and night level round trip', async ({
  page,
  context,
  browserName,
}) => {
  await page.goto(PAUSED);
  await waitReady(page);
  // The URL is rewritten on the first change only, so the loaded query stands as typed; the share
  // link is the canonical serialisation of the store, which omits `speed` while paused (plan
  // D79) and never carries the hash.
  const current = new URL(page.url());
  expect(current.searchParams.get('night')).toBe('0.6');
  expect(current.hash).toBe('#engine=webgl2');
  const canonical = new URLSearchParams(current.search);
  canonical.delete('speed');
  const expected = `${current.origin}${current.pathname}?${canonical.toString()}`;

  await test.step('copy link -> the serialised state without the hash', async () => {
    const copy = page.getByRole('button', { name: 'Copy a link to this view' });
    if (browserName === 'chromium') {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await copy.click();
      await expect(page.getByRole('status', { name: 'Notifications' })).toContainText(
        'Link copied',
      );
      const text = await page.evaluate(() => navigator.clipboard.readText());
      expect(text).toBe(expected);
      expect(text).not.toContain('#');
    } else {
      // No clipboard permission model: the read-only field carries the same link.
      await copy.click();
      await expect(page.getByRole('textbox', { name: 'Shareable link' })).toHaveValue(expected);
    }
  });

  await test.step('language toggle -> lang=fr in the URL and on the document', async () => {
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
    await page.getByRole('button', { name: 'Français' }).click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('lang'), { timeout: 3000 })
      .toBe('fr');
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('fr');
    // The top bar is visible in both layouts (the tabs sit inside the collapsed sheet on phones).
    await expect(page.getByRole('button', { name: 'Copier un lien vers cette vue' })).toBeVisible();
    await page.getByRole('button', { name: 'English' }).click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('lang'), { timeout: 3000 })
      .toBeNull();
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
  });

  await test.step('night=0.6 survives a view change and a reload', async () => {
    const state = await debugState(page);
    expect(state.night).toBe(true);
    expect(state.nightLevel).toBeCloseTo(0.6, 6);
    await page.evaluate(() => {
      window.__sky?.setView(120, 30, 45);
    });
    await expect
      .poll(() => new URL(page.url()).searchParams.get('az'), { timeout: 3000 })
      .toBe('120');
    expect(new URL(page.url()).searchParams.get('night')).toBe('0.6');
    await page.reload();
    await waitReady(page);
    const restored = await debugState(page);
    expect(restored.night).toBe(true);
    expect(restored.nightLevel).toBeCloseTo(0.6, 6);
    expect(await page.evaluate(() => document.documentElement.dataset.mode ?? null)).toBe('night');
  });
});
