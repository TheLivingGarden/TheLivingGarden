// =============================================================
// Bloom Garden v2 — Seed Boxes (CLIENT ONLY, greybox)
//
// GDD §3 step 4 / §4.1 / §4.3 "seed appointment": tap an empty box to
// plant a caught seed; the box takes your name and grows on a real-world
// timer; when it opens, the mystery flower is revealed. This is the D1
// return hook, so the box, its name, its sprout and its countdown must all
// be visible in the shared garden — to everyone.
//
// Real planter model + an animated balloon (both KJ's Blender exports) while the box
// holds a seed or an unharvested flower: KJ's seedling while growing, the real species
// model once opened (rarity effects in plantVfx.ts).
//
// Server communication (server is authoritative; the client only requests):
//   send    →  plantSeed   { boxId, rarityTier }   empty box
//   send    →  harvestBox  { boxId }              my opened box  (Phase 4)
//   send    →  waterBox    { boxId }              someone else's growing box (Phase 4)
//   receive ←  boxState    { boxId, owner, ownerName, rarityTier, plantedAt, opensAt, serverNow, opened, flower, waters, lastWaterer }
//   receive ←  pouchUpdate { countsJson }   (my own seed counts, one per rarity tier)
// One world tap per box; what it does depends on whose box it is and its state.
// `flower` is a PLANT_SPECIES id once opened — the harvest-time mystery, independent
// of rarityTier (fixed at planting, visible the whole time like a DCL wearable's rarity).
// =============================================================

import {
  engine,
  Entity,
  tweenSystem,
  Transform,
  MeshRenderer,
  Material,
  MaterialTransparencyMode,
  GltfContainer,
  GltfNodeModifiers,
  ColliderLayer,
  MeshCollider,
  TextShape,
  Name,
  TextAlignMode,
  PointerEvents,
  pointerEventsSystem,
  InputAction,
  Animator,
  Tween,
  TweenSequence,
  GltfContainerLoadingState,
  EasingFunction,
  Billboard, BillboardMode,
  timers, VisibilityComponent } from '@dcl/sdk/ecs'
import { Quaternion } from '@dcl/sdk/math'
import { isMobile } from '@dcl/sdk/platform'
import { BALLOON_TEXT_TRACK } from './balloonTextTrack'
import { getPlayer } from '@dcl/sdk/players'
import { room } from './shared/messages'
import { PROP_LAYOUT } from './shared/layout'
import { BOX_POSITIONS, ALMANAC_MILESTONES, STAMP_MILESTONES, BOX_CAP_DEFAULT, BOX_CAP_MAX, TEND_COOLDOWN_MS, BOX_WATER_MAX, WATER_DROP_MODEL_SRC, BOX_MODEL_SRC, BOX_MODEL_SCALE, BOX_MODEL_RIM_Y, BED_FILL_ORIGIN, BEDS_EXPLICIT, growMsForTier, growStageOf, tendsAvailable, BALLOON_MODEL_SRC, BALLOON_ANIMATED_SRC, BALLOON_ANIM_CLIPS, SEED_MODEL_HEIGHT, seedModelSrc, SEEDLING_MODEL_SRC_NORMAL, SEEDLING_MODEL_SRC_RARE, rarityTierById, plantSpeciesById, withArticle } from './shared/config'
import { showToast } from './notifications'
import { makeBeds, bedOwner, checkPlant, Bed } from './shared/beds'
import { attachPlantVfx, attachSeedlingVfx, detachPlantVfx, setupPlantVfx } from './plantVfx'
import { setupGiftSystem } from './giftSystem'
import { showDiscovery } from './discoveryCard'
import { registerStreamSource } from './streaming'
import { triggerSparkle } from './sparkleSystem'
import { openSeedMenuForPlanter } from './seedMenu'
import { setPouch, getBoxCap, isBoxCapKnown, nextSeedTier } from './playerInventory'
import { createSign, moveSign, setupSignSystem, Sign } from './signs'
import { playSfx } from './sounds'
import { playWateringBeat, isWateringEmoteActive } from './wateringSystem'
import { beginHold, isHolding } from './skillCheck'

// ---------------------------------------------------------------
// Config (greybox visuals)
// ---------------------------------------------------------------

// Text on the planter's own light wooden board (planterBox.glb node Cube.012: centre y 0.988, front face z≈1.048 — × BOX_MODEL_SCALE here).
// Readers stand on +Z. KJ 2026-09-25: "the planter text needs to be much bigger, to be legible on mobile" — the floating-tag attempt covered
// the balloons and the bed sign, so the text stays ON the planter. The board itself is only ~0.55 x 0.18 m, but the crate's front face around it
// is ~1.08 m wide, so the text (with its dark outline) is allowed to spill past the board: ~1 m wide, font ~2.4x the old 0.4.
const PLAQUE_OFFSET_Z = 1.055 * BOX_MODEL_SCALE
const PLAQUE_Y        = 0.988 * BOX_MODEL_SCALE
const PLAQUE_SIZE     = { w: 1.05, h: 0.40 }
const PLAQUE_FONT     = 0.95   // TUNING — ~0.05 m per character per unit: 17 chars per line across 0.97 m, two lines
// Plaques are POOLED: signs.ts only ever shows the nearest 8 within 9 m, so 96 per-box
// plaques meant 88 hidden text entities (+ a 96-text rewrite on every pouch update).
// PLAQUE_POOL plaques re-home to the nearest planters instead (same idea as the 100-pot test).
const PLAQUE_POOL     = 8
const PLAQUE_RANGE_M  = 12     // a bit beyond signs.ts' 9 m show range, so a plaque is in place before it fades in
const PLAQUE_SCAN_MS  = 400
const SEEDLING_SCALE = 0.25
const SEEDLING_MODEL_MIN_Y = 1.15   // seedling.glb's geometry starts 1.15 above its origin
// Balloon countdown, in the balloon GLB's own space (the entity carries BOX_MODEL_SCALE).
// Static balloon (KJ 2026-09-29): one un-skinned mesh in its raised pose, so EVERY planted planter shows a
// balloon at the right height and nothing animates — no clip, no Tweens, no per-frame write-back.
const BALLOON_TEXT_POS  = { x: -0.011, y: 2.816, z: -0.29 }
const BALLOON_TEXT_FONT = 0.8   // TUNING — must fit inside the balloon's dark disc
const BALLOON_TEXT_COLOR = { r: 1.0, g: 0.95, b: 0.82, a: 1 }
const FLOWER_SCALE  = 0.5   // fallback sphere size, only used if a species id isn't found
const TOAST_MS      = 5_000
const LABEL_TICK_MS = 1_000
// const enums in @dcl/ecs internals, not re-exported (same as plantVfx's particle enums)
const LS_FINISHED = 4   // LoadingState
const EF_LINEAR   = 0   // EasingFunction
const TL_RESTART  = 0   // TweenLoop
const TAP_DISTANCE  = 8     // m — mobile is third-person only, camera sits well behind the avatar

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------

interface BoxView {
  boxId:        string
  base:         Entity
  hit:          Entity          // tap target + walk blocker: the base itself (the model's own collider mesh), or a box-collider child when PLANTER_USE_MODEL_COLLIDER is off
  labelText:    string          // what this box's plaque says — shown by a pooled plaque when near
  plant:        Entity | null   // sprout or flower entity while planted
  plantKey:     string          // what `plant` currently shows — rebuilt only when this changes
  balloon:      Entity | null   // animated balloon while the box holds a seed or flower
  balloonText:  Entity | null   // countdown / "Ready to Harvest" on the balloon
  animSlot:     number          // index into balloonPool while an animated balloon stands in for the static one, else -1
  owner:        string
  ownerName:    string
  rarityTier:   number
  opened:       boolean
  flower:       string
  opensLocalAt: number          // local-clock ms; derived from opensAt − serverNow
  waters:       number
  lastWaterer:  string
  drop:         Entity | null   // water-drop marker: a growing seed of someone else's that I can still help
  stage:        number          // growth stage shown by the seedling (0..GROW_STAGES.length-1), only ever rises
  tends:        number          // times the owner has tended this seedling (server-confirmed), one allowed per stage
  plantedAt:    number          // epoch ms the seed went in — a bed's owner is whoever planted first in it
}

const views  = new Map<string, BoxView>()

// ---------------------------------------------------------------
// Beds (shared/beds.ts): two planters that belong to whoever planted in them. Derived from the baked layout
// (BOX_POSITIONS) so the client and the server compute the same beds; owners come from the planters themselves.
// ---------------------------------------------------------------
/** A planter's height off the strip floor: the field is terraced (BOX_POSITIONS `y`, absent = 0). */
const ly = (p: { y?: number } | undefined): number => p?.y ?? 0

const beds: Bed[] = makeBeds(BOX_POSITIONS, BED_FILL_ORIGIN, BEDS_EXPLICIT)
function bedInfo(id: string): { owner: string; ownerName: string; plantedAt: number } | undefined {
  const v = views.get(id)
  return v && v.owner ? { owner: v.owner.toLowerCase(), ownerName: v.ownerName, plantedAt: v.plantedAt } : undefined
}
const bedByBox = new Map<string, Bed>()
for (const b of beds) for (const id of b.boxIds) bedByBox.set(id, b)
function bedOwnerOfBox(boxId: string): { owner: string; ownerName: string; plantedAt: number } | null {
  const b = bedByBox.get(boxId)
  return b ? bedOwner(b, bedInfo) : null
}
/** The free planters I should be pointed at: my own bed's spare planters, else the lowest-numbered free bed's. Null = no steer. */
function steeredFreeBoxes(): Set<string> | null {
  const me = localId()
  const free = (id: string) => { const v = views.get(id); return !!v && !v.owner && !deleted.has(id) }
  const mine = beds.filter(b => bedOwner(b, bedInfo)?.owner === me).flatMap(b => b.boxIds).filter(free)
  if (mine.length > 0) return new Set(mine)
  // Nothing spare in my beds: the free bed nearest my existing ones (a bigger gardener's planters stay together), else the lowest-numbered.
  const myBeds = beds.filter(b => bedOwner(b, bedInfo)?.owner === me)
  const freeBeds = beds.filter(b => bedOwner(b, bedInfo) === null && b.boxIds.some(free))
  const near = (b: Bed) => myBeds.length === 0 ? 0 : Math.min(...myBeds.map(m => Math.hypot(m.cx - b.cx, m.cz - b.cz)))
  const freeBed = freeBeds.reduce<Bed | null>((best, b) => best === null || near(b) < near(best) ? b : best, null)
  return freeBed ? new Set(freeBed.boxIds.filter(free)) : null
}
/** Live planter layout: BOX_POSITIONS, as edited in preview by the planter editor
 *  (planterLayoutTool). Everything positions planters from HERE, never BOX_POSITIONS. */
