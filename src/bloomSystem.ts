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
import { BLOOM_CENTER, BLOOM_WINDOWS, BLOOM_MODEL_OFFSET_X } from './shared/config'
import { playClip } from './sounds'
import { isNightNow } from './moonlight'

// ---------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------

const BASE_LOOP_VOLUME  = 0.56  // KJ 2026-10-16: ambience a bit quieter (-3 dB; was 0.8). 10-15: global now, so a touch under full — the sfx have to sit above it
// Day / night music (KJ 2026-10-16: "make the soundscape more cheerful and relaxing"). BaseLoop is in C minor (C / Ab / F, almost no
// E) — right for the moonlit nights, gloomy by day. DayLoop.wav is its daytime partner in C major (soft pad on C-Am-F-G + sparse
// felt-piano notes; synthesised: empty for claude/tools/day_ambience.py). The two crossfade with the sky: day bed by day, BaseLoop by
// night (moonlight.ts isNightNow). DayLoop's RMS is ~3 dB above BaseLoop's, so it plays lower to sit at the same level.
const DAY_LOOP_VOLUME   = 0.19  // TUNING — -3 dB on 2026-10-16 (was 0.27)
// The Bloom "drop" (KJ 2026-10-16): the same song lifting — same key, chords and 90 bpm as DayLoop, plus a soft four-on-the-floor kick,
// claps, shaker and sub (day_ambience.py). When a Bloom opens: a 4-beat riser, then the drop loop from its first beat, the day / night
// beds ducked under it; when the Bloom starts closing it fades back out. Global, like the beds.
const DROP_VOLUME       = 0.5   // TUNING — sits ~4 dB above the day bed: a lift, not a club
const RISER_VOLUME      = 0.8
const RISER_MS          = Math.round(4 * 60_000 / 90)   // 4 beats at 90 bpm
const DROP_FADE_IN_S    = 0.4
const DROP_FADE_OUT_S   = 4
const BEDS_UNDER_DROP   = 0.25  // the beds' share while the drop plays
const MUSIC_FADE_S      = 6     // dusk / dawn crossfade time constant, seconds
// Twilight bed (KJ 2026-10-16): CC0 field recording "Crickets, Bells, and Leaves - Whispers of Summer Twilight" by bassimat (freesound.org/s/861408,
// credited in README.md): crickets, leaves and soft bells, made seamless and soft-limited (rms -20 dBFS, ~2 dB above BaseLoop, so it plays
// lower). It swells in as the sky goes dark and sits low by day, where the birds carry the soundscape. Global, ducked under the Bloom drop.
const TWILIGHT_VOLUME   = 0.35  // TUNING — at night; -3 dB on 2026-10-16 (was 0.5)
const TWILIGHT_DAY_SHARE = 0.25 // TUNING — its share by day (crickets under the birds)// Birdsong (KJ 2026-10-16). CC0 "bird05.wav" by l0vebliss (freesound.org/s/519061) — credited in README.md. The source peaked at -44.7 dB,
// so the file was normalised (+44.3 dB, to -0.4 dBFS; the gaps are digital silence, no hiss came up) and made mono for positional play.
// It is a 3.6 s call, so it is NOT looped (that would be a metronome): one call at a time, every BIRD_MIN_S-BIRD_MAX_S, from a random spot
// BIRD_DIST_MIN-MAX metres from you and a little above head height, at a slightly varied pitch. Daytime only — the garden's nights belong to
// the moon wisps.
const BIRD_SRC       = 'assets/scene/Sounds/ambience/BirdCall.wav'
const BIRD_VOLUME    = 1.0    // TUNING
const BIRD_MIN_S     = 6      // TUNING — KJ 2026-10-16 "more bird sound" (was 15-45 s)
const BIRD_MAX_S     = 16
const BIRD_ANSWER_P  = 0.35   // chance a second bird answers from elsewhere a moment later — reads as a garden full of birds, not one clip
const BIRD_DIST_MIN  = 6
const BIRD_DIST_MAX  = 14
const CHIMES_VOLUME     = 0.25  // TUNING — the file is ~12 dB louder than BaseLoop (RMS -9.8 vs -21.8 dB), so it needs a low volume to sit WITH the ambience; — the Bloom-area chimes (positional: they fade out as you walk away from the Bloom)
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
let baseLoopEntity:   Entity | null = null   // continuous — plays always (night music since 2026-10-16; volume follows musicMix)
let dayLoopEntity:    Entity | null = null   // daytime music
let twilightEntity:   Entity | null = null   // crickets / leaves / bells bed
let musicMix = -1                             // 1 = day bed, 0 = night loop; -1 = not set yet (snaps on the first tick)
let musicWritten = -1
let dropEntity:       Entity | null = null   // the Bloom drop loop
let dropMix = 0                               // 0..1 how much drop is in
let dropWanted = false                        // a Bloom is open (riser done) and not yet closing
let dropGen = 0                               // a newer Bloom cancels an older riser's pending start
let dropWritten = -1
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

