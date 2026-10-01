// =============================================================
// Bloom Garden v2 — Rarity VFX on a revealed flower (CLIENT ONLY)
//
// KJ's tier table (2026-09-18), with KJ's meaning of the words:
//   "pulse"     = emissive pulsed INTO the plant's own material (not a halo beside it)
//   "particles" = many small sparkles above and around the plant
//   Rare       green pulse
//   Epic       blue particles
//   Legendary  tonal purple pulse + purple particles           (+ pulsing light, desktop)
//   Exotic     alternating lime/red pulse + particles + tween  (+ pulsing light, desktop)
// Common/Uncommon get nothing. Mythic/Unique: stopgap re-coloured Exotic kit until their custom designs.
//
// The pulse uses GltfNodeModifiers, which REPLACES a node's material — so it re-supplies
// the plant's real texture/colour/alpha from PLANT_MATERIALS and adds emissive on top.
// It steps through PULSE_LEVELS fixed states and only re-sends on a step change: in the
// Unity explorer every material change restarts that material's (async, throttled) load,
// so a continuous 12 Hz float never finished loading and no pulse was ever visible
// (KJ 2026-09-18). A handful of repeating states become material-cache hits instead.
// Each step is still a main-thread material rebuild, so the step count and period are the
// perf knobs: 3 levels = 4 rebuilds per period (was 8 with 5 levels).
// The Exotic+ sway is a renderer-side looping Tween (was a per-frame Transform write). It is BUDGETED
// like the rest (2026-09-29): the Unity explorer writes every looping-tweened Transform back to the
// scene every frame, and it used to start at attach and run forever at any distance — one
// write-back per Exotic/Mythic/Unique in the whole Rare Plant Gallery and every planter.
// vfxFlags lets the dev test panel switch each effect off live for fps A/B checks.
//
// BUDGET: cost must not grow with the garden. Every BUDGET_MS the flowers are ranked by
// distance to the player and only the nearest few inside VFX_RADIUS_M run each effect
// (separate caps per effect, lower on mobile). A flower leaving the budget drops its
// pulse override (one rebuild back to the GLB's own material) and pauses its emitter.
// =============================================================

import { engine, Entity, Transform, GltfContainer, GltfContainerLoadingState, GltfNodeModifiers, ParticleSystem, Material, MaterialTransparencyMode, LightSource, Tween, TweenSequence, TweenState } from '@dcl/sdk/ecs'
import { Color4, Quaternion } from '@dcl/sdk/math'
import { isMobile } from '@dcl/sdk/platform'
import { SPARKLE_SRC, rarityTierById } from './shared/config'
import { PLANT_MATERIALS, PlantNodeMaterial } from './plantMaterials'

// const enums in @dcl/ecs internals, not re-exported (same as Clean The Club's stinkSystem)
const PSB_ALPHA  = 0
const LS_FINISHED = 4   // LoadingState
const PS_PLAYING = 0
const EF_EASESINE = 6   // EasingFunction
const TL_YOYO     = 1   // TweenLoop
const TS_COMPLETED = 1  // TweenStateStatus

type RGB = { r: number; g: number; b: number }
const GREEN       = { r: 0.204, g: 0.808, b: 0.463 }
const BLUE        = { r: 0.263, g: 0.561, b: 1.000 }
const ICE         = { r: 0.550, g: 0.800, b: 1.000 }
const PURPLE      = { r: 0.631, g: 0.294, b: 0.953 }
const LAVENDER    = { r: 0.860, g: 0.700, b: 1.000 }
const DEEP_PURPLE = { r: 0.380, g: 0.080, b: 0.780 }
const LIME        = { r: 0.608, g: 0.820, b: 0.255 }
const RED         = { r: 1.000, g: 0.200, b: 0.150 }
const MYTHIC_PINK  = { r: 1.000, g: 0.294, b: 0.929 }
const MYTHIC_CREAM = { r: 1.000, g: 0.800, b: 0.960 }
const UNIQUE_GOLD  = { r: 0.996, g: 0.635, b: 0.090 }
const UNIQUE_CREAM = { r: 1.000, g: 0.930, b: 0.700 }

