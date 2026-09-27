// Labels and the selection marker (VIEW-3, INFO-1, brief l.223, l.230, plan D105): an
// engine-owned HTML overlay over the canvas. A pool of `LABEL_POOL` `<span>`s is created once in
// the `aria-hidden` label root; every <= 10 Hz tick projects the candidates through the CPU
// direction twin (`sky/math/apparent.ts`), runs the pure greedy layout (`sky/math/labels.ts`)
// and writes only what changed: `textContent` and the data attributes when a slot's id changes,
// `transform` when a rounded position moves, `hidden` when a slot empties. Text widths are
// measured once per text with an offscreen 2D canvas (`measureText`), so the layout is
// deterministic and the e2e specs can assert on the boxes. The candidate list is rebuilt at
// change time only (catalogs, window bodies, density, layers, selection, language): selected
// object, cardinal letters, planets, named stars by magnitude, Messier objects, constellation
// names, minor bodies, other named deep-sky objects. React never touches this overlay (l.409).
// A star or deep-sky candidate is placed only while the shaders draw it: the same effective
// magnitude and size limits (fov rule, manual `maglim`, daylight fade) gate both, so a label
// never floats over an empty patch of sky (plan D94). The tick allocates nothing except the
// `translate3d(...)` string a moved slot needs (CSSOM has no numeric transform write) and the
// label texts when a slot's id changes.

import type { CatalogBundle } from '../../../api/catalogs';
import type { SkyActions } from '../../../state/storeTypes';
import type {
  FrameEval,
  LabelDensity,
  LabelKind,
  LayerFlags,
  ViewState,
  VisibleLabel,
} from '../../../state/types';
import { apparentCatalogEnu, apparentStarEnuAt, enuFromApparentIcrf } from '../../math/apparent';
import { DSO_MIN_RADIUS_PX, dsoPixelRadius } from '../../math/dso';
import { DEG, altAzToEnu, directionToScreen, enuToAltAz } from '../../math/frames';
import type { AltAz, ScreenPoint } from '../../math/frames';
import {
  LABEL_POOL,
  PROJECTED_STRIDE,
  createLabelPlacement,
  labelBudget,
  placeLabels,
} from '../../math/labels';
import type { LabelCandidate } from '../../math/labels';
import { minorPixelRadius } from '../../math/minorBodies';
import { inCone, starInCone } from '../../math/picking';
import { rotateInverse } from '../../math/quaternion';
import { starPixelRadius } from '../../math/stars';
import { yearsSinceEpoch } from '../../math/time';
import { at, load3, vec3 } from '../../math/typed';
import { BODY_MIN_RADIUS_PX } from './BodiesLayer';
import type { SkyResolver } from '../resolver';
import type { LabelBox, LabelTextKey, StarCatalogInput } from '../types';
import type { DsoLayer } from './DsoLayer';

