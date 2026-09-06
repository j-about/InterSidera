// The solar-system bodies layer (plan D83; SKY-2, brief l.87): one mesh with one billboard quad
// per body plus one glare quad for the Sun, refreshed every frame from the CPU-interpolated
// apparent directions (plan D74) rotated into ENU, refracted on Earth with the same D73
// formula as the star shader so both share one apparent frame (brief l.41). The geometry stays
// in ENU under the frozen world matrix P (ADR-0009).

import bodiesFragmentGlsl from '../../shaders/bodies.fragment.glsl?raw';
import bodiesFragmentWgsl from '../../shaders/bodies.fragment.wgsl?raw';
import bodiesVertexGlsl from '../../shaders/bodies.vertex.glsl?raw';
import bodiesVertexWgsl from '../../shaders/bodies.vertex.wgsl?raw';

import type { Backend, FrameEval, ViewState } from '../../../state/types';
import { DEG, SKY_RADIUS, altAzToEnu, enuToAltAz } from '../../math/frames';
import type { AltAz } from '../../math/frames';
import { rotate } from '../../math/quaternion';
import { apparentAltitudeDeg } from '../../math/refraction';
import { at, load3, vec3 } from '../../math/typed';
import type { ReadonlyVec3 } from '../../math/typed';
import { copy3, cross3, dot3, length3, scale3 } from '../../math/vec3';
import { Constants, Mesh, ShaderLanguage, ShaderMaterial, Vector2, VertexBuffer } from '../babylon';
import type { Matrix, Scene } from '../babylon';

const BODY_PARAMS_KIND = 'bodyParams';
const BODY_SUN_KIND = 'bodySun';
const VERTICES_PER_QUAD = 4;
const INDICES_PER_QUAD = 6;

/** Shader classes (bodies.*.glsl / .wgsl). */
const CLASS_SUN = 0;
const CLASS_MOON = 1;
const CLASS_OTHER = 2;
const CLASS_GLARE = 3;
const CLASS_HIDDEN = -1;
/** `mag: null` travels as NaN (plan D74) and is uploaded as this sentinel. */
const MAG_UNKNOWN = -99;
/** Minimum disc radius, CSS pixels (SKY-2 "a minimum pixel size otherwise"). */
export const BODY_MIN_RADIUS_PX = 2.5;
/** Glare radius added around the Sun disc, CSS pixels. */
export const SUN_GLARE_RADIUS_PX = 40;

const BODY_UNIFORMS: readonly string[] = ['worldViewProjection', 'uViewport', 'uFovV', 'uBodyPx'];

const UP: ReadonlyVec3 = [0, 0, 1];
/** Below this squared length the projected camera axis is degenerate (body on that axis). */
const BASIS_EPSILON = 1e-12;

function classOf(id: string): number {
  if (id === 'sun') {
    return CLASS_SUN;
  }
  if (id === 'moon') {
    return CLASS_MOON;
  }
  return CLASS_OTHER;
}

export class BodiesLayer {
  private readonly scene: Scene;
  private readonly material: ShaderMaterial;
  private readonly worldMatrix: Matrix;
  private mesh: Mesh | null = null;
  private positionBuffer: VertexBuffer | null = null;
  private paramsBuffer: VertexBuffer | null = null;
  private sunBuffer: VertexBuffer | null = null;
  private positions = new Float32Array(0);
  private params = new Float32Array(0);
  private sun = new Float32Array(0);
  private quads = 0;
  private visible = true;
  // Preallocated uniform carriers and scratch vectors.
  private readonly viewport = new Vector2();
  private readonly bodyPx = new Vector2();
  private readonly dirIcrf = vec3();
  private readonly enu = vec3();
  private readonly enuApparent = vec3();
  private readonly sunEnu = vec3();
  private readonly lightEnu = vec3();
  private readonly cameraRight = vec3();
  private readonly right = vec3();
  private readonly up = vec3();
  private readonly altAz: AltAz = { alt: 0, az: 0 };

