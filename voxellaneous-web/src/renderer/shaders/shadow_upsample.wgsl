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

@group(0) @binding(0) var shadow_half_tex: texture_2d<f32>;
@group(0) @binding(1) var depth_tex: texture_depth_2d;

// Controls edge sensitivity for bilateral weight.
// Higher = sharper edges preserved, lower = smoother blending.
const DEPTH_SIGMA: f32 = 500.0;

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    let half_dims = vec2<f32>(textureDimensions(shadow_half_tex, 0));
    let depth_dims = textureDimensions(depth_tex, 0);

    let uv = vec2<f32>(in.uv.x, 1.0 - in.uv.y);

    // Reference depth at this full-res pixel
    let depth_coord = vec2<i32>(uv * vec2<f32>(depth_dims));
    let ref_depth = textureLoad(depth_tex, depth_coord, 0);

    // Position in half-res texel space (continuous)
    let hf = uv * half_dims - 0.5;
    let h0 = vec2<i32>(floor(hf));
    let frac = hf - floor(hf);
    let half_max = vec2<i32>(half_dims) - 1;

    var total_weight = 0.0;
    var total_shadow = 0.0;

    // Bilateral filter over 2x2 neighborhood in half-res
    for (var dy = 0; dy < 2; dy++) {
        for (var dx = 0; dx < 2; dx++) {
            let hc = clamp(h0 + vec2<i32>(dx, dy), vec2<i32>(0), half_max);

            let s = textureLoad(shadow_half_tex, hc, 0).r;

            // Depth at center of this half-res texel (looked up in full-res depth)
            let half_center_uv = (vec2<f32>(hc) + 0.5) / half_dims;
            let sample_depth = textureLoad(depth_tex, vec2<i32>(half_center_uv * vec2<f32>(depth_dims)), 0);

            // Bilinear weight
            let bx = select(1.0 - frac.x, frac.x, dx == 1);
            let by = select(1.0 - frac.y, frac.y, dy == 1);
            let bilinear_w = bx * by;

            // Depth similarity weight (reject cross-edge blending)
            let depth_w = exp(-abs(ref_depth - sample_depth) * DEPTH_SIGMA);

            let w = bilinear_w * depth_w;
            total_weight += w;
            total_shadow += s * w;
        }
    }

    if total_weight > 1e-6 {
        return vec4<f32>(total_shadow / total_weight, 0.0, 0.0, 1.0);
    }
    // Fallback: nearest half-res texel
    let nearest = clamp(vec2<i32>(round(hf)), vec2<i32>(0), half_max);
    return vec4<f32>(textureLoad(shadow_half_tex, nearest, 0).r, 0.0, 0.0, 1.0);
}
