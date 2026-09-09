// The star layer (plan D82; brief l.87, l.137-139, l.537): one mesh with four vertices per
// star and a custom shader pair (GLSL for WebGL2, WGSL for WebGPU) that applies proper motion,
// aberration, the horizon rotation, optional refraction and the corner expansion on the GPU.
// The geometry stays in ENU: the frozen world matrix P of `frames.ts` maps it to Babylon
// (ADR-0009), so the shaders use `worldViewProjection` and contain no axis swizzle.

import starsFragmentGlsl from '../../shaders/stars.fragment.glsl?raw';
import starsFragmentWgsl from '../../shaders/stars.fragment.wgsl?raw';
import starsVertexGlsl from '../../shaders/stars.vertex.glsl?raw';
import starsVertexWgsl from '../../shaders/stars.vertex.wgsl?raw';

import type { Backend } from '../../../state/types';
import { C_AU_PER_DAY } from '../../math/properMotion';
import { at } from '../../math/typed';
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
import type { StarCatalogInput } from '../types';

/** Custom vertex kinds; custom kinds need an explicit `size` (Babylon cannot deduce it). */
const STAR_PM_KIND = 'starPm';
const STAR_PHOT_KIND = 'starPhot';
const VERTICES_PER_STAR = 4;
const INDICES_PER_STAR = 6;

/** The uniform contract shared by both shader twins (plan D82). */
const STAR_UNIFORMS: readonly string[] = [
  'worldViewProjection',
  'uHorizonQ',
  'uAberration',
  'uYears',
  'uRefraction',
  'uViewport',
  'uFovV',
  'uMagLimit',
  'uMagScale',
  'uAtmosphere',
  'uNight',
];

/** Transparent-queue order inside rendering group 0: sky quad 0, stars 1, deep-sky objects 2. */
export const STAR_ALPHA_INDEX = 1;

/**
 * Stars this many magnitudes brighter than the limit reach full brightness; the ones at the
 * limit keep 10 % (Pogson). A visual constant, not an astronomical one, so it lives with the
 * layer rather than in `sky/math/stars.ts`.
 */
export const STAR_BRIGHTNESS_RANGE_MAG = 2.5;

/** Per-frame inputs of the star shader, filled by the engine without allocation. */
export interface StarUniforms {
  /** ICRF -> ENU. */
  horizonQ: ReadonlyQuat;
  /** Barycentric observer velocity, au/day (divided by c on upload). */
  observerVelocity: ReadonlyVec3;
  /** Julian years since the SKYS epoch. */
  years: number;
  refractionOn: boolean;
  /** The D73 pressure/temperature factor. */
  refractionFactor: number;
  /** Render-target size in device pixels. */
  viewportWidth: number;
  viewportHeight: number;
  /** Vertical field of view in radians. */
  fovRad: number;
  magLimit: number;
  /** Device pixels per CSS pixel (the size constants are in CSS pixels). */
  pixelScale: number;
  /** Sky brightness B (SKY-7): the limit drops by 8 B, the brightness by 85 % B; 0 under a manual limit. */
  atmosphere: number;
}

export class StarLayer {
  private readonly scene: Scene;
  private readonly material: ShaderMaterial;
  private readonly worldMatrix: Matrix;
  private mesh: Mesh | null = null;
  private starCount = 0;
  private visible = true;
  // Preallocated uniform carriers; ShaderMaterial keeps the references and reads them at bind.
  private readonly horizonQ = new Quaternion();
  private readonly aberration = new Vector3();
  private readonly refraction = new Vector2();
  private readonly viewport = new Vector2();
  private readonly magScale = new Vector4();
  private readonly night = new Vector2(0, 1);

  constructor(scene: Scene, backend: Backend, worldMatrix: Matrix) {
    this.scene = scene;
    this.worldMatrix = worldMatrix;
    const wgsl = backend === 'webgpu';
    this.material = new ShaderMaterial(
      'stars',
      scene,
      wgsl
        ? { vertexSource: starsVertexWgsl, fragmentSource: starsFragmentWgsl }
        : { vertexSource: starsVertexGlsl, fragmentSource: starsFragmentGlsl },
      {
        attributes: [VertexBuffer.PositionKind, STAR_PM_KIND, STAR_PHOT_KIND],
        uniforms: [...STAR_UNIFORMS],
        needAlphaBlending: true,
        shaderLanguage: wgsl ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
      },
    );
    // Additive soft discs: no depth, no culling (the quads face the camera by construction).
    this.material.alphaMode = Constants.ALPHA_ADD;
    this.material.disableDepthWrite = true;
    this.material.depthFunction = Constants.ALWAYS;
    this.material.backFaceCulling = false;
    this.material.setQuaternion('uHorizonQ', this.horizonQ);
    this.material.setVector3('uAberration', this.aberration);
    this.material.setVector2('uRefraction', this.refraction);
    this.material.setVector2('uViewport', this.viewport);
    this.material.setVector4('uMagScale', this.magScale);
    this.material.setVector2('uNight', this.night);
    this.material.setFloat('uAtmosphere', 0);
    this.material.setFloat('uYears', 0);
    this.material.setFloat('uFovV', 1);
    this.material.setFloat('uMagLimit', 6.5);
  }

