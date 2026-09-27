# ADR-0014: Augmented reality: sensor mode, WebXR on WebGL2 and the coverage-alpha blend

- Status: Accepted
- Date: 2026-09-24 (records decisions taken at M5 on 2026-09-17 and amended at M6 on 2026-09-23)

## Context

The brief specifies five AR requirements (l.237-241): an AR button only in a secure context, on Earth, on devices exposing a rear camera and orientation sensors (AR-1 [M]); a sensor mode with the rear camera video as background, `deviceorientationabsolute` on Android and `webkitCompassHeading` on iOS behind `DeviceOrientationEvent.requestPermission()` from a tap, the same sky layers on top and an adjustable camera field (AR-2 [M]); a calibration drag with a compass-accuracy indicator (AR-3 [M]); a WebXR `immersive-ar` session through Babylon's default experience helper with the yaw aligned to north (AR-4 [S]); graceful degradation (AR-5 [M]). The pitfalls fix the W3C intrinsic Z-X'-Y'' order, `screen.orientation.angle` and gesture-gated permissions (l.546), and the XR camera reset to the origin (l.543). The browser matrix says "WebGPU used when available" and "WebXR mode on Android Chromium browsers" (l.268); AR code must be lazy (l.257, ADR-0013). Maintainer questions 26 (WebGPU phones and WebXR) and 27 (the blend) are unanswered: the recorded defaults apply.

## Options considered

1. Pose source. (a) Babylon's `DeviceOrientationCamera` input: rejected, it owns the camera, knows no compass correction and no absolute/relative arbitration. (b) An own Babylon-free controller on the DOM events, its kernels in `sky/math/orientation.ts` verified to 1e-15 against the W3C matrix and to 1e-6 against Babylon's own output: chosen (D116, D117).
2. Camera background. (a) A Babylon `VideoTexture` on a background quad: rejected, a GPU upload per frame, tinted by night mode, no `object-fit: cover`. (b) A DOM `<video>` in an engine-owned underlay beneath a transparent canvas: chosen (D121).
3. Blending the sky over the video. (a) A `uAr` AR-only shader switch, identical to M4 outside AR: the recorded fallback (question 27, R80). (b) Coverage alpha `max(rgb)` and `ALPHA_PREMULTIPLIED_PORTERDUFF` in every mode: chosen (D122), because an [M] path must not rest on spec-undefined compositing of RGB > A, and it makes the PNG export defined too; star crossovers change from `rgb + dst` to `rgb + (1 - a) dst`.
4. WebXR backend. (a) On both backends: rejected, Chrome's WebXR/WebGPU binding is flag-only and Babylon 9.25 enters a session on WebGL2 alone. (b) WebGL2 only, WebGPU phones get the sensor mode: chosen (D129, backlog B-79). (c) Prefer WebGL2 at engine creation when `isSessionSupported('immersive-ar')` is true: offered to the maintainer as question 26.
5. XR camera. (a) Parent the sky meshes to the XR camera: rejected, ADR-0009 keeps one frozen world matrix. (b) Zero every rig position each frame and compose the north yaw into the rig quaternion in place: chosen (D130).
6. Experience helper. (a) `WebXRDefaultExperience.CreateAsync` with the UI, pointer selection, teleportation, near interaction and hand tracking off: chosen (D128). (b) `WebXRExperienceHelper` plus `enableFeature(WebXRDomOverlay)`, which would drop four controller features from the 129 kB gzip `XrBridge` chunk: could, device-only proof (backlog B-96, Q83).
7. Testing the bridge. (a) Device-only (M5, Q65). (b) A Node vitest on Babylon's `NullEngine` through a test-only `createExperience` seam: chosen at M6 (D161, backlog B-93).

## Decision

Records plan rows D115 to D134 (D130 also in ADR-0009), the M6 amendments of D157 (C5) and D161 (Q65), and maintainer questions 26 and 27.

