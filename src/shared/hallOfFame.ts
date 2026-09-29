// =============================================================
// Bloom Garden v2 — Hall of Fame stand layout (pure data, shared by client + server)
//
// KJ's Blender scene.glb carries 24 placeholder HallOfFame_Module stands: five nodes (one single stand and
// four array rows, pitch 5.125 m) of the one module in assets/scene/Models/hallOfFameStand.
// RE-BAKED 2026-09-29 from scene.glb (was 55 stands in 9 rows, 2026-09-25 — table kept in
// design/layout-tables.bak-0929.ts). Each stand sits on its placeholder's footprint centre: x/z = the centre of
// its bounding box, y = the placeholder's floor minus 0.5 (the 09-25 convention). NOTE the north-south rows
// (.003/.004/the single stand) are now 6.41 m EAST of where the 09-25 bake put them — the placeholders moved.
// Facing is read from each placeholder's shape (its vertex mass sits toward the front). 09-25 notes follow: each array row unrolled into
// its module origins, world = (8 - glb.x, glb.y, glb.z + 24). rot = the entity yaw that lands
// the module on its placeholder (placeholder yaw minus the yaw the module file already
// carries, mirrored). The Avenue's slots (config.ts AVENUE_POSITIONS) are derived from this.
//
// Module anatomy (measured from hallOfFameStand.glb; in ENTITY-local metres, +X = the back,
// -X = the front a visitor stands at): a stepped wedge 1.6 m wide (Z) x 1.74 m deep (X), flat
// soil top at y 1.25 spanning X -0.15..+0.8, the front face a plain vertical wall (y 0.04-0.67).
// =============================================================

export const HOF_MODULES: ReadonlyArray<{ x: number; y: number; z: number; rot: number }> = [
  // HallOfFame_Module
  { x: 54.207, y: 0, z: 6.642, rot: 0 },
  // HallOfFame_Module.002
  { x: 33.178, y: 0.049, z: 3.885, rot: 180 },
  { x: 33.178, y: 0.049, z: 9.011, rot: 180 },
  { x: 33.178, y: 0.049, z: 14.137, rot: 180 },
  { x: 33.178, y: 0.049, z: 44.115, rot: 180 },
  { x: 33.178, y: 0.049, z: 38.989, rot: 180 },
  { x: 33.178, y: 0.049, z: 33.863, rot: 180 },
  // HallOfFame_Module.003
  { x: 46.699, y: 0.049, z: 10, rot: 180 },
  { x: 46.699, y: 0.049, z: 15.126, rot: 180 },
  { x: 46.699, y: 0.049, z: 20.252, rot: 180 },
  { x: 46.699, y: 0.049, z: 25.378, rot: 180 },
  { x: 46.699, y: 0.049, z: 30.504, rot: 180 },
  { x: 46.699, y: 0.049, z: 35.63, rot: 180 },
  { x: 46.699, y: 0.049, z: 40.756, rot: 180 },
  // HallOfFame_Module.004
  { x: 54.263, y: 0.049, z: 42.61, rot: 0 },
  { x: 54.263, y: 0.049, z: 37.485, rot: 0 },
  { x: 54.263, y: 0.049, z: 32.359, rot: 0 },
  { x: 54.263, y: 0.049, z: 27.233, rot: 0 },
  { x: 54.263, y: 0.049, z: 22.107, rot: 0 },
  { x: 54.263, y: 0.049, z: 16.981, rot: 0 },
  { x: 54.263, y: 0.049, z: 11.855, rot: 0 },
  // HallOfFame_Module.008
  { x: 49.175, y: 0.049, z: -6.95, rot: 90 },
  { x: 44.05, y: 0.049, z: -6.95, rot: 90 },
  { x: 38.924, y: 0.049, z: -6.95, rot: 90 },
]

/** Soil top: height above the module origin, and how far BEHIND the origin its centre is. */
export const HOF_SOIL_Y      = 1.25
export const HOF_SOIL_BACK   = 0.32
/** Front face: how far in FRONT of the soil centre the plain wall stands. */
export const HOF_FRONT_OUT   = 1.19

/** Unit vector a visitor faces to look at the module (its front), for entity yaw `rot`. */
function frontOf(rot: number): { x: number; z: number } {
  const r = (rot * Math.PI) / 180
  return { x: -Math.cos(r), z: Math.sin(r) }
}

/** One Avenue slot per stand: the soil centre, at soil height, facing the visitor. The Avenue's
 *  own `rot` convention is 0 = facing +z, so it is atan2(front.x, front.z). */
export function hofAvenueSlots(): Array<{ id: string; x: number; y: number; z: number; rot: number }> {
  return HOF_MODULES.map((m, i) => {
    const f = frontOf(m.rot)
    const rot = ((Math.round((Math.atan2(f.x, f.z) * 180) / Math.PI) % 360) + 360) % 360
    return {
      id: `av_${i + 1}`,
      x: Number((m.x - f.x * HOF_SOIL_BACK).toFixed(3)),
      y: Number((m.y + HOF_SOIL_Y).toFixed(3)),
      z: Number((m.z - f.z * HOF_SOIL_BACK).toFixed(3)),
      rot,
    }
  })
}
