# ADR-0009: Sky geometry in ENU with one reflection matrix

- Status: Accepted
- Date: 2026-09-06

## Context

The backend describes the sky in a right-handed local horizon frame: unit vectors ordered East, North, Up, with the azimuth measured from north through east (brief l.60, `astro/quaternions.py`). Babylon.js is left-handed and Y-up by default (brief l.543: "keep it"), and the brief fixes the mapping East -> +X, Up -> +Y, North -> +Z, to be implemented "in exactly one module (`frontend/src/sky/math/frames.ts`)" with unit tests for az = 0 -> +Z, az = 90 -> +X, alt = 90 -> +Y.

The permutation P that realises the mapping has determinant -1: it is a reflection, not a rotation. It therefore cannot be folded into the horizon quaternion the backend supplies (a quaternion only ever encodes a rotation), and it has to be applied somewhere between the ENU vectors and Babylon's clip space. Three layers produce sky geometry: the star mesh (471,820 vertices, positions and proper motions uploaded once, rotated per frame in the vertex shader), the body billboards (refreshed per frame on the CPU) and the reference lines (some static, some regenerated at 10 Hz). Two shader dialects exist for the stars and the bodies (GLSL for WebGL2, WGSL for WebGPU).

## Options considered

1. **Swizzle in every shader.** Each vertex shader ends with `vec3(enu.x, enu.z, enu.y)` before the projection, and the CPU paths (bodies, lines, the debug hook's projection) repeat the same swizzle. Rejected: the mapping would live in four shader files, two layers and one debug module, which contradicts brief l.60; a forgotten swizzle in one dialect would render a mirrored sky on one backend only, exactly the kind of divergence the two-backend Playwright run is meant to prevent.
2. **Convert on the CPU per vertex.** Upload star positions already permuted to Babylon axes and permute the horizon quaternion's action accordingly. Rejected: the rotation `q_h` acts on ENU vectors, so the shader would have to conjugate it by P on every vertex, or the CPU would have to re-upload 471,820 positions whenever the frame changes; both are per-frame work for a constant permutation, and the catalog buffers would no longer be the raw SKYS columns (`api/catalogs.ts` hands zero-copy views to the GPU).
3. **One frozen world matrix (chosen).** Every sky mesh keeps its geometry in ENU and carries P as its world matrix, frozen once with `mesh.freezeWorldMatrix(P)`. Babylon multiplies it into `worldViewProjection`, which the custom shaders already consume, so no shader contains an axis swizzle and no CPU path converts a vertex. The camera rotation for a view direction (`cameraRotationFor(az, alt) = { x: -alt, y: az, z: 0 }`) and the pure screen projection (`screenToDirection`, `directionToScreen`) live next to P in `frames.ts`.

## Decision

`sky/math/frames.ts` exports `enuToBabylonMatrix()`, the 4 x 4 column-major matrix of P (E -> +X, U -> +Y, N -> +Z), plus `enuToBabylon`/`babylonToEnu` for the unit tests. `SkyEngine` builds `Matrix.FromArray(enuToBabylonMatrix())` once and passes it to the star layer, the bodies layer and the line layers, each of which calls `freezeWorldMatrix(P)` on its meshes. Geometry, uniforms (`uHorizonQ`, `bodySun`), the CPU interpolation and the debug hook all stay in ENU; only Babylon's `worldViewProjection` crosses into the left-handed frame.

## Consequences

- Custom shaders use `worldViewProjection` and contain no axis swizzle; the GLSL and WGSL twins implement identical arithmetic, and the debug hook's CPU twin (`altAzOf`, `screenOf`) needs no frame conversion.
- A reflection flips the winding order, so `backFaceCulling` is off on the sky materials (stars and bodies are camera-facing quads anyway).
- `freezeWorldMatrix` skips Babylon's per-frame world-matrix recomputation and bounding-info synchronisation for these meshes; with `alwaysSelectAsActiveMesh`, `doNotSyncBoundingInfo` and `scene.skipFrustumClipping = true` the whole sky is drawn every frame, which is what a celestial sphere around the camera needs.
- The camera itself stays a `TargetCamera` at the origin in Babylon's frame; its rotation is derived from `(az, alt)` in `frames.ts`, the only other place that knows the axis convention.
- `alt` is clamped to +-89.99 degrees (`MAX_CAMERA_ALT_DEG`) because Babylon's look-at matrix is singular at the pole; the value survives the 0.01 degree URL rounding.

## Revisit trigger

- WebXR at M5: the XR camera is reset to the origin on session start and the sky must follow its position while ignoring translation (brief l.543). If parenting the sky meshes to the XR camera requires an unfrozen world matrix, P moves to a parent `TransformNode` (still one matrix, still defined in `frames.ts`).
- A Babylon.js release that changes `freezeWorldMatrix` semantics or makes `worldViewProjection` unavailable to `ShaderMaterial` on either backend.
