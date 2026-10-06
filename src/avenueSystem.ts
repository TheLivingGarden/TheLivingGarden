// =============================================================
// Bloom Garden v2 — The Avenue (CLIENT ONLY)
//
// design/communal-planters.md (2026-09-22): the Hall of Fame stands (shared/hallOfFame.ts; 24 since the 2026-09-29 re-bake, were 55), holding
// harvested Rare+ flowers. A gallery, not a garden — nothing grows or wilts here, the
// flower is simply on show with its owner's name until they take it back (or the
// crowding rule returns it to My flowers). The stands themselves are
// hallOfFame.ts; this file only adds the tap box, the flower and a pooled plaque per slot.
//
// Server communication (server is authoritative; the client only requests):
//   send    →  displayFlower { slotId, flower, rarityTier, at }   slotId '' = first free slot
//   send    →  recallFlower  { slotId }                my own slot
//   send    →  inspectAvenue { slotId }                counts a look (card in Phase 3)
//   receive ←  avenueState   { slotId, owner, ownerName, flower, rarityTier, since,
//                              grownBy, openedAt, helpersJson, giftedBy, looks }
// One world tap per slot: empty + flower in hand → display it here; empty + empty hand →
// the seed menu opens on Flowers for this slot; mine → tap twice to take it back;
// someone else's → inspect.
// =============================================================

import {
  engine, Entity, Transform, GltfContainer, ColliderLayer, MeshCollider, TextShape, Billboard, BillboardMode, Tween, EasingFunction, TweenLoop, TweenSequence, MeshRenderer, Material, MaterialTransparencyMode,
  pointerEventsSystem, InputAction,
} from '@dcl/sdk/ecs'
import { Quaternion } from '@dcl/sdk/math'
import { getPlayer } from '@dcl/sdk/players'
import { room } from './shared/messages'
import {
  SPARKLE_SRC,
  AVENUE_POSITIONS, AVENUE_CUBE_FRONT_OFFSET, AVENUE_PLAQUE_OUT, AVENUE_PLAQUE_DROP, AVENUE_FLOWER_SCALE,
  AVENUE_MIN_TIER, plantSpeciesById, rarityTierById,
} from './shared/config'
import { showToast } from './notifications'
import { attachPlantVfx, detachPlantVfx } from './plantVfx'
import { retirePlant } from './boxSystem'
import { getHeld, heldFlowerIndex, registerAvenueApi, getArmedAvenueFlower, armAvenuePlacement, keepsakeIdentity } from './playerInventory'
import { openSeedMenuForAvenue, isSeedMenuOpen } from './seedMenu'
import { createSign, moveSign, Sign } from './signs'
import { showAvenueCard, closeAvenueCard, isAvenueCardOpen } from './avenueCard'
import { playSfx } from './sounds'

// ---------------------------------------------------------------
// Config
// ---------------------------------------------------------------

const TAP_DISTANCE   = 8
const TOAST_MS       = 5_000
// Tap box = the cube's own body (soil − cube height → a little above the soil), 5 cm
// proud of the cube's front so it beats the wall's collider. It must NOT reach up into the
// row above: rows are 0.65 m apart and the first cut (0.5 m box ABOVE each soil) overlapped
// the cube above it, so the whole wall read as one target (KJ 2026-09-22).
const HIT_ABOVE_SOIL = 0.6
// Reaches 0.35 m FURTHER out than the cube's own face so a click aimed just in front of a
// slot still lands (nothing blocks it — scene.glb's visible meshes carry no collision).
// Width stays inside the 0.77 m column pitch and height inside the 0.65 m row pitch, so
// neighbouring slots still can't steal each other's taps.
// Hall of Fame stands: one box over the whole stand — the 1.6 m width, from 0.5 m behind the
// soil centre to 0.35 m past the front wall, and from ~1 m up the wall to a plant's height.
const HIT_BACK       = 0.5
const HIT_SIZE       = { x: 1.4, y: 1.5, z: HIT_BACK + AVENUE_CUBE_FRONT_OFFSET + 0.35 }
// Plaque on the cube's front face, just proud of it, centred on the face
const PLAQUE_OUT     = AVENUE_PLAQUE_OUT
const PLAQUE_DROP    = AVENUE_PLAQUE_DROP
const PLAQUE_TILT    = 45   // the star panel is a 45° slope (measured from the module mesh)
const PLAQUE_SIZE    = { w: 1.05, h: 0.34 }
const PLAQUE_FONT    = 0.7   // TUNING — two short lines under the star
// Empty stand: a floating "?" above the soil
const QUESTION_LIFT  = 0.7
const QUESTION_SRC   = 'assets/scene/Models/questionMark/questionMark.glb'
const QUESTION_SCALE = 2.2     // questionMark.glb is 0.34 x 0.53 m, origin at its base
const QUESTION_BOB_M   = 0.07  // float amplitude (the bob is one yoyo tween on a child, started when the mark pops in)
const QUESTION_BOB_MS  = 1800
const QUESTION_GLOW    = 1.5   // soft gold glow sprite behind the glyph, m
const QUESTION_RANGE_M = 16    // a "?" pops in as you come within this of its stand, and drops out again past +3 m
const QUESTION_POP_MS  = 350   // same ease as the plants' pop (boxSystem POP_MS / EASEOUTBACK)
// Pooled like boxSystem's: signs.ts shows the nearest 8 within 9 m anyway
const PLAQUE_POOL    = 8
const PLAQUE_RANGE_M = 12
const PLAQUE_SCAN_MS = 400

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------

