// The deep-sky layer (SKY-3, brief l.211, plan D101): one mesh with four vertices per object and
// a custom shader pair (GLSL for WebGL2, WGSL for WebGPU) that applies aberration, the horizon
// rotation and the optional refraction on the GPU, tests the magnitude/size limits and the type
// filter per vertex and draws one procedural symbol per type. The geometry is the ICRS unit
// vector under the frozen world matrix P (ADR-0009); the shaders use `worldViewProjection`.
// Rendering group 0 behind the bodies, `alphaIndex` 2 after the sky quad and the stars.

import dsoFragmentGlsl from '../../shaders/dso.fragment.glsl?raw';
import dsoFragmentWgsl from '../../shaders/dso.fragment.wgsl?raw';
import dsoVertexGlsl from '../../shaders/dso.vertex.glsl?raw';
import dsoVertexWgsl from '../../shaders/dso.vertex.wgsl?raw';

import type { DsoEntry } from '../../../api/catalogs';
import { DSO_TYPES } from '../../../state/types';
import type { Backend, DsoType } from '../../../state/types';
import {
  DSO_LINE_WIDTH_PX,
  DSO_MAG_UNKNOWN,
  DSO_MIN_RADIUS_PX,
  dsoVisible,
  symbolIdOf,
  writeDsoShape,
} from '../../math/dso';
import { DEG, dirFromRaDec } from '../../math/frames';
import { C_AU_PER_DAY } from '../../math/properMotion';
import { at, vec3 } from '../../math/typed';
import type { ReadonlyQuat, ReadonlyVec3 } from '../../math/typed';
import {
  Constants,
  Mesh,
  Quaternion,
  ShaderLanguage,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  VertexBuffer,
} from '../babylon';
import type { Matrix, Scene } from '../babylon';

const DSO_SHAPE_KIND = 'dsoShape';
const DSO_TYPE_KIND = 'dsoType';
const VERTICES_PER_OBJECT = 4;
const INDICES_PER_OBJECT = 6;
const ARCMIN_TO_RAD = DEG / 60;
/** Transparent-queue order inside rendering group 0: sky quad 0, stars 1, deep-sky objects 2. */
export const DSO_ALPHA_INDEX = 2;

/** The uniform contract shared by both shader twins (plan D101). */
const DSO_UNIFORMS: readonly string[] = [
  'worldViewProjection',
  'uHorizonQ',
  'uAberration',
  'uRefraction',
  'uViewport',
  'uFovV',
  'uDsoLimits',
  'uTypeOnA',
  'uTypeOnB',
  'uCameraRight',
  'uAtmosphere',
  'uNight',
];

/** Per-frame inputs of the DSO shader, filled by the engine without allocation. */
export interface DsoUniforms {
  horizonQ: ReadonlyQuat;
  /** Barycentric observer velocity, au/day (divided by c on upload). */
  observerVelocity: ReadonlyVec3;
  refractionOn: boolean;
  refractionFactor: number;
  /** Render-target size in device pixels. */
  viewportWidth: number;
  viewportHeight: number;
  fovRad: number;
  /** `dso.ts::dsoMagnitudeLimit`. */
  magLimit: number;
  /** `dso.ts::dsoSizeLimitArcmin` (major axis). */
  sizeLimitArcmin: number;
  /** Device pixels per CSS pixel. */
  pixelScale: number;
  /** The camera's horizontal right axis in ENU (`frames.ts::cameraBasis`). */
  cameraRight: ReadonlyVec3;
  /** Sky brightness B (0 under a manual magnitude limit, plan Q43). */
  atmosphere: number;
}

export class DsoLayer {
  private readonly scene: Scene;
  private readonly material: ShaderMaterial;
  private readonly worldMatrix: Matrix;
  private mesh: Mesh | null = null;
  private entries: readonly DsoEntry[] = [];
  /** Symbol class per object (`symbolIdOf`), for the CPU visibility count. */
  private classes = new Uint8Array(0);
  /** Magnitude (99 unknown) and major axis in arcminutes (0 unknown) per object. */
  private mags = new Float32Array(0);
  private majors = new Float32Array(0);
  private readonly typeOn = [true, true, true, true, true, true];
  private visible = true;
  // Preallocated uniform carriers; ShaderMaterial keeps the references and reads them at bind.
  private readonly horizonQ = new Quaternion();
  private readonly aberration = new Vector3();
  private readonly refraction = new Vector2();
  private readonly viewport = new Vector2();
  private readonly limits = new Vector4();
  private readonly typeA = new Vector3(1, 1, 1);
  private readonly typeB = new Vector3(1, 1, 1);
  private readonly cameraRight = new Vector3();
  private readonly night = new Vector2(0, 1);
  private readonly scratch = vec3();

