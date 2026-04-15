// =============================================================
// The Living Garden — Petal Particle System
//
// Phase state machine per petal — eliminates all mid-air
// disappearances and pop-in:
//
//   idle  ──► spawning ──► falling ──► grounded ──► shrinking
//              ▲                                        │
//              └──────── (relaunch if petalActive) ─────┘
//
// Rules:
//   • Petals materialise gently in-air (spawning: scale 0 → full).
//   • The ONLY exit from 'falling' is hitting the ground (y ≤ 0).
//     Petals never teleport or vanish while airborne.
//   • Grounded petals rest at full scale for PETAL_REST_MS.
//   • Shrinking petals fade out on the ground over PETAL_SHRINK_MS.
//   • After shrinking: auto-relaunch if petalActive, else go idle.
//   • startPetalSettle() cancels any petal still waiting to spawn,
//     lets every airborne petal land naturally, then idles them.
// =============================================================

import { engine, Entity, GltfContainer, Transform } from '@dcl/sdk/ecs'
import { BLOOM_CENTER } from './shared/config'

// ---------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------

const PETAL_COUNT = 20
const PETAL_SPAWN_RADIUS = 7
const PETAL_HEIGHT_MAX = 9      // max spawn height (m)
const PETAL_HEIGHT_MIN = 1      // min spawn height (m)
const PETAL_FALL_MIN = 0.4    // m/s
const PETAL_FALL_MAX = 1.0    // m/s
const PETAL_DRIFT_MAX = 0.3    // m/s max horizontal drift
const PETAL_SCALE = 1.5
const GROUND_HEIGHT = 0.3
const PETAL_SETTLE_TIME = 5000
/** Duration of the gentle scale-in at spawn (ms). */
const PETAL_SPAWN_MS = 600
/** Duration the petal rests on the ground at full scale (ms). */
const PETAL_REST_MS = 2_000
/** Duration of the ground shrink-out (ms). */
const PETAL_SHRINK_MS = 700

/** Max pre-spawn stagger on the very first rain call (all petals idle). */
const STAGGER_FIRST_MS = 2_000
/** Max pre-spawn stagger when relaunching during ongoing or burst rain. */
const STAGGER_BURST_MS = 500

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

type PetalPhase = 'idle' | 'spawning' | 'falling' | 'grounded' | 'shrinking'

interface PetalState {
  entity: Entity
  phase: PetalPhase
  pos: { x: number; y: number; z: number }
  vel: { x: number; y: number; z: number }
  rotY: number
  rotSpeed: number
  /** Elapsed ms in the current phase.  Negative = pre-spawn delay
   *  (petal is ready to enter 'spawning' but waiting for its stagger slot). */
  phaseMs: number
  targetFlip: number
}

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------

const petalPool: PetalState[] = []
let petalActive = false
let petalSettling = false
let time = 0
// ---------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------

function smoothstep(t: number): number {
  const c = Math.max(0, Math.min(1, t))
  return c * c * (3 - 2 * c)
}

/** Re-randomise a petal's position + velocity + rotation and set phase to
 *  'spawning'.  Caller must set phaseMs for stagger delay (negative = wait). */
