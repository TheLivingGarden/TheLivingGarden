// =============================================================
// The Living Garden — Watering System
// Prototype following DCL SDK7 patterns
// =============================================================

import {
  engine,
  Entity,
  Schemas,
  Animator,
  AudioSource,
  GltfContainer,
  TextShape,
  Billboard,
  BillboardMode,
  MeshCollider,
  ColliderLayer,
  pointerEventsSystem,
  InputAction,
  Transform,
  executeTask,
  timers,
} from '@dcl/sdk/ecs'
import { getPlayer } from '@dcl/sdk/players'
import { movePlayerTo, triggerSceneEmote } from '~system/RestrictedActions'

// ---------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------

// Set to true to compress all timers for rapid prototyping:
//   - Watered expiry  : 6h   → 30s
//   - Bloom delay     : next 6am/6pm UTC → 10s
//   - Post-bloom reset: +60s → +5s
//   - Server calls    : skipped (console logged instead)
const TEST_MODE = true

// TODO: replace with your real server base URL
const SERVER_URL = 'https://YOUR_SERVER_URL/api'

const TOTAL_PLANTS = 16

// How long a "watered" state lasts before expiring (ms).
// Switching between 6h and 12h is easy here.
const WATERED_EXPIRY_MS = TEST_MODE
  ? 30_000               // 30 seconds in test mode
  : 6 * 60 * 60 * 1000  // 6 hours in production

// Animation clip names — must match the GLB exactly.
const ANIM_DROOPY_STATE   = 'DroopyState'    // looping droopy idle
const ANIM_TO_HEALTHY     = 'DroopyToHealthy' // one-shot transition
const ANIM_HEALTHY_STATE  = 'HealthyState'   // looping healthy idle
const ANIM_TO_DROOPY      = 'HealthToDroopy' // one-shot transition
const ANIM_BLOOM          = 'Bloom'          // bloom model animation

// How long the transition clips play before switching to the looping idle.
// TODO: set this to match the actual DroopyToHealthy / HealthToDroopy clip length.
const ANIM_TRANSITION_MS = 1500

// How long the WateringCan emote plays before the plant responds.
// Tune this to match the actual GLB clip length so the plant blooms
// right as the watering-can tips forward at the end of the animation.
const EMOTE_DURATION_MS = 3000

// Toggle click method for UX prototyping:
//   false → click directly on the plant model (default)
//   true  → invisible oversized clickbox parented to each plant
const USE_CLICKBOX = false

// How many plants a single player can water per day.
const DAILY_WATER_LIMIT = 8

// Set to true to bypass the daily limit entirely (useful during testing
// or when running as an admin / stress-testing with one client).
const OVERRIDE_DAILY_LIMIT = false

// Plant entity names as placed in the scene editor.
const PLANT_NAMES = [
  'Plant_1',  'Plant_2',  'Plant_3',  'Plant_4',
  'Plant_5',  'Plant_6',  'Plant_7',  'Plant_8',
  'Plant_9',  'Plant_10', 'Plant_11', 'Plant_12',
  'Plant_13', 'Plant_14', 'Plant_15', 'Plant_16',
]

// ---------------------------------------------------------------
// Custom Component — tracks per-plant watered state
// ---------------------------------------------------------------

export const PlantData = engine.defineComponent('plant-data', {
  isWatered: Schemas.Boolean,
  wateredAt: Schemas.Number,  // Unix timestamp (ms); 0 when not watered
})

// ---------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------

let progressEntity: Entity
let bloomBillboard: Entity
let bloomModelEntity: Entity | null = null
let bloomSoundEntity:    Entity | null = null
let hoverSoundEntity:    Entity
let clickSoundEntity:    Entity
let wateringSoundEntity: Entity
let magicFXSoundEntity:  Entity
let wateredCount = 0
// Daily watering limit tracking
let playerWateredToday = 0
let dailyLimitReached  = false
let playerId           = 'unknown'
// True between bloom trigger and the post-bloom reset — expiry timers skip
// during this window so plants stay healthy through the full bloom moment.
let bloomActive = false
// True while petals are raining down
let petalActive = false
// True during the wind-down: petals keep falling but don't respawn,
// land on the ground, rest, then shrink away
let petalSettling = false
// Music fade state
let musicFadeState: 'in' | 'out' | 'none' = 'none'
let musicFadeMs    = 0

// ---------------------------------------------------------------
// Petal particle system
// ---------------------------------------------------------------

