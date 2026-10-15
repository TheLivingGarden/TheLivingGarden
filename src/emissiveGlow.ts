// =============================================================
// Bloom Garden v2 — emission tween for a single glowing model (CLIENT ONLY)
//
// KJ 2026-10-01: instead of exporting a Low / Mid / High model per light and swapping their visibility, export ONE (the brightest) and let
// code set how strongly it glows. Used by the ground lights, the three circles and the fairy / trellis lights.
//
// A Glow owns a GltfNodeModifiers override on the model: it REPLACES the model's material (all of it — path '' is the one form that works
// on a single-mesh GLB, see plantVfx), so it only suits models whose meshes share one material look. The material is re-supplied from the
// values the GLB was exported with. At full strength (cur 1) the override is REMOVED, so the light is exactly the exported model.
// =============================================================

import { engine, Entity, GltfNodeModifiers, GltfContainerLoadingState, VisibilityComponent } from '@dcl/sdk/ecs'

const LS_FINISHED = 4   // LoadingState

export interface GlowLook {
  /** The model's emissive colour as exported (the glTF emissiveFactor). */
  color:     { r: number; g: number; b: number }
  /** Its base colour, metallic and roughness — re-supplied because the override replaces the material. */
  albedo:    { r: number; g: number; b: number }
  metallic:  number
  roughness: number
  /** Multiplier from `cur` to emissiveIntensity: the model's glTF emissive strength (1 when it has none; 1.5 for the fairy lights). TUNING. */
  unit:      number
  /** When set, the model is its OWN "off" state too (KJ 2026-10-01: a separate Off export drifted out of date with the redesigned lights): at cur 0 it is
   *  drawn unlit in this base colour / roughness, and both ease to the lit values as `cur` rises. The model stays visible throughout. */
  off?:      { albedo: { r: number; g: number; b: number }; roughness: number }
  /** Smallest change in `cur` that is worth another write (each write re-applies the material to every mesh). */
  step?:     number
}

export interface Glow {
  entity:  Entity
  look:    GlowLook
  cur:     number   // 0..1 of the model's own emission
  from:    number   // where the current fade started
  target:  number
  elapsed: number   // seconds into the current fade
  written: number   // the cur last sent to the renderer (-1 = nothing pending / force a write)
  durS:    number   // how long a fade takes, seconds; 0 = snap
}

const glows: Glow[] = []
let installed = false

/** Start driving `entity`'s emission. `start` is where it begins (1 = full = the model as exported, nothing written). */
export function makeGlow(entity: Entity, look: GlowLook, start = 1, durS = 2): Glow {
  const gl: Glow = { entity, look, cur: start, from: start, target: start, elapsed: 0, written: start >= 0.995 ? start : -1, durS }
  // An own-off model must not flash at full glow while it loads: hidden until its first override has been written.
  if (look.off && start < 0.995) VisibilityComponent.createOrReplace(entity, { visible: false })
  glows.push(gl)
  if (!installed) { installed = true; engine.addSystem(glowSystem, 0, 'glowSystem') }
  return gl
}

/** Fade from wherever it is now to `target`, eased in AND out, over `durS` seconds (or the glow's current fade length). */
export function setGlowTarget(gl: Glow, target: number, durS?: number): void {
  if (durS !== undefined) gl.durS = durS
  if (target === gl.target) return   // already heading there — don't restart the fade
  gl.from = gl.cur
  gl.target = target
  gl.elapsed = 0
}

/** Jump straight to a value (e.g. start dark when lighting up from off). */
export function snapGlow(gl: Glow, value: number): void {
  gl.cur = value
  gl.from = value
  gl.target = value
  gl.written = -1
}

function write(gl: Glow): void {
  // Paths resolve only once the renderer has instantiated THIS model; the next frame tries again.
  if (GltfContainerLoadingState.getOrNull(gl.entity)?.currentState !== LS_FINISHED) return
  if (gl.cur >= 0.995) {
    if (GltfNodeModifiers.has(gl.entity)) GltfNodeModifiers.deleteFrom(gl.entity)   // full strength = the model exactly as exported
  } else {
    const l = gl.look
    const t = gl.cur
    const mix = (a: number, b: number) => (l.off ? a + (b - a) * t : b)   // off colour -> lit colour as it lights
    GltfNodeModifiers.createOrReplace(gl.entity, {
      modifiers: [{
        path: '',
        material: { material: { $case: 'pbr' as const, pbr: {
          albedoColor: { r: mix(l.off?.albedo.r ?? 0, l.albedo.r), g: mix(l.off?.albedo.g ?? 0, l.albedo.g), b: mix(l.off?.albedo.b ?? 0, l.albedo.b), a: 1 },
          metallic: l.metallic, roughness: mix(l.off?.roughness ?? 0, l.roughness),
          emissiveColor: { ...l.color },
          emissiveIntensity: gl.cur * l.unit,
        } } },
      }],
    })
  }
  gl.written = gl.cur
  if (gl.look.off && VisibilityComponent.has(gl.entity)) VisibilityComponent.deleteFrom(gl.entity)   // first write done: safe to show
}

// Week-4 review: "the flicker came across as a glitch or bug". The old ease was exponential — it lurched off at full speed and crept in —
// so every level change read as a jolt. A smoothstep fade starts AND ends gently.
function glowSystem(dt: number): void {
  for (const gl of glows) {
    if (gl.cur === gl.target && gl.written === gl.cur) continue
    gl.elapsed += dt
    const k = gl.durS <= 0 ? 1 : Math.min(1, gl.elapsed / gl.durS)
    gl.cur = k >= 1 ? gl.target : gl.from + (gl.target - gl.from) * k * k * (3 - 2 * k)
    if (gl.written < 0 || gl.cur === gl.target || Math.abs(gl.cur - gl.written) >= (gl.look.step ?? 0.015)) write(gl)
  }
}
