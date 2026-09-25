// =============================================================
// The Living Garden — Shared Message Definitions
// Imported by both server and client.
//
// Registry ORDER does NOT matter for delivery (event types travel as strings —
// see @dcl/sdk/src/network/events/protocol.ts). A 2026-09-16 "position cutoff"
// theory was WRONG: the real cause of undelivered seed messages was
// wateringSystem.ts calling room.clear() AFTER setupSeedSystem() had registered
// its listeners. If a handler never fires, check WHEN it was registered relative
// to room.clear() before suspecting the transport.
//
// ⚠️ Never put a 13-digit Date.now() in a Schemas.Number message field —
// float32 rounds it by up to ~131 s (this broke clockSync, ±50 s offsets).
// Use Schemas.Int64 for epoch-ms, matching PlantSync.wateredAt in schemas.ts.
// =============================================================

import { Schemas } from '@dcl/sdk/ecs'
import { registerMessages } from '@dcl/sdk/network'

export const room = registerMessages({
  // ── v2: bloom seeds ──────────────────────────────────────
  // rarityTier (0=Common..7=Unique, RARITY_TIERS in shared/config) replaced the old
  // rare:boolean 2026-09-18 — KJ's 8-tier expansion, following DCL wearable rarity
  // conventions. Species stays the harvest-time mystery (unknown until a box opens),
  // same as before — a seed/pouch entry only ever carries its rarity tier, never a
  // species id. NOT the same "tier" as plantStateUpdate's tier below (that one is the
  // lifetime-waters flair tier) — kept the distinct name on purpose to avoid confusion.
  seedSpawned:      Schemas.Map({ id: Schemas.String, x: Schemas.Number, z: Schemas.Number, rarityTier: Schemas.Number, spawnedAt: Schemas.Int64 }),
  seedGathered:     Schemas.Map({ seedId: Schemas.String, by: Schemas.String, byAddress: Schemas.String, rarityTier: Schemas.Number }),
  gatherSeed:       Schemas.Map({ seedId: Schemas.String }),
  /** Test-panel only: spawn one seed near x,z through the real seedSpawned path. */
  adminSpawnSeed:   Schemas.Map({ x: Schemas.Number, z: Schemas.Number, rarityTier: Schemas.Number }),
  /** Server → gatherer: the player's live seed pouch (after each gather, and on join).
   *  countsJson = JSON number[8], one count per rarity tier (index = tier id). */
  pouchUpdate:      Schemas.Map({ countsJson: Schemas.String }),
  /** Server → all (and joiners): this bloom's golden seed. Position is computed on each
   *  client from goldenSeedPos((now − spawnedAt), pathSeed); caught via gatherSeed with
   *  its id. Timestamps are Int64 — Schemas.Number corrupts 13-digit ms values. */
  goldenSeed:       Schemas.Map({ id: Schemas.String, pathSeed: Schemas.Number, spawnedAt: Schemas.Int64, endsAt: Schemas.Int64, serverNow: Schemas.Int64 }),

  // ── v2: seed boxes ───────────────────────────────────────
  /** Player taps an empty box to plant a seed from their pouch (rarityTier = which one). */
  plantSeed:        Schemas.Map({ boxId: Schemas.String, rarityTier: Schemas.Number }),
  /** One box's state — broadcast on change, sent per box to a joining/resyncing player.
   *  serverNow lets the client derive the countdown without trusting clockSync.
   *  owner '' = empty box. flower '' = species not yet revealed (box unopened) — the
   *  field name is unchanged but now holds a PLANT_SPECIES id, not a flat name.
   *  Timestamps are epoch ms (Int64). */
  boxState:         Schemas.Map({
    boxId: Schemas.String, owner: Schemas.String, ownerName: Schemas.String, rarityTier: Schemas.Number,
    plantedAt: Schemas.Int64, opensAt: Schemas.Int64, serverNow: Schemas.Int64,
    opened: Schemas.Boolean, flower: Schemas.String,
    waters: Schemas.Number, lastWaterer: Schemas.String,
    tends: Schemas.Number,   // how many times the OWNER has tended this seedling (one per growth stage)
  }),

  // ── v2 Phase 4: harvest / water / gift ───────────────────
  /** Owner taps their OPENED box: flower → their collection, box freed. */
  harvestBox:       Schemas.Map({ boxId: Schemas.String }),
  /** Visitor taps someone else's GROWING box: shaves BOX_WATER_SHAVE_MS (capped, once per visitor). */
  waterBox:         Schemas.Map({ boxId: Schemas.String }),
  /** Owner taps their own GROWING box when it shows a water drop: shaves TEND_SHAVE_FRACTION, once per growth stage. */
  tendBox:          Schemas.Map({ boxId: Schemas.String }),
  /** Tap a nearby player: give them one flower from your collection (by index). */
  giftFlower:       Schemas.Map({ toAddress: Schemas.String, flowerIndex: Schemas.Number }),
  /** Server → player: their keepsake collection + box cap (after harvest/gift, and on join). */
  /** avenueSlotsFree: how many MORE flowers this gardener could put on the Avenue right
   *  now (slots their flair has earned, minus slots they're already using) — lets the
   *  client onboarding hint know when to point at the Avenue without a extra round trip. */
  collectionUpdate: Schemas.Map({ flowersJson: Schemas.String, boxCap: Schemas.Number, avenueSlotsFree: Schemas.Number }),
  /** Hold one keepsake in your hand (by collection index), or -1 to put it away. */
  holdFlower:       Schemas.Map({ flowerIndex: Schemas.Number }),
  /** Equip a seed of this rarity tier into your hand, REPLACING whatever was there —
   *  a held keepsake included. -1 goes back to the default (the rarest seed you hold,
   *  shown only when your hands are otherwise free). */
  holdSeed:         Schemas.Map({ rarityTier: Schemas.Number }),
  /** Server → everyone: what a gardener holds (flower '' = empty hand). Also sent per holder on join.
   *  seedTier (v2): the rarest seed in their pouch, shown in the SAME hand when they hold no
   *  keepsake — a keepsake always wins, so the two can never collide. -1 = no seed to show. */
  heldFlower:       Schemas.Map({ address: Schemas.String, flower: Schemas.String, rarityTier: Schemas.Number, seedTier: Schemas.Number }),
  /** Server → receiver of a gift. */
  giftReceived:     Schemas.Map({ from: Schemas.String, flower: Schemas.String, rarityTier: Schemas.Number }),
  /** Server → player: short feedback toast (rejections and confirmations). Broadcast when untargeted. */
  notice:           Schemas.Map({ text: Schemas.String }),
  /** Server → all / joining player: every tribute plant (Phase 5b). json = TributeRecord[]. */
  tributesUpdate:   Schemas.Map({ json: Schemas.String }),

  // ── The Avenue (design/communal-planters.md) ─────────────
  /** One Avenue slot's state — broadcast on change, sent per slot on join/full sync.
   *  owner '' = empty. grownBy/openedAt/helpersJson/giftedBy are the flower's provenance,
   *  carried on the keepsake since harvest (helpersJson = JSON string[] of display names).
   *  looks = how many gardeners have stopped to inspect it. */
  avenueState:      Schemas.Map({
    slotId: Schemas.String, owner: Schemas.String, ownerName: Schemas.String,
    flower: Schemas.String, rarityTier: Schemas.Number, since: Schemas.Int64,
    grownBy: Schemas.String, openedAt: Schemas.Int64, helpersJson: Schemas.String, giftedBy: Schemas.String,
    looks: Schemas.Number,
  }),
  /** Put one of my keepsakes (by collection index) on the Avenue. slotId '' = the server
   *  picks the first free slot — and when none is free, tidies the longest-away owner's. */
  displayFlower:    Schemas.Map({ slotId: Schemas.String, flowerIndex: Schemas.Number }),
  /** Take my flower back off the Avenue into My flowers. */
  recallFlower:     Schemas.Map({ slotId: Schemas.String }),
  /** I opened this slot's inspect card — counts one look per gardener per slot per session. */
  inspectAvenue:    Schemas.Map({ slotId: Schemas.String }),

  // ── v2: onboarding ───────────────────────────────────────
  /** Server → player: which of the two onboarding firsts this gardener has already
   *  done. Persisted per wallet (player Storage 'onboarding'), so the lesson never
   *  replays for someone who has done it — and a gardener who watered last visit but
   *  never got as far as planting still gets the planting half next time.
   *  Sent on full sync and again after each first. */
  onboardingState:  Schemas.Map({ watered: Schemas.Boolean, planted: Schemas.Boolean, harvested: Schemas.Boolean, gifted: Schemas.Boolean, pouchOpened: Schemas.Boolean, avenueUsed: Schemas.Boolean }),
  /** Client → server: I opened the seed pouch for the first time. Ends the tutorial stage
   *  that pulses the chip (Fin 2026-09-21 never noticed the pouch existed). */
  markPouchOpened:  Schemas.Map({}),
  /** Server → one player: every species they have ever REVEALED, as a JSON string[] of
   *  species ids. The Almanac's source of truth, deliberately separate from `flowers`:
   *  a flower left on show in its planter (GDD 3.1) is discovered but not kept. */
  discoveredUpdate: Schemas.Map({ listJson: Schemas.String }),
  /** Server → one player: an Almanac milestone just paid out. Celebration only — the
   *  client DERIVES which rungs are earned from the species count it already has, so
   *  nothing here needs re-sending on join. */
  milestoneReached: Schemas.Map({ title: Schemas.String, species: Schemas.Number, stamps: Schemas.Number, seedTier: Schemas.Number, planters: Schemas.Number }),   // stamps > 0 = a rarity-stamp rung (species is then 0)
  /** Client → server: hold this empty planter for me while the tutorial points at it.
   *  The CLIENT picks which one — the scene server has no avatar positions, so "nearest
   *  free planter" can only be computed where the player is. */
  reserveBox:       Schemas.Map({ boxId: Schemas.String }),
  /** Server → player: the planter now held for them. boxId '' = request refused (taken,
   *  already held by someone else, or it would have used up the last free planter). */
  boxReserved:      Schemas.Map({ boxId: Schemas.String, expiresAt: Schemas.Int64 }),

  // ── Client → Server ───────────────────────────────────────
  /** Player requests to water a plant. Server validates and updates PlantSync. */
  waterPlant:       Schemas.Map({ plantId: Schemas.String, sweet: Schemas.Boolean }),   // sweet = released in the hold meter's sweet zone
  /** Sent on join so the server can map address → display name for the leaderboard. */
  registerPlayer:   Schemas.Map({ displayName: Schemas.String }),
  /** Sent on room.onReady so the server re-sends full state even after a client reload. */
  requestFullSync:  Schemas.Map({}),

  // ── Server → all clients ─────────────────────────────────
  /** Periodic heartbeat so clients can maintain a clock-offset via clockSync. */
  // Int64, not Number: a 13-digit epoch-ms in float32 rounds by up to ~131 s and
  // made clockSync reject every heartbeat as an "outlier" (±60 s offsets).
  notifyServerTime: Schemas.Map({ sentAt: Schemas.Int64 }),

  // ── Server → specific client ──────────────────────────────
  /** Sent on player join and after each successful watering.
   *  sentAt: server timestamp when message was created (for clockSync).
   *  bloomTime: absolute server timestamp of the next bloom window. */
  playerDailyState: Schemas.Map({ sentAt: Schemas.Int64, bloomTime: Schemas.Int64 }),
  /** Sent when server rejects a water attempt. */
  waterRejected:    Schemas.Map({ plantId: Schemas.String, reason: Schemas.String }),

  // ── Server → all clients ──────────────────────────────────
  /** Broadcast when a plant's watered state changes (water or expiry).
   *  expiresInMs: server-computed time until this plant dries (0 when not watered) —
   *  decay scales with gardeners present, so the client must not guess it. */
  /** `tier` is the lifetime-waters FLAIR tier; `almanac` is how many Almanac milestone
   *  rungs the waterer has claimed (0 = none). Two different ladders, both shown beside
   *  the name — one for care given, one for flowers found. */
  plantStateUpdate: Schemas.Map({ plantId: Schemas.String, isWatered: Schemas.Boolean, wateredAt: Schemas.Int64, wateredBy: Schemas.String, expiresInMs: Schemas.Number, tier: Schemas.Number, almanac: Schemas.Number }),
  /** Broadcast when the bloom threshold is reached.
   *  scale: bloomScaleFor(gardeners) (0–1] — 1 = full-garden bloom, below 1 = the
   *  smaller, quieter scaled bloom. variant: BLOOM_VARIANTS id rolled by the server (v2 Phase 6). */
  /** elapsedMs: how far into the bloom we already are — 0 on the live broadcast, >0 when
   *  re-sent to a late joiner, so their countdown matches everyone else's. durationMs: this
   *  bloom's length (bloomDurationMs — 2 min solo … 6 min at 6+ contributors). */
  bloomTriggered:   Schemas.Map({ scale: Schemas.Number, variant: Schemas.String, elapsedMs: Schemas.Number, durationMs: Schemas.Number }),
  /** v2 — bloom threshold (flat 80% since the decay-rate rework) + gardeners present.
   *  Sent to a joining player, on full sync, and broadcast when the gardener count changes. */
  thresholdUpdate:  Schemas.Map({ threshold: Schemas.Number, gardeners: Schemas.Number }),
  /** Server → each gardener present when a bloom ENDS: what the garden just did, and
   *  what they did in it. Sent per player (the you* fields differ) right before the
   *  cycle counters are cleared. The during-bloom contributor names are untouched —
   *  this is the closing beat, so a bloom finishes on a result instead of just stopping. */
  bloomSummary:     Schemas.Map({
    gardeners: Schemas.Number, waters: Schemas.Number, seeds: Schemas.Number, rares: Schemas.Number,
    youWaters: Schemas.Number, youSeeds: Schemas.Number, youRares: Schemas.Number,
  }),
  /** Broadcast when the server resets all plants after bloom. */
  bloomReset:       Schemas.Map({}),
  /** Top-10 boards — sent to all on water, to joining player on join.
   *  entriesJson = this week's board (resets at weeklyResetAt, epoch ms);
   *  allTimeJson = lifetime board, never resets. Entries: {displayName, count, tier}. */
  leaderboardUpdate: Schemas.Map({ entriesJson: Schemas.String, allTimeJson: Schemas.String, weeklyResetAt: Schemas.Int64 }),
  /** Server → ONE player, alongside every leaderboardUpdate: where THEY stand, ranked
   *  against the whole board rather than the top-10 slice — so the weekly board can show
   *  "you are #23" to someone who will never appear in the list itself (KJ 2026-09-22).
   *  rank 0 = not on the board at all (no waters yet this week). */
  yourStanding:      Schemas.Map({ weeklyRank: Schemas.Number, weeklyCount: Schemas.Number, allTimeRank: Schemas.Number, allTimeCount: Schemas.Number }),
  // (v2 seed messages registered at the FRONT — see top of registry)

  // ── Test-panel only — parked at the tail (see header note) ──
  // Expected casualties of the position cap; verify with the test panel.
  /** Test-panel only — wipe MY onboarding record so the whole tutorial replays. Without
   *  this, whoever built the tutorial can never see it again after doing it once. */
  adminResetOnboarding: Schemas.Map({}),
  /** Tribute plot editor. Empty json = "send me the saved draft"; otherwise save this one.
   *  A DRAFT only — deploys read TRIBUTE_HERO_PLOTS, never this. */
  adminTributeDraft: Schemas.Map({ json: Schemas.String }),
  tributeDraft:      Schemas.Map({ json: Schemas.String }),
  /** Plant layout editor — the 38 plants players water. Same draft/bake contract as the
   *  planter and tribute tools: deploys read PLANT_LAYOUT, never this. */
  adminPlantDraft:   Schemas.Map({ json: Schemas.String }),
  plantDraft:        Schemas.Map({ json: Schemas.String }),
  /** Test-panel only — tells the server to bypass the daily limit for this player. */
  setTestOverride:  Schemas.Map({ enabled: Schemas.Boolean }),
  /** Test-panel only — triggers bloom on the server so all clients sync correctly.
   *  variant: '' = roll normally; a BLOOM_VARIANTS id forces that variant at full scale. */
  forceBloom:       Schemas.Map({ variant: Schemas.String }),
  /** Test-panel only — adds lifetime (+weekly) waters through the REAL flair/tribute path. */
  adminGrantWaters: Schemas.Map({ amount: Schemas.Number }),
  /** Test-panel only — waters exactly enough plants to reach the 80% bloom threshold. */
  forceWater80:     Schemas.Map({}),
  /** Test-panel only — cancels any bloom-sustain hold and ends an active bloom immediately,
   *  same as a normal bloomReset. Idempotent: a no-op if nothing is active/holding. */
  adminResetBloom:  Schemas.Map({}),
  /** Test-panel only — tidy up the longest-away owner's planter now (crowding rule,
   *  GDD §3.1), ignoring the reserve, the minimum-away time and whether they're here. */
  adminTidyPlanter: Schemas.Map({}),
  /** Test-panel only (admin): lift the planter cap for the sender; each planting rolls a RANDOM
   *  tier and uses no seed. In-memory — a server restart turns it off. */
  adminUnlimitedPlanters: Schemas.Map({ on: Schemas.Boolean }),
  /** Planter layout tool (test panel, admin): save the draft layout (JSON array of
   *  { x, z, rot }) to world Storage 'planterDraft'; json '' = ask for the saved draft. */
  adminPlanterDraft: Schemas.Map({ json: Schemas.String }),
  /** Server → admin: the saved planter draft ('' = none yet). */
  planterDraft:      Schemas.Map({ json: Schemas.String }),
  /** Test-panel only (admin): fill up to `count` empty Avenue slots with real, persisted,
   *  Rare+ synthetic flowers (owner = the admin) — so the Avenue can be playtested without
   *  harvesting 72 real rares. count 0 = a sensible default (server picks). */
  adminFillAvenue:   Schemas.Map({ count: Schemas.Number }),
  /** Test-panel only (admin): empty every Avenue slot the admin owns (or all, if none are
   *  the admin's — a real player's display is never touched unless it's the admin's own). */
  adminClearAvenue:  Schemas.Map({}),
})
