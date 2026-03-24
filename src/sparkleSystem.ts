// =============================================================
// The Living Garden — Sparkle Burst System
// Emits a burst of magic sparkles from a plant when it
// finishes the DroopyToHealthy transition and enters HealthyState.
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
} from '@dcl/sdk/ecs'
import { Color4 } from '@dcl/sdk/math'

// ---------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------

const SPARKLE_SRC   = 'assets/scene/Images/sparkle.png'
const POOL_SIZE     = 80    // max active sparkles across all plants simultaneously
const BURST_COUNT   = 14    // sparkles emitted per plant per watering

const SPARKLE_SIZE  = 0.22  // world-space diameter at peak (metres)

// Speed range for the initial outward burst
const SPEED_MIN     = 1.8   // m/s
const SPEED_MAX     = 4.2   // m/s

// Gravity acceleration applied to sparkles (m/s²)
const GRAVITY       = 5.0

// Lifetime per sparkle — slight variation makes the burst feel organic
const LIFE_BASE_MS  = 550
const LIFE_VARY_MS  = 250

// Spawn offset above the plant base (metres)
const SPAWN_Y       = 0.6

// Scale curve breakpoints (fraction of total lifetime):
//   0 → POP_IN  : scale 0 → SPARKLE_SIZE
//   POP_IN → HOLD_END : hold at peak
//   HOLD_END → 1 : scale down to 0
const POP_IN   = 0.25
const HOLD_END = 0.55

// ---------------------------------------------------------------
// Pool state
// ---------------------------------------------------------------

interface SparkleState {
  entity:    Entity
  active:    boolean
  pos:       { x: number; y: number; z: number }
  vel:       { x: number; y: number; z: number }
  lifeMs:    number
  maxLifeMs: number
}

const pool: SparkleState[] = []

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/** Call once at scene startup — builds the pool and prepares all entities. */
export function setupSparkleSystem(): void {
  for (let i = 0; i < POOL_SIZE; i++) {
    const ent = engine.addEntity()

    MeshRenderer.setPlane(ent)

    Material.setPbrMaterial(ent, {
      texture:          Material.Texture.Common({ src: SPARKLE_SRC }),
      alphaTexture:     Material.Texture.Common({ src: SPARKLE_SRC }),
      albedoColor:      Color4.White(),
      emissiveColor:    { r: 1, g: 1, b: 1 },
      emissiveIntensity: 1.5,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    })

    Billboard.create(ent, { billboardMode: BillboardMode.BM_ALL })

    Transform.create(ent, {
      position: { x: 0, y: -100, z: 0 },
      scale:    { x: 0, y: 0, z: 0 },
    })

    pool.push({
      entity:    ent,
      active:    false,
      pos:       { x: 0, y: -100, z: 0 },
      vel:       { x: 0, y: 0,    z: 0 },
      lifeMs:    0,
      maxLifeMs: LIFE_BASE_MS,
    })
  }

  console.log(`[Sparkles] Pool ready — ${POOL_SIZE} instances`)
}

/** Emit a burst of sparkles centred on `pos` (world position of the plant). */
export function triggerSparkle(pos: { x: number; y: number; z: number }): void {
  let burst = 0
  for (const s of pool) {
    if (s.active) continue
    if (burst >= BURST_COUNT) break

    // Upper hemisphere burst — random azimuth, elevation 20°–90°
    const azimuth   = Math.random() * Math.PI * 2
    const elevation = (20 + Math.random() * 70) * (Math.PI / 180)
    const speed     = SPEED_MIN + Math.random() * (SPEED_MAX - SPEED_MIN)

    s.pos       = { x: pos.x, y: pos.y + SPAWN_Y, z: pos.z }
    s.vel       = {
      x: Math.cos(azimuth) * Math.cos(elevation) * speed,
      y: Math.sin(elevation) * speed,
      z: Math.sin(azimuth) * Math.cos(elevation) * speed,
    }
    s.lifeMs    = 0
    s.maxLifeMs = LIFE_BASE_MS + Math.random() * LIFE_VARY_MS
    s.active    = true
    burst++
  }
}

/** ECS system — register once with engine.addSystem. Idles when pool is empty. */
export function sparkleSystem(dt: number): void {
  for (const s of pool) {
    if (!s.active) continue

    const dtMs = dt * 1000
    s.lifeMs  += dtMs

    // Physics
    s.vel.y -= GRAVITY * dt
    s.pos.x += s.vel.x * dt
    s.pos.y += s.vel.y * dt
    s.pos.z += s.vel.z * dt

    // Scale curve
    const t  = Math.min(s.lifeMs / s.maxLifeMs, 1)
    let sc: number
    if (t < POP_IN) {
      // Ease-out pop in: fast at start, slows as it reaches peak
      const u = t / POP_IN
      sc = SPARKLE_SIZE * (1 - (1 - u) * (1 - u))
    } else if (t < HOLD_END) {
      sc = SPARKLE_SIZE
    } else {
      // Linear shrink to zero
      const u = (t - HOLD_END) / (1 - HOLD_END)
      sc = SPARKLE_SIZE * (1 - u)
    }

    const tf = Transform.getMutable(s.entity)
    tf.position = { x: s.pos.x, y: s.pos.y, z: s.pos.z }
    tf.scale    = { x: sc, y: sc, z: sc }

    if (s.lifeMs >= s.maxLifeMs) {
      s.active = false
      tf.scale = { x: 0, y: 0, z: 0 }
    }
  }
}