type SlotPos = { x: number; y: number; z: number; rot: number }

interface SlotView {
  slotId:     string
  pos:        SlotPos
  hit:        Entity
  plant:      Entity | null
  plantKey:   string
  labelText:  string
  owner:      string
  ownerName:  string
  flower:     string
  rarityTier: number
  since:      number
  grownBy:    string
  openedAt:   number
  helpers:    string[]
  giftedBy:   string
  looks:      number
}
interface Plaque { sign: Sign; slotId: string | null }

const views   = new Map<string, SlotView>()
const plaques: Plaque[] = []
const synced  = new Set<string>()   // had the join snapshot — no sounds for that one
let   plaqueAccum = 0
const questionKids = new Map<Entity, { pop: Entity; bob: Entity; all: Entity[] }>()   // root -> its pop-scale child, its bobbing child + every child, for cleanup
const questionShown = new Set<Entity>()   // "?" marks currently popped in
let   questionAccum = 0

function localId(): string { return (getPlayer()?.userId ?? '').toLowerCase() }
function isMine(v: SlotView): boolean { return !!v.owner && v.owner.toLowerCase() === localId() }
function speciesName(id: string): string { return plantSpeciesById(id)?.name ?? id }
/** Out of the wall into the avenue, along the slot's facing (rot 0 = +z). */
function outward(pos: SlotPos, d: number): { x: number; z: number } {
  const r = (pos.rot * Math.PI) / 180
  return { x: pos.x + d * Math.sin(r), z: pos.z + d * Math.cos(r) }
}
function slotPoint(pos: SlotPos, lx: number, lz: number): { x: number; z: number } {
  const r = (pos.rot * Math.PI) / 180
  return { x: pos.x + lx * Math.cos(r) + lz * Math.sin(r), z: pos.z - lx * Math.sin(r) + lz * Math.cos(r) }
}

/** Streaming (streaming.ts): each slot's flower, for the distance sweep. */
export function avenueStreamItems(): Array<{ key: string; x: number; z: number; entities: Entity[] }> {
  const out: Array<{ key: string; x: number; z: number; entities: Entity[] }> = []
  // A "?" is a small tree (root > pop > bob > model + glow): list every entity, because streaming.ts gives each one its OWN
  // VisibilityComponent — the phone client does not reliably hide children with their parent (KJ 2026-10-05: the "?" flickered on mobile).
  for (const v of views.values()) if (v.plant !== null) out.push({ key: v.slotId, x: v.pos.x, z: v.pos.z, entities: [v.plant, ...(questionKids.get(v.plant)?.all ?? [])] })
  return out
}

/** Public read for the inspect card (Phase 3) and the test panel. */
export function getAvenueSlot(slotId: string): Readonly<SlotView> | undefined { return views.get(slotId) }
export function avenueSlotIds(): string[] { return [...views.keys()] }

/** Onboarding: the nearest EMPTY slot to a point — mirrors boxSystem's
 *  nearestFreePlanter, same purpose (a shell highlight to make one findable among 72). */
