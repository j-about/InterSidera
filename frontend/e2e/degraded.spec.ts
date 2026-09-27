import { expect, test } from './fixtures.ts';

import type { Page } from '@playwright/test';

import { appUrl, collectErrors, debugState, waitReady } from './support.ts';

// Degraded states after boot (UX-6, plan D111, D113): when `/sky/frame` stops answering while
// time plays, the frame controller publishes `frames.failing` from the client's FIRST retry
// (plan R70: the client's own ladder used to run for up to 7.5 s before the banner learnt of
// it) and the alert banner appears with its retry button; once the API answers again "retry
// now" clears it. A `/meta` announcing another star-catalog ETag than the one served marks the
// catalog stale and prompts a reload. The boot's own error paths (plan D163): E1 a browser
// without WebGL2 (and no WebGPU) shows `engine.unsupported` on the splash; E2 a first frame
// refused for good (a 422 problem) shows `boot.failed` with the status and stops asking. The
// happy splash is smoke.spec.ts' business.

const ENGINE = 'webgl2';
const FRAME_ROUTE = '**/api/v1/sky/frame*';
/** The splash region (`BootStatus`, `aria-label` = `boot.label`). */
const SPLASH = 'Loading the sky';
/** Chromium's own console line for a request that failed or was answered with an error status. */
const RESOURCE_LINE = 'Failed to load resource';

test.describe.configure({ timeout: 180_000 });

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

test('an unreachable API raises the retry alert; a stale catalog prompts a reload', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto(appUrl(ENGINE, false));
  await waitReady(page);

  await test.step('aborted frame requests -> alert within 10 s from the first retry; retry now re-issues at once', async () => {
    let aborted = 0;
    await page.route(FRAME_ROUTE, (route) => {
      aborted += 1;
      return route.abort();
    });
    // A speed jump of more than 10x invalidates the buffer: a request leaves at once (D76).
    await page.evaluate(() => {
      window.__sky?.play(3600);
    });
    // Plan R70: the first failed attempt (0.5 s of client backoff) already publishes
    // `frames.failing`, so the alert stands within a couple of seconds, not after the 7.5 s
    // ladder; the hook mirrors the store's `failing` with its attempt count.
    const alert = page.getByRole('alert', { name: 'Sky service unreachable' });
    await expect(alert).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(async () => (await debugState(page)).failing?.attempts ?? 0, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);
    const failing = (await debugState(page)).failing;
    expect(failing).not.toBeNull();
    expect(failing?.status).toBe(0);
    expect(failing?.nextRetryMs ?? 0).toBeGreaterThan(0);
    // The seconds are followed by a no-break space (French-style unit spacing, plan D158); a
    // regular-expression expectation is not whitespace-normalised, a string one would be.
    await expect(alert).toContainText(/retrying in \d+\u00a0s/);
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
  expect(errors.filter((line) => !line.startsWith(RESOURCE_LINE))).toEqual([]);
});

test('a browser without WebGL2 or WebGPU shows the unsupported message on the splash (UX-6, E1)', async ({
  page,
}) => {
  const errors = collectErrors(page);
  // Every 3D context is refused and `navigator.gpu` is gone (an init script runs before the
  // page's own code): Babylon throws "WebGL not supported", `createEngine` maps it to
  // `WebGL2UnavailableError` and the boot ends in `engine.unsupported`. The 2D context stays
  // (the label layer measures text with it).
  await page.addInitScript(() => {
    const proto = HTMLCanvasElement.prototype;
    // The original through its descriptor (a bare method reference is an unbound-method lint).
    const original: unknown = Object.getOwnPropertyDescriptor(proto, 'getContext')?.value;
    if (typeof original !== 'function') {
      throw new Error('HTMLCanvasElement.prototype.getContext is not a function');
    }
    const refused = new Set(['webgl2', 'webgl', 'experimental-webgl', 'webgpu']);
    Object.defineProperty(proto, 'getContext', {
      configurable: true,
      writable: true,
      value: function getContext(
        this: HTMLCanvasElement,
        contextId: string,
        ...rest: unknown[]
      ): unknown {
        if (refused.has(contextId)) {
          return null;
        }
        const context: unknown = Reflect.apply(original, this, [contextId, ...rest]);
        return context;
      },
    });
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
  });
  await page.goto(appUrl(ENGINE, false));
  const splash = page.getByRole('status', { name: SPLASH });
  await expect(splash).toContainText('neither WebGPU nor WebGL2', { timeout: 60_000 });
  await expect(splash).toContainText('hardware acceleration');
  // The engine never came up: the hook (installed by the engine) is absent or never ready.
  expect(await page.evaluate(() => window.__sky?.isReady ?? false)).toBe(false);
  await expect(page.getByLabel('Sky view')).toHaveCount(1);
  // Babylon reports the missing context on the console before throwing; nothing else may.
  expect(errors.filter((line) => !line.includes('WebGL not supported'))).toEqual([]);
});

test('a first frame refused for good shows the HTTP status on the splash and stops asking (UX-6, E2)', async ({
  page,
}) => {
  const errors = collectErrors(page);
  const frameRequests = collectFrameRequests(page);
  // A coverage range far from the requested instant: the controller stops the clock at the
  // bound, refetches flush with it, is refused again and blocks the shape (plan D76); the boot
  // sees the blocked first frame as `FirstFrameError` -> `boot.failed` with `HTTP 422`.
  await page.route(FRAME_ROUTE, (route) =>
    route.fulfill({
      status: 422,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'https://github.com/j-about/InterSidera/blob/master/docs/api.md#problem-outside-coverage',
        title: 'Outside data coverage',
        status: 422,
        detail: 'refused by the test route',
        instance: '/api/v1/sky/frame',
        range_tt: [2400000.5, 2450000.5],
      }),
    }),
  );
  await page.goto(appUrl(ENGINE, false));
  const splash = page.getByRole('status', { name: SPLASH });
  await expect(splash).toContainText('The sky service failed: HTTP 422', { timeout: 60_000 });
  expect(await page.evaluate(() => window.__sky?.isReady ?? false)).toBe(false);
  // No endless frame phase: the refused shape is not asked for again (at most the request at
  // the requested instant and the one flush with the announced bound).
  const settled = frameRequests.length;
  expect(settled).toBeGreaterThanOrEqual(1);
  expect(settled).toBeLessThanOrEqual(2);
  await page.waitForTimeout(2000);
  expect(frameRequests.length).toBe(settled);
  // The 422 answers are Chromium's own resource lines; the page logs nothing of its own.
  expect(errors.filter((line) => !line.startsWith(RESOURCE_LINE))).toEqual([]);
});
