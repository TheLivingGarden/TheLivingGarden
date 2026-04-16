// =============================================================
// The Living Garden — Vertical Progress Bars
//
// All bar positions are defined in BAR_DEFINITIONS — no Creator
// Hub placeholder entities required.  Each bar is a code-created
// background plate; fill and marker ticks are parented to it so
// they inherit rotation.  Labels are world-space so they render
// correctly regardless of bar orientation.
// =============================================================

import {
  engine,
  Entity,
  MeshRenderer,
  Material,
  MaterialTransparencyMode,
  Transform,
  TextShape,
} from '@dcl/sdk/ecs'
import { Color4, Quaternion } from '@dcl/sdk/math'
import { BLOOM_THRESHOLD, TOTAL_PLANTS } from './shared/config'

// ===============================================================
// ██████╗  █████╗ ██████╗      ██████╗ ██████╗ ███╗   ██╗███████╗██╗ ██████╗
// ██╔══██╗██╔══██╗██╔══██╗    ██╔════╝██╔═══██╗████╗  ██║██╔════╝██║██╔════╝
// ██████╔╝███████║██████╔╝    ██║     ██║   ██║██╔██╗ ██║█████╗  ██║██║  ███╗
// ██╔══██╗██╔══██║██╔══██╗    ██║     ██║   ██║██║╚██╗██║██╔══╝  ██║██║   ██║
// ██████╔╝██║  ██║██║  ██║    ╚██████╗╚██████╔╝██║ ╚████║██║     ██║╚██████╔╝
// ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝     ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝     ╚═╝ ╚═════╝
//
//  No Creator Hub entities required — all bar positions live here.
//  Add / remove entries in BAR_DEFINITIONS to place bars in the scene.
// ===============================================================

// ── Bar positions & dimensions ───────────────────────────────────
// Each entry defines one bar's world-space anchor.
// rotation: euler degrees (pitch X, yaw Y, roll Z)
//           { x:0, y:0,   z:0 } = faces +Z
//           { x:0, y:90,  z:0 } = faces +X (rotated 90° right)
//           { x:0, y:180, z:0 } = faces -Z (flipped)
const BAR_DEFINITIONS: Array<{
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number }   // euler degrees
  width:    number   // metres
  height:   number   // metres
  depth:    number   // metres (keep thin, e.g. 0.06)
}> = [
  // ── placeholder positions — replace with your actual locations ──
  { position: { x: 4.425,  y: 1, z: 13.25 }, rotation: { x:0, y:0, z:0 }, width: 0.25, height: 3, depth: 0.06 },
  { position: { x: 4.45,  y: 1, z: 34.75 }, rotation: { x:0, y:180, z:0 }, width: 0.25, height: 3, depth: 0.06 },
  { position: { x: 0.4, y: 3, z: 18.375 }, rotation: { x:0, y:-90, z:0 }, width: 0.35, height: 5, depth: 0.06 },
  { position: { x: 0.4, y: 3, z: 29.61 }, rotation: { x:0, y:-90, z:0 }, width: 0.35, height: 5, depth: 0.06 },
]

// ── Shape ────────────────────────────────────────────────────────
const BAR_LIFT_M        = 1      // world-space upward offset (metres)

// ── Fill thresholds (0–1 ratio of total plants) ───────────────────
const ORANGE_RATIO = 0.50        // red → orange at this fraction
// green threshold is driven by BLOOM_THRESHOLD / TOTAL_PLANTS

// ── Background ───────────────────────────────────────────────────
const BG_COLOR     = { r: 0.08, g: 0.08, b: 0.10, a: 0.5 }
const BG_EMISSIVE  = { r: 0.08, g: 0.08, b: 0.10 }
const BG_EMISSION  = 0.4

// ── Fill colours & emission ───────────────────────────────────────
const FILL_RED_COLOR    = { r: 0.90, g: 0.18, b: 0.18 }
const FILL_ORANGE_COLOR = { r: 1.00, g: 0.50, b: 0.05 }
const FILL_GREEN_COLOR  = { r: 0.20, g: 0.88, b: 0.35 }
const FILL_EMISSION     = 1.2    // emissive intensity for all fill states

