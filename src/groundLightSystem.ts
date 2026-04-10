// =============================================================
// The Living Garden — Ground / Lamppost / Circle Light System
//
// Three logical light groups, each with Low / Mid / High GLB
// variants. Only one variant is visible at a time per group.
// Lampposts have 4 physical sets but always share one level.
//
// States
// ──────
//  static   — lights are frozen at their base level (no flicker)
//  normal   — gentle slow flicker, triggered by first watering
//  burst    — fast dramatic flicker for BURST_DURATION_MS after
//             any watering event, then drops back to normal
//  bloom    — all groups → HIGH, fast magical twinkle
//
// Health thresholds (circle escalation)
// ──────────────────────────────────────
//  > 20%  : Circle1 → MID
//  > 50%  : Circle1 → HIGH, Circle2 → MID
//  > 80%  : Circle1 → HIGH, Circle2 → HIGH, Circle3 → MID
// =============================================================

import { engine, Entity, VisibilityComponent, timers } from '@dcl/sdk/ecs'
import { TOTAL_PLANTS } from './shared/config'

// ── Health thresholds ─────────────────────────────────────────
const THR_LOW  = 0.20   // 20%
const THR_MID  = 0.50   // 50%
const THR_HIGH = 0.80   // 80%

// ── Flicker timing (ms) ───────────────────────────────────────
const NORMAL_MIN_MS      = 500
const NORMAL_MAX_MS      = 2_400
const BURST_MIN_MS       = 55
const BURST_MAX_MS       = 280
const BURST_DURATION_MS  = 1_800   // how long a watering burst lasts
const BLOOM_MIN_MS       = 65
const BLOOM_MAX_MS       = 360

// ── Flicker weights [Low, Mid, High] ─────────────────────────
// Weighted pick biased toward the base level for a natural feel
const W_BASE_LOW:  readonly [number, number, number] = [0.68, 0.26, 0.06]
const W_BASE_MID:  readonly [number, number, number] = [0.14, 0.64, 0.22]
const W_BASE_HIGH: readonly [number, number, number] = [0.05, 0.22, 0.73]
const W_BURST:     readonly [number, number, number] = [0.28, 0.38, 0.34]
const W_BLOOM:     readonly [number, number, number] = [0.08, 0.28, 0.64]

// ── Group definitions ─────────────────────────────────────────
// sets: each entry is [lowName, midName, highName] for one
//       physical set. Lampposts have 4 sets that stay in sync.
// startLevel: -1 = hidden, 0 = Low, 1 = Mid, 2 = High

const GROUP_DEFS: {
  id:         string
  sets:       Array<[string, string, string]>
  startLevel: number
}[] = [
  {
    id: 'ground',
    sets: [['GroundLights_Low', 'GroundLights_Mid', 'GroundLights_High']],
    startLevel: 0,   // starts at Low
  },
  {
    id: 'lamppost',
    sets: [
      ['lamppost_light_low',   'lamppost_light_mid',   'lamppost_light_high'],
      ['lamppost_light_low_2', 'lamppost_light_mid_2', 'lamppost_light_high_2'],
      ['lamppost_light_low_3', 'lamppost_light_mid_3', 'lamppost_light_high_3'],
      ['lamppost_light_low_4', 'lamppost_light_mid_4', 'lamppost_light_high_4'],
    ],
    startLevel: 0,   // starts at Low
  },
  {
    id: 'circle1',
    sets: [['Circle1_Low', 'Circle1_Mid', 'Circle1_High']],
    startLevel: -1,  // hidden until >20%
  },
  {
    id: 'circle2',
    sets: [['Circle2_Low', 'Circle2_Mid', 'Circle2_High']],
    startLevel: -1,  // hidden until >50%
  },
  {
    id: 'circle3',
    sets: [['Circle3_Low', 'Circle3_Mid', 'Circle3_High']],
    startLevel: -1,  // hidden until >80%
  },
]

// ── Types ─────────────────────────────────────────────────────

type FlickerMode = 'static' | 'normal' | 'burst' | 'bloom'

interface Group {
  id:          string
  sets:        Array<[Entity | null, Entity | null, Entity | null]>
  baseLevel:   number   // -1=hidden, 0/1/2 = Low/Mid/High
  current:     number
  flickerMode: FlickerMode
  burstUntil:  number   // timestamp ms — burst expires after this
}

// ── State ─────────────────────────────────────────────────────

const groups: Group[] = []
let globalFlickerMode: FlickerMode = 'static'
let lastHealthRatio = -1

// ── Helpers ───────────────────────────────────────────────────

