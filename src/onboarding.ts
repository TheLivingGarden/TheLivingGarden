// =============================================================
// Bloom Garden v2 — Onboarding (CLIENT ONLY)
//
// Two stages, in the order the game actually allows:
//   1. WATER  — taught at spawn. The only verb available immediately.
//   2. PLANT  — sleeps until the player is actually holding a seed (seeds only
//               fall from blooms), then points at a planter held for them and
//               wears KJ's toon shell over it.
//
// Both stages draw the same thing: a row of chevrons running from the target
// back toward the player, with a pulse travelling along it. The direction is
// carried by MOTION, not by more geometry — 4 × 20 tris for the whole trail.
// The bob is driven from this system's own tick, never a looping Tween (the
// explorer writes every actively-tweened Transform back into the scene every
// frame — that is what tanked scene tick fps in the 09-18 perf pass).
//
// Which stage is live is the SERVER's call, via onboardingState { watered,
// planted } — persisted per wallet, sent on join and after each first.
//
// The gold shell highlight is DIFFERENT from the rest: it runs ALWAYS, independent of
// `stage`, on every planter the player owns (boxSystem's myPlanters) — a returning
// player who finished the tutorial ages ago still can't spot their own planter among 50+
// look-alikes otherwise (KJ 2026-09-22). Onboarding-only extras (the reserved planter
// while learning to plant, the empty Avenue slot while learning the Avenue) are layered
// onto that same always-on list rather than fighting it for the shell pool.
//
// ⚠️ Registered from index.ts AFTER setupWateringSystem(), which calls
// room.clear() — a handler registered before that clear is silently wiped.
// =============================================================

import { engine, Transform, GltfContainer, VisibilityComponent, ColliderLayer, Entity, MeshRenderer, Material, MaterialTransparencyMode } from '@dcl/sdk/ecs'
import { Quaternion, Vector3, Color4 } from '@dcl/sdk/math'
import { room } from './shared/messages'
import { PlantData } from './wateringSystem'
import { isBloomActive } from './bloomSystem'
import { nearestFreePlanter, freePlanterPos, myOpenedPlanter, myOpenedPlanters, myPlanters, myGrowingStatus, myPlanterCount } from './boxSystem'
import { getSeedCount } from './seedSystem'
import { nearestFreeAvenueSlot } from './avenueSystem'
import { getFlowers, gardenersHere, setPouchHint, registerPouchOpened, getAvenueSlotsFree, getArmedAvenueFlower, getPouch, getBoxCap } from './playerInventory'
import { showPersistent, hidePersistent, showToast } from './notifications'
import {
  ARROW_MODEL_SRC, ARROW_SCALE, ARROW_FORWARD_YAW, ARROW_STANDOFF, ARROW_GROUND_LIFT,
  ARROW_BOB_AMPLITUDE, ARROW_BOB_PERIOD_MS,
  ARROW_CHEVRON_MAX, ARROW_CHEVRON_SPACING, ARROW_WAVE_SPEED, ARROW_WAVE_LENGTH,
  BEACON_HEIGHT, BEACON_RADIUS, BEACON_COLOR, BEACON_ALPHA, BEACON_INTENSITY,
  TOON_HIGHLIGHT_SRC, TOON_HIGHLIGHT_SCALE,
  ONBOARDING_REPICK_S, ONBOARDING_MAX_RANGE,
  ONBOARDING_WATER_HINT, ONBOARDING_PLANT_HINT, ONBOARDING_HARVEST_HINT, ONBOARDING_GIFT_HINT,
  ONBOARDING_POUCH_HINT, ONBOARDING_AVENUE_HINT, ONBOARDING_BLOOM_HINT, ONBOARDING_SEEDS_FALLING_HINT,
  ONBOARDING_SEED_TOAST, ONBOARDING_SEED_TOAST_MS,
  ONBOARDING_LOOP_TOAST, ONBOARDING_LOOP_TOAST_MS,
  ONBOARDING_HARVEST_TOAST, ONBOARDING_HARVEST_TOAST_MS,
  PLANTER_RESERVE_RETRY_S, AVENUE_MIN_TIER, AVENUE_ARROW_STANDOFF,
} from './shared/config'

