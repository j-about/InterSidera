// Reference overlays (plan D84; SKY-6, brief l.88, l.62, l.68): horizon with cardinal ticks,
// altitude/azimuth grid and meridian generated once in ENU; equatorial grid of date and the
// J2000 ecliptic regenerated at <= 10 Hz from the current rotations. Points come from the pure
// generators of `sky/math/lines.ts` as unit vectors, are scaled to the sky radius and uploaded
// into updatable LinesMesh buffers under the frozen world matrix P (ADR-0009). Cardinal letters
// are labels (LabelLayer) and the ground a background pass (BackgroundLayer). These meshes carry
// no vertex colours, so night mode (plan D108) rewrites `mesh.color` at change time.

import type { FrameEval, LayerFlags } from '../../../state/types';
import { SKY_RADIUS, eclipticPoleIcrf } from '../../math/frames';
import {
  ALTAZ_GRID_ALT_STEP_DEG,
  ALTAZ_GRID_AZ_STEP_DEG,
  CIRCLE_SEGMENTS,
  EQUATORIAL_GRID_DEC_STEP_DEG,
  EQUATORIAL_GRID_RA_STEP_DEG,
  azimuthArcPoints,
  greatCirclePoints,
  rotatePointsInPlace,
  smallCirclePoints,
} from '../../math/lines';
import { conjugateQ, multiplyQ } from '../../math/quaternion';
import { at, quat, vec3 } from '../../math/typed';
import type { Vec3 } from '../../math/typed';
import { Color3, CreateLineSystem, Vector3, VertexBuffer } from '../babylon';
import type { LinesMesh, Matrix, Scene } from '../babylon';

const CIRCLE_POINTS = CIRCLE_SEGMENTS + 1;
/** Points per vertical grid arc (5 degree steps from nadir to zenith). */
const ARC_POINTS = 37;
/** Cardinal ticks rise this far above the horizon (degrees). */
const CARDINAL_TICK_DEG = 1.5;

const UP: Vec3 = [0, 0, 1];
const EAST: Vec3 = [1, 0, 0];
const POLE: Vec3 = [0, 0, 1];

interface LineStyle {
  r: number;
  g: number;
  b: number;
  alpha: number;
}

type LineName = 'horizon' | 'azgrid' | 'meridian' | 'eqgrid' | 'ecliptic';

const STYLES: Record<LineName, LineStyle> = {
  horizon: { r: 0.85, g: 0.55, b: 0.25, alpha: 0.9 },
  azgrid: { r: 0.35, g: 0.55, b: 0.85, alpha: 0.35 },
  meridian: { r: 0.85, g: 0.35, b: 0.35, alpha: 0.6 },
  eqgrid: { r: 0.35, g: 0.8, b: 0.5, alpha: 0.35 },
  ecliptic: { r: 0.9, g: 0.8, b: 0.3, alpha: 0.7 },
};
const LINE_NAMES: readonly LineName[] = ['horizon', 'azgrid', 'meridian', 'eqgrid', 'ecliptic'];
/** Rec. 709 luminance of the night palette (plan D108: red channel alone). */
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/** One LinesMesh with its point buffer and the polyline structure (point counts). */
interface LineSet {
  mesh: LinesMesh;
  data: Float32Array;
  points: number;
}

function totalPoints(counts: readonly number[]): number {
  let n = 0;
  for (const c of counts) {
    n += c;
  }
  return n;
}

/** Scale unit vectors in place to the sky radius. */
function scaleToSky(data: Float32Array): void {
  for (let k = 0; k < data.length; k += 1) {
    data[k] = at(data, k) * SKY_RADIUS;
  }
}

/** Babylon needs `Vector3[][]` once, at creation; later updates reuse the flat array. */
function toLines(data: Float32Array, counts: readonly number[]): Vector3[][] {
  const lines: Vector3[][] = [];
  let offset = 0;
  for (const count of counts) {
    const line: Vector3[] = [];
    for (let k = 0; k < count; k += 1) {
      const o = 3 * (offset + k);
      line.push(new Vector3(at(data, o), at(data, o + 1), at(data, o + 2)));
    }
    lines.push(line);
    offset += count;
  }
  return lines;
}

