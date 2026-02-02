import { LoadedMesh, BoundingBox, VoxelData, VoxelizationConfig, Triangle } from './types';
import { RGBA } from '../scene';
import { sampleColorFromTriangle } from './color-extractor';

/**
 * Voxelizes a list of meshes into a 3D voxel grid
 */
export function voxelizeMeshes(
  meshes: LoadedMesh[],
  boundingBox: BoundingBox,
  config: VoxelizationConfig
): VoxelData {
  const resolution = config.resolution;
  const dims: [number, number, number] = [resolution, resolution, resolution];
  const voxelColors = new Map<number, RGBA>();

  // Calculate scale to fit mesh into voxel grid with some padding
  const size = [
    boundingBox.max[0] - boundingBox.min[0],
    boundingBox.max[1] - boundingBox.min[1],
    boundingBox.max[2] - boundingBox.min[2],
  ];
  const maxSize = Math.max(size[0], size[1], size[2]);
  const scale = (resolution - 1) / maxSize;
  const offset = boundingBox.min;

  // Process each mesh
  for (const mesh of meshes) {
    voxelizeSingleMesh(mesh, voxelColors, dims, scale, offset);
  }

  // Fill interior if solid mode
  if (config.mode === 'solid') {
    fillInterior(voxelColors, dims);
  }

  return { dims, voxelColors };
}

/**
 * Voxelizes a single mesh using triangle-box intersection
 */
function voxelizeSingleMesh(
  mesh: LoadedMesh,
  voxelColors: Map<number, RGBA>,
  dims: [number, number, number],
  scale: number,
  offset: [number, number, number]
): void {
  const { positions, indices, uvs, colors, material } = mesh;
  const triangleCount = indices.length / 3;

  for (let t = 0; t < triangleCount; t++) {
    const i0 = indices[t * 3];
    const i1 = indices[t * 3 + 1];
    const i2 = indices[t * 3 + 2];

    // Build triangle in voxel space
    const triangle: Triangle = {
      v0: transformPoint(positions, i0, scale, offset),
      v1: transformPoint(positions, i1, scale, offset),
      v2: transformPoint(positions, i2, scale, offset),
    };

    // Add UV coordinates if available
    if (uvs) {
      triangle.uv0 = [uvs[i0 * 2], uvs[i0 * 2 + 1]];
      triangle.uv1 = [uvs[i1 * 2], uvs[i1 * 2 + 1]];
      triangle.uv2 = [uvs[i2 * 2], uvs[i2 * 2 + 1]];
    }

    // Add vertex colors if available
    if (colors) {
      const stride = colors.length / (positions.length / 3);
      triangle.color0 = extractVertexColor(colors, i0, stride);
      triangle.color1 = extractVertexColor(colors, i1, stride);
      triangle.color2 = extractVertexColor(colors, i2, stride);
    }

    // Compute triangle AABB in voxel space
    const triMin: [number, number, number] = [
      Math.floor(Math.min(triangle.v0[0], triangle.v1[0], triangle.v2[0])),
      Math.floor(Math.min(triangle.v0[1], triangle.v1[1], triangle.v2[1])),
      Math.floor(Math.min(triangle.v0[2], triangle.v1[2], triangle.v2[2])),
    ];
    const triMax: [number, number, number] = [
      Math.floor(Math.max(triangle.v0[0], triangle.v1[0], triangle.v2[0])),
      Math.floor(Math.max(triangle.v0[1], triangle.v1[1], triangle.v2[1])),
      Math.floor(Math.max(triangle.v0[2], triangle.v1[2], triangle.v2[2])),
    ];

    // Clamp to grid bounds
    triMin[0] = Math.max(0, triMin[0]);
    triMin[1] = Math.max(0, triMin[1]);
    triMin[2] = Math.max(0, triMin[2]);
    triMax[0] = Math.min(dims[0] - 1, triMax[0]);
    triMax[1] = Math.min(dims[1] - 1, triMax[1]);
    triMax[2] = Math.min(dims[2] - 1, triMax[2]);

    // Test each voxel in the AABB
    for (let z = triMin[2]; z <= triMax[2]; z++) {
      for (let y = triMin[1]; y <= triMax[1]; y++) {
        for (let x = triMin[0]; x <= triMax[0]; x++) {
          if (triangleBoxIntersection(triangle, x, y, z)) {
            const idx = x + dims[0] * (y + dims[1] * z);
            if (!voxelColors.has(idx)) {
              const color = sampleColorFromTriangle(triangle, x + 0.5, y + 0.5, z + 0.5, material);
              voxelColors.set(idx, color);
            }
          }
        }
      }
    }
  }
}

/**
 * Transforms a vertex position to voxel space
 */
function transformPoint(
  positions: Float32Array,
  index: number,
  scale: number,
  offset: [number, number, number]
): [number, number, number] {
  return [
    (positions[index * 3] - offset[0]) * scale,
    (positions[index * 3 + 1] - offset[1]) * scale,
    (positions[index * 3 + 2] - offset[2]) * scale,
  ];
}

