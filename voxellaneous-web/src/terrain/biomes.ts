import { RGBA } from '../scene';

/**
 * Biome system: 9 biomes on a 3x3 temperature x humidity grid.
 * A shared 16x16 = 256-entry palette is generated with bilinear
 * interpolation between biome anchor colors for smooth transitions.
 *
 * Temperature axis: 0 = cold, 1 = hot
 * Humidity axis:    0 = dry,  1 = wet
 *
 * Grid layout:
 *          Dry            Moderate          Wet
 * Cold:    Tundra         Taiga             Snowy Taiga
 * Temp:    Plains         Forest            Swamp
 * Hot:     Desert         Savanna           Jungle
 */

/** Biome anchor colors at the 3x3 grid intersections.
 *  Indexed as BIOME_COLORS[tempRow][humCol]. */
const BIOME_COLORS: RGBA[][] = [
  // Cold (temperature ~ 0)
  [
    [140, 135, 130, 255], // Tundra: stone grey
    [35, 75, 55, 255],    // Taiga: dark pine
    [220, 225, 235, 255], // Snowy Taiga: snow over stone
  ],
  // Temperate (temperature ~ 0.5)
  [
    [115, 175, 45, 255],  // Plains: bright grass
    [45, 115, 30, 255],   // Forest: dark green
    [60, 80, 45, 255],    // Swamp: murky olive
  ],
  // Hot (temperature ~ 1)
  [
    [215, 190, 105, 255], // Desert: sandy gold
    [175, 165, 55, 255],  // Savanna: dry yellow-green
    [25, 135, 30, 255],   // Jungle: vivid green
  ],
];

/** Biome height modifiers at the 3x3 grid intersections.
 *  scale: multiplier on base noise amplitude.
 *  ridge: strength of ridged noise (sharp mountain peaks). 0 = none, 1 = full.
 *  offset: added to base height (world units).
 *  Indexed as [tempRow][humCol]. */
const BIOME_HEIGHT_SCALE: number[][] = [
  // Cold
  [7.0, 3.5, 2.0],    // Tundra: vast, Taiga: significant, Snowy Taiga: moderate
  // Temperate
  [0.3, 0.6, 0.1],    // Plains: gentle, Forest: rolling, Swamp: flat
  // Hot
  [0.5, 0.3, 2.5],    // Desert: dunes, Savanna: mild, Jungle: hilly
];

/** Detail noise multiplier: controls Hills/Details layers per biome.
 *  0 = completely flat (only Continents layer), 1 = full detail. */
const BIOME_DETAIL_SCALE: number[][] = [
  // Cold
  [0.8, 0.5, 0.3],   // Tundra: most, Taiga: moderate, Snowy Taiga: mild
  // Temperate
  [0.1, 0.4, 0.0],   // Plains: hint, Forest: some, Swamp: none
  // Hot
  [0.3, 0.15, 0.5],  // Desert: dune shapes, Savanna: slight, Jungle: moderate
];

/** Ridged noise creates sharp peaks (1-|noise|). Strong in mountainous biomes, zero in flat. */
const BIOME_RIDGE_STRENGTH: number[][] = [
  // Cold
  [0.8, 0.3, 0.15],  // Tundra: strong ridges, Taiga: some, Snowy Taiga: slight
  // Temperate
  [0.0, 0.05, 0.0],  // Plains: none, Forest: hint, Swamp: none
  // Hot
  [0.0, 0.0, 0.2],   // Desert: none, Savanna: none, Jungle: mild
];

const BIOME_HEIGHT_OFFSET: number[][] = [
  // Cold
  [500, 150, 180],    // Tundra: high plateau, Taiga: elevated, Snowy Taiga: moderate
  // Temperate
  [0, 20, -40],       // Plains: baseline, Forest: slight, Swamp: low-lying
  // Hot
  [-20, -10, 60],     // Desert: slight basin, Savanna: low, Jungle: raised
];

/** Bilinear interpolation of a scalar across the 3x3 biome grid */
function bilerpScalar(grid: number[][], temperature: number, humidity: number): number {
  const t = Math.max(0, Math.min(1, temperature)) * 2;
  const h = Math.max(0, Math.min(1, humidity)) * 2;
  const ti = Math.min(Math.floor(t), 1);
  const hi = Math.min(Math.floor(h), 1);
  const u = t - ti;
  const v = h - hi;
  const inv_u = 1 - u;
  const inv_v = 1 - v;
  return inv_u * inv_v * grid[ti][hi] + u * inv_v * grid[ti + 1][hi]
       + inv_u * v * grid[ti][hi + 1] + u * v * grid[ti + 1][hi + 1];
}