function randomizePetal(p: PetalState): void {
  const angle = Math.random() * Math.PI * 2
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
  p.rotY = Math.random() * Math.PI * 2
  p.rotSpeed = (Math.random() - 0.5) * 4
  p.phase = 'spawning'
  p.phaseMs = 0   // caller overrides for stagger
p.targetFlip = 0
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/** Call once at scene startup.  Finds the 'Petal' scene entity, hides it,
 *  and fills the pool with cloned GltfContainer instances. */
export function setupPetalSystem(): void {
  const petalSource = engine.getEntityOrNullByName('Petal')
  if (!petalSource) {
    console.log('[Petals] Petal entity not found — particle system disabled')
    return
  }

  const gltf = GltfContainer.getOrNull(petalSource)
  const src = gltf?.src ?? ''

  Transform.getMutable(petalSource).scale = { x: 0, y: 0, z: 0 }

  for (let i = 0; i < PETAL_COUNT; i++) {
    const ent = engine.addEntity()
    GltfContainer.create(ent, { src })
    Transform.create(ent, {
      position: { x: 0, y: -10, z: 0 },
      scale: { x: 0, y: 0, z: 0 },
    })
    petalPool.push({
      entity: ent,
      phase: 'idle',
      pos: { x: 0, y: -10, z: 0 },
      vel: { x: 0, y: -1, z: 0 },
      rotY: 0,
      rotSpeed: 1,
      phaseMs: 0,
      targetFlip: 0
    })
  }

  console.log(`[Petals] Pool ready — ${PETAL_COUNT} instances from "${src}"`)
}

/** Start (or re-burst) the petal rain.
 *  Only idle petals are relaunched — petals in any active phase (spawning,
 *  falling, grounded, shrinking) are left undisturbed so they don't teleport.
 *  Active petals auto-relaunch themselves after their shrink cycle. */
export function startPetalRain(): void {
  const firstLaunch = !petalActive && !petalSettling
  petalSettling = false
  petalActive = true
  for (const p of petalPool) {
    if (p.phase !== 'idle') continue
    randomizePetal(p)
    p.phaseMs = -(Math.random() * (firstLaunch ? STAGGER_FIRST_MS : STAGGER_BURST_MS))
  }
}

/** Begin the settle phase — in-flight petals fall to the ground and fade away.
 *  Petals still in their pre-spawn delay are cancelled immediately. */
export function startPetalSettle(): void {
  petalActive = false
  petalSettling = true
}

/** ECS system — register once with engine.addSystem at scene startup. */
export function petalParticleSystem(dt: number): void {
  time += dt
  if (!petalActive && !petalSettling) return

  //const dtMs     = dt * 1_000
  const dtClamped = Math.min(dt, 0.05) // cap at 50ms
  const dtMs = dtClamped * 1_000
  let allSettled = true

  for (const p of petalPool) {
    const tf = Transform.getMutable(p.entity)

    // ── Idle — off-screen, not counted as unsettled ───────────────
    if (p.phase === 'idle') continue

    // ── Pre-spawn delay ───────────────────────────────────────────
    // Petal is 'spawning' but phaseMs < 0 = still waiting in the stagger queue.
  if (p.phase === 'spawning' && p.phaseMs < 0) {
  p.phaseMs += dtMs
  tf.scale    = { x: 0, y: 0, z: 0 }
  tf.position = { x: 0, y: -10, z: 0 }
  allSettled  = false
  continue
}

    // ── Spawning: gentle scale-in from 0 → PETAL_SCALE ───────────
    if (p.phase === 'spawning') {
      allSettled = false
      p.phaseMs += dtMs
      const t = Math.min(p.phaseMs / PETAL_SPAWN_MS, 1)
      const sc = PETAL_SCALE * smoothstep(t)
      const half = p.rotY * 0.5
      tf.position = { x: p.pos.x, y: p.pos.y, z: p.pos.z }
      tf.rotation = { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }
      tf.scale = { x: sc, y: sc, z: sc }
      if (p.phaseMs >= PETAL_SPAWN_MS) p.phase = 'falling'
      continue
    }

    // ── Falling: physics — ONLY exit is hitting the ground ────────
    if (p.phase === 'falling') {
      p.phaseMs += dtMs
      allSettled = false
      // height factor (1 = high, 0 = near ground)
const heightT = Math.max(0, Math.min(1, (p.pos.y - GROUND_HEIGHT) / PETAL_HEIGHT_MAX))

// slow down near ground (air drag)
const fallSpeed = p.vel.y * (0.4 + 0.6 * heightT)
      p.pos.x += p.vel.x * dtClamped
      p.pos.y += p.vel.y * dtClamped
      p.pos.z += p.vel.z * dtClamped
      // slow spin as it gets close to ground
const groundProximity = Math.max(0, Math.min(1, (p.pos.y - GROUND_HEIGHT) / 2))

const spin = p.rotSpeed * groundProximity

p.rotY += spin * dtClamped
const wobbleX = Math.sin(time * 2 + p.rotY) * 0.01
const wobbleZ = Math.cos(time * 1.5 + p.rotY) * 0.01

p.pos.x += wobbleX
p.pos.z += wobbleZ
      if (p.pos.y <= GROUND_HEIGHT) {
        // Land: freeze position on the floor and enter rest phase
        p.pos.y = GROUND_HEIGHT
        p.vel = { x: 0, y: 0, z: 0 }
        //p.rotSpeed = 0
        p.phase = 'grounded'
        p.phaseMs = 0
        p.phaseMs = -1000
       // p.rotY = p.targetFlip
      }

    //  const half = p.rotY * 0.5
      tf.position = { x: p.pos.x, y: p.pos.y, z: p.pos.z }
   //   tf.rotation = { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }
      tf.scale = { x: PETAL_SCALE, y: PETAL_SCALE, z: PETAL_SCALE }
      // how close to ground (0 = high, 1 = near ground)
// how long we've been falling (0 → 1 over time)
const fallT = Math.min(p.phaseMs / PETAL_SETTLE_TIME, 1)  // ← THIS controls speed



// slowly rotate to flat over time
//p.rotY += (0 - p.rotY) * 0.02
const halfY = p.rotY * 0.5

tf.rotation = {
  x: 0,
  y: Math.sin(halfY),
  z: 0,
  w: Math.cos(halfY)
}
      
      continue
    }

    // ── Grounded: rest on the floor at full scale ─────────────────
    if (p.phase === 'grounded') {
      allSettled = false
    p.phaseMs = Math.min(p.phaseMs + dtMs, PETAL_REST_MS)
      //  p.phaseMs += dtMs
      tf.position = { x: p.pos.x, y: GROUND_HEIGHT, z: p.pos.z }
      tf.scale = { x: PETAL_SCALE, y: PETAL_SCALE, z: PETAL_SCALE }
      // if we are basically settled, force perfect flat
if (p.phaseMs > 400) {
  p.rotY = 0

  tf.rotation = {
    x: 0,
    y: 0,
    z: 0,
    w: 1
  }

  continue
}
      if (p.phaseMs >= PETAL_REST_MS) {
        p.phase = 'shrinking'
        p.phaseMs = 0
      }
// keep easing toward final flat rotation
p.rotY += (p.targetFlip - p.rotY) * 0.05

// how far through settling we are (0 → 1)
const settleT = Math.min(Math.max(p.phaseMs / 500, 0), 1)

// tilt fades out completely as it settles
const tilt = Math.sin(p.rotY * 2) * 0.1 * (1 - settleT)

const halfY = p.rotY * 0.5

tf.rotation = {
  x: Math.sin(tilt * 0.5),
  y: Math.sin(halfY),
  z: Math.cos(tilt * 0.5),
  w: Math.cos(halfY)
}
      /*
      const halfY = p.rotY * 0.5
      
      tf.rotation = {
        x: 0,
        y: Math.sin(halfY),
        z: 0,
        w: Math.cos(halfY)
      }
      */
      continue
    }

    // ── Shrinking: fade out on the ground ────────────────────────
    if (p.phase === 'shrinking') {
      allSettled = false
    p.phaseMs = Math.min(p.phaseMs + dtMs, PETAL_SHRINK_MS)
    //  p.phaseMs += dtMs
      const t = Math.min(p.phaseMs / PETAL_SHRINK_MS, 1)
      // Ease-in curve: scale lingers at full size then melts away quickly
      const sc = PETAL_SCALE * (1 - t * t)
      tf.position = { x: p.pos.x, y: GROUND_HEIGHT, z: p.pos.z }
      tf.scale = { x: sc, y: sc, z: sc }

      if (p.phaseMs >= PETAL_SHRINK_MS) {
        tf.scale = { x: 0, y: 0, z: 0 }
        if (petalActive) {
          // Continuous rain — relaunch with a small burst stagger for variety
          randomizePetal(p)
          p.phaseMs = -(Math.random() * STAGGER_BURST_MS)
        } else {
          // Settling — go idle; don't block the allSettled check
          p.phase = 'idle'
          tf.position = { x: 0, y: -10, z: 0 }
        }
      }
      continue
    }
  }

  if (petalSettling && allSettled) {
    petalSettling = false
    console.log('[Petals] All settled')
  }
}
