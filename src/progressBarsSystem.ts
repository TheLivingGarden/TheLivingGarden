// =============================================================
// The Living Garden — Vertical Progress Bars
//
// Each bar's transform is read from a BarPlaceholder_N entity
// placed in Creator Hub.  The placeholder's GltfContainer is
// removed and it is repurposed as the background plate.
// Fill and marker ticks are parented to it (inherit rotation).
// Labels are world-space + BillboardMode.BM_Y so they always
// face the player regardless of which way the bar is oriented.
// =============================================================

import {
  engine,
  Entity,
  GltfContainer,
  MeshRenderer,
  Material,
  MaterialTransparencyMode,
  Transform,
  TextShape,
} from '@dcl/sdk/ecs'
import { Color4 } from '@dcl/sdk/math'
import { BLOOM_THRESHOLD, TOTAL_PLANTS } from './shared/config'

// ---------------------------------------------------------------
// Placeholder names — created in Creator Hub
// ---------------------------------------------------------------

const PLACEHOLDER_NAMES = [
  'BarPlaceholder_1',
  'BarPlaceholder_2',
  'BarPlaceholder_3',
  'BarPlaceholder_4',
]

// How much taller to make the bars compared to the placeholder's Y scale
const HEIGHT_MULTIPLIER = 6
// Width (X) multiplier
const WIDTH_MULTIPLIER  = .6
// Depth (Z) multiplier — shrinks the bar to a thin slab
const DEPTH_MULTIPLIER  = 0.2
// World-space upward offset applied to every bar (metres)
const BAR_LIFT_M        = 1

// Small world-space gap between background and fill (metres)
const FILL_INSET = 0.015
// Fill/tick depth is capped so thick-depth placeholders don't produce brick-like fills
const MAX_FILL_DEPTH_M = 0.06   // 6 cm max world depth for fill
const MAX_TICK_DEPTH_M = 0.025  // 2.5 cm max world depth for ticks

// Marker ticks — fraction of bar height (0–1)
const MARKERS: Array<{ ratio: number; label: string; isThreshold?: boolean }> = [
  { ratio: 0.25, label: '25%'                    },
  { ratio: 0.50, label: '50%'                    },
  { ratio: 0.80, label: '80%', isThreshold: true },
]

// ---------------------------------------------------------------
// Colours
// ---------------------------------------------------------------

const COLOR_BG          = Color4.create(0.08, 0.08, 0.10, 0.75)
const COLOR_FILL_RED    = Color4.create(0.90, 0.18, 0.18, 1)
const COLOR_FILL_ORANGE = Color4.create(1.00, 0.50, 0.05, 1)
const COLOR_FILL_GREEN  = Color4.create(0.20, 0.88, 0.35, 1)
const COLOR_MARKER      = Color4.create(0.85, 0.85, 0.85, 1)
const COLOR_THRESHOLD   = Color4.create(1.00, 0.84, 0.10, 1)

const EMISSIVE_RED    = { r: 0.90, g: 0.18, b: 0.18 }
const EMISSIVE_ORANGE = { r: 1.00, g: 0.50, b: 0.05 }
const EMISSIVE_GREEN  = { r: 0.20, g: 0.88, b: 0.35 }

const BLOOM_RATIO  = BLOOM_THRESHOLD / TOTAL_PLANTS
const ORANGE_RATIO = 0.50

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------

interface Bar {
  fill:       Entity
  lastRatio:  number
  fillScaleX: number
  fillScaleZ: number
  fillFrontZ: number
  minFillH:   number
}

const bars: Bar[] = []

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

/** World-space +X (right) component from quaternion. */
function quatRightX(qx: number, qy: number, qz: number, qw: number): number {
  return 1 - 2 * (qy * qy + qz * qz)
}
/** World-space +X (right) Z component from quaternion. */
function quatRightZ(qx: number, qy: number, qz: number, qw: number): number {
  return 2 * (qx * qz - qy * qw)
}

// ---------------------------------------------------------------
// Setup
// ---------------------------------------------------------------

