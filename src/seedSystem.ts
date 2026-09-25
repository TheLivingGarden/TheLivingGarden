// =============================================================
// Bloom Garden v2 — Seed System (CLIENT ONLY, greybox)
//
// GDD §3 step 3 + §6 "Gather seeds": seeds flow from the bloom and
// are gathered by WALKING NEAR them — movement only, zero taps.
// Rares sparkle differently as they fall: a gentle chase, never a
// twitch test.
//
// Greybox pass: seeds are emissive spheres (mint = normal, gold =
// rare, slightly larger + pulsing). Real seed art arrives in the
// FX/variant phase.
//
// Server communication (one message per seed — see messages.ts registry note):
//   receive ←  seedSpawned   { id, x, z, rarityTier, spawnedAt }
//   send    →  gatherSeed    { seedId }
//   receive ←  seedGathered  { seedId, by, byAddress, rarityTier }
//
// The server is authoritative: a seed only despawns-with-reward on
// seedGathered. Client-side proximity just *requests* the gather.
// =============================================================

import {
  engine,
  Entity,
  Transform,
  GltfContainer,
  GltfNodeModifiers,
  ColliderLayer,
  ParticleSystem,
  LightSource,
} from '@dcl/sdk/ecs'
import { Color4, Quaternion } from '@dcl/sdk/math'
import { isMobile } from '@dcl/sdk/platform'
import { getPlayer } from '@dcl/sdk/players'
import { room } from './shared/messages'
import {
  SEED_FLIGHT_SPEED,
  SEED_FLIGHT_MIN_MS,
  SEED_FLIGHT_MAX_MS,
  SEED_LAUNCH_STAGGER_MS,
  SEED_FLIGHT_SCALE,
  SEED_DODGES_BY_TIER,
  SEED_DODGES_MOBILE_MAX,
  SEED_DODGE_TRIGGER_M,
  SEED_HOP_M_LOW,
  SEED_HOP_M_HIGH,
  SEED_HOP_MS,
  SEED_HOP_ARC_H,
  SEED_HOP_COOLDOWN_MS,
  SEED_NO_DODGE_LAST_MS,
  GARDEN_BOUNDS,
  SEED_ARC_H,
  BLOOM_SEED_ORIGIN,
  SEED_ORIGIN_SPREAD_M,
  SEED_LIFETIME_MS,
  SEED_GATHER_RADIUS,
  SEED_COLLECT_RADIUS,
  SEED_MODEL_HEIGHT,
  SPARKLE_SRC,
  seedModelSrc,
  rarityTierById,
  withArticle,
} from './shared/config'
import { showToast, showMoment } from './notifications'
import { triggerSparkle } from './sparkleSystem'
import { getPouch } from './playerInventory'
import { setupGoldenSeed } from './goldenSeed'
import { playSfx } from './sounds'

// ---------------------------------------------------------------
// Config (greybox visuals — replaced in the FX phase)
// ---------------------------------------------------------------

// `let` — live-tunable from the test panel admin controls (adminScaleSeeds / adminShiftSeedHeight)
let SEED_SCALE_MIN = 0.45             // world HEIGHT (m) of a Common seed — sized for visibility
let SEED_SCALE_MAX = 0.62             // world height at the top of the range (tier 7, Unique)
let SEED_REST_Y       = 1.1           // rest at ~chest height so plants/decor don't hide seeds
const SEED_BOB_SPEED    = 2.0         // idle bob speed (rad/s)
const SEED_SWAY_AMPL    = 0.35        // horizontal sway while falling (m)
// Chase speed scales with proximity: gentle drift at the leash edge, then it
// darts into you at close range — so walking THROUGH a seed collects it even
// at a run, while the far behaviour still reads as "drifts gently toward you".
const DRIFT_SPEED_MIN   = 2.5         // m/s at SEED_GATHER_RADIUS
const DRIFT_SPEED_MAX   = 9.0         // m/s when nearly touching (outruns a running avatar)
const CHEST_HEIGHT      = 0.9         // m above the avatar Transform origin (origin = feet)
const GATHER_RETRY_MS   = 3_000       // re-allow a gather request if no reply
const TOAST_GATHER_MS   = 4_000
// Tiers roll 0..7 (Mythic/Unique joined the roll 2026-09-19); size ramps across all of them.
const MAX_ROLLABLE_TIER = 7
function seedScaleForTier(tier: number): number {
  const t = Math.max(0, Math.min(MAX_ROLLABLE_TIER, tier)) / MAX_ROLLABLE_TIER
  return (SEED_SCALE_MIN + (SEED_SCALE_MAX - SEED_SCALE_MIN) * t) / SEED_MODEL_HEIGHT
}

