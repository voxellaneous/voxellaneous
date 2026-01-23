import { mat4 } from 'gl-matrix';
import { loadGLTF, loadGLTFFromFolder } from './gltf-loader';
import { voxelizeMeshes } from './voxelizer';
import { mapColorsToPalette } from './palette-mapper';
import { ConversionResult, VoxelizationConfig, VoxelExportFormat } from './types';
import { VoxelObject, Scene } from '../scene';

export type { VoxelizationConfig, ConversionResult, VoxelExportFormat } from './types';

/**
 * Converts a GLTF/GLB folder to voxel data (supports external .bin and textures)
 */
export async function convertGLTFFromFolder(
  files: FileList,
  config: VoxelizationConfig
): Promise<ConversionResult> {
  const startTime = performance.now();

  // Load and parse GLTF from folder
  const { meshes, boundingBox, fileName } = await loadGLTFFromFolder(files);

  // Count triangles
  const triangles = meshes.reduce((sum, m) => sum + m.indices.length / 3, 0);

  // Voxelize meshes
  const voxelData = voxelizeMeshes(meshes, boundingBox, config);

  // Map colors to palette
  const { voxels, palette, quantized, uniqueColors } = mapColorsToPalette(voxelData);

  const endTime = performance.now();

  // Create VoxelObject with proper scale to be visible
  const dims: [number, number, number] = [config.resolution, config.resolution, config.resolution];
  const modelMatrix = mat4.create();
  // Scale to match resolution so each voxel is 1 unit
  mat4.scale(modelMatrix, modelMatrix, [config.resolution, config.resolution, config.resolution]);
  // Center the object
  mat4.translate(modelMatrix, modelMatrix, [-0.5, -0.5, -0.5]);
  const invModelMatrix = mat4.invert(mat4.create(), modelMatrix)!;

  const object: VoxelObject = {
    id: fileName.replace(/\.[^.]+$/, ''),
    dims,
    model_matrix: modelMatrix,
    inv_model_matrix: invModelMatrix,
    voxels,
  };

  return {
    object,
    palette,
    stats: {
      triangles,
      voxels: voxelData.voxelColors.size,
      timeMs: endTime - startTime,
      uniqueColors,
      quantized,
    },
  };
}

/**
 * Converts a GLTF/GLB file to voxel data
 */
export async function convertGLTFToVoxels(file: File, config: VoxelizationConfig): Promise<ConversionResult> {
  const startTime = performance.now();

  // Load and parse GLTF file
  const { meshes, boundingBox } = await loadGLTF(file);

  // Count triangles
  const triangles = meshes.reduce((sum, m) => sum + m.indices.length / 3, 0);

  // Voxelize meshes
  const voxelData = voxelizeMeshes(meshes, boundingBox, config);

  // Map colors to palette
  const { voxels, palette, quantized, uniqueColors } = mapColorsToPalette(voxelData);

  const endTime = performance.now();

  // Create VoxelObject with proper scale to be visible
  const dims: [number, number, number] = [config.resolution, config.resolution, config.resolution];
  const modelMatrix = mat4.create();
  // Scale to match resolution so each voxel is 1 unit
  mat4.scale(modelMatrix, modelMatrix, [config.resolution, config.resolution, config.resolution]);
  // Center the object
  mat4.translate(modelMatrix, modelMatrix, [-0.5, -0.5, -0.5]);
  const invModelMatrix = mat4.invert(mat4.create(), modelMatrix)!;

  const object: VoxelObject = {
    id: file.name.replace(/\.[^.]+$/, ''),
    dims,
    model_matrix: modelMatrix,
    inv_model_matrix: invModelMatrix,
    voxels,
  };

  return {
    object,
    palette,
    stats: {
      triangles,
      voxels: voxelData.voxelColors.size,
      timeMs: endTime - startTime,
      uniqueColors,
      quantized,
    },
  };
}

/**
 * Exports conversion result to JSON format
 */
export function exportToJSON(result: ConversionResult, sourceFile: string, config: VoxelizationConfig): string {
  const exportData: VoxelExportFormat = {
    version: '1.0',
    object: {
      id: result.object.id,
      dims: [result.object.dims[0], result.object.dims[1], result.object.dims[2]],
      voxels: uint8ArrayToBase64(result.object.voxels),
    },
    palette: result.palette,
    metadata: {
      sourceFile,
      resolution: config.resolution,
      mode: config.mode,
      triangles: result.stats.triangles,
      voxels: result.stats.voxels,
    },
  };

  return JSON.stringify(exportData, null, 2);
}

