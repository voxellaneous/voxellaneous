/**
 * Utility functions for the renderer
 */

import type { RGBA } from './types';

/**
 * Pack RGBA values into a single u32 in ABGR byte order
 * This matches the Rust pack_rgba function and what unpack4x8unorm expects in WGSL
 * @param r Red component (0-255)
 * @param g Green component (0-255)
 * @param b Blue component (0-255)
 * @param a Alpha component (0-255)
 * @returns Packed u32 value
 */
export function packRGBA(r: number, g: number, b: number, a: number): number {
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/**
 * Pack an RGBA tuple into a single u32
 * @param rgba Array of [r, g, b, a] values (0-255)
 * @returns Packed u32 value
 */
export function packRGBATuple(rgba: RGBA): number {
  return packRGBA(rgba[0], rgba[1], rgba[2], rgba[3]);
}