- Gate and permission (D125, D126): `state/arCapabilities.ts` probes `isSecureContext`, `navigator.mediaDevices`, `DeviceOrientationEvent`, touch and a `videoinput` device once and on `devicechange`; the button renders only when every capability holds and `observer.body === 'earth'`; `state/arPermission.ts::requestOrientationPermission()` runs synchronously inside the click; the rear camera is verified at entry (`facingMode === 'user'` -> `noRearCamera`, B-76).
- Pose (D116-D118): `sky/ar/sensors.ts` -> `sky/ar/arController.ts` (imported lazily by `SkyEngine` when `ar.mode` becomes `requesting`, ticked in `tick`, disposed on `off`): per-sample source arbitration (an absolute sample within 1 s wins), the iOS compass correction, slerp smoothing (`tau` 80 ms), `(az, alt, roll)` plus the offset in one `setArPose` per frame; heading levels good/fair/poor at 15/35 degrees; both platforms give magnetic north and the AR-3 offset absorbs the declination (B-74, Q52).
- Roll and field (D119, D123): roll lives in `ar.roll` only and reaches the camera through `frames.ts::cameraRotationFor(az, alt, rollDeg)`; the diagonal field `D` (default 73 degrees, [50, 110]) becomes the vertical `fov` through `sky/math/cameraFov.ts` after the `object-fit: cover` crop.
- Calibration (D120; M6 D157 C5): a horizontal drag in `'offset'` mode calls `nudgeArOffset(dragDeltaDeg)`; M6 adds two 1-degree buttons beside the badge (`ar.offset.left`/`ar.offset.right`, "Turn the sky 1° left/right", SC 2.5.7) whose sign follows the label; a reset and the manual-north hint stay.
- Video and engine rules (D121, D122, D124): `sky/ar/cameraVideo.ts` appends the `<video autoplay muted playsinline>` into `SkyEngineOptions.underlayRoot`; tracks stop on exit, `visibilitychange: hidden`, `pagehide` and track `ended` (deferred during an XR session, R94); while AR runs the engine clears with alpha 0, hides the sky and ground quads, stops horizon culling, follow and centring, keeps labels, picking and refraction, and draws the video under the PNG export.
- WebXR (D128-D130, D132): `sky/engine/xr/XrBridge.ts` (reached only through `await import()`) creates the experience with `ignoreNativeCameraTransformation: true` and `inputOptions: { doNotLoadControllerMeshes, disableOnlineControllerRepository }` (Babylon otherwise fetches profiles from immersive-web.github.io, a foreign origin, l.580), requires `dom-overlay` on the overlay root, `local` space, `minZ/maxZ = 1/2000`; `xr.support = 'supported'` iff `isSessionSupported('immersive-ar')` and `engine.kind === 'webgl2'`; every failure and every session end returns to sensor mode with one banner; the WebXR globals come from Babylon's `engine.d.ts` (no `@types/webxr`).
- Chrome and tests (D127, D134; M6): `ui/ar/ArOverlay.tsx` (lazy) replaces the top bar as the DOM-overlay root; `e2e/ar.spec.ts` runs on `chromium-mobile` with fake media and a synthetic `deviceorientationabsolute` ticker, proves the lazy chunks by request and, at M6, scans three states with axe and exercises the nudge buttons; `sky/engine/xr/XrBridge.test.ts` (`// @vitest-environment node`, `NullEngine`, a fake experience through `XrBridge.create`'s fifth parameter) asserts the rig zeroing, the pose, `delta0` from a compass heading, the offset nudges and the fov mirror: the one sanctioned Babylon-under-Vitest exception (B-93).

## Consequences

- The `ar` slice is transient and never a URL parameter (ADR-0012, B-73); the eager bundle carries only the gate, the permission helper, the button and `cameraFov.ts` (B-75); everything else is a lazy chunk proven by `scripts/check_chunks.mjs` (ADR-0013).
- Inside an XR session there are no HTML labels, marker, picking, follow, centring or snapshot (B-80, Q62 kept); night mode leaves the video untinted and the export is not offered in AR (B-78).
- `Permissions-Policy` grants `camera`, `gyroscope`, `magnetometer`, `accelerometer` and `xr-spatial-tracking` to `(self)` (ADR-0018).
- The device rows of the manual checklist (`docs/testing.md` "Manual checks", D136) stay pending the maintainer (question 25), including the Q57 decision on the DPR cap from a `#dpr=1.5` run (D142).

## Revisit trigger

- Questions 26 or 27 answered the other way; Chrome unflags WebXR on WebGPU (then option 4a); Babylon requires the `unbounded` reference space (B-81) or changes `WebXRDefaultExperience`; a browser declination model (Q52); the B-96 helper swap proven on a device.

Pointers: `docs/architecture.md` ("Augmented reality"), `.claude/rules/frontend.md`, `.claude/rules/sky-math.md`, `.claude/rules/frontend-tests.md`, `docs/testing.md` ("Manual checks"), `docs/plan.md` section 3 (the rows above), section 11 (questions 25-27), `docs/backlog.md` (B-73 to B-81, B-93, B-96).
