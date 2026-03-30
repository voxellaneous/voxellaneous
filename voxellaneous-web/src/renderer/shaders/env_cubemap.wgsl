// Environment cubemap generation from atmosphere
// Single-scattering sky radiance using transmittance LUT

const PI: f32 = 3.14159265359;
const BOTTOM_RADIUS: f32 = 6360.0;
const TOP_RADIUS: f32 = 6460.0;

const RAYLEIGH_SCATTERING: vec3<f32> = vec3<f32>(5.802e-3, 13.558e-3, 33.1e-3);
const RAYLEIGH_SCALE_HEIGHT: f32 = 8.0;

const MIE_SCATTERING: f32 = 3.996e-3;
const MIE_EXTINCTION: f32 = 4.440e-3;
const MIE_SCALE_HEIGHT: f32 = 1.2;
const MIE_G: f32 = 0.8;

const NUM_STEPS: u32 = 32u;

struct Params {
    sun_dir:         vec3<f32>,
    sun_illuminance: f32,
    cam_height_km:   f32,
};

@group(0) @binding(0) var transmittance_lut: texture_2d<f32>;
@group(0) @binding(1) var lut_sampler: sampler;
@group(0) @binding(2) var output: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(3) var<uniform> params: Params;

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

fn sample_transmittance(height: f32, cos_zenith: f32) -> vec3<f32> {
    let uv = transmittance_lut_uv(height, cos_zenith);
    return textureSampleLevel(transmittance_lut, lut_sampler, uv, 0).rgb;
}

fn rayleigh_phase(cos_theta: f32) -> f32 {
    return (3.0 / (16.0 * PI)) * (1.0 + cos_theta * cos_theta);
}

fn hg_phase(cos_theta: f32, g: f32) -> f32 {
    let g2 = g * g;
    let denom = 1.0 + g2 - 2.0 * g * cos_theta;
    return (1.0 - g2) / (4.0 * PI * denom * sqrt(max(denom, 1e-6)));
}

fn ray_sphere_far(origin: vec3<f32>, dir: vec3<f32>, radius: f32) -> f32 {
    let b = dot(origin, dir);
    let c = dot(origin, origin) - radius * radius;
    let d = b * b - c;
    if d < 0.0 { return -1.0; }
    return -b + sqrt(d);
}

fn ray_sphere_near(origin: vec3<f32>, dir: vec3<f32>, radius: f32) -> f32 {
    let b = dot(origin, dir);
    let c = dot(origin, origin) - radius * radius;
    let d = b * b - c;
    if d < 0.0 { return -1.0; }
    return -b - sqrt(d);
}

fn cubemap_direction(face: u32, uv: vec2<f32>) -> vec3<f32> {
    let s = uv.x * 2.0 - 1.0;
    let t = uv.y * 2.0 - 1.0;
    var dir: vec3<f32>;
    switch face {
        case 0u { dir = vec3<f32>( 1.0, -t, -s); }  // +X
        case 1u { dir = vec3<f32>(-1.0, -t,  s); }  // -X
        case 2u { dir = vec3<f32>( s,  1.0,  t); }  // +Y
        case 3u { dir = vec3<f32>( s, -1.0, -t); }  // -Y
        case 4u { dir = vec3<f32>( s,   -t, 1.0); } // +Z
        default { dir = vec3<f32>(-s,   -t, -1.0); } // -Z
    }
    return normalize(dir);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dims = textureDimensions(output);
    if gid.x >= dims.x || gid.y >= dims.y || gid.z >= 6u { return; }

    let uv = (vec2<f32>(gid.xy) + 0.5) / vec2<f32>(dims.xy);
    let dir = cubemap_direction(gid.z, uv);

    let cam_pos = vec3<f32>(0.0, params.cam_height_km, 0.0);
    let sun_dir = normalize(params.sun_dir);

    let t_atmo = ray_sphere_far(cam_pos, dir, TOP_RADIUS);
    if t_atmo < 0.0 {
        textureStore(output, gid.xy, gid.z, vec4<f32>(0.0));
        return;
    }

    let t_ground = ray_sphere_near(cam_pos, dir, BOTTOM_RADIUS);
    var t_max = t_atmo;
    if t_ground >= 0.0 {
        t_max = t_ground;
    }

    let dt = t_max / f32(NUM_STEPS);
    let cos_theta = dot(dir, sun_dir);
    let rp = rayleigh_phase(cos_theta);
    let mp = hg_phase(cos_theta, MIE_G);

    var inscatter = vec3<f32>(0.0);
    var opt_depth_r = vec3<f32>(0.0);
    var opt_depth_m: f32 = 0.0;

    for (var i = 0u; i < NUM_STEPS; i++) {
        let t = (f32(i) + 0.5) * dt;
        let pos = cam_pos + dir * t;
        let h = length(pos) - BOTTOM_RADIUS;

        let rho_r = exp(-h / RAYLEIGH_SCALE_HEIGHT);
        let rho_m = exp(-h / MIE_SCALE_HEIGHT);

        opt_depth_r += RAYLEIGH_SCATTERING * rho_r * dt;
        opt_depth_m += MIE_EXTINCTION * rho_m * dt;

        let cam_t = exp(-(opt_depth_r + vec3<f32>(opt_depth_m)));

        let sample_h = length(pos);
        let cos_sun = dot(normalize(pos), sun_dir);
        let sun_t = sample_transmittance(sample_h, cos_sun);

        inscatter += sun_t * cam_t * (
            RAYLEIGH_SCATTERING * rho_r * rp +
            vec3<f32>(MIE_SCATTERING * rho_m * mp)
        ) * dt;
    }

    let color = inscatter * params.sun_illuminance;
    textureStore(output, gid.xy, gid.z, vec4<f32>(color, 1.0));
}
