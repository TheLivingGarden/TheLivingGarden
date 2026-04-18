// =============================================================
// The Living Garden — Ambient FX
//
//   Dust motes     — tiny sparkle sprites drifting upward throughout the garden
//   Shockwave      — concentric expanding rings at bloom trigger
//   Fireflies      — small emissive spheres wandering on sine paths
//   Ground ripple  — expanding ring at plant base on watering
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
import { Color4, Quaternion } from '@dcl/sdk/math'
import { BLOOM_CENTER, SPARKLE_SRC, GARDEN_BOUNDS } from './shared/config'

function rnd(min: number, max: number) { return min + Math.random() * (max - min) }

// =============================================================
// SECTION 1 — Dust motes
// =============================================================

const MOTE_COUNT  = 20
const MOTE_Y_MIN  = 0.3
const MOTE_Y_MAX  = 3.5

interface Mote {
  entity:     Entity
  baseX:      number
  z:          number
  y:          number
  speed:      number
  swayPhase:  number
  swayFreq:   number
  swayAmp:    number
}

const motes: Mote[] = []

function setupMotes() {
  for (let i = 0; i < MOTE_COUNT; i++) {
    const ent   = engine.addEntity()
    const baseX = rnd(GARDEN_BOUNDS.xMin, GARDEN_BOUNDS.xMax)
    const z     = rnd(GARDEN_BOUNDS.zMin, GARDEN_BOUNDS.zMax)
    const y     = rnd(MOTE_Y_MIN, MOTE_Y_MAX)
    const sc    = rnd(0.04, 0.10)
    Transform.create(ent, { position: { x: baseX, y, z }, scale: { x: sc, y: sc, z: sc } })
    MeshRenderer.setPlane(ent)
    Material.setPbrMaterial(ent, {
      texture:           Material.Texture.Common({ src: SPARKLE_SRC }),
      alphaTexture:      Material.Texture.Common({ src: SPARKLE_SRC }),
      transparencyMode:  MaterialTransparencyMode.MTM_ALPHA_BLEND,
      albedoColor:       { r: 1, g: 1, b: 1, a: rnd(0.25, 0.50) },
      emissiveColor:     { r: 1.0, g: 0.82, b: 0.45 },  // warm amber
      emissiveIntensity: 0.8,
    })
    Billboard.create(ent, { billboardMode: BillboardMode.BM_ALL })
    motes.push({ entity: ent, baseX, z, y, speed: rnd(0.03, 0.12),
      swayPhase: rnd(0, Math.PI * 2), swayFreq: rnd(0.3, 0.8), swayAmp: rnd(0.1, 0.30) })
  }
}



// =============================================================
// SECTION 2 — Bloom shockwave rings
// =============================================================

const SHOCK_COUNT   = 3
const SHOCK_DUR_MS  = 1400
const SHOCK_STAGGER = 280
const SHOCK_R_MAX   = 12
const SHOCK_Y_BLOOM  = -0.175   // central bloom (higher, more dramatic)
const SHOCK_Y_PLANT  = 0.15   // per-plant (closer to ground)

//const SHOCK_THICKNESS = 0.25

interface ShockRing {
  entity:  Entity
  active:  boolean
  elapsed: number
  delay:   number
}

const shockRings: ShockRing[] = []

function setupShockwaves() {
  for (let i = 0; i < SHOCK_COUNT; i++) {
    const ent = engine.addEntity()
    Transform.create(ent, {
      position:   { x: BLOOM_CENTER.x, y: BLOOM_CENTER.y + SHOCK_Y_BLOOM, z: BLOOM_CENTER.z},
      rotation: Quaternion.fromEulerDegrees(90, 0, 0),
      scale:    { x: 0.001, y: 0.001, z: 0.001 },
    })
    MeshRenderer.setPlane(ent)
    Material.setPbrMaterial(ent, {
      texture:           Material.Texture.Common({ src: SPARKLE_SRC }),
      alphaTexture:      Material.Texture.Common({ src: SPARKLE_SRC }),
      transparencyMode:  MaterialTransparencyMode.MTM_ALPHA_BLEND,
      albedoColor:       Color4.create(1, 0.95, 0.7, 0),
      emissiveColor:     { r: 1, g: 0.9, b: 0.5 },
      emissiveIntensity: 2.5,
      castShadows:       false,
    })
    shockRings.push({ entity: ent, active: false, elapsed: 0, delay: i * SHOCK_STAGGER })
  }
}

