import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env.CI;

// The WebGPU project asserts the WebGPU backend; every other project drives WebGL2 and ignores
// that spec (plan D89). Headless WebGPU on the CI runner is unmeasured, so `chromium-webgpu` is
// configured but not part of the CI project list (docs/testing.md, maintainer question 16).
const webgpuSpec = /webgpu\.spec\.ts/;
// The `perf` project (plan D146) is manual like `webkit` and `chromium-webgpu`: never in
// `make e2e` or CI (`npm run e2e -- --project=perf` after `make build-e2e`). Its spec records the
// boot under throttled network profiles through CDP and a heap-sampling profile mapped through the
// e2e build's source maps; the CI projects ignore it as they ignore the WebGPU spec.
const perfSpec = /perf\.spec\.ts/;
const manualSpecs = /(webgpu|perf)\.spec\.ts/;

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
  projects: [
    { name: 'chromium-desktop', testIgnore: manualSpecs, use: { ...devices['Desktop Chrome'] } },
    { name: 'chromium-mobile', testIgnore: manualSpecs, use: { ...devices['Pixel 7'] } },
    { name: 'webkit', testIgnore: manualSpecs, use: { ...devices['Desktop Safari'] } },
    {
      // Full Chromium in new headless mode (the headless shell has no WebGPU) with the SwiftShader
      // fallback adapter allowed (brief l.540, l.407).
      name: 'chromium-webgpu',
      testMatch: webgpuSpec,
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chromium',
        launchOptions: { args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader'] },
      },
    },
    { name: 'perf', testMatch: perfSpec, use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      // The API on de440s without downloads (brief l.428); `uv run` inside backend/ so
      // fastapi-cli finds `[tool.fastapi] entrypoint` in that pyproject. Playwright waits while
      // `/health` answers 503 `starting`.
      command: 'uv run fastapi run --host 127.0.0.1 --port 8000',
      cwd: '../backend',
      url: 'http://127.0.0.1:8000/api/v1/health',
      env: { SKYAPI_AUTO_FETCH: 'false', SKYAPI_EPHEMERIS: 'de440s.bsp' },
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
    {
      // Serves the e2e build (`npm run build:e2e`, `import.meta.env.MODE === 'e2e'`), the only
      // build that exposes `window.__sky` (brief l.410).
      command: 'npm run preview',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: !isCI,
      timeout: 60_000,
    },
  ],
});
