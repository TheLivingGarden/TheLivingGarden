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
  engine, Entity, Transform, MeshRenderer, MeshCollider, Material, TextShape,
  GltfContainer, ColliderLayer, Name, pointerEventsSystem, InputAction,
} from '@dcl/sdk/ecs'
import { Color4, Quaternion } from '@dcl/sdk/math'
import {
  RARITY_TIERS, PLANT_SPECIES, PlantSpecies, rarityTierById, plantSpeciesById, bespokePool, stampTotal, withArticle,
} from './shared/config'
import { PROP_LAYOUT } from './shared/layout'
import { ARROW_MODEL_SRC, ARROW_SCALE, ARROW_FORWARD_YAW } from './shared/config'
import { getDiscovered, getFlowers, getHeld, holdFlower, stampsFound, gardenersHere } from './playerInventory'
import { groupFlowers, Group, openSeedMenuFlowers } from './seedMenu'
import { showToast } from './notifications'
import { playSfx } from './sounds'
import { registerStreamedTree } from './streaming'
import {
  box, label, setScale, tapArea, setHover, ZERO, LEDGE_LO, LEDGE_HI,
  WOOD_D, PLATE, CREAM, GOLD, FONT_SIGN, REFRESH_MS, TOAST_MS,
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
  model: Entity; glow: Entity; plate: Entity; name: Entity; sub: Entity; tap: Entity
  src: string; tier: number
}
let fSlots: FSlot[] = []
let fGroups: Group[] = []
let fPage = 0
let fSig = ''
let fTitle: Entity, fSubtitle: Entity
let giftHint: Entity | null = null   // "Gift a flower - 2 here" under the sign (replaces the dark gift board)
// Rarity filter (KJ 2026-10-02: the tab strip on top of the shelf was tiny, half hidden behind the plants and did not look tappable). It is now one
// "Showing: All" line under the sign: tap it to step through the rarities you own (All -> rarest ... -> All). Same wording as the Collection wall.
let fFilter = -1   // -1 = All, else a rarity tier id
let giftKey = ''

/** The gift hint under the sign: empty with no flowers; "Gift a flower - N here" while another gardener is here. */
function refreshGiftBoard(): void {
  if (!giftHint) return
  const flowers = getFlowers().length
  const others = gardenersHere().length
  const key = `${flowers}|${others}`
  if (key === giftKey) return
  giftKey = key
  TextShape.getMutable(giftHint).text = flowers > 0 && others > 0 ? `Gift a flower - ${others} here` : ''
}

