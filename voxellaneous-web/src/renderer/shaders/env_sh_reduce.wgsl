// Reduce environment cubemap to L2 spherical harmonics (9 vec3 coefficients).
// Single workgroup of 256 threads; each thread processes ~96 texels.
// Cosine convolution factors (A_l) are baked into the coefficients so the
// lighting shader can evaluate irradiance directly.

const CUBEMAP_SIZE: u32 = 64u;
const TOTAL_TEXELS: u32 = CUBEMAP_SIZE * CUBEMAP_SIZE * 6u; // 24576
const WG_SIZE: u32 = 256u;

// Cosine-lobe convolution factors per SH band (for irradiance, not radiance)
const A0: f32 = 3.141593;   // pi
const A1: f32 = 2.094395;   // 2*pi/3
const A2: f32 = 0.785398;   // pi/4

@group(0) @binding(0) var env_cubemap: texture_2d_array<f32>;
@group(0) @binding(1) var<storage, read_write> sh_out: array<vec4<f32>, 9>;

var<workgroup> shared_r: array<f32, WG_SIZE>;
var<workgroup> shared_g: array<f32, WG_SIZE>;
var<workgroup> shared_b: array<f32, WG_SIZE>;

fn cubemap_direction(face: u32, uv: vec2<f32>) -> vec3<f32> {
    let s = uv.x * 2.0 - 1.0;
    let t = uv.y * 2.0 - 1.0;
    var dir: vec3<f32>;
    switch face {
        case 0u { dir = vec3<f32>( 1.0, -t, -s); }
        case 1u { dir = vec3<f32>(-1.0, -t,  s); }
        case 2u { dir = vec3<f32>( s,  1.0,  t); }
        case 3u { dir = vec3<f32>( s, -1.0, -t); }
        case 4u { dir = vec3<f32>( s,   -t, 1.0); }
        default { dir = vec3<f32>(-s,   -t, -1.0); }
    }
    return normalize(dir);
}

fn texel_solid_angle(u: f32, v: f32) -> f32 {
    // u, v in [-1, 1] (texel center in face space)
    let tmp = 1.0 + u * u + v * v;
    return 4.0 / (sqrt(tmp) * tmp * f32(CUBEMAP_SIZE) * f32(CUBEMAP_SIZE));
}

fn reduce(tid: u32, val: vec3<f32>, coeff_idx: u32) {
    shared_r[tid] = val.x;
    shared_g[tid] = val.y;
    shared_b[tid] = val.z;
    workgroupBarrier();

    for (var stride = WG_SIZE >> 1u; stride > 0u; stride >>= 1u) {
        if tid < stride {
            shared_r[tid] += shared_r[tid + stride];
            shared_g[tid] += shared_g[tid + stride];
            shared_b[tid] += shared_b[tid + stride];
        }
        workgroupBarrier();
    }

    if tid == 0u {
        sh_out[coeff_idx] = vec4<f32>(shared_r[0], shared_g[0], shared_b[0], 0.0);
    }
    workgroupBarrier();
}

@compute @workgroup_size(256, 1, 1)
fn main(@builtin(local_invocation_index) tid: u32) {
    // Per-thread accumulators for 9 SH coefficients
    var accum: array<vec3<f32>, 9>;

    let texels_per_thread = (TOTAL_TEXELS + WG_SIZE - 1u) / WG_SIZE;
    let start = tid * texels_per_thread;
    let end = min(start + texels_per_thread, TOTAL_TEXELS);

    let face_size = CUBEMAP_SIZE * CUBEMAP_SIZE;
    let inv_size = 1.0 / f32(CUBEMAP_SIZE);

    for (var i = start; i < end; i++) {
        let face = i / face_size;
        let idx = i % face_size;
        let px = idx % CUBEMAP_SIZE;
        let py = idx / CUBEMAP_SIZE;

        let uv = (vec2<f32>(f32(px), f32(py)) + 0.5) * inv_size;
        let dir = cubemap_direction(face, uv);

        // Face-space coords in [-1,1] for solid angle
        let fu = uv.x * 2.0 - 1.0;
        let fv = uv.y * 2.0 - 1.0;
        let d_omega = texel_solid_angle(fu, fv);

        let color = textureLoad(env_cubemap, vec2<u32>(px, py), face, 0).rgb;
        let weighted = color * d_omega;

        // SH basis (real, orthonormal) with cosine convolution baked in
        let d = dir;

        // L=0
        accum[0] += weighted * (0.282095 * A0);
        // L=1
        accum[1] += weighted * (0.488603 * d.y * A1);
        accum[2] += weighted * (0.488603 * d.z * A1);
        accum[3] += weighted * (0.488603 * d.x * A1);
        // L=2
        accum[4] += weighted * (1.092548 * d.x * d.y * A2);
        accum[5] += weighted * (1.092548 * d.y * d.z * A2);
        accum[6] += weighted * (0.315392 * (3.0 * d.z * d.z - 1.0) * A2);
        accum[7] += weighted * (1.092548 * d.x * d.z * A2);
        accum[8] += weighted * (0.546274 * (d.x * d.x - d.y * d.y) * A2);
    }

    // Reduce each coefficient across the workgroup
    for (var c = 0u; c < 9u; c++) {
        reduce(tid, accum[c], c);
    }
}
