import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { LoadedMesh, BoundingBox, MeshMaterial } from './types';

/**
 * Loads a GLTF/GLB file from a folder selection and extracts mesh data
 */
export async function loadGLTFFromFolder(
  files: FileList,
): Promise<{ meshes: LoadedMesh[]; boundingBox: BoundingBox; fileName: string }> {
  // Build a map of file paths to Files
  const fileMap = new Map<string, File>();
  let gltfFile: File | null = null;
  let glbFile: File | null = null;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    // Get relative path within the folder
    const relativePath = file.webkitRelativePath || file.name;
    // Store with normalized path (just filename or relative from folder root)
    const pathParts = relativePath.split('/');
    const localPath = pathParts.slice(1).join('/') || file.name; // Remove folder name prefix
    fileMap.set(localPath, file);
    fileMap.set(file.name, file); // Also store by just filename

    if (file.name.endsWith('.gltf')) {
      gltfFile = file;
    } else if (file.name.endsWith('.glb')) {
      glbFile = file;
    }
  }

  const mainFile = gltfFile || glbFile;
  if (!mainFile) {
    throw new Error('No GLTF or GLB file found in folder');
  }

  // Create a custom loading manager that resolves files from our map
  const manager = new THREE.LoadingManager();
  const blobUrls: string[] = [];

  // Track loading completion
  let loadingComplete = false;
  let loadResolve: () => void;
  const loadPromise = new Promise<void>((resolve) => {
    loadResolve = resolve;
  });

  manager.onLoad = () => {
    loadingComplete = true;
    loadResolve();
  };

  manager.setURLModifier((url: string) => {
    // Extract the filename from the URL
    const urlPath = url.replace(/^.*[\\\/]/, ''); // Get just filename
    const decodedPath = decodeURIComponent(urlPath);

    // Try to find the file in our map
    let file = fileMap.get(decodedPath);
    if (!file) {
      // Try with different path variations
      for (const [path, f] of fileMap) {
        if (path.endsWith(decodedPath) || decodedPath.endsWith(path)) {
          file = f;
          break;
        }
      }
    }

    if (file) {
      const blobUrl = URL.createObjectURL(file);
      blobUrls.push(blobUrl);
      return blobUrl;
    }

    return url;
  });

  const loader = new GLTFLoader(manager);
  const arrayBuffer = await mainFile.arrayBuffer();

  return new Promise((resolve, reject) => {
    loader.parse(
      arrayBuffer,
      '',
      async (gltf) => {
        // Wait for all textures to finish loading
        if (!loadingComplete) {
          await loadPromise;
        }

        // Small delay to ensure textures are fully processed
        await new Promise((r) => setTimeout(r, 100));

        const meshes: LoadedMesh[] = [];
        const globalBounds: BoundingBox = {
          min: [Infinity, Infinity, Infinity],
          max: [-Infinity, -Infinity, -Infinity],
        };

        gltf.scene.traverse((object) => {
          if (object instanceof THREE.Mesh) {
            const mesh = extractMeshData(object);
            if (mesh) {
              meshes.push(mesh);
              updateBounds(globalBounds, mesh.positions);
            }
          }
        });

        // Clean up blob URLs after extraction
        blobUrls.forEach((url) => URL.revokeObjectURL(url));

        if (meshes.length === 0) {
          reject(new Error('No meshes found in GLTF file'));
          return;
        }

        resolve({ meshes, boundingBox: globalBounds, fileName: mainFile.name });
      },
      (error) => {
        // Clean up blob URLs on error
        blobUrls.forEach((url) => URL.revokeObjectURL(url));
        reject(new Error(`Failed to parse GLTF: ${error.message}`));
      },
    );
  });
}

/**
 * Loads a single GLTF/GLB file (for GLB files that are self-contained)
 */
