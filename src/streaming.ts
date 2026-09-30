// =============================================================
// Bloom Garden v2 — distance streaming (CLIENT ONLY)
//
// The scene is ~90 m across and everything is spawned up front: 96 planters (each a ~4k-tri model plus a balloon, a plant
// and a countdown text), 24 gallery stands and the flowers on them. A phone draws all of it whichever end of the garden it
// stands at. This hides whole groups that are FAR from the player and shows them again on approach (KJ 2026-09-30: "lazy
// loading for plants, planters, stands").
//
// HIDE, don't destroy. Recreating models made the Unity explorer's ResetMaterialSystem throw before (see retirePlant), and a
// re-created GLB re-loads from scratch — visibility is instant and free to flip back. Each entity gets its OWN
// VisibilityComponent: the phone client has propagated visibility inconsistently between parent and child (bloom-garden v1
// mobile bug), so nothing here relies on a parent hiding its children.
//
// Nothing interactive is ever hidden: a group only hides beyond ~35-60 m, far outside pointer reach (7-8 m), and callers can
// exempt items that must stay shown (my own planters, the planter the tutorial is pointing at).
//
// The sweep is throttled (O(items), twice a second) and hysteretic (IN < OUT) so nothing flickers on the boundary.
// =============================================================

import { engine, Entity, Transform, VisibilityComponent } from '@dcl/sdk/ecs'
import { isMobile } from '@dcl/sdk/platform'

export interface StreamItem {
  key: string
  x: number
  z: number
  /** Every entity that draws this item. Entities that appear later are picked up on the next sweep. */
  entities: ReadonlyArray<Entity | null | undefined>
  /** True = never hide this one. */
  keep?: boolean
}

/** TUNING. Metres from the player. Phone: tight, because the frame budget is what we are protecting; desktop: loose,
 *  since only the far ends of the map ever fall outside it. Read lazily — the platform is not known at module load. */
const RANGE_IN  = (): number => isMobile() ? 34 : 60   // hidden items come back inside this
const RANGE_OUT = (): number => isMobile() ? 40 : 68   // shown items go away beyond this
const SWEEP_S = 0.5

interface Source { name: string; items: () => StreamItem[] }
interface State { hidden: boolean; applied: Set<Entity> }

const sources: Source[] = []
const states = new Map<string, State>()
let sweepIn = 0
let installed = false

/** Register a group of streamed items. `items` is re-read every sweep, so it can follow entities created later. */
export function registerStreamSource(name: string, items: () => StreamItem[]): void {
  sources.push({ name, items })
  if (!installed) { installed = true; engine.addSystem(streamSystem, 0, 'streamSystem') }
}

/** Stream a whole prop: `root` and every entity parented under it, however deep. The tree is (re)collected now and then rather than
 *  every sweep — props are built once at setup, so a slow refresh is enough to catch anything added later. */
export function registerStreamedTree(name: string, root: Entity): void {
  let cache: Entity[] = []
  let refreshedAt = -Infinity
  registerStreamSource(name, () => {
    const t = Date.now()
    if (t - refreshedAt > (cache.length > 1 ? 30_000 : 2_000)) { refreshedAt = t; cache = collectTree(root) }
    const p = Transform.getOrNull(root)?.position
    return p ? [{ key: name, x: p.x, z: p.z, entities: cache }] : []
  })
}

function collectTree(root: Entity): Entity[] {
  const children = new Map<Entity, Entity[]>()
  for (const [e, tr] of engine.getEntitiesWith(Transform)) {
    if (!tr.parent) continue
    const list = children.get(tr.parent)
    if (list) list.push(e); else children.set(tr.parent, [e])
  }
  const out: Entity[] = [root]
  for (let i = 0; i < out.length; i++) for (const c of children.get(out[i]) ?? []) out.push(c)
  return out
}

// Visibility flips are QUEUED and drained a few per frame (KJ 2026-09-30, "stuttering"): crossing a range boundary used to flip a few
// hundred entities inside one tick, and every flip is a component write the renderer has to act on. A steady trickle costs nothing.
const STREAM_BUDGET_PER_FRAME = 30
const flipQueue: Array<[Entity, boolean]> = []
function setShown(e: Entity, shown: boolean): void { flipQueue.push([e, shown]) }
function applyShown(e: Entity, shown: boolean): void {
  if (!Transform.has(e)) return   // removed since we hid it
  if (shown) VisibilityComponent.deleteFrom(e)
  else VisibilityComponent.createOrReplace(e, { visible: false })
}

function streamSystem(dt: number): void {
  for (let n = 0; n < STREAM_BUDGET_PER_FRAME && flipQueue.length > 0; n++) { const [e, shown] = flipQueue.shift()!; applyShown(e, shown) }
  sweepIn -= dt
  if (sweepIn > 0) return
  sweepIn = SWEEP_S
  const me = Transform.getOrNull(engine.PlayerEntity)?.position
  if (!me) return
  const inSq = RANGE_IN() * RANGE_IN(), outSq = RANGE_OUT() * RANGE_OUT()
  for (const src of sources) {
    let hiddenCount = 0
    const items = src.items()
    for (const it of items) {
      const k = `${src.name}:${it.key}`
      let st = states.get(k)
      if (!st) { st = { hidden: false, applied: new Set() }; states.set(k, st) }
      const dx = it.x - me.x, dz = it.z - me.z
      const sq = dx * dx + dz * dz
      const wantHidden = !it.keep && (st.hidden ? sq >= inSq : sq > outSq)   // hysteresis
      if (wantHidden) {
        for (const e of it.entities) if (e != null && !st.applied.has(e)) { setShown(e, false); st.applied.add(e) }
        st.hidden = true
        hiddenCount++
      } else if (st.hidden || st.applied.size > 0) {
        for (const e of st.applied) setShown(e, true)
        st.applied.clear()
        st.hidden = false
      }
    }
    if (hiddenCount !== lastHidden.get(src.name)) {
      lastHidden.set(src.name, hiddenCount)
      console.log(`[Stream] ${src.name}: ${hiddenCount}/${items.length} hidden`)
    }
  }
}
const lastHidden = new Map<string, number>()