// ---------------------------------------------------------------
// Tier FX ladder (KJ 2026-09-19) — restraint over quantity: "too much for too little".
// Motion carries the tiers and is FREE — the drift system already rewrites every live seed's
// Transform each frame, so spin / bob / heartbeat throb / wobble / spiral fall ride on that
// same write. On top, AT MOST ONE emitter per seed (Epic+): a few LARGE soft glints (≤ ~5
// alive), alpha-blended so they read on the bright floor, world-space so a falling seed leaves
// one or two behind. Seed materials are NEVER overridden: KJ's outline is an inverted hull
// (flipped normals + back-face culling) that an override material turns into a solid blob.
// ---------------------------------------------------------------

type RGB = { r: number; g: number; b: number }
interface SeedFx {
  spinDegS: number
  bob:      number                                  // idle bob height (m)
  throb:    { periodS: number; amp: number } | null // heartbeat scale spike
  wobbleDeg: number                                 // tilt sway while spinning
  spiral:   number                                  // fall sway multiplier (1 = the old sway)
  glints:   { a: RGB; b: RGB; rate: number; size: number } | null
  light:    RGB | null                              // desktop only (godot LightSource flicker)
}
const BLUE = { r: 0.26, g: 0.56, b: 1 }, ICE = { r: 0.7, g: 0.88, b: 1 }
const PURPLE = { r: 0.63, g: 0.29, b: 0.95 }, LAVENDER = { r: 0.9, g: 0.78, b: 1 }
const LIME = { r: 0.61, g: 0.82, b: 0.26 }, RED = { r: 1, g: 0.2, b: 0.15 }, PINK = { r: 1, g: 0.29, b: 0.93 }
const GOLD = { r: 1, g: 0.64, b: 0.09 }, CREAM = { r: 1, g: 0.93, b: 0.7 }
// TUNING — the whole ladder. glints.rate is per second; lifetime 1.2 s → rate × 1.2 alive.
const SEED_FX: ReadonlyArray<SeedFx> = [
  /* Common    */ { spinDegS: 40, bob: 0.05, throb: null,                         wobbleDeg: 0,  spiral: 1,   glints: null, light: null },
  /* Uncommon  */ { spinDegS: 60, bob: 0.08, throb: null,                         wobbleDeg: 0,  spiral: 1,   glints: null, light: null },
  /* Rare      */ { spinDegS: 60, bob: 0.08, throb: { periodS: 1.5, amp: 0.10 },  wobbleDeg: 0,  spiral: 1,   glints: null, light: null },
  /* Epic      */ { spinDegS: 70, bob: 0.09, throb: { periodS: 1.5, amp: 0.10 },  wobbleDeg: 12, spiral: 1,   glints: { a: BLUE,   b: ICE,      rate: 2,   size: 0.35 }, light: null },
  /* Legendary */ { spinDegS: 70, bob: 0.10, throb: { periodS: 1.3, amp: 0.12 },  wobbleDeg: 12, spiral: 2.2, glints: { a: PURPLE, b: LAVENDER, rate: 2.5, size: 0.4 },  light: null },
  /* Exotic    */ { spinDegS: 90, bob: 0.10, throb: { periodS: 0.8, amp: 0.14 },  wobbleDeg: 22, spiral: 2.2, glints: { a: LIME,   b: RED,      rate: 3,   size: 0.4 },  light: null },
  /* Mythic    */ { spinDegS: 90, bob: 0.12, throb: { periodS: 0.8, amp: 0.16 },  wobbleDeg: 22, spiral: 2.6, glints: { a: PINK,   b: CREAM,    rate: 3.5, size: 0.45 }, light: null },
  /* Unique    */ { spinDegS: 45, bob: 0.12, throb: { periodS: 1.1, amp: 0.14 },  wobbleDeg: 8,  spiral: 2.6, glints: { a: GOLD,   b: CREAM,    rate: 4,   size: 0.5 },  light: GOLD },
]
const seedFx = (tier: number): SeedFx => SEED_FX[Math.max(0, Math.min(SEED_FX.length - 1, tier))]
const PSB_ALPHA = 0, PS_PLAYING = 0, PSS_WORLD = 1   // const enums in @dcl/ecs internals (same as plantVfx)

