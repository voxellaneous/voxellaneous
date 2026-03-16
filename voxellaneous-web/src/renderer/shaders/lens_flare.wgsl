// Screen-space pseudo lens flare (John Chapman technique).
// Samples a downsampled brightness texture at reflected positions
// with chromatic distortion to produce physically-plausible ghosts and halo.

struct VSOut {
    @builtin(position) Position: vec4<f32>,
    @location(0)       uv:       vec2<f32>,
};

struct LensFlareParams {
    weight:    f32,     // 0 = invisible, 1 = full visibility
    intensity: f32,     // overall brightness multiplier
};

const GHOST_DISPERSAL: f32 = 0.25;   // spacing between ghosts
const GHOST_COUNT:     i32 = 4;       // number of ghost iterations
const HALO_WIDTH:      f32 = 0.45;    // halo ring distance from centre
const DISTORTION:      f32 = 4.0;     // chromatic aberration strength (texels)

@group(0) @binding(0) var bright_tex: texture_2d<f32>;
@group(0) @binding(1) var bright_sampler: sampler;
@group(0) @binding(2) var<uniform> params: LensFlareParams;
@group(0) @binding(3) var<storage, read> sun_occlusion: array<f32, 1>;

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

// Sample bright texture with per-channel UV offsets for chromatic distortion
fn sample_chromatic(uv: vec2<f32>, direction: vec2<f32>, distortion: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(
        textureSampleLevel(bright_tex, bright_sampler, uv + direction * distortion.r, 0).r,
        textureSampleLevel(bright_tex, bright_sampler, uv + direction * distortion.g, 0).g,
        textureSampleLevel(bright_tex, bright_sampler, uv + direction * distortion.b, 0).b
    );
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    let occlusion  = sun_occlusion[0];                   // 0 = visible, 1 = blocked
    let visibility = (1.0 - occlusion) * params.weight;

    if visibility < 0.001 {
        return vec4<f32>(0.0);
    }

    // Convert fullscreen UV → texture sample UV (flip Y for WebGPU tex coords)
    let tex_uv = vec2<f32>(in.uv.x, 1.0 - in.uv.y);

    // Chapman flip: point-reflect through centre (lens ghost reflection)
    let flipped = vec2<f32>(1.0) - tex_uv;

    // Ghost vector from flipped position toward centre
    let ghost_vec = (vec2<f32>(0.5) - flipped) * GHOST_DISPERSAL;
    let direction = normalize(ghost_vec);

    // Chromatic aberration: R/G/B offsets in texels
    let texel_size = 1.0 / f32(textureDimensions(bright_tex, 0).x);
    let distortion = vec3<f32>(
        -texel_size * DISTORTION,
         0.0,
         texel_size * DISTORTION
    );

    // ── Ghosts ─────────────────────────────────────────────────────
    var result = vec3<f32>(0.0);
    for (var i = 0; i < GHOST_COUNT; i++) {
        let offset = fract(flipped + ghost_vec * f32(i));

        // Weight: bright at centre, dim at edges (prevents wrap artifacts)
        let d = length(vec2<f32>(0.5) - offset) / length(vec2<f32>(0.5));
        let weight = pow(1.0 - d, 10.0);

        result += sample_chromatic(offset, direction, distortion) * weight;
    }

    // ── Halo ───────────────────────────────────────────────────────
    let halo_vec = normalize(ghost_vec) * HALO_WIDTH;
    let halo_uv  = flipped + halo_vec;
    let halo_d   = length(vec2<f32>(0.5) - fract(halo_uv)) / length(vec2<f32>(0.5));
    let halo_w   = pow(1.0 - halo_d, 5.0);
    result += sample_chromatic(halo_uv, direction, distortion) * halo_w * 1.5;

    return vec4<f32>(result * visibility * params.intensity, 0.0);
}
