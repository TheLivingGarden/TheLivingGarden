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
  GltfNodeModifiers,
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
  GltfContainerLoadingState,
  PlayerIdentityData,
  MaterialTransparencyMode,
} from '@dcl/sdk/ecs'
import { getPlayer }              from '@dcl/sdk/players'
import { onEnterSceneObservable } from '@dcl/sdk/observables'
import { setupPetalSystem, petalParticleSystem }                                                                   from './petalSystem'
import { setupBloomSystem, triggerBloomEvent, endBloom, startBloomClose, isBloomActive, playBloomAudioAccent }    from './bloomSystem'
import { startPreBloomEffects, startBloomPhases, startBloomCooldown, cancelPreBloom }                             from './bloomEvent'
import { setupSparkleSystem, triggerSparkle, triggerWateringTribute, triggerBloomSparkles, endBloomSparkles, bloomSparkleSystem } from './sparkleSystem'
import { setupAmbientFX, triggerGroundRipple, stopFireflies, ambientFXSystem }                                        from './ambientFX'
import { setupProgressBars, updateProgressBars, setBloomRatio } from './progressBarsSystem'
import { setupGroundLights, updateGroundLights, triggerGroundLightBurst }                       from './groundLightSystem'
import { flairIcon, almanacTitleByRank, bloomSustainMs, bloomVariantById, bloomFxLevel, withArticle, HOLD_WATERING_ENABLED } from './shared/config'
import { setBloomSparklePalette } from './sparkleSystem'
import { setAmbientPalette } from './ambientFX'
import { startMoonlight, stopMoonlight } from './moonlight'
import { setupLeaderboardBoards, updateLeaderboardDisplay, setYourStanding, BoardEntry }   from './leaderboardSystem'
import { setupFairyLights, setFairyLightsBloom }             from './fairyLightSystem'
import { syncMyHand } from './giftSystem'
import { beginHold, isHolding } from './skillCheck'
import { applyPropLayout } from './propLayoutTool'
import { showToast, showDailyLimit, hideDailyLimit, showPersistent, hidePersistent, showBannerIdle, showBannerCountdown, updateBannerCountdown, showBannerBloom, updateBannerHealth, updatePlayerCount, updateBloomRemaining, formatBloomCountdown, getMsUntilBloom, setNextBloomLocalTime } from './notifications'
import { clockSync } from './shared/clockSync'
import { triggerSceneEmote }  from '~system/RestrictedActions'
import { room }                             from './shared/messages'
import { TOTAL_PLANTS, BLOOM_THRESHOLD, BLOOM_CENTER, DAILY_WATER_LIMIT, PLANT_NAMES, FAST_PLANT_NAMES, FAST_PLANT_EXPIRY_MS, BLOOM_RESET_DELAY_MS, DROP_RANGE, DROP_RANGE_OUT, BLOOM_TRIGGER_COOLDOWN_MS, EXPIRY_TELL_MS, WATER_DROP_MODEL_SRC } from './shared/config'
import { setupPlayerTrailSystem, startPlayerTrail, stopPlayerTrail } from './playerTrailSystem'
import { startBloomFlower, stopBloomFlower } from './bloomFlowerSystem'
import { setupSeedSystem } from './seedSystem'
import { setupBoxSystem } from './boxSystem'
import { setupPlanterLayoutTool } from './planterLayoutTool'
import { setupTributeSystem } from './tributeSystem'
import { setupAvenueSystem } from './avenueSystem'
import { PLANT_LAYOUT } from './shared/layout'
import { Quaternion, Color4 } from '@dcl/sdk/math'

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

// ── v2: scaled bloom threshold ────────────────────────────────
// Authoritative value arrives via the server's thresholdUpdate message; until
// then we fall back to the full v1 threshold so behaviour is unchanged.
let bloomThreshold = BLOOM_THRESHOLD
// Scale (thresholdAtFire / full threshold) of the currently-active bloom —
// 1 = full-garden spectacle; below 1 = the smaller, quieter solo/duo bloom.
// Stored here for the FX phase to consume.
let currentBloomScale = 1
export function getCurrentBloomScale(): number { return currentBloomScale }
let currentBloomVariant = 'classic'   // BLOOM_VARIANTS id of the active bloom (Phase 6)
export function getCurrentBloomVariant(): string { return currentBloomVariant }

// ── Animation clip names (must match GLB exactly) ─────────────
const ANIM_DROOPY_STATE  = 'CloseIdle'  // droopy idle loop
const ANIM_TO_HEALTHY    = 'Play'       // droopy → healthy transition  (6.0 s)
const ANIM_HEALTHY_STATE = 'OpenIdle'   // healthy idle loop
const ANIM_CLOSE_PLAY       = 'ClosePlay'  // healthy → droopy transition  (6.033 s)
const ANIM_CLOSE_PLAY_SPEED = 0.25         // playback speed — slow wilt
const ANIM_TRANSITION_MS    = 6_000        // ms — duration of Play clip
const ANIM_CLOSE_PLAY_MS    = Math.round(6_033 / ANIM_CLOSE_PLAY_SPEED)  // 24 132 ms at 0.25×
const WILT_SOUND_DELAY_MS   = 5_000        // ms after ClosePlay starts before wilt sound plays
// LoadingState values (const enum in @dcl/ecs internals, not re-exported — same as boxSystem)
const LS_NOT_FOUND = 2, LS_FINISHED_WITH_ERROR = 3, LS_FINISHED = 4

// ── Unhealthy Rose (shown while plant is not watered) ─────────
const UNHEALTHY_ROSE_SRC  = 'assets/scene/Models/UnhealthyRose/UnhealthyRose.glb'
const ANIM_UNHEALTHY_IDLE = 'CloseIdle'  // idle loop in UnhealthyRose.glb

// ── Emote ─────────────────────────────────────────────────────
const EMOTE_SRC           = 'assets/scene/Models/Emotes/WateringCan_emote.glb'
const EMOTE_TOTAL_MS      = 2933   // ms — full clip length (keeps emoteActive locked)
const EMOTE_TRIGGER_MS    = 200    // ms — delay before triggerSceneEmote after click

// ── Pointer reach (Clean The Club model) ─────────────────────
// maxDistance measures from the CAMERA, not the player — the mobile 3rd-person
// camera sits 3–5m back, so a small value refuses clicks on plants you're
// standing next to. Two-gate design: generous camera budget + player-based gate.
const POINTER_MAX_DIST = 7   // metres, camera-based (PointerEvents maxDistance)
const MAX_REACH_M      = 4   // metres, horizontal player→plant gate on click

// ── Watering choreography milestones ─────────────────────────
// t=0           click — player steps to plant, emote fires
// t=WATER_FX    watering sound + ground ripple
// t=WATER_ANIM  plant tips forward, magic FX
// t=WATER_ANIM + ANIM_TRANSITION_MS — sparkles burst
const WATER_FX_MS   = 400
const WATER_ANIM_MS = 1500

// ── Water drop indicator ──────────────────────────────────────
const WATER_DROP_SRC = WATER_DROP_MODEL_SRC   // waterDrop.glb + baked 'Bob' clip (shared with boxSystem's seedling drops)
const WATER_DROP_Y   = 0.8   // local Y above plant pivot
const DROP_FADE_MS   = 1600  // ms for scale-in / scale-out tween

/** plant entity → its waterDrop entity */
const waterDropMap = new Map<Entity, Entity>()

// ── Droplet idle float animation ──────────────────────────────
// Baked into waterDrop_bob.glb: ±0.065 m, 1.1 rad/s (5.7 s period) — see setDropBob.
// The drop carries the fade scale Tween; its parent 'bob' entity just holds the height.

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
const CLICKBOX_SCALE = { x: 1.5, y: 2, z: 1.5 }   // initial only — resizeClickboxes() sets the real size
// Click boxes are sized in WORLD metres (2026-09-17). The old fixed LOCAL scale made a
// full-size plant's box 1.5 m wide × 2 m tall while a 0.38-scale fast plant 0.5 m away
// got 0.57 m — inside its neighbour's box, so small plants were untappable everywhere.
const CLICKBOX_W_MAX   = 1.2    // m — never wider than this, however isolated the plant
const CLICKBOX_W_MIN   = 0.24   // m — touch floor. Was 0.4, which forced FastPlant_4/Plant_18 (0.42 m apart) and FastPlant_3/Plant_3 (0.54 m) to overlap;
                                //     0.24 leaves zero overlapping pairs across the 38-plant layout (KJ 2026-09-24: fast roses overlap their neighbours)
