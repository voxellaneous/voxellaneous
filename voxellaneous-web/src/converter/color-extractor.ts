import { Triangle, MeshMaterial } from './types';
import { RGBA } from '../scene';

/**
 * Samples color from a triangle at a given voxel position
 * Priority: vertex colors > texture > material base color > gray fallback
 */
export function sampleColorFromTriangle(
  tri: Triangle,
  voxelX: number,
  voxelY: number,
  voxelZ: number,
  material: MeshMaterial,
): RGBA {
  // Compute barycentric coordinates for the voxel center projected onto the triangle
  const bary = computeBarycentric([voxelX, voxelY, voxelZ], tri.v0, tri.v1, tri.v2);

  // 1. Try vertex colors first
  if (tri.color0 && tri.color1 && tri.color2) {
    return interpolateColors(tri.color0, tri.color1, tri.color2, bary);
  }

  // 2. Try texture sampling
  if (material.texture && tri.uv0 && tri.uv1 && tri.uv2) {
    const uv = interpolateUV(tri.uv0, tri.uv1, tri.uv2, bary);
    const texColor = sampleTexture(material.texture, uv[0], uv[1]);
    if (texColor) return texColor;
  }

  // 3. Try material base color
  if (material.baseColor) {
    return material.baseColor;
  }

  // 4. Gray fallback
  return [128, 128, 128, 255];
}

/**
 * Computes barycentric coordinates for a point relative to a triangle
 */
function computeBarycentric(
  p: [number, number, number],
  v0: [number, number, number],
  v1: [number, number, number],
  v2: [number, number, number],
): [number, number, number] {
  // Vectors from v0
  const v0v1: [number, number, number] = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
  const v0v2: [number, number, number] = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
  const v0p: [number, number, number] = [p[0] - v0[0], p[1] - v0[1], p[2] - v0[2]];

  // Dot products
  const d00 = dot(v0v1, v0v1);
  const d01 = dot(v0v1, v0v2);
  const d11 = dot(v0v2, v0v2);
  const d20 = dot(v0p, v0v1);
  const d21 = dot(v0p, v0v2);

  const denom = d00 * d11 - d01 * d01;
  if (Math.abs(denom) < 1e-10) {
    // Degenerate triangle, return center
    return [1 / 3, 1 / 3, 1 - 2 / 3];
  }

  const v = (d11 * d20 - d01 * d21) / denom;
  const w = (d00 * d21 - d01 * d20) / denom;
  const u = 1 - v - w;

  // Clamp to valid range
  return [Math.max(0, Math.min(1, u)), Math.max(0, Math.min(1, v)), Math.max(0, Math.min(1, w))];
}

/**
 * Interpolates colors using barycentric coordinates
 */
function interpolateColors(c0: RGBA, c1: RGBA, c2: RGBA, bary: [number, number, number]): RGBA {
  return [
    clamp(Math.round(c0[0] * bary[0] + c1[0] * bary[1] + c2[0] * bary[2])),
    clamp(Math.round(c0[1] * bary[0] + c1[1] * bary[1] + c2[1] * bary[2])),
    clamp(Math.round(c0[2] * bary[0] + c1[2] * bary[1] + c2[2] * bary[2])),
    clamp(Math.round(c0[3] * bary[0] + c1[3] * bary[1] + c2[3] * bary[2])),
  ];
}

/**
 * Clamps a value to valid u8 range (0-255)
 */
function clamp(value: number): number {
  return Math.max(0, Math.min(255, value));
}

/**
 * Interpolates UV coordinates using barycentric coordinates
 */
function interpolateUV(
  uv0: [number, number],
  uv1: [number, number],
  uv2: [number, number],
  bary: [number, number, number],
): [number, number] {
  return [
    uv0[0] * bary[0] + uv1[0] * bary[1] + uv2[0] * bary[2],
    uv0[1] * bary[0] + uv1[1] * bary[1] + uv2[1] * bary[2],
  ];
}

/**
 * Samples a texture at the given UV coordinates
 */
function sampleTexture(texture: ImageData, u: number, v: number): RGBA | null {
  const { width, height, data } = texture;

  // Wrap UV coordinates
  let wrappedU = u % 1;
  let wrappedV = v % 1;
  if (wrappedU < 0) wrappedU += 1;
  if (wrappedV < 0) wrappedV += 1;

  // Convert to pixel coordinates (flip V for standard UV convention)
  const px = Math.floor(wrappedU * (width - 1));
  const py = Math.floor((1 - wrappedV) * (height - 1));

  // Clamp to bounds
  const x = Math.max(0, Math.min(width - 1, px));
  const y = Math.max(0, Math.min(height - 1, py));

  const idx = (y * width + x) * 4;
  return [data[idx], data[idx + 1], data[idx + 2], data[idx + 3]];
}

/**
 * Dot product helper
 */
function dot(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
