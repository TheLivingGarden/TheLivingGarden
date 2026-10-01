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
  ParticleSystem,
  timers,
} from '@dcl/sdk/ecs'
import { Color4, Quaternion } from '@dcl/sdk/math'
import { BLOOM_CENTER, SPARKLE_SRC } from './shared/config'
import { fx } from './perfTier'

const BLOOM_PLANTS = 6   // plants that burst sparkles at bloom (the pool is this many x BLOOM_BURST_COUNT)

// ---------------------------------------------------------------
// Shared helper — create one sparkle entity (plane + material)
// ---------------------------------------------------------------

function makeSparkleEntity(emissiveIntensity: number): Entity {
  const ent = engine.addEntity()
  MeshRenderer.setPlane(ent)
  Material.setPbrMaterial(ent, {
    texture:          Material.Texture.Common({ src: SPARKLE_SRC }),
    alphaTexture:     Material.Texture.Common({ src: SPARKLE_SRC }),
    albedoColor:      Color4.create(1.0, 0.95, 0.78, 1),  // warm cream
    emissiveColor:    { r: 1.0, g: 0.88, b: 0.52 },       // warm gold
    emissiveIntensity,
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    castShadows:      false,
  })
  // No Billboard while parked: the explorer rotates EVERY billboard entity toward the camera
  // each frame, hidden or not (BillboardSystem.UpdateRotation) — see wake()/park().
  Transform.create(ent, {
    position: { x: 0, y: -100, z: 0 },
    scale:    { x: 0.001, y: 0.001, z: 0.001 },
  })
  return ent
}

/** Dev A/B switches for the per-watering effects (test panel). Runtime only; production keeps all on. */
export const waterFxFlags = { ripple: true, burst: true, tribute: true }

// =============================================================
// SECTION 1 — Per-plant burst
// A renderer-side ParticleSystem per watering (was a 16-entity pool moved by this script
// every frame for 1.5 s). A fresh emitter per burst: re-sending an identical component
// isn't a reliable "play again" signal, and one entity per watering is nothing.
// =============================================================

const BURST_COUNT = () => fx(4, 3)    // sparkles per watering — few and big (KJ 2026-09-19: "too small and heavy")
const BURST_EMIT_MS   = 120  // emit window — maxParticles caps it at BURST_COUNT()
const SPARKLE_SIZE = () => fx(0.5, 0.55)  // world-space diameter at peak (m)
const SPEED_MIN       = 1.8  // m/s
const SPEED_MAX       = 4.2  // m/s
const GRAVITY_MOD     = 0.5  // × 9.81 m/s² (was 5 m/s²)
const LIFE_S          = 1.6
const SPAWN_Y         = 2    // metres above plant base
const CONE_HALF_ANGLE = 70   // ° from vertical — the old 20–90° elevation fountain
// const enums in @dcl/ecs internals, not re-exported (same as plantVfx)
const PSB_ALPHA = 0, PS_PLAYING = 0, PSS_WORLD = 1   // alpha, not additive: additive vanishes on the bright garden

let burstAlbedo:   { r: number; g: number; b: number } = { r: 1.0, g: 0.95, b: 0.78 }   // warm cream
let burstEmissive: { r: number; g: number; b: number } = { r: 1.0, g: 0.88, b: 0.52 }   // warm gold

/** Call once at scene startup — builds the bloom and tribute pools. */
export function setupSparkleSystem(): void {
  bloomPool   = createPool(BLOOM_POOL_SIZE(),   'bloom',   2.0, TRAVEL_DUR_BASE,  1.5, RISE_DUR_MS)
  tributePool = createPool(TRIBUTE_POOL_SIZE(), 'tribute', 1.8, TRIBUTE_DUR_BASE, 0.4, TRIBUTE_DISSOLVE_MS)
  console.log(`[Sparkles] Burst: particles  Bloom pool: ${BLOOM_POOL_SIZE()}  Tribute pool: ${TRIBUTE_POOL_SIZE()}`)
}

