import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env.CI;

// https://playwright.dev/docs/test-configuration
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  // Serial in CI, Playwright's default locally (`exactOptionalPropertyTypes` forbids `undefined`).
  ...(isCI ? { workers: 1 } : {}),
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    // Plain HTTP against `vite preview` (plan D15); 127.0.0.1 everywhere, never `localhost`.
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  // Desktop, mobile emulation and WebKit (brief l.410). No WebGL flags: Playwright already passes
  // --enable-unsafe-swiftshader to headless Chromium.
  // M3 adds a WebGPU project (headless WebGPU flags measured there, brief l.540).
  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'chromium-mobile', use: { ...devices['Pixel 7'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: [
    {
      // The API on de440s without downloads (brief l.428); `uv run` inside backend/ so
      // fastapi-cli finds `[tool.fastapi] entrypoint` in that pyproject.
      command: 'uv run fastapi run --host 127.0.0.1 --port 8000',
      cwd: '../backend',
      url: 'http://127.0.0.1:8000/api/v1/health',
      env: { SKYAPI_AUTO_FETCH: 'false', SKYAPI_EPHEMERIS: 'de440s.bsp' },
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
    {
      command: 'npm run preview',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: !isCI,
      timeout: 60_000,
    },
  ],
});
