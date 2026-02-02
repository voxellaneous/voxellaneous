struct VSOut {
    @builtin(position) Position: vec4<f32>,
    @location(0)         uv:       vec2<f32>,
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

@group(0) @binding(0) var u_tex: texture_2d<u32>;
@group(0) @binding(1) var u_samp: sampler;

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    let dims = textureDimensions(u_tex, 0);
    let coord = vec2<i32>(
        i32(in.uv.x * f32(dims.x)),
        i32((1.0 - in.uv.y) * f32(dims.y))
    );
    let texel: vec4<u32> = textureLoad(u_tex, coord, 0);
    // albedo was Rgba16Uint → normalize by 65535
    let inv = 1.0 / 65535.0;
    return vec4<f32>(
        f32(texel.r) * inv,
        f32(texel.g) * inv,
        f32(texel.b) * inv,
        f32(texel.a) * inv
    );
}
