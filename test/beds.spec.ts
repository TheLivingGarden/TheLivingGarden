import { deriveBeds, makeBeds, bedOwner, checkPlant, BoxOwnerInfo } from '../src/shared/beds'
import { BOX_POSITIONS, BED_FILL_ORIGIN, BEDS_EXPLICIT } from '../src/shared/config'

const grid = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `box_${i + 1}`, x: (i % 8) * 1.5, z: Math.floor(i / 8) * 3 }))
const origin = { x: 0, z: 0 }

describe('deriveBeds', () => {
  it('splits planters into beds of four, every planter in exactly one bed', () => {
    const beds = deriveBeds(grid(24), origin, 4)
    expect(beds).toHaveLength(6)
    const all = beds.flatMap(b => b.boxIds)
    expect(all).toHaveLength(24)
    expect(new Set(all).size).toBe(24)
    for (const b of beds) expect(b.boxIds).toHaveLength(4)
  })
  it('keeps a remainder as a smaller last bed', () => {
    const beds = deriveBeds(grid(10), origin, 4)
    expect(beds.map(b => b.boxIds.length)).toEqual([4, 4, 2])
  })
  it('numbers beds from the origin outward: bed 1 holds the planter nearest the origin', () => {
    const beds = deriveBeds(grid(24), origin, 4)
    expect(beds[0].id).toBe(1)
    expect(beds[0].boxIds).toContain('box_1')
    const d = (b: { cx: number; cz: number }) => Math.hypot(b.cx, b.cz)
    expect(d(beds[0])).toBeLessThanOrEqual(d(beds[beds.length - 1]))
  })
  it('is deterministic', () => {
    expect(deriveBeds(grid(24), origin, 4)).toEqual(deriveBeds(grid(24), origin, 4))
  })
  it('a bed is compact: its planters are near each other', () => {
    for (const b of deriveBeds(grid(24), origin, 4)) {
      const pts = b.boxIds.map(id => grid(24).find(p => p.id === id)!)
      const span = Math.max(...pts.map(a => Math.max(...pts.map(c => Math.hypot(a.x - c.x, a.z - c.z)))))
      expect(span).toBeLessThan(9)
    }
  })
})

describe('bedOwner and checkPlant', () => {
  const beds = deriveBeds(grid(16), origin, 4)   // 4 beds
  const info = (m: Record<string, BoxOwnerInfo>) => (id: string) => m[id]
  const A = 'alice', B = 'bob'
  const planted = (owner: string, at: number): BoxOwnerInfo => ({ owner, ownerName: owner, plantedAt: at })

  it('an empty bed has no owner; a planted one is owned by whoever planted in it', () => {
    const b0 = beds[0]
    expect(bedOwner(b0, info({}))).toBeNull()
    expect(bedOwner(b0, info({ [b0.boxIds[0]]: planted(A, 5) }))?.owner).toBe(A)
  })
  it('with two owners in one bed (a spill), the earliest planting owns it', () => {
    const b0 = beds[0]
    const m = { [b0.boxIds[0]]: planted(B, 9), [b0.boxIds[1]]: planted(A, 3) }
    expect(bedOwner(b0, info(m))?.owner).toBe(A)
  })
  it('a new player may plant in any free bed', () => {
    expect(checkPlant(beds, info({}), A, beds[2].boxIds[0]).ok).toBe(true)
  })
  it('you may plant in your own bed', () => {
    const m = { [beds[0].boxIds[0]]: planted(A, 1) }
    expect(checkPlant(beds, info(m), A, beds[0].boxIds[1]).ok).toBe(true)
  })
  it("someone else's plot is protected while a free bed exists", () => {
    const m = { [beds[0].boxIds[0]]: planted(A, 1) }
    const r = checkPlant(beds, info(m), B, beds[0].boxIds[1])
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('plot_taken')
    expect(r.ownerName).toBe(A)
  })
  it("...but spills into someone else's bed once no free bed is left", () => {
    const m: Record<string, BoxOwnerInfo> = {}
    beds.forEach((b, i) => { m[b.boxIds[0]] = planted(`p${i}`, i + 1) })   // every bed owned by someone
    expect(checkPlant(beds, info(m), B, beds[0].boxIds[1]).ok).toBe(true)
  })
  it('own bed first: with room in your bed you cannot start a second one', () => {
    const m = { [beds[0].boxIds[0]]: planted(A, 1) }
    const r = checkPlant(beds, info(m), A, beds[3].boxIds[0])
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('own_bed_first')
    expect(r.bed).toBe(beds[0].id)
  })
  it('once your bed is full you may take another free bed', () => {
    const m: Record<string, BoxOwnerInfo> = {}
    beds[0].boxIds.forEach((id, k) => { m[id] = planted(A, k + 1) })
    expect(checkPlant(beds, info(m), A, beds[3].boxIds[0]).ok).toBe(true)
  })
  it('a bed goes free again when its owner has emptied it', () => {
    expect(bedOwner(beds[0], info({}))).toBeNull()
    expect(checkPlant(beds, info({}), B, beds[0].boxIds[0]).ok).toBe(true)
  })
})

