// =============================================================
// The Living Garden — Fairy Light Flicker System
//
// Four independent strings, each with three brightness GLBs
// (Low / Mid / High). Exactly one GLB is visible per string
// at any time — the others are hidden.
//
//   FairyLights_1   FairyLights_2   (scene strings)
//   TrellisLights_1 TrellisLights_2 (trellis strings)
//
// Flicker is driven entirely by setTimeout chains — zero
// per-frame ECS system overhead.
// =============================================================

import { engine, Entity, VisibilityComponent, timers } from '@dcl/sdk/ecs'

// ── Normal flicker ────────────────────────────────────────────
// Gentle breathing glow: mostly bright with soft occasional dips.
const NORMAL_WEIGHTS = [0.08, 0.27, 0.65]   // [Low, Mid, High] probability
const NORMAL_MIN_MS  = 350
const NORMAL_MAX_MS  = 1_900

// ── Pre-bloom flicker ─────────────────────────────────────────
// Medium shimmer during the 5-min build-up — between normal and full bloom.
const PREBOOM_WEIGHTS = [0.12, 0.30, 0.58]  // [Low, Mid, High] probability
const PREBOOM_MIN_MS  = 180
const PREBOOM_MAX_MS  = 900

// ── Bloom flicker ─────────────────────────────────────────────
// Faster and more dramatic — frequent dips give a magical twinkle.
const BLOOM_WEIGHTS  = [0.22, 0.33, 0.45]   // [Low, Mid, High] probability
const BLOOM_MIN_MS   = 80
const BLOOM_MAX_MS   = 420

// ── String definitions ────────────────────────────────────────
// Each entry is [Low name, Mid name, High name] for one string.

const STRING_DEFS: [string, string, string][] = [
  ['FairyLights_1_Low.glb',   'FairyLights_1_Mid.glb',   'FairyLights_1_High.glb'],
  ['FairyLights_2_Low.glb',   'FairyLights_2_Mid.glb',   'FairyLights_2_High.glb'],
  ['TrellisLights_1_Low.glb', 'TrellisLights_1_Mid.glb', 'TrellisLights_1_High.glb'],
  ['TrellisLights_2_Low.glb', 'TrellisLights_2_Mid.glb', 'TrellisLights_2_High.glb'],
]

// ─────────────────────────────────────────────────────────────

type Level = 0 | 1 | 2   // 0 = Low, 1 = Mid, 2 = High

interface LightString {
  variants: [Entity, Entity, Entity]   // [Low, Mid, High]
  current:  Level
}

const strings: LightString[] = []
let bloomMode   = false
let preboomMode = false

// ── Helpers ───────────────────────────────────────────────────

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

function applyLevel(s: LightString, level: Level): void {
  s.current = level
  for (let i = 0; i < 3; i++) {
    VisibilityComponent.createOrReplace(s.variants[i], { visible: i === level })
  }
}

function scheduleNext(s: LightString, delayMs: number): void {
  timers.setTimeout(() => {
    const weights = bloomMode   ? BLOOM_WEIGHTS   :
                    preboomMode ? PREBOOM_WEIGHTS  : NORMAL_WEIGHTS
    const minMs   = bloomMode   ? BLOOM_MIN_MS    :
                    preboomMode ? PREBOOM_MIN_MS   : NORMAL_MIN_MS
    const maxMs   = bloomMode   ? BLOOM_MAX_MS    :
                    preboomMode ? PREBOOM_MAX_MS   : NORMAL_MAX_MS

    // Re-roll once if we'd pick the same level — ensures a visible change each step
    let next = weightedPick(weights)
    if (next === s.current) next = weightedPick(weights)

    applyLevel(s, next)
    scheduleNext(s, rnd(minMs, maxMs))
  }, delayMs)
}

// ── Public API ────────────────────────────────────────────────

/** Call once at scene startup. */
export function setupFairyLights(): void {
  for (let i = 0; i < STRING_DEFS.length; i++) {
    const [lowName, midName, highName] = STRING_DEFS[i]
    const low  = engine.getEntityOrNullByName(lowName)
    const mid  = engine.getEntityOrNullByName(midName)
    const high = engine.getEntityOrNullByName(highName)

    if (!low || !mid || !high) {
      console.error(`[FairyLights] Missing entities for string ${i + 1} — skipping`)
      continue
    }

    const s: LightString = { variants: [low, mid, high], current: 2 }
    strings.push(s)

    applyLevel(s, 2)  // start at High
    // Stagger starts slightly so strings don't all fire together
    scheduleNext(s, rnd(NORMAL_MIN_MS, NORMAL_MAX_MS) + i * 80)
  }

  console.log(`[FairyLights] Ready — ${strings.length}/${STRING_DEFS.length} strings initialised`)
}

/** Switch to bloom flicker (faster, more magical).
 *  Takes effect on each string's next scheduled timeout. */
export function setFairyLightsBloom(active: boolean): void {
  bloomMode = active
}

/** Switch to pre-bloom shimmer (medium speed — build-up anticipation).
 *  No-op while bloom is active; bloom takes priority. */
export function setFairyLightsPreboom(active: boolean): void {
  preboomMode = active
}
