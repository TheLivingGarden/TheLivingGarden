import { growStageOf, tendsAvailable, growMsForTier, GROW_STAGE_AT, TEND_SHAVE_FRACTION, rollTierAtLeast, GUARANTEED_MAX_TIER, rollPlantSpecies, plantSpeciesById, PLANT_SPECIES, MYTHIC_PLANTS, UNIQUE_PLANTS, stampTotal, RARITY_TIERS, STAMP_MILESTONES, stampMilestoneTarget, nextStampMilestone, stampCount, ALMANAC_MILESTONES, rollRainbowTier } from '../src/shared/config'

describe('growth stages and tending', () => {
  const tier = 0
  const total = growMsForTier(tier)
  const opensAt = 1_000_000 + total   // planted at t=1_000_000
  const at = (progress: number) => 1_000_000 + Math.round(total * progress)

  it('starts at stage 0 with one tend available', () => {
    expect(growStageOf(opensAt, at(0), tier)).toBe(0)
    expect(tendsAvailable(opensAt, at(0), tier, 0)).toBe(1)
  })

  it('steps up exactly at the configured fractions', () => {
    expect(growStageOf(opensAt, at(GROW_STAGE_AT[1] - 0.01), tier)).toBe(0)
    expect(growStageOf(opensAt, at(GROW_STAGE_AT[1]), tier)).toBe(1)
    expect(growStageOf(opensAt, at(GROW_STAGE_AT[3]), tier)).toBe(3)
    expect(growStageOf(opensAt, at(1), tier)).toBe(3)
  })

  it('allows one tend per stage reached, minus the ones already used', () => {
    expect(tendsAvailable(opensAt, at(0.6), tier, 0)).toBe(3)   // stage 2 → 3 tends possible
    expect(tendsAvailable(opensAt, at(0.6), tier, 3)).toBe(0)
    expect(tendsAvailable(opensAt, at(0.6), tier, 2)).toBe(1)
  })

  it('never lets tending skip the wait: even every tend leaves at least 80% of the timer', () => {
    expect(GROW_STAGE_AT.length * TEND_SHAVE_FRACTION).toBeLessThanOrEqual(0.2)
  })

  it('scales with the seed tier, so a rarer seed still has four stages over its longer timer', () => {
    const t = 5
    const o = 5_000_000 + growMsForTier(t)
    expect(growStageOf(o, 5_000_000 + growMsForTier(t) * 0.9, t)).toBe(3)
  })
})

describe('top-tier rarity is hard', () => {
  it('rolling at-least-Rare essentially never lands on Mythic or Unique', () => {
    let top = 0
    const N = 20_000
    for (let i = 0; i < N; i++) if (rollTierAtLeast(2) >= 6) top++
    // weights: Mythic 0.15 + Unique 0.03 out of 45.18 for tiers >= Rare  → about 0.4%; allow a wide margin
    expect(top / N).toBeLessThan(0.02)
  })
})

describe('the guaranteed Rare+ seed can never be Mythic or Unique', () => {
  it('capped at Exotic: 20,000 guaranteed rolls never reach tier 6 or 7', () => {
    for (let i = 0; i < 20_000; i++) {
      const t = rollTierAtLeast(2, GUARANTEED_MAX_TIER)
      expect(t).toBeGreaterThanOrEqual(2)
      expect(t).toBeLessThanOrEqual(GUARANTEED_MAX_TIER)
    }
  })
  it('the cap is Exotic (tier 5)', () => { expect(GUARANTEED_MAX_TIER).toBe(5) })
})

describe('bespoke Mythic and Unique plants', () => {
  it('a Mythic or Unique seed opens into its own pool once the pool has plants', () => {
    if (MYTHIC_PLANTS.length === 0 || UNIQUE_PLANTS.length === 0) return   // pools are filled as the art lands
    for (let i = 0; i < 200; i++) {
      expect(MYTHIC_PLANTS.map(p => p.id)).toContain(rollPlantSpecies(6))
      expect(UNIQUE_PLANTS.map(p => p.id)).toContain(rollPlantSpecies(7))
    }
  })
  it('regular tiers never roll a bespoke plant', () => {
    const bespoke = new Set([...MYTHIC_PLANTS, ...UNIQUE_PLANTS].map(p => p.id))
    for (let i = 0; i < 500; i++) for (const t of [0, 1, 2, 3, 4, 5]) expect(bespoke.has(rollPlantSpecies(t))).toBe(false)
  })
  it('every rolled plant resolves through plantSpeciesById', () => {
    for (const t of [0, 3, 6, 7]) for (let i = 0; i < 50; i++) expect(plantSpeciesById(rollPlantSpecies(t))).not.toBeNull()
  })
  it('the stamp total is the sum of what can actually be found', () => {
    const regular = PLANT_SPECIES.length * (RARITY_TIERS.length - 2)
    expect(stampTotal()).toBe(regular + (MYTHIC_PLANTS.length || PLANT_SPECIES.length) + (UNIQUE_PLANTS.length || PLANT_SPECIES.length))
  })
})

describe('stamp milestones', () => {
  it('counts one stamp per species|tier entry, ignoring bare species ids and duplicates', () => {
    expect(stampCount([])).toBe(0)
    expect(stampCount(['cactus|0', 'cactus|1', 'cactus|1', 'tulip|0', 'daisy'])).toBe(3)
    expect(stampCount(['cactus|x', ''])).toBe(0)
  })
  it('the ladder is strictly increasing and ends at every stamp', () => {
    const targets = STAMP_MILESTONES.map(stampMilestoneTarget)
    for (let i = 1; i < targets.length; i++) expect(targets[i]).toBeGreaterThan(targets[i - 1])
    expect(targets[targets.length - 1]).toBe(stampTotal())
    expect(STAMP_MILESTONES[STAMP_MILESTONES.length - 1].stamps).toBe(-1)
  })
  it('every rung below the last is reachable at plan size (fewer than the total)', () => {
    for (const m of STAMP_MILESTONES.slice(0, -1)) expect(m.stamps).toBeLessThan(stampTotal())
  })
  it('rewards are real tiers and the planter grants stay small', () => {
    for (const m of STAMP_MILESTONES) { expect(m.seedTier).toBeGreaterThanOrEqual(0); expect(m.seedTier).toBeLessThan(RARITY_TIERS.length) }
    expect(STAMP_MILESTONES.reduce((a, m) => a + m.planters, 0)).toBeLessThanOrEqual(2)
  })
  it('nextStampMilestone is the first rung not yet reached, then null once finished', () => {
    expect(nextStampMilestone(0)?.stamps).toBe(STAMP_MILESTONES[0].stamps)
    expect(nextStampMilestone(STAMP_MILESTONES[0].stamps)?.title).toBe(STAMP_MILESTONES[1].title)
    expect(nextStampMilestone(stampTotal())).toBeNull()
  })
})

describe('nothing hands out a Mythic or a Unique except the ordinary hard roll', () => {
  it('no milestone reward (species ladder or stamp ladder) is above Exotic', () => {
    for (const m of ALMANAC_MILESTONES) expect(m.seedTier).toBeLessThanOrEqual(GUARANTEED_MAX_TIER)
    for (const m of STAMP_MILESTONES) expect(m.seedTier).toBeLessThanOrEqual(GUARANTEED_MAX_TIER)
  })
  it('the golden rainbow seed never rolls above Exotic (20,000 catches)', () => {
    for (let i = 0; i < 20_000; i++) expect(rollRainbowTier()).toBeLessThanOrEqual(GUARANTEED_MAX_TIER)
  })
})
