/**
 * Cube vertex and index data for rendering voxel bounding boxes
 */

// 24 vertices (6 faces * 4 vertices), each vertex is 3 floats (x, y, z)
// Cube extends from -0.5 to 0.5 in object space
export const CUBE_VERTICES = new Float32Array([
  // Front face (z = 0.5)
  -0.5, -0.5, 0.5,
  0.5, -0.5, 0.5,
  0.5, 0.5, 0.5,
  -0.5, 0.5, 0.5,
  // Back face (z = -0.5)
  -0.5, -0.5, -0.5,
  0.5, -0.5, -0.5,
  0.5, 0.5, -0.5,
  -0.5, 0.5, -0.5,
  // Top face (y = 0.5)
  -0.5, 0.5, -0.5,
  0.5, 0.5, -0.5,
  0.5, 0.5, 0.5,
  -0.5, 0.5, 0.5,
  // Bottom face (y = -0.5)
  -0.5, -0.5, -0.5,
  0.5, -0.5, -0.5,
  0.5, -0.5, 0.5,
  -0.5, -0.5, 0.5,
  // Right face (x = 0.5)
  0.5, -0.5, -0.5,
  0.5, 0.5, -0.5,
  0.5, 0.5, 0.5,
  0.5, -0.5, 0.5,
  // Left face (x = -0.5)
  -0.5, -0.5, -0.5,
  -0.5, 0.5, -0.5,
  -0.5, 0.5, 0.5,
  -0.5, -0.5, 0.5,
]);

// 36 indices for 12 triangles (6 faces * 2 triangles)
export const CUBE_INDICES = new Uint16Array([
  // Front face
  0, 1, 2, 0, 2, 3,
  // Back face
  4, 5, 6, 4, 6, 7,
  // Top face
  8, 9, 10, 8, 10, 11,
  // Bottom face
  12, 13, 14, 12, 14, 15,
  // Right face
  16, 17, 18, 16, 18, 19,
  // Left face
  20, 21, 22, 20, 22, 23,
]);

// 24 indices for 12 edges (wireframe cube using line list)
// Uses first 8 vertices as cube corners
export const CUBE_EDGE_INDICES = new Uint16Array([
  // Front face edges
  0, 1, 1, 2, 2, 3, 3, 0,
  // Back face edges
  4, 5, 5, 6, 6, 7, 7, 4,
  // Connecting edges (front to back)
  0, 4, 1, 5, 2, 6, 3, 7,
]);

// Vertex stride in bytes (3 floats * 4 bytes)
export const VERTEX_STRIDE = 12;