/** Cardinal letters sit this far above the horizon (degrees), like the horizon ticks. */
export const CARDINAL_ALT_DEG = 1.5;
/** Named stars shown per density: `labels=1` the brightest, `labels=3` every indexed star. */
export const STAR_LABEL_MAG_LIMIT: readonly [number, number, number, number] = [
  -Infinity,
  1.5,
  3,
  Infinity,
];
/** The overlay font; the widths are measured with exactly this string. */
export const LABEL_FONT_PX = 12;
export const LABEL_LINE_HEIGHT_PX = 16;
export const LABEL_FONT = `${String(LABEL_FONT_PX)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
/** Horizontal padding inside a label box (each side), CSS pixels. */
const LABEL_PAD_PX = 2;
/** The marker ring is drawn this far outside the object's symbol. */
const MARKER_MARGIN_PX = 6;
/** A candidate is projected only within this margin around the view's half diagonal (degrees). */
const CONE_MARGIN_DEG = 2;

/** How a candidate's direction is found on every tick. */
const KIND_SELECTED = 0;
const KIND_CARDINAL = 1;
const KIND_BODY = 2;
const KIND_STAR = 3;
const KIND_DSO = 4;
const KIND_CONSTELLATION = 5;
const KIND_MINOR = 6;

const CARDINALS: readonly { letter: 'n' | 'e' | 's' | 'w'; az: number }[] = [
  { letter: 'n', az: 0 },
  { letter: 'e', az: 90 },
  { letter: 's', az: 180 },
  { letter: 'w', az: 270 },
];

/** Change-time inputs of `rebuild`. */
export interface LabelRebuildInputs {
  catalog: StarCatalogInput | null;
  bundle: CatalogBundle | null;
  /** The current window: body and minor-body ids (the list, not the directions). */
  frame: FrameEval;
  /** Minor-body id -> display name (from `frames.minor` and the defaults). */
  minorNames: ReadonlyMap<string, string>;
  density: LabelDensity;
  layers: LayerFlags;
  selection: string | null;
}

/** Per-tick inputs of `update`. */
export interface LabelTickInputs {
  frame: FrameEval;
  view: ViewState;
  /** Canvas size in CSS pixels. */
  width: number;
  height: number;
  refractionOn: boolean;
  refractionFactor: number;
  /** `ground === 'opaque'`: nothing below the horizon gets a label or the marker (plan D104). */
  cullBelowHorizon: boolean;
  /** The effective star limit the star shader draws to (`effectiveMagLimit`); fainter stars get no label. */
  starMagLimit: number;
  /** The effective `dso.ts` limits the DSO shader draws to; objects it hides get no label. */
  dsoMagLimit: number;
  dsoSizeLimitArcmin: number;
  /** Camera roll in degrees (`ar.roll`, plan D119): positions rotate, the text stays upright. */
  roll: number;
}

interface Slot {
  span: HTMLSpanElement;
  id: string | null;
  x: number;
  y: number;
}

function newSpan(root: HTMLElement): HTMLSpanElement {
  const span = document.createElement('span');
  span.hidden = true;
  span.style.cssText =
    `position:absolute;left:0;top:0;white-space:nowrap;font:${String(LABEL_FONT_PX)}px/${String(LABEL_LINE_HEIGHT_PX)}px system-ui,-apple-system,"Segoe UI",sans-serif;` +
    `padding:0 ${String(LABEL_PAD_PX)}px;text-shadow:0 0 2px #000,0 0 1px #000;will-change:transform;`;
  root.append(span);
  return span;
}

function newMarker(root: HTMLElement): HTMLDivElement {
  const div = document.createElement('div');
  div.hidden = true;
  div.dataset.marker = '';
  div.style.cssText =
    'position:absolute;left:0;top:0;box-sizing:border-box;border:2px solid currentColor;' +
    'border-radius:50%;opacity:0.9;will-change:transform;';
  root.append(div);
  return div;
}

export class LabelLayer {
  private readonly root: HTMLElement;
  private readonly labelText: (key: LabelTextKey) => string;
  private readonly resolver: SkyResolver;
  private readonly dso: DsoLayer;
  private readonly slots: Slot[] = [];
  private readonly marker: HTMLDivElement;
  private markerId: string | null = null;
  private markerX = NaN;
  private markerY = NaN;
  private markerR = NaN;
  private readonly measure: CanvasRenderingContext2D | null;
  private readonly widths = new Map<string, number>();
  // The candidate list and its per-candidate lookup data (rebuilt at change time).
  private candidates: LabelCandidate[] = [];
  private kinds = new Int8Array(0);
  private refs = new Int32Array(0);
  private projected = new Float64Array(0);
  private readonly placement = createLabelPlacement(LABEL_POOL);
  private catalog: StarCatalogInput | null = null;
  private selection: string | null = null;
  private density: LabelDensity = 0;
  // The ids drawn, compared in place against what was last published (<= 1 Hz, on change).
  private readonly drawnIds: string[] = [];
  private readonly publishedIds: string[] = [];
  private lastPublishMs = -Infinity;
  private dirty = true;
  /** `setVisibleLabels` calls so far (the debug hook's `labelPublishes`, plan D141). */
  private publishes = 0;
  // Scratch storage of `update` (nothing is allocated per tick).
  private readonly enu = vec3();
  private readonly icrf = vec3();
  private readonly viewEnu = vec3();
  private readonly viewIcrf = vec3();
  private readonly altAz: AltAz = { alt: 0, az: 0 };
  private readonly screen: ScreenPoint = { x: 0, y: 0 };

