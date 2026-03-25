import {} from '@dcl/sdk/math'
import { engine } from '@dcl/sdk/ecs'
import { setupNotifications } from './notifications'
import { setupWateringSystem } from './wateringSystem'


export function main() {
  setupNotifications()
  setupWateringSystem()
}
