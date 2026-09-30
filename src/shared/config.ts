// =============================================================
// The Living Garden — Shared Configuration
// Imported by both server and client so constants stay in sync.
// =============================================================

import { hofAvenueSlots, HOF_FRONT_OUT } from './hallOfFame'

/** Daily bloom windows in UTC. Add or remove entries to change the schedule. */
export const BLOOM_WINDOWS: ReadonlyArray<{ hour: number; minute: number }> = [
  { hour:  5, minute: 30 },   // 05:30 UTC
  { hour: 17, minute: 30 },   // 17:30 UTC
]

export const TOTAL_PLANTS       = 38   // 32 regular + 6 fast
export const BLOOM_THRESHOLD    = Math.ceil(TOTAL_PLANTS * 0.8)

// ── v2: gardener-scaled DECAY (KJ decision 2026-09-16, replaces threshold scaling) ──
// The bloom threshold stays a flat 80% of the garden for everyone, so a solo
// player still "completes" the watering; what scales with gardeners present is
// how fast plants dry out. Solo pace is ~1 plant per 4–5 s (31 plants ≈ 2.5 min),
// so solo decay must comfortably exceed that; the garden gets thirstier with
// each extra gardener until the v1 rate at DECAY_FULL_GARDENERS (GDD §5 "four").
export const DECAY_FACTOR_AT_SOLO  = 3.0   // TUNING — solo: 3 min × 3 = 9 min per plant
export const DECAY_FULL_GARDENERS  = 4     // at this many, decay is the base (v1) rate

/** Multiplier on the base expiry for `gardeners` present: 1 → 3.0, 2 → 2.33, 3 → 1.67, 4+ → 1. */
export function decayFactor(gardeners: number): number {
  const n = Math.max(1, Math.min(DECAY_FULL_GARDENERS, gardeners))
  return DECAY_FACTOR_AT_SOLO + (1 - DECAY_FACTOR_AT_SOLO) * (n - 1) / (DECAY_FULL_GARDENERS - 1)
}

/** Bloom size for the FX/seed phases: solo blooms stay small and quiet (GDD §3),
 *  a full-garden bloom needs DECAY_FULL_GARDENERS present. */
export function bloomScaleFor(gardeners: number): number {
  return Math.max(1, Math.min(DECAY_FULL_GARDENERS, gardeners)) / DECAY_FULL_GARDENERS
}

// ── v2: bloom seeds (GDD §3 step 3, §6 walk-through gathering) ──
// Seeds are a SHARED spectacle with PER-PLAYER pickup: every player sees the same
// rain and may collect each seed once — nobody takes a seed from anyone else.
// Yield and rarity scale with CONTRIBUTORS — players who watered this cycle (KJ
// 2026-09-18), same count as the bloom's length. Since everyone collects every seed,
// count is capped (~×2.5) and the group reward goes into RARITY instead (~×3), plus a
// guaranteed Rare-or-better seed when enough gardeners bloom together.
const SEEDS_BY_CONTRIBUTORS     = [4, 5, 6, 7, 8, 10]            // TUNING — 1..6+
const RARE_MULT_BY_CONTRIBUTORS = [1, 1.4, 1.8, 2.2, 2.6, 3]     // TUNING — × SEED_RARE_AT_SOLO
export const SEED_RARE_AT_SOLO  = 0.10      // TUNING — "mostly normal, occasionally rare"
export const GUARANTEED_RARE_AT_CONTRIBUTORS = 4   // TUNING — one seed of tier ≥ Rare from here
/** Press-and-hold watering (skillCheck.tsx). The server applies HOLD_SWEET_BONUS; it only sees the flag. */
/** Off 2026-09-24 (KJ: "crap, and can be overridden with a tap"); back ON 2026-09-27 as a real skill
 *  check (KJ: "facing the right way with the camera and pressing for a random amount of time shown
 *  on the screen"). There is NO tap bypass any more — a pour is the only way to water:
 *    • the meter fills only while the camera faces the plant (within HOLD_AIM_CONE_DEG), and drains
 *      at HOLD_DRAIN × the fill speed while you look away;
 *    • the green window is RANDOM per pour — start in [HOLD_SWEET_MIN_AT, HOLD_SWEET_MAX_AT], width
 *      in [HOLD_SWEET_W_MIN, HOLD_SWEET_W_MAX] — so a timing can't be memorised;
 *    • let go below HOLD_MIN_POUR: too little, nothing happens; anywhere else before the red: watered;
 *      in the green: a perfect pour (+HOLD_SWEET_BONUS watered time, streak +1); in the red
 *      (HOLD_OVER_GAP past the green) or holding to full: too much, NOT watered. */
export const HOLD_WATERING_ENABLED = true
export const HOLD_FILL_MS       = 2_000   // TUNING — empty to full while facing the plant
export const HOLD_MIN_POUR      = 0.18    // TUNING
export const HOLD_SWEET_MIN_AT  = 0.35    // TUNING
export const HOLD_SWEET_MAX_AT  = 0.7     // TUNING
export const HOLD_SWEET_W_MIN   = 0.12    // TUNING
export const HOLD_SWEET_W_MAX   = 0.2     // TUNING
export const HOLD_OVER_GAP      = 0.08    // TUNING
export const HOLD_AIM_CONE_DEG  = 35      // TUNING — generous: on a phone you tap the plant off-centre
export const HOLD_DRAIN         = 0.6     // TUNING
export const HOLD_SWEET_BONUS = 0.4        // TUNING — fraction of the plant's normal watered time added
export const HOLD_SHOW_AFTER_MS = 250      // shorter than this is a plain tap: no meter
/** A Bloom keeps the plants watered during it through the reset (2026-09-22). Playtest
 *  2026-09-24: the garden still sitting healthy after a Bloom made the loop confusing. */
export const BLOOM_KEEPS_WATERED = false
/** Seed chase (KJ 2026-09-24): rarer seeds hop away from an approaching gardener, a limited
 *  number of times, then let themselves be caught. Index = rarity tier (Common .. Unique).
 *  Cosmetic and client-side — every seed is still gathered through the server. */
export const SEED_DODGES_BY_TIER: ReadonlyArray<number> = [0, 2, 2, 4, 4, 4, 4, 4]   // TUNING
export const SEED_DODGES_MOBILE_MAX = 1     // TUNING — the phone joystick is imprecise
export const SEED_DODGE_TRIGGER_M = 3.0     // m — a dodger hops when you get this close
export const SEED_HOP_M_LOW  = 2.5          // m per hop, Uncommon / Rare
export const SEED_HOP_M_HIGH = 3.5          // m per hop, Epic and above
export const SEED_HOP_MS     = 600          // TUNING
export const SEED_HOP_ARC_H  = 0.7          // m the hop rises
export const SEED_HOP_COOLDOWN_MS = 350     // after landing, before it can hop again
export const SEED_NO_DODGE_LAST_MS = 20_000 // stop dodging this close to a seed's evaporation
export const SEED_FLIGHT_SPEED  = 4.0       // TUNING — m/s along the ground, so a far seed takes longer and stays visible
export const SEED_FLIGHT_MIN_MS = 2_600
export const SEED_FLIGHT_MAX_MS = 5_000
export const SEED_LAUNCH_STAGGER_MS = 1_200 // TUNING — seeds leave the Bloom one by one over this window
export const SEED_ARC_H         = 4.0       // TUNING — m the arc rises above the straight line
export const SEED_FLIGHT_SCALE  = 3.0       // TUNING — seeds are this much bigger at launch, easing to normal on landing
/** 2026-09-28 (KJ: "move bloom model and surrounding text forward, towards the spawn
 *  position", then "bloom model and text to go backwards (-x) by .5m") — the composite
 *  bakes the Bloom model's and its centerText GLBs' transforms, so this nudges them at
 *  setup instead of round-tripping through Blender/Creator Hub, the same reason
 *  PLANT_LAYOUT exists. The default spawn sits at higher X than the Bloom and looks back
 *  at it (see scene.json), so +X is toward the spawn. Net of both requests: +2 then -0.5.
 *  Applied to the 'Bloom', 'centerTextBloom', 'centerTextProgress' and
 *  'CenterTextInstructions.glb' entities directly (bloomSystem.ts / wateringSystem.ts),
 *  and folded into the two reference points below so every VFX/audio anchor keeps
 *  following the model. */
export const BLOOM_MODEL_OFFSET_X = 1.5

/** Where seeds pour out of the Bloom: the crown of the flower, measured from Models/Bloom/Bloom.glb
 *  (node at 5.81, -0.66, 23.91; ~6.5 m wide, top at y≈5.6). Each seed starts within SEED_ORIGIN_SPREAD_M of it. */
export const BLOOM_SEED_ORIGIN = { x: 5.8 + BLOOM_MODEL_OFFSET_X, y: 5.3, z: 23.9 } as const
export const SEED_ORIGIN_SPREAD_M = 1.2
export const SEED_LIFETIME_MS   = 120_000   // ungathered seeds fade after 2 min (the trickle's last wave lands 1 min before the end)
export const SEED_GATHER_RADIUS = 2.0       // m — walking this close starts the drift toward you
export const SEED_COLLECT_RADIUS = 0.9      // m — seed this close is gathered (client sends request)
export const SEED_SPAWN_HEIGHT  = 7         // m — seeds fall from the bloom canopy

const byContributors = <T>(table: ReadonlyArray<T>, contributors: number): T =>
  table[Math.max(1, Math.min(table.length, contributors)) - 1]

/** Seeds a bloom drops in total (across all its trickle waves). */
export function seedSpawnCount(contributors: number): number {
  return byContributors(SEEDS_BY_CONTRIBUTORS, contributors)
}

/** Chance a seed rolls ABOVE Common: 10% solo → 30% at 6+ contributors. `rareSeedMult`
 *  is BLOOM_VARIANTS' per-variant boost (moonlit blooms roll rarer); capped at 1. See
 *  rollSeedTier for what "above Common" rolls into. */
export function seedRareChance(contributors: number, rareSeedMult = 1): number {
  return Math.min(1, SEED_RARE_AT_SOLO * byContributors(RARE_MULT_BY_CONTRIBUTORS, contributors) * rareSeedMult)
}
/** Rare Plant Gallery → Bloom (KJ 2026-09-27: "still two divorced games"). Every flower on show in
 *  the Gallery raises the rare-seed chance of EVERY Bloom, for everyone — the rarer the flower, the
 *  bigger its share. Summed over the Gallery, capped, and applied as ×(1 + boost) on top of the
 *  gardener and variant multipliers. The server snapshots it when a Bloom triggers. */
export const GALLERY_BOOST_BY_TIER: ReadonlyArray<number> = [0, 0, 0.02, 0.03, 0.04, 0.05, 0.08, 0.1]   // TUNING — index = rarity tier
export const GALLERY_BOOST_CAP = 0.5   // TUNING — a packed Gallery at most +50%
export function galleryBoostOf(tier: number): number {
  return GALLERY_BOOST_BY_TIER[Math.max(0, Math.min(GALLERY_BOOST_BY_TIER.length - 1, Math.floor(tier)))] ?? 0
}
export function galleryBoost(tiers: ReadonlyArray<number>): number {
  return Math.min(GALLERY_BOOST_CAP, tiers.reduce((sum, t) => sum + galleryBoostOf(t), 0))
}
/** How long health must stay ≥ BLOOM_THRESHOLD (cumulatively) before bloom fires.
 *  Shared by server (sustain timer) and client (countdown display). */
export const BLOOM_SUSTAIN_MS   = 60_000   // the FULL-garden hold (4+ gardeners)
/** Hold time scales with gardeners like decay does (KJ 2026-09-17): solo, a minute is dead
 *  time — nothing can dry at 9-min decay — while in a group the hold IS the tension. */
const SUSTAIN_BY_GARDENERS_MS = [20_000, 35_000, 50_000, BLOOM_SUSTAIN_MS]   // TUNING — 1, 2, 3, 4+
export function bloomSustainMs(gardeners: number): number {
  return SUSTAIN_BY_GARDENERS_MS[Math.max(1, Math.min(SUSTAIN_BY_GARDENERS_MS.length, gardeners)) - 1]
}
export const DAILY_WATER_LIMIT  = 8
export const WATERED_EXPIRY_MS  = 3 * 60 * 1000        // 3 minutes
export const FAST_PLANT_EXPIRY_MS = 75_000               // 75 seconds
/** How long after bloom triggers before the server resets all plants. */
export const BLOOM_RESET_DELAY_MS = 6 * 60_000          // 6 minutes — the LONGEST bloom (see bloomDurationMs)
/** Watering is allowed DURING a bloom and unexpired plants survive its end (week-2 playtest
 *  2026-09-22: "3 minutes with nothing to do", "two divorced games"), so the next cycle can
 *  start above threshold. This cooldown is the only thing stopping a bloom re-firing the
 *  moment the last one ends. The client's post-bloom wind-down (`bloomActive` in
 *  wateringSystem) reads the SAME value, so the countdown banner stays hidden exactly as
 *  long as the server is refusing to start one. */
export const BLOOM_TRIGGER_COOLDOWN_MS = 65_000   // TUNING
/** Expiry tell: a watered plant shows its drop again this long before it dries out, and a
 *  water inside that window is accepted as a top-up — full timer again, counts as a water.
 *  The in-pillar answer to "add a skill check": a decision, not a reflex. */
export const EXPIRY_TELL_MS = 20_000   // TUNING
/** Server anti-cheat (2026-09-28): the minimum gap between two accepted waters from the
 *  same address, and how close (metres, scene-local) they must be standing to the plant.
 *  waterPlant had neither before — a scripted client could farm the lifetime-water
 *  flair tiers alone. Loose on purpose: never meant to catch a human's real tap rate or
 *  aim, just a scripted loop or a water sent from across the garden. */
export const WATER_COOLDOWN_MS = 1_500   // TUNING
/** Gap between two tends of the SAME seedling (KJ 2026-09-30: five in a row is silly, a few seconds between feels natural). */
export const TEND_COOLDOWN_MS = 6_000   // TUNING
export const WATER_REACH_M     = 4       // TUNING — the CLIENT's horizontal gate at the moment you press
/** The server judges at RELEASE (a pour is a hold, so you may have drifted) from a position that lags on phones, and only
 *  horizontally — the client gate is horizontal too, and a 3-D check against a plant standing 1.3 m up rejected pours the client
 *  had happily started (KJ 2026-09-30: "vfx goes off but the plant stays droopy"). Still tight enough to stop a water sent from across the garden. */