  constructor(
    root: HTMLElement,
    labelText: (key: LabelTextKey) => string,
    resolver: SkyResolver,
    dso: DsoLayer,
  ) {
    this.root = root;
    this.labelText = labelText;
    this.resolver = resolver;
    this.dso = dso;
    for (let k = 0; k < LABEL_POOL; k += 1) {
      this.slots.push({ span: newSpan(root), id: null, x: NaN, y: NaN });
    }
    this.marker = newMarker(root);
    const canvas = document.createElement('canvas');
    this.measure = canvas.getContext('2d');
    if (this.measure !== null) {
      this.measure.font = LABEL_FONT;
    }
  }

  /** Measured width of a text box (memoised per text), CSS pixels. */
  private widthOf(text: string): number {
    const known = this.widths.get(text);
    if (known !== undefined) {
      return known;
    }
    // Without a 2D context (a headless canvas without one) an average glyph width stands in.
    const width =
      (this.measure === null
        ? text.length * 0.58 * LABEL_FONT_PX
        : this.measure.measureText(text).width) +
      2 * LABEL_PAD_PX;
    this.widths.set(text, width);
    return width;
  }

  private candidate(id: string, kind: LabelKind, text: string): LabelCandidate {
    return {
      id,
      kind,
      text,
      widthPx: this.widthOf(text),
      heightPx: LABEL_LINE_HEIGHT_PX,
      radiusPx: 0,
    };
  }

  /** The text of a star from the index: proper name, else Bayer, Flamsteed, `HIP n`. */
  private static starText(entry: {
    hip: number;
    names: { proper?: string | null; bayer?: string | null; flamsteed?: string | null };
  }): string {
    return (
      entry.names.proper ?? entry.names.bayer ?? entry.names.flamsteed ?? `HIP ${String(entry.hip)}`
    );
  }

