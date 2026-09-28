// =============================================================
// Bloom Garden v2 — Pour meter: the watering skill check (CLIENT ONLY)
//
// KJ 2026-09-27: "a skill check for watering, something that involves facing the right way with
// the camera and pressing for a random amount of time shown on the screen". Simple to learn, hard
// to master:
//   • PRESS AND HOLD on a plant to pour. There is no tap bypass (the 09-24 meter was switched off
//     because a tap overrode it); a quick tap just says "hold to pour".
//   • The meter fills only while the CAMERA faces the plant, and drains while you look away. It is
//     a camera-direction test rather than the pointer, so it behaves the same on a phone.
//   • The green window is RANDOM on every pour, and drawn on the meter — read it, don't memorise it.
//   • Let go anywhere before the red: watered. In the green: a perfect pour (the server adds
//     HOLD_SWEET_BONUS watered time) and the streak goes up. In the red, or held to full: too much
//     water, the plant is NOT watered. Any pour that is not perfect resets the streak.
//
// This file only measures and reports the outcome; wateringSystem does the watering.
// Render-only UI mounted from ui.tsx.
// =============================================================

import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { engine, inputSystem, InputAction, PointerEventType, Transform } from '@dcl/sdk/ecs'
import {
  HOLD_FILL_MS, HOLD_MIN_POUR, HOLD_SWEET_MIN_AT, HOLD_SWEET_MAX_AT, HOLD_SWEET_W_MIN, HOLD_SWEET_W_MAX,
  HOLD_OVER_GAP, HOLD_AIM_CONE_DEG, HOLD_DRAIN, HOLD_SWEET_BONUS, HOLD_SHOW_AFTER_MS,
} from './shared/config'

/** tap = too short or too little (nothing happens) · light = watered · sweet = perfect · over = too much */
export type PourOutcome = 'tap' | 'light' | 'sweet' | 'over'

const RESULT_MS        = 1_100
const HINT_MS          = 1_400   // "Press and hold to pour" after a quick tap
const RELEASE_GRACE_MS = 200     // isPressed can read false on the very frame the press starts

interface Hold {
  startAt: number
  level:   number                  // 0..1, accumulated: fills while aimed, drains while not
  lo: number; hi: number; over: number   // this pour's random green window and red line
  aimed:   boolean
  target:  { x: number; y: number; z: number }
  done:    number                  // local ms it resolved, 0 = still pouring
  outcome: PourOutcome
  report:  (o: PourOutcome) => void
}
let hold: Hold | null = null
let systemOn = false
let streak = 0                     // perfect pours in a row
let resultStreak = 0               // the streak as it stood when the shown result resolved

const DARK  = { r: 0.07, g: 0.063, b: 0.055, a: 0.9 }
const CREAM = { r: 0.957, g: 0.918, b: 0.824 }
const DIM   = { r: 0.83, g: 0.82, b: 0.78 }
const WATER = { r: 0.42, g: 0.72, b: 0.95 }
const GOOD  = { r: 0.35, g: 0.72, b: 0.5 }
const RED   = { r: 0.9, g: 0.36, b: 0.32 }
const GOLD  = { r: 0.98, g: 0.78, b: 0.3 }

const rand = (a: number, b: number): number => a + Math.random() * (b - a)

/** Call on pointer-down over a plant, with where the plant stands. `report` fires exactly once. */
export function beginHold(report: (outcome: PourOutcome) => void, target: { x: number; y: number; z: number }): void {
  if (!systemOn) { systemOn = true; engine.addSystem(holdSystem) }
  const lo = rand(HOLD_SWEET_MIN_AT, HOLD_SWEET_MAX_AT)
  const hi = Math.min(0.92, lo + rand(HOLD_SWEET_W_MIN, HOLD_SWEET_W_MAX))
  hold = { startAt: Date.now(), level: 0, lo, hi, over: Math.min(0.97, hi + HOLD_OVER_GAP), aimed: true, target, done: 0, outcome: 'tap', report }
}

export function isHolding(): boolean { return hold !== null && hold.done === 0 }

/** Is the camera facing the plant? Yaw only: the angle on the ground between where the camera
 *  looks and the line from the camera to the plant. Pitch is ignored — looking down at a low
 *  plant is still facing it. */
function facing(target: { x: number; z: number }): boolean {
  const cam = Transform.getOrNull(engine.CameraEntity)
  if (!cam) return true   // no camera yet: never punish the player for the engine
  const q = cam.rotation
  const fx = 2 * (q.x * q.z + q.w * q.y)
  const fz = 1 - 2 * (q.x * q.x + q.y * q.y)
  const dx = target.x - cam.position.x
  const dz = target.z - cam.position.z
  const lf = Math.hypot(fx, fz), ld = Math.hypot(dx, dz)
  if (lf < 1e-4 || ld < 0.5) return true   // looking straight down, or standing on it
  const cos = (fx * dx + fz * dz) / (lf * ld)
  return cos >= Math.cos((HOLD_AIM_CONE_DEG * Math.PI) / 180)
}

