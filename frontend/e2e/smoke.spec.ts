import { expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';
import type { SkyDebugApi } from '../src/debug/skyDebugApi.ts';

// Load smoke (brief l.410, l.442; plan D89): the shell renders, the canvas is on screen, `/api`
// is proxied through `vite preview`, the sky reaches its first frame, the catalogs of the session
// stay under the 6 MB download budget (brief l.258, plan D137; the whole boot is recorded) and
// nothing is logged as an error. Runs in every project (desktop, mobile emulation, WebKit), so it
// forces no backend.

/** Session download budget of brief l.258, bytes on the wire (the catalogs are about 3.96 MB). */
const DOWNLOAD_BUDGET_BYTES = 6_000_000;

/** Console errors and uncaught exceptions of the page, collected from the first navigation. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    errors.push(error.message);
  });
  return errors;
}

// The first frame under SwiftShader (headless WebGL2 without a GPU) uploads 471,820 star
// vertices and compiles the shaders: well over the 30 s default.
test.describe.configure({ timeout: 180_000 });

test('the shell loads, the API is proxied and the sky reaches its first frame', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');

  await expect(page).toHaveTitle(/InterSidera/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('InterSidera');
  await expect(page.getByLabel('Sky view')).toBeVisible();

  // `/api` reaches FastAPI through the Vite preview proxy; `degraded` is the CI answer (the e2e
  // data set has no MPC tables, docs/testing.md).
  const res = await page.request.get('/api/v1/health');
  expect(res.ok()).toBeTruthy();
  // `res.json()` is `any`; type it as unknown so strictTypeChecked's no-unsafe-* rules stay green.
  const body: unknown = await res.json();
  expect(body).toMatchObject({ status: expect.stringMatching(/^(ready|degraded)$/) });

  // The debug hook exists in this e2e build only (brief l.410); its `isReady` flips after the
  // catalog and the first frame window are rendered.
  await page.waitForFunction(() => window.__sky?.isReady === true, undefined, {
    timeout: 120_000,
    polling: 250,
  });
  // The hook is typed by the global augmentation the type import above brings in.
  const backend: SkyDebugApi['backend'] | null = await page.evaluate(
    () => window.__sky?.backend ?? null,
  );
  expect(backend).toMatch(/^(webgl2|webgpu)$/);
  // The splash (the status region named "Loading the sky") is gone; the M4 chrome keeps other
  // status regions (hint, toasts), whose naming rule lives in a11y.spec.ts.
  await expect(page.getByRole('status', { name: 'Loading the sky' })).toHaveCount(0);

  // Session download (brief l.258, plan D137): the Resource Timing rows of this cold document
  // sum the catalogs on the wire (the SKYS is served uncompressed, backlog B-46: float32 unit
  // vectors do not compress) under the budget; the whole boot is recorded for docs/testing.md.
  const rows = await page.evaluate(() => window.__sky?.resources() ?? []);
  const catalogs = rows.filter((row) => row.name.startsWith('/api/v1/catalogs/'));
  expect(catalogs.map((row) => row.name)).toEqual(
    expect.arrayContaining(['/api/v1/catalogs/stars', '/api/v1/catalogs/stars/index']),
  );
  const catalogBytes = catalogs.reduce((sum, row) => sum + row.transferSize, 0);
  expect(catalogBytes).toBeGreaterThan(0);
  expect(catalogBytes).toBeLessThanOrEqual(DOWNLOAD_BUDGET_BYTES);
  const timing = await page.evaluate(() => window.__sky?.timing() ?? null);
  const bootBytes =
    rows.reduce((sum, row) => sum + row.transferSize, 0) + (timing?.navigation?.transferSize ?? 0);
  test.info().annotations.push({
    type: 'download-bytes',
    description: `catalogs ${String(catalogBytes)} B, whole boot ${String(bootBytes)} B (${String(rows.length)} resources)`,
  });
  expect(errors).toEqual([]);
});