  get count(): number {
    return this.starCount;
  }

  /** Upload the catalog once per session (brief l.71): four vertices per star. */
  setCatalog(catalog: StarCatalogInput): void {
    this.mesh?.dispose(false, false);
    this.mesh = null;
    const { dir, pm, mag, bv, count } = catalog.columns;
    const positions = new Float32Array(3 * VERTICES_PER_STAR * count);
    const motions = new Float32Array(3 * VERTICES_PER_STAR * count);
    const photometry = new Int16Array(2 * VERTICES_PER_STAR * count);
    const indices = new Uint32Array(INDICES_PER_STAR * count);
    for (let i = 0; i < count; i += 1) {
      const x = at(dir, 3 * i);
      const y = at(dir, 3 * i + 1);
      const z = at(dir, 3 * i + 2);
      const px = at(pm, 3 * i);
      const py = at(pm, 3 * i + 1);
      const pz = at(pm, 3 * i + 2);
      const m = at(mag, i);
      const b = at(bv, i);
      const v = VERTICES_PER_STAR * i;
      for (let k = 0; k < VERTICES_PER_STAR; k += 1) {
        const o = 3 * (v + k);
        positions[o] = x;
        positions[o + 1] = y;
        positions[o + 2] = z;
        motions[o] = px;
        motions[o + 1] = py;
        motions[o + 2] = pz;
        photometry[2 * (v + k)] = m;
        photometry[2 * (v + k) + 1] = b;
      }
      // Two triangles, corners 0-1-2 and 0-2-3 (the shader derives corners from the index).
      const t = INDICES_PER_STAR * i;
      indices[t] = v;
      indices[t + 1] = v + 1;
      indices[t + 2] = v + 2;
      indices[t + 3] = v;
      indices[t + 4] = v + 2;
      indices[t + 5] = v + 3;
    }
    const engine = this.scene.getEngine();
    const mesh = new Mesh('stars', this.scene);
    const totalVertices = VERTICES_PER_STAR * count;
    mesh.setVerticesBuffer(
      new VertexBuffer(engine, positions, VertexBuffer.PositionKind, { updatable: false, size: 3 }),
      true,
      totalVertices,
    );
    mesh.setVerticesBuffer(
      new VertexBuffer(engine, motions, STAR_PM_KIND, { updatable: false, size: 3 }),
    );
    // SNORM16 x2: magnitude and B-V in millimagnitudes, 32767 = unknown B-V (handled in the
    // shader); WebGPU maps this to `snorm16x2`, WebGL2 to a normalized SHORT attribute.
    mesh.setVerticesBuffer(
      new VertexBuffer(engine, photometry, STAR_PHOT_KIND, {
        updatable: false,
        size: 2,
        type: VertexBuffer.SHORT,
        normalized: true,
      }),
    );
    mesh.setIndices(indices, totalVertices, false);
    mesh.material = this.material;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = true;
    mesh.isPickable = false;
    mesh.renderingGroupId = 0;
    mesh.alphaIndex = STAR_ALPHA_INDEX;
    // Own copy of P: `freezeWorldMatrix` keeps the reference and a dirtied node recomputes into
    // it in place (Babylon 9.25), so sharing one instance across meshes is unsafe.
    mesh.freezeWorldMatrix(this.worldMatrix.clone());
    mesh.isVisible = this.visible;
    this.mesh = mesh;
    this.starCount = count;
  }

  /** Upload the per-frame uniforms (no allocation). */
  update(u: StarUniforms): void {
    const q = u.horizonQ;
    this.horizonQ.set(q[0], q[1], q[2], q[3]);
    const v = u.observerVelocity;
    this.aberration.set(v[0] / C_AU_PER_DAY, v[1] / C_AU_PER_DAY, v[2] / C_AU_PER_DAY);
    this.refraction.set(u.refractionOn ? 1 : 0, u.refractionFactor);
    this.viewport.set(u.viewportWidth, u.viewportHeight);
    this.magScale.set(u.magLimit - STAR_BRIGHTNESS_RANGE_MAG, u.pixelScale, 0, 0);
    this.material.setFloat('uYears', u.years);
    this.material.setFloat('uFovV', u.fovRad);
    this.material.setFloat('uMagLimit', u.magLimit);
    this.material.setFloat('uAtmosphere', u.atmosphere);
  }

  /** Night mode (plan D108): `uNight = (on, level)`. */
  setNight(on: boolean, level: number): void {
    this.night.set(on ? 1 : 0, level);
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
