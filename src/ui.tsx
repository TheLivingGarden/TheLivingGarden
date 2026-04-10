// =============================================================
// The Living Garden — Screen UI
//
// Layers
//   Persistent   — bottom-centre, stays until cleared
//   Daily Limit  — bottom-centre, player-dismissible
//   Toast        — bottom-centre, auto-dismiss
//   Banner       — top-centre, garden status, always dark
//   Health Bar   — right-centre, vertical bar mimicking 3D boards
// =============================================================

import ReactEcs, { ReactEcsRenderer, UiEntity, Label } from '@dcl/sdk/react-ecs'
import { TestPanelUi } from './testPanel'
import { Color4 } from '@dcl/sdk/math'
import { timers } from '@dcl/sdk/ecs'

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------

let toastVisible  = false
let toastText     = ''
let toastLarge    = false
let toastGen      = 0

let dailyLimitVisible = false
let dailyLimitText    = ''

let persistVisible = false
let persistText    = ''

type BannerState = 'idle' | 'countdown' | 'bloom'
let bannerState:    BannerState = 'idle'
let bannerCountdown = ''   // e.g. "3h 42m"
let bannerHealth    = 0    // 0–1 — drives the right-hand side bar

// ---------------------------------------------------------------
// Public API — bottom pills
// ---------------------------------------------------------------

export function showToast(text: string, durationMs: number, large = false): void {
  toastText    = text
  toastLarge   = large
  toastVisible = true
  const gen    = ++toastGen
  timers.setTimeout(() => { if (toastGen === gen) toastVisible = false }, durationMs)
}

export function showDailyLimit(text: string): void {
  dailyLimitText    = text
  dailyLimitVisible = true
}
export function hideDailyLimit(): void { dailyLimitVisible = false }

export function showPersistent(text: string): void {
  persistText    = text
  persistVisible = true
}
export function hidePersistent(): void { persistVisible = false }

// ---------------------------------------------------------------
// Public API — top banner
// ---------------------------------------------------------------

export function showBannerIdle(): void      { bannerState = 'idle'      }
export function showBannerBloom(): void     { bannerState = 'bloom'     }

export function showBannerCountdown(countdown: string): void {
  bannerState     = 'countdown'
  bannerCountdown = countdown
}
export function updateBannerCountdown(countdown: string): void {
  bannerCountdown = countdown
}

// ---------------------------------------------------------------
// Public API — side health bar
// ---------------------------------------------------------------

/** Update the vertical health bar (0–1). Call whenever wateredCount changes. */
export function updateBannerHealth(ratio: number): void {
  bannerHealth = Math.max(0, Math.min(1, ratio))
}

// ---------------------------------------------------------------
// Layout constants  (virtual canvas 1920 × 1080)
// ---------------------------------------------------------------

const DARK    = { r: 0.13, g: 0.13, b: 0.13, a: 0.88 }   // DCL default dark
const WHITE   = Color4.White()
const GREY    = Color4.create(0.65, 0.65, 0.65, 1)

// ── Bottom pills ──────────────────────────────────────────────
const PILL_W       = 580
const PILL_H_LG    = 72
const PILL_H_SM    = 92
const PILL_LEFT    = (1920 - PILL_W) / 2   // 670

const PERSIST_BOTTOM = 90
const PILL_STEP      = PILL_H_SM + 12

// ── Top banner ────────────────────────────────────────────────
const BANNER_W    = 700
const BANNER_LEFT = (1920 - BANNER_W) / 2
const BANNER_TOP  = 28

// Banner text colours per state (background is always DARK)
const TEXT_IDLE      = Color4.create(0.72, 0.80, 0.72, 1.00)  // muted sage
const TEXT_COUNTDOWN = Color4.create(0.95, 1.00, 0.88, 1.00)  // bright off-white
const TEXT_BLOOM     = Color4.create(1.00, 0.92, 0.35, 1.00)  // golden yellow
const TEXT_SUBTEXT   = Color4.create(0.65, 0.80, 0.65, 0.85)

