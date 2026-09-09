// Deep-sky object vertex shader, WGSL twin of dso.vertex.glsl (WebGPU; SKY-3, plan D101, brief
// l.88). One quad of four vertices per object, corners from the vertex index. Attributes:
// `position` = ICRS unit vector (sky/math/frames.ts `dirFromRaDec`), `dsoShape` = (magnitude or
// 99, major semi-axis rad, minor/major ratio or 1, position angle rad or 0), `dsoType` = symbol
// class 0..5 (sky/math/dso.ts `symbolIdOf`). Same rule as the star shader for the direction:
// first-order aberration (brief l.41 (d), catalog directions), the horizon rotation, optional D73
// refraction mirrored line by line from sky/math/refraction.ts. Visibility (dso.ts `dsoVisible`):
// mag <= limit - 8 B or major semi-axis >= size limit, and the type flag of uTypeOnA (galaxy,
// open cluster, globular cluster) / uTypeOnB (planetary nebula, nebula, other) set. The symbol
// radius is dso.ts `dsoPixelRadius`; the on-screen angle of the major axis is dso.ts
// `screenPositionAngle` from apparent.ts `billboardBasis` and dso.ts `northTangent`.
// `main` stays the last function of the file (Babylon injects its epilogue before the last `}`).
attribute position : vec3<f32>;
attribute dsoShape : vec4<f32>;
attribute dsoType : f32;

uniform worldViewProjection : mat4x4<f32>;
uniform uHorizonQ : vec4<f32>;
uniform uAberration : vec3<f32>;
uniform uRefraction : vec2<f32>;
uniform uViewport : vec2<f32>;
uniform uFovV : f32;
uniform uDsoLimits : vec4<f32>;
uniform uTypeOnA : vec3<f32>;
uniform uTypeOnB : vec3<f32>;
uniform uCameraRight : vec3<f32>;
uniform uAtmosphere : f32;

varying vCorner : vec2<f32>;
varying vSymbol : vec4<f32>;
varying vFade : f32;

const DEG : f32 = 0.017453292519943295;
const RAD : f32 = 57.29577951308232;
// Celestial sphere radius in Babylon units (sky/math/frames.ts SKY_RADIUS, brief l.59).
const SKY_RADIUS : f32 = 1000.0;
// sky/math/refraction.ts: Skyfield's cut and the arcminute unit of both formulas.
const ARCMIN_TO_DEG : f32 = 0.016666666666666666;
const MIN_REFRACTED_ALT_DEG : f32 = -1.0;
const MAX_REFRACTED_ALT_DEG : f32 = 89.9;
// sky/math/atmosphere.ts: STAR_FADE_MAGNITUDES, STAR_FADE_BRIGHTNESS.
const STAR_FADE_MAGNITUDES : f32 = 8.0;
const STAR_FADE_BRIGHTNESS : f32 = 0.85;
// apparent.ts BILLBOARD_EPSILON and the tangent epsilon of dso.ts northTangent.
const BASIS_EPSILON : f32 = 1e-12;