/** Emit a burst of sparkles centred on `pos` (world position of the plant). */
export function triggerSparkle(pos: { x: number; y: number; z: number }): void {
  if (!waterFxFlags.burst) return
  const e = engine.addEntity()
  // Unity cones emit along local +Z; pitch −90° points them up
  Transform.create(e, { position: { x: pos.x, y: pos.y + SPAWN_Y, z: pos.z }, rotation: Quaternion.fromEulerDegrees(-90, 0, 0) })
  ParticleSystem.create(e, {
    shape: ParticleSystem.Shape.Cone({ angle: CONE_HALF_ANGLE, radius: 0.05 }),
    rate: BURST_COUNT() / (BURST_EMIT_MS / 1000), maxParticles: BURST_COUNT(), lifetime: LIFE_S,
    gravity: GRAVITY_MOD,
    initialVelocitySpeed: { start: SPEED_MIN, end: SPEED_MAX },
    initialSize: { start: SPARKLE_SIZE(), end: SPARKLE_SIZE() }, sizeOverTime: { start: 1, end: 0 },
    initialColor: { start: Color4.create(burstAlbedo.r, burstAlbedo.g, burstAlbedo.b, 1), end: Color4.create(burstEmissive.r, burstEmissive.g, burstEmissive.b, 1) },
    texture: { src: SPARKLE_SRC }, billboard: true, blendMode: PSB_ALPHA,
    simulationSpace: PSS_WORLD,
    loop: true, prewarm: false, active: true, playbackState: PS_PLAYING,
  })
  timers.setTimeout(() => { if (ParticleSystem.has(e)) ParticleSystem.getMutable(e).active = false }, BURST_EMIT_MS)
  timers.setTimeout(() => engine.removeEntity(e), BURST_EMIT_MS + LIFE_S * 1000 + 200)
}

// =============================================================
// SECTION 2 — Bloom orbit sparkles
// =============================================================

const BLOOM_POOL_SIZE = () => BLOOM_PLANTS * BLOOM_BURST_COUNT()   // 6 plants x a few big sparkles each (was 6 x 12 small ones: every one is moved by this script every frame)
const BLOOM_BURST_COUNT = () => fx(4, 3)   // sparkles per plant at bloom
const BLOOM_SPARKLE_SIZE = () => fx(0.45, 0.5)

// Travel from plant to orbit entry point
const TRAVEL_DUR_BASE    = 1_600  // ms base travel duration
const TRAVEL_DUR_VARY    = 600    // ms random variation
const TRAVEL_ARC_HEIGHT  = 0.6    // m — peak of the arc above the straight-line path
const TRAVEL_POP_IN_FRAC = 0.25   // fraction of travel during which sparkle pops in

// Orbit parameters
const ORBIT_RADIUS_MIN = 2    // m
const ORBIT_RADIUS_MAX = 4    // m
const ORBIT_Y_MIN      = 4.0    // m — orbits around Bloom model at y=4
const ORBIT_Y_MAX      = 7    // m
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

type BloomPhase = 'idle' | 'travel' | 'orbit' | 'rise' | 'dissolve'

