// =============================================================
// The Living Garden — Bloom Event Orchestration (Intensity System)
// =============================================================
//
// Single global `bloomIntensity` (0|1|2) drives audio, petals,
// lights, and VFX.  Three phase functions manage the timeline:
//
//   startPreBloomEffects(msUntilBloom)  — 5-min pre-bloom buildup
//   startBloomPhases()                  — 10-min main event
//   startBloomCooldown()                — 5-min wind-down
//
// Intensity levels:
//   0 = calm   — quiet pulse audio, rare petals, gentle ground ripples
//   1 = medium — moderate pulse audio, occasional bursts, mixed FX
//   2 = peak   — full pulse + swell accent, frequent petals, shockwaves
// =============================================================

import { timers } from '@dcl/sdk/ecs'
import {
  triggerBloomShockwave,
  triggerGroundRipple,
  startFireflies,
  stopFireflies,
} from './ambientFX'
import {
  triggerGroundLightBurst,
  setGroundLightsBloom,
  setLamppostLevel,
  setLamppostBloomIntensity,
  updateGroundLights,
} from './groundLightSystem'
import { setFairyLightsBloom, setFairyLightsPreboom } from './fairyLightSystem'
import { startPetalRain } from './petalSystem'
import { endBloomSparkles } from './sparkleSystem'
import { setBloomAudioIntensity, playBloomAudioAccent } from './bloomSystem'
import { BLOOM_CENTER } from './shared/config'

// ---------------------------------------------------------------
// Public constant — used by wateringSystem to know how far ahead to
// start pre-bloom effects.
// ---------------------------------------------------------------
export const PRE_BLOOM_MS = 60_000 // shorter bloom window to match new trigger conditions

// ---------------------------------------------------------------
// Cancellation counters
// ---------------------------------------------------------------
let preGen      = 0
let bloomGen    = 0
let effectLoopGen = 0
let petalLoopGen  = 0

// ---------------------------------------------------------------
// Shared intensity state
// ---------------------------------------------------------------
let bloomIntensity: 0|1|2 = 0

// ---------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------

/** ±1 s human feel on any timer. */
function jitter(ms: number): number {
  return Math.max(0, ms + (Math.random() * 2000 - 1000))
}

/** Set intensity — drives audio, lampposts, and accent FX. */
function setIntensity(level: 0|1|2): void {
  bloomIntensity = level
  setBloomAudioIntensity(level)
  setLamppostBloomIntensity(level)
  if (level === 2) {
    playBloomAudioAccent()
    triggerGroundLightBurst()
  }
}

// ---------------------------------------------------------------
// Effect pulse — behaviour driven by current intensity
// ---------------------------------------------------------------

function pulse(): void {
  if (bloomIntensity === 0) {
    triggerGroundRipple(BLOOM_CENTER)

  } else if (bloomIntensity === 1) {
    triggerGroundRipple(BLOOM_CENTER)
    if (Math.random() < 0.5) triggerGroundLightBurst()

  } else {
    triggerGroundLightBurst()
    const r = Math.random()
    if (r < 0.33) {
      triggerBloomShockwave()
    } else if (r < 0.66) {
      triggerBloomShockwave()
      triggerGroundRipple(BLOOM_CENTER)
    } else {
      triggerBloomShockwave()
      timers.setTimeout(triggerBloomShockwave, 400)
    }
  }
}

// ---------------------------------------------------------------
// Petal burst — frequency driven by current intensity
// ---------------------------------------------------------------

function petalBurst(): void {
  if (bloomIntensity === 0) {
    if (Math.random() < 0.25) startPetalRain()

  } else if (bloomIntensity === 1) {
    startPetalRain()

  } else {
    startPetalRain()
    timers.setTimeout(startPetalRain, 600)
    if (Math.random() < 0.5) timers.setTimeout(startPetalRain, 1400)
  }
}

// ---------------------------------------------------------------
// Self-rescheduling loops (effect pulses + petal bursts)
// ---------------------------------------------------------------

function scheduleNextEffect(gen: number): void {
  const base = bloomIntensity === 2 ?  5_000
             : bloomIntensity === 1 ? 14_000
             :                        22_000
  timers.setTimeout(() => {
    if (effectLoopGen !== gen) return
    pulse()
    scheduleNextEffect(gen)
  }, jitter(base))
}

function scheduleNextPetal(gen: number): void {
  const base = bloomIntensity === 2 ?  5_000
             : bloomIntensity === 1 ? 11_000
             :                        28_000
  timers.setTimeout(() => {
    if (petalLoopGen !== gen) return
    petalBurst()
    scheduleNextPetal(gen)
  }, jitter(base))
}

function startLoops(): void {
  effectLoopGen++
  petalLoopGen++
  scheduleNextEffect(effectLoopGen)
  scheduleNextPetal(petalLoopGen)
}

function stopLoops(): void {
  effectLoopGen++
  petalLoopGen++
}

