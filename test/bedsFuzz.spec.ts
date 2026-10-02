import { makeBeds, checkPlant, bedOwner } from '../src/shared/beds'
import { BOX_POSITIONS, BED_FILL_ORIGIN, BEDS_EXPLICIT } from '../src/shared/config'

// Fuzz the plant/harvest rules the server runs: no bed may ever hold planters of two different gardeners.
describe('beds never mix gardeners', () => {
  it('holds under random plant / harvest sequences', () => {
    const beds = makeBeds(BOX_POSITIONS, BED_FILL_ORIGIN, BEDS_EXPLICIT)
    let seed = 12345
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296
    const players = Array.from({ length: 14 }, (_, i) => `p${i}`)
    const cap = new Map(players.map(p => [p, 2 + Math.floor(rnd() * 5)]))
    const boxes = new Map<string, { owner: string; ownerName: string; plantedAt: number }>()
    const info = (id: string) => boxes.get(id)
    let t = 0
    for (let step = 0; step < 20000; step++) {
      const p = players[Math.floor(rnd() * players.length)]
      const id = BOX_POSITIONS[Math.floor(rnd() * BOX_POSITIONS.length)].id
      if (rnd() < 0.35) { if (boxes.get(id)?.owner === p) boxes.delete(id); continue }
      if (boxes.has(id)) continue
      const owned = [...boxes.values()].filter(b => b.owner === p).length
      if (owned >= cap.get(p)!) continue
      if (!checkPlant(beds, info, p, id).ok) continue
      boxes.set(id, { owner: p, ownerName: p, plantedAt: ++t })
      for (const b of beds) {
        const owners = new Set(b.boxIds.map(i => boxes.get(i)?.owner).filter(Boolean))
        if (owners.size > 1) throw new Error(`step ${step}: bed ${b.id} mixes ${[...owners]} after ${p} planted ${id}`)
      }
    }
    expect(bedOwner(beds[0], info)).toBeDefined()
  })
})
