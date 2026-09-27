// @vitest-environment node
// The installable icons (plan D161, backlog B-66): the PNGs rendered by scripts/render_icons.mjs
// from favicon.svg are read back from disk and their IHDR checked against manifest.webmanifest
// (every entry's `sizes` is the file's real size, `purpose` is `any` or `maskable`, never both on
// one file, the 192 and 512 pixel sizes web.dev requires for the install prompt are present for
// both purposes) and against the `apple-touch-icon` link of index.html (180x180).

import { readFileSync } from 'node:fs';

const PUBLIC = new URL('../../public/', import.meta.url);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
}

function isManifestIcon(value: unknown): value is ManifestIcon {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const icon = value as Record<string, unknown>;
  return (
    typeof icon.src === 'string' &&
    typeof icon.sizes === 'string' &&
    typeof icon.type === 'string' &&
    typeof icon.purpose === 'string'
  );
}

function manifestIcons(): ManifestIcon[] {
  const parsed: unknown = JSON.parse(readFileSync(new URL('manifest.webmanifest', PUBLIC), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('icons' in parsed)) {
    throw new Error('manifest.webmanifest has no icons');
  }
  const icons: unknown = parsed.icons;
  if (!Array.isArray(icons) || !icons.every(isManifestIcon)) {
    throw new Error('manifest.webmanifest icons have an unexpected shape');
  }
  return icons;
}

/** Width and height from the IHDR chunk, after checking the signature and the chunk type. */
function ihdr(file: string): { width: number; height: number } {
  const bytes = readFileSync(new URL(file, PUBLIC));
  expect(bytes.length).toBeGreaterThan(24);
  expect([...bytes.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
  expect(bytes.toString('latin1', 12, 16)).toBe('IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('the rendered icons', () => {
  it('are square PNGs of the sizes the manifest declares, one purpose each', () => {
    const icons = manifestIcons();
    const pngs = icons.filter((icon) => icon.type === 'image/png');
    expect(pngs.map((icon) => icon.src).sort()).toEqual([
      '/icon-192-maskable.png',
      '/icon-192.png',
      '/icon-512-maskable.png',
      '/icon-512.png',
    ]);
    for (const icon of pngs) {
      expect(['any', 'maskable']).toContain(icon.purpose);
      expect(icon.purpose).not.toContain(' ');
      const match = /^(\d+)x(\d+)$/.exec(icon.sizes);
      if (match === null) {
        throw new Error(`${icon.src}: sizes ${icon.sizes} is not WxH`);
      }
      const declared = { width: Number(match[1]), height: Number(match[2]) };
      expect(declared.width).toBe(declared.height);
      expect(ihdr(icon.src.replace(/^\//, ''))).toEqual(declared);
      // The maskable files carry the suffix; the plain ones are the `any` icons.
      expect(icon.src.endsWith('-maskable.png')).toBe(icon.purpose === 'maskable');
    }
    // Both purposes offer the two sizes the install criteria ask for.
    for (const purpose of ['any', 'maskable']) {
      const sizes = pngs.filter((icon) => icon.purpose === purpose).map((icon) => icon.sizes);
      expect(sizes.sort()).toEqual(['192x192', '512x512']);
    }
    // The vector icon stays first for browsers that scale it.
    expect(icons[0]).toEqual({
      src: '/favicon.svg',
      sizes: 'any',
      type: 'image/svg+xml',
      purpose: 'any',
    });
  });

  it('include the 180x180 Apple touch icon that index.html links', () => {
    expect(ihdr('apple-touch-icon.png')).toEqual({ width: 180, height: 180 });
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    expect(html).toMatch(
      /<link rel="apple-touch-icon" sizes="180x180" href="\/apple-touch-icon\.png" \/>/,
    );
  });

  it('keep the transparent icons transparent and the maskable ones opaque (the IHDR colour type)', () => {
    // IHDR byte 25 is the colour type: 6 = truecolour with alpha, 2 = truecolour without.
    const colourType = (file: string): number => readFileSync(new URL(file, PUBLIC)).readUInt8(25);
    expect(colourType('icon-192.png')).toBe(6);
    expect(colourType('icon-512.png')).toBe(6);
    // Opaque by construction (the square fill of the render script): Chromium encodes an opaque
    // capture without an alpha channel, colour type 2, on the pinned Playwright build. Should an
    // encoder change add a constant-255 alpha, relax this with the reason then, not before.
    expect(colourType('icon-192-maskable.png')).toBe(2);
    expect(colourType('icon-512-maskable.png')).toBe(2);
    expect(colourType('apple-touch-icon.png')).toBe(2);
  });
});
