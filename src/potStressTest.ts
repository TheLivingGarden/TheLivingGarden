// =============================================================
// Bloom Garden v2 — 100-planter performance test (CLIENT ONLY, dev tool)
//
// KJ is considering 100+ planters in the scene. This spawns 100 of the REAL planter
// model (same GLB, scale, spacing and collision mask as boxSystem — primitive pots
// gave a falsely good reading) and lets the phone answer the question with a frame
// rate: one entity per pot, a real animated balloon + sprout on every other pot
// (boxSystem's real occupied-box visual, not a cheap stand-in — an unanimated pot
// undercounts the actual cost of a busy garden), and a POOL of 8 plaques that hop
// to the pots nearest the player (a plaque per pot would be 300 more entities).
// Local only — nothing is sent to the server. Remove with the test panel before
// production.
// =============================================================

import { engine, Entity, Transform, MeshRenderer, GltfContainer, ColliderLayer, Material, TextShape, PointerEvents, PointerEventType, InputAction, Animator, timers, VisibilityComponent, GltfNodeModifiers } from '@dcl/sdk/ecs'
import { Color4 } from '@dcl/sdk/math'
import { BOX_MODEL_SRC, BOX_MODEL_SCALE, BOX_MODEL_RIM_Y, BALLOON_MODEL_SRC } from './shared/config'
import { createSign, moveSign, removeSign, setupSignSystem, Sign } from './signs'
import { setAllPlantersVisible } from './boxSystem'
import { setDropsSuppressed, setAllPlantsVisible } from './wateringSystem'

const COLS = 10, ROWS = 10
const SPACING = 1.4                        // same pitch as the real planter row
const ORIGIN  = { x: 1.7, z: 27.5 }        // open floor past the Bloom; temporary, so overlap is fine
const PLAQUES = 8
const REHOME_MS = 500
const COLOR_SPROUT = Color4.create(0.35, 0.75, 0.35, 1)

interface Pot { x: number; z: number; label: string }
const entities: Entity[] = []
const pots: Pot[] = []
const pool: Sign[] = []
let rehomeAccum = 0

// ── frame-rate meter (always on while the dev tools are mounted) ──
let fps = 0, frames = 0, acc = 0
function fpsSystem(dt: number): void {
  frames++; acc += dt
  if (acc >= 1) {
    fps = Math.round(frames / acc); frames = 0; acc = 0
    recent.push(fps); if (recent.length > WINDOW) recent.shift()
  }
}
let meterStarted = false
export function startFpsMeter(): void { if (!meterStarted) { meterStarted = true; engine.addSystem(fpsSystem) } }
export function getFps(): number { return fps }

// ── Perf toggles (2026-09-21) ────────────────────────────────
// An asset audit said scene.glb is 317k tris / 41 MB (78% of all geometry, 59% of it
// textures) and that ~26k tris are invisible collider capsules. That ranks the suspects
// by SIZE, which is a proxy, not proof — a GPU eats triangles more easily than it eats
// draw calls, shadow passes or texture bandwidth. These toggles turn each suspect off so
// the frame rate answers instead. Everything here is client-only and reversible.
//
// GltfNodeModifiers cannot hide a node (it only carries castShadows and material), so
// individual trees inside scene.glb are not separable — the environment is all or nothing.
// Its SHADOWS and its COLLIDERS are separable, and both are prime suspects on their own.
export type PerfToggle = 'env' | 'envShadows' | 'envColliders' | 'plants' | 'planters' | 'drops'
const off = new Set<PerfToggle>()
export function isPerfOff(t: PerfToggle): boolean { return off.has(t) }
export function perfLabel(t: PerfToggle): string {
  const l: Record<PerfToggle, string> = {
    env:          'Environment  (317k tris)',
    envShadows:   'Env shadows',
    envColliders: 'Env colliders  (~26k tris)',
    plants:       'Plants  (38)',
    planters:     'Planters  (51)',
    drops:        'Water drops',
  }
  return l[t]
}

const sceneEntity = (): Entity | null => engine.getEntityOrNullByName('scene.glb')

