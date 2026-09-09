// Star fragment shader, GLSL twin of stars.fragment.wgsl (plan D82): a soft disc exp(-4 r^2)
// discarded outside the unit circle. The material blends with ALPHA_ADD (Babylon:
// COLOR = SRC_ALPHA * SRC + DEST), so the colour is written premultiplied with alpha 1.
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
  gl_FragColor = vec4(rgb, 1.0);
}
