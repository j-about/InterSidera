import { expect, test } from '@playwright/test';

test('placeholder page loads and /api is proxied to the backend', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/InterSidera/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // `/api` reaches FastAPI through the Vite preview proxy (M0 definition of done, brief l.442).
  const res = await page.request.get('/api/v1/health');
  expect(res.ok()).toBeTruthy();
  // `res.json()` is `any`; type it as unknown so strictTypeChecked's no-unsafe-* rules stay green.
  const body: unknown = await res.json();
  expect(body).toMatchObject({ status: 'ready' });
});
