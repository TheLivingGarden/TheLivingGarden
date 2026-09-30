// =============================================================
// Bloom Garden v2 — Podium: the top gardeners, as AVATARS (CLIENT ONLY)
//
// KJ 2026-09-20: show the all-time leaders as their own avatars on the stand in
// scene.glb rather than as another list of names. Four at a time, paged.
//
// ⚠️ THE RISK, stated plainly: AvatarShape only renders a player's REAL look if it
// is given their wearables. For a top-of-all-time board most of those players are
// offline, so we fetch their profile from a catalyst. If that fetch fails the slot
// still renders — as the DEFAULT body — so the podium degrades to generic figures
// rather than to nothing. Watch the [Podium] logs: they say which path each slot
// took, and that is what tells us whether this idea actually works.
//
// Perf: four full skinned avatars plus their wearable downloads is not cheap, and
// the scene already runs ~20 fps on KJ's iMac. PODIUM_COUNT = 0 turns it all off.
//
// ⚠️ setupPodium() runs from index.ts AFTER setupWateringSystem() (room.clear()).
// =============================================================

import {
  engine, Transform, AvatarShape, GltfContainer, MeshCollider, ColliderLayer,
  pointerEventsSystem, InputAction, Entity, TextShape, TextAlignMode,
} from '@dcl/sdk/ecs'
import { Quaternion, Vector3, Color4 } from '@dcl/sdk/math'
import { room } from './shared/messages'
import {
  PODIUM_SLOTS, PODIUM_ROTATION_Y, PODIUM_COUNT,
  PODIUM_PAGE_OFFSET, PODIUM_PAGE_SIZE, PODIUM_PAGE_Y, PODIUM_ARROW_ROLL,
  ARROW_MODEL_SRC, ARROW_SCALE, ARROW_FORWARD_YAW,
} from './shared/config'

interface BoardEntry { displayName: string; count: number; tier: number; address?: string }
/** The avatar's Transform carries an ABSOLUTE world position.
 *  CORRECTION 2026-09-21: an earlier note here blamed "a renderer ignoring the parent
 *  chain" for the avatars standing nowhere near the stand. That was wrong. The real cause
 *  was the GLB→world mapping negating X (see PODIUM_SLOTS in config) — the whole podium
 *  was ~16 m out along X, parented or not. Absolute transforms are kept because they are
 *  simpler to reason about, not because parenting is broken.
 *  No custom name plate any more (KJ 2026-09-22: "remove text above rendered avatars") —
 *  AvatarShape.name still gives each figure the platform's own floating nametag; how big
 *  that renders at a distance is native explorer behaviour with no scene-side control
 *  (PBAvatarShape has no size/distance field to tune — checked the schema). */
interface Slot {
  avatar: Entity; rank: Entity; waters: Entity
  /** What the avatar entity currently shows — a NEW entity is made whenever the person changes (see render). */
  shownAddress: string; sig: string
}

// "TOP GARDENERS" display (KJ 2026-09-29: the all-time LIST moved to the side-by-side boards on the far
// wall; the podium keeps the people). A title on the stand's dark screen, and over each avatar a big
// rank with their all-time waters underneath, on the panel behind them (Cube.001, face z -7.51). The
// captions sit in the clear band between the canopy's underside (y 5.74) and the avatars' nametags
// (about y 3.9), read from the garden side (+Z) so they turn 180. Both follow the paged entries.
const TITLE_TEXT   = 'TOP GARDENERS'
const TITLE_AT     = { x: 16.0, y: 7.45, z: -5.37 }   // on StandTop's screen (world y 7.0-8.7), garden face z -5.45
const CAP_Z        = -7.35
const CAP_RANK_Y   = 5.2
const CAP_WATERS_Y = 4.6
const CAP_GOLD     = Color4.create(1, 0.84, 0.1, 1)
const CAP_GREEN    = Color4.create(0.6, 1, 0.6, 1)

let entries: BoardEntry[] = []
let page = 0
const slots: Slot[] = []
let built = false

interface Look {
  wearables: string[]
  bodyShape: string
  skinColor?: { r: number; g: number; b: number }
  hairColor?: { r: number; g: number; b: number }
  eyeColor?:  { r: number; g: number; b: number }
}
/** address → their look, or null if the lookup failed. Never re-fetched. */
const profiles = new Map<string, Look | null>()
const fetching = new Set<string>()

