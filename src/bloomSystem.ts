// =============================================================
// The Living Garden — Bloom Event System (CINEMATIC FIXED)
// =============================================================

import {
  engine,
  Entity,
  AudioSource,
  Animator,
  Transform,
  timers,
} from '@dcl/sdk/ecs'
import { startPetalRain, startPetalSettle } from './petalSystem'
import { showToast } from './notifications'
import { BLOOM_CENTER, BLOOM_UTC_HOUR, BLOOM_UTC_MINUTE } from './shared/config'

// ---------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------

const MUSIC_FADE_IN_MS         = 3_000
const MUSIC_FADE_OUT_MS        = 6_000
const AMBIENT_MAX_VOLUME       = 0.7
const TEST_MODE_BLOOM_DELAY_MS = 10_000

const ANIM_IDLE      = 'CloseIdle'
const ANIM_BLOOM     = 'OpenAction'
const ANIM_OPEN_IDLE = 'OpenIdle'

const BLOOM_ANIM_SPEED        = 0.5
const BLOOM_SWITCH_TO_OPEN_MS = 20_000
const BLOOM_OPEN_POSE_HOLD_MS = 30 * 60 * 1_000

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------

let bloomActive = false
let bloomSoundEntity: Entity | null = null
let ambientSoundEntity: Entity | null = null
let bloomModelEntity: Entity | null = null

let musicFadeState: 'in' | 'out' | 'none' = 'none'
let musicFadeMs = 0

let testMode = false
let customBloomHour: number | null = null

let onResetCallback: () => void = () => {}
let onVisualBloomCallback: () => void = () => {}

let stopPetalCycle: (() => void) | null = null

// ---------------------------------------------------------------
// Petal Cycle (CINEMATIC)
// ---------------------------------------------------------------

function startPetalCycle() {
  let active = true

  function runCycle() {
    if (!active) return

    // 🌸 SPAWN
    startPetalRain()

    // ✨ FLOAT
    const floatTime = 5000 + Math.random() * 2000

    timers.setTimeout(() => {
      if (!active) return

      // 🍃 SETTLE (fall + fade)
      startPetalSettle()

      // ⏳ WAIT FOR CLEANUP
      const settleTime = 5000 + Math.random() * 2000

      timers.setTimeout(() => {
        if (!active) return

        // 🌑 GAP (breathing space)
        const gap = 4000 + Math.random() * 4000

        timers.setTimeout(runCycle, gap)

      }, settleTime)

    }, floatTime)
  }

  runCycle()

  return () => {
    active = false
  }
}

// ---------------------------------------------------------------
// Time Logic
// ---------------------------------------------------------------

function getNextBloomTime(): number {
  if (testMode) return Date.now() + TEST_MODE_BLOOM_DELAY_MS

  const hour = customBloomHour ?? BLOOM_UTC_HOUR
  const now = new Date()
  const target = new Date(now)

  target.setUTCHours(hour, BLOOM_UTC_MINUTE, 0, 0)

  if (now < target) return target.getTime()

  target.setUTCDate(target.getUTCDate() + 1)
  return target.getTime()
}

// ---------------------------------------------------------------
// Visual Bloom
// ---------------------------------------------------------------

function launchVisualBloom() {
  showToast('The Garden is in Full Bloom!', 6000)
  console.log('Bloom visual launched!')

  onVisualBloomCallback()

  // 🌸 start cinematic petals
  stopPetalCycle = startPetalCycle()

  // 🎬 animation
  if (bloomModelEntity) {
    Animator.createOrReplace(bloomModelEntity, {
      states: [
        { clip: ANIM_IDLE, playing: false, loop: true, speed: 1 },
        { clip: ANIM_BLOOM, playing: true, loop: false, speed: BLOOM_ANIM_SPEED },
        { clip: ANIM_OPEN_IDLE, playing: false, loop: true, speed: 1 },
      ],
    })

    timers.setTimeout(() => {
      if (bloomActive && bloomModelEntity) {
        Animator.playSingleAnimation(bloomModelEntity, ANIM_OPEN_IDLE)
        console.log('[BloomSystem] Switched to OpenIdle')
      }
    }, BLOOM_SWITCH_TO_OPEN_MS)
  }

  const msUntilNextBloom = BLOOM_OPEN_POSE_HOLD_MS
  const resetDelay = testMode ? 30000 : 0

  timers.setTimeout(onResetCallback, msUntilNextBloom + resetDelay)
}