const PETAL_COUNT         = 50
const PETAL_CENTER        = { x: 8, z: 8 }
const PETAL_SPAWN_RADIUS  = 5
const PETAL_HEIGHT_MAX    = 7   // max spawn height (m)
const PETAL_HEIGHT_MIN    = 1   // min spawn height (m)
const PETAL_FALL_MIN      = 0.4 // m/s min fall speed
const PETAL_FALL_MAX      = 1.0 // m/s max fall speed
const PETAL_DRIFT_MAX     = 0.3 // m/s max horizontal drift
const PETAL_LIFE_MIN_MS   = 3_000
const PETAL_LIFE_MAX_MS   = 7_000
const PETAL_SCALE         = 0.5
const PETAL_REST_MS       = 2_000  // time resting on ground before shrinking
const PETAL_SHRINK_MS     = 600    // duration of scale-to-zero shrink

const MUSIC_FADE_IN_MS    = 3_000  // bloom music swells in over 3s, then visuals trigger
const MUSIC_FADE_OUT_MS   = 6_000  // bloom music fades out over 6s

interface PetalState {
  entity:      Entity
  pos:         { x: number; y: number; z: number }
  vel:         { x: number; y: number; z: number }
  rotY:        number
  rotSpeed:    number
  lifetime:    number   // ms remaining
  maxLifetime: number   // ms total
  grounded:    boolean  // true once petal has landed during settle
  groundedMs:  number   // ms since landing
}

const petalPool: PetalState[] = []

function randomizePetal(p: PetalState) {
  const angle  = Math.random() * Math.PI * 2
  const radius = Math.random() * PETAL_SPAWN_RADIUS
  p.pos = {
    x: PETAL_CENTER.x + Math.cos(angle) * radius,
    y: PETAL_HEIGHT_MIN + Math.random() * (PETAL_HEIGHT_MAX - PETAL_HEIGHT_MIN),
    z: PETAL_CENTER.z + Math.sin(angle) * radius,
  }
  p.vel = {
    x: (Math.random() - 0.5) * PETAL_DRIFT_MAX * 2,
    y: -(PETAL_FALL_MIN + Math.random() * (PETAL_FALL_MAX - PETAL_FALL_MIN)),
    z: (Math.random() - 0.5) * PETAL_DRIFT_MAX * 2,
  }
  p.rotY        = Math.random() * Math.PI * 2
  p.rotSpeed    = (Math.random() - 0.5) * 4
  p.maxLifetime = PETAL_LIFE_MIN_MS + Math.random() * (PETAL_LIFE_MAX_MS - PETAL_LIFE_MIN_MS)
  p.lifetime    = p.maxLifetime
  p.grounded    = false
  p.groundedMs  = 0
}

function petalParticleSystem(dt: number) {
  if (!petalActive && !petalSettling) return

  const dtMs = dt * 1000
  let allSettled = true

  for (const p of petalPool) {
    const t = Transform.getMutable(p.entity)

    // ── Grounded phase (settling only) ───────────────────────────
    if (p.grounded) {
      p.groundedMs += dtMs

      if (p.groundedMs >= PETAL_REST_MS + PETAL_SHRINK_MS) {
        // Fully gone
        t.scale = { x: 0, y: 0, z: 0 }
      } else if (p.groundedMs >= PETAL_REST_MS) {
        // Shrinking — ease out so the last moment lingers
        const progress = (p.groundedMs - PETAL_REST_MS) / PETAL_SHRINK_MS
        const s = PETAL_SCALE * (1 - progress * progress)
        t.scale = { x: s, y: s, z: s }
        allSettled = false
      } else {
        // Resting on the ground — still visible
        allSettled = false
      }
      continue
    }

    // ── In-air phase ─────────────────────────────────────────────
    allSettled = false
    p.pos.x   += p.vel.x * dt
    p.pos.y   += p.vel.y * dt
    p.pos.z   += p.vel.z * dt
    p.rotY    += p.rotSpeed * dt
    p.lifetime -= dtMs

    if (p.pos.y < 0) {
      if (petalActive) {
        // Normal rain: respawn above the garden
        randomizePetal(p)
      } else {
        // Settling: land on the floor and begin the rest timer
        p.pos.y    = 0
        p.vel      = { x: 0, y: 0, z: 0 }
        p.rotSpeed = 0
        p.grounded = true
        p.groundedMs = 0
      }
    } else if (petalActive && p.lifetime <= 0) {
      // Lifetime expired mid-air during normal rain — respawn
      randomizePetal(p)
    }

    // Apply to renderer — rotation as Y-axis quaternion
    const half = p.rotY * 0.5
    t.position = { x: p.pos.x, y: p.pos.y, z: p.pos.z }
    t.rotation = { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }
    t.scale    = { x: PETAL_SCALE, y: PETAL_SCALE, z: PETAL_SCALE }
  }

  // Once every petal has shrunk away, idle the system
  if (petalSettling && allSettled) {
    petalSettling = false
    console.log('[Petals] all settled')
  }
}

