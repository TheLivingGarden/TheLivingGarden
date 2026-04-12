// =============================================================
// The Living Garden — Petal Particle System
// =============================================================

import { engine, Entity, GltfContainer, Transform } from '@dcl/sdk/ecs'
import { BLOOM_CENTER } from './shared/config'

// ---------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------

const PETAL_COUNT        = 20
const PETAL_SPAWN_RADIUS = 7
const PETAL_HEIGHT_MAX   = 9      // max spawn height (m)
const PETAL_HEIGHT_MIN   = 1      // min spawn height (m)
const PETAL_FALL_MIN     = 0.4    // m/s min fall speed
const PETAL_FALL_MAX     = 1.0    // m/s max fall speed
const PETAL_DRIFT_MAX    = 0.3    // m/s max horizontal drift
const PETAL_LIFE_MIN_MS  = 3_000
const PETAL_LIFE_MAX_MS  = 7_000
const PETAL_SCALE        = 1.5
const PETAL_REST_MS      = 2_000  // time resting on ground before shrinking
const PETAL_SHRINK_MS    = 600    // duration of scale-to-zero shrink

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------

interface PetalState {
  entity:      Entity
  pos:         { x: number; y: number; z: number }
  vel:         { x: number; y: number; z: number }
  rotY:        number
  rotSpeed:    number
  lifetime:    number   // ms remaining
  maxLifetime: number   // ms total
  grounded:    boolean  // true once petal has landed during settle
  groundedMs:  number   // ms since landing
}

const petalPool:    PetalState[] = []
let   petalActive   = false
let   petalSettling = false

// ---------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------

function randomizePetal(p: PetalState) {
  const angle  = Math.random() * Math.PI * 2
  const radius = Math.random() * PETAL_SPAWN_RADIUS
  p.pos = {
    x: BLOOM_CENTER.x + Math.cos(angle) * radius,
    y: PETAL_HEIGHT_MIN + Math.random() * (PETAL_HEIGHT_MAX - PETAL_HEIGHT_MIN),
    z: BLOOM_CENTER.z + Math.sin(angle) * radius,
  }
  p.vel = {
    x: (Math.random() - 0.5) * PETAL_DRIFT_MAX * 2,
    y: -(PETAL_FALL_MIN + Math.random() * (PETAL_FALL_MAX - PETAL_FALL_MIN)),
    z: (Math.random() - 0.5) * PETAL_DRIFT_MAX * 2,
  }
  p.rotY        = Math.random() * Math.PI * 2
  p.rotSpeed    = (Math.random() - 0.5) * 4
  p.maxLifetime = PETAL_LIFE_MIN_MS + Math.random() * (PETAL_LIFE_MAX_MS - PETAL_LIFE_MIN_MS)
  p.lifetime    = p.maxLifetime
  p.grounded    = false
  p.groundedMs  = 0
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/** Call once at scene startup — finds the 'Petal' scene entity, hides it,
 *  and fills the pool with pooled GltfContainer instances ready for bloom. */
export function setupPetalSystem(): void {
  const petalSource = engine.getEntityOrNullByName('Petal')
  if (!petalSource) {
    console.log('[Petals] Petal entity not found — particle system disabled')
    return
  }

  const gltf = GltfContainer.getOrNull(petalSource)
  const src  = gltf?.src ?? ''

  // Hide the original scene entity
  Transform.getMutable(petalSource).scale = { x: 0, y: 0, z: 0 }

  for (let i = 0; i < PETAL_COUNT; i++) {
    const ent = engine.addEntity()
    GltfContainer.create(ent, { src })
    Transform.create(ent, {
      position: { x: 0, y: -10, z: 0 },
      scale:    { x: 0, y: 0, z: 0 },     // hidden until bloom
    })
    petalPool.push({
      entity:      ent,
      pos:         { x: 0, y: -10, z: 0 },
      vel:         { x: 0, y: -1,  z: 0 },
      rotY:        0,
      rotSpeed:    1,
      lifetime:    0,
      maxLifetime: PETAL_LIFE_MAX_MS,
      grounded:    false,
      groundedMs:  0,
    })
  }

  console.log(`[Petals] Pool ready — ${PETAL_COUNT} instances from "${src}"`)
}

/** Start the petal rain (call when bloom triggers).
 *  Safe to call while petals are already falling — in-flight petals are
 *  left alone so they don't teleport. Only parked or grounded petals are
 *  relaunched, giving each call an additive burst rather than a hard reset. */
export function startPetalRain(): void {
  const wasActive = petalActive
  petalSettling   = false
  petalActive     = true
  for (const p of petalPool) {
    // Leave airborne petals alone — they'll continue falling naturally
    if (wasActive && !p.grounded && p.pos.y > 0) continue
    randomizePetal(p)
    p.lifetime = Math.random() * p.maxLifetime   // stagger so they don't all spawn at once
    const t = Transform.getMutable(p.entity)
    t.scale = { x: PETAL_SCALE, y: PETAL_SCALE, z: PETAL_SCALE }
  }
}

/** Begin the settle phase — petals fall to the ground and fade away (call on bloom reset). */
export function startPetalSettle(): void {
  petalActive   = false
  petalSettling = true
}

/** ECS system — register with engine.addSystem once at startup. */
export function petalParticleSystem(dt: number): void {
  if (!petalActive && !petalSettling) return

  const dtMs      = dt * 1000
  let   allSettled = true

  for (const p of petalPool) {
    const t = Transform.getMutable(p.entity)

    // ── Grounded phase (settling only) ───────────────────────────
    if (p.grounded) {
      p.groundedMs += dtMs

      if (p.groundedMs >= PETAL_REST_MS + PETAL_SHRINK_MS) {
        // Fully gone
        t.scale = { x: 0, y: 0, z: 0 }
      } else if (p.groundedMs >= PETAL_REST_MS) {
        // Shrinking — ease out so the last moment lingers
        const progress = (p.groundedMs - PETAL_REST_MS) / PETAL_SHRINK_MS
        const s = PETAL_SCALE * (1 - progress * progress)
        t.scale = { x: s, y: s, z: s }
        allSettled = false
      } else {
        // Resting on the ground — still visible
        allSettled = false
      }
      continue
    }

    // ── In-air phase ─────────────────────────────────────────────
    allSettled  = false
    p.pos.x    += p.vel.x * dt
    p.pos.y    += p.vel.y * dt
    p.pos.z    += p.vel.z * dt
    p.rotY     += p.rotSpeed * dt
    p.lifetime -= dtMs

    if (p.pos.y < 0) {
      if (petalActive) {
        // Normal rain: respawn above the garden
        randomizePetal(p)
      } else {
        // Settling: land on the floor and begin the rest timer
        p.pos.y      = 0
        p.vel        = { x: 0, y: 0, z: 0 }
        p.rotSpeed   = 0
        p.grounded   = true
        p.groundedMs = 0
      }
    } else if (petalActive && p.lifetime <= 0) {
      // Lifetime expired mid-air during normal rain — respawn
      randomizePetal(p)
    }

    // Apply to renderer — rotation as Y-axis quaternion
    const half = p.rotY * 0.5
    t.position = { x: p.pos.x, y: p.pos.y, z: p.pos.z }
    t.rotation = { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }
    t.scale    = { x: PETAL_SCALE, y: PETAL_SCALE, z: PETAL_SCALE }
  }

  // Once every petal has shrunk away, idle the system
  if (petalSettling && allSettled) {
    petalSettling = false
    console.log('[Petals] all settled')
  }
}
