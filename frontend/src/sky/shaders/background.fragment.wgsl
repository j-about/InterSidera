// Background fragment shader, WGSL twin of background.fragment.glsl (SKY-6/SKY-7, plan D104).
// The pixel direction is rebuilt in ENU from the camera basis (frames.ts `cameraBasis`:
// uCamForward, uCamRight, uCamUp) and uProj = (tan(fov / 2), aspect), the pure twin of
// `screenToDirection`. Mode 0 paints the sky: sky/math/atmosphere.ts `skyColor` mirrored line by
// line (`skyBrightness`, `twilight`, the daylight gradient and the twilight tint toward the
// Sun's azimuth), black below -3 degrees. Mode 1 paints the ground below the horizon with the
// SKY-6 opacity, a 0.3 degree soft edge. uSky = (Sun altitude deg, ground alpha, 0, 0); uSunEnu
// is the Sun direction in ENU. Night mode (UX-3, plan D108): red luminance only. The material
// blends ALPHA_COMBINE, so a sky pixel (alpha 1) replaces the clear colour and the ground pixel
// covers everything drawn before it in proportion to its alpha. `main` stays the last function.
uniform uMode : f32;
uniform uCamForward : vec3<f32>;
uniform uCamRight : vec3<f32>;
uniform uCamUp : vec3<f32>;
uniform uProj : vec2<f32>;
uniform uSunEnu : vec3<f32>;
uniform uSky : vec4<f32>;
uniform uNight : vec2<f32>;

varying vNdc : vec2<f32>;

const RAD : f32 = 57.29577951308232;
// sky/math/atmosphere.ts constants.
const CIVIL_TWILIGHT_DEG : f32 = -6.0;
const NAUTICAL_TWILIGHT_DEG : f32 = -12.0;
const ASTRONOMICAL_TWILIGHT_DEG : f32 = -18.0;
const CIVIL_END_BRIGHTNESS : f32 = 0.3;
const NAUTICAL_END_BRIGHTNESS : f32 = 0.05;
const TWILIGHT_PEAK_DEG : f32 = -3.0;
const TWILIGHT_WIDTH_DEG : f32 = 5.0;
const SKY_BLACK_BELOW_DEG : f32 = -3.0;
const HORIZON_DAY : vec3<f32> = vec3<f32>(0.62, 0.76, 0.92);
const ZENITH_DAY : vec3<f32> = vec3<f32>(0.16, 0.36, 0.78);
const TWILIGHT_TINT : vec3<f32> = vec3<f32>(1.0, 0.5, 0.2);
const TWILIGHT_TINT_STRENGTH : f32 = 0.8;
const TWILIGHT_ALT_SCALE_DEG : f32 = 12.0;
const TWILIGHT_AZ_SCALE_DEG : f32 = 60.0;
const GRADIENT_POWER : f32 = 0.6;
const GROUND_COLOR : vec3<f32> = vec3<f32>(0.09, 0.08, 0.07);
// The ground edge softens over this many degrees below the horizon.
const GROUND_EDGE_DEG : f32 = 0.3;
const LUMA : vec3<f32> = vec3<f32>(0.2126, 0.7152, 0.0722);

// atmosphere.ts `skyBrightness`.
fn skyBrightness(s : f32) -> f32 {
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
fn twilight(s : f32) -> f32 {
  let u = (s - TWILIGHT_PEAK_DEG) / TWILIGHT_WIDTH_DEG;
  return exp(-u * u);
}

// atmosphere.ts `wrapDeltaDeg`.
fn wrapDeltaDeg(d : f32) -> f32 {
  return d - 360.0 * floor((d + 180.0) / 360.0);
}

// atmosphere.ts `skyColor`.
fn skyColor(alt : f32, dAz : f32, s : f32) -> vec3<f32> {
  if (alt < SKY_BLACK_BELOW_DEG) {
    return vec3<f32>(0.0);
  }
  let brightness = skyBrightness(s);
  let t = pow(clamp(alt / 90.0, 0.0, 1.0), GRADIENT_POWER);
  let a = wrapDeltaDeg(dAz) / TWILIGHT_AZ_SCALE_DEG;
  let tint = twilight(s) * exp(-max(alt, 0.0) / TWILIGHT_ALT_SCALE_DEG) * exp(-a * a) * TWILIGHT_TINT_STRENGTH;
  return mix(HORIZON_DAY, ZENITH_DAY, vec3<f32>(t)) * brightness + TWILIGHT_TINT * tint;
}

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  // frames.ts `screenToDirection`: forward + x tan(fov/2) aspect right + y tan(fov/2) up.
  let ndc = fragmentInputs.vNdc;
  let dir = normalize(uniforms.uCamForward + ndc.x * uniforms.uProj.x * uniforms.uProj.y * uniforms.uCamRight + ndc.y * uniforms.uProj.x * uniforms.uCamUp);
  let alt = asin(clamp(dir.z, -1.0, 1.0)) * RAD;
  var rgb = vec3<f32>(0.0, 0.0, 0.0);
  var a = 1.0;
  if (uniforms.uMode < 0.5) {
    let az = atan2(dir.x, dir.y) * RAD;
    let sunAz = atan2(uniforms.uSunEnu.x, uniforms.uSunEnu.y) * RAD;
    rgb = skyColor(alt, az - sunAz, uniforms.uSky.x);
    a = 1.0;
  } else {
    let edge = 1.0 - smoothstep(-GROUND_EDGE_DEG, 0.0, alt);
    a = uniforms.uSky.y * edge;
    if (a <= 0.002) {
      discard;
    }
    rgb = GROUND_COLOR;
  }
  if (uniforms.uNight.x > 0.5) {
    rgb = vec3<f32>(dot(rgb, LUMA), 0.0, 0.0) * uniforms.uNight.y;
  }
  fragmentOutputs.color = vec4<f32>(rgb, a);
}
