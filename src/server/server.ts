// =============================================================
// The Living Garden — Authoritative Server
// Runs headlessly alongside the scene. Owns all game state:
//   • Plant watered/expired state  (PlantSync component, persisted)
//   • Bloom trigger + reset        (threshold check + timer)
//   • Boards, tributes, boxes, pouches, keepsakes (persisted)
// Memory is authoritative. persistence.ts holds every save until its key has been
// read, orders and retries them, and never reports a failed read as an empty key.
// =============================================================

import {
  engine,
  Entity,
  PlayerIdentityData,
  executeTask,
} from '@dcl/sdk/ecs'
import { loadScene, loadPlayer, createSceneWriter, createPlayerWriter, KeyWriter } from './persistence'
import { PlantSync }          from '../shared/schemas'
import { room }               from '../shared/messages'
import {
  PLANT_NAMES,
  BLOOM_THRESHOLD,
  WATERED_EXPIRY_MS,
  FAST_PLANT_EXPIRY_MS,
  FAST_PLANT_NAMES,
  BLOOM_RESET_DELAY_MS,
  bloomSustainMs,
  BLOOM_WINDOWS,
  plantDecayMs,
  bloomScaleFor,
  flairTier,
  WEEKLY_RESET_MS,
  TRIBUTE_MILESTONE,
  TRIBUTE_PLOTS,
  FOUNDING_TRIBUTES,
  rollBloomVariant,
  bloomVariantById,
  ADMIN_ADDRESSES,
  seedSpawnCount,
  seedRareChance,
  rollSeedTier,
  rollPlantSpecies,
  RARITY_TIERS,
  SEED_LIFETIME_MS,
  GARDEN_BOUNDS,
  BOX_POSITIONS,
  BOX_GROW_MS,
  BOX_CAP_DEFAULT,
  FLOWER_COLLECTION_CAP,
  BOX_WATER_SHAVE_MS,
  BOX_WATER_MAX,
  plantSpeciesById,
} from '../shared/config'

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------

const plantEntities   = new Map<string, Entity>()   // plantId → entity
const knownPlayers    = new Set<Entity>()            // entities seen this session
const playerAddresses = new Map<Entity, string>()    // entity → address (for disconnect cleanup)
const syncRateLimits  = new Map<string, number>()    // address → last requestFullSync ms
const SYNC_RATE_MS    = 5_000                        // min ms between full syncs per player
let   bloomActive      = false
let   bloomStartedAt:  number | null = null   // ms timestamp when current bloom began
let   bloomScale       = 1                    // bloomScaleFor(gardeners) of the active bloom
let   bloomVariant     = 'classic'            // BLOOM_VARIANTS id of the active bloom (Phase 6)


// ── Persistence ──────────────────────────────────────────────
// One writer per scene key. Each holds its saves until its key has been read, so a
// blob that failed to load is never overwritten by the emptier state we started
// with; a failed load is retried in the background until it can be merged, and on
// merge memory wins for anything touched this session. persistence.ts keeps ONE
// write in flight across every key — the preview storage service reads and rewrites
// the whole file per PUT, so concurrent writes to different keys erase each other.
const plantsWriter      = createSceneWriter('plants')
const leaderboardWriter = createSceneWriter('leaderboard')
const lifetimeWriter    = createSceneWriter('lifetime')
const resetAtWriter     = createSceneWriter('leaderboardResetAt')
const tributesWriter    = createSceneWriter('tributes')
const boxesWriter       = createSceneWriter('boxes')

const STORAGE_UNAVAILABLE_NOTICE = 'Your garden data is unavailable right now — try again in a moment'
const RELOAD_INTERVAL_MS         = 30_000

/** Keeps retrying a failed startup load until it succeeds, then merges it in. */
function scheduleReload(label: string, load: () => Promise<boolean>): void {
  setTimeout(() => executeTask(async () => {
    if (await load()) {
      console.log(`[Server] ${label}: late load succeeded — merged into live state, saves resumed`)
      checkBloomThreshold()
      return
    }
    scheduleReload(label, load)
  }), RELOAD_INTERVAL_MS)
}

// ── Leaderboard ──────────────────────────────────────────────
interface LeaderboardEntry { displayName: string; total: number }
const leaderboard = new Map<string, LeaderboardEntry>()  // address → entry

// ---------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------

interface PlantRecord {
  plantId:   string
  isWatered: boolean
  wateredAt: number   // ms timestamp stored as number (not BigInt)
  wateredBy: string   // display name of the player who watered it
  expiresAt?: number  // ms timestamp; decay is gardener-scaled so it must be stored, not recomputed
  tier?: number       // waterer's flair tier at water time (Phase 5)
}

// In-memory map of plantId → display name (kept in sync with PlantRecord)
const wateredByMap = new Map<string, string>()
const wateredTierMap = new Map<string, number>()   // plantId → waterer's flair tier
// plantId → when its current watering dries out (gardener-scaled at water time)
const plantExpiresAt = new Map<string, number>()

function expiresInMs(plantId: string, now = Date.now()): number {
  return Math.max(0, (plantExpiresAt.get(plantId) ?? 0) - now)
}

/** Mark `plantId` watered at `now` with decay for the gardeners present; returns expiresAt. */
function armExpiry(plantId: string, entity: Entity, now: number): number {
  const expiresAt = now + plantDecayMs(plantId, knownPlayers.size)
  plantExpiresAt.set(plantId, expiresAt)
  scheduleExpiry(plantId, entity, now, expiresAt - now)
  return expiresAt
}

/** Load (or late-load) plant states. False when the read failed. */
async function loadPlantStates(): Promise<boolean> {
  const res = await loadScene<PlantRecord[]>('plants')
  if (!res.ok) { console.error('[Server] plants: load failed — saves held until a reload succeeds'); return false }
  const records = Array.isArray(res.value) ? res.value : []

  const now = Date.now()
  let restored = 0

  for (const rec of records) {
    const entity = plantEntities.get(rec.plantId)
    if (!entity || !rec.isWatered) continue
    if (PlantSync.getOrNull(entity)?.isWatered) continue   // watered this session — memory wins

    // Pre-rework records have no expiresAt: fall back to the base (v1) decay
    const expiresAt = rec.expiresAt ?? rec.wateredAt + (FAST_PLANT_NAMES.has(rec.plantId) ? FAST_PLANT_EXPIRY_MS : WATERED_EXPIRY_MS)
    if (now >= expiresAt) continue  // expired while server was down

    const ps = PlantSync.getMutable(entity)
    ps.isWatered = true
    ps.wateredAt = rec.wateredAt
    if (rec.wateredBy) wateredByMap.set(rec.plantId, rec.wateredBy)
    if (rec.tier) wateredTierMap.set(rec.plantId, rec.tier)
    plantExpiresAt.set(rec.plantId, expiresAt)
    scheduleExpiry(rec.plantId, entity, rec.wateredAt, expiresAt - now)
    room.send('plantStateUpdate', { plantId: rec.plantId, isWatered: true, wateredAt: rec.wateredAt, wateredBy: rec.wateredBy ?? '', expiresInMs: expiresAt - now, tier: rec.tier ?? 0 })
    restored++
  }
  console.log(res.value === null ? '[Server] No persisted plant states — starting fresh' : `[Server] Restored ${restored} watered plants from storage`)
  plantsWriter.enable()
  return true
}

function savePlantStates(): void {
  const records: PlantRecord[] = []
  for (const [plantId, entity] of plantEntities) {
    const ps = PlantSync.getOrNull(entity)
    if (!ps) continue
    records.push({ plantId, isWatered: ps.isWatered, wateredAt: Number(ps.wateredAt), wateredBy: wateredByMap.get(plantId) ?? '', expiresAt: plantExpiresAt.get(plantId), tier: wateredTierMap.get(plantId) })
  }
  plantsWriter.save(records)
}