/** Heartbeat: a sharp throb then rest (sin⁸ spike), 0..1. */
const heartbeat = (tS: number, periodS: number): number => Math.pow(Math.max(0, Math.sin(Math.PI * ((tS / periodS) % 1))), 8)

/** The seed's one accent emitter (+ Unique's light), as CHILDREN — removed with it. */
function attachSeedFx(seed: Entity, fx: SeedFx): void {
  if (fx.glints) {
    const { a, b, rate, size } = fx.glints
    const e = engine.addEntity()
    Transform.create(e, { parent: seed })
    ParticleSystem.create(e, {
      shape: ParticleSystem.Shape.Sphere({ radius: 0.3 }),
      rate, maxParticles: Math.ceil(rate * 1.2) + 1, lifetime: 1.2,
      gravity: 0, additionalForce: { x: 0, y: 0.25, z: 0 },
      initialVelocitySpeed: { start: 0, end: 0.1 },
      initialSize: { start: size * 0.7, end: size }, sizeOverTime: { start: 0.4, end: 1 },   // swell…
      initialColor: { start: Color4.create(a.r, a.g, a.b, 1), end: Color4.create(b.r, b.g, b.b, 1) },
      colorOverTime: { start: Color4.create(1, 1, 1, 1), end: Color4.create(1, 1, 1, 0) },   // …then fade
      texture: { src: SPARKLE_SRC }, billboard: true, blendMode: PSB_ALPHA,
      simulationSpace: PSS_WORLD,
      loop: true, prewarm: false, active: true, playbackState: PS_PLAYING,
    })
  }
  if (fx.light && !isMobile()) {
    const l = engine.addEntity()
    Transform.create(l, { parent: seed })
    LightSource.create(l, { active: true, color: fx.light, intensity: 2_500, shadow: false, type: { $case: 'point', point: {} } })
  }
}

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------

interface Seed {
  id:          string
  entity:      Entity
  rarityTier:  number
  fx:          SeedFx
  baseScale:   number
  baseX:       number
  baseZ:       number
  spawnLocalMs: number   // local-clock ms when the fall began (clock-synced)
  despawnAtMs: number    // local-clock ms when an ungathered seed evaporates
  phase:       number    // per-seed offset so bobbing isn't synchronized
  drifting:    boolean   // player is close — seed is chasing them
  gatherSentAt: number   // 0 = not requested; else local ms of last request
  dodgesLeft:  number    // hops it will still make away from an approaching player
  hop:         { fromX: number; fromZ: number; toX: number; toZ: number; startMs: number } | null
  hopReadyAt:  number    // local ms — earliest the next hop may start
  originX:     number    // where it leaves the Bloom's crown (jittered per seed)
  originY:     number
  originZ:     number
  launchAt:    number    // local ms — when it leaves the Bloom (staggered); hidden at the Bloom until then
  flightMs:    number    // its arc's duration, longer for a farther landing spot
  trail:       Entity | null   // comet-tail emitter, removed when it lands
}

