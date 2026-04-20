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
import { startPetalSettle } from './petalSystem'
import { showToast } from './notifications'
import { BLOOM_CENTER, BLOOM_WINDOWS } from './shared/config'

// ---------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------

const BASE_LOOP_VOLUME  = 1.0   // max — boost the audio file itself if more is needed
const PULSE_BASE_VOLUME = 0.45
const SWELL_BASE_VOLUME = 0.85
const TEST_MODE_BLOOM_DELAY_MS = 10_000

const ANIM_IDLE      = 'CloseIdle'
const ANIM_BLOOM     = 'OpenAction'
const ANIM_OPEN_IDLE = 'OpenIdle'
const ANIM_CLOSE     = 'CloseAction'

const BLOOM_ANIM_SPEED        = 0.25
const BLOOM_SWITCH_TO_OPEN_MS = 20_000
const BLOOM_OPEN_POSE_HOLD_MS = 30 * 60 * 1_000
/** How long to let CloseAction play before switching to CloseIdle.
 *  = CloseAction clip length (seconds) / BLOOM_ANIM_SPEED
 *  Tune this if the animation still snaps early: increase until the
 *  flower is fully closed before CloseIdle takes over. */
const CLOSE_ACTION_MS         = 26_000

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------

let bloomActive       = false
let baseLoopEntity:   Entity | null = null   // continuous — plays always
let pulseEntity:      Entity | null = null   // bloom layer 1 — silent until bloom
let swellEntity:      Entity | null = null   // bloom layer 2 — silent until bloom
let bloomModelEntity: Entity | null = null

let testMode = false
let customBloomHour: number | null = null
let closeGen     = 0      // incremented each startBloomClose/triggerBloom — guards the close→idle timer
let closeStarted = false  // idempotency flag — prevents double-playing CloseAction

let onResetCallback: () => void = () => {}
let onVisualBloomCallback: () => void = () => {}

// (petal cycle now driven by bloomEvent.ts intensity system)

// ---------------------------------------------------------------
// Time Logic
// ---------------------------------------------------------------

function getNextBloomTime(): number {
  if (testMode) return Date.now() + TEST_MODE_BLOOM_DELAY_MS

  // Test-panel override: treat customBloomHour as a single one-off window (minute 0)
  if (customBloomHour !== null) {
    const target = new Date()
    target.setUTCHours(customBloomHour, 0, 0, 0)
    if (Date.now() < target.getTime()) return target.getTime()
    target.setUTCDate(target.getUTCDate() + 1)
    return target.getTime()
  }

  // Find the nearest upcoming window across all configured bloom times
  const now = Date.now()
  const d   = new Date(now)
  const y   = d.getUTCFullYear()
  const mo  = d.getUTCMonth()
  const day = d.getUTCDate()
  let nearest = Infinity
  for (const w of BLOOM_WINDOWS) {
    const today    = Date.UTC(y, mo, day,     w.hour, w.minute, 0, 0)
    const tomorrow = Date.UTC(y, mo, day + 1, w.hour, w.minute, 0, 0)
    const t = today > now ? today : tomorrow
    if (t < nearest) nearest = t
  }
  return nearest
}

// ---------------------------------------------------------------
// Visual Bloom
// ---------------------------------------------------------------

