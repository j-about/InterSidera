import { readFile } from 'node:fs/promises';

import { expect, readCspViolations, resetCspViolations, test } from './fixtures.ts';
import type { Page } from '@playwright/test';
import { securityHeaders } from '../security-headers.ts';
import { appUrl, metaOf, waitReady } from './support.ts';

// The security headers and the Content-Security-Policy of the web tier (plan D147, D153; brief
// l.274, l.580, l.585), proven against `vite preview` on both CI projects. (a) The exact header
// set of security-headers.ts on the document, the entry script, the manifest and the favicon,
// with `connect-src` naming the geocoder origin the API advertises through `/meta` (the drift
// guard between `SKY_GEOCODER_ORIGIN` and `SKYAPI_GEOCODER_URL`, risk R104). (c) The PNG export
// against the real engine (VIEW-6, plan D112; the M4 gap of docs/testing.md): a real download
// under the policy, its file name, PNG signature, weight and an IHDR equal to the engine's own
// render target as the hook reports it (`stats().renderWidth/renderHeight`, never a recomputation
// of the DPR cap in the spec). (b) Last, the
// negative control: a `data:` image that `img-src 'self'` refuses, recorded exactly once by the
// `cspViolations` fixture of fixtures.ts (the collector every spec relies on), then reset. The
// console is recorded from the first navigation: the final `Permissions-Policy` list must draw no
// warning (risk R102) and the only error line allowed is Chromium's report of that refusal.

const ENGINE = 'webgl2';
/** `intersidera-YYYY-MM-DDTHHMMSSZ.png` (ui/shell/ExportButton.tsx::snapshotFilename). */
const FILENAME = /^intersidera-\d{4}-\d{2}-\d{2}T\d{6}Z\.png$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A 1x1 PNG the negative control tries to load from a `data:` URL. */
const DATA_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test.describe.configure({ timeout: 180_000 });

interface ConsoleRecord {
  type: string;
  text: string;
}

/** Every console message and uncaught exception of the page, with its type. */
function collectConsole(page: Page): ConsoleRecord[] {
  const records: ConsoleRecord[] = [];
  page.on('console', (message) => {
    records.push({ type: message.type(), text: message.text() });
  });
  page.on('pageerror', (error) => {
    records.push({ type: 'pageerror', text: error.message });
  });
  return records;
}

function geocoderUrlOf(meta: unknown): string {
  if (typeof meta !== 'object' || meta === null) {
    throw new Error('unexpected /meta shape');
  }
  const geocoder = (meta as Record<string, unknown>).geocoder;
  const url =
    typeof geocoder === 'object' && geocoder !== null
      ? (geocoder as Record<string, unknown>).url
      : undefined;
  if (typeof url !== 'string' || url === '') {
    throw new Error('unexpected /meta.geocoder shape');
  }
  return url;
}

/** Every header of `expected` with its exact value, and no report-only twin (lower-cased keys). */
function expectSecurityHeaders(
  headers: Record<string, string>,
  expected: Record<string, string>,
  what: string,
): void {
  for (const [name, value] of Object.entries(expected)) {
    expect(headers[name.toLowerCase()], `${what}: ${name}`).toBe(value);
  }
  expect(headers['content-security-policy-report-only'], what).toBeUndefined();
}

async function expectHeadersOn(
  page: Page,
  path: string,
  expected: Record<string, string>,
): Promise<void> {
  const res = await page.request.get(path);
  expect(res.ok(), path).toBeTruthy();
  expectSecurityHeaders(res.headers(), expected, path);
}

