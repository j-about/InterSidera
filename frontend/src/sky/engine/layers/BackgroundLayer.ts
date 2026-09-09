// The sky background and the ground (SKY-6, SKY-7, brief l.214-215, plan D104): two full-screen
// quads emitted in clip space by one shader pair, mode 0 the daylight/twilight sky (rendering
// group 0, `alphaIndex` 0, before the stars) and mode 1 the ground below the horizon (group 3,
// after everything). The fragment shaders rebuild the ENU direction of every pixel from the
// camera basis of `frames.ts::cameraBasis`, so no geometry rotates and no swizzle exists; the
// colour model is `sky/math/atmosphere.ts` mirrored line by line. Canvas only: a render target
// would need the y flip Babylon applies after the varying (verified on the WebGPU processor).

import backgroundFragmentGlsl from '../../shaders/background.fragment.glsl?raw';
import backgroundFragmentWgsl from '../../shaders/background.fragment.wgsl?raw';
import backgroundVertexGlsl from '../../shaders/background.vertex.glsl?raw';
import backgroundVertexWgsl from '../../shaders/background.vertex.wgsl?raw';

import type { Backend } from '../../../state/types';
import type { ReadonlyVec3 } from '../../math/typed';
import {
  Constants,
  Mesh,
  ShaderLanguage,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  VertexBuffer,
} from '../babylon';
import type { Matrix, Scene } from '../babylon';

const BACKGROUND_UNIFORMS: readonly string[] = [
  'uMode',
  'uCamForward',
  'uCamRight',
  'uCamUp',
  'uProj',
  'uSunEnu',
  'uSky',
  'uNight',
];

/** Per-frame inputs of both passes, filled by the engine without allocation. */
export interface BackgroundUniforms {
  camForward: ReadonlyVec3;
  camRight: ReadonlyVec3;
  camUp: ReadonlyVec3;
  tanHalfFov: number;
  aspect: number;
  /** Sun direction in ENU (`rotate(horizonQ, sunDir)`). */
  sunEnu: ReadonlyVec3;
  sunAltDeg: number;
  /** `atmosphere.ts::groundAlpha` of the SKY-6 mode. */
  groundAlpha: number;
}

interface Pass {
  mesh: Mesh;
  material: ShaderMaterial;
}

export class BackgroundLayer {
  private readonly sky: Pass;
  private readonly ground: Pass;
  // Uniform carriers shared by both materials (the same values every frame).
  private readonly camForward = new Vector3();
  private readonly camRight = new Vector3();
  private readonly camUp = new Vector3();
  private readonly proj = new Vector2(1, 1);
  private readonly sunEnu = new Vector3(0, 0, -1);
  private readonly skyParams = new Vector4(-90, 0, 0, 0);
  private readonly night = new Vector2(0, 1);

  constructor(scene: Scene, backend: Backend, worldMatrix: Matrix) {
    this.sky = this.createPass(scene, backend, worldMatrix, 'sky', 0, 0, 0);
    this.ground = this.createPass(scene, backend, worldMatrix, 'ground', 1, 3, 0);
  }

  private createPass(
    scene: Scene,
    backend: Backend,
    worldMatrix: Matrix,
    name: string,
    mode: number,
    group: number,
    alphaIndex: number,
  ): Pass {
    const wgsl = backend === 'webgpu';
    const material = new ShaderMaterial(
      name,
      scene,
      wgsl
        ? { vertexSource: backgroundVertexWgsl, fragmentSource: backgroundFragmentWgsl }
        : { vertexSource: backgroundVertexGlsl, fragmentSource: backgroundFragmentGlsl },
      {
        attributes: [VertexBuffer.PositionKind],
        uniforms: [...BACKGROUND_UNIFORMS],
        needAlphaBlending: true,
        shaderLanguage: wgsl ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
      },
    );
    // Standard blending: the sky (alpha 1) replaces the clear colour, the ground covers by alpha.
    material.alphaMode = Constants.ALPHA_COMBINE;
    material.disableDepthWrite = true;
    material.depthFunction = Constants.ALWAYS;
    material.backFaceCulling = false;
    material.setFloat('uMode', mode);
    material.setVector3('uCamForward', this.camForward);
    material.setVector3('uCamRight', this.camRight);
    material.setVector3('uCamUp', this.camUp);
    material.setVector2('uProj', this.proj);
    material.setVector3('uSunEnu', this.sunEnu);
    material.setVector4('uSky', this.skyParams);
    material.setVector2('uNight', this.night);

    // Four clip-space corners; the vertex shader emits them as they are.
    const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
    const mesh = new Mesh(name, scene);
    mesh.setVerticesBuffer(
      new VertexBuffer(scene.getEngine(), positions, VertexBuffer.PositionKind, {
        updatable: false,
        size: 3,
      }),
      true,
      4,
    );
    mesh.setIndices(indices, 4, false);
    mesh.material = material;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = true;
    mesh.isPickable = false;
    mesh.renderingGroupId = group;
    mesh.alphaIndex = alphaIndex;
    // The shader ignores the world matrix; P is still frozen on it like every sky mesh.
    mesh.freezeWorldMatrix(worldMatrix.clone());
    mesh.isVisible = false;
    return { mesh, material };
  }

  /** Upload the per-frame uniforms (no allocation). */
  update(u: BackgroundUniforms): void {
    this.camForward.set(u.camForward[0], u.camForward[1], u.camForward[2]);
    this.camRight.set(u.camRight[0], u.camRight[1], u.camRight[2]);
    this.camUp.set(u.camUp[0], u.camUp[1], u.camUp[2]);
    this.proj.set(u.tanHalfFov, u.aspect);
    this.sunEnu.set(u.sunEnu[0], u.sunEnu[1], u.sunEnu[2]);
    this.skyParams.set(u.sunAltDeg, u.groundAlpha, 0, 0);
  }

  /** Night mode (plan D108): `uNight = (on, level)`. */
  setNight(on: boolean, level: number): void {
    this.night.set(on ? 1 : 0, level);
  }

  setSkyVisible(on: boolean): void {
    this.sky.mesh.isVisible = on;
  }

  setGroundVisible(on: boolean): void {
    this.ground.mesh.isVisible = on;
  }

  dispose(): void {
    this.sky.mesh.dispose(false, false);
    this.sky.material.dispose();
    this.ground.mesh.dispose(false, false);
    this.ground.material.dispose();
  }
}
