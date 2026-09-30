// =============================================================
// Bloom Garden v2 — Beds (shared by the server and the client)
//
// KJ 2026-09-25: keep ONE shared planter field (the social layer depends on everyone's planters
// being visible) but give it a sense of "my plot". Planters are grouped into BEDS of four. A bed
// belongs to whoever has planted in it; a new player is steered to a free bed and their planters
// stay together; other people's beds are protected while free beds remain.
//
// NO new storage: a bed's owner is derived from the planters already planted in it (which the
// server already persists), so there is nothing to migrate and the two sides cannot disagree.
// Pure functions only, so both sides run the same rule.
// =============================================================

export interface Bed { id: number; boxIds: string[]; cx: number; cz: number }
export interface BoxOwnerInfo { owner: string; ownerName: string; plantedAt: number }
export type BoxInfoFn = (boxId: string) => BoxOwnerInfo | undefined

/** KJ 2026-09-30: beds of TWO, not four. A gardener holds 2-6 planters (default 2), so a bed of four left half of every default
 *  gardener's bed empty and unusable by anyone else; pairs fit the default exactly, and a bigger gardener simply takes more beds. */
export const BED_SIZE = 2

/** Split one baked row/block into adjacent beds of BED_SIZE: order its planters along the axis it is longest on, then cut. */
function splitGroup<T extends { x: number; z: number }>(ps: T[]): T[][] {
  if (ps.length <= BED_SIZE) return [ps]
  const xs = ps.map(p => p.x), zs = ps.map(p => p.z)
  const alongX = Math.max(...xs) - Math.min(...xs) >= Math.max(...zs) - Math.min(...zs)
  const sorted = [...ps].sort((a, b) => alongX ? a.x - b.x || a.z - b.z : a.z - b.z || a.x - b.x)
  const out: T[][] = []
  for (let i = 0; i < sorted.length; i += BED_SIZE) out.push(sorted.slice(i, i + BED_SIZE))
  return out
}

/** Group planters into beds, numbered from `origin` outward (bed 1 is nearest — the potting shed's door in
 *  the new plaza). Greedy and deterministic: take the nearest unassigned planter, add its nearest unassigned
 *  neighbours. Explicit bed layouts can replace this later; nothing else depends on how beds are chosen. */
export function deriveBeds(
  planters: ReadonlyArray<{ id: string; x: number; z: number }>,
  origin: { x: number; z: number },
  size = BED_SIZE,
): Bed[] {
  const left = [...planters].sort((a, b) =>
    Math.hypot(a.x - origin.x, a.z - origin.z) - Math.hypot(b.x - origin.x, b.z - origin.z) || a.id.localeCompare(b.id))
  const beds: Bed[] = []
  while (left.length > 0) {
    const seed = left.shift()!
    const group = [seed]
    while (group.length < size && left.length > 0) {
      let bi = 0, bd = Infinity
      for (let i = 0; i < left.length; i++) {
        const d = Math.hypot(left[i].x - seed.x, left[i].z - seed.z)
        if (d < bd || (d === bd && left[i].id < left[bi].id)) { bd = d; bi = i }
      }
      group.push(left.splice(bi, 1)[0])
    }
    beds.push({
      id: beds.length + 1,
      boxIds: group.map(p => p.id),
      cx: group.reduce((s, p) => s + p.x, 0) / group.length,
      cz: group.reduce((s, p) => s + p.z, 0) / group.length,
    })
  }
  return beds
}

/** Beds from EXPLICIT groups of planter ids (the baked layout lists them, so a bed is always the row the artist laid out), numbered in the
 *  order given. Unknown ids and empty groups are dropped; planters named in no group still get beds (greedy fallback), so nothing is left out.
 *  With no groups at all this is deriveBeds. */
