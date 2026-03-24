// =============================================================
// The Living Garden — Screen UI
// Minimal notification system matching the design brief:
//   • Toast      — brief auto-dismiss pill (Plant Watered, daily limit)
//   • Persistent — stays until explicitly cleared (All plants watered)
// =============================================================

import ReactEcs, { ReactEcsRenderer, UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { timers } from '@dcl/sdk/ecs'

// ---------------------------------------------------------------
// State — read by the renderer every frame
// ---------------------------------------------------------------

let toastVisible  = false
let toastText     = ''
let toastLarge    = false   // larger font for key positive moments
let toastGen      = 0       // generation counter prevents stale timers hiding newer toasts

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

/** Persistent pill — stays until hidePersistent() is called. */
export function showPersistent(text: string): void {
  persistText    = text
  persistVisible = true
}

export function hidePersistent(): void {
  persistVisible = false
}

// ---------------------------------------------------------------
// Styling
// ---------------------------------------------------------------

const PILL_COLOR = { r: 0.13, g: 0.13, b: 0.13, a: 0.88 }
const WHITE      = Color4.White()
const PILL_W     = 580   // px in 1920-wide virtual canvas
const PILL_H_LG  = 72    // single-line large toast
const PILL_H_SM  = 92    // two-line / regular

// Bottom edge of the persistent pill (px from screen bottom)
const PERSIST_BOTTOM     = 90
// When both pills are visible, toast sits above persistent with a gap
const TOAST_BOTH_BOTTOM  = PERSIST_BOTTOM + PILL_H_SM + 12

// ---------------------------------------------------------------
// Setup
// ---------------------------------------------------------------

export function setupUi(): void {
  ReactEcsRenderer.setUiRenderer(uiComponent, { virtualWidth: 1920, virtualHeight: 1080 })
}

// ---------------------------------------------------------------
// Render
// ---------------------------------------------------------------

function uiComponent() {
  const toastBottom = persistVisible ? TOAST_BOTH_BOTTOM : PERSIST_BOTTOM
  const toastH      = toastLarge ? PILL_H_LG : PILL_H_SM

  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position:     { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >

      {/* ── Toast ─────────────────────────────────────────────── */}
      <UiEntity
        uiTransform={{
          display:        toastVisible ? 'flex' : 'none',
          positionType:   'absolute',
          position:       { bottom: toastBottom, left: 0, right: 0 },
          height:         toastH,
          alignItems:     'center',
          justifyContent: 'center',
        }}
      >
        <UiEntity
          uiTransform={{
            width:          PILL_W,
            height:         '100%',
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
      </UiEntity>

      {/* ── Persistent ────────────────────────────────────────── */}
      <UiEntity
        uiTransform={{
          display:        persistVisible ? 'flex' : 'none',
          positionType:   'absolute',
          position:       { bottom: PERSIST_BOTTOM, left: 0, right: 0 },
          height:         PILL_H_SM,
          alignItems:     'center',
          justifyContent: 'center',
        }}
      >
        <UiEntity
          uiTransform={{
            width:          PILL_W,
            height:         '100%',
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

    </UiEntity>
  )
}