  /**
   * Rebuild the candidate list in priority order (plan D105): the selection, the cardinal
   * letters (`horizon` on), then under a non-zero budget the planets, the named stars by
   * magnitude (density 1: brighter than 1.5, 2: brighter than 3, 3: every indexed star),
   * the Messier objects by magnitude, the constellation names (`cnames`), the minor bodies and
   * the other named deep-sky objects. `labels=0` shows the cardinal letters and the selection
   * alone (plan Q46).
   */
  rebuild(inputs: LabelRebuildInputs): void {
    const { catalog, bundle, frame, density, layers } = inputs;
    this.catalog = catalog;
    this.selection = inputs.selection;
    this.density = density;
    const list: LabelCandidate[] = [];
    const kinds: number[] = [];
    const refs: number[] = [];
    const push = (c: LabelCandidate, kind: number, ref: number): void => {
      list.push(c);
      kinds.push(kind);
      refs.push(ref);
    };
    const selected = inputs.selection;
    if (selected !== null) {
      const text = this.selectionText(selected, bundle, inputs.minorNames);
      if (text !== null) {
        push(this.candidate(selected, 'selected', text), KIND_SELECTED, 0);
      }
    }
    if (layers.horizon) {
      CARDINALS.forEach((cardinal, i) => {
        push(
          this.candidate(
            `cardinal:${cardinal.letter}`,
            'cardinal',
            this.labelText({ kind: 'cardinal', letter: cardinal.letter }),
          ),
          KIND_CARDINAL,
          i,
        );
      });
    }
    if (labelBudget(density) > 0) {
      if (layers.planets && frame.valid) {
        for (let i = 0; i < frame.bodyCount; i += 1) {
          const id = frame.bodyIds[i];
          if (id !== undefined && id !== selected) {
            push(this.candidate(id, 'body', this.labelText({ kind: 'body', id })), KIND_BODY, i);
          }
        }
      }
      if (layers.stars && catalog !== null && bundle !== null) {
        const magLimit = STAR_LABEL_MAG_LIMIT[density];
        const rows: { row: number; text: string }[] = [];
        for (const entry of bundle.index.data) {
          const row = catalog.hipIndex.get(entry.hip);
          if (row === undefined) {
            continue;
          }
          const proper = entry.names.proper;
          if (density < 3 && (proper === undefined || proper === null)) {
            continue;
          }
          if (at(catalog.columns.mag, row) / 1000 > magLimit) {
            continue;
          }
          rows.push({ row, text: LabelLayer.starText(entry) });
        }
        // The SKYS rows are sorted by magnitude: brighter first.
        rows.sort((a, b) => a.row - b.row);
        for (const { row, text } of rows) {
          const id = `hip:${String(at(catalog.columns.hip, row))}`;
          if (id !== selected) {
            push(this.candidate(id, 'star', text), KIND_STAR, row);
          }
        }
      }
      const dso = layers.dso ? (bundle?.dso?.data ?? null) : null;
      const messier: { row: number; mag: number; text: string }[] = [];
      const named: { row: number; mag: number; text: string }[] = [];
      if (dso !== null) {
        dso.forEach((entry, row) => {
          const mag = entry.mag ?? 99;
          if (entry.messier !== undefined && entry.messier !== null) {
            messier.push({ row, mag, text: `M${String(entry.messier)}` });
          } else if (entry.names.length > 0) {
            named.push({ row, mag, text: entry.names[0] ?? entry.id });
          }
        });
        messier.sort((a, b) => a.mag - b.mag);
        named.sort((a, b) => a.mag - b.mag);
        for (const m of messier) {
          const id = `dso:${dso[m.row]?.id ?? ''}`;
          if (id !== selected) {
            push(this.candidate(id, 'dso', m.text), KIND_DSO, m.row);
          }
        }
      }
      const cons = layers.cnames ? (bundle?.constellations?.data ?? null) : null;
      if (cons !== null) {
        cons.forEach((entry, row) => {
          push(
            this.candidate(
              `con:${entry.abbr}`,
              'constellation',
              this.labelText({ kind: 'constellation', abbr: entry.abbr }),
            ),
            KIND_CONSTELLATION,
            row,
          );
        });
      }
      if (layers.minor && frame.valid) {
        for (let m = 0; m < frame.minorCount; m += 1) {
          const id = frame.minorIds[m];
          if (id !== undefined && id !== selected) {
            push(this.candidate(id, 'minor', inputs.minorNames.get(id) ?? id), KIND_MINOR, m);
          }
        }
      }
      if (dso !== null) {
        for (const n of named) {
          const id = `dso:${dso[n.row]?.id ?? ''}`;
          if (id !== selected) {
            push(this.candidate(id, 'dso', n.text), KIND_DSO, n.row);
          }
        }
      }
    }
    this.candidates = list;
    this.kinds = Int8Array.from(kinds);
    this.refs = Int32Array.from(refs);
    this.projected = new Float64Array(PROJECTED_STRIDE * list.length);
    this.dirty = true;
  }

  /** The label of the selection: its usual text whatever its kind, `null` when it names nothing. */
  private selectionText(
    id: string,
    bundle: CatalogBundle | null,
    minorNames: ReadonlyMap<string, string>,
  ): string | null {
    const resolved = this.resolver.resolve(id);
    if (resolved === null) {
      return null;
    }
    switch (resolved.kind) {
      case 'star': {
        const hip = this.catalog === null ? NaN : at(this.catalog.columns.hip, resolved.index);
        const entry = bundle?.index.data.find((e) => e.hip === hip);
        return entry === undefined ? `HIP ${String(hip)}` : LabelLayer.starText(entry);
      }
      case 'dso': {
        const entry = this.resolver.dsoEntries[resolved.index];
        if (entry === undefined) {
          return null;
        }
        return entry.messier !== undefined && entry.messier !== null
          ? `M${String(entry.messier)}`
          : (entry.names[0] ?? entry.id);
      }
      case 'body':
        return this.labelText({ kind: 'body', id });
      case 'minor':
        return minorNames.get(id) ?? id;
      case 'con':
        return null;
    }
  }

