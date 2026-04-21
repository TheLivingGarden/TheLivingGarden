import { isServer } from '@dcl/sdk/network'
import { engine, VisibilityComponent } from '@dcl/sdk/ecs'
import { setupNotifications } from './notifications'
import { setupWateringSystem } from './wateringSystem'

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

  // Hide Discord buttons — removed from the experience
  for (const name of ['Discord Button', 'Discord Button_2']) {
    const e = engine.getEntityOrNullByName(name)
    if (e) VisibilityComponent.createOrReplace(e, { visible: false })
  }

}
