// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  CSP_GEOCODER_ORIGIN_DEFAULT,
  cspHeader,
  geocoderOriginFromEnv,
  securityHeaders,
} from './security-headers.ts';

// The web-tier headers (plan D147, D148): every directive exactly once, no inline or eval
// relaxation anywhere, the nonce on `script-src` and `style-src` only, the geocoder origin
// validated as an origin.

const ORIGIN = 'https://geocoder.example';
const NONCE = 'q7ZbT2nZ0g3q1vJmXfW4Yg==';

const DIRECTIVES = [
  'default-src',
  'script-src',
  'style-src',
  'img-src',
  'connect-src',
  'manifest-src',
  'worker-src',
  'media-src',
  'object-src',
  'base-uri',
  'form-action',
  'frame-ancestors',
];

function directivesOf(csp: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of csp.split('; ')) {
    const [name, ...sources] = entry.split(' ');
    if (name === undefined || map.has(name)) {
      throw new Error(`malformed or repeated directive in ${JSON.stringify(csp)}`);
    }
    map.set(name, sources.join(' '));
  }
  return map;
}

describe('cspHeader', () => {
  it('is the exact production policy', () => {
    expect(cspHeader({ geocoderOrigin: ORIGIN })).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; " +
        `connect-src 'self' ${ORIGIN}; manifest-src 'self'; worker-src 'none'; ` +
        "media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; " +
        "frame-ancestors 'none'",
    );
  });

  it('names every directive once, with and without a nonce', () => {
    for (const nonce of [undefined, NONCE]) {
      const csp = cspHeader(
        nonce === undefined ? { geocoderOrigin: ORIGIN } : { geocoderOrigin: ORIGIN, nonce },
      );
      const map = directivesOf(csp);
      expect([...map.keys()]).toEqual(DIRECTIVES);
      for (const name of DIRECTIVES) {
        expect(csp.split(`${name} `)).toHaveLength(2);
      }
    }
  });

  it("never relaxes with 'unsafe-inline' or 'unsafe-eval'", () => {
    for (const csp of [
      cspHeader({ geocoderOrigin: ORIGIN }),
      cspHeader({ geocoderOrigin: ORIGIN, nonce: NONCE }),
    ]) {
      expect(csp).not.toContain('unsafe-inline');
      expect(csp).not.toContain('unsafe-eval');
      expect(csp).not.toContain('wasm-unsafe-eval');
    }
  });

  it('lands the nonce on script-src and style-src only', () => {
    const map = directivesOf(cspHeader({ geocoderOrigin: ORIGIN, nonce: NONCE }));
    expect(map.get('script-src')).toBe(`'self' 'nonce-${NONCE}'`);
    expect(map.get('style-src')).toBe(`'self' 'nonce-${NONCE}'`);
    for (const [name, sources] of map) {
      if (name !== 'script-src' && name !== 'style-src') {
        expect(sources, name).not.toContain('nonce');
      }
    }
    const plain = directivesOf(cspHeader({ geocoderOrigin: ORIGIN }));
    expect(plain.get('script-src')).toBe("'self'");
    expect(plain.get('style-src')).toBe("'self'");
  });

  it("opens worker-src to blob: with a nonce only (Vite's HMR restart poller)", () => {
    expect(directivesOf(cspHeader({ geocoderOrigin: ORIGIN })).get('worker-src')).toBe("'none'");
    expect(
      directivesOf(cspHeader({ geocoderOrigin: ORIGIN, nonce: NONCE })).get('worker-src'),
    ).toBe('blob:');
  });

  it('puts the geocoder origin on connect-src alone', () => {
    const map = directivesOf(cspHeader({ geocoderOrigin: ORIGIN }));
    expect(map.get('connect-src')).toBe(`'self' ${ORIGIN}`);
    for (const [name, sources] of map) {
      if (name !== 'connect-src') {
        expect(sources, name).not.toContain(ORIGIN);
      }
    }
  });

  it('refuses a nonce outside the base64 alphabet', () => {
    expect(() => cspHeader({ geocoderOrigin: ORIGIN, nonce: "x' 'unsafe-inline" })).toThrow(
      /base64/,
    );
  });
});

describe('securityHeaders', () => {
  it('carries the seven headers with their exact values', () => {
    expect(securityHeaders({ geocoderOrigin: ORIGIN })).toEqual({
      'Content-Security-Policy': cspHeader({ geocoderOrigin: ORIGIN }),
      'Permissions-Policy':
        'camera=(self), geolocation=(self), gyroscope=(self), magnetometer=(self), ' +
        'accelerometer=(self), xr-spatial-tracking=(self), microphone=(), payment=(), usb=(), ' +
        'serial=(), hid=(), midi=(), display-capture=(), picture-in-picture=(), ' +
        'publickey-credentials-get=(), idle-detection=()',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
  });

  it('threads the nonce into the policy and nothing else', () => {
    const plain = securityHeaders({ geocoderOrigin: ORIGIN });
    const withNonce = securityHeaders({ geocoderOrigin: ORIGIN, nonce: NONCE });
    expect(withNonce['Content-Security-Policy']).toBe(
      cspHeader({ geocoderOrigin: ORIGIN, nonce: NONCE }),
    );
    for (const name of Object.keys(plain)) {
      if (name !== 'Content-Security-Policy') {
        expect(withNonce[name]).toBe(plain[name]);
      }
    }
    expect(withNonce['Permissions-Policy']).not.toContain('bluetooth');
  });
});

describe('geocoderOriginFromEnv', () => {
  it('defaults to Nominatim when the variable is unset', () => {
    expect(CSP_GEOCODER_ORIGIN_DEFAULT).toBe('https://nominatim.openstreetmap.org');
    expect(geocoderOriginFromEnv({})).toBe(CSP_GEOCODER_ORIGIN_DEFAULT);
    expect(geocoderOriginFromEnv({ SKY_GEOCODER_ORIGIN: undefined })).toBe(
      CSP_GEOCODER_ORIGIN_DEFAULT,
    );
  });

  it('accepts an origin, with an explicit non-default port', () => {
    expect(geocoderOriginFromEnv({ SKY_GEOCODER_ORIGIN: 'https://x.example:8443' })).toBe(
      'https://x.example:8443',
    );
    expect(geocoderOriginFromEnv({ SKY_GEOCODER_ORIGIN: 'http://127.0.0.1:8080' })).toBe(
      'http://127.0.0.1:8080',
    );
  });

  it.each([
    'https://x.example/path',
    'https://x.example/',
    'http://x.example?q',
    'ftp://x.example',
    'https://x.example:443',
    'x.example',
    '',
  ])('rejects %j with a clear error', (value) => {
    expect(() => geocoderOriginFromEnv({ SKY_GEOCODER_ORIGIN: value })).toThrow(
      /SKY_GEOCODER_ORIGIN=/,
    );
  });
});
