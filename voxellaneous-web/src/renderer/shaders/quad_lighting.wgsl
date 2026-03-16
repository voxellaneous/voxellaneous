struct VSOut {
    @builtin(position) Position: vec4<f32>,
    @location(0)       uv:       vec2<f32>,
};

struct LightingUniforms {
    light_dir:          vec3<f32>,
    ambient:            f32,
    cam_pos_ws:         vec3<f32>,
    light_intensity:    f32,
    inverse_vp:         mat4x4<f32>,
    haze_density:       f32,
    fog_density:        f32,
    fog_falloff:        f32,
};

// Earth atmosphere constants (km) matching webgpu-sky-atmosphere
const BOTTOM_RADIUS: f32 = 6360.0;
const TOP_RADIUS: f32 = 6460.0;
const TO_KM_SCALE: f32 = 1.0 / 2000.0;

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

@group(0) @binding(0) var albedo_tex: texture_2d<f32>;
@group(0) @binding(1) var normal_tex: texture_2d<f32>;
@group(0) @binding(2) var u_samp: sampler;
@group(0) @binding(3) var<uniform> u_lighting: LightingUniforms;
@group(0) @binding(4) var depth_tex: texture_depth_2d;
@group(0) @binding(5) var shadow_tex: texture_2d<f32>;
@group(0) @binding(6) var sky_aerial_tex: texture_2d<f32>;
@group(0) @binding(7) var transmittance_lut: texture_2d<f32>;
@group(0) @binding(8) var lut_sampler: sampler;
@group(0) @binding(9) var<storage, read> sun_occlusion: array<f32, 1>;

// Matches webgpu-sky-atmosphere transmittance_lut_params_to_uv
fn transmittance_lut_uv(view_height: f32, cos_view_zenith: f32) -> vec2<f32> {
    let height_sq = view_height * view_height;
    let bottom_sq = BOTTOM_RADIUS * BOTTOM_RADIUS;
    let top_sq = TOP_RADIUS * TOP_RADIUS;
    let h = sqrt(max(0.0, top_sq - bottom_sq));
    let rho = sqrt(max(0.0, height_sq - bottom_sq));
    let discriminant = height_sq * (cos_view_zenith * cos_view_zenith - 1.0) + top_sq;
    let dist_to_boundary = max(0.0, -view_height * cos_view_zenith + sqrt(max(discriminant, 0.0)));
    let min_dist = TOP_RADIUS - view_height;
    let max_dist = rho + h;
    let x_mu = (dist_to_boundary - min_dist) / (max_dist - min_dist);
    let x_r = rho / h;
    return vec2<f32>(x_mu, x_r);
}

fn get_sun_transmittance(cam_ws: vec3<f32>, sun_dir: vec3<f32>) -> vec3<f32> {
    let pos = vec3<f32>(cam_ws.x * TO_KM_SCALE, cam_ws.y * TO_KM_SCALE + BOTTOM_RADIUS, cam_ws.z * TO_KM_SCALE);
    let view_height = length(pos);
    let zenith = pos / view_height;
    let cos_sun_zenith = dot(sun_dir, zenith);
    let uv = transmittance_lut_uv(view_height, cos_sun_zenith);
    return textureSampleLevel(transmittance_lut, lut_sampler, uv, 0).rgb;
}

// Quilez height fog
fn height_fog(cam_y: f32, ray_y: f32, dist: f32, density: f32, falloff: f32) -> f32 {
    if density <= 0.0 || falloff <= 0.0 { return 0.0; }
    let k = dist * ray_y * falloff;
    let integral = select(dist * falloff, (1.0 - exp(-k)) / ray_y, abs(ray_y) > 0.001);
    let amount = (density / falloff) * exp(-cam_y * falloff) * integral;
    return clamp(1.0 - exp(-max(amount, 0.0)), 0.0, 1.0);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    let dims = textureDimensions(albedo_tex, 0);
    let coord = vec2<i32>(
        i32(in.uv.x * f32(dims.x)),
        i32((1.0 - in.uv.y) * f32(dims.y))
    );

    let normal_encoded = textureLoad(normal_tex, coord, 0);
    let aerial = textureLoad(sky_aerial_tex, coord, 0);

    // Sky pixels: pass through the sky atmosphere directly
    if all(normal_encoded.rgb == vec3<f32>(0.0)) {
        return vec4<f32>(aerial.rgb, 1.0);
    }

    let albedo = textureLoad(albedo_tex, coord, 0);
    let light_dir = normalize(u_lighting.light_dir);

    // Sun color from atmosphere transmittance LUT
    let sun_color = get_sun_transmittance(u_lighting.cam_pos_ws, light_dir);

    // Decode normal from [0,1] to [-1,1]
    let normal = normalize(normal_encoded.rgb * 2.0 - 1.0);

    // Read shadow from precomputed shadow buffer (R channel)
    let shadow = textureLoad(shadow_tex, coord, 0).r;

    // N dot L shading with sun color; no direct light when sun is below horizon
    let sun_above = smoothstep(-0.05, 0.05, light_dir.y);
    let ndotl = max(dot(normal, light_dir), 0.0);
    let diffuse = ndotl * sun_color * (u_lighting.light_intensity * 0.1) * (1.0 - shadow) * sun_above;
    let lighting = vec3<f32>(u_lighting.ambient) + diffuse;
    let lit_color = albedo.rgb * lighting;

    // Reconstruct world position from hardware depth
    let depth = textureLoad(depth_tex, coord, 0);
    let ndc = vec4<f32>(in.uv * 2.0 - 1.0, depth, 1.0);
    let world_h = u_lighting.inverse_vp * ndc;
    let world_pos = world_h.xyz / world_h.w;

    let cam = u_lighting.cam_pos_ws;
    let ray = world_pos - cam;
    let dist = length(ray);
    let ray_dir = ray / max(dist, 0.001);

    // Sun occlusion from compute pass (soft, multi-sample)
    let sun_occluded = sun_occlusion[0];

    // 1) Atmospheric haze — blends toward aerial perspective
    let haze = clamp(1.0 - exp(-u_lighting.haze_density * dist), 0.0, 1.0);
    let sun_align = max(dot(ray_dir, light_dir), 0.0);
    // When sun is behind terrain, reduce aerial inscatter near sun direction
    // (the Mie forward-scatter peak in aerial is wrong when sun is occluded)
    let occ_fade = sun_occluded * smoothstep(0.3, 0.95, sun_align);
    let haze_aerial = aerial.rgb * (1.0 - occ_fade);
    let haze_target = haze_aerial + (1.0 - aerial.a) * lit_color;
    let after_haze = mix(lit_color, haze_target, haze);

    // 2) Ground/cloud fog — Quilez height fog, tinted by sun color
    let fog = height_fog(cam.y, ray_dir.y, dist, u_lighting.fog_density, u_lighting.fog_falloff);
    let day_brightness = smoothstep(-0.1, 0.2, light_dir.y);
    let fog_color = sun_color * day_brightness;
    let result = mix(after_haze, fog_color, fog);

    return vec4<f32>(result, 1.0);
}
