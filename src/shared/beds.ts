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

export const BED_SIZE = 4

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
  | { ok: false; reason: 'plot_taken'; ownerName: string; bed: number }
  | { ok: false; reason: 'own_bed_first'; bed: number }

/** May `player` plant in planter `boxId`? Rules (KJ 2026-09-25):
 *   - a free bed: fine, unless you already own a bed that still has a free planter (own bed first);
 *   - your own bed: fine;
 *   - someone else's bed: protected while ANY free bed exists, allowed once none is left (spill).
 *  Nothing here blocks a player who has somewhere to plant: a refusal always names where to go. */
export function checkPlant(beds: ReadonlyArray<Bed>, info: BoxInfoFn, player: string, boxId: string): PlantVerdict & { ok: boolean; reason?: string; ownerName?: string; bed?: number } {
  const target = beds.find(b => b.boxIds.includes(boxId))
  if (!target) return { ok: true }   // a planter outside every bed (e.g. added by the editor): no rule applies
  const owner = bedOwner(target, info)
  if (owner && owner.owner === player) return { ok: true }
  const freeBed = beds.some(b => bedOwner(b, info) === null)
  if (owner) {
    if (freeBed) return { ok: false, reason: 'plot_taken', ownerName: owner.ownerName, bed: target.id }
    return { ok: true }   // every bed is taken: spill into the shared field
  }
  const mine = beds.find(b => bedOwner(b, info)?.owner === player && b.boxIds.some(id => !info(id)?.owner))
  if (mine) return { ok: false, reason: 'own_bed_first', bed: mine.id }
  return { ok: true }
}
