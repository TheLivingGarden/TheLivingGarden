// =============================================================
// The Living Garden — Bloom Contributor Flower
//
// After the bloom event closes, any player who watered at least
// one plant that contributed to that bloom gets a miniature
// healthy plant attached to their right hand for FLOWER_DURATION_MS.
//
// Only shown to the contributor themselves (no avatarId means each
// client renders the entity on its own avatar — correct behaviour
// since we create the entity only for contributing players).
//
// Architecture:
//   Parent entity — AvatarAttach (AAPT_RIGHT_HAND). Its Transform
//                   is overwritten each frame by DCL.
//   Child entity  — GltfContainer (demoPlant.glb) with offset +
//                   scale + rotation relative to the parent.
//
// Public API:
//   startBloomFlower(contributorNames) — attach if local player contributed
//   stopBloomFlower()                  — remove immediately (also called internally on restart)
// =============================================================

import {
  engine,
  Entity,
  GltfContainer,
  GltfContainerLoadingState,
  Transform,
  Animator,
  ColliderLayer,
  AvatarAttach,
  AvatarAnchorPointType,
  timers,
} from '@dcl/sdk/ecs'
import { Quaternion } from '@dcl/sdk/math'
import { getPlayer } from '@dcl/sdk/players'

// ---------------------------------------------------------------
// Config
// ---------------------------------------------------------------

/** Duration the flower remains attached after the bloom closes (ms).
 *  Matches TRAIL_DURATION_MS so trail and flower disappear together. */
const FLOWER_DURATION_MS = 10 * 60_000

/** GLB source — the same healthy plant used in the garden. */
const DEMO_PLANT_SRC = 'assets/scene/Models/demoPlant/demoPlant.glb'

/** Healthy-state animation clip name (matches scene plants). */
const ANIM_HEALTHY = 'OpenIdle'

// LoadingState values (const enum in @dcl/ecs internals, not re-exported — same as boxSystem)
const LS_NOT_FOUND = 2, LS_FINISHED_WITH_ERROR = 3, LS_FINISHED = 4

/** Scale of the plant relative to the hand anchor (1 = full scene size). */
const FLOWER_SCALE = { x: 0.18, y: 0.18, z: 0.18 }

/** Position offset from the right-hand anchor point (metres).
 *  Positive Y lifts it above the palm; Z pushes it forward along the hand. */
const FLOWER_OFFSET = { x: 0, y: 0.06, z: 0 }

/** Rotation offset — corrects for the GLB's default up-axis orientation. */
const FLOWER_ROTATION = Quaternion.fromEulerDegrees(90, 0, 0)

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------

let flowerGen       = 0
let flowerActive    = false   // the contributor holds the rose (even while the can hides it)
let flowerParentEnt: Entity | null = null
let flowerChildEnt:  Entity | null = null
let flowerAnimPending = false   // start the idle loop once the child GLB reports loaded
let systemAdded       = false

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/** Create the hand entities. Separate from startBloomFlower so the hand arbiter can remove and
 *  rebuild them: a rose hidden by scale was still showing next to the can (KJ 2026-09-24). */
function buildFlower(): void {
  // ── Parent: AvatarAttach anchor (transform gets overwritten by DCL) ──
  const parent = engine.addEntity()
  AvatarAttach.create(parent, {
    anchorPointId: AvatarAnchorPointType.AAPT_RIGHT_HAND,
  })
  flowerParentEnt = parent

  // ── Child: the GLB with offset, scale, rotation relative to parent ──
  const child = engine.addEntity()
  Transform.create(child, {
    position: FLOWER_OFFSET,
    scale:    FLOWER_SCALE,
    rotation: FLOWER_ROTATION,
    parent:   parent,
  })
  GltfContainer.create(child, {
    src: DEMO_PLANT_SRC,
    // Disable collision on the hand-held plant so it doesn't interfere
    // with the player's physics or the scene's collision layers.
    invisibleMeshesCollisionMask: ColliderLayer.CL_NONE,
    visibleMeshesCollisionMask:   ColliderLayer.CL_NONE,
  })
  flowerChildEnt = child

  // Healthy idle loop once the GLB reports loaded (was a 1.2 s guess)
  flowerAnimPending = true
  if (!systemAdded) { systemAdded = true; engine.addSystem(flowerAnimInitSystem) }
}

function removeFlowerEntities(): void {
  flowerAnimPending = false
  if (flowerParentEnt !== null) { engine.removeEntity(flowerParentEnt); flowerParentEnt = null }
  if (flowerChildEnt !== null)  { engine.removeEntity(flowerChildEnt);  flowerChildEnt = null }
}

/**
 * Attach a miniature healthy plant to the local player's right hand
 * if their display name appears in `contributorNames`.
 *
 * Pass the contributor set as an array BEFORE clearing it on bloomReset
 * (same call-site pattern as `startContributorCycle`).
 *
 * Safe to call multiple times — bumps the gen to cancel any previous
 * auto-stop timer and removes any previously attached flower first.
 */
export function startBloomFlower(contributorNames: string[]): void {
  stopBloomFlower()   // clean up any flower from a previous bloom cycle

  const lp        = getPlayer()
  const localName = lp?.name    ?? ''
  const localId   = lp?.userId  ?? ''

  // Match against both display name and userId for robustness
  const isContributor = (localName && contributorNames.includes(localName))
                     || (localId   && contributorNames.includes(localId))

  if (!isContributor) return

  const gen = ++flowerGen
  flowerActive = true
  buildFlower()

  // Auto-remove after FLOWER_DURATION_MS
  timers.setTimeout(() => {
    if (flowerGen === gen) stopBloomFlower()
  }, FLOWER_DURATION_MS)

  console.log(`[BloomFlower] Attached to right hand for ${localName || localId}`)
}

/**
 * Remove the attached flower immediately.
 * Any in-progress auto-stop timer is invalidated via the gen-counter.
 */
/** True while the contributor's hand-flower is attached (giftSystem hides the held keepsake then). */
export function isBloomFlowerActive(): boolean { return flowerActive }

function flowerAnimInitSystem(): void {
  if (!flowerAnimPending || flowerChildEnt === null) return
  const st = GltfContainerLoadingState.getOrNull(flowerChildEnt)?.currentState
  if (st === LS_NOT_FOUND || st === LS_FINISHED_WITH_ERROR) { flowerAnimPending = false; return }
  if (st !== LS_FINISHED) return
  flowerAnimPending = false
  Animator.createOrReplace(flowerChildEnt, { states: [{ clip: ANIM_HEALTHY, playing: true, loop: true }] })
}

/** Show/hide the contributor rose (the hand arbiter in giftSystem: one item per hand). Hiding
 *  REMOVES its entities and showing rebuilds them; the rose's timer and gen are untouched. */
export function setBloomFlowerVisible(visible: boolean): void {
  if (!flowerActive) return
  if (visible && flowerParentEnt === null) buildFlower()
  else if (!visible && flowerParentEnt !== null) removeFlowerEntities()
}

export function stopBloomFlower(): void {
  flowerGen++
  flowerActive = false
  removeFlowerEntities()
}