test('security headers, the PNG export under the policy and the violation collector', async ({
  page,
  cspViolations,
}) => {
  const records = collectConsole(page);
  const geocoderOrigin = new URL(geocoderUrlOf(await metaOf(page))).origin;
  const expected = securityHeaders({ geocoderOrigin });

  await test.step('(a) the exact header set on the document, the entry script, the manifest and the favicon', async () => {
    const document = await page.request.get('/');
    expect(document.ok()).toBeTruthy();
    expectSecurityHeaders(document.headers(), expected, '/');
    expect(expected['Content-Security-Policy']).toContain(`connect-src 'self' ${geocoderOrigin}`);
    // The built index.html carries one module script: the entry chunk under /assets/.
    const entry = /<script type="module" crossorigin src="(\/assets\/[^"]+\.js)"/.exec(
      await document.text(),
    )?.[1];
    if (entry === undefined) {
      throw new Error('index.html has no /assets/ entry script');
    }
    for (const path of [entry, '/manifest.webmanifest', '/favicon.svg']) {
      await expectHeadersOn(page, path, expected);
    }
    // The SPA fallback (a deep link) is index.html again, with the same headers.
    await expectHeadersOn(page, '/nowhere', expected);
  });

  await test.step('(c) the PNG export: a real download of the rendered frame', async () => {
    await page.goto(appUrl(ENGINE, false));
    await waitReady(page);
    const canvas = page.getByLabel('Sky view');
    await expect(canvas).toBeVisible();
    // The backing store the engine renders into, in device pixels (`EnginePerf.renderTarget()`
    // through the hook): the snapshot reads that canvas back, so the PNG is exactly that size.
    const target = await page.evaluate(() => {
      const stats = window.__sky?.stats();
      return stats === undefined ? null : { width: stats.renderWidth, height: stats.renderHeight };
    });
    if (target === null) {
      throw new Error('the debug hook is missing');
    }
    expect(target.width).toBeGreaterThan(0);
    expect(target.height).toBeGreaterThan(0);

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export the view as PNG' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(FILENAME);
    const bytes = await readFile(await download.path());

    expect(bytes.length).toBeGreaterThan(10_000);
    expect(bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)).toBe(true);
    // The IHDR chunk follows the signature: length (4), type (4), width (4), height (4).
    expect(bytes.toString('latin1', 12, 16)).toBe('IHDR');
    expect(bytes.readUInt32BE(16)).toBe(target.width);
    expect(bytes.readUInt32BE(20)).toBe(target.height);
    // The download anchor is a `blob:` URL and the export a canvas read-back: no violation.
    expect(cspViolations).toEqual([]);
    expect(await readCspViolations(page)).toEqual([]);
  });

  await test.step('the console is clean under the final Permissions-Policy', () => {
    expect(records.filter((record) => /permissions-policy/i.test(record.text))).toEqual([]);
    expect(
      records.filter((record) => record.type === 'error' || record.type === 'pageerror'),
    ).toEqual([]);
  });

  await test.step('(b) the negative control: a data: image is refused and recorded once', async () => {
    await page.evaluate((src) => {
      const image = document.createElement('img');
      image.alt = '';
      image.src = src;
      document.body.append(image);
    }, DATA_PNG);
    await expect.poll(() => cspViolations.length, { timeout: 10_000 }).toBe(1);
    const expectedRecord = expect.objectContaining({
      effectiveDirective: 'img-src',
      blockedURI: 'data',
      disposition: 'enforce',
    }) as unknown;
    expect(cspViolations).toEqual([expectedRecord]);
    // The document's own copy carries the same record.
    expect(await readCspViolations(page)).toEqual([expectedRecord]);
    // Chromium reports the refusal on the console too: exactly that line, nothing else. Its
    // wording moved from "Refused to load the image '...' because it violates" to "Loading the
    // image '...' violates" (Chromium 153); the blocked `data:` image and the directive are the
    // stable parts.
    const errors = records.filter(
      (record) => record.type === 'error' || record.type === 'pageerror',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.text).toMatch(
      /the image 'data:image\/png;base64,[^']*'.* violates the following Content Security Policy directive: "img-src 'self'"/,
    );

    await resetCspViolations(page, cspViolations);
    expect(cspViolations).toEqual([]);
    expect(await readCspViolations(page)).toEqual([]);
  });
});