const layout   = new Map<string, PlanterPos>()
const deleted  = new Set<string>()   // removed in the editor (hidden until the next bake)
const carrying = new Set<string>()   // being carried by the editor — plant rebuilt on drop
const synced   = new Set<string>()   // boxes that have had their first boxState (join sync) — no sounds for that one
let   pouch: number[] = []   // counts per rarity tier, from pouchUpdate
let   tickAccum = 0

/** Onboarding (Phase 2): the free planter nearest a point, and where it stands right
 *  now — `layout`, not BOX_POSITIONS, because the planter editor can have moved it.
 *  Null when every planter is taken. */
export function nearestFreePlanter(from: { x: number; z: number }): { boxId: string; x: number; z: number; rot: number; y: number } | null {
  let best: { boxId: string; x: number; z: number; rot: number; y: number } | null = null
  let bestSq = Infinity
  const steer = steeredFreeBoxes()   // beds: point at my own bed first, else the lowest-numbered free bed
  for (const v of views.values()) {
    if (v.owner || deleted.has(v.boxId)) continue
    if (steer && steer.size > 0 && !steer.has(v.boxId)) continue
    const p = layout.get(v.boxId)
    if (!p) continue
    const dx = p.x - from.x
    const dz = p.z - from.z
    const sq = dx * dx + dz * dz
    if (sq < bestSq) { bestSq = sq; best = { boxId: v.boxId, x: p.x, z: p.z, rot: p.rot, y: ly(p) } }
  }
  return best
}

/** Onboarding (stage 4): EVERY planter of mine holding an opened, unharvested flower,
 *  nearest first. All of them, not just the nearest — a gardener at the planter cap can
 *  have several standing open and wants to find them all (Fin 2026-09-21: "we wanted 2
 *  and had 1 when we were looking for our plants"). */
export function myOpenedPlanters(from: { x: number; z: number }): { boxId: string; x: number; z: number; rot: number; y: number }[] {
  const mine: { boxId: string; x: number; z: number; rot: number; y: number; sq: number }[] = []
  for (const v of views.values()) {
    if (!isMine(v) || !v.opened || deleted.has(v.boxId)) continue
    const p = layout.get(v.boxId)
    if (!p) continue
    const dx = p.x - from.x
    const dz = p.z - from.z
    mine.push({ boxId: v.boxId, x: p.x, z: p.z, rot: p.rot, y: ly(p), sq: dx * dx + dz * dz })
  }
  mine.sort((a, b) => a.sq - b.sq)
  return mine.map(m => ({ boxId: m.boxId, x: m.x, z: m.z, rot: m.rot, y: m.y }))
}

/** The nearest of them — the one the tutorial trail points at. */
export function myOpenedPlanter(from: { x: number; z: number }): { boxId: string; x: number; z: number; rot: number; y: number } | null {
  return myOpenedPlanters(from)[0] ?? null
}

/** EVERY planter I own, growing or opened — the always-on highlight (onboarding.ts) uses
 *  this so a returning player can find their own planters among 50+ look-alikes at any
 *  time, not just during the first-time tutorial (KJ 2026-09-22: "impossible to find"). */
export function myPlanters(from: { x: number; z: number }): { boxId: string; x: number; z: number; rot: number; y: number }[] {
  const mine: { boxId: string; x: number; z: number; rot: number; y: number; sq: number }[] = []
  for (const v of views.values()) {
    if (!isMine(v) || deleted.has(v.boxId)) continue
    const p = layout.get(v.boxId)
    if (!p) continue
    const dx = p.x - from.x
    const dz = p.z - from.z
    mine.push({ boxId: v.boxId, x: p.x, z: p.z, rot: p.rot, y: ly(p), sq: dx * dx + dz * dz })
  }
  mine.sort((a, b) => a.sq - b.sq)
  return mine.map(m => ({ boxId: m.boxId, x: m.x, z: m.z, rot: m.rot, y: m.y }))
}

/** Perf test (potStressTest): hide/show every planter — base, plant, balloon and plaque —
 *  so its cost can be measured against a frame rate instead of estimated from tri counts. */
export function setAllPlantersVisible(visible: boolean): void {
  for (const v of views.values()) {
    for (const e of [v.base, v.plant, v.balloon, v.balloonText]) {
      if (e === null || e === undefined) continue
      if (VisibilityComponent.has(e)) VisibilityComponent.getMutable(e).visible = visible
      else VisibilityComponent.create(e, { visible })
    }
  }
}

/** Where one planter stands, for the highlight shell to sit exactly on it. Null once
 *  the planter is taken or deleted — the caller should stop pointing at it. */
export function freePlanterPos(boxId: string): { x: number; z: number; rot: number; y: number } | null {
  const v = views.get(boxId)
  if (!v || v.owner || deleted.has(boxId)) return null
  const p = layout.get(boxId)
  return p ? { x: p.x, z: p.z, rot: p.rot, y: ly(p) } : null
}

function localId(): string { return (getPlayer()?.userId ?? '').toLowerCase() }
function isMine(v: BoxView): boolean { return !!v.owner && v.owner.toLowerCase() === localId() }
/** For the idle guide (onboarding.ts): how many of MY seeds are still growing, and the
 *  soonest opening in ms. */
export function myGrowingStatus(): { count: number; nextMs: number } {
  const now = Date.now()
  let count = 0, nextMs = Infinity
  for (const v of views.values()) if (isMine(v) && !v.opened) { count++; nextMs = Math.min(nextMs, Math.max(0, v.opensLocalAt - now)) }
  return { count, nextMs }
}
export function myPlanterCount(): number { return myBoxCount() }
/** Tutorial: every tend I have given my own seedlings (server-confirmed, summed) — the step
 *  watches it rise rather than trusting a one-off flag, so a replay works too. */
export function myTendsTotal(): number { let n = 0; for (const v of views.values()) if (isMine(v)) n += v.tends; return n }
/** Tutorial: the centre of the bed I own, or null if I have none yet. */
export function myBedCentre(): { x: number; z: number; y: number } | null {
  const me = localId()
  const b = beds.find(b => bedOwner(b, bedInfo)?.owner === me)
  return b ? { x: b.cx, z: b.cz, y: ly(layout.get(b.boxIds[0])) } : null
}
function myBoxCount(): number { let n = 0; for (const v of views.values()) if (isMine(v)) n++; return n }

// ---------------------------------------------------------------
// Visuals
// ---------------------------------------------------------------

function flowerName(v: BoxView): string { return plantSpeciesById(v.flower)?.name ?? v.flower }

/** Board text. The grow timer is on the bed sign (bedTimerLine); the balloon is only for ready planters. */
/** Short lines only, so the big font fits on the planter's front: the OWNER is on the bed sign, so it is left out unless this planter sits in someone else's bed. */
function labelFor(v: BoxView): string {
  if (!v.owner) {
    const have = pouch.reduce((a, b) => a + b, 0)
    return have > 0 ? `Tap to plant\n${have} seeds` : 'Empty planter\nno seeds yet'
  }
  const tierName = rarityTierById(v.rarityTier).name
  const bedOwnerInfo = bedOwnerOfBox(v.boxId)
  const spill = bedOwnerInfo && bedOwnerInfo.owner !== v.owner.toLowerCase() && v.ownerName ? `${v.ownerName}'s\n` : ''
  if (v.opened) return `${spill}${flowerName(v)}${v.rarityTier > 0 ? `\n${tierName}` : ''}`
  const watered = v.waters > 0 ? `\nwatered x${v.waters}` : ''
  return `${spill}${v.rarityTier > 0 ? `${tierName} ` : ''}seed${watered}`
}

/** Minutes → "2h 05m" / "12m" (the bed sign's timer line; minute resolution, so the sign text changes once a minute). */
function fmtMins(mins: number): string {
  if (mins <= 0) return 'opening…'
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m` : `${mins}m`
}

/** The bed sign's third line (KJ 2026-10-02: the timer belongs on the sign by the name, not on the planter's board where it can't be read). */
function bedTimerLine(bed: Bed, now: number): string {
  let ready = 0, soonest = Infinity
  for (const id of bed.boxIds) {
    const v = views.get(id)
    if (!v || !v.owner) continue
    if (v.opened) ready++
    else soonest = Math.min(soonest, Math.ceil(Math.max(0, v.opensLocalAt - now) / 60_000))
  }
  if (soonest === Infinity) return ready > 0 ? 'ready to harvest' : ''
  return ready > 0 ? `${ready} ready · next ${fmtMins(soonest)}` : `ready in ${fmtMins(soonest)}`
}

function countdown(v: BoxView, now: number): string {
  const left = Math.max(0, v.opensLocalAt - now)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(Math.floor(left / 3_600_000))}:${pad(Math.floor((left % 3_600_000) / 60_000))}:${pad(Math.floor((left % 60_000) / 1_000))}`
}

function balloonTextFor(v: BoxView, now: number): string {
  return v.opened ? 'Ready to\nHarvest' : `Harvest in\n${countdown(v, now)}`
}

/** Hover prompt for the one tap the box currently offers. */
function hoverFor(v: BoxView): string {
  if (!v.owner) return 'Plant seed'
  if (isMine(v)) return v.opened ? 'Harvest' : tendReady(v, Date.now()) ? 'Hold to water' : tendCooling(v, Date.now()) ? 'Watered…' : 'Growing…'
  if (v.opened) return `${v.ownerName}'s flower`
  return v.waters >= BOX_WATER_MAX ? 'Fully watered' : wateredByMe.has(v.boxId) ? 'Watered…' : 'Water'
}

/** A pulsing flower carries a GltfNodeModifiers material override. Removing the entity
 *  with the override still on makes the Unity explorer's ResetMaterialSystem restore
 *  materials on a GLB it is already destroying (same error as the old balloon removal),
 *  so drop the override first, hide it, and remove the entity once that has settled. */