// ── Right-side vertical health bar ────────────────────────────
const SIDE_W          = 40    // bar track width (px)
const SIDE_H          = 280   // bar track height (px)
const SIDE_LABEL_H    = 26    // % label above the bar
const SIDE_GAP        = 6     // gap between label and bar
const SIDE_TOTAL_H    = SIDE_LABEL_H + SIDE_GAP + SIDE_H
const SIDE_RIGHT_PAD  = 44    // distance from right edge
const SIDE_LEFT       = 1920 - SIDE_RIGHT_PAD - SIDE_W
const SIDE_TOP        = Math.round((1080 - SIDE_TOTAL_H) / 2)

// Tick marks (match the 3D boards: 25%, 50%, 80%)
const TICK_W          = SIDE_W + 10   // slightly wider than bar (overhangs 5px each side)
const TICK_OFFSET_X   = -5            // nudge left to centre the overhang
const TICK_H_NORMAL   = 2
const TICK_H_THRESHOLD = 3

// Bar fill colours (same thresholds as 3D boards)
const BAR_DARK   = Color4.create(0.08, 0.08, 0.09, 0.92)   // track background
const BAR_RED    = Color4.create(0.85, 0.18, 0.18, 1)
const BAR_ORANGE = Color4.create(1.00, 0.50, 0.05, 1)
const BAR_GREEN  = Color4.create(0.20, 0.88, 0.35, 1)
const TICK_COLOR = Color4.create(0.70, 0.70, 0.70, 1)
const TICK_GOLD  = Color4.create(1.00, 0.84, 0.10, 1)      // threshold marker

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function sideFillColor(): Color4 {
  if (bannerHealth >= 0.80) return BAR_GREEN
  if (bannerHealth >= 0.50) return BAR_ORANGE
  return BAR_RED
}