// Music fade system — runs in the main update loop so getMutable is reliable.
// Quadratic ease-in for the swell, quadratic ease-out for the fade.
function musicFadeSystem(dt: number) {
  if (musicFadeState === 'none' || !bloomSoundEntity) return

  musicFadeMs += dt * 1000

  if (musicFadeState === 'in') {
    const progress = Math.min(musicFadeMs / MUSIC_FADE_IN_MS, 1)
    // ease-in: starts barely audible, swells toward full
    AudioSource.getMutable(bloomSoundEntity).volume = progress * progress
    if (progress >= 1) musicFadeState = 'none'

  } else if (musicFadeState === 'out') {
    const progress = Math.min(musicFadeMs / MUSIC_FADE_OUT_MS, 1)
    // ease-out: drops quickly then lingers softly at the end
    const remaining = 1 - progress
    AudioSource.getMutable(bloomSoundEntity).volume = remaining * remaining
    if (progress >= 1) {
      // Fully silent — stop playback cleanly
      AudioSource.createOrReplace(bloomSoundEntity, {
        audioClipUrl: 'assets/scene/Sounds/MagicSound.mp3',
        playing: false,
        loop: false,
        volume: 0,
        pitch: 1,
      })
      musicFadeState = 'none'
    }
  }
}

// Reset animation state machine — driven by an ECS system so Animator
// updates run in the main update loop (same execution context as pointer
// events) rather than nested timer callbacks which the renderer ignores.
let resetQueue:  Entity[] = []
let resetPhase:  'to_droopy' | 'wait' | 'to_droopy_state' | 'done' = 'done'
let resetTimerMs = 0

// ---------------------------------------------------------------
// Helper: work out the next 6am or 6pm UTC bloom time
// ---------------------------------------------------------------

function getNextBloomTime(): number {
  if (TEST_MODE) return Date.now() + 10_000  // bloom fires in 10s

  const now = new Date()

  const at6am = new Date(now)
  at6am.setUTCHours(6, 0, 0, 0)

  const at6pm = new Date(now)
  at6pm.setUTCHours(18, 0, 0, 0)

  if (now < at6am) return at6am.getTime()
  if (now < at6pm) return at6pm.getTime()

  // Past 6pm — next is 6am tomorrow
  const tomorrow6am = new Date(at6am)
  tomorrow6am.setUTCDate(tomorrow6am.getUTCDate() + 1)
  return tomorrow6am.getTime()
}

// ---------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------

function updateProgressText() {
  const lines: string[] = [`${wateredCount}/${TOTAL_PLANTS} Plants Watered`]
  if (OVERRIDE_DAILY_LIMIT) {
    lines.push('Waters: Unlimited (override)')
  } else {
    const remaining = Math.max(0, DAILY_WATER_LIMIT - playerWateredToday)
    lines.push(remaining > 0
      ? `${remaining}/${DAILY_WATER_LIMIT} Waters Remaining Today`
      : 'Daily Limit Reached')
  }
  if (TEST_MODE) lines.push('[TEST MODE]')
  TextShape.getMutable(progressEntity).text = lines.join('\n')
}

function showBloomText(text: string) {
  TextShape.getMutable(bloomBillboard).text = text
}

// ---------------------------------------------------------------
// Server calls
// ---------------------------------------------------------------

function fetchPlantStates() {
  if (TEST_MODE) {
    console.log('[TEST] fetchPlantStates skipped — all plants start droopy')
    return
  }
  executeTask(async () => {
    try {
      const response = await fetch(`${SERVER_URL}/plants`)
      const data: Array<{ plantId: string; isWatered: boolean; wateredAt: number }> =
        await response.json()

      const now = Date.now()

      for (const state of data) {
        const entity = engine.getEntityOrNullByName(state.plantId)
        if (!entity || !PlantData.has(entity)) continue

        const msElapsed = now - state.wateredAt

        if (state.isWatered && msElapsed < WATERED_EXPIRY_MS) {
          const pd = PlantData.getMutable(entity)
          pd.isWatered = true
          pd.wateredAt = state.wateredAt

          // Already mid-session — jump straight to healthy idle
          Animator.playSingleAnimation(entity, ANIM_HEALTHY_STATE)
          disablePlantClick(entity)
          wateredCount++

          const msRemaining = WATERED_EXPIRY_MS - msElapsed
          scheduleExpiry(entity, state.wateredAt, msRemaining)
        }
      }

      updateProgressText()
      if (wateredCount >= TOTAL_PLANTS) triggerBloomEvent()
    } catch (e) {
      console.log('Could not fetch plant states from server:', e)
    }
  })
}

function sendWateredToServer(plantId: string, wateredAt: number) {
  if (TEST_MODE) {
    console.log(`[TEST] sendWateredToServer skipped — ${plantId} watered at ${wateredAt}`)
    return
  }
  executeTask(async () => {
    try {
      await fetch(`${SERVER_URL}/water`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // playerId lets the server enforce and record the daily limit per player
        body: JSON.stringify({ plantId, wateredAt, playerId }),
      })
    } catch (e) {
      console.log('Could not send watered state to server:', e)
    }
  })
}