const PLANT_RETIRE_MS = 1_000
export function retirePlant(e: Entity): void {
  if (!GltfNodeModifiers.has(e)) { engine.removeEntity(e); return }
  GltfNodeModifiers.deleteFrom(e)
  Transform.getMutable(e).scale = { x: 0, y: 0, z: 0 }
  timers.setTimeout(() => engine.removeEntity(e), PLANT_RETIRE_MS)
}

type PlanterPos = { x: number; z: number; rot: number; y?: number }

/** A point given in the planter's own frame (lx right, lz front) → world x/z. Same
 *  convention as Quaternion.fromEulerDegrees(0, rot, 0): rot 90 turns the front to +x. */
function planterPoint(pos: PlanterPos, lx: number, lz: number): { x: number; z: number } {
  const r = (pos.rot * Math.PI) / 180
  return { x: pos.x + lx * Math.cos(r) + lz * Math.sin(r), z: pos.z - lx * Math.sin(r) + lz * Math.cos(r) }
}
const planterRotation = (pos: PlanterPos) => Quaternion.fromEulerDegrees(0, pos.rot, 0)

function setPlantVisual(v: BoxView, pos: PlanterPos): void {
  detachPlantVfx(v.boxId)
  if (v.plant !== null) { retirePlant(v.plant); v.plant = null }
  if (!v.owner) return
  const e = engine.addEntity()

  if (!v.opened) {
    // Growing: KJ's seedling model — only a normal/rare tint is baked into art so
    // far (SEEDLING_MODEL_SRC_NORMAL/_RARE), so tier 0 (Common) gets normal and
    // everything above it borrows the rare variant until per-tier seedling art exists.
    v.stage = stageFor(v, Date.now())
    const k = SEEDLING_SCALE * GROW_STAGES[v.stage].scale
    Transform.create(e, { position: { x: pos.x, y: ly(pos) + BOX_MODEL_RIM_Y - SEEDLING_MODEL_MIN_Y * k, z: pos.z }, rotation: planterRotation(pos), scale: { x: k, y: k, z: k } })
    const src = v.rarityTier > 0 ? SEEDLING_MODEL_SRC_RARE : SEEDLING_MODEL_SRC_NORMAL
    GltfContainer.create(e, { src, visibleMeshesCollisionMask: ColliderLayer.CL_NONE, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE })
    GltfNodeModifiers.create(e, { modifiers: [{ path: '', castShadows: false }] })   // (plantVfx re-supplies this when it takes the node over)
    attachSeedlingVfx(v.boxId, e, v.rarityTier)   // tier pulse while growing (Rare and up)
    v.plant = e
    return
  }

  // Opened: the real species model, normalised from its own geometry (PLANT_SPECIES
  // scale/offsets); rarity effects are layered on by plantVfx.
  const species = plantSpeciesById(v.flower)
  if (species) {
    const at = planterPoint(pos, species.offsetX, species.offsetZ)   // footprint-centring offset turns with the planter
    Transform.create(e, { position: { x: at.x, y: ly(pos) + BOX_MODEL_RIM_Y + species.baseYOffset, z: at.z }, rotation: planterRotation(pos), scale: { x: species.scale, y: species.scale, z: species.scale } })
    GltfContainer.create(e, { src: species.modelSrc, visibleMeshesCollisionMask: ColliderLayer.CL_NONE, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE })
    GltfNodeModifiers.create(e, { modifiers: [{ path: '', castShadows: false }] })
    attachPlantVfx(v.boxId, e, species.id, v.rarityTier, { x: pos.x, y: ly(pos) + BOX_MODEL_RIM_Y, z: pos.z })
  } else {
    // Species id not in the catalog (shouldn't happen) — fall back to a tinted sphere.
    const k = FLOWER_SCALE
    Transform.create(e, { position: { x: pos.x, y: ly(pos) + BOX_MODEL_RIM_Y + k / 2, z: pos.z }, scale: { x: k, y: k, z: k } })
    MeshRenderer.setSphere(e)
    const c = rarityTierById(v.rarityTier).seedColor
    Material.setPbrMaterial(e, { albedoColor: { ...c, a: 1 }, emissiveColor: c, emissiveIntensity: 0.8 })
  }
  v.plant = e
}

/** One pooled balloon per box, created the first time the box is planted and never removed —
 *  shown/hidden by scale. Removing it made the Unity explorer's ResetMaterialSystem throw on harvest
 *  (KJ log 2026-09-18), and every replant re-loaded the GLB. It is a STATIC mesh (StaticBalloon.glb,
 *  2026-09-29): the old skinned, animated balloon needed a clip and two looping Tweens per box, and
 *  the explorer writes every looping-tweened Transform back to the scene each frame — 96 of them held
 *  the tick at ~13 fps, so only the nearest 8 were allowed to move and the rest sagged low under text
 *  that stayed up high. Static = every balloon at the right height, zero per-frame cost. */
function setBalloonVisual(v: BoxView, pos: PlanterPos): void {
  if (!v.owner || !v.opened) { if (v.balloon !== null) hideBalloon(v); return }   // a balloon means READY; the grow timer is on the board (labelFor)
  if (v.balloon === null) createBalloon(v, pos)
  const tr = Transform.getMutable(v.balloon!)
  const k = v.animSlot >= 0 ? 0 : BOX_MODEL_SCALE   // an animated balloon is standing in — keep the static one hidden
  if (tr.scale.x !== k) tr.scale = { x: k, y: k, z: k }
}

function hideBalloon(v: BoxView): void {
  if (v.animSlot >= 0) releaseSlot(v)
  if (v.balloon === null) return
  const tr = Transform.getMutable(v.balloon)
  if (tr.scale.x !== 0) tr.scale = { x: 0, y: 0, z: 0 }
}

function createBalloon(v: BoxView, pos: PlanterPos): void {
  const balloon = engine.addEntity()
  Transform.create(balloon, { position: { x: pos.x, y: ly(pos), z: pos.z }, rotation: planterRotation(pos), scale: { x: 0, y: 0, z: 0 } })
  GltfContainer.create(balloon, { src: BALLOON_MODEL_SRC, visibleMeshesCollisionMask: ColliderLayer.CL_NONE, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE })
  GltfNodeModifiers.create(balloon, { modifiers: [{ path: '', castShadows: false }] })   // 96 balloons: no shadow pass (KJ 2026-10-01 perf pass)
  // The countdown / "Ready to Harvest" text rides on the balloon's dark disc, facing out.
  const text = engine.addEntity()
  Transform.create(text, { parent: balloon, position: BALLOON_TEXT_POS, rotation: Quaternion.fromEulerDegrees(0, 180, 0) })
  TextShape.create(text, { text: balloonTextFor(v, Date.now()), fontSize: BALLOON_TEXT_FONT, textColor: BALLOON_TEXT_COLOR, textAlign: TextAlignMode.TAM_MIDDLE_CENTER })
  v.balloon = balloon
  v.balloonText = text
}

/** Everything setPlantVisual depends on. boxState arrives on every watering too, and the
 *  plant (GLB + rarity VFX) used to be torn down and rebuilt each time. */
function plantKeyFor(v: BoxView): string {
  return v.owner ? `${v.owner}|${v.opened}|${v.flower}|${v.rarityTier}` : ''
}

/** Boxes whose plant must be (re)built. One per frame, nearest to the player first, so a
 *  join sync (all 8 boxes in one tick) doesn't instantiate every GLB + emitter at once. */
const pendingPlant = new Set<BoxView>()
function plantRevealSystem(): void {
  if (pendingPlant.size === 0) return
  const me = Transform.getOrNull(engine.PlayerEntity)?.position
  let best: BoxView | null = null, bestD = Infinity
  for (const v of pendingPlant) {
    if (carrying.has(v.boxId)) continue
    const p = layout.get(v.boxId)!
    const d = me ? (p.x - me.x) ** 2 + (p.z - me.z) ** 2 : 0
    if (d < bestD) { bestD = d; best = v }
  }
  if (best === null) return
  pendingPlant.delete(best)
  setPlantVisual(best, layout.get(best.boxId)!)
  best.plantKey = plantKeyFor(best)
  if (popIn.delete(best.boxId) && best.plant !== null && Transform.has(best.plant)) {
    const to = { ...Transform.get(best.plant).scale }
    Tween.setScale(best.plant, { x: 0.001, y: 0.001, z: 0.001 }, to, POP_MS, EasingFunction.EF_EASEOUTBACK)
  }
}

// ---------------------------------------------------------------
// Plant / reveal sequences. Until now planting swapped the model instantly and opening
// was just the discovery card. Now: seed drops in → seedling pops up; on opening the
// seedling swells, bursts, the flower pops out, THEN the card. `held` keeps refresh()
// from swapping the visual while a beat is still playing; `popIn` scales the next-built
// plant up from nothing. Client-only, live events only (never the join snapshot).
// ---------------------------------------------------------------

const held  = new Set<string>()
const popIn = new Set<string>()
const SEED_DROP_MS   = 550
const SEED_DROP_H    = 1.6    // m above the rim the seed falls from
const SEED_WORLD_H   = 0.3    // m — the falling seed's size
const SWELL_MS       = 1100   // seedling swells before it opens
const SWELL_MULT     = 1.3
const POP_MS         = 650
const CARD_AFTER_MS  = 900    // discovery card lands once the flower has mostly popped

function releaseHold(v: BoxView): void {
  held.delete(v.boxId)
  pendingPlant.add(v)
}

function playPlantBeat(v: BoxView): void {
  const pos = layout.get(v.boxId)
  if (!pos) return
  held.add(v.boxId)
  const seed = engine.addEntity()
  const k = SEED_WORLD_H / SEED_MODEL_HEIGHT
  const rim = ly(pos) + BOX_MODEL_RIM_Y + 0.15
  Transform.create(seed, { position: { x: pos.x, y: rim + SEED_DROP_H, z: pos.z }, scale: { x: k, y: k, z: k } })
  GltfContainer.create(seed, { src: seedModelSrc(v.rarityTier), visibleMeshesCollisionMask: ColliderLayer.CL_NONE, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE })
  Tween.setMove(seed, { x: pos.x, y: rim + SEED_DROP_H, z: pos.z }, { x: pos.x, y: rim, z: pos.z }, SEED_DROP_MS, EasingFunction.EF_EASEINQUAD)
  timers.setTimeout(() => {
    engine.removeEntity(seed)
    playSfx('plant', { x: pos.x, y: 1, z: pos.z })
    popIn.add(v.boxId)
    releaseHold(v)
  }, SEED_DROP_MS)
}

