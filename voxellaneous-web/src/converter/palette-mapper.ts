import { VoxelData } from './types';
import { RGBA } from '../scene';

const MAX_PALETTE_SIZE = 256;

/**
 * Result of palette mapping operation
 */
export interface PaletteMappingResult {
  /** Voxel data with palette indices */
  voxels: Uint8Array;
  /** The color palette */
  palette: RGBA[];
  /** Whether quantization was needed */
  quantized: boolean;
  /** Number of unique colors before quantization */
  uniqueColors: number;
}

/**
 * Maps voxel colors to a palette with at most 256 colors
 * Uses median cut quantization if there are more than 256 unique colors
 */
export function mapColorsToPalette(
  voxelData: VoxelData,
  existingPalette?: RGBA[]
): PaletteMappingResult {
  const { dims, voxelColors } = voxelData;
  const [nx, ny, nz] = dims;
  const totalVoxels = nx * ny * nz;
  const voxels = new Uint8Array(totalVoxels);

  // Collect unique colors
  const colorMap = new Map<string, RGBA>();
  for (const color of voxelColors.values()) {
    const key = colorKey(color);
    if (!colorMap.has(key)) {
      colorMap.set(key, color);
    }
  }

  const uniqueColors = colorMap.size;
  let palette: RGBA[];
  let quantized = false;

  if (existingPalette && existingPalette.length > 0) {
    // Use existing palette and map to nearest colors
    palette = existingPalette;
  } else if (uniqueColors <= MAX_PALETTE_SIZE - 1) {
    // All colors fit in palette (leaving room for transparent at index 0)
    palette = Array.from(colorMap.values());
  } else {
    // Need to quantize (leave 1 slot for transparent at index 0)
    palette = medianCutQuantize(Array.from(colorMap.values()), MAX_PALETTE_SIZE - 1);
    quantized = true;
  }

  // Ensure palette index 0 is reserved (typically transparent/empty)
  if (palette.length === 0 || !isColorEqual(palette[0], [0, 0, 0, 0])) {
    palette.unshift([0, 0, 0, 0]);
    if (palette.length > MAX_PALETTE_SIZE) {
      palette.pop();
    }
  }

  // Build color -> index lookup
  const colorToIndex = new Map<string, number>();
  for (let i = 0; i < palette.length; i++) {
    colorToIndex.set(colorKey(palette[i]), i);
  }

  // Map voxels to palette indices
  for (const [idx, color] of voxelColors) {
    const key = colorKey(color);
    let paletteIdx = colorToIndex.get(key);

    if (paletteIdx === undefined) {
      // Find nearest color in palette
      paletteIdx = findNearestColor(color, palette);
    }

    voxels[idx] = paletteIdx;
  }

  return { voxels, palette, quantized, uniqueColors };
}

/**
 * Creates a string key for a color
 */
function colorKey(color: RGBA): string {
  return `${color[0]},${color[1]},${color[2]},${color[3]}`;
}

/**
 * Checks if two colors are equal
 */
function isColorEqual(a: RGBA, b: RGBA): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/**
 * Clamps a value to valid u8 range (0-255)
 */
function clamp(value: number): number {
  return Math.max(0, Math.min(255, value));
}

/**
 * Finds the nearest color in the palette using squared Euclidean distance
 */
function findNearestColor(color: RGBA, palette: RGBA[]): number {
  let minDist = Infinity;
  let minIdx = 1; // Skip index 0 (reserved)

  for (let i = 1; i < palette.length; i++) {
    const p = palette[i];
    const dist =
      (color[0] - p[0]) ** 2 +
      (color[1] - p[1]) ** 2 +
      (color[2] - p[2]) ** 2;

    if (dist < minDist) {
      minDist = dist;
      minIdx = i;
    }
  }

  return minIdx;
}

/**
 * Median cut color quantization algorithm
 * Recursively splits the color space along the axis with largest range
 */
function medianCutQuantize(colors: RGBA[], maxColors: number): RGBA[] {
  if (colors.length <= maxColors) {
    return colors;
  }

  // Initialize with all colors in one bucket
  let buckets: RGBA[][] = [colors];

  // Split buckets until we have enough
  while (buckets.length < maxColors) {
    // Find bucket with largest range
    let maxRange = -1;
    let maxBucketIdx = 0;
    let splitAxis = 0;

    for (let i = 0; i < buckets.length; i++) {
      const bucket = buckets[i];
      if (bucket.length <= 1) continue;

      // Calculate range for each channel
      for (let axis = 0; axis < 3; axis++) {
        let min = 255, max = 0;
        for (const c of bucket) {
          min = Math.min(min, c[axis]);
          max = Math.max(max, c[axis]);
        }
        const range = max - min;
        if (range > maxRange) {
          maxRange = range;
          maxBucketIdx = i;
          splitAxis = axis;
        }
      }
    }

    if (maxRange <= 0) break;

    // Split the bucket at median
    const bucket = buckets[maxBucketIdx];
    bucket.sort((a, b) => a[splitAxis] - b[splitAxis]);
    const mid = Math.floor(bucket.length / 2);

    buckets.splice(maxBucketIdx, 1, bucket.slice(0, mid), bucket.slice(mid));
  }

  // Average colors in each bucket
  const palette: RGBA[] = [];
  for (const bucket of buckets) {
    if (bucket.length === 0) continue;

    let r = 0, g = 0, b = 0, a = 0;
    for (const c of bucket) {
      r += c[0];
      g += c[1];
      b += c[2];
      a += c[3];
    }
    const n = bucket.length;
    palette.push([
      clamp(Math.round(r / n)),
      clamp(Math.round(g / n)),
      clamp(Math.round(b / n)),
      clamp(Math.round(a / n)),
    ]);
  }

  return palette;
}
