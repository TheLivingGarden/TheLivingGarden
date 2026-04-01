// =============================================================
// The Living Garden — Shared Configuration
// Imported by both server and client so constants stay in sync.
// =============================================================

export const TOTAL_PLANTS       = 21
export const BLOOM_THRESHOLD    = Math.ceil(TOTAL_PLANTS * 0.8)  // 17
export const DAILY_WATER_LIMIT  = 8
export const WATERED_EXPIRY_MS  = 6 * 60 * 60 * 1000   // 6 hours
/** How long after bloom triggers before the server resets all plants. */
export const BLOOM_RESET_DELAY_MS = 60_000              // 1 minute

export const PLANT_NAMES: string[] = [
  'Plant_1',  'Plant_2',  'Plant_3',  'Plant_4',
  'Plant_5',  'Plant_6',  'Plant_7',  'Plant_8',
  'Plant_9',  'Plant_10', 'Plant_11', 'Plant_12',
  'Plant_13', 'Plant_14', 'Plant_15', 'Plant_16',
  'Plant_17', 'Plant_18', 'Plant_19', 'Plant_20',
  'Plant_21',
]
