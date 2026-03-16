struct SunParams {
    uv:     vec2<f32>,
    weight: f32,
    dt:     f32,
    speed:  f32,
};

@group(0) @binding(0) var depth_tex: texture_depth_2d;
@group(0) @binding(1) var<uniform> params: SunParams;
@group(0) @binding(2) var<storage, read_write> result: array<f32, 1>;

var<workgroup> counts: array<u32, 256>;

@compute @workgroup_size(16, 16)
fn main(@builtin(local_invocation_id) lid: vec3<u32>,
        @builtin(local_invocation_index) idx: u32) {

    var my_count = 0u;

    if params.weight > 0.0 {
        let dims = textureDimensions(depth_tex, 0);
        let center = vec2<i32>(
            i32(params.uv.x * f32(dims.x)),
            i32((1.0 - params.uv.y) * f32(dims.y))
        );

        // Each thread samples a 2x2 block → 32x32 = 1024 total samples
        for (var dy = 0; dy < 2; dy++) {
            for (var dx = 0; dx < 2; dx++) {
                let px = i32(lid.x) * 2 + dx - 16;
                let py = i32(lid.y) * 2 + dy - 16;
                let c = clamp(center + vec2<i32>(px, py), vec2<i32>(0), vec2<i32>(dims) - 1);
                let d = textureLoad(depth_tex, c, 0);
                if d > 0.0 { my_count++; }
            }
        }
    }

    counts[idx] = my_count;
    workgroupBarrier();

    // Parallel reduction
    for (var stride = 128u; stride > 0u; stride >>= 1u) {
        if idx < stride {
            counts[idx] += counts[idx + stride];
        }
        workgroupBarrier();
    }

    if idx == 0u {
        let raw = f32(counts[0]) / 1024.0 * params.weight;
        let prev = result[0];
        // FPS-independent exponential decay (~1s for 95% transition)
        result[0] = mix(prev, raw, 1.0 - exp(-params.speed * params.dt));
    }
}