function setupFlowerShelf(): void {
  const o = PROP_LAYOUT['FlowerShelf']
  const pos = o ? { x: o.x, y: o.y, z: o.z } : SHELF_POS
  const root = engine.addEntity()
  Transform.create(root, { position: pos, rotation: Quaternion.fromEulerDegrees(0, o?.rotY ?? YAW, 0) })
  Name.create(root, { value: 'FlowerShelf' })
  registerStreamedTree('flowerShelf', root)   // hidden while you are across the garden (streaming.ts)

  const w = F_PER_ROW * F_PITCH + 0.3
  // (No cabinet geometry: the shelf is modelled in Blender now — KJ 2026-09-30. Items, labels and tabs stay.)
  fTitle = label(root, { x: 0, y: 3.1, z: 0.22 }, 'MY FLOWERS', FONT_SIGN, GOLD, w * 0.6, 0.5)
  fSubtitle = label(root, { x: SHELF_SIDE_X, y: SHELF_RAIL_Y, z: SHELF_TEXT_Z }, '', 0.75, CREAM, 1.5, 0.3)
  tapArea(root, { x: 0, y: 3.0, z: 0.2 }, { x: w * 0.5, y: 0.7, z: 0.1 }, 'Open all your flowers', () => openSeedMenuFlowers())
  // Gift hint, a line under the sign (it was a big dark board at the shelf's right end with tiny text).
  giftHint = label(root, { x: -SHELF_SIDE_X, y: SHELF_RAIL_Y, z: SHELF_TEXT_Z }, '', 0.75, GOLD, 1.5, 0.3)
  tapArea(root, { x: -SHELF_SIDE_X, y: SHELF_RAIL_Y, z: SHELF_TEXT_Z }, { x: 1.5, y: 0.4, z: 0.1 }, 'Open your flowers to gift one', () => openSeedMenuFlowers())
  // "Showing: All" — tap to step through the rarities you own.
  tapArea(root, { x: SHELF_SIDE_X, y: SHELF_RAIL_Y, z: SHELF_TEXT_Z }, { x: 1.5, y: 0.4, z: 0.1 }, 'Change rarity', () => cycleFilter())
  // Page arrows: the scene's own 3D arrow, standing at the sign's two ends (like the podium's pagers), tip pointing the way the page turns.
  ;([-1, 1] as const).forEach(dir => makeShelfArrow(root, dir, w))

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
    // A light, UNLIT backdrop behind each plant so it pops off the dark wood (KJ 2026-09-30): same colour as the Collection wall, sized to the slot.
    const plate = engine.addEntity()
    Transform.create(plate, { parent: root, position: { x, y: L + 0.42, z: 0.12 }, scale: ZERO })
    MeshRenderer.setBox(plate)
    Material.setBasicMaterial(plate, { diffuseColor: Color4.create(0.82, 0.76, 0.64, 1) })
    // Name and rarity on separate lines, now close together (was 0.4 m apart to leave room for a wrapped two-line name).
    const nameY = row === 0 ? 0.66 : 1.96   // KJ 2026-10-02: higher and closer together, so both lines sit on the dark band under their row
    const subY  = row === 0 ? 0.565 : 1.865   // KJ 2026-10-05: rarity tucked right under the name (was 0.14 m below it)
    const plateZ = row === 0 ? -0.29 : -0.28
    const name = label(root, { x, y: nameY, z: plateZ }, '', 0.72, CREAM, F_PITCH, 0.26)
    const sub  = label(root, { x, y: subY, z: plateZ }, '', 0.62, CREAM, F_PITCH, 0.16)
    const tap  = tapArea(root, { x, y: L + 0.3, z: 0 }, { x: F_PITCH * 0.92, y: 0.7, z: 0.5 }, '', () => holdSlot(i))
    fSlots.push({ model, glow, plate, name, sub, tap, src: '', tier: -1 })
  }
}

// The "Showing: …" line (right) and the gift line (left) sit on the shelf's TOP RAIL, either side of the Blender sign, z in FRONT of the plates
// (KJ 2026-10-02: under the sign they hid behind the first row's backdrops — a label at z 0.22 is farther from the viewer than a plate at 0.12).
const SHELF_SIDE_X = 1.4
const SHELF_RAIL_Y = 3.1
const SHELF_TEXT_Z = -0.3
const SHELF_ARROW_Y = 3.0          // arrow height, level with the sign
const SHELF_ARROW_X = 0.55         // how far past the sign's end the arrows stand (w/2 + this)
const SHELF_ARROW_ROLL = 90        // stands the flat chevron up toward the viewer; flip the sign of this if the arrow faces the wall

/** One page arrow, a child of the shelf so it follows the prop editor. The viewer faces +z in shelf-local space (the labels read from -z), so
 *  previous sits at -x pointing -x and next at +x pointing +x. Same two-entity recipe as podium.ts: the parent yaws the flat chevron along
 *  +-x, the child rolls it about its own tip axis to turn its face from up to the viewer. */
function makeShelfArrow(root: Entity, dir: -1 | 1, w: number): void {
  const x = dir * (w / 2 + SHELF_ARROW_X)
  const yaw = Math.atan2(dir, 0) * 180 / Math.PI + ARROW_FORWARD_YAW
  const pivot = engine.addEntity()
  Transform.create(pivot, { parent: root, position: { x, y: SHELF_ARROW_Y, z: 0.1 }, rotation: Quaternion.fromEulerDegrees(0, yaw, 0) })
  const e = engine.addEntity()
  Transform.create(e, { parent: pivot, rotation: Quaternion.fromEulerDegrees(0, 0, dir * SHELF_ARROW_ROLL), scale: { x: ARROW_SCALE, y: ARROW_SCALE, z: ARROW_SCALE } })
  GltfContainer.create(e, { src: ARROW_MODEL_SRC, visibleMeshesCollisionMask: ColliderLayer.CL_NONE, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE })
  tapArea(root, { x, y: SHELF_ARROW_Y, z: 0.1 }, { x: 1.1, y: 0.8, z: 0.4 }, dir < 0 ? 'Previous page' : 'Next page', () => turnFlowerPage(dir))
}