function fetchPlayerDailyCount(pid: string) {
  if (TEST_MODE) {
    console.log(`[TEST] fetchPlayerDailyCount skipped — ${pid} starts at 0`)
    return
  }
  const today = new Date().toISOString().slice(0, 10)  // YYYY-MM-DD
  executeTask(async () => {
    try {
      const response = await fetch(`${SERVER_URL}/daily-count?playerId=${pid}&date=${today}`)
      const data = await response.json()
      playerWateredToday = data.count ?? 0
      if (!OVERRIDE_DAILY_LIMIT && playerWateredToday >= DAILY_WATER_LIMIT) {
        onDailyLimitReached()
      }
      updateProgressText()
      console.log(`[WateringSystem] ${pid} has watered ${playerWateredToday} plants today`)
    } catch (e) {
      console.log('Could not fetch daily count:', e)
    }
  })
}

// ---------------------------------------------------------------
// Plant click registry — enable/disable per-plant pointer events
// ---------------------------------------------------------------

// Stores click target and plant name for each plant entity so we can
// re-register the pointer event after a plant reverts to droopy.
const plantRegistry = new Map<Entity, { clickTarget: Entity; plantName: string }>()

function enablePlantClick(entity: Entity) {
  // Don't re-enable if the player has used up their daily allowance
  if (!OVERRIDE_DAILY_LIMIT && dailyLimitReached) return
  const info = plantRegistry.get(entity)
  if (!info) return
  pointerEventsSystem.onPointerDown(
    { entity: info.clickTarget, opts: { button: InputAction.IA_POINTER, hoverText: 'Water' } },
    () => waterPlant(entity, info.plantName)
  )
  pointerEventsSystem.onPointerHoverEnter({ entity: info.clickTarget }, playHoverSound)
}

function disablePlantClick(entity: Entity) {
  const info = plantRegistry.get(entity)
  if (!info) return
  pointerEventsSystem.removeOnPointerDown(info.clickTarget)
  pointerEventsSystem.removeOnPointerHoverEnter(info.clickTarget)
}

/** Called when the player hits their daily watering limit. */
function onDailyLimitReached() {
  dailyLimitReached = true
  // Disable all droopy plants — this player can't water any more today
  for (const [entity] of plantRegistry) {
    if (!PlantData.get(entity).isWatered) disablePlantClick(entity)
  }
  updateProgressText()
  console.log('[WateringSystem] Daily water limit reached')
}

/** TEST_MODE only — resets the in-memory daily counter so one client
 *  can run through the full cycle multiple times. */
function resetDailyLimit() {
  playerWateredToday = 0
  dailyLimitReached  = false
  // Re-enable clicking on all currently-droopy plants
  for (const [entity] of plantRegistry) {
    if (!PlantData.get(entity).isWatered) enablePlantClick(entity)
  }
  updateProgressText()
  console.log('[TEST] Daily limit reset to 0')
}

// ---------------------------------------------------------------
// Interaction sounds & emote
// ---------------------------------------------------------------

const EMOTE_SRC = 'assets/scene/Models/Emotes/WateringCan_emote.glb'

/** Move a sound entity to the player's current world position then fire it.
 *  Keeps all interaction sounds at full apparent volume regardless of
 *  where in the scene the player is standing. */
function playAtPlayer(soundEntity: Entity, audioClipUrl: string, volume: number) {
  const pos = Transform.getOrNull(engine.PlayerEntity)?.position ?? { x: 8, y: 1, z: 8 }
  Transform.getMutable(soundEntity).position = pos
  AudioSource.createOrReplace(soundEntity, { audioClipUrl, playing: true, loop: false, volume, pitch: 1 })
}

function playHoverSound()    { playAtPlayer(hoverSoundEntity,    'assets/scene/Sounds/hover.mp3',    0.7) }
function playClickSound()    { playAtPlayer(clickSoundEntity,    'assets/scene/Sounds/click.mp3',    0.9) }
function playWateringSound() { playAtPlayer(wateringSoundEntity, 'assets/scene/Sounds/watering.mp3', 1.0) }
function playMagicFXSound()  { playAtPlayer(magicFXSoundEntity,  'assets/scene/Sounds/MagicFX.mp3',  1.0) }

// How far in front of the plant the player is placed to perform the emote.
// Tweak this value to taste — 1.2 m feels natural for a watering-can reach.
const WATER_DISTANCE = 2

