// =============================================================
// The Living Garden — Shared ECS Schemas
// Components defined here are synced server → all clients.
// validateBeforeChange ensures ONLY the server can mutate them.
// =============================================================

import { engine, Schemas } from '@dcl/sdk/ecs'
import { AUTH_SERVER_PEER_ID } from '@dcl/sdk/network/message-bus-sync'

/**
 * Per-plant authoritative state.
 * Created by the server on each plant entity and synced to all clients.
 * Clients MUST NOT write to this directly — use the waterPlant message.
 *
 * NOTE: wateredAt uses Int64 — Schemas.Number corrupts 13-digit timestamps.
 */
export const PlantSync = engine.defineComponent('garden:PlantSync', {
  isWatered: Schemas.Boolean,
  wateredAt: Schemas.Int64,
})

PlantSync.validateBeforeChange((value) => value.senderAddress === AUTH_SERVER_PEER_ID)
