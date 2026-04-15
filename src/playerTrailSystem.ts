// =============================================================
// The Living Garden — Player Sparkle Trail
//
// After the bloom event closes, every player in the scene leaves
// a gentle sparkle trail for TRAIL_DURATION_MS (10 min).
//
// Architecture mirrors the per-plant burst pool in sparkleSystem:
//   – Pre-allocated pool of Entity slots, no runtime alloc.
//   – A single ECS system (trailParticleSystem) ticks all slots.
//   – A gen-counter emit loop emits a wave every TRAIL_EMIT_INTERVAL.
//
// Public API:
//   setupPlayerTrailSystem()  — call once at scene startup
//   startPlayerTrail()        — call on bloomReset; auto-stops after 10 min
//   stopPlayerTrail()         — cancel immediately (particles finish naturally)
// =============================================================

import {
  engine,
  Entity,
  MeshRenderer,
  Material,
  MaterialTransparencyMode,
  Transform,
  Billboard,
  BillboardMode,
  PlayerIdentityData,
  timers,
} from '@dcl/sdk/ecs'
import { Color4 } from '@dcl/sdk/math'
import { SPARKLE_SRC } from './shared/config'

// ---------------------------------------------------------------
// Config  (tweak here — no magic numbers below)
// ---------------------------------------------------------------

/** Total duration of the trail effect after bloom closes (ms). */
const TRAIL_DURATION_MS   = 10 * 60_000

/** Interval between emit waves (ms). Lower = denser trail. */
const TRAIL_EMIT_INTERVAL = 350

/** Sparkles emitted per player per wave. */
const TRAIL_SPARKLES_PP   = 2

/** Pre-allocated pool.  Covers ~10 players × sparkles in flight.
 *  In-flight count ≈ players × TRAIL_SPARKLES_PP × (TRAIL_LIFE_MS / TRAIL_EMIT_INTERVAL)
 *  = 10 × 2 × (1050/350) = 60 → 80 gives comfortable headroom. */
const TRAIL_POOL_SIZE     = 100

/** World-space sparkle diameter at peak (m). */
const TRAIL_SPARKLE_SIZE  = 0.25

/** Sparkle base lifetime (ms). */
const TRAIL_LIFE_MS       = 1_500
const TRAIL_LIFE_VARY_MS  = 200

/** Spawn Y offset above the player entity pivot (foot level ≈ 0.1 m). */
const TRAIL_SPAWN_Y       = 0.8

/** Gentle upward drift speed (m/s). */
const TRAIL_DRIFT_Y       = 0.4

/** Maximum horizontal jitter radius (m). */
const TRAIL_JITTER_R      = 0.5

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

interface TrailSlot {
  entity:    Entity
  active:    boolean
  pos:       { x: number; y: number; z: number }
  vel:       { x: number; y: number; z: number }
  lifeMs:    number
  maxLifeMs: number
}

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------

let trailPool:        TrailSlot[] = []
let trailGen                      = 0
let trailSystemAdded              = false

// ---------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------

function makeTrailSparkle(): Entity {
  const ent = engine.addEntity()
  MeshRenderer.setPlane(ent)
  Material.setPbrMaterial(ent, {
    texture:           Material.Texture.Common({ src: SPARKLE_SRC }),
    alphaTexture:      Material.Texture.Common({ src: SPARKLE_SRC }),
    albedoColor:       Color4.create(1.0, 0.95, 0.78, 1),  // warm cream — matches plant sparkles
    emissiveColor:     { r: 1.0, g: 0.88, b: 0.52 },       // warm gold
    emissiveIntensity: 2.0,                                  // slightly brighter than burst sparkles
    transparencyMode:  MaterialTransparencyMode.MTM_ALPHA_BLEND,
  })
  Billboard.create(ent, { billboardMode: BillboardMode.BM_ALL })
  Transform.create(ent, {
    position: { x: 0, y: -100, z: 0 },
    scale:    { x: 0.001, y: 0.001, z: 0.001 },
  })
  return ent
}

function claimSlot(): TrailSlot | null {
  for (const s of trailPool) {
    if (!s.active) return s
  }
  return null   // pool exhausted — silently skip (no alloc, no error)
}

