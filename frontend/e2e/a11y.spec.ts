import { expect, test } from '@playwright/test';

import { appUrl, collectErrors, collectForeignRequests, debugState, waitReady } from './support.ts';

// Accessibility mechanics (UX-4, brief l.248, l.289-290; plan D112, D113) on the desktop
// layout only (`chromium-desktop`; the phone boots once in `mobile.spec.ts`): the skip link is the first Tab stop and moves the focus into the panel, every button
// has a name, the landmarks exist, the focused control shows an outline, the tabs follow the
// arrow keys, `prefers-reduced-motion` reaches the engine, the AR button is absent (AR-1, the
// touch heuristic; the phone project drives it in ar.spec.ts), and this spec is the single home of
// the "no unscoped `role=status` after ready" rule: once the sky is up the splash is gone and
// every remaining status region carries an accessible name, so specs can scope on it. One boot,
// `test.step` inside (plan D113).

test.skip(({ isMobile }) => isMobile, 'the desktop layout only: mobile.spec.ts covers the phone');

test.describe.configure({ timeout: 180_000 });

test('keyboard access, names, landmarks, focus ring, tabs, reduced motion, named status regions', async ({
  page,
}) => {
  const errors = collectErrors(page);
  const foreign = collectForeignRequests(page);
  await page.goto(appUrl('webgl2', false));
  await waitReady(page);

  await test.step('the landmarks are present', async () => {
    await expect(page.getByRole('banner')).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Controls' })).toBeVisible();
  });

  await test.step('the first Tab focuses the skip link; Enter moves the focus into the panel', async () => {
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to the control panel' });
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#panel')).toBeFocused();
    // The hash carries nothing (the dev/e2e engine override stays intact, plan D79).
    expect(new URL(page.url()).hash).toBe('#engine=webgl2');
  });

  await test.step('every button has a non-empty accessible name', async () => {
    const nameless = await page.getByRole('button').evaluateAll((buttons) =>
      buttons
        .filter((button) => {
          const label = button.getAttribute('aria-label')?.trim();
          if (label) {
            return false;
          }
          const labelledBy = button.getAttribute('aria-labelledby');
          if (labelledBy) {
            const text = labelledBy
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent.trim() ?? '')
              .join(' ')
              .trim();
            if (text) {
              return false;
            }
          }
          return !(button.textContent.trim() || button.getAttribute('title')?.trim());
        })
        .map((button) => button.outerHTML),
    );
    expect(nameless).toEqual([]);
  });

  await test.step('the focused control shows an outline', async () => {
    const about = page.getByRole('button', { name: 'About InterSidera' });
    await about.focus();
    await expect(about).toBeFocused();
    const outline = await about.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe('none');
  });

  await test.step('the arrow keys move the selected tab', async () => {
    const observer = page.getByRole('tab', { name: 'Observer' });
    await observer.focus();
    await expect(observer).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowRight');
    const time = page.getByRole('tab', { name: 'Time' });
    await expect(time).toHaveAttribute('aria-selected', 'true');
    await expect(time).toBeFocused();
    expect((await debugState(page)).ui.panel).toBe('time');
    await page.keyboard.press('End');
    await expect(page.getByRole('tab', { name: 'Details' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('Home');
    await expect(observer).toHaveAttribute('aria-selected', 'true');
  });

  await test.step('prefers-reduced-motion reaches the engine', async () => {
    expect((await debugState(page)).reducedMotion).toBe(false);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(async () => (await debugState(page)).reducedMotion).toBe(true);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect.poll(async () => (await debugState(page)).reducedMotion).toBe(false);
  });

  await test.step('the AR button is absent on a desktop (AR-1: the touch heuristic fails)', async () => {
    await expect(page.getByRole('button', { name: 'Augmented reality' })).toHaveCount(0);
    await expect
      .poll(async () => (await debugState(page)).ar.capabilities?.touch ?? null)
      .toBe(false);
  });

  await test.step('after ready the splash is gone and every status region is named', async () => {
    await expect(page.getByRole('status', { name: 'Loading the sky' })).toHaveCount(0);
    const unnamed = await page.locator('[role="status"]').evaluateAll((regions) =>
      regions
        .filter((region) => {
          const label = region.getAttribute('aria-label')?.trim();
          const labelledBy = region.getAttribute('aria-labelledby');
          const text = labelledBy
            ? labelledBy
                .split(/\s+/)
                .map((id) => document.getElementById(id)?.textContent.trim() ?? '')
                .join(' ')
                .trim()
            : '';
          return !label && !text;
        })
        .map((region) => region.outerHTML),
    );
    expect(unnamed).toEqual([]);
  });

  expect(foreign).toEqual([]);
  expect(errors).toEqual([]);
});
