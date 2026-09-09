// Shared helpers of the rendering sanity specs (engine.spec.ts on WebGL2, webgpu.spec.ts on
// WebGPU; brief l.410, l.466; plan D89). Everything handed to `page.evaluate` runs inside the page:
// those functions cannot close over this file and reach the hook through `window.__sky` directly.
// The only import from `src/` is the hook's type, with an explicit extension (tsconfig.node.json).

import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { SkyDebugApi } from '../src/debug/skyDebugApi.ts';

export type Engine = 'webgl2' | 'webgpu';

export const LAT = 51.48;
/** 2024-04-08 18:00 TT: Jupiter in the western evening sky from Greenwich. */
export const TT_FIXED = 2460409.25;
/** 0.7 s later, so the probe never lands on a frame sample and interpolation is exercised. */
export const TT_PROBE = TT_FIXED + 0.7 / 86400;
export const PLANETS = ['jupiter', 'mars', 'mercury', 'saturn', 'venus'];
/** Sirius, the brightest star, 21.6 degrees up from Greenwich at the probe instant. */
export const BRIGHT_STAR = 'hip:32349';
/** Field of view for the pixel probes: a star or a planet disc covers a few pixels at 20 degrees. */
export const PROBE_FOV = 20;
/** Side of the screenshot patch around the canvas centre, CSS pixels. */
const PATCH_PX = 24;
/** A rendered target peaks above this on some channel; the patch around it stays dark elsewhere. */
export const LIT_MIN = 128;
export const DARK_MAX = 40;
export const ARCMIN_DEG = 1 / 60;
const DEG = Math.PI / 180;

export interface AltAzRow {
  id: string;
  alt_deg: number;
  az_deg: number;
}

export interface AltAz {
  alt: number;
  az: number;
}

export type RenderedAltAz = NonNullable<ReturnType<SkyDebugApi['altAzOf']>>;
export type DebugState = ReturnType<SkyDebugApi['state']>;

export function isAltAzRow(value: unknown): value is AltAzRow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === 'string' && typeof row.alt_deg === 'number' && typeof row.az_deg === 'number'
  );
}

/** Angle between two horizon directions, degrees, through the unit vectors (no `acos` loss). */
export function separationDeg(a: AltAz, b: AltAz): number {
  const toUnit = (p: AltAz): [number, number, number] => {
    const alt = p.alt * DEG;
    const az = p.az * DEG;
    return [Math.cos(alt) * Math.sin(az), Math.cos(alt) * Math.cos(az), Math.sin(alt)];
  };
  const [ax, ay, az] = toUnit(a);
  const [bx, by, bz] = toUnit(b);
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  return Math.atan2(Math.hypot(cx, cy, cz), ax * bx + ay * by + az * bz) / DEG;
}

/**
 * Greenwich, paused at `TT_FIXED`, looking north at 45 degrees; the backend forced by the hash.
 * The atmosphere is off: the Sun is up at `TT_FIXED` and daylight would cull the probe stars.
 */
export function appUrl(engine: Engine, refraction: boolean): string {
  return `/?body=earth&lat=${String(LAT)}&lon=0&elev=0&t=${String(TT_FIXED)}&speed=0&az=0&alt=45&fov=60&atm=0&refr=${refraction ? '1' : '0'}#engine=${engine}`;
}

/** `null` from the page means the hook is absent or the target unknown: both fail the test. */
export function required<T>(value: T | null, what: string): T {
  if (value === null) {
    throw new Error(`${what}: the debug hook answered null`);
  }
  return value;
}

/** Console errors and uncaught exceptions of the page. */
export function collectErrors(page: Page): string[] {
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

/**
 * HTTP(S) requests to any host other than the app's own (OBS-7, brief l.196: the position leaves
 * the browser toward the API alone) and the hostnames in `allow` (the geocoder a test stubs).
 */
export function collectForeignRequests(
  page: Page,
  options: { allow?: readonly string[] } = {},
): string[] {
  const allowed = new Set(['127.0.0.1', ...(options.allow ?? [])]);
  const foreign: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !allowed.has(url.hostname)) {
      foreign.push(request.url());
    }
  });
  return foreign;
}

/** `/api/v1/meta` as the API serves it; callers validate the shape they read. */
export async function metaOf(page: Page): Promise<unknown> {
  const res = await page.request.get('/api/v1/meta');
  expect(res.ok()).toBeTruthy();
  return res.json() as Promise<unknown>;
}

export async function waitReady(page: Page, timeout = 120_000): Promise<void> {
  await page.waitForFunction(() => window.__sky?.isReady === true, undefined, {
    timeout,
    polling: 250,
  });
}

export async function backendOf(page: Page): Promise<string | null> {
  return page.evaluate(() => window.__sky?.backend ?? null);
}