  /** The ENU direction of candidate `i` into `out`; `false` when it cannot be placed now. */
  private directionOf(i: number, t: LabelTickInputs, years: number, cosCone: number): boolean {
    const frame = t.frame;
    const kind = at(this.kinds, i);
    const ref = at(this.refs, i);
    const candidate = this.candidates[i];
    if (candidate === undefined) {
      return false;
    }
    const out = this.enu;
    switch (kind) {
      case KIND_SELECTED:
        return this.resolver.directionOf(candidate.id, out);
      case KIND_CARDINAL: {
        const cardinal = CARDINALS[ref];
        if (cardinal === undefined) {
          return false;
        }
        altAzToEnu(out, CARDINAL_ALT_DEG, cardinal.az);
        return true;
      }
      case KIND_BODY: {
        const index = frame.bodyIds.indexOf(candidate.id);
        if (index < 0 || index >= frame.bodyCount) {
          return false;
        }
        load3(this.icrf, frame.dir, 3 * index);
        enuFromApparentIcrf(out, this.icrf, frame.horizonQ, t.refractionOn, t.refractionFactor);
        return true;
      }
      case KIND_STAR: {
        const catalog = this.catalog;
        if (catalog === null) {
          return false;
        }
        if (
          at(catalog.columns.mag, ref) / 1000 > t.starMagLimit ||
          !starInCone(catalog.columns.dir, catalog.columns.pm, ref, years, this.viewIcrf, cosCone)
        ) {
          return false;
        }
        apparentStarEnuAt(
          out,
          catalog.columns,
          ref,
          years,
          frame.observerVelocity,
          frame.horizonQ,
          t.refractionOn,
          t.refractionFactor,
        );
        return true;
      }
      case KIND_DSO: {
        if (!this.dso.isShown(ref, t.dsoMagLimit, t.dsoSizeLimitArcmin)) {
          return false;
        }
        load3(this.icrf, this.resolver.dsoDirections, 3 * ref);
        if (!inCone(this.icrf, this.viewIcrf, cosCone)) {
          return false;
        }
        apparentCatalogEnu(
          out,
          this.icrf,
          frame.observerVelocity,
          frame.horizonQ,
          t.refractionOn,
          t.refractionFactor,
        );
        return true;
      }
      case KIND_CONSTELLATION: {
        load3(this.icrf, this.resolver.constellationDirections, 3 * ref);
        if (!inCone(this.icrf, this.viewIcrf, cosCone)) {
          return false;
        }
        enuFromApparentIcrf(out, this.icrf, frame.horizonQ, t.refractionOn, t.refractionFactor);
        return true;
      }
      case KIND_MINOR: {
        const index = frame.minorIds.indexOf(candidate.id);
        if (index < 0 || index >= frame.minorCount || at(frame.minorDrawn, index) !== 1) {
          return false;
        }
        load3(this.icrf, frame.minorDir, 3 * index);
        enuFromApparentIcrf(out, this.icrf, frame.horizonQ, t.refractionOn, t.refractionFactor);
        return true;
      }
      default:
        return false;
    }
  }

