// =============================================================
// Bloom Garden v2 — Guided tutorial (CLIENT ONLY)
//
// KJ 2026-09-27: one linear walk round the garden instead of a set of one-line hints —
// nobody noticed the pill at the top. Each step is a centre-screen card (ui.tsx setCoach)
// plus the chevron trail and a light beacon pointing at where to go:
//   water → wake the Bloom → catch seeds → north arch → potting shed (seed rack) → your
//   plot → tend → harvest → flower shelf → Walk of Fame → round the loop to the Bloom.
// Every card has X (hide the card, keep the trail), Skip step and End tutorial; the
// Tutorial button by the pouch brings a closed card back or replays the walk from step 1.
//
// Steps finish on a CHANGE since the step began (a counter rising — my waters, my seeds,
// my planters, my tends, my flowers), never on the server's one-way onboarding flags, so
// a replay works for a veteran too. Walking steps finish on arrival; their trail follows
// a route of arches (see routeTarget).
//
// The trail is a row of chevrons from the target back to the player with a pulse running
// along it. The bob is driven from this system's own tick, never a looping Tween (the
// explorer writes every actively-tweened Transform back into the scene every frame —
// that is what tanked scene tick fps in the 09-18 perf pass).
//
// The gold shell highlight is DIFFERENT from the rest: it runs ALWAYS, on every planter
// the player owns (boxSystem's myPlanters) — a returning player can't spot their own
// planter among ninety-six look-alikes otherwise (KJ 2026-09-22).
//
// Phase 1 (2026-09-27): progress lives in this session. The server's onboardingState
// flags only decide whether a first-time player is dropped into the walk on join.
//
// ⚠️ Registered from index.ts AFTER setupWateringSystem(), which calls
// room.clear() — a handler registered before that clear is silently wiped.
// =============================================================

import { engine, Transform, GltfContainer, VisibilityComponent, ColliderLayer, Entity, MeshRenderer, Material, MaterialTransparencyMode } from '@dcl/sdk/ecs'
import { Quaternion, Vector3, Color4 } from '@dcl/sdk/math'
import { room } from './shared/messages'
import { PlantData, myWaterCount, getWateringStatus } from './wateringSystem'
import { isBloomActive } from './bloomSystem'
import { nearestFreePlanter, freePlanterPos, myOpenedPlanter, myOpenedPlanters, myPlanters, myGrowingStatus, myPlanterCount, myTendsTotal, myBedCentre } from './boxSystem'
import { getSeedCount, nearestSeedPos } from './seedSystem'
import { nearestFreeAvenueSlot } from './avenueSystem'
import { getFlowers, getArmedAvenueFlower, getPouch, getBoxCap } from './playerInventory'
import { hidePersistent, showMoment } from './notifications'
import { setCoach, registerCoachActions, setTutorialActive } from './ui'
import { playSfx } from './sounds'
import { triggerSparkle } from './sparkleSystem'
import { PROP_LAYOUT } from './shared/layout'
import {
  ARROW_MODEL_SRC, ARROW_SCALE, ARROW_FORWARD_YAW, ARROW_STANDOFF, ARROW_HIP_HEIGHT,
  ARROW_BOB_AMPLITUDE, ARROW_CHEVRON_MAX, ARROW_CHEVRON_SPACING, ARROW_WAVE_SPEED, ARROW_WAVE_LENGTH,
  BEACON_HEIGHT, BEACON_RADIUS, BEACON_COLOR, BEACON_ALPHA, BEACON_INTENSITY,
  BEACON_TAPER, BEACON_PULSE_PERIOD_S, BEACON_PULSE_DEPTH,
  TOON_HIGHLIGHT_SRC, TOON_HIGHLIGHT_SCALE,
  ONBOARDING_REPICK_S, ONBOARDING_MAX_RANGE,
  PLANTER_RESERVE_RETRY_S, AVENUE_ARROW_STANDOFF, BLOOM_CENTER, BLOOM_THRESHOLD, BLOOM_OPEN_MS,
  ARCH_NORTH, ARCH_SHED, ARCH_SOUTH, ARCH_FAME, ARCH_FAME_SOUTH, ARCH_SOUTH_SOUTH,
  TUTORIAL_ARRIVE_M, TUTORIAL_WAYPOINT_M, TUTORIAL_DONE_MS, TUTORIAL_TEXT, TutorialPoint,
} from './shared/config'

