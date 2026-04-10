// =============================================================
// The Living Garden — Watering System (CLIENT ONLY)
// All game-state authority has moved to src/server/server.ts.
// This file owns: click handling, animations, sounds, UI updates.
//
// Server communication:
//   send    →  room.send('waterPlant', { plantId })
//   receive ←  playerDailyState | waterRejected | plantStateUpdate | bloomTriggered | bloomReset
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
  MeshRenderer,
  Material,
  ColliderLayer,
  pointerEventsSystem,
  PointerEvents,
  InputAction,
  Transform,
  VisibilityComponent,
  Tween,
  EasingFunction,
  timers,
} from '@dcl/sdk/ecs'
import { getPlayer }              from '@dcl/sdk/players'
import { onEnterSceneObservable } from '@dcl/sdk/observables'
import { setupPetalSystem, petalParticleSystem }                                                                   from './petalSystem'
import { setupBloomSystem, triggerBloomEvent, endBloom, isBloomActive, musicFadeSystem }                          from './bloomSystem'
import { setupSparkleSystem, triggerSparkle, triggerWateringTribute, sparkleSystem, triggerBloomSparkles, endBloomSparkles, bloomSparkleSystem } from './sparkleSystem'
import { setupAmbientFX, triggerBloomShockwave, triggerGroundRipple, startFireflies, stopFireflies, ambientFXSystem } from './ambientFX'
import { setupProgressBars, updateProgressBars }              from './progressBarsSystem'
import { setupGroundLights, updateGroundLights, triggerGroundLightBurst, setGroundLightsBloom } from './groundLightSystem'
import { setupLeaderboardBoards, updateLeaderboardDisplay }   from './leaderboardSystem'
import { setupFairyLights, setFairyLightsBloom }             from './fairyLightSystem'
import { showToast, showDailyLimit, hideDailyLimit, showPersistent, hidePersistent, formatBloomCountdown, formatDailyLimitMessage } from './notifications'
import { movePlayerTo, triggerSceneEmote }  from '~system/RestrictedActions'
import { room }                             from './shared/messages'
import { TOTAL_PLANTS, BLOOM_THRESHOLD, DAILY_WATER_LIMIT, PLANT_NAMES } from './shared/config'

// ===============================================================
// ██████╗ ██████╗ ███╗   ██╗███████╗██╗ ██████╗
// ██╔════╝██╔═══██╗████╗  ██║██╔════╝██║██╔════╝
// ██║     ██║   ██║██╔██╗ ██║█████╗  ██║██║  ███╗
// ██║     ██║   ██║██║╚██╗██║██╔══╝  ██║██║   ██║
// ╚██████╗╚██████╔╝██║ ╚████║██║     ██║╚██████╔╝
//  ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝     ╚═╝ ╚═════╝
// ===============================================================

// ── Test / debug ──────────────────────────────────────────────
// Set to true to compress all timers for rapid prototyping:
//   - Watered expiry  : 6h  → 5min
//   - Bloom delay     : next 6pm UTC → 10s
const TEST_MODE = false

// ── Animation clip names (must match GLB exactly) ─────────────
const ANIM_DROOPY_STATE  = 'CloseIdle'  // droopy idle loop
const ANIM_TO_HEALTHY    = 'Play'       // droopy → healthy transition
const ANIM_HEALTHY_STATE = 'OpenIdle'   // healthy idle loop
// Note: no reverse transition clip — reset snaps directly to CloseIdle
const ANIM_TRANSITION_MS = 6_000        // ms — duration of Play clip
const ANIMATOR_INIT_DELAY_MS = 1000     // ms — defer Animator.create until GLBs load

// ── Unhealthy Rose (shown while plant is not watered) ─────────
const UNHEALTHY_ROSE_SRC  = 'assets/scene/Models/UnhealthyRose/UnhealthyRose.glb'
const ANIM_UNHEALTHY_IDLE = 'CloseIdle'  // idle loop in UnhealthyRose.glb