/** Crossfade the day bed and the night loop with the sky. Volumes are only written when they move by a noticeable step. */
function musicMixSystem(dt: number): void {
  if (baseLoopEntity === null || dayLoopEntity === null || dropEntity === null || twilightEntity === null) return
  if (dropWanted && closeStarted) dropWanted = false   // the Bloom has started closing: let the drop go
  const target = isNightNow() ? 0 : 1
  musicMix = musicMix < 0 ? target : musicMix + (target - musicMix) * Math.min(1, dt / MUSIC_FADE_S)
  if (Math.abs(musicMix - target) < 0.005) musicMix = target
  const dTarget = dropWanted ? 1 : 0
  dropMix += (dTarget - dropMix) * Math.min(1, dt / (dropWanted ? DROP_FADE_IN_S : DROP_FADE_OUT_S))
  if (Math.abs(dropMix - dTarget) < 0.005) dropMix = dTarget
  const changed = (a: number, w: number, t: number) => w < 0 || (a !== w && (Math.abs(a - w) >= 0.02 || a === t))
  if (changed(musicMix, musicWritten, target) || changed(dropMix, dropWritten, dTarget)) {
    musicWritten = musicMix
    dropWritten = dropMix
    const beds = 1 - (1 - BEDS_UNDER_DROP) * dropMix
    AudioSource.getMutable(dayLoopEntity).volume  = DAY_LOOP_VOLUME * musicMix * beds
    AudioSource.getMutable(baseLoopEntity).volume = BASE_LOOP_VOLUME * (1 - musicMix) * beds
    AudioSource.getMutable(twilightEntity).volume = TWILIGHT_VOLUME * (TWILIGHT_DAY_SHARE + (1 - TWILIGHT_DAY_SHARE) * (1 - musicMix)) * beds
    const drop = AudioSource.getMutable(dropEntity)
    drop.volume = DROP_VOLUME * dropMix
    if (dropMix === 0 && !dropWanted && drop.playing) drop.playing = false   // fully faded: stop it, so the next Bloom starts from beat 1
  }
}

/** The Bloom opened: riser now, then the drop loop from its first beat once the riser lands. */
function startBloomDrop(): void {
  const gen = ++dropGen
  playClip('assets/scene/Audio/BloomRiser.wav', RISER_VOLUME)
  timers.setTimeout(() => {
    if (gen !== dropGen || !bloomActive || closeStarted || dropEntity === null) return
    AudioSource.createOrReplace(dropEntity, { audioClipUrl: 'assets/scene/Audio/BloomDrop.wav', playing: true, loop: true, volume: 0, pitch: 1, global: true })
    dropWritten = -1
    dropWanted = true
  }, RISER_MS)
}

