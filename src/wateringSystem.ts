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
import { setupPetalSystem, petalParticleSystem } from './petalSystem'
import { setupBloomSystem, triggerBloomEvent, endBloom, isBloomActive, musicFadeSystem } from './bloomSystem'
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
// Set to true to bypass the daily limit entirely (useful during testing
// or when running as an admin / stress-testing with one client).
const OVERRIDE_DAILY_LIMIT = true

// TODO: replace with your real server base URL
const SERVER_URL = 'https://YOUR_SERVER_URL/api'

const TOTAL_PLANTS = 6
// How close to a plant to see the Click prompt
const MAX_CLICK_DISTANCE = 5
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

// How long the transition clips play before switching to the looping idle.
// TODO: set this to match the actual DroopyToHealthy / HealthToDroopy clip length.
const ANIM_TRANSITION_MS = 1500

// How long the WateringCan emote plays before the plant responds.
// Tune this to match the actual GLB clip length so the plant blooms
// right as the watering-can tips forward at the end of the animation.
const EMOTE_DURATION_MS = 3000

// Water drop indicator shown above droopy plants.
const WATER_DROP_SRC = 'assets/scene/Models/waterDrop/waterDrop.glb'
const WATER_DROP_Y   = 0.8   // metres above the plant base — tune to taste
const DROP_FADE_MS   = 800   // how long the fade in/out takes

// Toggle click method for UX prototyping:
//   false → click directly on the plant model (default)
//   true  → invisible oversized clickbox parented to each plant
const USE_CLICKBOX = false

// How many plants a single player can water per day.
const DAILY_WATER_LIMIT = 8



// Plant entity names as placed in the scene editor.
const PLANT_NAMES = [
  'Plant_1',  'Plant_2',  'Plant_3',  'Plant_4',
  'Plant_5',  'Plant_6', 
  // 'Plant_7',  'Plant_8',
  //'Plant_9',  'Plant_10', 'Plant_11', 'Plant_12',
  //'Plant_13', 'Plant_14', 'Plant_15', 'Plant_16',
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
let hoverSoundEntity:    Entity
let clickSoundEntity:    Entity
let wateringSoundEntity: Entity
let magicFXSoundEntity:  Entity
let wateredCount = 0
// Daily watering limit tracking
let playerWateredToday = 0
let dailyLimitReached  = false
let playerId           = 'unknown'
// True while the watering emote is in flight — prevents a second click from
// interrupting the avatar animation via a new movePlayerTo / triggerSceneEmote.
let emoteActive = false
// Water drop fade state per plant
type DropFade = 'in' | 'out' | 'visible' | 'hidden'
interface DropState { entity: Entity; fade: DropFade; fadeMs: number }
const dropMap = new Map<Entity, DropState>()  // plant entity → drop state

function setDropFade(plantEntity: Entity, direction: 'in' | 'out') {
  const s = dropMap.get(plantEntity)
  if (!s) return
  s.fade   = direction
  s.fadeMs = 0
}

function dropFadeSystem(dt: number) {
  for (const [, s] of dropMap) {
    if (s.fade !== 'in' && s.fade !== 'out') continue
    s.fadeMs += dt * 1000
    const t  = Math.min(s.fadeMs / DROP_FADE_MS, 1)
    const te = t * t * (3 - 2 * t)           // smooth-step ease
    const sc = s.fade === 'in' ? te : 1 - te
    const v  = Math.max(sc, 0.001)            // never exact 0 — GltfContainer safe
    Transform.getMutable(s.entity).scale = { x: v, y: v, z: v }
    if (t >= 1) s.fade = s.fade === 'in' ? 'visible' : 'hidden'
  }
}


// Reset animation state machine — driven by an ECS system so Animator
// updates run in the main update loop (same execution context as pointer
// events) rather than nested timer callbacks which the renderer ignores.
let resetQueue:  Entity[] = []
let resetPhase:  'to_droopy' | 'wait' | 'to_droopy_state' | 'done' = 'done'
let resetTimerMs = 0

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
    { entity: info.clickTarget, opts: { button: InputAction.IA_POINTER, hoverText: 'Water', maxDistance: MAX_CLICK_DISTANCE } },
    () => waterPlant(entity, info.plantName)
  )
  pointerEventsSystem.onPointerHoverEnter({ entity: info.clickTarget }, () => {
    if (!PlantData.get(entity).isWatered) playHoverSound()
  })
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
  emoteActive = true
  timers.setTimeout(() => {
    triggerSceneEmote({ src: EMOTE_SRC, loop: false })
  }, 200)

  // DCL's loop:false leaves the avatar frozen in the final keyframe instead of
  // returning to idle. Calling movePlayerTo in place after the emote duration
  // resets the avatar animation state without moving the player visibly.
  timers.setTimeout(() => {
    const pos = Transform.getOrNull(engine.PlayerEntity)?.position
    if (pos) movePlayerTo({ newRelativePosition: pos, avatarTarget: pos })
    emoteActive = false
  }, 200 + EMOTE_DURATION_MS)
}

