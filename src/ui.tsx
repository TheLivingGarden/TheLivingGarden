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
let bannerCountdown = ''   // e.g. "3h 42m 15s" — always kept current by ticker
let bannerVisible   = true // player can dismiss; auto-restores on bloom/countdown
let bannerHealth    = 0    // 0–1 — drives the right-hand side bar
let playerCount     = 0

// Banner animation
let bannerOffsetY = 0   // slide-in from top


function animateBannerIn(): void {
  const STEPS   = 10
  const STEP_MS = 25
  let step = 0
  bannerOffsetY = -20
  function tick(): void {
    step++
    const t      = step / STEPS
    const eased  = 1 - (1 - t) * (1 - t)   // ease-out quad
    bannerOffsetY = Math.round(-20 * (1 - eased))
    if (step < STEPS) timers.setTimeout(tick, STEP_MS)
    else bannerOffsetY = 0
  }
  timers.setTimeout(tick, STEP_MS)
}


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

export function showBannerIdle(): void  { bannerState = 'idle' }
export function showBannerBloom(): void { bannerState = 'bloom'; bannerVisible = true; animateBannerIn() }

export function showBannerCountdown(countdown: string): void {
  const wasCountdown = bannerState === 'countdown'
  bannerState     = 'countdown'
  bannerCountdown = countdown
  bannerVisible   = true
  if (!wasCountdown) {
    animateBannerIn()
  }
}
export function updateBannerCountdown(countdown: string): void {
  bannerCountdown = countdown
}
function hideBanner(): void { bannerVisible = false }

// ---------------------------------------------------------------
// Public API — side health bar
// ---------------------------------------------------------------

/** Update the vertical health bar (0–1). Call whenever wateredCount changes. */
export function updateBannerHealth(ratio: number): void {
  bannerHealth = Math.max(0, Math.min(1, ratio))
}

/** Update the player count label. */
export function updatePlayerCount(n: number): void {
  playerCount = n
}

/** Update the top-left waters-remaining counter. */



// ---------------------------------------------------------------
// Layout constants  (virtual canvas 1920 × 1080)
// ---------------------------------------------------------------

const DARK         = { r: 0.13, g: 0.13, b: 0.13, a: 0.88 }   // DCL default dark
const WHITE   = Color4.White()
const GREY    = Color4.create(0.65, 0.65, 0.65, 1)

// ── Bottom pills ──────────────────────────────────────────────
const PILL_W          = 580
const PILL_H_LG       = 72
const PILL_H_SM       = 92
const PILL_LEFT       = (1920 - PILL_W) / 2   // 670
const PILL_PAD_X      = 36   // horizontal padding inside toast + persistent pills
const PERSIST_BOTTOM  = 90
const PILL_STEP       = PILL_H_SM + 12   // vertical stride between stacked pills

// ── Toast ─────────────────────────────────────────────────────
const TOAST_FONT_LG   = 24
const TOAST_FONT_SM   = 18

// ── Daily Limit pill ──────────────────────────────────────────
const DAILY_FONT          = 18
const DAILY_DISMISS_SIZE  = 44   // dismiss button width & height (also used as ghost spacer)
const DAILY_DISMISS_FONT  = 22

// ── Persistent pill ───────────────────────────────────────────
const PERSIST_FONT    = 18

// ── Top banner ────────────────────────────────────────────────
const BANNER_W            = 820   // wide enough for idle text + countdown + dismiss button
const BANNER_LEFT         = (1920 - BANNER_W) / 2
const BANNER_TOP          = 28

const BANNER_H_SINGLE     = 52   // one line of text
const BANNER_H_COUNTDOWN  = 80   // main line + countdown subtitle

const BANNER_DISMISS_SIZE = 36   // close button width & height
const BANNER_DISMISS_FONT = 15

const BANNER_FONT_BLOOM     = 20
const BANNER_FONT_COUNTDOWN = 19
const BANNER_FONT_IDLE      = 16
const BANNER_LINE1_H        = 32   // height of the main text row
const BANNER_SUBTEXT_FONT   = 13
const BANNER_SUBTEXT_H      = 22   // height of the countdown subtitle row