/** Get height modifiers for a (temperature, humidity) point.
 *  scale: base noise multiplier. ridge: ridged noise strength. offset: world-unit shift. */
export function biomeHeightModifier(temperature: number, humidity: number): { scale: number; detail: number; ridge: number; offset: number } {
  return {
    scale: bilerpScalar(BIOME_HEIGHT_SCALE, temperature, humidity),
    detail: bilerpScalar(BIOME_DETAIL_SCALE, temperature, humidity),
    ridge: bilerpScalar(BIOME_RIDGE_STRENGTH, temperature, humidity),
    offset: bilerpScalar(BIOME_HEIGHT_OFFSET, temperature, humidity),
  };
}

/** Bilinear interpolation between four RGBA colors */
function bilerp(c00: RGBA, c10: RGBA, c01: RGBA, c11: RGBA, u: number, v: number): RGBA {
  const inv_u = 1 - u;
  const inv_v = 1 - v;
  return [
    Math.round(inv_u * inv_v * c00[0] + u * inv_v * c10[0] + inv_u * v * c01[0] + u * v * c11[0]),
    Math.round(inv_u * inv_v * c00[1] + u * inv_v * c10[1] + inv_u * v * c01[1] + u * v * c11[1]),
    Math.round(inv_u * inv_v * c00[2] + u * inv_v * c10[2] + inv_u * v * c01[2] + u * v * c11[2]),
    255,
  ];
}

/** Sample the biome color field at continuous (temperature, humidity) in [0, 1]. */
function sampleBiomeColor(temperature: number, humidity: number): RGBA {
  // Map to 2x2 patch grid (3 anchors → 2 intervals per axis)
  const t = Math.max(0, Math.min(1, temperature)) * 2; // [0, 2]
  const h = Math.max(0, Math.min(1, humidity)) * 2;

  const ti = Math.min(Math.floor(t), 1); // patch row 0 or 1
  const hi = Math.min(Math.floor(h), 1); // patch col 0 or 1

  const u = t - ti; // local [0, 1] within patch
  const v = h - hi;

  return bilerp(
    BIOME_COLORS[ti][hi],
    BIOME_COLORS[ti + 1][hi],
    BIOME_COLORS[ti][hi + 1],
    BIOME_COLORS[ti + 1][hi + 1],
    u, v,
  );
}

/** The shared 256-entry biome palette (16 temp bins x 16 humidity bins).
 *  Generated once at module load. */
export const BIOME_PALETTE: RGBA[] = (() => {
  const palette: RGBA[] = new Array(256);
  for (let ti = 0; ti < 16; ti++) {
    for (let hi = 0; hi < 16; hi++) {
      const temperature = (ti + 0.5) / 16;
      const humidity = (hi + 0.5) / 16;
      palette[ti * 16 + hi] = sampleBiomeColor(temperature, humidity);
    }
  }
  return palette;
})();

/** Compute palette index from continuous temperature and humidity values.
 *  Quantizes to the 16x16 grid. */
export function biomePaletteIndex(temperature: number, humidity: number): number {
  const ti = Math.max(0, Math.min(15, Math.floor(Math.max(0, Math.min(1, temperature)) * 15.999)));
  const hi = Math.max(0, Math.min(15, Math.floor(Math.max(0, Math.min(1, humidity)) * 15.999)));
  return ti * 16 + hi;
}

// Noise parameters for biome generation (offsets from base terrain seed)
export const BIOME_NOISE = {
  temperatureSeedOffset: 5000,
  temperatureFrequency: 0.00003,
  humiditySeedOffset: 6000,
  humidityFrequency: 0.00004,
  // Local detail noise that perturbs temp/humidity for within-biome variation
  localSeedOffset: 7000,
  localFrequency: 0.003,
  localStrength: 0.02,
  // Ridged noise for mountain peaks (1 - |noise| creates sharp ridges)
  ridgeSeedOffset: 8000,
  ridgeFrequency: 0.0001,
  ridgeOctaves: 5,
  ridgePersistence: 0.5,
  ridgeFeedback: 1.2,
  ridgeAmplitude: 40,
} as const;