  constructor(scene: Scene, backend: Backend, worldMatrix: Matrix) {
    this.scene = scene;
    this.worldMatrix = worldMatrix;
    const wgsl = backend === 'webgpu';
    this.material = new ShaderMaterial(
      'dso',
      scene,
      wgsl
        ? { vertexSource: dsoVertexWgsl, fragmentSource: dsoFragmentWgsl }
        : { vertexSource: dsoVertexGlsl, fragmentSource: dsoFragmentGlsl },
      {
        attributes: [VertexBuffer.PositionKind, DSO_SHAPE_KIND, DSO_TYPE_KIND],
        uniforms: [...DSO_UNIFORMS],
        needAlphaBlending: true,
        shaderLanguage: wgsl ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
      },
    );
    // Premultiplied "over" (plan D122, the star layer's rule): the fragment writes a coverage
    // alpha max(rgb) and mode 8 composites it over the transparent AR canvas and in the export
    // canvas by definition; a lone outline on the black sky is unchanged. No depth, no culling
    // (the quads face the camera by construction).
    this.material.alphaMode = Constants.ALPHA_PREMULTIPLIED_PORTERDUFF;
    this.material.disableDepthWrite = true;
    this.material.depthFunction = Constants.ALWAYS;
    this.material.backFaceCulling = false;
    this.material.setQuaternion('uHorizonQ', this.horizonQ);
    this.material.setVector3('uAberration', this.aberration);
    this.material.setVector2('uRefraction', this.refraction);
    this.material.setVector2('uViewport', this.viewport);
    this.material.setVector4('uDsoLimits', this.limits);
    this.material.setVector3('uTypeOnA', this.typeA);
    this.material.setVector3('uTypeOnB', this.typeB);
    this.material.setVector3('uCameraRight', this.cameraRight);
    this.material.setVector2('uNight', this.night);
    this.material.setFloat('uFovV', 1);
    this.material.setFloat('uAtmosphere', 0);
  }

  get count(): number {
    return this.entries.length;
  }

  /** Upload the catalog once per session: four vertices per object (plan D101). */
  setEntries(entries: readonly DsoEntry[] | null): void {
    this.mesh?.dispose(false, false);
    this.mesh = null;
    this.entries = entries ?? [];
    const count = this.entries.length;
    this.classes = new Uint8Array(count);
    this.mags = new Float32Array(count);
    this.majors = new Float32Array(count);
    if (count === 0) {
      return;
    }
    const positions = new Float32Array(3 * VERTICES_PER_OBJECT * count);
    const shapes = new Float32Array(4 * VERTICES_PER_OBJECT * count);
    const types = new Float32Array(VERTICES_PER_OBJECT * count);
    const indices = new Uint32Array(INDICES_PER_OBJECT * count);
    const dir = this.scratch;
    const shape = new Float32Array(4);
    this.entries.forEach((entry, i) => {
      dirFromRaDec(dir, entry.ra_deg, entry.dec_deg);
      writeDsoShape(shape, 0, entry.mag, entry.major_arcmin, entry.minor_arcmin, entry.pa_deg);
      const cls = symbolIdOf(entry.type);
      this.classes[i] = cls;
      this.mags[i] = entry.mag ?? DSO_MAG_UNKNOWN;
      this.majors[i] = entry.major_arcmin ?? 0;
      const v = VERTICES_PER_OBJECT * i;
      for (let k = 0; k < VERTICES_PER_OBJECT; k += 1) {
        const o = 3 * (v + k);
        positions[o] = dir[0];
        positions[o + 1] = dir[1];
        positions[o + 2] = dir[2];
        shapes.set(shape, 4 * (v + k));
        types[v + k] = cls;
      }
      // Two triangles, corners 0-1-2 and 0-2-3 (the shader derives corners from the index).
      const t = INDICES_PER_OBJECT * i;
      indices[t] = v;
      indices[t + 1] = v + 1;
      indices[t + 2] = v + 2;
      indices[t + 3] = v;
      indices[t + 4] = v + 2;
      indices[t + 5] = v + 3;
    });
    const engine = this.scene.getEngine();
    const mesh = new Mesh('dso', this.scene);
    const totalVertices = VERTICES_PER_OBJECT * count;
    mesh.setVerticesBuffer(
      new VertexBuffer(engine, positions, VertexBuffer.PositionKind, { updatable: false, size: 3 }),
      true,
      totalVertices,
    );
    mesh.setVerticesBuffer(
      new VertexBuffer(engine, shapes, DSO_SHAPE_KIND, { updatable: false, size: 4 }),
    );
    mesh.setVerticesBuffer(
      new VertexBuffer(engine, types, DSO_TYPE_KIND, { updatable: false, size: 1 }),
    );
    mesh.setIndices(indices, totalVertices, false);
    mesh.material = this.material;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = true;
    mesh.isPickable = false;
    mesh.renderingGroupId = 0;
    mesh.alphaIndex = DSO_ALPHA_INDEX;
    // Own copy of P: `freezeWorldMatrix` keeps the reference and a dirtied node recomputes into
    // it in place (Babylon 9.25), so sharing one instance across meshes is unsafe.
    mesh.freezeWorldMatrix(this.worldMatrix.clone());
    mesh.isVisible = this.visible;
    this.mesh = mesh;
  }

