import { expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

import { expectNoAxeViolations } from './axe.ts';
import { appUrl, collectErrors, debugState, openPanelTab, waitReady } from './support.ts';

// axe-core over the chrome on both projects (plan D156, D157; brief l.289-290): the main view,
// the control panel with each tab, the About dialog; on the phone the two WCAG 2.2 items measured
// failing at the 320 px reference width at M6 and fixed by plan D157 C7: the collapsed sheet
// strip wraps instead of scrolling sideways (SC 1.4.10 reflow: 749 px inside 320 before), and a
// keyboard focus landing on a top-bar control the expanded sheet covers collapses the sheet
// (SC 2.4.11 focus not obscured: seven controls were entirely hidden), while a tap on a control
// never does (a tap focuses a button too; at Pixel 7 size nothing is covered and the sheet must
// stay open). One boot, `test.step` inside (plan D113). a11y.spec.ts scans the desktop-only
// states (search list, time editor, night mode, the light scheme, the experimental rule).

test.describe.configure({ timeout: 180_000 });

const TABS = ['Observer', 'Time', 'Layers', 'Details'];

/** Whether the focused element is a top-bar control whose box is clear of the panel's box. */
async function focusedControlClearOfPanel(
  page: Page,
): Promise<{ inHeader: boolean; clear: boolean } | null> {
  return page.evaluate(() => {
    const active = document.activeElement;
    const panel = document.getElementById('panel');
    if (!(active instanceof HTMLElement) || panel === null) {
      return null;
    }
    const a = active.getBoundingClientRect();
    const b = panel.getBoundingClientRect();
    return {
      inHeader: active.closest('header') !== null,
      clear: a.bottom <= b.top || a.top >= b.bottom || a.right <= b.left || a.left >= b.right,
    };
  });
}

test('axe: the main view, the panel tabs and About; the 320 px reflow and focus rules on the phone', async ({
  page,
  isMobile,
}) => {
  const errors = collectErrors(page);
  await page.goto(appUrl('webgl2', false));
  await waitReady(page);

  await test.step('the main view', async () => {
    await expectNoAxeViolations(page, 'main view');
  });

  await test.step('the control panel with each tab', async () => {
    for (const name of TABS) {
      await openPanelTab(page, name);
      await expectNoAxeViolations(page, `${name} tab`);
    }
    await openPanelTab(page, 'Observer');
  });

  await test.step('the About dialog', async () => {
    const about = page.getByRole('button', { name: 'About InterSidera' });
    await about.click();
    const dialog = page.getByRole('dialog', { name: 'About InterSidera' });
    await expect(dialog).toBeVisible();
    await expectNoAxeViolations(page, 'About dialog');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  if (!isMobile) {
    expect(errors).toEqual([]);
    return;
  }

  const handle = page.getByRole('button', { name: /the control panel$/ });
  const sheetState = async (): Promise<string> => (await debugState(page)).ui.sheet;

  await test.step('320 px: the collapsed strip wraps, nothing scrolls sideways (SC 1.4.10)', async () => {
    if ((await sheetState()) === 'expanded') {
      await handle.tap();
    }
    await expect(handle).toHaveAttribute('aria-expanded', 'false');
    await page.setViewportSize({ width: 320, height: 568 });
    // The strip is the parent of the readout `section` in the sheet.
    const strip = page.getByTestId('time-readout').locator('..');
    await expect(strip).toBeVisible();
    const sizes = await strip.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      overflowX: getComputedStyle(el).overflowX,
    }));
    expect(sizes.scrollWidth).toBeLessThanOrEqual(sizes.clientWidth);
    expect(sizes.overflowX).not.toBe('auto');
    const doc = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(doc.scrollWidth).toBeLessThanOrEqual(doc.innerWidth);
  });

  await test.step('320 px: a keyboard focus into a covered top-bar control collapses the sheet (SC 2.4.11)', async () => {
    await handle.tap();
    await expect(handle).toHaveAttribute('aria-expanded', 'true');
    expect(await sheetState()).toBe('expanded');
    // The expanded sheet starts well above the wrapped top bar's bottom: some control is covered.
    const geometry = await page.evaluate(() => {
      const header = document.querySelector('header');
      const panel = document.getElementById('panel');
      if (header === null || panel === null) {
        return null;
      }
      return {
        headerBottom: header.getBoundingClientRect().bottom,
        panelTop: panel.getBoundingClientRect().top,
      };
    });
    if (geometry === null) {
      throw new Error('no header or panel');
    }
    expect(geometry.panelTop).toBeLessThan(geometry.headerBottom);
    // Tab through the top bar from the search box (it is not covered): the first control whose
    // box meets the sheet collapses it; the focused control is then in the top bar and clear.
    await page.getByRole('combobox', { name: 'Search the sky' }).focus();
    let collapsed = false;
    for (let presses = 0; presses < 20 && !collapsed; presses += 1) {
      await page.keyboard.press('Tab');
      collapsed = (await sheetState()) === 'collapsed';
    }
    expect(collapsed).toBe(true);
    await expect(handle).toHaveAttribute('aria-expanded', 'false');
    expect(await focusedControlClearOfPanel(page)).toEqual({ inHeader: true, clear: true });
  });

  await test.step('Pixel 7 size: the expanded sheet clears the top bar; a tap on the night switch keeps it', async () => {
    await page.setViewportSize({ width: 412, height: 839 });
    await handle.tap();
    await expect(handle).toHaveAttribute('aria-expanded', 'true');
    // The whole sheet is capped at 70 dvh (plan D157 C7): the top bar's three rows (bottom at
    // 160 px) end above the sheet (top at 252 px), so no target is partially obscured (SC 2.5.8).
    const clearance = await page.evaluate(() => {
      const header = document.querySelector('header');
      const panel = document.getElementById('panel');
      if (header === null || panel === null) {
        return null;
      }
      return {
        headerBottom: header.getBoundingClientRect().bottom,
        panelTop: panel.getBoundingClientRect().top,
      };
    });
    if (clearance === null) {
      throw new Error('no header or panel');
    }
    expect(clearance.panelTop).toBeGreaterThanOrEqual(clearance.headerBottom);
    const night = page.getByRole('switch', { name: 'Night vision' });
    await expect(night).toBeVisible();
    await night.tap();
    await expect(night).toHaveAttribute('aria-checked', 'true');
    expect(await sheetState()).toBe('expanded');
    await night.tap();
    await expect(night).toHaveAttribute('aria-checked', 'false');
    expect(await sheetState()).toBe('expanded');
    await expectNoAxeViolations(page, 'phone, sheet expanded after the tap');
  });

  expect(errors).toEqual([]);
});