// ---------------------------------------------------------------
// PRE-BLOOM  (5 minutes before bloom triggers)
//   0–120 s  → intensity 0  (calm awakening)
//   120–240 s → intensity 1  (building tension)
//   240–300 s → intensity 2  (anticipation peak)
// ---------------------------------------------------------------

export function startPreBloomEffects(msUntilBloom: number): void {
  preGen++
  const gen = preGen

  function at(msBefore: number, fn: () => void): void {
    const delay = msUntilBloom - msBefore
    if (delay <= 0) return
    timers.setTimeout(() => { if (preGen === gen) fn() }, jitter(delay))
  }

  // Visual warm-up
  at(300_000, () => setFairyLightsPreboom(true))

  // Start loops at intensity 0 — only once we're inside the 5-min window.
  // If the threshold is crossed hours early, delay until 5 min out so petals
  // and effects don't start immediately.
  stopLoops()     // cancel any stale loops from previous threshold
  const loopDelay = msUntilBloom - PRE_BLOOM_MS
  if (loopDelay <= 0) {
    // Already inside the window — start immediately
    setIntensity(0)
    startLoops()
  } else {
    timers.setTimeout(() => {
      if (preGen !== gen) return
      setIntensity(0)
      startLoops()
    }, loopDelay)
  }
// 40s out → start building
at(40_000, () => {
  setIntensity(1)
  triggerGroundRipple(BLOOM_CENTER)
})

// 20s out → peak anticipation
at(20_000, () => {
  setIntensity(2)
  triggerGroundLightBurst()
})

// 5s out → final hit
at(5_000, () => {
  triggerBloomShockwave()
})

  // Fireflies join ~2 min before
  at(120_000, () => {
    if (preGen !== gen) return
    startFireflies()
  })
}

export function cancelPreBloom(stopFfx = false): void {
  preGen++
  stopLoops()
  setFairyLightsPreboom(false)
  setLamppostLevel(0)   // return lampposts to Low if threshold drops
  if (stopFfx) stopFireflies()
}

// ---------------------------------------------------------------
// BLOOM PHASES  (10-minute main event)
//   0–60 s     → intensity 2  (opening burst)
//   60–180 s   → intensity 1
//   180–240 s  → intensity 0  (mid-event quiet)
//   240–360 s  → intensity 1
//   360–420 s  → intensity 2  (second peak)
//   420–540 s  → intensity 1
//   540–600 s  → intensity 2  (finale)
// ---------------------------------------------------------------

export function startBloomPhases(): void {
  cancelPreBloom()          // cancel pre-bloom timers + loops
  bloomGen++
  const gen = bloomGen

  function after(sec: number, fn: () => void): void {
    timers.setTimeout(() => {
      if (bloomGen !== gen) return
      fn()
    }, jitter(sec * 1000))
  }

  // ── Visual baseline ──────────────────────────────────────────
  setGroundLightsBloom(true)
  setFairyLightsBloom(true)
  startFireflies()

  // ── Opening burst ────────────────────────────────────────────
  setIntensity(2)
  triggerBloomShockwave()
  triggerGroundLightBurst()

  // Restart loops for bloom phase
  stopLoops()
  startLoops()

  // ── Intensity timeline ───────────────────────────────────────
 after( 20, () => setIntensity(1))     // was 60
after( 80, () => setIntensity(0))     // was 180
after(100, () => setIntensity(1))     // was 240

after(150, () => {
  setIntensity(2)
  triggerBloomShockwave()
  triggerGroundLightBurst()
  startPetalRain()
  timers.setTimeout(startPetalRain, 500)
})

after(180, () => setIntensity(1))     // was 420

after(220, () => {
  setIntensity(2)
  triggerBloomShockwave()
  triggerGroundLightBurst()
})
after(230, () => {
  const waves = [0, 800, 1600, 2400]
  waves.forEach(d => timers.setTimeout(triggerBloomShockwave, jitter(d)))
})

after(235, () => endBloomSparkles())
}

// ---------------------------------------------------------------
// COOLDOWN  (5 minutes after bloom reset)
//   0–60 s    → intensity 1  (gentle wind-down)
//   60–180 s  → intensity 0  (fading out)
//   180–300 s → silence      (all effects off)
// ---------------------------------------------------------------

export function startBloomCooldown(): void {
  stopLoops()           // cancel any running bloom loops
  bloomGen++
  const gen = bloomGen

  function step(sec: number, fn: () => void): void {
    timers.setTimeout(() => { if (bloomGen === gen) fn() }, jitter(sec * 1000))
  }

  // Phase 1: gentle wind-down with audio still running
  setIntensity(1)
  step(10, () => triggerGroundRipple(BLOOM_CENTER))
step(20, () => {
  setIntensity(0)
  triggerGroundRipple(BLOOM_CENTER)
})

step(30, () => {
  stopFireflies()
  setFairyLightsBloom(false)
  setGroundLightsBloom(false)
})

step(45, () => {
  setBloomAudioIntensity(0)
  setLamppostLevel(0)
  bloomIntensity = 0
})

step(60, () => updateGroundLights(0))
}
