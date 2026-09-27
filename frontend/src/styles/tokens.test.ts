// @vitest-environment node

import { readFileSync } from 'node:fs';

// Contrast of the design tokens (WCAG 2.2 AA SC 1.4.3 and 1.4.11, brief l.290; plan D157 C8):
// the gate that axe and Lighthouse cannot be here. axe marks `color-contrast` "incomplete" on
// every translucent surface (`--color-panel-bg` over the canvas) and on every `color-mix()` night
// token, so the M4 hand computation of docs/testing.md was the only contrast evidence. This test
// parses `app.css` (the `@theme` block, the `[data-mode='night']` block at brightness 1 and the
// `prefers-color-scheme: light` block), composites the translucent surfaces over the scheme's sky
// background and asserts the pairs: text >= 4.5:1, large text >= 3:1, the focus ring and the
// text-field border >= 3:1 against the surface they sit on. Outside the coverage include like the
// other node-environment suites. Night dimming below level 1 is the recorded exception (B-90).

type Rgb = readonly [number, number, number];
interface Rgba {
  rgb: Rgb;
  alpha: number;
}

const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');

/** `#rrggbb`, `rgb(r g b / a)` or a night `color-mix(in srgb, #hex calc(var(--night-brightness) * 100%), black)` at brightness 1. */
function parseColor(value: string): Rgba {
  const text = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(text);
  if (hex?.[1] !== undefined) {
    const n = Number.parseInt(hex[1], 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  const rgb = /^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/.exec(text);
  if (rgb) {
    return {
      rgb: [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])],
      alpha: rgb[4] === undefined ? 1 : Number(rgb[4]),
    };
  }
  const mix =
    /^color-mix\(in srgb, (#[0-9a-f]{6}) calc\(var\(--night-brightness\) \* 100%\), black\)$/i.exec(
      text,
    );
  if (mix?.[1] !== undefined) {
    // At brightness 1 the mix is the colour itself; below 1 it darkens towards black (B-90).
    return parseColor(mix[1]);
  }
  throw new Error(`unparsed colour: ${value}`);
}

/** The `--color-*` declarations of one CSS block body. */
function tokensOf(body: string): Map<string, Rgba> {
  const tokens = new Map<string, Rgba>();
  for (const match of body.matchAll(/--color-([a-z-]+):\s*([^;]+);/g)) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) {
      tokens.set(name, parseColor(value));
    }
  }
  return tokens;
}

/** The body of the block that starts at the first `{` after `opener` (one nesting level). */
function blockAfter(opener: RegExp): string {
  const at = opener.exec(css);
  if (at === null) {
    throw new Error(`block not found: ${opener.source}`);
  }
  const start = css.indexOf('{', at.index + at[0].length - 1) + 1;
  let depth = 1;
  for (let i = start; i < css.length; i += 1) {
    if (css[i] === '{') {
      depth += 1;
    } else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return css.slice(start, i);
      }
    }
  }
  throw new Error(`unterminated block: ${opener.source}`);
}

