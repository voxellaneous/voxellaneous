struct VSOut {
    @builtin(position) Position: vec4<f32>,
    @location(0)       uv:       vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
    var corners = array<vec2<f32>,3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 3.0, -1.0),
        vec2<f32>(-1.0,  3.0)
    );
    var out: VSOut;
    out.Position = vec4<f32>(corners[vi], 0.0, 1.0);
    out.uv       = corners[vi] * 0.5 + vec2<f32>(0.5);
    return out;
}

@group(0) @binding(0) var u_depth: texture_depth_2d;

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    let dims = textureDimensions(u_depth, 0);
    let coord = vec2<i32>(
        i32(in.uv.x * f32(dims.x)),
        i32((1.0 - in.uv.y) * f32(dims.y))
    );
    // Infinite reverse-Z: d=1 at near, d→0 at infinity
    // Linearize: linear_z = near / d
    let d = textureLoad(u_depth, coord, 0);
    let near = 0.1;
    let linear_z = near / max(d, 1e-7);
    // Map with log scale so near and far are both visible
    let v = 1.0 - saturate(log2(linear_z) / 16.0);
    return vec4<f32>(v, v, v, 1.0);
}
