#!/usr/bin/env node
// Lazy-chunk gate (make build, CI frontend job; plan D131, brief l.257 and l.478).
// The WebGPU engine, the AR controller, the AR overlay and the WebXR bridge must reach the
// browser only through their dynamic imports. Reads <dist>/.vite/manifest.json (build.manifest
// is on in vite.config.ts) and fails when:
//   (a) the static `imports` closure of the index.html entry contains one of the lazy modules or
//       a chunk named babylon-webgpu-*, webgpu-*, arController-*, ArOverlay-*, XrBridge-* or
//       webxr-* (the chunk Rolldown shares between the controller and the bridge), or one of the
//       lazy modules exists under <root>/src without a dynamic-entry chunk of its own (a module
//       that is also imported statically is folded into its importer and has no manifest key at
//       all, so the closure alone would never see it: plan risk R83);
//   (b) dist/index.html modulepreloads one of those files;
//   (c) an eager chunk contains the literals getUserMedia, deviceorientationabsolute,
//       immersive-ar or XR-RigCamera (identifiers are minified away, string literals survive):
//       this is also what catches a static import of sky/ar/{cameraVideo,sensors,webxr}.ts, whose
//       modules carry those literals and would be folded into the entry without a manifest key;
//   (d) a lazy chunk's static imports closure leads back to itself (a cycle: Rolldown groups with
//       includeDependenciesRecursively: false produce one that throws at evaluation);
//   (e) a Node ESM import() of dist/assets/webgpu-*.js throws (a ReferenceError on one of the
//       browser globals listed in DOM_GLOBALS is reported as skipped, anything else fails).
// Usage: node scripts/check_chunks.mjs [dist-dir] [vite-root]
//   defaults: frontend/dist and <dist-dir>/.. (the directory holding src/, i.e. frontend/).
// No dependencies; Node 24 built-ins only.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const LAZY_SOURCES = [
  'src/sky/engine/webgpu.ts',
  'src/sky/ar/arController.ts',
  'src/ui/ar/ArOverlay.tsx',
  'src/sky/engine/xr/XrBridge.ts',
];
const LAZY_PREFIXES = [
  'babylon-webgpu-',
  'webgpu-',
  'arController-',
  'ArOverlay-',
  'XrBridge-',
  'webxr-',
];
const FORBIDDEN_EAGER_LITERALS = [
  'getUserMedia',
  'deviceorientationabsolute',
  'immersive-ar',
  'XR-RigCamera',
];
/** Browser globals a chunk may touch at evaluation; Node has none of them (check (e)). */
const DOM_GLOBALS = new Set([
  'window',
  'document',
  'self',
  'location',
  'screen',
  'HTMLElement',
  'HTMLCanvasElement',
  'HTMLVideoElement',
  'Image',
  'Audio',
  'AudioContext',
  'OffscreenCanvas',
  'WebGLRenderingContext',
  'WebGL2RenderingContext',
  'requestAnimationFrame',
  'customElements',
  'XRWebGLLayer',
  'XRWebGLBinding',
  'XRRigidTransform',
  'GPUBufferUsage',
  'GPUTextureUsage',
  'GPUShaderStage',
  'GPUMapMode',
  'GPUColorWrite',
]);

const dist = path.resolve(
  process.argv[2] ?? path.join(import.meta.dirname, '..', 'frontend', 'dist'),
);
const root = path.resolve(process.argv[3] ?? path.join(dist, '..'));
const failures = [];
const notes = [];

function isLazyFile(file) {
  const base = path.basename(file);
  return LAZY_PREFIXES.some((prefix) => base.startsWith(prefix));
}

/** Kilobytes of 1000 bytes, as Vite's build report counts them. */
function kb(bytes) {
  return `${(bytes / 1000).toFixed(1)} kB`;
}

