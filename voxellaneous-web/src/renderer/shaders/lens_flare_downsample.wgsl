// Downsample HDR to 1/4 resolution with soft brightness threshold.
// Only bright areas (sun, specular highlights) survive the threshold,
// serving as input for the lens flare feature generation pass.

struct VSOut {
    @builtin(position) Position: vec4<f32>,
    @location(0)       uv:       vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
    var corners = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 3.0, -1.0),
        vec2<f32>(-1.0,  3.0)
    );
    var out: VSOut;
    out.Position = vec4<f32>(corners[vi], 0.0, 1.0);
    out.uv       = corners[vi] * 0.5 + vec2<f32>(0.5);
    return out;
}

const THRESHOLD: f32 = 1.5;

@group(0) @binding(0) var hdr_tex: texture_2d<f32>;
@group(0) @binding(1) var hdr_sampler: sampler;

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    // Bilinear sample gives free 2x2 box-filter downsample
    let sample_uv = vec2<f32>(in.uv.x, 1.0 - in.uv.y);
    let color = textureSampleLevel(hdr_tex, hdr_sampler, sample_uv, 0).rgb;

    // Soft threshold: preserve only bright areas, scale proportionally
    let brightness = max(color.r, max(color.g, color.b));
    let contribution = max(0.0, brightness - THRESHOLD) / max(brightness, 0.001);
    return vec4<f32>(color * contribution, 1.0);
}
