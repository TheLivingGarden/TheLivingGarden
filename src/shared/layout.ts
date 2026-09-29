// =============================================================
// Bloom Garden v2 — Code-owned plant layout
//
// Creator Hub is unavailable and the Blender layout is changing, so plant
// positions are owned HERE rather than hand-edited in main.composite. The
// composite still provides the plant ENTITIES (names, GLBs, animators) —
// this table only overrides where they stand. Everything derived from a
// plant (anchor, rose, water drop, labels, click box) is created after the
// override, so it all follows automatically.
//
// BAKED 2026-09-21 from KJ's in-world Plant editor (src/plantLayoutTool.ts): place the
// plants in world, Save / export, and the server logs this block. That replaced the
// Blender round trip (tools/blender_export_layout.py + fit-layout.mjs), which existed
// only because Creator Hub was unavailable — those still work, they are just not the
// only path now. An EMPTY table is an exact no-op: every plant keeps its composite
// transform. Coordinates rounded to 3 dp (sub-millimetre) for legibility.
//
// RE-BAKED 2026-09-29 from KJ's editor export, after the scene.glb re-export.
//
//   x, y, z  — scene-local metres (same space as the composite)
//   rotY     — optional yaw in degrees
//   scale    — optional uniform scale
// =============================================================

export interface PlantPlacement { x: number; y: number; z: number; rotY?: number; scale?: number }

export const PLANT_LAYOUT: Readonly<Record<string, PlantPlacement>> = {
  'FastPlant_1': { x: 8.2, y: 1.371, z: -4.6, rotY: 135, scale: 0.6 },
  'FastPlant_2': { x: 21.9, y: 1.312, z: 7, rotY: 57, scale: 0.6 },
  'FastPlant_3': { x: 13.3, y: 1.233, z: 10.5, rotY: 162, scale: 0.382 },
  'FastPlant_4': { x: 13.5, y: 1.318, z: 8.3, rotY: 297, scale: 0.382 },
  'FastPlant_5': { x: 23.6, y: 0.773, z: 46.8, rotY: 27, scale: 0.382 },
  'FastPlant_6': { x: 13.2, y: 1.336, z: 40.5, rotY: 222, scale: 0.382 },
  'Plant_1': { x: 21.9, y: 1.34, z: 11.6, rotY: 45, scale: 0.691 },
  'Plant_10': { x: 6.6, y: 1.386, z: -4.3, rotY: 75, scale: 1.1 },
  'Plant_11': { x: 23.1, y: 0.969, z: -4.4, rotY: 15, scale: 1 },
  'Plant_12': { x: 22, y: 1.359, z: 41.6, rotY: 60, scale: 1 },
  'Plant_13': { x: 21.7, y: 1.068, z: 38.8, rotY: 330, scale: 0.8 },
  'Plant_14': { x: 21.8, y: 1.124, z: 36.5, rotY: 300, scale: 0.7 },
  'Plant_15': { x: 13.5, y: 1.349, z: 36.6, rotY: 270, scale: 1 },
  'Plant_16': { x: 13.5, y: 1.314, z: 39.2, rotY: 345, scale: 1 },
  'Plant_17': { x: 9.1, y: 1.306, z: 52.5, rotY: 225, scale: 0.7 },
  'Plant_18': { x: 21.5, y: 1.127, z: 26.2, rotY: 225, scale: 1 },
  'Plant_19': { x: 13.2, y: 1.125, z: 30.6, rotY: 195, scale: 0.8 },
  'Plant_2': { x: 23.6, y: 1.151, z: 1.2, rotY: 0, scale: 1 },
  'Plant_20': { x: 7.7, y: 1.421, z: 52.7, rotY: 255, scale: 1 },
  'Plant_21': { x: 8.2, y: 1.093, z: 46.8, rotY: 120, scale: 0.7 },
  'Plant_22': { x: 3.9, y: 1.322, z: 52.5, rotY: 225, scale: 1 },
  'Plant_23': { x: 13.1, y: 1.102, z: 17.3, rotY: 150, scale: 0.643 },
  'Plant_24': { x: 13.4, y: 1.102, z: 11.6, rotY: 125, scale: 0.643 },
  'Plant_25': { x: 21.6, y: 1.312, z: 6.1, rotY: 249, scale: 0.541 },
  'Plant_26': { x: 9.6, y: 1.368, z: -4.5, rotY: 194, scale: 0.7 },
  'Plant_27': { x: 3.9, y: 1.289, z: -4.5, rotY: 60, scale: 0.848 },
  'Plant_28': { x: 5.2, y: 1.333, z: -4.5, rotY: 89, scale: 0.541 },
  'Plant_29': { x: 13.4, y: 1.33, z: 41.7, rotY: 90, scale: 0.7 },
  'Plant_3': { x: 21.3, y: 1.078, z: 21.7, rotY: 120, scale: 1 },
  'Plant_30': { x: 13.4, y: 1.096, z: 37.9, rotY: 120, scale: 0.7 },
  'Plant_31': { x: 21.6, y: 1.112, z: 40.3, rotY: 195, scale: 0.7 },
  'Plant_32': { x: 21.7, y: 1.355, z: 37.5, rotY: 150, scale: 0.6 },
  'Plant_4': { x: 8.3, y: 1.069, z: 1, rotY: 45, scale: 0.6 },
  'Plant_5': { x: 13.4, y: 0.963, z: 9.3, rotY: 135, scale: 0.9 },
  'Plant_6': { x: 28.1, y: 0.98, z: -4.3, rotY: 135, scale: 0.8 },
  'Plant_7': { x: 21.7, y: 1.122, z: 8.7, rotY: 315, scale: 1 },
  'Plant_8': { x: 21.7, y: 1.359, z: 10.1, rotY: 150, scale: 0.691 },
  'Plant_9': { x: 13.3, y: 1.331, z: 6, rotY: 240, scale: 0.7 },
}