interface Sparkles { colors: [RGB, RGB]; rate: number; max: number; size: [number, number] }
interface TierVfx {
  pulse:     { colors: RGB[]; mode: 'solid' | 'tonal' | 'alternate'; periodS: number; peak: number } | null
  particles: Sparkles | null
  light:     number   // peak LightSource intensity (0 = none); desktop only
  tween:     boolean
}
// TUNING — every number here. Each tier must read as clearly MORE than the one below.
const TIER_VFX: Record<number, TierVfx> = {
  2: { pulse: { colors: [GREEN], mode: 'solid', periodS: 3.0, peak: 3 }, particles: null, light: 0, tween: false },
  3: { pulse: null, particles: { colors: [BLUE, ICE], rate: 2, max: 5, size: [0.25, 0.35] }, light: 0, tween: false },
  4: { pulse: { colors: [DEEP_PURPLE, LAVENDER], mode: 'tonal', periodS: 2.6, peak: 5 }, particles: { colors: [PURPLE, LAVENDER], rate: 2.5, max: 6, size: [0.28, 0.4] }, light: 3_000, tween: false },
  5: { pulse: { colors: [LIME, RED], mode: 'alternate', periodS: 2.2, peak: 7 }, particles: { colors: [LIME, RED], rate: 3, max: 7, size: [0.3, 0.42] }, light: 4_500, tween: true },
  // STOPGAP until the bespoke Mythic/Unique designs exist (KJ 2026-09-19: both now drop):
  // Exotic's full kit, re-coloured, so a Mythic/Unique never looks plainer than an Exotic.
  6: { pulse: { colors: [MYTHIC_PINK, MYTHIC_CREAM], mode: 'tonal', periodS: 2.0, peak: 7 }, particles: { colors: [MYTHIC_PINK, MYTHIC_CREAM], rate: 3.5, max: 8, size: [0.3, 0.45] }, light: 4_500, tween: true },
  7: { pulse: { colors: [UNIQUE_GOLD, UNIQUE_CREAM], mode: 'tonal', periodS: 2.4, peak: 8 }, particles: { colors: [UNIQUE_GOLD, UNIQUE_CREAM], rate: 4, max: 9, size: [0.35, 0.5] }, light: 5_000, tween: true },
}

// ── Seedlings (growing stage) — KJ's table, seedling column (RARITY_TIERS.seedVfx):
// Rare green · Epic blue · Legendary purple · Exotic RED · Mythic pink · Unique gold pulse;
// Common/Uncommon none. The seedling GLB's one node 'Seedling' has an UNTEXTURED
// material, so each pulse step is a colour-only rebuild (no texture reload).
const PINK = { r: 1.000, g: 0.294, b: 0.929 }
const GOLD = { r: 0.996, g: 0.635, b: 0.090 }
const SEEDLING_PULSE: Record<number, RGB> = { 2: GREEN, 3: BLUE, 4: PURPLE, 5: RED, 6: PINK, 7: GOLD }
const SEEDLING_PERIOD_S = 2.6   // TUNING — gentler than the opened flowers
const SEEDLING_PEAK     = 2.5   // TUNING

const PULSE_LEVELS    = 3      // cached material states per colour (0 = no emissive) — each step = one material rebuild
const SPARKLE_RADIUS  = 0.38   // m — emitter sphere around the plant
const SPARKLE_Y       = 0.30   // m above the soil — roughly the middle of a 0.55 m plant
const LIGHT_Y         = 0.45   // m above the soil
const TWEEN_YAW_DEG   = 18     // Exotic: sway, not a spin (off-centre model origins would orbit)
const TWEEN_YAW_S     = 6

// TUNING — the per-device budget
const MOBILE          = isMobile()
const VFX_RADIUS_M    = 12
const MAX_PULSING     = MOBILE ? 4 : 8
const MAX_EMITTERS    = MOBILE ? 3 : 6
const MAX_LIGHTS      = 2               // desktop only (no lights on mobile at all)
const MAX_SWAYING     = MOBILE ? 3 : 6  // looping Tweens = per-frame write-back, so they are capped too
const BUDGET_MS       = 500
const HYSTERESIS_M    = 1.5             // an effect already running ranks this much closer — no flip-flop at the edge

