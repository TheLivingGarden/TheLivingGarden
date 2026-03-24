import {} from '@dcl/sdk/math'
import { engine } from '@dcl/sdk/ecs'
import { setupUi } from './ui'
import { setupWateringSystem } from './wateringSystem'


export function main() {
  setupUi()
  setupWateringSystem()
}
