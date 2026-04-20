// =============================================================
// The Living Garden — Shared Message Definitions
// Imported by both server and client.
// =============================================================

import { Schemas } from '@dcl/sdk/ecs'
import { registerMessages } from '@dcl/sdk/network'

export const room = registerMessages({
  // ── Client → Server ───────────────────────────────────────
  /** Player requests to water a plant. Server validates and updates PlantSync. */
  waterPlant:       Schemas.Map({ plantId: Schemas.String }),
  /** Sent on join so the server can map address → display name for the leaderboard. */
  registerPlayer:   Schemas.Map({ displayName: Schemas.String }),
  /** Test-panel only — triggers bloom on the server so all clients sync correctly. */
  forceBloom:       Schemas.Map({}),
  /** Test-panel only — waters exactly enough plants to reach the 80% bloom threshold. */
  forceWater80:     Schemas.Map({}),
  /** Test-panel only — tells the server to bypass the daily limit for this player. */
  setTestOverride:  Schemas.Map({ enabled: Schemas.Boolean }),
  /** Sent on room.onReady so the server re-sends full state even after a client reload. */
  requestFullSync:  Schemas.Map({}),

  // ── Server → all clients ─────────────────────────────────
  /** Periodic heartbeat so clients can maintain a clock-offset via clockSync. */
  notifyServerTime: Schemas.Map({ sentAt: Schemas.Number }),

  // ── Server → specific client ──────────────────────────────
  /** Sent on player join and after each successful watering.
   *  sentAt: server timestamp when message was created (for clockSync).
   *  bloomTime: absolute server timestamp of the next bloom window. */
  playerDailyState: Schemas.Map({ sentAt: Schemas.Number, bloomTime: Schemas.Number }),
  /** Sent when server rejects a water attempt. */
  waterRejected:    Schemas.Map({ plantId: Schemas.String, reason: Schemas.String }),

  // ── Server → all clients ──────────────────────────────────
  /** Broadcast when a plant's watered state changes (water or expiry). */
  plantStateUpdate: Schemas.Map({ plantId: Schemas.String, isWatered: Schemas.Boolean, wateredAt: Schemas.Number, wateredBy: Schemas.String }),
  /** Broadcast when the bloom threshold is reached. */
  bloomTriggered:   Schemas.Map({}),
  /** Broadcast when the server resets all plants after bloom. */
  bloomReset:       Schemas.Map({}),
  /** Top-10 all-time leaderboard — sent to all on water, to joining player on join. */
  leaderboardUpdate: Schemas.Map({ entriesJson: Schemas.String }),
})
