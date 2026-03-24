// =============================================================
// The Living Garden — Sparkle System
//
// Two independent particle effects using the same sparkle.png:
//
//   Per-plant burst  — fires when a plant transitions to HealthyState
//   Bloom orbit      — fires at visual bloom; sparkles burst from each
//                      plant, travel to the garden centre, orbit and
//                      bob, then rise and dissolve when bloom ends
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

const SPARKLE_SRC = 'assets/scene/Images/sparkle.png'

// ---------------------------------------------------------------
// Shared helper — create one sparkle entity (plane + material)
// ---------------------------------------------------------------

function makeSparkleEntity(emissiveIntensity: number): Entity {
  const ent = engine.addEntity()
  MeshRenderer.setPlane(ent)
  Material.setPbrMaterial(ent, {
    texture:           Material.Texture.Common({ src: SPARKLE_SRC }),
    alphaTexture:      Material.Texture.Common({ src: SPARKLE_SRC }),
    albedoColor:       Color4.White(),
    emissiveColor:     { r: 1, g: 1, b: 1 },
    emissiveIntensity,
    transparencyMode:  MaterialTransparencyMode.MTM_ALPHA_BLEND,
  })
  Billboard.create(ent, { billboardMode: BillboardMode.BM_ALL })
  Transform.create(ent, {
    position: { x: 0, y: -100, z: 0 },
    scale:    { x: 0,  y: 0,   z: 0 },
  })
  return ent
}

// =============================================================
// SECTION 1 — Per-plant burst
// =============================================================

const POOL_SIZE    = 80    // max active sparkles across all plants
const BURST_COUNT  = 14    // sparkles per plant per watering
const SPARKLE_SIZE = 0.22  // world-space diameter at peak (m)
const SPEED_MIN    = 1.8   // m/s
const SPEED_MAX    = 4.2   // m/s
const GRAVITY      = 5.0   // m/s²
const LIFE_BASE_MS = 550
const LIFE_VARY_MS = 250
const SPAWN_Y      = 0.6   // metres above plant base
// Scale curve breakpoints (0–1 fraction of lifetime)
const POP_IN   = 0.25
const HOLD_END = 0.55

interface SparkleState {
  entity:    Entity
  active:    boolean
  pos:       { x: number; y: number; z: number }
  vel:       { x: number; y: number; z: number }
  lifeMs:    number
  maxLifeMs: number
}

const pool: SparkleState[] = []

/** Call once at scene startup — builds both pools. */
export function setupSparkleSystem(): void {
  // Per-plant burst pool
  for (let i = 0; i < POOL_SIZE; i++) {
    const ent = makeSparkleEntity(1.5)
    pool.push({
      entity:    ent,
      active:    false,
      pos:       { x: 0, y: -100, z: 0 },
      vel:       { x: 0, y: 0,    z: 0 },
      lifeMs:    0,
      maxLifeMs: LIFE_BASE_MS,
    })
  }

  // Bloom orbit pool
  for (let i = 0; i < BLOOM_POOL_SIZE; i++) {
    const ent = makeSparkleEntity(2.0)
    bloomPool.push({
      entity:       ent,
      phase:        'idle',
      startPos:     { x: 0, y: -100, z: 0 },
      travelTarget: { x: 0, y: 0,    z: 0 },
      travelMs:     0,
      travelDurMs:  TRAVEL_DUR_BASE,
      orbitAngle:   0,
      orbitSpeed:   0,
      orbitRadius:  1.5,
      orbitBaseY:   1.5,
      bobPhase:     0,
      bobSpeed:     1.5,
      bobAmp:       0.2,
      riseMs:       0,
      riseDelay:    0,
      riseDurMs:    RISE_DUR_MS,
      riseStartPos: { x: 0, y: 0, z: 0 },
      pos:          { x: 0, y: -100, z: 0 },
      scale:        0,
    })
  }

  console.log(`[Sparkles] Per-plant pool: ${POOL_SIZE}, Bloom pool: ${BLOOM_POOL_SIZE}`)
}