// ── Profile lookup ────────────────────────────────────────────

/** Ask a catalyst what this wallet is wearing. Returns null (and logs) on any
 *  failure — the caller then renders the default body rather than nothing. */
async function fetchProfile(address: string): Promise<void> {
  if (profiles.has(address) || fetching.has(address)) return
  fetching.add(address)
  try {
    const res = await fetch(`https://peer.decentraland.org/lambdas/profiles/${address}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = await res.json()
    const av = body?.avatars?.[0]?.avatar
    const wearables: string[] = Array.isArray(av?.wearables) ? av.wearables : []
    const bodyShape: string = typeof av?.bodyShape === 'string' ? av.bodyShape : ''
    // Colours matter as much as the clothes — without them every gardener came out
    // with the same default skin and hair (KJ 2026-09-20).
    const col = (c: { r?: number; g?: number; b?: number } | undefined) =>
      c && typeof c.r === 'number' ? { r: c.r, g: c.g ?? 0, b: c.b ?? 0 } : undefined
    profiles.set(address, {
      wearables, bodyShape,
      skinColor: col(av?.skin?.color), hairColor: col(av?.hair?.color), eyeColor: col(av?.eyes?.color),
    })
    console.log(`[Podium] profile ${address.slice(0, 8)}… → ${wearables.length} wearable(s), body "${bodyShape}", skin ${av?.skin?.color ? 'yes' : 'no'}`)
  } catch (err) {
    profiles.set(address, null)
    console.log(`[Podium] profile ${address.slice(0, 8)}… FAILED (${err}) — falling back to the default body`)
  } finally {
    fetching.delete(address)
    render()
  }
}

// ── Build ─────────────────────────────────────────────────────

const podiumRotation = () => Quaternion.fromEulerDegrees(0, PODIUM_ROTATION_Y, 0)

/** Straight off the armature markers KJ placed in scene.glb — no centre-and-spacing
 *  maths, because the four are not evenly spaced and that is the point. */
function slotOffset(i: number): Vector3 {
  const p = PODIUM_SLOTS[i] ?? PODIUM_SLOTS[0]
  return Vector3.create(p.x, p.y, p.z)
}

function pageTarget(dir: -1 | 1): void {
  const pages = Math.max(1, Math.ceil(entries.length / PODIUM_COUNT))
  page = (page + dir + pages) % pages
  console.log(`[Podium] page ${page + 1}/${pages}`)
  render()
}

/** KJ 2026-09-22: "use our arrow models for the previous and next gardeners buttons" —
 *  the arrow's own tip does the pointing, so it needs no separate label. Yaw uses the
 *  exact same (direction → angle) conversion as onboarding.ts's drawTrail: feeding it the
 *  desired WORLD pointing direction (±X, since PODIUM_SLOTS runs along world X and
 *  PODIUM_ROTATION_Y — currently 0 — is the only thing that could rotate that away) makes
 *  the arrow point that way, corrected by the model's own authored-forward offset. */
function makePageButton(dir: -1 | 1): void {
  // Just outside whichever marker is furthest that way, so the pagers follow the markers
  // rather than a spacing constant that no longer exists.
  const xs = PODIUM_SLOTS.map(p => p.x)
  const endX = dir > 0 ? Math.max(...xs) : Math.min(...xs)
  const z = PODIUM_SLOTS.reduce((a, p) => a + p.z, 0) / PODIUM_SLOTS.length
  const at = Vector3.create(endX + dir * PODIUM_PAGE_OFFSET, PODIUM_SLOTS[0].y + PODIUM_PAGE_Y, z)
  // drawTrail's rule: yaw = atan2(d.x, d.z) + the model's authored-forward offset points the
  // tip along d. (The first cut had the sign flipped — Next pointed −X.) d = (dir, 0, 0).
  const yaw = Math.atan2(dir, 0) * 180 / Math.PI + ARROW_FORWARD_YAW

  // Two entities, not one composed quaternion: the parent yaws the flat chevron to point
  // along ±X, the child rolls it about its OWN tip axis (local Z) so the decal's face turns
  // from up (+Y) to the garden (+Z). Which way it rolls depends on which way it points, hence
  // the −dir; the hierarchy makes the order of the two rotations unambiguous.
  const pivot = engine.addEntity()
  Transform.create(pivot, { position: at, rotation: Quaternion.fromEulerDegrees(0, yaw, 0) })
  const e = engine.addEntity()
  Transform.create(e, { parent: pivot, rotation: Quaternion.fromEulerDegrees(0, 0, -dir * PODIUM_ARROW_ROLL), scale: Vector3.create(ARROW_SCALE, ARROW_SCALE, ARROW_SCALE) })
  GltfContainer.create(e, { src: ARROW_MODEL_SRC, visibleMeshesCollisionMask: ColliderLayer.CL_NONE, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE })

  // The arrow GLB carries no collision (decorative everywhere else it's used) — a
  // dedicated tap box, sized off the old flat-panel dimensions.
  const hit = engine.addEntity()
  Transform.create(hit, { position: at, scale: Vector3.create(PODIUM_PAGE_SIZE.x, PODIUM_PAGE_SIZE.y, PODIUM_PAGE_SIZE.z) })
  MeshCollider.setBox(hit, ColliderLayer.CL_POINTER)
  pointerEventsSystem.onPointerDown(
    { entity: hit, opts: { button: InputAction.IA_POINTER, hoverText: dir > 0 ? 'Next gardeners' : 'Previous gardeners', maxDistance: 8 } },
    () => pageTarget(dir),
  )
}

function newAvatarEntity(at: Vector3): Entity {
  const e = engine.addEntity()
  Transform.create(e, { position: at, rotation: podiumRotation() })
  return e
}

function build(): void {
  if (built || PODIUM_COUNT <= 0) return
  built = true
  for (let i = 0; i < PODIUM_COUNT; i++) {
    const at = slotOffset(i)

    const avatar = newAvatarEntity(at)

    const caption = (y: number, text: string, font: number, color: Color4): Entity => {
      const e = engine.addEntity()
      Transform.create(e, { position: { x: at.x, y, z: CAP_Z }, rotation: Quaternion.fromEulerDegrees(0, 180, 0) })
      TextShape.create(e, { text, fontSize: font, textColor: color, textAlign: TextAlignMode.TAM_MIDDLE_CENTER })
      return e
    }
    slots.push({ avatar, rank: caption(CAP_RANK_Y, '', 3.2, CAP_GOLD), waters: caption(CAP_WATERS_Y, '', 1.7, CAP_GREEN), shownAddress: '', sig: '' })
  }
  const title = engine.addEntity()
  Transform.create(title, { position: TITLE_AT, rotation: Quaternion.fromEulerDegrees(0, 180, 0) })
  TextShape.create(title, { text: TITLE_TEXT, fontSize: 3.2, textColor: CAP_GOLD, textAlign: TextAlignMode.TAM_MIDDLE_CENTER })
  makePageButton(-1)
  makePageButton(1)
  // Print every slot's WORLD position: the stand sits under a parent rotated -90° on Y,
  // so "where did the avatars actually go" is worth one line of proof rather than a
  // second round of squinting at screenshots.
  const where = slots.map((sl, i) => {
    const t = Transform.get(sl.avatar).position
    return `#${i + 1}(${t.x.toFixed(2)}, ${t.y.toFixed(2)}, ${t.z.toFixed(2)})`
  }).join(' ')
  console.log(`[Podium] built ${PODIUM_COUNT} plinth(s) — slots at ${where}  | from scene.glb armature markers`)
}

