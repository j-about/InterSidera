// Body fragment shader, GLSL twin of bodies.fragment.wgsl (plan D83, SKY-2): a disc with an
// anti-aliased rim, phase shading from the sphere normal against `bodySun` for the Moon and the
// planets (lit = smoothstep(-0.05, 0.05, n . sun)), the Sun fully lit, and an additive glare
// quad exp(-3 r^2). The material blends premultiplied (SRC + (1 - SRC_ALPHA) * DEST): the disc
// writes (rgb * a, a), the glare writes (rgb, 0) and therefore adds.
precision highp float;

varying vec2 vCorner;
varying vec4 vParams;
varying vec3 vSun;

const vec3 SUN_COLOR = vec3(1.0, 0.98, 0.92);
const vec3 MOON_COLOR = vec3(0.86, 0.86, 0.84);
const vec3 PLANET_COLOR = vec3(1.0, 0.97, 0.92);
const float GLARE_STRENGTH = 0.6;
// The night side keeps a faint glow so a thin crescent still reads as a disc.
const float DARK_SIDE = 0.06;

void main(void) {
  float r2 = dot(vCorner, vCorner);
  if (r2 > 1.0) {
    discard;
  }
  float cls = vParams.w;
  if (cls > 2.5) {
    float g = exp(-3.0 * r2) * GLARE_STRENGTH;
    gl_FragColor = vec4(SUN_COLOR * g, 0.0);
  } else {
    float edge = 1.0 - smoothstep(0.7, 1.0, r2);
    vec3 base = cls < 0.5 ? SUN_COLOR : (cls < 1.5 ? MOON_COLOR : PLANET_COLOR);
    float lit = 1.0;
    if (cls > 0.5) {
      vec3 n = vec3(vCorner, sqrt(max(0.0, 1.0 - r2)));
      lit = smoothstep(-0.05, 0.05, dot(n, vSun));
    }
    float shade = DARK_SIDE + (1.0 - DARK_SIDE) * lit;
    // Faint bodies dim a little; the -99 sentinel of an unknown magnitude clamps to full.
    float bright = clamp(pow(10.0, -0.4 * (vParams.y - 1.0)), 0.3, 1.0);
    vec3 color = base * shade * bright;
    gl_FragColor = vec4(color * edge, edge);
  }
}