// ── Leaderboard helpers ──────────────────────────────────────

// `leaderboard` is THIS WEEK's board (resets); `lifetime` never resets and is the
// source of milestone flair (GDD §4.3 hook 2, §5 recognition — the v1 complaint
// was 1,000+ waters vanishing on reset).
const lifetime = new Map<string, LeaderboardEntry>()   // address → entry, never reset
let weeklyResetAt = 0                                   // epoch ms when the weekly board next clears

interface BoardRecord extends LeaderboardEntry { address: string }

/** Merge stored totals into a live board: totals earned this session are added on top. */
function mergeBoard(board: Map<string, LeaderboardEntry>, records: unknown): void {
  if (!Array.isArray(records)) return
  for (const r of records as BoardRecord[]) {
    const live = board.get(r.address)
    if (live) live.total += r.total
    else board.set(r.address, { displayName: r.displayName, total: r.total })
  }
}

// Stored totals are ADDED to live ones, so the boards may be merged only once. A
// retry that happens because only the tributes read failed must not merge again.
let boardsMerged = false

/** Load (or late-load) both boards, the reset clock and the tributes. False when a read failed. */
async function loadLeaderboard(): Promise<boolean> {
  if (boardsMerged) return loadTributes()   // boards are already in; only tributes were missing
  const [board, life, resetAt] = await Promise.all([
    loadScene<BoardRecord[]>('leaderboard'),
    loadScene<BoardRecord[]>('lifetime'),
    loadScene<number>('leaderboardResetAt'),
  ])
  if (!board.ok || !life.ok || !resetAt.ok) {
    console.error('[Server] leaderboard: load failed — saves held until a reload succeeds')
    return false
  }
  boardsMerged = true
  leaderboardWriter.enable()
  lifetimeWriter.enable()
  resetAtWriter.enable()

  mergeBoard(leaderboard, board.value)
  console.log(`[Server] Loaded leaderboard: ${leaderboard.size} players`)
  if (life.value !== null) {
    mergeBoard(lifetime, life.value)
    console.log(`[Server] Loaded lifetime board: ${lifetime.size} players`)
  } else {
    // First run after the Phase 5 upgrade: the current weekly totals are the best
    // floor we have for lifetime — never start veterans from zero.
    for (const [address, e] of leaderboard) lifetime.set(address, { ...e })
    saveLifetime()
    console.log(`[Server] Lifetime board seeded from weekly (${lifetime.size} players)`)
  }

  // Weekly reset clock — persisted so restarts don't move the reset moment
  const storedResetAt = Number(resetAt.value ?? 0)
  if (!storedResetAt) {
    resetAtWriter.save(Date.now())
    console.log('[Server] Leaderboard weekly reset clock started')
    weeklyResetAt = Date.now() + WEEKLY_RESET_MS
  } else {
    weeklyResetAt = storedResetAt + WEEKLY_RESET_MS
  }
  ensureWeeklyReset()
  saveLeaderboard()
  return loadTributes()
}

// ── Tribute plants (Phase 5b, GDD §4.2) ──────────────────────
// Earned automatically at TRIBUTE_MILESTONE lifetime waters; founding entries
// come from config. Permanent: never touched by the weekly reset.
interface TributeRecord {
  address:     string   // '' for a founding honoree whose wallet isn't known yet
  displayName: string
  earnedAt:    number
  plot:        number   // index into TRIBUTE_PLOTS
  founding:    boolean
  note:        string
}
let tributes: TributeRecord[] = []

function nextFreePlot(): number {
  const used = new Set(tributes.filter(t => t.plot >= 0).map(t => t.plot))
  for (let i = 0; i < TRIBUTE_PLOTS.length; i++) if (!used.has(i)) return i
  return -1
}

function saveTributes(): void {
  tributesWriter.save(tributes)
}

function sendTributes(to?: string[]): void {
  room.send('tributesUpdate', { json: JSON.stringify(tributes) }, to ? { to } : undefined)
}

/** Load (or late-load) the tributes. False when the read failed. Stored entries are
 *  merged in rather than replacing the list, so a grant made during an outage survives. */
async function loadTributes(): Promise<boolean> {
  const res = await loadScene<TributeRecord[]>('tributes')
  if (!res.ok) { console.error('[Server] tributes: load failed — saves held until a reload succeeds'); return false }
  for (const r of Array.isArray(res.value) ? res.value : []) {
    const already = tributes.some(t => (r.address && t.address === r.address) || (t.founding && r.founding && t.displayName === r.displayName))
    if (!already) tributes.push(r)
  }
  tributesWriter.enable()
  let changed = false
  for (const f of FOUNDING_TRIBUTES) {
    const address  = f.address.toLowerCase()
    const existing = tributes.find(t => t.founding && t.displayName === f.displayName)
    if (existing) {
      // Config is the source of truth for the honoree's wallet and note
      if (existing.address !== address || existing.note !== f.note) { existing.address = address; existing.note = f.note; changed = true }
    } else {
      const plot = nextFreePlot()
      if (plot < 0) { console.error(`[Server] No free tribute plot for founding honoree ${f.displayName}`); continue }
      tributes.push({ address, displayName: f.displayName, earnedAt: Date.now(), plot, founding: true, note: f.note })
      changed = true
    }
    // Once the wallet is known, their lifetime total must match the honour (golden flair)
    if (address) {
      const e = lifetime.get(address)
      if (!e || e.total < TRIBUTE_MILESTONE) {
        lifetime.set(address, { displayName: f.displayName, total: Math.max(e?.total ?? 0, TRIBUTE_MILESTONE) })
        saveLifetime()
      }
    }
  }
  if (changed) saveTributes()
  console.log(`[Server] Tributes: ${tributes.length} (${tributes.filter(t => t.founding).length} founding, ${TRIBUTE_PLOTS.length - tributes.filter(t => t.plot >= 0).length} plots free)`)
  return true
}

/** Call after a lifetime total changes. Grows the plant the moment the milestone is crossed. */
async function grantTributeIfEarned(address: string): Promise<void> {
  const entry = lifetime.get(address)
  if (!entry || entry.total < TRIBUTE_MILESTONE) return
  if (tributes.some(t => t.address === address)) return
  // No free plot → the honour is still permanent: plot −1 = Tribute Register only.
  const plot = nextFreePlot()
  if (plot < 0) console.log(`[Server] ${entry.displayName} earned a tribute; all plots taken → register only (add TRIBUTE_HEDGE_PLOTS)`)
  tributes.push({ address, displayName: entry.displayName, earnedAt: Date.now(), plot, founding: false, note: '' })
  saveTributes()
  sendTributes()
  room.send('notice', { text: `${entry.displayName}'s tribute plant has grown - ${TRIBUTE_MILESTONE} lifetime waters` })
  console.log(`[Server] Tribute granted: ${entry.displayName} → plot ${plot}`)
}

/** Clears the weekly board once its reset moment has passed — runs at startup and
 *  on every broadcast, so a long-lived server resets on time (GDD: stated, visible time). */
function ensureWeeklyReset(): void {
  const now = Date.now()
  if (now < weeklyResetAt) return
  // Advance by whole periods so the moment stays on the same weekday/hour
  while (weeklyResetAt <= now) weeklyResetAt += WEEKLY_RESET_MS
  leaderboard.clear()
  saveLeaderboard()
  resetAtWriter.save(weeklyResetAt - WEEKLY_RESET_MS)
  console.log(`[Server] Weekly leaderboard reset complete — next at ${new Date(weeklyResetAt).toISOString()}`)
}

function saveLeaderboard(): void {
  leaderboardWriter.save([...leaderboard.entries()].map(([address, e]) => ({ address, ...e })))
}

