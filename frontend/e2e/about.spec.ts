import { expect, test } from './fixtures.ts';

import {
  appUrl,
  collectErrors,
  collectForeignRequests,
  debugState,
  metaOf,
  waitReady,
} from './support.ts';

// The About screen (INFO-4, brief l.233, l.326; plan D110, D113): opened from the keyboard, a
// named modal dialog that carries the versions of the app and of the server, the repository
// link, the attributions this server announces in `/meta` and the CC BY-SA credits of the data
// registry; Escape closes it and returns the focus to the button that opened it.

const ENGINE = 'webgl2';
const REPOSITORY_URL = 'https://github.com/j-about/InterSidera';

test.describe.configure({ timeout: 180_000 });

interface MetaShape {
  api_version: string;
  catalogs: { stars: { attribution: string; license: string } };
  geocoder: { attribution: string };
}

function isMetaShape(value: unknown): value is MetaShape {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const meta = value as Record<string, unknown>;
  const catalogs = meta.catalogs as Record<string, unknown> | undefined;
  const stars = catalogs?.stars as Record<string, unknown> | undefined;
  const geocoder = meta.geocoder as Record<string, unknown> | undefined;
  return (
    typeof meta.api_version === 'string' &&
    typeof stars?.attribution === 'string' &&
    typeof stars.license === 'string' &&
    typeof geocoder?.attribution === 'string'
  );
}

test('About: versions, repository, server attributions and credits; Escape returns the focus', async ({
  page,
}) => {
  const errors = collectErrors(page);
  const foreign = collectForeignRequests(page);
  await page.goto(appUrl(ENGINE, false));
  await waitReady(page);
  const meta = await metaOf(page);
  if (!isMetaShape(meta)) {
    throw new Error('unexpected /meta shape');
  }
  const healthRes = await page.request.get('/api/v1/health');
  expect(healthRes.ok()).toBeTruthy();
  const health: unknown = await healthRes.json();
  const version =
    typeof health === 'object' && health !== null && 'version' in health ? health.version : null;
  if (typeof version !== 'string') {
    throw new Error('unexpected /health shape');
  }

  const about = page.getByRole('button', { name: 'About InterSidera' });
  const dialog = page.getByRole('dialog', { name: 'About InterSidera' });

  await test.step('opens from the keyboard as a named modal dialog', async () => {
    await about.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    expect((await debugState(page)).ui.dialog).toBe('about');
  });

  await test.step('versions and the repository link', async () => {
    await expect(dialog).toContainText(version);
    await expect(dialog).toContainText(meta.api_version);
    const link = dialog.getByRole('link', { name: /Source code repository/ });
    await expect(link).toHaveAttribute('href', REPOSITORY_URL);
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(link).toHaveAttribute('target', '_blank');
  });

  await test.step('what this server serves and the registry credits', async () => {
    await expect(dialog).toContainText(meta.catalogs.stars.attribution);
    await expect(dialog).toContainText(meta.geocoder.attribution);
    await expect(dialog).toContainText('CC BY-SA 4.0');
    await expect(dialog).toContainText('OpenNGC');
    // The wording the brief mandates (l.193, l.318), as the API serves it.
    await expect(dialog).toContainText('© OpenStreetMap contributors');
    await expect(dialog).toContainText('Lucide');
    // Every external source is a new-tab link that never leaks a referrer.
    const links = dialog.getByRole('link');
    expect(await links.count()).toBeGreaterThan(5);
    for (const rel of await links.evaluateAll((all) => all.map((a) => a.getAttribute('rel')))) {
      expect(rel).toBe('noopener noreferrer');
    }
  });

  await test.step('Escape closes the dialog and returns the focus to the About button', async () => {
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(about).toBeFocused();
    await expect.poll(async () => (await debugState(page)).ui.dialog).toBeNull();
  });

  expect(foreign).toEqual([]);
  expect(errors).toEqual([]);
});
