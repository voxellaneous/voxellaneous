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

const PI: f32 = 3.14159265359;

// Earth atmosphere constants (km) matching webgpu-sky-atmosphere
const BOTTOM_RADIUS: f32 = 6360.0;
const TOP_RADIUS: f32 = 6460.0;
const TO_KM_SCALE: f32 = 1.0 / 2000.0;

// Fixed PBR material properties (will be per-material later)
const PBR_METALLIC: f32 = 0.0;
const PBR_ROUGHNESS: f32 = 0.5;

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
@group(0) @binding(10) var env_cubemap: texture_cube<f32>;
@group(0) @binding(11) var<storage, read> sh_coeffs: array<vec4<f32>, 9>;

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

// --- PBR helpers ---

fn fresnel_schlick(cos_theta: f32, f0: vec3<f32>) -> vec3<f32> {
    return f0 + (1.0 - f0) * pow(clamp(1.0 - cos_theta, 0.0, 1.0), 5.0);
}

fn fresnel_schlick_roughness(cos_theta: f32, f0: vec3<f32>, roughness: f32) -> vec3<f32> {
    return f0 + (max(vec3<f32>(1.0 - roughness), f0) - f0) * pow(clamp(1.0 - cos_theta, 0.0, 1.0), 5.0);
}

fn distribution_ggx(n_dot_h: f32, roughness: f32) -> f32 {
    let a = roughness * roughness;
    let a2 = a * a;
    let d = n_dot_h * n_dot_h * (a2 - 1.0) + 1.0;
    return a2 / (PI * d * d);
}

fn geometry_schlick_ggx(n_dot_x: f32, roughness: f32) -> f32 {
    let r = roughness + 1.0;
    let k = (r * r) / 8.0;
    return n_dot_x / (n_dot_x * (1.0 - k) + k);
}

fn geometry_smith(n_dot_v: f32, n_dot_l: f32, roughness: f32) -> f32 {
    return geometry_schlick_ggx(n_dot_v, roughness) * geometry_schlick_ggx(n_dot_l, roughness);
}