  constructor(scene: Scene, backend: Backend, worldMatrix: Matrix) {
    this.scene = scene;
    this.worldMatrix = worldMatrix;
    const wgsl = backend === 'webgpu';
    this.material = new ShaderMaterial(
      'bodies',
      scene,
      wgsl
        ? { vertexSource: bodiesVertexWgsl, fragmentSource: bodiesFragmentWgsl }
        : { vertexSource: bodiesVertexGlsl, fragmentSource: bodiesFragmentGlsl },
      {
        attributes: [VertexBuffer.PositionKind, BODY_PARAMS_KIND, BODY_SUN_KIND],
        uniforms: [...BODY_UNIFORMS],
        needAlphaBlending: true,
        shaderLanguage: wgsl ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
      },
    );
    // Premultiplied blending: discs write (rgb * a, a), the glare writes (rgb, 0) and adds.
    this.material.alphaMode = Constants.ALPHA_PREMULTIPLIED;
    this.material.disableDepthWrite = true;
    this.material.depthFunction = Constants.ALWAYS;
    this.material.backFaceCulling = false;
    this.material.setVector2('uViewport', this.viewport);
    this.material.setVector2('uBodyPx', this.bodyPx);
    this.material.setFloat('uFovV', 1);
  }

  /** (Re)allocate `bodyCount + 1` quads (the last one is the Sun glare); called on `/meta`. */
  setCapacity(bodyCount: number): void {
    const quads = Math.max(1, bodyCount) + 1;
    if (quads === this.quads && this.mesh !== null) {
      return;
    }
    this.disposeMesh();
    this.quads = quads;
    const vertices = VERTICES_PER_QUAD * quads;
    this.positions = new Float32Array(3 * vertices);
    this.params = new Float32Array(4 * vertices);
    this.sun = new Float32Array(3 * vertices);
    for (let i = 0; i < vertices; i += 1) {
      this.params[4 * i + 3] = CLASS_HIDDEN;
    }
    const indices = new Uint32Array(INDICES_PER_QUAD * quads);
    for (let i = 0; i < quads; i += 1) {
      const v = VERTICES_PER_QUAD * i;
      const t = INDICES_PER_QUAD * i;
      indices[t] = v;
      indices[t + 1] = v + 1;
      indices[t + 2] = v + 2;
      indices[t + 3] = v;
      indices[t + 4] = v + 2;
      indices[t + 5] = v + 3;
    }
    const engine = this.scene.getEngine();
    const mesh = new Mesh('bodies', this.scene);
    this.positionBuffer = new VertexBuffer(engine, this.positions, VertexBuffer.PositionKind, {
      updatable: true,
      size: 3,
    });
    this.paramsBuffer = new VertexBuffer(engine, this.params, BODY_PARAMS_KIND, {
      updatable: true,
      size: 4,
    });
    this.sunBuffer = new VertexBuffer(engine, this.sun, BODY_SUN_KIND, {
      updatable: true,
      size: 3,
    });
    mesh.setVerticesBuffer(this.positionBuffer, true, vertices);
    mesh.setVerticesBuffer(this.paramsBuffer);
    mesh.setVerticesBuffer(this.sunBuffer);
    mesh.setIndices(indices, vertices, false);
    mesh.material = this.material;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = true;
    mesh.isPickable = false;
    mesh.renderingGroupId = 2;
    // Own copy of P: `freezeWorldMatrix` keeps the reference and a dirtied node recomputes into
    // it in place (Babylon 9.25), so sharing one instance across meshes is unsafe.
    mesh.freezeWorldMatrix(this.worldMatrix.clone());
    mesh.isVisible = this.visible;
    this.mesh = mesh;
  }

