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
// RE-BAKED 2026-09-30 from KJ's editor export (the roses moved; pre-bake table: empty for claude/backups/layout.ts.bak-pre-plant-bake-2026-09-30).
//
//   x, y, z  — scene-local metres (same space as the composite)
//   rotY     — optional yaw in degrees
//   scale    — optional uniform scale
// =============================================================

export interface PlantPlacement { x: number; y: number; z: number; rotY?: number; scale?: number }

export const PLANT_LAYOUT: Readonly<Record<string, PlantPlacement>> = {
  'FastPlant_1': { x: 26.9, y: 1.355, z: -4.9, rotY: 135, scale: 0.6 },
  'FastPlant_2': { x: 24.1, y: 1.357, z: 10.2, rotY: 57, scale: 0.6 },
  'FastPlant_3': { x: 18, y: 1.287, z: 13.6, rotY: 162, scale: 0.382 },
  'FastPlant_4': { x: 18, y: 1.321, z: 12.4, rotY: 297, scale: 0.382 },
  'FastPlant_5': { x: 23.6, y: 1.333, z: 52.3, rotY: 27, scale: 0.382 },
  'FastPlant_6': { x: 10.8, y: 1.295, z: 42.8, rotY: 222, scale: 0.382 },
  'Plant_1': { x: 26.7, y: 1.124, z: 18.8, rotY: 90, scale: 0.691 },
  'Plant_10': { x: 11.5, y: 1.304, z: 5.3, rotY: 75, scale: 1.1 },
  'Plant_11': { x: 23.9, y: 1.294, z: -4.8, rotY: 15, scale: 1 },
  'Plant_12': { x: 24.2, y: 1.294, z: 41.6, rotY: 60, scale: 1 },
  'Plant_13': { x: 24, y: 1.275, z: 36.4, rotY: 330, scale: 0.8 },
  'Plant_14': { x: 26.7, y: 1.157, z: 29.4, rotY: 225, scale: 0.7 },
  'Plant_15': { x: 18.1, y: 1.365, z: 32.2, rotY: 270, scale: 1 },
  'Plant_16': { x: 18.3, y: 1.106, z: 42.8, rotY: 345, scale: 1 },
  'Plant_17': { x: 28.4, y: 1.3, z: 52.5, rotY: 225, scale: 0.7 },
  'Plant_18': { x: 24.2, y: 1.145, z: 26, rotY: 225, scale: 1 },
  'Plant_19': { x: 18, y: 1.111, z: 28.5, rotY: 195, scale: 0.8 },
  'Plant_2': { x: 25.9, y: 1.279, z: -4.7, rotY: 0, scale: 1 },
  'Plant_20': { x: 26.6, y: 1.3, z: 52.7, rotY: 255, scale: 1 },
  'Plant_21': { x: 8.2, y: 1.281, z: 42.9, rotY: 120, scale: 0.7 },
  'Plant_22': { x: 24.7, y: 1.274, z: 52.5, rotY: 225, scale: 1 },
  'Plant_23': { x: 18.1, y: 1.147, z: 19.7, rotY: 150, scale: 0.643 },
  'Plant_24': { x: 18.2, y: 1.279, z: 16.2, rotY: 125, scale: 0.643 },
  'Plant_25': { x: 24.1, y: 1.272, z: 6.2, rotY: 249, scale: 0.541 },
  'Plant_26': { x: 29.5, y: 1.283, z: -4.5, rotY: 194, scale: 0.7 },
  'Plant_27': { x: 7.8, y: 1.353, z: 5.1, rotY: 60, scale: 0.848 },
  'Plant_28': { x: 9.1, y: 1.295, z: 5.2, rotY: 89, scale: 0.541 },
  'Plant_29': { x: 13.4, y: 1.295, z: 42.8, rotY: 90, scale: 0.7 },
  'Plant_3': { x: 24.2, y: 1.132, z: 21.8, rotY: 120, scale: 1 },
  'Plant_30': { x: 18, y: 1.303, z: 37.1, rotY: 120, scale: 0.7 },
  'Plant_31': { x: 23.9, y: 1.316, z: 38.6, rotY: 195, scale: 0.7 },
  'Plant_32': { x: 18.3, y: 1.293, z: 34.4, rotY: 150, scale: 0.6 },
  'Plant_4': { x: 18.1, y: 1.15, z: 5.1, rotY: 45, scale: 0.6 },
  'Plant_5': { x: 18.1, y: 1.272, z: 11, rotY: 135, scale: 0.9 },
  'Plant_6': { x: 28.1, y: 1.306, z: -4.7, rotY: 105, scale: 0.8 },
  'Plant_7': { x: 24.1, y: 1.362, z: 8.6, rotY: 315, scale: 1 },
  'Plant_8': { x: 24.1, y: 1.275, z: 11.4, rotY: 150, scale: 0.691 },
  'Plant_9': { x: 13.3, y: 1.312, z: 5.3, rotY: 240, scale: 0.7 },
}

/** Loose composite props (lampposts and their light overlays, Discord buttons) moved with
 *  the Test panel's Prop editor (propLayoutTool.ts). Keyed by composite entity NAME; every member of a
 *  prop is listed, so a lamp's post and its three light overlays stay together. Empty = a no-op. */
export interface PropPlacement { x: number; y: number; z: number; rotY?: number }
export const PROP_LAYOUT: Readonly<Record<string, PropPlacement>> = {
  // Baked 2026-09-29 12:35 from KJ's in-world Prop editor export (rotations the export left out
  // are kept from the previous bake where one existed).
  'Discord Button': { x: -17, y: 1.7, z: 46.6 },
  'Discord Button_2': { x: 39.5, y: 1.1, z: 2.1 },
  'PouchRack': { x: -29.3, y: 1.85, z: 45.2 },
  'FlowerShelf': { x: -21.5, y: 1.65, z: 53.5, rotY: 0 },
  'AlmanacWall': { x: -31.4, y: 2.38, z: 49.68, rotY: 270 },   // 2026-10-05: on the shelf (top y 2.34), +0.08 m right; collectionDisplay.ts has the fit
  'ExamTable': { x: -23.3, y: 1.8, z: 51.2, rotY: 0 },
  'PlanterSign': { x: -39.4, y: 3.45, z: 27.3, rotY: 270 },   // 2026-10-06: KJ's Prop editor export — on the nursery's west fence, right of the Nursery sign
  'GrowSign': { x: -39.4, y: 3.45, z: 20.7, rotY: 270 },      // 2026-10-06: KJ's Prop editor export (boxSystem.ts createInfoSigns)
  'ProgressBar_1': { x: 4.4, y: 2.6, z: 8.4 },
  'ProgressBar_2': { x: 4.5, y: 2.6, z: 39.7 },
  'ProgressBar_3': { x: 0.4, y: 4.75, z: 18.375 },
  'ProgressBar_4': { x: 0.4, y: 4.85, z: 29.61 },
}
