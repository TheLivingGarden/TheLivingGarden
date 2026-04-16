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
  PointerEventType,
  inputSystem,
  Transform,
  VisibilityComponent,
  Tween,
  EasingFunction,
  timers,
  PlayerIdentityData,
} from '@dcl/sdk/ecs'
import { getPlayer }              from '@dcl/sdk/players'
import { onEnterSceneObservable } from '@dcl/sdk/observables'
import { setupPetalSystem, petalParticleSystem }                                                                   from './petalSystem'
import { setupBloomSystem, triggerBloomEvent, endBloom, isBloomActive, playBloomAudioAccent }                     from './bloomSystem'
import { startPreBloomEffects, startBloomPhases, startBloomCooldown, cancelPreBloom }                             from './bloomEvent'
import { setupSparkleSystem, triggerSparkle, triggerWateringTribute, sparkleSystem, triggerBloomSparkles, endBloomSparkles, bloomSparkleSystem } from './sparkleSystem'
import { setupAmbientFX, triggerGroundRipple, stopFireflies, ambientFXSystem }                                        from './ambientFX'
import { setupProgressBars, updateProgressBars }              from './progressBarsSystem'
import { setupGroundLights, updateGroundLights, triggerGroundLightBurst }                       from './groundLightSystem'
import { setupLeaderboardBoards, updateLeaderboardDisplay }   from './leaderboardSystem'
import { setupFairyLights, setFairyLightsBloom }             from './fairyLightSystem'
import { showToast, showDailyLimit, hideDailyLimit, showPersistent, hidePersistent, showBannerIdle, showBannerCountdown, updateBannerCountdown, showBannerBloom, updateBannerHealth, updatePlayerCount, updateWaterCount, triggerCanErrorEffect, formatBloomCountdown, formatDailyLimitMessage, getMsUntilBloom, setNextBloomLocalTime } from './notifications'
import { clockSync } from './shared/clockSync'
import { movePlayerTo, triggerSceneEmote }  from '~system/RestrictedActions'
import { room }                             from './shared/messages'
import { TOTAL_PLANTS, BLOOM_THRESHOLD, BLOOM_SUSTAIN_MS, BLOOM_CENTER, DAILY_WATER_LIMIT, PLANT_NAMES, FAST_PLANT_NAMES, FAST_PLANT_EXPIRY_MS } from './shared/config'
import { setupPlayerTrailSystem, startPlayerTrail, stopPlayerTrail } from './playerTrailSystem'
import { startBloomFlower, stopBloomFlower } from './bloomFlowerSystem'

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
const ANIM_TO_HEALTHY    = 'Play'       // droopy → healthy transition  (6.0 s)
const ANIM_HEALTHY_STATE = 'OpenIdle'   // healthy idle loop
const ANIM_CLOSE_PLAY       = 'ClosePlay'  // healthy → droopy transition  (6.033 s)
const ANIM_CLOSE_PLAY_SPEED = 0.25         // playback speed — slow wilt
const ANIM_TRANSITION_MS    = 6_000        // ms — duration of Play clip
const ANIM_CLOSE_PLAY_MS    = Math.round(6_033 / ANIM_CLOSE_PLAY_SPEED)  // 24 132 ms at 0.25×
const WILT_SOUND_DELAY_MS   = 5_000        // ms after ClosePlay starts before wilt sound plays
const ANIMATOR_INIT_DELAY_MS = 1000     // ms — defer Animator.create until GLBs load

// ── Unhealthy Rose (shown while plant is not watered) ─────────
const UNHEALTHY_ROSE_SRC  = 'assets/scene/Models/UnhealthyRose/UnhealthyRose.glb'
const ANIM_UNHEALTHY_IDLE = 'CloseIdle'  // idle loop in UnhealthyRose.glb

// ── Emote ─────────────────────────────────────────────────────
const EMOTE_SRC           = 'assets/scene/Models/Emotes/WateringCan_emote.glb'
const EMOTE_TOTAL_MS      = 2933   // ms — full clip length (keeps emoteActive locked)
const EMOTE_TRIGGER_MS    = 200    // ms — delay before triggerSceneEmote after movePlayerTo
const WATER_DISTANCE      = 2      // metres — how close player steps to the plant

// ── Watering choreography milestones ─────────────────────────
// t=0           click — player steps to plant, emote fires
// t=WATER_FX    watering sound + ground ripple
// t=WATER_ANIM  plant tips forward, magic FX
// t=WATER_ANIM + ANIM_TRANSITION_MS — sparkles burst
const WATER_FX_MS   = 400
const WATER_ANIM_MS = 1500

// ── Water drop indicator ──────────────────────────────────────
const WATER_DROP_SRC = 'assets/scene/Models/waterDrop/waterDrop.glb'
const WATER_DROP_Y   = 0.8   // local Y above plant pivot
const DROP_FADE_MS   = 1600  // ms for scale-in / scale-out tween

/** plant entity → its waterDrop entity */
const waterDropMap = new Map<Entity, Entity>()

// ── Sounds ────────────────────────────────────────────────────
const SND_HOVER    = 'assets/scene/Sounds/hover.mp3'
const SND_CLICK    = 'assets/scene/Sounds/click.mp3'
const SND_WATERING = 'assets/scene/Sounds/watering.mp3'
const SND_MAGIC    = 'assets/scene/Sounds/MagicFX.mp3'
const SND_WILT     = 'assets/scene/Sounds/PlantWiltSound.mp3'
const VOL_HOVER    = 0.7
const VOL_CLICK    = 0.9
const VOL_WATERING = 0.7
const VOL_MAGIC    = 0.9
const VOL_WILT     = 0.8
const SND_INIT_POS = { x: 8, y: 1, z: 8 }   // initial transform — overwritten on play