  /**
   * Refresh every quad from the current evaluation (no allocation): position = apparent ENU
   * direction (refracted when `refractionOn`) scaled to the sky radius, params = (angular
   * radius, magnitude, phase, class), sun = the body -> Sun light direction in the billboard
   * basis so the fragment shader can shade the phase. `width`/`height` are render pixels, `fovRad` the
   * vertical field of view, `pixelScale` device pixels per CSS pixel.
   */
  update(
    frame: FrameEval,
    view: ViewState,
    refractionOn: boolean,
    refractionFactor: number,
    width: number,
    height: number,
    fovRad: number,
    pixelScale: number,
  ): void {
    if (
      this.mesh === null ||
      this.positionBuffer === null ||
      this.paramsBuffer === null ||
      this.sunBuffer === null
    ) {
      return;
    }
    this.viewport.set(width, height);
    this.bodyPx.set(BODY_MIN_RADIUS_PX * pixelScale, SUN_GLARE_RADIUS_PX * pixelScale);
    this.material.setFloat('uFovV', fovRad);

    // The Sun direction as seen by the observer, and the camera's horizontal right axis (the
    // `(cos az, -sin az, 0)` of `frames.ts` `cameraBasis`; the camera never rolls) from which
    // `billboardBasis` derives each body's own screen-aligned basis.
    const q = frame.horizonQ;
    rotate(this.sunEnu, q, frame.sunDir);
    const azRad = view.az * DEG;
    this.cameraRight[0] = Math.cos(azRad);
    this.cameraRight[1] = -Math.sin(azRad);
    this.cameraRight[2] = 0;

    // The Sun's distance feeds the per-body light direction (`lightDirection`); the Sun is
    // always a requested body because it is never an observer (brief l.129, docs/api.md).
    const sunIndex = frame.bodyIds.indexOf('sun');
    const sunDist = sunIndex >= 0 && sunIndex < frame.bodyCount ? at(frame.distAu, sunIndex) : NaN;

    const bodySlots = this.quads - 1;
    const drawn = Math.min(frame.bodyCount, bodySlots);
    let sunSlot = -1;
    for (let i = 0; i < bodySlots; i += 1) {
      if (i >= drawn) {
        this.writeHidden(i);
        continue;
      }
      const id = frame.bodyIds[i] ?? '';
      load3(this.dirIcrf, frame.dir, 3 * i);
      rotate(this.enu, q, this.dirIcrf);
      enuToAltAz(this.altAz, this.enu[0], this.enu[1], this.enu[2]);
      const altApparent = refractionOn
        ? apparentAltitudeDeg(this.altAz.alt, refractionFactor)
        : this.altAz.alt;
      altAzToEnu(this.enuApparent, altApparent, this.altAz.az);
      const magRaw = at(frame.mag, i);
      const mag = Number.isNaN(magRaw) ? MAG_UNKNOWN : magRaw;
      const diamDeg = at(frame.diamDeg, i);
      const angularRadius = Number.isNaN(diamDeg) ? 0 : (diamDeg / 2) * DEG;
      const phaseRaw = at(frame.phase, i);
      const phase = Number.isNaN(phaseRaw) ? 1 : phaseRaw;
      const cls = classOf(id);
      if (cls === CLASS_SUN) {
        sunSlot = i;
      }
      this.billboardBasis(this.enu);
      this.lightDirection(cls === CLASS_SUN ? NaN : at(frame.distAu, i), sunDist);
      this.writeQuad(
        i,
        this.enuApparent,
        angularRadius,
        mag,
        phase,
        cls,
        dot3(this.right, this.lightEnu),
        dot3(this.up, this.lightEnu),
        -dot3(this.enu, this.lightEnu),
      );
    }
    // The glare quad copies the Sun slot with its own class (SKY-2 "a glare for the Sun").
    const glare = this.quads - 1;
    if (sunSlot >= 0) {
      const src = 4 * VERTICES_PER_QUAD * sunSlot;
      this.enuApparent[0] = at(this.positions, 3 * VERTICES_PER_QUAD * sunSlot) / SKY_RADIUS;
      this.enuApparent[1] = at(this.positions, 3 * VERTICES_PER_QUAD * sunSlot + 1) / SKY_RADIUS;
      this.enuApparent[2] = at(this.positions, 3 * VERTICES_PER_QUAD * sunSlot + 2) / SKY_RADIUS;
      this.writeQuad(
        glare,
        this.enuApparent,
        at(this.params, src),
        at(this.params, src + 1),
        at(this.params, src + 2),
        CLASS_GLARE,
        0,
        0,
        1,
      );
    } else {
      this.writeHidden(glare);
    }
    this.positionBuffer.updateDirectly(this.positions, 0);
    this.paramsBuffer.updateDirectly(this.params, 0);
    this.sunBuffer.updateDirectly(this.sun, 0);
  }

  setVisible(on: boolean): void {
    this.visible = on;
    if (this.mesh !== null) {
      this.mesh.isVisible = on;
    }
  }

  dispose(): void {
    this.disposeMesh();
    this.material.dispose();
  }