type Stage = 'none' | 'water' | 'bloom' | 'plant' | 'pouch' | 'harvest' | 'gift' | 'avenue'

// All four assume DONE until the server says otherwise, so a dropped message never
// nags a veteran with a tutorial they finished long ago.
let watered     = true
let planted     = true
let harvested   = true
let gifted      = true
let pouchOpened = true
let avenueUsed  = true
let hasSeeds = false
let stage: Stage = 'none'
let seedToastShown = false

let chevrons: Entity[] = []
// Shells and beacons are POOLS, not singletons: a gardener at the planter cap can have
// more than one flower standing open and wants every one of them marked, not just the
// nearest (Fin 2026-09-21). The plant stage still only ever marks the one held for them.
let shells:  Entity[] = []
let beacons: Entity[] = []
let beaconTargets: Vector3[] = []

let target: Vector3 | null = null   // what the trail points at
let heldBoxId = ''                  // planter the server is holding for us ('' = none)
let repickIn = 0
let retryIn  = 0
let elapsed  = 0
let shellAccum = 0                  // the always-on highlight's own repick clock

// ── Entities ──────────────────────────────────────────────────

function ensureChevrons(): Entity[] {
  if (chevrons.length === 0) {
    for (let i = 0; i < ARROW_CHEVRON_MAX; i++) {
      const e = engine.addEntity()
      Transform.create(e, { scale: Vector3.create(ARROW_SCALE, ARROW_SCALE, ARROW_SCALE) })
      // No colliders: a decal on the ground must not swallow a tap meant for a plant.
      GltfContainer.create(e, {
        src: ARROW_MODEL_SRC,
        visibleMeshesCollisionMask: ColliderLayer.CL_NONE,
        invisibleMeshesCollisionMask: ColliderLayer.CL_NONE,
      })
      VisibilityComponent.create(e, { visible: false })
      chevrons.push(e)
    }
  }
  return chevrons
}

function ensureShells(n: number): Entity[] {
  while (shells.length < n) {
    const e = engine.addEntity()
    Transform.create(e, { scale: Vector3.create(TOON_HIGHLIGHT_SCALE, TOON_HIGHLIGHT_SCALE, TOON_HIGHLIGHT_SCALE) })
    GltfContainer.create(e, {
      src: TOON_HIGHLIGHT_SRC,
      visibleMeshesCollisionMask: ColliderLayer.CL_NONE,
      invisibleMeshesCollisionMask: ColliderLayer.CL_NONE,
    })
    VisibilityComponent.create(e, { visible: false })
    shells.push(e)
  }
  return shells
}

/** A column of light standing on the current target, tall enough to clear the planting
 *  and read from the far side of the garden. Created on first use; only ever moved. */
function ensureBeacons(n: number): Entity[] {
  while (beacons.length < n) {
    const e = engine.addEntity()
    Transform.create(e)
    MeshRenderer.setCylinder(e, BEACON_RADIUS, BEACON_RADIUS)
    Material.setPbrMaterial(e, {
      albedoColor:       Color4.create(BEACON_COLOR.r, BEACON_COLOR.g, BEACON_COLOR.b, BEACON_ALPHA),
      emissiveColor:     BEACON_COLOR,
      emissiveIntensity: BEACON_INTENSITY,
      transparencyMode:  MaterialTransparencyMode.MTM_ALPHA_BLEND,
      castShadows:       false,
    })
    VisibilityComponent.create(e, { visible: false })
    beacons.push(e)
  }
  return beacons
}

/** Stand a column of light on each target. Created on first use; only ever moved. */
function beaconsOn(targets: ReadonlyArray<Vector3>): void {
  const pool = ensureBeacons(targets.length)
  for (let i = 0; i < pool.length; i++) {
    const on = i < targets.length
    VisibilityComponent.getMutable(pool[i]).visible = on
    if (!on) continue
    // The primitive cylinder is one unit tall, centred on its origin.
    const t = Transform.getMutable(pool[i])
    t.position = Vector3.create(targets[i].x, targets[i].y + BEACON_HEIGHT / 2, targets[i].z)
    t.scale    = Vector3.create(1, BEACON_HEIGHT, 1)
  }
}