// L2 SH irradiance evaluation (cosine convolution baked into coefficients)
fn eval_sh_irradiance(n: vec3<f32>) -> vec3<f32> {
    var result = sh_coeffs[0].xyz * 0.282095;
    result += sh_coeffs[1].xyz * (0.488603 * n.y);
    result += sh_coeffs[2].xyz * (0.488603 * n.z);
    result += sh_coeffs[3].xyz * (0.488603 * n.x);
    result += sh_coeffs[4].xyz * (1.092548 * n.x * n.y);
    result += sh_coeffs[5].xyz * (1.092548 * n.y * n.z);
    result += sh_coeffs[6].xyz * (0.315392 * (3.0 * n.z * n.z - 1.0));
    result += sh_coeffs[7].xyz * (1.092548 * n.x * n.z);
    result += sh_coeffs[8].xyz * (0.546274 * (n.x * n.x - n.y * n.y));
    return max(result, vec3<f32>(0.0));
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

    // Read shadow from precomputed shadow buffer (R channel, may be lower res)
    let shadow_dims = textureDimensions(shadow_tex, 0);
    let shadow_coord = vec2<i32>(
        i32(in.uv.x * f32(shadow_dims.x)),
        i32((1.0 - in.uv.y) * f32(shadow_dims.y))
    );
    let shadow = textureLoad(shadow_tex, shadow_coord, 0).r;

    // Reconstruct world position from hardware depth
    let depth = textureLoad(depth_tex, coord, 0);
    let ndc = vec4<f32>(in.uv * 2.0 - 1.0, depth, 1.0);
    let world_h = u_lighting.inverse_vp * ndc;
    let world_pos = world_h.xyz / world_h.w;

    let cam = u_lighting.cam_pos_ws;
    let view_dir = normalize(cam - world_pos);
    let n_dot_v = max(dot(normal, view_dir), 0.001);
    let n_dot_l = max(dot(normal, light_dir), 0.0);
    // Half-Lambert wrap for direct diffuse on axis-aligned voxel normals
    let n_dot_l_wrap = max(dot(normal, light_dir) * 0.7 + 0.3, 0.0);

    // PBR material
    let f0 = mix(vec3<f32>(0.04), albedo.rgb, PBR_METALLIC);

    // --- Direct lighting: Cook-Torrance ---
    let sun_above = smoothstep(-0.05, 0.05, light_dir.y);
    let radiance = sun_color * (u_lighting.light_intensity * 0.1) * (1.0 - shadow) * sun_above;

    // Diffuse uses wrap (fills perpendicular faces), specular uses real n_dot_l
    var direct = (1.0 - PBR_METALLIC) * albedo.rgb * radiance * n_dot_l_wrap;

    // Add specular only when surface faces the light
    if n_dot_l > 0.0 {
        let h_raw = view_dir + light_dir;
        let h_len_sq = dot(h_raw, h_raw);

        if h_len_sq > 1e-8 {
            let half_vec = h_raw * inverseSqrt(h_len_sq);
            let n_dot_h = max(dot(normal, half_vec), 0.0);
            let v_dot_h = max(dot(view_dir, half_vec), 0.0);

            let D = distribution_ggx(n_dot_h, PBR_ROUGHNESS);
            let G = geometry_smith(n_dot_v, n_dot_l, PBR_ROUGHNESS);
            let F = fresnel_schlick(v_dot_h, f0);

            direct += (D * G * F) / max(4.0 * n_dot_v * n_dot_l, 0.001) * radiance * n_dot_l;
        }
    }

    // --- Environment lighting: SH irradiance + cubemap specular ---
    let reflect_dir = reflect(-view_dir, normal);
    let env_spec = textureSampleLevel(env_cubemap, lut_sampler, reflect_dir, 0.0).rgb;
    let env_diff = eval_sh_irradiance(normal);

    let F_env = fresnel_schlick_roughness(n_dot_v, f0, PBR_ROUGHNESS);
    let kd_env = (1.0 - F_env) * (1.0 - PBR_METALLIC);

    // Attenuate sharp specular for rough surfaces (approximation for missing pre-filtered mips)
    let spec_atten = 1.0 - PBR_ROUGHNESS * PBR_ROUGHNESS;

    let ibl = kd_env * env_diff * albedo.rgb + F_env * env_spec * spec_atten;
    let lit_color = direct + ibl * u_lighting.ambient;

    // --- Atmospheric post-effects ---
    let ray = world_pos - cam;
    let dist = length(ray);
    let ray_dir = ray / max(dist, 0.001);

    // Sun occlusion from compute pass (soft, multi-sample)
    let sun_occluded = sun_occlusion[0];

    // 1) Atmospheric haze — blends toward aerial perspective
    let haze = clamp(1.0 - exp(-u_lighting.haze_density * dist), 0.0, 1.0);
    let sun_align = max(dot(ray_dir, light_dir), 0.0);
    // When sun is behind terrain, reduce aerial inscatter near sun direction
    let occ_fade = sun_occluded * smoothstep(0.3, 0.95, sun_align);
    let haze_aerial = aerial.rgb * (1.0 - occ_fade);
    let haze_target = haze_aerial + (1.0 - aerial.a) * lit_color;
    let after_haze = mix(lit_color, haze_target, haze);

    // 2) Ground/cloud fog — Quilez height fog, tinted by sun color
    let fog = height_fog(cam.y, ray_dir.y, dist, u_lighting.fog_density, u_lighting.fog_falloff);
    let day_brightness = smoothstep(-0.1, 0.2, light_dir.y);
    let sun_lum = dot(sun_color, vec3<f32>(0.2126, 0.7152, 0.0722));
    let fog_color = mix(vec3<f32>(sun_lum), sun_color, 0.4) * day_brightness;
    let result = mix(after_haze, fog_color, fog);

    return vec4<f32>(result, 1.0);
}
