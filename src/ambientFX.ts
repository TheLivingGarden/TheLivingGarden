// =============================================================
// The Living Garden — Ambient FX
//
//   Dust motes     — tiny sparkle sprites drifting upward throughout the garden
//   Shockwave      — concentric expanding rings at bloom trigger
//   Fireflies      — small emissive spheres wandering on sine paths
//   Ground ripple  — expanding ring at plant base on watering
//   Arrival        — sun shafts over the Bloom, seen from the entrance ledge
// =============================================================

import {
  engine,
  Entity,
  MeshRenderer,
  Material,
  MaterialTransparencyMode,
  Transform,
  ParticleSystem,
} from '@dcl/sdk/ecs'
import { Color4, Quaternion } from '@dcl/sdk/math'
import { BLOOM_CENTER, SPARKLE_SRC, GARDEN_BOUNDS } from './shared/config'
import { waterFxFlags } from './sparkleSystem'
import { fx } from './perfTier'

function rnd(min: number, max: number) { return min + Math.random() * (max - min) }

// =============================================================
// SECTION 1 — Dust motes
// =============================================================

const MOTE_COUNT  = () => fx(8, 5)   // KJ 2026-10-01: fewer and bigger (was 20 at 0.04-0.10 m)
const MOTE_Y_MIN  = 0.3
const MOTE_LIFE_S = 40     // slow rise: ~2.4 m over a lifetime (MOTE_RISE)
const MOTE_RISE   = 0.003  // m/s² upward — gentle, slightly accelerating drift

// One renderer-side ParticleSystem over the garden. The previous 20 motes were 40 looping
// Tween entities, and the Unity explorer writes a looping-tweened entity's Transform back to
// the scene EVERY frame — 40 inbound messages per tick for dust (KJ debug panel 2026-09-19).
// Prewarm fills the garden on load; at 20 particles its spawn-frame cost is negligible.
const PSB_ADD = 1, PS_PLAYING = 0, PSS_WORLD = 1   // const enums in @dcl/ecs internals (same as plantVfx)
function setupMotes() {
  const w = GARDEN_BOUNDS.xMax - GARDEN_BOUNDS.xMin, d = GARDEN_BOUNDS.zMax - GARDEN_BOUNDS.zMin
  const ent = engine.addEntity()
  Transform.create(ent, { position: { x: GARDEN_BOUNDS.xMin + w / 2, y: MOTE_Y_MIN + 0.5, z: GARDEN_BOUNDS.zMin + d / 2 } })
  ParticleSystem.create(ent, {
    shape: ParticleSystem.Shape.Box({ size: { x: w, y: 1, z: d } }),
    rate: MOTE_COUNT() / MOTE_LIFE_S, maxParticles: MOTE_COUNT(), lifetime: MOTE_LIFE_S,
    gravity: 0, additionalForce: { x: 0, y: MOTE_RISE, z: 0 },
    initialVelocitySpeed: { start: 0.01, end: 0.04 },
    initialSize: { start: 0.10, end: 0.26 }, sizeOverTime: { start: 1, end: 1 },
    initialColor: { start: Color4.create(1.0, 0.90, 0.70, 0.25), end: Color4.create(1.0, 0.82, 0.45, 0.50) },   // warm amber
    colorOverTime: { start: Color4.create(1, 1, 1, 1), end: Color4.create(1, 1, 1, 0) },
    texture: { src: SPARKLE_SRC }, billboard: true, blendMode: PSB_ADD,
    simulationSpace: PSS_WORLD,
    loop: true, prewarm: true, active: true, playbackState: PS_PLAYING,
  })
}

// =============================================================
// SECTION 2 — Bloom shockwave rings
// =============================================================

const SHOCK_COUNT   = 3
const SHOCK_DUR_MS  = 1400
const SHOCK_STAGGER = 280
const SHOCK_R_MAX   = 12
const SHOCK_ALPHA   = 0.85
const SHOCK_Y_BLOOM  = -0.175   // central bloom (higher, more dramatic)
const SHOCK_Y_PLANT  = 0.15   // per-plant (closer to ground)

//const SHOCK_THICKNESS = 0.25

interface ShockRing {
  entity:    Entity
  active:    boolean
  elapsed:   number
  delay:     number
  alphaStep: number   // last fade step sent — see setFadeStep
}