function playRevealBeat(v: BoxView): void {
  const pos = layout.get(v.boxId)
  if (!pos) return
  held.add(v.boxId)
  if (isMine(v)) showDiscovery(v.flower, v.rarityTier, SWELL_MS + CARD_AFTER_MS, v.boxId)   // state snapshotted now, shown after the beat
  if (v.plant !== null && Transform.has(v.plant)) {
    const k = Transform.get(v.plant).scale.x
    Tween.setScale(v.plant, { x: k, y: k, z: k }, { x: k * SWELL_MULT, y: k * SWELL_MULT, z: k * SWELL_MULT }, SWELL_MS, EasingFunction.EF_EASEINSINE)
  }
  timers.setTimeout(() => {
    triggerSparkle({ x: pos.x, y: ly(pos) + BOX_MODEL_RIM_Y, z: pos.z })
    playSfx('flowerOpen', { x: pos.x, y: 1, z: pos.z })
    popIn.add(v.boxId)
    releaseHold(v)
  }, SWELL_MS)
}

// Week-2 playtest 2026-09-22 ("add a water drop icon"): the same marker the garden plants
// carry, on any growing seed a visitor can still help. Not my own (I cannot water it), not
// one I already watered this session (the server would refuse — after a rejoin it just
// toasts, since boxState does not carry the waterer list). Bounded by players x planter cap.
const wateredByMe = new Set<string>()   // boxIds I watered this session, client-side only
const SEEDLING_DROP_Y = 0.5             // above the rim, like WATER_DROP_Y over a garden plant (KJ 2026-10-05: 0.3 m lower, was 0.8)

/** My own seedling has reached a stage I have not yet tended (tending = the owner's water, once per stage). */
const lastTendLocal = new Map<string, number>()   // boxId → when I last tended it (TEND_COOLDOWN_MS)
function tendCooling(v: BoxView, now: number): boolean { return now - (lastTendLocal.get(v.boxId) ?? 0) < TEND_COOLDOWN_MS }
function tendReady(v: BoxView, now: number): boolean {
  return isMine(v) && !!v.owner && !v.opened && !tendCooling(v, now) && tendsAvailable(v.opensLocalAt, now, v.rarityTier, v.tends) > 0
}
function wantsDrop(v: BoxView): boolean {
  if (!v.owner || v.opened) return false
  if (isMine(v)) return tendReady(v, Date.now())
  return v.waters < BOX_WATER_MAX && !wateredByMe.has(v.boxId)
}
function removeSeedlingDrop(v: BoxView): void {
  if (v.drop === null) return
  engine.removeEntity(v.drop)
  v.drop = null
}
function setSeedlingDrop(v: BoxView, pos: PlanterPos): void {
  if (!wantsDrop(v)) { removeSeedlingDrop(v); return }
  if (v.drop !== null) return
  const e = engine.addEntity()
  Transform.create(e, { position: { x: pos.x, y: ly(pos) + BOX_MODEL_RIM_Y + SEEDLING_DROP_Y, z: pos.z } })
  GltfContainer.create(e, { src: WATER_DROP_MODEL_SRC, visibleMeshesCollisionMask: ColliderLayer.CL_NONE, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE })
  Animator.create(e, { states: [{ clip: 'Bob', playing: true, loop: true, speed: 0.85 + Math.random() * 0.3 }] })
  v.drop = e
}

function refresh(v: BoxView): void {
  if (deleted.has(v.boxId)) return   // removed in the layout editor — stays hidden until the bake
  const pos = layout.get(v.boxId)!
  if (plantKeyFor(v) !== v.plantKey && !held.has(v.boxId)) pendingPlant.add(v)   // built by plantRevealSystem
  setSeedlingDrop(v, pos)
  setBalloonVisual(v, pos)
  if (v.balloonText !== null) setBalloonText(v, Date.now())
  setLabel(v, labelFor(v))
  const pe = PointerEvents.getMutableOrNull(v.hit)?.pointerEvents[0]?.eventInfo
  if (pe) pe.hoverText = hoverFor(v)
}

// ---------------------------------------------------------------
// Planting (world tap — GDD §6: "Tap an empty box, confirm. Large target, no drag.")
// ---------------------------------------------------------------

function tryPlant(v: BoxView): void {
  if (v.owner) return
  if (!adminUnlimited) {
    const verdict = checkPlant(beds, bedInfo, localId(), v.boxId)
    if (!verdict.ok) {
      showToast(verdict.reason === 'plot_taken'
        ? (verdict.full ? 'The garden is full right now - every plot is taken. Try again soon' : `That is ${verdict.ownerName}'s plot - plant in a bed of your own`)
        : 'Your plot has room - plant in the planter marked "Plant here" first', TOAST_MS, false)
      return
    }
  }
  if (isBoxCapKnown() && myBoxCount() >= getBoxCap()) {   // an unknown cap is only a placeholder: let the server decide
    showToast(`You're using all ${getBoxCap()} of your planters — harvest one to plant again`, TOAST_MS, false)
    return
  }
  const tier = adminUnlimited ? 0 : nextSeedTier()   // unlimited: the server rolls a random tier
  if (tier === null) {
    showToast('No seeds yet — catch some from a bloom', TOAST_MS, false)
    return
  }
  // More than one kind of seed in the pouch: the tap opens the seed menu so the player picks which one (KJ 2026-10-02). One kind plants straight away.
  if (!adminUnlimited && pouch.filter(n => n > 0).length > 1) {
    openSeedMenuForPlanter(v.boxId, t => sendPlant(v, t))
    return
  }
  sendPlant(v, tier)
}

function sendPlant(v: BoxView, tier: number): void {
  if (v.owner) return   // taken while the menu was open
  console.log(`[Boxes] planting tier-${tier} seed in ${v.boxId}`)
  room.send('plantSeed', { boxId: v.boxId, rarityTier: tier })
}

// Phase 4 — one tap, dispatched by whose box it is and its state.
// Server re-validates everything; these local checks only save a round trip.
/** Tend, gated by the same press-and-hold pour meter as a garden plant (2026-09-28, KJ:
 *  "i shouldnt be able to spam tend my seed"). A quick tap or too much water does nothing —
 *  skillCheck.tsx's meter is a single module-level hold, so this also can't run at the same
 *  time as watering a garden plant. */
function tendOnto(v: BoxView): void {
  if (isHolding() || isWateringEmoteActive()) return   // one water at a time: the previous can animation has to finish (KJ 2026-09-30)
  const pos = layout.get(v.boxId)
  const at = pos ? { x: pos.x, y: ly(pos) + BOX_MODEL_RIM_Y, z: pos.z } : { x: 0, y: 0, z: 0 }
  beginHold((outcome) => {
    if (outcome === 'tap' || outcome === 'over') return   // meter itself says why; no send
    console.log(`[Boxes] tending ${v.boxId}`)
    playWateringBeat()
    room.send('tendBox', { boxId: v.boxId })
    lastTendLocal.set(v.boxId, Date.now())
    v.tends += 1          // optimistic; the next boxState carries the server's count
    removeSeedlingDrop(v)
  }, at)
}

function onTap(v: BoxView): void {
  if (!v.owner) { tryPlant(v); return }
  if (isMine(v)) {
    if (v.opened) { console.log(`[Boxes] harvesting ${v.boxId}`); room.send('harvestBox', { boxId: v.boxId }); return }
    if (tendReady(v, Date.now())) { tendOnto(v); return }
    if (tendCooling(v, Date.now()) && tendsAvailable(v.opensLocalAt, Date.now(), v.rarityTier, v.tends) > 0) { showToast('Give it a few seconds, then water it again', TOAST_MS, false); return }
    showToast(`Still growing — ready in ${countdown(v, Date.now())}. Water it again when it grows`, TOAST_MS, false)
    return
  }
  if (v.opened) { showToast(`${v.ownerName}'s ${flowerName(v)}, on show`, TOAST_MS, false); return }
  if (v.waters >= BOX_WATER_MAX) { showToast(`${v.ownerName}'s seed has had all the water it can take`, TOAST_MS, false); return }
  if (isWateringEmoteActive() || isHolding()) return   // one water at a time (KJ 2026-09-30): a tap during the previous pour's animation does nothing
  console.log(`[Boxes] watering ${v.ownerName}'s ${v.boxId}`)
  playWateringBeat()   // same optimistic timing as a garden plant; the server still validates
  room.send('waterBox', { boxId: v.boxId })
  wateredByMe.add(v.boxId)
  removeSeedlingDrop(v)   // one water per visitor — the marker's job here is done
}

// ---------------------------------------------------------------
// Setup
// ---------------------------------------------------------------

// Model-space (before BOX_MODEL_SCALE): the planter body up to the soil rim
const PLANTER_COLLIDER_CENTER = { x: 0, y: 0.55, z: 0.06 }
const PLANTER_COLLIDER_SIZE   = { x: 1.8, y: 1.1, z: 1.95 }

/** KJ 2026-10-01: the planter model now carries its own collider mesh ("planter_collider" — a 12-triangle box inside planterBox.glb, next to the
 *  789-triangle visible mesh), so collision comes from the MODEL: pointer + physics, on the model's invisible (_collider) meshes only. The visible
 *  meshes carry no collision. `false` = the old separate box collider child (kept as the fallback, e.g. if taps misbehave on a phone). */
const PLANTER_USE_MODEL_COLLIDER = true

