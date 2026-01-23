struct VSOut {
    @builtin(position) Position: vec4<f32>,
    @location(0)       uv:       vec2<f32>,
};

struct LightingUniforms {
    light_dir: vec3<f32>,
    ambient:   f32,
    light_intensity: f32,
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

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    let dims = textureDimensions(albedo_tex, 0);
    let coord = vec2<i32>(
        i32(in.uv.x * f32(dims.x)),
        i32((1.0 - in.uv.y) * f32(dims.y))
    );

    let albedo = textureLoad(albedo_tex, coord, 0);
    let normal_encoded = textureLoad(normal_tex, coord, 0);

    // Skip pixels with no geometry (normal = 0)
    if all(normal_encoded.rgb == vec3<f32>(0.0)) {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }

    // Decode normal from [0,1] to [-1,1]
    let normal = normalize(normal_encoded.rgb * 2.0 - 1.0);

    // Normalize light direction (should already be normalized, but just in case)
    let light_dir = normalize(u_lighting.light_dir);

    // N dot L shading with intensity
    let ndotl = max(dot(normal, light_dir), 0.0);
    let diffuse = ndotl * u_lighting.light_intensity;

    // Combine ambient and diffuse
    let lighting = u_lighting.ambient + diffuse;

    // Apply lighting to albedo
    let lit_color = albedo.rgb * lighting;

    return vec4<f32>(lit_color, 1.0);
}