function triggerWateringEmote(plantEntity: Entity) {
  const plantPos  = Transform.getOrNull(plantEntity)?.position
  const playerPos = Transform.getOrNull(engine.PlayerEntity)?.position
  if (plantPos && playerPos) {
    // Project the player-to-plant vector onto the horizontal plane, normalise
    // it, then step back WATER_DISTANCE from the plant along that direction.
    // This always puts the player squarely in front of the plant they clicked,
    // no matter where in the scene the plant is placed.
    const dx  = playerPos.x - plantPos.x
    const dz  = playerPos.z - plantPos.z
    const len = Math.sqrt(dx * dx + dz * dz)
    const nx  = len > 0.001 ? dx / len : 0
    const nz  = len > 0.001 ? dz / len : 1
    movePlayerTo({
      newRelativePosition: {
        x: plantPos.x + nx * WATER_DISTANCE,
        y: playerPos.y,   // keep the player's current height
        z: plantPos.z + nz * WATER_DISTANCE,
      },
      avatarTarget: plantPos,  // face toward the plant
    })
  }
  // triggerSceneEmote is the correct SDK7 API for custom GLB avatar emotes.
  // The 200ms delay (matching DCL Foundation's pattern) gives the facing
  // rotation time to apply before the animation starts.
  timers.setTimeout(() => {
    triggerSceneEmote({ src: EMOTE_SRC, loop: false })
  }, 200)
}

// ---------------------------------------------------------------
// Plant lifecycle
// ---------------------------------------------------------------

/** Schedule an expiry timer that reverts one plant to droopy. */
function scheduleExpiry(entity: Entity, sessionTimestamp: number, delayMs: number) {
  timers.setTimeout(() => {
    // During bloom the reset will handle all plants — skip individual expiry
    if (bloomActive) return
    const pd = PlantData.getMutable(entity)
    // Guard: only revert if this is still the same watered session
    if (!pd.isWatered || pd.wateredAt !== sessionTimestamp) return

    pd.isWatered = false
    pd.wateredAt = 0
    wateredCount = Math.max(0, wateredCount - 1)
    updateProgressText()

    // Play transition, then settle into droopy idle.
    // Guard: only land on DroopyState if the plant hasn't been re-watered.
    Animator.playSingleAnimation(entity, ANIM_TO_DROOPY)
    timers.setTimeout(() => {
      if (!PlantData.get(entity).isWatered) {
        Animator.playSingleAnimation(entity, ANIM_DROOPY_STATE)
        enablePlantClick(entity)
      }
    }, ANIM_TRANSITION_MS)
  }, delayMs)
}

/** Water a single plant: animation, sound, state update, server sync. */
function waterPlant(entity: Entity, plantId: string) {
  const pd = PlantData.getMutable(entity)
  if (pd.isWatered) return  // already watered — ignore

  // Enforce daily limit (can be bypassed with OVERRIDE_DAILY_LIMIT)
  if (!OVERRIDE_DAILY_LIMIT && playerWateredToday >= DAILY_WATER_LIMIT) return

  const now = Date.now()
  pd.isWatered = true
  pd.wateredAt = now

  // Track daily usage and check if limit is now reached
  playerWateredToday++
  if (!OVERRIDE_DAILY_LIMIT && playerWateredToday >= DAILY_WATER_LIMIT) {
    onDailyLimitReached()
  }

  // Healthy plants are not clickable
  disablePlantClick(entity)

  // ── Event sequence ──────────────────────────────────────────────────────
  // t = 0ms     : click sound + player moves/faces plant + emote queued
  // t = 200ms   : emote fires + watering sound starts
  // t = EMOTE_DURATION_MS : plant plays DroopyToHealthy
  // t = EMOTE_DURATION_MS + ANIM_TRANSITION_MS : plant settles to HealthyState
  // ────────────────────────────────────────────────────────────────────────

  // 1. Click feedback — immediate
  playClickSound()
  triggerWateringEmote(entity)  // movePlayerTo now + triggerSceneEmote at 200ms

  // 2. Watering sound synced to when the emote actually starts
  timers.setTimeout(playWateringSound, 200)

  // 3. Plant responds after the emote has played through
  timers.setTimeout(() => {
    const current = PlantData.get(entity)
    if (!current.isWatered || current.wateredAt !== now) return  // guard: re-watered or expired mid-emote
    Animator.playSingleAnimation(entity, ANIM_TO_HEALTHY)
    playMagicFXSound()  // one-shot — plays through naturally, never looped or cut short
    timers.setTimeout(() => {
      const latest = PlantData.get(entity)
      if (latest.isWatered && latest.wateredAt === now) {
        Animator.playSingleAnimation(entity, ANIM_HEALTHY_STATE)
      }
    }, ANIM_TRANSITION_MS)
  }, EMOTE_DURATION_MS)

  // Sync to server
  sendWateredToServer(plantId, now)

  // Update progress display
  wateredCount++
  updateProgressText()

  // Schedule expiry
  scheduleExpiry(entity, now, WATERED_EXPIRY_MS)

  // Check for full-garden bloom
  if (wateredCount >= TOTAL_PLANTS) triggerBloomEvent()
}