// ── Emote ─────────────────────────────────────────────────────
const EMOTE_SRC       = 'assets/scene/Models/Emotes/WateringCan_emote.glb'
const EMOTE_TOTAL_MS  = 2933   // ms — full clip length (keeps emoteActive locked)
const WATER_DISTANCE  = 2    // metres — how close player steps to the plant

// ── Watering choreography milestones ─────────────────────────
// t=0           click — player steps to plant, emote fires
// t=WATER_FX    watering sound + ground ripple
// t=WATER_ANIM  plant tips forward, magic FX
// t=WATER_ANIM + ANIM_TRANSITION_MS — sparkles burst
const WATER_FX_MS   = 400
const WATER_ANIM_MS = 1500

// ── Water drop prop ───────────────────────────────────────────
const WATER_DROP_SRC = 'assets/scene/Models/waterDrop/waterDrop.glb'
const WATER_DROP_Y   = 0.8   // local Y above plant pivot
const DROP_FADE_MS   = 1600   // ms for scale-in / scale-out tween

// ── Sounds ────────────────────────────────────────────────────
const SND_HOVER    = 'assets/scene/Sounds/hover.mp3'
const SND_CLICK    = 'assets/scene/Sounds/click.mp3'
const SND_WATERING = 'assets/scene/Sounds/watering.mp3'
const SND_MAGIC    = 'assets/scene/Sounds/MagicFX.mp3'
const VOL_HOVER    = 0.7
const VOL_CLICK    = 0.9
const VOL_WATERING = 1.0
const VOL_MAGIC    = 1.0
const SND_INIT_POS = { x: 8, y: 1, z: 8 }   // initial transform — overwritten on play
const MAGIC_SOUND_CLEANUP_MS = 8_000          // remove one-shot entity after this many ms

// ── Clickbox (optional alternative pointer target) ────────────
const CLICKBOX_Y     = 1    // local Y offset above plant pivot
const CLICKBOX_SCALE = { x: 1.5, y: 2, z: 1.5 }

// ── In-world text labels ──────────────────────────────────────
const FONT_PCT_LABEL   = 6    // Image_2–5 + wateringPercentage entity
const FONT_BLOOM_LABEL = 2.5  // Image_6–9 bloom countdown
const FONT_BLOOM_CTR   = 1.5  // centerTextBloom entity
// TextShape has no emissiveIntensity — colour only.
const TEXT_LABEL_COLOR = { r: 1.0, g: 0.78, b: 0.5, a: 1 }  // gold/amber
const SCALE_PCT_LABEL   = 0.6   // uniform scale applied to Image_2–5 + wateringPercentage
const SCALE_BLOOM_LABEL = 1.4   // uniform scale applied to Image_6–9

// ── Timers & durations ────────────────────────────────────────
const WELCOME_DELAY_MS        = 1_500    // wait for server sync before first welcome toast
const TOAST_WATERED_MS        = 2_500    // "Plant Watered! X%" duration
const TOAST_WELCOME_MS        = 4_000    // "X% of Plants Watered" duration
const BLOOM_LABEL_TICK_MS     = 60_000   // re-check bloom countdown every 60 s
const LIVE_WATER_THRESHOLD_MS = 10_000   // plantStateUpdate < 10 s old = live water by another player
const LIMIT_DEBOUNCE_MS       = 5_000    // min gap between daily-limit toast notifications

// ── Expiry ────────────────────────────────────────────────────
const EXPIRY_PROD_MS = 6 * 60 * 60 * 1_000   // 6 hours
const EXPIRY_TEST_MS = 5 * 60 * 1_000        // 5 minutes (TEST_MODE)

// ── Bloom notification text ───────────────────────────────────
// NOTIFY_BLOOM_ACTIVE replaces the countdown pill the moment the visual
// bloom launches (3 s after bloomTriggered) and stays until the reset.
const NOTIFY_BLOOM_ACTIVE = 'The Garden is in Full Bloom!'

// =============================================================
//                  end of config
// =============================================================

let runtimeTestMode    = TEST_MODE
let overrideDailyLimit = false
let useClickbox        = false
let dailyWaterLimit    = DAILY_WATER_LIMIT

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