export const WATER_REACH_SLACK_M = 2   // TUNING
/** The floating drop over a plant (or a friend's seedling) that needs water — bob is baked in. */
export const WATER_DROP_MODEL_SRC = 'assets/scene/Models/waterDrop/waterDrop_bob.glb'

/** Bloom length by CONTRIBUTORS this cycle (players who watered since the last reset —
 *  not just present, so idlers can't stretch it). KJ 2026-09-18: solo 2 min … 6+ → 6 min.
 *  Index = contributors − 1; beyond the table stays at the last value. */
const BLOOM_MINUTES_BY_CONTRIBUTORS = [2, 3, 3.5, 4, 5, 6]   // TUNING
export function bloomDurationMs(contributors: number): number {
  const i = Math.max(1, Math.min(BLOOM_MINUTES_BY_CONTRIBUTORS.length, contributors)) - 1
  return BLOOM_MINUTES_BY_CONTRIBUTORS[i] * 60_000
}

/** Seed trickle: the bloom's seeds fall in waves across the bloom instead of all at once.
 *  Waves are SEED_WAVE_GAP_MS apart at most; the last one lands SEED_LAST_WAVE_BEFORE_END_MS
 *  before the bloom ends so it can still be gathered in the bloom. */
export const SEED_WAVE_GAP_MS             = 30_000   // TUNING
export const SEED_LAST_WAVE_BEFORE_END_MS = 60_000   // TUNING
/** The Bloom's OpenAction plays at 0.25x speed and it reaches OpenIdle 20 s after the trigger
 *  (bloomSystem BLOOM_SWITCH_TO_OPEN_MS). Seeds used to leave at t=0, out of a still-closed flower
 *  (KJ client log 2026-09-24). The opening burst now waits for the flower to be open, and carries
 *  most of the seeds so it reads as a shower; the rest trickle in afterwards. */
export const BLOOM_OPEN_MS = 20_000
export const SEED_BURST_FRACTION = 0.6   // TUNING — share of a bloom's seeds in the opening burst

// ── Scene-wide spatial / asset constants ─────────────────────
/** World-space centre of the Bloom model — used for sound, sparkles, shockwaves. */
export const BLOOM_CENTER = { x: 6.75 + BLOOM_MODEL_OFFSET_X, y: 2, z: 24 } as const
/** Shared sparkle texture used by all particle / FX systems. */
export const SPARKLE_SRC  = 'assets/scene/Images/sparkle.png'
/** Garden walkable area bounds — used for ambient FX spawning. */
export const GARDEN_BOUNDS = { xMin: 3, xMax: 14, zMin: 3, zMax: 22 } as const
/** Where Bloom seeds land and hop (KJ 2026-09-30: they only ever fell on ONE side of the Bloom). GARDEN_BOUNDS is the old
 *  single-side box and still drives the ambient FX; seeds use this one — the whole plant field (plants stand at x 4..28,
 *  z -5..53), both sides of the Bloom in x and z, minus a keep-out disc round the Bloom itself. TUNING. */
export const SEED_LAND_BOUNDS = { xMin: 4, xMax: 27, zMin: 2, zMax: 46 } as const
export const SEED_LAND_BLOOM_KEEPOUT_M = 4.5

// ── Rainbow seed chase (KJ 2026-09-18 as the "golden seed"; rainbow since 2026-09-19 so
// gold stays the Unique tier's colour). Code names still say "golden".
// One per bloom: appears GOLDEN_SEED_AT_FRACTION into the bloom and wanders the garden
// until it ends. Everyone may catch it once; each catcher rolls their own tier by
// RAINBOW_TIER_WEIGHTS. The server sends only { spawnedAt, pathSeed } — every client
// computes the same position from goldenSeedPos, so nothing streams per frame.
export const GOLDEN_SEED_AT_FRACTION   = 0.3   // TUNING — late enough that bloom-arrivals see it
/** What a rainbow catch rolls into — the realistic route to Mythic and Unique. */
// Legendary / Exotic ONLY. It used to roll Mythic 12% and Unique 3% for EVERY gardener who caught it, which made the hard tiers
// far easier than the ordinary roll (KJ 2026-09-25: Mythic and Unique must be hard). Mythic and Unique come only from the ordinary roll.
const RAINBOW_TIER_WEIGHTS: ReadonlyArray<[number, number]> = [[4, 65], [5, 35]]   // TUNING — [tier, weight]
export function rollRainbowTier(): number {
  let r = Math.random() * RAINBOW_TIER_WEIGHTS.reduce((a, [, w]) => a + w, 0)
  for (const [tier, w] of RAINBOW_TIER_WEIGHTS) { r -= w; if (r <= 0) return tier }
  return RAINBOW_TIER_WEIGHTS[0][0]
}
export const GOLDEN_SEED_CATCH_RADIUS  = 1.3   // m, 3D from chest height — generous for mobile

/** Where the golden seed is `tSec` after it appeared: a slow Lissajous wander inside
 *  GARDEN_BOUNDS (top speed ≈ 1 m/s — a gentle chase, never a sprint). */
export function goldenSeedPos(tSec: number, pathSeed: number): { x: number; y: number; z: number } {
  const b  = GARDEN_BOUNDS, margin = 0.8
  const cx = (b.xMin + b.xMax) / 2, ax = (b.xMax - b.xMin) / 2 - margin
  const cz = (b.zMin + b.zMax) / 2, az = (b.zMax - b.zMin) / 2 - margin
  const f  = (k: number) => (pathSeed * k) % 1                 // pathSeed-derived 0..1 values
  const w1 = 0.08 + 0.04 * f(0.37), w2 = 0.05 + 0.03 * f(0.71)
  return {
    x: cx + ax * Math.sin(w1 * tSec + f(0.13) * Math.PI * 2),
    y: 1.5 + 0.35 * Math.sin(0.9 * tSec + f(0.53) * Math.PI * 2),
    z: cz + az * Math.sin(w2 * tSec + f(0.91) * Math.PI * 2),
  }
}

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

/** How long a plant stays watered when watered with `gardeners` present. */
export function plantDecayMs(plantId: string, gardeners: number): number {
  const base = FAST_PLANT_NAMES.has(plantId) ? FAST_PLANT_EXPIRY_MS : WATERED_EXPIRY_MS
  return Math.round(base * decayFactor(gardeners))
}

// ── v2: seed boxes (GDD §3 step 4, §4.1 D1 hook, §4.3 seed appointment) ──
// A caught seed is planted in a named box in the SHARED garden; it grows on a
// real-world timer and opens as an unidentified flower (rarity known, identity not).
// Planter layout — REBAKED 2026-09-29 from KJ's updated scene.glb: six 1.38 m x 28.4 m planter strips (PlanterBox_newMat.052 holds four rows,
// .001 two). 96 planters = 24 beds of 4 (design/planter-beds-from-scene-glb.json), four beds per strip, numbered from the shed door outward.
// Each strip carries its beds centred on it: planters on the strip's centre line, 1.5 m pitch, 1 m between beds, 0.72 m spare at each end. Rows face the
// door axis (x -18.9): west of it rot 90 (front +x), east of it rot 270 (front -x). world = (8 - glb.x, glb.z + 24). rot: 0 = front faces +z, 90 = +x,
// 180 = -z, 270 = -x. Ids are stable BY BED: new bed k keeps the ids of the previous bake's bed k, so KJ's four planted planters (box_4, box_6, box_99,
// box_100) are still bed 1 (now the strip nearest the door, x -16.85). Previous tables: design/layout-tables.bak-0929.ts. Before that: 2026-09-25 bake.
// 2026-09-30: each row of four is now TWO pairs — the inner pairs were pushed 0.25 m apart each way (pair gap 2.0 m centre to centre, same as the
// gap between fours) so beds of two read as pairs. Backup of the pre-shift table: scratchpad config.ts.bak-before-pair-shift.
export const BOX_POSITIONS: ReadonlyArray<{ id: string; x: number; z: number; rot: number }> = [
  { id: 'box_4', x: -16.85, z: 37, rot: 270 },
  { id: 'box_6', x: -16.85, z: 35.5, rot: 270 },
  { id: 'box_99', x: -16.85, z: 33.5, rot: 270 },
  { id: 'box_100', x: -16.85, z: 32, rot: 270 },

  { id: 'box_1', x: -12.85, z: 37, rot: 270 },
  { id: 'box_2', x: -12.85, z: 35.5, rot: 270 },
  { id: 'box_3', x: -12.85, z: 33.5, rot: 270 },
  { id: 'box_50', x: -12.85, z: 32, rot: 270 },

  { id: 'box_51', x: -8.84, z: 37, rot: 270 },
  { id: 'box_52', x: -8.84, z: 35.5, rot: 270 },
  { id: 'box_53', x: -8.84, z: 33.5, rot: 270 },
  { id: 'box_54', x: -8.84, z: 32, rot: 270 },

  { id: 'box_55', x: -31.24, z: 37, rot: 90 },
  { id: 'box_56', x: -31.24, z: 35.5, rot: 90 },
  { id: 'box_57', x: -31.24, z: 33.5, rot: 90 },
  { id: 'box_58', x: -31.24, z: 32, rot: 90 },

  { id: 'box_59', x: -4.83, z: 37, rot: 270 },
  { id: 'box_60', x: -4.83, z: 35.5, rot: 270 },
  { id: 'box_61', x: -4.83, z: 33.5, rot: 270 },
  { id: 'box_62', x: -4.83, z: 32, rot: 270 },

  { id: 'box_63', x: -35.25, z: 37, rot: 90 },
  { id: 'box_64', x: -35.25, z: 35.5, rot: 90 },
  { id: 'box_65', x: -35.25, z: 33.5, rot: 90 },
  { id: 'box_66', x: -35.25, z: 32, rot: 90 },

  { id: 'box_67', x: -16.85, z: 30, rot: 270 },
  { id: 'box_68', x: -16.85, z: 28.5, rot: 270 },
  { id: 'box_69', x: -16.85, z: 26.5, rot: 270 },
  { id: 'box_70', x: -16.85, z: 25, rot: 270 },

  { id: 'box_71', x: -12.85, z: 30, rot: 270 },
  { id: 'box_72', x: -12.85, z: 28.5, rot: 270 },
  { id: 'box_73', x: -12.85, z: 26.5, rot: 270 },
  { id: 'box_74', x: -12.85, z: 25, rot: 270 },

  { id: 'box_75', x: -8.84, z: 30, rot: 270 },
  { id: 'box_76', x: -8.84, z: 28.5, rot: 270 },
  { id: 'box_77', x: -8.84, z: 26.5, rot: 270 },
  { id: 'box_78', x: -8.84, z: 25, rot: 270 },

  { id: 'box_79', x: -31.24, z: 30, rot: 90 },
  { id: 'box_80', x: -31.24, z: 28.5, rot: 90 },
  { id: 'box_81', x: -31.24, z: 26.5, rot: 90 },
  { id: 'box_82', x: -31.24, z: 25, rot: 90 },

  { id: 'box_83', x: -4.83, z: 30, rot: 270 },
  { id: 'box_84', x: -4.83, z: 28.5, rot: 270 },
  { id: 'box_85', x: -4.83, z: 26.5, rot: 270 },
  { id: 'box_86', x: -4.83, z: 25, rot: 270 },

  { id: 'box_87', x: -35.25, z: 30, rot: 90 },
  { id: 'box_88', x: -35.25, z: 28.5, rot: 90 },
  { id: 'box_89', x: -35.25, z: 26.5, rot: 90 },
  { id: 'box_90', x: -35.25, z: 25, rot: 90 },

  { id: 'box_91', x: -16.85, z: 23, rot: 270 },
  { id: 'box_92', x: -16.85, z: 21.5, rot: 270 },
  { id: 'box_93', x: -16.85, z: 19.5, rot: 270 },
  { id: 'box_94', x: -16.85, z: 18, rot: 270 },

  { id: 'box_97', x: -12.85, z: 23, rot: 270 },
  { id: 'box_98', x: -12.85, z: 21.5, rot: 270 },
  { id: 'box_101', x: -12.85, z: 19.5, rot: 270 },
  { id: 'box_102', x: -12.85, z: 18, rot: 270 },

  { id: 'box_103', x: -8.84, z: 23, rot: 270 },
  { id: 'box_104', x: -8.84, z: 21.5, rot: 270 },
  { id: 'box_105', x: -8.84, z: 19.5, rot: 270 },
  { id: 'box_106', x: -8.84, z: 18, rot: 270 },

  { id: 'box_107', x: -31.24, z: 23, rot: 90 },
  { id: 'box_108', x: -31.24, z: 21.5, rot: 90 },
  { id: 'box_109', x: -31.24, z: 19.5, rot: 90 },
  { id: 'box_110', x: -31.24, z: 18, rot: 90 },

  { id: 'box_111', x: -4.83, z: 23, rot: 270 },
  { id: 'box_112', x: -4.83, z: 21.5, rot: 270 },
  { id: 'box_113', x: -4.83, z: 19.5, rot: 270 },
  { id: 'box_114', x: -4.83, z: 18, rot: 270 },

  { id: 'box_115', x: -35.25, z: 23, rot: 90 },
  { id: 'box_116', x: -35.25, z: 21.5, rot: 90 },
  { id: 'box_117', x: -35.25, z: 19.5, rot: 90 },
  { id: 'box_118', x: -35.25, z: 18, rot: 90 },

  { id: 'box_119', x: -16.85, z: 16, rot: 270 },
  { id: 'box_120', x: -16.85, z: 14.5, rot: 270 },
  { id: 'box_121', x: -16.85, z: 12.5, rot: 270 },
  { id: 'box_122', x: -16.85, z: 11, rot: 270 },

  { id: 'box_123', x: -12.85, z: 16, rot: 270 },
  { id: 'box_124', x: -12.85, z: 14.5, rot: 270 },
  { id: 'box_125', x: -12.85, z: 12.5, rot: 270 },
  { id: 'box_126', x: -12.85, z: 11, rot: 270 },

  { id: 'box_127', x: -8.84, z: 16, rot: 270 },
  { id: 'box_128', x: -8.84, z: 14.5, rot: 270 },
  { id: 'box_129', x: -8.84, z: 12.5, rot: 270 },
  { id: 'box_130', x: -8.84, z: 11, rot: 270 },

  { id: 'box_131', x: -31.24, z: 16, rot: 90 },
  { id: 'box_132', x: -31.24, z: 14.5, rot: 90 },
  { id: 'box_133', x: -31.24, z: 12.5, rot: 90 },
  { id: 'box_134', x: -31.24, z: 11, rot: 90 },

  { id: 'box_135', x: -4.83, z: 16, rot: 270 },
  { id: 'box_136', x: -4.83, z: 14.5, rot: 270 },
  { id: 'box_137', x: -4.83, z: 12.5, rot: 270 },
  { id: 'box_138', x: -4.83, z: 11, rot: 270 },

  { id: 'box_139', x: -35.25, z: 16, rot: 90 },
  { id: 'box_140', x: -35.25, z: 14.5, rot: 90 },
  { id: 'box_141', x: -35.25, z: 12.5, rot: 90 },
  { id: 'box_142', x: -35.25, z: 11, rot: 90 },
]
// ── Sky ──────────────────────────────────────────────────────
/** The garden's resting sky: golden hour, all the time (KJ 2026-09-29). Seconds since 00:00
 *  for SkyboxTime (43200 = noon, 86400 = midnight) — 16:00 puts the sun lowish and warm.
 *  Nudge earlier for a higher sun, later (17:00 = 61200, 18:00 = 64800, 19:00 = 68400) for dusk. TUNING */