/** Dev A/B switches (test panel). Runtime only; production keeps everything on. */
export const vfxFlags = { pulse: true, particles: true, lights: true }

interface Active {
  key:       string
  plant:     Entity
  mats:      ReadonlyArray<PlantNodeMaterial>
  def:       TierVfx
  emitter:   Entity | null
  light:     Entity | null
  phase:     number
  sentKey:   string   // last pulse state sent — re-send only when it changes
  staticTint: boolean // seedlings: keep the tier tint on even when not pulsing (colour-only, one write)
  soil:      { x: number; z: number }
  inPulse:   boolean  // inside the budget for each effect
  inEmit:    boolean
  inLight:   boolean
  inSway:    boolean
  baseRot:   Quaternion.MutableQuaternion | null   // Exotic+: the resting rotation the sway swings around (null = no sway)
}
const active = new Map<string, Active>()

/** Start the tier's effects on a just-created flower entity. Safe to call repeatedly. */
export function attachPlantVfx(key: string, plant: Entity, speciesId: string, tier: number, soil: { x: number; y: number; z: number }): void {
  detachPlantVfx(key)
  const def = TIER_VFX[tier]
  if (!def) return
  let emitter: Entity | null = null
  if (def.particles) {
    const p = def.particles, [a, b] = p.colors
    emitter = engine.addEntity()
    Transform.create(emitter, { position: { x: soil.x, y: soil.y + SPARKLE_Y, z: soil.z } })
    ParticleSystem.create(emitter, {
      shape: ParticleSystem.Shape.Sphere({ radius: SPARKLE_RADIUS }),
      // KJ 2026-09-19: "too small and heavy" — was 30–70 tiny additive particles/s (up to 180
      // alive per flower). Now a few LARGE glints that swell then fade, alpha-blended so they
      // read on the bright garden. Cheap enough that mobile keeps the full count.
      rate: p.rate, maxParticles: p.max, lifetime: 2.0,
      gravity: 0, additionalForce: { x: 0, y: 0.18, z: 0 },
      initialVelocitySpeed: { start: 0, end: 0.08 },
      initialSize: { start: p.size[0], end: p.size[1] }, sizeOverTime: { start: 0.4, end: 1 },
      initialColor: { start: Color4.create(a.r, a.g, a.b, 1), end: Color4.create(b.r, b.g, b.b, 1) },
      colorOverTime: { start: Color4.create(1, 1, 1, 1), end: Color4.create(1, 1, 1, 0) },
      texture: { src: SPARKLE_SRC }, billboard: true, blendMode: PSB_ALPHA,
      loop: true, prewarm: false, active: false, playbackState: PS_PLAYING,   // budget pass switches it on; prewarm simulated a full lifetime on the spawn frame
    })
  }
  // Real light is desktop-only for the same reason as the moonlight: godot-explorer's
  // LightSource flicker bug (#2868) on mobile.
  let light: Entity | null = null
  if (def.light > 0 && !isMobile()) {
    light = engine.addEntity()
    Transform.create(light, { position: { x: soil.x, y: soil.y + LIGHT_Y, z: soil.z } })
    const c = def.pulse?.colors[0] ?? { r: 1, g: 1, b: 1 }
    LightSource.create(light, { active: false, color: c, intensity: 0, shadow: false, type: { $case: 'point', point: {} } })
  }
  active.set(key, {
    key, plant, emitter, light, def,
    mats: PLANT_MATERIALS[speciesId] ?? [],
    phase: Math.random() * 10,
    sentKey: '',
    staticTint: false,
    soil: { x: soil.x, z: soil.z },
    inPulse: false, inEmit: false, inLight: false, inSway: false,
    baseRot: def.tween ? restingRotation(plant) : null,
  })
  budgetAccumMs = BUDGET_MS   // rank the newcomer on the next frame (the sway starts there, if it makes the budget)
}

