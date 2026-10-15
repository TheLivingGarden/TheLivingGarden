// =============================================================
// The Living Garden — Fairy Light System
//
// ONE model (FairyLights_1_High — the fairy and trellis strings consolidated, KJ 2026-10-01) whose emission emissiveGlow.ts sets.
//
// KJ 2026-10-01: "they tween constantly — only tween them during the bloom and just have a soft glow the rest of the time". So:
//   - the rest of the time (including the pre-bloom build-up) they hold ONE steady soft glow: a single write, then nothing;
//   - during a bloom they BREATHE: a slow eased fade up to bright, a pause, a slow fade back down, and again (week-4 review, KJ 2026-10-15:
//     the random Low / Mid / High twinkle "came across as a glitch or bug"). Every write is a material re-apply across the whole model
//     (46 primitives), so the step stays coarse enough for a few writes a second.
//   - when the bloom ends they ease back to the soft glow and stop.
// =============================================================

import { engine, timers } from '@dcl/sdk/ecs'
import { Glow, makeGlow, setGlowTarget, snapGlow } from './emissiveGlow'

// ── Bloom breathing ───────────────────────────────────────────
const BREATHE_LOW   = 0.65    // TUNING — fractions of the model's full emission. The top stays under 0.995: at full strength emissiveGlow
const BREATHE_HIGH  = 0.97    // removes its override, and a material swap every breath would be its own pop.
const FADE_S        = 2.5     // TUNING — one fade, seconds (eased in and out)
const HOLD_MIN_MS   = 400     // a short, slightly irregular rest at each end so a garden of strings doesn't feel mechanical
const HOLD_MAX_MS   = 1_200
const SETTLE_S      = 3       // fading back to the soft glow when the bloom ends

// ── The model ─────────────────────────────────────────────────
const MODEL_ENTITY = 'FairyLights_1_High.glb'   // the composite entity name

// As exported (read from the GLB): all materials are base 0.8/0.3/0, emissive 1/0.342/0, glTF emissive strength 1.5.
// step 0.03: a 0.32 breath is ~11 writes over 2.5 s — fine enough not to read as stepping, few enough for phones.
// unit 2.5 (was 1.5, the GLB's own emissive strength): KJ 2026-10-15, "they look turned off when no bloom". The resting glow was 0.6 × 1.5 =
// 0.9, well under the 1.5 the model shows as exported, and in golden-hour light that read as unlit. Every level here is an override (the
// breath tops out under 0.995, see BREATHE_HIGH), so `unit` simply sets the scale: rest 0.5 × 2.5 = 1.25 (clearly on, a little softer than
// the export), a Bloom breath 1.6 – 2.4.
const LOOK = { color: { r: 1, g: 0.342, b: 0 }, albedo: { r: 0.8, g: 0.3, b: 0 }, metallic: 0, roughness: 0.5, unit: 2.5, step: 0.03 }
const SOFT_GLOW = 0.5   // TUNING — the resting glow, as a fraction of `unit`

let glow: Glow | null = null
let breatheGen = 0
let rising = true

function rnd(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

/** Fade to the other end, then rest, then turn round — until the bloom ends (a newer generation). */
function breathe(gen: number): void {
  if (breatheGen !== gen || glow === null) return
  setGlowTarget(glow, rising ? BREATHE_HIGH : BREATHE_LOW, FADE_S)
  rising = !rising
  timers.setTimeout(() => breathe(gen), FADE_S * 1000 + rnd(HOLD_MIN_MS, HOLD_MAX_MS))
}

// ── Public API ────────────────────────────────────────────────

/** Call once at scene startup. */
export function setupFairyLights(): void {
  const entity = engine.getEntityOrNullByName(MODEL_ENTITY)
  if (!entity) {
    console.log(`[FairyLights] no "${MODEL_ENTITY}" entity in the composite — skipping`)
    return
  }
  glow = makeGlow(entity, LOOK, 1, FADE_S)
  snapGlow(glow, SOFT_GLOW)   // the resting glow, written once as soon as the model has loaded
  console.log('[FairyLights] Ready — one consolidated model, steady soft glow')
}

/** Bloom on: breathe (slow, eased, regular). Bloom off: ease back to the steady soft glow and stop. */
export function setFairyLightsBloom(active: boolean): void {
  breatheGen++
  if (glow === null) return
  if (active) {
    rising = true
    breathe(breatheGen)
  } else {
    setGlowTarget(glow, SOFT_GLOW, SETTLE_S)
  }
}

/** The pre-bloom build-up no longer changes the fairy lights (they only move during the bloom itself). Kept so callers need no change. */
export function setFairyLightsPreboom(_active: boolean): void { /* intentionally nothing */ }