const CLICKBOX_GAP     = 0.96   // fraction of the neighbour gap the two boxes may fill together
const CLICKBOX_H_PER_SCALE = 1.9  // m of box height per unit of plant scale
const CLICKBOX_H_MIN   = 0.9    // m — short plants still need a finger-sized target

// ── In-world text labels ──────────────────────────────────────
const FONT_BLOOM_LABEL    = 2  // BloomCountdown / BloomResetTime signs (×4 each)
const FONT_WATERED_BY     = 1.2  // "Watered by" label above each plant
const WATERED_BY_Y        = 2.5  // local Y above plant pivot
// TextShape has no emissiveIntensity — colour only.
const TEXT_LABEL_COLOR    = { r: 1.0, g: 0.78, b: 0.5, a: 1 }  // gold/amber
const WATERED_BY_COLOR    = { r: 1.0, g: 0.95, b: 0.8, a: 1 }  // soft warm white / cream
const SCALE_BLOOM_LABEL = 1.4   // uniform scale applied to BloomCountdown / BloomResetTime

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

// ── Expiry ────────────────────────────────────────────────────
const EXPIRY_PROD_MS = 2.5 * 60 * 1_000        // 2.5 minutes
const EXPIRY_TEST_MS = 5 * 60 * 1_000        // 5 minutes (TEST_MODE)

// =============================================================
//                  end of config
// =============================================================

let runtimeTestMode    = TEST_MODE
let overrideDailyLimit = false
// Default ON: box colliders are immune to per-client visibility semantics — on the
// mobile client, colliders of GLTF meshes hidden via VisibilityComponent stop
// receiving pointer events (godot-explorer #1888), which killed watering on mobile.
let useClickbox        = true
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

const bloomCountdownLabels: Entity[] = []   // BloomCountdown, _2, _3, _4 — 60s sustain countdown
const bloomResetLabels:     Entity[] = []   // BloomResetTime, _2, _3, _4 — bloom reset countdown
let hoverSoundEntity:    Entity
let clickSoundEntity:    Entity
let wateringSoundEntity: Entity
let wiltSoundEntity:     Entity
const magicSoundEntities: Entity[] = []
let magicSoundIdx = 0

let waterRemaining          = DAILY_WATER_LIMIT
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
let lastDailyStateMs      = 0       // last playerDailyState (the head of every full sync) — see room.onReady

const wateredByLabelMap = new Map<Entity, Entity>()
// Flair icon above a "Watered by" label — created lazily (most waterers have no tier yet),
// parented to the billboarded label so it turns with the text.
const flairIconMap = new Map<Entity, Entity>()
const FLAIR_ICON_Y = 0.30
const FLAIR_ICON_S = 0.22
function setLabelFlair(plant: Entity, tier: number): void {
  const f = flairIcon(tier)
  let icon = flairIconMap.get(plant)
  if (!f) { if (icon) Transform.getMutable(icon).scale = { x: 0, y: 0, z: 0 }; return }
  const label = wateredByLabelMap.get(plant)
  if (!label) return
  if (!icon) {
    icon = engine.addEntity()
    Transform.create(icon, { position: { x: 0, y: FLAIR_ICON_Y, z: 0 }, parent: label })
    MeshRenderer.setPlane(icon)
    flairIconMap.set(plant, icon)
  }
  Transform.getMutable(icon).scale = { x: FLAIR_ICON_S, y: FLAIR_ICON_S, z: FLAIR_ICON_S }
  Material.setPbrMaterial(icon, {
    texture: Material.Texture.Common({ src: f.src }), alphaTexture: Material.Texture.Common({ src: f.src }),
    albedoColor: Color4.create(f.tint.r, f.tint.g, f.tint.b, 1), emissiveColor: f.tint, emissiveIntensity: 0.9,
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND, castShadows: false,
  })
}
const wateredByNames    = new Map<Entity, string>()   // entity → display name
// entity → the waterer's Almanac title, '' for most people. Text rather than an icon,
// unlike the flair tier: there is no art for the four rungs, and the title IS the reward,
// so it has to be readable. It only appears once someone has found 10 species, which is
// what keeps it off nearly every label and stops the garden turning into a wall of text.
const wateredByTitles   = new Map<Entity, string>()

const bloomContributors = new Set<string>()           // unique waterer names this bloom cycle
let   contributorLabelEntity: Entity | null = null
let   contributorLabelGen = 0
const entityPlantId     = new Map<Entity, string>()   // entity → plantId (for expiry lookup)

/** plant entity → its UnhealthyRose entity */
const roseMap = new Map<Entity, Entity>()

// ── Plant / rose animators: created when each GLB reports loaded ──────────────
const pendingPlantAnimators = new Set<Entity>()
const pendingRoseAnimators  = new Set<Entity>()
const pendingDropAnimators  = new Set<Entity>()

/** LS_FINISHED → true; error/not-found → dropped (logged); still loading → false. */
function glbReady(e: Entity, pending: Set<Entity>): boolean {
  const st = GltfContainerLoadingState.getOrNull(e)?.currentState
  if (st === LS_NOT_FOUND || st === LS_FINISHED_WITH_ERROR) {
    pending.delete(e)
    console.log(`[WateringSystem] GLB failed to load for entity ${e} — no animator`)
    return false
  }
  return st === LS_FINISHED
}

function plantAnimatorInitSystem(): void {
  // All three queues drain within seconds of load, but the spreads below allocate three
  // arrays EVERY FRAME whether or not there is anything in them — ~180 throwaway arrays a
  // second, for the whole session, to do nothing. The sets are the state that says whether
  // there is work; ask them first.
  if (pendingPlantAnimators.size === 0 && pendingDropAnimators.size === 0 && pendingRoseAnimators.size === 0) return
  for (const entity of [...pendingPlantAnimators]) {
    if (!glbReady(entity, pendingPlantAnimators)) continue
    pendingPlantAnimators.delete(entity)
    Animator.createOrReplace(entity, {
      states: [
        { clip: ANIM_DROOPY_STATE,  playing: false, loop: true  },
        { clip: ANIM_TO_HEALTHY,    playing: false, loop: false },
        { clip: ANIM_HEALTHY_STATE, playing: false, loop: true  },
        { clip: ANIM_CLOSE_PLAY,    playing: false, loop: false, speed: ANIM_CLOSE_PLAY_SPEED },
      ],
    })
    // The state as of NOW. A bloom no longer holds plants green (2026-09-22).
    const healthy = PlantData.getOrNull(entity)?.isWatered ?? false
    if (isShown(entity)) Animator.playSingleAnimation(entity, healthy ? ANIM_HEALTHY_STATE : ANIM_DROOPY_STATE, true)
  }
  for (const drop of [...pendingDropAnimators]) {
    if (!glbReady(drop, pendingDropAnimators)) continue
    pendingDropAnimators.delete(drop)
    Animator.createOrReplace(drop, { states: [{ clip: DROP_BOB_CLIP, playing: shownDrops.has(drop) && nearPlants.has(drop), loop: true, speed: 0.85 + Math.random() * 0.3 }] })
  }
  for (const rose of [...pendingRoseAnimators]) {
    if (!glbReady(rose, pendingRoseAnimators)) continue
    pendingRoseAnimators.delete(rose)
    Animator.createOrReplace(rose, {
      states: [
        { clip: ANIM_UNHEALTHY_IDLE, playing: false, loop: true  },
        { clip: ANIM_CLOSE_PLAY,     playing: false, loop: false },
      ],
    })
    if (isShown(rose)) Animator.playSingleAnimation(rose, ANIM_UNHEALTHY_IDLE, true)
  }
}

// Each plant is a PAIR of skinned, animated GLBs (rose + healthy plant) swapped by
// visibility. Hiding a model doesn't stop its Animator, so 38 hidden twins kept skinning
// every frame. The hidden one is stopped; whoever shows it starts its clip (every
// showPlant call site is followed by playSingleAnimation; showRose restarts the idle).
function showRose(entity: Entity)  {
  const r = roseMap.get(entity); if (!r) return
  VisibilityComponent.createOrReplace(r, { visible: true })
  if (Animator.has(r)) Animator.playSingleAnimation(r, ANIM_UNHEALTHY_IDLE, false)
}
function hideRose(entity: Entity)  {
  const r = roseMap.get(entity); if (!r) return
  VisibilityComponent.createOrReplace(r, { visible: false })
  if (Animator.has(r)) Animator.stopAllAnimations(r)
}
function showPlant(entity: Entity) { VisibilityComponent.createOrReplace(entity, { visible: true  }) }
function hidePlant(entity: Entity) {
  VisibilityComponent.createOrReplace(entity, { visible: false })
  if (Animator.has(entity)) Animator.stopAllAnimations(entity)
}
const isShown = (e: Entity): boolean => VisibilityComponent.getOrNull(e)?.visible !== false

