// =============================================================
// The Living Garden — Watering System (CLIENT ONLY)
// All game-state authority has moved to src/server/server.ts.
// This file owns: click handling, animations, sounds, UI updates.
//
// Server communication:
//   send    →  room.send('waterPlant', { plantId })
//   receive ←  playerDailyState | waterRejected | plantStateUpdate | bloomTriggered | bloomReset
//
// Cross-player plant state is synced via plantStateUpdate room messages.
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
  PointerEvents,
  InputAction,
  Transform,
  VisibilityComponent,
  timers,
} from '@dcl/sdk/ecs'
import { getPlayer }               from '@dcl/sdk/players'
import { onEnterSceneObservable }  from '@dcl/sdk/observables'
import { setupPetalSystem, petalParticleSystem }                           from './petalSystem'
import { setupBloomSystem, triggerBloomEvent, endBloom, isBloomActive, musicFadeSystem } from './bloomSystem'
import { setupSparkleSystem, triggerSparkle, sparkleSystem, triggerBloomSparkles, endBloomSparkles, bloomSparkleSystem } from './sparkleSystem'
import { setupAmbientFX, triggerBloomShockwave, triggerGroundRipple, startFireflies, stopFireflies, ambientFXSystem } from './ambientFX'
import { showToast, showDailyLimit, showPersistent, hidePersistent, formatBloomCountdown, formatDailyLimitMessage } from './notifications'
import { movePlayerTo, triggerSceneEmote } from '~system/RestrictedActions'
import { room }       from './shared/messages'
import { TOTAL_PLANTS, BLOOM_THRESHOLD, DAILY_WATER_LIMIT, PLANT_NAMES } from './shared/config'

// ---------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------

// Set to true to compress all timers for rapid prototyping:
//   - Watered expiry  : 6h   → 5min
//   - Bloom delay     : next 6pm UTC → 10s
//   - Server calls    : still sent, but TEST markers in logs
const TEST_MODE = true
let runtimeTestMode = TEST_MODE

let overrideDailyLimit = false

// Animation clip names — must match the GLB exactly.
const ANIM_DROOPY_STATE   = 'DroopyState'
const ANIM_TO_HEALTHY     = 'DroopyToHealthy'
const ANIM_HEALTHY_STATE  = 'HealthyState'
const ANIM_TO_DROOPY      = 'HealthToDroopy'
const ANIM_TRANSITION_MS  = 1500

// When in the emote the plant responds (can tips forward).
const EMOTE_DURATION_MS = 1500
// Full GLB clip length — emoteActive stays locked this long to prevent interruption.
const EMOTE_TOTAL_MS    = 2933

const WATER_DROP_SRC = 'assets/scene/Models/waterDrop/waterDrop.glb'
const WATER_DROP_Y   = 0.8
const DROP_FADE_MS   = 800

let useClickbox      = false
let dailyWaterLimit  = DAILY_WATER_LIMIT

// ---------------------------------------------------------------
// Custom Component — local per-plant watered state (client only)
// ---------------------------------------------------------------

export const PlantData = engine.defineComponent('plant-data', {
  isWatered: Schemas.Boolean,
  wateredAt: Schemas.Number,
})

// ---------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------

let progressEntity:      Entity
let hoverSoundEntity:    Entity
let clickSoundEntity:    Entity
let wateringSoundEntity: Entity

let playerWateredToday = 0
let dailyLimitReached  = false
let playerId           = 'unknown'
let initialLoadDone    = false
let roomReady          = false

let emoteActive   = false
let emoteGen      = 0
let emoteStartPos: { x: number; y: number; z: number } | null = null

type DropFade = 'in' | 'out' | 'visible' | 'hidden'
interface DropState { entity: Entity; fade: DropFade; fadeMs: number }
const dropMap = new Map<Entity, DropState>()

function setDropFade(plantEntity: Entity, direction: 'in' | 'out') {
  const s = dropMap.get(plantEntity)
  if (!s) return
  s.fade   = direction
  s.fadeMs = 0
}