function showBeacons(visible: boolean): void {
  for (const e of beacons) VisibilityComponent.getMutable(e).visible = visible
}

function showChevrons(visible: boolean): void {
  for (const e of chevrons) VisibilityComponent.getMutable(e).visible = visible
}

/** Wear the gold shell on these planters — the one you should plant in, or EVERY one of
 *  yours holding an opened flower. KJ 2026-09-20: the arrows point, but the highlight is
 *  what actually makes a planter findable among ninety-six of them. */
function shellsOnPlanters(ps: ReadonlyArray<{ x: number; z: number; rot: number }>): void {
  const pool = ensureShells(ps.length)
  for (let i = 0; i < pool.length; i++) {
    const on = i < ps.length
    VisibilityComponent.getMutable(pool[i]).visible = on
    if (!on) continue
    const t = Transform.getMutable(pool[i])
    t.position = Vector3.create(ps[i].x, 0, ps[i].z)
    t.rotation = Quaternion.fromEulerDegrees(0, ps[i].rot, 0)
  }
}

function clearVisuals(): void {
  // Shells are NOT cleared here — they're always-on now, independent of stage (see the
  // module header). Clearing them on every stage transition would fight the always-on
  // updater and flicker.
  showChevrons(false)
  showBeacons(false)
  beaconTargets = []
  hidePersistent()
}

// ── Targets ───────────────────────────────────────────────────

/** Nearest plant that still needs water, as a COPY — the live Transform position
 *  keeps changing underneath us. */
function nearestDroopyPlant(from: Vector3): Vector3 | null {
  let best: Vector3 | null = null
  let bestSq = ONBOARDING_MAX_RANGE * ONBOARDING_MAX_RANGE
  for (const [entity, plant] of engine.getEntitiesWith(PlantData)) {
    if (plant.isWatered) continue
    const p = Transform.getOrNull(entity)?.position
    if (!p) continue
    const dx = p.x - from.x
    const dz = p.z - from.z
    const sq = dx * dx + dz * dz
    if (sq < bestSq) { bestSq = sq; best = Vector3.create(p.x, p.y, p.z) }
  }
  return best
}

/** Keep a planter held for us, and return where it stands. Asks again when we have
 *  none, or when the one we held was taken/deleted in the meantime. */
function heldPlanter(from: Vector3, dt: number): Vector3 | null {
  retryIn -= dt
  if (heldBoxId) {
    const p = freePlanterPos(heldBoxId)
    if (p) return Vector3.create(p.x, 0, p.z)
    heldBoxId = ''            // someone planted in it — ask for another
  }
  if (retryIn <= 0) {
    retryIn = PLANTER_RESERVE_RETRY_S
    const candidate = nearestFreePlanter(from)
    if (candidate) room.send('reserveBox', { boxId: candidate.boxId })
  }
  return null
}

// ── Avenue slot marker ───────────────────────────────────────
//
// A single arrow (KJ 2026-09-22: "wrong model" on the shell — "smartly reuse our arrow
// model" instead), standing a short distance out from the empty slot and pointing back
// at it — the same standoff-and-point-back geometry avenueSystem.ts's plaques use, just
// with the tutorial arrow model instead of a sign.

let avenueArrow: Entity | null = null

function ensureAvenueArrow(): Entity {
  if (avenueArrow === null) {
    avenueArrow = engine.addEntity()
    Transform.create(avenueArrow, { scale: Vector3.create(ARROW_SCALE, ARROW_SCALE, ARROW_SCALE) })
    GltfContainer.create(avenueArrow, {
      src: ARROW_MODEL_SRC,
      visibleMeshesCollisionMask: ColliderLayer.CL_NONE,
      invisibleMeshesCollisionMask: ColliderLayer.CL_NONE,
    })
    VisibilityComponent.create(avenueArrow, { visible: false })
  }
  return avenueArrow
}

