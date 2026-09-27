import { expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

import {
  appUrl,
  canvasBox,
  collectErrors,
  collectForeignRequests,
  debugState,
  metaOf,
  required,
  waitReady,
} from './support.ts';

// The unified search (INFO-2, plan D107, D113): typing finds Betelgeuse locally and Enter
// selects it and centres the view (`sel` in the URL, the star at the canvas centre); M31 selects
// the canonical `dso:NGC224`; a constellation centres without selecting; the minor-body section
// follows `/meta`: with the MPC tables (local data) Ceres is pinned and selected, without them
// (CI) the section says so. Page-side functions reach the hook through `window.__sky` directly.

const ENGINE = 'webgl2';
/** The centred object stays within this many CSS pixels of the canvas centre. */
const CENTRE_TOLERANCE_PX = 3;

test.describe.configure({ timeout: 180_000 });

function selParam(page: Page): string | null {
  return new URL(page.url()).searchParams.get('sel');
}

async function screenOf(page: Page, id: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate((target) => window.__sky?.screenOf(target) ?? null, id);
}

/** Distance of an object from the canvas centre in CSS pixels, `Infinity` when unresolved. */
async function centreDistance(page: Page, id: string): Promise<number> {
  const point = await screenOf(page, id);
  if (point === null) {
    return Infinity;
  }
  const box = await canvasBox(page);
  return Math.hypot(point.x - box.width / 2, point.y - box.height / 2);
}

test('finds stars, deep-sky objects, constellations and the minor bodies of /meta', async ({
  page,
}) => {
  const errors = collectErrors(page);
  const foreign = collectForeignRequests(page);
  await page.goto(appUrl(ENGINE, false));
  await waitReady(page);
  const meta = await metaOf(page);
  const catalogs =
    typeof meta === 'object' && meta !== null && 'catalogs' in meta
      ? (meta as { catalogs: Record<string, unknown> }).catalogs
      : {};
  const hasMinor = catalogs.minor_bodies !== undefined && catalogs.minor_bodies !== null;
  const box = page.getByRole('combobox', { name: 'Search the sky' });

  await test.step('Betelg -> Betelgeuse selected and centred', async () => {
    await expect(box).toHaveAttribute('aria-expanded', 'false');
    await box.fill('Betelg');
    await expect(box).toHaveAttribute('aria-expanded', 'true');
    const option = page.getByRole('option', { name: /Betelgeuse/ });
    await expect(option).toBeVisible();
    await expect(option).toContainText('HIP 27989');
    await box.press('ArrowDown');
    await expect(option).toHaveAttribute('aria-selected', 'true');
    await box.press('Enter');
    await expect.poll(() => selParam(page), { timeout: 5000 }).toBe('hip:27989');
    expect((await debugState(page)).sel).toBe('hip:27989');
    await expect
      .poll(() => centreDistance(page, 'hip:27989'), { timeout: 15_000 })
      .toBeLessThan(CENTRE_TOLERANCE_PX);
    await expect(box).toHaveAttribute('aria-expanded', 'false');
  });

  await test.step('M31 -> the canonical dso:NGC224', async () => {
    await box.fill('M31');
    const option = page.getByRole('option', { name: /Andromeda Galaxy/ });
    await expect(option).toBeVisible();
    await option.click();
    await expect.poll(() => selParam(page), { timeout: 5000 }).toBe('dso:NGC224');
    await expect
      .poll(() => centreDistance(page, 'dso:NGC224'), { timeout: 15_000 })
      .toBeLessThan(CENTRE_TOLERANCE_PX);
  });

  await test.step('orion -> the view centres on the constellation, the selection stays', async () => {
    const before = await debugState(page);
    await box.fill('orion');
    const option = page.getByRole('option', { name: /Orion/ }).first();
    await expect(option).toContainText('Constellation');
    await box.press('Enter');
    // The label point of the constellation resolves through the same resolver as the centring.
    const label = await page.evaluate(() => window.__sky?.altAzOf('con:Ori') ?? null);
    if (label !== null) {
      await expect
        .poll(
          async () => {
            const view = (await debugState(page)).view;
            const dAz = Math.abs(((((view.az - label.az) % 360) + 540) % 360) - 180);
            return Math.hypot(dAz * Math.cos((label.alt * Math.PI) / 180), view.alt - label.alt);
          },
          { timeout: 15_000 },
        )
        .toBeLessThan(1);
    } else {
      await expect
        .poll(async () => {
          const view = (await debugState(page)).view;
          return Math.abs(view.az - before.view.az) + Math.abs(view.alt - before.view.alt);
        })
        .toBeGreaterThan(0.5);
    }
    expect(selParam(page)).toBe('dso:NGC224');
    expect((await debugState(page)).sel).toBe('dso:NGC224');
  });

  await test.step('the minor-body section follows /meta', async () => {
    await box.fill('Ceres');
    if (hasMinor) {
      const option = page.getByRole('option', { name: /Ceres/ });
      await expect(option).toBeVisible({ timeout: 15_000 });
      await expect(option).toContainText('Asteroid');
      await option.click();
      await expect
        .poll(() => new URL(page.url()).searchParams.get('minor'), { timeout: 5000 })
        .toBe('a:1');
      await expect.poll(() => selParam(page), { timeout: 5000 }).toBe('a:1');
      const state = await debugState(page);
      expect(state.sel).toBe('a:1');
      // Choosing a minor body switches its layer on, so the pin reaches /sky/frame and the sky.
      expect(state.layers.minor).toBe(true);
      await expect
        .poll(() => page.evaluate(() => window.__sky?.stats().minorDrawn ?? 0), {
          timeout: 60_000,
        })
        .toBeGreaterThanOrEqual(1);
    } else {
      await expect(
        page.getByText('Minor-body search is unavailable on this server.'),
      ).toBeVisible();
      expect(
        required(await page.evaluate(() => window.__sky?.state() ?? null), 'state()').sel,
      ).toBe('dso:NGC224');
    }
  });

  await test.step('Escape closes the list', async () => {
    await box.fill('sirius');
    await expect(page.getByRole('listbox')).toBeVisible();
    await box.press('Escape');
    await expect(page.getByRole('listbox')).toBeHidden();
  });

  expect(foreign).toEqual([]);
  expect(errors).toEqual([]);
});
