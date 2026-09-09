import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  PLANETS,
  TT_PROBE,
  altAzOf,
  appUrl,
  authoritativeAltAz,
  canvasBox,
  collectErrors,
  collectForeignRequests,
  debugState,
  metaOf,
  pickTarget,
  renderAt,
  required,
  waitReady,
} from './support.ts';

// Selection, picking and follow mode (INFO-1, VIEW-4; plan D106, D113): a tap on a planet
// selects it (`sel` in the URL, the marker in the overlay), `pick` answers the same id, a tap on
// an empty region deselects, follow mode keeps the selection at the canvas centre while the clock
// runs; the minor-body branch follows `/meta` (MPC present locally, absent in CI) instead of
// skipping. Page-side functions reach the hook through `window.__sky` directly.

const ENGINE = 'webgl2';
/** The centre stays within this many CSS pixels of the followed object. */
const FOLLOW_TOLERANCE_PX = 3;

test.describe.configure({ timeout: 180_000 });

async function screenOf(page: Page, id: string): Promise<{ x: number; y: number }> {
  return required(
    await page.evaluate((target) => window.__sky?.screenOf(target) ?? null, id),
    `screenOf(${id})`,
  );
}

/** A tap at canvas coordinates: touch on the mobile project, a click elsewhere. */
async function tapCanvas(page: Page, x: number, y: number, isMobile: boolean): Promise<void> {
  const box = await page.getByLabel('Sky view').boundingBox();
  if (box === null) {
    throw new Error('the canvas has no bounding box');
  }
  const pageX = box.x + x;
  const pageY = box.y + y;
  if (isMobile) {
    await page.touchscreen.tap(pageX, pageY);
  } else {
    await page.mouse.click(pageX, pageY);
  }
}

function selParam(page: Page): string | null {
  return new URL(page.url()).searchParams.get('sel');
}

test('a tap selects the planet under it, the marker follows, and follow mode keeps it centred', async ({
  page,
  isMobile,
}) => {
  const errors = collectErrors(page);
  const foreign = collectForeignRequests(page);
  await page.goto(appUrl(ENGINE, true));
  await waitReady(page);
  await renderAt(page, TT_PROBE);
  const rows = await authoritativeAltAz(page, TT_PROBE, true);
  const target = pickTarget(rows);

  await test.step('tap on the planet -> sel in the URL and a visible marker', async () => {
    const rendered = await altAzOf(page, target.id);
    await page.evaluate(
      ({ az, alt }) => {
        window.__sky?.setView(az, alt, 20);
      },
      { az: rendered.az, alt: rendered.alt },
    );
    const point = await screenOf(page, target.id);
    await tapCanvas(page, point.x, point.y, isMobile);
    await expect.poll(() => selParam(page), { timeout: 5000 }).toBe(target.id);
    expect((await debugState(page)).sel).toBe(target.id);
    const marker = page.locator('[data-marker]');
    await expect(marker).toBeVisible({ timeout: 5000 });
    expect(await marker.getAttribute('data-marker-id')).toBe(target.id);
  });

  await test.step('pick() answers the same id at the same point', async () => {
    const point = await screenOf(page, target.id);
    const picked = await page.evaluate(({ x, y }) => window.__sky?.pick(x, y) ?? null, {
      x: point.x,
      y: point.y,
    });
    expect(picked).toBe(target.id);
  });

  await test.step('a tap on an empty region deselects', async () => {
    // At fov 20 the 24 px tolerance spans 0.6 degrees and a random point usually lands on a faint
    // star; at fov 2 it spans 0.06 degrees, so a grid of candidates finds an empty one.
    await page.evaluate(() => {
      window.__sky?.setView(0, 45, 2);
    });
    const box = await canvasBox(page);
    let empty: { x: number; y: number } | null = null;
    for (const fy of [0.2, 0.5, 0.8]) {
      for (const fx of [0.15, 0.35, 0.65, 0.85]) {
        const candidate = { x: box.width * fx, y: box.height * fy };
        const picked = await page.evaluate(
          ({ x, y }) => window.__sky?.pick(x, y) ?? null,
          candidate,
        );
        if (picked === null) {
          empty = candidate;
          break;
        }
      }
      if (empty !== null) {
        break;
      }
    }
    const point = required(empty, 'an empty region of the canvas');
    await tapCanvas(page, point.x, point.y, isMobile);
    await expect.poll(() => selParam(page), { timeout: 5000 }).toBeNull();
    await expect(page.locator('[data-marker]')).toBeHidden({ timeout: 5000 });
  });

  await test.step('follow mode keeps the selection at the centre while time runs', async () => {
    // A tap selects first, then follow is armed (a tap keeps follow mode; a drag, a pinch or a
    // double tap ends it, plan D106).
    const rendered = await altAzOf(page, target.id);
    await page.evaluate(
      ({ az, alt }) => {
        window.__sky?.setView(az, alt, 20);
      },
      { az: rendered.az, alt: rendered.alt },
    );
    const point = await screenOf(page, target.id);
    await tapCanvas(page, point.x, point.y, isMobile);
    await expect.poll(() => selParam(page), { timeout: 5000 }).toBe(target.id);
    await page.evaluate(() => {
      window.__sky?.setFollow(true);
      window.__sky?.play(3600);
    });
    await page.waitForTimeout(3000);
    const box = await canvasBox(page);
    const centred = await screenOf(page, target.id);
    expect(Math.abs(centred.x - box.width / 2)).toBeLessThan(FOLLOW_TOLERANCE_PX);
    expect(Math.abs(centred.y - box.height / 2)).toBeLessThan(FOLLOW_TOLERANCE_PX);
    // The clock did run: the view followed a moving target.
    const state = await debugState(page);
    expect(state.mode).toBe('playing');
    expect(state.tt).toBeGreaterThan(TT_PROBE);
    await page.evaluate(() => {
      window.__sky?.pause();
    });
  });

  expect(PLANETS).toContain(target.id);
  expect(foreign).toEqual([]);
  expect(errors).toEqual([]);
});

