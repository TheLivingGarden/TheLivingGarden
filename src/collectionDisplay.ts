// =============================================================
// Bloom Garden v2 — Flower shelf and Almanac wall (CLIENT ONLY, prototype)
//
// KJ 2026-09-25: the seed rack made the pouch findable; this does the same for the other two
// things in the 2D menu, "My flowers" and the Almanac.
//
//   FLOWER SHELF ("MY FLOWERS"): two shelves of four showing your kept flowers as real 3D models,
//     rarest first, with page arrows. Tap one to HOLD it (the same call the menu makes). The
//     seed rack's gift board is the gifting prompt.
//   ALMANAC WALL: a wall of thumbnails, one per species, for ONE rarity at a time: pick a rarity
//     tab and every species you have found at that rarity is lit, the rest are dark. That is the
//     species x rarity "stamp" collection made visible (N of 608 across the tabs).
//
// Everything is drawn from the local player's own data, per screen, like the seed rack. No
// server messages. Both are movable with the Prop editor ("FlowerShelf", "AlmanacWall");
// PROP_LAYOUT bakes them. Text reads for a viewer on the -Z side, so both stand at yaw 180.
// =============================================================

import {
  engine, Entity, Transform, MeshRenderer, MeshCollider, Material, MaterialTransparencyMode, TextShape,
  GltfContainer, ColliderLayer, Name, pointerEventsSystem, InputAction,
} from '@dcl/sdk/ecs'
import { Color4, Quaternion } from '@dcl/sdk/math'
import {
  RARITY_TIERS, PLANT_SPECIES, PlantSpecies, rarityTierById, plantSpeciesById, bespokePool, stampTotal, withArticle,
} from './shared/config'
import { PROP_LAYOUT } from './shared/layout'
import { getDiscovered, getFlowers, holdFlower, stampsFound, notePouchOpened } from './playerInventory'
import { groupFlowers, Group, openSeedMenuFlowers } from './seedMenu'
import { showToast } from './notifications'
import { playSfx } from './sounds'
import {
  box, label, setScale, tapArea, setHover, buildShelfFrame, ZERO, LEDGE_LO, LEDGE_HI,
  WOOD_D, PANEL, PLATE, CREAM, GOLD, FONT_SIGN, REFRESH_MS, TOAST_MS,
} from './pouchRack'

const N = RARITY_TIERS.length
const INK = Color4.create(0.07, 0.065, 0.06, 1)

// Prototype spots south of the seed rack (checked against the real footprints: bodies clear, the
// shelf's front corner grazes a plant). TUNING — drag them with the Prop editor.
const SHELF_POS = { x: 10.6, y: 0, z: 12.0 }
const WALL_POS  = { x: 11.4, y: 0, z: 7.6 }
const YAW = 180

let accum = 0

// ===============================================================
// FLOWER SHELF
// ===============================================================

const F_PER_ROW = 4
const F_PITCH   = 0.95
const F_PAGE    = 8
const F_MODEL_K = 0.8   // species models are normalised to ~0.55 m; ×0.8 ≈ 0.44 m on the shelf

interface FSlot {
  model: Entity; glow: Entity; name: Entity; sub: Entity; tap: Entity
  src: string; tier: number
}
let fSlots: FSlot[] = []
let fGroups: Group[] = []
let fPage = 0
let fSig = ''
let fTitle: Entity, fSubtitle: Entity