// ── Marker ticks ──────────────────────────────────────────────────
const TICK_THICK_NORMAL_M    = 0.028   // world height of a standard tick (metres)
const TICK_THICK_THRESHOLD_M = 0.045   // world height of the threshold tick (metres)
const MARKER_COLOR      = { r: 0.85, g: 0.85, b: 0.85 }
const MARKER_EMISSION   = 0.7
const THRESHOLD_COLOR   = { r: 1.00, g: 0.84, b: 0.10 }   // gold at 80%
const THRESHOLD_EMISSION = 1.6

// ── Marker label font sizes & position ───────────────────────────
const LABEL_FONT_SIZE           = 1
const LABEL_FONT_SIZE_THRESHOLD = 1.5
// World-space gap between the bar's right edge and the label (metres)
// Positive = further right, negative = overlap the bar
const LABEL_OFFSET_M            = 0.2

// ── Tween ─────────────────────────────────────────────────────────
// Speed in ratio-units per second. 0.6 ≈ full bar fills in ~1.7 s.
const TWEEN_SPEED = 0.6

// ── Sparkles ──────────────────────────────────────────────────────
const SPARK_COUNT       = 6      // particles spawned per burst
const SPARK_LIFETIME    = 0.85   // seconds
const SPARK_RISE        = 1.6    // upward speed m/s
const SPARK_SPREAD      = 0.35   // max lateral speed m/s
const SPARK_SIZE        = 0.065  // initial cube size (metres)
const SPARK_MAX_LIVE    = 30     // hard cap on total live spark entities
const SPARK_COOLDOWN_MS = 800    // minimum ms between bursts per bar
// Warm golden glow — looks like sunlit water droplets
const SPARK_ALBEDO   = Color4.create(1.0, 0.92, 0.45, 1)
const SPARK_EMISSIVE = { r: 1.0, g: 0.88, b: 0.3 }
const SPARK_EMISSION = 3.5

// ===============================================================
//                  end of config
// ===============================================================

// Small world-space gap between background and fill (metres)
const FILL_INSET = 0.015
// Fill/tick depth is capped so thick-depth placeholders don't produce brick-like fills
const MAX_FILL_DEPTH_M = 0.06
const MAX_TICK_DEPTH_M = 0.025

// Marker ticks — fraction of bar height (0–1)
const MARKERS: Array<{ ratio: number; label: string; isThreshold?: boolean }> = [
  { ratio: 0.25, label: '25%'                    },
  { ratio: 0.50, label: '50%'                    },
  { ratio: 0.80, label: '80%', isThreshold: true },
]

// Derived colour constants (Color4 from config above)
const COLOR_BG          = Color4.create(BG_COLOR.r,          BG_COLOR.g,          BG_COLOR.b,          BG_COLOR.a)
const COLOR_FILL_RED    = Color4.create(FILL_RED_COLOR.r,    FILL_RED_COLOR.g,    FILL_RED_COLOR.b,    1)
const COLOR_FILL_ORANGE = Color4.create(FILL_ORANGE_COLOR.r, FILL_ORANGE_COLOR.g, FILL_ORANGE_COLOR.b, 1)
const COLOR_FILL_GREEN  = Color4.create(FILL_GREEN_COLOR.r,  FILL_GREEN_COLOR.g,  FILL_GREEN_COLOR.b,  1)
const COLOR_MARKER      = Color4.create(MARKER_COLOR.r,      MARKER_COLOR.g,      MARKER_COLOR.b,      1)
const COLOR_THRESHOLD   = Color4.create(THRESHOLD_COLOR.r,   THRESHOLD_COLOR.g,   THRESHOLD_COLOR.b,   1)

const BLOOM_RATIO = BLOOM_THRESHOLD / TOTAL_PLANTS

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------

interface Bar {
  fill:         Entity
  targetRatio:  number   // where the bar should end up
  displayRatio: number   // currently rendered (lerps toward targetRatio)
  fillScaleX:   number
  fillScaleZ:   number
  fillFrontZ:   number
  minFillH:     number
  worldX:       number   // world-space bar centre X
  worldY:       number   // world-space bar centre Y (lifted)
  worldZ:       number   // world-space bar centre Z
  barHeight:    number   // world height of bar (metres)
  lastSparkMs:  number   // timestamp of last spark burst — for cooldown
}

