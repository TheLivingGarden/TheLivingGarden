// =============================================================
// The Living Garden — Player Sparkle Trail
//
// After the bloom event closes, every player in the scene leaves
// a gentle sparkle trail for TRAIL_DURATION_MS (10 min).
//
// One renderer-side ParticleSystem per avatar (AvatarAttach), simulated in
// WORLD space so sparkles stay where they were emitted — a trail, not an aura.
// Zero per-frame scene work: the old 100-entity pool re-sent a Transform per
// live sparkle every frame (~9 per player) for the whole 10 minutes.
// A 1 s roster loop adds emitters for joiners and removes them for leavers.
//
// Public API:
//   setupPlayerTrailSystem()  — call once at scene startup
//   startPlayerTrail()        — call on bloomReset; auto-stops after 10 min
//   stopPlayerTrail()         — stop emitting now (live sparkles fade out)
// =============================================================

import {
  engine,
  Entity,
  Transform,
  AvatarAttach,
  AvatarAnchorPointType,
  ParticleSystem,
  PlayerIdentityData,
  timers,
} from '@dcl/sdk/ecs'
import { Color4 } from '@dcl/sdk/math'
import { SPARKLE_SRC } from './shared/config'
import { fx } from './perfTier'

// const enums in @dcl/ecs internals, not re-exported (same as plantVfx)
const PSB_ALPHA = 0, PS_PLAYING = 0, PSS_WORLD = 1   // alpha, not additive: additive vanishes on the bright garden

// ---------------------------------------------------------------
// Config  (tweak here — no magic numbers below)
// ---------------------------------------------------------------

/** Total duration of the trail effect after bloom closes (ms). */
const TRAIL_DURATION_MS  = 10 * 60_000

/** Sparkles per second: MY trail, and each OTHER player's (fewer — nobody is watching a stranger's trail closely). Few and big (KJ 2026-09-19, 2026-10-01). */
const TRAIL_RATE_SELF    = () => fx(3, 2)
const TRAIL_RATE_OTHER   = () => fx(2, 1.5)

/** World-space sparkle diameter at peak (m). */
const TRAIL_SPARKLE_SIZE = () => fx(0.5, 0.55)

/** Other players' trails only exist for the nearest few, within range (a hysteresis band so a trail does not flicker at the edge):
 *  every trail is an avatar attachment plus a particle system for the whole 10 minutes, for people you cannot see. */
const TRAIL_OTHERS_MAX   = () => fx(6, 3)
const TRAIL_RANGE_IN_M   = 25
const TRAIL_RANGE_OUT_M  = 30

/** Sparkle lifetime (s). */
const TRAIL_LIFE_S       = 1.6

/** Emitter height above the avatar's feet (m). */
const TRAIL_SPAWN_Y      = 0.8

/** Gentle upward drift (m/s²). */
const TRAIL_DRIFT_Y      = 0.4

/** Emitter sphere radius — horizontal jitter (m). */
const TRAIL_JITTER_R     = 0.5

/** How often the emitter roster is reconciled with the players in scene (ms). */
const ROSTER_MS          = 1_000

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------

const emitters = new Map<string, { parent: Entity; emitter: Entity }>()   // address ('' = local player)
let trailGen   = 0

// ---------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------