/** Step the rarity filter: All -> each rarity you own, rarest first -> All. */
function cycleFilter(): void {
  const owned = [...new Set(groupFlowers().map(g => g.rarityTier))].sort((a, b) => b - a)
  const order = [-1, ...owned]
  const next = order[(order.indexOf(fFilter) + 1) % order.length]
  if (next === fFilter) return
  fFilter = next
  fPage = 0
  fSig = ''
  playSfx('tutorialTap')
}

/** A filtered rarity you no longer hold (gifted / displayed away) falls back to All. */
function dropEmptyFilter(all: Group[]): void {
  if (fFilter >= 0 && !all.some(g => g.rarityTier === fFilter)) { fFilter = -1; fPage = 0 }
}

function turnFlowerPage(dir: number): void {
  const pages = Math.max(1, Math.ceil(fGroups.length / F_PAGE))
  fPage = (fPage + dir + pages) % pages
  fSig = ''
}

function holdSlot(i: number): void {
  const g = fGroups[fPage * F_PAGE + i]
  if (!g) { showToast('Grow a flower in a planter and it appears here', TOAST_MS, false); return }
  // A click TOGGLES (KJ 2026-09-30): pick it up — into my hand and onto the examination table — or, if it is the one already held, put it back.
  const held = getHeld()
  if (held && held.flower === g.flower && held.rarityTier === g.rarityTier) { holdFlower(-1); playSfx('tutorialTap'); return }
  holdFlower(g.lastIndex)
  playSfx('seedCatch')   // (Notification pass 2026-09-27: no "Holding your …" toast — it is in your hand)
}

