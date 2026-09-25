import type { KeyWriter } from '../src/server/persistence'

const mockSceneGet = jest.fn()
const mockSceneSet = jest.fn()
const mockPlayerGet = jest.fn()
const mockPlayerSet = jest.fn()

jest.mock('@dcl/sdk/server', () => ({
  Storage: {
    get: (...args: unknown[]) => mockSceneGet(...args),
    set: (...args: unknown[]) => mockSceneSet(...args),
    player: {
      get: (...args: unknown[]) => mockPlayerGet(...args),
      set: (...args: unknown[]) => mockPlayerSet(...args)
    }
  }
}))

type Persistence = typeof import('../src/server/persistence')

/** The module keeps global state (the in-flight counter, the write chain), so every
 *  test loads its own instance rather than inheriting the previous test's. */
async function loadPersistence(): Promise<Persistence> {
  jest.resetModules()
  return import('../src/server/persistence')
}

const settle = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('when reading a scene key', () => {
  let persistence: Persistence

  beforeEach(async () => {
    persistence = await loadPersistence()
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('and the key holds a value written with a version', () => {
    let storedValue: Array<{ plantId: string }>

    beforeEach(() => {
      storedValue = [{ plantId: 'Plant_1' }]
      mockSceneGet.mockResolvedValueOnce({ v: 4, d: storedValue })
    })

    it('should resolve the stored payload', async () => {
      await expect(persistence.loadScene('plants')).resolves.toEqual({
        ok: true,
        value: storedValue,
        version: 4
      })
    })

    it('should read the key without writing anything', async () => {
      await persistence.loadScene('plants')

      expect(mockSceneSet).not.toHaveBeenCalled()
    })
  })

  describe('and the key was written before versioning existed', () => {
    let storedValue: Array<{ address: string; total: number }>

    beforeEach(() => {
      storedValue = [{ address: '0x1', total: 4 }]
      mockSceneGet.mockResolvedValueOnce(storedValue)
    })

    it('should resolve the bare payload as the legacy version', async () => {
      await expect(persistence.loadScene('lifetime')).resolves.toEqual({
        ok: true,
        value: storedValue,
        version: persistence.LEGACY_VERSION
      })
    })
  })

  describe('and the key holds JSON text written before the envelope existed', () => {
    let storedValue: Array<{ boxId: string; owner: string }>

    beforeEach(() => {
      storedValue = [{ boxId: 'Box_1', owner: '0x1' }]
      mockSceneGet.mockResolvedValueOnce(JSON.stringify(storedValue))
    })

    it('should resolve the parsed payload as the legacy version', async () => {
      await expect(persistence.loadScene('boxes')).resolves.toEqual({
        ok: true,
        value: storedValue,
        version: persistence.LEGACY_VERSION
      })
    })
  })

  describe('and the key holds plain text that is not JSON', () => {
    beforeEach(() => {
      mockSceneGet.mockResolvedValueOnce('not json')
    })

    it('should resolve the text itself as the legacy version', async () => {
      await expect(persistence.loadScene('note')).resolves.toEqual({
        ok: true,
        value: 'not json',
        version: persistence.LEGACY_VERSION
      })
    })
  })

  describe('and the stored payload is an array inside an envelope', () => {
    beforeEach(() => {
      mockSceneGet.mockResolvedValueOnce({ v: 1, d: ['a', 'b'] })
    })

    it('should resolve the array rather than mistake it for an envelope', async () => {
      await expect(persistence.loadScene('discovered')).resolves.toEqual({
        ok: true,
        value: ['a', 'b'],
        version: 1
      })
    })
  })

  describe('and the key holds nothing', () => {
    beforeEach(() => {
      mockSceneGet.mockResolvedValueOnce(null)
    })

    it('should resolve a null value rather than report a failure', async () => {
      await expect(persistence.loadScene('boxes')).resolves.toEqual({
        ok: true,
        value: null,
        version: persistence.LEGACY_VERSION
      })
    })

    it('should cost a single call', async () => {
      await persistence.loadScene('boxes')

      expect(mockSceneGet).toHaveBeenCalledTimes(1)
    })
  })

  describe('and the read is rejected', () => {
    beforeEach(() => {
      mockSceneGet.mockRejectedValueOnce(new Error('Unable to retrieve realm information'))
    })

    it('should report the read as failed rather than as an empty key', async () => {
      await expect(persistence.loadScene('plants')).resolves.toEqual({ ok: false })
    })
  })

  describe('and forty reads are issued at once', () => {
    let peakInFlight: number

    beforeEach(() => {
      let inFlight = 0
      peakInFlight = 0
      mockPlayerGet.mockImplementation(async () => {
        inFlight++
        peakInFlight = Math.max(peakInFlight, inFlight)
        await settle(10)
        inFlight--
        return null
      })
    })

    it('should keep concurrent reads well under the runtime fetch cap of 32', async () => {
      await Promise.all(Array.from({ length: 40 }, (_, i) => persistence.loadPlayer(`0x${i}`, 'seeds')))

      expect(peakInFlight).toBeLessThanOrEqual(10)
    })
  })
})

describe('when reading a player key', () => {
  let persistence: Persistence
  let address: string

  beforeEach(async () => {
    persistence = await loadPersistence()
    address = '0xABCdef0000000000000000000000000000000001'
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('and the key holds a value', () => {
    beforeEach(() => {
      mockPlayerGet.mockResolvedValueOnce({ v: 1, d: { normal: 3 } })
    })

    it('should resolve the stored payload', async () => {
      await expect(persistence.loadPlayer(address, 'seeds')).resolves.toEqual({
        ok: true,
        value: { normal: 3 },
        version: 1
      })
    })

    it('should address the read to that player and key', async () => {
      await persistence.loadPlayer(address, 'seeds')

      expect(mockPlayerGet).toHaveBeenCalledWith(address, 'seeds')
    })
  })
})

describe('when saving through a key writer', () => {
  let persistence: Persistence

  beforeEach(async () => {
    persistence = await loadPersistence()
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('and the writer has not been enabled yet', () => {
    let writer: KeyWriter

    beforeEach(async () => {
      mockSceneSet.mockResolvedValue(true)
      writer = persistence.createSceneWriter('plants', 1)
      writer.save({ v: 1 })
      await settle(20)
    })

    it('should hold the save rather than write before the key has been read', () => {
      expect(mockSceneSet).not.toHaveBeenCalled()
    })
  })

  describe('and three saves are queued before the writer is enabled', () => {
    let writer: KeyWriter

    beforeEach(async () => {
      mockSceneSet.mockResolvedValue(true)
      writer = persistence.createSceneWriter('plants', 3)
      writer.save({ v: 1 })
      writer.save({ v: 2 })
      writer.save({ v: 3 })
      writer.enable()
      await writer.idle()
    })

    it('should write only the newest snapshot, stamped with the writer version', () => {
      expect(mockSceneSet).toHaveBeenCalledWith('plants', { v: 3, d: { v: 3 } })
    })

    it('should coalesce the three saves into one write', () => {
      expect(mockSceneSet).toHaveBeenCalledTimes(1)
    })
  })

  describe('and the save succeeds', () => {
    let writer: KeyWriter

    beforeEach(async () => {
      mockSceneSet.mockResolvedValue(true)
      writer = persistence.createSceneWriter('boxes', 1)
      writer.enable()
      writer.save({ a: 1 })
      await writer.idle()
    })

    it('should cost a single call', () => {
      expect(mockSceneSet).toHaveBeenCalledTimes(1)
    })
  })

  describe('and the first two attempts are reported as failed', () => {
    let writer: KeyWriter

    beforeEach(async () => {
      mockSceneSet.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true)
      writer = persistence.createSceneWriter('boxes', 1)
      writer.enable()
      writer.save({ v: 'final' })
      const deadline = Date.now() + 8000
      while (Date.now() < deadline && mockSceneSet.mock.calls.length < 3) await settle(50)
      await writer.idle()
    })

    it('should retry until the snapshot lands', () => {
      expect(mockSceneSet).toHaveBeenLastCalledWith('boxes', { v: 1, d: { v: 'final' } })
    })
  })

  describe('and the write throws instead of reporting a failure', () => {
    let writer: KeyWriter

    beforeEach(async () => {
      mockPlayerSet.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(true)
      writer = persistence.createPlayerWriter('0x9', 'flowers', 1)
      writer.enable()
      writer.save({ a: 1 })
      const deadline = Date.now() + 5000
      while (Date.now() < deadline && mockPlayerSet.mock.calls.length < 2) await settle(50)
      await writer.idle()
    })

    it('should treat the throw as a failure and retry it', () => {
      expect(mockPlayerSet.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('and the SDK refuses the snapshot', () => {
    let writer: KeyWriter
    let errors: jest.SpyInstance
    let problems: jest.Mock

    beforeEach(async () => {
      errors = jest.spyOn(console, 'error').mockImplementation(() => undefined)
      problems = jest.fn()
      persistence.onSaveProblem(problems)
      mockPlayerSet.mockRejectedValueOnce(new TypeError('Storage.player.set(): address must be a 0x-prefixed 20-byte hex address.'))
      writer = persistence.createPlayerWriter('guest', 'seeds', 1)
      writer.enable()
      writer.save({ common: 1 })
      await writer.idle()
      await settle(1500) // past the first retry delay, had it been scheduled
    })

    afterEach(() => {
      errors.mockRestore()
    })

    it('should not retry a snapshot the SDK will refuse again', () => {
      expect(mockPlayerSet).toHaveBeenCalledTimes(1)
    })

    it('should log the key and the reason', () => {
      expect(errors).toHaveBeenCalledWith(expect.stringMatching(/seeds@guest: save refused, snapshot dropped — .*address must be/))
    })

    it('should tell the listener the save was refused, with the reason', () => {
      expect(problems).toHaveBeenCalledWith('seeds@guest', expect.stringContaining('address must be'))
    })

    describe('and a later snapshot is accepted', () => {
      beforeEach(async () => {
        mockPlayerSet.mockResolvedValue(true)
        writer.save({ common: 2 })
        await writer.idle()
      })

      it('should write it', () => {
        expect(mockPlayerSet).toHaveBeenLastCalledWith('guest', 'seeds', { v: 1, d: { common: 2 } })
      })
    })
  })
  describe('and a newer snapshot arrives while an earlier one is failing', () => {
    let writer: KeyWriter

    beforeEach(async () => {
      mockPlayerSet.mockImplementationOnce(async () => {
        await settle(5)
        return false
      })
      mockPlayerSet.mockImplementation(async () => {
        await settle(5)
        return true
      })
      writer = persistence.createPlayerWriter('0xdef', 'seeds', 1)
      writer.enable()
      writer.save({ n: 1 })
      await settle(2)
      writer.save({ n: 2 })
      await writer.idle()
    })

    it('should let the newer snapshot supersede the failed one', () => {
      expect(mockPlayerSet).toHaveBeenLastCalledWith('0xdef', 'seeds', { v: 1, d: { n: 2 } })
    })
  })

  describe('and it is a player writer', () => {
    let writer: KeyWriter
    let address: string

    beforeEach(async () => {
      address = '0xabc'
      mockPlayerSet.mockResolvedValue(true)
      writer = persistence.createPlayerWriter(address, 'flowers', 1)
      writer.enable()
      writer.save([{ flower: 'Tulip' }])
      await writer.idle()
    })

    it('should address the write to that player and key', () => {
      expect(mockPlayerSet).toHaveBeenCalledWith(address, 'flowers', { v: 1, d: [{ flower: 'Tulip' }] })
    })
  })

  describe('and five different keys are written at once', () => {
    let peakInFlight: number
    let writers: KeyWriter[]

    beforeEach(async () => {
      let inFlight = 0
      peakInFlight = 0
      mockSceneSet.mockImplementation(async () => {
        inFlight++
        peakInFlight = Math.max(peakInFlight, inFlight)
        await settle(8)
        inFlight--
        return true
      })
      writers = ['plants', 'boxes', 'leaderboard', 'lifetimeTop', 'tributes'].map((key) =>
        persistence.createSceneWriter(key, 1)
      )
      writers.forEach((writer, i) => {
        writer.enable()
        writer.save({ i })
      })
      await Promise.all(writers.map((writer) => writer.idle()))
    })

    // The preview storage service rewrites the whole file per PUT, so two writes to
    // different keys in flight at once erase each other.
    it('should never overlap two writes, even across different keys', () => {
      expect(peakInFlight).toBe(1)
    })

    it('should still land a write for every key', () => {
      expect(mockSceneSet).toHaveBeenCalledTimes(5)
    })
  })

  describe('and the writer has gone idle', () => {
    let writer: KeyWriter
    let callsAtIdle: number

    beforeEach(async () => {
      mockPlayerSet.mockImplementation(async () => {
        await settle(5)
        return true
      })
      writer = persistence.createPlayerWriter('0x1', 'flowers', 1)
      writer.enable()
      writer.save({ a: 1 })
      await writer.idle()
      callsAtIdle = mockPlayerSet.mock.calls.length
      await settle(30)
    })

    it('should not write anything more after idle resolves', () => {
      expect(mockPlayerSet).toHaveBeenCalledTimes(callsAtIdle)
    })
  })
})

describe('when checking whether an address can key player storage', () => {
  let persistence: Persistence

  beforeEach(async () => {
    persistence = await loadPersistence()
  })

  it.each([
    ['a lowercase address', '0x1234567890abcdef1234567890abcdef12345678', true],
    ['a checksummed address', '0x1234567890ABCDEF1234567890abcdef12345678', true],
    ['a short address', '0x1234', false],
    ['a guest name', 'guest', false],
    ['a path segment', '..', false]
  ])('should answer for %s', (_label, address, storable) => {
    expect(persistence.isStorableAddress(address)).toBe(storable)
  })
})