// ── Steps ─────────────────────────────────────────────────────

type StepId = 'water' | 'bloom' | 'seeds' | 'arch' | 'shed' | 'plot' | 'tend' | 'harvest' | 'shelf' | 'toFame' | 'fame' | 'loop'
const STEPS: ReadonlyArray<StepId> = ['water', 'bloom', 'seeds', 'arch', 'shed', 'plot', 'tend', 'harvest', 'shelf', 'toFame', 'fame', 'loop']

const RACK:  TutorialPoint = { x: PROP_LAYOUT['PouchRack'].x,   z: PROP_LAYOUT['PouchRack'].z }
const SHELF: TutorialPoint = { x: PROP_LAYOUT['FlowerShelf'].x, z: PROP_LAYOUT['FlowerShelf'].z }
const BLOOM: TutorialPoint = { x: BLOOM_CENTER.x, z: BLOOM_CENTER.z }
/** The Bloom is a big thing to arrive at — the loop ends anywhere near it. */
const BLOOM_ARRIVE_M = 8
const BLOOM_TRAIL_BACK_M = 12
let bloomTrailOn = true

/** Walking steps: arches in the order walked, the step's destination last. */
const ROUTES: Partial<Record<StepId, ReadonlyArray<TutorialPoint>>> = {
  arch:   [ARCH_NORTH],
  shed:   [ARCH_SHED, RACK],
  shelf:  [ARCH_SHED, SHELF],
  toFame: [ARCH_SHED, ARCH_NORTH, ARCH_SOUTH, ARCH_FAME],
  loop:   [ARCH_FAME_SOUTH, ARCH_SOUTH_SOUTH, BLOOM],
}

// ── State ─────────────────────────────────────────────────────

let active     = false
let stepIdx    = 0
let cardHidden = false
let routeFloor = -1                 // index of the waypoint being walked to; -1 = pick the entry on the next tick
let snap = { waters: 0, pouch: 0, planters: 0, tends: 0, flowers: 0 }

// First-time players are dropped into the walk on join, once per session, off the server's flags.
let autoStartDecided = false
let endedThisSession = false

let chevrons: Entity[] = []
// Shells and beacons are POOLS, not singletons: a gardener at the planter cap can have
// more than one flower standing open and wants every one of them marked (Fin 2026-09-21).
let shells:  Entity[] = []
let beacons: Entity[] = []

let target: Vector3 | null = null   // what the trail points at
let heldBoxId = ''                  // planter the server is holding for us ('' = none)
let pickedBoxId = ''                // planter the CLIENT chose to guide to when there is no reservation ('' = none)
let repickIn = 0
let retryIn  = 0
let elapsed  = 0
let shellAccum = 0                  // the always-on highlight's own repick clock
let wasBlooming = false
let bloomSeenAt = 0                 // local ms the Bloom started (0 = not seen start, e.g. joined mid-bloom)

const step = (): StepId => STEPS[stepIdx]
const pouchTotal = (): number => getPouch().reduce((a, n) => a + n, 0)
const flat = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z)

// ── Entities ──────────────────────────────────────────────────

function ensureChevrons(): Entity[] {
  if (chevrons.length === 0) {
    for (let i = 0; i < ARROW_CHEVRON_MAX; i++) {
      const e = engine.addEntity()
      Transform.create(e, { scale: Vector3.create(ARROW_SCALE, ARROW_SCALE, ARROW_SCALE) })
      // No colliders: a decal on the ground must not swallow a tap meant for a plant.
      GltfContainer.create(e, {
        src: ARROW_MODEL_SRC,
        visibleMeshesCollisionMask: ColliderLayer.CL_NONE,
        invisibleMeshesCollisionMask: ColliderLayer.CL_NONE,
      })
      VisibilityComponent.create(e, { visible: false })
      chevrons.push(e)
    }
  }
  return chevrons
}

function ensureShells(n: number): Entity[] {
  while (shells.length < n) {
    const e = engine.addEntity()
    Transform.create(e, { scale: Vector3.create(TOON_HIGHLIGHT_SCALE, TOON_HIGHLIGHT_SCALE, TOON_HIGHLIGHT_SCALE) })
    GltfContainer.create(e, {
      src: TOON_HIGHLIGHT_SRC,
      visibleMeshesCollisionMask: ColliderLayer.CL_NONE,
      invisibleMeshesCollisionMask: ColliderLayer.CL_NONE,
    })
    VisibilityComponent.create(e, { visible: false })
    shells.push(e)
  }
  return shells
}

