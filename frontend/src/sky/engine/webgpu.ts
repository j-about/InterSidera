// The WebGPU chunk (plan D81, D90; brief l.538). Reached ONLY through `await import('./webgpu')`
// in `createEngine.ts`, after `navigator.gpu` exists, so WebGL2 users never download it; Vite's
// `codeSplitting` group `babylon-webgpu` keeps it out of the main bundle. Side-effect imports
// live here and in `babylon.ts` only, one reason per import (brief l.539).

// The WebGPU engine with its own extension registrations (alpha, textures, render targets, the
// WGSL shader processor, clear-quad shaders). `IsSupportedAsync` is a static getter.
export { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
// The WGSL colour shader LinesMesh selects under WebGPU (D84). LinesMesh would `import()` it
// lazily; importing it here makes the grid material compile with the rest of the chunk and
// never touches the network (no glslang/twgsl, brief l.538).
import '@babylonjs/core/ShadersWGSL/color.vertex';
import '@babylonjs/core/ShadersWGSL/color.fragment';
