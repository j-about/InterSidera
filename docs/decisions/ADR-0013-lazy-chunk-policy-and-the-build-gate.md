# ADR-0013: Lazy-chunk policy and the build gate

- Status: Accepted
- Date: 2026-09-24 (records decisions taken at M3 on 2026-09-06, M5 on 2026-09-17 and M6 on 2026-09-23; recording form)

## Context

The brief budgets the main JavaScript bundle at <= 1.5 MB gzipped with "AR/WebXR code split into lazily loaded chunks" (l.257; acceptance l.580), makes the AR definition of done "the e2e suite still passes with AR code split into lazy chunks" (l.478), requires Vite 8's `build.rolldownOptions.output.codeSplitting` (no `manualChunks`, l.549) and WGSL twins with no CDN shader compiler (l.540). The M3 and M4 builds silently shipped the 145 kB gzip WebGPU chunk to every user: `index` and `babylon` imported it statically and `index.html` preloaded it, which no gate caught (plan D131). With Babylon 9.27.1 (Step 0 of M6) the `ShadersWGSL` alternative of the M5 group regex captured 172.8 kB raw of WGSL string literals reachable only through the XR graph into `babylon-webgpu` (96.2 kB gzip).

## Options considered

1. `manualChunks`. Rejected: l.549 and Rolldown's object form is gone.
2. No gate, sizes read by hand from the build log. Rejected: the M3/M4 regression proved a silent preload is invisible without a manifest check.
3. `includeDependenciesRecursively: false` on the lazy group. Rejected: it yields a cyclic `webgpu`/`babylon-webgpu` pair that throws `Class extends value undefined` at evaluation (D131).
4. Keep `ShadersWGSL` in the group test (M5) or drop it (M6, plan D143, closes Q63 and R96). Dropped: the WGSL modules the engine needs follow the recursive capture anyway, the XR-only material shaders become lazy chunks nothing requests.
5. Source maps in production for the heap profiler. Rejected: `build.sourcemap: mode === 'e2e'` only (D146); production ships no maps.

## Decision

Records plan rows D81, D90, D131, D143 and D146 (with backlog B-83, B-92 and risks R58, R82, R83).

- D81 (engine creation): the WebGPU engine lives in the lazily imported `sky/engine/webgpu.ts`, used when `navigator.gpu` exists and `WebGPUEngine.IsSupportedAsync` resolves true; `initAsync()` failures fall back to WebGL2; never `glslangOptions`/`twgslOptions`.
- D90 and D131 (grouping): `frontend/vite.config.ts` declares two `codeSplitting.groups`: `babylon-webgpu` (priority 20) and `babylon` tagged `$initial` (priority 30) with the default recursive capture; the AR controller, the AR overlay and the WebXR bridge need no group because a dynamic-only import of an application module becomes its own chunk (`arController-*`, `ArOverlay-*`, `XrBridge-*`, plus the shared `webxr-*`); `build.manifest: true` feeds the gate.
- D143 (M6 regex): the group test is `/node_modules[\\/]@babylonjs[\\/]core[\\/](Engines[\\/](webgpuEngine|WebGPU)|Audio)[\\/]/`; measured at the M6 contract step on Babylon 9.27.1: `babylon-webgpu` 66.2 kB gzip (96.2 kB before), `webgpu` 1.3 kB, 51 lazy chunks (38 before), eager `index` 187.0 + `babylon` 233.0 + runtime 0.4 kB gzip unchanged by the regex (the plan's 65.5 kB / 49 chunks were Babylon 9.25.0 figures).
- The gate `scripts/check_chunks.mjs` (`make build`, the CI frontend job; Node built-ins only) reads `dist/.vite/manifest.json` and fails when: (a) the static import closure of the entry contains a lazy module or a chunk of the six lazy prefixes, or a lazy source has no dynamic-entry chunk of its own (R83); (b) `index.html` modulepreloads one; (c) an eager chunk contains the literals `getUserMedia`, `deviceorientationabsolute`, `immersive-ar` or `XR-RigCamera`; (d) a lazy chunk's closure leads back to itself; (e) a Node `import()` of `webgpu-*.js` throws; (f) the eager `.js` chunks gzipped together exceed `EAGER_GZIP_BUDGET_BYTES = 1_500_000` (the total is printed on every run); (g) the literal `defaultPixelShader` appears in an eager chunk, in `babylon-webgpu-*.js` or in `webgpu-*.js`. Checks (f) and (g) are the M6 additions (D143, backlog B-92 amending B-83).
- D146 (measurement project): the manual Playwright project `perf` (`testMatch: /perf\.spec\.ts/`, Desktop Chrome; the other projects carry `testIgnore: /(webgpu|perf)\.spec\.ts/`; never in `make e2e` or CI) boots the app under four CDP network profiles and samples the heap for 6 s, mapping sites through the e2e source maps; `e2e/perf.spec.ts` runs `mode: 'default'` so `npm --prefix frontend run e2e -- --project=perf` uses one worker without a flag (area A final report, section 1).

## Consequences

- A static import of `sky/ar/**`, `sky/engine/xr/**` or `ui/ar/ArOverlay.tsx` fails the build; a Babylon or Vite bump re-runs the gate and is the first suspect when a chunk moves (R58, R82, plan R98 at M6).
- Figures of record: the e2e build of the final M6 tree prints `eager .js gzip total: 422.2 kB of the 1500.0 kB budget (check (f))` with 52 lazy chunks (the hook chunk included; area A final report, section 3.4); the production `make build` of the milestone commit prints `eager .js gzip total: 421.8 kB of the 1500.0 kB budget (check (f))`: `babylon` 233.0 + `index` 188.3 + runtime 0.4 kB gzip eager, lazy `babylon-webgpu` 66.2, `webgpu` 1.3, `XrBridge` 129.0, `arController` 3.3, `ArOverlay` 2.1, `webxr` 1.2 kB gzip, 51 lazy chunks, (g) 0 occurrences, the `__sky` grep clean, `check_chunks: ok` (Step F `make build` on the final code tree, 2026-09-24, repeated before the commit).
- The two lazy `default.fragment-*` chunks holding the WGSL material shaders (109,220 and 113,318 B) exist but are never requested; (g) is what proves it.
- `make build` runs the gate and then a grep proving `dist/assets` contains no `__sky`: the debug hook stays a dynamic import under `import.meta.env.DEV || import.meta.env.MODE === 'e2e'`, so production carries neither the hook nor the `#engine`/`#dpr` overrides.
- The e2e build carries source maps (2.2 MB for `index`), read only by the `perf` project and never shipped.

## Revisit trigger

- Rolldown changes the `$initial` tag or the priority semantics; Babylon moves the WebGPU engine or the audio engine out of the two directories the regex names; Vite gains a first-class bundle-budget option (then (f) may move there); a bundle-size regression on a refresh (D164).

Pointers: `.claude/rules/tooling.md`, `docs/testing.md` (the bundle rows and the `perf` project), `docs/plan.md` section 3 (the rows above), `docs/backlog.md` (B-83, B-92).