// ---------------------------------------------------------------
// Emote cleanup — dismisses the prop GLB if player moves mid-emote
// ---------------------------------------------------------------

const EMOTE_MOVE_THRESHOLD = 0.4
function emoteCleanupSystem() {
  if (!emoteActive || !emoteStartPos) return
  const pos = Transform.getOrNull(engine.PlayerEntity)?.position
  if (!pos) return
  const dx = pos.x - emoteStartPos.x
  const dz = pos.z - emoteStartPos.z
  if (Math.sqrt(dx * dx + dz * dz) < EMOTE_MOVE_THRESHOLD) return
  ++emoteGen
  emoteActive   = false
  emoteStartPos = null
  movePlayerTo({ newRelativePosition: pos })
}

// ---------------------------------------------------------------
// Drop-fade system
// ---------------------------------------------------------------

function dropFadeSystem(dt: number) {
  for (const [, s] of dropMap) {
    if (s.fade !== 'in' && s.fade !== 'out') continue
    s.fadeMs += dt * 1000
    const t  = Math.min(s.fadeMs / DROP_FADE_MS, 1)
    const te = t * t * (3 - 2 * t)
    const sc = s.fade === 'in' ? te : 1 - te
    const v  = Math.max(sc, 0.001)
    Transform.getMutable(s.entity).scale = { x: v, y: v, z: v }
    if (t >= 1) s.fade = s.fade === 'in' ? 'visible' : 'hidden'
  }
}


// ---------------------------------------------------------------
// Reset animation state machine
// ---------------------------------------------------------------

let resetQueue:   Entity[] = []
let resetPhase:   'to_droopy' | 'wait' | 'to_droopy_state' | 'done' = 'done'
let resetTimerMs = 0

// ---------------------------------------------------------------
// Scene-asset visibility (progress bars, toon, bloom text)
// ---------------------------------------------------------------

let _sceneAssetsResolved = false
let _progressBarsGreen:  Entity | null = null
let _progressBarsRed:    Entity | null = null
let _centerToon:         Entity | null = null
let _centerTextBloom:    Entity | null = null
let _centerTextProgress: Entity | null = null

function resolveSceneAssets() {
  if (_sceneAssetsResolved) return
  _sceneAssetsResolved  = true
  _progressBarsGreen  = engine.getEntityOrNullByName('progressBarsGreen')
  _progressBarsRed    = engine.getEntityOrNullByName('progressBarsRed')
  _centerToon         = engine.getEntityOrNullByName('centerToon')
  _centerTextBloom    = engine.getEntityOrNullByName('centerTextBloom')
  _centerTextProgress = engine.getEntityOrNullByName('centerTextProgress')
}

function setVisible(entity: Entity | null, visible: boolean) {
  if (!entity) return
  VisibilityComponent.createOrReplace(entity, { visible })
}

function updateSceneAssets() {
  resolveSceneAssets()
  const healthy = computeWateredCount() >= BLOOM_THRESHOLD
  setVisible(_progressBarsGreen,  healthy)
  setVisible(_progressBarsRed,    !healthy)
  setVisible(_centerToon,         healthy)
  setVisible(_centerTextBloom,    healthy)
  setVisible(_centerTextProgress, !healthy)
}

// ---------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------

/** Count watered plants from local PlantData. */
function computeWateredCount(): number {
  let count = 0
  for (const [, pd] of engine.getEntitiesWith(PlantData)) {
    if (pd.isWatered) count++
  }
  return count
}

function updateProgressText() {
  const count = computeWateredCount()
  const lines: string[] = [`${count}/${BLOOM_THRESHOLD} Plants Watered`]
  if (overrideDailyLimit) {
    lines.push('Waters: Unlimited (override)')
  } else {
    const remaining = Math.max(0, dailyWaterLimit - playerWateredToday)
    lines.push(remaining > 0
      ? `${remaining}/${dailyWaterLimit} Waters Remaining Today`
      : 'Daily Limit Reached')
  }
  if (runtimeTestMode) lines.push('[TEST MODE]')
  TextShape.getMutable(progressEntity).text = lines.join('\n')
  updateSceneAssets()
}

