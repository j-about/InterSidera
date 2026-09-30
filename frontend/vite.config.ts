import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { configDefaults, defineConfig } from 'vitest/config';

import pkg from './package.json' with { type: 'json' };
import {
  CSP_GEOCODER_ORIGIN_DEFAULT,
  geocoderOriginFromEnv,
  securityHeaders,
} from './security-headers.ts';

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

  // The security headers of the web tier come from one module (security-headers.ts, plan D147):
  // `vite preview` serves the production values, `vite dev` the same policy plus a per-process
  // nonce on `script-src` and `style-src` (the Fast Refresh preamble of @vitejs/plugin-react is
  // an inline module script and the dev client injects `<style>` elements; `html.cspNonce` stamps
  // both, dev only: a build would bake a static nonce into dist/index.html). The geocoder origin
  // (`connect-src`) is `SKY_GEOCODER_ORIGIN` (plan D148) from the repository-root `.env` files
  // through Vite's own loader with the prefix filter (no `SKYAPI_*` value is read), `process.env`
  // winning; the default is Nominatim. It is resolved only when this config serves pages (`vite
  // dev`, `vite preview`): `vite build` and vitest never read `.env`, so check, test and types
  // stay hermetic (rules/tooling.md). Nothing of this reaches the client bundle.
  const servesPages = interactiveDev || isPreview === true;
  const geocoderOrigin = servesPages
    ? geocoderOriginFromEnv({
        ...loadEnv(mode, resolve(import.meta.dirname, '..'), 'SKY_GEOCODER_ORIGIN'),
        ...process.env,
      })
    : CSP_GEOCODER_ORIGIN_DEFAULT;
  const nonce = interactiveDev ? randomBytes(16).toString('base64') : undefined;

  return {
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    plugins: [
      react(),
      tailwindcss(),
      ...(interactiveDev && https === undefined ? [basicSsl()] : []),
    ],
    ...(nonce === undefined ? {} : { html: { cspNonce: nonce } }),
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        // Same-origin `/api` in development; the API listens on 8000 (brief l.20, l.95). The
        // target is 127.0.0.1, not `localhost`, which Node may resolve to ::1 while uvicorn binds
        // IPv4 only.
        '/api': { target: 'http://127.0.0.1:8000' },
        // The dev/e2e self-test report collector (plan D168, docs/dev-wsl2.md): `__sky.selfTest`
        // POSTs its report to a same-origin path, allowed by `connect-src 'self'`, and the proxy
        // hands it to the local collector on 9911 (a 502 when nothing listens). Inherited by
        // `preview.proxy`; nginx never has it.
        '/__selftest': { target: 'http://127.0.0.1:9911' },
      },
      ...(https === undefined ? {} : { https }),
      ...(nonce === undefined ? {} : { headers: securityHeaders({ geocoderOrigin, nonce }) }),
    },
    // `preview.proxy` inherits `server.proxy`, so the e2e smoke test reaches the API through 4173.
    // The preview binds 127.0.0.1 explicitly: Playwright's `webServer.url`, the CI curl loop and
    // scripts/lighthouse.mjs all address 127.0.0.1:4173, and Vite's default `localhost` is
    // resolved by Node in the resolver's order, ::1 first on GitHub's ubuntu-latest (the first
    // remote e2e job waited 60 s for a server listening on IPv6 only). `--host` still overrides
    // it for a phone on the LAN (docs/dev-wsl2.md).
    preview: {
      host: '127.0.0.1',
      port: 4173,
      strictPort: true,
      headers: securityHeaders({ geocoderOrigin }),
      ...(https === undefined ? {} : { https }),
    },
    build: {
      // `.vite/manifest.json` feeds scripts/check_chunks.mjs (the lazy-chunk gate, plan D131).
      manifest: true,
      // Source maps for the e2e build only (plan D146): the manual `perf` Playwright project maps
      // its heap-sampling sites back to `src/` through them. Production ships no maps.
      sourcemap: mode === 'e2e',
      // Vite 8 is Rolldown-based: `codeSplitting` groups, never `rollupOptions` / `manualChunks`
      // (brief l.549, plan D90, D131). Two groups: `babylon-webgpu` (the WebGPU engine and the
      // audio engine, reached only through the dynamic import in sky/engine/webgpu.ts, so WebGL2
      // users never download it) and `babylon` (the rest of @babylonjs/core) tagged `$initial`
      // with the higher priority. Rolldown groups capture their dependencies recursively: without
      // the tag the shared modules landed in the WebGPU chunk, which `index` and `babylon` then
      // imported statically and index.html preloaded (the M3/M4 builds shipped 145 kB gzip of
      // WebGPU code to everyone; D90 amended). Never `includeDependenciesRecursively: false` on
      // the lazy group: it yields a cyclic webgpu/babylon-webgpu pair that throws `Class extends
      // value undefined` at evaluation. The group test names no `ShadersWGSL` directory (plan
      // D143): the WGSL modules the engine needs (`clearQuad.*`, the `color.*` line shader of
      // sky/engine/webgpu.ts and their includes) are reached statically and follow through the
      // recursive capture, whereas the XR graph (WebXRDefaultExperience's controller, teleport
      // and hand-tracking features import StandardMaterial) makes the WGSL `default.*` material
      // shaders reachable too: 172.8 kB raw of string literals that the old `ShadersWGSL`
      // alternative captured into `babylon-webgpu` (96.2 kB gzip with Babylon 9.27). Without it
      // they become lazy chunks nothing requests. The AR controller, the AR overlay and the WebXR
      // bridge need no group: a dynamic-only import of an application module becomes its own
      // chunk. scripts/check_chunks.mjs (make build, CI) proves the split on
      // `.vite/manifest.json`, with an eager gzip budget and the rule that `defaultPixelShader`
      // appears in no eager chunk, `babylon-webgpu-*` or `webgpu-*` (checks (f) and (g), plan
      // D143). Measured on 2026-09-23 with `make build` (the gate's zlib figures): eager index
      // 187.0 kB + babylon 233.0 kB + runtime 0.4 kB gzip (420 kB, unchanged by the regex), lazy
      // babylon-webgpu 66.2 kB (96.2 kB before) + webgpu 1.3 kB, XrBridge 129.0 kB, arController
      // 3.3 kB, ArOverlay 2.0 kB, the shared webxr 1.2 kB, 51 lazy chunks in all (38 before;
      // budget 1.5 MB, brief l.257).
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              {
                name: 'babylon-webgpu',
                test: /node_modules[\\/]@babylonjs[\\/]core[\\/](Engines[\\/](webgpuEngine|WebGPU)|Audio)[\\/]/,
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
      // The headers module lives next to this config (Node side, tsconfig.node.json); its test
      // runs under the node environment (`// @vitest-environment node`) and stays outside the
      // coverage include below.
      include: ['src/**/*.{test,spec}.{ts,tsx}', 'security-headers.test.ts'],
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