// ── Render ────────────────────────────────────────────────────

function render(): void {
  if (!built) return
  const start = page * PODIUM_COUNT
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]
    const e = entries[start + i]
    const address = (e?.address ?? '').toLowerCase()
    const p = address ? profiles.get(address) : undefined
    if (near && address && p === undefined) void fetchProfile(address)   // renders default until it lands (and never while nobody is close)
    // Skip a slot that would render exactly what it already shows: leaderboardUpdate arrives on EVERY water, and
    // re-issuing four AvatarShapes each time made the explorer reload the figures (KJ 2026-09-30).
    const sig = e ? `${address}|${e.displayName}|${e.count}|${p === undefined ? 'p?' : p === null ? 'p0' : 'p1'}|${near ? 'n' : 'f'}` : ''
    if (sig === slot.sig) continue
    slot.sig = sig
    TextShape.getMutable(slot.rank).text   = e ? `#${start + i + 1}` : ''
    TextShape.getMutable(slot.waters).text = e ? `${e.count} waters` : ''
    // A different person = a different ENTITY. Re-pointing one AvatarShape at another wallet left the explorer showing the
    // previous gardener's name plate (and sometimes a half-swapped body): it treats the entity's avatar as already loaded.
    const want = near && address ? address : ''
    if (want !== slot.shownAddress) {
      const at = Transform.get(slot.avatar).position
      engine.removeEntity(slot.avatar)
      slot.avatar = newAvatarEntity(at)
      slot.shownAddress = want
    }
    if (!e || !want) continue   // far away (or an empty pod): the figure is not built at all — see `near`
    AvatarShape.createOrReplace(slot.avatar, {
      id: address,
      name: e.displayName,
      wearables: p?.wearables ?? [],
      emotes: [],
      ...(p?.bodyShape  ? { bodyShape: p.bodyShape }   : {}),
      ...(p?.skinColor  ? { skinColor: p.skinColor }   : {}),
      ...(p?.hairColor  ? { hairColor: p.hairColor }   : {}),
      ...(p?.eyeColor   ? { eyeColor:  p.eyeColor  }   : {}),
    })
  }
}