interface BloomSparkleState {
  entity:       Entity
  mode:         'bloom' | 'tribute'   // bloom → orbit after travel; tribute → dissolve
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

// ── Pool factory ─────────────────────────────────────────────────

function createPool(
  size:              number,
  mode:              'bloom' | 'tribute',
  emissiveIntensity: number,
  travelDurMs:       number,
  orbitRadius:       number,
  riseDurMs:         number,
): BloomSparkleState[] {
  const pool: BloomSparkleState[] = []
  for (let i = 0; i < size; i++) {
    pool.push({
      entity:       makeSparkleEntity(emissiveIntensity),
      mode,
      phase:        'idle',
      startPos:     { x: 0, y: -100, z: 0 },
      travelTarget: { x: 0, y: 0,    z: 0 },
      travelMs:     0,
      travelDurMs,
      orbitAngle:   0,
      orbitSpeed:   0,
      orbitRadius,
      orbitBaseY:   1.5,
      bobPhase:     0,
      bobSpeed:     1.5,
      bobAmp:       0.2,
      riseMs:       0,
      riseDelay:    0,
      riseDurMs,
      riseStartPos: { x: 0, y: 0, z: 0 },
      pos:          { x: 0, y: -100, z: 0 },
      scale:        0.001,
    })
  }
  return pool
}

let bloomPool:   BloomSparkleState[] = []

/** A pooled sparkle gets its Billboard only while it's in flight. */
function wake(e: Entity): void { Billboard.createOrReplace(e, { billboardMode: BillboardMode.BM_ALL }) }
function park(e: Entity): void { Billboard.deleteFrom(e) }

/** Phase 6b — retint EVERY sparkle pool for the active bloom variant, not just the
 *  bloom-moment one. Found 2026-09-17: the per-watering burst (now particles) and
 *  tributePool (the per-watering "travel to centre" effect) both stayed warm-gold
 *  through a moonlit bloom because this only covered bloomPool — the KJ-reported
 *  "yellow orb" during a moonlit bloom was one of those two, not a firefly.
 *  Call before triggerBloomSparkles; the pooled materials are mutated in place. */
export function setBloomSparklePalette(p: { albedo: { r: number; g: number; b: number }; emissive: { r: number; g: number; b: number } }): void {
  for (const s of [...bloomPool, ...tributePool]) {
    const m = Material.getMutableOrNull(s.entity)?.material
    if (!m || m.$case !== 'pbr') continue
    m.pbr.albedoColor   = { ...p.albedo, a: m.pbr.albedoColor?.a ?? 1 }
    m.pbr.emissiveColor = { ...p.emissive }
  }
  burstAlbedo   = { ...p.albedo }
  burstEmissive = { ...p.emissive }
}

// ── Tribute pool — per-watering travel-to-centre effect ──────────
const TRIBUTE_POOL_SIZE = () => TRIBUTE_COUNT() * 6    // 6 waterings in flight at a time
const TRIBUTE_COUNT = () => fx(3, 2)     // sparkles per watering
const TRIBUTE_DUR_BASE    = 1_200 // ms
const TRIBUTE_DUR_VARY    = 500
const TRIBUTE_SPARKLE_SIZE = () => fx(0.3, 0.34)
const TRIBUTE_DISSOLVE_MS  = 450  // fade at centre after arriving

let tributePool: BloomSparkleState[] = []

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
    for (let b = 0; b < BLOOM_BURST_COUNT(); b++) {
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
        x: BLOOM_CENTER.x + Math.cos(s.orbitAngle) * s.orbitRadius,
        y: s.orbitBaseY,
        z: BLOOM_CENTER.z + Math.sin(s.orbitAngle) * s.orbitRadius,
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
      wake(s.entity)

      // Park off-screen until travel delay expires
      Transform.getMutable(s.entity).scale = { x: 0.001, y: 0.001, z: 0.001 }
    }
  }

  console.log(`[Sparkles] Bloom wave started for ${plantPositions.length} plants`)
}

/**
 * Fire a small wave of sparkles that travel from `plantPos` to the bloom
 * centre — called after the per-plant burst has played (~650 ms delay).
 * Uses the tribute pool so it never conflicts with the bloom orbit effect.
 */
export function triggerWateringTribute(
  plantPos: { x: number; y: number; z: number },
): void {
  if (!waterFxFlags.tribute) return
  let activated = 0
  for (const s of tributePool) {
    if (s.phase !== 'idle' || activated >= TRIBUTE_COUNT()) continue

    // Arrive at a random point close to the bloom centre
    s.orbitAngle  = Math.random() * Math.PI * 2
    s.orbitRadius = 0.25 + Math.random() * 0.35
    s.orbitBaseY  = 1.0  + Math.random() * 1.5
    s.travelTarget = {
      x: BLOOM_CENTER.x + Math.cos(s.orbitAngle) * s.orbitRadius,
      y: s.orbitBaseY,
      z: BLOOM_CENTER.z + Math.sin(s.orbitAngle) * s.orbitRadius,
    }

    // Burst slightly offset from plant base
    const burstA = Math.random() * Math.PI * 2
    const burstR = 0.08 + Math.random() * 0.18
    s.startPos = {
      x: plantPos.x + Math.cos(burstA) * burstR,
      y: plantPos.y + 0.3 + Math.random() * 0.4,
      z: plantPos.z + Math.sin(burstA) * burstR,
    }

    s.travelMs    = -(Math.random() * 250)     // stagger launch
    s.travelDurMs = TRIBUTE_DUR_BASE + Math.random() * TRIBUTE_DUR_VARY
    s.riseMs      = 0
    s.riseDurMs   = TRIBUTE_DISSOLVE_MS
    s.scale       = 0
    s.phase       = 'travel'
    s.mode        = 'tribute'
    wake(s.entity)

    Transform.getMutable(s.entity).scale = { x: 0.001, y: 0.001, z: 0.001 }
    activated++
  }
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

  tickBloomPool(bloomPool, dtMs, dt)
  tickBloomPool(tributePool, dtMs, dt)
}

