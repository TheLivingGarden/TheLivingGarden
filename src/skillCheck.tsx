// =============================================================
// Bloom Garden v2 — Hold-to-pour meter (CLIENT ONLY)
//
// Playtest 2026-09-24: the timing bar felt wrong. Now you PRESS AND HOLD on a plant to pour.
// A tap waters as always. Holding fills a meter: let go in the green for a just-right pour
// (server adds HOLD_SWEET_BONUS watered time); let it go past the red mark, or let it fill,
// and it is too much water — the plant is not watered.
//
// This file only measures and reports the outcome; wateringSystem does the watering.
// Release = pointer up, or the button no longer being held. Render-only UI mounted from ui.tsx.
// =============================================================

import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { engine, inputSystem, InputAction, PointerEventType } from '@dcl/sdk/ecs'
import { HOLD_FILL_MS, HOLD_SWEET_LO, HOLD_SWEET_HI, HOLD_OVER_AT, HOLD_SWEET_BONUS, HOLD_SHOW_AFTER_MS } from './shared/config'

export type PourOutcome = 'tap' | 'light' | 'sweet' | 'over'

const RESULT_MS = 900
const RELEASE_GRACE_MS = 200   // isPressed can read false on the very frame the press starts

interface Hold { startAt: number; done: number; outcome: PourOutcome; report: (o: PourOutcome) => void }
let hold: Hold | null = null
let systemOn = false

const DARK  = { r: 0.07, g: 0.063, b: 0.055, a: 0.9 }
const CREAM = { r: 0.957, g: 0.918, b: 0.824 }
const WATER = { r: 0.42, g: 0.72, b: 0.95 }
const GOOD  = { r: 0.35, g: 0.72, b: 0.5 }
const RED   = { r: 0.9, g: 0.36, b: 0.32 }
const GOLD  = { r: 0.98, g: 0.78, b: 0.3 }

const level = (now: number, h: Hold) => Math.min(1, (now - h.startAt) / HOLD_FILL_MS)

/** Call on pointer-down over a plant. `report` fires exactly once, on release. */
export function beginHold(report: (outcome: PourOutcome) => void): void {
  if (!systemOn) { systemOn = true; engine.addSystem(holdSystem) }
  hold = { startAt: Date.now(), done: 0, outcome: 'tap', report }
}

export function isHolding(): boolean { return hold !== null && hold.done === 0 }

function resolve(now: number): void {
  if (!hold || hold.done !== 0) return
  const held = now - hold.startAt
  const l = level(now, hold)
  hold.outcome = held < HOLD_SHOW_AFTER_MS ? 'tap'
               : l > HOLD_OVER_AT ? 'over'
               : l >= HOLD_SWEET_LO && l <= HOLD_SWEET_HI ? 'sweet'
               : 'light'
  hold.done = now
  hold.report(hold.outcome)
}

function holdSystem(): void {
  if (!hold || hold.done !== 0) return
  const now = Date.now()
  const released = inputSystem.isTriggered(InputAction.IA_POINTER, PointerEventType.PET_UP)
                || (now - hold.startAt > RELEASE_GRACE_MS && !inputSystem.isPressed(InputAction.IA_POINTER))
  if (released || level(now, hold) >= 1) resolve(now)
}

export function HoldMeterUi(props: { px: (n: number) => number; fs: (n: number) => number; mobile: boolean }) {
  if (!hold) return null
  const now = Date.now()
  if (hold.done !== 0 && (now >= hold.done + RESULT_MS || hold.outcome === 'tap' || hold.outcome === 'light')) { hold = null; return null }
  if (hold.done === 0 && now - hold.startAt < HOLD_SHOW_AFTER_MS) return null   // a tap never shows the meter
  const { px, fs } = props
  const w = props.mobile ? 420 : 360
  const l = level(hold.done !== 0 ? hold.done : now, hold)
  const seg = (from: number, to: number, color: { r: number; g: number; b: number }, a = 1) => (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { left: `${from * 100}%`, top: 0 }, width: `${(to - from) * 100}%`, height: '100%' }}
      uiBackground={{ color: { ...color, a } }}
    />
  )
  const over = l > HOLD_OVER_AT
  const result = hold.done === 0 ? ''
               : hold.outcome === 'sweet' ? `Just right!  +${Math.round(HOLD_SWEET_BONUS * 100)}% water`
               : hold.outcome === 'over' ? 'Too much water!' : ''
  const resultColor = hold.outcome === 'sweet' ? GOLD : RED

  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: '58%', left: 0 }, width: '100%', flexDirection: 'row', justifyContent: 'center' }}>
      <UiEntity
        uiTransform={{ width: px(w), flexDirection: 'column', alignItems: 'center', padding: { left: px(20), right: px(20), top: px(14), bottom: px(16) }, borderRadius: px(20) }}
        uiBackground={{ color: DARK }}
      >
        <Label
          value={hold.done === 0 ? (over ? 'Too much!' : 'Keep holding - let go in the green') : result}
          fontSize={fs(hold.done === 0 ? 15 : 20)} color={{ ...(hold.done === 0 ? (over ? RED : CREAM) : resultColor), a: 1 }}
          textAlign="middle-center" textWrap="nowrap" uiTransform={{ width: '100%', height: fs(28) }}
        />
        <UiEntity uiTransform={{ width: '100%', height: px(26), margin: { top: px(8) }, borderRadius: px(13) }} uiBackground={{ color: { r: 1, g: 1, b: 1, a: 0.14 } }}>
          {seg(0, l, over ? RED : WATER, 0.9)}
          {seg(HOLD_SWEET_LO, HOLD_SWEET_HI, GOOD, 0.6)}
          {seg(HOLD_OVER_AT, 1, RED, 0.5)}
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}
