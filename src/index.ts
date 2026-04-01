import {} from '@dcl/sdk/math'
import { isServer } from '@dcl/sdk/network'
import { setupNotifications } from './notifications'
import { setupWateringSystem } from './wateringSystem'
import { setupSittingSystem }  from './sittingSystem'

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
    'Sit Spot 1',
    'Sit Spot 2',
  ])
}
