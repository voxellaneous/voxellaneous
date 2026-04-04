struct VSOut {
    @builtin(position) Position: vec4<f32>,
    @location(0)       uv:       vec2<f32>,
};

struct ShadowUniforms {
    light_dir:  vec3<f32>,
    _pad0:      f32,
    cam_pos_ws: vec3<f32>,
    _pad1:      f32,
    inverse_vp: mat4x4<f32>,
};

struct ShadowClipmapLevel {
    origin_x:   f32,
    origin_z:   f32,
    texel_size: f32,
    inv_size:   f32,
};

struct ShadowClipmapUniforms {
    levels: array<ShadowClipmapLevel, 4>,
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

@group(0) @binding(0) var normal_tex: texture_2d<f32>;
@group(0) @binding(1) var<uniform> u_shadow: ShadowUniforms;
@group(0) @binding(2) var depth_tex: texture_depth_2d;
@group(0) @binding(3) var shadow_clipmap_tex: texture_2d_array<f32>;
@group(0) @binding(4) var<uniform> u_shadow_clipmap: ShadowClipmapUniforms;

// Sample terrain height from a specific clipmap level with bilinear interpolation
fn sample_clipmap_height(world_x: f32, world_z: f32, level: i32) -> f32 {
    let lev = u_shadow_clipmap.levels[level];
    let size_f = 1.0 / lev.inv_size;
    let coverage = size_f * lev.texel_size;

    if world_x < lev.origin_x || world_x >= lev.origin_x + coverage ||
       world_z < lev.origin_z || world_z >= lev.origin_z + coverage {
        return -1e6;
    }

    let ctx = world_x / lev.texel_size - 0.5;
    let ctz = world_z / lev.texel_size - 0.5;
    let size = i32(size_f);

    let fx = floor(ctx);
    let fz = floor(ctz);
    let u = ctx - fx;
    let v = ctz - fz;

    let size_mask = size - 1;
    let ix0 = i32(u32(i32(fx)) & u32(size_mask));
    let iz0 = i32(u32(i32(fz)) & u32(size_mask));
    let ix1 = (ix0 + 1) & size_mask;
    let iz1 = (iz0 + 1) & size_mask;

    let h00 = textureLoad(shadow_clipmap_tex, vec2<i32>(ix0, iz0), level, 0).r;
    let h10 = textureLoad(shadow_clipmap_tex, vec2<i32>(ix1, iz0), level, 0).r;
    let h01 = textureLoad(shadow_clipmap_tex, vec2<i32>(ix0, iz1), level, 0).r;
    let h11 = textureLoad(shadow_clipmap_tex, vec2<i32>(ix1, iz1), level, 0).r;

    if min(min(h00, h10), min(h01, h11)) < -1e5 {
        let px = i32(u32(i32(round(ctx + 0.5))) & u32(size_mask));
        let pz = i32(u32(i32(round(ctz + 0.5))) & u32(size_mask));
        return textureLoad(shadow_clipmap_tex, vec2<i32>(px, pz), level, 0).r;
    }

    return mix(mix(h00, h10, u), mix(h01, h11, u), v);
}

fn sample_height_from(world_x: f32, world_z: f32, min_level: i32) -> f32 {
    for (var l = min_level; l < 4; l++) {
        let lev = u_shadow_clipmap.levels[l];
        let coverage = (1.0 / lev.inv_size) * lev.texel_size;
        let margin = coverage * 0.08;

        let dx = min(world_x - lev.origin_x, lev.origin_x + coverage - world_x);
        let dz = min(world_z - lev.origin_z, lev.origin_z + coverage - world_z);
        let edge_dist = min(dx, dz);

        if l == 3 && edge_dist < margin {
            return -1e6;
        }

        let h = sample_clipmap_height(world_x, world_z, l);
        if h > -1e5 {
            if l < 3 && edge_dist < margin {
                let h_coarse = sample_clipmap_height(world_x, world_z, l + 1);
                if h_coarse > -1e5 {
                    return mix(h_coarse, h, clamp(edge_dist / margin, 0.0, 1.0));
                }
            }
            return h;
        }
    }
    return -1e6;
}

// Shadow quality constants (replaced at pipeline creation for mobile)
const SHADOW_CLOSE_SAMPLES: i32 = 8;
const SHADOW_CLOSE_STEP: f32 = 8.0;
const SHADOW_NEAR_SAMPLES: i32 = 14;
const SHADOW_NEAR_STEP: f32 = 32.0;
const SHADOW_MID_SAMPLES: i32 = 32;
const SHADOW_MID_STEP: f32 = 128.0;
const SHADOW_FAR_SAMPLES: i32 = 32;
const SHADOW_FAR_STEP: f32 = 512.0;

fn compute_far_shadow(world_pos: vec3<f32>, light_dir: vec3<f32>) -> f32 {
    let horiz = vec2<f32>(light_dir.x, light_dir.z);
    let horiz_len = length(horiz);

    if horiz_len < 0.01 {
        return 0.0;
    }

    let sun_tan = light_dir.y / horiz_len;
    let march_dir = horiz / horiz_len;
    var max_horizon_tan = -1e6;
    let self_y = world_pos.y + 4.0;

    // Close-range: level 0 (texel_size=2)
    var t = 2.0;
    for (var i = 0; i < SHADOW_CLOSE_SAMPLES; i++) {
        let sx = world_pos.x + march_dir.x * t;
        let sz = world_pos.z + march_dir.y * t;
        let h = sample_clipmap_height(sx, sz, 0);
        if h > -1e5 {
            max_horizon_tan = max(max_horizon_tan, (h - self_y) / t);
            if max_horizon_tan >= sun_tan { return 1.0; }
        }
        t += SHADOW_CLOSE_STEP;
    }

    // Near: level 1+
    for (var i = 0; i < SHADOW_NEAR_SAMPLES; i++) {
        let sx = world_pos.x + march_dir.x * t;
        let sz = world_pos.z + march_dir.y * t;
        let h = sample_height_from(sx, sz, 1);
        if h > -1e5 {
            max_horizon_tan = max(max_horizon_tan, (h - self_y) / t);
            if max_horizon_tan >= sun_tan { return 1.0; }
        }
        t += SHADOW_NEAR_STEP;
    }

    for (var i = 0; i < SHADOW_MID_SAMPLES; i++) {
        let sx = world_pos.x + march_dir.x * t;
        let sz = world_pos.z + march_dir.y * t;
        let h = sample_height_from(sx, sz, 2);
        if h > -1e5 {
            max_horizon_tan = max(max_horizon_tan, (h - self_y) / t);
            if max_horizon_tan >= sun_tan { return 1.0; }
        }
        t += SHADOW_MID_STEP;
    }

    for (var i = 0; i < SHADOW_FAR_SAMPLES; i++) {
        let sx = world_pos.x + march_dir.x * t;
        let sz = world_pos.z + march_dir.y * t;
        let h = sample_clipmap_height(sx, sz, 3);
        if h > -1e5 {
            max_horizon_tan = max(max_horizon_tan, (h - self_y) / t);
            if max_horizon_tan >= sun_tan { return 1.0; }
        }
        t += SHADOW_FAR_STEP;
    }

    let penumbra_tan = 0.03;
    return smoothstep(sun_tan - penumbra_tan, sun_tan, max_horizon_tan);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    let dims = textureDimensions(normal_tex, 0);
    let coord = vec2<i32>(
        i32(in.uv.x * f32(dims.x)),
        i32((1.0 - in.uv.y) * f32(dims.y))
    );

    let normal_encoded = textureLoad(normal_tex, coord, 0);

    // Sky pixels: no shadow
    if all(normal_encoded.rgb == vec3<f32>(0.0)) {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }

    let light_dir = normalize(u_shadow.light_dir);

    // Reconstruct world position from depth buffer
    let depth = textureLoad(depth_tex, coord, 0);
    let ndc = vec4<f32>(
        in.uv.x * 2.0 - 1.0,
        in.uv.y * 2.0 - 1.0,
        depth,
        1.0
    );
    let world_h = u_shadow.inverse_vp * ndc;
    let world_pos = world_h.xyz / world_h.w;

    let shadow = compute_far_shadow(world_pos, light_dir);
    return vec4<f32>(shadow, 0.0, 0.0, 1.0);
}
