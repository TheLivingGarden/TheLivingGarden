// =============================================================
// The Living Garden — Server persistence
//
// A thin layer over @dcl/sdk/server's Storage. Writes go entirely through the SDK.
// Reads mostly do too — except that the SDK's get() resolves `null` both when a key
// truly holds nothing AND when the storage service failed the read (any non-404
// status, a timeout, a rejected fetch-cap request), which is exactly the ambiguity
// this module exists to remove (see `confirm` below): the module falls back to its
// own direct read of the storage service only to tell those two cases apart.
//
// The SDK serializes and coalesces writes per key, shares concurrent reads of
// the same key, caches confirmed values and absences, memoizes the realm lookup
// and skips a write whose value is provably already stored. What it leaves to
// the caller is retrying a write it reports as failed: set() does not retry, and
// a false result is a lost save unless someone acts on it.
// =============================================================

import { timers } from '@dcl/sdk/ecs'
import { Storage } from '@dcl/sdk/server'
import { getStorageServerUrl } from '@dcl/sdk/server/storage-url'
import { wrapSignedFetch } from '@dcl/sdk/server/utils'

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

/** Body shape of a storage GET, matching the PUT body set() sends (see the SDK's
 *  own player.js / scene.js, which parse the same envelope back out of `value`). */
interface GetBody { value?: unknown }

/** Confirms what the SDK's own get() left ambiguous by reading `path` directly.
 *  A 404 is a real "absent" outcome. Anything else — a 5xx, a timeout, a rejected
 *  fetch-cap request, or even a 200 with no `value` — is reported as a failure
 *  rather than guessed at, so the caller never treats a bad read as an empty key. */
async function confirm<T>(path: string): Promise<LoadResult<T>> {
  try {
    const url = `${await getStorageServerUrl()}${path}`
    const [error, data, status] = await wrapSignedFetch<GetBody>({ url })
    if (error) {
      if (status === 404) return { ok: true, value: null, version: LEGACY_VERSION }
      return { ok: false }
    }
    if (!data || data.value === undefined) return { ok: false }   // ambiguous — see the SDK's own get()
    return { ok: true, ...unwrap<T>(data.value) }
  } catch {
    return { ok: false }   // signedFetch itself rejected
  }
}

/** Reads through a slot. A thrown read (a rejected realm lookup) is a failure
 *  outright; a `null` result is confirmed directly before it is trusted as empty. */
async function load<T>(read: () => Promise<unknown>, path: string): Promise<LoadResult<T>> {
  let raw: unknown
  try {
    raw = await withSlot(read)
  } catch {
    return { ok: false }   // get() rejects when the realm lookup fails
  }
  if (raw !== null) return { ok: true, ...unwrap<T>(raw) }
  return withSlot(() => confirm<T>(path))
}

/** Reads a scene-scoped key, shared by everyone in the world. */
export function loadScene<T>(key: string): Promise<LoadResult<T>> {
  return load<T>(() => Storage.get<unknown>(key), `/values/${encodeURIComponent(key)}`)
}

/** Reads a key held against one player's address. */
export function loadPlayer<T>(address: string, key: string): Promise<LoadResult<T>> {
  return load<T>(
    () => Storage.player.get<unknown>(address, key),
    `/players/${encodeURIComponent(address)}/values/${encodeURIComponent(key)}`
  )
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
  let retryTimer: ReturnType<typeof timers.setTimeout> | null = null
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
      retryTimer = timers.setTimeout(() => { retryTimer = null; void flush() }, delay)
      break
    }
    writing = false
    settleIdle()
  }

  return {
    save(snapshot) {
      pending    = { v: version, d: snapshot } satisfies Envelope
      hasPending = true
      if (retryTimer !== null) { timers.clearTimeout(retryTimer); retryTimer = null }
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
