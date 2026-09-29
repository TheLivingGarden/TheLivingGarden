import { lastSeenToStore } from '../src/server/lastSeen'

describe('when choosing which last-seen times to store', () => {
  let seen: Map<string, number>

  beforeEach(() => {
    seen = new Map([
      ['0xowner', 100],
      ['0xvisitor', 200],
      ['0xslotowner', 300]
    ])
  })

  it('should keep only the owners of a planter or an Avenue slot', () => {
    expect(lastSeenToStore(seen, ['0xowner', '0xslotowner'])).toEqual({ '0xowner': 100, '0xslotowner': 300 })
  })

  it('should match owners case-insensitively, storing the lowercase address', () => {
    expect(lastSeenToStore(seen, ['0xOWNER'])).toEqual({ '0xowner': 100 })
  })

  it('should skip an owner who has never been seen', () => {
    expect(lastSeenToStore(seen, ['0xnever'])).toEqual({})
  })

  describe('and thousands of visitors have come and gone', () => {
    let stored: Record<string, number>

    beforeEach(() => {
      for (let i = 0; i < 10_000; i++) seen.set(`0xvisitor${i}`, i)
      stored = lastSeenToStore(seen, ['0xowner'])
    })

    it('should stay bounded by the owners, far under the 512 KB value cap', () => {
      expect(JSON.stringify(stored).length).toBeLessThan(100)
    })
  })
})