const seeds = new Map<string, Seed>()   // seedId → live seed

// ---------------------------------------------------------------
// Spawning / despawning
// ---------------------------------------------------------------

function spawnSeed(rec: { id: string; x: number; z: number; rarityTier: number; spawnedAt: number }): void {
  if (seeds.has(rec.id)) return   // duplicate seedSpawned (e.g. fullSync resend)

  // Fall timing runs off the CLIENT clock from the moment the message arrives —
  // NOT clockSync. The synced server time is unreliable in this scene (Schemas.Number
  // corrupts 13-digit timestamps → tens-of-seconds offset), which would otherwise
  // launch the seed above the canopy or despawn it instantly. Seeds are transient,
  // so a fresh local fall on arrival is correct and needs no cross-client sync.
  const localSpawn = Date.now()
  const despawnAt  = localSpawn + SEED_LIFETIME_MS

  const entity = engine.addEntity()
  const scale  = seedScaleForTier(rec.rarityTier)
  const oa = Math.random() * Math.PI * 2, orad = Math.sqrt(Math.random()) * SEED_ORIGIN_SPREAD_M
  const originX = BLOOM_SEED_ORIGIN.x + Math.cos(oa) * orad, originZ = BLOOM_SEED_ORIGIN.z + Math.sin(oa) * orad, originY = BLOOM_SEED_ORIGIN.y
  Transform.create(entity, {
    position: { x: originX, y: originY, z: originZ },   // pours out of the Bloom's crown, see the flight in seedDriftSystem
    scale:    { x: scale, y: scale, z: scale },
  })
  // KJ's tier seed model (was a greybox sphere). Proximity-collected, so no colliders;
  // small and numerous during a bloom, so no shadow casting either.
  GltfContainer.create(entity, { src: seedModelSrc(rec.rarityTier), visibleMeshesCollisionMask: ColliderLayer.CL_NONE, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE })
  GltfNodeModifiers.create(entity, { modifiers: [{ path: '', castShadows: false }] })
  const fx = seedFx(rec.rarityTier)
  attachSeedFx(entity, fx)

  seeds.set(rec.id, {
    id:           rec.id,
    entity,
    rarityTier:   rec.rarityTier,
    fx,
    baseScale:    scale,
    baseX:        rec.x,
    baseZ:        rec.z,
    spawnLocalMs: localSpawn,
    despawnAtMs:  despawnAt,
    phase:        Math.random() * Math.PI * 2,
    drifting:     false,
    gatherSentAt: 0,
    dodgesLeft:   Math.min(SEED_DODGES_BY_TIER[rec.rarityTier] ?? 0, isMobile() ? SEED_DODGES_MOBILE_MAX : Infinity),
    hop:          null,
    hopReadyAt:   0,
    originX, originY, originZ,
    launchAt:     localSpawn + Math.random() * SEED_LAUNCH_STAGGER_MS,
    flightMs:     Math.max(SEED_FLIGHT_MIN_MS, Math.min(SEED_FLIGHT_MAX_MS, Math.hypot(rec.x - originX, rec.z - originZ) / SEED_FLIGHT_SPEED * 1000)),
    trail:        null,
  })
  // Comet tail while it flies, so the launch reads as coming OUT of the Bloom
  const rec2 = seeds.get(rec.id)!
  const tc = rarityTierById(rec.rarityTier).seedColor
  const tail = engine.addEntity()
  Transform.create(tail, { parent: entity })
  ParticleSystem.create(tail, {
    shape: ParticleSystem.Shape.Sphere({ radius: 0.15 }),
    rate: 40, maxParticles: 60, lifetime: 1.0, gravity: 0,
    initialVelocitySpeed: { start: 0, end: 0.15 },
    initialSize: { start: 0.8, end: 1.0 }, sizeOverTime: { start: 1, end: 0 },
    initialColor: { start: Color4.create(tc.r, tc.g, tc.b, 1), end: Color4.create(1, 1, 1, 1) },
    colorOverTime: { start: Color4.create(1, 1, 1, 1), end: Color4.create(1, 1, 1, 0) },
    texture: { src: SPARKLE_SRC }, billboard: true, blendMode: PSB_ALPHA,
    simulationSpace: PSS_WORLD,
    loop: true, prewarm: false, active: true, playbackState: PS_PLAYING,
  })
  rec2.trail = tail
  console.log(`[Seeds] spawned ${rec.id} tier=${rec.rarityTier}: leaves the Bloom at (${originX.toFixed(1)}, ${originY.toFixed(1)}, ${originZ.toFixed(1)}), lands (${rec.x.toFixed(1)}, ${rec.z.toFixed(1)}) in ${Math.round(rec2.flightMs)} ms`)
}