// ── Clickbox (optional alternative pointer target) ────────────
const CLICKBOX_Y     = 1    // local Y offset above plant pivot
const CLICKBOX_SCALE = { x: 1.5, y: 2, z: 1.5 }

// ── In-world text labels ──────────────────────────────────────
const FONT_PCT_LABEL      = 6    // Image_2–5 + wateringPercentage entity
const FONT_BLOOM_LABEL    = 2.5  // Image_6–9 bloom countdown
const FONT_BLOOM_CTR      = 1.5  // centerTextBloom entity
const FONT_WATERED_BY     = 1.2  // "Watered by" label above each plant
const WATERED_BY_Y        = 2.5  // local Y above plant pivot
// TextShape has no emissiveIntensity — colour only.
const TEXT_LABEL_COLOR    = { r: 1.0, g: 0.78, b: 0.5, a: 1 }  // gold/amber
const WATERED_BY_COLOR    = { r: 1.0, g: 0.95, b: 0.8, a: 1 }  // soft warm white / cream
const SCALE_PCT_LABEL   = 0.6   // uniform scale applied to Image_2–5 + wateringPercentage
const SCALE_BLOOM_LABEL = 1.4   // uniform scale applied to Image_6–9

// ── Contributor thank-you label (above bloom model during the bloom event) ───
const CONTRIBUTOR_LABEL_FONT = 1.5      // world-space font size
const CONTRIBUTOR_LABEL_Y    = 5.5      // world-space Y (above bloom model)
const CONTRIBUTOR_DISPLAY_MS = 15_000   // ms each player name is shown

// ── Timers & durations ────────────────────────────────────────
const WELCOME_DELAY_MS        = 1_500    // wait for server sync before first welcome toast
const TOAST_WATERED_MS        = 2_500    // "Plant Watered! X%" duration
const TOAST_WELCOME_MS        = 4_000    // "X% of Plants Watered" duration
const BLOOM_LABEL_TICK_MS     = 1_000    // re-check bloom countdown every 1 s (seconds visible)
const LIVE_WATER_THRESHOLD_MS = 10_000   // plantStateUpdate < 10 s old = live water by another player
const LIMIT_DEBOUNCE_MS       = 5_000    // min gap between daily-limit toast notifications

// ── Expiry ────────────────────────────────────────────────────
const EXPIRY_PROD_MS = 2.5 * 60 * 1_000        // 2.5 minutes
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
let wiltSoundEntity:     Entity
const magicSoundEntities: Entity[] = []
let magicSoundIdx = 0

let playerWateredToday      = 0
let dailyLimitReached       = false
let lastLimitNotificationMs = 0
let lastBlockedClickMs      = 0         // throttle for blocked-click feedback (wiggle / toast)
const BLOCKED_CLICK_COOLDOWN_MS = 750   // ms — min gap between repeated blocked-click feedback

// Tracks optimistic client-side waters awaiting server confirmation.
// wasTopUp=true  → plant was already watered; rollback restores prevWateredAt
// wasTopUp=false → plant was unwatered; rollback reverts to unwatered state
// The ts guard prevents undoing a concurrent live update from another player.
interface PendingWater { ts: number; prevWateredAt: number; wasTopUp: boolean }
const pendingWaters = new Map<string, PendingWater>()
let initialLoadDone         = false
let roomReady               = false

let preBloomEffectsActive = false  // true once startPreBloomEffects has been called for this cycle
let bloomActive           = false  // true from startBloomPhases() until end of startBloomCooldown()
let emoteActive          = false
let lastSyncRequestMs    = 0
const SYNC_REQUEST_MIN_MS = 5_000   // don't flood server with requestFullSync on rapid reloads

const wateredByLabelMap = new Map<Entity, Entity>()
const wateredByNames    = new Map<Entity, string>()   // entity → display name

const bloomContributors = new Set<string>()           // unique waterer names this bloom cycle
let   contributorLabelEntity: Entity | null = null
let   contributorLabelGen = 0
const entityPlantId     = new Map<Entity, string>()   // entity → plantId (for expiry lookup)

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
  const drop = waterDropMap.get(plantEntity)
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
  // Show bloom state whenever: bloom active, threshold currently met, OR countdown
  // was previously unlocked this cycle (keeps labels visible while paused below threshold)
  const aboveThreshold = computeWateredCount() >= BLOOM_THRESHOLD
  const bloomMode = isBloomActive() || aboveThreshold || countdownUnlocked
  setVisible(_centerTextBloom,    bloomMode)
  setVisible(_centerTextProgress, !bloomMode)
  setVisible(percentageEntity, !bloomMode)
  for (const e of wateringLabels) setVisible(e, !bloomMode)
  if (bloomMode && !isBloomActive()) {
    // Only refresh label text when above threshold; below threshold = frozen (paused)
    if (aboveThreshold) setBloomLabelText(formatSustainCountdown())
  }
}

// ---------------------------------------------------------------
// Bloom label helpers
// ---------------------------------------------------------------

function setBloomLabelText(text: string) {
  for (const e of bloomLabels) TextShape.getMutable(e).text = text
}

