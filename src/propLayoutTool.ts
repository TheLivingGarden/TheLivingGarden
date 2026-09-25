// =============================================================
// Bloom Garden v2 — Prop layout editor (CLIENT ONLY, admin)
//
// KJ 2026-09-25: "streetlamps in my testing panel so I can move them — same to all loose
// models". Same verbs as the plant / planter editors: select nearest, pick up and carry,
// nudge, turn, export.
//
// A prop is a GROUP of composite entities that must move together — a lamppost is the post
// plus three light-level overlays (lamppost_light_high / _mid / _low) standing at the same
// spot, so moving the post alone would leave its light behind. Each member keeps its own
// small offset from the group's base, so nothing shifts relative to its neighbours.
//
// CLIENT-ONLY ON PURPOSE: no server draft and no new message type. The plant editor's
// server round trip silently lost 12 saves when the scene server was not restarted (see
// plantLayoutTool). Export prints a paste-ready PROP_LAYOUT block to the console and the
// edit lives for this session; bake it into shared/layout.ts to keep it.
// =============================================================

import { engine, Transform, TextShape, Billboard, BillboardMode, Entity } from '@dcl/sdk/ecs'
import { Quaternion } from '@dcl/sdk/math'
import { showToast } from './notifications'
import { PROP_LAYOUT } from './shared/layout'

const PLACE_AHEAD = 1.4
const GRID        = 0.1
const NUDGE       = 0.1
const NUDGE_Y     = 0.05
const TURN        = 15
const SELECT_NEAR = 8
const MARKER_Y    = 4.5
const TOAST_MS    = 3_000

interface Member { name: string; entity: Entity; off: { x: number; y: number; z: number }; rot: { x: number; y: number; z: number; w: number } }
interface Prop { id: string; members: Member[]; x: number; y: number; z: number; rotY: number; turned: boolean }

let on = false, started = false
let props = new Map<string, Prop>()
let selected: string | null = null
let carried = false
let marker: Entity | null = null

export function isPropToolOn(): boolean { return on }
export function propIsCarrying(): boolean { return carried }
export function propToolCount(): number { return props.size }
export function propSelectedInfo(): string {
  const p = selected ? props.get(selected) : undefined
  return p ? `${p.id} (${p.members.length} parts) — x ${p.x.toFixed(2)} y ${p.y.toFixed(2)} z ${p.z.toFixed(2)}  rot ${p.rotY}°` : 'No prop selected'
}

const snap = (v: number) => Number((Math.round(v / GRID) * GRID).toFixed(2))
const norm = (deg: number) => ((Math.round(deg) % 360) + 360) % 360
const yawOf = (q: { x: number; y: number; z: number; w: number }) =>
  norm((Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x)) * 180) / Math.PI)

function whereAmI(): { x: number; z: number; yaw: number } | null {
  const me  = Transform.getOrNull(engine.PlayerEntity)?.position
  const cam = Transform.getOrNull(engine.CameraEntity)?.rotation
  if (!me || !cam) return null
  const fx = 2 * (cam.x * cam.z + cam.w * cam.y)
  const fz = 1 - 2 * (cam.x * cam.x + cam.y * cam.y)
  return { x: me.x, z: me.z, yaw: (Math.atan2(fx, fz) * 180) / Math.PI }
}

/** The movable loose models, as groups of composite entity names. Add a row to make
 *  another prop movable — nothing else needs to change. */
function groupDefs(): Array<{ id: string; names: string[] }> {
  const defs: Array<{ id: string; names: string[] }> = []
  for (const s of ['', '_2', '_3', '_4']) {
    defs.push({
      id: `Lamppost${s || '_1'}`,
      names: [`lamppost${s}`, `lamppost_light_high${s}`, `lamppost_light_mid${s}`, `lamppost_light_low${s}`],
    })
  }
  for (let i = 1; i <= 12; i++) defs.push({ id: `SitSpot_${i}`, names: [`Sit Spot_${i}`] })
  defs.push({ id: 'DiscordButton', names: ['Discord Button'] }, { id: 'DiscordButton_2', names: ['Discord Button_2'] })
  defs.push({ id: 'PouchRack', names: ['PouchRack'] })   // the world seed rack (pouchRack.ts)
  return defs
}

/** Read every prop's CURRENT transform, whatever the composite and PROP_LAYOUT left it at. */
function readProps(): void {
  props = new Map()
  for (const def of groupDefs()) {
    const members: Member[] = []
    for (const name of def.names) {
      const entity = engine.getEntityOrNullByName(name)
      const t = entity ? Transform.getOrNull(entity) : null
      if (entity && t) members.push({ name, entity, off: { x: 0, y: 0, z: 0 }, rot: { ...t.rotation } })
    }
    if (members.length === 0) continue
    const base = Transform.get(members[0].entity)
    for (const m of members) {
      const t = Transform.get(m.entity)
      m.off = { x: t.position.x - base.position.x, y: t.position.y - base.position.y, z: t.position.z - base.position.z }
    }
    props.set(def.id, { id: def.id, members, x: base.position.x, y: base.position.y, z: base.position.z, rotY: yawOf(base.rotation), turned: false })
  }
}

function apply(id: string): void {
  const p = props.get(id)
  if (!p) return
  for (const m of p.members) {
    const t = Transform.getMutableOrNull(m.entity)
    if (!t) continue
    t.position = { x: p.x + m.off.x, y: p.y + m.off.y, z: p.z + m.off.z }
    if (p.turned) t.rotation = Quaternion.fromEulerDegrees(0, p.rotY, 0)   // untouched props keep their authored rotation
  }
  if (marker !== null && selected === id) Transform.getMutable(marker).position = { x: p.x, y: p.y + MARKER_Y, z: p.z }
}

