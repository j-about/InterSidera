// The WebXR set of Babylon.js modules (plan D128; brief l.240, l.257, l.539): the third and last
// place with side-effect imports beside `babylon.ts` (the WebGL set) and `webgpu.ts` (the WebGPU
// chunk). Reached ONLY through `await import('./xr/XrBridge')` in `SkyEngine.preloadXr` /
// `enterXr`, so the lazy `XrBridge` chunk carries every XR module and nobody downloads it before
// the "Immersive mode" tap (the controller prefetches it once `ar.xr.support` is `supported`).
// `scripts/check_chunks.mjs` proves the split (no `immersive-ar` / `XR-RigCamera` literal in an
// eager chunk). Everything else under `sky/engine/xr/` imports Babylon's XR classes from here and
// the rest from `../babylon`. One reason per import:

// The default experience helper (brief l.240 "Babylon's default XR experience helper"): creates
// the experience helper, the session manager, the WebXR camera with its rig and the managed
// output canvas, and registers the four controller features `CreateAsync` looks up (pointer
// selection, teleportation, near interaction, hand tracking), all disabled by our options.
export { WebXRDefaultExperience } from '@babylonjs/core/XR/webXRDefaultExperience';
// The `dom-overlay` feature (`RegisterWebXRDOMOverlay`): the overlay root the exit control, the
// badge, the hint and the calibration drag live in during a session (required, backlog B-81).
export { WebXRDomOverlay } from '@babylonjs/core/XR/features/WebXRDOMOverlay';

// Side-effect-free modules (enums and types).
export { WebXRState, WebXRTrackingState } from '@babylonjs/core/XR/webXRTypes';
export type { WebXRExperienceHelper } from '@babylonjs/core/XR/webXRExperienceHelper';
export type { WebXRSessionManager } from '@babylonjs/core/XR/webXRSessionManager';
export type { WebXRCamera } from '@babylonjs/core/XR/webXRCamera';
