// @vitest-environment node
// Label layout (VIEW-3, plan D105): rectangle overlap edge cases, the density budget, greedy
// placement in priority order, overlap rejection, viewport and behind-camera culling, the exempt
// kinds and the pool capacity.

import {
  LABEL_BUDGET,
  LABEL_GAP_PX,
  LABEL_POOL,
  PROJECTED_STRIDE,
  createLabelPlacement,
  isBudgetExempt,
  labelBudget,
  placeLabels,
  rectsOverlap,
} from './labels';
import type { LabelCandidate } from './labels';

function candidate(
  id: string,
  kind = 'star',
  widthPx = 40,
  heightPx = 14,
  radiusPx = 2,
): LabelCandidate {
  return { id, kind, text: id, widthPx, heightPx, radiusPx };
}

/** A projected buffer from `[x, y]` points (`null` = behind the camera). */
function projectedFrom(points: readonly (readonly [number, number] | null)[]): Float64Array {
  const out = new Float64Array(PROJECTED_STRIDE * points.length);
  points.forEach((p, i) => {
    if (p !== null) {
      out[PROJECTED_STRIDE * i] = p[0];
      out[PROJECTED_STRIDE * i + 1] = p[1];
      out[PROJECTED_STRIDE * i + 2] = 1;
    }
  });
  return out;
}

function placedIds(
  candidates: readonly LabelCandidate[],
  out: ReturnType<typeof createLabelPlacement>,
): string[] {
  const ids: string[] = [];
  for (let k = 0; k < out.count; k += 1) {
    ids.push(candidates[out.index[k] ?? -1]?.id ?? '?');
  }
  return ids;
}

describe('rectsOverlap', () => {
  it('detects overlap, treats touching edges as disjoint and honours the tolerance', () => {
    expect(rectsOverlap(0, 0, 10, 10, 5, 5, 10, 10)).toBe(true);
    expect(rectsOverlap(5, 5, 10, 10, 0, 0, 10, 10)).toBe(true);
    expect(rectsOverlap(0, 0, 10, 10, 10, 0, 10, 10)).toBe(false);
    expect(rectsOverlap(0, 0, 10, 10, 0, 10, 10, 10)).toBe(false);
    expect(rectsOverlap(0, 0, 10, 10, 20, 0, 10, 10)).toBe(false);
    expect(rectsOverlap(0, 0, 10, 10, 0, -20, 10, 10)).toBe(false);
    expect(rectsOverlap(0, 0, 10, 10, -20, 0, 10, 10)).toBe(false);
    expect(rectsOverlap(0, 0, 10, 10, 0, 20, 10, 10)).toBe(false);
    // Containment counts as overlap.
    expect(rectsOverlap(0, 0, 100, 100, 10, 10, 5, 5)).toBe(true);
    // A tolerance grows both boxes: touching boxes then overlap, a 4 px gap survives 1 px.
    expect(rectsOverlap(0, 0, 10, 10, 10, 0, 10, 10, 1)).toBe(true);
    expect(rectsOverlap(0, 0, 10, 10, 14, 0, 10, 10, 1)).toBe(false);
  });
});

describe('labelBudget', () => {
  it('follows {0: 0, 1: 14, 2: 36, 3: 90} and treats anything else as 0', () => {
    expect(LABEL_BUDGET).toEqual([0, 14, 36, 90]);
    expect(labelBudget(0)).toBe(0);
    expect(labelBudget(1)).toBe(14);
    expect(labelBudget(2)).toBe(36);
    expect(labelBudget(3)).toBe(90);
    expect(labelBudget(7)).toBe(0);
    expect(labelBudget(-1)).toBe(0);
    expect(LABEL_POOL).toBeGreaterThanOrEqual(90 + 4 + 1);
    expect(isBudgetExempt('selected')).toBe(true);
    expect(isBudgetExempt('cardinal')).toBe(true);
    expect(isBudgetExempt('star')).toBe(false);
  });
});