export function nearestFreeAvenueSlot(from: { x: number; z: number }): { slotId: string; x: number; y: number; z: number; rot: number } | null {
  // Columns hold two slots (y 1.13 and 2.43) at the SAME x/z, so distance alone ties and
  // array order always won — which meant the marker usually pointed overhead at the top
  // row. Break the tie toward eye height so the prompt lands on a slot you can easily hit.
  const EYE = 1.6
  let best: { slotId: string; x: number; y: number; z: number; rot: number } | null = null
  let bestSq = Infinity, bestDy = Infinity
  for (const v of views.values()) {
    if (v.owner) continue
    const dx = v.pos.x - from.x, dz = v.pos.z - from.z
    const sq = dx * dx + dz * dz
    const dy = Math.abs(v.pos.y - EYE)
    if (sq < bestSq - 0.01 || (Math.abs(sq - bestSq) <= 0.01 && dy < bestDy)) {
      bestSq = Math.min(sq, bestSq); bestDy = dy
      best = { slotId: v.slotId, x: v.pos.x, y: v.pos.y, z: v.pos.z, rot: v.pos.rot }
    }
  }
  return best
}

// ---------------------------------------------------------------
// Visuals
// ---------------------------------------------------------------

function labelFor(v: SlotView): string {
  // design/communal-planters.md: an empty slot holds a system-owned wild bloom, and its
  // plaque says so — "Unclaimed" is the one word that can't be mistaken for a real display.
  if (!v.owner) return 'Unclaimed\ntap to plant here'
  const tier = v.rarityTier > 0 ? rarityTierById(v.rarityTier).name + ' ' : ''
  return `${v.ownerName}\n${tier}${speciesName(v.flower)}`
}

/** Empty slot: a floating gold "?" over the soil — a stand waiting for a flower. Decoration
 *  only, no attribution, removed the instant a player plants here. Root = Y billboard at unit scale;
 *  pop = the pop-in scale; then the bobbing model and a soft glow sprite behind it.
 *  The billboard and the pop scale are on SEPARATE entities on purpose (KJ 2026-10-05): with both on the root the "?" vanished for a
 *  moment on approach and snapped back on mobile, while desktop was fine — an explorer that rebuilds a billboarded entity's
 *  orientation cannot be trusted to keep that same entity's scale, so the billboarded one never carries a scale to lose. */
function setWildBloom(v: SlotView): void {
  const e = engine.addEntity()
  Transform.create(e, { position: { x: v.pos.x, y: v.pos.y + QUESTION_LIFT, z: v.pos.z } })
  Billboard.create(e, { billboardMode: BillboardMode.BM_Y })
  const pop = engine.addEntity()
  Transform.create(pop, { parent: e, scale: { x: 0.001, y: 0.001, z: 0.001 } })   // popped in by questionPopSystem
  const bob = engine.addEntity()
  Transform.create(bob, { parent: pop })
  const model = engine.addEntity()
  Transform.create(model, { parent: bob, position: { x: 0, y: -0.265 * QUESTION_SCALE, z: 0 }, scale: { x: QUESTION_SCALE, y: QUESTION_SCALE, z: QUESTION_SCALE } })
  GltfContainer.create(model, { src: QUESTION_SRC, visibleMeshesCollisionMask: ColliderLayer.CL_NONE, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE })
  const glow = engine.addEntity()
  Transform.create(glow, { parent: bob, position: { x: 0, y: 0, z: 0.12 }, scale: { x: QUESTION_GLOW, y: QUESTION_GLOW, z: QUESTION_GLOW } })
  MeshRenderer.setPlane(glow)
  Material.setPbrMaterial(glow, {
    texture:          Material.Texture.Common({ src: SPARKLE_SRC }),
    alphaTexture:     Material.Texture.Common({ src: SPARKLE_SRC }),
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    albedoColor:      { r: 1, g: 0.72, b: 0.3, a: 0.4 },
    emissiveColor:    { r: 1, g: 0.6, b: 0.2 },
    emissiveIntensity: 1.6,
    castShadows:      false,
  })
  questionKids.set(e, { pop, bob, all: [pop, bob, model, glow] })
  v.plant = e
}

/** Take the "?" and its children down with the root (retirePlant removes only the entity it is handed). */
function removeQuestion(root: Entity): void {
  const kids = questionKids.get(root)
  if (kids === undefined) return
  questionKids.delete(root)
  for (const k of kids.all) engine.removeEntity(k)
}