// ── Animation budget (2026-09-21) ────────────────────────────
// Every plant carries THREE looping clips at rest: its own idle, the UnhealthyRose
// overlay's idle, and the water drop's bob. At 38 plants that is 114 clips running every
// frame whether or not you can see them — DCL does not cull animation for you, and it is
// the dominant per-frame cost in the garden. Anything that multiplies the plant count
// multiplies that, so idles now only run within ANIM_RANGE of the player.
// Hysteresis (ANIM_RANGE_OUT > ANIM_RANGE) stops a plant thrashing on the boundary while
// you stand next to it; the sweep is throttled because it is O(plants).
const ANIM_RANGE      = 18      // m — start playing
const ANIM_RANGE_OUT  = 22      // m — stop playing
const ANIM_SWEEP_S    = 0.5     // s between sweeps
const nearPlants = new Set<Entity>()   // plant / rose / drop entities currently animating
let animSweepIn = 0

/** Re-assert the idle a plant and its rose should be playing, given its watered state. */
function resumeIdles(entity: Entity): void {
  const healthy = PlantData.getOrNull(entity)?.isWatered ?? false
  if (Animator.has(entity) && isShown(entity)) {
    Animator.playSingleAnimation(entity, healthy ? ANIM_HEALTHY_STATE : ANIM_DROOPY_STATE, true)
  }
  const rose = roseMap.get(entity)
  if (rose !== undefined && Animator.has(rose) && isShown(rose)) {
    Animator.playSingleAnimation(rose, ANIM_UNHEALTHY_IDLE, true)
  }
}

function animBudgetSystem(dt: number): void {
  animSweepIn -= dt
  if (animSweepIn > 0) return
  animSweepIn = ANIM_SWEEP_S
  const me = Transform.getOrNull(engine.PlayerEntity)?.position
  if (!me) return
  const inSq = ANIM_RANGE * ANIM_RANGE, outSq = ANIM_RANGE_OUT * ANIM_RANGE_OUT
  const dInSq = DROP_RANGE * DROP_RANGE, dOutSq = DROP_RANGE_OUT * DROP_RANGE_OUT
  for (const [entity] of engine.getEntitiesWith(PlantData)) {
    const p = Transform.getOrNull(entity)?.position
    if (!p) continue
    const dx = p.x - me.x, dz = p.z - me.z
    const sq = dx * dx + dz * dz

    // Drops get their own, wider band — and their own hysteresis, so the fade never
    // chatters while you stand on the boundary.
    const dWas = dropInRange.has(entity)
    const dNow = dWas ? sq < dOutSq : sq < dInSq
    if (dNow !== dWas) {
      if (dNow) dropInRange.add(entity); else dropInRange.delete(entity)
      applyDropVisibility(entity)
    }

    const was = nearPlants.has(entity)
    const now = was ? sq < outSq : sq < inSq      // hysteresis
    if (now === was) continue

    const rose = roseMap.get(entity)
    const drop = waterDropMap.get(entity)
    if (now) {
      nearPlants.add(entity)
      if (rose !== undefined) nearPlants.add(rose)
      if (drop !== undefined) nearPlants.add(drop)
      resumeIdles(entity)
    } else {
      nearPlants.delete(entity)
      if (rose !== undefined) { nearPlants.delete(rose); if (Animator.has(rose)) Animator.stopAllAnimations(rose) }
      if (drop !== undefined) nearPlants.delete(drop)
      if (Animator.has(entity)) Animator.stopAllAnimations(entity)
    }
    if (drop !== undefined) applyDropBob(drop)
  }
}

// The bob is BAKED into waterDrop_bob.glb (clip 'Bob', node translation ±0.065 m,
// one 5.7 s sine period — generated from waterDrop.glb, geometry untouched). It used to be a
// looping Tween, and the explorer writes a looping-tweened entity's Transform back to the scene
// EVERY frame: 38 drops = 38 inbound messages per tick at rest. GLB animation has no write-back.
// Each drop gets a slightly different speed so they drift out of step instead of bobbing as one.
const DROP_BOB_CLIP = 'Bob'
const shownDrops   = new Set<Entity>()   // drops currently showing (their bob should play)

function setDropBob(drop: Entity, on: boolean): void {
  if (on) shownDrops.add(drop); else shownDrops.delete(drop)
  applyDropBob(drop)
}

/** The bob plays only when the drop is BOTH shown and near enough to matter. Two
 *  independent gates, so the distance system can never lose track of whether a drop is
 *  meant to be visible at all. */
function applyDropBob(drop: Entity): void {
  const want = shownDrops.has(drop) && nearPlants.has(drop)
  const st = Animator.getMutableOrNull(drop)?.states[0]
  if (st && st.playing !== want) st.playing = want
}

// What GAMEPLAY wants — "this plant needs water, so it should carry a drop". Whether the
// drop is actually on screen is a separate question (distance), and the two are combined
// in applyDropVisibility. Keeping them apart means the nine call sites below can go on
// expressing intent without knowing where the player is standing.
const dropWanted = new Set<Entity>()

function setDropFade(plantEntity: Entity, direction: 'in' | 'out') {
  if (direction === 'in') dropWanted.add(plantEntity); else dropWanted.delete(plantEntity)
  applyDropVisibility(plantEntity)
}

/** Show the drop only if gameplay wants it AND it is near enough to be worth showing. */
function applyDropVisibility(plantEntity: Entity): void {
  const drop = waterDropMap.get(plantEntity)
  if (!drop) return
  const show = !dropsSuppressed && dropWanted.has(plantEntity) && dropInRange.has(plantEntity)
  if (dropShown.has(plantEntity) === show) return      // already in that state — no re-tween
  if (show) dropShown.add(plantEntity); else dropShown.delete(plantEntity)
  if (show) {
    setDropBob(drop, true)
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
    setDropBob(drop, false)
  }
}
const dropInRange = new Set<Entity>()   // plants whose drop is close enough to render

/** Perf test: force every drop off, regardless of range or gameplay state. */
let dropsSuppressed = false
export function setDropsSuppressed(off: boolean): void {
  dropsSuppressed = off
  for (const [entity] of engine.getEntitiesWith(PlantData)) applyDropVisibility(entity)
}

/** Perf test: hide/show every plant AND its anchor (the anchor owns the rose, drop,
 *  labels and click box, so hiding the plant alone leaves most of the cost on screen). */
export function setAllPlantsVisible(visible: boolean): void {
  for (const name of plantNames()) {
    const pair = plantMovePair(name)
    if (!pair) continue
    for (const e of [pair.plant, pair.anchor]) {
      if (VisibilityComponent.has(e)) VisibilityComponent.getMutable(e).visible = visible
      else VisibilityComponent.create(e, { visible })
    }
  }
}
const dropShown   = new Set<Entity>()   // plants whose drop is currently tweened IN


// ---------------------------------------------------------------
// Reset animation state machine
// ---------------------------------------------------------------

type ResetPhase = 'to_droopy' | 'done'
const reset = { phase: 'done' as ResetPhase, queue: [] as Entity[] }

// ---------------------------------------------------------------
// Scene-asset visibility
// ---------------------------------------------------------------

let _sceneAssetsResolved    = false
let _centerTextBloom:        Entity | null = null
let _centerTextProgress:     Entity | null = null
let _centerTextInstructions: Entity | null = null

function resolveSceneAssets() {
  if (_sceneAssetsResolved) return
  _sceneAssetsResolved     = true
  _centerTextBloom         = engine.getEntityOrNullByName('centerTextBloom')
  _centerTextProgress      = engine.getEntityOrNullByName('centerTextProgress')
  _centerTextInstructions  = engine.getEntityOrNullByName('CenterTextInstructions.glb')
  if (!_centerTextInstructions) console.log('[WateringSystem] CenterTextInstructions.glb entity not found')
  if (!_centerTextProgress)     console.log('[WateringSystem] centerTextProgress entity not found')
  if (!_centerTextBloom)        console.log('[WateringSystem] centerTextBloom entity not found')
}