/** Reset every plant back to droopy (called after bloom). */
function resetAllPlants() {
  bloomActive = false
  wateredCount = 0
  updateProgressText()

  // Fade bloom music out — musicFadeSystem handles the gradual volume drop
  if (bloomSoundEntity) {
    musicFadeMs   = 0
    musicFadeState = 'out'
  }

  // Begin petal settle — stop spawning new petals, let in-air ones
  // drift down, land, rest 2s, then shrink away gracefully
  petalActive   = false
  petalSettling = true

  // Clear state and build the queue for the reset system
  resetQueue = []
  for (const [entity] of engine.getEntitiesWith(PlantData)) {
    const pd = PlantData.getMutable(entity)
    pd.isWatered = false
    pd.wateredAt = 0
    resetQueue.push(entity)
  }
  resetPhase  = 'to_droopy'
  resetTimerMs = 0
  console.log(`[RESET] resetAllPlants — ${resetQueue.length} plants queued`)

  // Stop the bloom model animation
  if (bloomModelEntity) {
    Animator.getMutable(bloomModelEntity).states[0].playing = false
  }
}

// ECS system that drives the reset animation one plant per frame.
// Running inside the main update loop ensures Animator mutations reach
// the renderer in the same processing lane as pointer events.
function resetAnimSystem(dt: number) {
  if (resetPhase === 'done') return

  if (resetPhase === 'to_droopy') {
    // Stop all animations first, then start HealthToDroopy on one plant per frame.
    // stopAllAnimations sends a distinct renderer event that properly interrupts
    // looping clips — getMutable alone doesn't reliably interrupt a running loop.
    const entity = resetQueue.shift()
    if (entity) {
      Animator.stopAllAnimations(entity, true)
      Animator.playSingleAnimation(entity, ANIM_TO_DROOPY, true)
      console.log(`[RESET-SYS] to_droopy fired on entity ${entity}`)
    }
    if (resetQueue.length === 0) {
      resetPhase  = 'wait'
      resetTimerMs = 0
      for (const [e] of engine.getEntitiesWith(PlantData)) resetQueue.push(e)
    }
    return
  }

  if (resetPhase === 'wait') {
    resetTimerMs += dt * 1000
    if (resetTimerMs >= ANIM_TRANSITION_MS) resetPhase = 'to_droopy_state'
    return
  }

  if (resetPhase === 'to_droopy_state') {
    const entity = resetQueue.shift()
    if (entity && !PlantData.get(entity).isWatered) {
      Animator.stopAllAnimations(entity, true)
      Animator.playSingleAnimation(entity, ANIM_DROOPY_STATE, true)
      console.log(`[RESET-SYS] to_droopy_state fired on entity ${entity}`)
    }
    if (resetQueue.length === 0) {
      resetPhase = 'done'
      // Re-enable clicking now all plants are droopy again
      for (const entity of plantRegistry.keys()) enablePlantClick(entity)
      console.log('[RESET] system complete — all plants in DroopyState')
    }
  }
}

// ---------------------------------------------------------------
// Bloom event
// ---------------------------------------------------------------

function triggerBloomEvent() {
  bloomActive = true
  console.log('Bloom building — music fade-in starting')

  // Music starts immediately, silent, and swells in over MUSIC_FADE_IN_MS.
  // Visual bloom fires only after the fade completes so the sound leads the moment.
  if (bloomSoundEntity) {
    AudioSource.createOrReplace(bloomSoundEntity, {
      audioClipUrl: 'assets/scene/Sounds/MagicSound.mp3',
      playing: true,
      loop: true,
      volume: 0,
      pitch: 1,
    })
    musicFadeMs    = 0
    musicFadeState = 'in'
  }

  timers.setTimeout(launchVisualBloom, MUSIC_FADE_IN_MS)
}

/** Called once the music has fully faded in — launches all visual bloom effects. */
function launchVisualBloom() {
  showBloomText('The Garden is in Full Bloom!')
  console.log('Bloom visual launched!')

  // Petal rain — stagger initial lifetimes so petals don't all spawn at once
  petalActive = true
  for (const p of petalPool) {
    randomizePetal(p)
    p.lifetime = Math.random() * p.maxLifetime  // stagger entry
    const t = Transform.getMutable(p.entity)
    t.scale = { x: PETAL_SCALE, y: PETAL_SCALE, z: PETAL_SCALE }
  }

  // Bloom model animation
  if (bloomModelEntity) {
    Animator.playSingleAnimation(bloomModelEntity, ANIM_BLOOM)
  }

  const msUntilNextBloom = getNextBloomTime() - Date.now()
  const resetDelay = TEST_MODE ? 30_000 : 60_000

  if (TEST_MODE) {
    console.log(`[TEST] Visual bloom live — reset in ${(msUntilNextBloom + resetDelay) / 1000}s`)
  } else {
    console.log(`Next bloom scheduled in ${Math.round(msUntilNextBloom / 1000 / 60)} minutes`)
  }

  timers.setTimeout(() => {
    resetAllPlants()
    showBloomText('')
  }, msUntilNextBloom + resetDelay)
}

