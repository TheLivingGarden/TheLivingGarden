// =============================================================
// The Living Garden — Authoritative Server
// Runs headlessly alongside the scene. Owns all game state:
//   • Plant watered/expired state  (PlantSync component + Storage)
//   • Per-player daily water count (Storage.player)
//   • Bloom trigger + reset        (threshold check + timer)
// =============================================================

import {
  engine,
  Entity,
  PlayerIdentityData,
  executeTask,
} from '@dcl/sdk/ecs'
import { Storage } from '@dcl/sdk/server'
import { PlantSync }          from '../shared/schemas'
import { room }               from '../shared/messages'
import {
  PLANT_NAMES,
  BLOOM_THRESHOLD,
  DAILY_WATER_LIMIT,
  WATERED_EXPIRY_MS,
  BLOOM_RESET_DELAY_MS,
  BLOOM_UTC_HOUR,
  BLOOM_UTC_MINUTE,
} from '../shared/config'

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------

const plantEntities   = new Map<string, Entity>()   // plantId → entity
const knownPlayers    = new Set<Entity>()            // entities seen this session
const playerAddresses = new Map<Entity, string>()    // entity → address (for disconnect cleanup)
const testOverrides   = new Set<string>()            // addresses with daily-limit bypass (test panel)
const syncRateLimits  = new Map<string, number>()    // address → last requestFullSync ms
const SYNC_RATE_MS    = 5_000                        // min ms between full syncs per player
let   bloomActive    = false

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
}

// In-memory map of plantId → display name (kept in sync with PlantRecord)
const wateredByMap = new Map<string, string>()

async function loadPlantStates(): Promise<void> {
  const raw = await Storage.get<string>('plants')
  if (!raw) { console.log('[Server] No persisted plant states — starting fresh'); return }

  const records: PlantRecord[] = JSON.parse(raw)
  const now = Date.now()
  let restored = 0

  for (const rec of records) {
    const entity = plantEntities.get(rec.plantId)
    if (!entity) continue
    if (!rec.isWatered) continue

    const elapsed = now - rec.wateredAt
    if (elapsed >= WATERED_EXPIRY_MS) continue  // expired while server was down

    const ps = PlantSync.getMutable(entity)
    ps.isWatered = true
    ps.wateredAt = rec.wateredAt
    if (rec.wateredBy) wateredByMap.set(rec.plantId, rec.wateredBy)
    scheduleExpiry(rec.plantId, entity, rec.wateredAt, WATERED_EXPIRY_MS - elapsed)
    restored++
  }
  console.log(`[Server] Restored ${restored} watered plants from Storage`)
}

async function savePlantStates(): Promise<void> {
  const records: PlantRecord[] = []
  for (const [plantId, entity] of plantEntities) {
    const ps = PlantSync.getOrNull(entity)
    if (!ps) continue
    records.push({ plantId, isWatered: ps.isWatered, wateredAt: Number(ps.wateredAt), wateredBy: wateredByMap.get(plantId) ?? '' })
  }
  await Storage.set('plants', JSON.stringify(records))
}

// ── Leaderboard helpers ──────────────────────────────────────

const LEADERBOARD_RESET_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000  // 7 days

async function loadLeaderboard(): Promise<void> {
  const raw = await Storage.get<string>('leaderboard')
  if (raw) {
    const records: Array<{ address: string; displayName: string; total: number }> = JSON.parse(raw)
    for (const r of records) leaderboard.set(r.address, { displayName: r.displayName, total: r.total })
    console.log(`[Server] Loaded leaderboard: ${leaderboard.size} players`)
  }

  // Weekly reset — check stored timestamp; if missing, start the clock now (preserves existing data)
  const rawResetAt = await Storage.get<string>('leaderboardResetAt')
  if (!rawResetAt) {
    await Storage.set('leaderboardResetAt', String(Date.now()))
    console.log('[Server] Leaderboard weekly reset clock started')
  } else if (Date.now() - parseInt(rawResetAt) >= LEADERBOARD_RESET_INTERVAL_MS) {
    leaderboard.clear()
    await saveLeaderboard()
    await Storage.set('leaderboardResetAt', String(Date.now()))
    console.log('[Server] Weekly leaderboard reset complete')
  }
}

async function saveLeaderboard(): Promise<void> {
  const records = [...leaderboard.entries()].map(([address, e]) => ({ address, ...e }))
  await Storage.set('leaderboard', JSON.stringify(records))
}

/** Top-10 sorted entries as JSON, ready to send over the wire. */
function leaderboardJson(): string {
  return JSON.stringify(
    [...leaderboard.values()]
      .sort((a, b) => b.total - a.total)
      .slice(0, 10)
      .map(e => ({ displayName: e.displayName, count: e.total }))
  )
}

