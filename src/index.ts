import { isServer } from '@dcl/sdk/network'
import { setupNotifications } from './notifications'
import { setupWateringSystem } from './wateringSystem'
import { setupSittingSystem } from './sittingSystem'

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
  setupSittingSystem([
    { name: 'Beanbag', sitOffset: { x: 0, y: 0.3, z: 0 } },
  ])
}
