// Background vertex shader, WGSL twin of background.vertex.glsl (SKY-6/SKY-7, plan D104): a
// full-screen quad emitted directly in clip space (`position.xy` in -1..1, the corner buffer of
// the layer), so the world matrix is not used. The fragment shader reconstructs the ENU
// direction of every pixel from the camera basis and the projection. Canvas only: Babylon's WGSL
// processor multiplies `position.y` by its yFactor after this body (1 on the canvas, -1 on a
// render target, where the varying would then be mirrored). `main` stays the last function.
attribute position : vec3<f32>;

varying vNdc : vec2<f32>;

@vertex
fn main(input : VertexInputs) -> FragmentInputs {
  vertexOutputs.vNdc = vertexInputs.position.xy;
  vertexOutputs.position = vec4<f32>(vertexInputs.position.xy, 0.5, 1.0);
}
