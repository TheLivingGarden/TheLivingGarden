// =============================================================
// The Living Garden — Server persistence
//
// A thin layer over @dcl/sdk/server's Storage. All I/O goes through the SDK;
// this module never talks to the storage service itself.
//
// The SDK serializes and coalesces writes per key, shares concurrent reads of
// the same key, caches confirmed values and absences, memoizes the realm lookup
// and skips a write whose value is provably already stored. What it leaves to
// the caller is retrying a write it reports as failed: set() does not retry, and
// a false result is a lost save unless someone acts on it.
// =============================================================

import { Storage } from '@dcl/sdk/server'

/** Outcome of a read: a value, null when the key holds nothing, or a failure. */
export type LoadResult<T> =
  | { ok: true; value: T | null }     // null = the key holds nothing
  | { ok: false }                     // the read threw and returned no answer

// ---------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------

/** The authoritative-server runtime allows 32 concurrent fetches per scene and
 *  rejects the rest with "fetch: too many concurrent requests" (bevy-explorer
 *  SERVER_MAX_CONCURRENT_FETCHES, enforced in server mode only; hammurabi-headless
 *  mirrors it as maxConcurrentFetches). The cap counts every fetch the scene makes,
 *  and a slow one holds its slot for up to the 15 s fetch timeout. The SDK turns
 *  that rejection into a plain null, which is indistinguishable from an empty key,
 *  so pacing our own calls well below the cap is what keeps a join burst from
 *  reading a player's pouch as empty. Costs nothing when nothing is queued. */
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

/** One write in flight at a time, across every key. The preview storage service
 *  serves a PUT as read-whole-file, set one key, write-whole-file with no lock, so
 *  concurrent writes to DIFFERENT keys erase each other: on 2026-09-17 a harvest's
 *  'boxes' write lost to its own 'flowers' write and the box stayed opened after a
 *  restart. The SDK only orders writes per key, so the global chain stays. Harmless
 *  on the Worlds key-value store, and it keeps writes to one slot of the fetch cap. */
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
async function load<T>(read: () => Promise<T | null>): Promise<LoadResult<T>> {
  try {
    return { ok: true, value: await withSlot(read) }
  } catch {
    return { ok: false }   // get() rejects when the realm lookup fails
  }
}

/** Reads a scene-scoped key, shared by everyone in the world. */
export function loadScene<T>(key: string): Promise<LoadResult<T>> {
  return load<T>(() => Storage.get<T>(key))
}

/** Reads a key held against one player's address. */
export function loadPlayer<T>(address: string, key: string): Promise<LoadResult<T>> {
  return load<T>(() => Storage.player.get<T>(address, key))
}

// ---------------------------------------------------------------
// Writes
// ---------------------------------------------------------------

const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS  = 30_000

/** Write-through for a single storage key: hold, coalesce, retry. */
export interface KeyWriter {
  /** Queue the current state. The SDK coalesces and orders the writes; this adds
   *  retry with backoff so a failed save is not silently lost. */
  save(snapshot: unknown): void
  /** Allow writes. Saves before this are held, so a blob is never written back
   *  before it has been read. */
  enable(): void
  /** Resolves once nothing is queued, in flight, or awaiting retry. */
  idle(): Promise<void>
}

/** Builds a writer over `write`. `label` names the key in retry logs. */
function createWriter(label: string, write: (value: unknown) => Promise<boolean>): KeyWriter {
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

  /** One write attempt. A throw counts as a failure, like a false result. */
  async function attempt(value: unknown): Promise<boolean> {
    try {
      return await queuedWrite(() => write(value))
    } catch {
      return false
    }
  }

  /** Writes the newest snapshot, retrying with backoff until one lands. */
  async function flush(): Promise<void> {
    if (writing || !enabled || !hasPending) return
    writing = true
    while (hasPending) {
      const snapshot = pending
      hasPending = false
      if (await attempt(snapshot)) { failures = 0; continue }
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
      pending    = snapshot
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

/** Writer for a scene-scoped key. */
export function createSceneWriter(key: string): KeyWriter {
  return createWriter(key, value => Storage.set(key, value))
}

/** Writer for a key held against one player's address. */
export function createPlayerWriter(address: string, key: string): KeyWriter {
  return createWriter(`${key}@${address.slice(0, 8)}`, value => Storage.player.set(address, key, value))
}