/** Loose composite props (lampposts and their light overlays, Discord buttons) moved with
 *  the Test panel's Prop editor (propLayoutTool.ts). Keyed by composite entity NAME; every member of a
 *  prop is listed, so a lamp's post and its three light overlays stay together. Empty = a no-op. */
export interface PropPlacement { x: number; y: number; z: number; rotY?: number }
export const PROP_LAYOUT: Readonly<Record<string, PropPlacement>> = {
  // Baked 2026-09-29 12:35 from KJ's in-world Prop editor export (rotations the export left out
  // are kept from the previous bake where one existed).
  'lamppost': { x: -1.4, y: 0.45, z: 1.4, rotY: 0 },
  'lamppost_light_high': { x: -1.4, y: 0.45, z: 1.4, rotY: 0 },
  'lamppost_light_mid': { x: -1.4, y: 0.45, z: 1.4, rotY: 0 },
  'lamppost_light_low': { x: -1.4, y: 0.45, z: 1.4, rotY: 0 },
  'lamppost_2': { x: -1.4, y: 0.4, z: 46.4, rotY: 0 },
  'lamppost_light_high_2': { x: -1.4, y: 0.4, z: 46.399, rotY: 0 },
  'lamppost_light_mid_2': { x: -1.4, y: 0.4, z: 46.399, rotY: 0 },
  'lamppost_light_low_2': { x: -1.4, y: 0.4, z: 46.399, rotY: 0 },
  'lamppost_3': { x: 30.9, y: 0.4, z: 46.1 },
  'lamppost_light_high_3': { x: 30.905, y: 0.4, z: 46.103 },
  'lamppost_light_mid_3': { x: 30.905, y: 0.4, z: 46.103 },
  'lamppost_light_low_3': { x: 30.905, y: 0.4, z: 46.103 },
  'lamppost_4': { x: 30.6, y: 0.5, z: 1.7 },
  'lamppost_light_high_4': { x: 30.602, y: 0.5, z: 1.705 },
  'lamppost_light_mid_4': { x: 30.602, y: 0.5, z: 1.705 },
  'lamppost_light_low_4': { x: 30.602, y: 0.5, z: 1.705 },
  'Discord Button': { x: -17, y: 1.7, z: 46.6 },
  'Discord Button_2': { x: 39.5, y: 1.1, z: 2.1 },
  'PouchRack': { x: -29.2, y: 1.5, z: 45.2 },
  'FlowerShelf': { x: -22, y: 1.7, z: 53.7, rotY: 0 },
  'AlmanacWall': { x: -31.4, y: 1.25, z: 49.6, rotY: 270 },
  'ExamTable': { x: -25.4, y: 1.6, z: 53.6, rotY: 0 },
  'ProgressBar_1': { x: 4.4, y: 2.6, z: 8.4 },
  'ProgressBar_2': { x: 4.5, y: 2.6, z: 39.7 },
  'ProgressBar_3': { x: 0.4, y: 4, z: 18.375 },
  'ProgressBar_4': { x: 0.4, y: 4, z: 29.61 },
}