function showAvenueArrow(slot: { x: number; y: number; z: number; rot: number } | null): void {
  const e = ensureAvenueArrow()
  VisibilityComponent.getMutable(e).visible = !!slot
  if (!slot) return
  const r = (slot.rot * Math.PI) / 180
  const t = Transform.getMutable(e)
  t.position = Vector3.create(slot.x + AVENUE_ARROW_STANDOFF * Math.sin(r), slot.y, slot.z + AVENUE_ARROW_STANDOFF * Math.cos(r))
  t.rotation = Quaternion.fromEulerDegrees(0, (slot.rot + 180) % 360 + ARROW_FORWARD_YAW, 0)
}

// ── The trail ─────────────────────────────────────────────────

/** Lay the chevrons from `to` all the way back to the player's feet, every one aimed at
 *  `to`, with a pulse running along the row so the eye is pulled toward the target. The
 *  row spans the WHOLE distance: up to ARROW_CHEVRON_MAX chevrons at the nominal
 *  spacing, and beyond that the gaps stretch rather than the trail stopping short. */
function drawTrail(player: Vector3, to: Vector3): void {
  const row = ensureChevrons()
  let dx = player.x - to.x
  let dz = player.z - to.z
  const len = Math.sqrt(dx * dx + dz * dz)
  if (len > 0.001) { dx /= len; dz /= len } else { dx = 0; dz = 1 }
  const yaw = Math.atan2(-dx, -dz) * 180 / Math.PI + ARROW_FORWARD_YAW
  const rotation = Quaternion.fromEulerDegrees(0, yaw, 0)

  // From the standoff out to the player's feet, never past them: standing on the target
  // leaves a single chevron at the standoff.
  const span    = Math.max(0, len - ARROW_STANDOFF)
  const count   = Math.max(1, Math.min(ARROW_CHEVRON_MAX, Math.round(span / ARROW_CHEVRON_SPACING) + 1))
  const spacing = count > 1 ? span / (count - 1) : 0

  for (let i = 0; i < row.length; i++) {
    const visible = i < count
    VisibilityComponent.getMutable(row[i]).visible = visible
    if (!visible) continue
    const out = ARROW_STANDOFF + spacing * i
    // Fixed metres/second toward `to`, so the ripple reads the same on a 4 m trail and a
    // 40 m one. Subtracting `out` makes it travel down the row toward the target.
    const phase = (elapsed * ARROW_WAVE_SPEED - out) / ARROW_WAVE_LENGTH
    const bob   = (Math.sin(phase * Math.PI * 2) + 1) * 0.5 * ARROW_BOB_AMPLITUDE
    const t = Transform.getMutable(row[i])
    t.position = Vector3.create(to.x + dx * out, to.y + ARROW_GROUND_LIFT + bob, to.z + dz * out)
    t.rotation = rotation
  }
}

// ── Stage selection ───────────────────────────────────────────

function currentStage(): Stage {
  if (!watered) return 'water'
  // First water done, no seed yet: the seed comes from the bloom their watering earns (KJ
  // 2026-09-22 playtest 2). Hint only — the ring already shows how far the garden is.
  if (!planted && !hasSeeds) return 'bloom'
  if (!planted && hasSeeds) return 'plant'
  // Straight after the first planting: Fin 2026-09-21 never noticed the pouch existed, so
  // the seeds and the whole flower collection behind it were invisible. No trail - the
  // target is a HUD chip, not a place; the UI pulses it while this stage is live.
  if (planted && !pouchOpened) return 'pouch'
  // Only once their own flower is actually standing open in a planter.
  if (!harvested && myOpenedPlanter({ x: 0, z: 0 }) !== null) return 'harvest'
  // Gifting needs someone to give TO — never nag a player gardening alone.
  if (harvested && !gifted && getFlowers().length > 0 && gardenersHere().length > 0) return 'gift'
  // Lowest priority — a bonus once the core loop is already known. Only fires when it's
  // actually actionable: a slot free AND something in My Flowers good enough for it.
  if (!avenueUsed && getAvenueSlotsFree() > 0 && getFlowers().some(f => f.rarityTier >= AVENUE_MIN_TIER)) return 'avenue'
  return 'none'
}

