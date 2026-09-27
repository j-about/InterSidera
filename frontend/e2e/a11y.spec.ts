import type { Page } from '@playwright/test';

import { expect, test } from './fixtures.ts';

import { axeScan, expectNoAxeViolations, incompleteSummary, summarizeViolations } from './axe.ts';
import {
  appUrl,
  collectErrors,
  collectForeignRequests,
  debugState,
  openTab,
  waitReady,
} from './support.ts';

// Accessibility mechanics (UX-4, brief l.248, l.289-290; plan D112, D113) on the desktop
// layout only (`chromium-desktop`; the phone boots once in `mobile.spec.ts`): the skip link is the first Tab stop and moves the focus into the panel, every button
// has a name, the landmarks exist, the focused control shows an outline, the tabs follow the
// arrow keys, `prefers-reduced-motion` reaches the engine, the AR button is absent (AR-1, the
// touch heuristic; the phone project drives it in ar.spec.ts), and this spec is the single home of
// the "no unscoped `role=status` after ready" rule: once the sky is up the splash is gone and
// every remaining status region carries an accessible name, so specs can scope on it. Then the
// axe-core scans of plan D156 over the desktop-only states: the main view, each tab, the open
// search list, the About dialog, the time editor, night mode at level 1, the dark and the light
// scheme, night at the 0.3 floor (the recorded exception B-90: only `color-contrast` may fail
// there, and its counts are annotated), and one run of axe's experimental rules filtered to
// `label-content-name-mismatch`, which guards the Switch's label-in-name fix (plan D157 C4: the
// state word is an `aria-hidden` sibling outside the button). Playwright renders the light
// scheme unless told otherwise (`colorScheme` defaults to `'light'`; playwright.config.ts sets
// none), so every scan before the scheme step is a light-scheme scan; the scheme step emulates
// the dark scheme (the M4 primary palette) and scans it, then the light one, and leaves the page
// dark for the two steps after it. Three boots through one helper, `test.step` inside (plan
// D113): the keyboard mechanics in one test, the light-scheme scans (eight) in a second, the night
// and scheme scans (five) in a third, so none runs near the 180 s cap under five SwiftShader
// workers (one test with everything timed out at the editor step under load; all thirteen scans in
// one test still took 168 s there, 67 s alone).

test.skip(({ isMobile }) => isMobile, 'the desktop layout only: mobile.spec.ts covers the phone');

test.describe.configure({ timeout: 180_000 });

/** The desktop boot both tests share: the collectors first, then the app until `isReady`. */
async function boot(page: Page): Promise<{ errors: string[]; foreign: string[] }> {
  const errors = collectErrors(page);
  const foreign = collectForeignRequests(page);
  await page.goto(appUrl('webgl2', false));
  await waitReady(page);
  return { errors, foreign };
}

test('keyboard access, names, landmarks, focus ring, tabs, reduced motion, named status regions', async ({
  page,
}) => {
  const { errors, foreign } = await boot(page);

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

test('axe: the main view, the tabs, the search list, the About dialog and the time editor', async ({
  page,
}) => {
  const { errors, foreign } = await boot(page);

  await test.step('axe: the main view and each tab', async () => {
    await expectNoAxeViolations(page, 'main view');
    for (const name of ['Observer', 'Time', 'Layers', 'Details']) {
      await openTab(page, name);
      await expectNoAxeViolations(page, `${name} tab`);
    }
    await openTab(page, 'Observer');
  });

  await test.step('axe: the open search list', async () => {
    const box = page.getByRole('combobox', { name: 'Search the sky' });
    await box.fill('Betelgeuse');
    await expect(page.getByRole('option', { name: /Betelgeuse/ })).toBeVisible();
    await expectNoAxeViolations(page, 'search list open');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox')).toBeHidden();
    await box.fill('');
  });

  await test.step('axe: the About dialog and the time editor', async () => {
    await page.getByRole('button', { name: 'About InterSidera' }).click();
    const about = page.getByRole('dialog', { name: 'About InterSidera' });
    await expect(about).toBeVisible();
    await expectNoAxeViolations(page, 'About dialog');
    await page.keyboard.press('Escape');
    await expect(about).toBeHidden();

    // The editor's button lives in the Time tab (`TimePanel.tsx`); the tab loop above left the
    // Observer tab open.
    await openTab(page, 'Time');
    await page.getByRole('button', { name: 'Set date and time' }).click();
    const editor = page.getByRole('dialog', { name: 'Set date and time' });
    await expect(editor).toBeVisible();
    await expectNoAxeViolations(page, 'time editor');
    await editor.getByRole('button', { name: 'Close' }).click();
    await expect(editor).toBeHidden();
  });

  expect(foreign).toEqual([]);
  expect(errors).toEqual([]);
});

test('axe: night mode, the dark and light schemes, the 0.3 floor and the label-in-name rule', async ({
  page,
}) => {
  const { errors, foreign } = await boot(page);
  const night = page.getByRole('switch', { name: 'Night vision' });
  const documentMode = (): Promise<string | null> =>
    page.evaluate(() => document.documentElement.dataset.mode ?? null);

  await test.step('axe: night mode at level 1, then the dark and light schemes', async () => {
    await night.click();
    await expect.poll(documentMode).toBe('night');
    await expectNoAxeViolations(page, 'night mode, level 1');
    await night.click();
    await expect.poll(documentMode).toBeNull();
    // The page booted in the light scheme (Playwright's default): the dark scheme needs the
    // emulation, and the light scan afterwards is the explicit twin of the scans above.
    const prefersDark = (): Promise<boolean> =>
      page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches);
    expect(await prefersDark()).toBe(false);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(prefersDark).toBe(true);
    await expectNoAxeViolations(page, 'dark scheme');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(prefersDark).toBe(false);
    await expectNoAxeViolations(page, 'light scheme');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(prefersDark).toBe(true);
  });

  await test.step('axe: night at the 0.3 floor is the recorded contrast exception (B-90)', async () => {
    await night.click();
    await expect.poll(documentMode).toBe('night');
    const slider = page.getByRole('slider', { name: 'Brightness' });
    await slider.focus();
    await page.keyboard.press('Home');
    await expect(slider).toHaveValue('0.3');
    const results = await axeScan(page);
    const contrast = results.violations.find((violation) => violation.id === 'color-contrast');
    // The dimming is the user's choice (plan D108): WCAG AA is asserted at level 1 only, and only
    // `color-contrast` may fall here; everything else stays clean.
    expect(summarizeViolations(results).filter((v) => v.id !== 'color-contrast')).toEqual([]);
    test.info().annotations.push({
      type: 'axe night=0.3 (B-90)',
      description: `color-contrast: ${String(contrast?.nodes.length ?? 0)} violation node(s), ${String(incompleteSummary(results)['color-contrast'] ?? 0)} incomplete node(s)`,
    });
    await page.keyboard.press('End');
    await expect(slider).toHaveValue('1');
    await night.click();
    await expect.poll(documentMode).toBeNull();
  });

  await test.step('axe: the experimental label-in-name rule accepts the switches (SC 2.5.3)', async () => {
    const results = await axeScan(page, { experimental: true });
    const mismatches = summarizeViolations(results).filter(
      (violation) => violation.id === 'label-content-name-mismatch',
    );
    expect(mismatches).toEqual([]);
  });

  expect(foreign).toEqual([]);
  expect(errors).toEqual([]);
});
