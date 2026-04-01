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
} from '../shared/config'

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------

const plantEntities = new Map<string, Entity>()   // plantId → entity
const knownPlayers  = new Set<Entity>()           // entities seen this session
let   bloomActive   = false

// ---------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------

interface PlantRecord {
  plantId:   string
  isWatered: boolean
  wateredAt: number   // ms timestamp stored as number (not BigInt)
}

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
    records.push({ plantId, isWatered: ps.isWatered, wateredAt: Number(ps.wateredAt) })
  }
  await Storage.set('plants', JSON.stringify(records))
}

function dailyKey(date: string): string { return `daily:${date}` }

async function getPlayerDailyCount(address: string): Promise<number> {
  const today = new Date().toISOString().slice(0, 10)
  const raw   = await Storage.player.get<string>(address, dailyKey(today))
  return raw ? parseInt(raw) : 0
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
    room.send('plantStateUpdate', { plantId, isWatered: false, wateredAt: 0 })
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
      if (!ps || !ps.isWatered || ps.wateredAt !== sessionTimestamp) return

      PlantSync.getMutable(entity).isWatered = false
      PlantSync.getMutable(entity).wateredAt = 0
      await savePlantStates()
      room.send('plantStateUpdate', { plantId, isWatered: false, wateredAt: 0 })
      console.log(`[Server] Plant expired: ${plantId}`)
    })
  }, delayMs)
}

// ---------------------------------------------------------------
// Player join detection
// ---------------------------------------------------------------

function playerJoinSystem(): void {
  for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
    if (knownPlayers.has(entity)) continue
    knownPlayers.add(entity)
    const address = identity.address
    executeTask(async () => {
      const wateredToday = await getPlayerDailyCount(address)
      room.send('playerDailyState', { wateredToday, dailyLimit: DAILY_WATER_LIMIT }, { to: [address] })

      // Send current state of all plants so the client can restore visuals
      for (const [plantId, plantEntity] of plantEntities) {
        const ps = PlantSync.getOrNull(plantEntity)
        if (!ps) continue
        room.send('plantStateUpdate', { plantId, isWatered: ps.isWatered, wateredAt: ps.wateredAt }, { to: [address] })
      }

      console.log(`[Server] Player joined: ${address} (${wateredToday}/${DAILY_WATER_LIMIT} today, ${getWateredCount()}/${BLOOM_THRESHOLD} watered)`)
    })
  }
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

  // Restore persisted plant states
  await loadPlantStates()
  console.log(`[Server] ${getWateredCount()} plants currently watered`)

  // ── Message: waterPlant ──────────────────────────────────────
  room.onMessage('waterPlant', (data, context) => {
    if (!context) return
    const playerAddress = context.from
    const { plantId }   = data
    const entity        = plantEntities.get(plantId)

    if (!entity) {
      console.log(`[Server] Unknown plant: ${plantId}`)
      return
    }

    executeTask(async () => {
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

      // Reject if daily limit reached
      const todayCount = await getPlayerDailyCount(playerAddress)
      if (todayCount >= DAILY_WATER_LIMIT) {
        room.send('waterRejected', { plantId, reason: 'daily_limit' }, { to: [playerAddress] })
        return
      }

      // ── All valid — water the plant ──────────────────────────
      const now = Date.now()
      PlantSync.getMutable(entity).isWatered = true
      PlantSync.getMutable(entity).wateredAt = now

      const newCount = await incrementPlayerDailyCount(playerAddress)
      await savePlantStates()
      scheduleExpiry(plantId, entity, now, WATERED_EXPIRY_MS)

      room.send('playerDailyState', { wateredToday: newCount, dailyLimit: DAILY_WATER_LIMIT }, { to: [playerAddress] })
      room.send('plantStateUpdate', { plantId, isWatered: true, wateredAt: now })
      console.log(`[Server] ${plantId} watered by ${playerAddress} (${newCount}/${DAILY_WATER_LIMIT} today, ${getWateredCount()}/${BLOOM_THRESHOLD} garden)`)

      // Check bloom threshold
      if (!bloomActive && getWateredCount() >= BLOOM_THRESHOLD) triggerBloom()
    })
  })

  // Player join detection — runs every frame, lightweight
  engine.addSystem(playerJoinSystem)

  console.log('[Server] Ready')
}
