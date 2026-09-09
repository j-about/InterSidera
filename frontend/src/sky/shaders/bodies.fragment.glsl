// Body fragment shader, GLSL twin of bodies.fragment.wgsl (plan D83, SKY-2): a disc with an
// anti-aliased rim, phase shading from the sphere normal against `bodySun` for the Moon and the
// planets (lit = smoothstep(-0.05, 0.05, n . sun)), the Sun fully lit, and an additive glare
// quad exp(-3 r^2). The material blends premultiplied (SRC + (1 - SRC_ALPHA) * DEST): the disc
// writes (rgb * a, a), the glare writes (rgb, 0) and therefore adds. Minor bodies (plan D102):
// class 4 is a flat disc, class 5 an additive comet tail fading along the strip. Night mode
// (UX-3, plan D108): uNight = (on, level) keeps the luminance in the red channel alone.
precision highp float;

uniform vec2 uNight;

varying vec2 vCorner;
varying vec4 vParams;
varying vec3 vSun;

const vec3 SUN_COLOR = vec3(1.0, 0.98, 0.92);
const vec3 MOON_COLOR = vec3(0.86, 0.86, 0.84);
const vec3 PLANET_COLOR = vec3(1.0, 0.97, 0.92);
const vec3 MINOR_COLOR = vec3(0.85, 0.88, 0.92);
const vec3 TAIL_COLOR = vec3(0.55, 0.75, 0.95);
const float GLARE_STRENGTH = 0.6;
const float TAIL_STRENGTH = 0.45;
// The night side keeps a faint glow so a thin crescent still reads as a disc.
const float DARK_SIDE = 0.06;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

void main(void) {
  float cls = vParams.w;
  vec3 rgb;
  float a;
  if (cls > 4.5) {
    // Comet tail: vCorner = (fraction along the strip, across in -1..1); additive like the glare.
    float along = clamp(vCorner.x, 0.0, 1.0);
    float across = 1.0 - smoothstep(0.3, 1.0, abs(vCorner.y));
    float g = (1.0 - along) * (1.0 - along) * across * TAIL_STRENGTH;
    rgb = TAIL_COLOR * g;
    a = 0.0;
  } else {
    float r2 = dot(vCorner, vCorner);
    if (r2 > 1.0) {
      discard;
    }
    if (cls > 2.5 && cls < 3.5) {
      float g = exp(-3.0 * r2) * GLARE_STRENGTH;
      rgb = SUN_COLOR * g;
      a = 0.0;
    } else {
      float edge = 1.0 - smoothstep(0.7, 1.0, r2);
      // Faint bodies dim a little; the -99 sentinel of an unknown magnitude clamps to full.
      float bright = clamp(pow(10.0, -0.4 * (vParams.y - 1.0)), 0.3, 1.0);
      if (cls > 3.5) {
        // Minor-body disc: flat, no phase.
        rgb = MINOR_COLOR * bright * edge;
      } else {
        vec3 base = cls < 0.5 ? SUN_COLOR : (cls < 1.5 ? MOON_COLOR : PLANET_COLOR);
        float lit = 1.0;
        if (cls > 0.5) {
          vec3 n = vec3(vCorner, sqrt(max(0.0, 1.0 - r2)));
          lit = smoothstep(-0.05, 0.05, dot(n, vSun));
        }
        float shade = DARK_SIDE + (1.0 - DARK_SIDE) * lit;
        rgb = base * shade * bright * edge;
      }
      a = edge;
    }
  }
  if (uNight.x > 0.5) {
    rgb = vec3(dot(rgb, LUMA), 0.0, 0.0) * uNight.y;
  }
  gl_FragColor = vec4(rgb, a);
}