function setPlantVisual(v: SlotView): void {
  const key = v.owner ? `${v.flower}|${v.rarityTier}` : `wild:${v.slotId}`
  if (key === v.plantKey) return
  v.plantKey = key
  detachPlantVfx(`av:${v.slotId}`)
  // retirePlant (not a bare removeEntity): every Avenue flower is Rare+ and carries the
  // pulse GltfNodeModifiers override, and removing an entity with that still on makes the
  // Unity explorer's ResetMaterialSystem throw on every recall/tidy/replace (2026-09-28).
  if (v.plant !== null) { questionShown.delete(v.plant); removeQuestion(v.plant); retirePlant(v.plant); v.plant = null }
  if (!v.owner) { setWildBloom(v); return }
  const species = plantSpeciesById(v.flower)
  if (!species) return
  const k  = species.scale * AVENUE_FLOWER_SCALE
  const at = slotPoint(v.pos, species.offsetX * AVENUE_FLOWER_SCALE, species.offsetZ * AVENUE_FLOWER_SCALE)
  const e  = engine.addEntity()
  Transform.create(e, { position: { x: at.x, y: v.pos.y + species.baseYOffset * AVENUE_FLOWER_SCALE, z: at.z }, rotation: Quaternion.fromEulerDegrees(0, v.pos.rot, 0), scale: { x: k, y: k, z: k } })
  GltfContainer.create(e, { src: species.modelSrc, visibleMeshesCollisionMask: ColliderLayer.CL_NONE, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE })
  attachPlantVfx(`av:${v.slotId}`, e, species.id, v.rarityTier, { x: v.pos.x, y: v.pos.y, z: v.pos.z })
  v.plant = e
}

/** Pop each empty stand's "?" in as the player nears it (like the plants), and let it go again
 *  once they walk off, so it pops fresh next time. */
function questionPopSystem(dt: number): void {
  questionAccum += dt * 1_000
  if (questionAccum < PLAQUE_SCAN_MS) return
  questionAccum = 0
  const me = Transform.getOrNull(engine.PlayerEntity)?.position
  if (!me) return
  for (const v of views.values()) {
    const e = v.plant
    if (v.owner || e === null || !Transform.has(e)) continue
    const d = Math.hypot(v.pos.x - me.x, v.pos.z - me.z)
    const hide = isSeedMenuOpen()   // (the hide-when-closer-than-3 m rule was removed 2026-10-05: it read as the "?" vanishing on approach)
    const kids = questionKids.get(e)
    if (!kids) continue
    if (!questionShown.has(e) && d <= QUESTION_RANGE_M && !hide) {
      questionShown.add(e)
      Tween.setScale(kids.pop, { x: 0.001, y: 0.001, z: 0.001 }, { x: 1, y: 1, z: 1 }, QUESTION_POP_MS, EasingFunction.EF_EASEOUTBACK)
      Tween.setMove(kids.bob, { x: 0, y: -QUESTION_BOB_M, z: 0 }, { x: 0, y: QUESTION_BOB_M, z: 0 }, QUESTION_BOB_MS, EasingFunction.EF_EASESINE)
      TweenSequence.create(kids.bob, { sequence: [], loop: TweenLoop.TL_YOYO })
    } else if (questionShown.has(e) && (d > QUESTION_RANGE_M + 3 || hide)) {
      questionShown.delete(e)
      Tween.deleteFrom(kids.pop)
      Tween.deleteFrom(kids.bob); TweenSequence.deleteFrom(kids.bob)
      Transform.getMutable(kids.pop).scale = { x: 0.001, y: 0.001, z: 0.001 }
    }
  }
}

function setLabel(v: SlotView, text: string): void {
  if (v.labelText === text) return
  v.labelText = text
  const pl = plaques.find(q => q.slotId === v.slotId)
  if (pl) TextShape.getMutable(pl.sign.text).text = text
}

function refresh(v: SlotView): void {
  setPlantVisual(v)
  setLabel(v, labelFor(v))
}

function placePlaque(pl: Plaque, pos: SlotPos): void {
  const at = outward(pos, PLAQUE_OUT)
  moveSign(pl.sign, { x: at.x, y: pos.y - PLAQUE_DROP, z: at.z })
  Transform.getMutable(pl.sign.root).rotation = Quaternion.fromEulerDegrees(PLAQUE_TILT, (180 + pos.rot) % 360, 0)   // reader stands out in the avenue; pitched to lie on the slope
}
function freePlaque(pl: Plaque): void { pl.slotId = null; moveSign(pl.sign, { x: 0, y: -50, z: 0 }) }