function broadcastLeaderboard(to?: string[]): void {
  const entriesJson = leaderboardJson()
  if (to) {
    // Targeted send — used on player join to push current state to one client
    room.send('leaderboardUpdate', { entriesJson }, { to })
  } else {
    // Broadcast — reaches all connected clients including the triggering player
    room.send('leaderboardUpdate', { entriesJson })
  }
}

function dailyKey(date: string): string { return `daily:${date}` }

async function getPlayerDailyCount(address: string): Promise<number> {
  try {
    const today = new Date().toISOString().slice(0, 10)
    const raw   = await Storage.player.get<string>(address, dailyKey(today))
    return raw ? parseInt(raw) : 0
  } catch {
    return 0  // new player — no storage entry yet (Storage.player.get throws 404)
  }
}

async function incrementPlayerDailyCount(address: string): Promise<number> {
  const today    = new Date().toISOString().slice(0, 10)
  const newCount = (await getPlayerDailyCount(address)) + 1
  await Storage.player.set(address, dailyKey(today), String(newCount))
  return newCount
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

function triggerBloom(): void {
  if (bloomActive) return
  bloomActive = true
  console.log(`[Server] Bloom triggered! (${getWateredCount()}/${BLOOM_THRESHOLD} plants)`)
  room.send('bloomTriggered', {})
  setTimeout(() => executeTask(resetGarden), BLOOM_RESET_DELAY_MS)
}

async function resetGarden(): Promise<void> {
  console.log('[Server] Resetting garden...')
  bloomActive = false

  for (const [plantId, entity] of plantEntities) {
    const ps   = PlantSync.getMutable(entity)
    ps.isWatered = false
    ps.wateredAt = 0
    wateredByMap.delete(plantId)
    room.send('plantStateUpdate', { plantId, isWatered: false, wateredAt: 0, wateredBy: '' })
  }

  await savePlantStates()
  room.send('bloomReset', {})
  console.log('[Server] Garden reset complete')
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
      if (bloomActive) return  // bloom reset will clear everything
      const ps = PlantSync.getOrNull(entity)
      if (!ps || !ps.isWatered || Number(ps.wateredAt) !== sessionTimestamp) return

      const expired = PlantSync.getMutable(entity)
      expired.isWatered = false
      expired.wateredAt = 0
      wateredByMap.delete(plantId)
      await savePlantStates()
      room.send('plantStateUpdate', { plantId, isWatered: false, wateredAt: 0, wateredBy: '' })
      console.log(`[Server] Plant expired: ${plantId}`)
    })
  }, delayMs)
}

// ---------------------------------------------------------------
// Scheduled bloom check — fires at every 6am and 6pm UTC
// ---------------------------------------------------------------

function msUntilNextBloomWindow(): number {
  // 15:30 Madrid (CEST = UTC+2 → 13:30 UTC)
  const now      = Date.now()
  const d        = new Date(now)
  const y        = d.getUTCFullYear()
  const mo       = d.getUTCMonth()
  const day      = d.getUTCDate()
  const today    = Date.UTC(y, mo, day,     BLOOM_UTC_HOUR, BLOOM_UTC_MINUTE, 0, 0)
  const tomorrow = Date.UTC(y, mo, day + 1, BLOOM_UTC_HOUR, BLOOM_UTC_MINUTE, 0, 0)
  const ms       = today - now
  return ms > 500 ? ms : tomorrow - now
}