function createBox(p: PlanterPos & { id: string }): BoxView {
  // Before 2026-10-01 the template had no _collider mesh and its visible meshes carried pointer + physics collision: 96 × 1,577-tri mesh
  // colliders tested on every pointer raycast and physics step. A box collider per planter replaced that; now the model has a 12-tri one of its own.
  const base = engine.addEntity()
  Transform.create(base, { position: { x: p.x, y: ly(p), z: p.z }, rotation: planterRotation(p), scale: { x: BOX_MODEL_SCALE, y: BOX_MODEL_SCALE, z: BOX_MODEL_SCALE } })
  GltfContainer.create(base, {
    src: BOX_MODEL_SRC,
    visibleMeshesCollisionMask: ColliderLayer.CL_NONE,
    invisibleMeshesCollisionMask: PLANTER_USE_MODEL_COLLIDER ? ColliderLayer.CL_POINTER | ColliderLayer.CL_PHYSICS : ColliderLayer.CL_NONE,
  })
  // No shadow casting (KJ 2026-09-19): 96 planters were drawn again for every shadow cascade
  GltfNodeModifiers.create(base, { modifiers: [{ path: '', castShadows: false }] })
  // `hit` is the entity taps land on (pointer events + hover text). With the model collider that IS the base entity.
  let hit = base
  if (!PLANTER_USE_MODEL_COLLIDER) {
    hit = engine.addEntity()
    Transform.create(hit, { parent: base, position: PLANTER_COLLIDER_CENTER, scale: PLANTER_COLLIDER_SIZE })
    MeshCollider.setBox(hit, ColliderLayer.CL_POINTER | ColliderLayer.CL_PHYSICS)
  }

  const v: BoxView = { boxId: p.id, base, hit, labelText: '', plant: null, plantKey: '', balloon: null, balloonText: null, animSlot: -1, owner: '', ownerName: '', rarityTier: 0, opened: false, flower: '', opensLocalAt: 0, waters: 0, lastWaterer: '', drop: null, stage: 0, tends: 0, plantedAt: 0 }
  pointerEventsSystem.onPointerDown(
    { entity: hit, opts: { button: InputAction.IA_POINTER, hoverText: 'Plant seed', maxDistance: TAP_DISTANCE } },
    () => onTap(v),
  )
  return v
}

/** Test-panel only: force two boxes into the growing state so the rarity-tinted
 *  seedling colors can be compared side by side without waiting on real timers.
 *  Client-only, cosmetic — the next boxState broadcast (or a rejoin) overwrites it. */
// ---------------------------------------------------------------
// Planter layout editor API (planterLayoutTool) — moves the REAL planters in this
// client only; the result is baked into BOX_POSITIONS. The server only knows ids.
// ---------------------------------------------------------------

export type PlanterPose = PlanterPos & { id: string }

/** Current layout, deleted planters excluded — what gets saved and baked. */
export function getPlanterLayout(): PlanterPose[] {
  return [...layout.entries()].filter(([id]) => !deleted.has(id)).map(([id, p]) => ({ id, ...p }))
}

/** Move/turn one planter and everything on it. Plant is rebuilt (unless it's being carried). */
export function setPlanterPose(id: string, pose: PlanterPos): void {
  const v = views.get(id)
  if (!v) return
  pose = { ...pose, y: pose.y ?? layout.get(id)?.y }   // the planter editor moves x / z / rot only: a planter keeps its terrace height
  layout.set(id, pose)
  const base = Transform.getMutable(v.base)
  base.position = { x: pose.x, y: ly(pose), z: pose.z }
  base.rotation = planterRotation(pose)
  const pl = plaques.find(q => q.boxId === id)
  if (pl) placePlaque(pl, pose)
  if (v.balloon !== null) {
    const b = Transform.getMutable(v.balloon)
    b.position = { x: pose.x, y: ly(pose), z: pose.z }
    b.rotation = planterRotation(pose)
  }
  if (!carrying.has(id) && v.plant !== null) { v.plantKey = ''; pendingPlant.add(v) }
}

/** Editor: lift a planter — its plant is taken down while it moves, rebuilt on drop. */
export function beginCarry(id: string): void {
  const v = views.get(id)
  if (!v) return
  carrying.add(id)
  detachPlantVfx(id)
  if (v.plant !== null) { retirePlant(v.plant); v.plant = null }
  v.plantKey = ''
}
export function endCarry(id: string): void {
  const v = views.get(id)
  carrying.delete(id)
  if (v) pendingPlant.add(v)
}

/** Editor: a new planter (client-only until baked — the server doesn't know its id yet). */
export function addPlanter(pose: PlanterPos): string {
  let n = views.size + 1
  while (views.has(`box_${n}`)) n++
  const id = `box_${n}`
  layout.set(id, pose)
  views.set(id, createBox({ id, ...pose }))
  refresh(views.get(id)!)
  return id
}

/** Editor: hide a planter until the next bake drops it (the server hands back its contents). */
export function deletePlanter(id: string): void {
  const v = views.get(id)
  if (!v || deleted.has(id)) return
  deleted.add(id)
  detachPlantVfx(id)
  removeSeedlingDrop(v)
  if (v.plant !== null) { retirePlant(v.plant); v.plant = null }
  const zero = { x: 0, y: 0, z: 0 }
  Transform.getMutable(v.base).scale = zero
  hideBalloon(v)
  const pl = plaques.find(q => q.boxId === id)
  if (pl) freePlaque(pl)
}
export function isPlanterDeleted(id: string): boolean { return deleted.has(id) }

/** Editor: apply a saved layout — move known planters, add new ids, delete missing ones. */
export function applyPlanterLayout(list: PlanterPose[]): void {
  const keep = new Set(list.map(p => p.id))
  for (const p of list) {
    if (views.has(p.id)) setPlanterPose(p.id, { x: p.x, z: p.z, rot: p.rot })
    else { layout.set(p.id, { x: p.x, z: p.z, rot: p.rot }); views.set(p.id, createBox(p)); refresh(views.get(p.id)!) }
  }
  for (const id of [...views.keys()]) if (!keep.has(id)) deletePlanter(id)
}

/** Test panel: run the crowding rule once now (server picks the longest-away owner's planter). */
export function adminTidyPlanter(): void { room.send('adminTidyPlanter', {}) }
/** Test panel (admin): lift my planter cap + random-tier, seedless planting (server-checked);
 *  the server replies with the new cap. */
let adminUnlimited = false
export function adminSetUnlimitedPlanters(on: boolean): void { adminUnlimited = on; room.send('adminUnlimitedPlanters', { on }) }

export function demoSeedlings(): void {
  const demo = (boxId: string, rarityTier: number) => {
    const v = views.get(boxId)
    if (!v) return
    v.owner        = '0xdemo'
    v.ownerName    = 'Demo'
    v.rarityTier   = rarityTier
    v.opened       = false
    v.opensLocalAt = Date.now() + 3_600_000
    refresh(v)
  }
  // One per seedling effect in KJ's table (Common = none); box_1..6 are a row in the current layout
  demo('box_1', 0); demo('box_2', 2); demo('box_3', 3); demo('box_4', 4); demo('box_5', 5); demo('box_6', 7)
  console.log('[Boxes] demo seedlings: box_1 Common, 2 Rare, 3 Epic, 4 Legendary, 5 Exotic, 6 Unique — the next real box update clears it')
}

/** Test-panel only: force four OTHER boxes into the opened/revealed state, one per
 *  effect tier (Rare pulse, Epic particles, Legendary pulse+particles, Exotic all + tween),
 *  without waiting on a real grow cycle. Client-only, cosmetic — clears on the next real update. */
export function demoRevealedFlowers(): void {
  const demo = (boxId: string, flower: string, rarityTier: number) => {
    const v = views.get(boxId)
    if (!v) return
    v.owner      = '0xdemo'
    v.ownerName  = 'Demo'
    v.rarityTier = rarityTier
    v.opened     = true
    v.flower     = flower
    refresh(v)
  }
  demo('box_5', 'rose', 2)               // Rare — green pulse
  demo('box_6', 'sunflower', 3)          // Epic — blue particles
  demo('box_7', 'bird_of_paradise', 4)   // Legendary — tonal purple pulse + particles (double-sided leaves)
  demo('box_8', 'void_tulip', 5)         // Exotic — lime/red pulse + particles + sway
  console.log('[Boxes] demo revealed flowers: box_5 Rose (Rare), box_6 Sunflower (Epic), box_7 Bird of Paradise (Legendary), box_8 Void Tulip (Exotic) — the next real box update clears it')
}

/** Once a second: only the balloon countdown moves; the board text is event-driven. */
// ---------------------------------------------------------------
// Bed signs: a plaque over each bed saying "Bed N" and who owns it, or "Free plot". A billboard so it reads from any side,
// shown within BED_SIGN_RANGE metres. Free planters also say whose plot they are in when you hover them.
// ---------------------------------------------------------------
interface BedSign { bed: Bed; root: Entity; text: Entity; face: Entity; ring: Entity; text_: string; faceOwner: string; near: boolean }   // + a frame plane, never touched after creation
const bedSigns: BedSign[] = []
// 3.2, was 2.2 (KJ 2026-09-27): the 1.3 m plaque spanned 1.55–2.85 m and sat on the balloons (up to ~1.9 m).
const BED_SIGN_Y     = 3.2
const BED_SIGN_RANGE = 20
const BED_SIGN_SCALE = 0.75   // TUNING — pair-beds' centres are 3.5 m apart (pairs are pushed 0.5 m apart in BOX_POSITIONS) and the plaque is 4.3 m wide at scale 1, so neighbours would overlap
const BED_TEXT_FREE  = { r: 0.83, g: 0.82, b: 0.78, a: 1 }
const BED_TEXT_MINE  = { r: 0.98, g: 0.78, b: 0.3, a: 1 }
const BED_TEXT_OTHER = { r: 0.957, g: 0.918, b: 0.824, a: 1 }
const CIRCLE_FRAME   = 'assets/images/circleFrame.png'   // white outside a circular hole; tinted plaque-brown, laid OVER the square avatar
const CIRCLE_RING    = 'assets/images/circleRing.png'    // white annulus, tinted per owner
const RING_MINE  = { r: 0.98, g: 0.78, b: 0.3 }
const RING_OTHER = { r: 0.957, g: 0.918, b: 0.824 }
const RING_FREE  = { r: 0.35, g: 0.62, b: 0.42 }

// The bed plaque matches the 2D UI: the same near-black as the menus (DARK in seedMenu/discoveryCard), rounded corners.
const PLAQUE_DARK = { r: 0.085, g: 0.078, b: 0.067 }
const PANEL_TEX   = 'assets/images/roundedPanel.png'