function resolve(now: number): void {
  if (!hold || hold.done !== 0) return
  const h = hold
  h.outcome = now - h.startAt < HOLD_SHOW_AFTER_MS || h.level < HOLD_MIN_POUR ? 'tap'
            : h.level >= h.over ? 'over'
            : h.level >= h.lo && h.level <= h.hi ? 'sweet'
            : 'light'
  // Any pour that is not perfect breaks the streak (KJ 2026-09-27: it only reset on too much);
  // a quick tap is not a pour, so it leaves the streak alone.
  if (h.outcome === 'sweet') streak++
  else if (h.outcome !== 'tap') streak = 0
  resultStreak = streak
  h.done = now
  h.report(h.outcome)
}

function holdSystem(dt: number): void {
  if (!hold || hold.done !== 0) return
  const now = Date.now()
  hold.aimed = facing(hold.target)
  const rate = (dt * 1000) / HOLD_FILL_MS
  hold.level = Math.max(0, Math.min(1, hold.level + (hold.aimed ? rate : -rate * HOLD_DRAIN)))
  const released = inputSystem.isTriggered(InputAction.IA_POINTER, PointerEventType.PET_UP)
                || (now - hold.startAt > RELEASE_GRACE_MS && !inputSystem.isPressed(InputAction.IA_POINTER))
  if (released || hold.level >= 1) resolve(now)
}

export function HoldMeterUi(props: { px: (n: number) => number; fs: (n: number) => number; mobile: boolean }) {
  if (!hold) return null
  const h = hold
  const now = Date.now()
  const shownFor = h.outcome === 'tap' ? HINT_MS : h.outcome === 'light' ? 500 : RESULT_MS
  if (h.done !== 0 && now >= h.done + shownFor) { hold = null; return null }
  if (h.done === 0 && now - h.startAt < HOLD_SHOW_AFTER_MS) return null   // a press only shows the meter once it is a hold
  const { px, fs } = props
  const w = props.mobile ? 440 : 380
  // 2026-09-28 ("prettier"): rounded to match every other bar in ui.tsx (the health ring's
  // fill has its own borderRadius, not just the track) — plain rectangles inside a pill
  // track read as a bug, not a style choice.
  const BAR_R = 13
  const seg = (from: number, to: number, color: { r: number; g: number; b: number }, a = 1) => (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { left: `${from * 100}%`, top: 0 }, width: `${Math.max(0, to - from) * 100}%`, height: '100%', borderRadius: px(BAR_R) }}
      uiBackground={{ color: { ...color, a } }}
    />
  )
  const over = h.level >= h.over
  const pouring = h.done === 0
  const line = pouring
    ? (!h.aimed ? 'Face the plant to pour' : over ? 'Too much!' : 'Let go in the green')
    : h.outcome === 'sweet' ? (resultStreak > 1 ? `Perfect pour  x${resultStreak}!` : `Perfect pour!  +${Math.round(HOLD_SWEET_BONUS * 100)}% water`)
    : h.outcome === 'over'  ? 'Too much water!'
    : h.outcome === 'tap'   ? 'Press and hold to pour'
    : 'Watered'
  const lineColor = pouring ? (!h.aimed ? GOLD : over ? RED : CREAM)
                  : h.outcome === 'sweet' ? GOLD : h.outcome === 'over' ? RED : h.outcome === 'tap' ? CREAM : DIM

  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: '58%', left: 0 }, width: '100%', flexDirection: 'row', justifyContent: 'center' }}>
      <UiEntity
        uiTransform={{ width: px(w), flexDirection: 'column', alignItems: 'center', padding: { left: px(20), right: px(20), top: px(14), bottom: px(16) }, borderRadius: px(20) }}
        uiBackground={{ color: DARK }}
      >
        <Label value={line} fontSize={fs(pouring ? 16 : 20)} color={{ ...lineColor, a: 1 }} textAlign="middle-center" textWrap="nowrap" uiTransform={{ width: '100%', height: fs(28), flexShrink: 0 }} />
        {/* the bar: water level, this pour's green window, and the red line after it */}
        <UiEntity uiTransform={{ display: h.outcome === 'tap' && !pouring ? 'none' : 'flex', width: '100%', height: px(26), margin: { top: px(8) }, borderRadius: px(BAR_R), flexShrink: 0 }} uiBackground={{ color: { r: 1, g: 1, b: 1, a: 0.14 } }}>
          {seg(0, h.level, over ? RED : WATER, h.aimed || !pouring ? 0.9 : 0.45)}
          {seg(h.lo, h.hi, GOOD, 0.65)}
          {seg(h.over, 1, RED, 0.5)}
        </UiEntity>
        <Label
          value={streak > 1 && pouring ? `Streak x${streak}` : ''}
          fontSize={fs(13)} color={{ ...GOLD, a: 0.9 }} textAlign="middle-center" textWrap="nowrap"
          uiTransform={{ display: streak > 1 && pouring ? 'flex' : 'none', width: '100%', height: fs(20), margin: { top: px(4) }, flexShrink: 0 }}
        />
      </UiEntity>
    </UiEntity>
  )
}