export async function debugState(page: Page): Promise<DebugState> {
  return required(await page.evaluate(() => window.__sky?.state() ?? null), 'state()');
}

export async function altAzOf(page: Page, id: string): Promise<RenderedAltAz> {
  return required(
    await page.evaluate((target) => window.__sky?.altAzOf(target) ?? null, id),
    `altAzOf(${id})`,
  );
}

/** Pause the simulation at `tt` and wait until the engine has rendered a frame at that instant. */
export async function renderAt(page: Page, tt: number): Promise<void> {
  await page.evaluate((target) => {
    window.__sky?.setTime(target);
  }, tt);
  await page.evaluate(() => window.__sky?.waitForFrame());
  // `state().tt` is the instant of the last render tick, which also evaluated the directions
  // `altAzOf` reads (SkyEngine.tick), so the probe below sees the requested time.
  await page.waitForFunction(
    (target) => Math.abs((window.__sky?.state().tt ?? NaN) - target) < 1e-7,
    tt,
    { timeout: 30_000, polling: 100 },
  );
}

/** The authoritative rows of `/sky/altaz` for the probe planets from Greenwich at `tt`. */
export async function authoritativeAltAz(
  page: Page,
  tt: number,
  refraction: boolean,
): Promise<AltAzRow[]> {
  const query = new URLSearchParams({
    body: 'earth',
    lat: String(LAT),
    lon: '0',
    elev: '0',
    tt: String(tt),
    targets: PLANETS.join(','),
    refraction: refraction ? '1' : '0',
  });
  const res = await page.request.get(`/api/v1/sky/altaz?${query.toString()}`);
  expect(res.ok()).toBeTruthy();
  const body: unknown = await res.json();
  if (!Array.isArray(body) || !body.every(isAltAzRow)) {
    throw new Error('unexpected /sky/altaz body');
  }
  return body;
}

/** The highest planet above 10 degrees: unambiguous, and clear of the horizon refraction ramp. */
export function pickTarget(rows: AltAzRow[]): AltAzRow {
  const candidates = rows.filter((row) => row.alt_deg > 10).sort((a, b) => b.alt_deg - a.alt_deg);
  const target = candidates[0];
  if (target === undefined) {
    throw new Error('no planet above 10 degrees at the probe instant');
  }
  return target;
}

export async function canvasBox(page: Page): Promise<{ width: number; height: number }> {
  const box = await page.getByLabel('Sky view').boundingBox();
  if (box === null) {
    throw new Error('the canvas has no bounding box');
  }
  return box;
}

export interface CentrePatch {
  /** Brightest pixel, max over r, g, b. */
  max: number;
  /** Darkest pixel, max over r, g, b. */
  min: number;
  /** Per-channel maxima (night mode keeps red alone, plan D108). */
  maxR: number;
  maxG: number;
  maxB: number;
}

/**
 * Brightest and darkest pixels (max over r, g, b) and the per-channel maxima of a `PATCH_PX`
 * square around the canvas centre, read from a screenshot decoded inside the page (a 2D canvas,
 * so no PNG library; plan D89 pixel probe). Works on both backends, which `screenOf` alone cannot
 * prove: it is a pure projection.
 */
export async function centrePatch(page: Page): Promise<CentrePatch> {
  const box = await page.getByLabel('Sky view').boundingBox();
  if (box === null) {
    throw new Error('the canvas has no bounding box');
  }
  const png = await page.screenshot({
    clip: {
      x: box.x + (box.width - PATCH_PX) / 2,
      y: box.y + (box.height - PATCH_PX) / 2,
      width: PATCH_PX,
      height: PATCH_PX,
    },
  });
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (context === null) {
      throw new Error('no 2D context to decode the screenshot');
    }
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let max = 0;
    let min = 255;
    let maxR = 0;
    let maxG = 0;
    let maxB = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      const value = Math.max(r, g, b);
      max = Math.max(max, value);
      min = Math.min(min, value);
      maxR = Math.max(maxR, r);
      maxG = Math.max(maxG, g);
      maxB = Math.max(maxB, b);
    }
    return { max, min, maxR, maxG, maxB };
  }, png.toString('base64'));
}

/**
 * Centre the view on a target at `PROBE_FOV` and check that something bright is drawn there and
 * that the patch is otherwise dark (a uniformly lit canvas fails too). Polled: `setView` lands on
 * the next render tick.
 */
export async function expectRendered(page: Page, id: string): Promise<void> {
  const rendered = await altAzOf(page, id);
  await page.evaluate(
    ({ az, alt, fov }) => {
      window.__sky?.setView(az, alt, fov);
    },
    { az: rendered.az, alt: rendered.alt, fov: PROBE_FOV },
  );
  await expect
    .poll(async () => (await centrePatch(page)).max, { timeout: 10_000 })
    .toBeGreaterThan(LIT_MIN);
  expect((await centrePatch(page)).min).toBeLessThan(DARK_MAX);
}

