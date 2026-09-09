// Deep-sky symbol fragment shader, WGSL twin of dso.fragment.glsl (SKY-3, plan D101): one
// procedural outline per type from the quad corner (vSymbol = type, minor/major ratio, on-screen
// angle of the major axis, stroke width in corner units). Galaxy: ellipse ring with the ratio and
// the angle; open cluster: dashed ring; globular cluster: ring and a plus; planetary nebula: ring
// and a centre dot; nebula: square outline; other: diamond outline. The material blends with
// ALPHA_ADD (COLOR = SRC_ALPHA * SRC + DEST): the colour is written premultiplied with alpha 1,
// faded by the daylight (vFade). Night mode (UX-3, plan D108): red luminance only.
uniform uNight : vec2<f32>;

varying vCorner : vec2<f32>;
varying vSymbol : vec4<f32>;
varying vFade : f32;

const GALAXY_COLOR : vec3<f32> = vec3<f32>(0.95, 0.72, 0.78);
const CLUSTER_COLOR : vec3<f32> = vec3<f32>(0.98, 0.92, 0.55);
const PLANETARY_COLOR : vec3<f32> = vec3<f32>(0.55, 0.92, 0.88);
const NEBULA_COLOR : vec3<f32> = vec3<f32>(0.6, 0.88, 0.6);
const OTHER_COLOR : vec3<f32> = vec3<f32>(0.8, 0.8, 0.85);
const LUMA : vec3<f32> = vec3<f32>(0.2126, 0.7152, 0.0722);
const TWO_PI : f32 = 6.283185307179586;
// The outline sits at this fraction of the quad so the stroke stays inside it.
const RING_R : f32 = 0.85;
const DASHES : f32 = 8.0;

// Anti-aliased stroke around the unit contour: `r` is the contour coordinate (1 on the line),
// `lw` the stroke width in the same units.
fn stroke(r : f32, lw : f32) -> f32 {
  return 1.0 - smoothstep(lw * 0.5, lw * 1.5, abs(r - 1.0));
}

// A bar of half length 0.55 and stroke `lw` along one axis (`a` across, `b` along).
fn bar(a : f32, b : f32, lw : f32) -> f32 {
  let across = 1.0 - smoothstep(lw * 0.5, lw * 1.5, abs(a));
  let along = 1.0 - smoothstep(0.5, 0.5 + lw, abs(b));
  return across * along;
}

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  let symbolType = fragmentInputs.vSymbol.x;
  let ratio = max(fragmentInputs.vSymbol.y, 0.05);
  let pa = fragmentInputs.vSymbol.z;
  let lw = max(fragmentInputs.vSymbol.w, 0.02);
  let c = fragmentInputs.vCorner;
  var coverage = 0.0;
  var color = OTHER_COLOR;
  if (symbolType < 0.5) {
    // Galaxy: the corner in the major/minor axis frame, then an ellipse ring.
    let cs = cos(pa);
    let sn = sin(pa);
    let u = c.x * cs + c.y * sn;
    let v = -c.x * sn + c.y * cs;
    let r = sqrt(u * u + (v * v) / (ratio * ratio)) / RING_R;
    coverage = stroke(r, lw);
    color = GALAXY_COLOR;
  } else if (symbolType < 1.5) {
    // Open cluster: a dashed ring.
    let r = length(c) / RING_R;
    let angle = atan2(c.y, c.x);
    let dash = step(0.5, fract(angle * DASHES / TWO_PI));
    coverage = stroke(r, lw) * dash;
    color = CLUSTER_COLOR;
  } else if (symbolType < 2.5) {
    // Globular cluster: a ring and a plus.
    let r = length(c) / RING_R;
    coverage = max(stroke(r, lw), max(bar(c.x, c.y, lw), bar(c.y, c.x, lw)));
    color = CLUSTER_COLOR;
  } else if (symbolType < 3.5) {
    // Planetary nebula: a ring and a centre dot.
    let r = length(c) / RING_R;
    let centre = 1.0 - smoothstep(0.15, 0.15 + lw, length(c));
    coverage = max(stroke(r, lw), centre);
    color = PLANETARY_COLOR;
  } else if (symbolType < 4.5) {
    // Nebula: a square outline.
    let r = max(abs(c.x), abs(c.y)) / RING_R;
    coverage = stroke(r, lw);
    color = NEBULA_COLOR;
  } else {
    // Other: a diamond outline.
    let r = (abs(c.x) + abs(c.y)) / RING_R;
    coverage = stroke(r, lw);
    color = OTHER_COLOR;
  }
  if (coverage <= 0.003) {
    discard;
  }
  var rgb = color * coverage * fragmentInputs.vFade;
  if (uniforms.uNight.x > 0.5) {
    rgb = vec3<f32>(dot(rgb, LUMA), 0.0, 0.0) * uniforms.uNight.y;
  }
  fragmentOutputs.color = vec4<f32>(rgb, 1.0);
}