// Banner text colours per state (background is always DARK)
const TEXT_IDLE      = Color4.create(0.72, 0.80, 0.72, 1.00)  // muted sage
const TEXT_COUNTDOWN = Color4.create(0.95, 1.00, 0.88, 1.00)  // bright off-white
const TEXT_BLOOM     = Color4.create(1.00, 0.92, 0.35, 1.00)  // golden yellow
const TEXT_SUBTEXT   = Color4.create(0.65, 0.80, 0.65, 0.85)

// ── Right-side vertical health bar ────────────────────────────
const SIDE_W          = 48    // bar track width (px)
const SIDE_H          = 420   // bar track height (px) — 1.5× original 280
const SIDE_LABEL_H    = 26    // % label above the bar
const SIDE_LABEL_FONT = 13
const SIDE_GAP        = 6     // gap between label and bar
const SIDE_FILL_MIN   = 2     // minimum fill height in px when health > 0
const PLAYER_COUNT_H    = 22
const PLAYER_COUNT_FONT = 11
const GARDEN_TITLE_H    = 22
const GARDEN_TITLE_FONT = 10
const SIDE_PILL_PAD_Y   = 5   // vertical padding inside the dark pill
const SIDE_PILL_GAP     = 6   // gap between pill and bar
const SIDE_PILL_H       = PLAYER_COUNT_H + 4 + GARDEN_TITLE_H + 4 + SIDE_LABEL_H + SIDE_PILL_PAD_Y * 2

// Watering can image — sits above the dark pill
const WATERING_CAN_SRC  = 'assets/scene/Images/WateringCanRender.png'
const CAN_IMG_SIZE       = 72    // square display size
const CAN_IMG_GAP        = 8     // gap between image and dark pill
const CAN_BADGE_H     = 22
const CAN_BADGE_MIN_W = 34
const CAN_BADGE_PAD_X = 6
const CAN_BADGE_FONT  = 12

const SIDE_COL_W    = SIDE_W
const SIDE_TOTAL_H  = SIDE_PILL_H + SIDE_PILL_GAP + SIDE_H
const SIDE_RIGHT_PAD  = 44    // distance from right edge
const SIDE_LEFT       = 1920 - SIDE_RIGHT_PAD - SIDE_COL_W
const SIDE_TOP        = Math.round((1080 - SIDE_TOTAL_H) / 2)