export const GOLDEN_HOUR_S = 57_600

// ── Onboarding (v2) ──────────────────────────────────────────
/** KJ's ground arrow (2026-09-20): 20 tris, gold emissive, no texture, lying flat in
 *  the XZ plane — 2 m wide, 1.1 m deep. Used by the onboarding to point at the thing
 *  the player should tap next. */
export const ARROW_MODEL_SRC = 'assets/scene/Models/arrow/Arrow.glb'
export const ARROW_SCALE     = 0.5
/** Yaw applied AFTER aiming the arrow at its target. The model's own forward axis is
 *  unverified in-world — if the arrow points away from what it should indicate, this
 *  is the single value to flip (180 ↔ 0). */
export const ARROW_FORWARD_YAW = 180
/** Metres back from the target, toward the player, where the arrow sits — far enough
 *  out that it lands on open ground rather than inside the plant. */
export const ARROW_STANDOFF = 1.2
/** The trail floats at the PLAYER's hip, not on the ground (KJ 2026-09-29): a decal at the
 *  target's feet was easy to lose against the grass and the planters. Metres above the
 *  player's feet, so it follows them up and down the ledges. TUNING */
export const ARROW_HIP_HEIGHT = 0.95
/** Gentle bob, driven from the onboarding system's own tick. Deliberately NOT a looping
 *  Tween: the explorer writes every actively-tweened Transform back into the scene every
 *  frame, which is what tanked scene tick fps in the 09-18 perf pass. */
export const ARROW_BOB_AMPLITUDE = 0.08
/** How often the onboarding re-picks which plant to point at (seconds). */
export const ONBOARDING_REPICK_S = 0.25
/** Don't point at anything further away than this — better to show nothing than to
 *  aim across the whole garden. */
export const ONBOARDING_MAX_RANGE = 40
/** The pointer trail runs the WHOLE way from the target back to the player's feet, so
 *  it is findable from across the garden. Fin playtest 2026-09-21: the old fixed row of
 *  4 x 0.9 m spanned 3.9 m, so the arrows clustered at the target and read as "only four
 *  arrows" from anywhere else. The pool is capped; past MAX x SPACING the gaps stretch
 *  rather than the row stopping short, so it always reaches the player. */
export const ARROW_CHEVRON_MAX     = 24
export const ARROW_CHEVRON_SPACING = 1.8
/** The pulse travels toward the target at a fixed metres/second with a fixed wavelength,
 *  NOT once-along-the-row: a row-relative phase would strobe faster and faster as the
 *  trail grows, and the trail is now any length from 0 to the width of the garden. */
export const ARROW_WAVE_SPEED  = 6
export const ARROW_WAVE_LENGTH = 5.4

/** A column of light standing on the tutorial target. The chevrons say which way to walk
 *  once you are near; this is what makes the target FINDABLE from the far side of the
 *  garden (Fin 2026-09-21: "so I can see them from the other side of the map"). Static:
 *  the chevron row already carries the motion, and re-writing a material every frame
 *  rebuilds it. Cylinder only, no collider - it must never swallow a tap meant for a
 *  plant or a planter. */
/** The bottom-of-screen dev line (fps + canvas/safe-area calibration). OFF since
 *  2026-09-21 - KJ: "this is the tool tip we wanted to remove". Flip to true for a perf or
 *  safe-area pass; the numbers are still in the [UI] boot log either way. */
/** How far a droopy plant's water drop is VISIBLE (metres, in / out for hysteresis).
 *  The drops are the brightest thing in the frame after the sky — a value study of KJ's
 *  2026-09-21 screenshot posterised them to pure white blobs, a dozen-plus at once — so
 *  showing every one across a 30x58 m garden turns the affordance into wallpaper. Near
 *  ones still point; distant ones let the garden be looked at. The droopy POSE is still
 *  the tell at range, which is what GDD 6 relies on anyway. Wider than ANIM_RANGE: a drop
 *  you can see should bob, but a drop can stop bobbing before it stops being useful. */
export const DROP_RANGE     = 20
export const DROP_RANGE_OUT = 24

export const SHOW_DEV_OVERLAY = false

/** Almanac milestones — the "big goal for others to achieve" Fin asked for (2026-09-21).
 *  Keyed on SPECIES discovered, deliberately never on species x rarity pairs: there are
 *  76 x 8 = 608 of those, and a Common Rose and a Legendary Rose are the same model with
 *  different VFX, so a pair-based goal is both unreachable and hollow.
 *  Each one pays a guaranteed seed, and the later ones a permanent extra planter. The
 *  planter grants are BOUNDED on purpose (+3 across the whole ladder, once ever): planters
 *  are a fixed commons of 96, and GDD 3.1 promises "new players can always plant", so an
 *  unbounded reward would eat the commons — see the planter-scaling note in design/todo.md.
 *  `species: -1` means the whole catalogue, so adding species never strands the last rung. */
export interface AlmanacMilestone { species: number; seedTier: number; planters: number; title: string }
export const ALMANAC_MILESTONES: ReadonlyArray<AlmanacMilestone> = [
  { species: 10, seedTier: 2, planters: 0, title: 'Gardener' },       // TUNING
  { species: 25, seedTier: 3, planters: 1, title: 'Botanist' },
  { species: 50, seedTier: 5, planters: 1, title: 'Curator' },
  { species: -1, seedTier: 5, planters: 1, title: 'Keeper of the Garden' },   // Exotic, NOT Unique: a Unique for every Keeper is a Unique for everyone (KJ 2026-09-25)
]
/** STAMP milestones (KJ 2026-09-25): a second ladder on RARITY STAMPS (each species in each rarity). The species
 *  ladder above ends within a day or two at a 2-minute growth base, so this one paces the rest of the month. Same
 *  reward shape; kept separate so the two ladders can never double-pay. -1 = every stamp that exists.
 *  Planter grants are deliberately few (a planter is faster progress). */
export interface StampMilestone { stamps: number; seedTier: number; planters: number; title: string }
export const STAMP_MILESTONES: ReadonlyArray<StampMilestone> = [
  { stamps: 25,  seedTier: 2, planters: 0, title: 'Collector' },          // TUNING
  { stamps: 50,  seedTier: 3, planters: 0, title: 'Cataloguer' },
  { stamps: 100, seedTier: 3, planters: 1, title: 'Archivist' },
  { stamps: 150, seedTier: 4, planters: 0, title: 'Connoisseur' },
  { stamps: 200, seedTier: 4, planters: 0, title: 'Rarity Hunter' },
  { stamps: 300, seedTier: 5, planters: 1, title: 'Grand Collector' },
  { stamps: 400, seedTier: 5, planters: 0, title: 'Master Collector' },
  { stamps: -1,  seedTier: 5, planters: 0, title: 'Keeper of Every Bloom' },   // Exotic: the prestige is the title, never a Unique seed
]
export function stampMilestoneTarget(m: StampMilestone): number { return m.stamps < 0 ? stampTotal() : m.stamps }
export function nextStampMilestone(found: number): StampMilestone | null {
  return STAMP_MILESTONES.find(m => found < stampMilestoneTarget(m)) ?? null
}
/** Stamps in a discovered list: one per distinct `${species}|${tier}` entry. A bare species id (the first hours of
 *  that key) has no rarity, so it is a species but not a stamp. */
export function stampCount(list: ReadonlyArray<string>): number {
  const seen = new Set<string>()
  for (const e of list) {
    const bar = e.lastIndexOf('|')
    if (bar > 0 && Number.isInteger(Number(e.slice(bar + 1))) && e.slice(bar + 1) !== '') seen.add(e)
  }
  return seen.size
}

/** How many species this rung actually needs (-1 = every species in the catalogue). */
export function milestoneTarget(m: AlmanacMilestone): number {
  return m.species < 0 ? PLANT_SPECIES.length : m.species
}
/** The rung they are working toward, or null once the ladder is finished. */
export function nextMilestone(speciesFound: number): AlmanacMilestone | null {
  return ALMANAC_MILESTONES.find(m => speciesFound < milestoneTarget(m)) ?? null
}
/** The title for a CLAIMED-RUNG COUNT (0 = none). The server tracks rungs rather than a
 *  species total for the boards, so one small number travels instead of a string. */
export function almanacTitleByRank(rank: number): string {
  return rank > 0 && rank <= ALMANAC_MILESTONES.length ? ALMANAC_MILESTONES[rank - 1].title : ''
}

/** The title they have earned, or '' before the first rung. */
export function milestoneTitle(speciesFound: number): string {
  let t = ''
  for (const m of ALMANAC_MILESTONES) if (speciesFound >= milestoneTarget(m)) t = m.title
  return t
}

/** How long the milestone card stays up. Longer than a discovery: it is rarer and it has
 *  more to say (title, what was granted, what the next rung is). */
export const MILESTONE_CARD_MS = 9_000

/** How long the discovery card stays up when one of your planters opens. Long enough to
 *  read the name and the rarity without being a modal you have to wait out. */
export const DISCOVERY_CARD_MS = 14_000   // includes the 2-5 s reveal build-up and the time to choose (discoveryCard.tsx)

export const BEACON_HEIGHT    = 7
export const BEACON_RADIUS    = 0.22
export const BEACON_COLOR     = { r: 1, g: 0.85, b: 0.35 }
export const BEACON_ALPHA     = 0.3
export const BEACON_INTENSITY = 1.6
/** 2026-09-28 ("prettier"): taper (top radius as a fraction of the base) and a gentle
 *  breathing pulse, instead of a flat static tube — same "free motion" FX taste as every
 *  other glow in the garden. */
export const BEACON_TAPER        = 0.35   // TUNING — top radius = BEACON_RADIUS × this
export const BEACON_PULSE_PERIOD_S = 1.8   // TUNING
export const BEACON_PULSE_DEPTH    = 0.35  // TUNING — 0 = no pulse, 1 = fades to nothing

// ── Guided tutorial (KJ 2026-09-27) ──────────────────────────────────────────
// One linear walk round the garden, each step a centre-screen card (the top pill went
// unnoticed) with the chevron trail + beacon pointing at where to go. Every step can be
// closed (X), skipped, or the whole tour ended; the bottom Tutorial button replays it.
// Positions are world metres read off KJ's scene.glb (world = 8 - x, y, z + 24).
export interface TutorialPoint { x: number; z: number }
/** Arches KJ named in scene.glb, centre of each opening — RE-READ 2026-09-29 from the
 *  re-exported scene.glb (shed arch moved ~1 m; the Fame arches moved 6.41 m east with the stands). */
export const ARCH_NORTH      = { x: 0.10,   z: 49.89 }   // garden → nursery
export const ARCH_SHED       = { x: -17.42, z: 49.38 }   // nursery → potting shed
export const ARCH_SOUTH      = { x: 31.90,  z: 49.21 }   // garden → Walk of Fame side
export const ARCH_SOUTH_SOUTH = { x: 31.90, z: -1.21 }
export const ARCH_FAME       = { x: 50.50,  z: 45.27 }   // into the Walk of Fame
export const ARCH_FAME_SOUTH = { x: 50.50,  z: 2.56 }    // out of it, the far end
/** A location step is done within this many metres (XZ) of its last waypoint. TUNING */
export const TUTORIAL_ARRIVE_M   = 4
/** Intermediate route waypoints count as passed within this. TUNING */
export const TUTORIAL_WAYPOINT_M = 3
export const TUTORIAL_DONE_MS    = 6_000   // the closing "you're set" moment

/** The step cards, in order. `kind` says what finishes the step (onboarding.ts). */
export const TUTORIAL_TEXT = {
  water:   { title: 'Water a plant', body: 'Face a plant with a water drop, press and hold to pour, and let go in the green.' },
  bloom:   { title: 'Water the garden', body: 'Keep the garden above 80% and the giant flower in the centre bursts open. More gardeners, and rarer flowers on show in the Gallery, both raise your Luck boost. Tap the health ring any time to see it.' },
  seeds:   { title: 'Catch the seeds', body: 'A seed has landed - follow the arrows and walk into it to catch it.' },
  arch:    { title: 'To the nursery', body: 'Follow the arrows through the arch - that is where seeds are grown.' },
  shed:    { title: 'The potting shed', body: 'Your seeds live on this rack - the rarer ones glow.' },
  plot:    { title: 'Your plot', body: 'Tap a free planter in your bed to plant a seed. It opens on a real-world timer.' },
  plotLook:{ title: 'Your plot', body: 'This is your bed - your planters grow here. Plant a seed whenever you catch one.' },
  tend:    { title: 'Water your seedling', body: 'Tap your seedling to water it - each water makes it grow faster.' },
  harvest: { title: 'Harvest your flower', body: 'Your flower has opened! Tap it to keep it.' },
  shelf:   { title: 'Your flowers', body: 'Every flower you harvest stands on this shelf. Hold one, or gift it to another gardener.' },
  toFame:  { title: 'The Rare Plant Gallery', body: 'Follow the arrows through the arches to the Rare Plant Gallery.' },
  fame:    { title: 'The Rare Plant Gallery', body: 'Only the rarest plants go on show here - and every one makes every Bloom\'s seeds rarer, for everyone. Tap a stand to display yours.' },
  loop:    { title: 'Seed shower', body: 'Head back and water the roses again - every Bloom brings a new seed shower.' },
  done:    { title: 'You know the garden', body: 'Tap ? any time to walk it again' },
} as const
/** How long a tutorial planter is held for its player, and how often the client
 *  re-asks while it has no reservation (someone else may have taken the last one). */