/**
 * Extracts vertex color from a color buffer
 */
function extractVertexColor(colors: Float32Array, index: number, stride: number): RGBA {
  const base = index * stride;
  const r = Math.round((colors[base] ?? 1) * 255);
  const g = Math.round((colors[base + 1] ?? 1) * 255);
  const b = Math.round((colors[base + 2] ?? 1) * 255);
  const a = stride >= 4 ? Math.round((colors[base + 3] ?? 1) * 255) : 255;
  return [r, g, b, a];
}

/**
 * Tests if a triangle intersects a unit voxel at (x, y, z)
 * Uses the Separating Axis Theorem (SAT)
 */
function triangleBoxIntersection(
  tri: Triangle,
  x: number,
  y: number,
  z: number
): boolean {
  // Box center and half-extents
  const boxCenter: [number, number, number] = [x + 0.5, y + 0.5, z + 0.5];
  const boxHalf = 0.5;

  // Translate triangle to box-centered coordinates
  const v0: [number, number, number] = [
    tri.v0[0] - boxCenter[0],
    tri.v0[1] - boxCenter[1],
    tri.v0[2] - boxCenter[2],
  ];
  const v1: [number, number, number] = [
    tri.v1[0] - boxCenter[0],
    tri.v1[1] - boxCenter[1],
    tri.v1[2] - boxCenter[2],
  ];
  const v2: [number, number, number] = [
    tri.v2[0] - boxCenter[0],
    tri.v2[1] - boxCenter[1],
    tri.v2[2] - boxCenter[2],
  ];

  // Triangle edges
  const e0 = sub(v1, v0);
  const e1 = sub(v2, v1);
  const e2 = sub(v0, v2);

  // Test 9 axes formed by cross products of triangle edges and box axes
  const axes = [
    [0, -e0[2], e0[1]], [0, -e1[2], e1[1]], [0, -e2[2], e2[1]],
    [e0[2], 0, -e0[0]], [e1[2], 0, -e1[0]], [e2[2], 0, -e2[0]],
    [-e0[1], e0[0], 0], [-e1[1], e1[0], 0], [-e2[1], e2[0], 0],
  ];

  for (const axis of axes) {
    if (!overlapOnAxis(v0, v1, v2, axis as [number, number, number], boxHalf)) {
      return false;
    }
  }

  // Test 3 box face normals (AABB axes)
  if (Math.max(v0[0], v1[0], v2[0]) < -boxHalf || Math.min(v0[0], v1[0], v2[0]) > boxHalf) return false;
  if (Math.max(v0[1], v1[1], v2[1]) < -boxHalf || Math.min(v0[1], v1[1], v2[1]) > boxHalf) return false;
  if (Math.max(v0[2], v1[2], v2[2]) < -boxHalf || Math.min(v0[2], v1[2], v2[2]) > boxHalf) return false;

  // Test triangle normal
  const normal = cross(e0, e1);
  const d = dot(normal, v0);
  const r = boxHalf * (Math.abs(normal[0]) + Math.abs(normal[1]) + Math.abs(normal[2]));
  if (d > r || d < -r) return false;

  return true;
}

/**
 * Tests overlap on a separating axis
 */
function overlapOnAxis(
  v0: [number, number, number],
  v1: [number, number, number],
  v2: [number, number, number],
  axis: [number, number, number],
  boxHalf: number
): boolean {
  const p0 = dot(v0, axis);
  const p1 = dot(v1, axis);
  const p2 = dot(v2, axis);

  const triMin = Math.min(p0, p1, p2);
  const triMax = Math.max(p0, p1, p2);

  const boxRadius = boxHalf * (Math.abs(axis[0]) + Math.abs(axis[1]) + Math.abs(axis[2]));

  return !(triMin > boxRadius || triMax < -boxRadius);
}

/**
 * Fills the interior of the voxel model using scanline fill
 */
function fillInterior(voxelColors: Map<number, RGBA>, dims: [number, number, number]): void {
  const [nx, ny, nz] = dims;

  // For each XY slice, do scanline fill along Z
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      let inside = false;
      let lastSurface = -1;
      let lastColor: RGBA = [128, 128, 128, 255];

      for (let z = 0; z < nz; z++) {
        const idx = x + nx * (y + ny * z);
        const isSurface = voxelColors.has(idx);

        if (isSurface) {
          // Crossing a surface boundary
          if (inside && lastSurface >= 0) {
            // Fill from last surface to this one
            for (let fillZ = lastSurface + 1; fillZ < z; fillZ++) {
              const fillIdx = x + nx * (y + ny * fillZ);
              if (!voxelColors.has(fillIdx)) {
                voxelColors.set(fillIdx, lastColor);
              }
            }
          }
          lastSurface = z;
          lastColor = voxelColors.get(idx)!;
          inside = !inside;
        }
      }
    }
  }
}

// Vector math helpers
function sub(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
