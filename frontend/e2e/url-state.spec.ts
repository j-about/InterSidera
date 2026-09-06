import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { SkyDebugApi } from '../src/debug/skyDebugApi.ts';

// URL round trip (UX-2, brief l.246, l.574; OBS-8, l.197; plan D79, D89): every M3 parameter
// reaches the store, a view change rewrites the query within the 2 Hz budget, a reload restores
// it, the language is applied to the document, the dev/e2e hash stays out of the query, and no
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
  await page.reload();
  await waitReady(page);
  const restored = await debugState(page);
  expect(restored.view).toEqual({ az: 120, alt: 30, fov: 45 });
  expect(restored.mode).toBe('paused');
  expect(Math.abs(restored.tt - TT)).toBeLessThan(1e-6);
  expect(restored.observer).toEqual({ body: 'earth', lat: 48.86, lon: 2.35, elev: 35 });
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('fr');

  // OBS-8: the URL is the only state; no cookie, no Web Storage, no IndexedDB database.
  const storage = await page.evaluate(async () => ({
    cookie: document.cookie,
    local: localStorage.length,
    session: sessionStorage.length,
    databases: (await indexedDB.databases()).length,
  }));
  expect(storage).toEqual({ cookie: '', local: 0, session: 0, databases: 0 });
});
