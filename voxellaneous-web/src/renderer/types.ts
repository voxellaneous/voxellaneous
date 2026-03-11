/**
 * TypeScript interfaces for WebGPU uniform buffers
 * These match the WGSL shader struct layouts exactly
 */

/**
 * Per-frame uniforms (80 bytes)
 * Layout: mat4(64) + vec3(12) + padding(4)
 */
export interface PerFrameUniforms {
  vpMatrix: Float32Array; // 16 floats = 64 bytes
  cameraPosition: Float32Array; // 3 floats = 12 bytes
  // 4 bytes padding implicit
}

/**
 * Static uniforms (1024 bytes)
 * Layout: u32[256] color palette
 */
export interface StaticUniforms {
  colorPalette: Uint32Array; // 256 u32s = 1024 bytes
}

/**
 * Per-draw uniforms (128 bytes)
 * Layout: mat4(64) + mat4(64)
 */
export interface PerDrawUniforms {
  modelMatrix: Float32Array; // 16 floats = 64 bytes
  inverseModelMatrix: Float32Array; // 16 floats = 64 bytes
}

/**
 * Lighting uniforms (32 bytes)
 * Layout: vec3(12) + f32(4) + f32(4) + padding(12)
 */
export interface LightingUniforms {
  lightDir: Float32Array; // 3 floats = 12 bytes
  ambient: number; // 4 bytes
  lightIntensity: number; // 4 bytes
  // 12 bytes padding implicit
}

/**
 * Draw call data containing GPU resources for a single voxel object
 */
export interface DrawCallData {
  bindGroup: GPUBindGroup;
  texture: GPUTexture;
  textureView: GPUTextureView;
  uniformBuffer: GPUBuffer;
}

// Re-export Scene types from the main scene module for compatibility
export type { Scene, VoxelObject as SceneObject, RGBA } from '../scene';

/**
 * GPU adapter info for debugging
 */
export interface GPUAdapterInfo {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
}

// Uniform buffer sizes in bytes
export const UNIFORM_SIZES = {
  PER_FRAME: 80,
  PER_DRAW: 1152,  // 128 (matrices) + 1024 (palette)
  LIGHTING: 32,
} as const;