function emitAtPos(pos: { x: number; y: number; z: number }): void {
  for (let i = 0; i < TRAIL_SPARKLES_PP; i++) {
    const s = claimSlot()
    if (!s) return
    const angle = Math.random() * Math.PI * 2
    s.active    = true
    s.lifeMs    = 0
    s.maxLifeMs = TRAIL_LIFE_MS + Math.random() * TRAIL_LIFE_VARY_MS
    s.pos       = {
      x: pos.x + Math.cos(angle) * Math.random() * TRAIL_JITTER_R,
      y: pos.y + TRAIL_SPAWN_Y,
      z: pos.z + Math.sin(angle) * Math.random() * TRAIL_JITTER_R,
    }
    s.vel = {
      x: (Math.random() - 0.5) * 0.2,
      y: TRAIL_DRIFT_Y + Math.random() * 0.2,
      z: (Math.random() - 0.5) * 0.2,
    }
    Transform.getMutable(s.entity).position = { ...s.pos }
  }
}

// ---------------------------------------------------------------
// ECS system — ticks every frame; runs even when trail is inactive
// (idle loop cost is negligible: one if-check per slot)
// ---------------------------------------------------------------

function trailParticleSystem(dt: number): void {
  for (const s of trailPool) {
    if (!s.active) continue

    s.lifeMs += dt * 1_000
    s.pos.x  += s.vel.x * dt
    s.pos.y  += s.vel.y * dt
    s.pos.z  += s.vel.z * dt

    const tf = Transform.getMutable(s.entity)

    if (s.lifeMs >= s.maxLifeMs) {
      s.active    = false
      tf.scale    = { x: 0.001, y: 0.001, z: 0.001 }
      tf.position = { x: 0, y: -100, z: 0 }
      continue
    }

    // Scale curve: pop in over first 20%, hold through 60%, fade to end
    const t = s.lifeMs / s.maxLifeMs
    let sc: number
    if (t < 0.2) {
      sc = TRAIL_SPARKLE_SIZE * (t / 0.2)
    } else if (t < 0.6) {
      sc = TRAIL_SPARKLE_SIZE
    } else {
      sc = TRAIL_SPARKLE_SIZE * (1 - (t - 0.6) / 0.4)
    }

    tf.position = { x: s.pos.x, y: s.pos.y, z: s.pos.z }
    tf.scale    = { x: sc, y: sc, z: sc }
  }
}

// ---------------------------------------------------------------
// Emit loop — recursive timer, cancelled via gen-counter
// ---------------------------------------------------------------

function emitWave(gen: number): void {
  if (trailGen !== gen) return

  // Local player
  const localPos = Transform.getOrNull(engine.PlayerEntity)?.position
  if (localPos) emitAtPos(localPos)

  // Remote players (PlayerIdentityData covers all connected avatars;
  // skip engine.PlayerEntity to avoid double-emitting for the local avatar)
  for (const [entity] of engine.getEntitiesWith(PlayerIdentityData)) {
    if (entity === engine.PlayerEntity) continue
    const pos = Transform.getOrNull(entity)?.position
    if (pos) emitAtPos(pos)
  }

  timers.setTimeout(() => emitWave(gen), TRAIL_EMIT_INTERVAL)
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Allocate the sparkle pool and register the ECS system.
 * Call exactly once at scene startup — idempotent on subsequent calls.
 */
export function setupPlayerTrailSystem(): void {
  if (trailSystemAdded) return
  trailSystemAdded = true

  for (let i = 0; i < TRAIL_POOL_SIZE; i++) {
    trailPool.push({
      entity:    makeTrailSparkle(),
      active:    false,
      pos:       { x: 0, y: 0, z: 0 },
      vel:       { x: 0, y: 0, z: 0 },
      lifeMs:    0,
      maxLifeMs: 0,
    })
  }

  engine.addSystem(trailParticleSystem)
  console.log(`[PlayerTrail] Setup complete — pool: ${TRAIL_POOL_SIZE}`)
}

/**
 * Start the post-bloom sparkle trail for all players.
 * Bumping the gen-counter makes it safe to call again mid-run
 * (e.g. a second bloom in the same session): the old loop stops
 * immediately, in-flight particles finish their lifecycle, and
 * a fresh 10-minute window starts.
 * Auto-stops after TRAIL_DURATION_MS.
 */
export function startPlayerTrail(): void {
  const gen = ++trailGen
  emitWave(gen)
  timers.setTimeout(() => {
    if (trailGen === gen) stopPlayerTrail()
  }, TRAIL_DURATION_MS)
  console.log('[PlayerTrail] Started — 10 min trail active')
}

/**
 * Cancel the emit loop immediately.
 * Any sparkles already in flight finish their lifecycle naturally —
 * the pool just stops being replenished.
 */
export function stopPlayerTrail(): void {
  trailGen++
  console.log('[PlayerTrail] Stopped')
}
