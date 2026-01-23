# Rust -> TypeScript Migration Plan (WASM -> pure TS)

Below is a step-by-step plan and specific entry points that need to be rewritten.

---

## 1) Current dependency map

- Frontend (`voxellaneous-web`) imports the WASM package `voxellaneous-core` and uses its `Renderer`.
- `voxellaneous-core` is the Rust rendering core with WebGPU (`wgpu`), built with `wasm-pack`.
- The main frontend entry point is `voxellaneous-web/src/main.ts`.

Migration goal: remove Rust/WASM, move render logic to TS (WebGPU or another backend), and keep a single TS project.

---

## 2) Specific entry points to rewrite (minimum)

### In `voxellaneous-web`
1) `voxellaneous-web/src/main.ts`
   - Current:
     - `import init, { Renderer } from 'voxellaneous-core';`
     - `await init({});`
     - `const renderer = await Renderer.new(canvas);`
     - `renderer.upload_scene(scene);`
     - `renderer.render(...)` and `renderer.resize(...)`
   - Replace with a pure TS renderer implementation.

2) `voxellaneous-web/src/scene.ts`
   - The `Scene` interface is used as the data contract between TS and Rust.
   - Keep/adapt it for the new TS renderer.

3) `voxellaneous-web/src/renderer/editor.ts`
   - UI tools for switching render targets/buffers depend on `Renderer` (presentTarget, etc.).
   - Update bindings/types for the new TS renderer.

4) `voxellaneous-web/package.json`
   - Remove dependency on `"voxellaneous-core": "file:../voxellaneous-core/pkg"`.


### In `voxellaneous-core` (logic to port)
What must be reimplemented in TS functionally:

1) `voxellaneous-core/src/lib.rs`
   - Essentially the entire renderer:
     - WebGPU device initialization
     - Pipeline and buffer creation
     - `Renderer::new(...)`
     - `Renderer::render(...)`
     - `Renderer::upload_scene(...)`
     - `Renderer::resize(...)`
   - In TS, this becomes a `Renderer` class/module.

2) `voxellaneous-core/src/scene.rs`
   - Rust scene types (mirror `voxellaneous-web/src/scene.ts`).
   - Port scene data loading logic (palette, voxels).

3) `voxellaneous-core/src/shaders/*.wgsl`
   - Shaders can be kept (already WebGPU/WGSL).
   - Move loading/compilation to TS.

---

## 3) Migration plan (recommended sequence)

### Stage 0 - preparation
- Pin current version and startup flow (what works today).
- Ensure `voxellaneous-web` runs and renders the scene.

### Stage 1 - break Rust dependency
- Remove wasm initialization from `main.ts`.
- Introduce a temporary TS Renderer with the same API:
  - `new(canvas)`
  - `render(mvp, cameraPos, presentTarget)`
  - `resize(w, h)`
  - `upload_scene(scene)`
- This stage can be a stub as long as the app runs without Rust.

### Stage 2 - port rendering to TS WebGPU
- Implement WebGPU initialization in TS.
- Port:
  - surface/context creation
  - pipelines
  - buffers
  - WGSL shader loading
- Run a minimal pass (e.g., full-screen quad) to confirm rendering works.

### Stage 3 - port scene logic
- Port `upload_scene`:
  - palette upload
  - voxel 3D texture upload
- Important: handle `bytes_per_row` requirements and proper padding.

### Stage 4 - full render
- Port render loop logic from Rust:
  - G-Buffer passes
  - present pass
- Match current behavior.

### Stage 5 - repo cleanup
- Remove `voxellaneous-core/` entirely (or archive it).
- Remove all `wasm-pack` references from docs.
- Ensure no references to `voxellaneous-core/pkg` remain.

---

## 4) API surface to keep (or replace)

The frontend currently expects these signatures:

- `Renderer.new(canvas: HTMLCanvasElement): Promise<Renderer>`
- `renderer.render(mvp: Float32Array, cameraPos: Float32Array, presentTarget: number): void`
- `renderer.resize(width: number, height: number): void`
- `renderer.upload_scene(scene: Scene): void`

In the TS version, you can keep these signatures to avoid rewriting the frontend.

---

## 5) Quick file list

- `voxellaneous-web/src/main.ts` - remove wasm init, plug in TS renderer
- `voxellaneous-web/src/scene.ts` - keep/adapt scene interfaces
- `voxellaneous-web/src/renderer/*` - some UI logic depends on Renderer
- `voxellaneous-web/package.json` - remove wasm dependency

- `voxellaneous-core/src/lib.rs` - port functionality to TS
- `voxellaneous-core/src/scene.rs` - scene types/structures
- `voxellaneous-core/src/shaders/*.wgsl` - use in TS

---

## 6) Proposed TS renderer structure

```
voxellaneous-web/src/renderer/
  Renderer.ts
  gpu/
    device.ts
    pipelines.ts
    textures.ts
    buffers.ts
  shaders/
    shader.wgsl
    quad_uint.wgsl
    quad_float.wgsl
```

---

If you want, I can:
- refine entry points after a deeper code review;
- prepare a skeleton TS Renderer with WebGPU;
- start porting step by step.
