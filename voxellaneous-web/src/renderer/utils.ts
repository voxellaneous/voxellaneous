/**
 * Utility functions for the renderer
 */

import type { RGBA } from './types';

/**
 * Replace named WGSL `const` declarations with new values at shader compile time.
 *
 * Matches lines of the form:
 *   `const NAME: TYPE = VALUE;`
 * and replaces VALUE with the override. Supports i32, u32, and f32 types,
 * automatically formatting the literal to match (e.g. `42u` for u32).
 *
 * @example
 *   patchWgslConstants(shaderSource, {
 *     MAX_STEPS: 512,
 *     SHADOW_NEAR_SAMPLES: 7,
 *     SHADOW_NEAR_STEP: 64,
 *   })
 */
export function patchWgslConstants(
  source: string,
  overrides: Record<string, number>,
): string {
  let result = source;
  for (const [name, value] of Object.entries(overrides)) {
    // Match: const NAME: TYPE = VALUE;
    const re = new RegExp(
      `(const\\s+${name}\\s*:\\s*)(i32|u32|f32)(\\s*=\\s*)[^;]+(;)`,
    );
    result = result.replace(re, (_match, prefix, type, eq, semi) => {
      let literal: string;
      switch (type) {
        case 'u32':
          literal = `${value}u`;
          break;
        case 'f32':
          literal = Number.isInteger(value) ? `${value}.0` : `${value}`;
          break;
        default: // i32
          literal = `${value}`;
          break;
      }
      return `${prefix}${type}${eq}${literal}${semi}`;
    });
  }
  return result;
}

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