  /** The symbol radius the label steps away from, CSS pixels. */
  private radiusOf(i: number, t: LabelTickInputs): number {
    const frame = t.frame;
    const kind = at(this.kinds, i);
    const ref = at(this.refs, i);
    const fovRad = t.view.fov * DEG;
    switch (kind) {
      case KIND_SELECTED: {
        const candidate = this.candidates[i];
        const resolved = candidate === undefined ? null : this.resolver.resolve(candidate.id);
        if (resolved === null) {
          return 0;
        }
        switch (resolved.kind) {
          case 'star':
            return this.catalog === null
              ? 0
              : starPixelRadius(at(this.catalog.columns.mag, resolved.index) / 1000, t.view.fov);
          case 'dso':
            return this.dsoRadius(resolved.index, t);
          case 'body':
            return this.bodyRadius(frame, resolved.index, fovRad, t.height);
          case 'minor':
            return minorPixelRadius(at(frame.minorMag, resolved.index));
          case 'con':
            return 0;
        }
        break;
      }
      case KIND_BODY: {
        const candidate = this.candidates[i];
        const index = candidate === undefined ? -1 : frame.bodyIds.indexOf(candidate.id);
        return index < 0 ? 0 : this.bodyRadius(frame, index, fovRad, t.height);
      }
      case KIND_STAR:
        return this.catalog === null
          ? 0
          : starPixelRadius(at(this.catalog.columns.mag, ref) / 1000, t.view.fov);
      case KIND_DSO:
        return this.dsoRadius(ref, t);
      case KIND_MINOR: {
        const candidate = this.candidates[i];
        const index = candidate === undefined ? -1 : frame.minorIds.indexOf(candidate.id);
        return index < 0 ? 0 : minorPixelRadius(at(frame.minorMag, index));
      }
      default:
        return 0;
    }
    return 0;
  }

  private bodyRadius(frame: FrameEval, index: number, fovRad: number, height: number): number {
    const diamDeg = at(frame.diamDeg, index);
    if (Number.isNaN(diamDeg)) {
      return BODY_MIN_RADIUS_PX;
    }
    return Math.max(
      BODY_MIN_RADIUS_PX,
      (Math.tan((diamDeg / 2) * DEG) / Math.tan(fovRad / 2)) * height * 0.5,
    );
  }

  private dsoRadius(row: number, t: LabelTickInputs): number {
    const entry = this.resolver.dsoEntries[row];
    const majorArcmin = entry?.major_arcmin ?? 0;
    return dsoPixelRadius(
      (majorArcmin / 2 / 60) * DEG,
      t.view.fov * DEG,
      t.height,
      DSO_MIN_RADIUS_PX,
    );
  }

  /**
   * One overlay tick (<= 10 Hz): project every candidate, place the labels, move the marker and
   * write the DOM changes. Returns the number of labels drawn.
   */
  update(t: LabelTickInputs): number {
    const frame = t.frame;
    const { width, height } = t;
    if (!frame.valid || width <= 0 || height <= 0) {
      this.hideAll();
      return 0;
    }
    const years =
      this.catalog === null ? 0 : yearsSinceEpoch(frame.tt, this.catalog.columns.epochTt);
    // The view centre in ICRF and the cone that holds the whole viewport plus a margin.
    altAzToEnu(this.viewEnu, t.view.alt, t.view.az);
    rotateInverse(this.viewIcrf, frame.horizonQ, this.viewEnu);
    const tanHalf = Math.tan((t.view.fov / 2) * DEG);
    const halfDiag = Math.atan(tanHalf * Math.hypot(1, width / height)) / DEG;
    const cosCone = Math.cos(Math.min(89, halfDiag + CONE_MARGIN_DEG) * DEG);
    const projected = this.projected;
    for (let i = 0; i < this.candidates.length; i += 1) {
      const o = PROJECTED_STRIDE * i;
      projected[o + 2] = 0;
      if (!this.directionOf(i, t, years, cosCone)) {
        continue;
      }
      const enu = this.enu;
      if (t.cullBelowHorizon && enu[2] < 0) {
        continue;
      }
      enuToAltAz(this.altAz, enu[0], enu[1], enu[2]);
      if (
        !directionToScreen(
          this.screen,
          this.altAz.alt,
          this.altAz.az,
          width,
          height,
          t.view.fov,
          t.view.az,
          t.view.alt,
          t.roll,
        )
      ) {
        continue;
      }
      const candidate = this.candidates[i];
      if (candidate !== undefined) {
        candidate.radiusPx = this.radiusOf(i, t);
      }
      projected[o] = this.screen.x;
      projected[o + 1] = this.screen.y;
      projected[o + 2] = 1;
    }
    const budget = labelBudget(this.density);
    const placed = placeLabels(this.candidates, projected, budget, width, height, this.placement);
    this.writeDom(placed);
    this.updateMarker(t);
    return placed;
  }

