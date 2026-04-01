// =============================================================
// The Living Garden — Sitting System
// Extracted from the Large Couch smart item (asset-packs).
// Attach sitting behaviour to any named scene entity — no smart
// item runtime required.
//
// Usage (index.ts):
//   setupSittingSystem([
//     'Bench_North_1', 'Bench_North_2',
//     'Log_East',
//   ])
//
// Each entity name must already exist in the scene with a
// Transform. The system adds a pointer-event collider so the
// player can click it, then:
//   • Teleports the player to the seat position
//   • Plays a random built-in sitting emote (looping)
//   • Auto-stands the player when they walk > STAND_DIST away
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
} from '@dcl/sdk/ecs'
import { movePlayerTo } from '~system/RestrictedActions'
import { showToast } from './notifications'

// ---------------------------------------------------------------
// Config
// ---------------------------------------------------------------

/** How far (metres) the player must move from a seat before it's freed. */
const STAND_DIST = 1.8

/** Built-in DCL emote IDs — randomly selected on each sit. */
const SIT_EMOTES = ['sittingChair1', 'sittingChair2'] as const

/** ms to wait after teleport before firing the emote (lets the move settle). */
const EMOTE_DELAY_MS = 400

// ---------------------------------------------------------------
// Seat state
// ---------------------------------------------------------------

interface Seat {
  entity:      Entity
  takenByLocal: boolean   // is the LOCAL player sitting here right now?
}

const seats: Seat[] = []
let   sittingSystemRegistered = false

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Register a list of scene entity names as sit spots and hook up
 * all click / stand-up behaviour.  Call once from main().
 */
export function setupSittingSystem(seatNames: string[]): void {
  for (const name of seatNames) {
    const entity = engine.getEntityOrNullByName(name)
    if (!entity) {
      console.log(`[SittingSystem] Entity not found: "${name}" — skipped`)
      continue
    }

    const seat: Seat = { entity, takenByLocal: false }
    seats.push(seat)

    // Invisible box collider so the player can click the mesh.
    // If the scene mesh already has a pointer-collision mask you can
    // remove this line — it won't break anything either way.
    MeshCollider.setBox(entity, ColliderLayer.CL_POINTER)

    pointerEventsSystem.onPointerDown(
      { entity, opts: { button: InputAction.IA_POINTER, hoverText: 'Sit Here', maxDistance: 10 } },
      () => onSeatClicked(seat),
    )

    console.log(`[SittingSystem] Registered: "${name}"`)
  }

  // Register the stand-up system once, regardless of how many seats.
  if (!sittingSystemRegistered) {
    engine.addSystem(standUpSystem)
    sittingSystemRegistered = true
  }
}

// ---------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------

function onSeatClicked(clicked: Seat): void {
  // If the player is already sitting here, do nothing.
  if (clicked.takenByLocal) return

  // Check whether ALL seats are taken by the local player
  // (in practice the local player occupies at most one seat, so
  // this also covers the "already sitting elsewhere" case).
  const alreadySitting = seats.some(s => s.takenByLocal)
  if (alreadySitting) {
    showToast('You are already sitting somewhere!', 2_500)
    return
  }

  // Check whether the clicked seat is occupied by someone else.
  // Without sync this is local-only; add syncEntity for multiplayer.
  // For now: proceed and let the player sit (they share the position).

  clicked.takenByLocal = true

  // Teleport the player to the seat transform.
  const t = Transform.getOrNull(clicked.entity)
  if (!t) return

  movePlayerTo({
    newRelativePosition: t.position,
    cameraTarget: {
      x: t.position.x + Math.sin(2 * Math.atan2(t.rotation.y, t.rotation.w)),
      y: t.position.y + 0.5,
      z: t.position.z + Math.cos(2 * Math.atan2(t.rotation.y, t.rotation.w)),
    },
  })

  // Play a random looping sit emote after the teleport settles.
  const emote = SIT_EMOTES[Math.floor(Math.random() * SIT_EMOTES.length)]
  setTimeout(() => {
    AvatarEmoteCommand.addValue(engine.PlayerEntity, {
      emoteUrn:  emote,
      loop:      true,
      timestamp: Date.now(),
    })
  }, EMOTE_DELAY_MS)
}

/**
 * ECS system — runs every frame.
 * Frees a seat and stops the emote when the player walks away.
 */
function standUpSystem(): void {
  const playerPos = Transform.getOrNull(engine.PlayerEntity)?.position
  if (!playerPos) return

  for (const seat of seats) {
    if (!seat.takenByLocal) continue

    const seatPos = Transform.getOrNull(seat.entity)?.position
    if (!seatPos) continue

    const dx   = playerPos.x - seatPos.x
    const dz   = playerPos.z - seatPos.z
    const dist = Math.sqrt(dx * dx + dz * dz)

    if (dist > STAND_DIST) {
      seat.takenByLocal = false
      // Stop the looping sit emote by issuing a fresh idle command.
      // DCL doesn't expose a dedicated "stop emote" — overwriting with
      // a non-looping empty-ish emote returns the avatar to idle.
      AvatarEmoteCommand.addValue(engine.PlayerEntity, {
        emoteUrn:  'handsair',   // brief built-in emote → returns to idle
        loop:      false,
        timestamp: Date.now(),
      })
    }
  }
}