function despawnSeed(id: string): void {
  const seed = seeds.get(id)
  if (!seed) return
  engine.removeEntityWithChildren(seed.entity)   // + its glint emitter / light
  seeds.delete(id)
}

/** Remove every live seed — scene teardown, and the end of a bloom. */
export function clearAllSeeds(): void {
  for (const id of [...seeds.keys()]) despawnSeed(id)
}

// ---------------------------------------------------------------
// Admin / test-panel controls (dev only)
// ---------------------------------------------------------------

/** Spawn a seed 4 m in front of the player (far enough to watch it fall) with NO network round-trip —
 *  isolates "can the client render a seed" from "does the message arrive". */
export function adminSpawnLocalSeed(rarityTier = 0): void {
  const p = Transform.getOrNull(engine.PlayerEntity)?.position
  if (!p) { console.log('[Seeds][admin] no player transform yet'); return }
  spawnSeed({ id: `local_${Date.now()}`, x: p.x + 4, z: p.z, rarityTier, spawnedAt: Date.now() })
}

/** Test panel: one LOCAL seed of every tier (Common → Unique) in a row 4 m out, 1.2 m apart —
 *  compare the whole FX ladder side by side. Local seeds self-collect on contact. */
/** Test panel: a local seed shower — 8 seeds pour out of the Bloom and land around the player
 *  through the REAL flight code, no server Bloom needed. Local seeds self-collect on contact. */
export function adminSeedShower(): void {
  const p = Transform.getOrNull(engine.PlayerEntity)?.position
  if (!p) return
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2
    spawnSeed({ id: `local_${Date.now()}_${i}`, x: p.x + Math.cos(a) * 5, z: p.z + Math.sin(a) * 5, rarityTier: i % 4 === 0 ? 3 : 0, spawnedAt: Date.now() })
  }
  triggerSparkle({ x: BLOOM_SEED_ORIGIN.x, y: BLOOM_SEED_ORIGIN.y, z: BLOOM_SEED_ORIGIN.z })
}

export function adminSpawnSeedLadder(): void {
  const p = Transform.getOrNull(engine.PlayerEntity)?.position
  if (!p) return
  for (let tier = 0; tier < SEED_FX.length; tier++) {
    spawnSeed({ id: `local_${Date.now()}_${tier}`, x: p.x + 4, z: p.z + (tier - (SEED_FX.length - 1) / 2) * 1.2, rarityTier: tier, spawnedAt: Date.now() })
  }
}

/** Ask the server to spawn one seed near the player through the REAL seedSpawned path. */
export function adminRequestServerSeed(rarityTier = 0): void {
  const p = Transform.getOrNull(engine.PlayerEntity)?.position ?? { x: 8, y: 0, z: 12 }
  console.log('[Seeds][admin] requesting server seed')
  room.send('adminSpawnSeed', { x: p.x + 4, z: p.z, rarityTier })
}