// ---------------------------------------------------------------
// Music Fade System
// ---------------------------------------------------------------

export function musicFadeSystem(dt: number): void {
  if (musicFadeState === 'none' || !bloomSoundEntity) return

  musicFadeMs += dt * 1000

  if (musicFadeState === 'in') {
    const p = Math.min(musicFadeMs / MUSIC_FADE_IN_MS, 1)

    AudioSource.getMutable(bloomSoundEntity).volume = p * p

    if (ambientSoundEntity) {
      const r = 1 - p
      AudioSource.getMutable(ambientSoundEntity).volume = AMBIENT_MAX_VOLUME * (r * r)
    }

    if (p >= 1) musicFadeState = 'none'
  }

  else if (musicFadeState === 'out') {
    const p = Math.min(musicFadeMs / MUSIC_FADE_OUT_MS, 1)
    const r = 1 - p

    AudioSource.getMutable(bloomSoundEntity).volume = r * r

    if (ambientSoundEntity) {
      AudioSource.getMutable(ambientSoundEntity).volume = AMBIENT_MAX_VOLUME * (p * p)
    }

    if (p >= 1) {
      AudioSource.createOrReplace(bloomSoundEntity, {
        audioClipUrl: 'assets/scene/Sounds/MagicSound.mp3',
        playing: false,
        loop: false,
        volume: 0,
        pitch: 1,
      })

      if (ambientSoundEntity) {
        AudioSource.getMutable(ambientSoundEntity).volume = AMBIENT_MAX_VOLUME
      }

      musicFadeState = 'none'
    }
  }
}

// ---------------------------------------------------------------
// Setup
// ---------------------------------------------------------------

export function setupBloomSystem(opts: {
  testMode: boolean
  onReset: () => void
  onVisualBloom?: () => void
}): void {
  testMode = opts.testMode
  onResetCallback = opts.onReset
  onVisualBloomCallback = opts.onVisualBloom ?? (() => {})

  ambientSoundEntity = engine.addEntity()
  Transform.create(ambientSoundEntity, { position: BLOOM_CENTER })
  AudioSource.create(ambientSoundEntity, {
    audioClipUrl: 'assets/scene/Sounds/AmbientSound.mp3',
    playing: true,
    loop: true,
    volume: AMBIENT_MAX_VOLUME,
    pitch: 1,
  })

  bloomSoundEntity = engine.addEntity()
  Transform.create(bloomSoundEntity, { position: BLOOM_CENTER })
  AudioSource.create(bloomSoundEntity, {
    audioClipUrl: 'assets/scene/Sounds/MagicSound.mp3',
    playing: false,
    loop: true,
    volume: 1,
    pitch: 1,
  })

  const bloomEnt = engine.getEntityOrNullByName('Bloom')

  if (bloomEnt) {
    bloomModelEntity = bloomEnt

    Animator.createOrReplace(bloomEnt, {
      states: [
        { clip: ANIM_IDLE, playing: true, loop: true, speed: 1 },
        { clip: ANIM_BLOOM, playing: false, loop: false, speed: BLOOM_ANIM_SPEED },
        { clip: ANIM_OPEN_IDLE, playing: false, loop: true, speed: 1 },
      ],
    })
  }
}

// ---------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------

export function triggerBloomEvent(): void {
  if (bloomActive) return

  bloomActive = true

  if (bloomSoundEntity) {
    AudioSource.createOrReplace(bloomSoundEntity, {
      audioClipUrl: 'assets/scene/Sounds/MagicSound.mp3',
      playing: true,
      loop: true,
      volume: 0,
      pitch: 1,
    })

    musicFadeMs = 0
    musicFadeState = 'in'
  }

  timers.setTimeout(launchVisualBloom, MUSIC_FADE_IN_MS)
}

// ---------------------------------------------------------------
// End Bloom
// ---------------------------------------------------------------

export function endBloom(): void {
  bloomActive = false

  if (bloomSoundEntity) {
    musicFadeMs = 0
    musicFadeState = 'out'
  }

  startPetalSettle()

  if (stopPetalCycle) {
    stopPetalCycle()
    stopPetalCycle = null
  }

  if (bloomModelEntity) {
    Animator.playSingleAnimation(bloomModelEntity, ANIM_IDLE)
  }
}

// ---------------------------------------------------------------

export function isBloomActive(): boolean {
  return bloomActive
}

export function setBloomTestMode(val: boolean): void {
  testMode = val
}

export function setCustomBloomHour(hour: number | null): void {
  customBloomHour = hour
}