let percentageEntity:    Entity
const wateringLabels:    Entity[] = []   // Image_2–5 placed in Creator Hub
const bloomLabels:       Entity[] = []   // Image_6–9 placed in Creator Hub
let hoverSoundEntity:    Entity
let clickSoundEntity:    Entity
let wateringSoundEntity: Entity

let playerWateredToday      = 0
let dailyLimitReached       = false
let lastLimitNotificationMs = 0
let initialLoadDone         = false
let roomReady               = false

let emoteActive = false

/** plant entity → its drop GLB entity */
const dropMap = new Map<Entity, Entity>()

/** plant entity → its UnhealthyRose entity */
const roseMap = new Map<Entity, Entity>()

function showRose(entity: Entity)  {
  const r = roseMap.get(entity); if (r) VisibilityComponent.createOrReplace(r, { visible: true  })
}
function hideRose(entity: Entity)  {
  const r = roseMap.get(entity); if (r) VisibilityComponent.createOrReplace(r, { visible: false })
}
function showPlant(entity: Entity) { VisibilityComponent.createOrReplace(entity, { visible: true  }) }
function hidePlant(entity: Entity) { VisibilityComponent.createOrReplace(entity, { visible: false }) }

function setDropFade(plantEntity: Entity, direction: 'in' | 'out') {
  const drop = dropMap.get(plantEntity)
  if (!drop) return
  if (direction === 'in') {
    Tween.setScale(drop,
      { x: 0.001, y: 0.001, z: 0.001 },
      { x: 1,     y: 1,     z: 1     },
      DROP_FADE_MS,
      EasingFunction.EF_EASEOUTBACK,
    )
  } else {
    Tween.setScale(drop,
      { x: 1,     y: 1,     z: 1     },
      { x: 0.001, y: 0.001, z: 0.001 },
      DROP_FADE_MS,
      EasingFunction.EF_EASEINBACK,
    )
  }
}


// ---------------------------------------------------------------
// Reset animation state machine
// ---------------------------------------------------------------

type ResetPhase = 'to_droopy' | 'done'
const reset = { phase: 'done' as ResetPhase, queue: [] as Entity[] }

// ---------------------------------------------------------------
// Scene-asset visibility
// ---------------------------------------------------------------

let _sceneAssetsResolved = false
let _centerTextBloom:    Entity | null = null
let _centerTextProgress: Entity | null = null

function resolveSceneAssets() {
  if (_sceneAssetsResolved) return
  _sceneAssetsResolved  = true
  _centerTextBloom    = engine.getEntityOrNullByName('centerTextBloom')
  _centerTextProgress = engine.getEntityOrNullByName('centerTextProgress')
}

function setVisible(entity: Entity | null, visible: boolean) {
  if (!entity) return
  VisibilityComponent.createOrReplace(entity, { visible })
}

function updateSceneAssets() {
  resolveSceneAssets()
  // Show bloom state whenever threshold is met OR bloom has been force-triggered
  const bloomMode = isBloomActive() || computeWateredCount() >= BLOOM_THRESHOLD
  setVisible(_centerTextBloom,    bloomMode)
  setVisible(_centerTextProgress, !bloomMode)
  setVisible(percentageEntity, !bloomMode)
  for (const e of wateringLabels) setVisible(e, !bloomMode)
  if (bloomMode) setBloomLabelText(formatBloomCountdown(runtimeTestMode))
}

// ---------------------------------------------------------------
// Bloom label helpers
// ---------------------------------------------------------------

function setBloomLabelText(text: string) {
  for (const e of bloomLabels) TextShape.getMutable(e).text = text
}

function clearBloomLabels() {
  for (const e of bloomLabels) TextShape.getMutable(e).text = ''
}

function startBloomLabelUpdater() {
  if (runtimeTestMode) { setBloomLabelText('All plants watered!\nBloom starting soon...'); return }
  setBloomLabelText(formatBloomCountdown(false))
  function tick() {
    if (!isBloomActive()) return
    setBloomLabelText(formatBloomCountdown(false))
    timers.setTimeout(tick, BLOOM_LABEL_TICK_MS)
  }
  timers.setTimeout(tick, BLOOM_LABEL_TICK_MS)
}

