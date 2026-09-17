// Star fragment shader, WGSL twin of stars.fragment.glsl (plan D82): a soft disc exp(-4 r^2)
// discarded outside the unit circle. The colour is premultiplied and the alpha is the coverage
// max(r, g, b) (plan D122): the material blends with ALPHA_PREMULTIPLIED_PORTERDUFF (Babylon:
// COLOR = SRC + (1 - SRC_ALPHA) * DEST, ALPHA = SRC_ALPHA + (1 - SRC_ALPHA) * DEST_ALPHA), the
// defined "over" of premultiplied colour, so the disc composites over the transparent canvas of
// the AR mode, the 2D export canvas and the black sky alike (rgb <= alpha always holds).
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
  fragmentOutputs.color = vec4<f32>(rgb, max(rgb.r, max(rgb.g, rgb.b)));
}