const eqGridCounts: number[] = [];
const eqGridDecs: number[] = [];
for (let dec = -90 + EQUATORIAL_GRID_DEC_STEP_DEG; dec < 90; dec += EQUATORIAL_GRID_DEC_STEP_DEG) {
  eqGridDecs.push(dec);
}
const EQ_RA_CIRCLES = 180 / EQUATORIAL_GRID_RA_STEP_DEG;
for (let k = 0; k < EQ_RA_CIRCLES; k += 1) {
  eqGridCounts.push(CIRCLE_POINTS);
}
eqGridCounts.push(...eqGridDecs.map(() => CIRCLE_POINTS));

// Scratch normal of the RA circles: `generateEquatorialGrid` runs at up to 10 Hz inside the
// render loop and must not allocate (rules/frontend.md).
const raNormal = vec3();

/** Equatorial grid in the frame whose pole is +Z (of date before rotation): RA great circles
 * through the poles every 15 degrees, declination circles every 15 degrees minus the poles. */
function generateEquatorialGrid(data: Float32Array): void {
  let offset = 0;
  const normal = raNormal;
  for (let k = 0; k < EQ_RA_CIRCLES; k += 1) {
    const ra = k * EQUATORIAL_GRID_RA_STEP_DEG * (Math.PI / 180);
    normal[0] = Math.cos(ra);
    normal[1] = Math.sin(ra);
    normal[2] = 0;
    offset += greatCirclePoints(data, offset, normal, CIRCLE_POINTS);
  }
  for (const dec of eqGridDecs) {
    offset += smallCirclePoints(data, offset, POLE, 90 - dec, CIRCLE_POINTS);
  }
}

export class LineLayers {
  private readonly horizon: LineSet;
  private readonly azgrid: LineSet;
  private readonly meridian: LineSet;
  private readonly eqgrid: LineSet;
  private readonly ecliptic: LineSet;
  private readonly qOfDateToEnu = quat();
  private readonly qConj = quat();
  private readonly eclipticPole = vec3();

  constructor(scene: Scene, worldMatrix: Matrix) {
    // Horizon: one great circle around Up plus four cardinal ticks.
    const horizonCounts = [CIRCLE_POINTS, 2, 2, 2, 2];
    const horizonData = new Float32Array(3 * totalPoints(horizonCounts));
    let offset = greatCirclePoints(horizonData, 0, UP, CIRCLE_POINTS);
    for (const az of [0, 90, 180, 270]) {
      offset += azimuthArcPoints(horizonData, offset, az, 0, CARDINAL_TICK_DEG, 2);
    }
    this.horizon = LineLayers.build(scene, worldMatrix, 'horizon', horizonData, horizonCounts);

    // Altitude/azimuth grid: vertical arcs every 15 degrees, altitude circles every 10 degrees
    // excluding the poles.
    const azCount = 360 / ALTAZ_GRID_AZ_STEP_DEG;
    const alts: number[] = [];
    for (let alt = -90 + ALTAZ_GRID_ALT_STEP_DEG; alt < 90; alt += ALTAZ_GRID_ALT_STEP_DEG) {
      alts.push(alt);
    }
    const azgridCounts: number[] = [];
    for (let k = 0; k < azCount; k += 1) {
      azgridCounts.push(ARC_POINTS);
    }
    azgridCounts.push(...alts.map(() => CIRCLE_POINTS));
    const azgridData = new Float32Array(3 * totalPoints(azgridCounts));
    offset = 0;
    for (let k = 0; k < azCount; k += 1) {
      offset += azimuthArcPoints(
        azgridData,
        offset,
        k * ALTAZ_GRID_AZ_STEP_DEG,
        -90,
        90,
        ARC_POINTS,
      );
    }
    for (const alt of alts) {
      offset += smallCirclePoints(azgridData, offset, UP, 90 - alt, CIRCLE_POINTS);
    }
    this.azgrid = LineLayers.build(scene, worldMatrix, 'azgrid', azgridData, azgridCounts);

    // Meridian: the great circle through north, zenith and south (normal = East).
    const meridianData = new Float32Array(3 * CIRCLE_POINTS);
    greatCirclePoints(meridianData, 0, EAST, CIRCLE_POINTS);
    this.meridian = LineLayers.build(scene, worldMatrix, 'meridian', meridianData, [CIRCLE_POINTS]);

    // Dynamic sets start with their identity-frame geometry and are refreshed by `updateDynamic`.
    const eqgridData = new Float32Array(3 * totalPoints(eqGridCounts));
    generateEquatorialGrid(eqgridData);
    this.eqgrid = LineLayers.build(scene, worldMatrix, 'eqgrid', eqgridData, eqGridCounts);

    const eclipticData = new Float32Array(3 * CIRCLE_POINTS);
    greatCirclePoints(eclipticData, 0, eclipticPoleIcrf(this.eclipticPole), CIRCLE_POINTS);
    this.ecliptic = LineLayers.build(scene, worldMatrix, 'ecliptic', eclipticData, [CIRCLE_POINTS]);
  }

