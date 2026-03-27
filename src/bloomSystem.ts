// =============================================================
// The Living Garden — Bloom Event System
// =============================================================

import {
  engine,
  Entity,
  AudioSource,
  Animator,
  TextShape,
  Billboard,
  BillboardMode,
  Transform,
  timers,
} from '@dcl/sdk/ecs'
import { startPetalRain, startPetalSettle } from './petalSystem'

// ---------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------

const MUSIC_FADE_IN_MS   = 3_000   // bloom music swells in over 3s, then visuals trigger
const MUSIC_FADE_OUT_MS  = 6_000   // bloom music fades out over 6s
const AMBIENT_MAX_VOLUME = 0.7     // background level for the ambient track
const ANIM_BLOOM         = 'Bloom'

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------

let bloomActive        = false
let bloomSoundEntity:   Entity | null = null
let ambientSoundEntity: Entity | null = null
let bloomModelEntity:   Entity | null = null
let bloomBillboard:     Entity
let musicFadeState: 'in' | 'out' | 'none' = 'none'
let musicFadeMs = 0
let testMode    = false
let customBloomHour: number | null = null   // null = use default schedule
let onResetCallback:       () => void = () => {}
let onVisualBloomCallback: () => void = () => {}

// ---------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------

function getNextBloomTime(): number {
  if (testMode) return Date.now() + 10_000  // bloom fires in 10s

  const hour = customBloomHour ?? 18  // default 6pm UTC
  const now    = new Date()
  const target = new Date(now)
  target.setUTCHours(hour, 0, 0, 0)

  if (now < target) return target.getTime()

  // Past today's target hour — schedule for same time tomorrow
  target.setUTCDate(target.getUTCDate() + 1)
  return target.getTime()
}

function showBloomText(text: string) {
  TextShape.getMutable(bloomBillboard).text = text
}

function launchVisualBloom() {
  showBloomText('The Garden is in Full Bloom!')
  console.log('Bloom visual launched!')

  onVisualBloomCallback()
  // Sparkles travel ~2.2s to reach orbit — petals start 1.5s after they settle
  timers.setTimeout(startPetalRain, 3_700)

  if (bloomModelEntity) {
    Animator.playSingleAnimation(bloomModelEntity, ANIM_BLOOM)
  }

  const msUntilNextBloom = getNextBloomTime() - Date.now()
  const resetDelay = testMode ? 30_000 : 60_000

  if (testMode) {
    console.log(`[TEST] Visual bloom live — reset in ${(msUntilNextBloom + resetDelay) / 1000}s`)
  } else {
    console.log(`Next bloom scheduled in ${Math.round(msUntilNextBloom / 1000 / 60)} minutes`)
  }

  timers.setTimeout(onResetCallback, msUntilNextBloom + resetDelay)
}

// ---------------------------------------------------------------
// Public ECS system — register with engine.addSystem once at startup
// ---------------------------------------------------------------