/**
 * Imports voxel data from JSON format
 */
export function importFromJSON(json: string): ConversionResult {
  const data: VoxelExportFormat = JSON.parse(json);

  const dims: [number, number, number] = [data.object.dims[0], data.object.dims[1], data.object.dims[2]];
  const modelMatrix = mat4.create();
  const invModelMatrix = mat4.create();
  mat4.invert(invModelMatrix, modelMatrix);

  const object: VoxelObject = {
    id: data.object.id,
    dims,
    model_matrix: modelMatrix,
    inv_model_matrix: invModelMatrix,
    voxels: base64ToUint8Array(data.object.voxels),
  };

  return {
    object,
    palette: data.palette,
    stats: {
      triangles: data.metadata.triangles,
      voxels: data.metadata.voxels,
      timeMs: 0,
      uniqueColors: data.palette.length,
      quantized: false,
    },
  };
}

/**
 * Creates a scene from a conversion result
 */
export function createSceneFromResult(result: ConversionResult): Scene {
  return {
    palette: result.palette,
    objects: [result.object],
  };
}

/**
 * Merges a conversion result into an existing scene
 */
export function mergeResultIntoScene(
  scene: Scene,
  result: ConversionResult,
  position: [number, number, number] = [0, 0, 0],
  scale: number = 1,
): void {
  // Remap voxel palette indices
  const paletteOffset = scene.palette.length;

  // Add new palette colors (skip index 0 which is transparent)
  for (let i = 1; i < result.palette.length; i++) {
    scene.palette.push(result.palette[i]);
  }

  // Create remapped voxels
  const remappedVoxels = new Uint8Array(result.object.voxels.length);
  for (let i = 0; i < result.object.voxels.length; i++) {
    const idx = result.object.voxels[i];
    remappedVoxels[i] = idx === 0 ? 0 : idx + paletteOffset - 1;
  }

  // Create positioned object
  const modelMatrix = mat4.create();
  mat4.translate(modelMatrix, modelMatrix, position);
  mat4.scale(modelMatrix, modelMatrix, [scale, scale, scale]);
  const invModelMatrix = mat4.invert(mat4.create(), modelMatrix)!;

  const object: VoxelObject = {
    id: result.object.id + '_' + Date.now(),
    dims: result.object.dims,
    model_matrix: modelMatrix,
    inv_model_matrix: invModelMatrix,
    voxels: remappedVoxels,
  };

  scene.objects.push(object);
}

/**
 * Converts Uint8Array to base64 string
 */
function uint8ArrayToBase64(arr: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i]);
  }
  return btoa(binary);
}

/**
 * Converts base64 string to Uint8Array
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    arr[i] = binary.charCodeAt(i);
  }
  return arr;
}

// Binary format magic bytes
const BINARY_MAGIC = new Uint8Array([0x56, 0x58, 0x4C, 0x31]); // "VXL1"
const BINARY_VERSION = 1;

/**
 * Exports conversion result to compressed binary format (.vxl.gz)
 * Format:
 *   Magic: 4 bytes "VXL1"
 *   Version: 1 byte
 *   Dims: 3x uint32 (12 bytes)
 *   Palette length: uint16 (2 bytes)
 *   Palette: N x 4 bytes RGBA
 *   Voxels: raw bytes
 * Then gzip compressed
 */
export async function exportToBinary(result: ConversionResult): Promise<Blob> {
  const dims = result.object.dims;
  const palette = result.palette;
  const voxels = result.object.voxels;

  // Calculate buffer size
  const headerSize = 4 + 1 + 12 + 2; // magic + version + dims + palette length
  const paletteSize = palette.length * 4;
  const totalSize = headerSize + paletteSize + voxels.length;

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  let offset = 0;

  // Magic bytes
  bytes.set(BINARY_MAGIC, offset);
  offset += 4;

  // Version
  view.setUint8(offset, BINARY_VERSION);
  offset += 1;

  // Dims (3x uint32, little endian)
  view.setUint32(offset, dims[0], true);
  offset += 4;
  view.setUint32(offset, dims[1], true);
  offset += 4;
  view.setUint32(offset, dims[2], true);
  offset += 4;

  // Palette length
  view.setUint16(offset, palette.length, true);
  offset += 2;

  // Palette data (RGBA)
  for (const color of palette) {
    bytes[offset++] = color[0];
    bytes[offset++] = color[1];
    bytes[offset++] = color[2];
    bytes[offset++] = color[3];
  }

  // Voxel data
  bytes.set(voxels, offset);

  // Compress with gzip
  const compressed = await gzipCompress(bytes);
  return new Blob([compressed], { type: 'application/gzip' });
}

