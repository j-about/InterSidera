import { readFileSync } from 'node:fs';

import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

import pkg from './package.json' with { type: 'json' };

/**
 * A trusted development certificate for phones (plan D135, backlog B-82): `DEV_TLS_CERT` and
 * `DEV_TLS_KEY` are Node-side variables of this config (never `VITE_*`, nothing reaches the
 * client), both required, pointing at PEM files (mkcert's `<ip>+3.pem` / `<ip>+3-key.pem`).
 * When set, `vite dev` and `vite preview` serve HTTPS with them and the basic-ssl plugin is
 * skipped: its self-signed leaf has no CA flag and a DNS-only SAN, so a phone cannot trust it
 * over the LAN. `undefined` when neither is set; one without the other is a configuration error.
 */
function devTls(): { cert: Buffer; key: Buffer } | undefined {
  const cert = process.env.DEV_TLS_CERT;
  const key = process.env.DEV_TLS_KEY;
  if (cert === undefined && key === undefined) {
    return undefined;
  }
  if (cert === undefined || key === undefined) {
    throw new Error('DEV_TLS_CERT and DEV_TLS_KEY must be set together (docs/dev-wsl2.md)');
  }
  return { cert: readFileSync(cert), key: readFileSync(key) };
}

// https://vite.dev/config/ — Vitest reads its `test` block from this same file (plan D14), so
// `defineConfig` comes from 'vitest/config' to type both halves.
export default defineConfig(({ command, mode, isPreview }) => {
  // HTTPS only for the interactive dev server: geolocation, camera, device orientation and WebXR
  // need a secure context on a phone (brief l.95, l.548). `vite preview` stays plain HTTP on 4173
  // so the Playwright web server and CI never deal with a self-signed certificate (plan D15),
  // unless `DEV_TLS_*` hand it a trusted certificate for a phone on the LAN (plan D135).
  const interactiveDev = command === 'serve' && mode === 'development' && !isPreview;
  const https = devTls();

  return {
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    plugins: [
      react(),
      tailwindcss(),
      ...(interactiveDev && https === undefined ? [basicSsl()] : []),
    ],
    server: {
      port: 5173,
      strictPort: true,
      // Same-origin `/api` in development; the API listens on 8000 (brief l.20, l.95). The target
      // is 127.0.0.1, not `localhost`, which Node may resolve to ::1 while uvicorn binds IPv4 only.
      proxy: { '/api': { target: 'http://127.0.0.1:8000' } },
      ...(https === undefined ? {} : { https }),
    },
    // `preview.proxy` inherits `server.proxy`, so the e2e smoke test reaches the API through 4173.
    preview: { port: 4173, strictPort: true, ...(https === undefined ? {} : { https }) },
    build: {
      // `.vite/manifest.json` feeds scripts/check_chunks.mjs (the lazy-chunk gate, plan D131).
      manifest: true,
      // Vite 8 is Rolldown-based: `codeSplitting` groups, never `rollupOptions` / `manualChunks`
      // (brief l.549, plan D90, D131). Two groups: `babylon-webgpu` (the WebGPU engine, the WGSL
      // shaders and the audio engine, reached only through the dynamic import in
      // sky/engine/webgpu.ts, so WebGL2 users never download it) and `babylon` (the rest of
      // @babylonjs/core) tagged `$initial` with the higher priority. Rolldown groups capture
      // their dependencies recursively: without the tag the shared modules landed in the WebGPU
      // chunk, which `index` and `babylon` then imported statically and index.html preloaded
      // (the M3/M4 builds shipped 145 kB gzip of WebGPU code to everyone; D90 amended). Never
      // `includeDependenciesRecursively: false` on the lazy group: it yields a cyclic
      // webgpu/babylon-webgpu pair that throws `Class extends value undefined` at evaluation. The
      // AR controller, the AR overlay and the WebXR bridge need no group: a dynamic-only import
      // of an application module becomes its own chunk. scripts/check_chunks.mjs (make build, CI)
      // proves the split on `.vite/manifest.json`. Measured on 2026-09-17 with `make build` (the
      // gate's zlib figures): eager index 178.1 kB + babylon 229.6 kB + runtime 0.4 kB gzip
      // (408 kB; 397 kB right after the regrouping at the contract step, down from 505 kB with
      // the eager WebGPU chunk), lazy babylon-webgpu 95.2 kB (68.1 kB before the XR graph made
      // the WGSL `default.*` shaders reachable, plan Q63/R96) + webgpu 0.9 kB, arController
      // 3.3 kB, ArOverlay 2.0 kB, XrBridge 129.1 kB and the shared webxr 1.2 kB gzip, plus 31
      // small on-demand Babylon chunks (audio, texture loaders, shaders) nothing requests
      // (budget 1.5 MB, brief l.257).
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              {
                name: 'babylon-webgpu',
                test: /node_modules[\\/]@babylonjs[\\/]core[\\/](Engines[\\/](webgpuEngine|WebGPU)|ShadersWGSL|Audio)[\\/]/,
                priority: 20,
              },
              {
                name: 'babylon',
                test: /node_modules[\\/]@babylonjs[\\/]core[\\/]/,
                tags: ['$initial'],
                priority: 30,
              },
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