function setBloomLabelScale(s: number) {
  for (const e of bloomLabels) setScale(e, s)
}

function clearBloomLabels() {
  for (const e of bloomLabels) {
    TextShape.getMutable(e).text = ''
    setScale(e, SCALE_BLOOM_LABEL)   // reset to normal size for next pre-bloom countdown
  }
}

// ── Contributor thank-you label — cycles through waterer names during bloom ──

/** Show "The Living Garden Blooms / Thanks to <name>" for each contributor in turn.
 *  Each name is visible for CONTRIBUTOR_DISPLAY_MS, then the next appears.
 *  Label hides automatically after the final name. */
function startContributorCycle(names: string[]): void {
  if (!contributorLabelEntity || names.length === 0) return
  const myGen = ++contributorLabelGen
  let i = 0
  function showNext(): void {
    if (contributorLabelGen !== myGen) {
      if (contributorLabelEntity) TextShape.getMutable(contributorLabelEntity).text = ''
      return
    }
    TextShape.getMutable(contributorLabelEntity!).text =
      `The Living Garden Blooms\nThanks to ${names[i]}`
    i++
    if (i < names.length) {
      timers.setTimeout(showNext, CONTRIBUTOR_DISPLAY_MS)
    } else {
      // All names shown — hide after the final display period
      timers.setTimeout(() => {
        if (contributorLabelGen !== myGen) return
        TextShape.getMutable(contributorLabelEntity!).text = ''
      }, CONTRIBUTOR_DISPLAY_MS)
    }
  }
  showNext()
}

function stopContributorCycle(): void {
  contributorLabelGen++
  if (contributorLabelEntity) TextShape.getMutable(contributorLabelEntity).text = ''
}

// ── Pre-bloom ticker — counts down while health >= threshold, bloom not yet active ──
let preBloomTickerGen = 0
// Set when threshold is first crossed this cycle; keeps bloom labels visible (paused)
// even if health briefly dips below.  Cleared only on bloomReset.
let countdownUnlocked = false

// ── Client-side 60 s sustain countdown ───────────────────────
// Mirrors the server's pauseable sustain timer so the 3D labels show
// exactly how long until bloom fires (not the scheduled window time).
let clientSustainStartMs:  number | null = null   // wall-clock ms when current run started
let clientSustainElapsedMs: number       = 0      // ms accumulated across paused segments

function formatSustainCountdown(): string {
  const elapsed     = clientSustainElapsedMs
                    + (clientSustainStartMs !== null ? Date.now() - clientSustainStartMs : 0)
  const remainingMs = Math.max(0, BLOOM_SUSTAIN_MS - elapsed)
  return `${Math.ceil(remainingMs / 1_000)}s`
}

function resetClientSustain(): void {
  clientSustainStartMs  = null
  clientSustainElapsedMs = 0
}

function startPreBloomTicker(): void {
  if (runtimeTestMode) return
  const myGen = ++preBloomTickerGen
  function tick() {
    if (preBloomTickerGen !== myGen) return   // cancelled — bloom fired or health dropped
    if (isBloomActive()) return               // bloom took over; bloom updater handles labels
    const countdown = formatSustainCountdown()
    updateBannerCountdown(countdown)          // keep banner in sync
    setBloomLabelText(countdown)              // ticker only runs while health ≥ threshold
    timers.setTimeout(tick, BLOOM_LABEL_TICK_MS)
  }
  timers.setTimeout(tick, BLOOM_LABEL_TICK_MS)
}

function stopPreBloomTicker(): void {
  preBloomTickerGen++   // invalidates any running chain
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
  updateBannerHealth(count / TOTAL_PLANTS)
  updateWaterCount(playerWateredToday, dailyWaterLimit)
  // Banner state: idle below threshold, countdown at/above threshold (unless bloom active)
  if (!isBloomActive() && !bloomActive) {
    if (count >= BLOOM_THRESHOLD) {
      countdownUnlocked = true   // latches on; only cleared by bloomReset
      // Resume (or start) the client sustain clock
      if (clientSustainStartMs === null) clientSustainStartMs = Date.now()
      const countdown = formatSustainCountdown()
      showBannerCountdown(countdown)
      setBloomLabelText(countdown)
      startPreBloomTicker()   // keeps banner + 3D labels ticking every second
      // Start pre-bloom FX once, when threshold is first crossed this cycle
      if (!preBloomEffectsActive && !runtimeTestMode) {
        preBloomEffectsActive = true
        playBloomAudioAccent()   // one-shot Swell accent at 80% threshold
        startPreBloomEffects(getMsUntilBloom())
      }
    } else {
      // Pause the sustain clock — preserve elapsed so countdown resumes from same point
      if (clientSustainStartMs !== null) {
        clientSustainElapsedMs += Date.now() - clientSustainStartMs
        clientSustainStartMs    = null
      }
      if (preBloomEffectsActive) {
        preBloomEffectsActive = false
        cancelPreBloom(true)   // threshold dropped — stop FX + fireflies
      }
      stopPreBloomTicker()   // ticker stops; 3D labels and banner freeze at last value
      // Only show idle banner if countdown was never started this cycle
      if (!countdownUnlocked) showBannerIdle()
    }
  }
  updateSceneAssets()
}

function showWelcomeProgress() {
  // welcome toast removed — garden health is shown in the top banner
}

// ---------------------------------------------------------------
// Plant click registry
// ---------------------------------------------------------------