function scheduleBloomCheck(): void {
  const delay    = msUntilNextBloomWindow()
  const windowAt = new Date(Date.now() + delay).toISOString()
  console.log(`[Server] Next bloom window: ${windowAt} (in ${Math.round(delay / 60_000)} min)`)

  setTimeout(() => {
    executeTask(async () => {
      const count = getWateredCount()
      console.log(`[Server] Bloom window reached — health ${count}/${BLOOM_THRESHOLD}`)
      if (!bloomActive && count >= BLOOM_THRESHOLD) triggerBloom()
      scheduleBloomCheck()  // always reschedule for the next window
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
        testOverrides.delete(address)
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
      const wateredToday = await getPlayerDailyCount(address)
      room.send('playerDailyState', { wateredToday, dailyLimit: DAILY_WATER_LIMIT }, { to: [address] })

      // Send current state of all plants so the client can restore visuals
      for (const [plantId, plantEntity] of plantEntities) {
        const ps = PlantSync.getOrNull(plantEntity)
        if (!ps) continue
        room.send('plantStateUpdate', { plantId, isWatered: ps.isWatered, wateredAt: Number(ps.wateredAt), wateredBy: wateredByMap.get(plantId) ?? '' }, { to: [address] })
      }

      broadcastLeaderboard([address])
      // Re-send bloom state to players who join while it is already active
      if (bloomActive) room.send('bloomTriggered', {}, { to: [address] })
      console.log(`[Server] Player joined: ${address} (${wateredToday}/${DAILY_WATER_LIMIT} today, ${getWateredCount()}/${BLOOM_THRESHOLD} watered, bloom=${bloomActive})`)
    })
  }
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

  // Restore persisted plant states and leaderboard
  await loadPlantStates()
  await loadLeaderboard()
  console.log(`[Server] ${getWateredCount()} plants currently watered`)

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

      // Reject if already watered
      if (ps.isWatered) {
        room.send('waterRejected', { plantId, reason: 'already_watered' }, { to: [playerAddress] })
        return
      }

      // Reject if daily limit reached (test-panel override bypasses this)
      const todayCount = await getPlayerDailyCount(playerAddress)
      if (!testOverrides.has(playerAddress) && todayCount >= DAILY_WATER_LIMIT) {
        room.send('waterRejected', { plantId, reason: 'daily_limit' }, { to: [playerAddress] })
        return
      }

      // ── All valid — water the plant ──────────────────────────
      const now      = Date.now()
      const watered  = PlantSync.getMutable(entity)
      watered.isWatered = true
      watered.wateredAt = now

      const newCount = await incrementPlayerDailyCount(playerAddress)

      // Update all-time leaderboard total for this player
      const entry = leaderboard.get(playerAddress)
      if (entry) {
        entry.total += 1
      } else {
        leaderboard.set(playerAddress, { displayName: playerAddress.slice(0, 8) + '…', total: 1 })
      }

      const displayName = leaderboard.get(playerAddress)?.displayName ?? playerAddress.slice(0, 8) + '…'
      wateredByMap.set(plantId, displayName)

      await savePlantStates()
      await saveLeaderboard()
      scheduleExpiry(plantId, entity, now, WATERED_EXPIRY_MS)

      room.send('playerDailyState', { wateredToday: newCount, dailyLimit: DAILY_WATER_LIMIT }, { to: [playerAddress] })
      room.send('plantStateUpdate', { plantId, isWatered: true, wateredAt: now, wateredBy: displayName })
      broadcastLeaderboard()
      console.log(`[Server] ${plantId} watered by ${playerAddress} (${newCount}/${DAILY_WATER_LIMIT} today, ${getWateredCount()}/${BLOOM_THRESHOLD} garden)`)
    }
  })

  // ── Message: forceBloom ─────────────────────────────────────
  onRoomMessage<Record<string, never>>('forceBloom', async (_data, _address) => {
    triggerBloom()
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
    const wateredToday = await getPlayerDailyCount(address)
    room.send('playerDailyState', { wateredToday, dailyLimit: DAILY_WATER_LIMIT }, { to: [address] })
    for (const [plantId, plantEntity] of plantEntities) {
      const ps = PlantSync.getOrNull(plantEntity)
      if (!ps) continue
      room.send('plantStateUpdate', { plantId, isWatered: ps.isWatered, wateredAt: Number(ps.wateredAt), wateredBy: wateredByMap.get(plantId) ?? '' }, { to: [address] })
    }
    broadcastLeaderboard([address])
    if (bloomActive) room.send('bloomTriggered', {}, { to: [address] })
    console.log(`[Server] Full sync sent to ${address} (${wateredToday}/${DAILY_WATER_LIMIT} today, ${getWateredCount()}/${BLOOM_THRESHOLD} watered)`)
  })

  // ── Message: setTestOverride ─────────────────────────────────
  onRoomMessage<{ enabled: boolean }>('setTestOverride', async (data, address) => {
    if (data.enabled) {
      testOverrides.add(address)
      console.log(`[Server] Test override ENABLED for ${address}`)
    } else {
      testOverrides.delete(address)
      console.log(`[Server] Test override DISABLED for ${address}`)
    }
  })

  // ── Message: registerPlayer ──────────────────────────────────
  onRoomMessage<{ displayName: string }>('registerPlayer', async (data, address) => {
    const entry = leaderboard.get(address)
    if (entry) {
      entry.displayName = data.displayName
    } else {
      leaderboard.set(address, { displayName: data.displayName, total: 0 })
    }
    await saveLeaderboard()
    broadcastLeaderboard([address])
    console.log(`[Server] Registered player: ${data.displayName} (${address})`)
  })

  // Player join detection — runs every frame, lightweight
  engine.addSystem(playerJoinSystem)

  // Schedule bloom checks at every 6am/6pm UTC window
  scheduleBloomCheck()

  console.log('[Server] Ready')
}
