// The shared Playwright `test` of every spec (plan D153): three automatic fixtures assert, after
// each test, that the page raised no Content-Security-Policy violation (the policy of
// security-headers.ts served by `vite preview`), that no request left for a foreign origin (OBS-7,
// brief l.196) and that the browser holds no state (OBS-8: no cookie, Web Storage or IndexedDB
// database). The specs import `test` and `expect` from here, never from '@playwright/test'
// (`import type` stays fine; eslint.config.js block G enforces it). A teardown assertion runs
// only when the test itself ended as expected, so it never masks the test's own failure.

import { test as base, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

import { collectForeignRequests } from './support.ts';

/** One `securitypolicyviolation` event as the page records it (the CSP3 event interface). */
export interface CspViolation {
  effectiveDirective: string;
  blockedURI: string;
  disposition: string;
  sample: string;
  sourceFile: string;
  lineNumber: number;
}

export interface ForeignRequests {
  /** Request URLs to an `http(s)` host other than the app's own, in order. */
  urls: string[];
  /** Exempt a hostname from now on: the geocoder a spec routes and fulfils itself. */
  allow(host: string): void;
}

declare global {
  interface Window {
    /** The current document's own records (the init script of the `cspViolations` fixture). */
    __cspViolations?: CspViolation[];
    /** The test-side collector (`page.exposeFunction`): one call per record, as it happens. */
    __cspViolation?: (record: CspViolation) => Promise<void>;
  }
}

/** The violations the current document has recorded since it was created. */
export async function readCspViolations(page: Page): Promise<CspViolation[]> {
  if (page.isClosed() || page.url() === 'about:blank') {
    return [];
  }
  return page.evaluate(() => window.__cspViolations ?? []);
}

/**
 * Forget every record so far, the test's array (the `cspViolations` fixture value) and the current
 * document's: after a deliberate violation, the negative control of csp.spec.ts.
 */
export async function resetCspViolations(page: Page, violations: CspViolation[]): Promise<void> {
  violations.length = 0;
  if (page.isClosed() || page.url() === 'about:blank') {
    return;
  }
  await page.evaluate(() => {
    window.__cspViolations = [];
  });
}

function endedAsExpected(): boolean {
  const info = base.info();
  return info.status === info.expectedStatus;
}

export const test = base.extend<{
  cspViolations: CspViolation[];
  foreignRequests: ForeignRequests;
  /** A teardown-only fixture: no value (`undefined` rather than `void`, which the lint refuses). */
  noStorage: undefined;
}>({
  // The collector is an init script (CDP-injected, outside the policy) registered on `document`,
  // where element and global violations end up (they bubble). Every record is handed to the
  // test's array through an exposed function, which survives navigations: a violation raised
  // before a `goto` or a `reload` is still asserted at teardown. The document keeps its own copy
  // for `readCspViolations` and for a record whose call is still in flight when the test ends:
  // the teardown's read is a round trip ordered behind every earlier call.
  cspViolations: [
    async ({ page }, use) => {
      const violations: CspViolation[] = [];
      await page.exposeFunction('__cspViolation', (record: CspViolation) => {
        violations.push(record);
      });
      await page.addInitScript(() => {
        const records: CspViolation[] = [];
        window.__cspViolations = records;
        document.addEventListener('securitypolicyviolation', (event) => {
          const record: CspViolation = {
            effectiveDirective: event.effectiveDirective,
            blockedURI: event.blockedURI,
            disposition: event.disposition,
            sample: event.sample,
            sourceFile: event.sourceFile,
            lineNumber: event.lineNumber,
          };
          records.push(record);
          void window.__cspViolation?.(record);
        });
      });
      await use(violations);
      if (!endedAsExpected()) {
        return;
      }
      // A read that fails on a document being replaced falls back to the exposed function's records.
      const current = await readCspViolations(page).catch((): CspViolation[] => []);
      const message =
        'the page raised Content-Security-Policy violations (security-headers.ts, plan D147)';
      expect(violations, message).toEqual([]);
      expect(current, message).toEqual([]);
    },
    { auto: true },
  ],

  foreignRequests: [
    async ({ page }, use) => {
      const allowed = new Set<string>();
      const urls = collectForeignRequests(page, allowed);
      await use({
        urls,
        allow(host) {
          allowed.add(host);
        },
      });
      if (!endedAsExpected()) {
        return;
      }
      const foreign = urls.filter((url) => !allowed.has(new URL(url).hostname));
      expect(foreign, 'a request left for a foreign origin (OBS-7, brief l.196)').toEqual([]);
    },
    { auto: true },
  ],

  noStorage: [
    async ({ page }, use) => {
      await use(undefined);
      if (!endedAsExpected() || page.isClosed() || page.url() === 'about:blank') {
        return;
      }
      const storage = await page.evaluate(async () => ({
        cookie: document.cookie,
        local: localStorage.length,
        session: sessionStorage.length,
        databases:
          typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).length : 0,
      }));
      expect(storage, 'the browser holds state outside the URL (OBS-8)').toEqual({
        cookie: '',
        local: 0,
        session: 0,
        databases: 0,
      });
    },
    { auto: true },
  ],
});

export { expect };
