// =============================================================
// Bloom Garden v2 — Examination table (CLIENT ONLY)
//
// KJ 2026-09-27: "a big examination table where you can see a bigger version of the plant and
// inspect it, in the potting shed". A table beside the flower shelf: hold a flower (from the
// shelf or the pouch), tap the table, and a big version of it turns slowly on the turntable with
// a plaque in front — name, rarity, who grew it, when it opened. One tap, no extra screen: the
// examination happens in the world, in the shed, where the flowers live.
//
// Client-only: each player examines their own flower on their own screen (like the shelf).
// No toasts (notification pass 2026-09-27) — the table's hover text says what to do.
// Built from pouchRack's helpers so it matches the shelf. Move it with the Test panel's Prop
// editor ("ExamTable"); PROP_LAYOUT['ExamTable'] bakes it.
// =============================================================

import { engine, Entity, Transform, GltfContainer, ColliderLayer, MeshRenderer, Material, Name, TextShape } from '@dcl/sdk/ecs'
import { Color4, Quaternion } from '@dcl/sdk/math'
import { plantSpeciesById, rarityTierById } from './shared/config'
import { PROP_LAYOUT } from './shared/layout'
import { getHeld, getFlowers, heldFlowerIndex, Keepsake } from './playerInventory'
import { box, label, tapArea, setHover, PLATE, CREAM } from './pouchRack'
import { playSfx } from './sounds'
import { registerStreamedTree, registerStreamSource } from './streaming'
import { openFlowerInspector } from './flowerInspector'
import { attachPlantVfx, detachPlantVfx } from './plantVfx'
import { retirePlant } from './boxSystem'

// In front of the flower shelf (PROP_LAYOUT FlowerShelf -24.3, 1.5, 53.4 — the shed floor is
// raised, hence y 1.5). TUNING — drag it with the Prop editor.
const DEFAULT_POS = { x: -24.3, y: 1.5, z: 50.8 }
const DEFAULT_YAW = 0

const TOP_Y     = 0.9            // table top height
const TOP_W     = 1.6, TOP_D = 1.0
const TAP_W = 0.9, TAP_D = 0.9, TAP_H = 0.7   // TUNING — the table's tap target: the turntable footprint, 0.7 m tall
const SPECIMEN_M = 1.35          // the specimen's largest dimension (species models are ~0.55 m)
const SPIN_DEG_S = 22            // turntable speed
const SPIN_RANGE = 16            // m — only turn while someone could be looking

let spinner: Entity | null = null   // turntable root the specimen hangs off; rotated by spinSystem
let specimen: Entity | null = null
let plaque: Entity | null = null
let tap: Entity | null = null
let root: Entity | null = null
let yawNow = 0
let shownKey = ''

const HOVER_EMPTY = 'Pick a flower from the shelf to examine it here'
const HOVER_HELD  = 'Inspect this flower'
const PLAQUE_EMPTY = 'Pick a flower from the shelf'