function applyStage(): void {
  const next = currentStage()
  if (next === stage) return
  stage = next
  setPouchHint(stage === 'pouch')   // the HUD pulses the chip off this
  repickIn = 0
  retryIn  = 0
  target   = null
  clearVisuals()
  if (stage === 'plant' && !seedToastShown) {
    seedToastShown = true
    showToast(ONBOARDING_SEED_TOAST, ONBOARDING_SEED_TOAST_MS)
  }
  console.log(`[Onboarding] stage → ${stage}`)
}

// ── System ────────────────────────────────────────────────────

// ── Idle guide ────────────────────────────────────────────────
// Playtest 2026-09-24: "it isn't clear what to do in the meantime". The stages above end
// once you have done each thing once; after that the pill went blank. This keeps ONE line
// on screen saying the next useful thing, in priority order. Re-asserted about once a
// second because the watering system hides the shared pill on bloom start/reset.
const IDLE_GUIDE_EVERY_S = 1
let idleAccum = 0

function idleGuide(dt: number, player: { x: number; z: number } | undefined): void {
  idleAccum -= dt
  if (idleAccum > 0) return
  idleAccum = IDLE_GUIDE_EVERY_S
  if (!player) return
  const seeds = getPouch().reduce((a, n) => a + n, 0)
  const growing = myGrowingStatus()
  if (getSeedCount() > 0) {
    showPersistent('The Bloom is dropping seeds - walk into them to catch them')
  } else if (seeds > 0 && myPlanterCount() < getBoxCap() && nearestFreePlanter(player)) {
    showPersistent(`You have ${seeds} seed${seeds === 1 ? '' : 's'} - tap a free planter to plant one`)
  } else if (growing.count > 0) {
    const s = Math.ceil(growing.nextMs / 1000)
    const when = s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
    showPersistent(`Your seed opens in ${when} - water plants, or help a neighbour's seedling`)
  } else if (myOpenedPlanters(player).length > 0) {
    hidePersistent()   // a flower is ready: the balloon and the gold planter already say so
  } else {
    showPersistent('Water plants to wake the Bloom - it rains seeds when it blooms')
  }
}

function onboardingSystem(dt: number): void {
  elapsed += dt
  const player = Transform.getOrNull(engine.PlayerEntity)?.position

  // ── Always-on shell highlight — runs regardless of `stage`, including 'none' (a
  // veteran with nothing left to learn), which is the whole point (see module header). ──
  shellAccum -= dt
  if (player && shellAccum <= 0) {
    shellAccum = ONBOARDING_REPICK_S
    const wanted: Array<{ x: number; z: number; rot: number }> = myPlanters(player)
    if (stage === 'plant' && heldBoxId) {
      const p = freePlanterPos(heldBoxId)
      if (p) wanted.push({ x: p.x, z: p.z, rot: p.rot })
    }
    shellsOnPlanters(wanted)
    // The Avenue slot gets its OWN marker, not the shell pool: shellsOnPlanters always
    // plants its pool at ground level (y=0), which is already wrong for a wall cube at
    // one of three different heights — and KJ 2026-09-22 also flagged the shell model
    // itself as the wrong fit for a wall slot. An arrow (see ensureAvenueArrow) fixes both.
    // Also while a flower is armed from the menu — the marker is then "a free spot", not
    // a tutorial step, so it shows for veterans mid-placement too.
    showAvenueArrow(stage === 'avenue' || getArmedAvenueFlower() !== null ? nearestFreeAvenueSlot(player) : null)
  }

  if (stage === 'none') { idleGuide(dt, player); return }

  // (Watering during a bloom is allowed since 2026-09-22, so the water stage no longer
  // pauses for one — plants droop and carry drops under the spectacle too.)

  if (!player) return

  if (stage === 'gift' || stage === 'pouch' || stage === 'bloom') {
    // No trail: gift's target is another player, who moves; pouch's is a HUD chip; bloom's
    // is the whole garden. The line (plus, for pouch, the chip's own pulse) is the lesson.
    showChevrons(false)
    showBeacons(false)
    showPersistent(stage === 'pouch' ? ONBOARDING_POUCH_HINT
                 : stage === 'gift'  ? ONBOARDING_GIFT_HINT
                 : isBloomActive()   ? ONBOARDING_SEEDS_FALLING_HINT : ONBOARDING_BLOOM_HINT)
    return
  }

  if (stage === 'avenue') {
    // No trail: the Avenue sits right where the garden starts, so a new player doesn't
    // need walking to it — the shell (always-on block, above) is the whole lesson.
    showChevrons(false)
    showBeacons(false)
    showPersistent(ONBOARDING_AVENUE_HINT)
    return
  }

  repickIn -= dt
  if (stage === 'water') {
    if (repickIn <= 0) {
      repickIn = ONBOARDING_REPICK_S
      target = nearestDroopyPlant(player)
      beaconTargets = target ? [target] : []
    }
  } else if (stage === 'harvest') {
    if (repickIn <= 0) {
      repickIn = ONBOARDING_REPICK_S
      // EVERY flower of theirs that is standing open gets a beacon; the trail walks them
      // to the nearest, because they can only go to one at a time. (The shell is handled
      // by the always-on block above — myPlanters already covers every opened one.)
      const mine = myOpenedPlanters(player)
      beaconTargets = mine.map(b => Vector3.create(b.x, 0, b.z))
      target = mine.length > 0 ? Vector3.create(mine[0].x, 0, mine[0].z) : null
    }
  } else {
    target = heldPlanter(player, dt)
    beaconTargets = target ? [target] : []
  }

  if (!target) { showChevrons(false); showBeacons(false); hidePersistent(); return }
  drawTrail(player, target)
  beaconsOn(beaconTargets)

  // Re-assert every tick: the persistent pill is shared, and a bloom start or a garden
  // reset calls hidePersistent() from the watering system.
  showPersistent(stage === 'water' ? ONBOARDING_WATER_HINT : stage === 'harvest' ? ONBOARDING_HARVEST_HINT : ONBOARDING_PLANT_HINT)
}

