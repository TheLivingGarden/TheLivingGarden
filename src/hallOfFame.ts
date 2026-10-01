// =============================================================
// Bloom Garden v2 — Hall of Fame stands (the rare-plant gallery / new Almanac)
//
// A real copy of assets/scene/Models/hallOfFameStand at every placeholder KJ put in scene.glb
// (layout + how it was baked: shared/hallOfFame.ts), each its own entity with the module's own
// collider. The Avenue's plants and plaques sit on them (avenueSystem.ts).
// The placeholders are still baked into scene.glb, coincident with these — delete them in
// Blender once the stands look right in-world.
// =============================================================

import { engine, Transform, GltfContainer, GltfNodeModifiers, Name, Entity } from '@dcl/sdk/ecs'
import { Quaternion } from '@dcl/sdk/math'
import { HOF_MODULES } from './shared/hallOfFame'
import { registerStreamSource } from './streaming'
import { avenueStreamItems } from './avenueSystem'

const HOF_SRC = 'assets/scene/Models/hallOfFameStand/hallOfFameStand.glb'

export const hofStands: Entity[] = []

export function setupHallOfFame(): void {
  HOF_MODULES.forEach((m, i) => {
    const e = engine.addEntity()
    Transform.create(e, { position: { x: m.x, y: m.y, z: m.z }, rotation: Quaternion.fromEulerDegrees(0, m.rot, 0) })
    GltfContainer.create(e, { src: HOF_SRC })
    GltfNodeModifiers.create(e, { modifiers: [{ path: '', castShadows: false }] })   // 24 stands: no shadow pass (perf pass 2026-10-01)
    Name.create(e, { value: `HallOfFame_${i + 1}` })
    hofStands.push(e)
  })
  // Far stands (and the flowers standing on them) are hidden on approach-based streaming — see streaming.ts
  registerStreamSource('gallery', () => [
    ...hofStands.map((e, i) => ({ key: `stand${i}`, x: HOF_MODULES[i].x, z: HOF_MODULES[i].z, entities: [e] })),
    ...avenueStreamItems(),
  ])
  console.log(`[HallOfFame] ${hofStands.length} stands placed`)
}
