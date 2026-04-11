// =============================================================
// The Living Garden — Bloom Event Orchestration (CINEMATIC)
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
  updateGroundLights,
} from './groundLightSystem'
import { setFairyLightsBloom, setFairyLightsPreboom } from './fairyLightSystem'
import { startPetalRain } from './petalSystem'
import { endBloomSparkles } from './sparkleSystem'
import { BLOOM_CENTER } from './shared/config'

export const PRE_BLOOM_MS = 5 * 60_000

let preGen = 0
let bloomGen = 0

// =============================================================
// ✨ GLOBAL HELPERS (CINEMATIC FEEL)
// =============================================================

function jitter(ms: number) {
  return ms + (Math.random() * 600 - 300) // ±300ms human feel
}

// 🌸 Petal choreography (NOT constant loop)
function schedulePetalMoments() {
  const timings = [
    3700,
    9000,

    // 👇 IMPORTANT GAP (creates anticipation)
    20000,

    32000,
    47000,
  ]

  timings.forEach((t) => {
    timers.setTimeout(() => {
      const variant = Math.random()

      if (variant < 0.4) {
        startPetalRain()
      } else if (variant < 0.75) {
        startPetalRain()
        timers.setTimeout(startPetalRain, 800)
      } else {
        startPetalRain()
        timers.setTimeout(startPetalRain, 500)
        timers.setTimeout(startPetalRain, 1200)
      }
    }, jitter(t))
  })
}

// ✨ Sparkle “breathing waves”
function triggerSparkleWaves() {
  const waves = [0, 1200, 2600, 4200]

  waves.forEach(delay => {
    timers.setTimeout(() => {
      triggerBloomShockwave()
    }, jitter(delay))
  })
}

// =============================================================
// PRE-BLOOM
// =============================================================

export function startPreBloomEffects(msUntilBloom: number): void {
  preGen++
  const gen = preGen
  const density = Math.random() < 0.5 ? 'calm' : 'intense'

  function at(secBefore: number, fn: () => void): void {
    const delay = msUntilBloom - secBefore * 1000
    if (delay <= 0) return
    timers.setTimeout(() => { if (preGen === gen) fn() }, jitter(delay))
  }

  at(300, () => setFairyLightsPreboom(true))
  at(270, () => triggerGroundRipple(BLOOM_CENTER))
  at(250, () => { triggerGroundRipple(BLOOM_CENTER); triggerGroundLightBurst() })
  at(230, () => triggerGroundRipple(BLOOM_CENTER))

  at(200, () => { triggerGroundRipple(BLOOM_CENTER); triggerGroundLightBurst() })
  at(180, () => triggerGroundRipple(BLOOM_CENTER))
  at(165, () => { triggerGroundLightBurst(); triggerGroundRipple(BLOOM_CENTER) })

  at(120, () => {
    startFireflies()
    triggerGroundLightBurst()
    triggerGroundRipple(BLOOM_CENTER)
  })

  if (density === 'intense') {
    at(105, () => triggerGroundRipple(BLOOM_CENTER))
    at(100, () => triggerGroundLightBurst())
  }

  at(60, () => {
    triggerBloomShockwave()
    triggerGroundLightBurst()
  })

  at(30, () => {
    triggerBloomShockwave()
    triggerGroundRipple(BLOOM_CENTER)
    triggerGroundLightBurst()
  })

  at(10, () => { triggerBloomShockwave(); triggerGroundLightBurst() })
}

export function cancelPreBloom(stopFfx = false): void {
  preGen++
  setFairyLightsPreboom(false)
  if (stopFfx) stopFireflies()
}

// =============================================================
// 🌸 BLOOM PHASES (CINEMATIC)
// =============================================================

export function startBloomPhases(): void {
  cancelPreBloom()
  bloomGen++
  const gen = bloomGen

  function after(sec: number, fn: () => void) {
    timers.setTimeout(() => {
      if (bloomGen === gen) fn()
    }, jitter(sec * 1000))
  }

  let intensity = 0

  function setIntensity(level: number) {
    intensity = level
    if (level === 2) triggerGroundLightBurst()
  }

  function pulse() {
    if (intensity === 0) {
      triggerGroundRipple(BLOOM_CENTER)
    }

    if (intensity === 1) {
      triggerGroundRipple(BLOOM_CENTER)
      if (Math.random() < 0.5) triggerGroundLightBurst()
    }

    if (intensity === 2) {
      triggerGroundLightBurst()

      const r = Math.random()

      if (r < 0.33) {
        triggerBloomShockwave()
      } else if (r < 0.66) {
        triggerBloomShockwave()
        triggerGroundRipple(BLOOM_CENTER)
      } else {
        triggerBloomShockwave()
        triggerBloomShockwave()
      }
    }
  }

  // 🌟 BASE STATE
  setGroundLightsBloom(true)
  setFairyLightsBloom(true)

  // 🌸 PETALS NOW FEEL ALIVE
  schedulePetalMoments()

  // 🌊 INTENSITY FLOW
  after(60, () => setIntensity(1))
  after(120, () => setIntensity(2))
  after(200, () => setIntensity(0))
  after(300, () => setIntensity(1))
  after(480, () => setIntensity(2))

  // 🎬 PHASE 1
  after(0, () => {
    triggerBloomShockwave()
    triggerGroundLightBurst()
  })

  after(12, () => pulse())
  after(28, () => pulse())

  after(55, () => {
    triggerBloomShockwave()
    triggerGroundLightBurst()
  })

  after(75, () => pulse())

  // 🎬 PHASE 2
  after(100, () => pulse())
  after(108, () => pulse())
  after(116, () => pulse())

  after(145, () => pulse())
  after(160, () => pulse())

  after(200, () => pulse())

  after(210, () => {
    const r = Math.random()
    if (r < 0.33) triggerBloomShockwave()
    else if (r < 0.66) triggerGroundLightBurst()
    else triggerGroundRipple(BLOOM_CENTER)
  })

  // 🎬 PHASE 3 (CALM)
  after(250, () => pulse())
  after(290, () => pulse())
  after(320, () => pulse())

  // 🎬 PHASE 4 (BIG MOMENT)
  after(360, () => {
    startPetalRain()

    triggerBloomShockwave()
    triggerBloomShockwave()
    triggerGroundLightBurst()
  })

  after(380, () => pulse())
  after(395, () => pulse())
  after(420, () => pulse())
  after(450, () => pulse())

  // 🎬 FINALE
  after(480, () => pulse())
  after(492, () => pulse())
  after(504, () => pulse())
  after(516, () => pulse())
  after(528, () => pulse())

  // ✨ NEW MAGIC ENDING
  after(535, () => triggerSparkleWaves())
  after(560, () => endBloomSparkles())
}

// =============================================================
// COOLDOWN
// =============================================================

export function startBloomCooldown(): void {
  bloomGen++
  const gen = bloomGen

  function step(secIn: number, fn: () => void): void {
    timers.setTimeout(() => { if (bloomGen === gen) fn() }, jitter(secIn * 1000))
  }

  step(20, () => triggerGroundRipple(BLOOM_CENTER))

  step(90, () => {
    stopFireflies()
    triggerGroundRipple(BLOOM_CENTER)
  })

  step(120, () => {
    setFairyLightsBloom(false)
    triggerGroundRipple(BLOOM_CENTER)
  })

  step(180, () => {
    setGroundLightsBloom(false)
    triggerGroundRipple(BLOOM_CENTER)
  })

  step(300, () => updateGroundLights(0))
}