  /** The `dso` URL filter: `null` shows every type (plan Q47: two vec3 flags, no int uniform). */
  setTypeFilter(types: readonly DsoType[] | null): void {
    DSO_TYPES.forEach((type, i) => {
      this.typeOn[i] = types === null || types.includes(type);
    });
    const on = (i: number): number => (this.typeOn[i] === true ? 1 : 0);
    this.typeA.set(on(0), on(1), on(2));
    this.typeB.set(on(3), on(4), on(5));
  }

  /** Night mode (plan D108): `uNight = (on, level)`. */
  setNight(on: boolean, level: number): void {
    this.night.set(on ? 1 : 0, level);
  }

  /** Upload the per-frame uniforms (no allocation). */
  update(u: DsoUniforms): void {
    const q = u.horizonQ;
    this.horizonQ.set(q[0], q[1], q[2], q[3]);
    const v = u.observerVelocity;
    this.aberration.set(v[0] / C_AU_PER_DAY, v[1] / C_AU_PER_DAY, v[2] / C_AU_PER_DAY);
    this.refraction.set(u.refractionOn ? 1 : 0, u.refractionFactor);
    this.viewport.set(u.viewportWidth, u.viewportHeight);
    this.limits.set(
      u.magLimit,
      (u.sizeLimitArcmin / 2) * ARCMIN_TO_RAD,
      DSO_MIN_RADIUS_PX * u.pixelScale,
      DSO_LINE_WIDTH_PX * u.pixelScale,
    );
    const r = u.cameraRight;
    this.cameraRight.set(r[0], r[1], r[2]);
    this.material.setFloat('uFovV', u.fovRad);
    this.material.setFloat('uAtmosphere', u.atmosphere);
  }

  /** How many objects the shader draws under these limits (the debug `stats().dso`, <= 10 Hz). */
  countVisible(magLimit: number, sizeLimitArcmin: number): number {
    let n = 0;
    for (let i = 0; i < this.entries.length; i += 1) {
      if (
        this.typeOn[at(this.classes, i)] === true &&
        dsoVisible(at(this.mags, i), at(this.majors, i), magLimit, sizeLimitArcmin)
      ) {
        n += 1;
      }
    }
    return n;
  }

  /** Whether object `row` passes the type filter and the limits (picking, labels). */
  isShown(row: number, magLimit: number, sizeLimitArcmin: number): boolean {
    return (
      this.typeOn[at(this.classes, row)] === true &&
      dsoVisible(at(this.mags, row), at(this.majors, row), magLimit, sizeLimitArcmin)
    );
  }

  /** Major semi-axis of object `row` in radians (0 when unknown). */
  majorSemiAxisRad(row: number): number {
    return (at(this.majors, row) / 2) * ARCMIN_TO_RAD;
  }

  setVisible(on: boolean): void {
    this.visible = on;
    if (this.mesh !== null) {
      this.mesh.isVisible = on;
    }
  }

  dispose(): void {
    this.mesh?.dispose(false, false);
    this.mesh = null;
    this.material.dispose();
  }
}