// Fades are stepped, not continuous: every Material change is a renderer-side material
// rebuild (and texture re-request — see plantVfx.ts), so a per-frame alpha write on these
// textured planes cost ~60 rebuilds/s per plane. ALPHA_STEPS levels = that many writes per fade.
const ALPHA_STEPS = 3   // TUNING — more steps = smoother fade, more rebuilds

/** Send `alpha` quantised to ALPHA_STEPS levels of `peak`, only when the level changes. Returns the level. */
function setFadeStep(entity: Entity, alpha: number, peak: number, lastStep: number): number {
  const step = Math.ceil((alpha / peak) * ALPHA_STEPS - 1e-6)
  if (step === lastStep) return lastStep
  const mat = Material.getFlatMutable(entity)
  if (mat.albedoColor) mat.albedoColor.a = (peak * step) / ALPHA_STEPS
  return step
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
    shockRings.push({ entity: ent, active: false, elapsed: 0, delay: i * SHOCK_STAGGER, alphaStep: 0 })
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

const FF_COUNT = () => fx(5, 3)      // KJ 2026-10-01: fewer and bigger (was 10 at 0.07)
const FF_SCALE = () => fx(0.14, 0.17)

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
  for (let i = 0; i < FF_COUNT(); i++) {
    const ent  = engine.addEntity()
    const warm = rnd(0, 1)
    Transform.create(ent, {
      position: { x: rnd(GARDEN_BOUNDS.xMin, GARDEN_BOUNDS.xMax), y: -100, z: rnd(GARDEN_BOUNDS.zMin, GARDEN_BOUNDS.zMax) },  // hidden until bloom
      scale:    { x: FF_SCALE(), y: FF_SCALE(), z: FF_SCALE() },
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
// Phase 6b — bloom variant palette
// Retints the pooled bloom FX (shockwaves, ripples, fireflies) in place;
// ambient motes keep their warm look so the garden itself doesn't change.
// =============================================================

type RGB = { r: number; g: number; b: number }

function tintEntity(entity: Entity, albedo: RGB, emissive: RGB, vary = 0): void {
  const m = Material.getMutableOrNull(entity)?.material
  if (!m || m.$case !== 'pbr') return
  const k = 1 - vary + rnd(0, vary * 2)   // per-entity brightness variation (fireflies)
  m.pbr.albedoColor   = { r: albedo.r * k, g: albedo.g * k, b: albedo.b * k, a: m.pbr.albedoColor?.a ?? 1 }
  m.pbr.emissiveColor = { r: emissive.r * k, g: emissive.g * k, b: emissive.b * k }
}

export function setAmbientPalette(p: { albedo: RGB; emissive: RGB }): void {
  for (const r of shockRings)  tintEntity(r.entity, p.albedo, p.emissive)
  for (const r of rippleSlots) tintEntity(r.entity, p.albedo, p.emissive)
  for (const f of fireflies)   tintEntity(f.entity, p.albedo, p.emissive, 0.12)
}

// =============================================================
// SECTION 4 — Ground ripple on watering
// Uses a fixed pool of 3 entities — avoids entity creation/destruction per trigger.
// =============================================================

const RIPPLE_DUR_MS   = 1700
const RIPPLE_R_MAX    = 4.5   // world-unit radius
const RIPPLE_POOL_SIZE = 3

const RIPPLE_ALPHA     = 0.75

interface RippleSlot { entity: Entity; active: boolean; elapsed: number; alphaStep: number }
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
    rippleSlots.push({ entity: ent, active: false, elapsed: 0, alphaStep: 0 })
  }
}

export function triggerGroundRipple(pos: { x: number; y: number; z: number }): void {
  if (!waterFxFlags.ripple) return
  const slot = rippleSlots.find(s => !s.active)
  if (!slot) return   // all slots busy — skip (3 concurrent ripples is unlikely)
  slot.active  = true
  slot.elapsed = 0
  const tf = Transform.getMutable(slot.entity)
  tf.position = { x: pos.x, y: pos.y + SHOCK_Y_PLANT, z: pos.z }
  tf.scale    = { x: 0.001, y: 0.001, z: 0.001 }
  slot.alphaStep = setFadeStep(slot.entity, RIPPLE_ALPHA, RIPPLE_ALPHA, slot.alphaStep)
}

function tickRipples(dt: number) {
  for (const slot of rippleSlots) {
    if (!slot.active) continue
    slot.elapsed += dt * 1000

    const t = Math.min(slot.elapsed / RIPPLE_DUR_MS, 1)
    if (t >= 1) {
      slot.active = false
      Transform.getMutable(slot.entity).scale = { x: 0.001, y: 0.001, z: 0.001 }
      slot.alphaStep = setFadeStep(slot.entity, 0, RIPPLE_ALPHA, slot.alphaStep)
      continue
    }

    const sc    = (1 - (1 - t) * (1 - t)) * RIPPLE_R_MAX
    const alpha = (1 - t) * (1 - t) * RIPPLE_ALPHA
    Transform.getMutable(slot.entity).scale = { 
  x: sc, 
  y: sc, 
  z: sc 
}
    slot.alphaStep = setFadeStep(slot.entity, alpha, RIPPLE_ALPHA, slot.alphaStep)
  }
}

// =============================================================
// SECTION 5 — Arrival: sun shafts over the Bloom
//
// What a player sees in the first seconds (KJ 2026-10-03, "the spawn moment"). They land on
// the entrance ledge (scene.json GardenLedgeArrival, x 29-31) facing the Bloom down -X:
// static, soft planes facing the ledge, hung over the Bloom. No system, no tweens, no material
// writes; put away for the Moonlit Bloom (setSunShafts). The texture's top half is one long
// fade-in, so the shafts dissolve into the sky instead of starting at a line (KJ 2026-10-03).
// (A petal emitter at the arch was tried and dropped the same day — it read as a second,
// weaker copy of the Bloom's 3D petal rain.)
// =============================================================

const SHAFT_SRC       = 'assets/scene/Images/sunShaft.png'
const SHAFT_X         = BLOOM_CENTER.x + 1.4   // just on the ledge side of the Bloom, so the shafts fall across it
const SHAFT_BOTTOM_Y  = 1.5                    // the texture has faded to nothing well above this — nobody walks through light
const SHAFT_HEIGHT    = 24
const SHAFT_TILT_DEG  = 16                     // lean, as seen from the ledge. TUNING
const SHAFT_ALPHA     = 0.20                   // TUNING — soft; these are atmosphere, not beams
/** z offset from the Bloom, width (m). Phones get the first two (big alpha quads are fill-rate). */
const SHAFTS: ReadonlyArray<{ dz: number; w: number }> = [{ dz: 0.6, w: 5.5 }, { dz: -4.2, w: 3.2 }, { dz: 4.6, w: 2.6 }]

const shaftEntities: { entity: Entity; w: number }[] = []

function setupSunShafts(): void {
  for (const s of SHAFTS.slice(0, fx(3, 2))) {
    const ent = engine.addEntity()
    Transform.create(ent, {
      position: { x: SHAFT_X, y: SHAFT_BOTTOM_Y + SHAFT_HEIGHT / 2, z: BLOOM_CENTER.z + s.dz },
      rotation: Quaternion.fromEulerDegrees(0, 90, SHAFT_TILT_DEG),   // face the ledge (+X), lean in the plane
      scale:    { x: s.w, y: SHAFT_HEIGHT, z: 1 },
    })
    MeshRenderer.setPlane(ent)
    Material.setPbrMaterial(ent, {
      texture:           Material.Texture.Common({ src: SHAFT_SRC }),
      alphaTexture:      Material.Texture.Common({ src: SHAFT_SRC }),
      transparencyMode:  MaterialTransparencyMode.MTM_ALPHA_BLEND,
      albedoColor:       Color4.create(1, 0.90, 0.62, SHAFT_ALPHA),
      emissiveColor:     { r: 1, g: 0.82, b: 0.50 },   // golden hour
      emissiveIntensity: 1.6,
      castShadows:       false,
    })
    shaftEntities.push({ entity: ent, w: s.w })
  }
}

/** Sunlight has no place in the Moonlit Bloom — moonlight.ts puts the shafts away and brings them back. */
export function setSunShafts(visible: boolean): void {
  for (const s of shaftEntities) {
    Transform.getMutable(s.entity).scale = visible ? { x: s.w, y: SHAFT_HEIGHT, z: 1 } : { x: 0, y: 0, z: 0 }
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
  setupSunShafts()
}

// =============================================================
// ECS system — register with engine.addSystem(ambientFXSystem)
// =============================================================

export function ambientFXSystem(dt: number): void {
  // (Dust motes move renderer-side — see setupMotes.)

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
    ring.alphaStep = setFadeStep(ring.entity, (1 - t) * (1 - t) * SHOCK_ALPHA, SHOCK_ALPHA, ring.alphaStep)
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