/** A column of light standing on the current target, tall enough to clear the planting
 *  and read from the far side of the garden. Created on first use; only ever moved. */
function ensureBeacons(n: number): Entity[] {
  while (beacons.length < n) {
    const e = engine.addEntity()
    Transform.create(e)
    // 2026-09-28 ("prettier"): tapered, not a rigid uniform tube — flares at the base like
    // a real light column instead of reading as a solid coloured pipe stuck in the ground.
    MeshRenderer.setCylinder(e, BEACON_RADIUS, BEACON_RADIUS * BEACON_TAPER)
    Material.setPbrMaterial(e, {
      albedoColor:       Color4.create(BEACON_COLOR.r, BEACON_COLOR.g, BEACON_COLOR.b, BEACON_ALPHA),
      emissiveColor:     BEACON_COLOR,
      emissiveIntensity: BEACON_INTENSITY,
      transparencyMode:  MaterialTransparencyMode.MTM_ALPHA_BLEND,
      castShadows:       false,
    })
    VisibilityComponent.create(e, { visible: false })
    beacons.push(e)
  }
  return beacons
}

/** Stand a column of light on each target. */
function beaconsOn(targets: ReadonlyArray<Vector3>): void {
  const pool = ensureBeacons(targets.length)
  for (let i = 0; i < pool.length; i++) {
    const on = i < targets.length
    VisibilityComponent.getMutable(pool[i]).visible = on
    if (!on) continue
    // The primitive cylinder is one unit tall, centred on its origin.
    const t = Transform.getMutable(pool[i])
    t.position = Vector3.create(targets[i].x, targets[i].y + BEACON_HEIGHT / 2, targets[i].z)
    t.scale    = Vector3.create(1, BEACON_HEIGHT, 1)
  }
}

function showBeacons(visible: boolean): void {
  for (const e of beacons) VisibilityComponent.getMutable(e).visible = visible
}

/** Gentle breathing pulse on whichever beacons are currently visible — "free motion"
 *  instead of a flat static column. At most a handful ever exist, so a per-frame material
 *  rebuild here is cheap (unlike the 09-18 bloom-VFX flood, which was about scale). */
function beaconPulseSystem(): void {
  if (beacons.length === 0) return
  const t = Date.now() / 1_000
  const k = 1 - BEACON_PULSE_DEPTH * (0.5 + 0.5 * Math.sin((t / BEACON_PULSE_PERIOD_S) * Math.PI * 2))
  for (const e of beacons) {
    if (!VisibilityComponent.getOrNull(e)?.visible) continue
    Material.setPbrMaterial(e, {
      albedoColor:       Color4.create(BEACON_COLOR.r, BEACON_COLOR.g, BEACON_COLOR.b, BEACON_ALPHA * k),
      emissiveColor:     BEACON_COLOR,
      emissiveIntensity: BEACON_INTENSITY * k,
      transparencyMode:  MaterialTransparencyMode.MTM_ALPHA_BLEND,
      castShadows:       false,
    })
  }
}

function showChevrons(visible: boolean): void {
  for (const e of chevrons) VisibilityComponent.getMutable(e).visible = visible
}

/** Wear the gold shell on these planters. KJ 2026-09-20: the arrows point, but the
 *  highlight is what actually makes a planter findable among ninety-six of them. */
function shellsOnPlanters(ps: ReadonlyArray<{ x: number; z: number; rot: number; y: number }>): void {
  const pool = ensureShells(ps.length)
  for (let i = 0; i < pool.length; i++) {
    const on = i < ps.length
    VisibilityComponent.getMutable(pool[i]).visible = on
    if (!on) continue
    const t = Transform.getMutable(pool[i])
    t.position = Vector3.create(ps[i].x, ps[i].y, ps[i].z)   // y: the planter's own height (0 unless terraced)
    t.rotation = Quaternion.fromEulerDegrees(0, ps[i].rot, 0)
  }
}

// ── Targets ───────────────────────────────────────────────────

/** Nearest plant that still needs water, as a COPY — the live Transform position
 *  keeps changing underneath us. */