  /**
   * Orthonormal billboard basis of the body at unit ENU direction `dir`, into `right` and `up`.
   * The quad is expanded in screen pixels, so the fragment shader's sphere normal
   * `(corner, sqrt(1 - r^2))` lives in (screen right, screen up, toward the viewer) at the body's
   * image. A rectilinear projection maps screen right at that image to the camera's right axis
   * projected on the body's tangent plane, `cameraRight - (cameraRight . dir) dir`; `up` is then
   * `(-dir) x right` so that `right x up` points to the viewer. Reusing the camera's own right/up
   * for every body would make `(right, up, -dir)` non-orthonormal off-centre and skew the
   * terminator (about 2 degrees at 25 degrees off-axis with a 60 degree field of view).
   */
  private billboardBasis(dir: ReadonlyVec3): void {
    const r = this.right;
    const along = dot3(this.cameraRight, dir);
    r[0] = this.cameraRight[0] - along * dir[0];
    r[1] = this.cameraRight[1] - along * dir[1];
    r[2] = this.cameraRight[2] - along * dir[2];
    let len2 = dot3(r, r);
    if (len2 < BASIS_EPSILON) {
      // The body lies on the camera's right axis (90 degrees off-screen, still uploaded as a
      // hidden-by-clipping quad): screen right is undefined there, so use the horizontal
      // direction to the body's right, `dir x Up`, which a horizontal `dir` never degenerates.
      cross3(r, dir, UP);
      len2 = dot3(r, r);
    }
    const inv = 1 / Math.sqrt(len2);
    r[0] *= inv;
    r[1] *= inv;
    r[2] *= inv;
    // up = (-dir) x right
    this.up[0] = -(dir[1] * r[2] - dir[2] * r[1]);
    this.up[1] = -(dir[2] * r[0] - dir[0] * r[2]);
    this.up[2] = -(dir[0] * r[1] - dir[1] * r[0]);
  }

  /**
   * Unit ENU direction from the body toward the Sun, `normalize(sunEnu * dSun - enu * dBody)`
   * from the observer-centred positions (SKY-2 "lit from `sun_dir`", brief l.87). The observer ->
   * Sun direction alone would light every outer planet from behind the viewer's line of sight
   * (Jupiter rendered black at 30 degrees from the Sun); the difference is the true illumination
   * direction and reduces to `sunEnu` for the Moon (0.003 au against 1 au). Falls back to
   * `sunEnu` for the Sun itself, when a distance is unknown, or when the body sits at the Sun.
   * Allocation-free: writes `lightEnu`.
   */
  private lightDirection(dist: number, sunDist: number): void {
    const l = this.lightEnu;
    if (Number.isNaN(dist) || Number.isNaN(sunDist)) {
      copy3(l, this.sunEnu);
      return;
    }
    l[0] = this.sunEnu[0] * sunDist - this.enu[0] * dist;
    l[1] = this.sunEnu[1] * sunDist - this.enu[1] * dist;
    l[2] = this.sunEnu[2] * sunDist - this.enu[2] * dist;
    const len = length3(l);
    if (!(len > 1e-9)) {
      copy3(l, this.sunEnu);
      return;
    }
    scale3(l, l, 1 / len);
  }

  private writeQuad(
    slot: number,
    enu: readonly [number, number, number],
    angularRadius: number,
    mag: number,
    phase: number,
    cls: number,
    sunX: number,
    sunY: number,
    sunZ: number,
  ): void {
    const v = VERTICES_PER_QUAD * slot;
    for (let k = 0; k < VERTICES_PER_QUAD; k += 1) {
      const p = 3 * (v + k);
      this.positions[p] = enu[0] * SKY_RADIUS;
      this.positions[p + 1] = enu[1] * SKY_RADIUS;
      this.positions[p + 2] = enu[2] * SKY_RADIUS;
      this.sun[p] = sunX;
      this.sun[p + 1] = sunY;
      this.sun[p + 2] = sunZ;
      const r = 4 * (v + k);
      this.params[r] = angularRadius;
      this.params[r + 1] = mag;
      this.params[r + 2] = phase;
      this.params[r + 3] = cls;
    }
  }

  private writeHidden(slot: number): void {
    const v = VERTICES_PER_QUAD * slot;
    for (let k = 0; k < VERTICES_PER_QUAD; k += 1) {
      this.params[4 * (v + k) + 3] = CLASS_HIDDEN;
    }
  }

  private disposeMesh(): void {
    this.mesh?.dispose(false, false);
    this.mesh = null;
    this.positionBuffer = null;
    this.paramsBuffer = null;
    this.sunBuffer = null;
  }
}