function setVisible(entity: Entity | null, visible: boolean) {
  if (!entity) return
  VisibilityComponent.createOrReplace(entity, { visible })
}

// ── Bloom-reset countdown ticker ─────────────────────────────
let bloomResetTickerGen  = 0
let bloomResetStartMs: number | null = null
let bloomDurationMs = BLOOM_RESET_DELAY_MS   // this bloom's length, from bloomTriggered (contributor-scaled)

/** @param elapsedMs how far into the bloom we join (late joiners) — keeps every client's
 *  countdown and end-of-bloom moment aligned with the server's. */
function startBloomResetTicker(elapsedMs = 0): void {
  bloomResetStartMs = Date.now() - elapsedMs
  const myGen = ++bloomResetTickerGen

  // Dedicated terminal timer — fires startBloomClose() at exactly countdown=0,
  // independently of the 1-second display loop.  The display loop is cancelled by
  // stopBloomResetTicker() (gen bump) when bloomReset arrives, but that must NOT
  // prevent the close animation from starting on time.  isBloomActive() guards
  // against stale timers firing during a subsequent bloom cycle (test mode).
  timers.setTimeout(() => {
    if (isBloomActive()) startBloomClose()
  }, Math.max(0, bloomDurationMs - elapsedMs))

  function tick(): void {
    if (bloomResetTickerGen !== myGen) return
    const elapsed   = Date.now() - (bloomResetStartMs ?? Date.now())
    const remaining = Math.max(0, bloomDurationMs - elapsed)
    const totalSecs = Math.ceil(remaining / 1_000)
    const m = Math.floor(totalSecs / 60)
    const s = totalSecs % 60
    const label = totalSecs > 0
      ? (m > 0 ? `${m}m ${s}s` : `${s}s`)
      : '…'
    setBloomResetText(label)
    updateBloomRemaining(totalSecs > 0 ? `${m}:${String(s).padStart(2, '0')}` : '', remaining, bloomDurationMs)   // HUD ring shows time left
    if (remaining > 0) timers.setTimeout(tick, 1_000)
    // No startBloomClose() here — the dedicated timer above handles it
  }
  tick()
}

function stopBloomResetTicker(): void {
  bloomResetTickerGen++
  bloomResetStartMs = null
}

function updateSceneAssets() {
  resolveSceneAssets()
  const aboveThreshold = computeWateredCount() >= bloomThreshold
  // Use only bloomSystem's visual flag — wateringSystem.bloomActive is the gameplay
  // cooldown guard (blocks watering for 65s), not a scene-visibility signal.
  const inBloom        = isBloomActive()
  const inCountdown    = !inBloom && (aboveThreshold || countdownUnlocked)

  // Phase 1 — idle: instructions GLB only
  setVisible(_centerTextInstructions, !inCountdown && !inBloom)
  // Phase 2 — countdown: progress GLB + countdown text labels
  setVisible(_centerTextProgress, inCountdown)
  // Phase 3 — bloom: bloom GLB + reset countdown text labels
  setVisible(_centerTextBloom, inBloom)

  if (inCountdown && aboveThreshold) {
    // Only refresh while above threshold; below threshold = paused / frozen at last value
    setBloomCountdownText(formatSustainCountdown())
  }
}

// ---------------------------------------------------------------
// Bloom label helpers
// ---------------------------------------------------------------

function setBloomCountdownText(text: string) {
  for (const e of bloomCountdownLabels) TextShape.getMutable(e).text = text
}

function setBloomResetText(text: string) {
  for (const e of bloomResetLabels) TextShape.getMutable(e).text = text
}

function clearBloomLabels() {
  for (const e of bloomCountdownLabels) {
    TextShape.getMutable(e).text = ''
    setScale(e, SCALE_BLOOM_LABEL)
  }
  for (const e of bloomResetLabels) {
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
  VisibilityComponent.createOrReplace(contributorLabelEntity, { visible: true })
  const myGen = ++contributorLabelGen
  let i = 0
  function showNext(): void {
    if (contributorLabelGen !== myGen) {
      if (contributorLabelEntity) {
        TextShape.getMutable(contributorLabelEntity).text = ''
        VisibilityComponent.createOrReplace(contributorLabelEntity, { visible: false })
      }
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
        VisibilityComponent.createOrReplace(contributorLabelEntity!, { visible: false })
      }, CONTRIBUTOR_DISPLAY_MS)
    }
  }
  showNext()
}

function stopContributorCycle(): void {
  contributorLabelGen++
  if (contributorLabelEntity) {
    TextShape.getMutable(contributorLabelEntity).text = ''
    VisibilityComponent.createOrReplace(contributorLabelEntity, { visible: false })
  }
}

// ── Pre-bloom ticker — counts down while health >= threshold, bloom not yet active ──
let preBloomTickerGen = 0
// Set when threshold is first crossed this cycle; keeps bloom labels visible (paused)
// even if health briefly dips below.  Cleared only on bloomReset.
let countdownUnlocked = false

// ── Client-side 60 s sustain countdown ───────────────────────
// Mirrors the server's pauseable sustain timer so the 3D labels show
// exactly how long until bloom fires (not the scheduled window time).
let gardenersPresent = 1   // server's count (thresholdUpdate) — drives hold length + the HUD
let clientSustainStartMs:  number | null = null   // wall-clock ms when current run started
let clientSustainElapsedMs: number       = 0      // ms accumulated across paused segments