describe('placeLabels', () => {
  it('places the labels in order to the right of their objects and reports the boxes', () => {
    const candidates = [candidate('a'), candidate('b', 'dso', 30, 12, 6)];
    const projected = projectedFrom([
      [100, 100],
      [300, 200],
    ]);
    const out = createLabelPlacement(8);
    expect(placeLabels(candidates, projected, 10, 800, 600, out)).toBe(2);
    expect(out.count).toBe(2);
    expect(placedIds(candidates, out)).toEqual(['a', 'b']);
    expect(out.x[0]).toBe(100 + 2 + LABEL_GAP_PX);
    expect(out.y[0]).toBe(100 - 7);
    expect(out.width[0]).toBe(40);
    expect(out.height[0]).toBe(14);
    expect(out.x[1]).toBe(300 + 6 + LABEL_GAP_PX);
    expect(out.y[1]).toBe(200 - 6);
  });

  it('rejects a label whose box overlaps one placed before it', () => {
    const candidates = [candidate('first'), candidate('second'), candidate('third')];
    const projected = projectedFrom([
      [100, 100],
      [110, 104],
      [100, 130],
    ]);
    const out = createLabelPlacement(8);
    expect(placeLabels(candidates, projected, 10, 800, 600, out)).toBe(2);
    expect(placedIds(candidates, out)).toEqual(['first', 'third']);
  });

  it('skips points behind the camera and boxes entirely outside the viewport', () => {
    const candidates = [
      candidate('behind'),
      candidate('right'),
      candidate('left'),
      candidate('above'),
      candidate('below'),
      candidate('edge'),
      candidate('inside'),
    ];
    const projected = projectedFrom([
      null,
      [800, 100],
      [-100, 100],
      [100, -20],
      [100, 620],
      // Its box starts 6 px before the right edge: partly visible, kept.
      [800 - 6 - 1, 100],
      [400, 300],
    ]);
    const out = createLabelPlacement(8);
    expect(placeLabels(candidates, projected, 10, 800, 600, out)).toBe(2);
    expect(placedIds(candidates, out)).toEqual(['edge', 'inside']);
  });

  it('spends the budget on ordinary labels only; selected and cardinal are exempt', () => {
    const candidates = [
      candidate('sel', 'selected'),
      candidate('n', 'cardinal'),
      candidate('e', 'cardinal'),
      candidate('p1', 'body'),
      candidate('p2', 'body'),
      candidate('s1', 'star'),
    ];
    const projected = projectedFrom([
      [100, 50],
      [100, 100],
      [100, 150],
      [100, 200],
      [100, 250],
      [100, 300],
    ]);
    const out = createLabelPlacement(8);
    expect(placeLabels(candidates, projected, 2, 800, 600, out)).toBe(5);
    expect(placedIds(candidates, out)).toEqual(['sel', 'n', 'e', 'p1', 'p2']);
    // Budget 0 (labels=0): only the exempt kinds show.
    expect(placeLabels(candidates, projected, 0, 800, 600, out)).toBe(3);
    expect(placedIds(candidates, out)).toEqual(['sel', 'n', 'e']);
    // A budget beyond the candidates places everything.
    expect(placeLabels(candidates, projected, 90, 800, 600, out)).toBe(6);
  });

  it('never places more than the pool holds and throws on a short projected buffer', () => {
    const candidates = Array.from({ length: 6 }, (_, i) => candidate(`c${String(i)}`));
    const projected = projectedFrom(candidates.map((_, i) => [100, 20 + 40 * i] as const));
    const out = createLabelPlacement(4);
    expect(placeLabels(candidates, projected, 90, 800, 600, out)).toBe(4);
    expect(out.count).toBe(4);
    expect(() => placeLabels(candidates, projected.subarray(0, 5), 90, 800, 600, out)).toThrow(
      RangeError,
    );
  });

  it('places nothing for an empty list and resets a previous count', () => {
    const out = createLabelPlacement(4);
    out.count = 3;
    expect(placeLabels([], new Float64Array(0), 90, 800, 600, out)).toBe(0);
    expect(out.count).toBe(0);
  });
});