function setupFlowerShelf(): void {
  const o = PROP_LAYOUT['FlowerShelf']
  const pos = o ? { x: o.x, y: o.y, z: o.z } : SHELF_POS
  const root = engine.addEntity()
  Transform.create(root, { position: pos, rotation: Quaternion.fromEulerDegrees(0, o?.rotY ?? YAW, 0) })
  Name.create(root, { value: 'FlowerShelf' })

  const w = F_PER_ROW * F_PITCH + 0.3
  buildShelfFrame(root, w)
  fTitle = label(root, { x: 0, y: 3.1, z: 0.22 }, 'MY FLOWERS', FONT_SIGN, GOLD, w * 0.6, 0.5)
  fSubtitle = label(root, { x: 0, y: 2.8, z: 0.22 }, '', 0.75, CREAM, w * 0.8, 0.25)
  tapArea(root, { x: 0, y: 3.0, z: 0.2 }, { x: w * 0.5, y: 0.7, z: 0.1 }, 'Open all your flowers', () => { notePouchOpened(); openSeedMenuFlowers() })
  // page arrows at the sign's ends
  ;([[-1, '<', -1], [1, '>', 1]] as const).forEach(([sd, glyph, dir]) => {
    label(root, { x: sd * w * 0.38, y: 3.0, z: 0.22 }, glyph, 1.2, GOLD, 0.5, 0.5)
    tapArea(root, { x: sd * w * 0.38, y: 3.0, z: 0.2 }, { x: 0.7, y: 0.7, z: 0.1 }, dir < 0 ? 'Previous page' : 'Next page', () => turnFlowerPage(dir))
  })

  fSlots = []
  for (let i = 0; i < F_PAGE; i++) {
    const row = i < F_PER_ROW ? 0 : 1
    const x = ((i % F_PER_ROW) - (F_PER_ROW - 1) / 2) * F_PITCH
    const L = row === 0 ? LEDGE_LO : LEDGE_HI
    const glow = engine.addEntity()
    Transform.create(glow, { parent: root, position: { x, y: L + 0.004, z: 0 }, scale: ZERO })
    MeshRenderer.setCylinder(glow)
    Material.setPbrMaterial(glow, { albedoColor: Color4.create(0.5, 0.5, 0.5, 1), emissiveColor: Color4.create(0.5, 0.5, 0.5, 1), emissiveIntensity: 0.8, metallic: 0, roughness: 1 })
    const model = engine.addEntity()
    Transform.create(model, { parent: root, position: { x, y: L, z: 0 }, scale: ZERO })
    GltfContainer.create(model, { src: PLANT_SPECIES[0].modelSrc, visibleMeshesCollisionMask: ColliderLayer.CL_NONE, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE })
    // Names may wrap to two lines ("Three-Spike Grass"), so the name sits high on its plate and the rarity low
    const nameY = row === 0 ? 0.6 : 1.87
    const subY  = row === 0 ? 0.2 : 1.5
    const plateZ = row === 0 ? -0.29 : -0.28
    const name = label(root, { x, y: nameY, z: plateZ }, '', 0.72, CREAM, F_PITCH, 0.34)
    const sub  = label(root, { x, y: subY, z: plateZ }, '', 0.62, CREAM, F_PITCH, 0.2)
    const tap  = tapArea(root, { x, y: L + 0.3, z: 0 }, { x: F_PITCH * 0.92, y: 0.7, z: 0.5 }, '', () => holdSlot(i))
    fSlots.push({ model, glow, name, sub, tap, src: '', tier: -1 })
  }
}

function turnFlowerPage(dir: number): void {
  const pages = Math.max(1, Math.ceil(fGroups.length / F_PAGE))
  fPage = (fPage + dir + pages) % pages
  fSig = ''
}

function holdSlot(i: number): void {
  const g = fGroups[fPage * F_PAGE + i]
  if (!g) { showToast('Grow a flower in a planter and it appears here', TOAST_MS, false); return }
  holdFlower(g.lastIndex)
  playSfx('seedCatch')
  const sp = plantSpeciesById(g.flower)
  showToast(`Holding your ${sp?.name ?? g.flower}`, TOAST_MS, false, rarityTierById(g.rarityTier).seedColor)
}

function refreshFlowerShelf(): void {
  fGroups = groupFlowers()
  const pages = Math.max(1, Math.ceil(fGroups.length / F_PAGE))
  if (fPage >= pages) fPage = pages - 1
  const sig = `${fPage}|${getFlowers().length}|${fGroups.map(g => g.key + g.count).join(',')}`
  if (sig === fSig) return
  fSig = sig

  TextShape.getMutable(fSubtitle).text = fGroups.length === 0
    ? 'grow a flower in a planter'
    : `page ${fPage + 1} of ${pages}   -   ${getFlowers().length} kept`

  for (let i = 0; i < F_PAGE; i++) {
    const s = fSlots[i]
    const g = fGroups[fPage * F_PAGE + i]
    const sp = g ? plantSpeciesById(g.flower) : null
    if (!g || !sp) {
      setScale(s.model, ZERO); setScale(s.glow, ZERO)
      TextShape.getMutable(s.name).text = ''; TextShape.getMutable(s.sub).text = ''
      setHover(s.tap, 'Empty')
      continue
    }
    const t = rarityTierById(g.rarityTier)
    const c = Color4.create(t.seedColor.r, t.seedColor.g, t.seedColor.b, 1)
    if (s.src !== sp.modelSrc) { GltfContainer.getMutable(s.model).src = sp.modelSrc; s.src = sp.modelSrc }
    const L = i < F_PER_ROW ? LEDGE_LO : LEDGE_HI
    const x = Transform.get(s.glow).position.x
    const tr = Transform.getMutable(s.model)
    tr.position = { x: x + sp.offsetX * F_MODEL_K, y: L + 0.02 + sp.baseYOffset * F_MODEL_K, z: sp.offsetZ * F_MODEL_K }
    const k = sp.scale * F_MODEL_K
    tr.scale = { x: k, y: k, z: k }
    if (s.tier !== g.rarityTier) {
      Material.setPbrMaterial(s.glow, { albedoColor: Color4.create(c.r * 0.5, c.g * 0.5, c.b * 0.5, 1), emissiveColor: c, emissiveIntensity: 0.9, metallic: 0, roughness: 1 })
      s.tier = g.rarityTier
    }
    setScale(s.glow, { x: 0.72, y: 0.01, z: 0.72 })
    TextShape.getMutable(s.name).text = sp.name
    TextShape.getMutable(s.sub).text = `${t.name}${g.count > 1 ? `  x${g.count}` : ''}`
    TextShape.getMutable(s.sub).textColor = c
    setHover(s.tap, `Hold your ${sp.name}${g.count > 1 ? ` (${g.count})` : ''}`)
  }
}