function nearestDroopyPlant(from: Vector3): Entity | null {
  let best: Entity | null = null
  let bestSq = ONBOARDING_MAX_RANGE * ONBOARDING_MAX_RANGE
  for (const [entity, plant] of engine.getEntitiesWith(PlantData)) {
    if (plant.isWatered) continue
    const p = Transform.getOrNull(entity)?.position
    if (!p) continue
    const dx = p.x - from.x
    const dz = p.z - from.z
    const sq = dx * dx + dz * dz
    if (sq < bestSq) { bestSq = sq; best = entity }
  }
  return best
}

/** The water step's trail stays on ONE plant. Re-picking the nearest dry plant every tick made
 *  the arrows jump to the next plant the moment you watered (optimistically, before the server
 *  confirmed and finished the step), and then jump again to the Bloom — "arrows reappeared
 *  twice" (KJ 2026-09-27). Once the chosen plant is watered the trail simply goes away while the
 *  step resolves; only if the step still has not finished after WATER_HOLD_MS (somebody else
 *  watered it) does it pick another plant. */
const WATER_HOLD_MS = 2_500
let waterTarget: Entity | null = null
let waterHeldSince = 0

function waterStepTarget(p: Vector3, hold: boolean): Vector3 | null {
  if (waterTarget !== null && PlantData.getOrNull(waterTarget)?.isWatered) {
    if (!waterHeldSince) waterHeldSince = Date.now()
    if (hold && Date.now() - waterHeldSince < WATER_HOLD_MS) return null
    waterTarget = null
  }
  if (waterTarget === null) { waterTarget = nearestDroopyPlant(p); waterHeldSince = 0 }
  const t = waterTarget !== null ? Transform.getOrNull(waterTarget)?.position : null
  return t ? Vector3.create(t.x, t.y, t.z) : null
}

/** Keep a planter held for us, and return where it stands. Asks again when we have
 *  none, or when the one we held was taken in the meantime. nearestFreePlanter steers to
 *  the player's own bed first, then the lowest-numbered free bed. */
function heldPlanter(from: Vector3, dt: number): Vector3 | null {
  retryIn -= dt
  if (heldBoxId) {
    const p = freePlanterPos(heldBoxId)
    if (p) return Vector3.create(p.x, 0, p.z)
    heldBoxId = ''            // someone planted in it — ask for another
  }
  if (retryIn <= 0) {
    retryIn = PLANTER_RESERVE_RETRY_S
    const candidate = nearestFreePlanter(from)
    if (candidate) room.send('reserveBox', { boxId: candidate.boxId })
  }
  // No reservation (yet, or the server said no — every bed held or taken): the client picks an empty bed itself and guides the player
  // to it anyway, arrows AND shell, instead of showing nothing (KJ 2026-09-30). The server still validates the plant when they tap.
  const pick = nearestFreePlanter(from)
  pickedBoxId = pick?.boxId ?? ''
  return pick ? Vector3.create(pick.x, 0, pick.z) : null
}

/** Can the plot step actually plant? Needs a seed AND room under the planter cap — pointing
 *  a capped player at a free planter is what produced KJ's conflicting toasts (2026-09-27). */
function canPlant(): boolean {
  return pouchTotal() > 0 && myPlanterCount() < getBoxCap()
}

/** My seedling that is still growing, nearest first. */
function myGrowingPlanter(from: Vector3): { x: number; z: number } | null {
  const opened = new Set(myOpenedPlanters(from).map(b => b.boxId))
  return myPlanters(from).find(b => !opened.has(b.boxId)) ?? null
}

/** Where a walking step's trail points. The route IS the path — arches in walking order — and
 *  the straight lines between them are the only lines known to clear the walls, so a waypoint
 *  is never skipped on distance alone. (KJ 2026-09-27: the old "cheapest way onto the route"
 *  pick sent step 12 straight at the Bloom through the Walk of Fame wall, because going direct
 *  cost less than going round by the arches.)
 *  The walk joins at the nearest ARCH when the step starts (never the destination itself), then
 *  moves on when you reach a waypoint, or once you are nearer the next one than it is. */
function routeTarget(route: ReadonlyArray<TutorialPoint>, p: Vector3): TutorialPoint {
  if (routeFloor < 0) {
    routeFloor = 0
    for (let i = 1; i < route.length - 1; i++) if (flat(p, route[i]) < flat(p, route[routeFloor])) routeFloor = i
  }
  while (routeFloor < route.length - 1) {
    const cur = route[routeFloor], next = route[routeFloor + 1]
    if (flat(p, cur) < TUTORIAL_WAYPOINT_M || flat(p, next) < flat(cur, next)) { routeFloor++; playSfx('tutorialWaypoint') }
    else break
  }
  return route[routeFloor]
}

