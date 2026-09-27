# ADR-0010: One store, the engine-owned clock and the engine/UI seam

- Status: Accepted
- Date: 2026-09-24 (records decisions taken at M3 on 2026-09-06, M4 on 2026-09-09 and M6 on 2026-09-23; recording form, brief l.483 and l.508)

## Context

The brief asks for "a single simulation store (clock, observer, view options)" synchronized both ways with the URL (l.85-86), for a `requestAnimationFrame` loop that "belongs to `SkyEngine`" while "React re-renders never drive the canvas; the store notifies the engine through subscriptions" (l.409), for labels and lines refreshed at <= 10 Hz (l.257), for a live-mode drift under 100 ms (l.264, l.575) and for a smooth 3600x time-lapse (l.575). Three designs were on the table at M3: a React-driven clock (re-renders at frame rate, every component reading `tt` from React state), a second store for the UI chrome beside the simulation store (plan Q35), or one store whose time is owned by the engine. At M6 the follow-mode sawtooth (plan R95: the followed object drawn 41-54 px off centre on frames between two overlay ticks, because follow wrote `setView` inside the 100 ms overlay tick while `frames.evaluate` refreshed the direction every frame) forced the follow cadence to be decided again.

## Options considered

1. React owns time (`useEffect` + `setState` per frame). Rejected: contradicts l.409, re-renders the chrome at frame rate and puts `Date.now()` in renders (the react-hooks compiler rules forbid it).
2. Two stores (simulation and chrome). Rejected (Q35): a fact read by both the engine and a component would have two homes.
3. One zustand vanilla store, the engine owns the clock, the seam is typed. Chosen.
4. Follow cadence at M6: keep the 100 ms overlay tick (M4, D93) or write the view every frame (chosen, D139; plan R106 weighs the per-frame store spread). Moving the view ownership into the engine was rejected: the camera controller and the URL sync read `view` from the store.

## Decision

Records plan rows D75, D80, D87, D92, D93, D94 and the M6 amendment D139.

- D75 (time): TT Julian Date is canonical; one wall clock (`Date.now()`) for live and playing, `performance.now()` only for the fps ring; `ttMinusUtc` seeded from `/meta.server_time`; `tt` clamped to the ephemeris and observer coverage; `step_s = max(1, ceil(|speed| 60 / 32))` and snapshot mode below 5 s of real time (`sky/math/time.ts`).
- D80 (store): `state/store.ts` is a zustand vanilla `createStore` with `subscribeWithSelector`, shared by React (`useStore`) and the engine (selector subscriptions). `SkyEngine.tick` derives `tt` from the store's control block on every frame and publishes the `clock.tt` mirror at most every `PUBLISH_INTERVAL_MS = 500` ms (`sky/engine/SkyEngine.ts` l.119); the overlays refresh every `OVERLAY_INTERVAL_MS = 100` ms (l.121); the visible-label list reaches the store at <= 1 Hz on change. The store never ticks.
- D87 (boot): `state/boot.ts` runs `/health` (polled with `Retry-After`, ADR-0008) and, since M6 (plan D138), `/meta` alongside it, then the catalogs in parallel, the engine and the first frame window; every phase is mirrored into `boot` and stamped with `performance.mark('sky:<phase>')` (D141); `ui/SkyCanvas.tsx` creates the engine through an injected factory.
- D92 (slices): the M4 chrome state is the `ui` slice of the same store, never a second store; `frames.coverageStop` is set by `stopAtBound`, whose only two callers are the engine's clamp branch and the frame controller's 422 branch (`state/frameController.ts` l.395); `stepTime` derives its base from `ttAt`, never from the 2 Hz mirror.
- D93 (seam): `SkyEngineOptions` carries `labelRoot` (the `aria-hidden` sibling of the canvas that the engine's `LabelLayer` alone writes), `labelText(key)` (the engine imports no i18next) and `tickers` (the details controller is pulled by `tick`, no second timer); `SkyEngineApi` exposes `directionOf`, `readoutOf`, `pick`, `snapshot` (M5: `preloadXr`, `enterXr`, `exitXr`; M6: `perf` with `afterFrames(n)`, plan D140). React reaches the API only through `SkyCanvas.onEngine` for event-time calls; everything else flows through subscriptions and the engine's publications (`publishTt`, `publishReadout`, `setVisibleLabels`, `stopAtBound`, `setView`).
- D94 (one CPU twin): every CPU object direction (labels, lines, picking, follow, centring, readout, debug hook) comes from `sky/engine/resolver.ts` on the pure kernels of `sky/math/apparent.ts`, the single twin of the star and DSO shaders.
- D139 (M6 amendment of D93): follow writes `setView` on every frame inside `tick`, after `frames.evaluate` refreshed the direction and before the tick reads `view`, through the preallocated `followPatch` (`SkyEngine.ts` l.208-209 and l.1168-1184); centring stays in the overlay tick; follow is suspended while the sensors or the XR rig own the view. D80's "no allocation" is read as the `store.ts` spread the inertia glide already pays per frame (plan R106).

## Consequences

- No React state for a fact another component or the engine reads; every component takes `{ store }` and its test injects fakes; `state/domSync.ts` alone writes `<html>` attributes.
- The engine's per-frame allocation exceptions are listed in the `SkyEngine.ts` header: the 2 Hz readout copy, the label texts on an id change and the follow patch's store spread; the M6 heap sampling records the rest (plan D144, backlog B-91).
- Plan R95 is closed by D139 together with `e2e/selection.spec.ts` sampling `screenOf`, the canvas box and `state().tt` in one `page.evaluate` right after `afterFrames(1)` (plan D162); the proof is the two final `make e2e` runs: 57 passed / 7 skipped / 0 failed in 8.9 min (2026-09-24, two-block `a11y` file) and 58 passed / 8 skipped / 0 failed in 9.0 min on the final tree (2026-09-27, load 0.69); the one loaded run between them (load 18.7) had 3 starvation timeouts. The host-GPU rows of the final tree (staleness `Date.now() - tickWallMs`, l.264) are 17 ms on WebGPU, 12 ms in night mode, 19 ms on WebGL2 and 21-23 ms at `#dpr=1.5`, every window at 60 fps (2026-09-27, app-mode windows closed after each report); on the pre-final M6 tree they read 15 ms on WebGPU and 25-37 ms on WebGL2 at 60 fps (area A verify report, section 5.5).
- The `ar` slice follows the same rule: `setArPose` is one `set` per engine frame written by the controller or the XR bridge, never by React (plan D115, ADR-0014).

## Revisit trigger

- A second renderer (a worker-hosted engine, an OffscreenCanvas) or a React feature that needs the engine's state inside React: the seam would gain a message channel, still one store.
- A follow-mode regression on a real GPU (R95 was measured on SwiftShader and on the Windows host): the D139 block is the first place to look.

Pointers: `docs/architecture.md` ("Time model", "Store", "Engine <-> UI seam"), `.claude/rules/frontend.md`, `docs/plan.md` section 3 (the rows above), section 8 (R95, R106).
