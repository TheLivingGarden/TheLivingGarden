import { chooseHandSeed } from '../src/server/hand'

describe('chooseHandSeed — what a gardener holds in their hand', () => {
  const pouch = [3, 0, 1, 0, 0, 0, 0, 0]   // 3 Common, 1 Rare

  it('shows the rarest seed they hold by default', () => {
    expect(chooseHandSeed(pouch, false, undefined)).toEqual({ tier: 2, equipped: undefined })
  })

  it('shows nothing when the pouch is empty — a hand seed must never outlive the pouch', () => {
    expect(chooseHandSeed([0, 0, 0, 0, 0, 0, 0, 0], false, undefined).tier).toBe(-1)
    expect(chooseHandSeed([0, 0, 0, 0, 0, 0, 0, 0], false, 2).tier).toBe(-1)
  })

  it('shows nothing when there is no pouch loaded at all', () => {
    expect(chooseHandSeed(undefined, false, undefined).tier).toBe(-1)
  })

  it('a keepsake in the hand wins over an equipped seed', () => {
    expect(chooseHandSeed(pouch, true, 0).tier).toBe(-1)
  })

  it('an equipped seed is shown while they still have one of that tier', () => {
    expect(chooseHandSeed(pouch, false, 0)).toEqual({ tier: 0, equipped: 0 })
  })

  it('an equipped seed of an exhausted tier is dropped and falls back to the rarest held', () => {
    expect(chooseHandSeed(pouch, false, 1)).toEqual({ tier: 2, equipped: undefined })
  })

  it('tolerates a short or holey pouch array', () => {
    expect(chooseHandSeed([2], false, 5)).toEqual({ tier: 0, equipped: undefined })
  })
})
