// The WebGL2 set of Babylon.js modules (plan D81, D90; brief l.406, l.539). This file,
// `webgpu.ts` (the lazy WebGPU chunk) and `xr/babylonXr.ts` (the lazy WebXR set, plan D128) are
// the ONLY places with side-effect imports: Babylon 9's `X.js` entries re-export `X.pure.js` and
// run `RegisterX()`; a missing registration degrades silently to a stub (visible only with
// `SetMissingSideEffectWarningsEnabled(true)`, which `createEngine` turns on in dev and e2e
// builds). Everything else in `sky/engine/` imports Babylon through this module, always from
// `@babylonjs/core/<module>` subpaths (never the root, never `Legacy/legacy`).
//
// Each re-export below evaluates the module and its registrations; the reason for each:

// WebGL Engine plus its extension registrations (alpha modes, dynamic vertex buffers, uniform
// buffers, render targets, textures, DOM helpers). `webGLVersion` decides the UX-6 fallback.
// Load-bearing for the WebXR bridge too (plan D132, risk R88): `Engines/engine` pulls Babylon's
// WebXR ambient type declarations into the program, which `xr/XrBridge.ts` types against.
export { Engine } from '@babylonjs/core/Engines/engine';
// Scene (rendering groups, transparent sorting, `whenReadyAsync`); its constructor attaches the
// input manager, which `SkyEngine` detaches again (the camera controller owns the DOM events).
export { Scene } from '@babylonjs/core/scene';
// Rotation-only camera at the origin (D85); the entry registers the node constructor.
export { TargetCamera } from '@babylonjs/core/Cameras/targetCamera';
// Mesh (geometry, sub-meshes, `setVerticesBuffer`, `setIndices`, `freezeWorldMatrix`).
export { Mesh } from '@babylonjs/core/Meshes/mesh';
// VertexBuffer with the stride/type helpers registered (custom kinds need `size`; SHORT normalized
// for the star photometry) and the dynamic-buffer engine extension for `updateDirectly`.
export { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
// ShaderMaterial with `{ vertexSource, fragmentSource }` sources and the WGSL/GLSL switch.
export { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
// `CreateLineSystem` (D84) and its `VertexData`/`Mesh` registrations; it constructs LinesMesh.
export { CreateLineSystem } from '@babylonjs/core/Meshes/Builders/linesBuilder';
// Vectors, quaternions and matrices with their class registrations (`Matrix.FromArray` for P).
export { Matrix, Quaternion, Vector2, Vector3, Vector4 } from '@babylonjs/core/Maths/math.vector';
// Colours (scene clear colour, line colours).
export { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
// The GLSL colour shader LinesMesh uses under WebGL2. LinesMesh would otherwise `import()` it
// lazily (a second network round trip before the first grid appears); the WGSL twin lives in the
// WebGPU chunk (`webgpu.ts`).
import '@babylonjs/core/Shaders/color.vertex';
import '@babylonjs/core/Shaders/color.fragment';

// Side-effect-free modules (constants, enums, types).
export { Constants } from '@babylonjs/core/Engines/constants';
export { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage';
export { SetMissingSideEffectWarningsEnabled } from '@babylonjs/core/Misc/devTools';
export type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';
export type { LinesMesh } from '@babylonjs/core/Meshes/linesMesh';