function saveLifetime(): void {
  lifetimeWriter.save([...lifetime.entries()].map(([address, e]) => ({ address, ...e })))
}

function tierOf(address: string): number {
  return flairTier(lifetime.get(address)?.total ?? 0)
}

/** Count one water on both boards (creating entries with a placeholder name). */
function bumpWaterTotals(address: string): void {
  for (const board of [leaderboard, lifetime]) {
    const entry = board.get(address)
    if (entry) entry.total += 1
    else board.set(address, { displayName: leaderboard.get(address)?.displayName ?? address.slice(0, 8) + '…', total: 1 })
  }
}

/** Top-10 sorted entries of a board as JSON, ready to send over the wire. */
function boardJson(board: Map<string, LeaderboardEntry>): string {
  return JSON.stringify(
    [...board.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 10)
      .map(([address, e]) => ({ displayName: e.displayName, count: e.total, tier: tierOf(address) }))
  )
}

function broadcastLeaderboard(to?: string[]): void {
  ensureWeeklyReset()
  const payload = { entriesJson: boardJson(leaderboard), allTimeJson: boardJson(lifetime), weeklyResetAt }
  if (to) {
    // Targeted send — used on player join to push current state to one client
    room.send('leaderboardUpdate', payload, { to })
  } else {
    // Broadcast — reaches all connected clients including the triggering player
    room.send('leaderboardUpdate', payload)
  }
}

// ---------------------------------------------------------------
// Bloom
// ---------------------------------------------------------------

function getWateredCount(): number {
  let count = 0
  for (const [, entity] of plantEntities) {
    if (PlantSync.getOrNull(entity)?.isWatered) count++
  }
  return count
}

// ── v2: bloom threshold + gardener count ─────────────────────
// Since the decay-rate rework the threshold is flat; what scales with gardeners
// is plant decay (see plantDecayMs) and bloom size (bloomScaleFor).

function currentBloomThreshold(): number {
  return BLOOM_THRESHOLD
}

let lastBroadcastGardeners = -1

/** Send threshold + gardener count — targeted to one player, or broadcast when the count changed. */
function sendThreshold(to?: string[]): void {
  const threshold = currentBloomThreshold()
  const gardeners = Math.max(1, knownPlayers.size)
  if (to) {
    room.send('thresholdUpdate', { threshold, gardeners }, { to })
    return
  }
  if (gardeners === lastBroadcastGardeners) return
  lastBroadcastGardeners = gardeners
  room.send('thresholdUpdate', { threshold, gardeners })
  console.log(`[Server] ${gardeners} gardener(s) present — new waterings last ${Math.round(plantDecayMs('Plant_1', gardeners) / 1000)}s`)
}

// ── Sustained-health bloom trigger ───────────────────────────

let bloomSustainTimer:     ReturnType<typeof setTimeout> | null = null
let bloomSustainStartedAt: number | null = null   // wall-clock ms when current run began
let bloomSustainElapsedMs: number        = 0      // ms accumulated before current run

/** Pause the sustain countdown (health dipped below threshold).
 *  Preserves elapsed time so the timer resumes from where it left off. */
function pauseBloomSustain(): void {
  if (bloomSustainTimer !== null) {
    clearTimeout(bloomSustainTimer)
    bloomSustainTimer = null
    if (bloomSustainStartedAt !== null) {
      bloomSustainElapsedMs += Date.now() - bloomSustainStartedAt
      bloomSustainStartedAt  = null
    }
    console.log(`[Server] Bloom sustain paused — ${Math.round(bloomSustainElapsedMs / 1_000)}s elapsed so far`)
  }
}

/** Full reset — called when bloom fires or garden resets. */
function cancelBloomSustain(): void {
  if (bloomSustainTimer !== null) {
    clearTimeout(bloomSustainTimer)
    bloomSustainTimer = null
  }
  bloomSustainStartedAt = null
  bloomSustainElapsedMs = 0
}

/** Call after any change to watered count.
 *  Resumes (or starts) the sustain countdown when health ≥ threshold;
 *  pauses it — without resetting — if health dips below. */
function checkBloomThreshold(): void {
  if (bloomActive) return
  const count     = getWateredCount()
  const threshold = currentBloomThreshold()
  if (count >= threshold) {
    if (bloomSustainTimer === null) {
      const remaining = Math.max(0, bloomSustainMs(knownPlayers.size) - bloomSustainElapsedMs)
      bloomSustainStartedAt = Date.now()
      console.log(`[Server] Health ${count}/${threshold} ≥ threshold — bloom fires in ${Math.ceil(remaining / 1_000)}s (${Math.round(bloomSustainElapsedMs / 1_000)}s already elapsed)`)
      bloomSustainTimer = setTimeout(() => {
        executeTask(async () => {
          bloomSustainTimer     = null
          bloomSustainStartedAt = null
          // Only reset elapsed after confirming we can bloom — if a plant expired in the
          // same tick, we want checkBloomThreshold() (called on next water) to restart
          // from 0 rather than an incorrect partial value.
          if (!bloomActive && getWateredCount() >= currentBloomThreshold()) {
            bloomSustainElapsedMs = 0
            triggerBloom()
          } else {
            bloomSustainElapsedMs = 0   // full cycle elapsed; reset for next attempt
            console.log('[Server] Bloom sustain timer fired but health below threshold — resetting countdown')
          }
        })
      }, remaining)
    }
  } else {
    pauseBloomSustain()
  }
}

/** @param forcedVariant test-panel only: a BLOOM_VARIANTS id to show at FULL scale ('' = normal roll) */
function triggerBloom(forcedVariant = ''): void {
  if (bloomActive) return
  const threshold = currentBloomThreshold()
  cancelBloomSustain()
  bloomActive    = true
  bloomStartedAt = Date.now()
  bloomScale     = forcedVariant ? 1 : bloomScaleFor(knownPlayers.size)
  const variant  = forcedVariant ? bloomVariantById(forcedVariant) : rollBloomVariant(bloomScale)
  bloomVariant   = variant.id
  console.log(`[Server] Bloom triggered! (${getWateredCount()}/${threshold} plants, scale ${bloomScale.toFixed(2)}, variant ${variant.name})`)
  room.send('bloomTriggered', { scale: bloomScale, variant: bloomVariant, elapsedMs: 0 })
  spawnBloomSeeds()
  setTimeout(() => executeTask(resetGarden), BLOOM_RESET_DELAY_MS)
}

// ---------------------------------------------------------------
// v2 — Bloom seeds (GDD §3 step 3: "gather seeds")
// ---------------------------------------------------------------

interface SeedRecord {
  id:         string
  x:          number
  z:          number
  rarityTier: number
  spawnedAt:  number
  gatheredBy: Set<string>   // addresses that already collected this seed (per-player pickup)
}

const activeSeeds = new Map<string, SeedRecord>()   // seedId → record, until lifetime expiry
let   seedCounter = 0

/** Broadcast one seed (or send it to a specific joining player). */
function sendSeed(seed: SeedRecord, to?: string[]): void {
  const payload = { id: seed.id, x: seed.x, z: seed.z, rarityTier: seed.rarityTier, spawnedAt: seed.spawnedAt }
  room.send('seedSpawned', payload, to ? { to } : undefined)
}

