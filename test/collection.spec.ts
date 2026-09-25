import { slimKeepsake, chunkCollection, CollectionAssembler, COLLECTION_CHUNK, MAX_SAFE_MESSAGE_BYTES } from '../src/shared/collection'

const flower = (i: number) => ({
  flower: `some_long_species_name_${i % 76}`, rarityTier: i % 8, at: 1790355278070 + i, from: i % 3 === 0 ? 'A Long Gardener Name' : undefined,
  grownBy: 'KJwalker3D', plantedAt: 1790351794204, openedAt: 1790351914204, helpers: ['Someone', 'Someone Else'], avenue: 2,
})

describe('slimKeepsake', () => {
  it('keeps only what the client uses and drops the provenance', () => {
    const s = slimKeepsake(flower(3)) as unknown as Record<string, unknown>
    expect(Object.keys(s).sort()).toEqual(['at', 'flower', 'from', 'rarityTier'])
  })
  it('omits an absent `from` instead of sending undefined', () => {
    expect('from' in slimKeepsake(flower(1))).toBe(false)
  })
})

describe('chunkCollection', () => {
  it('always yields at least one chunk, so an empty collection still reports the planter cap', () => {
    expect(chunkCollection([])).toEqual([{ start: 0, items: [] }])
  })
  it('splits into ordered chunks that reassemble to the original list', () => {
    const list = Array.from({ length: 500 }, (_, i) => slimKeepsake(flower(i)))
    const chunks = chunkCollection(list)
    expect(chunks.length).toBe(Math.ceil(500 / COLLECTION_CHUNK))
    expect(chunks.flatMap(c => c.items)).toEqual(list)
    chunks.forEach((c, i) => expect(c.start).toBe(i * COLLECTION_CHUNK))
  })
  it('keeps every chunk well under the message size limit even at the 500-flower cap', () => {
    const list = Array.from({ length: 500 }, (_, i) => slimKeepsake(flower(i)))
    for (const c of chunkCollection(list)) expect(JSON.stringify(c.items).length).toBeLessThan(MAX_SAFE_MESSAGE_BYTES)
  })
  it('the whole 500-flower collection would NOT fit one message (why it is chunked)', () => {
    const list = Array.from({ length: 500 }, (_, i) => slimKeepsake(flower(i)))
    expect(JSON.stringify(list).length).toBeGreaterThan(MAX_SAFE_MESSAGE_BYTES)
  })
})

describe('CollectionAssembler', () => {
  const list = Array.from({ length: 200 }, (_, i) => slimKeepsake(flower(i)))
  it('returns the full list once every chunk has arrived, in order', () => {
    const a = new CollectionAssembler()
    const chunks = chunkCollection(list)
    let done: unknown[] | null = null
    for (const c of chunks) done = a.add(c.start, list.length, c.items)
    expect(done).toEqual(list)
  })
  it('returns null while chunks are missing', () => {
    const a = new CollectionAssembler()
    const chunks = chunkCollection(list)
    expect(a.add(chunks[0].start, list.length, chunks[0].items)).toBeNull()
  })
  it('a new start-0 chunk restarts assembly, so a resync replaces a half-received list', () => {
    const a = new CollectionAssembler()
    const chunks = chunkCollection(list)
    a.add(chunks[0].start, list.length, chunks[0].items)
    a.add(0, 1, [list[5]])   // a fresh, shorter collection arrives
    expect(a.add(0, 1, [list[5]])).toEqual([list[5]])
  })
  it('an empty collection completes immediately', () => {
    expect(new CollectionAssembler().add(0, 0, [])).toEqual([])
  })
})
