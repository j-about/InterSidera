// Solar-system body billboards, GLSL twin of bodies.vertex.wgsl (WebGL2; plan D83, SKY-2,
// brief l.87). The CPU uploads per body: `position` = apparent ENU direction * 1000 (already
// refracted on Earth), `bodyParams` = (angular radius rad, magnitude or -99, phase, class:
// 0 Sun, 1 Moon, 2 other, 3 Sun glare, -1 hidden), `bodySun` = Sun direction in the billboard
// basis (screen right, screen up, toward the viewer). Corners come from the vertex index.
precision highp float;
precision highp int;

attribute vec3 position;
attribute vec4 bodyParams;
attribute vec3 bodySun;

uniform mat4 worldViewProjection;
uniform vec2 uViewport;
uniform float uFovV;
uniform vec2 uBodyPx;

varying vec2 vCorner;
varying vec4 vParams;
varying vec3 vSun;

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
  } else {
    vec4 clip = worldViewProjection * vec4(position, 1.0);
    // True angular size (exact at the screen centre) or the minimum pixel radius (SKY-2).
    float discPx = max(uBodyPx.x, tan(bodyParams.x) / tan(uFovV * 0.5) * uViewport.y * 0.5);
    float radiusPx = cls > 2.5 ? discPx + uBodyPx.y : discPx;
    clip.xy += c * radiusPx * 2.0 / uViewport * clip.w;
    gl_Position = clip;
  }
}