/** Roll and broadcast this bloom's seed drop — yield and rarity scale with bloom size. */
function spawnBloomSeeds(): void {
  const count        = seedSpawnCount(bloomScale)
  const rareSeedMult = bloomVariantById(bloomVariant).rareSeedMult
  const now          = Date.now()
  const batch: SeedRecord[] = []
  for (let i = 0; i < count; i++) {
    const seed: SeedRecord = {
      id:         `seed_${now}_${seedCounter++}`,
      x:          GARDEN_BOUNDS.xMin + Math.random() * (GARDEN_BOUNDS.xMax - GARDEN_BOUNDS.xMin),
      z:          GARDEN_BOUNDS.zMin + Math.random() * (GARDEN_BOUNDS.zMax - GARDEN_BOUNDS.zMin),
      rarityTier: rollSeedTier(bloomScale, rareSeedMult),
      spawnedAt:  now,
      gatheredBy: new Set(),
    }
    batch.push(seed)
    activeSeeds.set(seed.id, seed)
    // Ungathered seeds evaporate — clients despawn on their own matching timer
    setTimeout(() => activeSeeds.delete(seed.id), SEED_LIFETIME_MS)
    sendSeed(seed)
  }
  console.log(`[Server] Spawned ${count} bloom seeds (${batch.filter(s => s.rarityTier > 0).length} above Common, scale ${bloomScale.toFixed(2)})`)
}

/** Seeds this player can still collect — for joins/resyncs mid-bloom. */
function remainingSeeds(address: string): SeedRecord[] {
  const cutoff = Date.now() - SEED_LIFETIME_MS
  return [...activeSeeds.values()].filter(s => s.spawnedAt > cutoff && !s.gatheredBy.has(address))
}

/** Seed counts per rarity tier, index = tier id (0 = Common .. RARITY_TIERS.length-1). */
type SeedPouch = number[]
function emptyPouch(): SeedPouch { return new Array(RARITY_TIERS.length).fill(0) }

// In-memory pouch per player is the source of truth for the session; Storage is
// write-through. Without this, concurrent gathers each read→modified→wrote the
// stored value and overwrote each other (11 gathers persisted as 6).
// One cached object per (address, key) is the session's source of truth, each with
// its own writer — without this, concurrent gathers each read→modified→wrote the
// stored value and overwrote each other (11 gathers persisted as 6). A record whose
// read FAILED is not cached: the caller gets null, tells the player, and the next
// action retries, so a failed read is never mistaken for an empty pouch. Concurrent
// loads of one record share a request; records are dropped once the player leaves
// and their writes have landed.
interface PlayerRecord { value: unknown; writer: KeyWriter }
const playerRecords = new Map<string, PlayerRecord>()       // `${address}:${key}` → live record
const playerLoads   = new Map<string, Promise<unknown>>()   // in-flight loads for the same key

function recordKey(address: string, key: string): string { return `${address}:${key}` }

async function loadPlayerRecord<T>(address: string, key: string, parse: (stored: unknown) => T): Promise<T | null> {
  const k    = recordKey(address, key)
  const live = playerRecords.get(k)
  if (live) return live.value as T
  const inFlight = playerLoads.get(k)
  if (inFlight) return inFlight as Promise<T | null>

  const load = (async (): Promise<T | null> => {
    const res = await loadPlayer<unknown>(address, key)
    if (!res.ok) { console.error(`[Server] ${key} for ${address.slice(0, 8)}…: load failed`); return null }
    const value  = parse(res.value)
    const writer = createPlayerWriter(address, key)
    writer.enable()
    playerRecords.set(k, { value, writer })
    return value
  })()
  playerLoads.set(k, load)
  try { return await load } finally { playerLoads.delete(k) }
}

function savePlayerRecord(address: string, key: string): void {
  const rec = playerRecords.get(recordKey(address, key))
  if (rec) rec.writer.save(rec.value)
}

/** Forget a departed player's records once their pending writes have landed. */
function evictPlayerRecords(address: string): void {
  const prefix = `${address}:`
  const keys   = [...playerRecords.keys()].filter(k => k.startsWith(prefix))
  if (keys.length === 0) return
  executeTask(async () => {
    await Promise.all(keys.map(k => playerRecords.get(k)?.writer.idle() ?? Promise.resolve()))
    if (isConnected(address)) return   // came back while flushing — keep the cache warm
    for (const k of keys) playerRecords.delete(k)
  })
}

/** Tier array, tolerating the pre-2026-09-18 `{ normal, rare }` shape. */
function parsePouch(stored: unknown): SeedPouch {
  if (Array.isArray(stored)) return emptyPouch().map((_, i) => Number(stored[i]) || 0)
  const pouch = emptyPouch()
  if (stored && typeof stored === 'object') {
    // Common ← normal, Uncommon ← rare, so nobody's existing seeds vanish.
    const old = stored as { normal?: unknown; rare?: unknown }
    pouch[0] = Number(old.normal) || 0
    pouch[1] = Number(old.rare) || 0
  }
  return pouch
}

const loadPouch = (a: string) => loadPlayerRecord<SeedPouch>(a, 'seeds', parsePouch)
const savePouch = (a: string) => savePlayerRecord(a, 'seeds')

async function sendPouch(address: string): Promise<void> {
  const p = await loadPouch(address)
  if (p) room.send('pouchUpdate', { countsJson: JSON.stringify(p) }, { to: [address] })
}

// ---------------------------------------------------------------
// v2 — Seed boxes (GDD §3 step 4: plant → overnight timer → reveal)
// Shared world state → scene Storage ('boxes'), per the storage decision.
// ---------------------------------------------------------------

interface BoxRecord {
  boxId:       string
  owner:       string   // address; '' = empty
  ownerName:   string
  rarityTier:  number
  plantedAt:   number
  opensAt:     number
  opened:      boolean
  flower:      string   // '' until opened — a PLANT_SPECIES id once opened
  waters:      number   // Phase 4: how many visitors have watered this growing seed
  waterers:    string[] // their addresses (one water each) — server-only, not on the wire
  lastWaterer: string   // display name shown on the label
}

const boxes     = new Map<string, BoxRecord>()                       // boxId → record
const boxTimers = new Map<string, ReturnType<typeof setTimeout>>()  // boxId → open timer

function emptyBox(boxId: string): BoxRecord {
  return { boxId, owner: '', ownerName: '', rarityTier: 0, plantedAt: 0, opensAt: 0, opened: false, flower: '', waters: 0, waterers: [], lastWaterer: '' }
}

function sendBox(b: BoxRecord, to?: string[]): void {
  const payload = {
    boxId: b.boxId, owner: b.owner, ownerName: b.ownerName, rarityTier: b.rarityTier,
    plantedAt: b.plantedAt, opensAt: b.opensAt, serverNow: Date.now(),
    opened: b.opened, flower: b.flower, waters: b.waters, lastWaterer: b.lastWaterer,
  }
  room.send('boxState', payload, to ? { to } : undefined)
}

function boxesOwnedBy(address: string): number {
  let n = 0
  for (const b of boxes.values()) if (b.owner === address) n++
  return n
}

interface FlowerKeepsake { flower: string; rarityTier: number; at: number; from?: string }

const loadFlowers = (a: string) => loadPlayerRecord<FlowerKeepsake[]>(a, 'flowers', v => Array.isArray(v) ? v as FlowerKeepsake[] : [])
const saveFlowers = (a: string) => savePlayerRecord(a, 'flowers')
/** Read only where it decides something — nothing writes it yet (see BOX_CAP_DEFAULT). */
const loadBoxCap  = (a: string) => loadPlayerRecord<{ cap: number }>(a, 'boxCap', v => {
  const cap = Number((v as { cap?: unknown } | null)?.cap)
  return { cap: cap > 0 ? cap : BOX_CAP_DEFAULT }
})

function cachedBoxCap(address: string): number {
  const rec = playerRecords.get(recordKey(address, 'boxCap'))
  return rec ? (rec.value as { cap: number }).cap : BOX_CAP_DEFAULT
}

async function sendCollection(address: string): Promise<void> {
  const flowers = await loadFlowers(address)
  if (!flowers) return   // unavailable — the client keeps its last known collection
  room.send('collectionUpdate', { flowersJson: JSON.stringify(flowers), boxCap: cachedBoxCap(address) }, { to: [address] })
}

