# Voxellaneous Report (EN)

## Overview
The repository is split into two parts:

- `voxellaneous-core/` - rendering core in Rust -> WASM using `wgpu`.
- `voxellaneous-web/` - web frontend on Vite + TypeScript that boots the renderer, builds the scene, and provides GUI.

### Build/run
- Core (WASM): `wasm-pack build --target web`
- Web: `npm install`, `npm run dev`

### Data flow
- TS creates a `Scene` (palette + objects) and calls `renderer.upload_scene(scene)`.
- Rust packs the palette into a uniform and uploads voxels into 3D textures per object.
- The render loop writes per-frame uniforms, draws the G-Buffer, then presents the selected target via a full-screen pass.

## Current issues / risks

### 1) 3D texture upload violates `bytes_per_row`
**Where**: `voxellaneous-core/src/lib.rs` in `upload_scene`, `queue.write_texture(...)`.

**Why**: WebGPU requires `bytes_per_row` to be a multiple of 256. The code uses `bytes_per_row: Some(nx)` where `nx` is the voxel width. In the demo scene sizes 10/80/100 are not multiples of 256.

**Effect**: Upload can be rejected by the driver or produce incorrect rendering.

**Fix**: Pad rows to 256 bytes and upload via a staging buffer (or `copy_buffer_to_texture`).

---

### 2) Depth buffer presentation is incorrect
**Where**:
- `voxellaneous-core/src/lib.rs` (depth creation and present pass).
- `voxellaneous-core/src/shaders/quad_float.wgsl`.

**Why**:
- Depth texture is created only with `RENDER_ATTACHMENT` but later sampled, which requires `TEXTURE_BINDING`.
- Depth cannot be correctly sampled as `texture_2d<f32>` with a regular sampler.

**Effect**: With `presentTarget = 3` you get a validation error or black screen.

**Fix**: Create a dedicated depth pipeline (`texture_2d_depth` + comparison sampler) or copy depth into a float texture before showing. Update usage flags.

---

### 3) Ray-march step limit may be too low
**Where**: `voxellaneous-core/src/shaders/shader.wgsl`, `MAX_STEPS = 256`.

**Why**: Diagonal rays in volumes around ~100^3 can require more than 256 steps. This causes early exit and missing geometry.

**Effect**: Visual artifacts at some camera angles.

**Fix**: Increase the limit or compute a reasonable upper bound based on volume size and ray direction.

---

### 4) Camera speed depends on FPS
**Where**: `voxellaneous-web/src/camera.ts`.

**Why**: Moving a fixed amount per frame makes speed vary across machines.

**Effect**: Unstable and unpredictable movement speed.

**Fix**: Multiply speed by delta time (seconds between frames).

---

### 5) Bind-group allocations every frame
**Where**: `voxellaneous-core/src/lib.rs`, `render()`.

**Why**: `per_frame_bind_group` and `quad_bind` are created every frame, causing extra allocations.

**Effect**: Unnecessary load and potential FPS drop on weaker systems.

**Fix**: Cache bind-groups and only update buffers.

---

### 6) No scene data consistency checks
**Where**: `voxellaneous-core/src/lib.rs` in `upload_scene`.

**Why**: There is no validation that `voxels.len()` matches `dims`, or that palette indices are valid.

**Effect**: Incorrect uploads and rendering errors.

**Fix**: Add validation before upload and return an error to JS.

---

### 7) Potential palette layout mismatch risk
**Where**:
- `voxellaneous-core/src/lib.rs`: `StaticUniforms { color_palette: [u32; 256] }`.
- `voxellaneous-core/src/shaders/shader.wgsl`: `palette: array<vec4<u32>, 64>`.

**Why**: Size matches (64x4=256) but depends on alignment and packing rules.

**Effect**: Possible color corruption if the struct changes.

**Fix**: Document the layout or adjust host data to `vec4<u32>` structure.

---

### 8) No automated tests
**Where**: whole repository.

**Why**: No tests/CI to catch regressions in the scene or renderer.

**Effect**: Bugs are discovered only manually.

**Fix**: Add minimal tests for scene generation and data consistency.

## Module quick overview

### `voxellaneous-core/`
- `Renderer` creates device/surface, G-Buffer, pipeline and renders objects.
- Voxel objects are rendered via ray-march in `shader.wgsl`.
- `quad_float.wgsl` and `quad_uint.wgsl` present the selected target to the screen.

### `voxellaneous-web/`
- `main.ts` boots WASM, creates the camera, starts the rAF loop.
- `camera.ts` implements pointer-lock controls.
- `editor.ts` + `renderer/editor.ts` provide UI for selecting G-Buffer targets and inspecting GPU data.
- `tests/cornell-box.ts` generates a test scene (Cornell box).

### `ai-development-framework/`
- Strictly governs the development process with stages and logging.

## Additional notes
- `README.md` is minimal and assumes manual build steps.
- The Vite config extends access to the repo root to load local WASM.