/** Music/ambient crossfade system — runs every frame, idles when fades are inactive. */
export function musicFadeSystem(dt: number): void {
  if (musicFadeState === 'none' || !bloomSoundEntity) return

  musicFadeMs += dt * 1000

  if (musicFadeState === 'in') {
    const progress = Math.min(musicFadeMs / MUSIC_FADE_IN_MS, 1)
    // Bloom track: ease-in — starts barely audible, swells toward full
    AudioSource.getMutable(bloomSoundEntity).volume = progress * progress
    // Ambient track: inverse — fades out as bloom swells in
    if (ambientSoundEntity) {
      const remaining = 1 - progress
      AudioSource.getMutable(ambientSoundEntity).volume = AMBIENT_MAX_VOLUME * (remaining * remaining)
    }
    if (progress >= 1) musicFadeState = 'none'

  } else if (musicFadeState === 'out') {
    const progress = Math.min(musicFadeMs / MUSIC_FADE_OUT_MS, 1)
    // Bloom track: ease-out — drops quickly then lingers softly
    const remaining = 1 - progress
    AudioSource.getMutable(bloomSoundEntity).volume = remaining * remaining
    // Ambient track: inverse — fades back in as bloom fades out
    if (ambientSoundEntity) {
      AudioSource.getMutable(ambientSoundEntity).volume = AMBIENT_MAX_VOLUME * (progress * progress)
    }
    if (progress >= 1) {
      // Bloom fully silent — stop playback cleanly
      AudioSource.createOrReplace(bloomSoundEntity, {
        audioClipUrl: 'assets/scene/Sounds/MagicSound.mp3',
        playing: false, loop: false, volume: 0, pitch: 1,
      })
      // Ambient back to full volume
      if (ambientSoundEntity) {
        AudioSource.getMutable(ambientSoundEntity).volume = AMBIENT_MAX_VOLUME
      }
      musicFadeState = 'none'
    }
  }
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/** Call once at scene startup — creates all bloom-related entities and registers state. */
export function setupBloomSystem(opts: {
  testMode:       boolean
  onReset:        () => void
  onVisualBloom?: () => void
}): void {
  testMode               = opts.testMode
  onResetCallback        = opts.onReset
  onVisualBloomCallback  = opts.onVisualBloom ?? (() => {})

  // Bloom text billboard — shown when all plants are watered
  bloomBillboard = engine.addEntity()
  Transform.create(bloomBillboard, { position: { x: 6.75, y: 5, z: 24 } })
  TextShape.create(bloomBillboard, { text: '', fontSize: 4 })
  Billboard.create(bloomBillboard, { billboardMode: BillboardMode.BM_Y })

  // Ambient background track — plays from scene load, fades out during bloom
  ambientSoundEntity = engine.addEntity()
  Transform.create(ambientSoundEntity, { position: { x: 6.75, y: 2, z: 24 } })
  AudioSource.create(ambientSoundEntity, {
    audioClipUrl: 'assets/scene/Sounds/AmbientSound.mp3',
    playing: true, loop: true, volume: AMBIENT_MAX_VOLUME, pitch: 1,
  })

  // Bloom music — silent until triggered; Transform at scene centre avoids
  // DCL applying 3-D positional distance/Doppler effects
  bloomSoundEntity = engine.addEntity()
  Transform.create(bloomSoundEntity, { position: { x: 6.75, y: 2, z: 24 } })
  AudioSource.create(bloomSoundEntity, {
    audioClipUrl: 'assets/scene/Sounds/MagicSound.mp3',
    playing: false, loop: true, volume: 1, pitch: 1,
  })

  // Bloom model — separate scene entity with its own Bloom animation clip
  const bloomEnt = engine.getEntityOrNullByName('Bloom')
  if (bloomEnt) {
    bloomModelEntity = bloomEnt
    Animator.createOrReplace(bloomEnt, {
      states: [{ clip: ANIM_BLOOM, playing: false, loop: true }],
    })
  } else {
    console.log('[BloomSystem] Bloom entity not found')
  }

  console.log('[BloomSystem] ready')
}

/** Trigger the bloom sequence — call when all plants are watered. */
export function triggerBloomEvent(): void {
  if (bloomActive) return   // already blooming — ignore duplicate trigger
  bloomActive = true
  console.log('Bloom building — music fade-in starting')

  if (bloomSoundEntity) {
    AudioSource.createOrReplace(bloomSoundEntity, {
      audioClipUrl: 'assets/scene/Sounds/MagicSound.mp3',
      playing: true, loop: true, volume: 0, pitch: 1,
    })
    musicFadeMs    = 0
    musicFadeState = 'in'
  }

  timers.setTimeout(launchVisualBloom, MUSIC_FADE_IN_MS)
}

/** Tear down the bloom — fades music, settles petals, lets model animation finish.
 *  Call from wateringSystem.resetAllPlants at the start of the reset sequence. */
export function endBloom(): void {
  bloomActive = false
  showBloomText('')

  if (bloomSoundEntity) {
    musicFadeMs    = 0
    musicFadeState = 'out'
  }

  startPetalSettle()

  if (bloomModelEntity) {
    // Turn off looping — the current cycle plays through to the end and
    // the model settles on its final frame rather than snapping to a stop.
    Animator.getMutable(bloomModelEntity).states[0].loop = false
  }
}

/** Returns true while the bloom event is active. */
export function isBloomActive(): boolean {
  return bloomActive
}

// ---------------------------------------------------------------
// Runtime setters — used by the test panel
// ---------------------------------------------------------------

/** Switch instant-bloom mode on/off at runtime (mirrors testMode). */
export function setBloomTestMode(val: boolean): void {
  testMode = val
}

/** Override the scheduled bloom hour (UTC, 0–23). Pass null to restore default (18:00). */
export function setCustomBloomHour(hour: number | null): void {
  customBloomHour = hour
}