// The gardeners wave when you walk up (KJ 2026-09-30). AvatarShape plays a stock emote when expressionTriggerId is set with a
// FRESH timestamp; the same id + timestamp again is ignored, so each wave stamps Date.now().
const WAVE_EMOTE     = 'wave'
const WAVE_RANGE_M   = 8
const WAVE_REPEAT_MS = 20_000
const WAVE_SCAN_S    = 0.5
// Lazy avatars (KJ 2026-09-30): four full skinned avatars plus their wearable downloads and catalyst lookups are only worth it when
// someone is standing near the podium. Built inside NEAR_IN_M, removed beyond NEAR_OUT_M.
const NEAR_IN_M  = 26
const NEAR_OUT_M = 34
let near = false
let waveScanIn = 0
const lastWaveAt = new Map<Entity, number>()
function podiumWaveSystem(dt: number): void {
  waveScanIn -= dt
  if (waveScanIn > 0) return
  waveScanIn = WAVE_SCAN_S
  const me = Transform.getOrNull(engine.PlayerEntity)?.position
  if (!me) return
  const now = Date.now()
  let nearest = Infinity
  for (const slot of slots) { const at = Transform.getOrNull(slot.avatar)?.position; if (at) nearest = Math.min(nearest, Math.hypot(at.x - me.x, at.z - me.z)) }
  const wasNear = near
  near = wasNear ? nearest < NEAR_OUT_M : nearest < NEAR_IN_M
  if (near !== wasNear) { console.log(`[Podium] avatars ${near ? 'built' : 'removed'} (nearest ${nearest.toFixed(0)} m)`); for (const s of slots) s.sig = ''; render() }
  for (const slot of slots) {
    if (!slot.shownAddress || !AvatarShape.has(slot.avatar)) continue
    const at = Transform.getOrNull(slot.avatar)?.position
    if (!at) continue
    if (Math.hypot(at.x - me.x, at.z - me.z) > WAVE_RANGE_M) { lastWaveAt.delete(slot.avatar); continue }   // walk off and back = a fresh wave
    if (now - (lastWaveAt.get(slot.avatar) ?? 0) < WAVE_REPEAT_MS) continue
    lastWaveAt.set(slot.avatar, now)
    const shape = AvatarShape.getMutable(slot.avatar)
    shape.expressionTriggerId = WAVE_EMOTE
    shape.expressionTriggerTimestamp = now
  }
}

export function setupPodium(): void {
  if (PODIUM_COUNT <= 0) { console.log('[Podium] disabled (PODIUM_COUNT = 0)'); return }
  build()
  engine.addSystem(podiumWaveSystem, 0, 'podiumWaveSystem')
  room.onMessage('leaderboardUpdate', (data) => {
    try { entries = JSON.parse(data.allTimeJson) as BoardEntry[] } catch { return }
    page = Math.min(page, Math.max(0, Math.ceil(entries.length / PODIUM_COUNT) - 1))   // a water elsewhere must not flip the page back
    render()
  })
  console.log(`[Podium] ready · leaderboardUpdate listeners=${room.listenerCount('leaderboardUpdate')}`)
}
