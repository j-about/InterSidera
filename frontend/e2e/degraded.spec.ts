import { expect, test } from '@playwright/test';

import { appUrl, collectErrors, debugState, waitReady } from './support.ts';

// Degraded states after boot (UX-6, plan D111, D113): when `/sky/frame` stops answering while
// time plays, the client retries inside its own policy first (up to 7.5 s), then the frame
// controller publishes `frames.failing` and the alert banner appears with its retry button;
// once the API answers again "retry now" clears it. A `/meta` announcing another star-catalog
// ETag than the one served marks the catalog stale and prompts a reload. The splash of the boot
// itself is smoke.spec.ts' business.

const ENGINE = 'webgl2';
const FRAME_ROUTE = '**/api/v1/sky/frame*';

test.describe.configure({ timeout: 180_000 });

test('an unreachable API raises the retry alert; a stale catalog prompts a reload', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto(appUrl(ENGINE, false));
  await waitReady(page);

  await test.step('aborted frame requests -> alert within 30 s; retry now re-issues at once', async () => {
    let aborted = 0;
    await page.route(FRAME_ROUTE, (route) => {
      aborted += 1;
      return route.abort();
    });
    // A speed jump of more than 10x invalidates the buffer: a request leaves at once (D76).
    await page.evaluate(() => {
      window.__sky?.play(3600);
    });
    const alert = page.getByRole('alert', { name: 'Sky service unreachable' });
    await expect(alert).toBeVisible({ timeout: 30_000 });
    await expect(alert).toContainText(/retrying in \d+ s/);
    expect((await debugState(page)).mode).toBe('playing');

    // "Retry now" ends the backoff: a new request leaves within a second while the route still
    // refuses (clicking after `unroute` would race the natural recovery, which clears the alert
    // by itself as soon as a retry succeeds).
    const before = aborted;
    await alert.getByRole('button', { name: 'Retry now' }).click();
    await expect.poll(() => aborted, { timeout: 5000 }).toBeGreaterThan(before);

    // The API answers again: the next retry settles a window and the alert goes away.
    await page.unroute(FRAME_ROUTE);
    await expect(alert).toBeHidden({ timeout: 45_000 });
    await page.evaluate(() => {
      window.__sky?.pause();
    });
  });

  await test.step('a /meta with another star ETag -> the reload prompt', async () => {
    await page.route('**/api/v1/meta', async (route) => {
      const response = await route.fetch();
      const body: unknown = await response.json();
      const meta = body as { catalogs: { stars: { etag: string } } };
      meta.catalogs.stars.etag = 'not-the-served-artifact';
      await route.fulfill({ response, json: meta });
    });
    await page.reload();
    await waitReady(page);
    const status = page.getByRole('status', { name: 'Catalogs updated' });
    await expect(status).toBeVisible({ timeout: 30_000 });
    await expect(status).toContainText('newer catalogs');
    await expect(status.getByRole('button', { name: 'Reload' })).toBeVisible();
    await page.unroute('**/api/v1/meta');
  });

  // The aborted requests are Chromium's own "Failed to load resource" console lines; the page
  // itself reports them as network failures and logs nothing.
  expect(errors.filter((line) => !line.startsWith('Failed to load resource'))).toEqual([]);
});