export async function loadGLTF(file: File): Promise<{ meshes: LoadedMesh[]; boundingBox: BoundingBox }> {
  const arrayBuffer = await file.arrayBuffer();
  const loader = new GLTFLoader();

  return new Promise((resolve, reject) => {
    loader.parse(
      arrayBuffer,
      '',
      (gltf) => {
        const meshes: LoadedMesh[] = [];
        const globalBounds: BoundingBox = {
          min: [Infinity, Infinity, Infinity],
          max: [-Infinity, -Infinity, -Infinity],
        };

        gltf.scene.traverse((object) => {
          if (object instanceof THREE.Mesh) {
            const mesh = extractMeshData(object);
            if (mesh) {
              meshes.push(mesh);
              updateBounds(globalBounds, mesh.positions);
            }
          }
        });

        if (meshes.length === 0) {
          reject(new Error('No meshes found in GLTF file'));
          return;
        }

        resolve({ meshes, boundingBox: globalBounds });
      },
      (error) => {
        reject(new Error(`Failed to parse GLTF: ${error.message}`));
      },
    );
  });
}

/**
 * Extracts geometry and material data from a Three.js mesh
 */
function extractMeshData(mesh: THREE.Mesh): LoadedMesh | null {
  const geometry = mesh.geometry;

  if (!geometry.attributes.position) {
    return null;
  }

  // Get world-transformed positions
  mesh.updateMatrixWorld(true);
  const worldMatrix = mesh.matrixWorld;

  const positionAttr = geometry.attributes.position;
  const positions = new Float32Array(positionAttr.count * 3);

  // Apply world transform to positions
  const tempVec = new THREE.Vector3();
  for (let i = 0; i < positionAttr.count; i++) {
    tempVec.fromBufferAttribute(positionAttr, i);
    tempVec.applyMatrix4(worldMatrix);
    positions[i * 3] = tempVec.x;
    positions[i * 3 + 1] = tempVec.y;
    positions[i * 3 + 2] = tempVec.z;
  }

  // Get indices (generate if not present)
  let indices: Uint16Array | Uint32Array;
  if (geometry.index) {
    const indexArray = geometry.index.array;
    indices = indexArray instanceof Uint32Array ? indexArray : new Uint16Array(indexArray);
  } else {
    // Generate sequential indices for non-indexed geometry
    const indexCount = positionAttr.count;
    indices = indexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
    for (let i = 0; i < indexCount; i++) {
      indices[i] = i;
    }
  }

  // Get optional attributes
  const normals = geometry.attributes.normal ? new Float32Array(geometry.attributes.normal.array) : undefined;

  const uvs = geometry.attributes.uv ? new Float32Array(geometry.attributes.uv.array) : undefined;

  const colors = geometry.attributes.color ? new Float32Array(geometry.attributes.color.array) : undefined;

  // Extract material data
  const material = extractMaterialData(mesh.material);

  return {
    name: mesh.name || 'unnamed_mesh',
    positions,
    indices,
    normals,
    uvs,
    colors,
    material,
  };
}

/**
 * Extracts color and texture information from a Three.js material
 * Handles PBR metallic materials by applying metallic tint
 */
