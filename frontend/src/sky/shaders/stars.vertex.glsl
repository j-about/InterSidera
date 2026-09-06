// Star vertex shader, GLSL twin of stars.vertex.wgsl (WebGL2; plan D82, brief l.87, l.137-139).
// Babylon's WebGL2 processor prepends the GLSL ES 3.00 version line and rewrites `attribute`
// -> `in` and `varying` -> `out`; `gl_VertexID` is a GLSL ES 3.00 built-in. GLSL comments are
// NOT stripped before that pass: a comment containing the version directive or a preprocessor
// keyword (hash + if/else/endif/define/include) is taken for real code and disables the
// conversion, so no such token may appear anywhere in this file. Both twins implement the same
// rule with the same constants: d = normalize(dir + pm * years), d = normalize(d + v / c),
// enu = q_h d, optional D73 refraction on the altitude (azimuth kept), corner expansion sized
// by magnitude and field of view, colour from B-V (sky/math/stars.ts, sky/math/refraction.ts).
precision highp float;
precision highp int;

attribute vec3 position;
attribute vec3 starPm;
attribute vec2 starPhot;

uniform mat4 worldViewProjection;
uniform vec4 uHorizonQ;
uniform vec3 uAberration;
uniform float uYears;
uniform vec2 uRefraction;
uniform vec2 uViewport;
uniform float uFovV;
uniform float uMagLimit;
uniform vec4 uMagScale;

varying vec2 vCorner;
varying vec4 vColor;

const float DEG = 0.017453292519943295;
const float RAD = 57.29577951308232;
// Celestial sphere radius in Babylon units (sky/math/frames.ts SKY_RADIUS, brief l.59).
const float SKY_RADIUS = 1000.0;
// starPhot is SNORM16: value * 32767 millimag / 1000 = magnitudes (docs/api.md "SKYS v1").
const float SNORM_TO_MAG = 32.767;
// The SKYS sentinel 32767 (unknown B-V) decodes to 1.0; no real B-V reaches 32 mag.
const float BV_UNKNOWN_THRESHOLD = 0.9999;
const float BV_DEFAULT = 0.65;
// sky/math/stars.ts: STAR_SIZE_*, STAR_REFERENCE_MAG, STAR_SIZE_ZOOM_MAG, WIDE_FIELD_FOV_DEG.
const float STAR_SIZE_BASE_PX = 1.0;
const float STAR_SIZE_PER_MAG = 0.55;
const float STAR_SIZE_MIN_PX = 1.0;
const float STAR_SIZE_MAX_PX = 12.0;
const float STAR_REFERENCE_MAG = 6.5;
const float STAR_SIZE_ZOOM_MAG = 3.0;
const float WIDE_FIELD_FOV_DEG = 90.0;
// sky/math/refraction.ts: Skyfield's cut and the arcminute unit of both formulas.
const float ARCMIN_TO_DEG = 0.016666666666666666;
const float MIN_REFRACTED_ALT_DEG = -1.0;
const float MAX_REFRACTED_ALT_DEG = 89.9;

