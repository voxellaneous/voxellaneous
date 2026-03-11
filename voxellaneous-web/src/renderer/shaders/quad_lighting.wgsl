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
    fog_density:        f32,
    fog_height_falloff: f32,
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

@group(0) @binding(0) var albedo_tex: texture_2d<f32>;
@group(0) @binding(1) var normal_tex: texture_2d<f32>;
@group(0) @binding(2) var u_samp: sampler;
@group(0) @binding(3) var<uniform> u_lighting: LightingUniforms;
@group(0) @binding(4) var depth_tex: texture_depth_2d;

// Quilez-style exponential height fog with directional inscattering
// https://iquilezles.org/articles/fog/
fn apply_fog(
    color: vec3<f32>,
    dist: f32,
    ray_dir: vec3<f32>,
    cam_y: f32,
    sun_dir: vec3<f32>,
    sun_intensity: f32,
) -> vec3<f32> {
    let a = u_lighting.fog_density;
    let b = u_lighting.fog_height_falloff;

    // Closed-form integral of a*exp(-b*y) along the view ray
    let cam_factor = a * exp(-b * cam_y);
    let b_rd_y = b * ray_dir.y;

    var optical_depth: f32;
    if abs(b_rd_y) < 1e-7 {
        // Near-horizontal ray: use limit form (L'Hopital)
        optical_depth = cam_factor * dist;
    } else {
        optical_depth = (cam_factor / b_rd_y) * (1.0 - exp(-b_rd_y * dist));
    }

    let extinction = exp(-max(optical_depth, 0.0));

    // Directional inscattering (warm near sun, cool elsewhere)
    let sun_amount = max(dot(ray_dir, sun_dir), 0.0);
    let sun_cutoff = select(1.0, 1.0, dot(sun_dir, vec3<f32>(0, 1, 0)) > 0.0);
    let fog_color = sun_cutoff * mix(
        vec3<f32>(0.5, 0.6, 0.7),
        vec3<f32>(1.0, 0.9, 0.7),
        pow(sun_amount, 8.0)
    );

    // Scale inscattering by sun intensity to stay in HDR range
    let inscatter = fog_color * sun_intensity * 0.1;
    return color * extinction + inscatter * (1.0 - extinction);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    let dims = textureDimensions(albedo_tex, 0);
    let coord = vec2<i32>(
        i32(in.uv.x * f32(dims.x)),
        i32((1.0 - in.uv.y) * f32(dims.y))
    );

    let albedo = textureLoad(albedo_tex, coord, 0);
    let normal_encoded = textureLoad(normal_tex, coord, 0);

    // Black for sky pixels — atmosphere library renders on top
    if all(normal_encoded.rgb == vec3<f32>(0.0)) {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }

    // Decode normal from [0,1] to [-1,1]
    let normal = normalize(normal_encoded.rgb * 2.0 - 1.0);
    let light_dir = normalize(u_lighting.light_dir);

    // N dot L shading
    let ndotl = max(dot(normal, light_dir), 0.0);
    let diffuse = ndotl * (u_lighting.light_intensity * 0.1);
    let lighting = u_lighting.ambient + diffuse;
    let lit_color = albedo.rgb * lighting;

    // Reconstruct world position from depth buffer + inverse VP
    let depth = textureLoad(depth_tex, coord, 0);
    let ndc = vec4<f32>(
        in.uv.x * 2.0 - 1.0,
        in.uv.y * 2.0 - 1.0,
        depth,
        1.0
    );
    let world_h = u_lighting.inverse_vp * ndc;
    let world_pos = world_h.xyz / world_h.w;

    let to_surface = world_pos - u_lighting.cam_pos_ws;
    let dist = length(to_surface);
    let ray_dir = to_surface / dist;

    let fogged = apply_fog(
        lit_color, dist, ray_dir,
        u_lighting.cam_pos_ws.y,
        light_dir, u_lighting.light_intensity,
    );

    return vec4<f32>(fogged, 1.0);
}
