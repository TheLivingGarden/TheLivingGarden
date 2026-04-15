// =============================================================
// The Living Garden — Sitting System
//
// Problem: DCL catalog smart-item sit spots use a tiny
// `sitting_pose_collider.glb` hitbox.  The player must be
// standing precisely on it for E to register — hence repeated
// presses.
//
// Fix: register our own pointerEventsSystem.onPointerDown with
// InputAction.IA_PRIMARY directly on the seat entity.  In SDK7
// each entity has exactly ONE handler per input action, so ours
// replaces the catalog item's handler.  We also slap a full-size
// box collider on the mesh so there is nothing precise to aim at.
//
// NOTE: InputModifier is intentionally NOT used — it blocks the
// emote from playing (see feedback_dcl_emote_quirks memory).
// =============================================================

import {
  engine,
  Entity,
  Transform,
  MeshCollider,
  ColliderLayer,
  pointerEventsSystem,
  InputAction,
  AvatarEmoteCommand,
  timers,
} from '@dcl/sdk/ecs'
import { movePlayerTo } from '~system/RestrictedActions'

// ---------------------------------------------------------------
// Config  (tweak at the top — no magic numbers below)
// ---------------------------------------------------------------

/** ms after movePlayerTo before firing the emote (teleport needs to settle). */
const SIT_EMOTE_DELAY_MS = 400
/** ms after first emote call to fire a second time (handles first-call drop). */
const SIT_EMOTE_RETRY_MS = 350
/** Pointer-event interaction distance in metres — generous so E works easily. */
const SIT_INTERACT_DIST  = 6
/** How far (metres, XZ plane) the player must walk before auto-standing. */
const SIT_STAND_DIST     = 2.0
/** Hover label shown when player is in range. */
const SIT_HOVER_TEXT     = 'Sit'
/** Built-in DCL emote IDs — randomly chosen each sit. */
const SIT_EMOTES         = ['sittingChair1', 'sittingChair2'] as const

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

export interface SeatConfig {
  /** Entity name exactly as it appears in Creator Hub / entity-names.ts. */
  name:      string
  /** World-space offset added to the entity's Transform.position for the
   *  sit position.  Defaults to { x:0, y:0.3, z:0 } (slightly above pivot). */
  sitOffset?: { x: number; y: number; z: number }
}

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------

/** Entity the local player is currently sitting on, or null. */
let currentSeat:     Entity | null = null
let standSysAdded                  = false

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Register one or more seat entities and wire up reliable E-key
 * interactions.  Call once from main() after the scene is ready.
 *
 * Example:
 *   setupSittingSystem([
 *     { name: 'Beanbag',        sitOffset: { x: 0, y: 0.3, z: 0 } },
 *     { name: 'Bench_North_1'                                       },
 *   ])
 */
export function setupSittingSystem(seats: SeatConfig[]): void {
  for (const { name, sitOffset } of seats) {
    const entity = engine.getEntityOrNullByName(name)
    if (!entity) {
      console.error(`[SittingSystem] Entity not found: "${name}" — skipped`)
      continue
    }

    const offset = sitOffset ?? { x: 0, y: 0.3, z: 0 }

    // Replace catalog item's tiny collider with a full-size box so the
    // player doesn't need to aim precisely at an invisible hitbox.
    MeshCollider.setBox(entity, ColliderLayer.CL_POINTER)

    // Register E-key handler — replaces catalog smart-item handler.
    pointerEventsSystem.onPointerDown(
      {
        entity,
        opts: {
          button:    InputAction.IA_PRIMARY,
          hoverText: SIT_HOVER_TEXT,
          maxDistance: SIT_INTERACT_DIST,
        },
      },
      () => onSeatPressed(entity, offset),
    )

    console.log(`[SittingSystem] Registered seat: "${name}"`)
  }

  if (!standSysAdded) {
    engine.addSystem(standUpSystem)
    standSysAdded = true
  }
}

// ---------------------------------------------------------------
// Internal
// ---------------------------------------------------------------

function onSeatPressed(
  entity: Entity,
  offset: { x: number; y: number; z: number },
): void {
  if (currentSeat) return   // already sitting somewhere

  const t = Transform.getOrNull(entity)
  if (!t) return

  currentSeat = entity

  const pos = {
    x: t.position.x + offset.x,
    y: t.position.y + offset.y,
    z: t.position.z + offset.z,
  }

  movePlayerTo({
    newRelativePosition: pos,
    cameraTarget: { x: pos.x, y: pos.y + 0.5, z: pos.z + 1 },
  })

  const emote = SIT_EMOTES[Math.floor(Math.random() * SIT_EMOTES.length)]

  // Fire emote once the teleport has settled, then fire again after a short
  // delay to handle the DCL first-call timing drop.
  timers.setTimeout(() => {
    AvatarEmoteCommand.addValue(engine.PlayerEntity, {
      emoteUrn:  emote,
      loop:      true,
      timestamp: Date.now(),
    })
    timers.setTimeout(() => {
      if (currentSeat === entity) {   // still sitting here
        AvatarEmoteCommand.addValue(engine.PlayerEntity, {
          emoteUrn:  emote,
          loop:      true,
          timestamp: Date.now(),
        })
      }
    }, SIT_EMOTE_RETRY_MS)
  }, SIT_EMOTE_DELAY_MS)
}

/** ECS system — runs every frame, frees the seat when the player walks away. */
function standUpSystem(): void {
  if (!currentSeat) return

  const playerPos = Transform.getOrNull(engine.PlayerEntity)?.position
  const seatPos   = Transform.getOrNull(currentSeat)?.position
  if (!playerPos || !seatPos) return

  const dx   = playerPos.x - seatPos.x
  const dz   = playerPos.z - seatPos.z
  const dist = Math.sqrt(dx * dx + dz * dz)

  if (dist > SIT_STAND_DIST) {
    currentSeat = null
    // Cancel the looping sit by overwriting with a brief non-looping emote,
    // which returns the avatar to idle.
    AvatarEmoteCommand.addValue(engine.PlayerEntity, {
      emoteUrn:  'wave',
      loop:      false,
      timestamp: Date.now(),
    })
  }
}