describe("the baked layout from KJ's scene.glb (2026-09-25)", () => {
  const beds = makeBeds(BOX_POSITIONS, BED_FILL_ORIGIN, BEDS_EXPLICIT)
  it('is 96 planters with unique ids', () => {
    expect(BOX_POSITIONS).toHaveLength(96)
    expect(new Set(BOX_POSITIONS.map(p => p.id)).size).toBe(96)
  })
  it('groups into 24 beds of exactly four', () => {
    expect(beds).toHaveLength(24)
    for (const b of beds) expect(b.boxIds).toHaveLength(4)
  })
  it('every bed is a tidy row: its planters span at most 4.5 m and share a facing', () => {
    for (const b of beds) {
      const ps = b.boxIds.map(id => BOX_POSITIONS.find(p => p.id === id)!)
      const span = Math.max(...ps.map(a => Math.max(...ps.map(c => Math.hypot(a.x - c.x, a.z - c.z)))))
      expect(span).toBeLessThanOrEqual(4.6)
      expect(new Set(ps.map(p => p.rot)).size).toBe(1)
    }
  })
  it("bed 1 holds KJ's four planted test planters, so they keep their plot", () => {
    expect([...beds[0].boxIds].sort()).toEqual(['box_100', 'box_4', 'box_6', 'box_99'])
  })
})

describe('makeBeds with explicit groups', () => {
  const ps = grid(10)
  it('uses the given groups, numbered in order, with centroids', () => {
    const beds = makeBeds(ps, origin, [['box_1', 'box_2'], ['box_5', 'box_6', 'box_7']])
    expect(beds.slice(0, 2).map(b => b.id)).toEqual([1, 2])      // the two given groups come first, in order
    expect(beds[1].boxIds).toEqual(['box_5', 'box_6', 'box_7'])
    expect(beds[0].boxIds).toEqual(['box_1', 'box_2'])
    expect(beds[0].cx).toBeCloseTo(0.75)
  })
  it('planters not named in any group still get a bed (nothing is left out)', () => {
    const beds = makeBeds(ps, origin, [['box_1', 'box_2']])
    expect(beds.flatMap(b => b.boxIds).sort()).toEqual(ps.map(p => p.id).sort())
  })
  it('ignores ids that are not planters, and empty groups', () => {
    const beds = makeBeds(ps, origin, [['nope', 'box_1'], []])
    expect(beds[0].boxIds).toEqual(['box_1'])
    expect(beds.every(b => b.boxIds.length > 0)).toBe(true)
  })
  it('falls back to the greedy grouping when no groups are given', () => {
    expect(makeBeds(ps, origin)).toEqual(deriveBeds(ps, origin))
  })
})
