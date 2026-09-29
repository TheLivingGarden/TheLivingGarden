/** The waterPlant reach rule, pure so it can be tested without a scene server.
 *  - no plant position           → 'no_plant'  (reject)
 *  - no server-side player pos   → 'unverified' (allow: a phone client in local preview never got a Transform onto
 *                                  the server entity, 2026-09-29; anyone WITH a position is still checked)
 *  - player within reachM        → 'ok'
 *  - otherwise                   → 'too_far'   (reject) */
export type V3 = { x: number; y: number; z: number }
export type ReachVerdict = 'ok' | 'unverified' | 'too_far' | 'no_plant'

export function reachVerdict(plant: V3 | null | undefined, player: V3 | null | undefined, reachM: number): ReachVerdict {
  if (!plant) return 'no_plant'
  if (!player) return 'unverified'
  const d = Math.hypot(plant.x - player.x, plant.y - player.y, plant.z - player.z)
  return d > reachM ? 'too_far' : 'ok'
}
