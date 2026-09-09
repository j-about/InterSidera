// Solar-system body billboards, WGSL twin of bodies.vertex.glsl (WebGPU; plan D83, SKY-2,
// brief l.87). The CPU uploads per body: `position` = apparent ENU direction * 1000 (already
// refracted on Earth), `bodyParams` = (angular radius rad, magnitude or -99, phase, class:
// 0 Sun, 1 Moon, 2 other, 3 Sun glare, -1 hidden), `bodySun` = Sun direction in the billboard
// basis (screen right, screen up, toward the viewer). Corners come from the vertex index.
// Minor bodies (SKY-4, plan D102) reuse the shader: class 4 is a disc whose `bodyParams.x` is
// the radius in CSS pixels (sky/math/minorBodies.ts `minorPixelRadius`), class 5 a comet tail
// strip whose `bodyParams.x` is the screen angle of the antisolar direction in radians,
// counter-clockwise from screen right. `uBodyPx` = (minimum disc radius, glare radius, device
// pixels per CSS pixel, tail length), the first two and the last in device pixels.
// `main` stays the last function of the file (Babylon injects its epilogue before the last `}`).
attribute position : vec3<f32>;
attribute bodyParams : vec4<f32>;
attribute bodySun : vec3<f32>;

uniform worldViewProjection : mat4x4<f32>;
uniform uViewport : vec2<f32>;
uniform uFovV : f32;
uniform uBodyPx : vec4<f32>;

varying vCorner : vec2<f32>;
varying vParams : vec4<f32>;
varying vSun : vec3<f32>;

// Half width of a comet tail strip, CSS pixels.
const TAIL_HALF_WIDTH_PX : f32 = 1.5;

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
  } else if (cls > 4.5) {
    // Comet tail: a strip from the body along the antisolar screen angle, fading along it.
    var clip = uniforms.worldViewProjection * vec4<f32>(vertexInputs.position, 1.0);
    let along = (c.x + 1.0) * 0.5;
    let ca = cos(vertexInputs.bodyParams.x);
    let sa = sin(vertexInputs.bodyParams.x);
    let offset = along * uniforms.uBodyPx.w * vec2<f32>(ca, sa) + c.y * TAIL_HALF_WIDTH_PX * uniforms.uBodyPx.z * vec2<f32>(-sa, ca);
    clip = vec4<f32>(clip.xy + offset * 2.0 / uniforms.uViewport * clip.w, clip.zw);
    vertexOutputs.position = clip;
    vertexOutputs.vCorner = vec2<f32>(along, c.y);
  } else {
    var clip = uniforms.worldViewProjection * vec4<f32>(vertexInputs.position, 1.0);
    var radiusPx = 0.0;
    if (cls > 3.5) {
      // Minor-body disc: the CPU radius in CSS pixels.
      radiusPx = vertexInputs.bodyParams.x * uniforms.uBodyPx.z;
    } else {
      // True angular size (exact at the screen centre) or the minimum pixel radius (SKY-2).
      let discPx = max(uniforms.uBodyPx.x, tan(vertexInputs.bodyParams.x) / tan(uniforms.uFovV * 0.5) * uniforms.uViewport.y * 0.5);
      radiusPx = select(discPx, discPx + uniforms.uBodyPx.y, cls > 2.5);
    }
    clip = vec4<f32>(clip.xy + c * radiusPx * 2.0 / uniforms.uViewport * clip.w, clip.zw);
    vertexOutputs.position = clip;
  }
}