/** Multiply seed scale (applies to live seeds immediately). */
export function adminScaleSeeds(mult: number): void {
  SEED_SCALE_MIN *= mult
  SEED_SCALE_MAX *= mult
  for (const s of seeds.values()) s.baseScale = seedScaleForTier(s.rarityTier)   // applied on the next frame
  console.log(`[Seeds][admin] scale min=${SEED_SCALE_MIN.toFixed(2)} max=${SEED_SCALE_MAX.toFixed(2)}`)
}

/** Raise/lower the resting height (live seeds follow on their next bob frame). */
export function adminShiftSeedHeight(delta: number): void {
  SEED_REST_Y = Math.max(0.1, SEED_REST_Y + delta)
  console.log(`[Seeds][admin] rest y=${SEED_REST_Y.toFixed(2)}`)
}

/** Log every live seed with its current world position. */
export function adminListSeeds(): void {
  console.log(`[Seeds][admin] ${seeds.size} live · seedSpawned listeners=${room.listenerCount('seedSpawned')}`)
  for (const s of seeds.values()) {
    const p = Transform.getOrNull(s.entity)?.position
    console.log(`  ${s.id} tier=${s.rarityTier} at (${p?.x.toFixed(1)}, ${p?.y.toFixed(1)}, ${p?.z.toFixed(1)}) drifting=${s.drifting}`)
  }
}

export function getSeedCount(): number { return seeds.size }

// ---------------------------------------------------------------
// Per-frame: fall, sway, bob, drift-to-player, collect
// ---------------------------------------------------------------

/** Hop directly away from the player (±jitter), clamped inside the garden. If every angle is
 *  boxed in by the bounds the seed gives up dodging, so a cornered seed is always catchable. */
function startHop(seed: Seed, sx: number, sz: number, px: number, pz: number, now: number): void {
  const away = Math.atan2(sz - pz, sx - px)
  const dist = seed.rarityTier >= 3 ? SEED_HOP_M_HIGH : SEED_HOP_M_LOW
  const m = 0.5
  for (const off of [0, 0.7, -0.7, 1.4, -1.4]) {
    const a = away + off + (Math.random() - 0.5) * 0.5
    const tx = Math.max(GARDEN_BOUNDS.xMin + m, Math.min(GARDEN_BOUNDS.xMax - m, sx + Math.cos(a) * dist))
    const tz = Math.max(GARDEN_BOUNDS.zMin + m, Math.min(GARDEN_BOUNDS.zMax - m, sz + Math.sin(a) * dist))
    if (Math.hypot(tx - sx, tz - sz) < 1.5) continue   // squeezed by the bounds — try another angle
    seed.hop = { fromX: sx, fromZ: sz, toX: tx, toZ: tz, startMs: now }
    seed.dodgesLeft--
    return
  }
  seed.dodgesLeft = 0   // cornered: let the player have it
}

