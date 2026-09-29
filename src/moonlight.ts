// =============================================================
// Bloom Garden v2 — Moonlit Bloom spectacle (CLIENT ONLY)
//
// The rare variant has to READ as rare. Retinting the bloom FX cool-white is
// invisible in daylight, so the Moonlit Bloom changes the light itself:
//   1. night falls   — SkyboxTime on the root entity rolls the sky to midnight;
//                      at bloom reset the sky rolls back to the garden's golden hour
//   2. moon wisps    — slow glowing lights rise from the whole garden, only
//                      readable because the sky is dark
//   3. the moon glow — a breathing blue-white glow sprite that hangs over BLOOM_CENTER
//                      for the whole event; the garden has no single "Bloom" mesh, so
//                      this is the one persistent mark on the moment itself
//   4. a real light   — a point LightSource at the same spot, so the moon-blue tint
//                      actually falls on nearby geometry, not just the glow sprite
// Everything is created on the first Moonlit Bloom — zero cost on a normal day.
// =============================================================

import {
  engine, Entity, Transform, MeshRenderer, Material, MaterialTransparencyMode,
  Billboard, BillboardMode, SkyboxTime, TransitionMode, LightSource,
} from '@dcl/sdk/ecs'
import { isMobile } from '@dcl/sdk/platform'
import { GARDEN_BOUNDS, BLOOM_CENTER, SPARKLE_SRC, GOLDEN_HOUR_S } from './shared/config'

const NIGHT_TIME_S   = 0        // seconds since 00:00 — midnight
const WISP_COUNT     = 28       // TUNING — pooled, billboard planes
const WISP_Y_MIN     = 0.2
const WISP_Y_MAX     = 6.5
const WISP_SIZE_MIN  = 0.22
const WISP_SIZE_MAX  = 0.55
const WISP_RAMP_S    = 6        // wisps swell in over the nightfall, not all at once
const SYSTEM_NAME    = 'moonlight-wisps'

// A soft moon-blue glow that hangs over the Bloom itself for the whole event — the
// garden has no single "Bloom" mesh (it's a moment, not an object), so this is the
// one persistent, unmissable mark that THIS bloom is the rare one, not just tinted
// ambient FX. Breathes slowly; never fully still.
const GLOW_Y         = BLOOM_CENTER.y + 2.4
const GLOW_SIZE_MIN  = 3.2
const GLOW_SIZE_MAX  = 3.9
const GLOW_BREATHE_S = 4.5
// Mobile has no real LightSource (see below) — the glow sprite carries the whole
// effect there, so it runs noticeably bigger to compensate.
const GLOW_MOBILE_MULT = 1.45

// A real dynamic light alongside the glow sprite — the sprite is self-illuminating and
// doesn't tint anything around it; this actually casts moon-blue light onto the garden.
// KJ 2026-09-17: "would be awesome to add a blue tinted light over the bloom". First
// version (intensity 30k, forced range 22m) was too dim to notice — per the SDK docs,
// intensity 160k is what gives ~20m of real visibility; range is left auto (intensity^0.25)
// rather than forced, matching the documented pattern.
// DESKTOP ONLY (isMobile() check in startMoonlight): KJ reported flicker + a "following"
// look on mobile — that matches a known godot-explorer bug where LightSource causes
// visible artifacts at Medium/High graphics quality (github.com/decentraland/
// godot-explorer#2868). It's a client bug, not fixable from scene code, so mobile skips
// the real light entirely and leans on the boosted glow sprite instead. Also bumped
// intensity further for desktop, where KJ still found it weak even at High quality.
// NOTE FOR KJ: dynamic lights are capped per graphics-quality preset and fully OFF at
// Very Low — a client setting, not something the scene can override.
const LIGHT_Y         = BLOOM_CENTER.y + 3.5
const LIGHT_COLOR     = { r: 0.55, g: 0.72, b: 1.0 }
const LIGHT_INTENSITY = 260_000

interface Wisp {
  entity: Entity
  x: number; z: number; y: number
  size: number; speed: number
  swayPhase: number; swayFreq: number; swayAmp: number
}

const wisps: Wisp[] = []
let active = false
let ramp   = 0   // 0→1 master scale, eases the whole field in
let glowEntity: Entity | null = null
let lightEntity: Entity | null = null
let glowT = 0   // seconds, drives the breathing sine

function rnd(min: number, max: number): number { return min + Math.random() * (max - min) }

function createGlow(): void {
  const entity = engine.addEntity()
  Transform.create(entity, { position: { x: BLOOM_CENTER.x, y: GLOW_Y, z: BLOOM_CENTER.z }, scale: { x: 0, y: 0, z: 0 } })
  MeshRenderer.setPlane(entity)
  Material.setPbrMaterial(entity, {
    texture:           Material.Texture.Common({ src: SPARKLE_SRC }),
    alphaTexture:      Material.Texture.Common({ src: SPARKLE_SRC }),
    transparencyMode:  MaterialTransparencyMode.MTM_ALPHA_BLEND,
    albedoColor:       { r: 0.75, g: 0.85, b: 1.0, a: 0.55 },
    emissiveColor:     { r: 0.5, g: 0.7, b: 1.0 },
    emissiveIntensity: 2.2,
    castShadows:       false,
  })
  glowEntity = entity
}

function createLight(): void {
  const entity = engine.addEntity()
  Transform.create(entity, { position: { x: BLOOM_CENTER.x, y: LIGHT_Y, z: BLOOM_CENTER.z } })
  LightSource.create(entity, {
    active: false, color: LIGHT_COLOR, intensity: LIGHT_INTENSITY,
    shadow: false, type: { $case: 'point', point: {} },
  })
  lightEntity = entity
}

