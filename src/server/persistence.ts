// =============================================================
// The Living Garden — Server persistence
//
// A thin layer over @dcl/sdk/server's Storage. All I/O goes through the SDK;
// this module never talks to the storage service itself.
//
// The SDK serializes and coalesces writes per key, shares concurrent reads of
// the same key, caches confirmed values and absences, makes a read wait for the
// writes to its key already pending, and skips a write whose value is provably
// already stored. A read that fails rejects instead of resolving null, so a
// failure is never mistaken for an empty key. What it leaves to the caller is
// retrying a write it reports as failed: set() resolves false and does not retry.
// set() throws a TypeError, before sending anything, for a value it would store
// changed (NaN, a Map, undefined in an array, ...) or an invalid key or address.
// Retrying the same snapshot cannot help, so the writer logs it, drops it and
// writes the next snapshot normally. The server never builds such a value; a
// refusal means a bug, which a listener can surface (see onSaveProblem).
// =============================================================

import { Storage } from '@dcl/sdk/server'

/** Outcome of a read: a value, null when the key holds nothing, or a failure.
 *  `version` is the shape version the value was written with; 0 for a value
 *  stored before versioning, so a caller can migrate on the way in. */
export type LoadResult<T> =
  | { ok: true; value: T | null; version: number }   // null = the key holds nothing
  | { ok: false }                                    // the read threw and returned no answer

// ---------------------------------------------------------------
// Shape versions
// ---------------------------------------------------------------

/** Every value is written as this envelope: `v` is the shape version of `d`.
 *  Values written before versioning are bare payloads and read back as version 0,
 *  so nothing stored has to be rewritten before it can be read. */
interface Envelope { v: number; d: unknown }

/** Version stamped on a value stored before this envelope existed. */
export const LEGACY_VERSION = 0

function isEnvelope(x: unknown): x is Envelope {
  return !!x && typeof x === 'object' && !Array.isArray(x)
    && typeof (x as Envelope).v === 'number' && 'd' in (x as Envelope)
}

function unwrap<T>(stored: unknown): { value: T | null; version: number } {
  if (isEnvelope(stored)) return { value: (stored.d ?? null) as T | null, version: stored.v }
  return { value: (parseLegacy(stored) ?? null) as T | null, version: LEGACY_VERSION }
}

/** Before the envelope, the server stored every value as `JSON.stringify(...)` text, so a
 *  legacy string is JSON to parse, not the payload itself. Text that is not JSON is
 *  returned as it is (an unversioned string value). */
function parseLegacy(stored: unknown): unknown {
  if (typeof stored !== 'string') return stored
  try { return JSON.parse(stored) } catch { return stored }
}

// ---------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------

/** The authoritative-server runtime allows 32 concurrent fetches per scene and
 *  rejects the rest with "fetch: too many concurrent requests" (bevy-explorer
 *  SERVER_MAX_CONCURRENT_FETCHES, enforced in server mode only; hammurabi-headless
 *  mirrors it as maxConcurrentFetches). The cap counts every fetch the scene makes,
 *  and a slow one holds its slot for up to the 15 s fetch timeout. A rejected read
 *  now surfaces as a failed load rather than an empty key, but it still fails:
 *  pacing our own calls well below the cap keeps a join burst from failing a
 *  player's loads at all. Costs nothing when nothing is queued. */
const MAX_IN_FLIGHT = 8
let   inFlight      = 0
const waiting: Array<() => void> = []

/** Runs `fn` once a call slot frees up, keeping the scene under the fetch cap. */
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>(resolve => waiting.push(resolve))
  inFlight++
  try {
    return await fn()
  } finally {
    inFlight--
    waiting.shift()?.()
  }
}

/** One write in flight at a time, across every key. It keeps writes to one slot of
 *  the fetch cap, so a burst of saves cannot starve the reads of players joining.
 *  (It was introduced because the 7.26.1 preview storage server lost concurrent
 *  writes to different keys, as a harvest's 'boxes' write did to its 'flowers' write
 *  on 2026-09-17; the preview server in this sdk-commands locks each write.) */
let writeChain: Promise<unknown> = Promise.resolve()

/** Runs `write` after every earlier write has settled. */
function queuedWrite<T>(write: () => Promise<T>): Promise<T> {
  const run = writeChain.then(write, write)
  writeChain = run.catch(() => undefined)
  return run
}

// ---------------------------------------------------------------
// Reads
// ---------------------------------------------------------------