// ---------------------------------------------------------------
// Plant lifecycle
// ---------------------------------------------------------------

/** Schedule an expiry timer that reverts one plant to droopy. */
function scheduleExpiry(entity: Entity, sessionTimestamp: number, delayMs: number) {
  timers.setTimeout(() => {
    // During bloom the reset will handle all plants — skip individual expiry
    if (isBloomActive()) return
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
        setDropFade(entity, 'in')
      }
    }, ANIM_TRANSITION_MS)
  }, delayMs)
}

/** Water a single plant: animation, sound, state update, server sync. */
function waterPlant(entity: Entity, plantId: string) {
  if (isBloomActive()) return   // garden is blooming — no new watering until reset
  if (emoteActive) return   // emote in flight — don't interrupt it
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

  // Water drop fades out as the plant is being watered
  setDropFade(entity, 'out')

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
  // Tear down bloom — fades music, settles petals, clears text, stops model anim
  endBloom()

  wateredCount = 0
  updateProgressText()

  // Clear state and build the queue for the reset system
  resetQueue = []
  for (const [entity] of engine.getEntitiesWith(PlantData)) {
    const pd = PlantData.getMutable(entity)
    pd.isWatered = false
    pd.wateredAt = 0
    resetQueue.push(entity)
  }
  resetPhase   = 'to_droopy'
  resetTimerMs = 0
  console.log(`[RESET] resetAllPlants — ${resetQueue.length} plants queued`)
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
      setDropFade(entity, 'in')
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

  // Water drop indicator — visible on droopy plants, fades out when watered
  const drop = engine.addEntity()
  Transform.create(drop, {
    position: { x: 0, y: WATER_DROP_Y, z: 0 },
    scale:    { x: 1, y: 1, z: 1 },
    parent:   entity,
  })
  GltfContainer.create(drop, { src: WATER_DROP_SRC })
  Billboard.create(drop, { billboardMode: BillboardMode.BM_Y })
  dropMap.set(entity, { entity: drop, fade: 'visible', fadeMs: 0 })
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

  // Bloom system — billboard, audio, model, music fade
  setupBloomSystem({ testMode: TEST_MODE, onReset: resetAllPlants })

  // Interaction sound entities — placed at scene centre, audible everywhere
  const SND_POS = { x: 8, y: 1, z: 8 }
  hoverSoundEntity = engine.addEntity()
  Transform.create(hoverSoundEntity, { position: SND_POS })
  AudioSource.create(hoverSoundEntity, { audioClipUrl: 'assets/scene/Sounds/hover.mp3',    playing: false, loop: false, volume: 1, pitch: 1 })

  clickSoundEntity = engine.addEntity()
  Transform.create(clickSoundEntity, { position: SND_POS })
  AudioSource.create(clickSoundEntity, { audioClipUrl: 'assets/scene/Sounds/click.mp3',    playing: false, loop: false, volume: 1, pitch: 1 })

  wateringSoundEntity = engine.addEntity()
  Transform.create(wateringSoundEntity, { position: SND_POS })
  AudioSource.create(wateringSoundEntity, { audioClipUrl: 'assets/scene/Sounds/watering.mp3', playing: false, loop: false, volume: 1,   pitch: 1 })

  magicFXSoundEntity = engine.addEntity()
  Transform.create(magicFXSoundEntity, { position: SND_POS })
  AudioSource.create(magicFXSoundEntity, { audioClipUrl: 'assets/scene/Sounds/MagicFX.mp3',  playing: false, loop: false, volume: 1,   pitch: 1 })

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
  // Petal particle system — hide source entity, create pooled instances
  setupPetalSystem()

  // Music fade system — runs every frame, idles when musicFadeState === 'none'
  engine.addSystem(musicFadeSystem)

  // Reset animation system — runs every frame, idles when resetPhase === 'done'
  engine.addSystem(resetAnimSystem)
  engine.addSystem(dropFadeSystem)

  // Petal particle system (petalSystem.ts) — idles when no bloom active
  engine.addSystem(petalParticleSystem)

  // Pull any existing watered states from the server
  fetchPlantStates()

  // Reset any avatar emote state that may have persisted across hot-reloads
  // in the DCL preview. movePlayerTo in place kicks the avatar back to idle
  // without visibly moving the player.
  timers.setTimeout(() => {
    const pos = Transform.getOrNull(engine.PlayerEntity)?.position
    if (pos) movePlayerTo({ newRelativePosition: pos, avatarTarget: pos })
  }, 500)

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
// [DONE] Water droplet on top of droopy plants (wait for feedback before implementation)
// ----------------------
// Tighten bloom moment build up and pacing
// -----------------------
// [DONE] Find and add audio files (watering, click covered by foundation defaults) 
// -----------------------
// [DONE] Petal particle system for bloom
// -----------------------
// Lights sway and flicker for bloom
// -----------------------
// [DONE] Sounds for plant animations + bloom moment 
// */