import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import {
  appUrl,
  blurActiveElement,
  collectErrors,
  collectForeignRequests,
  debugState,
  metaOf,
  openTab,
  waitReady,
} from './support.ts';

// Time (TIME-1..TIME-5, brief l.201-205; plan D98-D100, D113): the readout at the fixture instant
// (UTC from TT - 69.184 s, the Julian Date, LAST on Earth and not on Mars), the editor round trip
// inside de440s and its refusal of a year outside the coverage with the URL untouched, the
// transport through the debug hook, the `]`, `n` and Space shortcuts (Space inside a text field
// leaves the clock alone), and the bound stop when the clock plays into the coverage end. One
// boot; page-side functions reach the hook through `window.__sky` directly.

const ENGINE = 'webgl2';
/** Simulated seconds per real second for the play check. */
const PLAY_SPEED = 3600;

function ephemerisEnd(meta: unknown): number {
  if (typeof meta !== 'object' || meta === null || !('coverage' in meta)) {
    throw new Error('/meta has no coverage');
  }
  const coverage = (meta as { coverage: { ephemeris_tt?: unknown } }).coverage;
  const range = coverage.ephemeris_tt;
  if (!Array.isArray(range) || typeof range[1] !== 'number') {
    throw new Error('unexpected /meta.coverage.ephemeris_tt');
  }
  return range[1];
}

function tParam(page: Page): string | null {
  return new URL(page.url()).searchParams.get('t');
}

async function fillEditor(page: Page, fields: Record<string, string>): Promise<void> {
  for (const [name, value] of Object.entries(fields)) {
    await page.getByRole('dialog').getByRole('textbox', { name }).fill(value);
  }
}

test.describe.configure({ timeout: 180_000 });