/** Reads through a slot, reporting a rejected read as a failure. */
async function load<T>(read: () => Promise<unknown>): Promise<LoadResult<T>> {
  try {
    return { ok: true, ...unwrap<T>(await withSlot(read)) }
  } catch {
    return { ok: false }   // get() rejects whenever the read fails
  }
}

/** Reads a scene-scoped key, shared by everyone in the world. */
export function loadScene<T>(key: string): Promise<LoadResult<T>> {
  return load<T>(() => Storage.get<unknown>(key))
}

/** Reads a key held against one player's address. */
export function loadPlayer<T>(address: string, key: string): Promise<LoadResult<T>> {
  return load<T>(() => Storage.player.get<unknown>(address, key))
}

// ---------------------------------------------------------------
// Values the SDK refuses
// ---------------------------------------------------------------

/** Whether an address can key player storage: the SDK and the service accept only a 0x-prefixed 20-byte hex address. */
export function isStorableAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address)
}

/** Receives every save the SDK refused, with the key's label and the SDK's reason. */
export type SaveProblemListener = (label: string, reason: string) => void
let saveProblemListener: SaveProblemListener | undefined

/** Registers the one listener told about refused saves, e.g. to notify an admin. */
export function onSaveProblem(listener: SaveProblemListener | undefined): void {
  saveProblemListener = listener
}

// ---------------------------------------------------------------
// Writes
// ---------------------------------------------------------------

const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS  = 30_000

/** Write-through for a single storage key: hold, coalesce, retry. */
export interface KeyWriter {
  /** Queue the current state, stamped with the writer's shape version. The SDK
   *  coalesces and orders the writes; this adds retry with backoff so a failed
   *  save is not silently lost. */
  save(snapshot: unknown): void
  /** Allow writes. Saves before this are held, so a blob is never written back
   *  before it has been read. */
  enable(): void
  /** Resolves once nothing is queued, in flight, or awaiting retry. */
  idle(): Promise<void>
}

/** Builds a writer over `write`. `label` names the key in retry logs. */
function createWriter(label: string, version: number, write: (value: unknown) => Promise<boolean>): KeyWriter {
  let enabled    = false
  let writing    = false
  let hasPending = false
  let pending: unknown = null
  let failures   = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let idleWaiters: Array<() => void> = []

  /** Releases idle() waiters once nothing is left to write. */
  function settleIdle(): void {
    if (hasPending || writing || retryTimer !== null) return
    const waiters = idleWaiters
    idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  /** One write attempt: whether it landed, failed and is worth retrying, or was refused and dropped. */
  async function attempt(value: unknown): Promise<'landed' | 'failed' | 'refused'> {
    try {
      return (await queuedWrite(() => write(value))) ? 'landed' : 'failed'
    } catch (error) {
      if (!(error instanceof TypeError)) return 'failed'
      console.error(`[Persistence] ${label}: save refused, snapshot dropped — ${error.message}`)
      saveProblemListener?.(label, error.message)
      return 'refused'
    }
  }

  /** Writes the newest snapshot, retrying with backoff until one lands. */
  async function flush(): Promise<void> {
    if (writing || !enabled || !hasPending) return
    writing = true
    while (hasPending) {
      const snapshot = pending
      hasPending = false
      const outcome = await attempt(snapshot)
      if (outcome !== 'failed') { failures = 0; continue }
      if (hasPending) continue        // a newer snapshot arrived; write that instead
      hasPending = true               // keep this one for the retry
      pending    = snapshot
      failures++
      const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(failures - 1, 5))
      console.error(`[Persistence] ${label}: save failed (attempt ${failures}) — retrying in ${delay / 1_000}s`)
      retryTimer = setTimeout(() => { retryTimer = null; void flush() }, delay)
      break
    }
    writing = false
    settleIdle()
  }

  return {
    save(snapshot) {
      pending    = { v: version, d: snapshot } satisfies Envelope
      hasPending = true
      if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null }
      void flush()
    },
    enable() {
      enabled = true
      void flush()
    },
    idle() {
      return new Promise<void>(resolve => { idleWaiters.push(resolve); settleIdle() })
    },
  }
}

/** Writer for a scene-scoped key. `version` stamps every value it writes. */
export function createSceneWriter(key: string, version: number): KeyWriter {
  return createWriter(key, version, value => Storage.set(key, value))
}

/** Writer for a key held against one player's address. */
export function createPlayerWriter(address: string, key: string, version: number): KeyWriter {
  return createWriter(`${key}@${address.slice(0, 8)}`, version, value => Storage.player.set(address, key, value))
}