function fmtDate(ms?: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${d.getDate()}`
}

/** The keepsake in the hand, with its provenance when the collection has it. */
function heldKeepsake(): Keepsake | null {
  const h = getHeld()
  if (!h || !h.flower) return null
  const i = heldFlowerIndex()
  const k = i !== null ? getFlowers()[i] : undefined
  return k ?? { flower: h.flower, rarityTier: h.rarityTier, at: 0 }
}

const SPECIMEN_VFX_KEY = 'exam:specimen'

/** Where the turntable's centre is in the world (the table's origin plus its small rotated offset). */
function turntableWorld(): { x: number; y: number; z: number } {
  const t = root ? Transform.getOrNull(root) : null
  if (!t) return { x: 0, y: 0, z: 0 }
  const yawRad = (yaw_of(t.rotation) * Math.PI) / 180
  const off = 0.05
  return { x: t.position.x + Math.sin(yawRad) * off, y: t.position.y + TOP_Y + 0.06, z: t.position.z + Math.cos(yawRad) * off }
}
function yaw_of(q: { x: number; y: number; z: number; w: number }): number {
  return (Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x)) * 180) / Math.PI
}

/** Remove the specimen the safe way: its effects first, then a retired entity (a bare removeEntity on a model carrying the pulse override
 *  made the Unity explorer throw — see retirePlant). */
function clearSpecimen(): void {
  detachPlantVfx(SPECIMEN_VFX_KEY)
  if (specimen !== null) { retirePlant(specimen); specimen = null }
}

/** Put the held flower on the turntable (or clear it). The shelf's click is what holds it — KJ 2026-09-30: click a flower on the shelf and it goes
 *  into your hand AND onto this table; click it again and it goes back. Runs twice a second; only rebuilds when the flower changes. */
function syncSpecimen(): void {
  if (!spinner || !plaque) return
  const k = heldKeepsake()
  const sp = k ? plantSpeciesById(k.flower) : undefined
  if (!k || !sp) {
    clearSpecimen()
    if (shownKey !== '') {
      shownKey = ''
      const ts = TextShape.getMutable(plaque)
      ts.text = PLAQUE_EMPTY
      ts.textColor = CREAM
    }
    return
  }
  const key = `${k.flower}:${k.rarityTier}:${k.at}`
  if (key === shownKey) return
  shownKey = key
  clearSpecimen()
  specimen = engine.addEntity()
  const K = (SPECIMEN_M / 0.55) * sp.scale
  const f = SPECIMEN_M / 0.55
  Transform.create(specimen, {
    parent: spinner,
    position: { x: sp.offsetX * f, y: sp.baseYOffset * f, z: sp.offsetZ * f },
    scale: { x: K, y: K, z: K },
  })
  GltfContainer.create(specimen, { src: sp.modelSrc, visibleMeshesCollisionMask: ColliderLayer.CL_NONE, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE })
  // The flower's rarity effects (glints, glow, pulse, sway) — the same attach the planters and the Gallery use (KJ 2026-09-30: "why don't I see
  // its effects?": the specimen was a bare model, so nothing above Common ever showed). `soil` = the turntable's centre in world space.
  attachPlantVfx(SPECIMEN_VFX_KEY, specimen, sp.id, k.rarityTier, turntableWorld())
  const tier = rarityTierById(k.rarityTier)
  const lines = [sp.name, tier.name]
  const who = [k.grownBy ? `grown by ${k.grownBy}` : '', k.from ? `a gift from ${k.from}` : '', fmtDate(k.openedAt ?? k.at)].filter(Boolean).join(' - ')
  if (who) lines.push(who)
  const ts = TextShape.getMutable(plaque)
  ts.text = lines.join('\n')
  ts.textColor = k.rarityTier > 0 ? Color4.create(tier.seedColor.r, tier.seedColor.g, tier.seedColor.b, 1) : CREAM
  playSfx('flowerOpen')   // the same chime as a flower opening in its planter
}

/** Tapping the table opens the inspector for the flower on it. */
function examine(): void {
  const k = heldKeepsake()
  if (!k) return
  playSfx('tutorialTap')
  openFlowerInspector(k)
}

/** Turn the specimen while someone is near; keep the hover text honest about what a tap does. */
let hoverAccum = 0
function spinSystem(dt: number): void {
  if (!root || !spinner) return
  const me = Transform.getOrNull(engine.PlayerEntity)?.position
  const at = Transform.getOrNull(root)?.position
  if (specimen !== null && me && at && Math.hypot(me.x - at.x, me.z - at.z) < SPIN_RANGE) {
    yawNow = (yawNow + SPIN_DEG_S * dt) % 360
    Transform.getMutable(spinner).rotation = Quaternion.fromEulerDegrees(0, yawNow, 0)
  }
  hoverAccum -= dt
  if (hoverAccum <= 0) {
    hoverAccum = 0.5
    syncSpecimen()
    if (tap) setHover(tap, heldKeepsake() ? HOVER_HELD : HOVER_EMPTY)
  }
}

export function setupExamTable(): void {
  const o = PROP_LAYOUT['ExamTable']
  const pos = o ? { x: o.x, y: o.y, z: o.z } : DEFAULT_POS
  const yaw = o?.rotY ?? DEFAULT_YAW

  root = engine.addEntity()
  Transform.create(root, { position: pos, rotation: Quaternion.fromEulerDegrees(0, yaw, 0) })
  Name.create(root, { value: 'ExamTable' })
  registerStreamedTree('examTable', root)   // hidden while you are across the garden (streaming.ts)
  // The specimen is created and replaced at runtime, after the tree above was collected (it only refreshes every 30 s), so it is streamed on its own:
  // it hides with the rest of the table when you walk away and shows again on return. (Its effects pause themselves beyond ~12 m — plantVfx's budget.)
  registerStreamSource('examSpecimen', () => {
    const t = root ? Transform.getOrNull(root) : null
    return specimen !== null && t ? [{ key: 'specimen', x: t.position.x, z: t.position.z, entities: [specimen] }] : []
  })

  // (No table geometry — top, apron, legs: the table is modelled in Blender now, KJ 2026-09-30. The turntable, plaque and tap target stay.)
  // Turntable: a low dark disc the specimen stands on.
  const disc = engine.addEntity()
  Transform.create(disc, { parent: root, position: { x: 0, y: TOP_Y + 0.03, z: 0.05 }, scale: { x: 0.85, y: 0.05, z: 0.85 } })
  MeshRenderer.setCylinder(disc)
  Material.setPbrMaterial(disc, { albedoColor: PLATE, emissiveColor: PLATE, emissiveIntensity: 0.3, metallic: 0, roughness: 0.8 })
  spinner = engine.addEntity()
  Transform.create(spinner, { parent: root, position: { x: 0, y: TOP_Y + 0.06, z: 0.05 } })

  // Plaque on the front edge (viewer on -Z, signs.ts rule) and a small title board.
  box(root, { x: 0, y: TOP_Y - 0.14, z: -TOP_D / 2 - 0.01 }, { x: 1.2, y: 0.3, z: 0.02 }, PLATE, 0.3)
  plaque = label(root, { x: 0, y: TOP_Y - 0.14, z: -TOP_D / 2 - 0.03 }, PLAQUE_EMPTY, 0.5, CREAM, 1.15, 0.3)
  label(root, { x: 0, y: TOP_Y + 0.02, z: -TOP_D / 2 + 0.06 }, 'Examination table', 0.4, CREAM, 1.2, 0.12)

  // The tap target (KJ 2026-10-01: it was the whole table top and 1.3 m high, and got in the way of clicking other things): now just over the
  // turntable — its footprint, from the top up to 0.7 m, enough to click the flower on it without reaching out over the rest of the table.
  tap = tapArea(root, { x: 0, y: TOP_Y + TAP_H / 2, z: 0.05 }, { x: TAP_W, y: TAP_H, z: TAP_D }, HOVER_EMPTY, examine)

  engine.addSystem(spinSystem)
  console.log(`[ExamTable] ready at (${pos.x}, ${pos.y}, ${pos.z}) yaw ${yaw}`)
}
