// =============================================================
// The Living Garden — Screen UI
// Minimal notification system matching the design brief:
//   • Toast       — brief auto-dismiss pill (Plant Watered)
//   • Daily Limit — dismissible pill with × button (stays until player closes)
//   • Persistent  — stays until explicitly cleared (All plants watered)
// =============================================================

import ReactEcs, { ReactEcsRenderer, UiEntity, Label } from '@dcl/sdk/react-ecs'
import { TestPanelUi } from './testPanel'
import { Color4 } from '@dcl/sdk/math'
import { timers } from '@dcl/sdk/ecs'

// ---------------------------------------------------------------
// State — read by the renderer every frame
// ---------------------------------------------------------------

let toastVisible  = false
let toastText     = ''
let toastLarge    = false
let toastGen      = 0

let dailyLimitVisible = false
let dailyLimitText    = ''

let persistVisible = false
let persistText    = ''

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/** Brief pill that auto-dismisses after `durationMs`.
 *  Pass large=true for bold-feeling moments (e.g. Plant Watered). */
export function showToast(text: string, durationMs: number, large = false): void {
  toastText    = text
  toastLarge   = large
  toastVisible = true
  const gen    = ++toastGen
  timers.setTimeout(() => {
    if (toastGen === gen) toastVisible = false
  }, durationMs)
}

/** Daily-limit pill — stays on screen until the player taps ×. */
export function showDailyLimit(text: string): void {
  dailyLimitText    = text
  dailyLimitVisible = true
}

export function hideDailyLimit(): void {
  dailyLimitVisible = false
}

/** Persistent pill — stays until hidePersistent() is called. */
export function showPersistent(text: string): void {
  persistText    = text
  persistVisible = true
}

export function hidePersistent(): void {
  persistVisible = false
}

// ---------------------------------------------------------------
// Layout constants (virtual canvas: 1920 × 1080)
// ---------------------------------------------------------------

const PILL_COLOR = { r: 0.13, g: 0.13, b: 0.13, a: 0.88 }
const WHITE      = Color4.White()
const PILL_W     = 580
const PILL_H_LG  = 72    // single-line large toast
const PILL_H_SM  = 92    // two-line / regular
const PILL_LEFT  = (1920 - PILL_W) / 2   // 670 — centres pill in 1920-wide canvas

const PERSIST_BOTTOM = 90
const PILL_STEP      = PILL_H_SM + 12   // 104 — gap between stacked pills

// ---------------------------------------------------------------
// Setup
// ---------------------------------------------------------------

export function setupUi(): void {
  ReactEcsRenderer.setUiRenderer(uiComponent, { virtualWidth: 1920, virtualHeight: 1080 })
}

// ---------------------------------------------------------------
// Render — pills are direct children of the root, absolutely
// positioned from the viewport so no intermediate sizing issues.
// Stacking order (bottom to top): Persistent → Daily Limit → Toast
// ---------------------------------------------------------------

function uiComponent() {
  // Each layer sits one PILL_STEP above the layers below it that are visible
  const dailyBottom = PERSIST_BOTTOM + (persistVisible ? PILL_STEP : 0)
  const toastBottom = dailyBottom    + (dailyLimitVisible ? PILL_STEP : 0)
  const toastH      = toastLarge ? PILL_H_LG : PILL_H_SM

  return (
    <UiEntity>

      {/* ── Test Panel ─────────────────────────────────────────── */}
      <TestPanelUi />

      {/* ── Toast ─────────────────────────────────────────────── */}
      <UiEntity
        uiTransform={{
          display:        toastVisible ? 'flex' : 'none',
          positionType:   'absolute',
          position:       { bottom: toastBottom, left: PILL_LEFT },
          width:          PILL_W,
          height:         toastH,
          alignItems:     'center',
          justifyContent: 'center',
          padding:        { left: 36, right: 36 },
        }}
        uiBackground={{ color: PILL_COLOR }}
      >
        <Label
          value={toastText}
          fontSize={toastLarge ? 24 : 18}
          color={WHITE}
          textAlign="middle-center"
          uiTransform={{ width: '100%', height: '100%' }}
        />
      </UiEntity>

      {/* ── Daily Limit (dismissible) ──────────────────────────── */}
      <UiEntity
        uiTransform={{
          display:        dailyLimitVisible ? 'flex' : 'none',
          positionType:   'absolute',
          position:       { bottom: dailyBottom, left: PILL_LEFT },
          width:          PILL_W,
          height:         PILL_H_SM,
          flexDirection:  'row',
          alignItems:     'center',
          padding:        { left: 28, right: 8 },
        }}
        uiBackground={{ color: PILL_COLOR }}
      >
        {/* Message text */}
        <Label
          value={dailyLimitText}
          fontSize={18}
          color={WHITE}
          textAlign="middle-left"
          uiTransform={{ flexGrow: 1, height: '100%' }}
        />
        {/* × dismiss button */}
        <UiEntity
          uiTransform={{
            width:          44,
            height:         44,
            alignItems:     'center',
            justifyContent: 'center',
            flexShrink:     0,
          }}
          onMouseDown={hideDailyLimit}
        >
          <Label
            value="✕"
            fontSize={22}
            color={WHITE}
            textAlign="middle-center"
            uiTransform={{ width: '100%', height: '100%' }}
          />
        </UiEntity>
      </UiEntity>

      {/* ── Persistent ────────────────────────────────────────── */}
      <UiEntity
        uiTransform={{
          display:        persistVisible ? 'flex' : 'none',
          positionType:   'absolute',
          position:       { bottom: PERSIST_BOTTOM, left: PILL_LEFT },
          width:          PILL_W,
          height:         PILL_H_SM,
          alignItems:     'center',
          justifyContent: 'center',
          padding:        { left: 36, right: 36 },
        }}
        uiBackground={{ color: PILL_COLOR }}
      >
        <Label
          value={persistText}
          fontSize={18}
          color={WHITE}
          textAlign="middle-center"
          uiTransform={{ width: '100%', height: '100%' }}
        />
      </UiEntity>

    </UiEntity>
  )
}