// ── The trail ─────────────────────────────────────────────────

/** Lay the chevrons from `to` all the way back to the player's feet, every one aimed at
 *  `to`, with a pulse running along the row so the eye is pulled toward the target. */
function drawTrail(player: Vector3, to: Vector3): void {
  const row = ensureChevrons()
  let dx = player.x - to.x
  let dz = player.z - to.z
  const len = Math.sqrt(dx * dx + dz * dz)
  if (len > 0.001) { dx /= len; dz /= len } else { dx = 0; dz = 1 }
  const yaw = Math.atan2(-dx, -dz) * 180 / Math.PI + ARROW_FORWARD_YAW
  const rotation = Quaternion.fromEulerDegrees(0, yaw, 0)

  const span    = Math.max(0, len - ARROW_STANDOFF)
  const count   = Math.max(1, Math.min(ARROW_CHEVRON_MAX, Math.round(span / ARROW_CHEVRON_SPACING) + 1))
  const spacing = count > 1 ? span / (count - 1) : 0

  for (let i = 0; i < row.length; i++) {
    const visible = i < count
    VisibilityComponent.getMutable(row[i]).visible = visible
    if (!visible) continue
    const out = ARROW_STANDOFF + spacing * i
    const phase = (elapsed * ARROW_WAVE_SPEED - out) / ARROW_WAVE_LENGTH
    const bob   = (Math.sin(phase * Math.PI * 2) + 1) * 0.5 * ARROW_BOB_AMPLITUDE
    const t = Transform.getMutable(row[i])
    t.position = Vector3.create(to.x + dx * out, player.y + ARROW_HIP_HEIGHT + bob, to.z + dz * out)
    t.rotation = rotation
  }
}

// ── Avenue slot marker ───────────────────────────────────────
// An arrow standing a short distance out from the nearest free Avenue slot while a flower
// is armed from the menu (KJ 2026-09-22: reuse the arrow model, not the shell).

let avenueArrow: Entity | null = null

function showAvenueArrow(slot: { x: number; y: number; z: number; rot: number } | null): void {
  if (avenueArrow === null) {
    if (!slot) return
    avenueArrow = engine.addEntity()
    Transform.create(avenueArrow, { scale: Vector3.create(ARROW_SCALE, ARROW_SCALE, ARROW_SCALE) })
    GltfContainer.create(avenueArrow, { src: ARROW_MODEL_SRC, visibleMeshesCollisionMask: ColliderLayer.CL_NONE, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE })
    VisibilityComponent.create(avenueArrow, { visible: false })
  }
  VisibilityComponent.getMutable(avenueArrow).visible = !!slot
  if (!slot) return
  const r = (slot.rot * Math.PI) / 180
  const t = Transform.getMutable(avenueArrow)
  t.position = Vector3.create(slot.x + AVENUE_ARROW_STANDOFF * Math.sin(r), slot.y, slot.z + AVENUE_ARROW_STANDOFF * Math.cos(r))
  t.rotation = Quaternion.fromEulerDegrees(0, (slot.rot + 180) % 360 + ARROW_FORWARD_YAW, 0)
}

// ── Flow ──────────────────────────────────────────────────────

function enterStep(i: number): void {
  stepIdx    = i
  cardHidden = false
  routeFloor = -1
  waterTarget = null
  waterHeldSince = 0
  bloomTrailOn = true
  repickIn   = 0
  retryIn    = 0
  target     = null
  snap = { waters: myWaterCount(), pouch: pouchTotal(), planters: myPlanterCount(), tends: myTendsTotal(), flowers: getFlowers().length }
  room.send('tourProgress', { step: i, done: false })   // a rejoin resumes here
  console.log(`[Tutorial] step ${i + 1}/${STEPS.length} → ${step()}`)
}

function start(i = 0): void {
  active = true
  setTutorialActive(true)
  celebrate = null
  hidePersistent()
  enterStep(i)
}

function stop(): void {
  active = false
  setTutorialActive(false)
  celebrate = null
  target = null
  heldBoxId = ''
  setCoach(null)
  showChevrons(false)
  showBeacons(false)
}

