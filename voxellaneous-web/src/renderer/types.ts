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
  PER_DRAW: 1152, // 128 (matrices) + 1024 (palette)
  LIGHTING: 112,
} as const;

/** Quality settings that differ between desktop and mobile. */
export interface QualityPreset {
  /** Max DDA steps for voxel raymarching (desktop: 2048, mobile: 512) */
  voxelMaxSteps: number;
  /** Max DDA steps for heightmap raymarching (desktop: 128, mobile: 64) */
  heightmapMaxSteps: number;
  /** Resolution scale for shadow buffer (1.0 = full, 0.5 = half) */
  effectScale: number;
  /** Shadow sample counts per tier [close, near, mid, far] */
  shadowSamples: [number, number, number, number];
  /** Shadow step sizes per tier [close, near, mid, far] */
  shadowSteps: [number, number, number, number];
  /** Shadow resolution scale relative to effectScale (0.5 = half-res + bilateral upsample, 1.0 = full) */
  shadowScale: number;
  /** Max concurrent chunk generation requests (desktop: 64, mobile: 16) */
  maxPendingChunkRequests: number;
  /** LOD level render distances — fewer/shorter on mobile */
  lodLevels: number[];
}

export const DESKTOP_QUALITY: QualityPreset = {
  voxelMaxSteps: 2048,
  heightmapMaxSteps: 128,
  effectScale: 1.0,
  shadowSamples: [8, 14, 32, 32],
  shadowSteps: [8, 32, 128, 512],
  shadowScale: 1.0,
  maxPendingChunkRequests: 64,
  lodLevels: [8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192],
};

export const MOBILE_QUALITY: QualityPreset = {
  voxelMaxSteps: 256,
  heightmapMaxSteps: 128,
  effectScale: 1.0,
  shadowSamples: [4, 4, 8, 8],
  shadowSteps: [16, 64, 512, 1024],
  shadowScale: 0.5,
  maxPendingChunkRequests: 16,
  lodLevels: [8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192],
};

export function isMobileDevice(): boolean {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1;
}
