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

@group(0) @binding(0) var hdr_tex: texture_2d<f32>;
@group(0) @binding(1) var u_samp: sampler;

// ACES filmic tone mapping (Narkowicz approximation)
fn aces_tonemap(x: vec3<f32>) -> vec3<f32> {
    let a = 2.51;
    let b = 0.03;
    let c = 2.43;
    let d = 0.59;
    let e = 0.14;
    return saturate((x * (a * x + b)) / (x * (c * x + d) + e));
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    let dims = textureDimensions(hdr_tex, 0);
    let coord = vec2<i32>(
        i32(in.uv.x * f32(dims.x)),
        i32((1.0 - in.uv.y) * f32(dims.y))
    );
    let hdr_color = textureLoad(hdr_tex, coord, 0).rgb;
    let mapped = aces_tonemap(hdr_color);
    return vec4<f32>(mapped, 1.0);
}