/** A copy of the flower's rotation as placed — what the sway swings around and returns to. */
function restingRotation(plant: Entity): Quaternion.MutableQuaternion {
  const q = Transform.get(plant).rotation
  return Quaternion.create(q.x, q.y, q.z, q.w)
}

/** Sway −yaw → +yaw → back, sine-eased, looping in the renderer — only while in the budget. */
function setSway(a: Active, on: boolean): void {
  if (a.baseRot === null || a.inSway === on) return
  if (on) {
    // An entity runs ONE Tween. A flower that has just opened is still popping in (boxSystem's
    // scale Tween, same frame as this attach): starting the sway now would replace it mid-grow
    // and leave the flower part-sized. Wait until it has finished — the next rebudget retries.
    const other = Tween.getOrNull(a.plant)
    if (other && other.mode?.$case !== 'rotate' && TweenState.getOrNull(a.plant)?.state !== TS_COMPLETED) return
    const half = TWEEN_YAW_S * 500
    const l = Quaternion.multiply(a.baseRot, Quaternion.fromEulerDegrees(0, -TWEEN_YAW_DEG, 0))
    const r = Quaternion.multiply(a.baseRot, Quaternion.fromEulerDegrees(0, TWEEN_YAW_DEG, 0))
    Tween.createOrReplace(a.plant, { duration: half, easingFunction: EF_EASESINE, mode: { $case: 'rotate', rotate: { start: l, end: r } } })
    TweenSequence.createOrReplace(a.plant, { sequence: [], loop: TL_YOYO })
  } else {
    // Stop the loop and put the flower back to rest: the write-back has left the scene's copy
    // of its rotation wherever the sway happened to be.
    if (Tween.has(a.plant)) Tween.deleteFrom(a.plant)
    if (TweenSequence.has(a.plant)) TweenSequence.deleteFrom(a.plant)
    const t = Transform.getMutableOrNull(a.plant)
    if (t) t.rotation = a.baseRot
  }
  a.inSway = on
}

/** Test panel: switch one effect family on/off on every live flower. */
export function setVfxFlag(name: keyof typeof vfxFlags, on: boolean): void {
  vfxFlags[name] = on
  for (const a of active.values()) {
    if (name === 'particles' && a.emitter !== null) ParticleSystem.getMutable(a.emitter).active = on && a.inEmit
    if (name === 'lights' && a.light !== null) LightSource.getMutable(a.light).active = on && a.inLight
    if (name === 'pulse') {
      a.sentKey = ''
      if (!on && !a.staticTint && GltfNodeModifiers.has(a.plant)) GltfNodeModifiers.deleteFrom(a.plant)   // seedlings keep their tint
    }
  }
}

/** Seedling leaf tint for a tier: the rarity colour lifted 20% toward white so it reads as
 *  a leaf. Only two tints are BAKED (seedling_normal / seedling_rare = pale gold), so every tier
 *  above Common looked gold — a Mythic seedling was yellow, not pink (KJ 2026-09-19). */
function seedlingTint(tier: number): [number, number, number, number] {
  const c = rarityTierById(tier).seedColor, w = 0.2
  return [c.r + (1 - c.r) * w, c.g + (1 - c.g) * w, c.b + (1 - c.b) * w, 1]
}

/** Growing seedling: tier TINT always (tier 1+), plus its tier's pulse (2+) when in the budget;
 *  no particles/light (seedling column of KJ's table). The seedling GLB is one untextured,
 *  single-shell material ('Seedling'), so the override is a safe colour-only rebuild. */
export function attachSeedlingVfx(key: string, seedling: Entity, tier: number): void {
  const soil = Transform.getOrNull(seedling)?.position ?? { x: 0, y: 0, z: 0 }
  detachPlantVfx(key)
  if (tier <= 0) return   // Common: the baked green seedling_normal is its look
  const color = SEEDLING_PULSE[tier]
  active.set(key, {
    key, plant: seedling, emitter: null, light: null,
    def: { pulse: color ? { colors: [color], mode: 'solid', periodS: SEEDLING_PERIOD_S, peak: SEEDLING_PEAK } : null, particles: null, light: 0, tween: false },
    mats: [{ path: 'Seedling', color: seedlingTint(tier), blend: false, metallic: 0, roughness: 0.9 }],
    phase: Math.random() * 10,
    sentKey: '',
    staticTint: true,
    soil: { x: soil.x, z: soil.z },
    inPulse: false, inEmit: false, inLight: false, inSway: false, baseRot: null,
  })
  budgetAccumMs = BUDGET_MS
}

