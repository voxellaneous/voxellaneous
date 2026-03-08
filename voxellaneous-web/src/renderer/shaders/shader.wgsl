struct VertexInput {
    @location(0) position: vec3<f32>,  // in object space [-0.5,0.5]^3
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) obj_pos: vec3<f32>,   // object-space position on bbox surface
};

struct PerFrameUniforms {
    vp_matrix:  mat4x4<f32>,
    cam_pos_ws: vec3<f32>,
    _padding:   f32,
};
@group(0) @binding(0) var<uniform> u_frame: PerFrameUniforms;

struct PerDrawUniforms {
    model_matrix:     mat4x4<f32>,
    inv_model_matrix: mat4x4<f32>,
    palette:          array<vec4<u32>, 64>,
};
@group(1) @binding(1) var<uniform> u_draw: PerDrawUniforms;

@group(1) @binding(0) var voxel_texture: texture_3d<u32>;

// G‑buffer outputs: albedo, normal, linear depth, and explicit fragment depth
struct GBuffer {
    @location(0) albedo:    vec4<f32>, // Rgba8Unorm
    @location(1) normal:    vec4<f32>, // Rgba8Unorm encoded
    @location(2) linear_z:  u32,       // R16Uint
    @builtin(frag_depth) depth: f32,   // Correct depth for raymarched hit point
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    let ws4 = u_draw.model_matrix * vec4<f32>(in.position, 1.0);
    out.position = u_frame.vp_matrix * ws4;
    out.obj_pos = in.position;  // Pass object-space position directly
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> GBuffer {
    // Transform camera position to object space
    let cam_os = (u_draw.inv_model_matrix * vec4<f32>(u_frame.cam_pos_ws, 1.0)).xyz;
    // Ray direction from camera to this point on the bbox surface (in object space)
    let dir_os = normalize(in.obj_pos - cam_os);

    let dims = vec3<u32>(textureDimensions(voxel_texture, 0));
    let dims_f = vec3<f32>(dims);
    // Protect against division by zero for rays nearly parallel to axes
    let eps = 1e-8;
    let dir_sign = select(vec3<f32>(-1.0), vec3<f32>(1.0), dir_os >= vec3<f32>(0.0));
    let safe_dir = select(dir_os, dir_sign * eps, abs(dir_os) < vec3<f32>(eps));
    let inv_dir = 1.0 / safe_dir;

    let bounds_min = vec3<f32>(-0.5);
    let bounds_max = vec3<f32>(0.5);
    let tmin = (bounds_min - cam_os) * inv_dir;
    let tmax = (bounds_max - cam_os) * inv_dir;

    let t_entry = max(max(min(tmin.x, tmax.x), min(tmin.y, tmax.y)), min(tmin.z, tmax.z));
    let t_exit  = min(min(max(tmin.x, tmax.x), max(tmin.y, tmax.y)), max(tmin.z, tmax.z));

    if t_exit < 0.0 || t_entry > t_exit {
        discard;
    }

    var t = max(t_entry, 0.0);
    // Small epsilon to nudge ray past entry point
    let t_nudge = 1e-4;
    let ray_start_os = cam_os + (t + t_nudge) * dir_os;
    // Clamp to strictly inside bounds
    let bound_eps = 1e-4;
    let clamped_os = clamp(ray_start_os, vec3<f32>(-0.5 + bound_eps), vec3<f32>(0.5 - bound_eps));
    // Convert to voxel space [0, dims) and clamp to valid range
    var ray_voxel = (clamped_os + vec3<f32>(0.5)) * dims_f;
    ray_voxel = clamp(ray_voxel, vec3<f32>(0.001), dims_f - vec3<f32>(0.001));
    // Initial voxel
    var voxel = vec3<i32>(floor(ray_voxel));
    // Step direction: +1 or -1 based on ray direction (never 0)
    let step = vec3<i32>(select(vec3<i32>(-1), vec3<i32>(1), dir_os >= vec3<f32>(0.0)));
    // DDA in voxel space - use safe_dir to avoid division by zero
    let dir_voxel = safe_dir * dims_f;
    let inv_dir_voxel = 1.0 / dir_voxel;
    // Compute distance to next voxel boundary for each axis
    let voxel_f = vec3<f32>(voxel);
    let next_boundary = select(voxel_f, voxel_f + 1.0, safe_dir >= vec3<f32>(0.0));
    var t_max = (next_boundary - ray_voxel) * inv_dir_voxel;
    let t_delta = abs(inv_dir_voxel);

    var hit_idx = 0u;
    var hit_voxel = vec3<u32>(0u);
    var hit_t = 0.0;
    var hit_normal = vec3<f32>(0.0);

    // Determine initial entry axis from box intersection
    let entry_t = vec3<f32>(min(tmin.x, tmax.x), min(tmin.y, tmax.y), min(tmin.z, tmax.z));
    var last_axis = 0;
    if entry_t.y > entry_t.x && entry_t.y > entry_t.z {
        last_axis = 1;
    } else if entry_t.z > entry_t.x {
        last_axis = 2;
    }

    let MAX_STEPS = 2048u;
    for (var i = 0u; i < MAX_STEPS; i = i + 1u) {
        if any(voxel < vec3<i32>(0)) || any(voxel >= vec3<i32>(dims)) {
            break;
        }

        let coord = vec3<u32>(voxel);
        let idx = textureLoad(voxel_texture, coord, 0).r;

        if idx != 0u {
            hit_idx = idx;
            hit_voxel = coord;
            hit_t = t;

            if last_axis == 0 {
                hit_normal = vec3<f32>(-f32(step.x), 0.0, 0.0);
            } else if last_axis == 1 {
                hit_normal = vec3<f32>(0.0, -f32(step.y), 0.0);
            } else {
                hit_normal = vec3<f32>(0.0, 0.0, -f32(step.z));
            }

            break;
        }

        if t_max.x < t_max.y && t_max.x < t_max.z {
            voxel.x += step.x;
            t += t_max.x;
            t_max.x += t_delta.x;
            last_axis = 0;
        } else if t_max.y < t_max.z {
            voxel.y += step.y;
            t += t_max.y;
            t_max.y += t_delta.y;
            last_axis = 1;
        } else {
            voxel.z += step.z;
            t += t_max.z;
            t_max.z += t_delta.z;
            last_axis = 2;
        }
    }

    if hit_idx == 0u {
        discard;
    }

    // Compute hit position from voxel coordinates
    // Convert hit_voxel [0, dims) to object space [-0.5, 0.5]
    // hit_normal points outward from the voxel face (toward camera)
    // Surface hit point = voxel center + 0.5 * voxel_size in normal direction
    let voxel_size = 1.0 / dims_f;
    let voxel_center_os = (vec3<f32>(hit_voxel) + 0.5) * voxel_size - vec3<f32>(0.5);
    let hit_pos_os = voxel_center_os + hit_normal * 0.5 * voxel_size;
    let hit_pos_ws = (u_draw.model_matrix * vec4<f32>(hit_pos_os, 1.0)).xyz;

    let packed = u_draw.palette[hit_idx / 4u][hit_idx % 4u];
    let albedo = unpack4x8unorm(packed);

    let linear_z = length(hit_pos_ws - u_frame.cam_pos_ws);

    // Compute correct fragment depth from hit position in world space
    // Transform hit_pos_ws to clip space using VP matrix
    let hit_clip = u_frame.vp_matrix * vec4<f32>(hit_pos_ws, 1.0);
    // Reverse-Z: projection matrix already swaps near/far, so near objects get ~1.0, far ~0.0
    // Just do perspective divide, matrix handles the inversion
    let frag_depth = clamp(hit_clip.z / hit_clip.w, 0.0, 1.0);

    return GBuffer(
        albedo,
        vec4<f32>(hit_normal * 0.5 + 0.5, 1.0),
        u32(clamp(linear_z / 100.0, 0.0, 1.0) * 65535.0),
        frag_depth
    );
}
