// =============================================================
// Bloom Garden v2 — Seed rack (CLIENT ONLY, prototype)
//
// KJ 2026-09-25: players could not FIND the 2D seed pouch (a small chip in the corner of
// a busy screen). This is the pouch as an object in the world: a shelf with one slot per
// rarity tier, near spawn.
//
//   - a slot lights up with that tier's seed model and a count when you own some, and is a
//     dark silhouette with a tier name when you do not (the empty shelf shows what exists)
//   - tap a stocked slot to HOLD that seed (the same call the pouch menu makes)
//   - tap the sign for the full menu; the gift board prompts gifting when you have kept
//     flowers and another gardener is here
//
// Everything is drawn from the local player's own pouch, so each player sees only their own
// seeds on their own screen. No server messages, no new state.
//
// Orientation (signs.ts rule): text reads for a viewer on the entity's -Z side, so the rack
// root is rotated 180 to face a viewer standing to its +Z (the spawn side).
// Move it with the Test panel's Prop editor ("PouchRack"); PROP_LAYOUT['PouchRack'] bakes it.
// =============================================================

import {
  engine, Entity, Transform, MeshRenderer, MeshCollider, Material, TextShape, TextAlignMode,
  GltfContainer, ColliderLayer, PointerEvents, pointerEventsSystem, InputAction, Name,
} from '@dcl/sdk/ecs'
import { Color4, Quaternion } from '@dcl/sdk/math'
import { RARITY_TIERS, rarityTierById, seedModelSrc, SEED_MODEL_HEIGHT, withArticle } from './shared/config'
import { PROP_LAYOUT } from './shared/layout'
import { getPouch, setPreferredTier, nextSeedTier, holdSeed } from './playerInventory'
import { openSeedMenu } from './seedMenu'
import { showToast } from './notifications'
import { registerStreamedTree } from './streaming'
import { playSfx } from './sounds'

// Default spot: just south of the spawn area (x 10.5..12.5, z 19..22), clear of the bush at
// (8.7, 18.5) and the Bloom's plinth. TUNING — drag it with the Prop editor.
const DEFAULT_POS = { x: 11.4, y: 0, z: 16.8 }
const DEFAULT_YAW = 180

// Two shelves of four, so every slot has room for text big enough to read on a phone (the first
// prototype was one row of eight at 0.46 m; its counts were ~5 cm tall). The rarest four sit on the top shelf.
const PER_ROW     = 4
const PITCH       = 0.95          // m between slots
const SEED_WORLD_H = 0.44         // m — a seed's height on the shelf
export const LEDGE_LO    = 0.85
export const LEDGE_HI    = 2.05
export const TAP_M       = 9
export const REFRESH_MS  = 400
export const TOAST_MS    = 3_500
// TextShape fontSize is roughly 0.2 m of glyph height per unit: NAME ~0.11 m, COUNT ~0.2 m, SIGN ~0.24 m
export const FONT_NAME   = 0.55
export const FONT_COUNT  = 1.0
export const FONT_LINE   = 0.72   // the combined "30 Uncommon" line under each seed
export const FONT_SIGN   = 1.0

// Lighter than the first pass: the dark wood and near-black panel swallowed the seed colours
export const WOOD   = Color4.create(0.62, 0.42, 0.24, 1)
export const WOOD_D = Color4.create(0.45, 0.29, 0.16, 1)
export const PANEL  = Color4.create(0.58, 0.47, 0.34, 1)   // lighter than the first pass so plants and seeds read against it
export const PLATE  = Color4.create(0.30, 0.21, 0.15, 1)
export const CREAM  = Color4.create(1.0, 0.95, 0.82, 1)
export const GOLD   = Color4.create(0.98, 0.78, 0.30, 1)

const N = RARITY_TIERS.length

interface Slot {
  tier:    number
  glow:    Entity     // tier-coloured disc under a stocked seed
  seed:    Entity     // the tier's seed model (scaled to 0 when empty)
  ghost:   Entity     // dark silhouette (shown when empty)
  ring:    Entity     // gold ring: the seed that will be planted next
  count:   Entity     // big count on the plate
  tap:     Entity     // pointer collider
}

let slots: Slot[] = []
let lastKey = ''
let accum = 0