/** A keepsake shown in a gardener's hand (2026-09-28: "held plant is missing its rarity
 *  vfx"). Tier pulse/tint only, same as attachSeedlingVfx and for the same reason: the
 *  particle emitter and light are positioned once in world space at `soil` and never
 *  move — fine for a planted flower, but a held item walks away from that point with the
 *  player. staticTint (see applyPulse) already degrades gracefully outside the pulse
 *  budget to a flat tint rather than a light/emitter left floating behind. */
export function attachHeldFlowerVfx(key: string, entity: Entity, speciesId: string, tier: number): void {
  const soil = Transform.getOrNull(entity)?.position ?? { x: 0, y: 0, z: 0 }
  detachPlantVfx(key)
  const def = TIER_VFX[tier]
  if (!def) return   // Common/Uncommon: no tier vfx at all, same as a planted flower
  active.set(key, {
    key, plant: entity, emitter: null, light: null, def,
    mats: PLANT_MATERIALS[speciesId] ?? [],
    phase: Math.random() * 10,
    sentKey: '',
    staticTint: true,
    soil: { x: soil.x, z: soil.z },
    inPulse: false, inEmit: false, inLight: false, inSway: false, baseRot: null,   // a held item never sways (it walks away from its soil)
  })
  budgetAccumMs = BUDGET_MS
}

/** Remove particles + light; the caller owns the plant entity (its override goes with it). */
export function detachPlantVfx(key: string): void {
  const a = active.get(key)
  if (!a) return
  if (a.emitter !== null) engine.removeEntity(a.emitter)
  if (a.light !== null) engine.removeEntity(a.light)
  if (a.inSway && Transform.has(a.plant)) setSway(a, false)   // re-attach on a living entity must not leave a loop running
  active.delete(key)
}

function lerp(a: RGB, b: RGB, t: number): RGB {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t }
}

function applyPulse(a: Active, now: number): void {
  const p = a.def.pulse
  const pulsing = p !== null && vfxFlags.pulse && a.inPulse
  if (!pulsing && !a.staticTint) return
  let key = 'static', k = 0, color: RGB = { r: 0, g: 0, b: 0 }   // static = tint only, no emissive
  if (pulsing) {
    const t = (now + a.phase) / p.periodS
    const cycle = Math.floor(t)
    const level = Math.round(Math.sin(Math.PI * (t - cycle)) * (PULSE_LEVELS - 1))   // 0 → top → 0; colour swaps at 0
    const colorIdx = p.mode === 'alternate' ? cycle % p.colors.length : 0
    key = `${colorIdx}|${level}`
    k = level / (PULSE_LEVELS - 1)
    color = p.mode === 'tonal' ? lerp(p.colors[0], p.colors[1], k) : p.colors[colorIdx]
  }
  if (key === a.sentKey) return
  a.sentKey = key
  if (a.light !== null) {
    const l = LightSource.getMutable(a.light)
    l.color = color
    l.intensity = a.def.light * (0.25 + 0.75 * k)
  }
  if (a.mats.length === 0) return
  // Only once the renderer has instantiated THIS model (paths resolve against the loaded hierarchy).
  if (GltfContainerLoadingState.getOrNull(a.plant)?.currentState !== LS_FINISHED) { a.sentKey = ''; return }
  if (!GltfNodeModifiers.has(a.plant)) console.log(`[PlantVfx] pulse on ${a.key}: ${GltfContainer.getOrNull(a.plant)?.src ?? '?'} paths=${a.mats.map(m => m.path).join(',')}`)
  GltfNodeModifiers.createOrReplace(a.plant, {
    modifiers: a.mats.map(m => {
      const tex = m.texture ? Material.Texture.Common({ src: m.texture }) : undefined
      return {
        // ONE mesh node → GLOBAL modifier (path ''). The explorer (v0.174, FindRendererByPath) looks
        // a path up under the model's first child; for a single-root model whose mesh sits ON that
        // root there's no scene wrapper, so the first child IS the named node and 'Seedling' is
        // searched for inside 'Seedling' → "GLTF Node path … not found" (the mushroom_brown error),
        // and the seedling tint / 52 of 78 species' pulses silently never applied (KJ 2026-09-19).
        // A global modifier skips the lookup; with one mesh node it's exactly equivalent.
        path: a.mats.length === 1 ? '' : m.path,
        castShadows: false,   // perf pass 2026-10-01: flowers on planters / the Gallery / the table cast no shadow
        material: { material: { $case: 'pbr' as const, pbr: {
          texture: tex,
          emissiveTexture: tex,
          albedoColor: { r: m.color[0], g: m.color[1], b: m.color[2], a: m.color[3] },
          transparencyMode: m.blend ? MaterialTransparencyMode.MTM_ALPHA_BLEND : MaterialTransparencyMode.MTM_OPAQUE,
          metallic: m.metallic,
          roughness: m.roughness,
          emissiveColor: color,
          emissiveIntensity: (p?.peak ?? 0) * k,
        } } },
      }
    }),
  })
}