// ── v2: held flower — one keepsake per gardener, shown in their hand to everyone.
// In memory only: an empty hand on rejoin is fine; the flower itself stays in the collection.
const heldFlowers = new Map<string, { flower: string; rarityTier: number }>()   // lowercase address →

function sendHeld(address: string, to?: string[]): void {
  const h = heldFlowers.get(address)
  room.send('heldFlower', { address, flower: h?.flower ?? '', rarityTier: h?.rarityTier ?? 0 }, to ? { to } : undefined)
}
function sendAllHeld(to: string[]): void { for (const a of heldFlowers.keys()) sendHeld(a, to) }
function clearHeld(address: string): void { if (heldFlowers.delete(address)) sendHeld(address) }

/** Every test-panel handler is gated on this (pre-production gate, todo.md). */
function isAdmin(address: string): boolean { return ADMIN_ADDRESSES.includes(address.toLowerCase()) }

function sendNotice(address: string, text: string): void {
  room.send('notice', { text }, { to: [address] })
}

function isConnected(address: string): boolean {
  for (const a of playerAddresses.values()) if (a === address) return true
  return false
}

function saveBoxes(): void {
  boxesWriter.save([...boxes.values()])
}

/** The box's timer elapsed: reveal the species, persist, tell everyone. Rarity tier
 *  was already fixed when the seed was planted — only the species is the mystery. */
function openBox(boxId: string): void {
  const b = boxes.get(boxId)
  if (!b || !b.owner || b.opened) return
  boxTimers.delete(boxId)
  b.opened = true
  b.flower = rollPlantSpecies()
  console.log(`[Server] ${b.boxId} opened for ${b.ownerName}: ${b.flower} (tier ${b.rarityTier})`)
  sendBox(b)
  saveBoxes()
}

/** Schedule (or immediately fire) the open for a planted box. Safe to call on restart. */
function scheduleOpen(b: BoxRecord): void {
  if (!b.owner || b.opened) return
  const existing = boxTimers.get(b.boxId)
  if (existing) clearTimeout(existing)
  const delay = Math.max(0, b.opensAt - Date.now())
  boxTimers.set(b.boxId, setTimeout(() => executeTask(async () => openBox(b.boxId)), delay))
}

/** Load (or late-load) the boxes. False when the read failed. A box claimed this
 *  session keeps its claim over the stored record. */
async function loadBoxes(): Promise<boolean> {
  const res = await loadScene<Array<Partial<BoxRecord> & { boxId: string }>>('boxes')
  if (!res.ok) { console.error('[Server] boxes: load failed — saves held until a reload succeeds'); return false }
  {
    const records = Array.isArray(res.value) ? res.value : []
    // Records saved before Phase 4 lack the watering fields; an undefined string
    // makes every boxState send throw in the event bus, so backfill on load.
    // Records saved before 2026-09-18 have `rare: boolean` instead of `rarityTier` —
    // that field is simply dropped by the spread below and emptyBox's rarityTier:0
    // (Common) default takes over. Fine for pre-production test data; a live-player
    // migration would need to map old rare:true → rarityTier:1 explicitly.
    for (const r of records) {
      const live = boxes.get(r.boxId)
      if (!live || live.owner) continue
      const restored: BoxRecord = { ...emptyBox(r.boxId), ...r, waters: r.waters ?? 0, waterers: r.waterers ?? [], lastWaterer: r.lastWaterer ?? '' }
      boxes.set(r.boxId, restored)
      if (restored.owner) sendBox(restored)
    }
  }
  let growing = 0
  for (const b of boxes.values()) if (b.owner && !b.opened && !boxTimers.has(b.boxId)) { scheduleOpen(b); growing++ }
  console.log(`[Server] Boxes: ${boxes.size} total, ${[...boxes.values()].filter(b => b.owner).length} planted, ${growing} growing (timers rescheduled)`)
  boxesWriter.enable()
  return true
}

async function resetGarden(): Promise<void> {
  // Idempotent guard — ignore if bloom is no longer active (already reset)
  if (!bloomActive) return
  console.log('[Server] Resetting garden...')
  cancelBloomSustain()
  bloomActive    = false
  bloomStartedAt = null

  for (const [plantId, entity] of plantEntities) {
    const ps     = PlantSync.getMutable(entity)
    ps.isWatered = false
    ps.wateredAt = 0
    wateredByMap.delete(plantId)
    wateredTierMap.delete(plantId)
    plantExpiresAt.delete(plantId)
    room.send('plantStateUpdate', { plantId, isWatered: false, wateredAt: 0, wateredBy: '', expiresInMs: 0, tier: 0 })
  }

  room.send('bloomReset', {})
  console.log('[Server] Garden reset complete')
  savePlantStates()
}

// ---------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------

function scheduleExpiry(
  plantId:          string,
  entity:           Entity,
  sessionTimestamp: number,
  delayMs:          number,
): void {
  setTimeout(() => {
    executeTask(async () => {
      const ps = PlantSync.getOrNull(entity)
      if (!ps || !ps.isWatered || Number(ps.wateredAt) !== sessionTimestamp) return

      const expired = PlantSync.getMutable(entity)
      expired.isWatered = false
      expired.wateredAt = 0
      wateredByMap.delete(plantId)
      wateredTierMap.delete(plantId)
      plantExpiresAt.delete(plantId)
      savePlantStates()
      room.send('plantStateUpdate', { plantId, isWatered: false, wateredAt: 0, wateredBy: '', expiresInMs: 0, tier: 0 })
      console.log(`[Server] Plant expired: ${plantId}`)
      // Pause (not cancel) — preserves elapsed progress; timer resumes when health recovers.
      // Expiry must never start the sustain timer, only pause it.
      if (getWateredCount() < currentBloomThreshold()) pauseBloomSustain()
    })
  }, delayMs)
}

// ---------------------------------------------------------------
// Scheduled bloom check — fires at every 6am and 6pm UTC
// ---------------------------------------------------------------

function msUntilNextBloomWindow(): number {
  const now = Date.now()
  const d   = new Date(now)
  const y   = d.getUTCFullYear()
  const mo  = d.getUTCMonth()
  const day = d.getUTCDate()
  let nearest = Infinity
  for (const w of BLOOM_WINDOWS) {
    const today    = Date.UTC(y, mo, day,     w.hour, w.minute, 0, 0)
    const tomorrow = Date.UTC(y, mo, day + 1, w.hour, w.minute, 0, 0)
    const ms = today - now
    if (ms > 500 && ms < nearest) nearest = ms          // today's window still ahead
    else if (tomorrow - now < nearest) nearest = tomorrow - now  // fall back to tomorrow
  }
  return nearest
}

/** Build a playerDailyState payload stamped with the current server time and
 *  the absolute timestamp of the next bloom window (for client clock-sync). */
function dailyStatePayload() {
  const sentAt    = Date.now()
  const bloomTime = sentAt + msUntilNextBloomWindow()
  return { sentAt, bloomTime }
}

function scheduleBloomCheck(): void {
  const delay    = msUntilNextBloomWindow()
  const windowAt = new Date(Date.now() + delay).toISOString()
  console.log(`[Server] Next bloom window: ${windowAt} (in ${Math.round(delay / 60_000)} min)`)

  setTimeout(() => {
    executeTask(async () => {
      const count = getWateredCount()
      console.log(`[Server] Bloom window reached — health ${count}/${currentBloomThreshold()}`)
      checkBloomThreshold()  // starts/resets sustain timer; bloom fires 60 s later if health holds
      scheduleBloomCheck()   // always reschedule for the next window
    })
  }, delay)
}

// ---------------------------------------------------------------
// Player join detection
// ---------------------------------------------------------------

