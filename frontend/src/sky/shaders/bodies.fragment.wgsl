// Body fragment shader, WGSL twin of bodies.fragment.glsl (plan D83, SKY-2): a disc with an
// anti-aliased rim, phase shading from the sphere normal against `bodySun` for the Moon and the
// planets (lit = smoothstep(-0.05, 0.05, n . sun)), the Sun fully lit, and an additive glare
// quad exp(-3 r^2). The material blends premultiplied (SRC + (1 - SRC_ALPHA) * DEST): the disc
// writes (rgb * a, a), the glare writes (rgb, 0) and therefore adds. Minor bodies (plan D102):
// class 4 is a flat disc, class 5 an additive comet tail fading along the strip. Night mode
// (UX-3, plan D108): uNight = (on, level) keeps the luminance in the red channel alone.
uniform uNight : vec2<f32>;

varying vCorner : vec2<f32>;
varying vParams : vec4<f32>;
varying vSun : vec3<f32>;

const SUN_COLOR : vec3<f32> = vec3<f32>(1.0, 0.98, 0.92);
const MOON_COLOR : vec3<f32> = vec3<f32>(0.86, 0.86, 0.84);
const PLANET_COLOR : vec3<f32> = vec3<f32>(1.0, 0.97, 0.92);
const MINOR_COLOR : vec3<f32> = vec3<f32>(0.85, 0.88, 0.92);
const TAIL_COLOR : vec3<f32> = vec3<f32>(0.55, 0.75, 0.95);
const GLARE_STRENGTH : f32 = 0.6;
const TAIL_STRENGTH : f32 = 0.45;
// The night side keeps a faint glow so a thin crescent still reads as a disc.
const DARK_SIDE : f32 = 0.06;
const LUMA : vec3<f32> = vec3<f32>(0.2126, 0.7152, 0.0722);

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  let cls = fragmentInputs.vParams.w;
  var rgb = vec3<f32>(0.0, 0.0, 0.0);
  var a = 0.0;
  if (cls > 4.5) {
    // Comet tail: vCorner = (fraction along the strip, across in -1..1); additive like the glare.
    let along = clamp(fragmentInputs.vCorner.x, 0.0, 1.0);
    let across = 1.0 - smoothstep(0.3, 1.0, abs(fragmentInputs.vCorner.y));
    let g = (1.0 - along) * (1.0 - along) * across * TAIL_STRENGTH;
    rgb = TAIL_COLOR * g;
    a = 0.0;
  } else {
    let r2 = dot(fragmentInputs.vCorner, fragmentInputs.vCorner);
    if (r2 > 1.0) {
      discard;
    }
    if (cls > 2.5 && cls < 3.5) {
      let g = exp(-3.0 * r2) * GLARE_STRENGTH;
      rgb = SUN_COLOR * g;
      a = 0.0;
    } else {
      let edge = 1.0 - smoothstep(0.7, 1.0, r2);
      // Faint bodies dim a little; the -99 sentinel of an unknown magnitude clamps to full.
      let bright = clamp(pow(10.0, -0.4 * (fragmentInputs.vParams.y - 1.0)), 0.3, 1.0);
      if (cls > 3.5) {
        // Minor-body disc: flat, no phase.
        rgb = MINOR_COLOR * bright * edge;
      } else {
        let base = select(select(PLANET_COLOR, MOON_COLOR, cls < 1.5), SUN_COLOR, cls < 0.5);
        var lit = 1.0;
        if (cls > 0.5) {
          let n = vec3<f32>(fragmentInputs.vCorner, sqrt(max(0.0, 1.0 - r2)));
          lit = smoothstep(-0.05, 0.05, dot(n, fragmentInputs.vSun));
        }
        let shade = DARK_SIDE + (1.0 - DARK_SIDE) * lit;
        rgb = base * shade * bright * edge;
      }
      a = edge;
    }
  }
  if (uniforms.uNight.x > 0.5) {
    rgb = vec3<f32>(dot(rgb, LUMA), 0.0, 0.0) * uniforms.uNight.y;
  }
  fragmentOutputs.color = vec4<f32>(rgb, a);
}