/** `glow` > 0 makes the box faintly self-lit so it does not go black under the night sky (KJ playtest 2026-09-25: flowers vanished against a dark panel). */
export function box(parent: Entity, pos: { x: number; y: number; z: number }, size: { x: number; y: number; z: number }, color: Color4, glow = 0): Entity {
  const e = engine.addEntity()
  Transform.create(e, { parent, position: pos, scale: size })
  MeshRenderer.setBox(e)
  Material.setPbrMaterial(e, glow > 0
    ? { albedoColor: color, emissiveColor: color, emissiveIntensity: glow, metallic: 0, roughness: 1 }
    : { albedoColor: color, metallic: 0, roughness: 1 })
  return e
}

export function label(parent: Entity, pos: { x: number; y: number; z: number }, text: string, fontSize: number, color: Color4, w = 0.5, h = 0.2): Entity {
  const e = engine.addEntity()
  Transform.create(e, { parent, position: pos })
  TextShape.create(e, {
    text, fontSize, textColor: color, textAlign: TextAlignMode.TAM_MIDDLE_CENTER,
    width: w, height: h, textWrapping: true,
    outlineWidth: 0.15, outlineColor: { r: 0.12, g: 0.07, b: 0.03 },
  })
  return e
}

export function setScale(e: Entity, k: { x: number; y: number; z: number }): void {
  const t = Transform.getMutable(e)
  if (t.scale.x !== k.x || t.scale.y !== k.y || t.scale.z !== k.z) t.scale = k
}
export const ZERO = { x: 0, y: 0, z: 0 }

export function tapArea(parent: Entity, pos: { x: number; y: number; z: number }, size: { x: number; y: number; z: number }, hover: string, onTap: () => void): Entity {
  const e = engine.addEntity()
  Transform.create(e, { parent, position: pos, scale: size })
  MeshCollider.setBox(e, ColliderLayer.CL_POINTER)
  pointerEventsSystem.onPointerDown({ entity: e, opts: { button: InputAction.IA_POINTER, hoverText: hover, maxDistance: TAP_M } }, onTap)
  return e
}
export function setHover(e: Entity, text: string): void {
  const pe = PointerEvents.getMutableOrNull(e)?.pointerEvents[0]?.eventInfo
  if (pe) pe.hoverText = text
}

function holdTier(tier: number): void {
  const count = getPouch()[tier] ?? 0
  const name = rarityTierById(tier).name
  if (count <= 0) { showToast(`No ${name} seeds yet - the Bloom drops them`, TOAST_MS, false); return }
  setPreferredTier(tier)
  holdSeed(tier)
  playSfx('seedCatch')   // (Notification pass 2026-09-27: no "Holding a Rare seed" toast — it is in your hand)
  lastKey = ''   // repaint now
}

