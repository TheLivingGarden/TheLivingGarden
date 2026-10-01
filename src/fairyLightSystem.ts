// =============================================================
// The Living Garden — Fairy Light System
//
// ONE model (FairyLights_1_High — the fairy and trellis strings consolidated, KJ 2026-10-01) whose emission emissiveGlow.ts sets.
//
// KJ 2026-10-01: "they tween constantly — only tween them during the bloom and just have a soft glow the rest of the time". So:
//   - the rest of the time (including the pre-bloom build-up) they hold ONE steady soft glow: a single write, then nothing;
//   - during a bloom they twinkle between Low / Mid / High, slowly and eased. Every step is a material re-apply across the whole model
//     (46 primitives), so the twinkle is a few steps a second at most, not the old 80 ms flicker.
//   - when the bloom ends they ease back to the soft glow and stop.
// =============================================================

import { engine, timers } from '@dcl/sdk/ecs'
import { Glow, makeGlow, setGlowTarget, snapGlow } from './emissiveGlow'

// ── Bloom twinkle ─────────────────────────────────────────────
const BLOOM_WEIGHTS = [0.22, 0.33, 0.45]   // [Low, Mid, High] probability
const BLOOM_MIN_MS  = 700
const BLOOM_MAX_MS  = 1_800
const TAU_BLOOM     = 0.3     // ease time constant, seconds
const TAU_SETTLE    = 0.8     // easing back to the soft glow when the bloom ends

// ── The model ─────────────────────────────────────────────────
const MODEL_ENTITY = 'FairyLights_1_High.glb'   // the composite entity name

// As exported (read from the GLB): all materials are base 0.8/0.3/0, emissive 1/0.342/0, glTF emissive strength 1.5.
const LOOK = { color: { r: 1, g: 0.342, b: 0 }, albedo: { r: 0.8, g: 0.3, b: 0 }, metallic: 0, roughness: 0.5, unit: 1.5, step: 0.06 }
const LEVEL_FRACTION: [number, number, number] = [1 / 3, 2 / 3, 1]   // Low, Mid, High of the model's full emission
const SOFT_GLOW = 0.6   // TUNING — the resting glow, as a fraction of the model's full emission

type Level = 0 | 1 | 2   // 0 = Low, 1 = Mid, 2 = High

let glow: Glow | null = null
let twinkleGen = 0
let current: Level = 1

function rnd(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function weightedPick(weights: number[]): Level {
  const r = Math.random()
  let acc = 0
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i]
    if (r < acc) return i as Level
  }
  return 2
}

function scheduleNext(gen: number, delayMs: number): void {
  timers.setTimeout(() => {
    if (twinkleGen !== gen || glow === null) return   // the bloom ended (or a newer one started)
    // Re-roll once if we'd pick the same level — ensures a visible change each step
    let next = weightedPick(BLOOM_WEIGHTS)
    if (next === current) next = weightedPick(BLOOM_WEIGHTS)
    current = next
    setGlowTarget(glow, LEVEL_FRACTION[next], TAU_BLOOM)
    scheduleNext(gen, rnd(BLOOM_MIN_MS, BLOOM_MAX_MS))
  }, delayMs)
}

// ── Public API ────────────────────────────────────────────────

/** Call once at scene startup. */
export function setupFairyLights(): void {
  const entity = engine.getEntityOrNullByName(MODEL_ENTITY)
  if (!entity) {
    console.log(`[FairyLights] no "${MODEL_ENTITY}" entity in the composite — skipping`)
    return
  }
  glow = makeGlow(entity, LOOK, 1, TAU_BLOOM)
  snapGlow(glow, SOFT_GLOW)   // the resting glow, written once as soon as the model has loaded
  console.log('[FairyLights] Ready — one consolidated model, steady soft glow')
}

/** Bloom on: twinkle (slow and eased). Bloom off: ease back to the steady soft glow and stop. */
export function setFairyLightsBloom(active: boolean): void {
  twinkleGen++
  if (glow === null) return
  if (active) {
    current = 2
    setGlowTarget(glow, LEVEL_FRACTION[2], TAU_BLOOM)
    scheduleNext(twinkleGen, rnd(BLOOM_MIN_MS, BLOOM_MAX_MS))
  } else {
    setGlowTarget(glow, SOFT_GLOW, TAU_SETTLE)
  }
}

/** The pre-bloom build-up no longer changes the fairy lights (they only move during the bloom itself). Kept so callers need no change. */
export function setFairyLightsPreboom(_active: boolean): void { /* intentionally nothing */ }
