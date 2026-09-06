// Body fragment shader, WGSL twin of bodies.fragment.glsl (plan D83, SKY-2): a disc with an
// anti-aliased rim, phase shading from the sphere normal against `bodySun` for the Moon and the
// planets (lit = smoothstep(-0.05, 0.05, n . sun)), the Sun fully lit, and an additive glare
// quad exp(-3 r^2). The material blends premultiplied (SRC + (1 - SRC_ALPHA) * DEST): the disc
// writes (rgb * a, a), the glare writes (rgb, 0) and therefore adds.
varying vCorner : vec2<f32>;
varying vParams : vec4<f32>;
varying vSun : vec3<f32>;

const SUN_COLOR : vec3<f32> = vec3<f32>(1.0, 0.98, 0.92);
const MOON_COLOR : vec3<f32> = vec3<f32>(0.86, 0.86, 0.84);
const PLANET_COLOR : vec3<f32> = vec3<f32>(1.0, 0.97, 0.92);
const GLARE_STRENGTH : f32 = 0.6;
// The night side keeps a faint glow so a thin crescent still reads as a disc.
const DARK_SIDE : f32 = 0.06;

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  let r2 = dot(fragmentInputs.vCorner, fragmentInputs.vCorner);
  if (r2 > 1.0) {
    discard;
  }
  let cls = fragmentInputs.vParams.w;
  if (cls > 2.5) {
    let g = exp(-3.0 * r2) * GLARE_STRENGTH;
    fragmentOutputs.color = vec4<f32>(SUN_COLOR * g, 0.0);
  } else {
    let edge = 1.0 - smoothstep(0.7, 1.0, r2);
    let base = select(select(PLANET_COLOR, MOON_COLOR, cls < 1.5), SUN_COLOR, cls < 0.5);
    var lit = 1.0;
    if (cls > 0.5) {
      let n = vec3<f32>(fragmentInputs.vCorner, sqrt(max(0.0, 1.0 - r2)));
      lit = smoothstep(-0.05, 0.05, dot(n, fragmentInputs.vSun));
    }
    let shade = DARK_SIDE + (1.0 - DARK_SIDE) * lit;
    // Faint bodies dim a little; the -99 sentinel of an unknown magnitude clamps to full.
    let bright = clamp(pow(10.0, -0.4 * (fragmentInputs.vParams.y - 1.0)), 0.3, 1.0);
    let color = base * shade * bright;
    fragmentOutputs.color = vec4<f32>(color * edge, edge);
  }
}