function playerJoinSystem(): void {
  // Detect disconnections — entities removed from the engine no longer have PlayerIdentityData
  for (const entity of [...knownPlayers]) {
    if (!PlayerIdentityData.getOrNull(entity)) {
      const address = playerAddresses.get(entity)
      knownPlayers.delete(entity)
      playerAddresses.delete(entity)
      if (address) {
        syncRateLimits.delete(address)
        evictPlayerRecords(address)
        clearHeld(address.toLowerCase())
        console.log(`[Server] Player disconnected: ${address}`)
      }
    }
  }

  for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
    if (knownPlayers.has(entity)) continue
    knownPlayers.add(entity)
    const address = identity.address
    playerAddresses.set(entity, address)
    executeTask(async () => {
      room.send('playerDailyState', dailyStatePayload(), { to: [address] })

      // Send current state of all plants so the client can restore visuals
      for (const [plantId, plantEntity] of plantEntities) {
        const ps = PlantSync.getOrNull(plantEntity)
        if (!ps) continue
        room.send('plantStateUpdate', { plantId, isWatered: ps.isWatered, wateredAt: Number(ps.wateredAt), wateredBy: wateredByMap.get(plantId) ?? '', expiresInMs: expiresInMs(plantId), tier: wateredTierMap.get(plantId) ?? 0 }, { to: [address] })
      }

      broadcastLeaderboard([address])
      sendThreshold([address])
      await sendPouch(address)
      // Re-send bloom state to players who join while it is already active
      if (bloomActive) room.send('bloomTriggered', { scale: bloomScale, variant: bloomVariant, elapsedMs: bloomStartedAt ? Date.now() - bloomStartedAt : 0 }, { to: [address] })
      for (const seed of remainingSeeds(address)) sendSeed(seed, [address])
      for (const b of boxes.values()) sendBox(b, [address])
      await sendCollection(address)
      sendTributes([address])
      sendAllHeld([address])
      console.log(`[Server] Player joined: ${address} (${getWateredCount()}/${currentBloomThreshold()} watered, bloom=${bloomActive})`)
    })
  }

  // v2 — joins/leaves above may have moved the scaled threshold; broadcast only on change
  sendThreshold()
}

// ---------------------------------------------------------------
// Message handler helper
// ---------------------------------------------------------------

/** Wraps room.onMessage with context validation and executeTask so
 *  every handler is guaranteed a valid sender address. */
function onRoomMessage<T>(
  name:    Parameters<typeof room.onMessage>[0],
  handler: (data: T, address: string) => Promise<void>,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  room.onMessage(name, (data: any, context) => {
    if (!context) return
    executeTask(() => handler(data as T, context.from))
  })
}

// ---------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------

