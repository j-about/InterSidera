// Star fragment shader, GLSL twin of stars.fragment.wgsl (plan D82): a soft disc exp(-4 r^2)
// discarded outside the unit circle. The colour is premultiplied and the alpha is the coverage
// max(r, g, b) (plan D122): the material blends with ALPHA_PREMULTIPLIED_PORTERDUFF (Babylon:
// COLOR = SRC + (1 - SRC_ALPHA) * DEST, ALPHA = SRC_ALPHA + (1 - SRC_ALPHA) * DEST_ALPHA), the
// defined "over" of premultiplied colour, so the disc composites over the transparent canvas of
// the AR mode, the 2D export canvas and the black sky alike (rgb <= alpha always holds).
// Night mode (UX-3, plan D108): uNight = (on, level) keeps the luminance in the red channel
// alone, green and blue exactly 0, scaled by the level.
precision highp float;

uniform vec2 uNight;

varying vec2 vCorner;
varying vec4 vColor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

void main(void) {
  float r2 = dot(vCorner, vCorner);
  if (r2 > 1.0) {
    discard;
  }
  float w = exp(-4.0 * r2);
  vec3 rgb = vColor.rgb * vColor.a * w;
  if (uNight.x > 0.5) {
    rgb = vec3(dot(rgb, LUMA), 0.0, 0.0) * uNight.y;
  }
  gl_FragColor = vec4(rgb, max(rgb.r, max(rgb.g, rgb.b)));
}
