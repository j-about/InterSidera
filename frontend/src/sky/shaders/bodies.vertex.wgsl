// Solar-system body billboards, WGSL twin of bodies.vertex.glsl (WebGPU; plan D83, SKY-2,
// brief l.87). The CPU uploads per body: `position` = apparent ENU direction * 1000 (already
// refracted on Earth), `bodyParams` = (angular radius rad, magnitude or -99, phase, class:
// 0 Sun, 1 Moon, 2 other, 3 Sun glare, -1 hidden), `bodySun` = Sun direction in the billboard
// basis (screen right, screen up, toward the viewer). Corners come from the vertex index.
// `main` stays the last function of the file (Babylon injects its epilogue before the last `}`).
attribute position : vec3<f32>;
attribute bodyParams : vec4<f32>;
attribute bodySun : vec3<f32>;

uniform worldViewProjection : mat4x4<f32>;
uniform uViewport : vec2<f32>;
uniform uFovV : f32;
uniform uBodyPx : vec2<f32>;

varying vCorner : vec2<f32>;
varying vParams : vec4<f32>;
varying vSun : vec3<f32>;

@vertex
fn main(input : VertexInputs) -> FragmentInputs {
  // Corner of the quad from the vertex index: 0 (-1,-1), 1 (1,-1), 2 (1,1), 3 (-1,1).
  let index = vertexInputs.vertexIndex & 3u;
  let bit0 = index & 1u;
  let bit1 = (index >> 1u) & 1u;
  let c = vec2<f32>(select(-1.0, 1.0, (bit0 ^ bit1) == 1u), select(-1.0, 1.0, bit1 == 1u));
  let cls = vertexInputs.bodyParams.w;
  vertexOutputs.vCorner = c;
  vertexOutputs.vParams = vertexInputs.bodyParams;
  vertexOutputs.vSun = vertexInputs.bodySun;
  if (cls < -0.5) {
    // Hidden or invalid slot: a degenerate quad outside the clip volume.
    vertexOutputs.position = vec4<f32>(0.0, 0.0, 2.0, 1.0);
  } else {
    var clip = uniforms.worldViewProjection * vec4<f32>(vertexInputs.position, 1.0);
    // True angular size (exact at the screen centre) or the minimum pixel radius (SKY-2).
    let discPx = max(uniforms.uBodyPx.x, tan(vertexInputs.bodyParams.x) / tan(uniforms.uFovV * 0.5) * uniforms.uViewport.y * 0.5);
    let radiusPx = select(discPx, discPx + uniforms.uBodyPx.y, cls > 2.5);
    clip = vec4<f32>(clip.xy + c * radiusPx * 2.0 / uniforms.uViewport * clip.w, clip.zw);
    vertexOutputs.position = clip;
  }
}