const plantRegistry     = new Map<Entity, { clickTarget: Entity; plantName: string; clickboxEntity: Entity | null }>()
const plantNameToEntity = new Map<string, Entity>()

function enablePlantClick(entity: Entity) {
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
  triggerCanErrorEffect()   // scale-up + shake to signal the limit has been reached
  updateProgressText()
}

export function resetDailyLimit(): void {
  playerWateredToday = 0
  dailyLimitReached  = false
  hideDailyLimit()
  updateProgressText()
  console.log('[TEST] Daily limit reset to 0')
}

// ---------------------------------------------------------------
// Interaction sounds & emote
// ---------------------------------------------------------------

function playAtPlayer(soundEntity: Entity) {
  const pos = Transform.getOrNull(engine.PlayerEntity)?.position ?? { x: 8, y: 1, z: 8 }
  Transform.getMutable(soundEntity).position = pos
  // Reuse the existing AudioSource component — no recreation, just retrigger
  AudioSource.getMutable(soundEntity).playing = false
  timers.setTimeout(() => { AudioSource.getMutable(soundEntity).playing = true }, 0)
}

function playHoverSound()    { playAtPlayer(hoverSoundEntity)    }
function playWiltSound(plantEntity: Entity) {
  const pos = Transform.getOrNull(plantEntity)?.position ?? SND_INIT_POS
  Transform.getMutable(wiltSoundEntity).position = pos
  AudioSource.getMutable(wiltSoundEntity).playing = false
  timers.setTimeout(() => { AudioSource.getMutable(wiltSoundEntity).playing = true }, 0)
}
function playClickSound()    { playAtPlayer(clickSoundEntity)    }
function playWateringSound() { playAtPlayer(wateringSoundEntity) }

function playMagicFXSound() {
  // Alternate between two entities — each call lands on a different one so DCL
  // always sees a fresh AudioSource component, avoiding the alternating-skip bug.
  magicSoundIdx = (magicSoundIdx + 1) % 2
  const ent = magicSoundEntities[magicSoundIdx]
  const pos = Transform.getOrNull(engine.PlayerEntity)?.position ?? { x: 8, y: 1, z: 8 }
  Transform.getMutable(ent).position = pos
  AudioSource.createOrReplace(ent, {
    audioClipUrl: SND_MAGIC,
    playing:      true,
    loop:         false,
    volume:       VOL_MAGIC,
    pitch:        1,
  })
}

function stopWateringEmote() {
  if (!emoteActive) return
  emoteActive = false
  triggerSceneEmote({ src: '', loop: false })
}

const EMOTE_STOP_ACTIONS = [
  InputAction.IA_FORWARD,
  InputAction.IA_BACKWARD,
  InputAction.IA_LEFT,
  InputAction.IA_RIGHT,
  InputAction.IA_JUMP,
] as const

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

  // Exit on any movement/jump key — matches creator's reference implementation
  const systemName = `emote-watch-${Date.now()}`
  engine.addSystem(() => {
    if (!emoteActive) { engine.removeSystem(systemName); return }
    for (const action of EMOTE_STOP_ACTIONS) {
      if (inputSystem.isTriggered(action, PointerEventType.PET_DOWN)) {
        engine.removeSystem(systemName)
        stopWateringEmote()
        return
      }
    }
  }, undefined, systemName)

  timers.setTimeout(() => {
    if (!emoteActive) return
    triggerSceneEmote({ src: EMOTE_SRC, loop: false })
    timers.setTimeout(() => {
      engine.removeSystem(systemName)
      stopWateringEmote()
    }, EMOTE_TOTAL_MS)
  }, EMOTE_TRIGGER_MS)
}

// ---------------------------------------------------------------
// Plant lifecycle
// ---------------------------------------------------------------

/** Returns the correct expiry duration for a plant — fast or standard. */
function plantExpiryMs(plantId: string): number {
  if (FAST_PLANT_NAMES.has(plantId)) return FAST_PLANT_EXPIRY_MS
  return runtimeTestMode ? EXPIRY_TEST_MS : EXPIRY_PROD_MS
}

function scheduleExpiry(entity: Entity, sessionTimestamp: number, delayMs: number) {
  timers.setTimeout(() => {
    if (isBloomActive()) return
    const pd = PlantData.getMutable(entity)
    if (!pd.isWatered || pd.wateredAt !== sessionTimestamp) return

    // Mark expired immediately so progress & clicks are correct.
    // Another player can water during the ClosePlay animation — the timer
    // below guards against applying the visual swap if that happens.
    pd.isWatered = false
    pd.wateredAt = 0
    updateProgressText()
    enablePlantClick(entity)

    // Clear the "watered by" label immediately on expiry
    wateredByNames.delete(entity)
    const expiredLabel = wateredByLabelMap.get(entity)
    if (expiredLabel) TextShape.getMutable(expiredLabel).text = ''

    // Only play ClosePlay if the healthy plant mesh is currently visible.
    // If it's not visible (e.g. the player loaded after this plant had already
    // expired and the server sent isWatered=false on join), snap straight to droopy.
    const plantVisible = VisibilityComponent.getOrNull(entity)?.visible ?? false
    if (plantVisible) {
      Animator.playSingleAnimation(entity, ANIM_CLOSE_PLAY)
      timers.setTimeout(() => { if (!PlantData.get(entity).isWatered) playWiltSound(entity) }, WILT_SOUND_DELAY_MS)
      timers.setTimeout(() => {
        // Abort visual swap if re-watered during the animation
        if (PlantData.get(entity).isWatered) return
        hidePlant(entity)
        showRose(entity)
        setDropFade(entity, 'in')
      }, ANIM_CLOSE_PLAY_MS)
    } else {
      showRose(entity)
      setDropFade(entity, 'in')
    }
  }, delayMs)
}