const THEME = tokensOf(blockAfter(/@theme\s*\{/));
const NIGHT = tokensOf(blockAfter(/\[data-mode='night'\]\s*\{/));
const LIGHT = tokensOf(blockAfter(/:root:not\(\[data-mode='night'\]\)\s*\{/));

type SchemeName = 'dark' | 'light' | 'night';
const SCHEMES: Record<SchemeName, Map<string, Rgba>> = {
  dark: THEME,
  light: new Map([...THEME, ...LIGHT]),
  night: new Map([...THEME, ...NIGHT]),
};

function token(scheme: SchemeName, name: string): Rgba {
  const value = SCHEMES[scheme].get(name);
  if (value === undefined) {
    throw new Error(`no token --color-${name} in the ${scheme} scheme`);
  }
  return value;
}

/** `top` composited over the opaque `bottom` (source-over). */
function over(top: Rgba, bottom: Rgb): Rgb {
  const mix = (t: number, b: number): number => top.alpha * t + (1 - top.alpha) * b;
  return [mix(top.rgb[0], bottom[0]), mix(top.rgb[1], bottom[1]), mix(top.rgb[2], bottom[2])];
}

/** WCAG relative luminance of an sRGB colour (channels 0-255, fractional after compositing). */
function luminance([r, g, b]: Rgb): number {
  const linear = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** The WCAG contrast ratio of two opaque colours, `>= 1`. */
function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The opaque surfaces of a scheme: the sky, the panel over it, a text field over the panel. */
function surfaces(scheme: SchemeName): { sky: Rgb; panel: Rgb; field: Rgb; accent: Rgb } {
  const sky = token(scheme, 'sky-bg').rgb;
  const panel = over(token(scheme, 'panel-bg'), sky);
  const field = over(token(scheme, 'field-bg'), panel);
  return { sky, panel, field, accent: token(scheme, 'accent').rgb };
}

/** Opaque text tokens only: a translucent foreground would need its own compositing. */
function opaque(scheme: SchemeName, name: string): Rgb {
  const value = token(scheme, name);
  expect(value.alpha, `--color-${name} in ${scheme} is opaque`).toBe(1);
  return value.rgb;
}

/**
 * `border-muted/<alpha>`: the text-field border TextField.tsx draws over the field surface, read
 * from the component source so the gate proves the alpha that ships, not a constant beside it.
 */
const textField = readFileSync(new URL('../ui/components/TextField.tsx', import.meta.url), 'utf8');
const alphaMatch = /border border-muted\/(\d+)/.exec(textField);
if (alphaMatch?.[1] === undefined) {
  throw new Error('TextField border alpha not found');
}
const FIELD_BORDER_ALPHA = Number(alphaMatch[1]) / 100;

const TEXT_MIN = 4.5;
const LARGE_TEXT_MIN = 3;
const NON_TEXT_MIN = 3;

describe('the token blocks', () => {
  it('reads @theme, the night block and the light block, and every scheme resolves 13 tokens', () => {
    expect(THEME.size).toBe(13);
    expect(NIGHT.size).toBe(13);
    expect(LIGHT.size).toBe(9);
    for (const scheme of ['dark', 'light', 'night'] as const) {
      expect(SCHEMES[scheme].size, `${scheme} scheme`).toBe(13);
    }
  });
});

describe.each(['dark', 'light', 'night'] as const)('%s scheme tokens', (scheme) => {
  const s = surfaces(scheme);

  it.each([
    ['panel-fg', 'panel'],
    ['muted', 'panel'],
    ['warn', 'panel'],
    ['danger', 'panel'],
    ['accent', 'panel'],
    ['panel-fg', 'field'],
    ['sky-fg', 'sky'],
    ['sky-warn', 'sky'],
  ] as const)('text --color-%s on the %s surface reaches 4.5:1', (name, surface) => {
    expect(contrast(opaque(scheme, name), s[surface])).toBeGreaterThanOrEqual(TEXT_MIN);
  });

  it('text on the accent (the primary button) reaches 4.5:1', () => {
    expect(contrast(opaque(scheme, 'on-accent'), s.accent)).toBeGreaterThanOrEqual(TEXT_MIN);
  });

  it('the accent as a large label over the panel reaches 3:1', () => {
    expect(contrast(opaque(scheme, 'accent'), s.panel)).toBeGreaterThanOrEqual(LARGE_TEXT_MIN);
  });

  it('the focus ring reaches 3:1 on the panel and on the sky', () => {
    expect(contrast(opaque(scheme, 'focus'), s.panel)).toBeGreaterThanOrEqual(NON_TEXT_MIN);
    expect(contrast(opaque(scheme, 'sky-focus'), s.sky)).toBeGreaterThanOrEqual(NON_TEXT_MIN);
  });

  it('the text-field border reaches 3:1 against the panel around it and the field inside it', () => {
    const border = over({ rgb: opaque(scheme, 'muted'), alpha: FIELD_BORDER_ALPHA }, s.field);
    expect(contrast(border, s.panel)).toBeGreaterThanOrEqual(NON_TEXT_MIN);
    expect(contrast(border, s.field)).toBeGreaterThanOrEqual(NON_TEXT_MIN);
  });
});

describe('the parser', () => {
  it('reads every syntax app.css uses and refuses the rest', () => {
    expect(parseColor('#05070f')).toEqual({ rgb: [5, 7, 15], alpha: 1 });
    expect(parseColor('rgb(10 13 24 / 0.85)')).toEqual({ rgb: [10, 13, 24], alpha: 0.85 });
    expect(parseColor('rgb(0 0 0)')).toEqual({ rgb: [0, 0, 0], alpha: 1 });
    expect(
      parseColor('color-mix(in srgb, #ff3b30 calc(var(--night-brightness) * 100%), black)'),
    ).toEqual({ rgb: [255, 59, 48], alpha: 1 });
    expect(() => parseColor('oklch(0.5 0.1 200)')).toThrow(/unparsed/);
    expect(() => blockAfter(/@nothing\s*\{/)).toThrow(/not found/);
  });

  it('computes the WCAG reference ratios', () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrast([255, 255, 255], [255, 255, 255])).toBe(1);
    // #767676 on white is the classic 4.54:1 AA boundary.
    expect(contrast([118, 118, 118], [255, 255, 255])).toBeCloseTo(4.54, 2);
    expect(over({ rgb: [255, 255, 255], alpha: 0.5 }, [0, 0, 0])).toEqual([127.5, 127.5, 127.5]);
  });
});