/** Registered with playerInventory, so the HUD can report the first open without
 *  importing this module. Cheap to call again: the server ignores a step that is already
 *  true, and the local flag stops the stage without waiting for the round trip. */
function markPouchOpened(): void {
  if (pouchOpened) return
  pouchOpened = true
  room.send('markPouchOpened', {})
  applyStage()
}

/** Test panel: wipe my record on the server so the whole tutorial replays. */
export function adminResetOnboarding(): void {
  room.send('adminResetOnboarding', {})
}

let watchAccum = 0
function stageWatchSystem(dt: number): void {
  watchAccum += dt
  if (watchAccum < 1) return
  watchAccum = 0
  applyStage()
}

export function setupOnboarding(): void {
  room.onMessage('onboardingState', (data) => {
    // Stage 3 is a one-off beat, not a stage: the moment their first seed goes in, point
    // them back at the verb that starts the whole loop again. Fires only on the
    // false→true transition, so it never replays on a later join.
    const justPlanted   = !planted && !!data.planted
    const justHarvested = !harvested && !!data.harvested   // same one-off beat for the first harvest
    watered     = !!data.watered
    planted     = !!data.planted
    harvested   = !!data.harvested
    gifted      = !!data.gifted
    pouchOpened = !!data.pouchOpened
    avenueUsed  = !!data.avenueUsed
    if (justPlanted) showToast(ONBOARDING_LOOP_TOAST, ONBOARDING_LOOP_TOAST_MS)
    if (justHarvested) showToast(ONBOARDING_HARVEST_TOAST, ONBOARDING_HARVEST_TOAST_MS)
    applyStage()
  })
  room.onMessage('pouchUpdate', (data) => {
    let total = 0
    try { for (const n of JSON.parse(data.countsJson) as number[]) total += n } catch { return }
    hasSeeds = total > 0
    applyStage()
  })
  room.onMessage('boxReserved', (data) => {
    heldBoxId = data.boxId
    if (heldBoxId) console.log(`[Onboarding] planter ${heldBoxId} held for this gardener`)
  })
  // A box opening or a gardener arriving can start a stage, and neither sends
  // onboardingState — so re-evaluate on a slow tick rather than only on messages.
  registerPouchOpened(markPouchOpened)
  engine.addSystem(stageWatchSystem)
  engine.addSystem(onboardingSystem)
  console.log(`[Onboarding] ready · onboardingState listeners=${room.listenerCount('onboardingState')}`)
}