function seedDriftSystem(dt: number): void {
  if (seeds.size === 0) return
  const now       = Date.now()
  const playerPos = Transform.getOrNull(engine.PlayerEntity)?.position

  for (const seed of [...seeds.values()]) {
    if (now >= seed.despawnAtMs) { despawnSeed(seed.id); continue }

    if (seed.trail !== null && now - seed.launchAt >= seed.flightMs) { engine.removeEntity(seed.trail); seed.trail = null }   // landed: comet tail off
    const t  = Transform.getMutable(seed.entity)
    const flown = now - seed.launchAt   // <0: still waiting inside the Bloom for its turn to launch
    // Tier motion — all in this one Transform write (no extra messages)
    const fx = seed.fx, tS = now / 1_000
    const tilt = fx.wobbleDeg * Math.sin(tS * 1.7 + seed.phase)
    t.rotation = Quaternion.fromEulerDegrees(tilt, (tS * fx.spinDegS + seed.phase * 57) % 360, 0)
    const k = seed.baseScale * (1 + (fx.throb ? fx.throb.amp * heartbeat(tS + seed.phase, fx.throb.periodS) : 0))
    t.scale = { x: k, y: k, z: k }

    if (flown < seed.flightMs && !seed.drifting) {
      // ── Flight: seeds burst OUT of the Bloom and arc to where they land (playtest
      // 2026-09-24: "the Bloom is dropping seeds but they just float into the scene").
      // Horizontal eases out, height is a straight fall plus an arc; rarer tiers still
      // spiral (fx.spiral) around their landing spot as they come in.
      const p = Math.max(0, flown / seed.flightMs)
      const ease = 1 - (1 - p) * (1 - p)
      const big = flown < 0 ? 0 : seed.baseScale * (SEED_FLIGHT_SCALE + (1 - SEED_FLIGHT_SCALE) * ease)   // hidden until it launches, big at launch, normal on landing
      t.scale = { x: big, y: big, z: big }
      t.position.y = seed.originY + (SEED_REST_Y - seed.originY) * p + SEED_ARC_H * 4 * p * (1 - p)
      const turns = Math.PI * 3 * fx.spiral, amp = SEED_SWAY_AMPL * fx.spiral * (1 - p)
      t.position.x = seed.originX + (seed.baseX - seed.originX) * ease + Math.sin(seed.phase + p * turns) * amp
      t.position.z = seed.originZ + (seed.baseZ - seed.originZ) * ease + Math.cos(seed.phase + p * turns) * amp
    } else if (seed.hop !== null) {
      // ── Hopping away from the player (see startHop) ──
      const h = seed.hop, p = Math.min(1, (now - h.startMs) / SEED_HOP_MS)
      const ease = 1 - (1 - p) * (1 - p)
      t.position.x = h.fromX + (h.toX - h.fromX) * ease
      t.position.z = h.fromZ + (h.toZ - h.fromZ) * ease
      t.position.y = SEED_REST_Y + SEED_HOP_ARC_H * 4 * p * (1 - p)
      if (p >= 1) { seed.baseX = h.toX; seed.baseZ = h.toZ; seed.hop = null; seed.hopReadyAt = now + SEED_HOP_COOLDOWN_MS }
    } else if (!seed.drifting) {
      // ── Landed: idle bob ──
      t.position.y = SEED_REST_Y + Math.abs(Math.sin(now / 1_000 * SEED_BOB_SPEED + seed.phase)) * fx.bob
    }

    if (!playerPos) continue

    const dx = playerPos.x - t.position.x
    const dz = playerPos.z - t.position.z
    const dist = Math.sqrt(dx * dx + dz * dz)                 // horizontal — starts the attraction
    const dy = (playerPos.y + CHEST_HEIGHT) - t.position.y
    const dist3 = Math.sqrt(dx * dx + dz * dz + dy * dy)      // 3D — a seed overhead is NOT reached yet

    if (dist3 < SEED_COLLECT_RADIUS) {
      // ── Reached the player in 3D — request the gather (server decides) ──
      // Local admin seeds don't exist server-side, so they self-collect on contact
      // instead of following the player forever (no toast, no pouch).
      if (seed.id.startsWith('local_')) {
        console.log(`[Seeds] local test seed collected: ${seed.id}`)
        despawnSeed(seed.id)
        continue
      }
      if (seed.gatherSentAt === 0 || now - seed.gatherSentAt > GATHER_RETRY_MS) {
        seed.gatherSentAt = now
        console.log(`[Seeds] Requesting gather: ${seed.id}`)
        room.send('gatherSeed', { seedId: seed.id })
      }
    } else if (seed.dodgesLeft > 0 && !seed.drifting && flown >= seed.flightMs && dist < SEED_DODGE_TRIGGER_M) {
      // ── Rare+ seed: don't be caught yet — hop away (mid-hop it just keeps going) ──
      if (seed.despawnAtMs - now <= SEED_NO_DODGE_LAST_MS) seed.dodgesLeft = 0   // about to evaporate: let it be caught
      else if (seed.hop === null && now >= seed.hopReadyAt) startHop(seed, t.position.x, t.position.z, playerPos.x, playerPos.z, now)
    } else if (seed.dodgesLeft === 0 && seed.hop === null && dist < SEED_GATHER_RADIUS) {
      // ── Walk-through magnetism: drift toward the player, faster as it closes ──
      seed.drifting = true
      const closeness = 1 - dist / SEED_GATHER_RADIUS   // 0 at leash edge → 1 touching
      const speed = DRIFT_SPEED_MIN + (DRIFT_SPEED_MAX - DRIFT_SPEED_MIN) * closeness
      const step = Math.min(speed * dt, dist)
      t.position.x += (dx / dist) * step
      t.position.z += (dz / dist) * step
      // Float up toward chest height while chasing — avatar origin is at the FEET,
      // so the target must be ABOVE playerPos.y or the seed burrows underground.
      t.position.y += ((playerPos.y + CHEST_HEIGHT) - t.position.y) * Math.min(dt * 6, 1)
    } else if (seed.drifting && dist > SEED_GATHER_RADIUS * 1.5) {
      // Player walked away — seed settles where it is and resumes bobbing
      seed.drifting = false
      seed.baseX = t.position.x
      seed.baseZ = t.position.z
    }
  }
}