test('readout, editor, transport, shortcuts and the coverage bound stop', async ({ page }) => {
  const errors = collectErrors(page);
  const foreign = collectForeignRequests(page);
  const end = ephemerisEnd(await metaOf(page));
  await page.goto(appUrl(ENGINE, false));
  await waitReady(page);

  await test.step('the readout shows the fixture instant, the Julian Date and LAST on Earth', async () => {
    await expect(page.getByTestId('time-utc')).toHaveText('2024-04-08 17:58:50');
    await expect(page.getByTestId('time-jd')).toHaveText('2460409.25000');
    await expect(page.getByTestId('time-last')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('time-last')).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
  });

  await test.step('LAST disappears on Mars and returns on Earth', async () => {
    await openTab(page, 'Observer');
    await page.getByRole('combobox', { name: 'Observed from' }).selectOption('mars');
    await expect(page.getByTestId('time-last')).toHaveCount(0, { timeout: 20_000 });
    await page.getByRole('combobox', { name: 'Observed from' }).selectOption('earth');
    await expect(page.getByTestId('time-last')).toBeVisible({ timeout: 20_000 });
  });

  await test.step('the editor applies a date inside the coverage and the URL follows', async () => {
    await openTab(page, 'Time');
    await page.getByRole('button', { name: 'Set date and time' }).click();
    const dialog = page.getByRole('dialog', { name: 'Set date and time' });
    await expect(dialog).toBeVisible();
    // UTC entry: the scale of the readout's second line.
    await dialog.getByRole('switch', { name: 'Local time' }).click();
    await fillEditor(page, {
      Year: '2030',
      Month: '6',
      Day: '15',
      Hour: '12',
      Minute: '0',
      Second: '0',
    });
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('time-utc')).toHaveText('2030-06-15 12:00:00');
    const state = await debugState(page);
    expect(state.mode).toBe('paused');
    await expect.poll(() => Number(tParam(page)), { timeout: 3000 }).toBeCloseTo(state.tt, 5);
  });

  await test.step('the editor refuses a year outside the coverage and leaves the URL alone', async () => {
    const before = tParam(page);
    const stateBefore = await debugState(page);
    await page.getByRole('button', { name: 'Set date and time' }).click();
    const dialog = page.getByRole('dialog', { name: 'Set date and time' });
    await fillEditor(page, { Year: '-44', Month: '3', Day: '15' });
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(dialog.getByRole('alert')).toHaveText(/outside the coverage/);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
    expect(tParam(page)).toBe(before);
    expect((await debugState(page)).tt).toBe(stateBefore.tt);
  });

  await test.step('playing advances the simulation time at the chosen speed', async () => {
    await page.evaluate((speed) => {
      window.__sky?.play(speed);
    }, PLAY_SPEED);
    const t1 = await debugState(page);
    const wall1 = Date.now();
    await page.waitForTimeout(2000);
    const t2 = await debugState(page);
    const elapsedDays = ((Date.now() - wall1) / 1000) * (PLAY_SPEED / 86400);
    expect(t2.mode).toBe('playing');
    expect(t2.speed).toBe(PLAY_SPEED);
    // The mirror is published at <= 2 Hz: allow one publish interval of slack either way.
    expect(t2.tt - t1.tt).toBeGreaterThan(elapsedDays * 0.6);
    expect(t2.tt - t1.tt).toBeLessThan(elapsedDays * 1.4);
    await page.evaluate(() => {
      window.__sky?.pause();
    });
    await expect.poll(async () => (await debugState(page)).mode).toBe('paused');
  });

  await test.step('the ] key steps one hour forward with the default step unit', async () => {
    await blurActiveElement(page);
    const before = (await debugState(page)).tt;
    await page.keyboard.press(']');
    await expect
      .poll(async () => (await debugState(page)).tt - before, { timeout: 3000 })
      .toBeCloseTo(1 / 24, 6);
    expect((await debugState(page)).mode).toBe('paused');
  });

  await test.step('Space inside a text field does not touch the clock', async () => {
    await openTab(page, 'Observer');
    const field = page.getByRole('textbox', { name: 'Elevation (m)' });
    await field.focus();
    await page.keyboard.press('Space');
    await expect(field).toHaveValue(/ /);
    expect((await debugState(page)).mode).toBe('paused');
    await field.fill('0');
    await blurActiveElement(page);
  });

  await test.step('n goes live and writes t=live', async () => {
    await page.keyboard.press('n');
    await expect.poll(() => tParam(page), { timeout: 3000 }).toBe('live');
    expect((await debugState(page)).mode).toBe('live');
  });

  await test.step('playing into the coverage end stops the clock one guard inside and shows the banner', async () => {
    await openTab(page, 'Time');
    await page.evaluate((tt) => {
      window.__sky?.setTime(tt);
    }, end - 0.01);
    await page.evaluate(() => {
      window.__sky?.play(86400);
    });
    await expect
      .poll(async () => (await debugState(page)).coverageStop, { timeout: 20_000 })
      .not.toBeNull();
    const stopped = await debugState(page);
    expect(stopped.mode).toBe('paused');
    expect(stopped.tt).toBeLessThanOrEqual(end);
    expect(stopped.tt).toBeGreaterThan(end - 1);
    // One announcement: the shell's degraded-state banner (plan D111), none in the time panel.
    await expect(page.getByRole('status', { name: 'Edge of the data' })).toBeVisible();
    await expect(page.getByRole('status', { name: 'Edge of the data' })).toHaveText(
      /edge of the ephemeris/,
    );
    await expect(page.getByRole('status', { name: 'Edge of the data' })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Forward: Day' })).toBeDisabled();
  });

  expect(foreign).toEqual([]);
  // The bound step makes the frame buffer ask past the coverage edge on purpose (plan D76: the API
  // answers 422 and the controller reissues the request flush with the bound); Chromium logs every
  // non-2xx resource as a console error, which is the one line tolerated here.
  expect(errors.filter((line) => !line.includes('status of 422'))).toEqual([]);
});