export function setupProgressBars(): void {
  for (const name of PLACEHOLDER_NAMES) {
    const ph = engine.getEntityOrNullByName(name)
    if (!ph) { console.log(`[ProgressBars] ${name} not found`); continue }

    const tf = Transform.getOrNull(ph)
    if (!tf) { console.log(`[ProgressBars] ${name} has no Transform`); continue }

    const sx = tf.scale.x * WIDTH_MULTIPLIER   // world width
    const sy = tf.scale.y * HEIGHT_MULTIPLIER  // world height (scaled up)
    const sz = tf.scale.z * DEPTH_MULTIPLIER   // world depth  (thinned)
    const px = tf.position.x
    const py = tf.position.y + BAR_LIFT_M      // lifted
    const pz = tf.position.z
    const { x: qx, y: qy, z: qz, w: qw } = tf.rotation

    // ── Remove Creator Hub's original mesh, then set our background ─
    // Creator Hub places primitives as GltfContainer; if we leave it
    // alongside MeshRenderer.setBox both render at once (produces the
    // pink/salmon double-mesh seen in the screenshot).
    GltfContainer.deleteFrom(ph)
    // Write adjusted dimensions back so the background box and all parented
    // children (fill, ticks) reflect the new height, depth, and position.
    const phTf      = Transform.getMutable(ph)
    phTf.scale.x    = sx
    phTf.scale.y    = sy
    phTf.scale.z    = sz
    phTf.position.y = py
    MeshRenderer.setBox(ph)
    Material.setPbrMaterial(ph, {
      albedoColor:       COLOR_BG,
      emissiveColor:     { r: 0.08, g: 0.08, b: 0.10 },
      emissiveIntensity: 0.4,
      transparencyMode:  MaterialTransparencyMode.MTM_ALPHA_BLEND,
    })

    // ── Precompute local-space fill geometry ───────────────────────
    // Fill depth is capped to MAX_FILL_DEPTH_M so a square-cross-section
    // placeholder (sz ≈ sx) doesn't produce a thick brick-shaped fill.
    const fillWorldDepth = Math.min(sz - 2 * FILL_INSET, MAX_FILL_DEPTH_M)
    const fillScaleX     = (sx - 2 * FILL_INSET) / sx
    const fillScaleZ     = Math.max(0.05, fillWorldDepth / sz)
    const fillFrontZ     = 0.5 + 0.005 / sz   // 5 mm proud of front face (local Z)
    const tickFrontZ     = 0.5 + 0.010 / sz   // ticks slightly further out
    const minFillH       = 0.001 / sy          // 1 mm minimum visible fill

    // ── Fill — child of background, grows from bottom upward ───────
    const fill = engine.addEntity()
    Transform.create(fill, {
      parent:   ph,
      position: { x: 0, y: -0.5 + minFillH / 2, z: fillFrontZ },
      scale:    { x: fillScaleX, y: minFillH, z: fillScaleZ },
    })
    MeshRenderer.setBox(fill)
    Material.setPbrMaterial(fill, {
      albedoColor:       COLOR_FILL_RED,
      emissiveColor:     EMISSIVE_RED,
      emissiveIntensity: 0.5,
    })
    bars.push({ fill, lastRatio: -1, fillScaleX, fillScaleZ, fillFrontZ, minFillH })

    // ── Marker ticks — children of background ─────────────────────
    const tickWorldDepth = Math.min(sz, MAX_TICK_DEPTH_M)
    const rx = quatRightX(qx, qy, qz, qw)
    const rz = quatRightZ(qx, qy, qz, qw)

    for (const m of MARKERS) {
      const localY     = m.ratio - 0.5              // -0.5 = bottom, +0.5 = top
      const tickThickL = (m.isThreshold ? 0.045 : 0.028) / sy
      const tickWideL  = (sx + 0.06) / sx           // slightly wider than bar
      const tickDeepL  = tickWorldDepth / sz

      const color    = m.isThreshold ? COLOR_THRESHOLD : COLOR_MARKER
      const emissive = m.isThreshold
        ? { r: 1.0, g: 0.84, b: 0.10 }
        : { r: 0.85, g: 0.85, b: 0.85 }

      const tick = engine.addEntity()
      Transform.create(tick, {
        parent:   ph,
        position: { x: 0, y: localY, z: tickFrontZ },
        scale:    { x: tickWideL, y: tickThickL, z: tickDeepL },
      })
      MeshRenderer.setBox(tick)
      Material.setPbrMaterial(tick, {
        albedoColor:       color,
        emissiveColor:     emissive,
        emissiveIntensity: m.isThreshold ? 1.6 : 0.7,
      })

      // ── Label — world-space, rotated to match the bar's facing ───
      // Not parented (avoids TextShape distortion from non-uniform parent scale).
      // The label inherits the bar's Y rotation so it faces the same direction
      // as the bar's front face instead of defaulting to global +Z.
      const labelDist = sx * 0.5 + 0.14
      const labelX    = px + rx * labelDist
      const labelY    = py + (m.ratio - 0.5) * sy
      const labelZ    = pz + rz * labelDist

      const label = engine.addEntity()
      Transform.create(label, {
        position: { x: labelX, y: labelY, z: labelZ },
        rotation: tf.rotation,   // same Y rotation as the bar → text faces bar front
      })
      TextShape.create(label, {
        text:      m.label,
        fontSize:  m.isThreshold ? 2.4 : 1.9,
        textColor: m.isThreshold ? COLOR_THRESHOLD : COLOR_MARKER,
      })
    }
  }

  console.log(`[ProgressBars] ${bars.length} bars ready`)
}

// ---------------------------------------------------------------
// Update — call whenever the watered count changes
// ---------------------------------------------------------------

export function updateProgressBars(wateredCount: number, total: number): void {
  const ratio    = total > 0 ? Math.min(wateredCount / total, 1) : 0
  const isGreen  = ratio >= BLOOM_RATIO
  const isOrange = !isGreen && ratio >= ORANGE_RATIO

  const albedo   = isGreen ? COLOR_FILL_GREEN  : isOrange ? COLOR_FILL_ORANGE  : COLOR_FILL_RED
  const emissive = isGreen ? EMISSIVE_GREEN     : isOrange ? EMISSIVE_ORANGE    : EMISSIVE_RED

  for (const bar of bars) {
    if (bar.lastRatio === ratio) continue
    bar.lastRatio = ratio

    const fillH   = Math.max(bar.minFillH, ratio)
    const centreY = -0.5 + fillH / 2

    const tf = Transform.getMutable(bar.fill)
    tf.position = { x: 0, y: centreY,       z: bar.fillFrontZ }
    tf.scale    = { x: bar.fillScaleX, y: fillH, z: bar.fillScaleZ }

    Material.setPbrMaterial(bar.fill, {
      albedoColor:       albedo,
      emissiveColor:     emissive,
      emissiveIntensity: 0.5,
    })
  }
}