/** Billboards only during the night: the explorer rotates EVERY billboard entity toward the
 *  camera each frame, parked or not — 29 of them idling all day between Moonlit Blooms. */
function setBillboards(on: boolean): void {
  const all = glowEntity === null ? wisps.map(w => w.entity) : [...wisps.map(w => w.entity), glowEntity]
  for (const e of all) {
    if (on) Billboard.createOrReplace(e, { billboardMode: BillboardMode.BM_ALL })
    else Billboard.deleteFrom(e)
  }
}

function respawn(w: Wisp, y: number): void {
  w.x = rnd(GARDEN_BOUNDS.xMin, GARDEN_BOUNDS.xMax)
  w.z = rnd(GARDEN_BOUNDS.zMin, GARDEN_BOUNDS.zMax)
  w.y = y
}

function createWisps(): void {
  for (let i = 0; i < WISP_COUNT; i++) {
    const entity = engine.addEntity()
    Transform.create(entity, { position: { x: 0, y: -100, z: 0 }, scale: { x: 0, y: 0, z: 0 } })
    MeshRenderer.setPlane(entity)
    Material.setPbrMaterial(entity, {
      texture:           Material.Texture.Common({ src: SPARKLE_SRC }),
      alphaTexture:      Material.Texture.Common({ src: SPARKLE_SRC }),
      transparencyMode:  MaterialTransparencyMode.MTM_ALPHA_BLEND,
      albedoColor:       { r: 0.85, g: 0.92, b: 1.0, a: 0.9 },
      emissiveColor:     { r: 0.55, g: 0.75, b: 1.0 },
      emissiveIntensity: 3,
      castShadows:       false,
    })
    const w: Wisp = {
      entity, x: 0, z: 0, y: 0,
      size: rnd(WISP_SIZE_MIN, WISP_SIZE_MAX), speed: rnd(0.18, 0.42),
      swayPhase: rnd(0, Math.PI * 2), swayFreq: rnd(0.2, 0.5), swayAmp: rnd(0.25, 0.7),
    }
    respawn(w, rnd(WISP_Y_MIN, WISP_Y_MAX))   // start spread through the column, not in one sheet
    wisps.push(w)
  }
}

function wispSystem(dt: number): void {
  ramp = Math.min(1, ramp + dt / WISP_RAMP_S)
  if (glowEntity !== null) {
    glowT += dt
    const breathe = (Math.sin((glowT / GLOW_BREATHE_S) * Math.PI * 2) + 1) / 2   // 0..1
    const mult = isMobile() ? GLOW_MOBILE_MULT : 1
    const k = (GLOW_SIZE_MIN + breathe * (GLOW_SIZE_MAX - GLOW_SIZE_MIN)) * ramp * mult
    Transform.getMutable(glowEntity).scale = { x: k, y: k, z: k }
  }
  for (const w of wisps) {
    w.y += w.speed * dt
    if (w.y > WISP_Y_MAX) respawn(w, WISP_Y_MIN)
    w.swayPhase += w.swayFreq * dt
    // Swell from nothing at the ground to full mid-column and back to nothing at the top —
    // no pop at either end, and no per-frame material writes.
    const k = Math.sin(((w.y - WISP_Y_MIN) / (WISP_Y_MAX - WISP_Y_MIN)) * Math.PI) * w.size * ramp
    const t = Transform.getMutable(w.entity)
    t.position = { x: w.x + Math.sin(w.swayPhase) * w.swayAmp, y: w.y, z: w.z + Math.cos(w.swayPhase * 0.7) * w.swayAmp }
    t.scale    = { x: k, y: k, z: k }
  }
}

/** The garden's resting sky — golden hour, held for everyone whatever the world clock says. */
export function setGoldenHour(): void {
  SkyboxTime.createOrReplace(engine.RootEntity, { fixedTime: GOLDEN_HOUR_S, transitionMode: TransitionMode.TM_FORWARD })
}

/** Night falls and the wisps rise. Safe to call again mid-bloom (late joiner re-send). */
export function startMoonlight(): void {
  SkyboxTime.createOrReplace(engine.RootEntity, { fixedTime: NIGHT_TIME_S, transitionMode: TransitionMode.TM_FORWARD })
  if (active) return
  active = true
  ramp   = 0
  glowT  = 0
  if (wisps.length === 0) createWisps()
  if (glowEntity === null) createGlow()
  setBillboards(true)
  // Desktop (Unity) only — the real point light triggers a known godot-explorer
  // artifact on mobile (flicker); mobile relies on the boosted glow sprite instead.
  if (!isMobile()) {
    if (lightEntity === null) createLight()
    if (lightEntity !== null) LightSource.getMutable(lightEntity).active = true
  }
  engine.addSystem(wispSystem, undefined, SYSTEM_NAME)
  console.log('[Moonlight] night falls')
}

/** Dawn breaks: the sky returns to golden hour and the wisps and the glow are put away. */
export function stopMoonlight(): void {
  if (!active) return
  active = false
  setGoldenHour()
  engine.removeSystem(SYSTEM_NAME)
  setBillboards(false)
  for (const w of wisps) {
    const t = Transform.getMutable(w.entity)
    t.position = { x: w.x, y: -100, z: w.z }
    t.scale    = { x: 0, y: 0, z: 0 }
  }
  if (glowEntity !== null) Transform.getMutable(glowEntity).scale = { x: 0, y: 0, z: 0 }
  if (lightEntity !== null) LightSource.getMutable(lightEntity).active = false
  console.log('[Moonlight] dawn')
}