/** Boot: place composite props from shared/layout.ts PROP_LAYOUT (empty = a no-op). */
export function applyPropLayout(): void {
  let moved = 0
  for (const [name, p] of Object.entries(PROP_LAYOUT)) {
    const entity = engine.getEntityOrNullByName(name)
    const t = entity ? Transform.getMutableOrNull(entity) : null
    if (!t) { console.log(`[Layout] no prop named "${name}" — skipped`); continue }
    t.position = { x: p.x, y: p.y, z: p.z }
    if (p.rotY !== undefined) t.rotation = Quaternion.fromEulerDegrees(0, p.rotY, 0)
    moved++
  }
  if (moved > 0) console.log(`[Layout] ${moved} props placed from shared/layout.ts`)
}

export function setPropTool(enabled: boolean): void {
  if (!started) { started = true; engine.addSystem(editorSystem) }
  on = enabled
  if (on) {
    readProps()
    showToast(`Prop editor on — ${props.size} props`, TOAST_MS, false)
  } else {
    carried = false
    select(null)
  }
}

function select(id: string | null): void {
  selected = id
  if (id === null) { if (marker !== null) { engine.removeEntity(marker); marker = null } return }
  if (marker === null) {
    marker = engine.addEntity()
    Transform.create(marker, { position: { x: 0, y: MARKER_Y, z: 0 } })
    TextShape.create(marker, { text: '', fontSize: 2.4, textColor: { r: 1, g: 0.85, b: 0.3, a: 1 }, outlineWidth: 0.2, outlineColor: { r: 0, g: 0, b: 0 } })
    Billboard.create(marker, { billboardMode: BillboardMode.BM_Y })
  }
  TextShape.getMutable(marker).text = `[ ${id} ]`
  apply(id)
}

function need(): Prop | null {
  if (!on) { showToast('Turn the prop editor on first', TOAST_MS, false); return null }
  const p = selected ? props.get(selected) : undefined
  if (!p) { showToast('Select a prop first', TOAST_MS, false); return null }
  return p
}

function changed(): void {
  if (selected) apply(selected)
  showToast(propSelectedInfo(), TOAST_MS, false)
}

export function propSelectNearest(): void {
  if (!on) { showToast('Turn the prop editor on first', TOAST_MS, false); return }
  const w = whereAmI()
  if (!w) return
  let best: string | null = null, bestSq = SELECT_NEAR * SELECT_NEAR
  props.forEach((p, id) => {
    const sq = (p.x - w.x) ** 2 + (p.z - w.z) ** 2
    if (sq < bestSq) { bestSq = sq; best = id }
  })
  if (best === null) { showToast(`No prop within ${SELECT_NEAR} m`, TOAST_MS, false); return }
  select(best)
  showToast(`Selected ${best}`, TOAST_MS, false)
}

export function propPickUpOrDrop(): void {
  if (need() === null) return
  if (carried) { carried = false; changed(); return }
  carried = true
  showToast('Carrying — walk, then Drop', TOAST_MS, false)
}

export function propNudge(dir: 'fwd' | 'back' | 'left' | 'right' | 'up' | 'down'): void {
  const p = need()
  if (p === null || carried) return
  if (dir === 'up' || dir === 'down') { p.y = Number((p.y + (dir === 'up' ? NUDGE_Y : -NUDGE_Y)).toFixed(3)); changed(); return }
  const w = whereAmI()
  if (!w) return
  const r = (w.yaw * Math.PI) / 180
  const f = { x: Math.sin(r), z: Math.cos(r) }
  const s = { x: Math.cos(r), z: -Math.sin(r) }
  const v = dir === 'fwd' ? f : dir === 'back' ? { x: -f.x, z: -f.z } : dir === 'left' ? { x: -s.x, z: -s.z } : s
  p.x = snap(p.x + v.x * NUDGE)
  p.z = snap(p.z + v.z * NUDGE)
  changed()
}

function rotateBy(d: number): void {
  const p = need()
  if (p === null) return
  p.rotY = norm(p.rotY + d); p.turned = true
  changed()
}
export function propRotateLeft(): void { rotateBy(-TURN) }
export function propRotateRight(): void { rotateBy(TURN) }
export function propSnap90(): void {
  const p = need()
  if (p === null) return
  p.rotY = norm(Math.round(p.rotY / 90) * 90); p.turned = true
  changed()
}

/** Print a paste-ready PROP_LAYOUT block (every member of every prop) to the console. */
export function propExport(): void {
  if (carried) { carried = false; changed() }
  const rows: string[] = []
  props.forEach(p => {
    for (const m of p.members) {
      const t = Transform.getOrNull(m.entity)
      if (!t) continue
      rows.push(`  '${m.name}': { x: ${Number(t.position.x.toFixed(3))}, y: ${Number(t.position.y.toFixed(3))}, z: ${Number(t.position.z.toFixed(3))}${p.turned ? `, rotY: ${p.rotY}` : ''} },`)
    }
  })
  console.log(`[PropLayout] ${props.size} props — paste into shared/layout.ts PROP_LAYOUT:\n${rows.join('\n')}`)
  showToast(`Exported ${rows.length} parts to the console`, TOAST_MS, false)
}

function editorSystem(): void {
  if (!on || !carried || !selected) return
  const p = props.get(selected)
  const w = whereAmI()
  if (!p || !w) return
  const r = (w.yaw * Math.PI) / 180
  const x = snap(w.x + Math.sin(r) * PLACE_AHEAD)
  const z = snap(w.z + Math.cos(r) * PLACE_AHEAD)
  if (x !== p.x || z !== p.z) { p.x = x; p.z = z; apply(selected) }
}