function rnd(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function weightedPick(w: readonly [number, number, number]): number {
  const r = Math.random()
  if (r < w[0]) return 0
  if (r < w[0] + w[1]) return 1
  return 2
}

function weightsFor(g: Group): readonly [number, number, number] {
  const mode = g.burstUntil > Date.now() ? 'burst' : g.flickerMode
  if (mode === 'bloom')  return W_BLOOM
  if (mode === 'burst')  return W_BURST
  if (g.baseLevel === 1) return W_BASE_MID
  if (g.baseLevel === 2) return W_BASE_HIGH
  return W_BASE_LOW
}

function timingFor(g: Group): [number, number] {
  const mode = g.burstUntil > Date.now() ? 'burst' : g.flickerMode
  if (mode === 'bloom') return [BLOOM_MIN_MS,  BLOOM_MAX_MS]
  if (mode === 'burst') return [BURST_MIN_MS,  BURST_MAX_MS]
  return [NORMAL_MIN_MS, NORMAL_MAX_MS]
}

function applyLevel(g: Group, level: number): void {
  g.current = level
  for (const set of g.sets) {
    for (let i = 0; i < 3; i++) {
      const e = set[i]
      if (e) VisibilityComponent.createOrReplace(e, { visible: level >= 0 && i === level })
    }
  }
}

function scheduleNext(g: Group, delayMs: number): void {
  timers.setTimeout(() => {
    if (g.baseLevel < 0 && g.flickerMode !== 'bloom') {
      // Group is hidden and not in bloom — reschedule but don't show
      scheduleNext(g, rnd(NORMAL_MIN_MS, NORMAL_MAX_MS))
      return
    }

    const w   = weightsFor(g)
    const [minMs, maxMs] = timingFor(g)

    // Pick next level, re-roll once if same (ensures visible change)
    let next = weightedPick(w)
    if (next === g.current) next = weightedPick(w)

    // In bloom: always show something (floor at Low)
    if (g.flickerMode === 'bloom') next = Math.max(0, next)

    applyLevel(g, next)
    scheduleNext(g, rnd(minMs, maxMs))
  }, delayMs)
}

// ── Public API ────────────────────────────────────────────────

/** Call once at scene startup. */
export function setupGroundLights(): void {
  for (const def of GROUP_DEFS) {
    const resolvedSets: Array<[Entity | null, Entity | null, Entity | null]> = []
    let allFound = true

    for (const [lowName, midName, highName] of def.sets) {
      const low  = engine.getEntityOrNullByName(lowName)
      const mid  = engine.getEntityOrNullByName(midName)
      const high = engine.getEntityOrNullByName(highName)
      if (!low && !mid && !high) { allFound = false; break }
      resolvedSets.push([low, mid, high])
    }

    if (!allFound || resolvedSets.length === 0) {
      console.error(`[GroundLights] Missing entities for group "${def.id}" — skipping`)
      continue
    }

    const g: Group = {
      id:          def.id,
      sets:        resolvedSets,
      baseLevel:   def.startLevel,
      current:     def.startLevel,
      flickerMode: 'static',
      burstUntil:  0,
    }
    groups.push(g)

    // Apply initial visibility
    applyLevel(g, def.startLevel)

    // Stagger start slightly so groups don't fire in lockstep
    const stagger = groups.length * 120
    scheduleNext(g, rnd(NORMAL_MIN_MS, NORMAL_MAX_MS) + stagger)
  }

  console.log(`[GroundLights] Ready — ${groups.length}/${GROUP_DEFS.length} groups initialised`)
}

/**
 * Call whenever the watered count changes.
 * Drives circle level escalation and flicker mode transitions.
 */
export function updateGroundLights(wateredCount: number): void {
  const ratio = Math.min(wateredCount / TOTAL_PLANTS, 1)
  if (ratio === lastHealthRatio) return
  lastHealthRatio = ratio

  // Unlock normal flicker mode once any plant is watered
  if (ratio > 0 && globalFlickerMode === 'static') {
    globalFlickerMode = 'normal'
    for (const g of groups) {
      if (g.flickerMode === 'static') g.flickerMode = 'normal'
    }
  }

  // Circle level escalation
  const circle1 = groups.find(g => g.id === 'circle1')
  const circle2 = groups.find(g => g.id === 'circle2')
  const circle3 = groups.find(g => g.id === 'circle3')

  if (circle1) {
    const target = ratio >= THR_MID ? 2 : ratio >= THR_LOW ? 1 : -1
    if (target !== circle1.baseLevel) {
      circle1.baseLevel = target
      applyLevel(circle1, target)
    }
  }
  if (circle2) {
    const target = ratio >= THR_HIGH ? 2 : ratio >= THR_MID ? 1 : -1
    if (target !== circle2.baseLevel) {
      circle2.baseLevel = target
      applyLevel(circle2, target)
    }
  }
  if (circle3) {
    const target = ratio >= THR_HIGH ? 1 : -1
    if (target !== circle3.baseLevel) {
      circle3.baseLevel = target
      applyLevel(circle3, target)
    }
  }
}

/**
 * Call on every watering event (by any player).
 * Triggers a brief burst flicker across all groups.
 */
export function triggerGroundLightBurst(): void {
  if (globalFlickerMode === 'bloom') return   // bloom already handles its own rhythm
  const until = Date.now() + BURST_DURATION_MS
  for (const g of groups) {
    if (g.baseLevel < 0) continue   // don't flash hidden groups
    g.burstUntil = until
  }
}

/**
 * Call when the bloom event fires.
 * All groups switch to HIGH + fast magical twinkle.
 */
export function setGroundLightsBloom(active: boolean): void {
  globalFlickerMode = active ? 'bloom' : 'normal'
  for (const g of groups) {
    g.flickerMode = active ? 'bloom' : 'normal'
    if (active) {
      g.baseLevel = 2   // all groups → High base during bloom
      applyLevel(g, 2)
    }
  }
}