// ── Payoff (KJ 2026-09-27: "we want each step to feel really satisfying") ──
// A finished step gets a rising chime, a sparkle burst at your feet, and a short green beat on
// the card (its dot turns gold) before the next step's card takes over. Skipping gets none of it.
const CELEBRATE_MS = 2_800   // KJ 2026-09-27: 1.4 s was too short to enjoy
const ACTION_STEPS: ReadonlySet<StepId> = new Set<StepId>(['water', 'bloom', 'seeds', 'plot', 'tend', 'harvest'])
const PRAISE = ['Nice!', 'Lovely!', 'Well done!', 'Beautiful!', 'Perfect!']
let celebrate: { until: number; step: number; title: string; body: string } | null = null

function reward(): void {
  const p = Transform.getOrNull(engine.PlayerEntity)?.position
  if (p) triggerSparkle({ x: p.x, y: p.y, z: p.z })
}

/** The step was DONE (not skipped): pay it off, then move on. */
function completeStep(): void {
  const last = stepIdx + 1 >= STEPS.length
  playSfx(last ? 'tutorialDone' : 'tutorialStep')
  // Action steps already have their own payoff (the watering splash, the seed catch, the
  // planting drop, the flower opening) — a second sparkle on top read as "two things at once"
  // (KJ 2026-09-27). The burst is for the walking steps, where arriving is otherwise silent.
  if (!ACTION_STEPS.has(step())) reward()
  if (!last) celebrate = { until: Date.now() + CELEBRATE_MS, step: stepIdx + 1, title: PRAISE[stepIdx % PRAISE.length], body: `${currentCardTitle()} - done` }
  advance()
}

function currentCardTitle(): string { return TUTORIAL_TEXT[step()].title }

function advance(): void {
  if (stepIdx + 1 < STEPS.length) { enterStep(stepIdx + 1); return }
  room.send('tourProgress', { step: stepIdx, done: true })   // finished: never auto-starts again
  stop()
  showMoment(TUTORIAL_TEXT.done.title, TUTORIAL_TEXT.done.body, TUTORIAL_DONE_MS)
}

function endTutorial(): void {
  endedThisSession = true
  room.send('tourProgress', { step: stepIdx, done: true })   // ended: never auto-starts again
  stop()
  showMoment('Tutorial ended', 'Tap ? to walk it again', 3_500)
}

/** Is the current step finished? Every check is a change since the step began, or an
 *  arrival — see the module header. */
function stepDone(p: Vector3): boolean {
  const s = step()
  const route = ROUTES[s]
  if (route) return flat(p, route[route.length - 1]) < (s === 'loop' ? BLOOM_ARRIVE_M : TUTORIAL_ARRIVE_M)
  switch (s) {
    case 'water':   return myWaterCount() > snap.waters
    // A real Bloom and a real catch, even on a replay: seeds already in the pouch used to finish
    // both at once and send a veteran straight to the nursery (KJ 2026-09-27). Skip step is the out.
    case 'bloom':   return isBloomActive() || getSeedCount() > 0
    case 'seeds':   return pouchTotal() > snap.pouch
    case 'plot': {
      if (canPlant()) return myPlanterCount() > snap.planters
      const bed = plotLookTarget(p)
      return !bed || flat(p, bed) < TUTORIAL_ARRIVE_M
    }
    // Tended once, or it is already open, or nothing of mine is growing to tend.
    case 'tend':    return myTendsTotal() > snap.tends || myOpenedPlanter(p) !== null || myGrowingStatus().count === 0
    case 'harvest': return getFlowers().length > snap.flowers || (myGrowingStatus().count === 0 && myOpenedPlanter(p) === null)
    case 'fame':    return false   // finished by its "Got it" button
    default:        return false
  }
}

/** A player who can't plant right now is shown their bed instead: theirs if they own
 *  one, else one of their planters, else the planter they would be steered to. */
function plotLookTarget(p: Vector3): { x: number; z: number } | null {
  return myBedCentre() ?? myPlanters(p)[0] ?? nearestFreePlanter(p)
}

