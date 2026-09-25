// =============================================================
// The Living Garden — Authoritative Server
// Runs headlessly alongside the scene. Owns all game state:
//   • Plant watered/expired state  (PlantSync component, persisted)
//   • Bloom trigger + reset        (threshold check + timer)
//   • Boards, tributes, planters, pouches, keepsakes, almanac (persisted)
// Memory is authoritative. persistence.ts holds every save until its key has been
// read, orders and retries them, and never reports a failed read as an empty key.
// =============================================================

import {
  engine,
  Entity,
  PlayerIdentityData,
  executeTask,
} from '@dcl/sdk/ecs'
import { loadScene, loadPlayer, createSceneWriter, createPlayerWriter, KeyWriter, isStorableAddress, onSaveProblem } from './persistence'
import { lastSeenToStore } from './lastSeen'
import { PlantSync }          from '../shared/schemas'
import { room }               from '../shared/messages'
import {
  PLANT_NAMES,
  BLOOM_THRESHOLD,
  WATERED_EXPIRY_MS,
  FAST_PLANT_EXPIRY_MS,
  FAST_PLANT_NAMES,
  BLOOM_RESET_DELAY_MS,
  bloomDurationMs,
  SEED_WAVE_GAP_MS,
  SEED_LAST_WAVE_BEFORE_END_MS,
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
  rollTierAtLeast,
  GUARANTEED_RARE_AT_CONTRIBUTORS,
  GOLDEN_SEED_AT_FRACTION,
  rollRainbowTier,
  rollPlantSpecies,
  RARITY_TIERS,
  ALMANAC_MILESTONES,
  milestoneTarget,
  SEED_LIFETIME_MS,
  GARDEN_BOUNDS,
  BOX_POSITIONS,
  BOX_GROW_MS,
  growMsForTier,
  growShaveMsForTier,
  formatGrowTime,
  BOX_CAP_DEFAULT,
  PLANTER_RESERVE_TTL_MS,
  FINALE_RARE_TIER,
  PLANTER_RESERVE_FREE,
  PLANTER_TIDY_MIN_AWAY_MS,
  FLOWER_COLLECTION_CAP,
  BOX_WATER_MAX,
  BLOOM_TRIGGER_COOLDOWN_MS, EXPIRY_TELL_MS,
  plantSpeciesById,
  rarityTierById,
  AVENUE_POSITIONS,
  AVENUE_MIN_TIER,
  AVENUE_NEVER_TIDY_TIER,
  avenueSlotCap,
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
let   bloomDuration    = BLOOM_RESET_DELAY_MS // ms length of the active bloom (bloomDurationMs)
let   bloomSeedContributors = 1               // contributors at fire time — seed count + rarity
/** Players who watered since the last reset — the bloom's length scales with them. */
const cycleContributors = new Set<string>()
// Per-cycle tallies behind the bloom finale card. Keyed LOWERCASE, like cycleContributors
// and heldFlowers — the room hands addresses over in mixed case, and crossing the two key
// spaces is exactly what wiped a player's held flower on 2026-09-20.
const cycleWatersBy = new Map<string, number>()                                 // address → waters this cycle
const cycleSeedsBy  = new Map<string, { seeds: number; rares: number }>()       // address → gathered this bloom


// ── Persistence ──────────────────────────────────────────────
// One writer per scene key. Each holds its saves until its key has been read, so a
// blob that failed to load is never overwritten by the emptier state we started
// with; a failed load is retried in the background until it can be merged, and on
// merge memory wins for anything touched this session. persistence.ts keeps ONE
// write in flight across every key — the preview storage service reads and rewrites
// the whole file per PUT, so concurrent writes to different keys erase each other
// (2026-09-17: a harvest's 'boxes' write lost to its own 'flowers' write).
//
// Every value carries a shape version. Bump a key's version here when its stored
// shape changes, and handle the older one where it is read: persistence.ts reports
// the version each value was written with, and a value stored before versioning
// reads back as LEGACY_VERSION.
const V = {
  plants: 1, leaderboard: 1, lifetimeTop: 1, leaderboardResetAt: 1,
  tributes: 1, boxes: 1, lastSeen: 1, planterDraft: 1,
  avenue: 1, plantDraft: 1, tributeDraft: 1,
} as const

/** Shape version per player-scoped key, stamped when its writer is created. */
const PLAYER_KEY_VERSION: Record<string, number> = {
  seeds: 1, flowers: 1, boxCap: 1, lifetime: 1,
  onboarding: 1, discovered: 1, milestones: 1, keptSafe: 1,
}

const plantsWriter       = createSceneWriter('plants',             V.plants)
const leaderboardWriter  = createSceneWriter('leaderboard',        V.leaderboard)
const lifetimeTopWriter  = createSceneWriter('lifetimeTop',        V.lifetimeTop)
const resetAtWriter      = createSceneWriter('leaderboardResetAt', V.leaderboardResetAt)
const tributesWriter     = createSceneWriter('tributes',           V.tributes)
const boxesWriter        = createSceneWriter('boxes',              V.boxes)
const lastSeenWriter     = createSceneWriter('lastSeen',           V.lastSeen)
const planterDraftWriter = createSceneWriter('planterDraft',       V.planterDraft)   // admin overwrite target, never merged
const plantDraftWriter   = createSceneWriter('plantDraft',         V.plantDraft)     // admin overwrite target, never merged
const tributeDraftWriter = createSceneWriter('tributeDraft',       V.tributeDraft)   // admin overwrite target, never merged
const avenueWriter       = createSceneWriter('avenue',             V.avenue)

/** A draft is stored as the JSON text the editor sent. One written before versioning
 *  reads back parsed (persistence.ts parses legacy JSON strings), so re-serialise it. */
function draftText(res: { ok: boolean; value?: unknown }): string {
  if (!res.ok || res.value == null) return ''
  return typeof res.value === 'string' ? res.value : JSON.stringify(res.value)
}

const RELOAD_INTERVAL_MS = 30_000

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
interface LeaderboardEntry {
  displayName: string
  total: number
  /** Flair tier at the time this entry last changed. Stored on WEEKLY entries so the
   *  board still shows the right flair for a gardener who is offline and outside the
   *  lifetime top-N, whose lifetime total the server therefore does not hold. */
  tier?: number
}
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
// plantId → waterer's Almanac rung count. In memory only, unlike the flair tier: a restart
// just means already-watered plants show no title until their next watering, and those
// plants expire within minutes anyway.
const wateredAlmanacMap = new Map<string, number>()
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
    room.send('plantStateUpdate', { plantId: rec.plantId, isWatered: true, wateredAt: rec.wateredAt, wateredBy: rec.wateredBy ?? '', expiresInMs: expiresAt - now, tier: rec.tier ?? 0, almanac: 0 })
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
// A gardener's lifetime total lives in THEIR OWN player record, not in a scene blob.
// The blob was rewritten in full on every water and grew with every player who ever
// watered, so its cost climbed with the population on the hottest path. What stays
// scene-level is `lifetimeTop`: the top LIFETIME_TOP_N gardeners, so the all-time
// board still works for players who are offline. The old `lifetime` blob is read once
// at boot as a floor and never written again — a gardener's record is seeded from it
// the first time they load.
const lifetime = new Map<string, LeaderboardEntry>()   // address → entry, never reset
const LIFETIME_TOP_N = 50
let lifetimeTopJson = ''                                // last top-N written, to skip no-op saves
let weeklyResetAt = 0                                   // epoch ms when the weekly board next clears

interface BoardRecord extends LeaderboardEntry { address: string }

/** Merge stored totals into a live board: totals earned this session are added on top. */
function mergeBoard(board: Map<string, LeaderboardEntry>, records: unknown): void {
  if (!Array.isArray(records)) return
  for (const r of records as BoardRecord[]) {
    const live = board.get(r.address)
    if (live) { live.total += r.total; live.tier = r.tier ?? live.tier }
    else board.set(r.address, { displayName: r.displayName, total: r.total, tier: r.tier })
  }
}

// Stored totals are ADDED to live ones, so the boards may be merged only once. A retry
// that happens because only the tributes read failed must not merge them again.
let boardsMerged = false

/** Load (or late-load) both boards, the reset clock and the tributes. False when a read failed. */
async function loadLeaderboard(): Promise<boolean> {
  if (boardsMerged) return loadTributes()   // boards are already in; only tributes were missing
  const [board, legacy, top, resetAt] = await Promise.all([
    loadScene<BoardRecord[]>('leaderboard'),
    loadScene<BoardRecord[]>('lifetime'),      // legacy blob: read as a floor, never written
    loadScene<BoardRecord[]>('lifetimeTop'),
    loadScene<number>('leaderboardResetAt'),
  ])
  if (!board.ok || !legacy.ok || !top.ok || !resetAt.ok) {
    console.error('[Server] leaderboard: load failed — saves held until a reload succeeds')
    return false
  }
  boardsMerged = true
  leaderboardWriter.enable()
  lifetimeTopWriter.enable()
  resetAtWriter.enable()

  mergeBoard(leaderboard, board.value)
  console.log(`[Server] Loaded leaderboard: ${leaderboard.size} players`)
  // Both are floors, never sums: the top-N is derived from records that were
  // themselves seeded from the legacy blob, so adding them would double-count.
  seedLifetime(legacy.value)
  seedLifetime(top.value)
  if (lifetime.size > 0) {
    console.log(`[Server] Lifetime: ${lifetime.size} gardener(s) known (legacy blob + top ${LIFETIME_TOP_N})`)
  } else {
    // Fresh world: this week's totals are the best floor we have — never start
    // veterans from zero. Records are written as each of them next waters.
    for (const [address, e] of leaderboard) lifetime.set(address, { ...e })
    console.log(`[Server] Lifetime seeded from weekly (${lifetime.size} players)`)
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
  refreshLifetimeTop()
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
  // Retract any founding tribute no longer listed in FOUNDING_TRIBUTES (KJ 2026-09-22:
  // "remove the tribute plaque and plant to Peter for now") — its plot frees up, and
  // re-adding the honoree to the config list regrows it exactly as it did the first time.
  const keptNames = new Set(FOUNDING_TRIBUTES.map(f => f.displayName))
  const beforeCount = tributes.length
  tributes = tributes.filter(t => !t.founding || keptNames.has(t.displayName))
  if (tributes.length !== beforeCount) changed = true
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
        void saveLifetimeFor(address)   // honorees are rarely connected, so load-then-write
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

/** Seed live totals from a stored board. A floor, never a sum: a stored total can
 *  raise a live one but never lower it, so re-running this cannot double-count. */
function seedLifetime(records: unknown): void {
  if (!Array.isArray(records)) return
  for (const r of records as BoardRecord[]) {
    if (!r || typeof r.address !== 'string') continue
    const total = Number(r.total) || 0
    const live  = lifetime.get(r.address)
    if (live) {
      if (total > live.total) live.total = total
      if (r.displayName) live.displayName = r.displayName
    } else {
      lifetime.set(r.address, { displayName: String(r.displayName ?? ''), total })
    }
  }
}

/** Rewrite the bounded all-time board, but only when its content actually changed —
 *  most waters do not move the top LIFETIME_TOP_N at all. */
function refreshLifetimeTop(): void {
  const top = [...lifetime.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, LIFETIME_TOP_N)
    .map(([address, e]) => ({ address, displayName: e.displayName, total: e.total }))
  const json = JSON.stringify(top)
  if (json === lifetimeTopJson) return
  lifetimeTopJson = json
  lifetimeTopWriter.save(top)
}

/** One gardener's lifetime record. The object it returns IS their entry in `lifetime`,
 *  so bumping the board bumps the record and one save persists both. */
async function loadLifetimeRecord(address: string): Promise<LeaderboardEntry> {
  const seeded = lifetime.get(address)
  const rec = await loadPlayerRecord<LeaderboardEntry>(address, 'lifetime', stored => {
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      const r = stored as Partial<LeaderboardEntry>
      // The legacy blob is a floor: an older record must never lower a known total.
      return { displayName: String(r.displayName ?? seeded?.displayName ?? ''), total: Math.max(Number(r.total) || 0, seeded?.total ?? 0) }
    }
    return { displayName: seeded?.displayName ?? '', total: seeded?.total ?? 0 }
  })
  lifetime.set(address, rec)
  return rec
}

/** Persist one gardener's lifetime total, and the all-time board if they moved it.
 *  Loads the record first so a total is never written before it has been read. */
async function saveLifetimeFor(address: string): Promise<void> {
  await loadLifetimeRecord(address)
  savePlayerJson(address, 'lifetime')
  refreshLifetimeTop()
}

function tierOf(address: string): number {
  return flairTier(lifetime.get(address)?.total ?? 0)
}

/** "N lifetime waters — your name now carries X". Shared by the real crossing (waterPlant)
 *  and the test-panel shortcut (adminGrantWaters). (The Avenue no longer unlocks by flair —
 *  AVENUE_SLOT_CAP — so the unlock line that used to ride on tier 1 is gone; the onboarding
 *  'avenue' stage does that job the moment a player actually has a Rare to display.) */
function flairTierMessage(tier: number, total: number): string {
  const names = ['', 'a sprout', 'a flower', 'a golden flower']
  return `${total} lifetime waters — your name now carries ${names[tier]}`
}

// Almanac rung count per gardener, mirrored in memory so the watering and board paths can
// read it SYNCHRONOUSLY — both run per-water and must not await a Storage read. Written by
// checkMilestones, which runs on join and on every discovery, so it is warm for everyone
// connected; a gardener the server has not seen this run simply shows no title.
const almanacRanks = new Map<string, number>()
const almanacRankOf = (address: string): number => almanacRanks.get(address.toLowerCase()) ?? 0

/** Count one water on both boards (creating entries with a placeholder name). */
function bumpWaterTotals(address: string): void {
  for (const board of [leaderboard, lifetime]) {
    const entry = board.get(address)
    if (entry) entry.total += 1
    else board.set(address, { displayName: leaderboard.get(address)?.displayName ?? address.slice(0, 8) + '…', total: 1 })
  }
  // Stamp the weekly entry so the board keeps its flair once the gardener is gone.
  const weekly = leaderboard.get(address)
  if (weekly) weekly.tier = flairTier(lifetime.get(address)?.total ?? 0)
}

/** Top-10 sorted entries of a board as JSON, ready to send over the wire. */
function boardJson(board: Map<string, LeaderboardEntry>): string {
  return JSON.stringify(
    [...board.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 10)
      // address travels too (v2): the podium renders each top gardener's AvatarShape,
      // which needs their wallet to look the profile up. Names alone are not enough.
      // A stamped tier wins: for a weekly entry it may be the only record of the
      // gardener's flair, since their lifetime total is no longer held for everyone.
      .map(([address, e]) => ({ displayName: e.displayName, count: e.total, tier: e.tier ?? tierOf(address), almanac: almanacRankOf(address), address }))
  )
}

/** Where one gardener stands on a board — ranked against EVERY entry, not the top-10 slice,
 *  so someone outside the list still gets a real number. rank 0 = not on the board. */
function standingIn(board: Map<string, LeaderboardEntry>, address: string): { rank: number; count: number } {
  const mine = board.get(address)
  if (!mine) return { rank: 0, count: 0 }
  let ahead = 0
  for (const other of board.values()) if (other.total > mine.total) ahead++
  return { rank: ahead + 1, count: mine.total }
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
  // Each recipient also gets their OWN standing — one small per-player message rather than
  // a per-player board, since the board itself is identical for everyone.
  for (const address of to ?? [...new Set(playerAddresses.values())]) {
    const w = standingIn(leaderboard, address)
    const a = standingIn(lifetime, address)
    room.send('yourStanding', { weeklyRank: w.rank, weeklyCount: w.count, allTimeRank: a.rank, allTimeCount: a.count }, { to: [address] })
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
let bloomCooldownUntil:    number        = 0      // no bloom may START before this (set by resetGarden)

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
  if (bloomActive || Date.now() < bloomCooldownUntil) return
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

/** @param forcedVariant test-panel only: a BLOOM_VARIANTS id to force ('' = normal roll). Forces the
 *  variant ONLY — scale, length and seeds follow the real gardeners, so a test bloom plays out
 *  like a real one (KJ 2026-09-19: a solo forced bloom ran the full 6 min). */
function triggerBloom(forcedVariant = ''): void {
  if (bloomActive) return
  const threshold = currentBloomThreshold()
  cancelBloomSustain()
  bloomActive    = true
  bloomStartedAt = Date.now()
  bloomScale     = bloomScaleFor(knownPlayers.size)
  const variant  = forcedVariant ? bloomVariantById(forcedVariant) : rollBloomVariant(bloomScale)
  bloomVariant   = variant.id
  bloomSeedContributors = Math.max(1, cycleContributors.size)
  bloomDuration  = bloomDurationMs(bloomSeedContributors)
  console.log(`[Server] Bloom triggered! (${getWateredCount()}/${threshold} plants, scale ${bloomScale.toFixed(2)}, variant ${variant.name}, ${cycleContributors.size} contributor(s) → ${bloomDuration / 60_000} min)`)
  room.send('bloomTriggered', { scale: bloomScale, variant: bloomVariant, elapsedMs: 0, durationMs: bloomDuration })
  scheduleSeedWaves()
  scheduleGoldenSeed()
  setTimeout(() => executeTask(resetGarden), bloomDuration)
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

/** Seed trickle (KJ 2026-09-18): the bloom's seeds fall in waves across the bloom —
 *  something to do the whole time, at any length. Waves are ≤ SEED_WAVE_GAP_MS apart, the
 *  first at the start and the last SEED_LAST_WAVE_BEFORE_END_MS before the end; the
 *  earliest waves take the leftovers. Total yield/rarity unchanged (bloom size). */
const seedWaveTimers: Array<ReturnType<typeof setTimeout>> = []

function scheduleSeedWaves(): void {
  cancelSeedWaves()
  const total  = seedSpawnCount(bloomSeedContributors)
  const window = Math.max(0, bloomDuration - SEED_LAST_WAVE_BEFORE_END_MS)
  const waves  = Math.max(1, Math.min(total, Math.floor(window / SEED_WAVE_GAP_MS) + 1))
  const gap    = waves > 1 ? window / (waves - 1) : 0
  for (let w = 0; w < waves; w++) {
    const n = Math.floor(total / waves) + (w < total % waves ? 1 : 0)
    if (w === 0) { spawnBloomSeeds(n, bloomSeedContributors >= GUARANTEED_RARE_AT_CONTRIBUTORS); continue }
    seedWaveTimers.push(setTimeout(() => executeTask(async () => { if (bloomActive) spawnBloomSeeds(n) }), Math.round(gap * w)))
  }
  console.log(`[Server] Seed trickle: ${total} seeds in ${waves} wave(s) over ${Math.round(window / 1000)}s`)
}

// ── Golden seed chase ─────────────────────────────────────────
interface GoldenSeed { id: string; pathSeed: number; spawnedAt: number; endsAt: number; gatheredBy: Set<string> }
let golden: GoldenSeed | null = null
let goldenTimer: ReturnType<typeof setTimeout> | null = null

function scheduleGoldenSeed(): void {
  cancelGoldenSeed()
  const startedAt = bloomStartedAt ?? Date.now()
  goldenTimer = setTimeout(() => executeTask(async () => {
    goldenTimer = null
    if (!bloomActive) return
    golden = { id: `golden_${Date.now()}`, pathSeed: Math.random() * 1000, spawnedAt: Date.now(), endsAt: startedAt + bloomDuration, gatheredBy: new Set() }
    console.log(`[Server] Golden seed ${golden.id} appears — ${Math.round((golden.endsAt - golden.spawnedAt) / 1000)}s to catch it`)
    sendGolden()
  }), Math.round(bloomDuration * GOLDEN_SEED_AT_FRACTION))
}

function cancelGoldenSeed(): void {
  if (goldenTimer !== null) { clearTimeout(goldenTimer); goldenTimer = null }
  golden = null   // clients despawn it at endsAt on their own
}

/** Broadcast (or send to a joiner) — only while it is still out. */
function sendGolden(to?: string[]): void {
  if (!golden || Date.now() >= golden.endsAt) return
  const payload = { id: golden.id, pathSeed: golden.pathSeed, spawnedAt: golden.spawnedAt, endsAt: golden.endsAt, serverNow: Date.now() }
  room.send('goldenSeed', payload, to ? { to } : undefined)
}

function cancelSeedWaves(): void {
  for (const t of seedWaveTimers) clearTimeout(t)
  seedWaveTimers.length = 0
}

/** Roll and broadcast one wave of seeds — rarity scales with contributors.
 *  `guaranteeRare`: this wave's first seed is Rare or better (4+ contributors). */
function spawnBloomSeeds(count: number, guaranteeRare = false): void {
  const rareSeedMult = bloomVariantById(bloomVariant).rareSeedMult
  const now          = Date.now()
  const batch: SeedRecord[] = []
  for (let i = 0; i < count; i++) {
    const seed: SeedRecord = {
      id:         `seed_${now}_${seedCounter++}`,
      x:          GARDEN_BOUNDS.xMin + Math.random() * (GARDEN_BOUNDS.xMax - GARDEN_BOUNDS.xMin),
      z:          GARDEN_BOUNDS.zMin + Math.random() * (GARDEN_BOUNDS.zMax - GARDEN_BOUNDS.zMin),
      rarityTier: guaranteeRare && i === 0 ? rollTierAtLeast(2) : rollSeedTier(bloomSeedContributors, rareSeedMult),
      spawnedAt:  now,
      gatheredBy: new Set(),
    }
    batch.push(seed)
    activeSeeds.set(seed.id, seed)
    // Ungathered seeds evaporate — clients despawn on their own matching timer
    setTimeout(() => activeSeeds.delete(seed.id), SEED_LIFETIME_MS)
    sendSeed(seed)
  }
  console.log(`[Server] Seed wave: ${count} seeds (${batch.filter(s => s.rarityTier > 0).length} above Common, ${bloomSeedContributors} contributor(s)${guaranteeRare ? ', 1 guaranteed Rare+' : ''})`)
}

/** Seeds this player can still collect — for joins/resyncs mid-bloom. */
function remainingSeeds(address: string): SeedRecord[] {
  const cutoff = Date.now() - SEED_LIFETIME_MS
  return [...activeSeeds.values()].filter(s => s.spawnedAt > cutoff && !s.gatheredBy.has(address))
}

/** Seed counts per rarity tier, index = tier id (0 = Common .. RARITY_TIERS.length-1). */
type SeedPouch = number[]
function emptyPouch(): SeedPouch { return new Array(RARITY_TIERS.length).fill(0) }

// ── Per-player records ───────────────────────────────────────
// One cached object per (address, key) is the session's source of truth, each with
// its own writer — without this, concurrent gathers each read→modified→wrote the
// stored value and overwrote each other (11 gathers persisted as 6). Concurrent loads
// of one record share a request, and records are dropped once the player leaves and
// their writes have landed. If a read FAILS (only a rejected get — the realm lookup),
// the default is returned but NOT cached, so nothing can be written over what is
// stored; a save for an uncached record is logged as dropped rather than lost silently.
interface PlayerRecord { value: unknown; writer: KeyWriter }
const playerRecords = new Map<string, PlayerRecord>()       // `${lowercase address}:${key}` → live record

/** Players whose address cannot key player storage: their records live in memory for the session only. */
const memoryOnlyPlayers = new Set<string>()                 // lowercase address
const MEMORY_ONLY_WRITER: KeyWriter = { save() {}, enable() {}, idle: () => Promise.resolve() }
const playerLoads   = new Map<string, Promise<unknown>>()   // in-flight loads for the same key

// Keyed LOWERCASE, like heldFlowers/heldSeeds — join hands over `identity.address`, messages
// `context.from` (mixed case). Two live pouches per player meant the hand and the chip read
// different ones (week-2 playtest 2026-09-22: "seed in my hand but my inventory says no
// seeds yet"). The Storage address is passed through as given — only the cache key is normalised.
function recordKey(address: string, key: string): string { return `${address.toLowerCase()}:${key}` }

async function loadPlayerRecord<T>(address: string, key: string, parse: (stored: unknown) => T): Promise<T> {
  const k    = recordKey(address, key)
  const live = playerRecords.get(k)
  if (live) return live.value as T
  const inFlight = playerLoads.get(k)
  if (inFlight) return inFlight as Promise<T>
  if (memoryOnlyPlayers.has(address.toLowerCase())) {
    const value = parse(null)
    playerRecords.set(k, { value, writer: MEMORY_ONLY_WRITER })
    return value
  }

  const load = (async (): Promise<T> => {
    const res = await loadPlayer<unknown>(address, key)
    if (!res.ok) { console.error(`[Server] ${key} for ${address.slice(0, 8)}…: load failed — using the default, not cached`); return parse(null) }
    const value  = parse(res.value)
    const writer = createPlayerWriter(address, key, PLAYER_KEY_VERSION[key] ?? 1)
    writer.enable()
    playerRecords.set(k, { value, writer })
    return value
  })()
  playerLoads.set(k, load)
  try { return await load } finally { playerLoads.delete(k) }
}

/** Object records: the stored object, or `def()` when the key holds nothing usable. */
function loadPlayerJson<T>(address: string, key: string, def: () => T): Promise<T> {
  return loadPlayerRecord<T>(address, key, stored => (stored !== null && typeof stored === 'object' ? stored as T : def()))
}

/** Queue the record's current state; the writer orders and retries it. */
function savePlayerJson(address: string, key: string): void {
  const rec = playerRecords.get(recordKey(address, key))
  if (rec) rec.writer.save(rec.value)
  else console.error(`[Server] ${key} for ${address.slice(0, 8)}…: save dropped — record never loaded`)
}

/** Forget a departed player's records once their pending writes have landed. */
function evictPlayerRecords(address: string): void {
  const prefix = `${address.toLowerCase()}:`
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
const savePouch = (a: string) => savePlayerJson(a, 'seeds')

function sendPouch(address: string): void {
  const p = playerRecords.get(recordKey(address, 'seeds'))?.value as SeedPouch | undefined
  if (p) room.send('pouchUpdate', { countsJson: JSON.stringify(p) }, { to: [address] })
  else console.error(`[Server] sendPouch: no live pouch for ${address} — call loadPouch first`)
  refreshHandSeed(address)   // the rarest seed they hold may have changed
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

/** "12 s" at the playtest base, "24 minutes" at the production one. */
function shaveText(ms: number): string { return ms < 90_000 ? `${Math.round(ms / 1000)} s` : formatGrowTime(ms) }

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

interface FlowerKeepsake {
  flower: string; rarityTier: number; at: number; from?: string
  // Provenance (2026-09-22, for the Avenue plaque) — set at harvest, carried through gifts.
  // Older keepsakes lack them; every reader must treat them as optional.
  grownBy?:  string     // display name of whoever grew it
  plantedAt?: number
  openedAt?: number
  helpers?:  string[]   // display names of the visitors who watered its planter
  avenue?:   number     // how many times it has stood on the Avenue
}
const loadFlowers = (a: string) => loadPlayerRecord<FlowerKeepsake[]>(a, 'flowers', v => (Array.isArray(v) ? v as FlowerKeepsake[] : []))

// ── Onboarding (v2): the two firsts the in-world tutorial waits on. Persisted per
// wallet so the lesson never replays for a gardener who has done it — and a gardener
// who watered last visit but never got as far as planting still gets taught planting.
interface OnboardingRecord { watered: boolean; planted: boolean; harvested: boolean; gifted: boolean; pouchOpened: boolean; avenueUsed: boolean }
async function loadOnboarding(address: string): Promise<OnboardingRecord> {
  // Backfill for gardeners who predate this record (the key landed 2026-09-20): without it
  // every existing player is handed the beginner tutorial at launch. Used ONLY as the
  // default - once a record exists it wins, which is why the test panel's reset (it writes
  // an all-false record rather than deleting the key) still replays the whole tutorial.
  const flowers = await loadFlowers(address)
  const o = await loadPlayerJson<OnboardingRecord>(address, 'onboarding', () => ({
    watered:   (lifetime.get(address)?.total ?? 0) > 0,
    planted:     boxesOwnedBy(address) > 0 || flowers.length > 0,
    harvested:   flowers.length > 0,
    gifted:      false,
    // Same condition as `planted`: anyone who has already grown something has been
    // around long enough not to be taught where their own pouch is.
    pouchOpened: boxesOwnedBy(address) > 0 || flowers.length > 0,
    // Unlike `gifted`, this one CAN be backfilled accurately: the Avenue tracks its own
    // owners, so a gardener who already has a flower on show is never nagged about it.
    avenueUsed:  [...avenue.values()].some(r => r.owner === address),
  }))
  // Migrate on load: a record written before a field existed reads back undefined,
  // and an undefined in a Schemas.Boolean field throws inside the event bus. The
  // harvested/gifted pair was added 2026-09-20, so early records DO hit this.
  o.watered   = !!o.watered
  o.planted   = !!o.planted
  o.harvested = !!o.harvested
  o.gifted    = !!o.gifted
  o.pouchOpened = !!o.pouchOpened
  o.avenueUsed  = !!o.avenueUsed
  return o
}
async function sendOnboarding(address: string): Promise<void> {
  const o = await loadOnboarding(address)
  room.send('onboardingState', { watered: o.watered, planted: o.planted, harvested: o.harvested, gifted: o.gifted, pouchOpened: o.pouchOpened, avenueUsed: o.avenueUsed }, { to: [address] })
}
// ── Tutorial planter reservations (Phase 2). In memory only: a server restart just
// means the tutorial re-asks. The CLIENT chooses which planter (the server has no
// avatar positions); the server only decides whether it may be held.
const planterReservations = new Map<string, { boxId: string; expiresAt: number }>()   // address →

/** The address holding this planter, or null. Expired holds are dropped on read. */
function reservationHolder(boxId: string): string | null {
  const now = Date.now()
  for (const [address, r] of planterReservations) {
    if (r.expiresAt <= now) { planterReservations.delete(address); continue }
    if (r.boxId === boxId) return address
  }
  return null
}

function clearReservation(address: string): void { planterReservations.delete(address) }

/** Record one of the firsts and tell the client — a no-op once it is already set. */
async function markOnboarding(address: string, step: keyof OnboardingRecord): Promise<void> {
  const o = await loadOnboarding(address)
  if (o[step]) return
  o[step] = true
  // No starter seed here: KJ 2026-09-22 playtest 2 — the first seed must come from the
  // bloom the player's own watering earns, so the loop is the lesson (onboarding 'bloom' stage).
  void savePlayerJson(address, 'onboarding')
  await sendOnboarding(address)
}
const loadBoxCap  = (a: string) => loadPlayerJson<{ cap: number }>(a, 'boxCap', () => ({ cap: BOX_CAP_DEFAULT }))
/** Admins with the test panel's "Unlimited planters" on (in memory only). */
const unlimitedPlanters = new Set<string>()
const UNLIMITED_CAP = 999
const RARITY_TIER_COUNT = 8   // Common..Unique
/** Effective planter cap: a stored cap (e.g. bought planters) never drops below the default. */
async function planterCap(address: string): Promise<number> {
  if (unlimitedPlanters.has(address)) return UNLIMITED_CAP
  return Math.max((await loadBoxCap(address)).cap, BOX_CAP_DEFAULT)
}

// ── Discovered species (2026-09-21) — the ALMANAC's source of truth, and deliberately
// NOT derived from `flowers`. A species counts the moment it is revealed in your planter
// or arrives as a gift, so leaving a flower on show (GDD §3.1's first-class choice) never
// costs you catalogue progress. Backfilled on first load from the flowers already kept
// PLUS any opened planter still standing, so nobody loses history to the new key.
// Entries are `${species}|${tier}`, not bare species ids: species and rarity are rolled
// INDEPENDENTLY (openBox picks the species, the tier was fixed when the seed was planted),
// so "which rarities have I seen this flower at" is real collection depth and the Almanac
// shows it. Bare ids from the first hours of this key are still read, as species-only.
const discoveredKey = (flower: string, tier: number) => `${flower}|${tier}`

async function loadDiscovered(address: string): Promise<string[]> {
  const flowers = await loadFlowers(address)
  const lower   = address.toLowerCase()
  const standing = [...boxes.values()].filter(b => b.opened && b.flower && b.owner.toLowerCase() === lower)
  return loadPlayerJson<string[]>(address, 'discovered', () => [...new Set([
    ...flowers.map(f => discoveredKey(f.flower, f.rarityTier ?? 0)),
    ...standing.map(b => discoveredKey(b.flower, b.rarityTier)),
  ])])
}

async function sendDiscovered(address: string): Promise<void> {
  const list = await loadDiscovered(address)
  room.send('discoveredUpdate', { listJson: JSON.stringify(list) }, { to: [address] })
  await checkMilestones(address, speciesCount(list))
}

/** Distinct species in a discovered list. Entries are `${species}|${tier}`; a bare id
 *  from the first hours of this key still counts as its species. */
function speciesCount(list: string[]): number {
  const ids = new Set<string>()
  for (const e of list) { const bar = e.lastIndexOf('|'); ids.add(bar === -1 ? e : e.slice(0, bar)) }
  ids.delete('')
  return ids.size
}

const loadMilestones = (a: string) => loadPlayerJson<{ claimed: number }>(a, 'milestones', () => ({ claimed: 0 }))

/** Pay out every Almanac milestone this species count has crossed. Plural on purpose: the
 *  first load of an established gardener backfills a whole collection at once and can
 *  cross several rungs in one go. Runs from sendDiscovered, so it covers both a fresh
 *  discovery and a join — `claimed` is what stops anything paying twice. */
async function checkMilestones(address: string, species: number): Promise<void> {
  const rec = await loadMilestones(address)
  let changed = false
  almanacRanks.set(address.toLowerCase(), rec.claimed)   // warm the sync cache on every join
  for (let i = rec.claimed; i < ALMANAC_MILESTONES.length; i++) {
    const m = ALMANAC_MILESTONES[i]
    if (species < milestoneTarget(m)) break
    rec.claimed = i + 1
    changed = true

    const pouch = await loadPouch(address)
    pouch[m.seedTier] = (pouch[m.seedTier] ?? 0) + 1
    void savePouch(address)
    sendPouch(address)

    if (m.planters > 0) {
      const cap = await loadBoxCap(address)
      cap.cap = Math.max(cap.cap, BOX_CAP_DEFAULT) + m.planters
      void savePlayerJson(address, 'boxCap')
      await sendCollection(address)   // carries boxCap — the client's own planting gate
    }

    room.send('milestoneReached', { title: m.title, species: milestoneTarget(m), seedTier: m.seedTier, planters: m.planters }, { to: [address] })
    console.log(`[Server] ${address} reached Almanac milestone "${m.title}" (${milestoneTarget(m)} species) → tier-${m.seedTier} seed${m.planters > 0 ? ` + ${m.planters} planter` : ''}`)
  }
  if (changed) {
    almanacRanks.set(address.toLowerCase(), rec.claimed)
    void savePlayerJson(address, 'milestones')
    broadcastLeaderboard()   // the boards carry the title, so a new one lands straight away
  }
}

/** Record this species AT THIS RARITY as seen. No-op if they already had that pair. */
async function markDiscovered(address: string, flower: string, tier: number): Promise<void> {
  if (!address || !flower) return
  const key  = discoveredKey(flower, tier)
  const list = await loadDiscovered(address)
  if (list.includes(key)) return
  list.push(key)
  void savePlayerJson(address, 'discovered')
  await sendDiscovered(address)
}

async function sendCollection(address: string): Promise<void> {
  const flowers = await loadFlowers(address)
  const cap     = await planterCap(address)
  const free    = Math.max(0, avenueSlotCap() - avenueSlotsOwnedBy(address))
  room.send('collectionUpdate', { flowersJson: JSON.stringify(flowers), boxCap: cap, avenueSlotsFree: free }, { to: [address] })
}

// ── v2: held flower — one keepsake per gardener, shown in their hand to everyone.
// In memory only: an empty hand on rejoin is fine; the flower itself stays in the collection.
const heldFlowers = new Map<string, { flower: string; rarityTier: number }>()   // lowercase address →

/** ⚠️ Two key spaces meet here: player records are keyed by the address exactly as the
 *  room handed it over (mixed case), `heldFlowers` by the LOWERCASED address. Crossing
 *  them silently reports "no keepsake held" and wipes the player's held flower, so every
 *  lookup below goes through these two helpers rather than indexing a map directly. */
function pouchOf(address: string): SeedPouch | undefined {
  return playerRecords.get(recordKey(address, 'seeds'))?.value as SeedPouch | undefined
}

/** Seeds a gardener has EXPLICITLY equipped (lowercase key). An equip replaces whatever
 *  was in the hand, a keepsake included — so equipping one of these clears heldFlowers,
 *  and holding a keepsake clears this. The hand only ever holds one thing. */
const heldSeeds = new Map<string, number>()   // address → rarity tier

/** What goes in a gardener's hand, as a seed tier (-1 = no seed):
 *    1. nothing, if a keepsake is in the hand — a flower ALWAYS wins the hand
 *    2. a seed they explicitly equipped, while they still have one of that tier
 *    3. otherwise the rarest seed they hold — the pouch made visible by default
 *  The keepsake test is FIRST (KJ 2026-09-21: "when I hold a flower it should replace my
 *  seed — same hand, it's action based"). It used to sit after the equipped-seed branch,
 *  so an equipped seed short-circuited and both rendered at once. `holdFlower` clears the
 *  equipped seed itself, but GIFT RECEIPT puts a flower straight into `heldFlowers`, so
 *  the order here is what actually closes it. */
function handSeedTier(address: string): number {
  const key   = address.toLowerCase()
  const pouch = pouchOf(address)
  if (!pouch) return -1
  if (heldFlowers.has(key)) return -1
  const equipped = heldSeeds.get(key)
  if (equipped !== undefined) {
    if ((pouch[equipped] ?? 0) > 0) return equipped
    heldSeeds.delete(key)        // planted the last one of that tier — fall through
  }
  for (let tier = pouch.length - 1; tier >= 0; tier--) if ((pouch[tier] ?? 0) > 0) return tier
  return -1
}

/** Last seedTier broadcast per gardener (lowercase key) — a pouch changes on every single
 *  gather during a bloom, and only a CHANGE of the shown seed is worth a broadcast. */
const shownSeedTier = new Map<string, number>()

function sendHeld(address: string, to?: string[]): void {
  const key = address.toLowerCase()
  const h = heldFlowers.get(key)
  const seedTier = handSeedTier(address)
  shownSeedTier.set(key, seedTier)
  room.send('heldFlower', { address: key, flower: h?.flower ?? '', rarityTier: h?.rarityTier ?? 0, seedTier }, to ? { to } : undefined)
}

/** Broadcast the hand only when the seed it should show has actually changed. */
function refreshHandSeed(address: string): void {
  if (shownSeedTier.get(address.toLowerCase()) === handSeedTier(address)) return
  sendHeld(address)
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
  void markDiscovered(b.owner, b.flower, b.rarityTier)   // revealed — counts whether or not they harvest it
  void saveBoxes()
}

/** Schedule (or immediately fire) the open for a planted box. Safe to call on restart. */
function scheduleOpen(b: BoxRecord): void {
  if (!b.owner || b.opened) return
  const existing = boxTimers.get(b.boxId)
  if (existing) clearTimeout(existing)
  const delay = Math.max(0, b.opensAt - Date.now())
  boxTimers.set(b.boxId, setTimeout(() => executeTask(async () => openBox(b.boxId)), delay))
}

/** Load (or late-load) the planters. False when the read failed. A planter claimed
 *  this session keeps its claim over the stored record. A stored record whose planter
 *  is no longer in BOX_POSITIONS (planter editor bake) is tidied: contents go back to
 *  the owner with a 'kept safe' note. */
async function loadBoxes(): Promise<boolean> {
  const res = await loadScene<Array<Partial<BoxRecord> & { boxId: string }>>('boxes')
  if (!res.ok) { console.error('[Server] boxes: load failed — saves held until a reload succeeds'); return false }
  const orphaned: BoxRecord[] = []
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
      if (!live) {
        // Planter removed from the layout (planter editor bake) — contents go back to the owner
        if (r.owner) orphaned.push({ ...emptyBox(r.boxId), ...r, waterers: r.waterers ?? [] })
        continue
      }
      if (live.owner) continue   // claimed this session — memory wins
      const restored: BoxRecord = { ...emptyBox(r.boxId), ...r, waters: r.waters ?? 0, waterers: r.waterers ?? [], lastWaterer: r.lastWaterer ?? '' }
      boxes.set(r.boxId, restored)
      if (restored.owner) sendBox(restored)
    }
  }
  let growing = 0
  for (const b of boxes.values()) if (b.owner && !b.opened && !boxTimers.has(b.boxId)) { scheduleOpen(b); growing++ }
  console.log(`[Server] Boxes: ${boxes.size} total, ${[...boxes.values()].filter(b => b.owner).length} planted, ${growing} growing (timers rescheduled)`)
  boxesWriter.enable()
  for (const r of orphaned) await tidyPlanter(r)   // owners get a 'kept safe' note next visit
  if (orphaned.length > 0) console.log(`[Server] ${orphaned.length} planted planter(s) left the layout — contents returned`)
  return true
}

// ── Crowding rule (GDD §3.1) ─────────────────────────────────
// Keep PLANTER_RESERVE_FREE planters free so a newcomer always has one to tap. When fewer
// are free, tidy up the planter of the owner away longest (not connected, away at least
// PLANTER_TIDY_MIN_AWAY_MS): an opened flower goes to their My flowers, a growing seed back
// to their pouch — never lost — and they're told on their next visit.
const lastSeen = new Map<string, number>()   // lowercase address → ms of last join/leave

/** Load (or late-load) last-seen times. False when the read failed. A time recorded
 *  this session wins over the stored one. */
async function loadLastSeen(): Promise<boolean> {
  const res = await loadScene<Record<string, number>>('lastSeen')
  if (!res.ok) { console.error('[Server] lastSeen: load failed — saves held until a reload succeeds'); return false }
  if (res.value && typeof res.value === 'object') {
    for (const [a, t] of Object.entries(res.value)) if (!lastSeen.has(a)) lastSeen.set(a, Number(t) || 0)
  }
  lastSeenWriter.enable()
  return true
}
function markSeen(address: string): void {
  lastSeen.set(address.toLowerCase(), Date.now())
  const owners = [...[...boxes.values()].map(b => b.owner), ...[...avenue.values()].map(r => r.owner)].filter(Boolean)
  lastSeenWriter.save(lastSeenToStore(lastSeen, owners))
}
const loadKeptSafe = (a: string) => loadPlayerJson<string[]>(a, 'keptSafe', () => [])

/** Tidy one planter: its contents go back to the owner, the planter is freed. */
async function tidyPlanter(b: BoxRecord): Promise<void> {
  const owner = b.owner, tier = b.rarityTier, opened = b.opened, flower = b.flower
  if (!owner) return
  const timer = boxTimers.get(b.boxId)
  if (timer) { clearTimeout(timer); boxTimers.delete(b.boxId) }
  if (boxes.get(b.boxId) === b) {                             // not for a planter the layout dropped
    boxes.set(b.boxId, emptyBox(b.boxId))                     // free it before any await
    sendBox(boxes.get(b.boxId)!)
    void saveBoxes()
  }
  let note: string
  if (opened) {
    const flowers = await loadFlowers(owner)                   // past FLOWER_COLLECTION_CAP on purpose: never lost
    flowers.push({ flower, rarityTier: tier, at: Date.now(), ...provenanceOf(b) })
    void savePlayerJson(owner, 'flowers')
    note = `The garden got busy while you were away — your ${plantSpeciesById(flower)?.name ?? flower} was kept safe in My flowers`
  } else {
    const pouch = await loadPouch(owner)
    pouch[tier] = (pouch[tier] ?? 0) + 1
    void savePouch(owner)
    note = 'The garden got busy while you were away — your seed is back in your pouch'
  }
  console.log(`[Server] Tidied ${b.boxId} (owner ${owner.slice(0, 8)}…, ${opened ? `opened ${flower}` : 'growing'}, last seen ${lastSeen.get(owner.toLowerCase()) ? new Date(lastSeen.get(owner.toLowerCase())!).toISOString() : 'never'})`)
  if (isConnected(owner)) {                                    // only via the admin test path
    sendNotice(owner, note)
    void sendCollection(owner)
    sendPouch(owner)
  } else {
    (await loadKeptSafe(owner)).push(note)
    void savePlayerJson(owner, 'keptSafe')
  }
}

/** Longest-away owner's planter, or null. `force` (admin test) ignores presence + min-away. */
function tidyCandidate(force: boolean): BoxRecord | null {
  const now = Date.now()
  let best: BoxRecord | null = null, bestSeen = Infinity
  for (const b of boxes.values()) {
    if (!b.owner) continue
    if (!force && isConnected(b.owner)) continue
    const seen = lastSeen.get(b.owner.toLowerCase()) ?? 0      // never recorded = oldest
    if (!force && now - seen < PLANTER_TIDY_MIN_AWAY_MS) continue
    if (seen < bestSeen) { bestSeen = seen; best = b }
  }
  return best
}

let ensuringFree = false
async function ensureFreePlanters(): Promise<void> {
  if (ensuringFree) return
  ensuringFree = true
  try {
    let free = [...boxes.values()].filter(b => !b.owner).length
    while (free < PLANTER_RESERVE_FREE) {
      const b = tidyCandidate(false)
      if (!b) break
      await tidyPlanter(b)
      free++
    }
  } finally { ensuringFree = false }
}


// ── The Avenue (design/communal-planters.md, 2026-09-22) ─────
// Display-only slots on the entrance wall: a harvested keepsake moves out of My flowers
// into a slot and back again on recall or tidy. Nothing grows here, so there are no
// timers — state is one JSON list in world Storage 'avenue', same shape of code as boxes.
interface AvenueRecord {
  slotId:   string
  owner:    string          // address; '' = empty
  ownerName: string
  keepsake: FlowerKeepsake | null   // the flower itself, returned intact on recall/tidy
  since:    number          // epoch ms it went on show
  looks:    number
}
const avenue = new Map<string, AvenueRecord>()           // slotId → record
const avenueLooked = new Set<string>()                   // `${address}:${slotId}` — one look each per session

function emptySlot(slotId: string): AvenueRecord { return { slotId, owner: '', ownerName: '', keepsake: null, since: 0, looks: 0 } }

/** What a keepsake remembers about its planter — read at harvest/tidy while the box record exists. */
function provenanceOf(b: BoxRecord): Pick<FlowerKeepsake, 'grownBy' | 'plantedAt' | 'openedAt' | 'helpers'> {
  return {
    grownBy: b.ownerName, plantedAt: b.plantedAt, openedAt: b.opensAt,
    helpers: b.waterers.map(a => leaderboard.get(a)?.displayName ?? a.slice(0, 8) + '…'),
  }
}

function sendAvenue(r: AvenueRecord, to?: string[]): void {
  const k = r.keepsake
  room.send('avenueState', {
    slotId: r.slotId, owner: r.owner, ownerName: r.ownerName,
    flower: k?.flower ?? '', rarityTier: k?.rarityTier ?? 0, since: r.since,
    grownBy: k?.grownBy ?? '', openedAt: k?.openedAt ?? 0, helpersJson: JSON.stringify(k?.helpers ?? []), giftedBy: k?.from ?? '',
    looks: r.looks,
  }, to ? { to } : undefined)
}
function sendAllAvenue(to: string[]): void { for (const r of avenue.values()) sendAvenue(r, to) }

function saveAvenue(): void {
  avenueWriter.save([...avenue.values()])
}

/** Load (or late-load) the Avenue. False when the read failed. A slot claimed this
 *  session wins over the stored one; a stored slot no longer in the layout sends its
 *  flower home. */
async function loadAvenue(): Promise<boolean> {
  for (const p of AVENUE_POSITIONS) if (!avenue.has(p.id)) avenue.set(p.id, emptySlot(p.id))
  const res = await loadScene<Array<Partial<AvenueRecord> & { slotId: string }>>('avenue')
  if (!res.ok) { console.error('[Server] avenue: load failed — saves held until a reload succeeds'); return false }
  const orphaned: AvenueRecord[] = []
  const records = Array.isArray(res.value) ? res.value : []
  for (const r of records) {
    const rec = { ...emptySlot(r.slotId), ...r }
    const live = avenue.get(r.slotId)
    if (!live) { if (rec.owner) orphaned.push(rec); continue }   // slot left the layout → flower goes home
    if (live.owner) continue   // claimed this session — memory wins
    avenue.set(r.slotId, rec)
  }
  console.log(`[Server] Avenue: ${avenue.size} slots, ${[...avenue.values()].filter(r => r.owner).length} on show`)
  avenueWriter.enable()
  for (const r of orphaned) await returnAvenueFlower(r, 'tidy')
  if (orphaned.length > 0) { console.log(`[Server] ${orphaned.length} Avenue slot(s) left the layout — flowers returned`); saveAvenue() }
  return true
}

function avenueSlotsOwnedBy(address: string): number {
  let n = 0
  for (const r of avenue.values()) if (r.owner === address) n++
  return n
}

/** Give a slot's flower back to its owner (recall, tidy, or a slot dropped from the layout). */
async function returnAvenueFlower(r: AvenueRecord, why: 'recall' | 'tidy'): Promise<void> {
  const owner = r.owner, k = r.keepsake
  if (!owner || !k) return
  if (avenue.get(r.slotId) === r) { avenue.set(r.slotId, emptySlot(r.slotId)); sendAvenue(avenue.get(r.slotId)!); void saveAvenue() }
  const flowers = await loadFlowers(owner)                    // past FLOWER_COLLECTION_CAP on purpose: never lost
  flowers.push({ ...k, avenue: (k.avenue ?? 0) + 1 })
  void savePlayerJson(owner, 'flowers')
  const name = plantSpeciesById(k.flower)?.name ?? k.flower
  if (why === 'recall') { void sendCollection(owner); sendNotice(owner, `Your ${name} is back in My flowers`); return }
  const note = `The Avenue got busy while you were away — your ${name} was kept safe in My flowers (it keeps its Avenue mark)`
  console.log(`[Server] Avenue tidied ${r.slotId} (owner ${owner.slice(0, 8)}…, ${k.flower} tier ${k.rarityTier})`)
  if (isConnected(owner)) { sendNotice(owner, note); void sendCollection(owner) }
  else { (await loadKeptSafe(owner)).push(note); void savePlayerJson(owner, 'keptSafe') }
}

/** Crowding rule: the slot whose owner has been away longest — never a Mythic/Unique,
 *  never someone here now or away less than PLANTER_TIDY_MIN_AWAY_MS. */
function avenueTidyCandidate(): AvenueRecord | null {
  const now = Date.now()
  let best: AvenueRecord | null = null, bestSeen = Infinity
  for (const r of avenue.values()) {
    if (!r.owner || !r.keepsake) continue
    if (r.keepsake.rarityTier >= AVENUE_NEVER_TIDY_TIER) continue
    if (isConnected(r.owner)) continue
    const seen = lastSeen.get(r.owner.toLowerCase()) ?? 0
    if (now - seen < PLANTER_TIDY_MIN_AWAY_MS) continue
    if (seen < bestSeen) { best = r; bestSeen = seen }
  }
  return best
}

/** Joining owner: deliver any "kept safe" notes from while they were away. */
async function deliverKeptSafe(address: string): Promise<void> {
  const notes = await loadKeptSafe(address)
  if (notes.length === 0) return
  for (const n of notes) sendNotice(address, n)
  notes.length = 0
  void savePlayerJson(address, 'keptSafe')
}

/** Tally one gathered seed for the finale card. */
function countGatheredSeed(address: string, rarityTier: number): void {
  const key = address.toLowerCase()
  const t = cycleSeedsBy.get(key) ?? { seeds: 0, rares: 0 }
  t.seeds++
  if (rarityTier >= FINALE_RARE_TIER) t.rares++
  cycleSeedsBy.set(key, t)
}

/** The closing beat: what the garden just did, and what each gardener present did in it.
 *  Sent per player because the you* fields differ. Must run BEFORE the cycle counters
 *  are cleared. */
function sendBloomSummary(): void {
  let waters = 0, seeds = 0, rares = 0
  for (const n of cycleWatersBy.values()) waters += n
  for (const t of cycleSeedsBy.values()) { seeds += t.seeds; rares += t.rares }
  const gardeners = Math.max(1, cycleContributors.size)
  for (const address of new Set(playerAddresses.values())) {
    const key = address.toLowerCase()
    const mine = cycleSeedsBy.get(key)
    room.send('bloomSummary', {
      gardeners, waters, seeds, rares,
      youWaters: cycleWatersBy.get(key) ?? 0,
      youSeeds:  mine?.seeds ?? 0,
      youRares:  mine?.rares ?? 0,
    }, { to: [address] })
  }
  console.log(`[Server] Bloom finale: ${gardeners} gardener(s), ${waters} waters, ${seeds} seeds (${rares} rare+)`)
}

async function resetGarden(): Promise<void> {
  // Idempotent guard — ignore if bloom is no longer active (already reset)
  if (!bloomActive) return
  console.log('[Server] Resetting garden...')
  cancelBloomSustain()
  cancelSeedWaves()
  activeSeeds.clear()   // ungathered seeds die with the bloom — and a joiner must not be sent them
  cancelGoldenSeed()
  sendBloomSummary()          // must precede the clears below — it reads the cycle tallies
  cycleContributors.clear()   // the next bloom's length counts the next cycle's waterers
  cycleWatersBy.clear()
  cycleSeedsBy.clear()
  bloomActive    = false
  bloomStartedAt = null

  const now = Date.now()
  let kept = 0
  for (const [plantId, entity] of plantEntities) {
    const ps     = PlantSync.getMutable(entity)
    // Watered during the bloom and still fresh — it stays (2026-09-22). Only dry plants,
    // or ones whose expiry is due this very tick, go back to droopy.
    if (ps.isWatered && (plantExpiresAt.get(plantId) ?? 0) > now) { kept++; continue }
    ps.isWatered = false
    ps.wateredAt = 0
    wateredByMap.delete(plantId)
    wateredTierMap.delete(plantId)
    wateredAlmanacMap.delete(plantId)
    plantExpiresAt.delete(plantId)
    room.send('plantStateUpdate', { plantId, isWatered: false, wateredAt: 0, wateredBy: '', expiresInMs: 0, tier: 0, almanac: 0 })
  }

  room.send('bloomReset', {})
  // The garden may still be above threshold — hold the next trigger, then re-check once
  // the hold ends (nothing else calls checkBloomThreshold until the next water).
  bloomCooldownUntil = now + BLOOM_TRIGGER_COOLDOWN_MS
  setTimeout(() => executeTask(async () => { if (!bloomActive) checkBloomThreshold() }), BLOOM_TRIGGER_COOLDOWN_MS)
  console.log(`[Server] Garden reset complete — ${kept} watered plants kept, next bloom possible in ${BLOOM_TRIGGER_COOLDOWN_MS / 1000}s`)

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
    wateredAlmanacMap.delete(plantId)
      plantExpiresAt.delete(plantId)
      savePlantStates()
      room.send('plantStateUpdate', { plantId, isWatered: false, wateredAt: 0, wateredBy: '', expiresInMs: 0, tier: 0, almanac: 0 })
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
        for (const k of avenueLooked) if (k.startsWith(address.toLowerCase() + ':')) avenueLooked.delete(k)
        evictPlayerRecords(address)
        memoryOnlyPlayers.delete(address.toLowerCase())
        markSeen(address)
        void ensureFreePlanters()
        heldSeeds.delete(address.toLowerCase())
        shownSeedTier.delete(address.toLowerCase())
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
      const storable = isStorableAddress(address)
      if (!storable) {
        memoryOnlyPlayers.add(address.toLowerCase())
        console.error(`[Server] ${address}: not a storable address — this session's progress stays in memory`)
      }
      // Independent reads start together; onboarding's backfill reads the lifetime total, so it follows that
      // record. The sends below then await reads that are already cached or in flight.
      const lifetimeLoad = loadLifetimeRecord(address)
      void Promise.allSettled([
        loadPouch(address), loadFlowers(address), loadBoxCap(address), loadKeptSafe(address),
        loadMilestones(address), loadDiscovered(address), lifetimeLoad.then(() => loadOnboarding(address)),
      ])
      room.send('playerDailyState', dailyStatePayload(), { to: [address] })

      // Send current state of all plants so the client can restore visuals
      for (const [plantId, plantEntity] of plantEntities) {
        const ps = PlantSync.getOrNull(plantEntity)
        if (!ps) continue
        room.send('plantStateUpdate', { plantId, isWatered: ps.isWatered, wateredAt: Number(ps.wateredAt), wateredBy: wateredByMap.get(plantId) ?? '', expiresInMs: expiresInMs(plantId), tier: wateredTierMap.get(plantId) ?? 0, almanac: wateredAlmanacMap.get(plantId) ?? 0 }, { to: [address] })
      }

      await lifetimeLoad   // authoritative total before the board goes out
      broadcastLeaderboard([address])
      sendThreshold([address])
      await loadPouch(address)
      sendPouch(address)
      // Re-send bloom state to players who join while it is already active
      if (bloomActive) room.send('bloomTriggered', { scale: bloomScale, variant: bloomVariant, elapsedMs: bloomStartedAt ? Date.now() - bloomStartedAt : 0, durationMs: bloomDuration }, { to: [address] })
      for (const seed of remainingSeeds(address)) sendSeed(seed, [address])
    if (golden && !golden.gatheredBy.has(address)) sendGolden([address])
      for (const b of boxes.values()) sendBox(b, [address])
      await sendCollection(address)
      await sendDiscovered(address)
      await sendOnboarding(address)
      sendTributes([address])
      sendAllAvenue([address])
      sendAllHeld([address])
      markSeen(address)
      await deliverKeptSafe(address)
      if (!storable) sendNotice(address, "Your progress this visit can't be saved — your address could not be used for storage")
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

  // Tell any connected admin, once per key per session, that a save was refused; the log has the details.
  const reportedSaveProblems = new Set<string>()
  onSaveProblem((label) => {
    if (reportedSaveProblems.has(label)) return
    reportedSaveProblems.add(label)
    const text = `Storage: ${label} could not be saved (see server logs)`
    for (const address of new Set(playerAddresses.values())) if (isAdmin(address)) sendNotice(address, text)
  })

  // Create PlantSync component for every plant (server-side state tracking only)
  for (const name of PLANT_NAMES) {
    const entity = engine.getEntityOrNullByName(name)
    if (!entity) { console.log(`[Server] Plant entity not found: ${name}`); continue }
    PlantSync.create(entity, { isWatered: false, wateredAt: 0 })
    plantEntities.set(name, entity)
  }

  console.log(`[Server] ${plantEntities.size} plants registered`)

  for (const p of BOX_POSITIONS) boxes.set(p.id, emptyBox(p.id))
  for (const w of [planterDraftWriter, plantDraftWriter, tributeDraftWriter]) w.enable()   // admin overwrite targets; nothing to read first

  // Restore persisted state. Loads never throw; a key that could not be read starts
  // empty, keeps its saves held and is reloaded in the background until it can be
  // merged — so an outage at boot neither aborts server() nor lets the first save
  // overwrite good data. Tributes load with the boards: they seed lifetime totals
  // for founding honorees, so they must follow them.
  const loads: Array<[string, () => Promise<boolean>]> = [
    ['plants',      loadPlantStates],
    ['leaderboard', loadLeaderboard],
    ['boxes',       loadBoxes],
    ['avenue',      loadAvenue],
    ['lastSeen',    loadLastSeen],
  ]
  const outcomes = await Promise.all(loads.map(([, load]) => load()))
  loads.forEach(([label, load], i) => { if (!outcomes[i]) scheduleReload(label, load) })
  await ensureFreePlanters()
  setInterval(() => executeTask(ensureFreePlanters), 60 * 60 * 1000)   // owners age past the min-away while nobody joins
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

      // Watering DURING a bloom is allowed (2026-09-22): the garden keeps drying under the
      // spectacle and tending it is what fills the bloom's minutes.
      // Reject if already watered and not yet inside its expiry tell — prevents concurrent
      // double-water when two players click the same plant before either sees the other's
      // confirmation (isWatered is set synchronously before any await, so this is race-free).
      // Inside the tell window the water is a TOP-UP: full timer again, counts on the boards;
      // the old expiry timer bails on its own because wateredAt moves.
      if (ps.isWatered && expiresInMs(plantId) > EXPIRY_TELL_MS) {
        room.send('waterRejected', { plantId, reason: 'already_watered' }, { to: [playerAddress] })
        return
      }

      // ── All valid — water the plant ──────────────────────────
      const now      = Date.now()
      const watered  = PlantSync.getMutable(entity)
      watered.isWatered = true
      watered.wateredAt = now

      // Count on both boards: this week's (resets) and lifetime (flair source). The
      // record loads before the bump so a stored total is never overwritten by one
      // that started from the legacy floor.
      await loadLifetimeRecord(playerAddress)
      const tierBefore = tierOf(playerAddress)
      const cycleKey = playerAddress.toLowerCase()
      cycleContributors.add(cycleKey)
      cycleWatersBy.set(cycleKey, (cycleWatersBy.get(cycleKey) ?? 0) + 1)
      bumpWaterTotals(playerAddress)
      const tier = tierOf(playerAddress)

      const displayName = leaderboard.get(playerAddress)?.displayName ?? playerAddress.slice(0, 8) + '…'
      wateredByMap.set(plantId, displayName)
      wateredTierMap.set(plantId, tier)
      wateredAlmanacMap.set(plantId, almanacRankOf(playerAddress))

      savePlantStates()
      saveLeaderboard()
      void saveLifetimeFor(playerAddress)
      const expiresAt = armExpiry(plantId, entity, now)

      room.send('plantStateUpdate', { plantId, isWatered: true, wateredAt: now, wateredBy: displayName, expiresInMs: expiresAt - now, tier, almanac: almanacRankOf(playerAddress) })
      void markOnboarding(playerAddress, 'watered')
      if (tier > tierBefore) {
        sendNotice(playerAddress, flairTierMessage(tier, lifetime.get(playerAddress)?.total ?? 0))
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
    if (data.seedId.startsWith('golden_')) { await catchGolden(data.seedId, playerAddress); return }
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
    pouch[seed.rarityTier] = (pouch[seed.rarityTier] ?? 0) + 1     // synchronous on the shared live object
    countGatheredSeed(playerAddress, seed.rarityTier)
    void savePouch(playerAddress)      // serialized write-through, fail-open
    console.log(`[Server] ${displayName} gathered tier-${seed.rarityTier} seed ${seed.id} (pouch: ${pouch.join(',')})`)
    sendPouch(playerAddress)
    // Targeted, not broadcast — only the gatherer's client despawns it
    room.send('seedGathered', { seedId: seed.id, by: displayName, byAddress: playerAddress, rarityTier: seed.rarityTier }, { to: [playerAddress] })
  })

  /** Rainbow ("golden") seed: each player may catch it once and rolls their own tier by rollRainbowTier. */
  async function catchGolden(seedId: string, playerAddress: string): Promise<void> {
    if (!golden || golden.id !== seedId || Date.now() >= golden.endsAt) return
    if (golden.gatheredBy.has(playerAddress)) return
    golden.gatheredBy.add(playerAddress)                       // before any await — no double award
    const tier  = rollRainbowTier()
    const name  = leaderboard.get(playerAddress)?.displayName ?? playerAddress.slice(0, 8) + '…'
    const pouch = await loadPouch(playerAddress)
    pouch[tier] = (pouch[tier] ?? 0) + 1
    countGatheredSeed(playerAddress, tier)   // the rainbow seed counts on the finale card too
    void savePouch(playerAddress)
    sendPouch(playerAddress)
    console.log(`[Server] ${name} caught the rainbow seed → tier ${tier} (${golden.gatheredBy.size} caught so far)`)
    room.send('seedGathered', { seedId, by: name, byAddress: playerAddress, rarityTier: tier }, { to: [playerAddress] })
    room.send('notice', { text: `${name} caught the rainbow seed!` })   // everyone — a shared moment
  }

  // ── Message: adminSpawnSeed (test panel) ────────────────────
  onRoomMessage<{ x: number; z: number; rarityTier: number }>('adminSpawnSeed', async (data, address) => {
    if (!isAdmin(address)) { sendNotice(address, 'Test tools: admin wallet only'); return }
    // Gathering writes the tier into the pouch array; one past the last tier would leave holes the SDK refuses to store.
    if (!Number.isInteger(data.rarityTier) || data.rarityTier < 0 || data.rarityTier >= RARITY_TIER_COUNT) {
      sendNotice(address, `Test tools: rarity tier must be 0 to ${RARITY_TIER_COUNT - 1}`)
      return
    }
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
    const holder = reservationHolder(data.boxId)
    if (holder && holder !== playerAddress) {
      sendNotice(playerAddress, 'That planter is being saved for a new gardener — try another')
      return
    }
    const pouch = await loadPouch(playerAddress)
    const cap   = await planterCap(playerAddress)
    if (b.owner) { sendBox(b, [playerAddress]); return }          // re-check after the awaits
    if (boxesOwnedBy(playerAddress) >= cap) {
      sendNotice(playerAddress, `You're using all ${cap} of your planters — harvest one to plant again`)
      return
    }
    // Admin unlimited: a RANDOM tier every time (test a mixed garden) and no seed needed or used
    const unlimited = unlimitedPlanters.has(playerAddress)
    const tier = unlimited ? Math.floor(Math.random() * RARITY_TIER_COUNT) : data.rarityTier
    if (!unlimited && (pouch[tier] ?? 0) <= 0) { sendPouch(playerAddress); sendNotice(playerAddress, 'No seeds — catch some from a bloom'); return }
    // Consume the seed and claim the box synchronously — no await between check and claim
    if (!unlimited) pouch[tier] -= 1
    const now = Date.now()
    b.owner     = playerAddress
    markSeen(playerAddress)   // an owner's last-seen time is stored from the moment they own something
    b.ownerName = leaderboard.get(playerAddress)?.displayName ?? playerAddress.slice(0, 8) + '…'
    b.rarityTier = tier
    b.plantedAt = now
    b.opensAt   = now + growMsForTier(tier)
    b.opened    = false
    b.flower    = ''
    b.waters    = 0
    b.waterers  = []
    b.lastWaterer = ''
    scheduleOpen(b)
    console.log(`[Server] ${b.ownerName} planted a tier-${tier} seed in ${b.boxId} (opens in ${formatGrowTime(growMsForTier(tier))})`)
    sendBox(b)
    sendPouch(playerAddress)
    void savePouch(playerAddress)
    void saveBoxes()
    clearReservation(playerAddress)
    void markOnboarding(playerAddress, 'planted')
    void ensureFreePlanters()   // this planting may have used up the reserve
  })

  // ── Message: reserveBox (v2 onboarding, Phase 2) ────────────
  onRoomMessage<{ boxId: string }>('reserveBox', async (data, playerAddress) => {
    const refuse = () => room.send('boxReserved', { boxId: '', expiresAt: 0 }, { to: [playerAddress] })
    const o = await loadOnboarding(playerAddress)
    if (o.planted) { refuse(); return }                       // tutorial is over for them
    const b = boxes.get(data.boxId)
    if (!b || b.owner) { refuse(); return }
    const holder = reservationHolder(data.boxId)
    if (holder && holder !== playerAddress) { refuse(); return }
    // Never hold the last free planter: with a full garden that would block a real
    // gardener outright, and the crowding rule only frees one once someone plants.
    const free = [...boxes.values()].filter(x => !x.owner && !reservationHolder(x.boxId)).length
    if (free <= 1 && holder !== playerAddress) { refuse(); return }
    const expiresAt = Date.now() + PLANTER_RESERVE_TTL_MS
    planterReservations.set(playerAddress, { boxId: data.boxId, expiresAt })
    room.send('boxReserved', { boxId: data.boxId, expiresAt }, { to: [playerAddress] })
    console.log(`[Server] ${data.boxId} held for ${playerAddress.slice(0, 8)}… (tutorial)`)
  })

  // ── Message: harvestBox (Phase 4) ───────────────────────────
  onRoomMessage<{ boxId: string }>('harvestBox', async (data, playerAddress) => {
    const b = boxes.get(data.boxId)
    if (!b || b.owner !== playerAddress) return
    if (!b.opened) { sendNotice(playerAddress, 'Still growing — come back when it opens'); return }
    const flowers = await loadFlowers(playerAddress)
    if (!b.opened || b.owner !== playerAddress) return           // re-check after the await
    if (flowers.length >= FLOWER_COLLECTION_CAP) { sendNotice(playerAddress, `Your collection holds ${FLOWER_COLLECTION_CAP} flowers — gift one to make room`); return }
    const keepsake: FlowerKeepsake = { flower: b.flower, rarityTier: b.rarityTier, at: Date.now(), ...provenanceOf(b) }
    flowers.push(keepsake)
    const name = b.ownerName
    boxes.set(b.boxId, emptyBox(b.boxId))                        // frees the box
    console.log(`[Server] ${name} harvested ${keepsake.flower} (tier ${keepsake.rarityTier}) from ${b.boxId} (collection ${flowers.length})`)
    sendBox(boxes.get(b.boxId)!)
    void saveBoxes()
    void savePlayerJson(playerAddress, 'flowers')
    void sendCollection(playerAddress)
    void markOnboarding(playerAddress, 'harvested')
    sendNotice(playerAddress, `Harvested your ${plantSpeciesById(keepsake.flower)?.name ?? keepsake.flower} — your planter is free again`)
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
    b.opensAt = Math.max(Date.now(), b.opensAt - growShaveMsForTier(b.rarityTier))
    scheduleOpen(b)
    console.log(`[Server] ${name} watered ${b.ownerName}'s ${b.boxId} (${b.waters}/${BOX_WATER_MAX}, −${Math.round(growShaveMsForTier(b.rarityTier) / 1000)}s)`)
    sendBox(b)
    void saveBoxes()
    const left = BOX_WATER_MAX - b.waters
    sendNotice(playerAddress, `You watered ${b.ownerName}'s seed — ${shaveText(growShaveMsForTier(b.rarityTier))} sooner${left > 0 ? `, ${left} more water${left === 1 ? '' : 's'} can help it` : ', and that is all it can take'}`)
    if (isConnected(b.owner)) sendNotice(b.owner, `${name} watered your seed`)
  })

  // ── Message: giftFlower (Phase 4 — keepsakes) ───────────────
  onRoomMessage<{ toAddress: string; flowerIndex: number }>('giftFlower', async (data, playerAddress) => {
    const to = (data.toAddress || '').toLowerCase()
    if (!to || to === playerAddress) return
    if (!isConnected(to)) { sendNotice(playerAddress, 'That player is not here'); return }
    const mine   = await loadFlowers(playerAddress)
    const theirs = await loadFlowers(to)
    const idx = Math.floor(data.flowerIndex)
    if (idx < 0 || idx >= mine.length) { sendNotice(playerAddress, 'You have no flower to give'); return }
    if (theirs.length >= FLOWER_COLLECTION_CAP) { sendNotice(playerAddress, `Their collection already holds ${FLOWER_COLLECTION_CAP} flowers`); return }
    const fromName = leaderboard.get(playerAddress)?.displayName ?? playerAddress.slice(0, 8) + '…'
    const toName   = leaderboard.get(to)?.displayName ?? to.slice(0, 8) + '…'
    const [gift] = mine.splice(idx, 1)
    // Hand to hand (KJ 2026-09-18): gifting the kind you're holding empties your hand, and
    // the receiver now holds the gift — everyone sees it change hands.
    const held = heldFlowers.get(playerAddress.toLowerCase())
    if (held && held.flower === gift.flower && held.rarityTier === gift.rarityTier) clearHeld(playerAddress.toLowerCase())
    heldSeeds.delete(to)        // the gift takes the hand — same rule as holdFlower
    heldFlowers.set(to, { flower: gift.flower, rarityTier: gift.rarityTier })
    sendHeld(to)
    theirs.push({ ...gift, from: fromName, at: Date.now() })
    console.log(`[Server] ${fromName} gifted ${gift.flower} (tier ${gift.rarityTier}) to ${toName}`)
    void savePlayerJson(playerAddress, 'flowers')
    void savePlayerJson(to, 'flowers')
    void sendCollection(playerAddress)
    void sendCollection(to)
    void markDiscovered(to, gift.flower, gift.rarityTier)   // a gift is a first sighting for the receiver
    room.send('giftReceived', { from: fromName, flower: gift.flower, rarityTier: gift.rarityTier }, { to: [to] })
    void markOnboarding(playerAddress, 'gifted')
    sendNotice(playerAddress, `You gave your ${plantSpeciesById(gift.flower)?.name ?? gift.flower} to ${toName}`)
  })

  // ── The Avenue: display / recall / inspect ───────────────────
  onRoomMessage<{ slotId: string; flowerIndex: number }>('displayFlower', async (data, playerAddress) => {
    if (avenue.size === 0) { sendNotice(playerAddress, 'The Avenue is not open yet'); return }
    const cap = avenueSlotCap()   // every slot when AVENUE_SLOT_CAP is 0 — then only a full wall stops you
    if (avenueSlotsOwnedBy(playerAddress) >= cap) { sendNotice(playerAddress, cap === 1 ? 'You already have a flower on the Avenue — take it back first' : `You already have ${cap} flowers on the Avenue`); return }
    const flowers = await loadFlowers(playerAddress)
    const idx = Math.floor(data.flowerIndex)
    const f = flowers[idx]
    if (!f) { sendNotice(playerAddress, 'You no longer have that flower'); return }
    if (f.rarityTier < AVENUE_MIN_TIER) { sendNotice(playerAddress, `The Avenue is for ${rarityTierById(AVENUE_MIN_TIER).name} flowers and up`); return }
    let slot = data.slotId ? avenue.get(data.slotId) : undefined
    if (slot && slot.owner) { sendNotice(playerAddress, `${slot.ownerName}'s flower is on show there`); return }
    if (!slot) slot = [...avenue.values()].find(r => !r.owner)
    if (!slot) {
      const victim = avenueTidyCandidate()
      if (!victim) { sendNotice(playerAddress, 'The Avenue is full right now — try again later'); return }
      await returnAvenueFlower(victim, 'tidy')
      slot = avenue.get(victim.slotId)!
    }
    if (slot.owner || flowers[idx] !== f) return                  // re-check after the awaits
    flowers.splice(idx, 1)
    const name = leaderboard.get(playerAddress)?.displayName ?? playerAddress.slice(0, 8) + '…'
    avenue.set(slot.slotId, { slotId: slot.slotId, owner: playerAddress, ownerName: name, keepsake: f, since: Date.now(), looks: 0 })
    markSeen(playerAddress)
    const held = heldFlowers.get(playerAddress.toLowerCase())
    if (held && held.flower === f.flower && held.rarityTier === f.rarityTier) clearHeld(playerAddress.toLowerCase())
    console.log(`[Server] ${name} put ${f.flower} (tier ${f.rarityTier}) on the Avenue at ${slot.slotId}`)
    sendAvenue(avenue.get(slot.slotId)!)
    void saveAvenue()
    void savePlayerJson(playerAddress, 'flowers')
    void sendCollection(playerAddress)
    void markOnboarding(playerAddress, 'avenueUsed')
    sendNotice(playerAddress, `Your ${plantSpeciesById(f.flower)?.name ?? f.flower} is on the Avenue with your name on it`)
  })

  onRoomMessage<{ slotId: string }>('recallFlower', async (data, playerAddress) => {
    const r = avenue.get(data.slotId)
    if (!r || r.owner !== playerAddress) return
    await returnAvenueFlower(r, 'recall')
  })

  onRoomMessage<{ slotId: string }>('inspectAvenue', async (data, playerAddress) => {
    const r = avenue.get(data.slotId)
    if (!r || !r.owner) return
    const key = `${playerAddress.toLowerCase()}:${r.slotId}`
    if (avenueLooked.has(key)) return
    avenueLooked.add(key)
    r.looks += 1
    sendAvenue(r)
    void saveAvenue()
  })

  // ── Message: adminFillAvenue (test panel) — populate empty slots with real, persisted
  // Rare+ flowers so the Avenue can be playtested without a genuine harvest chain ──
  onRoomMessage<{ count: number }>('adminFillAvenue', async (data, address) => {
    if (!isAdmin(address)) { sendNotice(address, 'Test tools: admin wallet only'); return }
    if (avenue.size === 0) { sendNotice(address, 'The Avenue is not open yet'); return }
    const empties = [...avenue.values()].filter(r => !r.owner)
    const n = Math.max(1, Math.min(empties.length, Math.floor(data?.count) || 8))
    const name = leaderboard.get(address)?.displayName ?? address.slice(0, 8) + '…'
    for (let i = 0; i < n; i++) {
      const slot = empties[i]
      const flower: FlowerKeepsake = {
        flower: rollPlantSpecies(), rarityTier: rollTierAtLeast(AVENUE_MIN_TIER), at: Date.now(),
        grownBy: name, plantedAt: Date.now(), openedAt: Date.now(), helpers: [],
      }
      avenue.set(slot.slotId, { slotId: slot.slotId, owner: address, ownerName: name, keepsake: flower, since: Date.now(), looks: 0 })
      sendAvenue(avenue.get(slot.slotId)!)
    }
    markSeen(address)
    void saveAvenue()
    console.log(`[Server] [Test] filled ${n} Avenue slot(s) for ${address}`)
  })

  // ── Message: adminClearAvenue (test panel) — empty every slot the admin filled ──
  onRoomMessage<Record<string, never>>('adminClearAvenue', async (_data, address) => {
    if (!isAdmin(address)) { sendNotice(address, 'Test tools: admin wallet only'); return }
    const mine = [...avenue.values()].filter(r => r.owner === address)
    if (mine.length === 0) { sendNotice(address, 'You have no Avenue slots to clear'); return }
    for (const r of mine) { avenue.set(r.slotId, emptySlot(r.slotId)); sendAvenue(avenue.get(r.slotId)!) }
    void saveAvenue()
    console.log(`[Server] [Test] cleared ${mine.length} Avenue slot(s) for ${address}`)
  })

  // ── Message: holdFlower — show one of your keepsakes in your hand (-1 = put away) ──
  onRoomMessage<{ flowerIndex: number }>('holdFlower', async (data, playerAddress) => {
    const a   = playerAddress.toLowerCase()
    const idx = Math.floor(data.flowerIndex)
    if (idx < 0) { clearHeld(a); return }
    const f = (await loadFlowers(playerAddress))[idx]
    if (!f) { sendNotice(playerAddress, 'You no longer have that flower'); return }
    heldSeeds.delete(a)          // a keepsake replaces an equipped seed — one thing per hand
    heldFlowers.set(a, { flower: f.flower, rarityTier: f.rarityTier })
    sendHeld(a)
  })

  // ── Message: holdSeed — equip a seed, replacing whatever is in the hand ──
  onRoomMessage<{ rarityTier: number }>('holdSeed', async (data, playerAddress) => {
    const a    = playerAddress.toLowerCase()
    const tier = Math.floor(data.rarityTier)
    if (tier < 0) { heldSeeds.delete(a); sendHeld(a); return }
    const pouch = await loadPouch(playerAddress)
    if ((pouch[tier] ?? 0) <= 0) { sendNotice(playerAddress, 'You have no seed of that kind'); return }
    heldSeeds.set(a, tier)
    heldFlowers.delete(a)   // not clearHeld(): that broadcasts too, and one send is enough
    sendHeld(a)
    console.log(`[Server] ${playerAddress.slice(0, 8)}… equipped a tier-${tier} seed`)
  })

  // ── Message: forceBloom ─────────────────────────────────────
  onRoomMessage<{ variant: string }>('forceBloom', async (data, address) => {
    console.log(`[Server] forceBloom from ${address} (admin=${isAdmin(address)}, bloomActive=${bloomActive})`)
    if (!isAdmin(address)) { sendNotice(address, 'Test tools: admin wallet only'); return }
    // triggerBloom() no-ops while a bloom is already running, and used to do it silently —
    // so a bloom left active by an interrupted reset made the button dead forever.
    if (bloomActive) { sendNotice(address, 'A bloom is already running — use Reset bloom first'); return }
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

  // ── Message: adminUnlimitedPlanters (test panel) — no planter cap, seeds not consumed ──
  onRoomMessage<{ on: boolean }>('adminUnlimitedPlanters', async (data, address) => {
    if (!isAdmin(address)) { sendNotice(address, 'Test tools: admin wallet only'); return }
    if (data.on) unlimitedPlanters.add(address); else unlimitedPlanters.delete(address)
    await sendCollection(address)   // pushes the new cap to the client's own gate
    sendNotice(address, data.on ? 'Unlimited planters ON — plant anywhere, random tier, no seeds used' : 'Unlimited planters OFF')
    console.log(`[Server] Admin unlimited planters ${data.on ? 'ON' : 'OFF'} for ${address}`)
  })

  // ── Message: adminTidyPlanter (test panel) — run the crowding rule once, now ──
  onRoomMessage<Record<string, never>>('adminTidyPlanter', async (_data, address) => {
    if (!isAdmin(address)) { sendNotice(address, 'Test tools: admin wallet only'); return }
    const b = tidyCandidate(true)
    if (!b) { sendNotice(address, 'No planted planters to tidy'); return }
    await tidyPlanter(b)
  })

  // ── Message: adminPlantDraft (plant layout editor) — save / load the draft ──
  // The console block below is what gets baked into shared/layout.ts PLANT_LAYOUT.
  onRoomMessage<{ json: string }>('adminPlantDraft', async (data, address) => {
    if (!isAdmin(address)) { sendNotice(address, 'Test tools: admin wallet only'); return }
    if (!data.json) {
      let saved = ''
      saved = draftText(await loadScene<unknown>('plantDraft'))
      room.send('plantDraft', { json: saved }, { to: [address] })
      return
    }
    try {
      const map = JSON.parse(data.json) as Record<string, { x: number; y: number; z: number; rotY: number; scale: number }>
      const names = Object.keys(map)
      if (typeof map !== 'object' || names.length === 0 || names.length > 300) throw new Error('not a map of 1..300 plants')
      plantDraftWriter.save(data.json)
      const ts = names.map(n => `  '${n}': { x: ${map[n].x}, y: ${map[n].y}, z: ${map[n].z}, rotY: ${map[n].rotY}, scale: ${map[n].scale} },`).join('\n')
      console.log(`[Server] Plant draft saved: ${names.length} plants — bake into shared/layout.ts PLANT_LAYOUT:\n${ts}`)
      room.send('plantDraft', { json: data.json }, { to: [address] })   // ack — the client warns without it
    } catch (err) {
      sendNotice(address, 'Plant draft rejected')
      console.error('[Server] adminPlantDraft rejected:', err)
    }
  })

  // ── Message: adminTributeDraft (tribute plot editor) — save / load the draft ──
  // Baked into TRIBUTE_HERO_PLOTS by hand afterwards; this Storage copy only survives
  // restarts. The console line below is the one that actually gets baked.
  onRoomMessage<{ json: string }>('adminTributeDraft', async (data, address) => {
    if (!isAdmin(address)) { sendNotice(address, 'Test tools: admin wallet only'); return }
    if (!data.json) {
      let saved = ''
      saved = draftText(await loadScene<unknown>('tributeDraft'))
      room.send('tributeDraft', { json: saved }, { to: [address] })
      return
    }
    try {
      const list = JSON.parse(data.json)
      if (!Array.isArray(list) || list.length > 100) throw new Error('not a list of ≤ 100 plots')
      tributeDraftWriter.save(data.json)
      const ts = list.map((p: { x: number; z: number; rot: number }) => `  { x: ${p.x}, z: ${p.z}, rot: ${p.rot} },`).join('\n')
      console.log(`[Server] Tribute draft saved: ${list.length} plots — bake into TRIBUTE_HERO_PLOTS:\n${ts}`)
    } catch (err) {
      sendNotice(address, 'Tribute draft rejected')
      console.error('[Server] adminTributeDraft rejected:', err)
    }
  })

  // ── Message: adminPlanterDraft (planter layout tool) — save / load the draft layout ──
  // Baked into BOX_POSITIONS by hand afterwards; this Storage copy only survives restarts.
  onRoomMessage<{ json: string }>('adminPlanterDraft', async (data, address) => {
    if (!isAdmin(address)) { sendNotice(address, 'Test tools: admin wallet only'); return }
    if (!data.json) {
      const saved = draftText(await loadScene<unknown>('planterDraft'))
      room.send('planterDraft', { json: saved }, { to: [address] })
      return
    }
    try {
      const list = JSON.parse(data.json)
      if (!Array.isArray(list) || list.length > 300) throw new Error('not a list of ≤ 300 planters')
      planterDraftWriter.save(data.json)
      console.log(`[Server] Planter draft saved: ${list.length} planters`)
    } catch (err) {
      sendNotice(address, 'Planter draft not saved — bad data')
      console.error('[Server] adminPlanterDraft rejected:', err)
    }
  })

  // ── Message: adminGrantWaters (test panel) — exercise flair tiers + tribute grant ──
  onRoomMessage<{ amount: number }>('adminGrantWaters', async (data, address) => {
    if (!isAdmin(address)) { sendNotice(address, 'Test tools: admin wallet only'); return }
    const amount = Math.max(1, Math.min(1000, Math.floor(data?.amount ?? 0)))
    await loadLifetimeRecord(address)
    const tierBefore = tierOf(address)
    for (let i = 0; i < amount; i++) bumpWaterTotals(address)
    const tier = tierOf(address)
    saveLeaderboard()
    await saveLifetimeFor(address)
    broadcastLeaderboard()
    const total = lifetime.get(address)?.total ?? 0
    console.log(`[Server] [Test] granted ${amount} waters to ${address} → lifetime ${total}, tier ${tierBefore}→${tier}`)
    sendNotice(address, tier > tierBefore
      ? flairTierMessage(tier, total)
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
        room.send('plantStateUpdate', { plantId, isWatered: true, wateredAt: now, wateredBy: '[Test Mode]', expiresInMs: expiresAt - now, tier: 0, almanac: 0 })
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
      room.send('plantStateUpdate', { plantId, isWatered: ps.isWatered, wateredAt: Number(ps.wateredAt), wateredBy: wateredByMap.get(plantId) ?? '', expiresInMs: expiresInMs(plantId), tier: wateredTierMap.get(plantId) ?? 0, almanac: wateredAlmanacMap.get(plantId) ?? 0 }, { to: [address] })
    }
    await loadLifetimeRecord(address)
    broadcastLeaderboard([address])
    sendThreshold([address])
    await loadPouch(address)
    sendPouch(address)
    if (bloomActive) room.send('bloomTriggered', { scale: bloomScale, variant: bloomVariant, elapsedMs: bloomStartedAt ? Date.now() - bloomStartedAt : 0, durationMs: bloomDuration }, { to: [address] })
    for (const seed of remainingSeeds(address)) sendSeed(seed, [address])
    if (golden && !golden.gatheredBy.has(address)) sendGolden([address])
    for (const b of boxes.values()) sendBox(b, [address])
    await sendCollection(address)
    await sendDiscovered(address)
    await sendOnboarding(address)
    sendTributes([address])
    sendAllAvenue([address])
    sendAllHeld([address])
    console.log(`[Server] Full sync sent to ${address} (${getWateredCount()}/${currentBloomThreshold()} watered)`)
  })

  // ── Message: markPouchOpened ─────────────────────────────────
  onRoomMessage<Record<string, never>>('markPouchOpened', async (_data, address) => {
    await markOnboarding(address, 'pouchOpened')
  })

  // ── Message: adminResetOnboarding (test panel) ───────────────
  onRoomMessage<Record<string, never>>('adminResetOnboarding', async (_data, address) => {
    if (!isAdmin(address)) { sendNotice(address, 'Test tools: admin wallet only'); return }
    const o = await loadOnboarding(address)
    o.watered = o.planted = o.harvested = o.gifted = o.pouchOpened = false
    await savePlayerJson(address, 'onboarding')
    await sendOnboarding(address)
    sendNotice(address, 'Onboarding reset — the tutorial will replay from the first water')
    console.log(`[Server] Onboarding reset for ${address}`)
  })

  // ── Message: registerPlayer ──────────────────────────────────
  onRoomMessage<{ displayName: string }>('registerPlayer', async (data, address) => {
    await loadLifetimeRecord(address)
    for (const board of [leaderboard, lifetime]) {
      const entry = board.get(address)
      if (entry) entry.displayName = data.displayName
      else board.set(address, { displayName: data.displayName, total: 0 })
    }
    saveLeaderboard()
    await saveLifetimeFor(address)
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
