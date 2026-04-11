// =============================================================
// The Living Garden — Shared Configuration
// Imported by both server and client so constants stay in sync.
// =============================================================

/** Daily bloom time in UTC. Change both values here to reschedule. */
export const BLOOM_UTC_HOUR   = 14
export const BLOOM_UTC_MINUTE =  5

export const TOTAL_PLANTS       = 21
export const BLOOM_THRESHOLD    = Math.ceil(TOTAL_PLANTS * 0.8)  // 17
export const DAILY_WATER_LIMIT  = 8
export const WATERED_EXPIRY_MS  = 6 * 60 * 60 * 1000   // 6 hours
/** How long after bloom triggers before the server resets all plants.
 *  Matches the 10-min visual bloom so the reset coincides with the post-bloom cooldown start. */
export const BLOOM_RESET_DELAY_MS = 10 * 60_000         // 10 minutes

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
  'Plant_21',
]