/** Keep the pool on the nearest slots (same scheme as boxSystem's plaqueHomeSystem). */
function plaqueHomeSystem(dt: number): void {
  plaqueAccum += dt * 1_000
  if (plaqueAccum < PLAQUE_SCAN_MS) return
  plaqueAccum = 0
  const me = Transform.getOrNull(engine.PlayerEntity)?.position
  if (!me) return
  const wanted = new Set([...views.values()]
    .map(v => ({ id: v.slotId, d: Math.hypot(v.pos.x - me.x, v.pos.z - me.z) }))
    .filter(r => r.d <= PLAQUE_RANGE_M)
    .sort((a, b) => a.d - b.d)
    .slice(0, PLAQUE_POOL)
    .map(r => r.id))
  for (const pl of plaques) if (pl.slotId !== null && !wanted.has(pl.slotId)) freePlaque(pl)
  for (const id of wanted) {
    if (plaques.some(q => q.slotId === id)) continue
    const pl = plaques.find(q => q.slotId === null)
    const v = views.get(id)
    if (!pl || !v) break
    pl.slotId = id
    placePlaque(pl, v.pos)
    TextShape.getMutable(pl.sign.text).text = v.labelText
  }
}

// ---------------------------------------------------------------
// Tap
// ---------------------------------------------------------------

function onTap(v: SlotView): void {
  console.log(`[Avenue] tap ${v.slotId} (owner ${v.owner ? v.owner.slice(0, 8) + '…' : 'free'}, armed ${getArmedAvenueFlower() ?? 'none'})`)
  if (!v.owner) {
    // 1. A flower armed from the menu goes exactly where they tapped — this is how a
    //    player chooses their own slot.
    const armed = getArmedAvenueFlower()
    if (armed !== null) {
      armAvenuePlacement(null)
      const id = keepsakeIdentity(armed)
      if (id) room.send('displayFlower', { slotId: v.slotId, ...id })
      return
    }
    // 2. Shortcut: holding an ELIGIBLE flower puts it straight in. Holding an ineligible
    //    one used to fire a request the server could only refuse, which read as nothing
    //    happening — now it opens the menu for this slot and says why.
    const held = getHeld()
    const idx  = held ? heldFlowerIndex() : null
    if (held && idx !== null && held.rarityTier >= AVENUE_MIN_TIER) {
      const id = keepsakeIdentity(idx)
      if (id) room.send('displayFlower', { slotId: v.slotId, ...id })
      return
    }
    if (held && idx !== null) showToast(`Your ${speciesName(held.flower)} is a ${rarityTierById(held.rarityTier).name} — the Gallery takes ${rarityTierById(AVENUE_MIN_TIER).name} and up`, TOAST_MS, false)
    openSeedMenuForAvenue(v.slotId)
    return
  }
  const armed = getArmedAvenueFlower()
  if (isMine(v)) {
    // 3. MY OWN stand, with another flower ready (armed from the menu, or an eligible one in hand): swap them in one tap
    //    (KJ 2026-10-05) — the server sends the one on show back to My flowers first. With nothing ready, the card (Recall lives there).
    const held    = getHeld()
    const heldIdx = held ? heldFlowerIndex() : null
    const idx     = armed !== null ? armed : (held && heldIdx !== null && held.rarityTier >= AVENUE_MIN_TIER ? heldIdx : null)
    if (idx !== null) {
      armAvenuePlacement(null)
      const id = keepsakeIdentity(idx)
      if (id) room.send('displayFlower', { slotId: v.slotId, ...id })
      return
    }
    openCard(v)
    return
  }
  if (armed !== null) {
    // 4. SOMEONE ELSE'S stand while placing: it stays theirs. If a stand is free, point at those; if EVERY stand is taken, ask the
    //    server for a place — it frees the stand whose owner has been away longest (never Mythic/Unique, never someone here), or says
    //    the Gallery is full. Before this there was no way to reach that rule: a full Gallery left an armed flower nowhere to go.
    if ([...views.values()].some(s => !s.owner)) { showToast('That stand is taken — tap an empty one (they have a ? over them)', TOAST_MS, false); return }
    armAvenuePlacement(null)
    const id = keepsakeIdentity(armed)
    if (id) room.send('displayFlower', { slotId: '', ...id })
    return
  }
  room.send('inspectAvenue', { slotId: v.slotId })   // a look is someone else stopping by
  openCard(v)
}

