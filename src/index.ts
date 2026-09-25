import { isServer } from '@dcl/sdk/network'
import { setupNotifications } from './notifications'
import { setupWateringSystem } from './wateringSystem'
import { setupOnboarding } from './onboarding'
import { setupBloomFinale } from './bloomFinale'
import { setupDiscoveryCard } from './discoveryCard'
import { setupPodium } from './podium'
import { setupPouchRack } from './pouchRack'

// Importing shared schemas + messages here ensures registerMessages()
// and defineComponent() run on BOTH server and client before any
// system or message handler is registered.
import './shared/schemas'
import './shared/messages'

export async function main() {
  if (isServer()) {
    const { server } = await import('./server/server')
    await server()
    return
  }

  // ── Client only ────────────────────────────────────────────
  setupNotifications()
  setupWateringSystem()
  // AFTER setupWateringSystem: it calls room.clear() partway through, and any
  // room.onMessage handler registered before that clear is silently wiped.
  setupOnboarding()
  setupBloomFinale()
  setupDiscoveryCard()   // same post-room.clear() window
  setupPodium()
  setupPouchRack()   // after setupWateringSystem: the gift API it uses is registered by then

  // Discord buttons are BACK (KJ 2026-09-20) — they carry their own link from the
  // composite, and the info panel's last page links to the same server.

}
