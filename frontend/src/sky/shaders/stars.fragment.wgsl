// Star fragment shader, WGSL twin of stars.fragment.glsl (plan D82): a soft disc exp(-4 r^2)
// discarded outside the unit circle. The material blends with ALPHA_ADD (Babylon:
// COLOR = SRC_ALPHA * SRC + DEST), so the colour is written premultiplied with alpha 1.
// Night mode (UX-3, plan D108): uNight = (on, level) keeps the luminance in the red channel
// alone, green and blue exactly 0, scaled by the level.
uniform uNight : vec2<f32>;

varying vCorner : vec2<f32>;
varying vColor : vec4<f32>;

const LUMA : vec3<f32> = vec3<f32>(0.2126, 0.7152, 0.0722);

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  let r2 = dot(fragmentInputs.vCorner, fragmentInputs.vCorner);
  if (r2 > 1.0) {
    discard;
  }
  let w = exp(-4.0 * r2);
  var rgb = fragmentInputs.vColor.rgb * fragmentInputs.vColor.a * w;
  if (uniforms.uNight.x > 0.5) {
    rgb = vec3<f32>(dot(rgb, LUMA), 0.0, 0.0) * uniforms.uNight.y;
  }
  fragmentOutputs.color = vec4<f32>(rgb, 1.0);
}