export function makeBeds(
  planters: ReadonlyArray<{ id: string; x: number; z: number }>,
  origin: { x: number; z: number },
  groups?: ReadonlyArray<ReadonlyArray<string>>,
): Bed[] {
  if (!groups || groups.length === 0) return deriveBeds(planters, origin)
  const byId = new Map(planters.map(p => [p.id, p]))
  const used = new Set<string>()
  const beds: Bed[] = []
  for (const g of groups) {
    const ps = g.map(id => byId.get(id)).filter((p): p is { id: string; x: number; z: number } => !!p && !used.has(p.id))
    if (ps.length === 0) continue
    ps.forEach(p => used.add(p.id))
    for (const part of splitGroup(ps)) {
      beds.push({ id: beds.length + 1, boxIds: part.map(p => p.id), cx: part.reduce((a, p) => a + p.x, 0) / part.length, cz: part.reduce((a, p) => a + p.z, 0) / part.length })
    }
  }
  const rest = planters.filter(p => !used.has(p.id))
  for (const b of deriveBeds(rest, origin)) beds.push({ ...b, id: beds.length + 1 })
  return beds
}

/** The owner of a bed: whoever planted first among its planted planters, or null when it is empty. */
export function bedOwner(bed: Bed, info: BoxInfoFn): BoxOwnerInfo | null {
  let best: BoxOwnerInfo | null = null
  for (const id of bed.boxIds) {
    const i = info(id)
    if (i && i.owner && (best === null || i.plantedAt < best.plantedAt)) best = i
  }
  return best
}

export type PlantVerdict =
  | { ok: true }
  | { ok: false; reason: 'plot_taken'; ownerName: string; bed: number; full: boolean }   // full = no unowned bed anywhere
  | { ok: false; reason: 'own_bed_first'; bed: number }

/** May `player` plant in planter `boxId`? Rules (KJ 2026-09-25):
 *   - a free bed: fine, unless you already own a bed that still has a free planter (own bed first);
 *   - your own bed: fine;
 *   - someone else's bed: always refused (KJ 2026-09-30: no spill; free beds come from the away-owner release).
 *  Nothing here blocks a player who has somewhere to plant: a refusal always names where to go. */
export function checkPlant(beds: ReadonlyArray<Bed>, info: BoxInfoFn, player: string, boxId: string): PlantVerdict & { ok: boolean; reason?: string; ownerName?: string; bed?: number; full?: boolean } {
  const target = beds.find(b => b.boxIds.includes(boxId))
  if (!target) return { ok: true }   // a planter outside every bed (e.g. added by the editor): no rule applies
  const owner = bedOwner(target, info)
  if (owner && owner.owner === player) return { ok: true }
  if (owner) return { ok: false, reason: 'plot_taken', ownerName: owner.ownerName, bed: target.id, full: !beds.some(b => bedOwner(b, info) === null) }   // never spill (KJ 2026-09-30): one owner per bed
  const mine = beds.find(b => bedOwner(b, info)?.owner === player && b.boxIds.some(id => !info(id)?.owner))
  if (mine) return { ok: false, reason: 'own_bed_first', bed: mine.id }
  return { ok: true }
}

/** Which OWNED bed to free so a newcomer can get a bed of their own (KJ 2026-09-29: with every bed owned, the "protected
 *  while a free bed exists" rule stops protecting anyone and players spill into each other's plots).
 *  A bed is only releasable when EVERY planter in it belongs to someone who is not connected and has been away at least
 *  `minAwayMs` (never seen = away forever). Of those, the bed whose most recent owner visit is oldest goes first.
 *  Returns null when nothing qualifies. `skip` = bed ids already tried this pass. */
export function pickBedToRelease(
  beds: ReadonlyArray<Bed>,
  info: BoxInfoFn,
  isConnected: (owner: string) => boolean,
  lastSeenAt: (owner: string) => number,
  now: number,
  minAwayMs: number,
  skip: ReadonlySet<number> = new Set(),
): Bed | null {
  let best: Bed | null = null, bestSeen = Infinity
  for (const bed of beds) {
    if (skip.has(bed.id)) continue
    const owners = bed.boxIds.map(id => info(id)).filter((i): i is BoxOwnerInfo => !!i && !!i.owner)
    if (owners.length === 0) continue                                   // already free
    if (owners.some(o => isConnected(o.owner) || now - lastSeenAt(o.owner) < minAwayMs)) continue
    const seen = Math.max(...owners.map(o => lastSeenAt(o.owner)))
    if (seen < bestSeen) { bestSeen = seen; best = bed }
  }
  return best
}
