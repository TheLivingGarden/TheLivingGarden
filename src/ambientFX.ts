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

const SPARKLE_SRC = 'assets/scene/Images/sparkle.png'

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
    const baseX = rnd(3, 14)
    const z     = rnd(3, 22)
    const y     = rnd(MOTE_Y_MIN, MOTE_Y_MAX)
    const sc    = rnd(0.04, 0.10)
    Transform.create(ent, { position: { x: baseX, y, z }, scale: { x: sc, y: sc, z: sc } })
    MeshRenderer.setPlane(ent)
    Material.setPbrMaterial(ent, {
      texture:           Material.Texture.Common({ src: SPARKLE_SRC }),
      alphaTexture:      Material.Texture.Common({ src: SPARKLE_SRC }),
      transparencyMode:  MaterialTransparencyMode.MTM_ALPHA_BLEND,
      albedoColor:       { r: 1, g: 1, b: 1, a: rnd(0.25, 0.50) },
      emissiveColor:     { r: 0.9, g: 0.95, b: 1.0 },
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
const SHOCK_POS     = { x: 6.75, y: 2, z: 24 }

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
      position: SHOCK_POS,
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
      position: { x: rnd(3, 14), y: -100, z: rnd(3, 22) },  // hidden until bloom
      scale:    { x: FF_SCALE, y: FF_SCALE, z: FF_SCALE },
    })
    MeshRenderer.setSphere(ent)
    Material.setPbrMaterial(ent, {
      albedoColor:       Color4.create(0.7, 1.0, 0.3 + warm * 0.25, 1),
      emissiveColor:     { r: 0.6, g: 1.0, b: 0.3 + warm * 0.25 },
      emissiveIntensity: 2.5,
    })
    fireflies.push({
      entity: ent,
      bx: rnd(3, 14), by: rnd(0.8, 2.5), bz: rnd(3, 22),
      fx: rnd(0.15, 0.45), fy: rnd(0.25, 0.60), fz: rnd(0.15, 0.45),
      px: rnd(0, Math.PI * 2), py: rnd(0, Math.PI * 2), pz: rnd(0, Math.PI * 2),
      ax: rnd(0.6, 1.5), ay: rnd(0.2, 0.5), az: rnd(0.6, 1.5),
      t: rnd(0, 100),
    })
  }
}

// =============================================================
// SECTION 4 — Ground ripple on watering
// Fresh entity per trigger — avoids stale component state on reuse.
// Entity is removed once the animation completes.
// =============================================================

const RIPPLE_DUR_MS = 700
const RIPPLE_R_MAX  = 4.5   // world-unit radius

interface ActiveRipple { entity: Entity; elapsed: number }
const activeRipples: ActiveRipple[] = []

export function triggerGroundRipple(pos: { x: number; y: number; z: number }): void {
  const ent = engine.addEntity()
  Transform.create(ent, {
    position: { x: pos.x, y: 0.08, z: pos.z },
    rotation: Quaternion.fromEulerDegrees(90, 0, 0),
    scale:    { x: 0.001, y: 0.001, z: 0.001 },
  })
  MeshRenderer.setPlane(ent)
  Material.setPbrMaterial(ent, {
    texture:           Material.Texture.Common({ src: SPARKLE_SRC }),
    alphaTexture:      Material.Texture.Common({ src: SPARKLE_SRC }),
    transparencyMode:  MaterialTransparencyMode.MTM_ALPHA_BLEND,
    albedoColor:       Color4.create(0.6, 0.9, 1.0, 0.75),
    emissiveColor:     { r: 0.4, g: 0.8, b: 1.0 },
    emissiveIntensity: 2.0,
  })
  activeRipples.push({ entity: ent, elapsed: 0 })
}

function tickRipples(dt: number) {
  for (let i = activeRipples.length - 1; i >= 0; i--) {
    const r = activeRipples[i]
    r.elapsed += dt * 1000

    const t = Math.min(r.elapsed / RIPPLE_DUR_MS, 1)
    if (t >= 1) {
      engine.removeEntity(r.entity)
      activeRipples.splice(i, 1)
      continue
    }

    const sc    = (1 - (1 - t) * (1 - t)) * RIPPLE_R_MAX
    const alpha = (1 - t) * (1 - t) * 0.75
    Transform.getMutable(r.entity).scale = { x: sc, y: sc, z: sc }
    Material.setPbrMaterial(r.entity, {
      texture:           Material.Texture.Common({ src: SPARKLE_SRC }),
      alphaTexture:      Material.Texture.Common({ src: SPARKLE_SRC }),
      transparencyMode:  MaterialTransparencyMode.MTM_ALPHA_BLEND,
      albedoColor:       Color4.create(0.6, 0.9, 1.0, alpha),
      emissiveColor:     { r: 0.4, g: 0.8, b: 1.0 },
      emissiveIntensity: 2.0,
    })
  }
}

// =============================================================
// Public setup
// =============================================================

export function setupAmbientFX(): void {
  setupMotes()
  setupShockwaves()
  setupFireflies()
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
    Transform.getMutable(ring.entity).scale = { x: sc, y: sc, z: sc }
    Material.setPbrMaterial(ring.entity, {
      texture:           Material.Texture.Common({ src: SPARKLE_SRC }),
      alphaTexture:      Material.Texture.Common({ src: SPARKLE_SRC }),
      transparencyMode:  MaterialTransparencyMode.MTM_ALPHA_BLEND,
      albedoColor:       Color4.create(1, 0.95, 0.7, (1 - t) * (1 - t) * 0.85),
      emissiveColor:     { r: 1, g: 0.9, b: 0.5 },
      emissiveIntensity: 2.5,
    })
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
