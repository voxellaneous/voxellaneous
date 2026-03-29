struct VertexInput {
    @location(0) position: vec3<f32>,
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) obj_pos: vec3<f32>,
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

@group(1) @binding(0) var heightmap_texture: texture_2d<u32>;

struct GBuffer {
    @location(0) albedo:    vec4<f32>,
    @location(1) normal:    vec4<f32>,
    @builtin(frag_depth) depth: f32,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    let ws4 = u_draw.model_matrix * vec4<f32>(in.position, 1.0);
    out.position = u_frame.vp_matrix * ws4;
    out.obj_pos = in.position;
    return out;
}

const HEIGHTMAP_MAX_STEPS: u32 = 128u;

@fragment
fn fs_main(in: VertexOutput) -> GBuffer {
    let cam_os = (u_draw.inv_model_matrix * vec4<f32>(u_frame.cam_pos_ws, 1.0)).xyz;
    let dir_os = normalize(in.obj_pos - cam_os);

    // Heightmap is NxN; Y extent may differ from XZ (non-cubic bounding box).
    // Derive ratio from model matrix so texel heights map to shader Y space.
    let hm_dims = textureDimensions(heightmap_texture, 0);
    let chunk_size = f32(hm_dims.x);
    let dims_f = vec3<f32>(chunk_size);
    let scale_xz = length(u_draw.model_matrix[0].xyz);
    let scale_y  = length(u_draw.model_matrix[1].xyz);
    let y_ratio  = scale_xz / scale_y; // chunk_size / numYVoxels

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
    let t_nudge = 1e-4;
    let ray_start_os = cam_os + (t + t_nudge) * dir_os;
    let bound_eps = 1e-4;
    let clamped_os = clamp(ray_start_os, vec3<f32>(-0.5 + bound_eps), vec3<f32>(0.5 - bound_eps));

    // Convert to voxel space [0, chunk_size)
    var ray_voxel = (clamped_os + vec3<f32>(0.5)) * dims_f;
    ray_voxel = clamp(ray_voxel, vec3<f32>(0.001), dims_f - vec3<f32>(0.001));

    // 2D DDA setup (X and Z only)
    var voxel_x = i32(floor(ray_voxel.x));
    var voxel_z = i32(floor(ray_voxel.z));

    let step_x = select(-1, 1, dir_os.x >= 0.0);
    let step_z = select(-1, 1, dir_os.z >= 0.0);

    let dir_voxel = safe_dir * dims_f;

    let next_bound_x = select(f32(voxel_x), f32(voxel_x) + 1.0, safe_dir.x >= 0.0);
    let next_bound_z = select(f32(voxel_z), f32(voxel_z) + 1.0, safe_dir.z >= 0.0);

    var t_max_x = (next_bound_x - ray_voxel.x) / dir_voxel.x;
    var t_max_z = (next_bound_z - ray_voxel.z) / dir_voxel.z;

    let t_delta_x = abs(1.0 / dir_voxel.x);
    let t_delta_z = abs(1.0 / dir_voxel.z);

    // Determine entry axis
    let entry_t = vec3<f32>(min(tmin.x, tmax.x), min(tmin.y, tmax.y), min(tmin.z, tmax.z));
    var last_axis = 0; // 0=X, 1=Y, 2=Z
    if entry_t.y > entry_t.x && entry_t.y > entry_t.z {
        last_axis = 1;
    } else if entry_t.z > entry_t.x {
        last_axis = 2;
    }

    var hit = false;
    var hit_pos_os = vec3<f32>(0.0);
    var hit_normal = vec3<f32>(0.0);
    var hit_biome_idx = 0u;

    let dims_i = i32(chunk_size);
    let voxel_size = 1.0 / dims_f;
    var t_current = 0.0;

    for (var i = 0u; i < HEIGHTMAP_MAX_STEPS; i = i + 1u) {
        if voxel_x < 0 || voxel_x >= dims_i || voxel_z < 0 || voxel_z >= dims_i {
            break;
        }

        // RG texture: R = voxel height, G = biome palette index
        let texel = textureLoad(heightmap_texture, vec2<u32>(u32(voxel_x), u32(voxel_z)), 0);
        let h = f32(texel.r) * y_ratio;
        let t_col_exit = min(t_max_x, t_max_z);

        if h > 0.0 {
            let y_at_entry = ray_voxel.y + t_current * dir_voxel.y;

            // Case 1: Ray enters column below terrain height (side or Y-face hit)
            if y_at_entry < h && y_at_entry >= 0.0 {
                hit = true;
                hit_biome_idx = texel.g;
                let pos = ray_voxel + t_current * dir_voxel;
                hit_pos_os = pos / dims_f - vec3<f32>(0.5);

                if last_axis == 0 {
                    hit_normal = vec3<f32>(-f32(step_x), 0.0, 0.0);
                } else if last_axis == 2 {
                    hit_normal = vec3<f32>(0.0, 0.0, -f32(step_z));
                } else {
                    // Entered from Y face
                    hit_normal = select(vec3<f32>(0.0, -1.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), dir_os.y < 0.0);
                }
                break;
            }

            // Case 2: Top/bottom face hit - ray crosses y = h
            if abs(dir_voxel.y) > eps {
                let t_top = (h - ray_voxel.y) / dir_voxel.y;
                if t_top >= t_current && t_top <= t_col_exit {
                    let pos = ray_voxel + t_top * dir_voxel;
                    let check_x = i32(floor(clamp(pos.x, 0.0, chunk_size - 0.001)));
                    let check_z = i32(floor(clamp(pos.z, 0.0, chunk_size - 0.001)));
                    if check_x == voxel_x && check_z == voxel_z {
                        hit = true;
                        hit_biome_idx = texel.g;
                        hit_pos_os = pos / dims_f - vec3<f32>(0.5);
                        hit_normal = select(vec3<f32>(0.0, -1.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), dir_os.y < 0.0);
                        break;
                    }
                }
            }

            // Case 3: Ray enters from above into fully solid column (y_at_entry >= h already checked)
            // handled by case 2
        }

        // Step to next column
        t_current = t_col_exit;
        if t_max_x < t_max_z {
            voxel_x += step_x;
            t_max_x += t_delta_x;
            last_axis = 0;
        } else {
            voxel_z += step_z;
            t_max_z += t_delta_z;
            last_axis = 2;
        }
    }

    if !hit {
        discard;
    }

    let hit_pos_ws = (u_draw.model_matrix * vec4<f32>(hit_pos_os, 1.0)).xyz;

    let packed = u_draw.palette[hit_biome_idx / 4u][hit_biome_idx % 4u];
    let albedo = unpack4x8unorm(packed);

    let hit_clip = u_frame.vp_matrix * vec4<f32>(hit_pos_ws, 1.0);
    let frag_depth = clamp(hit_clip.z / hit_clip.w, 0.0, 1.0);

    return GBuffer(
        albedo,
        vec4<f32>(hit_normal * 0.5 + 0.5, 1.0),
        frag_depth
    );
}
