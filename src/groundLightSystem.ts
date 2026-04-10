// =============================================================
// The Living Garden — Ground / Lamppost / Circle Light System
//
// Each group has up to four GLB variants: Off / Low / Mid / High.
// Only one variant is visible at a time per group.
// Lampposts have 4 physical sets that always share one level.
//
// Levels
// ──────
//  -1 = Off  (visible dark/unlit model — default before watering)
//   0 = Low
//   1 = Mid
//   2 = High
//
// States
// ──────
//  static  — frozen at base level, no flicker (0 plants watered)
//  normal  — gentle slow flicker (first watering onwards)
//  burst   — fast dramatic flicker for BURST_DURATION_MS then → normal
//  bloom   — all groups → High, fast magical twinkle
//
// Health thresholds (circle escalation)
// ──────────────────────────────────────
//  > 20%  : Circle1 → Mid
//  > 50%  : Circle1 → High,  Circle2 → Mid
//  > 80%  : Circle1 → High,  Circle2 → High,  Circle3 → Mid
// =============================================================

import { engine, Entity, VisibilityComponent, timers } from '@dcl/sdk/ecs'
import { TOTAL_PLANTS } from './shared/config'

// ── Health thresholds ─────────────────────────────────────────
const THR_LOW  = 0.20
const THR_MID  = 0.50
const THR_HIGH = 0.80

// ── Flicker timing (ms) ───────────────────────────────────────
const NORMAL_MIN_MS     = 500
const NORMAL_MAX_MS     = 2_400
const BURST_MIN_MS      = 55
const BURST_MAX_MS      = 280
const BURST_DURATION_MS = 1_800
const BLOOM_MIN_MS      = 65
const BLOOM_MAX_MS      = 360

// ── Flicker weights [Low, Mid, High] ─────────────────────────
const W_BASE_LOW:  readonly [number, number, number] = [0.68, 0.26, 0.06]
const W_BASE_MID:  readonly [number, number, number] = [0.14, 0.64, 0.22]
const W_BASE_HIGH: readonly [number, number, number] = [0.05, 0.22, 0.73]
const W_BURST:     readonly [number, number, number] = [0.28, 0.38, 0.34]
const W_BLOOM:     readonly [number, number, number] = [0.08, 0.28, 0.64]

// ── Group definitions ─────────────────────────────────────────
// offName:    entity name for the Off variant (null = no Off model)
// sets:       [lowName, midName, highName] — one entry per physical set
//             (Lampposts have 4 sets that stay in sync)
// startLevel: -1=Off, 0=Low, 1=Mid, 2=High

const GROUP_DEFS: {
  id:         string
  offName:    string | null
  sets:       Array<[string, string, string]>
  startLevel: number
}[] = [
  {
    id:         'ground',
    offName:    'GroundLights_Off',
    sets:       [['GroundLights_Low', 'GroundLights_Mid', 'GroundLights_High']],
    startLevel: -1,   // Off until first watering
  },
  {
    id:         'lamppost',
    offName:    null,  // no Off variant — lampposts always on at Low
    sets: [
      ['lamppost_light_low',   'lamppost_light_mid',   'lamppost_light_high'],
      ['lamppost_light_low_2', 'lamppost_light_mid_2', 'lamppost_light_high_2'],
      ['lamppost_light_low_3', 'lamppost_light_mid_3', 'lamppost_light_high_3'],
      ['lamppost_light_low_4', 'lamppost_light_mid_4', 'lamppost_light_high_4'],
    ],
    startLevel: 0,    // Low from the start
  },
  {
    id:         'circle1',
    offName:    'Circle1_Off',
    sets:       [['Circle1_Low', 'Circle1_Mid', 'Circle1_High']],
    startLevel: -1,   // Off until > 20%
  },
  {
    id:         'circle2',
    offName:    'Circle2_Off',
    sets:       [['Circle2_Low', 'Circle2_Mid', 'Circle2_High']],
    startLevel: -1,   // Off until > 50%
  },
  {
    id:         'circle3',
    offName:    'Circle3_Off',
    sets:       [['Circle3_Low', 'Circle3_Mid', 'Circle3_High']],
    startLevel: -1,   // Off until > 80%
  },
]