/** One call from a random spot around the player, at a pitch between 0.85 and 1.2 so the single recording reads as several birds. */
function birdCall(): void {
  const me = Transform.getOrNull(engine.PlayerEntity)?.position
  if (!me || isNightNow()) return
  const a = Math.random() * Math.PI * 2
  const d = BIRD_DIST_MIN + Math.random() * (BIRD_DIST_MAX - BIRD_DIST_MIN)
  playClip(BIRD_SRC, BIRD_VOLUME, { x: me.x + Math.cos(a) * d, y: me.y + 3 + Math.random() * 3, z: me.z + Math.sin(a) * d }, 0.85 + Math.random() * 0.35)
}

function scheduleBird(): void {
  timers.setTimeout(() => {
    birdCall()
    if (Math.random() < BIRD_ANSWER_P) timers.setTimeout(birdCall, 600 + Math.random() * 1200)
    scheduleBird()
  }, (BIRD_MIN_S + Math.random() * (BIRD_MAX_S - BIRD_MIN_S)) * 1000)
}

export function setupBloomSystem(opts: {
  testMode: boolean
  onReset: () => void
  onVisualBloom?: () => void
}): void {
  testMode = opts.testMode
  onResetCallback = opts.onReset
  onVisualBloomCallback = opts.onVisualBloom ?? (() => {})

  // Continuous base layer — always playing. GLOBAL (KJ 2026-10-15: "should the soundscape be louder?"): it was a point source at the
  // Bloom centre, already at full volume, so it faded with distance and was barely there in the nursery, the shed (~31 m away) and the
  // Gallery. Now it plays at that full level everywhere in the scene. The Bloom's Pulse / Swell stay positional — they belong to it.
  baseLoopEntity = engine.addEntity()
  Transform.create(baseLoopEntity, { position: BLOOM_CENTER })
  AudioSource.create(baseLoopEntity, {
    audioClipUrl: 'assets/scene/Audio/BaseLoop.mp3',
    playing: true,
    loop: true,
    volume: BASE_LOOP_VOLUME,
    pitch: 1,
    global: true,
  })
  dayLoopEntity = engine.addEntity()
  Transform.create(dayLoopEntity, { position: BLOOM_CENTER })
  AudioSource.create(dayLoopEntity, {
    audioClipUrl: 'assets/scene/Audio/DayLoop.wav',
    playing: true,
    loop: true,
    volume: 0,
    pitch: 1,
    global: true,
  })
  twilightEntity = engine.addEntity()
  Transform.create(twilightEntity, { position: BLOOM_CENTER })
  AudioSource.create(twilightEntity, { audioClipUrl: 'assets/scene/Audio/TwilightAmbience.wav', playing: true, loop: true, volume: 0, pitch: 1, global: true })
  dropEntity = engine.addEntity()
  Transform.create(dropEntity, { position: BLOOM_CENTER })
  AudioSource.create(dropEntity, { audioClipUrl: 'assets/scene/Audio/BloomDrop.wav', playing: false, loop: true, volume: 0, pitch: 1, global: true })
  engine.addSystem(musicMixSystem, undefined, 'day-night-music')

  // KJ 2026-10-15: "some special sound around the main bloom area". A positional loop AT the Bloom — sparse C-major wind chimes and a
  // faint breathing shimmer (synthesised: empty for claude/tools/bloom_ambience.py) — so walking up to the Bloom sounds different from
  // the rest of the garden. Not global on purpose: the fade with distance IS the effect.
  const chimesEntity = engine.addEntity()
  Transform.create(chimesEntity, { position: BLOOM_CENTER })
  AudioSource.create(chimesEntity, {
    audioClipUrl: 'assets/scene/Audio/BloomChimes.wav',
    playing: true,
    loop: true,
    volume: CHIMES_VOLUME,
    pitch: 1,
  })

  scheduleBird()

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

    // 2026-09-28: nudge the composite-baked position toward the spawn (BLOOM_MODEL_OFFSET_X)
    const bloomTf = Transform.getMutableOrNull(bloomEnt)
    if (bloomTf) bloomTf.position = { x: bloomTf.position.x + BLOOM_MODEL_OFFSET_X, y: bloomTf.position.y, z: bloomTf.position.z }

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
  startBloomDrop()
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