  private writeDom(placed: number): void {
    const p = this.placement;
    let changed = false;
    for (let k = 0; k < this.slots.length; k += 1) {
      const slot = this.slots[k];
      if (slot === undefined) {
        continue;
      }
      if (k >= placed) {
        if (slot.id !== null) {
          slot.id = null;
          slot.span.hidden = true;
          slot.x = NaN;
          slot.y = NaN;
          changed = true;
        }
        continue;
      }
      const candidate = this.candidates[at(p.index, k)];
      if (candidate === undefined) {
        continue;
      }
      if (slot.id !== candidate.id) {
        slot.id = candidate.id;
        slot.span.textContent = candidate.text;
        slot.span.dataset.labelId = candidate.id;
        slot.span.dataset.labelKind = candidate.kind;
        slot.span.hidden = false;
        changed = true;
      } else if (slot.span.textContent !== candidate.text) {
        slot.span.textContent = candidate.text;
        changed = true;
      }
      const x = Math.round(at(p.x, k));
      const y = Math.round(at(p.y, k));
      if (x !== slot.x || y !== slot.y) {
        slot.x = x;
        slot.y = y;
        slot.span.style.transform = `translate3d(${String(x)}px, ${String(y)}px, 0)`;
      }
    }
    if (changed) {
      this.dirty = true;
    }
  }

  private updateMarker(t: LabelTickInputs): void {
    const id = this.selection;
    if (id === null || !this.resolver.directionOf(id, this.enu)) {
      this.hideMarker();
      return;
    }
    const enu = this.enu;
    if (t.cullBelowHorizon && enu[2] < 0) {
      this.hideMarker();
      return;
    }
    enuToAltAz(this.altAz, enu[0], enu[1], enu[2]);
    if (
      !directionToScreen(
        this.screen,
        this.altAz.alt,
        this.altAz.az,
        t.width,
        t.height,
        t.view.fov,
        t.view.az,
        t.view.alt,
        t.roll,
      )
    ) {
      this.hideMarker();
      return;
    }
    const selectedIndex = at(this.kinds, 0) === KIND_SELECTED ? 0 : -1;
    const radius = (selectedIndex === 0 ? this.radiusOf(0, t) : 0) + MARKER_MARGIN_PX;
    const r = Math.round(radius);
    const x = Math.round(this.screen.x - r);
    const y = Math.round(this.screen.y - r);
    if (this.markerId !== id) {
      this.markerId = id;
      this.marker.dataset.markerId = id;
      this.marker.hidden = false;
    }
    if (r !== this.markerR) {
      this.markerR = r;
      this.marker.style.width = `${String(2 * r)}px`;
      this.marker.style.height = `${String(2 * r)}px`;
    }
    if (x !== this.markerX || y !== this.markerY) {
      this.markerX = x;
      this.markerY = y;
      this.marker.style.transform = `translate3d(${String(x)}px, ${String(y)}px, 0)`;
    }
  }

  private hideMarker(): void {
    if (this.markerId !== null) {
      this.markerId = null;
      this.marker.hidden = true;
      this.markerX = NaN;
      this.markerY = NaN;
    }
  }

  private hideAll(): void {
    let changed = false;
    for (const slot of this.slots) {
      if (slot.id !== null) {
        slot.id = null;
        slot.span.hidden = true;
        slot.x = NaN;
        slot.y = NaN;
        changed = true;
      }
    }
    this.placement.count = 0;
    this.hideMarker();
    if (changed) {
      this.dirty = true;
    }
  }