function showWelcomeProgress() {
  const count = computeWateredCount()
  showToast(`${count}/${BLOOM_THRESHOLD} Plants Watered`, 4_000)
}

// ---------------------------------------------------------------
// Plant click registry
// ---------------------------------------------------------------

const plantRegistry     = new Map<Entity, { clickTarget: Entity; plantName: string; clickboxEntity: Entity | null }>()
const plantNameToEntity = new Map<string, Entity>()

function enablePlantClick(entity: Entity) {
  if (!overrideDailyLimit && dailyLimitReached) return
  const info = plantRegistry.get(entity)
  if (!info) return
  pointerEventsSystem.onPointerDown(
    { entity: info.clickTarget, opts: { button: InputAction.IA_POINTER, hoverText: 'Water', maxDistance: 3 } },
    () => waterPlant(entity, info.plantName),
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
  PointerEvents.deleteFrom(info.clickTarget)
}

function onDailyLimitReached() {
  dailyLimitReached = true
  for (const [entity] of plantRegistry) {
    if (!PlantData.get(entity).isWatered) disablePlantClick(entity)
  }
  updateProgressText()
}

export function resetDailyLimit() {
  playerWateredToday = 0
  dailyLimitReached  = false
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

function playAtPlayer(soundEntity: Entity, audioClipUrl: string, volume: number) {
  const pos = Transform.getOrNull(engine.PlayerEntity)?.position ?? { x: 8, y: 1, z: 8 }
  Transform.getMutable(soundEntity).position = pos
  AudioSource.createOrReplace(soundEntity, { audioClipUrl, playing: false, loop: false, volume, pitch: 1 })
  timers.setTimeout(() => { AudioSource.getMutable(soundEntity).playing = true }, 0)
}

function playHoverSound()    { playAtPlayer(hoverSoundEntity,    'assets/scene/Sounds/hover.mp3',    0.7) }
function playClickSound()    { playAtPlayer(clickSoundEntity,    'assets/scene/Sounds/click.mp3',    0.9) }
function playWateringSound() { playAtPlayer(wateringSoundEntity, 'assets/scene/Sounds/watering.mp3', 1.0) }

function playMagicFXSound() {
  const pos = Transform.getOrNull(engine.PlayerEntity)?.position ?? { x: 8, y: 1, z: 8 }
  const ent = engine.addEntity()
  Transform.create(ent, { position: pos })
  AudioSource.create(ent, { audioClipUrl: 'assets/scene/Sounds/MagicFX.mp3', playing: true, loop: false, volume: 1.0, pitch: 1 })
  timers.setTimeout(() => engine.removeEntity(ent), 8_000)
}

const WATER_DISTANCE = 1.5

function triggerWateringEmote(plantEntity: Entity) {
  const plantPos  = Transform.getOrNull(plantEntity)?.position
  const playerPos = Transform.getOrNull(engine.PlayerEntity)?.position
  if (plantPos && playerPos) {
    const dx  = playerPos.x - plantPos.x
    const dz  = playerPos.z - plantPos.z
    const len = Math.sqrt(dx * dx + dz * dz)
    const nx  = len > 0.001 ? dx / len : 0
    const nz  = len > 0.001 ? dz / len : 1
    movePlayerTo({
      newRelativePosition: { x: plantPos.x + nx * WATER_DISTANCE, y: playerPos.y, z: plantPos.z + nz * WATER_DISTANCE },
      avatarTarget: plantPos,
    })
  }

  emoteActive    = true
  emoteStartPos  = Transform.getOrNull(engine.PlayerEntity)?.position ?? null
  const gen      = ++emoteGen

  timers.setTimeout(() => { triggerSceneEmote({ src: EMOTE_SRC, loop: false }) }, 400)

  timers.setTimeout(() => {
    if (emoteGen !== gen) return
    emoteActive   = false
    emoteStartPos = null
    const pos = Transform.getOrNull(engine.PlayerEntity)?.position
    if (pos) movePlayerTo({ newRelativePosition: pos })
  }, 400 + EMOTE_TOTAL_MS)
}

// ---------------------------------------------------------------
// Plant lifecycle
// ---------------------------------------------------------------

/** Schedule a client-side expiry timer (for the local player's plants only). */
function scheduleExpiry(entity: Entity, sessionTimestamp: number, delayMs: number) {
  timers.setTimeout(() => {
    if (isBloomActive()) return
    const pd = PlantData.getMutable(entity)
    if (!pd.isWatered || pd.wateredAt !== sessionTimestamp) return

    pd.isWatered = false
    pd.wateredAt = 0
    updateProgressText()

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

/** Water a single plant — optimistic local update + server message. */
function waterPlant(entity: Entity, plantId: string) {
  if (isBloomActive()) return
  if (emoteActive)     return
  if (!roomReady && !runtimeTestMode) { showToast('Connecting...', 1_500); return }

  const pd = PlantData.getMutable(entity)
  if (pd.isWatered) return

  if (!overrideDailyLimit && playerWateredToday >= dailyWaterLimit) return

  const now = Date.now()
  pd.isWatered = true
  pd.wateredAt = now

  playerWateredToday++
  const justHitLimit = !overrideDailyLimit && playerWateredToday >= dailyWaterLimit
  if (justHitLimit) onDailyLimitReached()

  disablePlantClick(entity)
  setDropFade(entity, 'out')

  // ── Event sequence ──────────────────────────────────────────
  playClickSound()
  triggerWateringEmote(entity)

  timers.setTimeout(playWateringSound, 400)
  timers.setTimeout(() => {
    const pos = Transform.getOrNull(entity)?.position
    if (pos) triggerGroundRipple(pos)
  }, 400)

  timers.setTimeout(() => {
    const current = PlantData.get(entity)
    if (!current.isWatered || current.wateredAt !== now) return
    Animator.playSingleAnimation(entity, ANIM_TO_HEALTHY)
    playMagicFXSound()
    timers.setTimeout(() => {
      const latest = PlantData.get(entity)
      if (latest.isWatered && latest.wateredAt === now) {
        Animator.playSingleAnimation(entity, ANIM_HEALTHY_STATE)
        const plantPos = Transform.getOrNull(entity)?.position
        if (plantPos) triggerSparkle(plantPos)
      }
    }, ANIM_TRANSITION_MS)
  }, EMOTE_DURATION_MS)

  // ── Server message (authoritative validation + persistence) ──
  room.send('waterPlant', { plantId })

  // ── Local UI ─────────────────────────────────────────────────
  updateProgressText()
  showToast('Plant Watered!', 2_500, true)
  if (justHitLimit) timers.setTimeout(() => {
    showDailyLimit(formatDailyLimitMessage(runtimeTestMode))
  }, 2_500)

  // Schedule client-side expiry (test mode: 5 min / prod: 6 h)
  const expiryMs = runtimeTestMode ? 5 * 60 * 1000 : 6 * 60 * 60 * 1000
  scheduleExpiry(entity, now, expiryMs)
}

/** Visual-only reset — called when server broadcasts bloomReset. */
export function resetAllPlants() {
  endBloom()
  endBloomSparkles()
  stopFireflies()
  hidePersistent()

  resetQueue = []
  for (const [entity] of engine.getEntitiesWith(PlantData)) {
    const pd   = PlantData.getMutable(entity)
    pd.isWatered = false
    pd.wateredAt = 0
    resetQueue.push(entity)
  }
  // Also reset daily counters so plants are immediately clickable again
  playerWateredToday = 0
  dailyLimitReached  = false

  resetPhase   = 'to_droopy'
  resetTimerMs = 0
  updateProgressText()
  console.log(`[Client] resetAllPlants — ${resetQueue.length} plants queued`)
}

function resetAnimSystem(dt: number) {
  if (resetPhase === 'done') return

  if (resetPhase === 'to_droopy') {
    const entity = resetQueue.shift()
    if (entity) {
      Animator.stopAllAnimations(entity, true)
      Animator.playSingleAnimation(entity, ANIM_TO_DROOPY, true)
    }
    if (resetQueue.length === 0) {
      resetPhase   = 'wait'
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
    }
    if (resetQueue.length === 0) {
      resetPhase = 'done'
      for (const entity of plantRegistry.keys()) enablePlantClick(entity)
      console.log('[Client] Reset complete — all plants droopy')
    }
  }
}

// ---------------------------------------------------------------
// Per-plant setup
// ---------------------------------------------------------------

function setupPlant(plantName: string) {
  const entity = engine.getEntityOrNullByName(plantName)
  if (!entity) { console.log(`[WateringSystem] Entity not found: ${plantName}`); return }

  if (PlantData.has(entity)) {
    console.log(`[WateringSystem] DUPLICATE skipped: "${plantName}" (entity ${entity})`)
    return
  }

  PlantData.create(entity, { isWatered: false, wateredAt: 0 })

  let clickTarget:    Entity
  let clickboxEntity: Entity | null = null
  if (useClickbox) {
    const clickBox = engine.addEntity()
    Transform.create(clickBox, { position: { x: 0, y: 1, z: 0 }, scale: { x: 1.5, y: 2, z: 1.5 }, parent: entity })
    MeshCollider.setBox(clickBox, ColliderLayer.CL_POINTER)
    clickTarget    = clickBox
    clickboxEntity = clickBox
  } else {
    clickTarget = entity
  }

  plantRegistry.set(entity, { clickTarget, plantName, clickboxEntity })
  plantNameToEntity.set(plantName, entity)
  enablePlantClick(entity)

  const drop = engine.addEntity()
  Transform.create(drop, { position: { x: 0, y: WATER_DROP_Y, z: 0 }, scale: { x: 1, y: 1, z: 1 }, parent: entity })
  GltfContainer.create(drop, { src: WATER_DROP_SRC })
  Billboard.create(drop, { billboardMode: BillboardMode.BM_Y })
  dropMap.set(entity, { entity: drop, fade: 'visible', fadeMs: 0 })
}

// ---------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------

export function setupWateringSystem() {
  progressEntity = engine.addEntity()
  Transform.create(progressEntity, { position: { x: 8, y: 3.5, z: 8 } })
  TextShape.create(progressEntity, {
    text: `0/${BLOOM_THRESHOLD} Plants Watered${TEST_MODE ? '\n[TEST MODE]' : ''}`,
    fontSize: 3,
  })
  Billboard.create(progressEntity, { billboardMode: BillboardMode.BM_Y })

  // Bloom system — client visual only; server drives trigger + reset
  setupBloomSystem({
    testMode:      TEST_MODE,
    onReset:       () => {},   // server sends bloomReset — handled via message below
    onVisualBloom: () => {
      hidePersistent()
      triggerBloomShockwave()
      startFireflies()
      const positions: Array<{ x: number; y: number; z: number }> = []
      for (const [entity] of plantRegistry) {
        const pos = Transform.getOrNull(entity)?.position
        if (pos) positions.push(pos)
      }
      triggerBloomSparkles(positions)
    },
  })

  // Sound entities
  const SND_POS = { x: 8, y: 1, z: 8 }
  hoverSoundEntity    = engine.addEntity()
  Transform.create(hoverSoundEntity,    { position: SND_POS })
  AudioSource.create(hoverSoundEntity,  { audioClipUrl: 'assets/scene/Sounds/hover.mp3',    playing: false, loop: false, volume: 1, pitch: 1 })
  clickSoundEntity    = engine.addEntity()
  Transform.create(clickSoundEntity,    { position: SND_POS })
  AudioSource.create(clickSoundEntity,  { audioClipUrl: 'assets/scene/Sounds/click.mp3',    playing: false, loop: false, volume: 1, pitch: 1 })
  wateringSoundEntity = engine.addEntity()
  Transform.create(wateringSoundEntity, { position: SND_POS })
  AudioSource.create(wateringSoundEntity, { audioClipUrl: 'assets/scene/Sounds/watering.mp3', playing: false, loop: false, volume: 1, pitch: 1 })

  // Wire up each plant
  for (const name of PLANT_NAMES) setupPlant(name)

  // Deferred animator setup — ensures GltfContainers have loaded
  timers.setTimeout(() => {
    for (const name of PLANT_NAMES) {
      const entity = engine.getEntityOrNullByName(name)
      if (!entity) continue
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

  setupPetalSystem()
  setupSparkleSystem()
  setupAmbientFX()

  engine.addSystem(emoteCleanupSystem)
  engine.addSystem(musicFadeSystem)
  engine.addSystem(resetAnimSystem)
  engine.addSystem(dropFadeSystem)
  engine.addSystem(petalParticleSystem)
  engine.addSystem(sparkleSystem)
  engine.addSystem(bloomSparkleSystem)
  engine.addSystem(ambientFXSystem)

  // ── Room ready — set flag so waterPlant() can proceed ─────
  room.onReady(() => {
    console.log('[Client] Connected to room')
    roomReady = true
  })

  // ── Server message handlers ────────────────────────────────

  /** Server confirmed a watering — update daily count display. */
  room.onMessage('playerDailyState', (data) => {
    playerWateredToday = data.wateredToday
    if (!initialLoadDone) {
      initialLoadDone = true
      showWelcomeProgress()
    }
    if (!overrideDailyLimit && playerWateredToday >= dailyWaterLimit && !dailyLimitReached) {
      onDailyLimitReached()
    }
    updateProgressText()
  })

  /** Server rejected a watering — revert optimistic progress counters. */
  room.onMessage('waterRejected', (data) => {
    console.log(`[Client] Water rejected: ${data.plantId} (${data.reason})`)
    if (data.reason === 'already_watered' || data.reason === 'bloom_active') {
      // Revert the optimistic count; plantStateUpdate will correct the plant visual
      playerWateredToday = Math.max(0, playerWateredToday - 1)
      if (dailyLimitReached && playerWateredToday < dailyWaterLimit) {
        dailyLimitReached = false
        for (const [entity] of plantRegistry) {
          if (!PlantData.get(entity).isWatered) enablePlantClick(entity)
        }
      }
      updateProgressText()
    }
  })

  /** Server triggered bloom — start visual sequence. */
  room.onMessage('bloomTriggered', () => {
    if (!isBloomActive()) {
      triggerBloomEvent()
      showPersistent(formatBloomCountdown(runtimeTestMode))
    }
  })

  /** Server reset all plants after bloom — drive visual reset. */
  room.onMessage('bloomReset', () => {
    resetAllPlants()
  })

  /** Server broadcast: a plant's watered state changed (remote water, expiry, or join-sync). */
  room.onMessage('plantStateUpdate', (data) => {
    const entity = plantNameToEntity.get(data.plantId)
    if (!entity) return
    const local = PlantData.getOrNull(entity)
    if (!local) return

    if (data.isWatered && !local.isWatered) {
      // Remote player watered this plant — play full visual sequence
      const pd = PlantData.getMutable(entity)
      pd.isWatered = true
      pd.wateredAt = data.wateredAt
      disablePlantClick(entity)
      setDropFade(entity, 'out')

      // Play transition animation then settle into healthy idle
      Animator.playSingleAnimation(entity, ANIM_TO_HEALTHY)
      const plantPos = Transform.getOrNull(entity)?.position
      if (plantPos) {
        // Play watering sound at the plant position (not the local player)
        Transform.getMutable(wateringSoundEntity).position = plantPos
        AudioSource.createOrReplace(wateringSoundEntity, { audioClipUrl: 'assets/scene/Sounds/watering.mp3', playing: true, loop: false, volume: 1.0, pitch: 1 })
        triggerGroundRipple(plantPos)
      }
      timers.setTimeout(() => {
        if (!PlantData.get(entity).isWatered) return
        Animator.playSingleAnimation(entity, ANIM_HEALTHY_STATE)
        if (plantPos) triggerSparkle(plantPos)
      }, ANIM_TRANSITION_MS)

      updateProgressText()
      console.log(`[Client] plantStateUpdate watered: ${data.plantId}`)

    } else if (!data.isWatered && local.isWatered) {
      // Plant expired or bloom reset
      const pd = PlantData.getMutable(entity)
      pd.isWatered = false
      pd.wateredAt = 0
      enablePlantClick(entity)
      setDropFade(entity, 'in')
      Animator.playSingleAnimation(entity, ANIM_DROOPY_STATE)
      updateProgressText()
      console.log(`[Client] plantStateUpdate expired: ${data.plantId}`)
    }
  })

  // Reset emote state that may have persisted across hot-reloads
  timers.setTimeout(() => {
    const pos = Transform.getOrNull(engine.PlayerEntity)?.position
    if (pos) movePlayerTo({ newRelativePosition: pos, avatarTarget: pos })
  }, 500)

  // Player identity
  playerId = getPlayer()?.userId ?? 'unknown'
  console.log(`[WateringSystem] Player ID: ${playerId}`)
  updateProgressText()

  // Re-entry welcome toast
  onEnterSceneObservable.add((player) => {
    const localId = getPlayer()?.userId
    console.log(`[EnterScene] player=${player.userId} local=${localId} loadDone=${initialLoadDone}`)
    if (!localId || player.userId !== localId) return
    if (initialLoadDone) showWelcomeProgress()
  })
}

// ---------------------------------------------------------------
// Runtime setters & getters — used by the test panel
// ---------------------------------------------------------------

export function setOverrideDailyLimit(val: boolean): void {
  overrideDailyLimit = val
  updateProgressText()
}

export function setDailyWaterLimit(val: number): void {
  dailyWaterLimit = Math.max(1, Math.min(TOTAL_PLANTS, val))
  updateProgressText()
}

export function setRuntimeTestMode(val: boolean): void {
  runtimeTestMode = val
  updateProgressText()
}

export function setUseClickbox(val: boolean): void {
  if (val === useClickbox) return
  useClickbox = val
  for (const [plantEntity, info] of plantRegistry) {
    pointerEventsSystem.removeOnPointerDown(info.clickTarget)
    pointerEventsSystem.removeOnPointerHoverEnter(info.clickTarget)
    PointerEvents.deleteFrom(info.clickTarget)
    if (val) {
      const clickBox = engine.addEntity()
      Transform.create(clickBox, { position: { x: 0, y: 1, z: 0 }, scale: { x: 1.5, y: 2, z: 1.5 }, parent: plantEntity })
      MeshCollider.setBox(clickBox, ColliderLayer.CL_POINTER)
      info.clickTarget    = clickBox
      info.clickboxEntity = clickBox
    } else {
      if (info.clickboxEntity) engine.removeEntity(info.clickboxEntity)
      info.clickboxEntity = null
      info.clickTarget    = plantEntity
    }
    if (!PlantData.get(plantEntity).isWatered) enablePlantClick(plantEntity)
  }
}

export function getUseClickbox(): boolean { return useClickbox }

export function getWateringStatus() {
  return {
    wateredCount:       computeWateredCount(),
    totalPlants:        TOTAL_PLANTS,
    playerWateredToday,
    dailyWaterLimit,
    dailyLimitReached,
    overrideDailyLimit,
    runtimeTestMode,
  }
}

export function forceTriggerBloom(): void {
  if (isBloomActive()) return
  triggerBloomEvent()
  showPersistent(formatBloomCountdown(runtimeTestMode))
}

export function resetAllPlantsTestPanel(): void {
  resetAllPlants()
}