function tickBloomPool(pool: BloomSparkleState[], dtMs: number, dt: number): void {
  for (const s of pool) {
    if (s.phase === 'idle') continue

    const tf = Transform.getMutable(s.entity)

    // ── Travel phase ───────────────────────────────────────────────
    if (s.phase === 'travel') {
      s.travelMs += dtMs

      if (s.travelMs < 0) {
        // Pre-travel delay — keep hidden
        tf.scale = { x: 0.001, y: 0.001, z: 0.001 }
        continue
      }

      const rawT = Math.min(s.travelMs / s.travelDurMs, 1)
      const t    = smoothstep(rawT)

      // Lerp position with a gentle vertical arc (sin arch above the straight line)
      const arc = Math.sin(rawT * Math.PI) * TRAVEL_ARC_HEIGHT   // peaks in the middle
      const x   = s.startPos.x + (s.travelTarget.x - s.startPos.x) * t
      const y   = s.startPos.y + (s.travelTarget.y - s.startPos.y) * t + arc
      const z   = s.startPos.z + (s.travelTarget.z - s.startPos.z) * t
      s.scale   = BLOOM_SPARKLE_SIZE() * Math.min(rawT / TRAVEL_POP_IN_FRAC, 1)  // pop in over first 25%

      s.pos       = { x, y, z }
      tf.position = { x, y, z }
      tf.scale    = { x: s.scale, y: s.scale, z: s.scale }

      if (rawT >= 1) {
        if (s.mode === 'tribute') {
          s.phase        = 'dissolve'
          s.riseMs       = 0
          s.riseDurMs    = TRIBUTE_DISSOLVE_MS
          s.riseStartPos = { ...s.travelTarget }
        } else {
          s.phase    = 'orbit'
          s.bobPhase = Math.random() * Math.PI * 2
        }
      }
      continue
    }

    // ── Orbit phase ────────────────────────────────────────────────
    if (s.phase === 'orbit') {
      s.orbitAngle += s.orbitSpeed * dt
      s.bobPhase   += s.bobSpeed   * dt

      const x = BLOOM_CENTER.x + Math.cos(s.orbitAngle) * s.orbitRadius
      const y = s.orbitBaseY   + Math.sin(s.bobPhase)   * s.bobAmp
      const z = BLOOM_CENTER.z + Math.sin(s.orbitAngle) * s.orbitRadius
      s.scale = BLOOM_SPARKLE_SIZE()
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
      s.scale  = BLOOM_SPARKLE_SIZE() * fade * fade * fade  // cubic — lingers then melts

      tf.position = { x: s.riseStartPos.x, y, z: s.riseStartPos.z }
      tf.scale    = { x: s.scale, y: s.scale, z: s.scale }

      if (riseT >= 1) {
        s.phase     = 'idle'
        tf.position = { x: 0, y: -100, z: 0 }
        tf.scale    = { x: 0.001, y: 0.001, z: 0.001 }
        park(s.entity)
      }
    }

    // ── Dissolve phase (tribute only) ──────────────────────────────
    if (s.phase === 'dissolve') {
      s.riseMs += dtMs
      const t  = Math.min(s.riseMs / s.riseDurMs, 1)
      const sc = TRIBUTE_SPARKLE_SIZE() * (1 - t) * (1 - t)   // quadratic fade

      tf.position = s.riseStartPos
      tf.scale    = { x: sc, y: sc, z: sc }

      if (t >= 1) {
        s.phase     = 'idle'
        tf.position = { x: 0, y: -100, z: 0 }
        tf.scale    = { x: 0.001, y: 0.001, z: 0.001 }
        park(s.entity)
      }
    }
  }
}