function launchVisualBloom() {
  console.log('Bloom visual launched!')

  onVisualBloomCallback()

  // 🎬 animation
  if (bloomModelEntity) {
    Animator.createOrReplace(bloomModelEntity, {
      states: [
        { clip: ANIM_IDLE,      playing: false, loop: true,  speed: 1 },
        { clip: ANIM_BLOOM,     playing: true,  loop: false, speed: BLOOM_ANIM_SPEED },
        { clip: ANIM_OPEN_IDLE, playing: false, loop: true,  speed: 1 },
        { clip: ANIM_CLOSE,     playing: false, loop: false, speed: BLOOM_ANIM_SPEED },
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

// No-op — fade system removed, BaseLoop plays continuously.
// Kept as export so wateringSystem.ts import doesn't need updating.
export function musicFadeSystem(_dt: number): void {}

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

  // Continuous base layer — always playing
  baseLoopEntity = engine.addEntity()
  Transform.create(baseLoopEntity, { position: BLOOM_CENTER })
  AudioSource.create(baseLoopEntity, {
    audioClipUrl: 'assets/scene/Audio/BaseLoop.mp3',
    playing: true,
    loop: true,
    volume: BASE_LOOP_VOLUME,
    pitch: 1,
  })

  // Bloom layers — silent until bloom sequence defines them
  pulseEntity = engine.addEntity()
  Transform.create(pulseEntity, { position: BLOOM_CENTER })
  AudioSource.create(pulseEntity, {
    audioClipUrl: 'assets/scene/Audio/Pulse.mp3',
    playing: false,
    loop: false,
    volume: PULSE_BASE_VOLUME,
    pitch: 1,
  })

  swellEntity = engine.addEntity()
  Transform.create(swellEntity, { position: BLOOM_CENTER })
  AudioSource.create(swellEntity, {
    audioClipUrl: 'assets/scene/Audio/Swell3.mp3',
    playing: false,
    loop: false,
    volume: SWELL_BASE_VOLUME,
    pitch: 1,
  })

  const bloomEnt = engine.getEntityOrNullByName('Bloom')

  if (bloomEnt) {
    bloomModelEntity = bloomEnt

    Animator.createOrReplace(bloomEnt, {
      states: [
        { clip: ANIM_IDLE,      playing: true,  loop: true,  speed: 1 },
        { clip: ANIM_BLOOM,     playing: false, loop: false, speed: BLOOM_ANIM_SPEED },
        { clip: ANIM_OPEN_IDLE, playing: false, loop: true,  speed: 1 },
        { clip: ANIM_CLOSE,     playing: false, loop: false, speed: BLOOM_ANIM_SPEED },
      ],
    })
  }
}

// ---------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------

export function triggerBloomEvent(): void {
  if (bloomActive) return
  bloomActive  = true
  closeStarted = false  // reset so startBloomClose can fire for this new cycle
  closeGen++            // cancel any pending close→idle timer from a previous cycle
  launchVisualBloom()
}

// ---------------------------------------------------------------
// End Bloom
// ---------------------------------------------------------------

/** Start the CloseAction animation immediately. Idempotent — safe to call from both
 *  the client-side reset ticker (proactive, fires at countdown = 0) and endBloom()
 *  (fallback, fires when the server's bloomReset message arrives). Whichever runs
 *  first wins; the second call is a no-op so CloseAction never plays twice. */
export function startBloomClose(): void {
  if (closeStarted) return
  closeStarted = true
  const gen = ++closeGen   // claim this close cycle's generation

  startPetalSettle()

  if (bloomModelEntity) {
    // Re-assert the full animator state including speeds, then play CloseAction.
    // playSingleAnimation alone doesn't guarantee the configured speed is applied,
    // so we use createOrReplace to be explicit.
    Animator.createOrReplace(bloomModelEntity, {
      states: [
        { clip: ANIM_IDLE,      playing: false, loop: true,  speed: 1               },
        { clip: ANIM_BLOOM,     playing: false, loop: false, speed: BLOOM_ANIM_SPEED },
        { clip: ANIM_OPEN_IDLE, playing: false, loop: true,  speed: 1               },
        { clip: ANIM_CLOSE,     playing: true,  loop: false, speed: BLOOM_ANIM_SPEED },
      ],
    })
    console.log('[BloomSystem] Playing CloseAction')

    timers.setTimeout(() => {
      if (gen !== closeGen) return   // superseded by a newer bloom or close cycle
      if (bloomModelEntity) {
        Animator.playSingleAnimation(bloomModelEntity, ANIM_IDLE)
        console.log('[BloomSystem] Switched to CloseIdle')
      }
    }, CLOSE_ACTION_MS)
  }
}

export function endBloom(): void {
  bloomActive = false

  // Stop bloom audio layers
  if (pulseEntity) {
    const src = AudioSource.getMutableOrNull(pulseEntity)
    if (src) { src.playing = false; src.volume = 0 }
  }

  // Start close animation — no-op if the reset ticker already called startBloomClose()
  startBloomClose()
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

// ---------------------------------------------------------------
// Audio Intensity API — called by bloomEvent.ts intensity system
// ---------------------------------------------------------------

const PULSE_VOLUME: Record<0|1|2, number> = { 0: 0, 1: 0.45, 2: 0.85 }

/** Set the looping Pulse layer volume (0 = silence, 1 = medium, 2 = peak). */
export function setBloomAudioIntensity(level: 0|1|2): void {
  if (!pulseEntity) return
  const src = AudioSource.getMutableOrNull(pulseEntity)
  if (!src) return
  if (level === 0) {
    src.playing = false
    src.volume  = 0
  } else {
    src.volume  = PULSE_VOLUME[level]
    src.playing = true
  }
}

/** Fire a one-shot Swell accent (used at intensity 2 moments). */
export function playBloomAudioAccent(): void {
  if (!swellEntity) return
  const src = AudioSource.getMutableOrNull(swellEntity)
  if (!src) return
  src.playing = false
  timers.setTimeout(() => {
    const s = AudioSource.getMutableOrNull(swellEntity!)
    if (s) s.playing = true
  }, 0)
}