// ---------------------------------------------------------------
// Per-plant setup
// ---------------------------------------------------------------

function setupPlant(plantName: string) {
  const entity = engine.getEntityOrNullByName(plantName)
  if (!entity) {
    console.log(`[WateringSystem] Entity not found: ${plantName}`)
    return
  }

  // Track watered state
  PlantData.create(entity, { isWatered: false, wateredAt: 0 })

  // TODO: add AudioSource once audio files are in place
  // AudioSource.createOrReplace(entity, { audioClipUrl: 'assets/sounds/water.mp3', ... })

  // Click target — swap via USE_CLICKBOX flag at the top of the file
  let clickTarget: Entity
  if (USE_CLICKBOX) {
    // Invisible oversized box parented to the plant — easy to hit.
    // Adjust scale/position to taste during UX feedback.
    const clickBox = engine.addEntity()
    Transform.create(clickBox, {
      position: { x: 0, y: 1, z: 0 },   // centred 1m above plant base
      scale:    { x: 1.5, y: 2, z: 1.5 },
      parent:   entity,
    })
    MeshCollider.setBox(clickBox, ColliderLayer.CL_POINTER)
    clickTarget = clickBox
  } else {
    clickTarget = entity
  }

  // Register so enable/disablePlantClick can find the click target later
  plantRegistry.set(entity, { clickTarget, plantName })
  // Plants start droopy — enable clicking immediately
  enablePlantClick(entity)
}

// ---------------------------------------------------------------
// Public entry point — call from index.ts main()
// ---------------------------------------------------------------

