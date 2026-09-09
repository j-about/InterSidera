// The minor-body layer (SKY-4, brief l.212, plan D102): asteroids and comets of the current
// frame window drawn through the bodies shader (shared material, so the same uniforms) with two
// quads per slot: a flat disc (class 4, radius from the apparent magnitude through
// `sky/math/minorBodies.ts`) and, for comets, a tail strip (class 5) along the antisolar tangent
// projected on the billboard basis. Positions are the apparent ENU directions (refracted on
// Earth) under the frozen world matrix P (ADR-0009). Rendering group 2 with the bodies.

import type { FrameEval, ViewState } from '../../../state/types';
import { billboardBasis, enuFromApparentIcrf, screenAngle } from '../../math/apparent';
import { SKY_RADIUS, cameraBasis } from '../../math/frames';
import { antisolarTangent, minorPixelRadius } from '../../math/minorBodies';
import { rotate } from '../../math/quaternion';
import { at, load3, vec3 } from '../../math/typed';
import { Mesh, VertexBuffer } from '../babylon';
import type { Matrix, Scene, ShaderMaterial } from '../babylon';

const BODY_PARAMS_KIND = 'bodyParams';
const BODY_SUN_KIND = 'bodySun';
const VERTICES_PER_QUAD = 4;
const INDICES_PER_QUAD = 6;
const QUADS_PER_SLOT = 2;
/** Shader classes of the bodies twins (plan D102). */
const CLASS_MINOR_DISC = 4;
const CLASS_COMET_TAIL = 5;
const CLASS_HIDDEN = -1;
/** `mag: null` travels as NaN (plan D74) and is uploaded as this sentinel. */
const MAG_UNKNOWN = -99;

export class MinorLayer {
  private readonly scene: Scene;
  private readonly material: ShaderMaterial;
  private readonly worldMatrix: Matrix;
  private mesh: Mesh | null = null;
  private positionBuffer: VertexBuffer | null = null;
  private paramsBuffer: VertexBuffer | null = null;
  private positions = new Float32Array(0);
  private params = new Float32Array(0);
  private capacity = 0;
  private visible = true;
  private drawn = 0;
  // Scratch vectors (nothing is allocated per frame).
  private readonly dirIcrf = vec3();
  private readonly enu = vec3();
  private readonly enuApparent = vec3();
  private readonly sunEnu = vec3();
  private readonly tail = vec3();
  private readonly camForward = vec3();
  private readonly camRight = vec3();
  private readonly camUp = vec3();
  private readonly right = vec3();
  private readonly up = vec3();

  /** `material` is the bodies layer's shader material (same uniforms, one compile). */
  constructor(scene: Scene, material: ShaderMaterial, worldMatrix: Matrix) {
    this.scene = scene;
    this.material = material;
    this.worldMatrix = worldMatrix;
  }

  /** Minor bodies drawn by the last `update` (`stats().minorDrawn`). */
  get drawnCount(): number {
    return this.drawn;
  }

  /** (Re)allocate two quads per slot for `limits.max_minor_bodies` slots; called on `/meta`. */
  setCapacity(capacity: number): void {
    const cap = Math.max(1, capacity);
    if (cap === this.capacity && this.mesh !== null) {
      return;
    }
    this.disposeMesh();
    this.capacity = cap;
    const quads = QUADS_PER_SLOT * cap;
    const vertices = VERTICES_PER_QUAD * quads;
    this.positions = new Float32Array(3 * vertices);
    this.params = new Float32Array(4 * vertices);
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
    const mesh = new Mesh('minor', this.scene);
    this.positionBuffer = new VertexBuffer(engine, this.positions, VertexBuffer.PositionKind, {
      updatable: true,
      size: 3,
    });
    this.paramsBuffer = new VertexBuffer(engine, this.params, BODY_PARAMS_KIND, {
      updatable: true,
      size: 4,
    });
    mesh.setVerticesBuffer(this.positionBuffer, true, vertices);
    mesh.setVerticesBuffer(this.paramsBuffer);
    // The Sun attribute is unused by classes 4 and 5; the shader still expects the buffer.
    mesh.setVerticesBuffer(
      new VertexBuffer(engine, new Float32Array(3 * vertices), BODY_SUN_KIND, {
        updatable: false,
        size: 3,
      }),
    );
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
   * Refresh every slot from the current evaluation (no allocation): the disc at the apparent
   * direction with the CPU radius, the tail of a comet along the antisolar screen angle.
   */
  update(frame: FrameEval, view: ViewState, refractionOn: boolean, refractionFactor: number): void {
    if (this.mesh === null || this.positionBuffer === null || this.paramsBuffer === null) {
      return;
    }
    const q = frame.horizonQ;
    rotate(this.sunEnu, q, frame.sunDir);
    cameraBasis(this.camForward, this.camRight, this.camUp, view.az, view.alt);
    const count = Math.min(frame.minorCount, this.capacity);
    let drawn = 0;
    for (let m = 0; m < this.capacity; m += 1) {
      const disc = QUADS_PER_SLOT * m;
      const tail = disc + 1;
      if (m >= count || at(frame.minorDrawn, m) !== 1) {
        this.writeHidden(disc);
        this.writeHidden(tail);
        continue;
      }
      drawn += 1;
      load3(this.dirIcrf, frame.minorDir, 3 * m);
      rotate(this.enu, q, this.dirIcrf);
      enuFromApparentIcrf(this.enuApparent, this.dirIcrf, q, refractionOn, refractionFactor);
      const magRaw = at(frame.minorMag, m);
      const mag = Number.isNaN(magRaw) ? MAG_UNKNOWN : magRaw;
      this.writeQuad(disc, minorPixelRadius(magRaw), mag, CLASS_MINOR_DISC);
      if (frame.minorKinds[m] === 'comet' && antisolarTangent(this.tail, this.enu, this.sunEnu)) {
        billboardBasis(this.right, this.up, this.enu, this.camRight);
        this.writeQuad(tail, screenAngle(this.tail, this.right, this.up), mag, CLASS_COMET_TAIL);
      } else {
        this.writeHidden(tail);
      }
    }
    this.drawn = drawn;
    this.positionBuffer.updateDirectly(this.positions, 0);
    this.paramsBuffer.updateDirectly(this.params, 0);
  }

  setVisible(on: boolean): void {
    this.visible = on;
    if (this.mesh !== null) {
      this.mesh.isVisible = on;
    }
  }

  dispose(): void {
    this.disposeMesh();
  }

  /** `bodyParams.x` carries the CSS radius (class 4) or the screen angle (class 5). */
  private writeQuad(slot: number, x: number, mag: number, cls: number): void {
    const v = VERTICES_PER_QUAD * slot;
    const enu = this.enuApparent;
    for (let k = 0; k < VERTICES_PER_QUAD; k += 1) {
      const p = 3 * (v + k);
      this.positions[p] = enu[0] * SKY_RADIUS;
      this.positions[p + 1] = enu[1] * SKY_RADIUS;
      this.positions[p + 2] = enu[2] * SKY_RADIUS;
      const r = 4 * (v + k);
      this.params[r] = x;
      this.params[r + 1] = mag;
      this.params[r + 2] = 0;
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
  }
}
