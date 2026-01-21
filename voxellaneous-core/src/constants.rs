#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
pub struct Vertex {
    position: [f32; 3],
}

pub const CUBE_VERTICES: &[Vertex] = &[
    Vertex {
        position: [-0.5, -0.5, 0.5],
    },
    Vertex {
        position: [0.5, -0.5, 0.5],
    },
    Vertex {
        position: [0.5, 0.5, 0.5],
    },
    Vertex {
        position: [-0.5, 0.5, 0.5],
    },
    Vertex {
        position: [-0.5, -0.5, -0.5],
    },
    Vertex {
        position: [0.5, -0.5, -0.5],
    },
    Vertex {
        position: [0.5, 0.5, -0.5],
    },
    Vertex {
        position: [-0.5, 0.5, -0.5],
    },
    Vertex {
        position: [-0.5, 0.5, -0.5],
    },
    Vertex {
        position: [0.5, 0.5, -0.5],
    },
    Vertex {
        position: [0.5, 0.5, 0.5],
    },
    Vertex {
        position: [-0.5, 0.5, 0.5],
    },
    Vertex {
        position: [-0.5, -0.5, -0.5],
    },
    Vertex {
        position: [0.5, -0.5, -0.5],
    },
    Vertex {
        position: [0.5, -0.5, 0.5],
    },
    Vertex {
        position: [-0.5, -0.5, 0.5],
    },
    Vertex {
        position: [0.5, -0.5, -0.5],
    },
    Vertex {
        position: [0.5, 0.5, -0.5],
    },
    Vertex {
        position: [0.5, 0.5, 0.5],
    },
    Vertex {
        position: [0.5, -0.5, 0.5],
    },
    Vertex {
        position: [-0.5, -0.5, -0.5],
    },
    Vertex {
        position: [-0.5, 0.5, -0.5],
    },
    Vertex {
        position: [-0.5, 0.5, 0.5],
    },
    Vertex {
        position: [-0.5, -0.5, 0.5],
    },
];

pub const CUBE_INDICES: &[u16] = &[
    // Front face
    0, 1, 2, 0, 2, 3, // Back face
    4, 5, 6, 4, 6, 7, // Top face
    8, 9, 10, 8, 10, 11, // Bottom face
    12, 13, 14, 12, 14, 15, // Right face
    16, 17, 18, 16, 18, 19, // Left face
    20, 21, 22, 20, 22, 23,
];

// Wireframe cube edge indices (12 edges, 24 indices for line list)
// Using first 8 vertices as cube corners
pub const CUBE_EDGE_INDICES: &[u16] = &[
    // Front face edges
    0, 1, 1, 2, 2, 3, 3, 0,
    // Back face edges
    4, 5, 5, 6, 6, 7, 7, 4,
    // Connecting edges (front to back)
    0, 4, 1, 5, 2, 6, 3, 7,
];