function formatSustainCountdown(): string {
  const elapsed     = clientSustainElapsedMs
                    + (clientSustainStartMs !== null ? Date.now() - clientSustainStartMs : 0)
  const remainingMs = Math.max(0, bloomSustainMs(gardenersPresent) - elapsed)
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
    setBloomCountdownText(countdown)              // ticker only runs while health ≥ threshold
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
  updateProgressBars(count, TOTAL_PLANTS)
  updateGroundLights(count)
  updateBannerHealth(count / TOTAL_PLANTS)
  // Banner state: idle below threshold, countdown at/above threshold (unless bloom active)
  if (!isBloomActive() && !bloomActive) {
    if (count >= bloomThreshold) {
      countdownUnlocked = true   // latches on; only cleared by bloomReset
      // Resume (or start) the client sustain clock
      if (clientSustainStartMs === null) clientSustainStartMs = Date.now()
      const countdown = formatSustainCountdown()
      showBannerCountdown(countdown)
      setBloomCountdownText(countdown)
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

/** Size every clickbox in world metres from its nearest neighbour: the gap between two
 *  plants is split in proportion to their scales (big plant → bigger share), so boxes
 *  never swallow a smaller neighbour. Call once all plants are registered. */
function resizeClickboxes(): void {
  const items: Array<{ box: Entity; x: number; z: number; s: number }> = []
  for (const info of plantRegistry.values()) {
    if (!info.clickboxEntity) continue
    const tf = Transform.getOrNull(info.anchor)
    if (!tf) continue
    items.push({ box: info.clickboxEntity, x: tf.position.x, z: tf.position.z, s: Math.max(0.05, tf.scale.x) })
  }
  for (const a of items) {
    let width = CLICKBOX_W_MAX
    for (const b of items) {
      if (b === a) continue
      const d = Math.hypot(a.x - b.x, a.z - b.z)
      // my share of the gap, as a full width: 2 × d × myScale / (myScale + theirScale)
      width = Math.min(width, 2 * d * CLICKBOX_GAP * a.s / (a.s + b.s))
    }
    width = Math.max(CLICKBOX_W_MIN, Math.min(CLICKBOX_W_MAX, width))
    const height = Math.max(CLICKBOX_H_MIN, CLICKBOX_H_PER_SCALE * a.s)
    const t = Transform.getMutable(a.box)
    // anchor mirrors the plant's scale, so convert world metres → local units
    t.scale    = { x: width / a.s, y: height / a.s, z: width / a.s }
    t.position = { x: 0, y: (height / 2) / a.s, z: 0 }
  }
  console.log(`[WateringSystem] clickboxes sized for ${items.length} plants (world metres, neighbour-aware)`)
}

const plantRegistry     = new Map<Entity, { clickTarget: Entity; plantName: string; clickboxEntity: Entity | null; anchor: Entity }>()
const plantNameToEntity = new Map<string, Entity>()

/** Plant layout editor (plantLayoutTool.ts): every plant by name, and the pair of entities
 *  that have to move together. The ANCHOR is a sibling that mirrors the plant's transform
 *  and owns every derived child (rose, water drop, labels, click box), so moving the plant
 *  alone would leave its drop and click box behind. */
export function plantNames(): string[] { return [...plantNameToEntity.keys()].sort() }
export function plantMovePair(name: string): { plant: Entity; anchor: Entity } | null {
  const plant = plantNameToEntity.get(name)
  if (plant === undefined) return null
  const reg = plantRegistry.get(plant)
  return reg ? { plant, anchor: reg.anchor } : null
}

function enablePlantClick(entity: Entity) {
  const info = plantRegistry.get(entity)
  if (!info) return
  pointerEventsSystem.onPointerDown(
    { entity: info.clickTarget, opts: { button: InputAction.IA_POINTER, hoverText: 'Water', maxDistance: POINTER_MAX_DIST } },
    () => {
      // Player-based reach gate — maxDistance above is camera-based and must stay
      // generous for mobile; this is the real "how far can I water from" limit.
      const plantPos  = Transform.getOrNull(entity)?.position
      const playerPos = Transform.getOrNull(engine.PlayerEntity)?.position
      if (plantPos && playerPos) {
        const dx = playerPos.x - plantPos.x
        const dz = playerPos.z - plantPos.z
        if (dx * dx + dz * dz > MAX_REACH_M * MAX_REACH_M) {
          const now = Date.now()
          if (now - lastBlockedClickMs > BLOCKED_CLICK_COOLDOWN_MS) {
            lastBlockedClickMs = now
            showToast('Step a little closer to water this plant', 2_000)
          }
          return
        }
      }
      pourOnto(entity, info.plantName)
    },
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

export function resetDailyLimit(): void {
  waterRemaining = DAILY_WATER_LIMIT
  updateProgressText()
  console.log('[TEST] Daily limit reset')
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

export function isWateringEmoteActive(): boolean { return emoteActive }

function stopWateringEmote() {
  if (!emoteActive) return
  emoteActive = false
  syncMyHand()   // the can is gone — bring back the seed / keepsake
  triggerSceneEmote({ src: '', loop: false })
}

const EMOTE_STOP_ACTIONS = [
  InputAction.IA_FORWARD,
  InputAction.IA_BACKWARD,
  InputAction.IA_LEFT,
  InputAction.IA_RIGHT,
  InputAction.IA_JUMP,
] as const

// Persistent system — registered once in setupWateringSystem, runs only while emote is active.
function emoteWatchSystem(): void {
  if (!emoteActive) return
  for (const action of EMOTE_STOP_ACTIONS) {
    if (inputSystem.isTriggered(action, PointerEventType.PET_DOWN)) {
      stopWateringEmote()
      return
    }
  }
}

/** The tap feedback a garden plant gets — emote now, pour sound at WATER_FX_MS — for
 *  other tap targets that water something (seedlings, boxSystem). Week-2 playtest:
 *  watering a friend's seed played nothing. */
export function playWateringBeat(): void {
  if (emoteActive) return
  playClickSound()
  triggerWateringEmote(engine.PlayerEntity)
  timers.setTimeout(playWateringSound, WATER_FX_MS)
}

function triggerWateringEmote(_plantEntity: Entity) {
  // movePlayerTo retired (Clean The Club precedent) — teleport-stepping players
  // to the plant put them inside geometry; the emote now plays where they stand.
  emoteActive = true
  syncMyHand()   // one thing in the hand at a time: the can replaces the seed / keepsake

  timers.setTimeout(() => {
    if (!emoteActive) return
    triggerSceneEmote({ src: EMOTE_SRC, loop: false })
    timers.setTimeout(() => {
      stopWateringEmote()
    }, EMOTE_TOTAL_MS)
  }, EMOTE_TRIGGER_MS)
}

// ---------------------------------------------------------------
// Plant lifecycle
// ---------------------------------------------------------------

// Decay is gardener-scaled on the server, so the authoritative duration arrives
// with every plantStateUpdate. The constants below are only the optimistic guess
// for the ~200 ms between our tap and the server's confirmation.
const serverExpiryMs = new Map<string, number>()   // plantId → last expiresInMs from the server

/** Expiry duration for a plant — the server's figure once known, else the local guess. */
function plantExpiryMs(plantId: string): number {
  const fromServer = serverExpiryMs.get(plantId)
  if (fromServer !== undefined && fromServer > 0) return fromServer
  if (FAST_PLANT_NAMES.has(plantId)) return FAST_PLANT_EXPIRY_MS
  return runtimeTestMode ? EXPIRY_TEST_MS : EXPIRY_PROD_MS
}

// One live expiry timer per plant: a reschedule (server confirming a longer
// decay than our guess) must supersede the earlier timer, not race it.
const expiryGen = new Map<Entity, number>()

/** Watered plants inside their last EXPIRY_TELL_MS: drop showing, a tap is a top-up. */
const expiryTell = new Set<Entity>()

function scheduleExpiry(entity: Entity, sessionTimestamp: number, delayMs: number) {
  const gen = (expiryGen.get(entity) ?? 0) + 1
  expiryGen.set(entity, gen)
  expiryTell.delete(entity)
  // Expiry tell (week-2 playtest 2026-09-22, "add a skill check to watering"): the drop
  // comes back EXPIRY_TELL_MS before the plant dries, while it is still green. Which to
  // water first — the one about to go, or the one already gone — is the decision.
  timers.setTimeout(() => {
    if (expiryGen.get(entity) !== gen) return
    const pd = PlantData.get(entity)
    if (!pd.isWatered || pd.wateredAt !== sessionTimestamp) return
    expiryTell.add(entity)
    setDropFade(entity, 'in')
  }, Math.max(0, delayMs - EXPIRY_TELL_MS))
  timers.setTimeout(() => {
    if (expiryGen.get(entity) !== gen) return
    const pd = PlantData.getMutable(entity)
    if (!pd.isWatered || pd.wateredAt !== sessionTimestamp) return
    expiryTell.delete(entity)

    // Mark expired immediately so progress & clicks are correct.
    // Another player can water during the ClosePlay animation — the timer
    // below guards against applying the visual swap if that happens.
    pd.isWatered = false
    pd.wateredAt = 0
    updateProgressText()
    enablePlantClick(entity)

    // Clear the "watered by" label immediately on expiry
    wateredByNames.delete(entity)
    setLabelFlair(entity, 0)
    const expiredLabel = wateredByLabelMap.get(entity)
    if (expiredLabel) TextShape.getMutable(expiredLabel).text = ''

    // Wilt plays during a bloom too (2026-09-22: watering during bloom is allowed, so a
    // dry plant has to LOOK dry under the spectacle).
    {
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
    }
  }, delayMs)
}

/** Press on a plant. A tap waters at once; holding pours (see skillCheck.tsx): a just-right
 *  release adds watered time, too much and the plant is not watered at all. The can comes out
 *  on the press so the hold has a pose behind it. */
function pourOnto(entity: Entity, plantId: string): void {
  if (!HOLD_WATERING_ENABLED) { waterPlant(entity, plantId); return }
  if (emoteActive || isHolding()) return
  if (PlantData.get(entity).isWatered && !expiryTell.has(entity)) { waterPlant(entity, plantId); return }   // its own "already watered" toast
  triggerWateringEmote(entity)
  beginHold((outcome) => {
    if (outcome === 'over') {
      stopWateringEmote()
      playWiltSound(entity)
      showToast('Too much water! Let go sooner', TOAST_WATERED_MS, false)
      return
    }
    waterPlant(entity, plantId, outcome === 'sweet', true)
  })
}

function waterPlant(entity: Entity, plantId: string, sweet = false, fromHold = false) {
  // Watering during a bloom is allowed (2026-09-22) — the old "Can't water during bloom" gate is gone.
  if (emoteActive && !fromHold) return

  // Gate: already watered and not yet showing its expiry tell — inform without using water.
  // Inside the tell the tap is a top-up (the server re-arms the full timer).
  if (PlantData.get(entity).isWatered && !expiryTell.has(entity)) {
    const now = Date.now()
    if (now - lastBlockedClickMs > BLOCKED_CLICK_COOLDOWN_MS) {
      lastBlockedClickMs = now
      showToast('This plant is already watered', TOAST_WATERED_MS, false)
    }
    return
  }

  const pd = PlantData.getMutable(entity)
  const wasAlreadyWatered = pd.isWatered   // top-up: only reachable inside the expiry tell
  const prevWateredAt     = pd.wateredAt
  expiryTell.delete(entity)

  const now = Date.now()
  pd.isWatered = true
  pd.wateredAt = now

  disablePlantClick(entity)     // prevent double-click while pending; re-enabled on confirmation
  setDropFade(entity, 'out')    // hide drop when watering

  playClickSound()
  if (!fromHold) triggerWateringEmote(entity)   // a hold already started it on the press
  if (sweet) {   // just-right pour: the plant answers with a flourish
    const at = Transform.getOrNull(entity)?.position
    if (at) timers.setTimeout(() => { playMagicFXSound(); triggerSparkle(at) }, WATER_FX_MS)
    showToast('Just right! Stays watered longer', TOAST_WATERED_MS, false)
  }

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

  room.send('waterPlant', { plantId, sweet })
  pendingWaters.set(plantId, { ts: now, prevWateredAt, wasTopUp: wasAlreadyWatered })

  updateProgressText()
  const _pct = Math.round((computeWateredCount() / TOTAL_PLANTS) * 100)
  showToast(`Plant Watered! ${_pct}%`, TOAST_WATERED_MS, true)

  scheduleExpiry(entity, now, plantExpiryMs(plantId))
}

export function resetAllPlants(): void {
  endBloom()
  endBloomSparkles()
  stopFireflies()
  setFairyLightsBloom(false)
  hidePersistent()

  // Plants watered during the bloom and still fresh survive its end (2026-09-22) — the
  // server has already sent isWatered=false for every plant it DID reset, so local state
  // is authoritative here. Only the dry ones lose their label and go back to droopy.
  for (const [plant, labelEntity] of wateredByLabelMap) {
    if (PlantData.getOrNull(plant)?.isWatered) continue
    TextShape.getMutable(labelEntity).text = ''
    wateredByNames.delete(plant)
    setLabelFlair(plant, 0)
  }

  reset.queue = []
  for (const [entity] of engine.getEntitiesWith(PlantData)) {
    if (PlantData.get(entity).isWatered) continue
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
    // Only write when the text changes — any TextShape write rebuilds that label's mesh,
    // and "2m ago" mostly doesn't change between 5 s refreshes.
    const title = wateredByTitles.get(entity) ?? ''
    const text = `Watered by ${name}${title ? `\n${title}` : ''}\n${formatTimeAgo(pd.wateredAt)}`
    if (TextShape.get(labelEntity).text === text) continue
    const ts = TextShape.getMutable(labelEntity)
    ts.text      = text
    // Fixed alpha, matching the flair icon above it (which never fades) — a fade tied to
    // time-to-expiry made the name go fully invisible on any plant watered a while ago,
    // leaving just the flair badge floating with no name under it. Found 2026-09-17.
    ts.textColor = WATERED_BY_COLOR
  }
}

/** Code-owned layout (shared/layout.ts): move the composite's plant entities BEFORE
 *  setupPlant derives anchors / drops / click boxes from their transforms. */
function applyPlantLayout(): void {
  let moved = 0
  for (const [name, p] of Object.entries(PLANT_LAYOUT)) {
    const entity = engine.getEntityOrNullByName(name)
    if (!entity) { console.log(`[Layout] no entity named "${name}" — skipped`); continue }
    const tf = Transform.getMutableOrNull(entity)
    if (!tf) continue
    tf.position = { x: p.x, y: p.y, z: p.z }
    if (p.rotY !== undefined) tf.rotation = Quaternion.fromEulerDegrees(0, p.rotY, 0)
    if (p.scale !== undefined) tf.scale = { x: p.scale, y: p.scale, z: p.scale }
    moved++
  }
  if (moved > 0) console.log(`[Layout] ${moved} plants placed from shared/layout.ts`)
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
    // With clickboxes the mesh has no pointer handler — on the pointer layer it would
    // only BLOCK taps meant for a smaller neighbour behind it.
    GltfContainer.getMutable(entity).visibleMeshesCollisionMask =
      useClickbox ? ColliderLayer.CL_PHYSICS : ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER
  }

  // Neutral anchor mirroring the plant's transform. Runtime children (rose, drop,
  // labels, clickbox) parent to THIS instead of the plant entity: on the mobile
  // client, VisibilityComponent on a parent hides all its children too
  // (godot-explorer #1888 — reported against this very scene), so hiding the plant
  // was hiding every rose, drop and label with it. The anchor never gets a
  // VisibilityComponent, so its children are safe under either semantics.
  const plantTf = Transform.getOrNull(entity)
  const anchor  = engine.addEntity()
  Transform.create(anchor, {
    position: plantTf ? { ...plantTf.position } : { x: 0, y: 0, z: 0 },
    rotation: plantTf ? { ...plantTf.rotation } : { x: 0, y: 0, z: 0, w: 1 },
    scale:    plantTf ? { ...plantTf.scale }    : { x: 1, y: 1, z: 1 },
    parent:   plantTf?.parent,
  })

  // Spawn the UnhealthyRose model on the anchor — sits exactly on top of the plant
  const roseEntity = engine.addEntity()
  Transform.create(roseEntity, { parent: anchor })
  GltfContainer.create(roseEntity, { src: UNHEALTHY_ROSE_SRC })
  roseMap.set(entity, roseEntity)

  // Fail-open: show the unwatered rose immediately so plants are visible and
  // clickable even if the deferred animator init below never runs (e.g. the
  // client kills or stalls the scene runtime mid-startup). The deferred init
  // corrects visibility for plants the server reports as watered.
  hidePlant(entity)
  showRose(entity)

  let clickTarget:    Entity
  let clickboxEntity: Entity | null = null
  if (useClickbox) {
    const clickBox = engine.addEntity()
    Transform.create(clickBox, { position: { x: 0, y: CLICKBOX_Y, z: 0 }, scale: CLICKBOX_SCALE, parent: anchor })
    MeshCollider.setBox(clickBox, ColliderLayer.CL_POINTER)
    clickTarget    = clickBox
    clickboxEntity = clickBox
  } else {
    clickTarget = entity
  }

  plantRegistry.set(entity, { clickTarget, plantName, clickboxEntity, anchor })
  plantNameToEntity.set(plantName, entity)
  entityPlantId.set(entity, plantName)
  enablePlantClick(entity)

  // ── Water drop indicator ─────────────────────────────────────
  const bobEnt = engine.addEntity()
  Transform.create(bobEnt, { position: { x: 0, y: WATER_DROP_Y, z: 0 }, parent: anchor })
  // Starts HIDDEN — a droopy plant's drop fading IN through setDropFade (below) is what
  // should make it appear. Starting at full scale left every drop visible from the instant
  // it was created, before any server message had a chance to say the plant was already
  // watered — the likely cause of "drops on watered flowers" (KJ 2026-09-22); see the
  // matching fix in the plantStateUpdate join-recovery branch.
  const dropEnt = engine.addEntity()
  Transform.create(dropEnt, { position: { x: 0, y: 0, z: 0 }, scale: { x: 0.001, y: 0.001, z: 0.001 }, parent: bobEnt })
  GltfContainer.create(dropEnt, { src: WATER_DROP_SRC })
  GltfNodeModifiers.create(dropEnt, { modifiers: [{ path: '', castShadows: false }] })   // 38 small drops — not worth a shadow pass
  // No Billboard: the drop is a 3D teardrop, symmetric about Y, so facing the camera changed
  // nothing — yet the explorer re-rotated all 38 every frame.
  waterDropMap.set(entity, dropEnt)
  pendingDropAnimators.add(dropEnt)

  // "Watered by" label — hidden until plant is watered
  const wateredByLabel = engine.addEntity()
  Transform.create(wateredByLabel, { position: { x: 0, y: WATERED_BY_Y, z: 0 }, parent: anchor })
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
  // The in-world "N%" health text (Creator Hub entities `wateringPercentage` and
  // `Image_2`..`Image_5`) was retired 2026-09-21. None of those entities exist in the
  // composite any more — health reads from the GardenHealth sign art plus
  // progressBarsSystem and the HUD ring. The old code logged four "not found" warnings
  // every boot, and `wateringPercentage`'s `?? engine.addEntity()` fallback quietly built
  // an orphan entity at the scene origin, carrying a live TextShape that was then hidden
  // on every update. If those signs ever come back, rebuild this from git history.

  // ── Bloom countdown labels — 60s sustain countdown (shown pre-bloom) ──
  for (const name of ['BloomCountdown', 'BloomCountdown_2', 'BloomCountdown_3', 'BloomCountdown_4']) {
    const e = engine.getEntityOrNullByName(name)
    if (!e) { console.log(`[WateringSystem] ${name} not found`); continue }
    MeshRenderer.deleteFrom(e)
    Material.deleteFrom(e)
    setScale(e, SCALE_BLOOM_LABEL)
    TextShape.createOrReplace(e, { text: '', fontSize: FONT_BLOOM_LABEL, textColor: TEXT_LABEL_COLOR })
    bloomCountdownLabels.push(e)
  }

  // ── Bloom reset labels — garden reset countdown (shown during bloom) ──
  for (const name of ['BloomResetTime', 'BloomResetTime_2', 'BloomResetTime_3', 'BloomResetTime_4']) {
    const e = engine.getEntityOrNullByName(name)
    if (!e) { console.log(`[WateringSystem] ${name} not found`); continue }
    MeshRenderer.deleteFrom(e)
    Material.deleteFrom(e)
    setScale(e, SCALE_BLOOM_LABEL)
    TextShape.createOrReplace(e, { text: '', fontSize: FONT_BLOOM_LABEL, textColor: TEXT_LABEL_COLOR })
    bloomResetLabels.push(e)
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
  // Hidden by default — shown only while contributor cycle is running to avoid
  // leaving an implicit TextShape collider floating above the bloom model.
  VisibilityComponent.createOrReplace(contributorLabelEntity, { visible: false })

  setupLeaderboardBoards()

  setupBloomSystem({
    testMode:      TEST_MODE,
    onReset:       () => {},
    onVisualBloom: () => {
      // UI updates
      hidePersistent()
      stopPreBloomTicker()
      preBloomEffectsActive = false

      // Bloom sparkles at each plant position (needs registry access — must stay here)
      const positions: Array<{ x: number; y: number; z: number }> = []
      for (const [entity] of plantRegistry) {
        const pos = Transform.getOrNull(entity)?.position
        if (pos) positions.push(pos)
      }
      triggerBloomSparkles(positions)

      // All VFX, audio, petals, and lights driven by intensity system —
      // budget from bloom scale (solo = quiet bloom), flavour from the variant,
      // pacing from the real hold time so the finale actually plays before reset.
      startBloomPhases(bloomFxLevel(currentBloomScale), currentBloomVariant, bloomSustainMs(gardenersPresent))
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

  applyPlantLayout()
  applyPropLayout()
  for (const name of PLANT_NAMES) setupPlant(name)
  resizeClickboxes()

  // Starting look now (no GLB needed for visibility); animators once each GLB has loaded.
  // Was one 1 s timer doing both: on a slow/late-joining client it fired before the GLBs
  // loaded, and when the join sync (incl. an active bloom) arrived first it reset
  // bloom-healthy plants back to droopy. Server state updates visibility from here on.
  for (const name of PLANT_NAMES) {
    const entity = engine.getEntityOrNullByName(name)
    if (!entity) continue
    hidePlant(entity)
    showRose(entity)
    pendingPlantAnimators.add(entity)
    const rose = roseMap.get(entity)
    if (rose) pendingRoseAnimators.add(rose)
  }
  engine.addSystem(plantAnimatorInitSystem)
  engine.addSystem(animBudgetSystem)   // idles only run near the player

  setupPetalSystem()
  setupSparkleSystem()
  setupPlayerTrailSystem()
  setupAmbientFX()
  setupFairyLights()
  setupProgressBars()
  setupGroundLights()

  // Set correct initial GLB visibility (phase 1 = instructions only)
  updateSceneAssets()

  engine.addSystem(resetAnimSystem)
  engine.addSystem(emoteWatchSystem)
  engine.addSystem(petalParticleSystem)
  engine.addSystem(bloomSparkleSystem)
  engine.addSystem(ambientFXSystem)

  // (HUD gardener count now comes from the server's thresholdUpdate — see that handler.)

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
    // The server's join sync usually lands just before onReady; asking again re-applied the
    // whole garden a second later (KJ log 2026-09-18 15:36:30/31) — double the join spike.
    if (roomReady && now - lastDailyStateMs < SYNC_REQUEST_MIN_MS) {
      console.log('[Client] requestFullSync skipped — join sync just arrived')
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

  // ⚠️ Any subsystem that registers room.onMessage handlers MUST be set up AFTER
  // room.clear() above, or its listeners are silently wiped. (Seeds were registered
  // in the subsystem block before the clear and never received a single message —
  // cost a full day of playtests to find. Keep every room.onMessage below this line.)
  setupSeedSystem()
  setupBoxSystem()
  setupPlanterLayoutTool()   // planter editor (admin): re-applies the saved layout draft
  setupTributeSystem()
  setupAvenueSystem()        // the Avenue (entrance wall planters) — same post-room.clear() window

  room.onMessage('notifyServerTime', (data) => {
    clockSync.updateOffset(data.sentAt)
  })

  room.onMessage('playerDailyState', (data) => {
    lastDailyStateMs = Date.now()
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
    if (!initialLoadDone) {
      initialLoadDone = true
      timers.setTimeout(showWelcomeProgress, WELCOME_DELAY_MS)
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
            enablePlantClick(rejEntity)
          } else {
            // Fresh water rollback — revert to unwatered state.
            // Setting wateredAt=0 cancels pending animation timers (they
            // guard with wateredAt === pending.ts).
            pd.isWatered = false
            pd.wateredAt = 0
            hidePlant(rejEntity)
            showRose(rejEntity)
            setDropFade(rejEntity, 'in')
            enablePlantClick(rejEntity)
            // Only show "beaten to it" feedback when we actually rolled back — not when
            // plantStateUpdate arrived first and already resolved the pending correctly.
            if (data.reason === 'already_watered') {
              showToast('Someone else just watered that!', TOAST_WATERED_MS, false)
            }
          }
        }
      }
      stopWateringEmote()
    }
  })

  room.onMessage('thresholdUpdate', (data) => {
    if (!data || typeof data.threshold !== 'number' || data.threshold <= 0) return
    // Gardeners first: the threshold is flat since the decay rework, so the early return
    // below used to swallow every gardener change (hold length + HUD never heard of it).
    if (typeof data.gardeners === 'number' && data.gardeners > 0) {
      gardenersPresent = data.gardeners
      updatePlayerCount(gardenersPresent)
    }
    if (data.threshold === bloomThreshold) return
    bloomThreshold = data.threshold
    setBloomRatio(bloomThreshold / TOTAL_PLANTS)
    console.log(`[Client] Bloom threshold now ${bloomThreshold} (${data.gardeners} gardeners)`)
    // Re-evaluate banner/countdown state — a join can push health below the new
    // threshold (pause) or a leave can drop the threshold below health (resume).
    updateProgressText()
  })

  room.onMessage('bloomTriggered', (data) => {
    currentBloomScale = typeof data?.scale === 'number' && data.scale > 0 ? Math.min(data.scale, 1) : 1
    currentBloomVariant = data?.variant || 'classic'
    const variant = bloomVariantById(currentBloomVariant)
    if (!isBloomActive() && variant.id !== 'classic') {
      showToast(`${withArticle(variant.name, true)}! Rare seeds fall thicker tonight`, 6_000, false)
    }
    // The rare variant changes the light itself — also on a late joiner's re-send
    if (variant.id === 'moonlit') startMoonlight()
    // Phase 6b: the variant's palette on every pooled bloom FX, before any of it fires
    setBloomSparklePalette(variant.palette)
    setAmbientPalette(variant.palette)
    const fxLevel = bloomFxLevel(currentBloomScale)
    const bannerLabel = variant.id !== 'classic' ? `${withArticle(variant.name, true)}!`
                      : fxLevel === 0 ? 'A quiet bloom has woken'
                      : fxLevel === 1 ? 'The Garden is blooming'
                      : 'The Garden is in Full Bloom!'
    stopWateringEmote()
    stopPreBloomTicker()   // stop immediately — prevents stale "1s" from being re-written
    resetClientSustain()   // sustain complete — bloom is firing
    showBannerBloom(bannerLabel)   // switch banner from countdown → bloom before visual effects ramp up
    for (const e of bloomCountdownLabels) TextShape.getMutable(e).text = ''  // clear countdown before reset ticker starts
    bloomDurationMs = typeof data?.durationMs === 'number' && data.durationMs > 0 ? data.durationMs : BLOOM_RESET_DELAY_MS
    startBloomResetTicker(typeof data?.elapsedMs === 'number' && data.elapsedMs > 0 ? data.elapsedMs : 0)  // countdown to garden reset, aligned for late joiners
    if (!isBloomActive()) {
      triggerBloomEvent()
      startContributorCycle([...bloomContributors])   // thank each waterer in turn
      updateSceneAssets()
    }

    // Unwatered plants used to be snapped to healthy here for the spectacle. Since 2026-09-22
    // watering during a bloom is allowed, so a dry plant keeps its droop and its drop — the
    // bloom is a layer over the garden, not a pause in it.
    console.log(`[Client] bloomTriggered: registry=${plantRegistry.size} elapsedMs=${data?.elapsedMs ?? 0}`)
  })

  room.onMessage('bloomReset', () => {
    stopPreBloomTicker()
    stopBloomResetTicker()
    preBloomEffectsActive = false
    countdownUnlocked = false   // full cycle reset — labels and banner return to idle
    resetClientSustain()
    stopContributorCycle()
    setBloomSparklePalette(bloomVariantById('classic').palette)   // back to the warm default for the next cycle
    setAmbientPalette(bloomVariantById('classic').palette)
    stopMoonlight()          // dawn breaks as the garden resets (no-op after a classic bloom)
    startBloomFlower([...bloomContributors])  // attach hand flower to contributors — must run BEFORE clear()
    bloomContributors.clear()
    resetAllPlants()         // stops bloom, resets visuals + audio via endBloom()
    updateSceneAssets()      // endBloom() cleared isBloomActive() — switch center text immediately
    startBloomCooldown()     // gradual 5-min wind-down of lights + audio
    timers.setTimeout(() => { bloomActive = false }, BLOOM_TRIGGER_COOLDOWN_MS)  // = the server's trigger hold, so no countdown shows while none can start
    startPlayerTrail()       // 10-min sparkle trail on all players after bloom
    clearBloomLabels()
    showBannerIdle()
    updateBannerHealth(computeWateredCount() / TOTAL_PLANTS)   // kept plants mean it is rarely 0 now
    hideDailyLimit()
  })

  room.onMessage('leaderboardUpdate', (data) => {
    const parse = (s: string): BoardEntry[] => { try { return JSON.parse(s) } catch { return [] } }
    updateLeaderboardDisplay({ weekly: parse(data.entriesJson), allTime: parse(data.allTimeJson), weeklyResetAt: Number(data.weeklyResetAt) })
  })

  room.onMessage('yourStanding', (data) => {
    setYourStanding({ weeklyRank: data.weeklyRank, weeklyCount: data.weeklyCount, allTimeRank: data.allTimeRank, allTimeCount: data.allTimeCount })
  })

  room.onMessage('plantStateUpdate', (data) => {
    const entity = plantNameToEntity.get(data.plantId)
    if (!entity) return
    const local = PlantData.getOrNull(entity)
    if (!local) return

    const wasWatered = local.isWatered
    const plantPos   = Transform.getOrNull(entity)?.position
    const wateredAt  = Number(data.wateredAt)   // Int64 on the wire
    if (data.isWatered && data.expiresInMs > 0) serverExpiryMs.set(data.plantId, data.expiresInMs)
    else serverExpiryMs.delete(data.plantId)

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
      wateredByTitles.set(entity, almanacTitleByRank(data.almanac))
      setLabelFlair(entity, data.tier)   // flair icon above the label (GDD §5)
      bloomContributors.add(data.wateredBy)   // tracks everyone who contributed this cycle
    } else {
      wateredByNames.delete(entity)
      setLabelFlair(entity, 0)
    }
    if (wateredByLabel) {
      const ts = TextShape.getMutable(wateredByLabel)
      if (data.isWatered && data.wateredBy) {
        ts.text      = `Last watered by ${data.wateredBy}\n${formatTimeAgo(wateredAt)}`
        ts.textColor = WATERED_BY_COLOR   // fixed — matches the flair icon, see refreshWateredByLabels
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
        PlantData.getMutable(entity).wateredAt = wateredAt
      }

      if (pending !== undefined && !pending.wasTopUp) {
        // ── Case A: our fresh water confirmed ────────────────────
        // Optimistic animations already running in waterPlant — just re-enable click,
        // and replace the guessed expiry with the server's gardener-scaled one.
        enablePlantClick(entity)
        if (data.expiresInMs > 0) scheduleExpiry(entity, local.wateredAt, data.expiresInMs)

      } else if (pending !== undefined && pending.wasTopUp) {
        // ── Case B: our top-up confirmed ─────────────────────────
        // Plant already healthy; re-enable click. Drop stays hidden (plant watered).
        // The optimistic expiry (keyed on local `now`) will self-cancel because
        // pd.wateredAt is now the server's — schedule a fresh expiry from there.
        enablePlantClick(entity)
        if (data.expiresInMs > 0) scheduleExpiry(entity, wateredAt, data.expiresInMs)

      } else if (!wasWatered) {
        // ── Case C: remote player freshly watered this plant ─────
        const isLive = (Date.now() - wateredAt) < LIVE_WATER_THRESHOLD_MS
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
          setDropFade(entity, 'out')
        }

      }
      else {
        // ── Case D: remote top-up (only possible inside the expiry tell) ─────
        // The tell drop is showing — hide it and re-arm the tell from the fresh timer.
        expiryTell.delete(entity)
        setDropFade(entity, 'out')
        if (data.expiresInMs > 0) scheduleExpiry(entity, wateredAt, data.expiresInMs)
      }

    } else {
      PlantData.getMutable(entity).isWatered = false
      PlantData.getMutable(entity).wateredAt = 0
      expiryTell.delete(entity)
      enablePlantClick(entity)

      if (wasWatered) {
        // Wilt plays during a bloom too (2026-09-22).
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
      } else if (!wasWatered) {
        // Droopy from the start (the join snapshot, or never watered this session): the drop
        // now starts hidden, so this is what makes it appear — before, a full-scale default
        // did that by accident. Drops DO show during a bloom now (2026-09-22: watering during
        // bloom is allowed — this reverses the same-day "no drops when I loaded in" call).
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
      Transform.create(clickBox, { position: { x: 0, y: CLICKBOX_Y, z: 0 }, scale: CLICKBOX_SCALE, parent: info.anchor })
      MeshCollider.setBox(clickBox, ColliderLayer.CL_POINTER)
      info.clickTarget    = clickBox
      info.clickboxEntity = clickBox
    } else {
      if (info.clickboxEntity) engine.removeEntity(info.clickboxEntity)
      info.clickboxEntity = null
      info.clickTarget    = plantEntity
    }
    // mesh is only a pointer target when it IS the click target
    if (GltfContainer.has(plantEntity)) {
      GltfContainer.getMutable(plantEntity).visibleMeshesCollisionMask =
        val ? ColliderLayer.CL_PHYSICS : ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER
    }
    enablePlantClick(plantEntity)
  }
  if (val) resizeClickboxes()
}

export function getUseClickbox(): boolean { return useClickbox }

export function getWateringStatus() {
  return {
    wateredCount: computeWateredCount(),
    totalPlants:  TOTAL_PLANTS,
    waterRemaining,
    dailyWaterLimit,
    overrideDailyLimit,
    runtimeTestMode,
  }
}

/** Test panel: +amount lifetime waters through the server's real flair / tribute path. */
export function adminGrantWaters(amount: number): void {
  if (room.isReady()) room.send('adminGrantWaters', { amount })
}

/** @param variant '' = normal roll; a BLOOM_VARIANTS id forces it at full scale (test panel) */
/** Test-panel stop-bloom / reset button — cancels a stuck sustain hold or ends an
 *  active bloom, whichever applies. Server-side; no-op if nothing is active. */
export function forceResetBloom(): void {
  if (room.isReady()) room.send('adminResetBloom', {})
}

export function forceTriggerBloom(variant = ''): void {
  // Both guards below used to fail in TOTAL SILENCE — the button did nothing and said
  // nothing, which is exactly what KJ hit on the deployed world (2026-09-20).
  if (isBloomActive()) {
    console.log('[TestPanel] Force bloom ignored — this client already thinks a bloom is active')
    showToast('Force bloom: a bloom is already running here', 4000, false)
    return
  }
  if (room.isReady()) {
    room.send('forceBloom', { variant })
  } else {
    console.log('[TestPanel] Force bloom: room not ready — falling back to a LOCAL-only bloom')
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