  /** Generate unit points, scale them and create the LinesMesh (setup only). */
  private static build(
    scene: Scene,
    worldMatrix: Matrix,
    name: LineName,
    data: Float32Array,
    counts: readonly number[],
  ): LineSet {
    scaleToSky(data);
    // `useVertexAlpha` must be explicit: Babylon 9.25 passes the option through unchanged and a
    // missing value disables blending, so `mesh.alpha` would be ignored.
    const mesh = CreateLineSystem(
      name,
      { lines: toLines(data, counts), updatable: true, useVertexAlpha: true },
      scene,
    );
    const style = STYLES[name];
    mesh.color = new Color3(style.r, style.g, style.b);
    mesh.alpha = style.alpha;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = true;
    mesh.isPickable = false;
    mesh.renderingGroupId = 1;
    // Own copy of P per mesh: `freezeWorldMatrix` keeps the reference and `computeWorldMatrix`
    // writes into it in place as soon as the node is marked dirty (Babylon 9.25 transformNode),
    // so one shared instance would let a single dirtied mesh overwrite the matrix of all others.
    mesh.freezeWorldMatrix(worldMatrix.clone());
    return { mesh, data, points: totalPoints(counts) };
  }

  /** Night mode (plan D108): the luminance of each style in the red channel, scaled by the level. */
  setNight(on: boolean, level: number): void {
    for (const name of LINE_NAMES) {
      const style = STYLES[name];
      const mesh = this[name].mesh;
      if (on) {
        const l = (style.r * LUMA_R + style.g * LUMA_G + style.b * LUMA_B) * level;
        mesh.color.set(l, 0, 0);
      } else {
        mesh.color.set(style.r, style.g, style.b);
      }
    }
  }

  /**
   * Apply the layer flags. The static sets are ENU geometry and may show at once; the rotating
   * sets need a frame window first (`hasFrame`): until `updateDynamic` has run they still hold
   * their identity-frame geometry, which would put the celestial pole at the zenith.
   */
  setVisibility(layers: LayerFlags, hasFrame: boolean): void {
    this.horizon.mesh.isVisible = layers.horizon;
    this.azgrid.mesh.isVisible = layers.azgrid;
    this.meridian.mesh.isVisible = layers.meridian;
    this.eqgrid.mesh.isVisible = layers.eqgrid && hasFrame;
    this.ecliptic.mesh.isVisible = layers.ecliptic && hasFrame;
  }

  /**
   * Refresh the rotating overlays (<= 10 Hz, brief l.68): the equatorial grid of date through
   * `q_h * conj(q_eq)` (of-date -> ICRF -> ENU) and the J2000 ecliptic through `q_h`.
   */
  updateDynamic(frame: FrameEval): void {
    if (this.eqgrid.mesh.isVisible) {
      conjugateQ(this.qConj, frame.equinoxQ);
      multiplyQ(this.qOfDateToEnu, frame.horizonQ, this.qConj);
      generateEquatorialGrid(this.eqgrid.data);
      rotatePointsInPlace(this.eqgrid.data, 0, this.eqgrid.points, this.qOfDateToEnu);
      scaleToSky(this.eqgrid.data);
      this.eqgrid.mesh.updateVerticesData(
        VertexBuffer.PositionKind,
        this.eqgrid.data,
        false,
        false,
      );
    }
    if (this.ecliptic.mesh.isVisible) {
      greatCirclePoints(this.ecliptic.data, 0, eclipticPoleIcrf(this.eclipticPole), CIRCLE_POINTS);
      rotatePointsInPlace(this.ecliptic.data, 0, this.ecliptic.points, frame.horizonQ);
      scaleToSky(this.ecliptic.data);
      this.ecliptic.mesh.updateVerticesData(
        VertexBuffer.PositionKind,
        this.ecliptic.data,
        false,
        false,
      );
    }
  }

  dispose(): void {
    this.horizon.mesh.dispose();
    this.azgrid.mesh.dispose();
    this.meridian.mesh.dispose();
    this.eqgrid.mesh.dispose();
    this.ecliptic.mesh.dispose();
  }
}