test('the minor-body layer follows /meta: drawn with the MPC tables, silent without them', async ({
  page,
}) => {
  const errors = collectErrors(page);
  const requests: string[] = [];
  page.on('request', (request) => {
    requests.push(request.url());
  });
  await page.goto(
    appUrl(ENGINE, false).replace('&atm=0', '&atm=0&layers=stars,planets,horizon,minor&minor=a:1'),
  );
  await waitReady(page);
  const meta = await metaOf(page);
  const catalogs =
    typeof meta === 'object' && meta !== null && 'catalogs' in meta
      ? (meta as { catalogs: Record<string, unknown> }).catalogs
      : {};
  const hasMinor = catalogs.minor_bodies !== undefined && catalogs.minor_bodies !== null;

  if (hasMinor) {
    await test.step('Ceres is requested, drawn and resolvable', async () => {
      await expect
        .poll(() => page.evaluate(() => window.__sky?.stats().minorDrawn ?? 0), {
          timeout: 60_000,
        })
        .toBeGreaterThanOrEqual(1);
      expect(requests.some((u) => u.includes('/api/v1/sky/frame') && u.includes('minor='))).toBe(
        true,
      );
      const ceres = await altAzOf(page, 'a:1');
      await page.evaluate(
        ({ az, alt }) => {
          window.__sky?.setView(az, alt, 20);
        },
        { az: ceres.az, alt: ceres.alt },
      );
      const point = await screenOf(page, 'a:1');
      const box = await canvasBox(page);
      expect(Math.abs(point.x - box.width / 2)).toBeLessThan(3);
      expect(Math.abs(point.y - box.height / 2)).toBeLessThan(3);
    });
  } else {
    await test.step('without MPC data the layer stays silent and the boot still completes', async () => {
      expect(await page.evaluate(() => window.__sky?.isReady ?? false)).toBe(true);
      expect(
        requests.filter((u) => u.includes('/api/v1/sky/frame') && u.includes('minor=')),
      ).toEqual([]);
      expect(await page.evaluate(() => window.__sky?.stats().minorDrawn ?? -1)).toBe(0);
    });
  }
  expect(errors).toEqual([]);
});