// Hamilton rotation by a unit quaternion (sky/math/quaternion.ts `rotate`).
fn rotateByQuat(q : vec4<f32>, v : vec3<f32>) -> vec3<f32> {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

// Saemundsson, true altitude in degrees (refraction.ts `saemundssonRefractionDeg`; the range
// check is done once by the caller).
fn saemundssonDeg(hTrue : f32, factor : f32) -> f32 {
  let arg = (hTrue + 10.3 / (hTrue + 5.11)) * DEG;
  return 1.02 / tan(arg) * ARCMIN_TO_DEG * factor;
}

// Bennett, apparent altitude in degrees (refraction.ts `bennettRefractionDeg`).
fn bennettDeg(hApp : f32, factor : f32) -> f32 {
  if (hApp < MIN_REFRACTED_ALT_DEG || hApp > MAX_REFRACTED_ALT_DEG) {
    return 0.0;
  }
  let arg = (hApp + 7.31 / (hApp + 4.4)) * DEG;
  return 1.0 / tan(arg) * ARCMIN_TO_DEG * factor;
}

// THE forward formula (plan D73): Saemundsson seed, then two Bennett corrections.
fn apparentAltitudeDeg(hTrue : f32, factor : f32) -> f32 {
  if (hTrue < MIN_REFRACTED_ALT_DEG || hTrue > MAX_REFRACTED_ALT_DEG) {
    return hTrue;
  }
  let a0 = hTrue + saemundssonDeg(hTrue, factor);
  let a1 = hTrue + bennettDeg(a0, factor);
  return hTrue + bennettDeg(a1, factor);
}

// The type flag of a symbol class: uTypeOnA = (galaxy, open, globular), uTypeOnB = (planetary,
// nebula, other), 0 or 1 each (plan Q47: two vec3 flags, no integer uniform).
fn typeFlag(symbolType : f32) -> f32 {
  if (symbolType < 0.5) {
    return uniforms.uTypeOnA.x;
  }
  if (symbolType < 1.5) {
    return uniforms.uTypeOnA.y;
  }
  if (symbolType < 2.5) {
    return uniforms.uTypeOnA.z;
  }
  if (symbolType < 3.5) {
    return uniforms.uTypeOnB.x;
  }
  if (symbolType < 4.5) {
    return uniforms.uTypeOnB.y;
  }
  return uniforms.uTypeOnB.z;
}

@vertex
fn main(input : VertexInputs) -> FragmentInputs {
  // Corner of the quad from the vertex index: 0 (-1,-1), 1 (1,-1), 2 (1,1), 3 (-1,1).
  let index = vertexInputs.vertexIndex & 3u;
  let bit0 = index & 1u;
  let bit1 = (index >> 1u) & 1u;
  let c = vec2<f32>(select(-1.0, 1.0, (bit0 ^ bit1) == 1u), select(-1.0, 1.0, bit1 == 1u));
  vertexOutputs.vCorner = c;
  let mag = vertexInputs.dsoShape.x;
  let major = vertexInputs.dsoShape.y;
  // uDsoLimits = (magnitude limit, size limit as a semi-axis in rad, min radius px, line width px).
  let magLimitEff = uniforms.uDsoLimits.x - STAR_FADE_MAGNITUDES * uniforms.uAtmosphere;
  let shown = typeFlag(vertexInputs.dsoType) > 0.5 && (mag <= magLimitEff || major >= uniforms.uDsoLimits.y);
  if (!shown) {
    // Filtered out: a degenerate quad outside the clip volume.
    vertexOutputs.position = vec4<f32>(0.0, 0.0, 2.0, 1.0);
    vertexOutputs.vSymbol = vec4<f32>(0.0);
    vertexOutputs.vFade = 0.0;
  } else {
    let d = normalize(vertexInputs.position + uniforms.uAberration);
    var enu = rotateByQuat(uniforms.uHorizonQ, d);
    if (uniforms.uRefraction.x > 0.5) {
      let alt = asin(clamp(enu.z, -1.0, 1.0)) * RAD;
      let altApp = apparentAltitudeDeg(alt, uniforms.uRefraction.y);
      let ch = cos(alt * DEG);
      let scale = select(1.0, cos(altApp * DEG) / ch, ch > 1e-6);
      enu = vec3<f32>(enu.xy * scale, sin(altApp * DEG));
    }
    var clip = uniforms.worldViewProjection * vec4<f32>(enu * SKY_RADIUS, 1.0);
    // dso.ts `dsoPixelRadius`: the true semi-axis on screen or the minimum radius.
    let radiusPx = max(uniforms.uDsoLimits.z, tan(major) / tan(uniforms.uFovV * 0.5) * uniforms.uViewport.y * 0.5);
    clip = vec4<f32>(clip.xy + c * radiusPx * 2.0 / uniforms.uViewport * clip.w, clip.zw);
    vertexOutputs.position = clip;
    // dso.ts `northTangent`: toward the ICRF pole in the tangent plane, rotated into ENU.
    var nt = vec3<f32>(0.0, 0.0, 1.0) - d.z * d;
    let ntLen2 = dot(nt, nt);
    nt = select(vec3<f32>(1.0, 0.0, 0.0), nt / sqrt(ntLen2), ntLen2 > BASIS_EPSILON);
    let nEnu = rotateByQuat(uniforms.uHorizonQ, nt);
    // apparent.ts `billboardBasis` at the object's image.
    var right = uniforms.uCameraRight - dot(uniforms.uCameraRight, enu) * enu;
    let rl2 = dot(right, right);
    if (rl2 < BASIS_EPSILON) {
      right = cross(enu, vec3<f32>(0.0, 0.0, 1.0));
    }
    right = normalize(right);
    let up = cross(-enu, right);
    // dso.ts `screenPositionAngle`: north on screen plus the position angle.
    let screenPa = atan2(dot(nEnu, up), dot(nEnu, right)) + vertexInputs.dsoShape.w;
    vertexOutputs.vSymbol = vec4<f32>(vertexInputs.dsoType, vertexInputs.dsoShape.z, screenPa, uniforms.uDsoLimits.w / radiusPx);
    vertexOutputs.vFade = 1.0 - STAR_FADE_BRIGHTNESS * uniforms.uAtmosphere;
  }
}