function extractMaterialData(material: THREE.Material | THREE.Material[]): MeshMaterial {
  const mat = Array.isArray(material) ? material[0] : material;

  const result: MeshMaterial = {};
  let baseColor: [number, number, number] = [255, 255, 255];
  let metalness = 0;

  // Handle various material types that have color property
  if ('color' in mat && mat.color instanceof THREE.Color) {
    const color = mat.color;
    baseColor = [clampColor(color.r * 255), clampColor(color.g * 255), clampColor(color.b * 255)];
  }

  // Check for metalness (PBR property)
  if ('metalness' in mat && typeof mat.metalness === 'number') {
    metalness = mat.metalness;
  }

  // Try to extract texture from various material types
  if ('map' in mat && mat.map) {
    const map = mat.map as THREE.Texture;
    if (map.image) {
      result.texture = extractTextureData(map);
    }
  }

  // For highly metallic materials without texture, apply metallic tint
  // Metallic surfaces reflect their environment, so we simulate this
  // by tinting gray/white base colors toward a metallic appearance
  if (metalness > 0.5 && !result.texture) {
    const brightness = (baseColor[0] + baseColor[1] + baseColor[2]) / 3;

    // If base color is mostly gray/white (common for metals in PBR)
    if (brightness > 180 && Math.abs(baseColor[0] - baseColor[1]) < 30 && Math.abs(baseColor[1] - baseColor[2]) < 30) {
      // Apply a subtle gold/silver tint based on warmth
      // Gold: warm tint, Silver: cool tint
      const warmth = (baseColor[0] - baseColor[2]) / 255; // positive = warm

      if (warmth > 0.05) {
        // Gold-ish tint
        baseColor = [clampColor(brightness * 1.1), clampColor(brightness * 0.85), clampColor(brightness * 0.5)];
      } else if (warmth < -0.05) {
        // Blue-ish/cool metal
        baseColor = [clampColor(brightness * 0.8), clampColor(brightness * 0.85), clampColor(brightness * 1.0)];
      } else {
        // Silver/chrome - keep neutral but add slight contrast
        baseColor = [clampColor(brightness * 0.95), clampColor(brightness * 0.95), clampColor(brightness * 1.0)];
      }
    }
  }

  // If no base color set, try emissive
  if (baseColor[0] === 255 && baseColor[1] === 255 && baseColor[2] === 255) {
    if ('emissive' in mat && mat.emissive instanceof THREE.Color) {
      const emissive = mat.emissive;
      if (emissive.r > 0.1 || emissive.g > 0.1 || emissive.b > 0.1) {
        baseColor = [clampColor(emissive.r * 255), clampColor(emissive.g * 255), clampColor(emissive.b * 255)];
      }
    }
  }

  result.baseColor = [baseColor[0], baseColor[1], baseColor[2], 255];

  return result;
}

/**
 * Clamps a color value to valid u8 range (0-255)
 */
function clampColor(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * Extracts ImageData from a Three.js texture
 */
function extractTextureData(texture: THREE.Texture): ImageData | undefined {
  const image = texture.image;

  if (!image) return undefined;

  // Handle different image types
  const canvas = document.createElement('canvas');
  let ctx: CanvasRenderingContext2D | null;

  // Handle HTMLImageElement, HTMLCanvasElement, ImageBitmap
  if (
    image instanceof HTMLImageElement ||
    image instanceof HTMLCanvasElement ||
    (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap)
  ) {
    const width = image.width || 256;
    const height = image.height || 256;
    canvas.width = width;
    canvas.height = height;
    ctx = canvas.getContext('2d');

    if (!ctx) return undefined;

    try {
      ctx.drawImage(image as CanvasImageSource, 0, 0);
      return ctx.getImageData(0, 0, width, height);
    } catch (e) {
      // CORS or other error
      console.warn('Failed to extract texture data:', e);
      return undefined;
    }
  }

  if (image instanceof ImageData) {
    return image;
  }

  // Handle raw data buffers (CompressedTexture, DataTexture, etc.)
  if (image.data && image.width && image.height) {
    try {
      // Check if it's RGBA data
      const expectedLength = image.width * image.height * 4;
      if (image.data.length === expectedLength) {
        return new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
      }
      // Handle RGB data (no alpha)
      const rgbLength = image.width * image.height * 3;
      if (image.data.length === rgbLength) {
        const rgba = new Uint8ClampedArray(expectedLength);
        for (let i = 0, j = 0; i < rgbLength; i += 3, j += 4) {
          rgba[j] = image.data[i];
          rgba[j + 1] = image.data[i + 1];
          rgba[j + 2] = image.data[i + 2];
          rgba[j + 3] = 255;
        }
        return new ImageData(rgba, image.width, image.height);
      }
    } catch (e) {
      console.warn('Failed to create ImageData from raw data:', e);
    }
  }

  return undefined;
}

/**
 * Updates the global bounding box with the positions from a mesh
 */
function updateBounds(bounds: BoundingBox, positions: Float32Array): void {
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];

    bounds.min[0] = Math.min(bounds.min[0], x);
    bounds.min[1] = Math.min(bounds.min[1], y);
    bounds.min[2] = Math.min(bounds.min[2], z);

    bounds.max[0] = Math.max(bounds.max[0], x);
    bounds.max[1] = Math.max(bounds.max[1], y);
    bounds.max[2] = Math.max(bounds.max[2], z);
  }
}
