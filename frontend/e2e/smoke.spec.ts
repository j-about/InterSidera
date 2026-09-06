import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { SkyDebugApi } from '../src/debug/skyDebugApi.ts';

// Load smoke (brief l.410, l.442; plan D89): the shell renders, the canvas is on screen, `/api`
// is proxied through `vite preview`, the sky reaches its first frame and nothing is logged as an
// error. Runs in every project (desktop, mobile emulation, WebKit), so it forces no backend.

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
  await expect(page.getByRole('status')).toHaveCount(0);
  expect(errors).toEqual([]);
});
