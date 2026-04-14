// =============================================================
// The Living Garden — Shared Configuration
// Imported by both server and client so constants stay in sync.
// =============================================================

/** Daily bloom windows in UTC. Add or remove entries to change the schedule. */
export const BLOOM_WINDOWS: ReadonlyArray<{ hour: number; minute: number }> = [
  { hour:  5, minute: 30 },   // 05:30 UTC
  { hour: 17, minute: 30 },   // 17:30 UTC
]

export const TOTAL_PLANTS       = 38   // 32 regular + 6 fast
export const BLOOM_THRESHOLD    = Math.ceil(TOTAL_PLANTS * 0.8)
export const DAILY_WATER_LIMIT  = 8
export const WATERED_EXPIRY_MS  = 30 * 60 * 1000        // 30 minutes
export const FAST_PLANT_EXPIRY_MS = 75_000               // 75 seconds
/** How long after bloom triggers before the server resets all plants.
 *  Matches the 10-min visual bloom so the reset coincides with the post-bloom cooldown start. */
export const BLOOM_RESET_DELAY_MS = 11 * 60_000         // 10 minutes + 1min breather

// ── Scene-wide spatial / asset constants ─────────────────────
/** World-space centre of the Bloom model — used for sound, sparkles, shockwaves. */
export const BLOOM_CENTER = { x: 6.75, y: 2, z: 24 } as const
/** Shared sparkle texture used by all particle / FX systems. */
export const SPARKLE_SRC  = 'assets/scene/Images/sparkle.png'
/** Garden walkable area bounds — used for ambient FX spawning. */
export const GARDEN_BOUNDS = { xMin: 3, xMax: 14, zMin: 3, zMax: 22 } as const

export const PLANT_NAMES: string[] = [
  'Plant_1',  'Plant_2',  'Plant_3',  'Plant_4',
  'Plant_5',  'Plant_6',  'Plant_7',  'Plant_8',
  'Plant_9',  'Plant_10', 'Plant_11', 'Plant_12',
  'Plant_13', 'Plant_14', 'Plant_15', 'Plant_16',
  'Plant_17', 'Plant_18', 'Plant_19', 'Plant_20',
  'Plant_21', 'Plant_22', 'Plant_23', 'Plant_24',
  'Plant_25', 'Plant_26', 'Plant_27', 'Plant_28',
  'Plant_29', 'Plant_30', 'Plant_31', 'Plant_32',
  'FastPlant_1', 'FastPlant_2', 'FastPlant_3',
  'FastPlant_4', 'FastPlant_5', 'FastPlant_6',
]

/** Set of plant names that use FAST_PLANT_EXPIRY_MS instead of WATERED_EXPIRY_MS. */
export const FAST_PLANT_NAMES = new Set([
  'FastPlant_1', 'FastPlant_2', 'FastPlant_3',
  'FastPlant_4', 'FastPlant_5', 'FastPlant_6',
])
