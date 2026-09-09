// Background fragment shader, GLSL twin of background.fragment.wgsl (SKY-6/SKY-7, plan D104).
// The pixel direction is rebuilt in ENU from the camera basis (frames.ts `cameraBasis`:
// uCamForward, uCamRight, uCamUp) and uProj = (tan(fov / 2), aspect), the pure twin of
// `screenToDirection`. Mode 0 paints the sky: sky/math/atmosphere.ts `skyColor` mirrored line by
// line (`skyBrightness`, `twilight`, the daylight gradient and the twilight tint toward the
// Sun's azimuth), black below -3 degrees. Mode 1 paints the ground below the horizon with the
// SKY-6 opacity, a 0.3 degree soft edge. uSky = (Sun altitude deg, ground alpha, 0, 0); uSunEnu
// is the Sun direction in ENU. Night mode (UX-3, plan D108): red luminance only. The material
// blends ALPHA_COMBINE, so a sky pixel (alpha 1) replaces the clear colour and the ground pixel
// covers everything drawn before it in proportion to its alpha.
precision highp float;

uniform float uMode;
uniform vec3 uCamForward;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec2 uProj;
uniform vec3 uSunEnu;
uniform vec4 uSky;
uniform vec2 uNight;

varying vec2 vNdc;

const float RAD = 57.29577951308232;
// sky/math/atmosphere.ts constants.
const float CIVIL_TWILIGHT_DEG = -6.0;
const float NAUTICAL_TWILIGHT_DEG = -12.0;
const float ASTRONOMICAL_TWILIGHT_DEG = -18.0;
const float CIVIL_END_BRIGHTNESS = 0.3;
const float NAUTICAL_END_BRIGHTNESS = 0.05;
const float TWILIGHT_PEAK_DEG = -3.0;
const float TWILIGHT_WIDTH_DEG = 5.0;
const float SKY_BLACK_BELOW_DEG = -3.0;
const vec3 HORIZON_DAY = vec3(0.62, 0.76, 0.92);
const vec3 ZENITH_DAY = vec3(0.16, 0.36, 0.78);
const vec3 TWILIGHT_TINT = vec3(1.0, 0.5, 0.2);
const float TWILIGHT_TINT_STRENGTH = 0.8;
const float TWILIGHT_ALT_SCALE_DEG = 12.0;
const float TWILIGHT_AZ_SCALE_DEG = 60.0;
const float GRADIENT_POWER = 0.6;
const vec3 GROUND_COLOR = vec3(0.09, 0.08, 0.07);
// The ground edge softens over this many degrees below the horizon.
const float GROUND_EDGE_DEG = 0.3;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// atmosphere.ts `skyBrightness`.
float skyBrightness(float s) {
  if (s >= 0.0) {
    return 1.0;
  }
  if (s >= CIVIL_TWILIGHT_DEG) {
    return mix(CIVIL_END_BRIGHTNESS, 1.0, (s - CIVIL_TWILIGHT_DEG) / -CIVIL_TWILIGHT_DEG);
  }
  if (s >= NAUTICAL_TWILIGHT_DEG) {
    return mix(NAUTICAL_END_BRIGHTNESS, CIVIL_END_BRIGHTNESS, (s - NAUTICAL_TWILIGHT_DEG) / (CIVIL_TWILIGHT_DEG - NAUTICAL_TWILIGHT_DEG));
  }
  if (s >= ASTRONOMICAL_TWILIGHT_DEG) {
    return mix(0.0, NAUTICAL_END_BRIGHTNESS, (s - ASTRONOMICAL_TWILIGHT_DEG) / (NAUTICAL_TWILIGHT_DEG - ASTRONOMICAL_TWILIGHT_DEG));
  }
  return 0.0;
}

// atmosphere.ts `twilight`.
float twilight(float s) {
  float u = (s - TWILIGHT_PEAK_DEG) / TWILIGHT_WIDTH_DEG;
  return exp(-u * u);
}

// atmosphere.ts `wrapDeltaDeg`.
float wrapDeltaDeg(float d) {
  return d - 360.0 * floor((d + 180.0) / 360.0);
}

// atmosphere.ts `skyColor`.
vec3 skyColor(float alt, float dAz, float s) {
  if (alt < SKY_BLACK_BELOW_DEG) {
    return vec3(0.0);
  }
  float brightness = skyBrightness(s);
  float t = pow(clamp(alt / 90.0, 0.0, 1.0), GRADIENT_POWER);
  float a = wrapDeltaDeg(dAz) / TWILIGHT_AZ_SCALE_DEG;
  float tint = twilight(s) * exp(-max(alt, 0.0) / TWILIGHT_ALT_SCALE_DEG) * exp(-a * a) * TWILIGHT_TINT_STRENGTH;
  return mix(HORIZON_DAY, ZENITH_DAY, t) * brightness + TWILIGHT_TINT * tint;
}

void main(void) {
  // frames.ts `screenToDirection`: forward + x tan(fov/2) aspect right + y tan(fov/2) up.
  vec3 dir = normalize(uCamForward + vNdc.x * uProj.x * uProj.y * uCamRight + vNdc.y * uProj.x * uCamUp);
  float alt = asin(clamp(dir.z, -1.0, 1.0)) * RAD;
  vec3 rgb;
  float a;
  if (uMode < 0.5) {
    float az = atan(dir.x, dir.y) * RAD;
    float sunAz = atan(uSunEnu.x, uSunEnu.y) * RAD;
    rgb = skyColor(alt, az - sunAz, uSky.x);
    a = 1.0;
  } else {
    float edge = 1.0 - smoothstep(-GROUND_EDGE_DEG, 0.0, alt);
    a = uSky.y * edge;
    if (a <= 0.002) {
      discard;
    }
    rgb = GROUND_COLOR;
  }
  if (uNight.x > 0.5) {
    rgb = vec3(dot(rgb, LUMA), 0.0, 0.0) * uNight.y;
  }
  gl_FragColor = vec4(rgb, a);
}