let openCardSlot = ''
/** The inspect card — everything this one flower remembers, and a camera move onto it. */
function openCard(v: SlotView): void {
  openCardSlot = v.slotId
  showAvenueCard({
    slotId: v.slotId, ownerName: v.ownerName, flower: v.flower, rarityTier: v.rarityTier,
    since: v.since, grownBy: v.grownBy, openedAt: v.openedAt, helpers: v.helpers,
    giftedBy: v.giftedBy, looks: v.looks, mine: isMine(v),
    at: { x: v.pos.x, y: v.pos.y, z: v.pos.z },
  }, () => { console.log(`[Avenue] recalling ${v.slotId}`); room.send('recallFlower', { slotId: v.slotId }) })
}

function createSlot(p: SlotPos & { id: string }): SlotView {
  const hit = engine.addEntity()
  const c = outward(p, (HIT_SIZE.z - 2 * HIT_BACK) / 2)   // box runs from HIT_BACK behind the soil centre out past the stand's front wall
  Transform.create(hit, { position: { x: c.x, y: p.y + HIT_ABOVE_SOIL - HIT_SIZE.y / 2, z: c.z }, rotation: Quaternion.fromEulerDegrees(0, p.rot, 0), scale: HIT_SIZE })
  MeshCollider.setBox(hit, ColliderLayer.CL_POINTER)   // the wall itself already blocks walking
  const v: SlotView = { slotId: p.id, pos: p, hit, plant: null, plantKey: '', labelText: '', owner: '', ownerName: '', flower: '', rarityTier: 0, since: 0, grownBy: '', openedAt: 0, helpers: [], giftedBy: '', looks: 0 }
  pointerEventsSystem.onPointerDown(
    { entity: hit, opts: { button: InputAction.IA_POINTER, hoverText: 'Gallery stand', maxDistance: TAP_DISTANCE } },
    () => onTap(v),
  )
  return v
}

// ---------------------------------------------------------------
// Setup — MUST be called after wateringSystem's room.clear()
// ---------------------------------------------------------------

export function setupAvenueSystem(): void {
  if (AVENUE_POSITIONS.length === 0) return
  for (let i = 0; i < PLAQUE_POOL; i++) plaques.push({ sign: createSign({ x: 0, y: -50, z: 0 }, 0, PLAQUE_SIZE, PLAQUE_FONT, false), slotId: null })   // no backing panel: outlined text on the stand's own star panel
  for (const p of AVENUE_POSITIONS) views.set(p.id, createSlot(p))

  room.onMessage('avenueState', (data) => {
    const v = views.get(data.slotId)
    if (!v) return
    const live     = synced.has(v.slotId)
    const wasOwned = !!v.owner
    const wasMine  = isMine(v)
    synced.add(v.slotId)
    v.owner = data.owner; v.ownerName = data.ownerName
    v.flower = data.flower; v.rarityTier = data.rarityTier; v.since = Number(data.since)
    v.grownBy = data.grownBy; v.openedAt = Number(data.openedAt); v.giftedBy = data.giftedBy; v.looks = data.looks
    try { v.helpers = JSON.parse(data.helpersJson) } catch { v.helpers = [] }
    refresh(v)
    if (isAvenueCardOpen() && openCardSlot === v.slotId) { if (v.owner) openCard(v); else closeAvenueCard() }
    const at = { x: v.pos.x, y: v.pos.y, z: v.pos.z }
    if (live && !wasOwned && v.owner) { playSfx('plant', at); if (isMine(v)) armAvenuePlacement(null) }
    if (live && wasMine && !v.owner) playSfx('harvest')
  })

  registerAvenueApi({
    display: (slotId, flowerIndex) => { const id = keepsakeIdentity(flowerIndex); if (id) room.send('displayFlower', { slotId, ...id }) },
    recall:  (slotId) => room.send('recallFlower', { slotId }),
  })
  engine.addSystem(plaqueHomeSystem)
  engine.addSystem(questionPopSystem)
  console.log(`[Avenue] ${views.size} slots ready · avenueState listeners=${room.listenerCount('avenueState')}`)
}

// ---------------------------------------------------------------
// Admin test tools (test panel only — see testPanel.tsx)
// ---------------------------------------------------------------

/** Fill empty Avenue slots with real, persisted, Rare+ flowers so the Avenue can be
 *  playtested without a genuine harvest chain. count 0/omitted = the server's default. */
export function adminFillAvenue(count = 8): void { room.send('adminFillAvenue', { count }) }
/** Empty every Avenue slot the admin filled with adminFillAvenue — never touches a real
 *  player's display (server-enforced: only the admin's own slots). */
export function adminClearAvenue(): void { room.send('adminClearAvenue', {}) }
