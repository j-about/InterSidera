// Deep-sky symbol fragment shader, GLSL twin of dso.fragment.wgsl (SKY-3, plan D101): one
// procedural outline per type from the quad corner (vSymbol = type, minor/major ratio, on-screen
// angle of the major axis, stroke width in corner units). Galaxy: ellipse ring with the ratio and
// the angle; open cluster: dashed ring; globular cluster: ring and a plus; planetary nebula: ring
// and a centre dot; nebula: square outline; other: diamond outline. The material blends with
// ALPHA_ADD (COLOR = SRC_ALPHA * SRC + DEST): the colour is written premultiplied with alpha 1,
// faded by the daylight (vFade). Night mode (UX-3, plan D108): red luminance only.
precision highp float;

uniform vec2 uNight;

varying vec2 vCorner;
varying vec4 vSymbol;
varying float vFade;

const vec3 GALAXY_COLOR = vec3(0.95, 0.72, 0.78);
const vec3 CLUSTER_COLOR = vec3(0.98, 0.92, 0.55);
const vec3 PLANETARY_COLOR = vec3(0.55, 0.92, 0.88);
const vec3 NEBULA_COLOR = vec3(0.6, 0.88, 0.6);
const vec3 OTHER_COLOR = vec3(0.8, 0.8, 0.85);
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
const float TWO_PI = 6.283185307179586;
// The outline sits at this fraction of the quad so the stroke stays inside it.
const float RING_R = 0.85;
const float DASHES = 8.0;

// Anti-aliased stroke around the unit contour: `r` is the contour coordinate (1 on the line),
// `lw` the stroke width in the same units.
float stroke(float r, float lw) {
  return 1.0 - smoothstep(lw * 0.5, lw * 1.5, abs(r - 1.0));
}

// A bar of half length 0.55 and stroke `lw` along one axis (`a` across, `b` along).
float bar(float a, float b, float lw) {
  float across = 1.0 - smoothstep(lw * 0.5, lw * 1.5, abs(a));
  float along = 1.0 - smoothstep(0.5, 0.5 + lw, abs(b));
  return across * along;
}

void main(void) {
  float symbolType = vSymbol.x;
  float ratio = max(vSymbol.y, 0.05);
  float pa = vSymbol.z;
  float lw = max(vSymbol.w, 0.02);
  vec2 c = vCorner;
  float coverage;
  vec3 color;
  if (symbolType < 0.5) {
    // Galaxy: the corner in the major/minor axis frame, then an ellipse ring.
    float cs = cos(pa);
    float sn = sin(pa);
    float u = c.x * cs + c.y * sn;
    float v = -c.x * sn + c.y * cs;
    float r = sqrt(u * u + (v * v) / (ratio * ratio)) / RING_R;
    coverage = stroke(r, lw);
    color = GALAXY_COLOR;
  } else if (symbolType < 1.5) {
    // Open cluster: a dashed ring.
    float r = length(c) / RING_R;
    float angle = atan(c.y, c.x);
    float dash = step(0.5, fract(angle * DASHES / TWO_PI));
    coverage = stroke(r, lw) * dash;
    color = CLUSTER_COLOR;
  } else if (symbolType < 2.5) {
    // Globular cluster: a ring and a plus.
    float r = length(c) / RING_R;
    coverage = max(stroke(r, lw), max(bar(c.x, c.y, lw), bar(c.y, c.x, lw)));
    color = CLUSTER_COLOR;
  } else if (symbolType < 3.5) {
    // Planetary nebula: a ring and a centre dot.
    float r = length(c) / RING_R;
    float dot_ = 1.0 - smoothstep(0.15, 0.15 + lw, length(c));
    coverage = max(stroke(r, lw), dot_);
    color = PLANETARY_COLOR;
  } else if (symbolType < 4.5) {
    // Nebula: a square outline.
    float r = max(abs(c.x), abs(c.y)) / RING_R;
    coverage = stroke(r, lw);
    color = NEBULA_COLOR;
  } else {
    // Other: a diamond outline.
    float r = (abs(c.x) + abs(c.y)) / RING_R;
    coverage = stroke(r, lw);
    color = OTHER_COLOR;
  }
  if (coverage <= 0.003) {
    discard;
  }
  vec3 rgb = color * coverage * vFade;
  if (uNight.x > 0.5) {
    rgb = vec3(dot(rgb, LUMA), 0.0, 0.0) * uNight.y;
  }
  gl_FragColor = vec4(rgb, 1.0);
}
