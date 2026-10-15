import { isServer } from '@dcl/sdk/network'
import { engine, VisibilityComponent, TouchScreenControls, InputAction } from '@dcl/sdk/ecs'
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
import { setGoldenHour } from './moonlight'
import { installSystemProfiler } from './hitchHud'
import { installSystemTap } from './systemTap'

// Importing shared schemas + messages here ensures registerMessages()
// and defineComponent() run on BOTH server and client before any
// system or message handler is registered.
import './shared/schemas'
import './shared/messages'

export async function main() {
  if (!isServer()) { installSystemTap(); installSystemProfiler() }   // must run before any engine.addSystem (they wrap them)
  if (isServer()) {
    const { server } = await import('./server/server')
    await server()
    return
  }

  // ── Client only ────────────────────────────────────────────
  setGoldenHour()   // the resting sky (config GOLDEN_HOUR_S); the Moonlit Bloom rolls to night and back
  // Phone HUD (week-4 follow-up, KJ 2026-10-15): the garden only uses tap (IA_POINTER), movement and jump, so E / F / 1-4 are
  // clutter. With two buttons left there is no "+" menu either. No-op on desktop; the explorer restores them when you leave.
  TouchScreenControls.hide([InputAction.IA_PRIMARY, InputAction.IA_SECONDARY, InputAction.IA_ACTION_3, InputAction.IA_ACTION_4, InputAction.IA_ACTION_5, InputAction.IA_ACTION_6])
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

  // Discord buttons hidden again (KJ 2026-09-30): the info panel's last page has the link. Hidden, not deleted, so they can come back.
  for (const name of ['Discord Button', 'Discord Button_2']) {
    const e = engine.getEntityOrNullByName(name)
    if (e) VisibilityComponent.createOrReplace(e, { visible: false })
  }

}