/** Emit a burst of sparkles centred on `pos` (world position of the plant). */
export function triggerSparkle(pos: { x: number; y: number; z: number }): void {
  let burst = 0
  for (const s of pool) {
    if (s.active) continue
    if (burst >= BURST_COUNT) break

    const azimuth   = Math.random() * Math.PI * 2
    const elevation = (20 + Math.random() * 70) * (Math.PI / 180)
    const speed     = SPEED_MIN + Math.random() * (SPEED_MAX - SPEED_MIN)

    s.pos       = { x: pos.x, y: pos.y + SPAWN_Y, z: pos.z }
    s.vel       = {
      x: Math.cos(azimuth) * Math.cos(elevation) * speed,
      y: Math.sin(elevation) * speed,
      z: Math.sin(azimuth)  * Math.cos(elevation) * speed,
    }
    s.lifeMs    = 0
    s.maxLifeMs = LIFE_BASE_MS + Math.random() * LIFE_VARY_MS
    s.active    = true
    burst++
  }
}

/** ECS system for per-plant bursts — register once with engine.addSystem. */
export function sparkleSystem(dt: number): void {
  for (const s of pool) {
    if (!s.active) continue

    const dtMs = dt * 1000
    s.lifeMs  += dtMs

    s.vel.y -= GRAVITY * dt
    s.pos.x += s.vel.x * dt
    s.pos.y += s.vel.y * dt
    s.pos.z += s.vel.z * dt

    const t = Math.min(s.lifeMs / s.maxLifeMs, 1)
    let sc: number
    if (t < POP_IN) {
      const u = t / POP_IN
      sc = SPARKLE_SIZE * (1 - (1 - u) * (1 - u))
    } else if (t < HOLD_END) {
      sc = SPARKLE_SIZE
    } else {
      sc = SPARKLE_SIZE * (1 - (t - HOLD_END) / (1 - HOLD_END))
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

// =============================================================
// SECTION 2 — Bloom orbit sparkles
// =============================================================

// Bloom model world position
const BLOOM_CENTER_X = 8
const BLOOM_CENTER_Z = 24

const BLOOM_POOL_SIZE    = 72   // 6 plants × 12 sparkles
const BLOOM_BURST_COUNT  = 12   // sparkles per plant at bloom
const BLOOM_SPARKLE_SIZE = 0.28

// Travel from plant to orbit entry point
const TRAVEL_DUR_BASE  = 1_600  // ms base travel duration
const TRAVEL_DUR_VARY  = 600    // ms random variation

// Orbit parameters
const ORBIT_RADIUS_MIN = 1.0    // m
const ORBIT_RADIUS_MAX = 2.8    // m
const ORBIT_Y_MIN      = 3.0    // m — orbits around Bloom model at y=4
const ORBIT_Y_MAX      = 5.5    // m
const ORBIT_SPEED_MIN  = 0.3    // rad/s
const ORBIT_SPEED_MAX  = 0.75   // rad/s

// Bob parameters
const BOB_AMP_MIN   = 0.1       // m
const BOB_AMP_MAX   = 0.3       // m
const BOB_SPEED_MIN = 1.0       // rad/s
const BOB_SPEED_MAX = 2.2       // rad/s

// Rise-and-dissolve when bloom ends
const RISE_DUR_MS      = 2_800  // ms for rise fade
const RISE_HEIGHT      = 1.5    // m of vertical travel while rising
const RISE_DELAY_MAX   = 2_000  // ms max stagger between sparkles

type BloomPhase = 'idle' | 'travel' | 'orbit' | 'rise'

interface BloomSparkleState {
  entity:       Entity
  phase:        BloomPhase
  // Travel
  startPos:     { x: number; y: number; z: number }
  travelTarget: { x: number; y: number; z: number }
  travelMs:     number
  travelDurMs:  number
  // Orbit
  orbitAngle:   number   // radians — also the entry angle used at travel end
  orbitSpeed:   number   // rad/s (positive = CCW, negative = CW)
  orbitRadius:  number   // m
  orbitBaseY:   number   // m
  bobPhase:     number   // radians
  bobSpeed:     number   // rad/s
  bobAmp:       number   // m
  // Rise
  riseMs:       number   // elapsed since endBloomSparkles (includes delay)
  riseDelay:    number   // ms before this sparkle starts rising (stagger)
  riseDurMs:    number
  riseStartPos: { x: number; y: number; z: number }
  // Render
  pos:          { x: number; y: number; z: number }   // current world position
  scale:        number
}

const bloomPool: BloomSparkleState[] = []

/** Smoothstep easing (0→1). */
function smoothstep(t: number): number {
  const c = Math.max(0, Math.min(1, t))
  return c * c * (3 - 2 * c)
}

/**
 * Trigger bloom sparkles — call exactly when the visual bloom launches
 * (i.e. from the onVisualBloom callback, 3 s after triggerBloomEvent).
 * Each plant position gets BLOOM_BURST_COUNT sparkles.
 */
export function triggerBloomSparkles(
  plantPositions: Array<{ x: number; y: number; z: number }>,
): void {
  let poolIdx = 0

  for (const plantPos of plantPositions) {
    for (let b = 0; b < BLOOM_BURST_COUNT; b++) {
      // Find next idle slot
      while (poolIdx < bloomPool.length && bloomPool[poolIdx].phase !== 'idle') poolIdx++
      if (poolIdx >= bloomPool.length) break

      const s = bloomPool[poolIdx++]

      // Orbit params — assigned now so travelTarget can use them
      s.orbitRadius = ORBIT_RADIUS_MIN + Math.random() * (ORBIT_RADIUS_MAX - ORBIT_RADIUS_MIN)
      s.orbitBaseY  = ORBIT_Y_MIN      + Math.random() * (ORBIT_Y_MAX      - ORBIT_Y_MIN)
      s.orbitAngle  = Math.random() * Math.PI * 2
      s.orbitSpeed  = (ORBIT_SPEED_MIN + Math.random() * (ORBIT_SPEED_MAX - ORBIT_SPEED_MIN))
                      * (Math.random() < 0.5 ? 1 : -1)
      s.bobPhase    = Math.random() * Math.PI * 2
      s.bobSpeed    = BOB_SPEED_MIN + Math.random() * (BOB_SPEED_MAX - BOB_SPEED_MIN)
      s.bobAmp      = BOB_AMP_MIN   + Math.random() * (BOB_AMP_MAX   - BOB_AMP_MIN)

      // Orbit entry point (where travel ends)
      s.travelTarget = {
        x: BLOOM_CENTER_X + Math.cos(s.orbitAngle) * s.orbitRadius,
        y: s.orbitBaseY,
        z: BLOOM_CENTER_Z + Math.sin(s.orbitAngle) * s.orbitRadius,
      }

      // Burst start — slight random offset from plant so they look ejected
      const burstA = Math.random() * Math.PI * 2
      const burstR = 0.1 + Math.random() * 0.25
      s.startPos = {
        x: plantPos.x + Math.cos(burstA) * burstR,
        y: plantPos.y + 0.3 + Math.random() * 0.5,
        z: plantPos.z + Math.sin(burstA) * burstR,
      }

      // Stagger travel start with a small delay so burst feels organic
      s.travelMs    = -(Math.random() * 300)   // negative = delay before moving
      s.travelDurMs = TRAVEL_DUR_BASE + Math.random() * TRAVEL_DUR_VARY

      s.riseMs      = 0
      s.riseDelay   = 0
      s.riseDurMs   = RISE_DUR_MS
      s.scale       = 0
      s.phase       = 'travel'

      // Park off-screen until travel delay expires
      Transform.getMutable(s.entity).scale = { x: 0, y: 0, z: 0 }
    }
  }

  console.log(`[Sparkles] Bloom wave started for ${plantPositions.length} plants`)
}

/**
 * Begin rise-and-dissolve for all orbiting bloom sparkles.
 * Call from resetAllPlants (i.e. when bloom ends).
 */
export function endBloomSparkles(): void {
  for (const s of bloomPool) {
    if (s.phase === 'idle') continue
    s.riseStartPos = { ...s.pos }
    s.riseMs       = 0
    s.riseDelay    = Math.random() * RISE_DELAY_MAX
    s.riseDurMs    = RISE_DUR_MS
    s.phase        = 'rise'
  }
  console.log('[Sparkles] Bloom sparkles entering rise phase')
}

/** ECS system for bloom orbit sparkles — register once with engine.addSystem. */
export function bloomSparkleSystem(dt: number): void {
  const dtMs = dt * 1000

  for (const s of bloomPool) {
    if (s.phase === 'idle') continue

    const tf = Transform.getMutable(s.entity)

    // ── Travel phase ───────────────────────────────────────────────
    if (s.phase === 'travel') {
      s.travelMs += dtMs

      if (s.travelMs < 0) {
        // Pre-travel delay — keep hidden
        tf.scale = { x: 0, y: 0, z: 0 }
        continue
      }

      const rawT = Math.min(s.travelMs / s.travelDurMs, 1)
      const t    = smoothstep(rawT)

      // Lerp position with a gentle vertical arc (sin arch above the straight line)
      const arc = Math.sin(rawT * Math.PI) * 0.6   // peaks in the middle
      const x   = s.startPos.x + (s.travelTarget.x - s.startPos.x) * t
      const y   = s.startPos.y + (s.travelTarget.y - s.startPos.y) * t + arc
      const z   = s.startPos.z + (s.travelTarget.z - s.startPos.z) * t
      s.scale   = BLOOM_SPARKLE_SIZE * Math.min(rawT / 0.25, 1)  // pop in over first 25%

      s.pos       = { x, y, z }
      tf.position = { x, y, z }
      tf.scale    = { x: s.scale, y: s.scale, z: s.scale }

      if (rawT >= 1) {
        s.phase    = 'orbit'
        s.bobPhase = Math.random() * Math.PI * 2   // randomise bob start
      }
      continue
    }

    // ── Orbit phase ────────────────────────────────────────────────
    if (s.phase === 'orbit') {
      s.orbitAngle += s.orbitSpeed * dt
      s.bobPhase   += s.bobSpeed   * dt

      const x = BLOOM_CENTER_X + Math.cos(s.orbitAngle) * s.orbitRadius
      const y = s.orbitBaseY   + Math.sin(s.bobPhase)   * s.bobAmp
      const z = BLOOM_CENTER_Z + Math.sin(s.orbitAngle) * s.orbitRadius
      s.scale = BLOOM_SPARKLE_SIZE
      s.pos   = { x, y, z }

      tf.position = { x, y, z }
      tf.scale    = { x: s.scale, y: s.scale, z: s.scale }
      continue
    }

    // ── Rise phase ─────────────────────────────────────────────────
    if (s.phase === 'rise') {
      s.riseMs += dtMs

      if (s.riseMs < s.riseDelay) continue   // hold — waiting for stagger offset

      const riseElapsed = s.riseMs - s.riseDelay
      const riseT       = Math.min(riseElapsed / s.riseDurMs, 1)

      const y  = s.riseStartPos.y + riseT * RISE_HEIGHT
      const fade = 1 - riseT
      s.scale  = BLOOM_SPARKLE_SIZE * fade * fade * fade  // cubic — lingers then melts

      tf.position = { x: s.riseStartPos.x, y, z: s.riseStartPos.z }
      tf.scale    = { x: s.scale, y: s.scale, z: s.scale }

      if (riseT >= 1) {
        s.phase  = 'idle'
        tf.scale = { x: 0, y: 0, z: 0 }
      }
    }
  }
}
