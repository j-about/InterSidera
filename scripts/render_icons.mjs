#!/usr/bin/env node
// Rasterise frontend/public/favicon.svg into the PWA and Apple icons (plan D161, backlog B-66):
//   icon-192.png, icon-512.png            transparent, manifest purpose "any"
//   icon-192-maskable.png, icon-512-maskable.png
//                                         a square #05070f fill behind the glyph (the maskable
//                                         safe zone is the inner 80 %: the four-point star of
//                                         favicon.svg spans 75 % of the width), purpose "maskable"
//   apple-touch-icon.png                  180x180, opaque (iOS composites the icon on black, so
//                                         a transparent one shows as a black square)
// The render is deterministic: one headless Chromium page per size at device scale factor 1,
// the SVG inlined at the exact pixel size, `omitBackground` for the transparent icons, PNG out.
// The browser is the Playwright Chromium the e2e suite uses, driven through `@playwright/test`
// (the declared devDependency; it re-exports the browser API of `playwright-core`) resolved
// from frontend/node_modules (no dependency of its own, no root `npx`). Not part of
// `make check`: run it after a change to favicon.svg and commit the PNGs
// (`frontend/src/data/icons.test.ts` reads their IHDR back, .gitattributes marks them generated).
// Usage: node scripts/render_icons.mjs [--out frontend/public]
//   On the sudo-less WSL export the Playwright library variables first (docs/dev-wsl2.md).
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = path.join(ROOT, 'frontend');
const SOURCE = path.join(FRONTEND, 'public', 'favicon.svg');
/** `background_color` / `theme_color` of manifest.webmanifest and the `<meta name="theme-color">`. */
const FILL = '#05070f';

const ICONS = [
  { file: 'icon-192.png', size: 192, fill: null },
  { file: 'icon-512.png', size: 512, fill: null },
  { file: 'icon-192-maskable.png', size: 192, fill: FILL },
  { file: 'icon-512-maskable.png', size: 512, fill: FILL },
  { file: 'apple-touch-icon.png', size: 180, fill: FILL },
];

function parseArgs(argv) {
  let out = path.join(FRONTEND, 'public');
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out' && argv[i + 1] !== undefined) {
      out = path.resolve(argv[i + 1]);
      i += 1;
    } else {
      throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  return { out };
}

/** The SVG markup at `size` pixels: the viewBox stays, width/height become the raster size. */
function svgAt(markup, size) {
  const sized = markup
    .replace(/\swidth="[^"]*"/, ` width="${size}"`)
    .replace(/\sheight="[^"]*"/, ` height="${size}"`);
  if (!sized.includes(`width="${size}"`) || !sized.includes(`height="${size}"`)) {
    throw new Error('favicon.svg carries no width/height attributes to resize');
  }
  return sized;
}

function pageFor(svg, size, fill) {
  const background = fill === null ? 'transparent' : fill;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; padding: 0; width: ${size}px; height: ${size}px; overflow: hidden; background: ${background}; }
    svg { display: block; }
  </style></head><body>${svg}</body></html>`;
}

/** Width and height of a PNG from its IHDR chunk (bytes 16..23), after the 8-byte signature. */
function ihdr(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    !signature.every((value, i) => bytes[i] === value) ||
    bytes.toString('latin1', 12, 16) !== 'IHDR'
  ) {
    throw new Error('not a PNG');
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function main() {
  const { out } = parseArgs(process.argv.slice(2));
  const require = createRequire(path.join(FRONTEND, 'package.json'));
  const { chromium } = require('@playwright/test');
  const markup = readFileSync(SOURCE, 'utf8').trim();
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const icon of ICONS) {
      const context = await browser.newContext({
        viewport: { width: icon.size, height: icon.size },
        deviceScaleFactor: 1,
        colorScheme: 'light',
      });
      const page = await context.newPage();
      await page.setContent(pageFor(svgAt(markup, icon.size), icon.size, icon.fill), {
        waitUntil: 'load',
      });
      const png = await page.screenshot({
        type: 'png',
        omitBackground: icon.fill === null,
        clip: { x: 0, y: 0, width: icon.size, height: icon.size },
        animations: 'disabled',
        caret: 'hide',
      });
      await context.close();
      const { width, height } = ihdr(png);
      if (width !== icon.size || height !== icon.size) {
        throw new Error(`${icon.file}: rendered ${width}x${height}, expected ${icon.size}`);
      }
      const target = path.join(out, icon.file);
      writeFileSync(target, png);
      console.log(`${path.relative(ROOT, target)}: ${width}x${height}, ${png.length} bytes`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