function createBedSigns(): void {
  for (const bed of beds) {
    const root = engine.addEntity()
    Transform.create(root, { position: { x: bed.cx, y: BED_SIGN_Y + ly(BOX_POSITIONS.find(b => b.id === bed.boxIds[0])), z: bed.cz }, scale: { x: 0, y: 0, z: 0 } })
    Billboard.create(root, { billboardMode: BillboardMode.BM_Y })
    // Brown plaque, the owner's picture in a circle at the left, the text to its right. The viewer is on the -Z side, so
    // depth order from the back: panel, avatar (a plain SQUARE — the explorer ignores a separate mask on it), the
    // brown frame with a circular hole that crops it, then the tinted ring as the outline.
    const panel = engine.addEntity()
    Transform.create(panel, { parent: root, position: { x: 0, y: 0, z: 0.08 }, scale: { x: 4.3, y: 1.6, z: 1 } })
    MeshRenderer.setPlane(panel)
    Material.setPbrMaterial(panel, {
      texture: Material.Texture.Common({ src: PANEL_TEX }), alphaTexture: Material.Texture.Common({ src: PANEL_TEX }),
      albedoColor: { ...PLAQUE_DARK, a: 1 }, emissiveColor: PLAQUE_DARK, emissiveIntensity: 0.35,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND, castShadows: false,
    })
    const face = engine.addEntity()
    Transform.create(face, { parent: root, position: { x: -1.55, y: 0, z: 0.0 }, scale: { x: 0, y: 0, z: 0 } })
    MeshRenderer.setPlane(face)
    const frame = engine.addEntity()
    Transform.create(frame, { parent: root, position: { x: -1.55, y: 0, z: -0.05 }, scale: { x: 1.15, y: 1.15, z: 1.15 } })
    MeshRenderer.setPlane(frame)
    Material.setPbrMaterial(frame, {
      texture: Material.Texture.Common({ src: CIRCLE_FRAME }), alphaTexture: Material.Texture.Common({ src: CIRCLE_FRAME }),
      albedoColor: { ...PLAQUE_DARK, a: 1 }, emissiveColor: PLAQUE_DARK, emissiveIntensity: 0.35,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND, castShadows: false,
    })
    const ring = engine.addEntity()
    Transform.create(ring, { parent: root, position: { x: -1.55, y: 0, z: -0.10 }, scale: { x: 1.15, y: 1.15, z: 1.15 } })
    MeshRenderer.setPlane(ring)
    const text = engine.addEntity()
    // A TextShape's position is the CENTRE of its box, not its left edge: the box spans x -0.6 .. 2.0: a 0.4 m gap after the picture's ring.
    // Font units are small: fontSize 1.15 came out ~0.06 m per character, so 3.4 makes "KJwalker3D's" ~2.4 m wide.
    Transform.create(text, { parent: root, position: { x: 0.7, y: 0, z: -0.12 } })
    TextShape.create(text, {
      text: '', fontSize: 2.5, textColor: BED_TEXT_FREE, textAlign: TextAlignMode.TAM_MIDDLE_LEFT,
      width: 2.6, height: 1.5, textWrapping: true, outlineWidth: 0.12, outlineColor: { r: 0.1, g: 0.06, b: 0.03 },
    })
    bedSigns.push({ bed, root, text, face, ring, text_: '', faceOwner: '\u0000', near: false })
  }
}

/** The outline: gold for my plot, cream for someone else's, green for a free one. */
function setBedRing(ring: Entity, c: { r: number; g: number; b: number }): void {
  Material.setPbrMaterial(ring, {
    texture: Material.Texture.Common({ src: CIRCLE_RING }), alphaTexture: Material.Texture.Common({ src: CIRCLE_RING }),
    albedoColor: { ...c, a: 1 }, emissiveColor: c, emissiveIntensity: 0.8,
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND, castShadows: false,
  })
}

function updateBeds(): void {
  const me = localId()
  updatePlantHere(me)
  const pos = Transform.getOrNull(engine.PlayerEntity)?.position
  for (const bs of bedSigns) {
    const owner = bedOwner(bs.bed, bedInfo)
    const mine = !!owner && owner.owner === me
    // "Name's plot" for everyone, including me (KJ 2026-09-25: my name, not "Your plot")
    // …and how many of its planters are still free (KJ 2026-09-29: show what the bed has left to use)
    const freeN = bs.bed.boxIds.filter(id => { const v = views.get(id); return !v || !v.owner }).length
    const timer = owner ? bedTimerLine(bs.bed, Date.now()) : ''
    const text = owner ? `${owner.ownerName}'s\nplot · ${freeN === 0 ? 'full' : `${freeN} free`}${timer ? `\n${timer}` : ''}` : 'Free plot'
    if (text !== bs.text_) {
      bs.text_ = text
      const ts = TextShape.getMutable(bs.text)
      ts.text = text
      ts.textColor = mine ? BED_TEXT_MINE : owner ? BED_TEXT_OTHER : BED_TEXT_FREE
    }
    // Only POPULATED beds get a sign (KJ 2026-09-25: hide the name tags of empty beds)
    const near = !!owner && !!pos && Math.hypot(pos.x - bs.bed.cx, pos.z - bs.bed.cz) <= BED_SIGN_RANGE
    // Profile picture in a circle (the owner's avatar face); a green disc when the plot is free. Lazy (KJ 2026-09-30): the avatar
    // TEXTURE is only requested once the sign is in range — up to 48 owners' faces were being fetched at join for signs nobody could see.
    const who = owner ? owner.owner : ''
    if (who !== bs.faceOwner && (near || !who)) {
      bs.faceOwner = who
      const tex = who ? Material.Texture.Avatar({ userId: who }) : null
      Material.setPbrMaterial(bs.face, tex
        ? { texture: tex, emissiveTexture: tex, emissiveColor: { r: 1, g: 1, b: 1 }, emissiveIntensity: 0.9, castShadows: false }
        : { albedoColor: { ...RING_FREE, a: 1 }, emissiveColor: RING_FREE, emissiveIntensity: 0.4, metallic: 0, roughness: 1 })   // free plot: a plain green disc behind the hole
      Transform.getMutable(bs.face).scale = { x: 1.04, y: 1.04, z: 1.04 }
      setBedRing(bs.ring, mine ? RING_MINE : owner ? RING_OTHER : RING_FREE)
    }
    if (near !== bs.near) { bs.near = near; Transform.getMutable(bs.root).scale = near ? { x: BED_SIGN_SCALE, y: BED_SIGN_SCALE, z: BED_SIGN_SCALE } : { x: 0, y: 0, z: 0 } }
    // Hover on each FREE planter in this bed says whose plot it is, so the protection is not a surprise on tap
    for (const id of bs.bed.boxIds) {
      const v = views.get(id)
      if (!v || v.owner) continue
      const verdict = checkPlant(beds, bedInfo, me, id)
      setHoverText(v, verdict.ok ? (v.boxId === plantHereBox ? 'Plant here' : 'Plant seed') : verdict.reason === 'plot_taken' ? (verdict.full ? 'Garden full' : `${verdict.ownerName}'s plot`) : 'Fill your own plot first')
    }
  }
}
// "Plant here" marker (KJ 2026-10-02 playtest: "error message isn't clear about the bed or where to put the seed"). Beds carry no visible number, so
// "plant in Bed 1" meant nothing. Your plot is a PAIR: once one planter is yours, the other must be filled before you start a new plot, so that
// free planter wears a floating "Plant here" while you hold seeds. One entity, moved.
const PLANT_HERE_LIFT = 1.15
const PLANT_HERE_RANGE = 25   // m — the marker only shows when you are near enough to act on it
let plantHere: Entity | null = null
let plantHereBox = ''   // the planter wearing the marker, '' = none
function updatePlantHere(me: string): void {
  let box = ''
  if (me && pouch.some(n => n > 0) && !(isBoxCapKnown() && myBoxCount() >= getBoxCap())) {
    for (const bs of bedSigns) {
      if (bedOwner(bs.bed, bedInfo)?.owner !== me) continue
      const free = bs.bed.boxIds.find(id => { const v = views.get(id); return v && !v.owner && !deleted.has(id) && layout.has(id) })
      const pos = free ? layout.get(free) : undefined
      const mePos = Transform.getOrNull(engine.PlayerEntity)?.position
      if (free && pos && mePos && Math.hypot(pos.x - mePos.x, pos.z - mePos.z) <= PLANT_HERE_RANGE) { box = free; break }
    }
  }
  if (box === plantHereBox) return
  plantHereBox = box
  if (box === '') { if (plantHere !== null) Transform.getMutable(plantHere).scale = { x: 0, y: 0, z: 0 }; return }
  const pos = layout.get(box)!
  const at = { x: pos.x, y: ly(pos) + BOX_MODEL_RIM_Y + PLANT_HERE_LIFT, z: pos.z }
  if (plantHere === null) {
    plantHere = engine.addEntity()
    Transform.create(plantHere, { position: at })
    Billboard.create(plantHere, { billboardMode: BillboardMode.BM_Y })
    TextShape.create(plantHere, { text: 'Plant here', fontSize: 2.4, textColor: BED_TEXT_MINE, outlineWidth: 0.2, outlineColor: { r: 0.1, g: 0.06, b: 0.03 } })
  }
  Transform.createOrReplace(plantHere, { position: at, scale: { x: 1, y: 1, z: 1 } })
}

function setHoverText(v: BoxView, text: string): void {
  const pe = PointerEvents.getMutableOrNull(v.hit)?.pointerEvents[0]?.eventInfo
  if (pe && pe.hoverText !== text) pe.hoverText = text
}

function boxTickSystem(dt: number): void {
  tickAccum += dt * 1_000
  if (tickAccum < LABEL_TICK_MS) return
  tickAccum = 0
  const now = Date.now()
  updateBeds()
  for (const v of views.values()) {
    if (v.balloonText !== null && v.owner) { setBalloonText(v, now); if (v.animSlot >= 0) setSlotText(v, now) }
    if (v.owner && !v.opened && v.plant !== null && !held.has(v.boxId)) {
      const s = stageFor(v, now)
      if (s > v.stage) growTo(v, s)
    }
    if (isMine(v) && v.owner && !v.opened) {   // a new stage means a new tend: the drop and hover follow the clock, not just boxState
      const pos = layout.get(v.boxId)
      if (pos) setSeedlingDrop(v, pos)
      const pe = PointerEvents.getMutableOrNull(v.hit)?.pointerEvents[0]?.eventInfo
      if (pe) pe.hoverText = hoverFor(v)
    }
  }
}