interface PooledSpark {
  entity:  Entity
  active:  boolean
  x: number; y: number; z: number
  vx: number; vy: number; vz: number
  life:    number   // remaining seconds
  maxLife: number
}

const bars:      Bar[]         = []
const sparkPool: PooledSpark[] = []

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

/** Activate pool slots at the fill tip of a bar. No entities are created. */
function spawnSparks(bar: Bar): void {
  const now = Date.now()
  if (now - bar.lastSparkMs < SPARK_COOLDOWN_MS) return   // per-bar cooldown
  bar.lastSparkMs = now

  const tipY = bar.worldY + (bar.targetRatio - 0.5) * bar.barHeight
  let spawned = 0
  for (const s of sparkPool) {
    if (spawned >= SPARK_COUNT) break
    if (s.active) continue
    const angle = Math.random() * Math.PI * 2
    const speed = Math.random() * SPARK_SPREAD
    s.x      = bar.worldX + Math.cos(angle) * speed * 0.1
    s.y      = tipY
    s.z      = bar.worldZ + Math.sin(angle) * speed * 0.1
    s.vx     = Math.cos(angle) * speed
    s.vy     = SPARK_RISE * (0.7 + Math.random() * 0.6)
    s.vz     = Math.sin(angle) * speed
    s.life   = SPARK_LIFETIME
    s.maxLife = SPARK_LIFETIME
    s.active = true
    const tf = Transform.getMutable(s.entity)
    tf.position = { x: s.x, y: s.y, z: s.z }
    tf.scale    = { x: SPARK_SIZE, y: SPARK_SIZE, z: SPARK_SIZE }
    spawned++
  }
}

// ---------------------------------------------------------------
// Setup
// ---------------------------------------------------------------