// ---------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------

function computeWateredCount(): number {
  let count = 0
  for (const [, pd] of engine.getEntitiesWith(PlantData)) {
    if (pd.isWatered) count++
  }
  return count
}

function updateProgressText() {
  const count  = computeWateredCount()
  const pct    = Math.round((count / TOTAL_PLANTS) * 100)
  const pctStr = `${pct}%`
  TextShape.getMutable(percentageEntity).text = pctStr
  for (const e of wateringLabels) TextShape.getMutable(e).text = pctStr
  updateProgressBars(count, TOTAL_PLANTS)
  updateGroundLights(count)
  updateSceneAssets()
}

function showWelcomeProgress() {
  const count = computeWateredCount()
  const pct   = Math.round((count / TOTAL_PLANTS) * 100)
  showToast(`Water the plants! ${pct}% watered`, TOAST_WELCOME_MS)
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

export function resetDailyLimit(): void {
  playerWateredToday = 0
  dailyLimitReached  = false
  hideDailyLimit()
  for (const [entity] of plantRegistry) {
    if (!PlantData.get(entity).isWatered) enablePlantClick(entity)
  }
  updateProgressText()
  console.log('[TEST] Daily limit reset to 0')
}

// ---------------------------------------------------------------
// Interaction sounds & emote
// ---------------------------------------------------------------

function playAtPlayer(soundEntity: Entity, audioClipUrl: string, volume: number) {
  const pos = Transform.getOrNull(engine.PlayerEntity)?.position ?? { x: 8, y: 1, z: 8 }
  Transform.getMutable(soundEntity).position = pos
  AudioSource.createOrReplace(soundEntity, { audioClipUrl, playing: false, loop: false, volume, pitch: 1 })
  timers.setTimeout(() => { AudioSource.getMutable(soundEntity).playing = true }, 0)
}

function playHoverSound()    { playAtPlayer(hoverSoundEntity,    SND_HOVER,    VOL_HOVER)    }
function playClickSound()    { playAtPlayer(clickSoundEntity,    SND_CLICK,    VOL_CLICK)    }
function playWateringSound() { playAtPlayer(wateringSoundEntity, SND_WATERING, VOL_WATERING) }

function playMagicFXSound() {
  const pos = Transform.getOrNull(engine.PlayerEntity)?.position ?? { x: 8, y: 1, z: 8 }
  const ent = engine.addEntity()
  Transform.create(ent, { position: pos })
  AudioSource.create(ent, { audioClipUrl: SND_MAGIC, playing: true, loop: false, volume: VOL_MAGIC, pitch: 1 })
  timers.setTimeout(() => engine.removeEntity(ent), MAGIC_SOUND_CLEANUP_MS)
}

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

  emoteActive = true
  triggerSceneEmote({ src: EMOTE_SRC, loop: false })
  timers.setTimeout(() => { emoteActive = false }, EMOTE_TOTAL_MS)
}

// ---------------------------------------------------------------
// Plant lifecycle
// ---------------------------------------------------------------

function scheduleExpiry(entity: Entity, sessionTimestamp: number, delayMs: number) {
  timers.setTimeout(() => {
    if (isBloomActive()) return
    const pd = PlantData.getMutable(entity)
    if (!pd.isWatered || pd.wateredAt !== sessionTimestamp) return

    pd.isWatered = false
    pd.wateredAt = 0
    updateProgressText()

    // Swap back to unhealthy rose
    hidePlant(entity)
    showRose(entity)
    enablePlantClick(entity)
    setDropFade(entity, 'in')
  }, delayMs)
}

