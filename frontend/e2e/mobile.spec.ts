import { expect, test } from '@playwright/test';

import { appUrl, collectErrors, collectForeignRequests, debugState, waitReady } from './support.ts';

// The phone layout (VIEW-5, brief l.225; plan D112, D113) on the Pixel 7 emulation only: the
// canvas fills the viewport, the control panel is a bottom sheet whose handle expands it (a real
// touch tap), Escape collapses it, nothing overflows horizontally and the landmarks are present.
// One boot, `test.step` inside (plan D113).

test.skip(({ isMobile }) => !isMobile, 'the bottom sheet exists below the md breakpoint only');

test.describe.configure({ timeout: 180_000 });

test('the bottom sheet, the viewport-filling canvas and the landmarks on a phone', async ({
  page,
}) => {
  const errors = collectErrors(page);
  const foreign = collectForeignRequests(page);
  await page.goto(appUrl('webgl2', false));
  await waitReady(page);

  await test.step('the canvas fills the viewport', async () => {
    const viewport = page.viewportSize();
    if (viewport === null) {
      throw new Error('the mobile project has no viewport');
    }
    const box = await page.getByLabel('Sky view').boundingBox();
    if (box === null) {
      throw new Error('the canvas has no bounding box');
    }
    expect(Math.round(box.x)).toBe(0);
    expect(Math.round(box.y)).toBe(0);
    expect(Math.round(box.width)).toBe(viewport.width);
    expect(Math.round(box.height)).toBe(viewport.height);
  });

  await test.step('the landmarks are present', async () => {
    await expect(page.getByRole('banner')).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Controls' })).toBeVisible();
  });

  const handle = page.getByRole('button', { name: /the control panel$/ });
  await test.step('the sheet starts collapsed: handle not expanded, tabs hidden', async () => {
    await expect(handle).toHaveAttribute('aria-expanded', 'false');
    await expect(handle).toHaveAttribute('aria-controls', 'panel-body');
    await expect(page.getByRole('tablist')).toBeHidden();
    expect((await debugState(page)).ui.sheet).toBe('collapsed');
  });

  await test.step('a tap on the handle expands the sheet', async () => {
    await handle.tap();
    await expect(handle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('tablist')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Observer' })).toBeVisible();
    expect((await debugState(page)).ui.sheet).toBe('expanded');
  });

  await test.step('Escape collapses it again', async () => {
    await page.keyboard.press('Escape');
    await expect(handle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('tablist')).toBeHidden();
    expect((await debugState(page)).ui.sheet).toBe('collapsed');
  });

  await test.step('nothing overflows horizontally', async () => {
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
  });

  expect(foreign).toEqual([]);
  expect(errors).toEqual([]);
});
