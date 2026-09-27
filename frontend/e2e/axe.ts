// axe-core in the Playwright suite (plan D156; brief l.289-290, WCAG 2.2 AA): the single home of
// `AxeBuilder`. Every scan runs the WCAG 2.0/2.1/2.2 A and AA tags plus axe's best practices,
// excludes the engine's label overlay (`[data-sky-labels]`, the `aria-hidden` sibling of the
// canvas that `LabelLayer` owns: engine-drawn text is outside the chrome's responsibility) and
// asserts an empty violation list. `color-contrast` stays enabled: on the translucent panel
// surfaces and the `color-mix()` night tokens axe only ever answers "incomplete", so the token
// contrast test (`src/styles/tokens.test.ts`) is the contrast gate and a future opaque surface
// would still be caught here. axe leaves its `experimental` rules out of tag runs; `experimental:
// true` adds them for the one scan that guards the Switch's label-in-name fix (plan D157 C4).
// Lighthouse embeds the same axe-core (`scripts/lighthouse.mjs`), so a green suite here predicts
// its score for the scanned states and adds the states Lighthouse never sees (tabs, dialogs, the
// phone sheet, the AR overlay).

import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import { expect } from './fixtures.ts';

export type AxeResults = Awaited<ReturnType<AxeBuilder['analyze']>>;

export interface AxeScanOptions {
  /** CSS selectors left out of the scan beside the label overlay. */
  exclude?: string[];
  /** Rule ids switched off for this scan; the call site says why. */
  disable?: string[];
  /** Also run axe's `experimental` rules (excluded from tag runs by default). */
  experimental?: boolean;
}

export interface AxeViolation {
  id: string;
  impact: string | null;
  targets: unknown[];
}

/** WCAG 2.0, 2.1 and 2.2 at levels A and AA, plus axe's best practices. */
export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

/** The engine's label overlay (`SkyCanvas.tsx`), never scanned. */
export const LABEL_OVERLAY_SELECTOR = '[data-sky-labels]';

/** One axe run over the current document state. */
export async function axeScan(page: Page, options: AxeScanOptions = {}): Promise<AxeResults> {
  let builder = new AxeBuilder({ page })
    .withTags([...WCAG_TAGS, ...(options.experimental === true ? ['experimental'] : [])])
    .exclude(LABEL_OVERLAY_SELECTOR);
  for (const selector of options.exclude ?? []) {
    builder = builder.exclude(selector);
  }
  if (options.disable !== undefined && options.disable.length > 0) {
    builder = builder.disableRules(options.disable);
  }
  return builder.analyze();
}

/** The violations as the assertion prints them: rule, impact and the offending targets. */
export function summarizeViolations(results: AxeResults): AxeViolation[] {
  return results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact ?? null,
    targets: violation.nodes.map((node) => node.target),
  }));
}

/** Rule ids axe could not decide (`incomplete`), with their node counts, for the record. */
export function incompleteSummary(results: AxeResults): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of results.incomplete) {
    counts[item.id] = item.nodes.length;
  }
  return counts;
}

/**
 * Scan the current state and assert it carries no violation; the results come back so a spec can
 * record the `incomplete` list (the night-mode exception, B-90) or inspect one rule.
 */
export async function expectNoAxeViolations(
  page: Page,
  name: string,
  options: AxeScanOptions = {},
): Promise<AxeResults> {
  const results = await axeScan(page, options);
  expect(summarizeViolations(results), `axe violations in state "${name}"`).toEqual([]);
  return results;
}
