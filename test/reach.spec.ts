import { reachVerdict } from '../src/server/reach'

const plant = { x: 10, y: 1, z: 10 }

describe('the waterPlant reach rule', () => {
  it('allows a player standing next to the plant', () => {
    expect(reachVerdict(plant, { x: 11, y: 0, z: 10 }, 4)).toBe('ok')
  })
  it('rejects a player across the garden', () => {
    expect(reachVerdict(plant, { x: 30, y: 0, z: 10 }, 4)).toBe('too_far')
  })
  it('rejects just outside the reach and allows just inside it', () => {
    expect(reachVerdict({ x: 0, y: 0, z: 0 }, { x: 4.01, y: 0, z: 0 }, 4)).toBe('too_far')
    expect(reachVerdict({ x: 0, y: 0, z: 0 }, { x: 3.99, y: 0, z: 0 }, 4)).toBe('ok')
  })
  it('cannot measure a player the server has no position for, so it does not reject them (the phone bug)', () => {
    expect(reachVerdict(plant, null, 4)).toBe('unverified')
    expect(reachVerdict(plant, undefined, 4)).toBe('unverified')
  })
  it('rejects when the plant itself has no position', () => {
    expect(reachVerdict(null, { x: 0, y: 0, z: 0 }, 4)).toBe('no_plant')
  })
  it('still checks a player who is at the exact origin, so standing at (0,0,0) is no bypass', () => {
    expect(reachVerdict(plant, { x: 0, y: 0, z: 0 }, 4)).toBe('too_far')
  })
})