const manifestPath = path.join(dist, '.vite', 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error(`check_chunks: no manifest at ${manifestPath} (vite.config.ts build.manifest)`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const entryKey =
  Object.keys(manifest).find((key) => key === 'index.html' && manifest[key].isEntry) ??
  Object.keys(manifest).find((key) => manifest[key].isEntry);
if (entryKey === undefined) {
  console.error('check_chunks: the manifest has no entry chunk');
  process.exit(1);
}

/** Keys reachable from `start` through static `imports` (the start itself included). */
function staticClosure(start) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const key = queue.shift();
    for (const dep of manifest[key]?.imports ?? []) {
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return seen;
}

// (a) The eager closure of the entry.
const eager = staticClosure(entryKey);
for (const key of eager) {
  const file = manifest[key].file;
  if (LAZY_SOURCES.includes(key)) {
    failures.push(`(a) ${key} is imported statically from the entry (${file})`);
  } else if (isLazyFile(file)) {
    failures.push(`(a) the eager closure of ${entryKey} contains the lazy chunk ${file}`);
  }
}
// (a) Every lazy module present in the source tree owns a dynamic-entry chunk. A folded module
//     (statically imported somewhere in the main graph) has no manifest key, so the closure test
//     above cannot see it; a module nobody imports has none either.
const srcDir = path.join(root, 'src');
if (!existsSync(srcDir)) {
  failures.push(`(a) no source tree at ${srcDir}: pass the Vite root as the second argument`);
} else {
  for (const key of LAZY_SOURCES) {
    if (!existsSync(path.join(root, key))) continue;
    if (manifest[key]?.isDynamicEntry !== true) {
      failures.push(
        `(a) ${key} exists but has no dynamic-entry chunk in the manifest (folded into a static importer, or never imported?)`,
      );
    }
  }
}

// (b) Preloads in index.html (attribute order free: Vite writes `rel` first today, not by contract).
const indexHtmlPath = path.join(dist, 'index.html');
if (!existsSync(indexHtmlPath)) {
  failures.push(`(b) ${indexHtmlPath} is missing`);
} else {
  const html = readFileSync(indexHtmlPath, 'utf8');
  for (const tag of html.match(/<link\b[^>]*>/g) ?? []) {
    if (!/\brel=["']modulepreload["']/.test(tag)) continue;
    const href = /\bhref=["']([^"']+)["']/.exec(tag)?.[1];
    if (href !== undefined && isLazyFile(href)) {
      failures.push(`(b) index.html modulepreloads the lazy chunk ${href}`);
    }
  }
}

// (c) Forbidden literals inside the eager chunks.
for (const key of eager) {
  const file = path.join(dist, manifest[key].file);
  if (!existsSync(file) || !file.endsWith('.js')) continue;
  const text = readFileSync(file, 'utf8');
  for (const literal of FORBIDDEN_EAGER_LITERALS) {
    if (text.includes(literal)) {
      failures.push(`(c) the eager chunk ${manifest[key].file} contains "${literal}"`);
    }
  }
}

// (d) No lazy chunk is part of a static import cycle.
const lazyKeys = Object.keys(manifest).filter((key) => !eager.has(key));
for (const key of lazyKeys) {
  const seen = new Set();
  const queue = [...(manifest[key].imports ?? [])];
  while (queue.length > 0) {
    const dep = queue.shift();
    if (dep === key) {
      failures.push(`(d) the lazy chunk ${manifest[key].file} lies on a static import cycle`);
      break;
    }
    if (seen.has(dep)) continue;
    seen.add(dep);
    queue.push(...(manifest[dep]?.imports ?? []));
  }
}

// (e) The lazy WebGPU entry evaluates under Node (its imports included).
const assetsDir = path.join(dist, 'assets');
const webgpuFiles = existsSync(assetsDir)
  ? readdirSync(assetsDir).filter((name) => /^webgpu-.*\.js$/.test(name))
  : [];
if (webgpuFiles.length === 0) {
  failures.push(`(e) no webgpu-*.js chunk under ${assetsDir}`);
}
for (const name of webgpuFiles) {
  try {
    await import(pathToFileURL(path.join(assetsDir, name)).href);
    notes.push(`(e) import() of ${name} evaluated`);
  } catch (error) {
    const missing =
      error instanceof ReferenceError
        ? /^(\w+) is not defined$/.exec(error.message)?.[1]
        : undefined;
    if (missing !== undefined && DOM_GLOBALS.has(missing)) {
      notes.push(`(e) import() of ${name} skipped: ${missing} is not defined (browser global)`);
    } else {
      failures.push(
        `(e) import() of ${name} threw: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

// Report.
function sizes(keys) {
  return keys
    .map((key) => manifest[key].file)
    .filter((file) => file.endsWith('.js') && existsSync(path.join(dist, file)))
    .sort()
    .map((file) => {
      const bytes = statSync(path.join(dist, file)).size;
      const gz = gzipSync(readFileSync(path.join(dist, file))).length;
      return `    ${file}  ${kb(bytes)} (gzip ${kb(gz)})`;
    });
}
console.log(`check_chunks: ${dist} (sources under ${root})`);
console.log(`  eager (${eager.size} chunks):`);
for (const line of sizes([...eager])) console.log(line);
const lazyNamed = lazyKeys.filter((key) => isLazyFile(manifest[key].file));
console.log(`  lazy AR/XR/WebGPU (${lazyNamed.length} of ${lazyKeys.length} lazy chunks):`);
for (const line of sizes(lazyNamed)) console.log(line);
for (const note of notes) console.log(`  ${note}`);
if (failures.length > 0) {
  for (const line of failures) console.error(`  FAIL ${line}`);
  console.error(`check_chunks: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log('check_chunks: ok');