export function setupWateringSystem() {
  // Progress indicator — always faces the player (Y-billboard)
  progressEntity = engine.addEntity()
  Transform.create(progressEntity, {
    position: { x: 8, y: 3.5, z: 8 },
  })
  TextShape.create(progressEntity, {
    text: `0/${TOTAL_PLANTS} Plants Watered${TEST_MODE ? '\n[TEST MODE]' : ''}`,
    fontSize: 3,
  })
  Billboard.create(progressEntity, { billboardMode: BillboardMode.BM_Y })

  // Bloom billboard — shown when all plants are watered
  bloomBillboard = engine.addEntity()
  Transform.create(bloomBillboard, {
    position: { x: 8, y: 5, z: 8 },
  })
  TextShape.create(bloomBillboard, {
    text: '',
    fontSize: 4,
  })
  Billboard.create(bloomBillboard, { billboardMode: BillboardMode.BM_Y })

  // Bloom sound — loops MagicSound.mp3 during the bloom event.
  // Transform at scene centre prevents DCL applying 3-D positional
  // distance/Doppler effects that alter pitch and volume.
  bloomSoundEntity = engine.addEntity()
  Transform.create(bloomSoundEntity, { position: { x: 8, y: 2, z: 8 } })
  AudioSource.create(bloomSoundEntity, {
    audioClipUrl: 'assets/scene/Sounds/MagicSound.mp3',
    playing: false,
    loop: true,
    volume: 1,
    pitch: 1,
  })

  // Bloom model — separate entity with its own Bloom animation
  const bloomEnt = engine.getEntityOrNullByName('Bloom')
  if (bloomEnt) {
    bloomModelEntity = bloomEnt
    Animator.createOrReplace(bloomEnt, {
      states: [{ clip: ANIM_BLOOM, playing: false, loop: true }],
    })
  } else {
    console.log('[WateringSystem] Bloom.glb entity not found')
  }

  // Interaction sound entities — placed at scene centre, audible everywhere
  const SND_POS = { x: 8, y: 1, z: 8 }
  hoverSoundEntity = engine.addEntity()
  Transform.create(hoverSoundEntity, { position: SND_POS })
  AudioSource.create(hoverSoundEntity, { audioClipUrl: 'assets/scene/Sounds/hover.mp3',    playing: false, loop: false, volume: 0.7, pitch: 1 })

  clickSoundEntity = engine.addEntity()
  Transform.create(clickSoundEntity, { position: SND_POS })
  AudioSource.create(clickSoundEntity, { audioClipUrl: 'assets/scene/Sounds/click.mp3',    playing: false, loop: false, volume: 0.9, pitch: 1 })

  wateringSoundEntity = engine.addEntity()
  Transform.create(wateringSoundEntity, { position: SND_POS })
  AudioSource.create(wateringSoundEntity, { audioClipUrl: 'assets/scene/Sounds/watering.mp3', playing: false, loop: false, volume: 1,   pitch: 1 })

  magicFXSoundEntity = engine.addEntity()
  Transform.create(magicFXSoundEntity, { position: SND_POS })
  AudioSource.create(magicFXSoundEntity, { audioClipUrl: 'assets/scene/Sounds/MagicFX.mp3',  playing: false, loop: false, volume: 1,   pitch: 1 })

  // Preload the watering-can emote GLB so the renderer has the animation data
  // ready before AvatarEmoteCommand.addValue() is ever called.
  // Without this hidden entity the emote silently fails to play.
  const emotePreload = engine.addEntity()
  Transform.create(emotePreload, { position: { x: 8, y: -10, z: 8 }, scale: { x: 0, y: 0, z: 0 } })
  GltfContainer.create(emotePreload, { src: EMOTE_SRC })

  // Wire up each plant (pointer events, state component, audio)
  for (const name of PLANT_NAMES) {
    setupPlant(name)
  }

  // Animator setup is deferred 1s to ensure GltfContainers have fully loaded.
  timers.setTimeout(() => {
    for (const name of PLANT_NAMES) {
      const entity = engine.getEntityOrNullByName(name)
      if (!entity) {
        console.log(`[WateringSystem] entity not found — ${name}`)
        continue
      }

      Animator.createOrReplace(entity, {
        states: [
          { clip: ANIM_DROOPY_STATE,  playing: false, loop: true  },
          { clip: ANIM_TO_HEALTHY,    playing: false, loop: false },
          { clip: ANIM_HEALTHY_STATE, playing: false, loop: true  },
          { clip: ANIM_TO_DROOPY,     playing: false, loop: false },
        ],
      })
      Animator.playSingleAnimation(entity, ANIM_DROOPY_STATE, true)
    }
  }, 1000)

  // Petal particle system — hide source entity, create pooled instances
  const petalSource = engine.getEntityOrNullByName('Petal')
  if (petalSource) {
    const gltf = GltfContainer.getOrNull(petalSource)
    const src  = gltf?.src ?? ''
    // Hide the original scene entity
    Transform.getMutable(petalSource).scale = { x: 0, y: 0, z: 0 }

    for (let i = 0; i < PETAL_COUNT; i++) {
      const ent = engine.addEntity()
      GltfContainer.create(ent, { src })
      Transform.create(ent, {
        position: { x: 0, y: -10, z: 0 },
        scale:    { x: 0, y: 0, z: 0 },     // hidden until bloom
      })
      petalPool.push({
        entity:      ent,
        pos:         { x: 0, y: -10, z: 0 },
        vel:         { x: 0, y: -1, z: 0 },
        rotY:        0,
        rotSpeed:    1,
        lifetime:    0,
        maxLifetime: PETAL_LIFE_MAX_MS,
        grounded:    false,
        groundedMs:  0,
      })
    }
    console.log(`[WateringSystem] Petal pool ready — ${PETAL_COUNT} instances from "${src}"`)
  } else {
    console.log('[WateringSystem] Petal entity not found — particle system disabled')
  }

  // Music fade system — runs every frame, idles when musicFadeState === 'none'
  engine.addSystem(musicFadeSystem)

  // Reset animation system — runs every frame, idles when resetPhase === 'done'
  engine.addSystem(resetAnimSystem)

  // Petal particle system — runs every frame, idles when petalActive === false
  engine.addSystem(petalParticleSystem)

  // Pull any existing watered states from the server
  fetchPlantStates()

  // Resolve player identity (synchronous in SDK7) then load their daily count.
  playerId = getPlayer()?.userId ?? 'unknown'
  console.log(`[WateringSystem] Player ID: ${playerId}`)
  fetchPlayerDailyCount(playerId)
  updateProgressText()

  // TEST_MODE only — small clickable billboard to reset the daily counter
  // so one client can run through the full cycle repeatedly.
  if (TEST_MODE) {
    const resetBtn = engine.addEntity()
    Transform.create(resetBtn, { position: { x: 1, y: 1.5, z: 1 } })
    TextShape.create(resetBtn, { text: 'Reset\nDaily Limit\n[TEST]', fontSize: 2 })
    Billboard.create(resetBtn, { billboardMode: BillboardMode.BM_Y })
    pointerEventsSystem.onPointerDown(
      { entity: resetBtn, opts: { button: InputAction.IA_POINTER, hoverText: 'Reset Daily Limit' } },
      resetDailyLimit
    )
  }
}



/// TODO
//**

// - in live mode check server for plant state
// -------------------
// [DONE] Daily watering limit — 8 per player (DAILY_WATER_LIMIT constant)
// [DONE] Override feature — OVERRIDE_DAILY_LIMIT flag + TEST_MODE reset button
// ---------------------
// Water droplet on top of droopy plants (wait for feedback before implementation)
// ----------------------
// Tighten bloom moment build up and pacing
// -----------------------
// Find and add audio files (watering, click covered by foundation defaults) 
// -----------------------
// [DONE] Petal particle system for bloom
// -----------------------
// Lights sway and flicker for bloom
// -----------------------
// Sounds for plant animations + bloom moment 
// */