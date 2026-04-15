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

/** Delay before starting the Animator — lets the GLB finish loading (ms). */
const ANIM_INIT_DELAY_MS = 1_200

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
let flowerParentEnt: Entity | null = null
let flowerChildEnt:  Entity | null = null

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

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

  // Deferred Animator — play the healthy idle loop once the GLB has loaded
  timers.setTimeout(() => {
    if (flowerGen !== gen) return
    Animator.createOrReplace(child, {
      states: [
        { clip: ANIM_HEALTHY, playing: true, loop: true },
      ],
    })
    Animator.playSingleAnimation(child, ANIM_HEALTHY, true)
  }, ANIM_INIT_DELAY_MS)

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
export function stopBloomFlower(): void {
  flowerGen++
  if (flowerParentEnt !== null) {
    engine.removeEntity(flowerParentEnt)
    flowerParentEnt = null
  }
  if (flowerChildEnt !== null) {
    engine.removeEntity(flowerChildEnt)
    flowerChildEnt = null
  }
}