function waterPlant(entity: Entity, plantId: string) {
  if (isBloomActive()) return
  if (emoteActive)     return

  const pd = PlantData.getMutable(entity)
  if (pd.isWatered) return

  if (!overrideDailyLimit && playerWateredToday >= dailyWaterLimit) {
    const now = Date.now()
    if (now - lastLimitNotificationMs > LIMIT_DEBOUNCE_MS) {
      lastLimitNotificationMs = now
      showDailyLimit(formatDailyLimitMessage(runtimeTestMode))
    }
    return
  }

  const now = Date.now()
  pd.isWatered = true
  pd.wateredAt = now

  playerWateredToday++
  const justHitLimit = !overrideDailyLimit && playerWateredToday >= dailyWaterLimit
  if (justHitLimit) onDailyLimitReached()

  disablePlantClick(entity)
  setDropFade(entity, 'out')

  playClickSound()
  triggerWateringEmote(entity)

  // t=WATER_FX_MS — sound + ripple + light burst
  timers.setTimeout(playWateringSound, WATER_FX_MS)
  timers.setTimeout(() => {
    const pos = Transform.getOrNull(entity)?.position
    if (pos) triggerGroundRipple(pos)
    triggerGroundLightBurst()
  }, WATER_FX_MS)

  // t=WATER_ANIM_MS — swap rose→plant, animate to healthy
  timers.setTimeout(() => {
    const current = PlantData.get(entity)
    if (!current.isWatered || current.wateredAt !== now) return
    hideRose(entity)
    showPlant(entity)
    Animator.playSingleAnimation(entity, ANIM_TO_HEALTHY)
    playMagicFXSound()
    // t=WATER_ANIM_MS + ANIM_TRANSITION_MS — sparkles burst
    timers.setTimeout(() => {
      const latest = PlantData.get(entity)
      if (latest.isWatered && latest.wateredAt === now) {
        Animator.playSingleAnimation(entity, ANIM_HEALTHY_STATE)
        const plantPos = Transform.getOrNull(entity)?.position
        if (plantPos) {
          triggerSparkle(plantPos)
          timers.setTimeout(() => triggerWateringTribute(plantPos), 650)
        }
      }
    }, ANIM_TRANSITION_MS)
  }, WATER_ANIM_MS)

  room.send('waterPlant', { plantId })

  updateProgressText()
  const _pct = Math.round((computeWateredCount() / TOTAL_PLANTS) * 100)
  showToast(`Plant Watered! ${_pct}%`, TOAST_WATERED_MS, true)
  if (justHitLimit) timers.setTimeout(() => {
    showDailyLimit(formatDailyLimitMessage(runtimeTestMode))
  }, TOAST_WATERED_MS)

  const expiryMs = runtimeTestMode ? EXPIRY_TEST_MS : EXPIRY_PROD_MS
  scheduleExpiry(entity, now, expiryMs)
}

export function resetAllPlants(): void {
  endBloom()
  endBloomSparkles()
  stopFireflies()
  setFairyLightsBloom(false)
  hidePersistent()

  reset.queue = []
  for (const [entity] of engine.getEntitiesWith(PlantData)) {
    const pd   = PlantData.getMutable(entity)
    pd.isWatered = false
    pd.wateredAt = 0
    reset.queue.push(entity)
  }
  reset.phase = 'to_droopy'
  updateProgressText()
  console.log(`[Client] resetAllPlants — ${reset.queue.length} plants queued`)
}