let budgetAccumMs = 0

/** Pick the nearest flowers inside VFX_RADIUS_M for each effect, up to its cap. */
function rebudget(): void {
  const me = Transform.getOrNull(engine.PlayerEntity)?.position
  if (!me) return
  const ranked = [...active.values()]
    .map(a => ({ a, d: Math.hypot(a.soil.x - me.x, a.soil.z - me.z) }))
    .filter(r => r.d <= VFX_RADIUS_M + HYSTERESIS_M)
  const pick = (want: (a: Active) => boolean, was: (a: Active) => boolean, cap: number): Set<Active> =>
    new Set(ranked
      .filter(r => want(r.a) && r.d - (was(r.a) ? HYSTERESIS_M : 0) <= VFX_RADIUS_M)
      .sort((x, y) => (x.d - (was(x.a) ? HYSTERESIS_M : 0)) - (y.d - (was(y.a) ? HYSTERESIS_M : 0)))
      .slice(0, cap)
      .map(r => r.a))
  const pulse = pick(a => a.def.pulse !== null, a => a.inPulse, MAX_PULSING)
  const emit  = pick(a => a.emitter !== null,   a => a.inEmit,  MAX_EMITTERS)
  const light = pick(a => a.light !== null,     a => a.inLight, MAX_LIGHTS)
  const sway  = pick(a => a.baseRot !== null,   a => a.inSway,  MAX_SWAYING)
  for (const a of active.values()) {
    const p = pulse.has(a), e = emit.has(a), l = light.has(a)
    if (a.inPulse && !p && !a.staticTint && GltfNodeModifiers.has(a.plant)) GltfNodeModifiers.deleteFrom(a.plant)   // seedlings fall back to the static tint
    if (a.inPulse !== p) a.sentKey = ''
    if (a.inEmit !== e && a.emitter !== null) ParticleSystem.getMutable(a.emitter).active = e && vfxFlags.particles
    if (a.inLight !== l && a.light !== null) LightSource.getMutable(a.light).active = l && vfxFlags.lights
    a.inPulse = p; a.inEmit = e; a.inLight = l
    setSway(a, sway.has(a))
  }
}

function plantVfxSystem(dt: number): void {
  if (active.size === 0) return
  budgetAccumMs += dt * 1000
  if (budgetAccumMs >= BUDGET_MS) { budgetAccumMs = 0; rebudget() }
  const now = Date.now() / 1000
  for (const a of active.values()) applyPulse(a, now)
}

let started = false
export function setupPlantVfx(): void {
  if (started) return
  started = true
  engine.addSystem(plantVfxSystem)
}