// ---------------------------------------------------------------
// Growth stages (playtest 2026-09-24: "we could have a lot more progression here"). The
// seedling used to sit at one size until the flower opened. Now it steps through four
// stages by how much of ITS OWN timer has elapsed (a Rare's 6-minute wait and a Common's
// 2-minute wait both read as seed → sprout → seedling → bud), popping at each step.
// Progress is elapsed/total, so a visitor's watering shave makes the next pop come sooner.
// ---------------------------------------------------------------
const GROW_STAGES: ReadonlyArray<{ scale: number }> = [   // WHEN each stage starts is GROW_STAGE_AT in config
  { scale: 0.5  },   // seed just in the soil
  { scale: 0.7  },   // sprout
  { scale: 0.9  },   // seedling
  { scale: 1.15 },   // bud, about to open
]   // TUNING
const GROW_POP_MS = 600

function stageFor(v: BoxView, now: number): number {
  return growStageOf(v.opensLocalAt, now, v.rarityTier)
}

function growTo(v: BoxView, stage: number): void {
  const pos = layout.get(v.boxId)
  if (!pos || v.plant === null || !Transform.has(v.plant)) return
  const from = Transform.get(v.plant).scale.x
  const k = SEEDLING_SCALE * GROW_STAGES[stage].scale
  v.stage = stage
  // Keep the base in the soil: the seedling's geometry starts SEEDLING_MODEL_MIN_Y*k above its origin.
  Transform.getMutable(v.plant).position.y = ly(pos) + BOX_MODEL_RIM_Y - SEEDLING_MODEL_MIN_Y * k
  Tween.setScale(v.plant, { x: from, y: from, z: from }, { x: k, y: k, z: k }, GROW_POP_MS, EasingFunction.EF_EASEOUTBACK)
  if (isMine(v)) triggerSparkle({ x: pos.x, y: ly(pos) + BOX_MODEL_RIM_Y, z: pos.z })
}

/** Write a balloon's text only when it changed ("Ready to Harvest" never does; a countdown
 *  changes once a minute at most). Was every owned balloon, every second: ~90 text rebuilds/s
 *  with a full garden (KJ 17 fps, 2026-09-19). */
function setBalloonText(v: BoxView, now: number): void {
  if (v.balloonText === null) return
  const text = balloonTextFor(v, now)
  if (TextShape.get(v.balloonText).text !== text) TextShape.getMutable(v.balloonText).text = text
}

// ---------------------------------------------------------------
// Animated balloon pool (KJ 2026-09-29: "i expected the balloons to animate when i got near").
// Every planted planter shows the STATIC balloon. The few planters nearest the player swap it for an
// animated one from this small pool: the skinned clip plus two looping Tweens that carry the text along
// the bone. The explorer writes every looping-tweened Transform back to the scene each frame (96 of
// them held the tick at ~13 fps), so the pool stays tiny and is re-picked as you walk.
// ---------------------------------------------------------------
interface BalloonSlot { balloon: Entity; mover: Entity; pivot: Entity; text: Entity; boxId: string | null }
const balloonPool: BalloonSlot[] = []
const BALLOON_ANIM_M    = 8      // TUNING — m
const BALLOON_SCAN_MS   = 500
let balloonScanAccum = 0

function createBalloonPool(): void {
  // Phone: static balloons only (KJ 2026-09-29: on mobile the animated ones sat at odd heights and their text drifted out of sync).
  const n = isMobile() ? 0 : 6   // TUNING
  for (let i = 0; i < n; i++) {
    const balloon = engine.addEntity()
    Transform.create(balloon, { position: { x: 0, y: -50, z: 0 }, scale: { x: 0, y: 0, z: 0 } })
    GltfContainer.create(balloon, { src: BALLOON_ANIMATED_SRC, visibleMeshesCollisionMask: ColliderLayer.CL_NONE, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE })
    // Hide the baked "Harvest in" mesh (KJ's GLB left untouched) — the live text below replaces it
    GltfNodeModifiers.create(balloon, { modifiers: [{
      path: 'Text.002', castShadows: false,
      material: { material: { $case: 'pbr', pbr: { albedoColor: { r: 1, g: 1, b: 1, a: 0 }, transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND } } },
    }] })
    // balloon → mover (bone position) → pivot (bone rotation) → text (facing)
    const mover = engine.addEntity()
    Transform.create(mover, { parent: balloon, position: BALLOON_TEXT_POS })
    const pivot = engine.addEntity()
    Transform.create(pivot, { parent: mover })
    const text = engine.addEntity()
    Transform.create(text, { parent: pivot, rotation: Quaternion.fromEulerDegrees(0, 180, 0) })
    TextShape.create(text, { text: '', fontSize: BALLOON_TEXT_FONT, textColor: BALLOON_TEXT_COLOR, textAlign: TextAlignMode.TAM_MIDDLE_CENTER })
    balloonPool.push({ balloon, mover, pivot, text, boxId: null })
  }
}

/** Bone.003's baked motion as looping renderer-side Tween sequences (one segment per track key). */
// Finished one-shot tweens (pops, swells, seed drops, water drops) stay on their entity as a Tween component, and the SDK's tween
// bookkeeping system re-serialises EVERY entity that carries one, every tick (ecs/dist/systems/tween.js). They pile up over a session — plants
// stream in and out, every pop leaves one behind — so the scene's script time climbed with play time (KJ 2026-10-02 PERF: script 17 ms → 40 ms).
// Looping tweens (they have a TweenSequence) are left alone. The scene's Transform already holds each tween's end value (the pops
// are authored from the target scale), so dropping a finished tween changes nothing on screen.
let tweenSweepAccum = 0
function tweenSweepSystem(dt: number): void {
  tweenSweepAccum += dt
  if (tweenSweepAccum < 0.5) return
  tweenSweepAccum = 0
  for (const [e] of engine.getEntitiesWith(Tween)) {
    if (!TweenSequence.has(e) && tweenSystem.tweenCompleted(e)) Tween.deleteFrom(e)
  }
}

function trackSequence(kind: 'move' | 'rotate'): NonNullable<Parameters<typeof Tween.create>[1]>[] {
  const out: NonNullable<Parameters<typeof Tween.create>[1]>[] = []
  for (let i = 0; i + 1 < BALLOON_TEXT_TRACK.length; i++) {
    const a = BALLOON_TEXT_TRACK[i], b = BALLOON_TEXT_TRACK[i + 1]
    const duration = Math.round((b[0] - a[0]) * 1000)
    out.push(kind === 'move'
      ? { duration, easingFunction: EF_LINEAR, mode: { $case: 'move', move: { start: { x: a[1], y: a[2], z: a[3] }, end: { x: b[1], y: b[2], z: b[3] } } } }
      : { duration, easingFunction: EF_LINEAR, mode: { $case: 'rotate', rotate: { start: { x: a[4], y: a[5], z: a[6], w: a[7] }, end: { x: b[4], y: b[5], z: b[6], w: b[7] } } } })
  }
  return out
}
const MOVE_SEQ   = trackSequence('move')
const ROTATE_SEQ = trackSequence('rotate')

function setSlotText(v: BoxView, now: number): void {
  const slot = balloonPool[v.animSlot]
  if (!slot) return
  const text = balloonTextFor(v, now)
  if (TextShape.get(slot.text).text !== text) TextShape.getMutable(slot.text).text = text
}

/** Put an animated balloon on this planter and hide its static one. Clip and text Tweens start on the same tick. */
function assignSlot(v: BoxView, pos: PlanterPos, i: number): void {
  const slot = balloonPool[i]
  slot.boxId = v.boxId
  v.animSlot = i
  const tr = Transform.getMutable(slot.balloon)
  tr.position = { x: pos.x, y: ly(pos), z: pos.z }
  tr.rotation = planterRotation(pos)
  tr.scale = { x: BOX_MODEL_SCALE, y: BOX_MODEL_SCALE, z: BOX_MODEL_SCALE }
  setSlotText(v, Date.now())
  if (v.balloon !== null) Transform.getMutable(v.balloon).scale = { x: 0, y: 0, z: 0 }
  Animator.createOrReplace(slot.balloon, { states: BALLOON_ANIM_CLIPS.map(clip => ({ clip, playing: true, loop: true, shouldReset: true })) })
  Tween.createOrReplace(slot.mover, MOVE_SEQ[0])
  TweenSequence.createOrReplace(slot.mover, { sequence: MOVE_SEQ.slice(1), loop: TL_RESTART })
  Tween.createOrReplace(slot.pivot, ROTATE_SEQ[0])
  TweenSequence.createOrReplace(slot.pivot, { sequence: ROTATE_SEQ.slice(1), loop: TL_RESTART })
}

/** Stop the motion (no per-frame write-back), park the animated balloon, bring the static one back. */
function releaseSlot(v: BoxView): void {
  const slot = balloonPool[v.animSlot]
  v.animSlot = -1
  if (!slot) return
  slot.boxId = null
  if (Animator.has(slot.balloon)) Animator.stopAllAnimations(slot.balloon)
  for (const e of [slot.mover, slot.pivot]) { TweenSequence.deleteFrom(e); Tween.deleteFrom(e) }
  Transform.getMutable(slot.balloon).scale = { x: 0, y: 0, z: 0 }
  if (v.owner && v.balloon !== null) Transform.getMutable(v.balloon).scale = { x: BOX_MODEL_SCALE, y: BOX_MODEL_SCALE, z: BOX_MODEL_SCALE }
}