export function startFireflies(): void {
  firefliesActive = true
  for (const f of fireflies) {
    Transform.getMutable(f.entity).position = { x: f.bx, y: f.by, z: f.bz }
  }
}

export function stopFireflies(): void {
  firefliesActive = false
  for (const f of fireflies) {
    Transform.getMutable(f.entity).position = { x: f.bx, y: -100, z: f.bz }
  }
}

export function triggerBloomShockwave(): void {
  for (const ring of shockRings) {
    ring.active  = true
    ring.elapsed = -ring.delay
    Transform.getMutable(ring.entity).scale = { x: 0.001, y: 0.001, z: 0.001 }
  }
}

// =============================================================
// SECTION 3 — Fireflies
// =============================================================

const FF_COUNT = 10
const FF_SCALE = 0.07

interface Firefly {
  entity: Entity
  bx: number; by: number; bz: number
  fx: number; fy: number; fz: number
  px: number; py: number; pz: number
  ax: number; ay: number; az: number
  t:  number
}

const fireflies: Firefly[] = []
let firefliesActive = false

function setupFireflies() {
  for (let i = 0; i < FF_COUNT; i++) {
    const ent  = engine.addEntity()
    const warm = rnd(0, 1)
    Transform.create(ent, {
      position: { x: rnd(GARDEN_BOUNDS.xMin, GARDEN_BOUNDS.xMax), y: -100, z: rnd(GARDEN_BOUNDS.zMin, GARDEN_BOUNDS.zMax) },  // hidden until bloom
      scale:    { x: FF_SCALE, y: FF_SCALE, z: FF_SCALE },
    })
    MeshRenderer.setSphere(ent)
    Material.setPbrMaterial(ent, {
      albedoColor:       Color4.create(1.0, 0.75 + warm * 0.1, 0.2 + warm * 0.15, 1),
      emissiveColor:     { r: 1.0, g: 0.65 + warm * 0.1, b: 0.1 + warm * 0.1 },  // warm amber
      emissiveIntensity: 2.5,
    })
    fireflies.push({
      entity: ent,
      bx: rnd(GARDEN_BOUNDS.xMin, GARDEN_BOUNDS.xMax), by: rnd(0.8, 2.5), bz: rnd(GARDEN_BOUNDS.zMin, GARDEN_BOUNDS.zMax),
      fx: rnd(0.15, 0.45), fy: rnd(0.25, 0.60), fz: rnd(0.15, 0.45),
      px: rnd(0, Math.PI * 2), py: rnd(0, Math.PI * 2), pz: rnd(0, Math.PI * 2),
      ax: rnd(0.6, 1.5), ay: rnd(0.2, 0.5), az: rnd(0.6, 1.5),
      t: rnd(0, 100),
    })
  }
}

// =============================================================
// SECTION 4 — Ground ripple on watering
// Uses a fixed pool of 3 entities — avoids entity creation/destruction per trigger.
// =============================================================

const RIPPLE_DUR_MS   = 1700
const RIPPLE_R_MAX    = 4.5   // world-unit radius
const RIPPLE_POOL_SIZE = 3

interface RippleSlot { entity: Entity; active: boolean; elapsed: number }
const rippleSlots: RippleSlot[] = []

function setupRipplePool(): void {
  for (let i = 0; i < RIPPLE_POOL_SIZE; i++) {
    const ent = engine.addEntity()
    Transform.create(ent, {
      position: { x: 0, y: -100, z: 0 },   // parked off-scene until triggered
      rotation: Quaternion.fromEulerDegrees(90, 0, 0),
      scale:    { x: 0.001, y: 0.001, z: 0.001 },
    })
    MeshRenderer.setPlane(ent)
    Material.setPbrMaterial(ent, {
      texture:           Material.Texture.Common({ src: SPARKLE_SRC }),
      alphaTexture:      Material.Texture.Common({ src: SPARKLE_SRC }),
      transparencyMode:  MaterialTransparencyMode.MTM_ALPHA_BLEND,
      albedoColor:       Color4.create(1.0, 0.88, 0.52, 0.0),  // start transparent
      emissiveColor:     { r: 1.0, g: 0.75, b: 0.32 },
      emissiveIntensity: 2.0,
      castShadows:       false,
    })
    rippleSlots.push({ entity: ent, active: false, elapsed: 0 })
  }
}