function waterPlant(entity: Entity, plantId: string) {
  if (isBloomActive()) return
  if (emoteActive)     return

  // Gate: plant already watered — inform without using water or wiggling
  if (PlantData.get(entity).isWatered) {
    const now = Date.now()
    if (now - lastBlockedClickMs > BLOCKED_CLICK_COOLDOWN_MS) {
      lastBlockedClickMs = now
      showToast('This plant is already watered', TOAST_WATERED_MS, false)
    }
    return
  }

  // Gate: daily limit reached — wiggle + inform
  if (!overrideDailyLimit && playerWateredToday >= dailyWaterLimit) {
    const now = Date.now()
    if (now - lastBlockedClickMs > BLOCKED_CLICK_COOLDOWN_MS) {
      lastBlockedClickMs = now
      triggerCanErrorEffect()
      showToast('No daily waters remaining', TOAST_WATERED_MS, false)
    }
    return
  }

  const pd = PlantData.getMutable(entity)
  const wasAlreadyWatered = false   // top-up path no longer reachable
  const prevWateredAt     = pd.wateredAt

  const now = Date.now()
  pd.isWatered = true
  pd.wateredAt = now

  playerWateredToday++
  const justHitLimit = !overrideDailyLimit && playerWateredToday >= dailyWaterLimit
  if (justHitLimit) onDailyLimitReached()

  disablePlantClick(entity)     // prevent double-click while pending; re-enabled on confirmation
  setDropFade(entity, 'out')    // hide drop when watering

  playClickSound()
  triggerWateringEmote(entity)

  // t=WATER_FX_MS — sound + ripple + light burst
  timers.setTimeout(playWateringSound, WATER_FX_MS)
  timers.setTimeout(() => {
    const pos = Transform.getOrNull(entity)?.position
    if (pos) triggerGroundRipple(pos)
    triggerGroundLightBurst()
  }, WATER_FX_MS)

  if (!wasAlreadyWatered) {
    // ── Fresh water — swap rose → healthy plant ──────────────────
    // t=WATER_ANIM_MS — hide rose, show plant, animate to healthy
    timers.setTimeout(() => {
      const current = PlantData.get(entity)
      if (!current.isWatered || current.wateredAt !== now) return
      hideRose(entity)
      showPlant(entity)
      Animator.playSingleAnimation(entity, ANIM_TO_HEALTHY)
      playMagicFXSound()
      const plantPos = Transform.getOrNull(entity)?.position
      if (plantPos) {
        triggerSparkle(plantPos)
        timers.setTimeout(() => triggerWateringTribute(plantPos), 650)
      }
      // t=WATER_ANIM_MS + ANIM_TRANSITION_MS — switch to idle pose
      timers.setTimeout(() => {
        const latest = PlantData.get(entity)
        if (latest.isWatered && latest.wateredAt === now) {
          Animator.playSingleAnimation(entity, ANIM_HEALTHY_STATE)
        }
      }, ANIM_TRANSITION_MS)
    }, WATER_ANIM_MS)
  } else {
    // ── Top-up — plant already healthy; just sparkle + magic FX ──
    timers.setTimeout(() => {
      const current = PlantData.get(entity)
      if (!current.isWatered || current.wateredAt !== now) return
      playMagicFXSound()
      const plantPos = Transform.getOrNull(entity)?.position
      if (plantPos) {
        triggerSparkle(plantPos)
        timers.setTimeout(() => triggerWateringTribute(plantPos), 650)
      }
    }, WATER_ANIM_MS)
  }

  room.send('waterPlant', { plantId })
  pendingWaters.set(plantId, { ts: now, prevWateredAt, wasTopUp: wasAlreadyWatered })

  updateProgressText()
  const _pct = Math.round((computeWateredCount() / TOTAL_PLANTS) * 100)
  showToast(`Plant Watered! ${_pct}%`, TOAST_WATERED_MS, true)
  if (justHitLimit) {
    lastBlockedClickMs = now   // prime throttle so first post-limit click gets feedback
    timers.setTimeout(() => {
      showDailyLimit(formatDailyLimitMessage(runtimeTestMode))
    }, TOAST_WATERED_MS)
  }

  scheduleExpiry(entity, now, plantExpiryMs(plantId))
}

