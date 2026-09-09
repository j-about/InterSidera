// Background vertex shader, GLSL twin of background.vertex.wgsl (SKY-6/SKY-7, plan D104): a
// full-screen quad emitted directly in clip space (`position.xy` in -1..1, the corner buffer of
// the layer), so the world matrix is not used. The fragment shader reconstructs the ENU
// direction of every pixel from the camera basis and the projection. Canvas only: a render
// target would need the y flip Babylon applies after the varying is written (verified on the
// WebGPU processor; recorded in the layer). No preprocessor token may appear in this file.
precision highp float;

attribute vec3 position;

varying vec2 vNdc;

void main(void) {
  vNdc = position.xy;
  gl_Position = vec4(position.xy, 0.5, 1.0);
}