function balloonPoolSystem(dt: number): void {
  balloonScanAccum += dt * 1_000
  if (balloonScanAccum < BALLOON_SCAN_MS) return
  balloonScanAccum = 0
  const me = Transform.getOrNull(engine.PlayerEntity)?.position
  if (!me) return
  const near = [...views.values()]
    .filter(v => v.owner && v.opened && v.balloon !== null)
    .map(v => { const p = layout.get(v.boxId); return { v, p, d: p ? Math.hypot(p.x - me.x, p.z - me.z) : Infinity } })
    .filter(r => r.d <= BALLOON_ANIM_M)
    .sort((a, b) => a.d - b.d)
    .slice(0, balloonPool.length)
  const keep = new Set(near.map(r => r.v))
  for (const v of views.values()) if (v.animSlot >= 0 && !keep.has(v)) releaseSlot(v)
  for (const r of near) {
    if (r.v.animSlot >= 0 || !r.p) continue
    const free = balloonPool.findIndex(s => s.boxId === null && GltfContainerLoadingState.getOrNull(s.balloon)?.currentState === LS_FINISHED)
    if (free >= 0) assignSlot(r.v, r.p, free)
  }
}

// ---------------------------------------------------------------
// Plaque pool
// ---------------------------------------------------------------

interface Plaque { sign: Sign; boxId: string | null }
const plaques: Plaque[] = []
let plaqueAccum = 0

function placePlaque(pl: Plaque, pose: PlanterPos): void {
  const at = planterPoint(pose, 0, PLAQUE_OFFSET_Z)   // on the planter's front board
  moveSign(pl.sign, { x: at.x, y: PLAQUE_Y + ly(pose), z: at.z })
  Transform.getMutable(pl.sign.root).rotation = Quaternion.fromEulerDegrees(0, (180 + pose.rot) % 360, 0)
}

function freePlaque(pl: Plaque): void {
  pl.boxId = null
  moveSign(pl.sign, { x: 0, y: -50, z: 0 })
}

/** Remember the text; write it only if a plaque is on that box right now. */
function setLabel(v: BoxView, text: string): void {
  if (v.labelText === text) return
  v.labelText = text
  const pl = plaques.find(q => q.boxId === v.boxId)
  if (pl) TextShape.getMutable(pl.sign.text).text = text
}

/** Keep the pool on the nearest planters. A plaque only moves when its box drops out of the
 *  nearest set, so plaques in view stay put. */
function plaqueHomeSystem(dt: number): void {
  plaqueAccum += dt * 1_000
  if (plaqueAccum < PLAQUE_SCAN_MS) return
  plaqueAccum = 0
  const me = Transform.getOrNull(engine.PlayerEntity)?.position
  if (!me) return
  const wanted = new Set([...layout.entries()]
    .filter(([id]) => !deleted.has(id))
    .map(([id, p]) => ({ id, p, d: Math.hypot(p.x - me.x, p.z - me.z) }))
    .filter(r => r.d <= PLAQUE_RANGE_M)
    .sort((a, b) => a.d - b.d)
    .slice(0, PLAQUE_POOL)
    .map(r => r.id))
  for (const pl of plaques) if (pl.boxId !== null && !wanted.has(pl.boxId)) freePlaque(pl)
  for (const id of wanted) {
    if (plaques.some(q => q.boxId === id)) continue
    const pl = plaques.find(q => q.boxId === null)
    const v = views.get(id), pose = layout.get(id)
    if (!pl || !v || !pose) break
    pl.boxId = id
    placePlaque(pl, pose)
    TextShape.getMutable(pl.sign.text).text = v.labelText
  }
}

/** The nursery's info boards (KJ 2026-10-05 / 06): dark brown board, amber title, cream lines. Static, and Named so the Prop editor can
 *  move them (PROP_LAYOUT). Read from the -Z side. Both are the same width, so they hang as a pair. */
const INFO_SIGN_W = 3.0, INFO_SIGN_LINE = 0.24
const INFO_BOARD = { r: 0.40, g: 0.21, b: 0.11, a: 1 }, INFO_AMBER = { r: 1, g: 0.72, b: 0.22, a: 1 }, INFO_CREAM = { r: 1, g: 0.95, b: 0.82, a: 1 }
function createInfoSign(name: string, title: string, lines: string[], rows: number, fallback: { x: number; y: number; z: number; rotY: number }): void {
  const o = PROP_LAYOUT[name] ?? fallback
  const H = 0.95 + INFO_SIGN_LINE * rows
  const root = engine.addEntity()
  Transform.create(root, { position: { x: o.x, y: o.y, z: o.z }, rotation: Quaternion.fromEulerDegrees(0, o.rotY ?? 0, 0) })
  Name.create(root, { value: name })
  const panel = engine.addEntity()
  Transform.create(panel, { parent: root, position: { x: 0, y: 0, z: 0.03 }, scale: { x: INFO_SIGN_W, y: H, z: 0.04 } })
  MeshRenderer.setBox(panel)
  // UNLIT (basic material): a lit dark-brown board went black in the garden's dusk light (KJ 2026-10-06), so the colour is drawn as given.
  Material.setBasicMaterial(panel, { diffuseColor: INFO_BOARD })
  const head = engine.addEntity()
  Transform.create(head, { parent: root, position: { x: 0, y: H / 2 - 0.26, z: -0.01 } })
  TextShape.create(head, { text: title, fontSize: 2.2, textColor: INFO_AMBER, textAlign: TextAlignMode.TAM_MIDDLE_CENTER })
  const body = engine.addEntity()
  Transform.create(body, { parent: root, position: { x: 0, y: -0.2, z: -0.01 } })
  TextShape.create(body, { text: lines.join('\n'), fontSize: 1.4, textColor: INFO_CREAM, textAlign: TextAlignMode.TAM_MIDDLE_CENTER, lineSpacing: 30 })
}
function createInfoSigns(): void {
  // "More planters": its lines are read from the milestone tables, so it cannot drift from what the server pays.
  const grants = [
    ...ALMANAC_MILESTONES.filter(m => m.planters > 0 && m.species > 0).map(m => `+${m.planters}  at ${m.species} species discovered`),
    ...STAMP_MILESTONES.filter(m => m.planters > 0 && m.stamps > 0).map(m => `+${m.planters}  at ${m.stamps} rarity stamps`),
  ]
  const planters = [`Everyone starts with ${BOX_CAP_DEFAULT}. Earn up to ${BOX_CAP_MAX}:`, ...grants]
  const growing = ['Tap an empty planter to plant a seed', 'Rarer seeds take longer to grow', 'Tend your seedling to speed it up', 'Friends can water it to help', 'Tap the flower to harvest it']
  const rows = Math.max(planters.length, growing.length) - 1   // same height for both boards
  createInfoSign('PlanterSign', 'More planters', planters, rows, { x: -39.4, y: 3.45, z: 27.3, rotY: 270 })
  createInfoSign('GrowSign', 'How to grow', growing, rows, { x: -39.4, y: 3.45, z: 20.7, rotY: 270 })
}

/** Register handlers — MUST be called after wateringSystem's room.clear(). */
export function setupBoxSystem(): void {
  for (let i = 0; i < PLAQUE_POOL; i++) plaques.push({ sign: createSign({ x: 0, y: -50, z: 0 }, 0, PLAQUE_SIZE, PLAQUE_FONT, false), boxId: null })
  for (const p of BOX_POSITIONS) { layout.set(p.id, { x: p.x, z: p.z, rot: p.rot, y: p.y }); views.set(p.id, createBox(p)) }
  createBedSigns()
  createInfoSigns()
  // Distance streaming (streaming.ts): far planters + their balloon / plant / drop are hidden. Never mine, and never the ones the
  // tutorial or bed steering is pointing at (their shell + arrow would float over an invisible planter).
  registerStreamSource('planters', () => {
    const steer = steeredFreeBoxes()
    const out: Array<{ key: string; x: number; z: number; entities: Array<Entity | null>; keep: boolean }> = []
    for (const v of views.values()) {
      const p = layout.get(v.boxId)
      if (!p || deleted.has(v.boxId)) continue
      out.push({ key: v.boxId, x: p.x, z: p.z, entities: [v.base, v.balloon, v.balloonText, v.plant, v.drop], keep: isMine(v) || !!steer?.has(v.boxId) })
    }
    return out
  })

  room.onMessage('boxState', (data) => {
    const v = views.get(data.boxId)
    if (!v) return
    const wasOpened = v.opened
    const wasMine   = isMine(v)
    const wasOwned  = !!v.owner
    const live      = synced.has(v.boxId)   // false for the join/resync snapshot
    synced.add(v.boxId)
    v.owner     = data.owner
    v.ownerName = data.ownerName
    v.rarityTier = data.rarityTier
    v.opened    = data.opened
    v.flower    = data.flower
    v.waters      = data.waters
    v.lastWaterer = data.lastWaterer
    v.tends       = data.tends ?? 0
    v.plantedAt   = Number(data.plantedAt)
    // Countdown from the server's own clock delta — clockSync is unreliable here
    v.opensLocalAt = Date.now() + (Number(data.opensAt) - Number(data.serverNow))
    const planting  = live && !wasOwned && !!v.owner && !v.opened
    const revealing = live && !wasOpened && v.opened && !!v.owner
    if (planting || revealing) held.add(v.boxId)   // before refresh(): keep the old visual for the beat
    refresh(v)
    // planting + opening sounds are played by the beats below, AT the planter so neighbours hear them too
    if (planting) playPlantBeat(v)
    if (revealing) playRevealBeat(v)
    if (live && wasMine && wasOpened && !v.owner) playSfx('harvest')
    // `live` matters here: the join/resync snapshot arrives with opened=true and
    // wasOpened=false for every planter already standing open, so an ungated branch
    // replays the whole beat on every rejoin. It was only a toast before; as a card it
    // would be a faceful of "you discovered" for flowers opened days ago.
    // (Notification pass 2026-09-27: no "Seed planted" toast — the seed drops in and the balloon's countdown starts)
  })

  setupGiftSystem()   // same post-room.clear() window as this system

  room.onMessage('pouchUpdate', (data) => {
    try { pouch = JSON.parse(data.countsJson) } catch { pouch = [] }
    setPouch(pouch)   // HUD chip + seed menu read the shared store
    for (const v of views.values()) if (!v.owner) setLabel(v, labelFor(v))
  })

  setupSignSystem()
  setupPlantVfx()
  createBalloonPool()
  engine.addSystem(balloonPoolSystem)
  engine.addSystem(boxTickSystem)
  engine.addSystem(plantRevealSystem)
  engine.addSystem(plaqueHomeSystem)
  engine.addSystem(tweenSweepSystem)
  console.log(`[Boxes] ${views.size} seed boxes ready · boxState listeners=${room.listenerCount('boxState')}`)
}
