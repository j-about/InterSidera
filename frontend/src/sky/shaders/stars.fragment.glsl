// Star fragment shader, GLSL twin of stars.fragment.wgsl (plan D82): a soft disc exp(-4 r^2)
// discarded outside the unit circle. The material blends with ALPHA_ADD (Babylon:
// COLOR = SRC_ALPHA * SRC + DEST), so the colour is written premultiplied with alpha 1.
precision highp float;

varying vec2 vCorner;
varying vec4 vColor;

void main(void) {
  float r2 = dot(vCorner, vCorner);
  if (r2 > 1.0) {
    discard;
  }
  float w = exp(-4.0 * r2);
  gl_FragColor = vec4(vColor.rgb * vColor.a * w, 1.0);
}