function resetAnimSystem(dt: number) {
  if (reset.phase === 'done') return

  // No reverse transition clip — snap each plant directly to droopy idle
  if (reset.phase === 'to_droopy') {
    const entity = reset.queue.shift()
    if (entity && !PlantData.get(entity).isWatered) {
      Animator.stopAllAnimations(entity, true)
      hidePlant(entity)
      showRose(entity)
      setDropFade(entity, 'in')
    }
    if (reset.queue.length === 0) {
      reset.phase = 'done'
      for (const e of plantRegistry.keys()) enablePlantClick(e)
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

  if (GltfContainer.has(entity)) {
    GltfContainer.getMutable(entity).visibleMeshesCollisionMask =
      ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER
  }

  // Spawn the UnhealthyRose model as a child — sits exactly on top of the plant
  const roseEntity = engine.addEntity()
  Transform.create(roseEntity, { parent: entity })
  GltfContainer.create(roseEntity, { src: UNHEALTHY_ROSE_SRC })
  roseMap.set(entity, roseEntity)

  // Start hidden — animator init (deferred below) will set visibility correctly
  hidePlant(entity)
  hideRose(entity)

  let clickTarget:    Entity
  let clickboxEntity: Entity | null = null
  if (useClickbox) {
    const clickBox = engine.addEntity()
    Transform.create(clickBox, { position: { x: 0, y: CLICKBOX_Y, z: 0 }, scale: CLICKBOX_SCALE, parent: entity })
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
  dropMap.set(entity, drop)
}

// ---------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------

/** Apply a uniform scale to an entity — safe whether or not it already has a Transform. */
function setScale(entity: Entity, s: number): void {
  const existing = Transform.getOrNull(entity)
  if (existing) {
    Transform.getMutable(entity).scale = { x: s, y: s, z: s }
  } else {
    Transform.create(entity, { scale: { x: s, y: s, z: s } })
  }
}

export function setupWateringSystem(): void {
  // ── Percentage text (entity "wateringPercentage" in Creator Hub) ──
  percentageEntity = engine.getEntityOrNullByName('wateringPercentage') ?? engine.addEntity()
  setScale(percentageEntity, SCALE_PCT_LABEL)
  TextShape.createOrReplace(percentageEntity, { text: '0%', fontSize: FONT_PCT_LABEL, textColor: TEXT_LABEL_COLOR })

  // ── Watering progress labels — Image_2 through Image_5 ──
  for (let i = 2; i <= 5; i++) {
    const e = engine.getEntityOrNullByName(`Image_${i}`)
    if (!e) { console.log(`[WateringSystem] Image_${i} not found`); continue }
    MeshRenderer.deleteFrom(e)
    Material.deleteFrom(e)
    setScale(e, SCALE_PCT_LABEL)
    TextShape.createOrReplace(e, { text: '0%', fontSize: FONT_PCT_LABEL, textColor: TEXT_LABEL_COLOR })
    wateringLabels.push(e)
  }

  // ── Bloom countdown labels — Image_6 through Image_9 ──
  for (let i = 6; i <= 9; i++) {
    const e = engine.getEntityOrNullByName(`Image_${i}`)
    if (!e) { console.log(`[WateringSystem] Image_${i} not found`); continue }
    MeshRenderer.deleteFrom(e)
    Material.deleteFrom(e)
    setScale(e, SCALE_BLOOM_LABEL)
    TextShape.createOrReplace(e, { text: '', fontSize: FONT_BLOOM_LABEL, textColor: TEXT_LABEL_COLOR })
    bloomLabels.push(e)
  }
  const ctb = engine.getEntityOrNullByName('centerTextBloom')
  if (ctb) {
    setScale(ctb, 1)
    TextShape.createOrReplace(ctb, { text: '', fontSize: FONT_BLOOM_CTR, textColor: TEXT_LABEL_COLOR })
    bloomLabels.push(ctb)
  } else {
    console.log('[WateringSystem] centerTextBloom not found')
  }

  setupLeaderboardBoards()

  setupBloomSystem({
    testMode:      TEST_MODE,
    onReset:       () => {},
    onVisualBloom: () => {
      // Switch the persistent pill from "Bloom in Xh Ym" → active bloom message.
      // Don't hide it — it must survive any daily-limit pill that may be stacked above it.
      showPersistent(NOTIFY_BLOOM_ACTIVE)
      triggerBloomShockwave()
      startFireflies()
      setFairyLightsBloom(true)
      setGroundLightsBloom(true)
      const positions: Array<{ x: number; y: number; z: number }> = []
      for (const [entity] of plantRegistry) {
        const pos = Transform.getOrNull(entity)?.position
        if (pos) positions.push(pos)
      }
      triggerBloomSparkles(positions)
    },
  })

  // Sound entities
  hoverSoundEntity    = engine.addEntity()
  Transform.create(hoverSoundEntity,    { position: SND_INIT_POS })
  AudioSource.create(hoverSoundEntity,  { audioClipUrl: SND_HOVER,    playing: false, loop: false, volume: VOL_HOVER,    pitch: 1 })
  clickSoundEntity    = engine.addEntity()
  Transform.create(clickSoundEntity,    { position: SND_INIT_POS })
  AudioSource.create(clickSoundEntity,  { audioClipUrl: SND_CLICK,    playing: false, loop: false, volume: VOL_CLICK,    pitch: 1 })
  wateringSoundEntity = engine.addEntity()
  Transform.create(wateringSoundEntity, { position: SND_INIT_POS })
  AudioSource.create(wateringSoundEntity, { audioClipUrl: SND_WATERING, playing: false, loop: false, volume: VOL_WATERING, pitch: 1 })

  for (const name of PLANT_NAMES) setupPlant(name)

  // Deferred animator setup — ensures GltfContainers have loaded
  timers.setTimeout(() => {
    for (const name of PLANT_NAMES) {
      const entity = engine.getEntityOrNullByName(name)
      if (!entity) continue
      const isWatered = PlantData.getOrNull(entity)?.isWatered ?? false

      // demoPlant animator
      Animator.createOrReplace(entity, {
        states: [
          { clip: ANIM_DROOPY_STATE,  playing: false, loop: true  },
          { clip: ANIM_TO_HEALTHY,    playing: false, loop: false },
          { clip: ANIM_HEALTHY_STATE, playing: false, loop: true  },
        ],
      })
      Animator.playSingleAnimation(entity, isWatered ? ANIM_HEALTHY_STATE : ANIM_DROOPY_STATE, true)

      // UnhealthyRose animator
      const roseEntity = roseMap.get(entity)
      if (roseEntity) {
        Animator.createOrReplace(roseEntity, {
          states: [{ clip: ANIM_UNHEALTHY_IDLE, playing: false, loop: true }],
        })
        Animator.playSingleAnimation(roseEntity, ANIM_UNHEALTHY_IDLE, true)
      }

      // Set correct initial visibility
      if (isWatered) {
        showPlant(entity)
        hideRose(entity)
      } else {
        hidePlant(entity)
        showRose(entity)
      }
    }
  }, ANIMATOR_INIT_DELAY_MS)

  setupPetalSystem()
  setupSparkleSystem()
  setupAmbientFX()
  setupFairyLights()
  setupProgressBars()
  setupGroundLights()

  engine.addSystem(musicFadeSystem)
  engine.addSystem(resetAnimSystem)
  engine.addSystem(petalParticleSystem)
  engine.addSystem(sparkleSystem)
  engine.addSystem(bloomSparkleSystem)
  engine.addSystem(ambientFXSystem)

  // Diagnostic: log when the SDK's internal room-ready atom fires
  room.onReady((isReady) => {
    console.log(`[Client] room.onReady fired: isReady=${isReady}`)
  })

  // ── Server message handlers ──────────────────────────────────

  room.onMessage('playerDailyState', (data) => {
    // First message from the server proves the room is functional — register the player now
    if (!roomReady) {
      roomReady = true
      console.log('[Client] Room confirmed via playerDailyState')
      const lp = getPlayer()
      room.send('registerPlayer', { displayName: lp?.name ?? lp?.userId ?? 'unknown' })
    }
    playerWateredToday = data.wateredToday
    if (!initialLoadDone) {
      initialLoadDone = true
      timers.setTimeout(showWelcomeProgress, WELCOME_DELAY_MS)
    }
    if (!overrideDailyLimit && playerWateredToday >= dailyWaterLimit && !dailyLimitReached) {
      onDailyLimitReached()
      showDailyLimit(formatDailyLimitMessage(runtimeTestMode))
    }
    updateProgressText()
  })

  room.onMessage('waterRejected', (data) => {
    console.log(`[Client] Water rejected: ${data.plantId} (${data.reason})`)

    if (data.reason === 'daily_limit') {
      playerWateredToday = Math.max(0, playerWateredToday - 1)
      if (!dailyLimitReached) onDailyLimitReached()
      const now = Date.now()
      if (now - lastLimitNotificationMs > LIMIT_DEBOUNCE_MS) {
        lastLimitNotificationMs = now
        showDailyLimit(formatDailyLimitMessage(runtimeTestMode))
      }
      return
    }

    if (data.reason === 'already_watered' || data.reason === 'bloom_active') {
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

  room.onMessage('bloomTriggered', () => {
    if (!isBloomActive()) {
      triggerBloomEvent()
      showPersistent(formatBloomCountdown(runtimeTestMode))
      startBloomLabelUpdater()
      updateSceneAssets()
    }
  })

  room.onMessage('bloomReset', () => {
    resetAllPlants()
    clearBloomLabels()
    setGroundLightsBloom(false)
    updateGroundLights(0)   // reset circles to hidden
  })

  room.onMessage('leaderboardUpdate', (data) => {
    const entries: Array<{ displayName: string; count: number }> = JSON.parse(data.entriesJson)
    updateLeaderboardDisplay(entries)
  })

  room.onMessage('plantStateUpdate', (data) => {
    const entity = plantNameToEntity.get(data.plantId)
    if (!entity) return
    const local = PlantData.getOrNull(entity)
    if (!local) return

    const wasWatered = local.isWatered
    const plantPos   = Transform.getOrNull(entity)?.position

    if (data.isWatered) {
      PlantData.getMutable(entity).isWatered = true
      if (!wasWatered) PlantData.getMutable(entity).wateredAt = data.wateredAt
      disablePlantClick(entity)

      if (!wasWatered) {
        const isLive = (Date.now() - data.wateredAt) < LIVE_WATER_THRESHOLD_MS
        if (isLive) {
          hideRose(entity)
          showPlant(entity)
          setDropFade(entity, 'out')
          Animator.playSingleAnimation(entity, ANIM_TO_HEALTHY)
          triggerGroundLightBurst()
          if (plantPos) {
            Transform.getMutable(wateringSoundEntity).position = plantPos
            AudioSource.createOrReplace(wateringSoundEntity, { audioClipUrl: SND_WATERING, playing: true, loop: false, volume: VOL_WATERING, pitch: 1 })
            triggerGroundRipple(plantPos)
          }
          timers.setTimeout(() => {
            if (!PlantData.get(entity).isWatered) return
            Animator.playSingleAnimation(entity, ANIM_HEALTHY_STATE)
            if (plantPos) triggerSparkle(plantPos)
          }, ANIM_TRANSITION_MS)
        } else {
          // State recovery on join — snap to healthy immediately, no fade
          hideRose(entity)
          showPlant(entity)
          Animator.playSingleAnimation(entity, ANIM_HEALTHY_STATE)
          const drop = dropMap.get(entity)
          if (drop) {
            Tween.deleteFrom(drop)
            Transform.getMutable(drop).scale = { x: 0.001, y: 0.001, z: 0.001 }
          }
        }
      }
    } else {
      PlantData.getMutable(entity).isWatered = false
      PlantData.getMutable(entity).wateredAt = 0
      enablePlantClick(entity)

      if (wasWatered) {
        hidePlant(entity)
        showRose(entity)
        setDropFade(entity, 'in')
      }
    }

    updateProgressText()
    console.log(`[Client] plantStateUpdate ${data.plantId} → ${data.isWatered ? 'watered' : 'droopy'}`)
  })

  const localPlayer = getPlayer()
  const playerId    = localPlayer?.userId ?? 'unknown'
  console.log(`[WateringSystem] Player: ${localPlayer?.name ?? playerId} (${playerId})`)
  updateProgressText()

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
      Transform.create(clickBox, { position: { x: 0, y: CLICKBOX_Y, z: 0 }, scale: CLICKBOX_SCALE, parent: plantEntity })
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
    wateredCount: computeWateredCount(),
    totalPlants:  TOTAL_PLANTS,
    playerWateredToday,
    dailyWaterLimit,
    dailyLimitReached,
    overrideDailyLimit,
    runtimeTestMode,
  }
}

export function forceTriggerBloom(): void {
  if (isBloomActive()) return
  if (room.isReady()) {
    room.send('forceBloom', {})
  } else {
    // Local fallback — room not connected yet (common in local preview)
    triggerBloomEvent()
  }
}