// ── Types ─────────────────────────────────────────────────────

type FlickerMode = 'static' | 'normal' | 'burst' | 'bloom'

interface GroupSet {
  off:  Entity | null
  low:  Entity | null
  mid:  Entity | null
  high: Entity | null
}

interface Group {
  id:          string
  sets:        GroupSet[]
  baseLevel:   number      // -1=Off, 0=Low, 1=Mid, 2=High
  minLevel:    number      // floor for flicker — once set to 0, Off is never shown again
  current:     number
  flickerMode: FlickerMode
  burstUntil:  number      // timestamp ms
  gen:         number      // increment to cancel all pending timers for this group
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
  if (mode === 'bloom') return [BLOOM_MIN_MS, BLOOM_MAX_MS]
  if (mode === 'burst') return [BURST_MIN_MS, BURST_MAX_MS]
  return [NORMAL_MIN_MS, NORMAL_MAX_MS]
}

/** Show exactly one variant across all sets. level: -1=Off, 0=Low, 1=Mid, 2=High */
function applyLevel(g: Group, level: number): void {
  g.current = level
  for (const s of g.sets) {
    if (s.off)  VisibilityComponent.createOrReplace(s.off,  { visible: level === -1 })
    if (s.low)  VisibilityComponent.createOrReplace(s.low,  { visible: level ===  0 })
    if (s.mid)  VisibilityComponent.createOrReplace(s.mid,  { visible: level ===  1 })
    if (s.high) VisibilityComponent.createOrReplace(s.high, { visible: level ===  2 })
  }
}

function scheduleNext(g: Group, delayMs: number): void {
  const myGen = g.gen   // capture — stale timers self-exit when gen changes
  timers.setTimeout(() => {
    if (g.gen !== myGen) return   // cancelled — a newer chain is running

    // Group is Off and locked there (no flicker yet) — idle reschedule
    if (g.baseLevel === -1 && g.flickerMode !== 'bloom') {
      scheduleNext(g, rnd(NORMAL_MIN_MS, NORMAL_MAX_MS))
      return
    }

    const w = weightsFor(g)
    const [minMs, maxMs] = timingFor(g)

    let next = weightedPick(w)
    if (next === g.current) next = weightedPick(w)

    // Apply floor: never show Off if minLevel says so, never go below Low in bloom
    if (g.flickerMode === 'bloom') next = Math.max(0, next)
    else                           next = Math.max(g.minLevel, next)

    applyLevel(g, next)
    scheduleNext(g, rnd(minMs, maxMs))
  }, delayMs)
}

// ── Public API ────────────────────────────────────────────────

export function setupGroundLights(): void {
  for (const def of GROUP_DEFS) {
    const resolvedSets: GroupSet[] = []

    // Resolve Off entity (shared across all sets in this group)
    const offEntity = def.offName ? engine.getEntityOrNullByName(def.offName) : null

    for (const [lowName, midName, highName] of def.sets) {
      const low  = engine.getEntityOrNullByName(lowName)
      const mid  = engine.getEntityOrNullByName(midName)
      const high = engine.getEntityOrNullByName(highName)
      if (!low && !mid && !high) {
        console.error(`[GroundLights] Missing entities for group "${def.id}" — skipping`)
        break
      }
      resolvedSets.push({ off: offEntity, low, mid, high })
    }

    if (resolvedSets.length === 0) continue

    const g: Group = {
      id:          def.id,
      sets:        resolvedSets,
      baseLevel:   def.startLevel,
      minLevel:    -1,   // no floor yet — Off is allowed
      current:     def.startLevel,
      flickerMode: 'static',
      burstUntil:  0,
      gen:         0,
    }
    groups.push(g)

    applyLevel(g, def.startLevel)

    const stagger = groups.length * 120
    scheduleNext(g, rnd(NORMAL_MIN_MS, NORMAL_MAX_MS) + stagger)
  }

  console.log(`[GroundLights] Ready — ${groups.length}/${GROUP_DEFS.length} groups initialised`)
}