// ===============================================================
// ALMANAC WALL
// ===============================================================

const COLS = 12
const ROWS = 7
const TILE = 0.48
const TP   = 0.54   // tile pitch
const GRID_W = COLS * TP
const GRID_H = ROWS * TP
const GRID_BOTTOM = 0.5
const GRID_TOP = GRID_BOTTOM + GRID_H
// Eight rarity tabs in TWO rows of four, so a label can be ~20 cm tall (the first pass had one row of eight at
// ~10 cm, unreadable from spawn — KJ 2026-09-25 "too small and hard to read").
const TAB_COLS = 4
const TAB_W = GRID_W / TAB_COLS
const TAB_H = 0.8

interface Tile { e: Entity; found: boolean; speciesId: string }
interface Tab  { bg: Entity; name: Entity; count: Entity; tier: number }
let tiles: Tile[] = []
let tabs: Tab[] = []
let selTier = 0
let aSig = ''
let aTotal: Entity

function tileList(tier: number): ReadonlyArray<PlantSpecies> {
  const pool = bespokePool(tier)
  return pool.length > 0 ? pool : PLANT_SPECIES
}

function setupAlmanacWall(): void {
  const o = PROP_LAYOUT['AlmanacWall']
  const pos = o ? { x: o.x, y: o.y, z: o.z } : WALL_POS
  const root = engine.addEntity()
  Transform.create(root, { position: pos, rotation: Quaternion.fromEulerDegrees(0, o?.rotY ?? YAW, 0) })
  Name.create(root, { value: 'AlmanacWall' })

  const panelW = GRID_W + 0.6
  const tabsTop = GRID_TOP + 0.15 + 2 * (TAB_H + 0.08)
  const panelTop = tabsTop + 1.3
  box(root, { x: 0, y: (0.2 + panelTop) / 2, z: 0.05 }, { x: panelW, y: panelTop - 0.2, z: 0.08 }, PANEL, 0.4)       // wall (light, faintly self-lit)
  ;[-1, 1].forEach(sd => box(root, { x: sd * (panelW / 2 + 0.06), y: panelTop / 2, z: 0.05 }, { x: 0.14, y: panelTop, z: 0.14 }, WOOD_D, 0.3))
  box(root, { x: 0, y: panelTop - 0.6, z: 0.0 }, { x: panelW, y: 1.2, z: 0.05 }, PLATE, 0.3)                          // title bar
  label(root, { x: -panelW / 2 + 1.9, y: panelTop - 0.6, z: -0.06 }, 'ALMANAC', 1.7, GOLD, 3.4, 0.7)
  aTotal = label(root, { x: panelW / 2 - 2.3, y: panelTop - 0.6, z: -0.06 }, '', 1.1, CREAM, 4.3, 0.5)
  tapArea(root, { x: panelW / 2 - 2.3, y: panelTop - 0.6, z: -0.05 }, { x: 4.3, y: 1.0, z: 0.1 }, 'Open the full Almanac', () => { notePouchOpened(); openSeedMenuFlowers() })

  // rarity tabs: 2 rows x 4
  tabs = []
  for (let i = 0; i < N; i++) {
    const col = i % TAB_COLS, row = Math.floor(i / TAB_COLS)
    const x = (col - (TAB_COLS - 1) / 2) * TAB_W
    const y = tabsTop - TAB_H / 2 - row * (TAB_H + 0.08) - 0.05
    const t = rarityTierById(i)
    const c = Color4.create(t.seedColor.r, t.seedColor.g, t.seedColor.b, 1)
    const bg = box(root, { x, y, z: -0.02 }, { x: TAB_W - 0.08, y: TAB_H, z: 0.06 }, c, 0.7)
    const nameLbl = label(root, { x, y: y + 0.2, z: -0.07 }, t.name, 1.0, INK, TAB_W - 0.1, 0.34)
    const count = label(root, { x, y: y - 0.2, z: -0.07 }, '', 0.9, INK, TAB_W - 0.1, 0.3)
    tapArea(root, { x, y, z: -0.06 }, { x: TAB_W - 0.08, y: TAB_H, z: 0.1 }, `${t.name} stamps`, () => { selTier = i; aSig = ''; playSfx('seedCatch') })
    tabs.push({ bg, name: nameLbl, count, tier: i })
  }

  // tiles
  tiles = []
  for (let t = 0; t < COLS * ROWS; t++) {
    const col = t % COLS, row = Math.floor(t / COLS)
    const x = (col - (COLS - 1) / 2) * TP
    const y = GRID_TOP - TP * (row + 0.5)
    const e = engine.addEntity()
    Transform.create(e, { parent: root, position: { x, y, z: -0.03 }, scale: ZERO })
    MeshRenderer.setBox(e)
    MeshCollider.setBox(e, ColliderLayer.CL_POINTER)
    tileTap(e, t)
    tiles.push({ e, found: false, speciesId: '' })
  }
}