// Tick marks (match the 3D boards: 25%, 50%, 80%)
const TICK_W           = SIDE_W + 10   // slightly wider than bar (overhangs 5px each side)
const TICK_OFFSET_X    = -5            // nudge left to centre the overhang
const TICK_H_NORMAL    = 2
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
  if (bannerState === 'countdown') return `Keep garden health above 80% for ${bannerCountdown} to wake the big bloom`
  return 'Keep garden health above 80% to wake the big bloom'
}
function bannerHealthLine(): string | null {
  if (bannerState === 'bloom') return null
  return `Garden Health: ${Math.round(bannerHealth * 100)}%`
}
function bannerFontSize(): number {
  return bannerState === 'bloom' ? BANNER_FONT_BLOOM : bannerState === 'countdown' ? BANNER_FONT_COUNTDOWN : BANNER_FONT_IDLE
}
function bannerTextColor(): Color4 {
  if (bannerState === 'bloom')     return TEXT_BLOOM
  if (bannerState === 'countdown') return TEXT_COUNTDOWN
  return TEXT_IDLE
}
function showPlusOneWater(): void {
  showToast('+1 water', 900, false)
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

  const isCountdown  = bannerState === 'countdown'
  const isBloom      = bannerState === 'bloom'
  const bannerH      = BANNER_H_SINGLE

  // Side bar fill — grows from bottom, minimum SIDE_FILL_MIN px when health > 0
  const fillH       = bannerHealth > 0 ? Math.max(SIDE_FILL_MIN, Math.round(bannerHealth * SIDE_H)) : 0
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
          TOP BANNER — always dark, compact, player-dismissible
      ══════════════════════════════════════════════════════════════ */}
      <UiEntity
        uiTransform={{
          display:        bannerVisible ? 'flex' : 'none',
          positionType:   'absolute',
          position:       { top: BANNER_TOP + bannerOffsetY, left: BANNER_LEFT },
          width:          BANNER_W,
          height:         bannerH,
          flexDirection:  'row',
          alignItems:     'center',
        }}
        uiBackground={{ color: DARK }}
      >
        {/* Ghost spacer — mirrors dismiss button so text stays centred */}
        <UiEntity uiTransform={{ width: BANNER_DISMISS_SIZE, height: BANNER_DISMISS_SIZE, flexShrink: 0 }} />

        {/* Centre content column */}
        <UiEntity
          uiTransform={{
            flexGrow:       1,
            height:         '100%',
            flexDirection:  'column',
            alignItems:     'center',
            justifyContent: 'center',
          }}
        >
          <Label
            value={bannerLine1()}
            fontSize={bannerFontSize()}
            color={bannerTextColor()}
            textAlign="middle-center"
            uiTransform={{ width: '100%', height: BANNER_LINE1_H }}
          />
        </UiEntity>

        {/* Dismiss button */}
        <UiEntity
          uiTransform={{ width: BANNER_DISMISS_SIZE, height: BANNER_DISMISS_SIZE, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
          onMouseDown={hideBanner}
        >
          <Label
            value="✕"
            fontSize={BANNER_DISMISS_FONT}
            color={TEXT_IDLE}
            textAlign="middle-center"
            uiTransform={{ width: '100%', height: '100%' }}
          />
        </UiEntity>
      </UiEntity>

      {/* ═══════════════════════════════════════════════════════════
          RIGHT SIDE — vertical health bar (mimics 3D boards)
      ══════════════════════════════════════════════════════════════ */}
      <UiEntity
        uiTransform={{
          positionType:   'absolute',
          position:       { top: SIDE_TOP, left: SIDE_LEFT },
          width:          SIDE_COL_W,
          height:         SIDE_TOTAL_H,
          flexDirection:  'column',
          alignItems:     'center',
        }}
      >
        {/* Dark pill — player count + title + % */}
        <UiEntity
          uiTransform={{
            width:          SIDE_W,
            height:         SIDE_PILL_H,
            flexShrink:     0,
            flexDirection:  'column',
            alignItems:     'center',
            justifyContent: 'center',
            padding:        { top: SIDE_PILL_PAD_Y, bottom: SIDE_PILL_PAD_Y },
          }}
          uiBackground={{ color: DARK }}
        >
          <Label
            value="Garden Health"
            fontSize={GARDEN_TITLE_FONT}
            color={TEXT_IDLE}
            textAlign="middle-center"
            uiTransform={{ width: SIDE_W, height: GARDEN_TITLE_H }}
          />
          <UiEntity uiTransform={{ width: SIDE_W, height: 4, flexShrink: 0 }} />
          <Label
            value={pctLabel}
            fontSize={SIDE_LABEL_FONT}
            color={GREY}
            textAlign="middle-center"
            uiTransform={{ width: SIDE_W, height: SIDE_LABEL_H }}
          />
        </UiEntity>

        {/* Spacer between pill and bar */}
        <UiEntity uiTransform={{ width: SIDE_W, height: SIDE_PILL_GAP, flexShrink: 0 }} />

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
          padding:        { left: PILL_PAD_X, right: PILL_PAD_X },
        }}
        uiBackground={{ color: DARK }}
      >
        <Label
          value={toastText}
          fontSize={toastLarge ? TOAST_FONT_LG : TOAST_FONT_SM}
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
        }}
        uiBackground={{ color: DARK }}
      >
        {/* Ghost spacer — mirrors the dismiss button so the label area is symmetric */}
        <UiEntity uiTransform={{ width: DAILY_DISMISS_SIZE, height: DAILY_DISMISS_SIZE, flexShrink: 0 }} />
        <Label
          value={dailyLimitText}
          fontSize={DAILY_FONT}
          color={WHITE}
          textAlign="middle-center"
          uiTransform={{ flexGrow: 1, height: '100%' }}
        />
        <UiEntity
          uiTransform={{ width: DAILY_DISMISS_SIZE, height: DAILY_DISMISS_SIZE, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
          onMouseDown={hideDailyLimit}
        >
          <Label
            value="✕"
            fontSize={DAILY_DISMISS_FONT}
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
          padding:        { left: PILL_PAD_X, right: PILL_PAD_X },
        }}
        uiBackground={{ color: DARK }}
      >
        <Label
          value={persistText}
          fontSize={PERSIST_FONT}
          color={WHITE}
          textAlign="middle-center"
          uiTransform={{ width: '100%', height: '100%' }}
        />
      </UiEntity>

    </UiEntity>
  )
}
