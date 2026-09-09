// Deep-sky object vertex shader, GLSL twin of dso.vertex.wgsl (WebGL2; SKY-3, plan D101, brief
// l.88). One quad of four vertices per object, corners from the vertex index. Attributes:
// `position` = ICRS unit vector (sky/math/frames.ts `dirFromRaDec`), `dsoShape` = (magnitude or
// 99, major semi-axis rad, minor/major ratio or 1, position angle rad or 0), `dsoType` = symbol
// class 0..5 (sky/math/dso.ts `symbolIdOf`). Same rule as the star shader for the direction:
// first-order aberration (brief l.41 (d), catalog directions), the horizon rotation, optional D73
// refraction mirrored line by line from sky/math/refraction.ts. Visibility (dso.ts `dsoVisible`):
// mag <= limit - 8 B or major semi-axis >= size limit, and the type flag of uTypeOnA (galaxy,
// open cluster, globular cluster) / uTypeOnB (planetary nebula, nebula, other) set. The symbol
// radius is dso.ts `dsoPixelRadius`; the on-screen angle of the major axis is dso.ts
// `screenPositionAngle` from apparent.ts `billboardBasis` and dso.ts `northTangent`. GLSL
// comments are not stripped before Babylon's conversion pass: no preprocessor token appears here.
precision highp float;
precision highp int;

attribute vec3 position;
attribute vec4 dsoShape;
attribute float dsoType;

uniform mat4 worldViewProjection;
uniform vec4 uHorizonQ;
uniform vec3 uAberration;
uniform vec2 uRefraction;
uniform vec2 uViewport;
uniform float uFovV;
uniform vec4 uDsoLimits;
uniform vec3 uTypeOnA;
uniform vec3 uTypeOnB;
uniform vec3 uCameraRight;
uniform float uAtmosphere;

varying vec2 vCorner;
varying vec4 vSymbol;
varying float vFade;

const float DEG = 0.017453292519943295;
const float RAD = 57.29577951308232;
// Celestial sphere radius in Babylon units (sky/math/frames.ts SKY_RADIUS, brief l.59).
const float SKY_RADIUS = 1000.0;
// sky/math/refraction.ts: Skyfield's cut and the arcminute unit of both formulas.
const float ARCMIN_TO_DEG = 0.016666666666666666;
const float MIN_REFRACTED_ALT_DEG = -1.0;
const float MAX_REFRACTED_ALT_DEG = 89.9;
// sky/math/atmosphere.ts: STAR_FADE_MAGNITUDES, STAR_FADE_BRIGHTNESS.
const float STAR_FADE_MAGNITUDES = 8.0;
const float STAR_FADE_BRIGHTNESS = 0.85;
// apparent.ts BILLBOARD_EPSILON and the tangent epsilon of dso.ts northTangent.
const float BASIS_EPSILON = 1e-12;

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

// The type flag of a symbol class: uTypeOnA = (galaxy, open, globular), uTypeOnB = (planetary,
// nebula, other), 0 or 1 each (plan Q47: two vec3 flags, no integer uniform).
float typeFlag(float symbolType) {
  if (symbolType < 0.5) {
    return uTypeOnA.x;
  }
  if (symbolType < 1.5) {
    return uTypeOnA.y;
  }
  if (symbolType < 2.5) {
    return uTypeOnA.z;
  }
  if (symbolType < 3.5) {
    return uTypeOnB.x;
  }
  if (symbolType < 4.5) {
    return uTypeOnB.y;
  }
  return uTypeOnB.z;
}

void main(void) {
  // Corner of the quad from the vertex index: 0 (-1,-1), 1 (1,-1), 2 (1,1), 3 (-1,1).
  int index = gl_VertexID & 3;
  int bit0 = index & 1;
  int bit1 = (index >> 1) & 1;
  vec2 c = vec2((bit0 ^ bit1) == 1 ? 1.0 : -1.0, bit1 == 1 ? 1.0 : -1.0);
  vCorner = c;
  float mag = dsoShape.x;
  float major = dsoShape.y;
  // uDsoLimits = (magnitude limit, size limit as a semi-axis in rad, min radius px, line width px).
  float magLimitEff = uDsoLimits.x - STAR_FADE_MAGNITUDES * uAtmosphere;
  bool shown = typeFlag(dsoType) > 0.5 && (mag <= magLimitEff || major >= uDsoLimits.y);
  if (!shown) {
    // Filtered out: a degenerate quad outside the clip volume.
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vSymbol = vec4(0.0);
    vFade = 0.0;
  } else {
    vec3 d = normalize(position + uAberration);
    vec3 enu = rotateByQuat(uHorizonQ, d);
    if (uRefraction.x > 0.5) {
      float alt = asin(clamp(enu.z, -1.0, 1.0)) * RAD;
      float altApp = apparentAltitudeDeg(alt, uRefraction.y);
      float ch = cos(alt * DEG);
      float scale = ch > 1e-6 ? cos(altApp * DEG) / ch : 1.0;
      enu = vec3(enu.xy * scale, sin(altApp * DEG));
    }
    vec4 clip = worldViewProjection * vec4(enu * SKY_RADIUS, 1.0);
    // dso.ts `dsoPixelRadius`: the true semi-axis on screen or the minimum radius.
    float radiusPx = max(uDsoLimits.z, tan(major) / tan(uFovV * 0.5) * uViewport.y * 0.5);
    clip.xy += c * radiusPx * 2.0 / uViewport * clip.w;
    gl_Position = clip;
    // dso.ts `northTangent`: toward the ICRF pole in the tangent plane, rotated into ENU.
    vec3 nt = vec3(0.0, 0.0, 1.0) - d.z * d;
    float ntLen2 = dot(nt, nt);
    nt = ntLen2 > BASIS_EPSILON ? nt / sqrt(ntLen2) : vec3(1.0, 0.0, 0.0);
    vec3 nEnu = rotateByQuat(uHorizonQ, nt);
    // apparent.ts `billboardBasis` at the object's image.
    vec3 right = uCameraRight - dot(uCameraRight, enu) * enu;
    float rl2 = dot(right, right);
    if (rl2 < BASIS_EPSILON) {
      right = cross(enu, vec3(0.0, 0.0, 1.0));
    }
    right = normalize(right);
    vec3 up = cross(-enu, right);
    // dso.ts `screenPositionAngle`: north on screen plus the position angle.
    float screenPa = atan(dot(nEnu, up), dot(nEnu, right)) + dsoShape.w;
    vSymbol = vec4(dsoType, dsoShape.z, screenPa, uDsoLimits.w / radiusPx);
    vFade = 1.0 - STAR_FADE_BRIGHTNESS * uAtmosphere;
  }
}
