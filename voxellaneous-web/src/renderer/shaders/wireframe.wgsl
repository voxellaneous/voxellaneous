struct VertexInput {
    @location(0) position: vec3<f32>,
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
};

struct PerFrameUniforms {
    vp_matrix:  mat4x4<f32>,
    cam_pos_ws: vec3<f32>,
    _padding:   f32,
};
@group(0) @binding(0) var<uniform> u_frame: PerFrameUniforms;

struct PerDrawUniforms {
    model_matrix:     mat4x4<f32>,
    inv_model_matrix: mat4x4<f32>,
};
@group(1) @binding(0) var<uniform> u_draw: PerDrawUniforms;

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    let ws4 = u_draw.model_matrix * vec4<f32>(in.position, 1.0);
    out.position = u_frame.vp_matrix * ws4;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return vec4<f32>(1.0, 1.0, 0.0, 1.0); // Yellow wireframe
}