// Hamilton rotation by a unit quaternion (sky/math/quaternion.ts `rotate`).
vec3 rotateByQuat(vec4 q, vec3 v) {
  vec3 t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

// Saemundsson, true altitude in degrees (refraction.ts `saemundssonRefractionDeg`; the range
// check is done once by the caller).
float saemundssonDeg(float hTrue, float factor) {
  float arg = (hTrue + 10.3 / (hTrue + 5.11)) * DEG;
  return 1.02 / tan(arg) * ARCMIN_TO_DEG * factor;
}

// Bennett, apparent altitude in degrees (refraction.ts `bennettRefractionDeg`).
float bennettDeg(float hApp, float factor) {
  if (hApp < MIN_REFRACTED_ALT_DEG || hApp > MAX_REFRACTED_ALT_DEG) {
    return 0.0;
  }
  float arg = (hApp + 7.31 / (hApp + 4.4)) * DEG;
  return 1.0 / tan(arg) * ARCMIN_TO_DEG * factor;
}

// THE forward formula (plan D73): Saemundsson seed, then two Bennett corrections.
float apparentAltitudeDeg(float hTrue, float factor) {
  if (hTrue < MIN_REFRACTED_ALT_DEG || hTrue > MAX_REFRACTED_ALT_DEG) {
    return hTrue;
  }
  float a0 = hTrue + saemundssonDeg(hTrue, factor);
  float a1 = hTrue + bennettDeg(a0, factor);
  return hTrue + bennettDeg(a1, factor);
}

// Piecewise-linear B-V -> sRGB, the stops of sky/math/stars.ts BV_COLOR_STOPS.
vec3 bvToRgb(float bv) {
  vec3 c0 = vec3(0.607843137, 0.690196078, 1.0);
  vec3 c1 = vec3(0.792156863, 0.847058824, 1.0);
  vec3 c2 = vec3(0.972549020, 0.968627451, 1.0);
  vec3 c3 = vec3(1.0, 0.956862745, 0.917647059);
  vec3 c4 = vec3(1.0, 0.823529412, 0.631372549);
  vec3 c5 = vec3(1.0, 0.8, 0.435294118);
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

void main(void) {
  // Corner of the quad from the vertex index: 0 (-1,-1), 1 (1,-1), 2 (1,1), 3 (-1,1).
  int index = gl_VertexID & 3;
  int bit0 = index & 1;
  int bit1 = (index >> 1) & 1;
  vec2 c = vec2((bit0 ^ bit1) == 1 ? 1.0 : -1.0, bit1 == 1 ? 1.0 : -1.0);
  float mag = starPhot.x * SNORM_TO_MAG;
  vCorner = c;
  if (mag > uMagLimit) {
    // Fainter than the limit: a degenerate quad outside the clip volume.
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vColor = vec4(0.0);
  } else {
    vec3 d = normalize(position + starPm * uYears);
    d = normalize(d + uAberration);
    vec3 enu = rotateByQuat(uHorizonQ, d);
    if (uRefraction.x > 0.5) {
      float alt = asin(clamp(enu.z, -1.0, 1.0)) * RAD;
      float altApp = apparentAltitudeDeg(alt, uRefraction.y);
      float ch = cos(alt * DEG);
      float scale = ch > 1e-6 ? cos(altApp * DEG) / ch : 1.0;
      enu = vec3(enu.xy * scale, sin(altApp * DEG));
    }
    vec4 clip = worldViewProjection * vec4(enu * SKY_RADIUS, 1.0);
    // stars.ts `starPixelRadius`: reference magnitude rising with the zoom on a log scale.
    float fovDeg = uFovV * RAD;
    float zoom = clamp(log(WIDE_FIELD_FOV_DEG / fovDeg) / log(WIDE_FIELD_FOV_DEG), 0.0, 1.0);
    float reference = STAR_REFERENCE_MAG + STAR_SIZE_ZOOM_MAG * zoom;
    float radiusCss = clamp(STAR_SIZE_BASE_PX + STAR_SIZE_PER_MAG * (reference - mag), STAR_SIZE_MIN_PX, STAR_SIZE_MAX_PX);
    float radiusPx = radiusCss * uMagScale.y;
    clip.xy += c * radiusPx * 2.0 / uViewport * clip.w;
    gl_Position = clip;
    float bvRaw = starPhot.y;
    float bv = bvRaw > BV_UNKNOWN_THRESHOLD ? BV_DEFAULT : bvRaw * SNORM_TO_MAG;
    // stars.ts `starBrightness(mag, uMagScale.x)`.
    float brightness = clamp(pow(10.0, -0.4 * (mag - uMagScale.x)), 0.0, 1.0);
    vColor = vec4(bvToRgb(bv), brightness);
  }
}