/** The tile IS its own tap target (it already carries a pointer collider). */
function tileTap(e: Entity, t: number): void {
  pointerEventsSystem.onPointerDown({ entity: e, opts: { button: InputAction.IA_POINTER, hoverText: '', maxDistance: 14 } }, () => tapTile(t))
}

function tapTile(t: number): void {
  const list = tileList(selTier)
  const sp = list[t]
  if (!sp) return
  const seen = getDiscovered().get(sp.id)
  const tier = rarityTierById(selTier).name
  if (seen?.has(selTier)) { showToast(`${sp.name} - ${tier} stamp collected`, TOAST_MS, false, rarityTierById(selTier).seedColor); return }
  if (seen && seen.size > 0) { showToast(`${sp.name} - you have not found it as ${withArticle(tier)} yet`, TOAST_MS, false); return }
  showToast('Not discovered yet - keep growing seeds', TOAST_MS, false)
}

function refreshAlmanac(): void {
  const seen = getDiscovered()
  const list = tileList(selTier)
  const sig = `${selTier}|${stampsFound()}|${seen.size}|${list.length}`
  if (sig === aSig) return
  aSig = sig

  TextShape.getMutable(aTotal).text = `${stampsFound()} of ${stampTotal()} stamps`

  for (const tab of tabs) {
    const l = tileList(tab.tier)
    let n = 0
    for (const sp of l) if (seen.get(sp.id)?.has(tab.tier)) n++
    TextShape.getMutable(tab.count).text = `${n} / ${l.length}`
    const tc = rarityTierById(tab.tier).seedColor
    const on = tab.tier === selTier
    const k = on ? 1 : 0.5
    const c = Color4.create(tc.r * k, tc.g * k, tc.b * k, 1)
    Material.setPbrMaterial(tab.bg, { albedoColor: c, emissiveColor: c, emissiveIntensity: on ? 0.9 : 0.4, metallic: 0, roughness: 1 })
    setScale(tab.bg, { x: TAB_W - 0.08, y: on ? TAB_H + 0.1 : TAB_H, z: 0.06 })
    const ink = on ? INK : CREAM   // dark text on the lit tab, light text on the dimmed ones
    TextShape.getMutable(tab.name).textColor = ink
    TextShape.getMutable(tab.count).textColor = ink
  }

  for (let t = 0; t < tiles.length; t++) {
    const tile = tiles[t]
    const sp = list[t]
    if (!sp) { setScale(tile.e, ZERO); tile.speciesId = ''; continue }
    const found = !!seen.get(sp.id)?.has(selTier)
    if (tile.speciesId !== sp.id || tile.found !== found) {
      // SELF-LIT: the scene is at night and lit materials rendered every tile near-black. Found tiles glow at full
      // strength, missing ones as a clearly dimmer silhouette, so the two read apart at a glance.
      const tex = Material.Texture.Common({ src: `assets/images/plantThumbs/${sp.id}.png` })
      Material.setPbrMaterial(tile.e, {
        texture: tex, emissiveTexture: tex,
        albedoColor: found ? Color4.White() : Color4.create(0.12, 0.12, 0.12, 1),
        emissiveColor: Color4.White(), emissiveIntensity: found ? 1.0 : 0.18,
        transparencyMode: MaterialTransparencyMode.MTM_ALPHA_TEST, alphaTest: 0.5,
        metallic: 0, roughness: 1,
      })
      tile.speciesId = sp.id; tile.found = found
    }
    setScale(tile.e, { x: TILE, y: TILE, z: 0.04 })
    const any = (seen.get(sp.id)?.size ?? 0) > 0
    setHover(tile.e, found ? sp.name : any ? `${sp.name} - not found at this rarity` : '???')
  }
}

// ===============================================================

export function setupCollectionDisplays(): void {
  setupFlowerShelf()
  setupAlmanacWall()
  engine.addSystem((dt: number) => {
    accum += dt * 1_000
    if (accum < REFRESH_MS) return
    accum = 0
    refreshFlowerShelf()
    refreshAlmanac()
  })
}