/**
 * Call whenever the watered count changes.
 * Transitions ground lights from Off → Low on first watering,
 * and escalates circle levels at health thresholds.
 */
export function updateGroundLights(wateredCount: number): void {
  const ratio = Math.min(wateredCount / TOTAL_PLANTS, 1)
  if (ratio === lastHealthRatio) return
  lastHealthRatio = ratio

  // First watering — unlock normal flicker and lift ground lights Off → Low
  if (ratio > 0 && globalFlickerMode === 'static') {
    globalFlickerMode = 'normal'
    for (const g of groups) {
      g.flickerMode = 'normal'
      if (g.id === 'ground' && g.baseLevel === -1) {
        g.baseLevel = 0
        applyLevel(g, 0)
        g.gen++   // cancel idle chain, restart as flickering Low
        scheduleNext(g, rnd(NORMAL_MIN_MS, NORMAL_MAX_MS))
      }
    }
  }

  // Circle escalation
  const ground  = groups.find(g => g.id === 'ground')
  const circle1 = groups.find(g => g.id === 'circle1')
  const circle2 = groups.find(g => g.id === 'circle2')
  const circle3 = groups.find(g => g.id === 'circle3')

  if (circle1) {
    const target = ratio >= THR_MID ? 2 : ratio >= THR_LOW ? 1 : -1
    if (target !== circle1.baseLevel) { circle1.baseLevel = target; applyLevel(circle1, target) }

    // Once circle1 reaches Low or above, ground lights can no longer show Off
    if (target >= 0 && ground && ground.minLevel < 0) {
      ground.minLevel = 0
      // If ground is currently showing Off, snap it to Low immediately
      if (ground.current === -1) {
        ground.baseLevel = 0
        applyLevel(ground, 0)
        ground.gen++   // cancel the idle Off chain, restart at Low
        scheduleNext(ground, rnd(NORMAL_MIN_MS, NORMAL_MAX_MS))
      }
    }
  }
  if (circle2) {
    const target = ratio >= THR_HIGH ? 2 : ratio >= THR_MID ? 1 : -1
    if (target !== circle2.baseLevel) { circle2.baseLevel = target; applyLevel(circle2, target) }
  }
  if (circle3) {
    const target = ratio >= THR_HIGH ? 1 : -1
    if (target !== circle3.baseLevel) { circle3.baseLevel = target; applyLevel(circle3, target) }
  }
}

/**
 * Call on every watering event (by any player).
 * Triggers a brief burst flicker across all active groups.
 */
export function triggerGroundLightBurst(): void {
  if (globalFlickerMode === 'bloom') return
  const until = Date.now() + BURST_DURATION_MS
  for (const g of groups) {
    if (g.baseLevel === -1) continue   // don't burst Off groups
    g.burstUntil = until
  }
}

/**
 * Call when the bloom event fires / resets.
 * Bloom: all groups → High, fast magical twinkle.
 * Reset: restore Off states, flicker continues as normal.
 */
export function setGroundLightsBloom(active: boolean): void {
  globalFlickerMode = active ? 'bloom' : 'normal'
  for (const g of groups) {
    g.flickerMode = active ? 'bloom' : 'normal'
    g.gen++   // cancel any in-flight timer chain for this group
    if (active) {
      g.baseLevel = 2
      applyLevel(g, 2)
    }
    scheduleNext(g, rnd(active ? BLOOM_MIN_MS : NORMAL_MIN_MS, active ? BLOOM_MAX_MS : NORMAL_MAX_MS))
  }
}