  /**
   * Publish the drawn labels through `actions.setVisibleLabels` at most once per second and only
   * when the set of ids changed since the last publication (plan D105). Allocates the list only
   * when publishing.
   */
  publishIfChanged(nowMs: number, actions: Pick<SkyActions, 'setVisibleLabels'>): void {
    if (!this.dirty || nowMs - this.lastPublishMs < 1000) {
      return;
    }
    this.dirty = false;
    const drawn = this.drawnIds;
    drawn.length = 0;
    for (const slot of this.slots) {
      if (slot.id !== null) {
        drawn.push(slot.id);
      }
    }
    let same = drawn.length === this.publishedIds.length;
    for (let k = 0; same && k < drawn.length; k += 1) {
      same = drawn[k] === this.publishedIds[k];
    }
    if (same) {
      return;
    }
    this.lastPublishMs = nowMs;
    this.publishedIds.length = 0;
    const list: VisibleLabel[] = [];
    for (const slot of this.slots) {
      if (slot.id === null) {
        continue;
      }
      this.publishedIds.push(slot.id);
      const kind = slot.span.dataset.labelKind;
      list.push({
        id: slot.id,
        kind: this.kindOf(kind),
        text: slot.span.textContent,
      });
    }
    actions.setVisibleLabels(list);
    this.publishes += 1;
  }

  /** Publications of the visible-label list since creation (monotonic, plan D141). */
  get publishCount(): number {
    return this.publishes;
  }

  /**
   * Forget what was published: the engine emptied the store's list itself during a WebXR session
   * (plan D124, backlog B-80), so the next `publishIfChanged` must compare against nothing and
   * publish the drawn set again even when it did not change.
   */
  resetPublished(): void {
    this.publishedIds.length = 0;
    this.dirty = true;
  }

  private kindOf(value: string | undefined): LabelKind {
    switch (value) {
      case 'selected':
      case 'cardinal':
      case 'body':
      case 'star':
      case 'dso':
      case 'constellation':
      case 'minor':
        return value;
      default:
        return 'star';
    }
  }

  /** The drawn labels with their boxes (a fresh array; debug hook and e2e specs). */
  labelBoxes(): LabelBox[] {
    const out: LabelBox[] = [];
    const p = this.placement;
    for (let k = 0; k < p.count && k < this.slots.length; k += 1) {
      const slot = this.slots[k];
      const candidate = this.candidates[at(p.index, k)];
      if (slot === undefined || candidate === undefined) {
        continue;
      }
      if (slot.id === null) {
        continue;
      }
      out.push({
        id: candidate.id,
        kind: this.kindOf(candidate.kind),
        text: candidate.text,
        x: slot.x,
        y: slot.y,
        width: candidate.widthPx,
        height: candidate.heightPx,
      });
    }
    return out;
  }

  /**
   * Draw the visible labels and the marker onto a 2D context of the snapshot (VIEW-6): the same
   * font and colours as the overlay, scaled by `scale` device pixels per CSS pixel.
   */
  compositeOnto(ctx: CanvasRenderingContext2D, scale: number): void {
    ctx.save();
    ctx.font = `${String(LABEL_FONT_PX * scale)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textBaseline = 'middle';
    for (const slot of this.slots) {
      if (slot.id === null || Number.isNaN(slot.x)) {
        continue;
      }
      ctx.fillStyle = getComputedStyle(slot.span).color;
      ctx.fillText(
        slot.span.textContent,
        (slot.x + LABEL_PAD_PX) * scale,
        (slot.y + LABEL_LINE_HEIGHT_PX / 2) * scale,
      );
    }
    if (this.markerId !== null && !Number.isNaN(this.markerX)) {
      ctx.strokeStyle = getComputedStyle(this.marker).borderColor;
      ctx.lineWidth = 2 * scale;
      ctx.beginPath();
      ctx.arc(
        (this.markerX + this.markerR) * scale,
        (this.markerY + this.markerR) * scale,
        Math.max(1, this.markerR - 1) * scale,
        0,
        2 * Math.PI,
      );
      ctx.stroke();
    }
    ctx.restore();
  }

  dispose(): void {
    this.root.replaceChildren();
    this.slots.length = 0;
    this.widths.clear();
  }
}