export function resetAllPlants(): void {
  endBloom()
  endBloomSparkles()
  stopFireflies()
  setFairyLightsBloom(false)
  hidePersistent()

  dailyLimitReached = false

  // Clear all "Watered by" labels
  for (const [, labelEntity] of wateredByLabelMap) {
    TextShape.getMutable(labelEntity).text = ''
  }
  wateredByNames.clear()

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

function formatTimeAgo(wateredAtMs: number): string {
  const elapsed = Date.now() - wateredAtMs
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1)  return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ago`
}

function refreshWateredByLabels(): void {
  const now = Date.now()
  for (const [entity, labelEntity] of wateredByLabelMap) {
    const pd   = PlantData.getOrNull(entity)
    const name = wateredByNames.get(entity)
    if (!pd?.isWatered || !name) continue
    const pid      = entityPlantId.get(entity)
    const expiryMs = plantExpiryMs(pid ?? '')
    const alpha    = Math.max(0, 1 - (now - pd.wateredAt) / expiryMs)
    const ts = TextShape.getMutable(labelEntity)
    ts.text      = `Watered by ${name}\n${formatTimeAgo(pd.wateredAt)}`
    ts.textColor = { ...WATERED_BY_COLOR, a: alpha }
  }
}

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
  entityPlantId.set(entity, plantName)
  enablePlantClick(entity)

  // ── Water drop indicator ─────────────────────────────────────
  const dropEnt = engine.addEntity()
  Transform.create(dropEnt, { position: { x: 0, y: WATER_DROP_Y, z: 0 }, scale: { x: 1, y: 1, z: 1 }, parent: entity })
  GltfContainer.create(dropEnt, { src: WATER_DROP_SRC })
  Billboard.create(dropEnt, { billboardMode: BillboardMode.BM_Y })
  waterDropMap.set(entity, dropEnt)

  // "Watered by" label — hidden until plant is watered
  const wateredByLabel = engine.addEntity()
  Transform.create(wateredByLabel, { position: { x: 0, y: WATERED_BY_Y, z: 0 }, parent: entity })
  TextShape.create(wateredByLabel, { text: '', fontSize: FONT_WATERED_BY, textColor: WATERED_BY_COLOR, textWrapping: false })
  Billboard.create(wateredByLabel, { billboardMode: BillboardMode.BM_Y })
  wateredByLabelMap.set(entity, wateredByLabel)
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

  // ── Contributor thank-you label — floats above the bloom model, billboard Y ──
  contributorLabelEntity = engine.addEntity()
  Transform.create(contributorLabelEntity, {
    position: { x: BLOOM_CENTER.x, y: CONTRIBUTOR_LABEL_Y, z: BLOOM_CENTER.z },
  })
  Billboard.create(contributorLabelEntity, { billboardMode: BillboardMode.BM_Y })
  TextShape.create(contributorLabelEntity, {
    text:         '',
    fontSize:     CONTRIBUTOR_LABEL_FONT,
    textColor:    WATERED_BY_COLOR,   // cream / soft warm white
    textWrapping: false,
  })

  setupLeaderboardBoards()

  setupBloomSystem({
    testMode:      TEST_MODE,
    onReset:       () => {},
    onVisualBloom: () => {
      // UI updates
      hidePersistent()
      showDailyLimit(NOTIFY_BLOOM_ACTIVE)
      stopPreBloomTicker()
      setBloomLabelScale(SCALE_BLOOM_LABEL * 0.6)
      setBloomLabelText('Bloom Event\nThe Living Garden')
      preBloomEffectsActive = false

      // Bloom sparkles at each plant position (needs registry access — must stay here)
      const positions: Array<{ x: number; y: number; z: number }> = []
      for (const [entity] of plantRegistry) {
        const pos = Transform.getOrNull(entity)?.position
        if (pos) positions.push(pos)
      }
      triggerBloomSparkles(positions)

      // All VFX, audio, petals, and lights driven by intensity system
      startBloomPhases()
      bloomActive = true
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
  wiltSoundEntity = engine.addEntity()
  Transform.create(wiltSoundEntity,     { position: SND_INIT_POS })
  AudioSource.create(wiltSoundEntity,   { audioClipUrl: SND_WILT,     playing: false, loop: false, volume: VOL_WILT,     pitch: 1 })
  for (let i = 0; i < 2; i++) {
    const ent = engine.addEntity()
    Transform.create(ent, { position: SND_INIT_POS })
    AudioSource.create(ent, { audioClipUrl: SND_MAGIC, playing: false, loop: false, volume: VOL_MAGIC, pitch: 1 })
    magicSoundEntities.push(ent)
  }

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
          { clip: ANIM_CLOSE_PLAY,    playing: false, loop: false, speed: ANIM_CLOSE_PLAY_SPEED },
        ],
      })
      Animator.playSingleAnimation(entity, isWatered ? ANIM_HEALTHY_STATE : ANIM_DROOPY_STATE, true)

      // UnhealthyRose animator
      const roseEntity = roseMap.get(entity)
      if (roseEntity) {
        Animator.createOrReplace(roseEntity, {
          states: [
            { clip: ANIM_UNHEALTHY_IDLE, playing: false, loop: true  },
            { clip: ANIM_CLOSE_PLAY,     playing: false, loop: false },
          ],
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
  setupPlayerTrailSystem()
  setupAmbientFX()
  setupFairyLights()
  setupProgressBars()
  setupGroundLights()

  engine.addSystem(resetAnimSystem)
  engine.addSystem(petalParticleSystem)
  engine.addSystem(sparkleSystem)
  engine.addSystem(bloomSparkleSystem)
  engine.addSystem(ambientFXSystem)

  // Player count — throttled, updates UI every 5 s
  let playerCountTimer = 0
  engine.addSystem((dt: number) => {
    playerCountTimer += dt
    if (playerCountTimer < 5) return
    playerCountTimer = 0
    let count = 0
    for (const _ of engine.getEntitiesWith(PlayerIdentityData)) count++
    updatePlayerCount(count)
  })

  // Refresh "X min ago" timestamps and decay alpha on watered-by labels every 5 s
  let labelRefreshTimer = 0
  engine.addSystem((dt: number) => {
    labelRefreshTimer += dt
    if (labelRefreshTimer < 5) return
    labelRefreshTimer = 0
    refreshWateredByLabels()
  })

  // On every room connection (including reloads) request a full state dump from the server.
  // This ensures the client re-syncs even when the server's playerJoinSystem doesn't detect
  // a new entity (e.g. quick reloads where the ECS entity version doesn't change).
  room.onReady((isReady) => {
    console.log(`[Client] room.onReady fired: isReady=${isReady}`)
    if (!isReady) return
    const now = Date.now()
    if (now - lastSyncRequestMs < SYNC_REQUEST_MIN_MS) {
      console.log('[Client] requestFullSync skipped — rate limited')
      return
    }
    lastSyncRequestMs = now
    // Reset init flags so playerDailyState handler re-runs welcome flow on reload
    roomReady       = false
    initialLoadDone = false
    room.send('requestFullSync', {})
  })

  // ── Server message handlers ──────────────────────────────────
  // Clear any handlers from a previous setup call (DCL can re-run setup on scene reload).
  // Without this, each reload stacks another copy of every handler, causing N sounds,
  // N animations, and N ripples per broadcast — a reliable crash path.
  room.clear()

  room.onMessage('notifyServerTime', (data) => {
    clockSync.updateOffset(data.sentAt)
  })

  room.onMessage('playerDailyState', (data) => {
    // Clock sync — keep offset calibrated on every server message
    if (data.sentAt)    clockSync.updateOffset(data.sentAt)
    // Store server-authoritative bloom time converted to local clock
    if (data.bloomTime) setNextBloomLocalTime(clockSync.toLocalTime(data.bloomTime))

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

    // Roll back optimistic plant state if it was set by THIS click.
    // The ts guard ensures we don't undo a live update from another player
    // that arrived on the same plant concurrently.
    const pending = pendingWaters.get(data.plantId)
    pendingWaters.delete(data.plantId)
    if (pending !== undefined) {
      const rejEntity = plantNameToEntity.get(data.plantId)
      if (rejEntity) {
        const pd = PlantData.getMutable(rejEntity)
        if (pd.isWatered && pd.wateredAt === pending.ts) {
          if (pending.wasTopUp) {
            // Top-up rollback — restore original wateredAt; drop stays hidden (plant still watered)
            pd.wateredAt = pending.prevWateredAt
            if (overrideDailyLimit || !dailyLimitReached) enablePlantClick(rejEntity)
          } else {
            // Fresh water rollback — revert to unwatered state.
            // Setting wateredAt=0 cancels pending animation timers (they
            // guard with wateredAt === pending.ts).
            pd.isWatered = false
            pd.wateredAt = 0
            hidePlant(rejEntity)
            showRose(rejEntity)
            setDropFade(rejEntity, 'in')
            if (overrideDailyLimit || !dailyLimitReached) enablePlantClick(rejEntity)
          }
        }
      }
      stopWateringEmote()
    }

    playerWateredToday = Math.max(0, playerWateredToday - 1)

    if (data.reason === 'daily_limit') {
      if (!dailyLimitReached) onDailyLimitReached()
      const now = Date.now()
      if (now - lastLimitNotificationMs > LIMIT_DEBOUNCE_MS) {
        lastLimitNotificationMs = now
        showDailyLimit(formatDailyLimitMessage(runtimeTestMode))
      }
      return
    }

    if (data.reason === 'bloom_active') {
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
    stopWateringEmote()
    stopPreBloomTicker()   // stop immediately — prevents stale "1s" from being re-written
    resetClientSustain()   // sustain complete — bloom is firing
    showBannerBloom()      // switch banner from countdown → bloom before visual effects ramp up
    if (!isBloomActive()) {
      triggerBloomEvent()
      startContributorCycle([...bloomContributors])   // thank each waterer in turn
      updateSceneAssets()
    }
  })

  room.onMessage('bloomReset', () => {
    stopPreBloomTicker()
    preBloomEffectsActive = false
    countdownUnlocked = false   // full cycle reset — labels and banner return to idle
    resetClientSustain()
    stopContributorCycle()
    startBloomFlower([...bloomContributors])  // attach hand flower to contributors — must run BEFORE clear()
    bloomContributors.clear()
    resetAllPlants()         // stops bloom, resets visuals + audio via endBloom()
    startBloomCooldown()     // gradual 5-min wind-down of lights + audio
    timers.setTimeout(() => { bloomActive = false }, 65_000)  // matches step(60) — last cooldown step
    startPlayerTrail()       // 10-min sparkle trail on all players after bloom
    clearBloomLabels()
    showBannerIdle()
    updateBannerHealth(0)
    hideDailyLimit()
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

    // Consume any pending optimistic water — server has spoken.
    // Four cases:
    //   A  pending && !wasTopUp  = our own fresh water confirmed
    //   B  pending &&  wasTopUp  = our own top-up confirmed
    //   C  !pending && !wasWatered = remote player freshly watered
    //   D  !pending &&  wasWatered = remote player topped up an already-watered plant
    const pending = pendingWaters.get(data.plantId)
    pendingWaters.delete(data.plantId)

    // Update "Watered by" label + accumulate bloom contributors
    const wateredByLabel = wateredByLabelMap.get(entity)
    if (data.isWatered && data.wateredBy) {
      wateredByNames.set(entity, data.wateredBy)
      bloomContributors.add(data.wateredBy)   // tracks everyone who contributed this cycle
    } else {
      wateredByNames.delete(entity)
    }
    if (wateredByLabel) {
      const ts = TextShape.getMutable(wateredByLabel)
      if (data.isWatered && data.wateredBy) {
        const pid      = entityPlantId.get(entity)
        const expiryMs = plantExpiryMs(pid ?? '')
        const alpha    = Math.max(0, 1 - (Date.now() - data.wateredAt) / expiryMs)
        ts.text      = `Last watered by ${data.wateredBy}\n${formatTimeAgo(data.wateredAt)}`
        ts.textColor = { ...WATERED_BY_COLOR, a: alpha }
      } else {
        ts.text = ''
      }
    }

    if (data.isWatered) {
      PlantData.getMutable(entity).isWatered = true

      // Preserve local optimistic timestamp for Case A so the animation guards
      // in waterPlant (which close over the local `now`) continue to pass.
      // All other cases use the server-authoritative timestamp for accurate decay.
      const isCaseA = pending !== undefined && !pending.wasTopUp
      if (!isCaseA) {
        PlantData.getMutable(entity).wateredAt = data.wateredAt
      }

      if (pending !== undefined && !pending.wasTopUp) {
        // ── Case A: our fresh water confirmed ────────────────────
        // Optimistic animations already running in waterPlant — just re-enable click.
        enablePlantClick(entity)

      } else if (pending !== undefined && pending.wasTopUp) {
        // ── Case B: our top-up confirmed ─────────────────────────
        // Plant already healthy; re-enable click. Drop stays hidden (plant watered).
        // The optimistic expiry (keyed on local `now`) will self-cancel because
        // pd.wateredAt is now data.wateredAt — schedule a fresh expiry from there.
        enablePlantClick(entity)
        const remaining = plantExpiryMs(data.plantId) - (Date.now() - data.wateredAt)
        if (remaining > 0) scheduleExpiry(entity, data.wateredAt, remaining)

      } else if (!wasWatered) {
        // ── Case C: remote player freshly watered this plant ─────
        const isLive = (Date.now() - data.wateredAt) < LIVE_WATER_THRESHOLD_MS
        if (isLive) {
          hideRose(entity)
          showPlant(entity)
          setDropFade(entity, 'out')
          Animator.playSingleAnimation(entity, ANIM_TO_HEALTHY)
          triggerGroundLightBurst()
          if (plantPos) {
            Transform.getMutable(wateringSoundEntity).position = plantPos
            AudioSource.getMutable(wateringSoundEntity).playing = true
            triggerGroundRipple(plantPos)
          }
          timers.setTimeout(() => {
            if (!PlantData.get(entity).isWatered) return
            Animator.playSingleAnimation(entity, ANIM_HEALTHY_STATE)
            if (plantPos) triggerSparkle(plantPos)
          }, ANIM_TRANSITION_MS)
        } else {
          // State recovery on join — snap to healthy, drop hidden
          hideRose(entity)
          showPlant(entity)
          Animator.playSingleAnimation(entity, ANIM_HEALTHY_STATE)
          const drop = waterDropMap.get(entity)
          if (drop) {
            Tween.deleteFrom(drop)
            Transform.getMutable(drop).scale = { x: 0.001, y: 0.001, z: 0.001 }
          }
        }

      }
      // Case D (remote top-up): drop already hidden, nothing to change visually

    } else {
      PlantData.getMutable(entity).isWatered = false
      PlantData.getMutable(entity).wateredAt = 0
      enablePlantClick(entity)

      if (wasWatered) {
        // Mirror scheduleExpiry: play ClosePlay if the plant mesh is visible,
        // snap immediately if not. This handles the race where the server's
        // expiry broadcast arrives before the client-side timer fires (common
        // on fast-decaying plants). The client-side timer will bail because
        // pd.isWatered is already false by the time it fires.
        const plantVisible = VisibilityComponent.getOrNull(entity)?.visible ?? false
        if (plantVisible) {
          Animator.playSingleAnimation(entity, ANIM_CLOSE_PLAY)
          timers.setTimeout(() => { if (!PlantData.get(entity).isWatered) playWiltSound(entity) }, WILT_SOUND_DELAY_MS)
          timers.setTimeout(() => {
            if (PlantData.get(entity).isWatered) return
            hidePlant(entity)
            showRose(entity)
            setDropFade(entity, 'in')
          }, ANIM_CLOSE_PLAY_MS)
        } else {
          hidePlant(entity)
          showRose(entity)
          setDropFade(entity, 'in')
        }
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
  room.send('setTestOverride', { enabled: val })
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
    enablePlantClick(plantEntity)
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

/** Test-panel: asks the server to water exactly enough plants to hit the 80% bloom threshold.
 *  Plants watered this way use normal expiry and appear as "[Test Mode]" in contributor labels. */
export function forceWaterToThreshold(): void {
  if (room.isReady()) room.send('forceWater80', {})
}

// ── Post-bloom effect test toggles ────────────────────────────
export function forceStartPlayerTrail(): void { startPlayerTrail() }
export function forceStopPlayerTrail():  void { stopPlayerTrail()  }

export function forceStartBloomFlower(): void {
  const lp = getPlayer()
  const ids: string[] = []
  if (lp?.name)   ids.push(lp.name)
  if (lp?.userId) ids.push(lp.userId)
  startBloomFlower(ids.length > 0 ? ids : ['__test__'])
}
export function forceStopBloomFlower(): void { stopBloomFlower() }