/**
 * The sanity checks shared by both backends: Polaris against the latitude, the highest planet
 * against `/sky/altaz` at an off-grid instant (with the requested refraction), the projection of
 * that planet at the canvas centre, and the pixel probes on a bright star and on the planet.
 */
export async function runSanityChecks(page: Page, refraction: boolean): Promise<void> {
  const state = await debugState(page);
  expect(state.refr).toBe(refraction);
  expect(state.catalogs.stars).toBeGreaterThan(100_000);

  // Polaris (HIP 11767) stands about 0.7 degrees from the pole: its altitude is the latitude.
  const polaris = await altAzOf(page, 'hip:11767');
  expect(Math.abs(polaris.alt - LAT)).toBeLessThan(1);

  await renderAt(page, TT_PROBE);
  expect(Math.abs((await debugState(page)).tt - TT_PROBE)).toBeLessThan(1e-7);

  const rows = await authoritativeAltAz(page, TT_PROBE, refraction);
  const target = pickTarget(rows);
  const rendered = await altAzOf(page, target.id);
  // `alt` is what the engine draws: refracted when the URL asks for it, geometric otherwise.
  const separation = separationDeg(
    { alt: rendered.alt, az: rendered.az },
    { alt: target.alt_deg, az: target.az_deg },
  );
  expect(separation).toBeLessThanOrEqual(ARCMIN_DEG);
  if (refraction) {
    // Refraction lifts a planet at 30 degrees by about 1.7 arcmin: the two altitudes differ.
    expect(rendered.alt).toBeGreaterThan(rendered.altTrue);
  } else {
    expect(rendered.alt).toBe(rendered.altTrue);
  }

  // Centre the view on the target: its screen position is the middle of the canvas.
  await page.evaluate(
    ({ az, alt }) => {
      window.__sky?.setView(az, alt);
    },
    { az: target.az_deg, alt: target.alt_deg },
  );
  const screen = required(
    await page.evaluate((id) => window.__sky?.screenOf(id) ?? null, target.id),
    `screenOf(${target.id})`,
  );
  const box = await canvasBox(page);
  expect(screen.x).toBeGreaterThanOrEqual(0);
  expect(screen.x).toBeLessThanOrEqual(box.width);
  expect(screen.y).toBeGreaterThanOrEqual(0);
  expect(screen.y).toBeLessThanOrEqual(box.height);
  expect(Math.abs(screen.x - box.width / 2)).toBeLessThan(3);
  expect(Math.abs(screen.y - box.height / 2)).toBeLessThan(3);

  // Pixel probes (plan D89): the star shader draws a bright star, the bodies shader draws the
  // planet lit (every outer planet is at least 99 % illuminated from Earth, brief SKY-2).
  await expectRendered(page, BRIGHT_STAR);
  await expectRendered(page, target.id);
}

/**
 * Select a tab of the control panel (VIEW-5): on the phone the bottom sheet is expanded first
 * through its handle (the tabs live in the collapsed body), on the desktop the column is always
 * open; the tab panel is visible afterwards. Same as `openPanelTab` without the returned panel.
 */
export async function openTab(page: Page, name: string): Promise<void> {
  await openPanelTab(page, name);
}

/** Move the focus off any control so the single-key shortcuts reach the window. */
export async function blurActiveElement(page: Page): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      active.blur();
    }
  });
}

/**
 * Open a control-panel tab and return its (visible) panel: on the phone layout the bottom sheet
 * is collapsed until its handle is tapped (VIEW-5, plan D112), on the desktop the tabs are
 * visible.
 */
export async function openPanelTab(page: Page, name: string | RegExp): Promise<Locator> {
  const handle = page.getByRole('button', { name: /Expand the control panel|Déployer le panneau/ });
  if (await handle.isVisible()) {
    await handle.click();
  }
  await page.getByRole('tab', { name }).click();
  const panel = page.getByRole('tabpanel', { name });
  await expect(panel).toBeVisible();
  return panel;
}

/** The `dd` text next to a `dt` label inside a description list (the details panel rows). */
export function definitionOf(panel: Locator, label: string): Locator {
  return panel.locator('dt', { hasText: label }).locator('xpath=following-sibling::dd[1]');
}

/** `21.63°` or `21,63°` (French) -> 21.63; throws on anything else. */
export function parseDegrees(text: string): number {
  const match = /(-?\d+(?:[.,]\d+)?)\s*°/.exec(text);
  const degrees = match?.[1];
  if (degrees === undefined) {
    throw new Error(`no degrees in ${JSON.stringify(text)}`);
  }
  return Number(degrees.replace(',', '.'));
}