function addEmitter(address: string): void {
  const rate = address === '' ? TRAIL_RATE_SELF() : TRAIL_RATE_OTHER()
  const parent = engine.addEntity()
  AvatarAttach.create(parent, address === ''
    ? { anchorPointId: AvatarAnchorPointType.AAPT_POSITION }
    : { avatarId: address, anchorPointId: AvatarAnchorPointType.AAPT_POSITION })
  const emitter = engine.addEntity()
  Transform.create(emitter, { parent, position: { x: 0, y: TRAIL_SPAWN_Y, z: 0 } })
  ParticleSystem.create(emitter, {
    shape: ParticleSystem.Shape.Sphere({ radius: TRAIL_JITTER_R }),
    rate: rate, maxParticles: Math.ceil(rate * TRAIL_LIFE_S) + 2, lifetime: TRAIL_LIFE_S,
    gravity: 0, additionalForce: { x: 0, y: TRAIL_DRIFT_Y, z: 0 },
    initialVelocitySpeed: { start: 0.05, end: 0.2 },
    initialSize: { start: TRAIL_SPARKLE_SIZE(), end: TRAIL_SPARKLE_SIZE() }, sizeOverTime: { start: 1, end: 0 },
    initialColor: { start: Color4.create(1.0, 0.95, 0.78, 1), end: Color4.create(1.0, 0.88, 0.52, 1) },   // warm cream → gold
    colorOverTime: { start: Color4.create(1, 1, 1, 1), end: Color4.create(1, 1, 1, 0) },
    texture: { src: SPARKLE_SRC }, billboard: true, blendMode: PSB_ALPHA,
    simulationSpace: PSS_WORLD,
    loop: true, prewarm: false, active: true, playbackState: PS_PLAYING,
  })
  emitters.set(address, { parent, emitter })
}

/** `removeEntityWithChildren` walks the Transform tree starting AT the root, so it removes NOTHING
 *  when the root has no Transform — and an AvatarAttach anchor doesn't have one. Retired and departed players'
 *  trail emitters were never removed (2026-09-27).
 *  Remove the Transform children (and their subtrees), then the anchor itself. */
function removeAnchor(root: Entity): void {
  const kids: Entity[] = []
  for (const [e, t] of engine.getEntitiesWith(Transform)) if (t.parent === root) kids.push(e)
  for (const k of kids) engine.removeEntityWithChildren(k)
  engine.removeEntity(root)
}

/** Stop emitting now; remove once the last sparkles have faded. */
function retireAllEmitters(): void {
  const retired = [...emitters.values()]
  emitters.clear()
  for (const e of retired) ParticleSystem.getMutable(e.emitter).active = false
  timers.setTimeout(() => { for (const e of retired) removeAnchor(e.parent) }, TRAIL_LIFE_S * 1_000)
}

function syncRoster(gen: number): void {
  if (trailGen !== gen) return
  const me = Transform.getOrNull(engine.PlayerEntity)?.position
  // Others, nearest first, inside the range (wider for a trail that already exists), capped.
  const near: Array<{ address: string; d: number }> = []
  for (const [entity, id] of engine.getEntitiesWith(PlayerIdentityData)) {
    if (entity === engine.PlayerEntity) continue
    const address = id.address.toLowerCase()
    const p = Transform.getOrNull(entity)?.position
    const d = me && p ? Math.hypot(p.x - me.x, p.z - me.z) : 0
    if (d <= (emitters.has(address) ? TRAIL_RANGE_OUT_M : TRAIL_RANGE_IN_M)) near.push({ address, d })
  }
  near.sort((a, b) => a.d - b.d)
  const present = new Set<string>([''])
  for (const n of near.slice(0, TRAIL_OTHERS_MAX())) present.add(n.address)
  for (const [address, e] of emitters) {
    if (!present.has(address)) { removeAnchor(e.parent); emitters.delete(address) }
  }
  for (const address of present) if (!emitters.has(address)) addEmitter(address)
  timers.setTimeout(() => syncRoster(gen), ROSTER_MS)
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/** Kept for the startup call order — emitters are created on demand. */
export function setupPlayerTrailSystem(): void {
  console.log('[PlayerTrail] Setup complete — renderer particles')
}

/**
 * Start the post-bloom sparkle trail for all players.
 * Bumping the gen-counter makes it safe to call again mid-run
 * (e.g. a second bloom in the same session): a fresh 10-minute window starts.
 * Auto-stops after TRAIL_DURATION_MS.
 */
export function startPlayerTrail(): void {
  const gen = ++trailGen
  syncRoster(gen)
  timers.setTimeout(() => {
    if (trailGen === gen) stopPlayerTrail()
  }, TRAIL_DURATION_MS)
  console.log('[PlayerTrail] Started — 10 min trail active')
}

/** Stop emitting immediately; live sparkles finish their fade. */
export function stopPlayerTrail(): void {
  trailGen++
  retireAllEmitters()
  console.log('[PlayerTrail] Stopped')
}