export function setupPouchRack(): void {
  const o = PROP_LAYOUT['PouchRack']
  const pos = o ? { x: o.x, y: o.y, z: o.z } : DEFAULT_POS
  const yaw = o?.rotY ?? DEFAULT_YAW

  const root = engine.addEntity()
  Transform.create(root, { position: pos, rotation: Quaternion.fromEulerDegrees(0, yaw, 0) })
  Name.create(root, { value: 'PouchRack' })
  registerStreamedTree('pouchRack', root)   // hidden while you are across the garden (streaming.ts)

  // No cabinet geometry any more (KJ 2026-09-30): the shelves are modelled in Blender, in scene.glb. Everything below — seeds, plates' names
  // and counts, the sign text, the tap areas — keeps its position relative to the rack's origin and sits on KJ's shelves.
  const w = PER_ROW * PITCH + 0.3
  label(root, { x: 0, y: 3.08, z: 0.22 }, 'SEED POUCH', FONT_SIGN, GOLD, w * 0.9, 0.5)
  label(root, { x: 0, y: 2.78, z: 0.22 }, 'tap a seed to hold it', 0.36, CREAM, w * 0.9, 0.2)
  tapArea(root, { x: 0, y: 3.0, z: 0.2 }, { x: w * 0.9, y: 0.7, z: 0.1 }, 'Open your pouch', () => openSeedMenu())

  slots = []
  for (let i = 0; i < N; i++) {
    const row = i < PER_ROW ? 0 : 1
    const col = i % PER_ROW
    const x = (col - (PER_ROW - 1) / 2) * PITCH
    const L = row === 0 ? LEDGE_LO : LEDGE_HI
    const t = rarityTierById(i)
    const c = Color4.create(t.seedColor.r, t.seedColor.g, t.seedColor.b, 1)
    const seedY = L + 0.02 + SEED_WORLD_H / 2

    const glow = engine.addEntity()
    Transform.create(glow, { parent: root, position: { x, y: L + 0.004, z: 0 }, scale: ZERO })
    MeshRenderer.setCylinder(glow)
    Material.setPbrMaterial(glow, { albedoColor: Color4.create(c.r * 0.5, c.g * 0.5, c.b * 0.5, 1), emissiveColor: c, emissiveIntensity: 0.9, metallic: 0, roughness: 1 })

    const ring = engine.addEntity()
    Transform.create(ring, { parent: root, position: { x, y: L + 0.002, z: 0 }, scale: ZERO })
    MeshRenderer.setCylinder(ring)
    Material.setPbrMaterial(ring, { albedoColor: GOLD, emissiveColor: GOLD, emissiveIntensity: 1.2, metallic: 0, roughness: 1 })

    const k = SEED_WORLD_H / SEED_MODEL_HEIGHT
    const seed = engine.addEntity()
    Transform.create(seed, { parent: root, position: { x, y: seedY, z: 0 }, scale: ZERO })
    GltfContainer.create(seed, { src: seedModelSrc(i), visibleMeshesCollisionMask: ColliderLayer.CL_NONE, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE })

    const ghost = engine.addEntity()
    Transform.create(ghost, { parent: root, position: { x, y: seedY, z: 0 }, scale: { x: 0.26, y: 0.34, z: 0.26 } })
    MeshRenderer.setSphere(ghost)
    Material.setPbrMaterial(ghost, { albedoColor: Color4.create(0.30, 0.26, 0.24, 1), metallic: 0, roughness: 1 })

    // Name and count on the plate under this slot's ledge (cabinet front for the low shelf, strip for the high one).
    // Both sit IN FRONT of the surface (z more negative): the first pass put the names on the panel's own plane and they z-fought away.
    // ONE line per seed — "30 Uncommon" — midway between where the name and the count used to sit (KJ 2026-09-30).
    const lineY = row === 0 ? 0.46 : 1.78
    const plateZ = row === 0 ? -0.29 : -0.28
    const count = label(root, { x, y: lineY, z: plateZ }, `0 ${t.name}`, FONT_LINE, Color4.create(c.r, c.g, c.b, 0.5), PITCH, 0.3)
    const tap = tapArea(root, { x, y: L + 0.3, z: 0 }, { x: PITCH * 0.92, y: 0.7, z: 0.5 }, `${t.name} seeds`, () => holdTier(i))
    slots.push({ tier: i, glow, seed, ghost, ring, count, tap })
  }

  // (The "Your flowers" gift board moved to the flower shelf, collectionDisplay.ts, 2026-09-27:
  // once the shed layout split the rack and the shelf, it hung off the seed wall.)

  engine.addSystem(rackSystem)
}

function rackSystem(dt: number): void {
  accum += dt * 1_000
  if (accum < REFRESH_MS) return
  accum = 0
  const pouch = getPouch()
  const next = nextSeedTier()
  const key = `${pouch.join(',')}|${next}`
  if (key === lastKey) return
  lastKey = key

  for (const s of slots) {
    const n = pouch[s.tier] ?? 0
    const stocked = n > 0
    setScale(s.seed, stocked ? { x: SEED_WORLD_H / SEED_MODEL_HEIGHT, y: SEED_WORLD_H / SEED_MODEL_HEIGHT, z: SEED_WORLD_H / SEED_MODEL_HEIGHT } : ZERO)
    setScale(s.glow, stocked ? { x: 0.72, y: 0.01, z: 0.72 } : ZERO)
    setScale(s.ghost, stocked ? ZERO : { x: 0.26, y: 0.34, z: 0.26 })
    setScale(s.ring, stocked && s.tier === next ? { x: 0.86, y: 0.006, z: 0.86 } : ZERO)
    const ts = TextShape.getMutable(s.count)
    const tc = rarityTierById(s.tier).seedColor
    ts.text = `${n} ${rarityTierById(s.tier).name}`
    ts.textColor = Color4.create(tc.r, tc.g, tc.b, stocked ? 1 : 0.5)   // dimmed while empty
    setHover(s.tap, stocked ? `Hold ${withArticle(rarityTierById(s.tier).name)} seed (${n})` : `${rarityTierById(s.tier).name}: none yet`)
  }

}