// ---------------------------------------------------------------
// Setup — message handlers + system registration
// ---------------------------------------------------------------

export function setupSeedSystem(): void {
  room.onMessage('seedSpawned', (data) => {
    // First seed of a shower: the Bloom visibly shakes them loose, and a big centre-screen
    // line says what to do (Week-2 notes: "the Bloom-to-seed transition must be unmistakable").
    if (seeds.size === 0 && !seeds.has(data.id)) {
      triggerSparkle({ x: BLOOM_SEED_ORIGIN.x, y: BLOOM_SEED_ORIGIN.y, z: BLOOM_SEED_ORIGIN.z })
      showMoment('The Bloom is dropping seeds!', 'Chase them down and walk into them', 4_500)
    }
    spawnSeed(data)
  })

  // The bloom is over: seeds nobody caught are gone. Their own SEED_LIFETIME_MS (2 min)
  // outlives the bloom — the last trickle wave lands 1 min before the end — so without
  // this they kept floating over an already-reset, droopy garden (KJ 2026-09-20).
  room.onMessage('bloomReset', () => clearAllSeeds())

  room.onMessage('seedGathered', (data) => {
    // Sent to the gatherer only (per-player pickup); guard keeps a stray duplicate
    // from toasting twice.
    const existed = seeds.has(data.seedId)
    despawnSeed(data.seedId)
    if (!existed) return
    console.log(`[Seeds] gathered ${data.seedId} tier=${data.rarityTier}`)
    const localId = getPlayer()?.userId ?? ''
    if (localId && data.byAddress.toLowerCase() === localId.toLowerCase()) {
      // No emoji — the Unity client does not render them yet (PNG glyph in the FX pass)
      playSfx('seedCatch')
      // Every catch says what it was and where it went (KJ 2026-09-22 playtest 2: seeds
      // should read as coming from the bloom and piling up). pouchUpdate lands before
      // seedGathered on the wire, so the store already counts this one.
      const tierName = rarityTierById(data.rarityTier).name
      const total = getPouch().reduce((a, n) => a + n, 0)
      showToast(`Caught ${withArticle(tierName)} seed - ${total} in your pouch`, TOAST_GATHER_MS, false, rarityTierById(data.rarityTier).seedColor)
    }
  })

  engine.addSystem(seedDriftSystem)
  setupGoldenSeed()   // same post-room.clear() window
  console.log(`[Seeds] Seed system ready · seedSpawned listeners=${room.listenerCount('seedSpawned')}`)
}