export const PLANTER_RESERVE_TTL_MS   = 4 * 60_000
export const PLANTER_RESERVE_RETRY_S  = 5

/** KJ's planter template (2026-09-17): origin at the base, front (+z) faces the
 *  garden, rim at y≈1.1. 4,440 tris — decimate before ship. */
export const BOX_MODEL_SRC   = 'assets/scene/Models/planterBox/planterBox.glb'
export const BOX_MODEL_SCALE = 0.6
export const BOX_MODEL_RIM_Y = 1.1 * BOX_MODEL_SCALE   // where the soil surface sits

/** KJ's toon planter (2026-09-20): a 190-tri single-material proxy of planterBox.glb at
 *  ~98% of its bounds, gold and emissive. Worn OVER the real planter, scaled up so it
 *  reads as a rim rather than sitting inside the mesh. */
// KJ 2026-09-25: "a softer highlight model (reduce transparency and/or shrink a tiny bit)". planterBoxToonSoft.glb is a COPY of the original
// with a semi-transparent, muted gold material (the original is untouched); the shell is also a touch tighter (1.05 -> 1.03).
export const TOON_HIGHLIGHT_SRC   = 'assets/scene/Models/planterBoxToon/planterBoxToonSoft.glb'
export const TOON_HIGHLIGHT_SCALE = BOX_MODEL_SCALE * 1.03

/** KJ split the balloons out of the box template (2026-09-17) into their own GLB so
 *  they can animate independently — same origin/scale as the box, balloons rise to
 *  y≈3.1 in model space, so placing it at the box's own transform reconstructs the
 *  original combined layout exactly. Shown while a box holds a seed or an unharvested
 *  flower (v.owner truthy). The file has two 5 s loop clips, presumably one per balloon
 *  cluster — both are played simultaneously since it isn't confirmed which drives what. */
/** Static, un-skinned balloon in its raised pose (KJ 2026-09-29). Replaced planterBalloon.glb, whose skinned clip +
 *  text Tweens cost too much to run on every planter. */
export const BALLOON_MODEL_SRC   = 'assets/scene/Models/staticBalloon/StaticBalloon.glb'
/** The ANIMATED balloon (skinned clip 'balloons' + text Tweens) — only a small pool of these is ever live, on the planters
 *  nearest the player (boxSystem balloonPoolSystem); every other planter shows the static one. */
export const BALLOON_ANIMATED_SRC = 'assets/scene/Models/planterBalloon/planterBalloon.glb'
export const BALLOON_ANIM_CLIPS   = ['balloons', 'balloons.001'] as const
/** KJ's seedling model (2026-09-17), stands in for the greybox sprout sphere while a
 *  box's seed is growing (unopened). The source file ships with no material — a
 *  `Material` component on the GltfContainer entity does NOT retint an imported mesh
 *  (that's not a thing GltfContainer supports; confirmed 2026-09-17 after the first
 *  attempt showed no visible difference between rarities). The two rarity colors are
 *  baked directly into two exported variants instead. */
export const SEEDLING_MODEL_SRC_NORMAL = 'assets/scene/Models/seedling/seedling_normal.glb'
/** KJ's seed models (2026-09-19), one per rarity tier, indexed by tier id (RARITY_TIERS).
 *  All share the same 152-tri mesh; the model is ~0.94 m tall, centred near its origin. */
export const SEED_MODEL_SRCS: ReadonlyArray<string> = [
  'assets/scene/Models/Seeds/CommonSeed/commonSeed.glb',
  'assets/scene/Models/Seeds/UncommonSeed/uncommonSeed.glb',
  'assets/scene/Models/Seeds/RareSeed/rareSeed.glb',
  'assets/scene/Models/Seeds/EpicSeed/epicSeed.glb',
  'assets/scene/Models/Seeds/LegendarySeed/legendarySeed.glb',
  'assets/scene/Models/Seeds/ExoticSeed/exoticSeed.glb',
  'assets/scene/Models/Seeds/MythicSeed/mythicSeed.glb',
  'assets/scene/Models/Seeds/UniqueSeed/uniqueSeed.glb',
]
export const SEED_MODEL_HEIGHT = 0.94   // m at scale 1 — divide a wanted world height by this
/** Seed carried in the hand (v2): the pouch made visible, so a gardener walking past
 *  reads as carrying something rather than holding a number in a menu. The model is
 *  SEED_MODEL_HEIGHT tall at scale 1 — this puts it at roughly a fist's width. */
export const SEED_HAND_WORLD_H = 0.22
export const SEED_HAND_SCALE   = SEED_HAND_WORLD_H / SEED_MODEL_HEIGHT
export const seedModelSrc = (tier: number): string => SEED_MODEL_SRCS[Math.max(0, Math.min(SEED_MODEL_SRCS.length - 1, tier))]
export const SEEDLING_MODEL_SRC_RARE   = 'assets/scene/Models/seedling/seedling_rare.glb'
/** TUNING — the base is COMMON's grow time. GDD: overnight scale, "an evening plant opens
 *  by next morning". Set to 2 minutes for the greybox playtest so the whole loop fits one
 *  session; production wants roughly 4 h here, which puts the top of the ladder at 24 h. */
export const BOX_GROW_MS = 2 * 60_000

/** Rarity time ladder (KJ 2026-09-21) — rarer seeds take longer to open, so the WAIT is
 *  part of what a rare is. Multipliers on BOX_GROW_MS rather than absolute times: the
 *  2-minute playtest base and a 4-hour production base then keep the same SHAPE, and
 *  there is still one knob to turn. Index = rarity tier (Common .. Unique). */
export const BOX_GROW_TIER_MULT: ReadonlyArray<number> = [1, 1.5, 2, 2.5, 3, 4, 5, 6]   // TUNING
/** Mythic and Unique are ABSOLUTE waits, not multiples of the base (KJ 2026-09-29): a day for a Mythic, three and a
 *  half days for a Unique — the wait is part of what they are, and it stays put when BOX_GROW_MS is tuned. */
export const LEGEND_GROW_MS: ReadonlyArray<number> = [24 * 3_600_000, 84 * 3_600_000]   // TUNING — tiers 6, 7
export function growMsForTier(tier: number): number {
  const t = Math.max(0, Math.min(BOX_GROW_TIER_MULT.length - 1, Math.round(tier) || 0))
  if (t >= 6) return LEGEND_GROW_MS[t - 6]
  return Math.round(BOX_GROW_MS * BOX_GROW_TIER_MULT[t])
}
/** A visitor's watering shaves a FRACTION of that seed's own timer, not a flat amount:
 *  10% of a Common was the whole point of the gesture, and the same milliseconds off a
 *  Unique would be a rounding error. Still capped by BOX_WATER_MAX per box. */
export const BOX_WATER_SHAVE_FRACTION = 0.10   // TUNING

/** Growth stages (a seedling steps up at these fractions of ITS OWN timer) and TENDING: the
 *  owner may water their own seedling once per stage reached, each worth TEND_SHAVE_FRACTION
 *  of the whole timer (KJ 2026-09-25: "what can I do instead of waiting?"). 4 stages x 5% =
 *  at most 20% off — a nudge, never a skip, so the come-back-later hook survives. Shared so
 *  the server's rule and the client's water drop can never disagree about the stage. */
export const GROW_STAGE_AT: ReadonlyArray<number> = [0, 0.25, 0.55, 0.8]   // TUNING
export const TEND_SHAVE_FRACTION = 0.05   // TUNING
export function growStageOf(opensAt: number, now: number, tier: number): number {
  const total = growMsForTier(tier)
  const progress = Math.max(0, Math.min(1, 1 - Math.max(0, opensAt - now) / total))
  let stage = 0
  for (let i = 0; i < GROW_STAGE_AT.length; i++) if (progress >= GROW_STAGE_AT[i]) stage = i
  return stage
}
/** Tends the owner can make right now: one per stage reached, minus those already used. */
export function tendsAvailable(opensAt: number, now: number, tier: number, used: number): number {
  return growStageOf(opensAt, now, tier) + 1 - used
}
export function growShaveMsForTier(tier: number): number {
  return Math.round(growMsForTier(tier) * BOX_WATER_SHAVE_FRACTION)
}
/** "2 minutes" / "90 minutes" / "6 hours" — shared so the info panel, the seed menu and
 *  any log all say a duration the same way. */
