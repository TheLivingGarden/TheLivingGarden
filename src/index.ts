import { isServer } from '@dcl/sdk/network'
import { setupNotifications } from './notifications'
import { setupWateringSystem } from './wateringSystem'
import { setupOnboarding } from './onboarding'
import { setupBloomFinale } from './bloomFinale'
import { setupDiscoveryCard } from './discoveryCard'
import { setupPodium } from './podium'
import { setupPouchRack } from './pouchRack'
import { setupCollectionDisplays } from './collectionDisplay'
import { setupHallOfFame } from './hallOfFame'
import { setupExamTable } from './examTable'
import { setupGalleryThreads } from './galleryThreads'
import { setupWaterStreakBadges } from './waterStreakBadgeSystem'

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
  setupCollectionDisplays()   // flower shelf + Almanac wall
  setupHallOfFame()   // the rare-plant gallery stands from scene.glb (24 since the 2026-09-29 re-bake)
  setupExamTable()    // potting-shed examination table (examTable.ts)
  setupGalleryThreads()   // Gallery flowers fly to the Bloom when it triggers — after room.clear() like the rest
  setupWaterStreakBadges()   // nametag: name + current water streak, after room.clear() like the rest

  // Discord buttons are BACK (KJ 2026-09-20) — they carry their own link from the
  // composite, and the info panel's last page links to the same server.

}
