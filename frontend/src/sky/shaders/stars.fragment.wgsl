// Star fragment shader, WGSL twin of stars.fragment.glsl (plan D82): a soft disc exp(-4 r^2)
// discarded outside the unit circle. The material blends with ALPHA_ADD (Babylon:
// COLOR = SRC_ALPHA * SRC + DEST), so the colour is written premultiplied with alpha 1.
varying vCorner : vec2<f32>;
varying vColor : vec4<f32>;

@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  let r2 = dot(fragmentInputs.vCorner, fragmentInputs.vCorner);
  if (r2 > 1.0) {
    discard;
  }
  let w = exp(-4.0 * r2);
  fragmentOutputs.color = vec4<f32>(fragmentInputs.vColor.rgb * fragmentInputs.vColor.a * w, 1.0);
}