function countdown(ms: number): string {
  const s = Math.ceil(ms / 1000)
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The card for the current step. Growing steps fold the live countdown into the body. */
function currentCard(p: Vector3): { title: string; body: string; primary?: string } {
  const s = step()
  if (s === 'plot' && !canPlant()) return TUTORIAL_TEXT.plotLook
  // KJ 2026-09-27: "wake the bloom" read as confusing — say how many plants, not a percentage.
  if (s === 'bloom') {
    const need = Math.max(0, BLOOM_THRESHOLD - getWateringStatus().wateredCount)
    return need > 0
      ? { title: TUTORIAL_TEXT.bloom.title, body: `Water ${need} more plant${need === 1 ? '' : 's'} to start the Bloom. Watered plants dry out, so keep going!` }
      : TUTORIAL_TEXT.bloom
  }
  // The seeds leave BLOOM_OPEN_MS after the trigger, once the flower is open — say so, or the
  // wait reads as nothing happening.
  if (s === 'seeds' && getSeedCount() === 0 && isBloomActive()) {
    const left = bloomSeenAt ? Math.ceil((BLOOM_OPEN_MS - (Date.now() - bloomSeenAt)) / 1000) : 0
    return { title: TUTORIAL_TEXT.seeds.title, body: left > 0 ? `Seeds fall in ${left}s - stay close and walk into one to catch it.` : 'Seeds are falling - walk into one to catch it.' }
  }
  if (s === 'fame') return { ...TUTORIAL_TEXT.fame, primary: 'Got it' }
  if (s === 'harvest' && myOpenedPlanter(p) === null) {
    const g = myGrowingStatus()
    return { title: TUTORIAL_TEXT.harvest.title, body: `Your seed opens in ${countdown(g.nextMs)} - water it at each stage, or water the garden while you wait.` }
  }
  if (s === 'tend') {
    const g = myGrowingStatus()
    return g.count > 0 ? { title: TUTORIAL_TEXT.tend.title, body: `${TUTORIAL_TEXT.tend.body} Opens in ${countdown(g.nextMs)}.` } : TUTORIAL_TEXT.tend
  }
  return TUTORIAL_TEXT[s]
}

/** Where the trail points for the current step, or null for none. */
function pickTarget(p: Vector3, dt: number): Vector3 | null {
  const s = step()
  const route = ROUTES[s]
  if (route) { const t = routeTarget(route, p); return Vector3.create(t.x, 0, t.z) }
  switch (s) {
    // Steps 1 and 2 are BOTH "water plants", so both point at a plant. Step 2 used to point at the
    // Bloom while its card said "water 12 more plants" — KJ 2026-09-27: "it wasn't clear if you're
    // directing me to the plants to water or to the main bloom". Step 1 holds on its one plant
    // (the step ends with that water); step 2 moves straight on to the next dry plant each time.
    case 'water': return waterStepTarget(p, true)
    case 'bloom': return waterStepTarget(p, false)
    case 'seeds': {
      // Once a seed is out, point at IT (KJ 2026-09-27: "arrows should connect to the seed, not
      // the Bloom"); while waiting for the first one, at the Bloom it will fall from.
      const seed = nearestSeedPos(p)
      if (seed) return Vector3.create(seed.x, 0, seed.z)
      // Hysteresis: hide inside BLOOM_ARRIVE_M, come back only past BLOOM_TRAIL_BACK_M, so the
      // trail does not blink on and off while you walk round the edge of the Bloom.
      const d = flat(p, BLOOM)
      bloomTrailOn = bloomTrailOn ? d > BLOOM_ARRIVE_M : d > BLOOM_TRAIL_BACK_M
      return bloomTrailOn ? Vector3.create(BLOOM.x, 0, BLOOM.z) : null
    }
    case 'plot': {
      if (canPlant()) return heldPlanter(p, dt)
      const b = plotLookTarget(p)
      return b ? Vector3.create(b.x, 0, b.z) : null
    }
    case 'tend': { const g = myGrowingPlanter(p); return g ? Vector3.create(g.x, 0, g.z) : null }
    case 'harvest': {
      const o = myOpenedPlanter(p) ?? myGrowingPlanter(p)
      return o ? Vector3.create(o.x, 0, o.z) : null
    }
    default: return null   // fame: you are already there
  }
}

// ── Systems ───────────────────────────────────────────────────

// (Notification pass 2026-09-27: the after-tutorial "idle guide" pill is gone. It sat at the
// top of the screen at all times and was the main source of "excessive notifications" — the
// Tutorial button is the way back to guidance now.)

function tutorialSystem(dt: number): void {
  elapsed += dt
  const player = Transform.getOrNull(engine.PlayerEntity)?.position

  // When the Bloom went off, as seen here — the "wait for it" countdown runs from this.
  const blooming = isBloomActive()
  if (blooming && !wasBlooming) bloomSeenAt = Date.now()
  if (!blooming) bloomSeenAt = 0
  wasBlooming = blooming

  // ── Always-on shell highlight — tutorial or not (see module header). ──
  shellAccum -= dt
  if (player && shellAccum <= 0) {
    shellAccum = ONBOARDING_REPICK_S
    const wanted: Array<{ x: number; z: number; rot: number; y: number }> = myPlanters(player)
    if (active && step() === 'plot' && (heldBoxId || pickedBoxId)) {
      const p = freePlanterPos(heldBoxId || pickedBoxId)
      if (p) wanted.push({ x: p.x, z: p.z, rot: p.rot, y: p.y })
    }
    shellsOnPlanters(wanted)
    showAvenueArrow(getArmedAvenueFlower() !== null ? nearestFreeAvenueSlot(player) : null)
  }

  if (!active) return
  if (!player) return

  repickIn -= dt
  if (repickIn <= 0) {
    repickIn = ONBOARDING_REPICK_S
    if (stepDone(player)) { completeStep(); if (!active) return }
    // A bloom that ends with nothing caught sends the player back to wake the next one.
    if (step() === 'seeds' && !isBloomActive() && getSeedCount() === 0 && pouchTotal() <= snap.pouch) enterStep(STEPS.indexOf('bloom'))
    target = pickTarget(player, ONBOARDING_REPICK_S)
    // No Skip on the last step (KJ 2026-09-27) — there is nothing to skip to; End tutorial stays.
    if (celebrate && Date.now() >= celebrate.until) celebrate = null
    if (!cardHidden) setCoach(celebrate
      ? { step: celebrate.step, of: STEPS.length, title: celebrate.title, body: celebrate.body, celebrate: true }
      : { step: stepIdx + 1, of: STEPS.length, skip: stepIdx < STEPS.length - 1, ...currentCard(player) })
  }

  // Close enough that the trail would only point at your feet: stand the beacon alone.
  if (!target || flat(player, target) < 1.5) showChevrons(false)
  else drawTrail(player, target)
  if (target) beaconsOn([target])
  else showBeacons(false)
}

/** Test panel: wipe my record on the server AND start the walk here and now. The join-time
 *  auto-start decides once per session, so a reset alone never restarted it (KJ 2026-09-27:
 *  worked on a fresh mobile account, not on desktop after a reset). */
export function adminResetOnboarding(): void {
  room.send('adminResetOnboarding', {})
  endedThisSession = false
  start(0)
}

export function setupOnboarding(): void {
  registerCoachActions({
    close:    () => { playSfx('tutorialTap'); cardHidden = true; setCoach(null) },
    skip:     () => { playSfx('tutorialTap'); celebrate = null; advance() },
    end:      () => { playSfx('tutorialTap'); endTutorial() },
    primary:  () => completeStep(),   // "Got it" counts as doing the step
    // Brings a closed card back; with no walk running, starts one from step 1.
    tutorial: () => { playSfx('tutorialTap'); if (active) { cardHidden = false; repickIn = 0 } else start(0) },
  })
  room.onMessage('onboardingState', (data) => {
    // Only the first message decides — the server re-sends after every first, and a player
    // who ended the walk must not be dropped back into it.
    if (autoStartDecided) return
    autoStartDecided = true
    if (endedThisSession || active) return
    // The server remembers the tour (2026-09-27): finished or ended = never auto-start again;
    // part-way = resume at that step. The old first-timer flags still start a brand-new player.
    if (data.tourDone) return
    const saved = Math.floor(data.tourStep ?? 0)
    if (saved > 0 && saved < STEPS.length) start(saved)
    else if (!data.watered)   start(STEPS.indexOf('water'))
    else if (!data.planted)   start(STEPS.indexOf('bloom'))
    else if (!data.harvested) start(STEPS.indexOf('tend'))
  })
  room.onMessage('boxReserved', (data) => {
    heldBoxId = data.boxId
    if (heldBoxId) console.log(`[Tutorial] planter ${heldBoxId} held for this gardener`)
  })
  engine.addSystem(tutorialSystem)
  engine.addSystem(beaconPulseSystem)
  console.log(`[Tutorial] ready · onboardingState listeners=${room.listenerCount('onboardingState')}`)
}