function refreshFlowerShelf(): void {
  const all = groupFlowers()
  const sig = `${fFilter}|${fPage}|${getFlowers().length}|${all.map(g => g.key + g.count).join(',')}`
  if (sig === fSig) return
  dropEmptyFilter(all)   // a filter that no longer has flowers falls back to All
  fGroups = fFilter < 0 ? all : all.filter(g => g.rarityTier === fFilter)
  const pages = Math.max(1, Math.ceil(fGroups.length / F_PAGE))
  if (fPage >= pages) fPage = pages - 1
  fSig = `${fFilter}|${fPage}|${getFlowers().length}|${all.map(g => g.key + g.count).join(',')}`

  TextShape.getMutable(fSubtitle).text = all.length === 0
    ? 'grow a flower in a planter'
    : `Showing: ${fFilter < 0 ? 'All' : rarityTierById(fFilter).name}  ${fPage + 1}/${pages}`

  for (let i = 0; i < F_PAGE; i++) {
    const s = fSlots[i]
    const g = fGroups[fPage * F_PAGE + i]
    const sp = g ? plantSpeciesById(g.flower) : null
    if (!g || !sp) {
      setScale(s.model, ZERO); setScale(s.glow, ZERO); setScale(s.plate, ZERO)
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
    setScale(s.plate, { x: F_PITCH * 0.9, y: 0.85, z: 0.02 })
    TextShape.getMutable(s.name).text = sp.name
    TextShape.getMutable(s.sub).text = `${t.name}${g.count > 1 ? `  x${g.count}` : ''}`
    TextShape.getMutable(s.sub).textColor = c
    setHover(s.tap, sp.name)   // just the name: a click toggles it in your hand / on the table
  }
}

// ===============================================================
// ALMANAC WALL
// ===============================================================

const COLS = 14   // KJ 2026-10-02: wider and shorter (14 x 6 = 84 slots for the 76 species; the board is no longer 12 x 7)
const ROWS = 6
const TILE = 0.48
const TP   = 0.54   // tile pitch (columns)
const ROW_PITCH = 0.62   // KJ 2026-10-05: rows are spaced wider than columns so the board fills the taller Blender frame without stretching the square tiles
const GRID_W = COLS * TP
const GRID_H = ROWS * ROW_PITCH
const GRID_BOTTOM = 0.7   // the footer strip (0 .. 0.6) sits under the grid
const PANEL_TOP_MARGIN = 0.315   // backdrop above the grid
const GRID_TOP = GRID_BOTTOM + GRID_H
// Eight rarity tabs in a vertical RAIL down the left of the grid (KJ 2026-10-02: the two rows of four sat high on the wall and were hard to hit;
// a column of wide, row-shaped targets is easier to click and reads as navigation). The rail spans the grid's height, so the wall is
// ~1.9 m shorter than with the tab rows on top, and ~2 m wider.
// Fitted to KJ's Blender frame (measured from scene.glb, 2026-10-02): posts' inner faces 7.92 m apart (z 45.70 / 53.62), the top beam's underside at y 6.00,
// and the lower crossbar KJ kept as a base — its top is at about y 2.76. The board is 10.16 x 4.09 m at scale 1 (no title bar: KJ paints COLLECTION and the
// hint in Blender; the two live numbers are a footer), so scale 0.77 fills the width and height together. The board's bottom edge sits at the AlmanacWall
// layout y (2.8 since KJ's 2026-10-02 bake), so there is no extra lift any more.
// KJ 2026-10-05 re-fit to the reworked frame (measured by ray-casting Shelf.009 in Blender): back panel 7.92 m wide (z 45.70-53.62, centre 49.66),
// bottom shelf's top at y 2.34, top beam's underside at y 6.08. Board 10.16 x 4.735 at scale 0.775 = 7.87 x 3.67 m, bottom at y 2.38 (layout y), so it
// sits on the shelf and stops just under the beam.
const WALL_SCALE = 0.775
const WALL_BOTTOM = 0      // the board's bottom edge, in board metres
const WALL_LIFT_Y = 0
const RAIL_W = 2.0
const PANEL_W = GRID_W + 0.6 + RAIL_W
const GRID_CX = RAIL_W / 2                 // the grid is centred right of the wall's middle
const TAB_X = -PANEL_W / 2 + RAIL_W / 2    // the rail's centre line
const TAB_W = RAIL_W - 0.3
const TAB_PITCH = GRID_H / N
const TAB_H = TAB_PITCH - 0.07
const tabY = (i: number): number => GRID_TOP - TAB_PITCH * (i + 0.5)

interface Tile { e: Entity; found: boolean; speciesId: string }
interface Tab  { bg: Entity; name: Entity; count: Entity; tier: number }
let tiles: Tile[] = []
let tabs: Tab[] = []
let selTier = 0
let aSig = ''
let aTotal: Entity
let aView: Entity        // "Showing Epic" under the stamp total
let tabFrame: Entity     // gold frame behind the selected rarity tab (one entity, moved)

function tileList(tier: number): ReadonlyArray<PlantSpecies> {
  const pool = bespokePool(tier)
  return pool.length > 0 ? pool : PLANT_SPECIES
}

function setupAlmanacWall(): void {
  const o = PROP_LAYOUT['AlmanacWall']
  const pos = o ? { x: o.x, y: o.y, z: o.z } : WALL_POS
  const root = engine.addEntity()
  Transform.create(root, { position: { x: pos.x, y: pos.y + WALL_LIFT_Y, z: pos.z }, rotation: Quaternion.fromEulerDegrees(0, o?.rotY ?? YAW, 0), scale: { x: WALL_SCALE, y: WALL_SCALE, z: WALL_SCALE } })
  Name.create(root, { value: 'AlmanacWall' })
  registerStreamedTree('collectionWall', root)   // 76 textured tiles: hidden while you are across the garden (streaming.ts)

  const panelW = PANEL_W
  const panelTop = GRID_TOP + PANEL_TOP_MARGIN   // margin above the grid; no title bar any more
  // The wall backdrop is UNLIT and one fixed colour (KJ 2026-09-30): lit, it went mauve at golden hour and near-black under the
  // night sky, so the (transparent) plant thumbnails sat on a different colour depending on the time of day.
  const wall = engine.addEntity()
  Transform.create(wall, { parent: root, position: { x: 0, y: (WALL_BOTTOM + panelTop) / 2, z: 0.05 }, scale: { x: panelW, y: panelTop - WALL_BOTTOM, z: 0.08 } })
  MeshRenderer.setBox(wall)
  Material.setBasicMaterial(wall, { diffuseColor: Color4.create(0.82, 0.76, 0.64, 1) })
  // (No side posts: the Blender frame around the wall has them.)
  // Footer: the two live numbers, spread left and right (the title and the "tap a rarity" hint are modelled in Blender now).
  box(root, { x: 0, y: 0.3, z: 0.0 }, { x: panelW, y: 0.6, z: 0.05 }, PLATE, 0.3)
  aTotal = label(root, { x: -panelW / 4, y: 0.3, z: -0.06 }, '', 2.0, CREAM, panelW / 2 - 0.3, 0.55)
  aView = label(root, { x: panelW / 4, y: 0.3, z: -0.06 }, '', 2.0, GOLD, panelW / 2 - 0.3, 0.55)
  tapArea(root, { x: -panelW / 4, y: 0.3, z: -0.05 }, { x: panelW / 2 - 0.3, y: 0.6, z: 0.1 }, 'Open your Collection', () => openSeedMenuFlowers())

  // rarity tabs: one column, down the left
  tabs = []
  tabFrame = box(root, { x: TAB_X, y: 0, z: 0.0 }, { x: TAB_W + 0.1, y: TAB_H + 0.1, z: 0.04 }, GOLD, 1.0)
  for (let i = 0; i < N; i++) {
    const y = tabY(i)
    const t = rarityTierById(i)
    const c = Color4.create(t.seedColor.r, t.seedColor.g, t.seedColor.b, 1)
    const bg = box(root, { x: TAB_X, y, z: -0.02 }, { x: TAB_W, y: TAB_H, z: 0.06 }, c, 0.7)
    const nameLbl = label(root, { x: TAB_X - 0.3, y, z: -0.07 }, t.name, 1.25, INK, 1.2, TAB_H - 0.02)
    const count = label(root, { x: TAB_X + 0.5, y, z: -0.07 }, '', 1.15, INK, 0.8, TAB_H - 0.02)
    tapArea(root, { x: TAB_X, y, z: -0.06 }, { x: TAB_W, y: TAB_H, z: 0.1 }, `${t.name} stamps`, () => { selTier = i; aSig = ''; playSfx('seedCatch') })
    tabs.push({ bg, name: nameLbl, count, tier: i })
  }

  // tiles
  tiles = []
  for (let t = 0; t < COLS * ROWS; t++) {
    const col = t % COLS, row = Math.floor(t / COLS)
    const x = GRID_CX + (col - (COLS - 1) / 2) * TP
    const y = GRID_TOP - ROW_PITCH * (row + 0.5)
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
  TextShape.getMutable(aView).text = `Showing ${rarityTierById(selTier).name}`
  Transform.getMutable(tabFrame).position = { x: TAB_X, y: tabY(selTier), z: 0.0 }

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
    setScale(tab.bg, { x: on ? TAB_W + 0.04 : TAB_W, y: TAB_H, z: 0.06 })
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
      // SELF-LIT: the scene is at night and lit materials rendered every tile near-black, so found tiles glow at
      // full strength. Missing ones are a PURE black silhouette (KJ 2026-09-29: black and transparent only, no
      // grey detail): an UNLIT black material keeps the thumbnail's alpha cut-out and nothing else — no lighting,
      // emissive or specular can lift it off black.
      const tex = Material.Texture.Common({ src: `assets/images/plantThumbs/${sp.id}.png` })
      if (found) {
        // UNLIT, like the silhouettes (KJ 2026-09-30: thumbnails looked washed out and pink). The old lit albedo + emissive of the
        // same texture double-counted the golden-hour light and pushed every colour to pastel; a basic material shows the PNG as drawn.
        Material.setBasicMaterial(tile.e, { texture: tex, alphaTest: 0.5 })
      } else {
        Material.setBasicMaterial(tile.e, { texture: tex, diffuseColor: Color4.Black(), alphaTest: 0.5 })
      }
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
    refreshGiftBoard()
    refreshAlmanac()
  })
}