function bannerLine1(): string {
  if (bannerState === 'bloom')     return 'The Garden is in Full Bloom!'
  if (bannerState === 'countdown') return `Garden Bloom in ${bannerCountdown}`
  return 'Water the plants to see the garden bloom'
}
function bannerFontSize(): number {
  return bannerState === 'bloom' ? 20 : bannerState === 'countdown' ? 19 : 16
}
function bannerTextColor(): Color4 {
  if (bannerState === 'bloom')     return TEXT_BLOOM
  if (bannerState === 'countdown') return TEXT_COUNTDOWN
  return TEXT_IDLE
}

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
  const dailyBottom = PERSIST_BOTTOM + (persistVisible ? PILL_STEP : 0)
  const toastBottom = dailyBottom    + (dailyLimitVisible ? PILL_STEP : 0)
  const toastH      = toastLarge ? PILL_H_LG : PILL_H_SM

  const isCountdown = bannerState === 'countdown'
  // Banner: single-line or two-line countdown, always compact
  const bannerH     = isCountdown ? 80 : 52

  // Side bar fill — grows from bottom, minimum 2px when health > 0
  const fillH       = bannerHealth > 0 ? Math.max(2, Math.round(bannerHealth * SIDE_H)) : 0
  const fillTop     = SIDE_H - fillH   // top offset within track (bottom-anchored)

  // Tick positions (top offset from bar track top)
  const tick25Top  = Math.round(SIDE_H * 0.75) - TICK_H_NORMAL
  const tick50Top  = Math.round(SIDE_H * 0.50) - TICK_H_NORMAL
  const tick80Top  = Math.round(SIDE_H * 0.20) - TICK_H_THRESHOLD

  // Percent label (0–100)
  const pctLabel = `${Math.round(bannerHealth * 100)}%`

  return (
    <UiEntity>

      {/* ── Test Panel ─────────────────────────────────────────── */}
      <TestPanelUi />

      {/* ═══════════════════════════════════════════════════════════
          TOP BANNER — always dark, compact
      ══════════════════════════════════════════════════════════════ */}
      <UiEntity
        uiTransform={{
          positionType:   'absolute',
          position:       { top: BANNER_TOP, left: BANNER_LEFT },
          width:          BANNER_W,
          height:         bannerH,
          flexDirection:  'column',
          alignItems:     'center',
          justifyContent: 'center',
          padding:        { left: 32, right: 32 },
        }}
        uiBackground={{ color: DARK }}
      >
        <Label
          value={bannerLine1()}
          fontSize={bannerFontSize()}
          color={bannerTextColor()}
          textAlign="middle-center"
          uiTransform={{ width: '100%', height: 32 }}
        />
        {isCountdown && (
          <Label
            value="Keep garden health at or above 80%"
            fontSize={13}
            color={TEXT_SUBTEXT}
            textAlign="middle-center"
            uiTransform={{ width: '100%', height: 22 }}
          />
        )}
      </UiEntity>

      {/* ═══════════════════════════════════════════════════════════
          RIGHT SIDE — vertical health bar (mimics 3D boards)
      ══════════════════════════════════════════════════════════════ */}
      <UiEntity
        uiTransform={{
          positionType:   'absolute',
          position:       { top: SIDE_TOP, left: SIDE_LEFT },
          width:          SIDE_W,
          height:         SIDE_TOTAL_H,
          flexDirection:  'column',
          alignItems:     'center',
        }}
      >
        {/* Percentage label */}
        <Label
          value={pctLabel}
          fontSize={13}
          color={GREY}
          textAlign="middle-center"
          uiTransform={{ width: SIDE_W, height: SIDE_LABEL_H }}
        />

        {/* Spacer */}
        <UiEntity uiTransform={{ width: SIDE_W, height: SIDE_GAP, flexShrink: 0 }} />

        {/* Bar track */}
        <UiEntity
          uiTransform={{
            width:        SIDE_W,
            height:       SIDE_H,
            flexShrink:   0,
            positionType: 'relative',
          }}
          uiBackground={{ color: BAR_DARK }}
        >
          {/* Fill — bottom-anchored */}
          {fillH > 0 && (
            <UiEntity
              uiTransform={{
                positionType: 'absolute',
                position:     { top: fillTop, left: 0 },
                width:        SIDE_W,
                height:       fillH,
              }}
              uiBackground={{ color: sideFillColor() }}
            />
          )}

          {/* Tick 25% */}
          <UiEntity
            uiTransform={{
              positionType: 'absolute',
              position:     { top: tick25Top, left: TICK_OFFSET_X },
              width:        TICK_W,
              height:       TICK_H_NORMAL,
            }}
            uiBackground={{ color: TICK_COLOR }}
          />

          {/* Tick 50% */}
          <UiEntity
            uiTransform={{
              positionType: 'absolute',
              position:     { top: tick50Top, left: TICK_OFFSET_X },
              width:        TICK_W,
              height:       TICK_H_NORMAL,
            }}
            uiBackground={{ color: TICK_COLOR }}
          />

          {/* Tick 80% — gold threshold marker */}
          <UiEntity
            uiTransform={{
              positionType: 'absolute',
              position:     { top: tick80Top, left: TICK_OFFSET_X },
              width:        TICK_W,
              height:       TICK_H_THRESHOLD,
            }}
            uiBackground={{ color: TICK_GOLD }}
          />
        </UiEntity>
      </UiEntity>

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
        uiBackground={{ color: DARK }}
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
        uiBackground={{ color: DARK }}
      >
        <Label
          value={dailyLimitText}
          fontSize={18}
          color={WHITE}
          textAlign="middle-left"
          uiTransform={{ flexGrow: 1, height: '100%' }}
        />
        <UiEntity
          uiTransform={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
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
        uiBackground={{ color: DARK }}
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
