import { mat4, vec3 } from 'gl-matrix';
import { Scene } from '../src/scene';

function createUniformVoxelData([nx, ny, nz]: [number, number, number], paletteIndex: number): Uint8Array {
  const total = nx * ny * nz;
  const voxels = new Uint8Array(total);
  voxels.fill(paletteIndex);
  return voxels;
}

function createSphereVoxelData([nx, ny, nz]: [number, number, number], paletteIndex: number): Uint8Array {
  const voxels = new Uint8Array(nx * ny * nz);
  const cx = (nx - 1) / 2;
  const cy = (ny - 1) / 2;
  const cz = (nz - 1) / 2;
  const radius = Math.min(nx, ny, nz) * 0.5 * 0.9;
  const r2 = radius * radius;

  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const dz = z - cz;
        if (dx * dx + dy * dy + dz * dz <= r2) {
          voxels[x + nx * (y + ny * z)] = paletteIndex;
        }
      }
    }
  }
  return voxels;
}

function addObjectToScene(scene: Scene, id: string, dims: vec3, translate: vec3, voxels: Uint8Array): void {
  const modelMatrix = mat4.create();
  mat4.translate(modelMatrix, modelMatrix, translate);
  mat4.scale(modelMatrix, modelMatrix, dims);
  const inverseModelMatrix = mat4.invert(mat4.create(), modelMatrix);

  scene.objects.push({
    id,
    dims,
    model_matrix: modelMatrix,
    inv_model_matrix: inverseModelMatrix,
    voxels,
  });
}

/** Builds a Cornell box scene using bounding-box objects and 3D‐texture voxel data */
export function createCornellBoxScene(scene: Scene): void {
  // 4‐color palette: red, green, white, gray
  scene.palette = [
    [0, 0, 0, 255], // black (unused)
    [255, 0, 0, 255], // red
    [0, 255, 0, 255], // green
    [255, 255, 255, 255], // white
    [128, 128, 128, 255], // gray (sphere)
  ];

  scene.objects = [];

  // Left wall: 10×80×80 voxels, red
  addObjectToScene(
    scene,
    'left_wall',
    vec3.fromValues(10, 80, 80),
    vec3.fromValues(-45, 0, 0),
    createUniformVoxelData([10, 80, 80], 1),
  );

  // Right wall: 10×80×80 voxels, green
  addObjectToScene(
    scene,
    'right_wall',
    vec3.fromValues(10, 80, 80),
    vec3.fromValues(45, 0, 0),
    createUniformVoxelData([10, 80, 80], 2),
  );

  // Bottom wall: 80×10×80 voxels, white
  addObjectToScene(
    scene,
    'floor',
    vec3.fromValues(100, 10, 80),
    vec3.fromValues(0, -45, 0),
    createUniformVoxelData([100, 10, 80], 3),
  );

  // Top wall: 80×10×80 voxels, white
  addObjectToScene(
    scene,
    'ceiling',
    vec3.fromValues(100, 10, 80),
    vec3.fromValues(0, 45, 0),
    createUniformVoxelData([100, 10, 80], 3),
  );

  // Back wall: 100×100×10 voxels, white
  addObjectToScene(
    scene,
    'back_wall',
    vec3.fromValues(100, 100, 10),
    vec3.fromValues(0, 0, -45),
    createUniformVoxelData([100, 100, 10], 3),
  );

  // Sphere in the center: 32×32×32 voxels, gray
  addObjectToScene(
    scene,
    'sphere',
    vec3.fromValues(32, 32, 32),
    vec3.fromValues(0, 0, 0),
    createSphereVoxelData([32, 32, 32], 4),
  );
}