export function triggerGroundRipple(pos: { x: number; y: number; z: number }): void {
  const slot = rippleSlots.find(s => !s.active)
  if (!slot) return   // all slots busy — skip (3 concurrent ripples is unlikely)
  slot.active  = true
  slot.elapsed = 0
  const tf = Transform.getMutable(slot.entity)
  tf.position = { x: pos.x, y: pos.y + SHOCK_Y_PLANT, z: pos.z }
  tf.scale    = { x: 0.001, y: 0.001, z: 0.001 }
  const mat = Material.getFlatMutable(slot.entity)
  if (mat.albedoColor) mat.albedoColor.a = 0.75
}

function tickRipples(dt: number) {
  for (const slot of rippleSlots) {
    if (!slot.active) continue
    slot.elapsed += dt * 1000

    const t = Math.min(slot.elapsed / RIPPLE_DUR_MS, 1)
    if (t >= 1) {
      slot.active = false
      Transform.getMutable(slot.entity).scale = { x: 0.001, y: 0.001, z: 0.001 }
      const mat = Material.getFlatMutable(slot.entity)
      if (mat.albedoColor) mat.albedoColor.a = 0
      continue
    }

    const sc    = (1 - (1 - t) * (1 - t)) * RIPPLE_R_MAX
    const alpha = (1 - t) * (1 - t) * 0.75
    Transform.getMutable(slot.entity).scale = { 
  x: sc, 
  y: sc, 
  z: sc 
}
    const mat = Material.getFlatMutable(slot.entity)
    if (mat.albedoColor) mat.albedoColor.a = alpha
  }
}

// =============================================================
// Public setup
// =============================================================

export function setupAmbientFX(): void {
  setupMotes()
  setupShockwaves()
  setupFireflies()
  setupRipplePool()
}

// =============================================================
// ECS system — register with engine.addSystem(ambientFXSystem)
// =============================================================

export function ambientFXSystem(dt: number): void {
  // ── Dust motes ──────────────────────────────────────────────
  for (const m of motes) {
    m.y += m.speed * dt
    if (m.y > MOTE_Y_MAX) m.y = MOTE_Y_MIN
    m.swayPhase += m.swayFreq * dt
    Transform.getMutable(m.entity).position = { x: m.baseX + Math.sin(m.swayPhase) * m.swayAmp, y: m.y, z: m.z }
  }

  // ── Bloom shockwave rings ────────────────────────────────────
  for (const ring of shockRings) {
    if (!ring.active) continue
    ring.elapsed += dt * 1000
    if (ring.elapsed < 0) continue

    const t = Math.min(ring.elapsed / SHOCK_DUR_MS, 1)
    if (t >= 1) {
      ring.active = false
      Transform.getMutable(ring.entity).scale = { x: 0.001, y: 0.001, z: 0.001 }
      continue
    }
    const sc = (1 - (1 - t) * (1 - t)) * SHOCK_R_MAX
    Transform.getMutable(ring.entity).scale = { 
  x: sc, 
  y: sc, 
  z: sc 
}
    const mat = Material.getFlatMutable(ring.entity)
    if (mat.albedoColor) mat.albedoColor.a = (1 - t) * (1 - t) * 0.85
  }

  // ── Fireflies — bloom only ───────────────────────────────────
  if (firefliesActive) {
    for (const f of fireflies) {
      f.t += dt
      Transform.getMutable(f.entity).position = {
        x: f.bx + Math.sin(f.t * f.fx + f.px) * f.ax,
        y: f.by + Math.sin(f.t * f.fy + f.py) * f.ay,
        z: f.bz + Math.sin(f.t * f.fz + f.pz) * f.az,
      }
    }
  }

  // ── Ground ripples ──────────────────────────────────────────
  tickRipples(dt)
}
