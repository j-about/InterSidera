import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

import pkg from './package.json' with { type: 'json' };

// https://vite.dev/config/ — Vitest reads its `test` block from this same file (plan D14), so
// `defineConfig` comes from 'vitest/config' to type both halves.
export default defineConfig(({ command, mode, isPreview }) => {
  // HTTPS only for the interactive dev server: geolocation, camera, device orientation and WebXR
  // need a secure context on a phone (brief l.95, l.548). `vite preview` stays plain HTTP on 4173
  // so the Playwright web server and CI never deal with a self-signed certificate (plan D15).
  const interactiveDev = command === 'serve' && mode === 'development' && !isPreview;

  return {
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    plugins: [react(), tailwindcss(), ...(interactiveDev ? [basicSsl()] : [])],
    server: {
      port: 5173,
      strictPort: true,
      // Same-origin `/api` in development; the API listens on 8000 (brief l.20, l.95). The target
      // is 127.0.0.1, not `localhost`, which Node may resolve to ::1 while uvicorn binds IPv4 only.
      proxy: { '/api': { target: 'http://127.0.0.1:8000' } },
    },
    // `preview.proxy` inherits `server.proxy`, so the e2e smoke test reaches the API through 4173.
    preview: { port: 4173, strictPort: true },
    build: {
      // Vite 8 is Rolldown-based: `codeSplitting` groups, never `rollupOptions` / `manualChunks`
      // (brief l.549, plan D90). The WebGPU engine is only reached through a dynamic import
      // (sky/engine/webgpu.ts), so WebGL2 users never download it; the rest of Babylon shares one
      // vendor chunk. Measured on 2026-09-06 with `npm run build`: application 105 KB + babylon
      // 184 KB gzip for the WebGL2 set, babylon-webgpu 145 KB gzip (budget 1.5 MB, brief l.257).
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              {
                name: 'babylon-webgpu',
                test: /node_modules[\\/]@babylonjs[\\/]core[\\/](Engines[\\/](webgpuEngine|WebGPU)|ShadersWGSL|Audio)[\\/]/,
                priority: 20,
              },
              { name: 'babylon', test: /node_modules[\\/]@babylonjs[\\/]core[\\/]/, priority: 10 },
            ],
          },
        },
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.{test,spec}.{ts,tsx}'],
      // Vitest 4 excludes only node_modules and .git by default; keep the Playwright specs and the
      // build output out of the unit-test run.
      exclude: [...configDefaults.exclude, 'e2e/**', 'dist/**'],
      // 100 % coverage on the pure sky mathematics and the URL codec (brief l.294, plan D88).
      // `include` lists never-imported files too; `exclude` is load-bearing in Vitest 4 (its
      // "contains" matching would otherwise pull the colocated tests into the thresholds). The
      // brace pattern keeps `url.ts` selected under Vitest 5's directory semantics as well.
      coverage: {
        provider: 'v8',
        include: ['src/sky/math/**/*.ts', 'src/state/url.{ts,tsx}'],
        exclude: ['**/*.test.ts', 'src/test/**'],
        thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
        reporter: ['text'],
        reportOnFailure: true,
      },
    },
  };
});