export function setPerfOff(t: PerfToggle, isOff: boolean): void {
  if (isOff) off.add(t); else off.delete(t)
  const on = !isOff
  const env = sceneEntity()
  switch (t) {
    case 'env':
      if (env === null) { console.log('[Perf] scene.glb entity not found'); return }
      if (VisibilityComponent.has(env)) VisibilityComponent.getMutable(env).visible = on
      else VisibilityComponent.create(env, { visible: on })
      break
    case 'envShadows':
      if (env === null) return
      // path '' targets the whole GLB — the single-root convention this project already
      // uses for the planters' castShadows override.
      GltfNodeModifiers.createOrReplace(env, { modifiers: [{ path: '', castShadows: on }] })
      break
    case 'envColliders': {
      if (env === null) return
      const g = GltfContainer.getMutableOrNull(env)
      if (!g) return
      const mask = on ? (ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER) : ColliderLayer.CL_NONE
      g.visibleMeshesCollisionMask = mask
      // PHYSICS|POINTER, matching main.composite: physics-only colliders land on the explorer's
      // CharacterOnly layer, which blocks the avatar but not the camera (2026-09-27).
      g.invisibleMeshesCollisionMask = on ? ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER : ColliderLayer.CL_NONE
      break
    }
    case 'plants':   setAllPlantsVisible(on); break
    case 'planters': setAllPlantersVisible(on); break
    case 'drops':    setDropsSuppressed(isOff); break
  }
  console.log(`[Perf] ${t} ${isOff ? 'OFF' : 'ON'}  (fps now ${fps}, take the reading after ~5 s)`)
}

// A one-second counter jitters too much to compare two configurations. This averages a
// rolling window so a toggle's effect is readable rather than guessed at.
const WINDOW = 5
const recent: number[] = []
export function getFpsAvg(): number {
  return recent.length === 0 ? 0 : Math.round(recent.reduce((a, b) => a + b, 0) / recent.length)
}
export function resetFpsAvg(): void { recent.length = 0 }
export function getTestPotCount(): number { return pots.length }

function rehomeSystem(dt: number): void {
  if (pots.length === 0) return
  rehomeAccum += dt * 1_000
  if (rehomeAccum < REHOME_MS) return
  rehomeAccum = 0
  const me = Transform.getOrNull(engine.PlayerEntity)?.position
  if (!me) return
  const nearest = pots.map(p => ({ p, d: (p.x - me.x) ** 2 + (p.z - me.z) ** 2 })).sort((a, b) => a.d - b.d).slice(0, pool.length)
  nearest.forEach((n, i) => {
    moveSign(pool[i], { x: n.p.x, y: BOX_MODEL_RIM_Y + 0.3, z: n.p.z - 0.5 })
    TextShape.getMutable(pool[i].text).text = n.p.label
  })
}
let rehomeStarted = false

export function spawnTestPots(): void {
  if (pots.length > 0) return
  setupSignSystem()
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const n = r * COLS + c + 1
    const x = ORIGIN.x + c * SPACING, z = ORIGIN.z + r * SPACING
    const pot = engine.addEntity()
    Transform.create(pot, { position: { x, y: 0, z }, scale: { x: BOX_MODEL_SCALE, y: BOX_MODEL_SCALE, z: BOX_MODEL_SCALE } })
    GltfContainer.create(pot, { src: BOX_MODEL_SRC, visibleMeshesCollisionMask: ColliderLayer.CL_POINTER | ColliderLayer.CL_PHYSICS })
    PointerEvents.create(pot, { pointerEvents: [{ eventType: PointerEventType.PET_DOWN, eventInfo: { button: InputAction.IA_POINTER, hoverText: `Test planter ${n}`, maxDistance: 8 } }] })
    entities.push(pot)
    const growing = n % 2 === 0
    if (growing) {
      const sprout = engine.addEntity()
      Transform.create(sprout, { position: { x, y: BOX_MODEL_RIM_Y + 0.09, z }, scale: { x: 0.18, y: 0.18, z: 0.18 } })
      MeshRenderer.setSphere(sprout)
      Material.setPbrMaterial(sprout, { albedoColor: COLOR_SPROUT })
      entities.push(sprout)

      const balloon = engine.addEntity()
      Transform.create(balloon, { position: { x, y: 0, z }, scale: { x: BOX_MODEL_SCALE, y: BOX_MODEL_SCALE, z: BOX_MODEL_SCALE } })
      GltfContainer.create(balloon, { src: BALLOON_MODEL_SRC, visibleMeshesCollisionMask: ColliderLayer.CL_NONE, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE })
      entities.push(balloon)
    }
    pots.push({ x, z, label: growing ? `Gardener ${n}'s seed\nopens in 7h ${n % 60}m` : 'Empty planter\nTap to plant' })
  }
  for (let i = 0; i < PLAQUES; i++) pool.push(createSign({ x: ORIGIN.x, y: -5, z: ORIGIN.z }, 0, { w: 0.85, h: 0.42 }, 0.6))
  if (!rehomeStarted) { rehomeStarted = true; engine.addSystem(rehomeSystem) }
  console.log(`[PotTest] ${pots.length} pots, ${entities.length} entities + ${pool.length} pooled plaques (${pool.length * 3} entities)`)
}

export function removeTestPots(): void {
  for (const e of entities) engine.removeEntity(e)
  for (const s of pool) removeSign(s)
  entities.length = 0; pots.length = 0; pool.length = 0
  console.log('[PotTest] removed')
}