/**
 * Imports voxel data from compressed binary format (.vxl.gz)
 */
export async function importFromBinary(file: File): Promise<ConversionResult> {
  const compressed = new Uint8Array(await file.arrayBuffer());
  return importFromArrayBuffer(compressed, file.name);
}

/**
 * Imports voxel data from ArrayBuffer (for fetch use)
 */
export async function importFromArrayBuffer(compressed: Uint8Array, filename: string = 'scene.voxgz'): Promise<ConversionResult> {
  const bytes = await gzipDecompress(compressed);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let offset = 0;

  // Verify magic bytes
  for (let i = 0; i < 4; i++) {
    if (bytes[offset + i] !== BINARY_MAGIC[i]) {
      throw new Error('Invalid VXL file: bad magic bytes');
    }
  }
  offset += 4;

  // Version
  const version = view.getUint8(offset);
  if (version !== BINARY_VERSION) {
    throw new Error(`Unsupported VXL version: ${version}`);
  }
  offset += 1;

  // Dims
  const dimX = view.getUint32(offset, true);
  offset += 4;
  const dimY = view.getUint32(offset, true);
  offset += 4;
  const dimZ = view.getUint32(offset, true);
  offset += 4;

  // Palette length
  const paletteLength = view.getUint16(offset, true);
  offset += 2;

  // Palette data
  const palette: import('../scene').RGBA[] = [];
  for (let i = 0; i < paletteLength; i++) {
    palette.push([
      bytes[offset++],
      bytes[offset++],
      bytes[offset++],
      bytes[offset++],
    ]);
  }

  // Voxel data
  const voxelCount = dimX * dimY * dimZ;
  const voxels = new Uint8Array(bytes.buffer, bytes.byteOffset + offset, voxelCount);

  // Create object with proper transforms
  const dims: [number, number, number] = [dimX, dimY, dimZ];
  const resolution = Math.max(dimX, dimY, dimZ);
  const modelMatrix = mat4.create();
  mat4.scale(modelMatrix, modelMatrix, [resolution, resolution, resolution]);
  mat4.translate(modelMatrix, modelMatrix, [-0.5, -0.5, -0.5]);
  const invModelMatrix = mat4.invert(mat4.create(), modelMatrix)!;

  const object: VoxelObject = {
    id: filename.replace(/\.voxgz$/, '').replace(/\.vxl\.gz$/, ''),
    dims,
    model_matrix: modelMatrix,
    inv_model_matrix: invModelMatrix,
    voxels: new Uint8Array(voxels), // Copy to avoid detached buffer issues
  };

  // Count non-zero voxels
  let voxelCountNonZero = 0;
  for (let i = 0; i < voxels.length; i++) {
    if (voxels[i] !== 0) voxelCountNonZero++;
  }

  return {
    object,
    palette,
    stats: {
      triangles: 0,
      voxels: voxelCountNonZero,
      timeMs: 0,
      uniqueColors: palette.length,
      quantized: false,
    },
  };
}

/**
 * Compresses data using gzip
 */
async function gzipCompress(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream();
  const compressedStream = stream.pipeThrough(new CompressionStream('gzip'));
  const reader = compressedStream.getReader();

  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Checks if data is gzip compressed (magic bytes 0x1f 0x8b)
 */
function isGzipCompressed(data: Uint8Array): boolean {
  return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;
}

/**
 * Decompresses gzip data (or returns as-is if already decompressed)
 */
async function gzipDecompress(data: Uint8Array): Promise<Uint8Array> {
  // Check if data is actually gzip compressed
  // Browsers may auto-decompress when fetching .gz files
  if (!isGzipCompressed(data)) {
    return data;
  }

  const stream = new Blob([data]).stream();
  const decompressedStream = stream.pipeThrough(new DecompressionStream('gzip'));
  const reader = decompressedStream.getReader();

  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
