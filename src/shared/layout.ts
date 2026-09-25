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
//   x, y, z  — scene-local metres (same space as the composite)
//   rotY     — optional yaw in degrees
//   scale    — optional uniform scale
// =============================================================

export interface PlantPlacement { x: number; y: number; z: number; rotY?: number; scale?: number }

export const PLANT_LAYOUT: Readonly<Record<string, PlantPlacement>> = {
  'FastPlant_1': { x: 12.9, y: 0.771, z: 2.9, rotY: 0, scale: 0.6 },
  'FastPlant_2': { x: 18.7, y: 0.812, z: 4.5, rotY: 57, scale: 0.6 },
  'FastPlant_3': { x: 13.2, y: 0.583, z: 21.6, rotY: 162, scale: 0.382 },
  'FastPlant_4': { x: 13.3, y: 0.568, z: 26.8, rotY: 297, scale: 0.382 },
  'FastPlant_5': { x: 10.787, y: 0.773, z: 40.25, rotY: 57, scale: 0.382 },
  'FastPlant_6': { x: 2.966, y: 0.886, z: 40.362, rotY: 57, scale: 0.382 },
  'Plant_1': { x: 18.7, y: 0.84, z: 6.8, rotY: 285, scale: 0.691 },
  'Plant_2': { x: 23.4, y: 0.501, z: 1, rotY: 0, scale: 1 },
  'Plant_3': { x: 13.4, y: 0.578, z: 21.1, rotY: 225, scale: 1 },
  'Plant_4': { x: 8.3, y: 0.569, z: 1, rotY: 45, scale: 0.6 },
  'Plant_5': { x: 13.71, y: 0.563, z: 14.25, rotY: 315, scale: 0.9 },
  'Plant_6': { x: 18.6, y: 0.98, z: 2, rotY: 180, scale: 0.8 },
  'Plant_7': { x: 18.6, y: 0.922, z: 4, rotY: 180, scale: 1 },
  'Plant_8': { x: 18.7, y: 1.009, z: 2.9, rotY: 60, scale: 0.691 },
  'Plant_9': { x: 13, y: 0.781, z: 6, rotY: 75, scale: 0.7 },
  'Plant_10': { x: 13, y: 0.836, z: 3.7, rotY: 0, scale: 1.1 },
  'Plant_11': { x: 18.7, y: 0.969, z: 0.6, rotY: 15, scale: 1 },
  'Plant_12': { x: 10.88, y: 0.759, z: 40.936, rotY: 60, scale: 1 },
  'Plant_13': { x: 10.443, y: 0.868, z: 39.563, rotY: 330, scale: 0.8 },
  'Plant_14': { x: 10.443, y: 0.724, z: 37.32, rotY: 300, scale: 0.7 },
  'Plant_15': { x: 2.75, y: 0.799, z: 37.82, rotY: 120, scale: 1 },
  'Plant_16': { x: 2.63, y: 0.864, z: 39.78, rotY: 180, scale: 1 },
  'Plant_17': { x: 3.081, y: 0.806, z: 41.893, rotY: 45, scale: 0.7 },
  'Plant_18': { x: 13, y: 0.577, z: 27.1, rotY: 120, scale: 1 },
  'Plant_19': { x: 13.77, y: 0.475, z: 33.48, rotY: 45, scale: 0.8 },
  'Plant_20': { x: 14.445, y: 0.521, z: 45.885, rotY: 0, scale: 1 },
  'Plant_21': { x: 9.2, y: 0.543, z: 46.39, rotY: 315, scale: 0.7 },
  'Plant_22': { x: 2.76, y: 0.572, z: 45.95, rotY: 180, scale: 1 },
  'Plant_23': { x: 13.4, y: 0.552, z: 26.3, rotY: 150, scale: 0.643 },
  'Plant_24': { x: 13.3, y: 0.552, z: 22.2, rotY: 125, scale: 0.643 },
  'Plant_25': { x: 18.7, y: 0.812, z: 6.1, rotY: 249, scale: 0.541 },
  'Plant_26': { x: 12.9, y: 0.818, z: 1.2, rotY: 194, scale: 0.7 },
  'Plant_27': { x: 13, y: 0.789, z: 2, rotY: 300, scale: 0.848 },
  'Plant_28': { x: 18.6, y: 0.833, z: 5.3, rotY: 179, scale: 0.541 },
  'Plant_29': { x: 2.75, y: 0.88, z: 40.86, rotY: 45, scale: 0.7 },
  'Plant_30': { x: 3.11, y: 0.846, z: 38.936, rotY: 120, scale: 0.7 },
  'Plant_31': { x: 10.443, y: 0.812, z: 42.07, rotY: 195, scale: 0.7 },
  'Plant_32': { x: 10.912, y: 0.805, z: 38.413, rotY: 225, scale: 0.6 },
}

/** Loose composite props (lampposts and their light overlays, sit spots, Discord buttons) moved with
 *  the Test panel's Prop editor (propLayoutTool.ts). Keyed by composite entity NAME; every member of a
 *  prop is listed, so a lamp's post and its three light overlays stay together. Empty = a no-op. */
export interface PropPlacement { x: number; y: number; z: number; rotY?: number }
export const PROP_LAYOUT: Readonly<Record<string, PropPlacement>> = {
}
