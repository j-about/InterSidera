// Solar-system body billboards, GLSL twin of bodies.vertex.wgsl (WebGL2; plan D83, SKY-2,
// brief l.87). The CPU uploads per body: `position` = apparent ENU direction * 1000 (already
// refracted on Earth), `bodyParams` = (angular radius rad, magnitude or -99, phase, class:
// 0 Sun, 1 Moon, 2 other, 3 Sun glare, -1 hidden), `bodySun` = Sun direction in the billboard
// basis (screen right, screen up, toward the viewer). Corners come from the vertex index.
// Minor bodies (SKY-4, plan D102) reuse the shader: class 4 is a disc whose `bodyParams.x` is
// the radius in CSS pixels (sky/math/minorBodies.ts `minorPixelRadius`), class 5 a comet tail
// strip whose `bodyParams.x` is the screen angle of the antisolar direction in radians,
// counter-clockwise from screen right. `uBodyPx` = (minimum disc radius, glare radius, device
// pixels per CSS pixel, tail length), the first two and the last in device pixels.
precision highp float;
precision highp int;

attribute vec3 position;
attribute vec4 bodyParams;
attribute vec3 bodySun;

uniform mat4 worldViewProjection;
uniform vec2 uViewport;
uniform float uFovV;
uniform vec4 uBodyPx;

varying vec2 vCorner;
varying vec4 vParams;
varying vec3 vSun;

// Half width of a comet tail strip, CSS pixels.
const float TAIL_HALF_WIDTH_PX = 1.5;

void main(void) {
  // Corner of the quad from the vertex index: 0 (-1,-1), 1 (1,-1), 2 (1,1), 3 (-1,1).
  int index = gl_VertexID & 3;
  int bit0 = index & 1;
  int bit1 = (index >> 1) & 1;
  vec2 c = vec2((bit0 ^ bit1) == 1 ? 1.0 : -1.0, bit1 == 1 ? 1.0 : -1.0);
  float cls = bodyParams.w;
  vCorner = c;
  vParams = bodyParams;
  vSun = bodySun;
  if (cls < -0.5) {
    // Hidden or invalid slot: a degenerate quad outside the clip volume.
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  } else if (cls > 4.5) {
    // Comet tail: a strip from the body along the antisolar screen angle, fading along it.
    vec4 clip = worldViewProjection * vec4(position, 1.0);
    float along = (c.x + 1.0) * 0.5;
    float ca = cos(bodyParams.x);
    float sa = sin(bodyParams.x);
    vec2 offset = along * uBodyPx.w * vec2(ca, sa) + c.y * TAIL_HALF_WIDTH_PX * uBodyPx.z * vec2(-sa, ca);
    clip.xy += offset * 2.0 / uViewport * clip.w;
    gl_Position = clip;
    vCorner = vec2(along, c.y);
  } else {
    vec4 clip = worldViewProjection * vec4(position, 1.0);
    float radiusPx;
    if (cls > 3.5) {
      // Minor-body disc: the CPU radius in CSS pixels.
      radiusPx = bodyParams.x * uBodyPx.z;
    } else {
      // True angular size (exact at the screen centre) or the minimum pixel radius (SKY-2).
      float discPx = max(uBodyPx.x, tan(bodyParams.x) / tan(uFovV * 0.5) * uViewport.y * 0.5);
      radiusPx = cls > 2.5 ? discPx + uBodyPx.y : discPx;
    }
    clip.xy += c * radiusPx * 2.0 / uViewport * clip.w;
    gl_Position = clip;
  }
}
