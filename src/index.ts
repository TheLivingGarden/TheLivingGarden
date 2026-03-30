import {} from '@dcl/sdk/math'
import { engine } from '@dcl/sdk/ecs'
import { setupNotifications } from './notifications'
import { setupWateringSystem } from './wateringSystem'
import { setupSittingSystem } from './sittingSystem'


export function main() {
  setupNotifications()
  setupWateringSystem()

  // Register every named seat entity in the scene.
  // Replace / extend this list with your actual entity names.
  setupSittingSystem([
    'Sit Spot 1',
    'Sit Spot 2',
  ])
}
