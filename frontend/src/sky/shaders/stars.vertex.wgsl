// Star vertex shader, WGSL twin of stars.vertex.glsl (WebGPU; plan D82, brief l.87, l.137-139).
// Babylon's WGSL processor turns `attribute name : type;` into vertexInputs.name, `uniform` into
// the `uniforms` buffer and `varying` into vertexOutputs.name; `vertexInputs.vertexIndex` is the
// vertex_index built-in. The processor injects code before the last `}` of the file, so `main`
// is the last function and returns nowhere early. Same rule and constants as the GLSL twin.
attribute position : vec3<f32>;
attribute starPm : vec3<f32>;
attribute starPhot : vec2<f32>;

uniform worldViewProjection : mat4x4<f32>;
uniform uHorizonQ : vec4<f32>;
uniform uAberration : vec3<f32>;
uniform uYears : f32;
uniform uRefraction : vec2<f32>;
uniform uViewport : vec2<f32>;
uniform uFovV : f32;
uniform uMagLimit : f32;
uniform uMagScale : vec4<f32>;

varying vCorner : vec2<f32>;
varying vColor : vec4<f32>;

const DEG : f32 = 0.017453292519943295;
const RAD : f32 = 57.29577951308232;
// Celestial sphere radius in Babylon units (sky/math/frames.ts SKY_RADIUS, brief l.59).
const SKY_RADIUS : f32 = 1000.0;
// starPhot is SNORM16: value * 32767 millimag / 1000 = magnitudes (docs/api.md "SKYS v1").
const SNORM_TO_MAG : f32 = 32.767;
// The SKYS sentinel 32767 (unknown B-V) decodes to 1.0; no real B-V reaches 32 mag.
const BV_UNKNOWN_THRESHOLD : f32 = 0.9999;
const BV_DEFAULT : f32 = 0.65;
// sky/math/stars.ts: STAR_SIZE_*, STAR_REFERENCE_MAG, STAR_SIZE_ZOOM_MAG, WIDE_FIELD_FOV_DEG.
const STAR_SIZE_BASE_PX : f32 = 1.0;
const STAR_SIZE_PER_MAG : f32 = 0.55;
const STAR_SIZE_MIN_PX : f32 = 1.0;
const STAR_SIZE_MAX_PX : f32 = 12.0;
const STAR_REFERENCE_MAG : f32 = 6.5;
const STAR_SIZE_ZOOM_MAG : f32 = 3.0;
const WIDE_FIELD_FOV_DEG : f32 = 90.0;
// sky/math/refraction.ts: Skyfield's cut and the arcminute unit of both formulas.
const ARCMIN_TO_DEG : f32 = 0.016666666666666666;
const MIN_REFRACTED_ALT_DEG : f32 = -1.0;
const MAX_REFRACTED_ALT_DEG : f32 = 89.9;

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

// Piecewise-linear B-V -> sRGB, the stops of sky/math/stars.ts BV_COLOR_STOPS.
fn bvToRgb(bv : f32) -> vec3<f32> {
  let c0 = vec3<f32>(0.607843137, 0.690196078, 1.0);
  let c1 = vec3<f32>(0.792156863, 0.847058824, 1.0);
  let c2 = vec3<f32>(0.972549020, 0.968627451, 1.0);
  let c3 = vec3<f32>(1.0, 0.956862745, 0.917647059);
  let c4 = vec3<f32>(1.0, 0.823529412, 0.631372549);
  let c5 = vec3<f32>(1.0, 0.8, 0.435294118);
  if (bv <= 0.0) {
    return mix(c0, c1, clamp((bv + 0.33) / 0.33, 0.0, 1.0));
  }
  if (bv <= 0.3) {
    return mix(c1, c2, bv / 0.3);
  }
  if (bv <= 0.6) {
    return mix(c2, c3, (bv - 0.3) / 0.3);
  }
  if (bv <= 1.0) {
    return mix(c3, c4, (bv - 0.6) / 0.4);
  }
  return mix(c4, c5, clamp((bv - 1.0) / 0.4, 0.0, 1.0));
}

@vertex
fn main(input : VertexInputs) -> FragmentInputs {
  // Corner of the quad from the vertex index: 0 (-1,-1), 1 (1,-1), 2 (1,1), 3 (-1,1).
  let index = vertexInputs.vertexIndex & 3u;
  let bit0 = index & 1u;
  let bit1 = (index >> 1u) & 1u;
  let c = vec2<f32>(select(-1.0, 1.0, (bit0 ^ bit1) == 1u), select(-1.0, 1.0, bit1 == 1u));
  let mag = vertexInputs.starPhot.x * SNORM_TO_MAG;
  vertexOutputs.vCorner = c;
  if (mag > uniforms.uMagLimit) {
    // Fainter than the limit: a degenerate quad outside the clip volume.
    vertexOutputs.position = vec4<f32>(0.0, 0.0, 2.0, 1.0);
    vertexOutputs.vColor = vec4<f32>(0.0);
  } else {
    var d = normalize(vertexInputs.position + vertexInputs.starPm * uniforms.uYears);
    d = normalize(d + uniforms.uAberration);
    var enu = rotateByQuat(uniforms.uHorizonQ, d);
    if (uniforms.uRefraction.x > 0.5) {
      let alt = asin(clamp(enu.z, -1.0, 1.0)) * RAD;
      let altApp = apparentAltitudeDeg(alt, uniforms.uRefraction.y);
      let ch = cos(alt * DEG);
      let scale = select(1.0, cos(altApp * DEG) / ch, ch > 1e-6);
      enu = vec3<f32>(enu.xy * scale, sin(altApp * DEG));
    }
    var clip = uniforms.worldViewProjection * vec4<f32>(enu * SKY_RADIUS, 1.0);
    // stars.ts `starPixelRadius`: reference magnitude rising with the zoom on a log scale.
    let fovDeg = uniforms.uFovV * RAD;
    let zoom = clamp(log(WIDE_FIELD_FOV_DEG / fovDeg) / log(WIDE_FIELD_FOV_DEG), 0.0, 1.0);
    let reference = STAR_REFERENCE_MAG + STAR_SIZE_ZOOM_MAG * zoom;
    let radiusCss = clamp(STAR_SIZE_BASE_PX + STAR_SIZE_PER_MAG * (reference - mag), STAR_SIZE_MIN_PX, STAR_SIZE_MAX_PX);
    let radiusPx = radiusCss * uniforms.uMagScale.y;
    clip = vec4<f32>(clip.xy + c * radiusPx * 2.0 / uniforms.uViewport * clip.w, clip.zw);
    vertexOutputs.position = clip;
    let bvRaw = vertexInputs.starPhot.y;
    let bv = select(bvRaw * SNORM_TO_MAG, BV_DEFAULT, bvRaw > BV_UNKNOWN_THRESHOLD);
    // stars.ts `starBrightness(mag, uMagScale.x)`.
    let brightness = clamp(pow(10.0, -0.4 * (mag - uniforms.uMagScale.x)), 0.0, 1.0);
    vertexOutputs.vColor = vec4<f32>(bvToRgb(bv), brightness);
  }
}