export async function server(): Promise<void> {
  console.log('[Server] Starting up...')

  // Create PlantSync component for every plant (server-side state tracking only)
  for (const name of PLANT_NAMES) {
    const entity = engine.getEntityOrNullByName(name)
    if (!entity) { console.log(`[Server] Plant entity not found: ${name}`); continue }
    PlantSync.create(entity, { isWatered: false, wateredAt: 0 })
    plantEntities.set(name, entity)
  }

  console.log(`[Server] ${plantEntities.size} plants registered`)

  for (const p of BOX_POSITIONS) boxes.set(p.id, emptyBox(p.id))

  // Restore persisted state. Loads never throw; a key that could not be read starts
  // empty, keeps its saves held and is reloaded in the background until it can be
  // merged — so an outage at boot neither aborts server() nor lets the first save
  // overwrite good data. Leaderboard and tributes load as one unit; tributes seed
  // lifetime totals for founding honorees, so they must follow the boards.
  const loads: Array<[string, () => Promise<boolean>]> = [
    ['plants',      loadPlantStates],
    ['leaderboard', loadLeaderboard],
    ['boxes',       loadBoxes],
  ]
  const outcomes = await Promise.all(loads.map(([, load]) => load()))
  loads.forEach(([label, load], i) => { if (!outcomes[i]) scheduleReload(label, load) })
  const restoredCount = getWateredCount()
  console.log(`[Server] ${restoredCount} plants currently watered`)

  // If health is already at/above threshold on startup (persisted from before restart),
  // start the sustain timer immediately so the bloom can still fire.
  // Without this, the client would start its countdown (seeing count ≥ threshold via
  // requestFullSync) but the server would have no timer — bloom would never trigger.
  if (restoredCount >= currentBloomThreshold() && !bloomActive) {
    console.log('[Server] Restored state already at/above bloom threshold — starting sustain timer')
    checkBloomThreshold()
  }

  // ── Message: waterPlant ──────────────────────────────────────
  onRoomMessage<{ plantId: string }>('waterPlant', async (data, playerAddress) => {
    const { plantId } = data
    const entity      = plantEntities.get(plantId)

    if (!entity) {
      console.log(`[Server] Unknown plant: ${plantId}`)
      return
    }

    {
      const ps = PlantSync.getOrNull(entity)
      if (!ps) return

      // Reject if bloom is active
      if (bloomActive) {
        room.send('waterRejected', { plantId, reason: 'bloom_active' }, { to: [playerAddress] })
        return
      }

      // Reject if already watered — prevents concurrent double-water when two players
      // click the same unwatered plant before either receives the other's confirmation.
      // isWatered is set synchronously before any await, so this check is race-free.
      if (ps.isWatered) {
        room.send('waterRejected', { plantId, reason: 'already_watered' }, { to: [playerAddress] })
        return
      }

      // ── All valid — water the plant ──────────────────────────
      const now      = Date.now()
      const watered  = PlantSync.getMutable(entity)
      watered.isWatered = true
      watered.wateredAt = now

      // Count on both boards: this week's (resets) and lifetime (flair source)
      const tierBefore = tierOf(playerAddress)
      bumpWaterTotals(playerAddress)
      const tier = tierOf(playerAddress)

      const displayName = leaderboard.get(playerAddress)?.displayName ?? playerAddress.slice(0, 8) + '…'
      wateredByMap.set(plantId, displayName)
      wateredTierMap.set(plantId, tier)

      savePlantStates()
      saveLeaderboard()
      saveLifetime()
      const expiresAt = armExpiry(plantId, entity, now)

      room.send('plantStateUpdate', { plantId, isWatered: true, wateredAt: now, wateredBy: displayName, expiresInMs: expiresAt - now, tier })
      if (tier > tierBefore) {
        const names = ['', 'a sprout', 'a flower', 'a golden flower']
        sendNotice(playerAddress, `${lifetime.get(playerAddress)?.total} lifetime waters — your name now carries ${names[tier]}`)
        console.log(`[Server] ${displayName} reached flair tier ${tier}`)
      }
      await grantTributeIfEarned(playerAddress)
      broadcastLeaderboard()
      console.log(`[Server] ${plantId} watered by ${playerAddress} (${getWateredCount()}/${currentBloomThreshold()} garden)`)
      checkBloomThreshold()
    }
  })

  // ── Message: gatherSeed (v2) ────────────────────────────────
  onRoomMessage<{ seedId: string }>('gatherSeed', async (data, playerAddress) => {
    const seed = activeSeeds.get(data.seedId)
    if (!seed) return   // expired or never existed — client despawns on its own lifetime timer
    // Per-player pickup: each player may collect each seed once; the seed stays for
    // everyone else. Mark synchronously before any await so a duplicate request
    // from the same client cannot double-award (same pattern as waterPlant).
    // NOTE (anticheat, later round): no server-side distance check yet — the
    // server does not trust position here; acceptable while seeds are un-tradeable.
    if (seed.gatheredBy.has(playerAddress)) return
    seed.gatheredBy.add(playerAddress)

    const displayName = leaderboard.get(playerAddress)?.displayName ?? playerAddress.slice(0, 8) + '…'
    const pouch = await loadPouch(playerAddress)
    if (!pouch) {
      seed.gatheredBy.delete(playerAddress)   // let them retry once the read works
      sendNotice(playerAddress, STORAGE_UNAVAILABLE_NOTICE)
      return
    }
    pouch[seed.rarityTier] = (pouch[seed.rarityTier] ?? 0) + 1     // synchronous on the shared live object
    savePouch(playerAddress)           // ordered write-through, retried on failure
    console.log(`[Server] ${displayName} gathered tier-${seed.rarityTier} seed ${seed.id} (pouch: ${pouch.join(',')})`)
    void sendPouch(playerAddress)
    // Targeted, not broadcast — only the gatherer's client despawns it
    room.send('seedGathered', { seedId: seed.id, by: displayName, byAddress: playerAddress, rarityTier: seed.rarityTier }, { to: [playerAddress] })
  })

  // ── Message: adminSpawnSeed (test panel) ────────────────────
  onRoomMessage<{ x: number; z: number; rarityTier: number }>('adminSpawnSeed', async (data, address) => {
    if (!isAdmin(address)) { sendNotice(address, 'Test tools: admin wallet only'); return }
    const seed: SeedRecord = { id: `admin_${Date.now()}`, x: data.x, z: data.z, rarityTier: data.rarityTier, spawnedAt: Date.now(), gatheredBy: new Set() }
    activeSeeds.set(seed.id, seed)
    setTimeout(() => activeSeeds.delete(seed.id), SEED_LIFETIME_MS)
    sendSeed(seed)
    console.log(`[Server] adminSpawnSeed from ${address.slice(0, 8)} → ${seed.id} at (${data.x.toFixed(1)}, ${data.z.toFixed(1)})`)
  })

  // ── Message: plantSeed (v2) ─────────────────────────────────
  onRoomMessage<{ boxId: string; rarityTier: number }>('plantSeed', async (data, playerAddress) => {
    const b = boxes.get(data.boxId)
    if (!b) return
    if (b.owner) { sendBox(b, [playerAddress]); return }          // taken — resync the tapper
    const [pouch, capRecord] = await Promise.all([loadPouch(playerAddress), loadBoxCap(playerAddress)])
    if (!pouch || !capRecord) { sendNotice(playerAddress, STORAGE_UNAVAILABLE_NOTICE); return }
    const cap = capRecord.cap
    if (b.owner) { sendBox(b, [playerAddress]); return }          // re-check after the awaits
    if (boxesOwnedBy(playerAddress) >= cap) {
      sendNotice(playerAddress, cap === 1 ? 'You already have a box — harvest it when it opens' : `You already have ${cap} boxes`)
      return
    }
    if ((pouch[data.rarityTier] ?? 0) <= 0) { void sendPouch(playerAddress); sendNotice(playerAddress, 'No seeds — catch some from a bloom'); return }
    // Consume the seed and claim the box synchronously — no await between check and claim
    pouch[data.rarityTier] -= 1
    const now = Date.now()
    b.owner     = playerAddress
    b.ownerName = leaderboard.get(playerAddress)?.displayName ?? playerAddress.slice(0, 8) + '…'
    b.rarityTier = data.rarityTier
    b.plantedAt = now
    b.opensAt   = now + BOX_GROW_MS
    b.opened    = false
    b.flower    = ''
    b.waters    = 0
    b.waterers  = []
    b.lastWaterer = ''
    scheduleOpen(b)
    console.log(`[Server] ${b.ownerName} planted a tier-${data.rarityTier} seed in ${b.boxId} (opens in ${Math.round(BOX_GROW_MS / 60_000)} min)`)
    sendBox(b)
    void sendPouch(playerAddress)
    savePouch(playerAddress)
    saveBoxes()
  })

  // ── Message: harvestBox (Phase 4) ───────────────────────────
  onRoomMessage<{ boxId: string }>('harvestBox', async (data, playerAddress) => {
    const b = boxes.get(data.boxId)
    if (!b || b.owner !== playerAddress) return
    if (!b.opened) { sendNotice(playerAddress, 'Still growing — come back when it opens'); return }
    const flowers = await loadFlowers(playerAddress)
    if (!flowers) { sendNotice(playerAddress, STORAGE_UNAVAILABLE_NOTICE); return }
    if (!b.opened || b.owner !== playerAddress) return           // re-check after the await
    if (flowers.length >= FLOWER_COLLECTION_CAP) { sendNotice(playerAddress, 'Your collection is full — gift a flower first'); return }
    const keepsake: FlowerKeepsake = { flower: b.flower, rarityTier: b.rarityTier, at: Date.now() }
    flowers.push(keepsake)
    const name = b.ownerName
    boxes.set(b.boxId, emptyBox(b.boxId))                        // frees the box
    console.log(`[Server] ${name} harvested ${keepsake.flower} (tier ${keepsake.rarityTier}) from ${b.boxId} (collection ${flowers.length})`)
    sendBox(boxes.get(b.boxId)!)
    saveBoxes()
    saveFlowers(playerAddress)
    void sendCollection(playerAddress)
    sendNotice(playerAddress, `Harvested your ${keepsake.flower} — box is free again`)
  })

  // ── Message: waterBox (Phase 4 — the quiet social loop) ─────
  onRoomMessage<{ boxId: string }>('waterBox', async (data, playerAddress) => {
    const b = boxes.get(data.boxId)
    console.log(`[Server] waterBox ${data.boxId} from ${playerAddress.slice(0, 8)}… → ${!b ? 'unknown box' : !b.owner ? 'empty' : b.opened ? 'opened' : `growing, waters ${b.waters}/${BOX_WATER_MAX}`}`)
    if (!b || !b.owner) return
    if (b.owner === playerAddress) { sendNotice(playerAddress, 'Only visitors can water your seed'); return }
    if (b.opened) { sendNotice(playerAddress, `${b.ownerName}'s ${b.flower} has already opened`); return }
    if (b.waterers.includes(playerAddress)) { sendNotice(playerAddress, `You already watered ${b.ownerName}'s seed`); return }
    if (b.waters >= BOX_WATER_MAX) { sendNotice(playerAddress, `${b.ownerName}'s seed has had all the water it can take`); return }
    const name = leaderboard.get(playerAddress)?.displayName ?? playerAddress.slice(0, 8) + '…'
    b.waters += 1
    b.waterers.push(playerAddress)
    b.lastWaterer = name
    b.opensAt = Math.max(Date.now(), b.opensAt - BOX_WATER_SHAVE_MS)
    scheduleOpen(b)
    console.log(`[Server] ${name} watered ${b.ownerName}'s ${b.boxId} (${b.waters}/${BOX_WATER_MAX}, −${Math.round(BOX_WATER_SHAVE_MS / 1000)}s)`)
    sendBox(b)
    saveBoxes()
    sendNotice(playerAddress, `You watered ${b.ownerName}'s seed — it opens sooner`)
    if (isConnected(b.owner)) sendNotice(b.owner, `${name} watered your seed`)
  })

  // ── Message: giftFlower (Phase 4 — keepsakes) ───────────────
  onRoomMessage<{ toAddress: string; flowerIndex: number }>('giftFlower', async (data, playerAddress) => {
    const to = (data.toAddress || '').toLowerCase()
    if (!to || to === playerAddress) return
    if (!isConnected(to)) { sendNotice(playerAddress, 'That player is not here'); return }
    const [mine, theirs] = await Promise.all([loadFlowers(playerAddress), loadFlowers(to)])
    if (!mine || !theirs) { sendNotice(playerAddress, STORAGE_UNAVAILABLE_NOTICE); return }
    const idx = Math.floor(data.flowerIndex)
    if (idx < 0 || idx >= mine.length) { sendNotice(playerAddress, 'You have no flower to give'); return }
    if (theirs.length >= FLOWER_COLLECTION_CAP) { sendNotice(playerAddress, 'Their collection is full'); return }
    const fromName = leaderboard.get(playerAddress)?.displayName ?? playerAddress.slice(0, 8) + '…'
    const toName   = leaderboard.get(to)?.displayName ?? to.slice(0, 8) + '…'
    const [gift] = mine.splice(idx, 1)
    // Gave away the last one of the kind you're holding → empty hand
    const held = heldFlowers.get(playerAddress.toLowerCase())
    if (held && held.flower === gift.flower && held.rarityTier === gift.rarityTier
        && !mine.some(f => f.flower === held.flower && f.rarityTier === held.rarityTier)) clearHeld(playerAddress.toLowerCase())
    theirs.push({ ...gift, from: fromName, at: Date.now() })
    console.log(`[Server] ${fromName} gifted ${gift.flower} (tier ${gift.rarityTier}) to ${toName}`)
    saveFlowers(playerAddress)
    saveFlowers(to)
    void sendCollection(playerAddress)
    void sendCollection(to)
    room.send('giftReceived', { from: fromName, flower: gift.flower, rarityTier: gift.rarityTier }, { to: [to] })
    sendNotice(playerAddress, `You gave your ${plantSpeciesById(gift.flower)?.name ?? gift.flower} to ${toName}`)
  })

  // ── Message: holdFlower — show one of your keepsakes in your hand (-1 = put away) ──
  onRoomMessage<{ flowerIndex: number }>('holdFlower', async (data, playerAddress) => {
    const a   = playerAddress.toLowerCase()
    const idx = Math.floor(data.flowerIndex)
    if (idx < 0) { clearHeld(a); return }
    const f = (await loadFlowers(playerAddress))?.[idx]
    if (!f) { sendNotice(playerAddress, 'You no longer have that flower'); return }
    heldFlowers.set(a, { flower: f.flower, rarityTier: f.rarityTier })
    sendHeld(a)
  })

  // ── Message: forceBloom ─────────────────────────────────────
  onRoomMessage<{ variant: string }>('forceBloom', async (data, address) => {
    if (!isAdmin(address)) { sendNotice(address, 'Test tools: admin wallet only'); return }
    triggerBloom(data?.variant || '')
  })

  // ── Message: adminResetBloom (test panel) — stop-bloom / reset button. Cancels any
  // sustain hold (covers the "stuck at Hold 80% for 0s" case) and ends an active bloom
  // the same way a normal bloomReset does. Idempotent either way.
  onRoomMessage<Record<string, never>>('adminResetBloom', async (_data, address) => {
    if (!isAdmin(address)) { sendNotice(address, 'Test tools: admin wallet only'); return }
    cancelBloomSustain()
    if (bloomActive) await resetGarden()
    sendThreshold([address])
    console.log(`[Server] Admin reset bloom/sustain (requested by ${address})`)
  })

  // ── Message: adminGrantWaters (test panel) — exercise flair tiers + tribute grant ──
  onRoomMessage<{ amount: number }>('adminGrantWaters', async (data, address) => {
    if (!isAdmin(address)) { sendNotice(address, 'Test tools: admin wallet only'); return }
    const amount = Math.max(1, Math.min(1000, Math.floor(data?.amount ?? 0)))
    const tierBefore = tierOf(address)
    for (let i = 0; i < amount; i++) bumpWaterTotals(address)
    const tier = tierOf(address)
    saveLeaderboard()
    saveLifetime()
    broadcastLeaderboard()
    const total = lifetime.get(address)?.total ?? 0
    console.log(`[Server] [Test] granted ${amount} waters to ${address} → lifetime ${total}, tier ${tierBefore}→${tier}`)
    sendNotice(address, tier > tierBefore
      ? `${total} lifetime waters — your name now carries ${['', 'a sprout', 'a flower', 'a golden flower'][tier]}`
      : `[Test] +${amount} waters → ${total} lifetime`)
    await grantTributeIfEarned(address)
  })

  // ── Message: forceWater80 (test panel) ──────────────────────
  onRoomMessage<Record<string, never>>('forceWater80', async (_data, address) => {
    if (!isAdmin(address)) { sendNotice(address, 'Test tools: admin wallet only'); return }
    if (bloomActive) return
    const needed = Math.max(0, currentBloomThreshold() - getWateredCount())
    if (needed === 0) {
      console.log('[Server] forceWater80: already at/above threshold')
      return
    }
    const now = Date.now()
    let watered = 0
    for (const [plantId, entity] of plantEntities) {
      if (watered >= needed) break
      const ps = PlantSync.getOrNull(entity)
      if (ps && !ps.isWatered) {
        const mutable     = PlantSync.getMutable(entity)
        mutable.isWatered = true
        mutable.wateredAt = now
        wateredByMap.set(plantId, '[Test Mode]')
        const expiresAt = armExpiry(plantId, entity, now)
        room.send('plantStateUpdate', { plantId, isWatered: true, wateredAt: now, wateredBy: '[Test Mode]', expiresInMs: expiresAt - now, tier: 0 })
        watered++
      }
    }
    if (watered > 0) savePlantStates()
    console.log(`[Server] forceWater80: watered ${watered} plants (${getWateredCount()}/${currentBloomThreshold()} total)`)
    checkBloomThreshold()
  })

  // ── Message: requestFullSync ─────────────────────────────────
  onRoomMessage<Record<string, never>>('requestFullSync', async (_data, address) => {
    const now      = Date.now()
    const lastSync = syncRateLimits.get(address) ?? 0
    if (now - lastSync < SYNC_RATE_MS) {
      console.log(`[Server] requestFullSync rate-limited for ${address}`)
      return
    }
    syncRateLimits.set(address, now)
    room.send('playerDailyState', dailyStatePayload(), { to: [address] })
    for (const [plantId, plantEntity] of plantEntities) {
      const ps = PlantSync.getOrNull(plantEntity)
      if (!ps) continue
      room.send('plantStateUpdate', { plantId, isWatered: ps.isWatered, wateredAt: Number(ps.wateredAt), wateredBy: wateredByMap.get(plantId) ?? '', expiresInMs: expiresInMs(plantId), tier: wateredTierMap.get(plantId) ?? 0 }, { to: [address] })
    }
    broadcastLeaderboard([address])
    sendThreshold([address])
    await sendPouch(address)
    if (bloomActive) room.send('bloomTriggered', { scale: bloomScale, variant: bloomVariant, elapsedMs: bloomStartedAt ? Date.now() - bloomStartedAt : 0 }, { to: [address] })
    for (const seed of remainingSeeds(address)) sendSeed(seed, [address])
    for (const b of boxes.values()) sendBox(b, [address])
    await sendCollection(address)
    sendTributes([address])
    sendAllHeld([address])
    console.log(`[Server] Full sync sent to ${address} (${getWateredCount()}/${currentBloomThreshold()} watered)`)
  })

  // ── Message: registerPlayer ──────────────────────────────────
  onRoomMessage<{ displayName: string }>('registerPlayer', async (data, address) => {
    for (const board of [leaderboard, lifetime]) {
      const entry = board.get(address)
      if (entry) entry.displayName = data.displayName
      else board.set(address, { displayName: data.displayName, total: 0 })
    }
    saveLeaderboard()
    saveLifetime()
    broadcastLeaderboard([address])
    console.log(`[Server] Registered player: ${data.displayName} (${address})`)
  })

  // Player join detection — runs every frame, lightweight
  engine.addSystem(playerJoinSystem)

  // Schedule bloom checks at every 6am/6pm UTC window
  scheduleBloomCheck()

  // Clock-sync heartbeat — lets clients keep their clockSync offset calibrated
  const SERVER_TIME_INTERVAL_MS = 30_000
  room.send('notifyServerTime', { sentAt: Date.now() })
  setInterval(() => room.send('notifyServerTime', { sentAt: Date.now() }), SERVER_TIME_INTERVAL_MS)

  console.log('[Server] Ready')
}
