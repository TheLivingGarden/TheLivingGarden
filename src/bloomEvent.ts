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
// Phase 6: the bloom's FX budget (from bloom scale) caps every intensity call, so a
// solo bloom can never reach the full spectacle; the variant flavours the timeline.
let bloomFxCap: 0|1|2 = 2
let bloomVariantId = 'classic'
export function getBloomVariantId(): string { return bloomVariantId }

// ---------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------

/** ±1 s human feel on any timer. */
function jitter(ms: number): number {
  return Math.max(0, ms + (Math.random() * 2000 - 1000))
}

/** Set intensity — drives audio, lampposts, and accent FX. Capped by the bloom's FX budget. */
function setIntensity(requested: 0|1|2): void {
  const level = (requested > bloomFxCap ? bloomFxCap : requested) as 0|1|2
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
// BLOOM PHASES — every beat is a FRACTION of the real hold time (holdMs), not a fixed
// second count. The hold is bloomSustainMs(gardeners): 20 s solo / 35 s (2) / 50 s (3)
// / 60 s (4+) since the 2026-09-17 decay-rate rework. This file's old schedule assumed
// a ~10-minute event and scheduled its second half — including the ENTIRE moonlit
// finale — at 150–235 s, long after the server had already reset the garden at 20–60 s.
// startBloomCooldown() bumps bloomGen on reset, so those late beats were silently
// no-ops: the true root cause of "moonlight bloom doesn't look any different" (found
// 2026-09-17). Also: the gentle branch (fxLevel 1) never checked variantId at all,
// even though moonlit IS reachable there (exactly 3 gardeners) — it now gets the same
// richer closing beat as the full spectacle, scaled to its shorter window.
// ---------------------------------------------------------------

/** @param fxLevel  0 = quiet solo bloom, 1 = gentle, 2 = full spectacle (bloomFxLevel of the bloom scale)
 *  @param variantId BLOOM_VARIANTS id — 'classic' or a rare flavour
 *  @param holdMs   real time until the server resets the bloom — bloomSustainMs(gardenersPresent)
 *  at the caller. Every beat below is `at(fraction of holdMs)`, clamped short of the end
 *  so nothing fires after the reset has already happened. */
export function startBloomPhases(fxLevel: 0|1|2 = 2, variantId = 'classic', holdMs = 60_000): void {
  cancelPreBloom()          // cancel pre-bloom timers + loops
  bloomGen++
  const gen = bloomGen
  bloomFxCap     = fxLevel
  bloomVariantId = variantId
  const moonlit  = variantId === 'moonlit'

  function at(frac: number, fn: () => void): void {
    const ms = Math.max(0, Math.min(frac * holdMs, holdMs - 1500))
    timers.setTimeout(() => { if (bloomGen === gen) fn() }, jitter(ms))
  }

  // ── Visual baseline (every bloom, even the quiet one) ────────
  // SPREAD over the first ~0.6 s (KJ 2026-10-01): everything used to start on the same tick, a one-frame spike. The lights and the opening
  // shockwave stay at t=0 — they are the "it just happened" beat; the rest follows in quick succession.
  const early = (ms: number, fn: () => void): void => { timers.setTimeout(() => { if (bloomGen === gen) fn() }, ms) }
  setGroundLightsBloom(true)
  setFairyLightsBloom(true)
  early(200, () => { stopLoops(); startLoops() })
  early(400, startFireflies)

  // ── Quiet solo bloom: lights, one soft petal rain, a ripple — no shockwaves.
  // GDD §3 pillar 3: "solo care earns a quiet bloom, group care the full spectacle".
  // Always classic — moonlit needs bloomScale ≥0.75, unreachable at 1 gardener.
  if (fxLevel === 0) {
    setIntensity(0)
    at(0.20, () => triggerGroundRipple(BLOOM_CENTER))
    at(0.60, () => startPetalRain())
    return
  }

  // ── Gentle bloom (2–3 gardeners): opening burst, one mid petal wave, one closing
  // flourish — capped at intensity 1. Moonlit is reachable at exactly 3 gardeners.
  if (fxLevel === 1) {
    setIntensity(1)
    triggerBloomShockwave()
    triggerGroundLightBurst()
    if (moonlit) {
      // Rare variant: a double-crack opening and petals from the first second
      timers.setTimeout(triggerBloomShockwave, jitter(900))
      early(550, startPetalRain)
    }
    at(0.40, () => setIntensity(0))
    at(0.65, () => { setIntensity(1); triggerBloomShockwave(); startPetalRain() })
    at(0.88, () => {
      // Finale: the rare variant gets an extra wave and a second petal pass
      const waves = moonlit ? [0, 400, 900] : [0, 900]
      waves.forEach(d => timers.setTimeout(triggerBloomShockwave, jitter(d)))
      if (moonlit) startPetalRain()
    })
    return
  }

  // ── Full spectacle (4+ gardeners) ─────────────────────────────
  setIntensity(2)
  triggerBloomShockwave()
  triggerGroundLightBurst()
  if (moonlit) {
    // Rare variant: a double-crack opening and petals from the first second
    timers.setTimeout(triggerBloomShockwave, jitter(900))
    early(550, startPetalRain)
  }

  at(0.22, () => setIntensity(1))
  at(0.42, () => {
    setIntensity(2)
    triggerBloomShockwave()
    triggerGroundLightBurst()
    startPetalRain()
    if (moonlit) timers.setTimeout(startPetalRain, 500)
  })
  at(0.62, () => setIntensity(1))
  at(0.80, () => {
    setIntensity(2)
    triggerBloomShockwave()
    triggerGroundLightBurst()
  })
  at(0.90, () => {
    // Finale: the rare variant "erupts over the whole garden" — more waves, gentler spacing
    const waves = moonlit ? [0, 400, 800, 1200] : [0, 700, 1400]
    waves.forEach(d => timers.setTimeout(triggerBloomShockwave, jitter(d)))
    if (moonlit) { startPetalRain(); timers.setTimeout(startPetalRain, 700) }
  })
}

// ---------------------------------------------------------------
// COOLDOWN  (5 minutes after bloom reset)
//   0–60 s    → intensity 1  (gentle wind-down)
//   60–180 s  → intensity 0  (fading out)
//   180–300 s → silence      (all effects off)
// ---------------------------------------------------------------

/** @param getWateredCount live count of currently-watered plants — read at the moment the
 *  post-bloom circle correction fires (60s in), not captured up front, since watering
 *  during the wind-down is allowed and plants watered during the bloom survive it. */
export function startBloomCooldown(getWateredCount: () => number): void {
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

step(60, () => updateGroundLights(getWateredCount()))
}