export function setupProgressBars(): void {
  for (const def of BAR_DEFINITIONS) {
    const sx = def.width   // world width
    const sy = def.height  // world height
    const sz = def.depth   // world depth
    const px = def.position.x
    const py = def.position.y + BAR_LIFT_M   // lifted
    const pz = def.position.z
    const quat = Quaternion.fromEulerDegrees(def.rotation.x, def.rotation.y, def.rotation.z)
    const { x: qx, y: qy, z: qz, w: qw } = quat

    // ── Background plate — code-created entity, no Creator Hub dependency ─
    const ph = engine.addEntity()
    Transform.create(ph, {
      position: { x: px, y: py, z: pz },
      rotation: quat,
      scale:    { x: sx, y: sy, z: sz },
    })
    MeshRenderer.setBox(ph)
    Material.setPbrMaterial(ph, {
      albedoColor:       COLOR_BG,
      emissiveColor:     BG_EMISSIVE,
      emissiveIntensity: BG_EMISSION,
      transparencyMode:  MaterialTransparencyMode.MTM_ALPHA_BLEND,
    })

    // ── Precompute local-space fill geometry ───────────────────────
    const fillWorldDepth = Math.min(sz - 2 * FILL_INSET, MAX_FILL_DEPTH_M)
    const fillScaleX     = (sx - 2 * FILL_INSET) / sx
    const fillScaleZ     = Math.max(0.05, fillWorldDepth / sz)
    const fillFrontZ     = 0.5 + 0.005 / sz
    const tickFrontZ     = 0.5 + 0.010 / sz
    const minFillH       = 0.001 / sy

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
      emissiveColor:     FILL_RED_COLOR,
      emissiveIntensity: FILL_EMISSION,
    })
    bars.push({
      fill,
      targetRatio:  0,
      displayRatio: 0,
      fillScaleX,
      fillScaleZ,
      fillFrontZ,
      minFillH,
      worldX:      px,
      worldY:      py,
      worldZ:      pz,
      barHeight:   sy,
      lastSparkMs: 0,
    })

    // ── Marker ticks — children of background ─────────────────────
    const tickWorldDepth = Math.min(sz, MAX_TICK_DEPTH_M)
    const rx = quatRightX(qx, qy, qz, qw)
    const rz = quatRightZ(qx, qy, qz, qw)

    for (const m of MARKERS) {
      const localY     = m.ratio - 0.5
      const tickThickL = (m.isThreshold ? TICK_THICK_THRESHOLD_M : TICK_THICK_NORMAL_M) / sy
      const tickWideL  = (sx + 0.06) / sx
      const tickDeepL  = tickWorldDepth / sz

      const color    = m.isThreshold ? COLOR_THRESHOLD : COLOR_MARKER
      const emissive = m.isThreshold ? THRESHOLD_COLOR : MARKER_COLOR

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
        emissiveIntensity: m.isThreshold ? THRESHOLD_EMISSION : MARKER_EMISSION,
      })

      const labelDist = sx * 0.5 + LABEL_OFFSET_M
      const labelX    = px + rx * labelDist
      const labelY    = py + (m.ratio - 0.5) * sy
      const labelZ    = pz + rz * labelDist

      const label = engine.addEntity()
      Transform.create(label, {
        position: { x: labelX, y: labelY, z: labelZ },
        rotation: quat,
      })
      TextShape.create(label, {
        text:      m.label,
        fontSize:  m.isThreshold ? LABEL_FONT_SIZE_THRESHOLD : LABEL_FONT_SIZE,
        textColor: m.isThreshold ? COLOR_THRESHOLD : COLOR_MARKER,
      })
    }
  }

  // ── Pre-allocate spark pool — no entity creation during gameplay ─
  for (let i = 0; i < SPARK_MAX_LIVE; i++) {
    const e = engine.addEntity()
    Transform.create(e, {
      position: { x: 0, y: 0, z: 0 },
      scale:    { x: 0, y: 0, z: 0 },   // hidden until activated
    })
    MeshRenderer.setBox(e)
    Material.setPbrMaterial(e, {
      albedoColor:       SPARK_ALBEDO,
      emissiveColor:     SPARK_EMISSIVE,
      emissiveIntensity: SPARK_EMISSION,
    })
    sparkPool.push({ entity: e, active: false, x:0, y:0, z:0, vx:0, vy:0, vz:0, life:0, maxLife:0 })
  }

  // ── Tween + sparkle system ──────────────────────────────────────
  engine.addSystem((dt: number) => {
    // Tween fills toward their target ratios
    for (const bar of bars) {
      if (bar.displayRatio === bar.targetRatio) continue
      const diff = bar.targetRatio - bar.displayRatio
      const step = TWEEN_SPEED * dt
      bar.displayRatio = Math.abs(diff) <= step
        ? bar.targetRatio
        : bar.displayRatio + Math.sign(diff) * step

      const fillH   = Math.max(bar.minFillH, bar.displayRatio)
      const centreY = -0.5 + fillH / 2
      const tf = Transform.getMutable(bar.fill)
      tf.position = { x: 0, y: centreY,       z: bar.fillFrontZ }
      tf.scale    = { x: bar.fillScaleX, y: fillH, z: bar.fillScaleZ }
    }

    // Animate and return expired sparks to the pool
    for (const s of sparkPool) {
      if (!s.active) continue
      s.life -= dt
      if (s.life <= 0) {
        s.active = false
        Transform.getMutable(s.entity).scale = { x: 0, y: 0, z: 0 }
        continue
      }
      s.x += s.vx * dt
      s.y += s.vy * dt
      s.z += s.vz * dt
      s.vy -= 2.5 * dt   // gentle gravity pull
      const progress = s.life / s.maxLife
      const sc = SPARK_SIZE * progress
      const tf = Transform.getMutable(s.entity)
      tf.position = { x: s.x, y: s.y, z: s.z }
      tf.scale    = { x: sc, y: sc, z: sc }
    }
  })

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
  const emissive = isGreen ? FILL_GREEN_COLOR  : isOrange ? FILL_ORANGE_COLOR  : FILL_RED_COLOR

  for (const bar of bars) {
    if (bar.targetRatio === ratio) continue

    const increased = ratio > bar.targetRatio
    bar.targetRatio = ratio

    // Update fill colour immediately so it matches the new state
    Material.setPbrMaterial(bar.fill, {
      albedoColor:       albedo,
      emissiveColor:     emissive,
      emissiveIntensity: FILL_EMISSION,
    })

    // Sparkles only when the bar is going up
    if (increased) spawnSparks(bar)
  }
}
