// Label layout (VIEW-3, brief l.223, plan D105): greedy placement of screen labels in priority
// order with rectangle-overlap rejection and a density budget. Pure, dependency-free,
// allocation-free: the engine projects the candidates into a preallocated buffer and the layout
// writes into a preallocated placement. The selected object and the cardinal letters are exempt
// from the budget (never culled by density); every label still yields to one placed before it.

import { at } from './typed';

/** What the layout needs to know about a label; the engine keeps the list in priority order. */
export interface LabelCandidate {
  id: string;
  /** `selected` and `cardinal` are exempt from the budget (plan D105). */
  kind: string;
  text: string;
  /** Measured text box, CSS pixels. */
  widthPx: number;
  heightPx: number;
  /** Symbol radius of the object the label sits next to, CSS pixels. */
  radiusPx: number;
}

/** Labels shown per density (`labels=0..3`), the exempt ones excluded. */
export const LABEL_BUDGET: readonly [number, number, number, number] = [0, 14, 36, 90];
/** Pool size: the largest budget plus four cardinal letters and the selection, with one spare. */
export const LABEL_POOL = 96;
/** Gap between an object's symbol and its label (CSS pixels). */
export const LABEL_GAP_PX = 4;
/** Stride of the `projected` buffer: x, y and a 0/1 flag telling whether the point is usable. */
export const PROJECTED_STRIDE = 3;

/** The placed labels: candidate indices and the boxes (top-left corner and size) they got. */
export interface LabelPlacement {
  count: number;
  index: Int32Array;
  x: Float64Array;
  y: Float64Array;
  width: Float64Array;
  height: Float64Array;
}

export function createLabelPlacement(capacity: number): LabelPlacement {
  return {
    count: 0,
    index: new Int32Array(capacity),
    x: new Float64Array(capacity),
    y: new Float64Array(capacity),
    width: new Float64Array(capacity),
    height: new Float64Array(capacity),
  };
}

/** Budget of a density level; anything outside 0..3 counts as 0 (defensive, like the URL codec). */
export function labelBudget(density: number): number {
  return LABEL_BUDGET[density === 1 || density === 2 || density === 3 ? density : 0];
}

/** `true` when the two boxes overlap after growing each by `tolerance` on every side. */
export function rectsOverlap(
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
  tolerance = 0,
): boolean {
  return (
    ax - tolerance < bx + bw + tolerance &&
    bx - tolerance < ax + aw + tolerance &&
    ay - tolerance < by + bh + tolerance &&
    by - tolerance < ay + ah + tolerance
  );
}

/** Exempt from the density budget: the selection and the four cardinal letters. */
export function isBudgetExempt(kind: string): boolean {
  return kind === 'selected' || kind === 'cardinal';
}

/**
 * Place labels greedily in candidate order. `projected[3 i .. 3 i + 2]` is the screen position of
 * candidate `i` and a flag (0 = behind the camera, culled or absent); a buffer shorter than the
 * candidates is a `RangeError`. A label's box sits to the right of its object (`x + radius + gap`,
 * vertically centred); it is skipped when its box leaves the viewport entirely, when it overlaps a
 * placed box, or when the budget is spent (exempt kinds ignore the budget). Returns the number
 * placed, also stored in `out.count`.
 */
export function placeLabels(
  candidates: readonly LabelCandidate[],
  projected: ArrayLike<number>,
  budget: number,
  width: number,
  height: number,
  out: LabelPlacement,
): number {
  const capacity = out.index.length;
  let placed = 0;
  let budgeted = 0;
  for (let i = 0; i < candidates.length && placed < capacity; i += 1) {
    const candidate = candidates[i];
    if (candidate === undefined || at(projected, PROJECTED_STRIDE * i + 2) !== 1) {
      continue;
    }
    const exempt = isBudgetExempt(candidate.kind);
    if (!exempt && budgeted >= budget) {
      continue;
    }
    const x = at(projected, PROJECTED_STRIDE * i) + candidate.radiusPx + LABEL_GAP_PX;
    const y = at(projected, PROJECTED_STRIDE * i + 1) - candidate.heightPx / 2;
    const w = candidate.widthPx;
    const h = candidate.heightPx;
    if (x >= width || x + w <= 0 || y >= height || y + h <= 0) {
      continue;
    }
    let blocked = false;
    for (let k = 0; k < placed; k += 1) {
      if (
        rectsOverlap(x, y, w, h, at(out.x, k), at(out.y, k), at(out.width, k), at(out.height, k))
      ) {
        blocked = true;
        break;
      }
    }
    if (blocked) {
      continue;
    }
    out.index[placed] = i;
    out.x[placed] = x;
    out.y[placed] = y;
    out.width[placed] = w;
    out.height[placed] = h;
    placed += 1;
    if (!exempt) {
      budgeted += 1;
    }
  }
  out.count = placed;
  return placed;
}