export function formatGrowTime(ms: number): string {
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`
  const hrs = Math.round(mins / 60)
  if (hrs >= 48) { const d = Math.floor(hrs / 24), h = hrs % 24; return h === 0 ? `${d} days` : `${d} days ${h} hours` }
  return `${hrs} hour${hrs === 1 ? '' : 's'}`
}
/** Compact form for a tile: "2m" / "90m" / "6h". */
export function shortGrowTime(ms: number): string {
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.round(mins / 60)
  if (hrs >= 48) { const d = Math.floor(hrs / 24), h = hrs % 24; return h === 0 ? `${d}d` : `${d}d ${h}h` }
  return `${hrs}h`
}

// ── Rarity + plant species catalog (2026-09-18) ──────────────────────────────
// KJ's expansion plan: 78 base models (77 from the original inventory + Void Tulip, a
// bonus find kept 2026-09-18) from Foundation's public asset-packs (Pirates,
// Genesis City, Fantasy, Halloween, Voxels, Western) x 6 procedural rarity tiers
// (Common..Exotic) = 468 look combinations via color/VFX layering, no new art per
// combination. Mythic and Unique are reserved for bespoke custom models (TBD),
// outside this generic tier system. Foundation asset-packs GLBs carry no explicit
// license — treat as CC BY-NC (non-commercial) pending KJ's conversation with
// Foundation (in progress 2026-09-18).
//
// WIRED UP 2026-09-18 (Phase 2): messages.ts, server.ts, boxSystem.ts, seedSystem.ts,
// playerInventory.ts, seedMenu.tsx, giftSystem.ts, ui.tsx, testPanel.tsx all roll and
// carry rarityTier/species now — the old rare:boolean is gone. Not yet done: real
// per-species flower/seedling models (still greybox spheres + a 2-color seedling GLB
// tinted by tier bucket, not per-species) and the actual pulse/particle VFX layer
// KJ's tier table calls for (only the seed/flower base COLOR is wired so far).

export interface PlantSpecies {
  id:          string   // stable id — also the asset folder name (disambiguated where
                         // two packs happened to reuse the same one, e.g. 'cactus')
  name:        string   // display name
  pack:        string   // source Foundation asset pack, kept for licensing/attribution tracking
  modelSrc:    string   // GLB path
  // Every model was authored at its own scale/origin/up-axis. These are computed from
  // each GLB's world-space bounds (accessor bounds pushed through the node hierarchy's
  // rotation/scale/translation — raw accessor bounds alone mis-sized 29 of 78, e.g.
  // Z-up voxel models and cm-authored meshes) so the largest dimension is ~0.55 m, the
  // lowest point sits at y=0 and the footprint is centred on the box.
  scale:       number
  baseYOffset: number
  offsetX:     number   // DCL metres; assumes explorers mirror glTF X (glTF +X = DCL -X)
  offsetZ:     number
}
/** The 78 committed base models. */
export const PLANT_SPECIES: ReadonlyArray<PlantSpecies> = [
  { id: 'curly_magic_bean_sprout', name: 'Curled Beanstalk', pack: 'fantasy', modelSrc: 'assets/scene/Models/plants/fantasy/curly_magic_bean_sprout/curly_magic_bean_sprout.glb', scale: 0.4318, baseYOffset: 0.0057, offsetX: -0.0123, offsetZ: 0.0605 },
  { id: 'dracaena', name: 'Teal Dracaena', pack: 'fantasy', modelSrc: 'assets/scene/Models/plants/fantasy/dracaena/dracaena.glb', scale: 0.4089, baseYOffset: 0.0031, offsetX: -0.0081, offsetZ: 0.0017 },
  { id: 'large_light_green_grass_mound', name: 'Meadow Cushion', pack: 'fantasy', modelSrc: 'assets/scene/Models/plants/fantasy/large_light_green_grass_mound/large_light_green_grass_mound.glb', scale: 0.0847, baseYOffset: 0.0188, offsetX: -0.0104, offsetZ: -0.0209 },
  { id: 'large_yellow-green_grass_mound', name: 'Sunlit Cushion', pack: 'fantasy', modelSrc: 'assets/scene/Models/plants/fantasy/large_yellow-green_grass_mound/large_yellow-green_grass_mound.glb', scale: 0.0845, baseYOffset: 0.0015, offsetX: -0.0001, offsetZ: -0.0111 },
  { id: 'magic_bean_sprout', name: 'Magic Beanstalk', pack: 'fantasy', modelSrc: 'assets/scene/Models/plants/fantasy/magic_bean_sprout/magic_bean_sprout.glb', scale: 0.4877, baseYOffset: 0.0013, offsetX: -0.0461, offsetZ: 0.0504 },
  { id: 'mountain_ragweed', name: 'Goldberry Sprig', pack: 'fantasy', modelSrc: 'assets/scene/Models/plants/fantasy/mountain_ragweed/mountain_ragweed.glb', scale: 0.4273, baseYOffset: 0.0125, offsetX: 0.1083, offsetZ: 0.0064 },
  { id: 'nutsedge', name: 'Teal Sedge', pack: 'fantasy', modelSrc: 'assets/scene/Models/plants/fantasy/nutsedge/nutsedge.glb', scale: 0.6076, baseYOffset: 0.0037, offsetX: 0.009, offsetZ: 0.002 },
  { id: 'purple_heart_plant', name: 'Blue Heart Lily', pack: 'fantasy', modelSrc: 'assets/scene/Models/plants/fantasy/purple_heart_plant/purple_heart_plant.glb', scale: 0.4619, baseYOffset: -0.0, offsetX: 0.0052, offsetZ: 0.0775 },
  { id: 'purple_oyster_plant', name: 'Magenta Oyster', pack: 'fantasy', modelSrc: 'assets/scene/Models/plants/fantasy/purple_oyster_plant/purple_oyster_plant.glb', scale: 0.497, baseYOffset: -0.0005, offsetX: 0.0102, offsetZ: 0.0371 },
  { id: 'shreed_plant', name: 'Pale Frond', pack: 'fantasy', modelSrc: 'assets/scene/Models/plants/fantasy/shreed_plant/shreed_plant.glb', scale: 0.3774, baseYOffset: 0.006, offsetX: -0.0243, offsetZ: 0.0951 },
  { id: 'single_magic_bean_sprout', name: 'Bean Shoot', pack: 'fantasy', modelSrc: 'assets/scene/Models/plants/fantasy/single_magic_bean_sprout/single_magic_bean_sprout.glb', scale: 0.6086, baseYOffset: 0.0014, offsetX: 0.0188, offsetZ: -0.0 },
  { id: 'small_green_grass_mound', name: 'Moss Cushion', pack: 'fantasy', modelSrc: 'assets/scene/Models/plants/fantasy/small_green_grass_mound/small_green_grass_mound.glb', scale: 0.168, baseYOffset: 0.0038, offsetX: 0.0137, offsetZ: -0.0067 },
  { id: 'small_lighter_green_grass_mound', name: 'Pale Cushion', pack: 'fantasy', modelSrc: 'assets/scene/Models/plants/fantasy/small_lighter_green_grass_mound/small_lighter_green_grass_mound.glb', scale: 0.1771, baseYOffset: 0.0041, offsetX: 0.0092, offsetZ: -0.0133 },
  { id: 'swamp_lily_pad', name: 'Swamp Lily Pad', pack: 'fantasy', modelSrc: 'assets/scene/Models/plants/fantasy/swamp_lily_pad/swamp_lily_pad.glb', scale: 1.1633, baseYOffset: -0.019, offsetX: -0.0, offsetZ: 0.0035 },
  { id: 'swamp_red_cactus', name: 'Crimson Spire', pack: 'fantasy', modelSrc: 'assets/scene/Models/plants/fantasy/swamp_red_cactus/swamp_red_cactus.glb', scale: 0.2731, baseYOffset: 0.0, offsetX: 0.0003, offsetZ: 0.0085 },
  { id: 'sweet_geranium', name: 'Bluebell Geranium', pack: 'fantasy', modelSrc: 'assets/scene/Models/plants/fantasy/sweet_geranium/sweet_geranium.glb', scale: 0.3617, baseYOffset: 0.0082, offsetX: 0.0043, offsetZ: -0.0124 },
  { id: 'three-spiked_grass', name: 'Three-Spike Grass', pack: 'fantasy', modelSrc: 'assets/scene/Models/plants/fantasy/three-spiked_grass/three-spiked_grass.glb', scale: 1.1145, baseYOffset: 0.0188, offsetX: 0.0047, offsetZ: 0.0876 },
  { id: 'wild_chives', name: 'Wild Chives', pack: 'fantasy', modelSrc: 'assets/scene/Models/plants/fantasy/wild_chives/wild_chives.glb', scale: 0.2772, baseYOffset: 0.0058, offsetX: 0.0036, offsetZ: 0.0558 },
  { id: 'wild_long_mushrooms', name: 'Glowcap Mushroom', pack: 'fantasy', modelSrc: 'assets/scene/Models/plants/fantasy/wild_long_mushrooms/wild_long_mushrooms.glb', scale: 0.7344, baseYOffset: 0.006, offsetX: 0.0036, offsetZ: 0.0325 },
  { id: 'yellow_croton_plant', name: 'Yellow Croton', pack: 'fantasy', modelSrc: 'assets/scene/Models/plants/fantasy/yellow_croton_plant/yellow_croton_plant.glb', scale: 0.3957, baseYOffset: -0.0072, offsetX: -0.0049, offsetZ: 0.0316 },
  { id: 'balsam_flower', name: 'Balsam Flower', pack: 'genesis_city', modelSrc: 'assets/scene/Models/plants/genesis_city/balsam_flower/balsam_flower.glb', scale: 0.4457, baseYOffset: 0.0006, offsetX: -0.0048, offsetZ: -0.0058 },
  { id: 'birds_nest_fern', name: 'Bird\'s Nest Fern', pack: 'genesis_city', modelSrc: 'assets/scene/Models/plants/genesis_city/birds_nest_fern/birds_nest_fern.glb', scale: 0.5157, baseYOffset: -0.0124, offsetX: 0.0005, offsetZ: 0.0045 },
  { id: 'genesis_cactus', name: 'Saguaro Cactus', pack: 'genesis_city', modelSrc: 'assets/scene/Models/plants/genesis_city/cactus/cactus.glb', scale: 0.3071, baseYOffset: 0.0122, offsetX: 0.0, offsetZ: 0.0178 },
  { id: 'dandelion', name: 'Dandelion Clock', pack: 'genesis_city', modelSrc: 'assets/scene/Models/plants/genesis_city/dandelion/dandelion.glb', scale: 0.7793, baseYOffset: 0.0003, offsetX: 0.0093, offsetZ: 0.0684 },
  { id: 'flower_sprouts', name: 'Pink Bud Sprout', pack: 'genesis_city', modelSrc: 'assets/scene/Models/plants/genesis_city/flower_sprouts/flower_sprouts.glb', scale: 0.7001, baseYOffset: 0.0104, offsetX: 0.0528, offsetZ: 0.0429 },
  { id: 'grass_sprout', name: 'Grass Tuft', pack: 'genesis_city', modelSrc: 'assets/scene/Models/plants/genesis_city/grass_sprout/grass_sprout.glb', scale: 0.7863, baseYOffset: 0.0298, offsetX: -0.0244, offsetZ: 0.0011 },
  { id: 'gypsy_mushroom', name: 'Gypsy Mushroom', pack: 'genesis_city', modelSrc: 'assets/scene/Models/plants/genesis_city/gypsy_mushroom/gypsy_mushroom.glb', scale: 1.6652, baseYOffset: -0.0, offsetX: 0.0002, offsetZ: 0.0 },
  { id: 'java_fern', name: 'Java Fern', pack: 'genesis_city', modelSrc: 'assets/scene/Models/plants/genesis_city/java_fern/java_fern.glb', scale: 1.0099, baseYOffset: 0.0035, offsetX: 0.0208, offsetZ: -0.0132 },
  { id: 'kangaroo_paws', name: 'Kangaroo Paws', pack: 'genesis_city', modelSrc: 'assets/scene/Models/plants/genesis_city/kangaroo_paws/kangaroo_paws.glb', scale: 0.3869, baseYOffset: 0.0063, offsetX: 0.0188, offsetZ: -0.0399 },
  { id: 'magenta_mushroom', name: 'Magenta Mushroom', pack: 'genesis_city', modelSrc: 'assets/scene/Models/plants/genesis_city/magenta_mushroom/magenta_mushroom.glb', scale: 2.5405, baseYOffset: 0.0636, offsetX: -0.0893, offsetZ: 0.054 },
  { id: 'maidenhair_fern', name: 'Maidenhair Fern', pack: 'genesis_city', modelSrc: 'assets/scene/Models/plants/genesis_city/maidenhair_fern/maidenhair_fern.glb', scale: 0.63, baseYOffset: 0.0069, offsetX: -0.0293, offsetZ: -0.0516 },
  { id: 'moss_rose', name: 'Moss Rose', pack: 'genesis_city', modelSrc: 'assets/scene/Models/plants/genesis_city/moss_rose/moss_rose.glb', scale: 0.8545, baseYOffset: -0.0099, offsetX: 0.0096, offsetZ: -0.0164 },
  { id: 'ostrich_ferns', name: 'Ostrich Fern', pack: 'genesis_city', modelSrc: 'assets/scene/Models/plants/genesis_city/ostrich_ferns/ostrich_ferns.glb', scale: 0.9194, baseYOffset: 0.0061, offsetX: 0.0101, offsetZ: -0.0243 },
  { id: 'rose', name: 'Rose', pack: 'genesis_city', modelSrc: 'assets/scene/Models/plants/genesis_city/rose/rose.glb', scale: 0.5522, baseYOffset: 0.0136, offsetX: 0.0124, offsetZ: -0.0188 },
  { id: 'rose_head', name: 'Rose Bloom', pack: 'genesis_city', modelSrc: 'assets/scene/Models/plants/genesis_city/rose_head/rose_head.glb', scale: 0.8369, baseYOffset: 0.0193, offsetX: 0.0476, offsetZ: -0.0017 },
  { id: 'sunflower', name: 'Sunflower', pack: 'genesis_city', modelSrc: 'assets/scene/Models/plants/genesis_city/sunflower/sunflower.glb', scale: 1.1275, baseYOffset: 0.0236, offsetX: -0.0568, offsetZ: -0.0829 },
  { id: 'sunflower_head', name: 'Sunflower Head', pack: 'genesis_city', modelSrc: 'assets/scene/Models/plants/genesis_city/sunflower_head/sunflower_head.glb', scale: 0.815, baseYOffset: 0.0018, offsetX: -0.0, offsetZ: -0.005 },
  { id: 'sweet_pea', name: 'Sweet Pea', pack: 'genesis_city', modelSrc: 'assets/scene/Models/plants/genesis_city/sweet_pea/sweet_pea.glb', scale: 0.3951, baseYOffset: 0.0075, offsetX: 0.0437, offsetZ: -0.0355 },
  { id: 'flower_01', name: 'Ghost Lily', pack: 'halloween', modelSrc: 'assets/scene/Models/plants/halloween/flower_01/flower_01.glb', scale: 2.0068, baseYOffset: 0.0041, offsetX: -0.0039, offsetZ: -0.0338 },
  { id: 'flower_02', name: 'Autumn Poppy', pack: 'halloween', modelSrc: 'assets/scene/Models/plants/halloween/flower_02/flower_02.glb', scale: 1.8143, baseYOffset: 0.0025, offsetX: -0.0053, offsetZ: -0.006 },
  { id: 'pumpkin_leaf', name: 'Pumpkin Vine', pack: 'halloween', modelSrc: 'assets/scene/Models/plants/halloween/pumpkin_leaf/pumpkin_leaf.glb', scale: 1.1499, baseYOffset: 0.0122, offsetX: -0.1067, offsetZ: -0.037 },
  { id: 'pumpkin_leaf__2', name: 'Pumpkin Leaf', pack: 'halloween', modelSrc: 'assets/scene/Models/plants/halloween/pumpkin_leaf__2/pumpkin_leaf__2.glb', scale: 1.5643, baseYOffset: 0.0182, offsetX: -0.2681, offsetZ: 0.0482 },
  { id: 'areca_palm', name: 'Areca Palm', pack: 'pirates', modelSrc: 'assets/scene/Models/plants/pirates/areca_palm/areca_palm.glb', scale: 0.2141, baseYOffset: 0.0, offsetX: -0.0175, offsetZ: -0.0032 },
  { id: 'bamboo', name: 'Bamboo', pack: 'pirates', modelSrc: 'assets/scene/Models/plants/pirates/bamboo/bamboo.glb', scale: 0.1581, baseYOffset: 0.0002, offsetX: -0.0039, offsetZ: -0.0265 },
  { id: 'bamboo_culms', name: 'Bamboo Culm', pack: 'pirates', modelSrc: 'assets/scene/Models/plants/pirates/bamboo_culms/bamboo_culms.glb', scale: 0.1483, baseYOffset: -0.0009, offsetX: 0.0, offsetZ: -0.0039 },
  { id: 'beach_fern', name: 'Beach Fern', pack: 'pirates', modelSrc: 'assets/scene/Models/plants/pirates/beach_fern/beach_fern.glb', scale: 1.9661, baseYOffset: 0.0071, offsetX: 0.0341, offsetZ: 0.0015 },
  { id: 'beachgrass', name: 'Beach Grass', pack: 'pirates', modelSrc: 'assets/scene/Models/plants/pirates/beachgrass/beachgrass.glb', scale: 0.4657, baseYOffset: 0.012, offsetX: 0.0186, offsetZ: -0.0222 },
  { id: 'beachgrass_fern', name: 'Dune Grass', pack: 'pirates', modelSrc: 'assets/scene/Models/plants/pirates/beachgrass_fern/beachgrass_fern.glb', scale: 0.4151, baseYOffset: -0.0023, offsetX: 0.0005, offsetZ: -0.0001 },
  { id: 'bird_of_paradise', name: 'Bird of Paradise', pack: 'pirates', modelSrc: 'assets/scene/Models/plants/pirates/bird_of_paradise/bird_of_paradise.glb', scale: 1.4774, baseYOffset: -0.0187, offsetX: -0.0445, offsetZ: 0.1149 },
  { id: 'blue_star_fern', name: 'Blue Star Fern', pack: 'pirates', modelSrc: 'assets/scene/Models/plants/pirates/blue_star_fern/blue_star_fern.glb', scale: 1.0695, baseYOffset: 0.0092, offsetX: 0.0464, offsetZ: -0.0619 },
  { id: 'cretan_brake_fern', name: 'Brake Fern', pack: 'pirates', modelSrc: 'assets/scene/Models/plants/pirates/cretan_brake_fern/cretan_brake_fern.glb', scale: 1.0517, baseYOffset: -0.0005, offsetX: 0.047, offsetZ: -0.0248 },
  { id: 'jungle_fern', name: 'Jungle Fern', pack: 'pirates', modelSrc: 'assets/scene/Models/plants/pirates/jungle_fern/jungle_fern.glb', scale: 0.3237, baseYOffset: 0.001, offsetX: -0.0214, offsetZ: 0.0102 },
  { id: 'lilypad', name: 'Lily Pad', pack: 'pirates', modelSrc: 'assets/scene/Models/plants/pirates/lilypad/lilypad.glb', scale: 0.6986, baseYOffset: 0.0005, offsetX: 0.0, offsetZ: -0.0294 },
  { id: 'monstera_deliciosa', name: 'Monstera', pack: 'pirates', modelSrc: 'assets/scene/Models/plants/pirates/monstera_deliciosa/monstera_deliciosa.glb', scale: 0.3209, baseYOffset: -0.0026, offsetX: 0.0288, offsetZ: 0.058 },
  { id: 'musa_acuminata', name: 'Banana Palm', pack: 'pirates', modelSrc: 'assets/scene/Models/plants/pirates/musa_acuminata/musa_acuminata.glb', scale: 0.2669, baseYOffset: -0.0028, offsetX: 0.038, offsetZ: 0.07 },
  { id: 'plumeria', name: 'Plumeria', pack: 'pirates', modelSrc: 'assets/scene/Models/plants/pirates/plumeria/plumeria.glb', scale: 0.5215, baseYOffset: -0.0068, offsetX: -0.0401, offsetZ: -0.003 },
  { id: 'sand_reed', name: 'Sand Reed', pack: 'pirates', modelSrc: 'assets/scene/Models/plants/pirates/sand_reed/sand_reed.glb', scale: 0.3378, baseYOffset: 0.0045, offsetX: -0.0167, offsetZ: -0.0143 },
  { id: 'sand_weeds', name: 'Dune Reed', pack: 'pirates', modelSrc: 'assets/scene/Models/plants/pirates/sand_weeds/sand_weeds.glb', scale: 0.4861, baseYOffset: 0.0127, offsetX: 0.0055, offsetZ: 0.0088 },
  { id: 'voxels_cactus', name: 'Cactus Block', pack: 'voxels_pack', modelSrc: 'assets/scene/Models/plants/voxels_pack/cactus/cactus.glb', scale: 0.55, baseYOffset: 0.0, offsetX: 0.0, offsetZ: 0.0 },
  { id: 'flower_red', name: 'Pixel Poppy', pack: 'voxels_pack', modelSrc: 'assets/scene/Models/plants/voxels_pack/flower_red/flower_red.glb', scale: 0.55, baseYOffset: 0.0, offsetX: 0.0, offsetZ: -0.0 },
  { id: 'flower_yellow', name: 'Pixel Buttercup', pack: 'voxels_pack', modelSrc: 'assets/scene/Models/plants/voxels_pack/flower_yellow/flower_yellow.glb', scale: 0.55, baseYOffset: 0.0, offsetX: 0.0, offsetZ: -0.0 },
  { id: 'grass_long', name: 'Pixel Tallgrass', pack: 'voxels_pack', modelSrc: 'assets/scene/Models/plants/voxels_pack/grass_long/grass_long.glb', scale: 0.55, baseYOffset: 0.0, offsetX: 0.0, offsetZ: -0.0 },
  { id: 'mushroom_brown', name: 'Pixel Toadstool', pack: 'voxels_pack', modelSrc: 'assets/scene/Models/plants/voxels_pack/mushroom_brown/mushroom_brown.glb', scale: 0.55, baseYOffset: 0.0, offsetX: 0.0, offsetZ: -0.0 },
  { id: 'vegetation_flowers', name: 'Flowering Block', pack: 'voxels_pack', modelSrc: 'assets/scene/Models/plants/voxels_pack/vegetation_flowers/vegetation_flowers.glb', scale: 0.55, baseYOffset: 0.0, offsetX: 0.0, offsetZ: 0.0 },
  { id: 'cactus_1', name: 'Sentinel Cactus', pack: 'western', modelSrc: 'assets/scene/Models/plants/western/cactus_1/cactus_1.glb', scale: 0.1296, baseYOffset: 0.0077, offsetX: -0.0201, offsetZ: -0.0142 },
  { id: 'cactus_2', name: 'Goldspine Cactus', pack: 'western', modelSrc: 'assets/scene/Models/plants/western/cactus_2/cactus_2.glb', scale: 0.1566, baseYOffset: 0.0111, offsetX: 0.0058, offsetZ: -0.0061 },
  { id: 'cactus_3', name: 'Leaning Cactus', pack: 'western', modelSrc: 'assets/scene/Models/plants/western/cactus_3/cactus_3.glb', scale: 0.1234, baseYOffset: 0.0046, offsetX: 0.009, offsetZ: -0.0022 },
  { id: 'cactus_4', name: 'Stoneside Cactus', pack: 'western', modelSrc: 'assets/scene/Models/plants/western/cactus_4/cactus_4.glb', scale: 0.2242, baseYOffset: 0.0115, offsetX: 0.0351, offsetZ: -0.0407 },
  { id: 'cactus_5', name: 'Twin Column Cactus', pack: 'western', modelSrc: 'assets/scene/Models/plants/western/cactus_5/cactus_5.glb', scale: 0.1271, baseYOffset: 0.0057, offsetX: -0.0444, offsetZ: -0.0112 },
  { id: 'cactus_6', name: 'Woolly Cactus', pack: 'western', modelSrc: 'assets/scene/Models/plants/western/cactus_6/cactus_6.glb', scale: 0.2062, baseYOffset: 0.0202, offsetX: 0.0158, offsetZ: -0.0173 },
  { id: 'cactus_7', name: 'Goldcrown Cactus', pack: 'western', modelSrc: 'assets/scene/Models/plants/western/cactus_7/cactus_7.glb', scale: 0.1734, baseYOffset: 0.0058, offsetX: 0.0215, offsetZ: -0.0214 },
  { id: 'cactus_8', name: 'Pink Crown Cactus', pack: 'western', modelSrc: 'assets/scene/Models/plants/western/cactus_8/cactus_8.glb', scale: 0.1699, baseYOffset: 0.0082, offsetX: -0.0016, offsetZ: 0.0078 },
  { id: 'cactus_9', name: 'Bluebloom Cactus', pack: 'western', modelSrc: 'assets/scene/Models/plants/western/cactus_9/cactus_9.glb', scale: 0.2829, baseYOffset: 0.0181, offsetX: 0.028, offsetZ: -0.0049 },
  { id: 'plant_1', name: 'Desert Star', pack: 'western', modelSrc: 'assets/scene/Models/plants/western/plant_1/plant_1.glb', scale: 0.2579, baseYOffset: 0.0467, offsetX: 0.0087, offsetZ: -0.0074 },
  { id: 'plant_2', name: 'Rock Agave', pack: 'western', modelSrc: 'assets/scene/Models/plants/western/plant_2/plant_2.glb', scale: 0.1765, baseYOffset: 0.009, offsetX: 0.0166, offsetZ: -0.0153 },
  // Bonus find, kept by KJ 2026-09-18 — not in the original 77-item list, but a real,
  // on-theme flower.
  { id: 'void_tulip', name: 'Void Tulip', pack: 'fantasy', modelSrc: 'assets/scene/Models/plants/fantasy/void_tulip/void_tulip.glb', scale: 0.3216, baseYOffset: 0.0046, offsetX: 0.0095, offsetZ: 0.0217 },
]

export interface RarityTierDef {
  id:        number   // 0 = Common .. 7 = Unique
  name:      string
  seedColor: { r: number; g: number; b: number }
  seedVfx:   string    // KJ's spec, in prose — translated into engine params when the VFX system is built
  plantVfx:  string
  custom:    boolean   // true for Mythic/Unique — bespoke, outside the generic tier engine
}
/** KJ's rarity spec (2026-09-18), following DCL wearable rarity conventions. */
export const RARITY_TIERS: ReadonlyArray<RarityTierDef> = [
  { id: 0, name: 'Common',    seedColor: { r: 0.451, g: 0.827, b: 0.827 }, seedVfx: 'None',  plantVfx: 'None', custom: false },
  { id: 1, name: 'Uncommon',  seedColor: { r: 1.000, g: 0.514, b: 0.384 }, seedVfx: 'None',  plantVfx: 'None', custom: false },
  { id: 2, name: 'Rare',      seedColor: { r: 0.204, g: 0.808, b: 0.463 }, seedVfx: 'Green pulse',  plantVfx: 'Green pulse', custom: false },
  { id: 3, name: 'Epic',      seedColor: { r: 0.263, g: 0.561, b: 1.000 }, seedVfx: 'Blue pulse',   plantVfx: 'Blue particles', custom: false },
  { id: 4, name: 'Legendary', seedColor: { r: 0.631, g: 0.294, b: 0.953 }, seedVfx: 'Purple pulse', plantVfx: 'Tonal purple pulse and particles', custom: false },
  { id: 5, name: 'Exotic',    seedColor: { r: 0.608, g: 0.820, b: 0.255 }, seedVfx: 'Red pulse',    plantVfx: 'Alternating colour pulse, particles, slow scale/rotation tween', custom: false },
  { id: 6, name: 'Mythic',    seedColor: { r: 1.000, g: 0.294, b: 0.929 }, seedVfx: 'Pink pulse',   plantVfx: 'Custom', custom: true },
  { id: 7, name: 'Unique',    seedColor: { r: 0.996, g: 0.635, b: 0.090 }, seedVfx: 'Gold pulse',   plantVfx: 'Custom', custom: true },
]
/** "a Rare" / "an Uncommon" (capital: "An Uncommon") for generated messages. Goes by sound:
 *  "Unique" and "Uni…"/"Use…"/"Eu…"/"One…" words take "a". */
export function withArticle(word: string, capital = false): string {
  const vowelSound = /^[aeiou]/i.test(word) && !/^(uni|use|usu|eu|one)/i.test(word)
  const art = vowelSound ? 'an' : 'a'
  return `${capital ? art[0].toUpperCase() + art.slice(1) : art} ${word}`
}

/** Rarity stamps: one per species per rarity tier (KJ 2026-09-25 — the long tail of the collection). */
export function stampTotal(): number {
  // Tiers 0..5 pair every regular species; Mythic and Unique pair only their own bespoke plants
  // (until a pool has plants, that tier still uses the regular catalogue).
  const regular = PLANT_SPECIES.length * (RARITY_TIERS.length - 2)
  return regular + (MYTHIC_PLANTS.length || PLANT_SPECIES.length) + (UNIQUE_PLANTS.length || PLANT_SPECIES.length)
}

export function rarityTierById(id: number): RarityTierDef {
  return RARITY_TIERS[id] ?? RARITY_TIERS[0]
}

/** Relative odds among Uncommon..Unique (tiers 1-7) once a seed rolls "above Common" —
 *  see seedRareChance. Mythic/Unique joined the roll 2026-09-19 (KJ) now that their seed
 *  models exist: per seed ≈ Mythic 1 in 2,500 solo → 1 in 840 at 6+ gardeners, Unique
 *  1 in 10,000 → 1 in 3,350. The rainbow seed (rollRainbowTier) is the realistic route. */
// Mythic and Unique are meant to be HARD (KJ 2026-09-25). Weights were [.., 0.4, 0.1]; now 0.15 and 0.03,
// i.e. a share of about 0.15% and 0.03% of the above-Common seeds (was 0.4% / 0.1%). See design/rarity-notes.md.
const TIER_ROLL_WEIGHTS: ReadonlyArray<number> = [55, 30, 10, 4, 1, 0.15, 0.03]   // TUNING — tier 1..7

/** Rolls a rarity tier for a newly-spawned seed: seedRareChance(...) decides whether
 *  it beats Common at all, then this weights which of Uncommon..Exotic it lands on. */
export function rollSeedTier(contributors: number, rareSeedMult = 1): number {
  if (Math.random() >= seedRareChance(contributors, rareSeedMult)) return 0   // Common
  return rollTierAtLeast(1)
}

/** A tier ≥ `minTier` (1..7) by TIER_ROLL_WEIGHTS — the guaranteed Rare+ seed uses 2. */
/** The guaranteed Rare+ seed (4+ gardeners) may roll up to this tier and no higher. KJ 2026-09-25:
 *  Mythic and Unique must be HARD. Uncapped, that one guaranteed roll made them ~9x easier in a
 *  populated Bloom than solo (a Mythic about 1 Bloom in 190 instead of 1 in 510). Now Mythic and
 *  Unique only come from the ordinary roll. */
export const GUARANTEED_MAX_TIER = 5   // Exotic

export function rollTierAtLeast(minTier: number, maxTier = TIER_ROLL_WEIGHTS.length): number {
  const from    = Math.max(1, Math.min(TIER_ROLL_WEIGHTS.length, minTier))
  const to      = Math.max(from, Math.min(TIER_ROLL_WEIGHTS.length, maxTier))
  const weights = TIER_ROLL_WEIGHTS.slice(from - 1, to)
  let r = Math.random() * weights.reduce((a, b) => a + b, 0)
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i]
    if (r <= 0) return from + i
  }
  return from
}

/** Rolls a species for a revealed plant — uniform across the committed catalog for now
 *  (all 78 equally likely); rarity tier is a fully separate axis, rolled independently
 *  at the seed stage via rollSeedTier. */
export function rollPlantSpecies(tier = 0): string {
  const pool = bespokePool(tier)
  const list = pool.length > 0 ? pool : PLANT_SPECIES
  return list[Math.floor(Math.random() * list.length)].id
}

/** BESPOKE plants (KJ 2026-09-25): a Mythic or Unique seed opens into one of these hand-made plants, not a
 *  regular species with a tint. While a pool is EMPTY that tier falls back to the regular catalogue, so the game
 *  keeps working until the art lands. To add one: append an entry here (id, name, modelSrc, scale/offsets as for
 *  PLANT_SPECIES) and drop `assets/images/plantThumbs/<id>.png`. See design/bespoke-plants.md. Plan: 12 Mythic, 6 Unique. */
export const MYTHIC_PLANTS: ReadonlyArray<PlantSpecies> = [
  { id: 'stout_paradise_anemone', name: 'Stout Paradise Anemone', pack: 'mythic', modelSrc: 'assets/scene/Models/plants/mythic/stout_paradise_anemone/stout_paradise_anemone.glb', scale: 0.4228, baseYOffset: 0.001, offsetX: 0.0, offsetZ: -0.0002 },
  { id: 'all_seeing_berry', name: 'All-Seeing Berry', pack: 'mythic', modelSrc: 'assets/scene/Models/plants/mythic/all_seeing_berry/all_seeing_berry.glb', scale: 0.373, baseYOffset: 0.021, offsetX: -0.0264, offsetZ: 0.0404 },
  { id: 'pumpkin_sprite', name: 'Pumpkin Sprite', pack: 'mythic', modelSrc: 'assets/scene/Models/plants/mythic/pumpkin_sprite/pumpkin_sprite.glb', scale: 0.6943, baseYOffset: -0.0029, offsetX: -0.013, offsetZ: -0.0004 },
  { id: 'anemone_lantern', name: 'Anemone Lantern', pack: 'mythic', modelSrc: 'assets/scene/Models/plants/mythic/anemone_lantern/anemone_lantern.glb', scale: 0.4293, baseYOffset: -0.0051, offsetX: -0.0002, offsetZ: -0.0017 },
  { id: 'shy_curlberry', name: 'Shy Curlberry', pack: 'mythic', modelSrc: 'assets/scene/Models/plants/mythic/shy_curlberry/shy_curlberry.glb', scale: 0.359, baseYOffset: 0.0152, offsetX: 0.0, offsetZ: 0.0 },
  { id: 'violet_alien_anemone', name: 'Violet Alien Anemone', pack: 'mythic', modelSrc: 'assets/scene/Models/plants/mythic/violet_alien_anemone/violet_alien_anemone.glb', scale: 0.443, baseYOffset: -0.0039, offsetX: -0.0057, offsetZ: 0.0446 },
  { id: 'sunlit_coral', name: 'Sunlit Coral', pack: 'mythic', modelSrc: 'assets/scene/Models/plants/mythic/sunlit_coral/sunlit_coral.glb', scale: 0.3671, baseYOffset: 0.0055, offsetX: -0.0265, offsetZ: 0.0191 },
  { id: 'teal_trumpet', name: 'Teal Trumpet', pack: 'mythic', modelSrc: 'assets/scene/Models/plants/mythic/teal_trumpet/teal_trumpet.glb', scale: 0.3624, baseYOffset: 0.0196, offsetX: 0.0191, offsetZ: 0.0037 },
  { id: 'squishy_succulent', name: 'Squishy Succulent', pack: 'mythic', modelSrc: 'assets/scene/Models/plants/mythic/squishy_succulent/squishy_succulent.glb', scale: 0.3412, baseYOffset: -0.0025, offsetX: 0.0254, offsetZ: 0.0258 },
  { id: 'nobbly_puff_plant', name: 'Nobbly Puff Plant', pack: 'mythic', modelSrc: 'assets/scene/Models/plants/mythic/nobbly_puff_plant/nobbly_puff_plant.glb', scale: 0.3438, baseYOffset: -0.0012, offsetX: 0.0363, offsetZ: -0.0077 },
  { id: 'spiral_bloom', name: 'Spiral Bloom', pack: 'mythic', modelSrc: 'assets/scene/Models/plants/mythic/spiral_bloom/spiral_bloom.glb', scale: 0.2442, baseYOffset: -0.003, offsetX: -0.007, offsetZ: -0.0346 },
  { id: 'judgement_berry', name: 'Judgement Berry', pack: 'mythic', modelSrc: 'assets/scene/Models/plants/mythic/judgement_berry/judgement_berry.glb', scale: 0.376, baseYOffset: 0.002, offsetX: 0.0097, offsetZ: 0.0124 },
  { id: 'mosaic_reef_bloom', name: 'Mosaic Reef Bloom', pack: 'mythic', modelSrc: 'assets/scene/Models/plants/mythic/mosaic_reef_bloom/mosaic_reef_bloom.glb', scale: 0.4162, baseYOffset: 0.0079, offsetX: -0.0137, offsetZ: 0.0527 },
  { id: 'sunset_anemone', name: 'Sunset Anemone', pack: 'mythic', modelSrc: 'assets/scene/Models/plants/mythic/sunset_anemone/sunset_anemone.glb', scale: 0.3389, baseYOffset: -0.0025, offsetX: 0.001, offsetZ: 0.0348 },
  { id: 'sprouted_anemone', name: 'Sprouted Anemone', pack: 'mythic', modelSrc: 'assets/scene/Models/plants/mythic/sprouted_anemone/sprouted_anemone.glb', scale: 0.3444, baseYOffset: -0.0025, offsetX: 0.0004, offsetZ: 0.0629 },
  { id: 'sour_banana_plant', name: 'Sour Banana Plant', pack: 'mythic', modelSrc: 'assets/scene/Models/plants/mythic/sour_banana_plant/sour_banana_plant.glb', scale: 0.4328, baseYOffset: 0.0319, offsetX: -0.0054, offsetZ: 0.0381 },
  { id: 'coral_bloom', name: 'Coral Bloom', pack: 'mythic', modelSrc: 'assets/scene/Models/plants/mythic/coral_bloom/coral_bloom.glb', scale: 0.3269, baseYOffset: -0.0009, offsetX: 0.0077, offsetZ: -0.0078 },
  { id: 'sprouted_pink_lily', name: 'Sprouted Pink Lily', pack: 'mythic', modelSrc: 'assets/scene/Models/plants/mythic/sprouted_pink_lily/sprouted_pink_lily.glb', scale: 0.2122, baseYOffset: 0.0119, offsetX: -0.0141, offsetZ: 0.0005 },
  { id: 'moonroot_carrot', name: 'Moonroot Carrot', pack: 'mythic', modelSrc: 'assets/scene/Models/plants/mythic/moonroot_carrot/moonroot_carrot.glb', scale: 0.3544, baseYOffset: 0.0161, offsetX: -0.0234, offsetZ: -0.0341 },
  { id: 'spotted_midnight_lily', name: 'Spotted Midnight Lily', pack: 'mythic', modelSrc: 'assets/scene/Models/plants/mythic/spotted_midnight_lily/spotted_midnight_lily.glb', scale: 0.359, baseYOffset: -0.0011, offsetX: -0.0, offsetZ: -0.0 },
]
export const UNIQUE_PLANTS: ReadonlyArray<PlantSpecies> = [
  { id: 'alien_strawberry_vine', name: 'Alien Strawberry Vine', pack: 'unique', modelSrc: 'assets/scene/Models/plants/unique/alien_strawberry_vine/alien_strawberry_vine.glb', scale: 0.308, baseYOffset: -0.0008, offsetX: 0.0031, offsetZ: 0.0638 },
  { id: 'striped_anemone', name: 'Striped Anemone', pack: 'unique', modelSrc: 'assets/scene/Models/plants/unique/striped_anemone/striped_anemone.glb', scale: 0.354, baseYOffset: 0.0096, offsetX: 0.0648, offsetZ: 0.1353 },
  { id: 'budding_anemone', name: 'Budding Anemone', pack: 'unique', modelSrc: 'assets/scene/Models/plants/unique/budding_anemone/budding_anemone.glb', scale: 0.354, baseYOffset: 0.0096, offsetX: 0.069, offsetZ: 0.1063 },
  { id: 'hidden_fern_bulb', name: 'Hidden Fern Bulb', pack: 'unique', modelSrc: 'assets/scene/Models/plants/unique/hidden_fern_bulb/hidden_fern_bulb.glb', scale: 0.3423, baseYOffset: -0.0006, offsetX: -0.0083, offsetZ: 0.0257 },
  { id: 'giant_bugberry', name: 'Giant Bugberry', pack: 'unique', modelSrc: 'assets/scene/Models/plants/unique/giant_bugberry/giant_bugberry.glb', scale: 0.4313, baseYOffset: -0.0041, offsetX: 0.0141, offsetZ: -0.0 },
  { id: 'snake_eye_vine', name: 'Snake-Eye Vine', pack: 'unique', modelSrc: 'assets/scene/Models/plants/unique/snake_eye_vine/snake_eye_vine.glb', scale: 0.3655, baseYOffset: -0.0033, offsetX: 0.024, offsetZ: -0.0219 },
  { id: 'striped_honey_pot', name: 'Striped Honey Pot', pack: 'unique', modelSrc: 'assets/scene/Models/plants/unique/striped_honey_pot/striped_honey_pot.glb', scale: 0.3756, baseYOffset: -0.0052, offsetX: 0.0401, offsetZ: -0.0069 },
  { id: 'peacock_bloom', name: 'Peacock Bloom', pack: 'unique', modelSrc: 'assets/scene/Models/plants/unique/peacock_bloom/peacock_bloom.glb', scale: 0.2631, baseYOffset: 0.0009, offsetX: -0.018, offsetZ: 0.021 },
  { id: 'puffer_plant', name: 'Puffer Plant', pack: 'unique', modelSrc: 'assets/scene/Models/plants/unique/puffer_plant/puffer_plant.glb', scale: 0.3355, baseYOffset: 0.0006, offsetX: 0.0, offsetZ: -0.0 },
  { id: 'golden_step_palm', name: 'Golden Step Palm', pack: 'unique', modelSrc: 'assets/scene/Models/plants/unique/golden_step_palm/golden_step_palm.glb', scale: 0.2065, baseYOffset: 0.003, offsetX: -0.0021, offsetZ: 0.0052 },
]
/** Mythic + Unique plants: the Almanac's "Legends". Each exists at ONE rarity only (its own tier). */
export const LEGEND_PLANTS: ReadonlyArray<PlantSpecies> = [...MYTHIC_PLANTS, ...UNIQUE_PLANTS]
export function legendTier(id: string): number { return MYTHIC_PLANTS.some(s => s.id === id) ? 6 : UNIQUE_PLANTS.some(s => s.id === id) ? 7 : -1 }
export function bespokePool(tier: number): ReadonlyArray<PlantSpecies> {
  return tier === 6 ? MYTHIC_PLANTS : tier === 7 ? UNIQUE_PLANTS : []
}
/** Species retired from the pool, mapped to the one that replaced them. KJ 2026-09-20:
 *  the voxel pack shipped three near-identical grasses (grass_long, grass_long_2,
 *  grass_medium) — one is enough, and each GLB costs its own texture.
 *  Kept as ALIASES rather than deleted outright: flowers already grown and gifted carry
 *  these ids in player Storage, and an unresolvable id has no model to render. */
const RETIRED_SPECIES: Readonly<Record<string, string>> = {
  grass_long_2: 'grass_long',
  grass_medium: 'grass_long',
}
export function plantSpeciesById(id: string): PlantSpecies | null {
  const key = RETIRED_SPECIES[id] ?? id
  return PLANT_SPECIES.find(s => s.id === key) ?? MYTHIC_PLANTS.find(s => s.id === key) ?? UNIQUE_PLANTS.find(s => s.id === key) ?? null
}

/** How long the bloom finale card holds after a bloom ends, and the rarity tier at
 *  which a gathered seed counts as "rare" on it (2 = Rare, the third of the eight). */
export const BLOOM_FINALE_MS  = 9_000
export const FINALE_RARE_TIER = 2

// ── Podium — top gardeners as AVATARS (KJ 2026-09-20) ────────
/** KJ placed four avatar armatures in scene.glb (2026-09-21) marking exactly where the
 *  top gardeners should stand, so these are READ OFF THE ART, not computed from a centre
 *  and an even spacing — the four are not evenly spaced (1.856 / 1.878 / 1.887 m) and
 *  that is deliberate. Source nodes `Armature`, `Armature.001/.002/.003`.
 *
 *  ⚠️ GLB-LOCAL → SCENE-WORLD IS NOT A PLAIN OFFSET. glTF is right-handed and DCL is
 *  left-handed, so the importer NEGATES X; Z passes through. With scene.glb's container
 *  sitting at (8, 0, 24) with identity rotation in main.composite:
 *
 *      world = ( 8 - local.x ,  local.y ,  local.z + 24 )
 *
 *  The podium was ~16 m out along X from 2026-09-20 until this was found (the old code
 *  used `local.x + 8`, which got Z right and X mirrored, dropping the avatars into the
 *  planter field — exactly what KJ's screenshot showed). Two independent checks:
 *  `StandTop.root` (local -7.97, 0.17, -30.66) maps to x 15.969, and the mean of the four
 *  markers below is 15.976 — they are centred on their own stand. */
// y RAISED 0.979 -> 1.479 on 2026-09-29: the stand in scene.glb rose 0.5 m after these markers were
// baked (StandBottom's plinth tops are now y 1.48), which sank the avatars half a metre into their
// pods. The marker nodes themselves are gone from the file, so x/z are kept and y follows the plinths.
export const PODIUM_SLOTS: ReadonlyArray<{ x: number; y: number; z: number }> = [
  { x: 13.326, y: 1.479, z: -6.66 },
  { x: 15.196, y: 1.479, z: -6.66 },
  { x: 17.066, y: 1.479, z: -6.66 },
  { x: 18.936, y: 1.479, z: -6.66 },
]
// RE-CENTRED 2026-09-30 (KJ: avatars stood a little to one side of their pods): x / z are now the centres of the four plinth TOPS in
// StandBottom (scene.glb, world = (8 - x, y, z + 24)), measured from the mesh. They were 0.14-0.17 m lower in x and 0.05 m off in z.
/** Euler Y. The markers carry GLB yaw 180 and I reasoned an X-mirror would preserve it;
 *  KJ checked in-world 2026-09-21 and they faced backwards, so the import lands them at 0.
 *  0 = facing +Z, out of the stand and into the garden. */
export const PODIUM_ROTATION_Y = 0
/** How many top gardeners stand on it — one per marker. 0 disables the whole thing, the
 *  escape hatch if four skinned avatars cost too much frame rate on the iMac. */
export const PODIUM_COUNT      = PODIUM_SLOTS.length
/** Name plate height above the rail. */
/** Tap targets that page through the board sit this far out past the end pods. */
export const PODIUM_PAGE_OFFSET = 0.75
/** The page buttons were collider-only and therefore invisible (KJ 2026-09-21). They now
 *  render a small emissive panel with a label on it, at roughly chest height on the rail. */
export const PODIUM_PAGE_SIZE   = { x: 0.55, y: 0.55, z: 0.08 }
export const PODIUM_PAGE_Y      = 1.15   // above the rail top
/** The pager arrows are the tutorial's ground-decal chevron stood on end: rolled about
 *  the arrow's own tip axis so its face turns toward the garden (+Z). Sign is applied per
 *  direction in podium.ts. If they come out facing the fence instead, flip to −90 (KJ
 *  2026-09-22: "need rotating 90° maybe on X or Z" — it's Z in the arrow's frame). TUNING */
export const PODIUM_ARROW_ROLL  = 90

// ── Test tooling ─────────────────────────────────────────────
/** Wallets allowed to use test handlers that write PERMANENT data (lifetime board /
 *  tributes). Lower-case. Pre-production: gate every test handler + unmount TestPanelUi. */
/** One-off lifetime-water grants (KJ 2026-09-30). Applied server-side the next time the gardener's record loads, once per `id`
 *  (the id is stored on their lifetime record, so a redeploy or restart never pays twice). Lowercase address. */
export const WATER_GRANTS: ReadonlyArray<{ id: string; address: string; amount: number }> = [
  { id: 'peterparker-2026-09-30', address: '0xce0a77432dc952460c6ca1b8d8cf54169db3e210', amount: 2000 },
]

export const ADMIN_ADDRESSES: ReadonlyArray<string> = ['0x8967ad851ccbd4c1a2d57a128d3c606fcab29bad']

// ── v2 Phase 6: bloom variants + scaled-bloom FX (GDD §3 step 3, §5 "shareable moment") ──
// The variant SYSTEM ships now; the catalog grows later and odds can be rotated
// every few weeks without a new build of anything but this table (GDD §9).
export interface RGB { r: number; g: number; b: number }
export interface BloomPalette { albedo: RGB; emissive: RGB }   // sparkles, shockwaves, ripples, fireflies
export interface BloomVariant {
  id: string
  name: string
  weight: number        // relative odds among eligible variants
  minScale: number      // bloom scale required (bloomScaleFor: 1 gardener 0.25 … 4+ = 1)
  rareSeedMult: number  // multiplies the per-seed rare chance for this bloom
  palette: BloomPalette
}
export const BLOOM_VARIANTS: ReadonlyArray<BloomVariant> = [
  { id: 'classic', name: 'Bloom',         weight: 9, minScale: 0,    rareSeedMult: 1,
    palette: { albedo: { r: 1.0, g: 0.95, b: 0.78 }, emissive: { r: 1.0, g: 0.88, b: 0.52 } } },   // warm gold (v1 look)
  { id: 'moonlit', name: 'Moonlit Bloom', weight: 1, minScale: 0.75, rareSeedMult: 2,             // TUNING — rare; needs 3+ gardeners
    palette: { albedo: { r: 0.85, g: 0.92, b: 1.0 }, emissive: { r: 0.55, g: 0.75, b: 1.0 } } },   // cool moonlight
]
export function bloomVariantById(id: string): BloomVariant {
  return BLOOM_VARIANTS.find(v => v.id === id) ?? BLOOM_VARIANTS[0]
}
/** Weighted roll among variants eligible for this bloom's scale. */
export function rollBloomVariant(bloomScale: number): BloomVariant {
  const eligible = BLOOM_VARIANTS.filter(v => bloomScale >= v.minScale)
  const total = eligible.reduce((s, v) => s + v.weight, 0)
  let r = Math.random() * total
  for (const v of eligible) { r -= v.weight; if (r <= 0) return v }
  return eligible[eligible.length - 1] ?? BLOOM_VARIANTS[0]
}
/** FX budget for a bloom of `scale`: 0 = quiet solo bloom, 1 = gentle (2–3 gardeners), 2 = full spectacle. */
export function bloomFxLevel(scale: number): 0 | 1 | 2 {
  return scale >= 0.99 ? 2 : scale >= 0.5 ? 1 : 0
}

// ── v2 Phase 5: boards + milestone flair (GDD §4.3 hook 2, §5 recognition) ──
/** Lifetime-water thresholds for the flair tiers: sprout → flower → golden flower. */
export const FLAIR_TIERS = [100, 500, 1000] as const   // TUNING — GDD "~100 / 500 / 1,000"
/** 0 = none, 1 = sprout, 2 = flower, 3 = golden. */
export function flairTier(lifetimeWaters: number): number {
  let tier = 0
  for (const t of FLAIR_TIERS) if (lifetimeWaters >= t) tier++
  return tier
}
/** Flair icon shown beside a name (boards) or above a "Watered by" label: the HUD glyph
 *  set, tinted per tier. null = no flair yet. (Text tags retired 2026-09-17.) */
export function flairIcon(tier: number): { src: string; tint: { r: number; g: number; b: number } } | null {
  if (tier >= 3) return { src: 'assets/scene/Images/ui/glyph_flower.png', tint: { r: 1.0,  g: 0.82, b: 0.30 } }   // golden flower
  if (tier === 2) return { src: 'assets/scene/Images/ui/glyph_flower.png', tint: { r: 0.96, g: 0.55, b: 0.75 } }   // flower
  if (tier === 1) return { src: 'assets/scene/Images/ui/glyph_seed.png',   tint: { r: 0.45, g: 0.85, b: 0.55 } }   // sprout
  return null
}
/** Weekly board cadence — the reset moment is shown in-world (GDD §4.3). */
export const WEEKLY_RESET_MS = 7 * 24 * 60 * 60 * 1000

// ── v2 Phase 4: harvest, gift, box-watering (GDD §3 step 5, §5 social loop) ──
/** Planters a player may hold at once — growing AND displaying (GDD §3.1, 2026-09-18:
 *  displaying = leaving an opened flower in its planter). Stored per player (`boxCap`)
 *  so purchasable extra planters can raise it; the effective cap is max(stored, this). */
/** Beds are numbered outward from here: bed 1 is the group of planters nearest this point. It is now the potting shed's door in KJ's new scene.glb (door.001), so the first
 *  gardeners sit beside their inventory (design/zone-layout.md). */
/** The beds of the baked layout, one list of planter ids per bed, numbered from the shed door outward (KJ's scene.glb strips, 2026-09-25).
 *  Explicit so a bed is always the row that was laid out; shared/beds.ts falls back to greedy grouping for any planter not listed. */
export const BEDS_EXPLICIT: ReadonlyArray<ReadonlyArray<string>> = [
  ['box_4', 'box_6', 'box_99', 'box_100'],
  ['box_1', 'box_2', 'box_3', 'box_50'],
  ['box_51', 'box_52', 'box_53', 'box_54'],
  ['box_55', 'box_56', 'box_57', 'box_58'],
  ['box_59', 'box_60', 'box_61', 'box_62'],
  ['box_63', 'box_64', 'box_65', 'box_66'],
  ['box_67', 'box_68', 'box_69', 'box_70'],
  ['box_71', 'box_72', 'box_73', 'box_74'],
  ['box_75', 'box_76', 'box_77', 'box_78'],
  ['box_79', 'box_80', 'box_81', 'box_82'],
  ['box_83', 'box_84', 'box_85', 'box_86'],
  ['box_87', 'box_88', 'box_89', 'box_90'],
  ['box_91', 'box_92', 'box_93', 'box_94'],
  ['box_97', 'box_98', 'box_101', 'box_102'],
  ['box_103', 'box_104', 'box_105', 'box_106'],
  ['box_107', 'box_108', 'box_109', 'box_110'],
  ['box_111', 'box_112', 'box_113', 'box_114'],
  ['box_115', 'box_116', 'box_117', 'box_118'],
  ['box_119', 'box_120', 'box_121', 'box_122'],
  ['box_123', 'box_124', 'box_125', 'box_126'],
  ['box_127', 'box_128', 'box_129', 'box_130'],
  ['box_131', 'box_132', 'box_133', 'box_134'],
  ['box_135', 'box_136', 'box_137', 'box_138'],
  ['box_139', 'box_140', 'box_141', 'box_142'],
]
export const BED_FILL_ORIGIN = { x: -18.9, z: 50.0 } as const
export const BOX_CAP_DEFAULT       = 2   // TUNING
/** Crowding rule (GDD §3.1): keep this many planters free. When fewer are free, the
 *  planter of the owner away longest (not connected, away ≥ PLANTER_TIDY_MIN_AWAY_MS) is
 *  tidied up — opened flower → their My flowers, growing seed → back to their pouch. */
export const PLANTER_RESERVE_FREE    = 5                     // TUNING — at ~100 planters
export const PLANTER_TIDY_MIN_AWAY_MS = 24 * 60 * 60 * 1000  // TUNING
/** Free BEDS to keep in reserve (KJ 2026-09-29): with no free bed the plot protection stops protecting anyone and players
 *  spill into each other's beds. Below this, a bed whose owners have all been away past PLANTER_TIDY_MIN_AWAY_MS is released. */
/** Under pressure (someone is here, wants to plant, and every bed is owned) a bed whose owners are ALL offline for this long is released
 *  straight away, longest-away first. Owners who are connected are never touched. */
export const PLANTER_TIDY_MIN_AWAY_PRESSURE_MS = 30 * 60 * 1000  // TUNING
export const BED_RESERVE_FREE = 2   // TUNING
/** Keepsake collection size — a TECHNICAL backstop, not a gameplay limit (KJ 2026-09-19:
 *  "players can be hoarders"; was 20). The whole collection is stored and sent as one JSON
 *  list (~85 B per flower) on every harvest / gift / join, so this only guards payload size:
 *  500 ≈ 42 KB. Unbounded hoarding would need per-(species, tier) counts instead of a list. */
export const FLOWER_COLLECTION_CAP = 500
/** Another player watering your growing box shaves this off its timer… */
/** …at most this many times per box, one water per visitor. */
export const BOX_WATER_MAX         = 5   // TUNING — was 3; week-2 testers wanted "more a day"

// ── The Avenue — communal planters (design/communal-planters.md, 2026-09-22) ──
// MOVED 2026-09-25: the 72 old wall cubes are gone from the layout; the Avenue is now the 55 Hall of Fame
// stands from KJ's scene.glb (shared/hallOfFame.ts) — av_1..av_55 in row order, soil-top slots. A stored
// av_56..av_72 flower is sent home by the server's orphan rule. The notes below on the old wall are history.
// A gallery, not a garden: harvested flowers only, nothing grows or wilts.
// BAKED 2026-09-22 from scene.glb itself: the 72 wall planters are part of KJ's entrance
// model (nodes ExhibitFlowers..ExhibitFlowers.005, identity transforms, geometry baked
// into the vertices — the node origins mean nothing). Each cube has a 2-triangle soil
// face inside it; x/z here = that face's centre, y = its height, mapped GLB-local →
// scene-world exactly as PODIUM_SLOTS: world = (8 − local.x, local.y, local.z + 24).
// Two walls: z ≈ 20.5 (rot 0, faces +z into the avenue) and z ≈ 27.5 (rot 180). Three
// rows (soil y 1.13 / 1.78 / 2.43). Ids run from the gate (x ≈ 47) toward the garden.
// Re-bake with the same script if the wall moves: cluster horizontal faces at |z| 3.1–3.78.
export const AVENUE_POSITIONS: ReadonlyArray<{ id: string; x: number; y: number; z: number; rot: number }> = hofAvenueSlots()
/** Stand geometry (scene metres), from the Hall of Fame module: the plain front wall stands
 *  HOF_FRONT_OUT in front of the soil centre, and its plaque centre is DROP below the soil top. */
export const AVENUE_CUBE_FRONT_OFFSET = HOF_FRONT_OUT
export const AVENUE_PLAQUE_OUT        = 0.98   // on the star panel: 0.96 m out from the soil centre + 0.02 proud of the slope
export const AVENUE_PLAQUE_DROP       = 0.31   // panel centre is 0.33 m below the soil top, +0.02 proud
/** Species models are normalised to ~0.55 m (PLANT_SPECIES) for a 1.1 m planter; the
 *  Avenue cubes are 0.54 m wide, so shrink a touch. TUNING. */
export const AVENUE_FLOWER_SCALE = 1.8   // stands are 1.6 m wide (the old wall cubes were 0.54) — TUNING
/** Empty-slot filler: a floating gold "?" over the soil (avenueSystem.ts setWildBloom). */
/** How far out from a slot the onboarding marker arrow floats. Deliberately SHORT: at the
 *  tutorial trail's 1.2 m the arrow hung a metre in front of a 0.54 m cube, so a click
 *  aimed at the arrow projected past the cube edge and hit nothing — which is what "the
 *  arrow pointed at it and clicking did nothing" looks like (KJ 2026-09-22). Close in, a
 *  click on the arrow carries through to the slot behind it. TUNING */
export const AVENUE_ARROW_STANDOFF = 0.45
/** Inspect card (design/communal-planters.md "zooms in on plant") camera move — OFF for
 *  now (2026-09-22). Two blind attempts (a fixed-point placement, then a two-camera eased
 *  "return to the exact starting pose" close) both read as worse than no camera move at
 *  all — KJ: "still terrible, like a bunch of things happening at once" on the second one.
 *  Neither attempt could be watched live, so this stopped rather than guess a third time.
 *  The card's information works with this off; re-enabling needs either watching it
 *  together in-world or real docs on how the explorer actually blends a virtualCameraEntity
 *  switch (the two-hop close relied on that being smooth, and evidently it wasn't, or the
 *  extra entities/timers it juggled were themselves the "bunch of things"). Code kept in
 *  avenueCard.tsx, simplified back to a single camera / single direct release — the
 *  smaller of the two attempts, in case this gets picked up again. */
export const AVENUE_CAMERA_ZOOM          = false
export const AVENUE_CAMERA_PUSH_FRACTION = 0.35   // lean in by at most this fraction of the player's own distance — TUNING
export const AVENUE_CAMERA_MIN_DIST      = 0.6    // safety floor only — never end up closer than this (clipping) — TUNING
export const AVENUE_CAMERA_MS            = 600    // transition duration
/** Lowest rarity tier allowed on the Avenue (2 = Rare). TUNING — drop to 1 (Uncommon)
 *  if the Avenue is mostly empty after launch week (hypothesis H2-07). */
export const AVENUE_MIN_TIER = 2
/** Mythic and Unique are never tidied off the Avenue by the crowding rule. */
export const AVENUE_NEVER_TIDY_TIER = 6
/** Per-player Avenue slot cap. 0 = NO per-player limit (KJ 2026-09-22): Rare+ flowers are
 *  scarce enough to be the limiter and the crowding rule handles a full wall, and the old
 *  flair-tier ladder (1/2/3 slots at 100/500/1,000 waters) gated the feature behind 100
 *  waters for no design gain. Set a number to reinstate a flat cap if one player ever
 *  wallpapers the wall. TUNING */
export const AVENUE_SLOT_CAP = 0
/** How many Avenue slots a player may hold — the cap, or every slot when uncapped. */
export function avenueSlotCap(): number {
  return AVENUE_SLOT_CAP > 0 ? AVENUE_SLOT_CAP : AVENUE_POSITIONS.length
}
