// =============================================================
// The Living Garden — Prototype Test Panel
// Reviewer / tester use only — not shown in production.
// All settings are runtime-only and NOT persisted.
// =============================================================

import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import {
  setOverrideDailyLimit,
  setUseClickbox,
  getUseClickbox,
  resetAllPlants,
  forceTriggerBloom,
  forceWaterToThreshold,
  forceStartPlayerTrail,
  forceStopPlayerTrail,
  forceStartBloomFlower,
  forceStopBloomFlower,
  getWateringStatus,
} from './wateringSystem'
import { isBloomActive } from './bloomSystem'

// ── Colors ──────────────────────────────────────────────────────
const PANEL_BG   = Color4.create(0.08, 0.08, 0.10, 0.95)
const HEADER_BG  = Color4.create(0.13, 0.13, 0.17, 1.0)
const WARN_BG    = Color4.create(0.22, 0.16, 0.03, 0.90)
const BTN_ON     = Color4.create(0.13, 0.50, 0.26, 1.0)   // green — active
const BTN_OFF    = Color4.create(0.20, 0.20, 0.24, 1.0)   // grey  — inactive
const BTN_DANGER = Color4.create(0.46, 0.15, 0.15, 1.0)   // red
const BTN_WATER  = Color4.create(0.10, 0.38, 0.52, 1.0)   // teal
const BTN_BLOOM  = Color4.create(0.36, 0.16, 0.48, 1.0)   // purple
const DIVIDER    = Color4.create(0.22, 0.22, 0.26, 1.0)
const WHITE      = Color4.White()
const MUTED      = Color4.create(0.52, 0.52, 0.58, 1.0)
const WARN_TEXT  = Color4.create(0.95, 0.76, 0.20, 1.0)
const OK_TEXT    = Color4.create(0.26, 0.80, 0.40, 1.0)
const ERR_TEXT   = Color4.create(0.95, 0.56, 0.14, 1.0)

// ── Layout — right-anchored, top of screen ───────────────────────
const PANEL_W      = 390
const PANEL_LEFT   = 1920 - PANEL_W - 20   // 1510
const PANEL_TOP    = 20
const HEADER_H     = 46
const PANEL_H_OPEN = 547

// ── Panel state ──────────────────────────────────────────────────
let panelOpen     = false
let overrideLimit = false                  // mirrors overrideDailyLimit
let clickboxMode  = getUseClickbox()       // mirrors useClickbox
let trailActive   = false                  // sparkle trail toggle
let flowerActive  = false                  // plant-in-hand toggle

// ── Helpers ──────────────────────────────────────────────────────

/** Two-state toggle — false button on left, true button on right. */
function ToggleButton({
  value,
  onChange,
  labelFalse = 'OFF',
  labelTrue  = 'ON',
  widthFalse = 52,
  widthTrue  = 52,
}: {
  value:       boolean
  onChange:    (v: boolean) => void
  labelFalse?: string
  labelTrue?:  string
  widthFalse?: number
  widthTrue?:  number
}) {
  return (
    <UiEntity uiTransform={{ flexDirection: 'row' }}>
      <UiEntity
        uiTransform={{ width: widthFalse, height: 30, alignItems: 'center', justifyContent: 'center', margin: { right: 4 } }}
        uiBackground={{ color: !value ? BTN_ON : BTN_OFF }}
        onMouseDown={() => onChange(false)}
      >
        <Label value={labelFalse} fontSize={10} color={!value ? WHITE : MUTED} textAlign="middle-center" />
      </UiEntity>
      <UiEntity
        uiTransform={{ width: widthTrue, height: 30, alignItems: 'center', justifyContent: 'center' }}
        uiBackground={{ color: value ? BTN_ON : BTN_OFF }}
        onMouseDown={() => onChange(true)}
      >
        <Label value={labelTrue} fontSize={10} color={value ? WHITE : MUTED} textAlign="middle-center" />
      </UiEntity>
    </UiEntity>
  )
}

// ── Component ────────────────────────────────────────────────────

export function TestPanelUi() {
  const s   = getWateringStatus()
  const pnH = panelOpen ? PANEL_H_OPEN : HEADER_H

  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position:     { left: PANEL_LEFT, top: PANEL_TOP },
        width:        PANEL_W,
        height:       pnH,
        flexDirection: 'column',
      }}
      uiBackground={{ color: PANEL_BG }}
    >

      {/* ── Header / toggle ───────────────────────────────────── */}
      <UiEntity
        uiTransform={{
          width:          '100%',
          height:         HEADER_H,
          flexDirection:  'row',
          alignItems:     'center',
          justifyContent: 'space-between',
          padding:        { left: 14, right: 14 },
          flexShrink:     0,
        }}
        uiBackground={{ color: HEADER_BG }}
        onMouseDown={() => { panelOpen = !panelOpen }}
      >
        <Label value="🧪  PROTOTYPE TEST PANEL" fontSize={12} color={MUTED} />
        <Label value={panelOpen ? '▲ close' : '▼ open'} fontSize={10} color={MUTED} />
      </UiEntity>

      {/* ── Content ───────────────────────────────────────────── */}
      <UiEntity
        uiTransform={{
          display:        panelOpen ? 'flex' : 'none',
          width:          '100%',
          flexDirection:  'column',
          padding:        { left: 14, right: 14, top: 10, bottom: 10 },
          flexShrink:     0,
        }}
      >

        {/* Disclaimer */}
        <UiEntity
          uiTransform={{
            width:          '100%',
            height:         46,
            alignItems:     'center',
            justifyContent: 'center',
            padding:        { left: 8, right: 8 },
            margin:         { bottom: 10 },
          }}
          uiBackground={{ color: WARN_BG }}
        >
          <Label
            value={'🌿  Server connected — plant state & daily counts persist\nSettings below only affect local client timing & testing'}
            fontSize={10}
            color={OK_TEXT}
            textAlign="middle-center"
            uiTransform={{ width: '100%', height: '100%' }}
          />
        </UiEntity>

        {/* ── Settings ─────────────────────────────────────────── */}

        {/* Daily Limit Override */}
        <UiEntity uiTransform={{ width: '100%', height: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', margin: { bottom: 6 } }}>
          <Label value="Daily Limit Override" fontSize={12} color={WHITE} uiTransform={{ flexGrow: 1 }} />
          <ToggleButton
            value={overrideLimit}
            onChange={v => { overrideLimit = v; setOverrideDailyLimit(v) }}
          />
        </UiEntity>

        {/* Clickbox Mode */}
        <UiEntity uiTransform={{ width: '100%', height: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', margin: { bottom: 6 } }}>
          <Label value="Click Target  (plant / clickbox)" fontSize={12} color={WHITE} uiTransform={{ flexGrow: 1 }} />
          <ToggleButton
            value={clickboxMode}
            onChange={v => { clickboxMode = v; setUseClickbox(v) }}
            labelFalse="PLANT"
            labelTrue="BOX"
          />
        </UiEntity>

        {/* Divider */}
        <UiEntity uiTransform={{ width: '100%', height: 1, margin: { top: 4, bottom: 8 } }} uiBackground={{ color: DIVIDER }} />

        {/* ── Actions ───────────────────────────────────────────── */}
        <Label value="ACTIONS" fontSize={10} color={MUTED} uiTransform={{ margin: { bottom: 6 } }} />

        <UiEntity
          uiTransform={{ width: '100%', height: 34, alignItems: 'center', justifyContent: 'center', margin: { bottom: 5 } }}
          uiBackground={{ color: BTN_DANGER }}
          onMouseDown={resetAllPlants}
        >
          <Label value="Reset All Plants" fontSize={12} color={WHITE} textAlign="middle-center" />
        </UiEntity>

        <UiEntity
          uiTransform={{ width: '100%', height: 34, alignItems: 'center', justifyContent: 'center', margin: { bottom: 5 } }}
          uiBackground={{ color: BTN_WATER }}
          onMouseDown={forceWaterToThreshold}
        >
          <Label value="Water 80% of Plants" fontSize={12} color={WHITE} textAlign="middle-center" />
        </UiEntity>

        <UiEntity
          uiTransform={{ width: '100%', height: 34, alignItems: 'center', justifyContent: 'center', margin: { bottom: 8 } }}
          uiBackground={{ color: BTN_BLOOM }}
          onMouseDown={forceTriggerBloom}
        >
          <Label value="Force Bloom Now" fontSize={12} color={WHITE} textAlign="middle-center" />
        </UiEntity>

        {/* Divider */}
        <UiEntity uiTransform={{ width: '100%', height: 1, margin: { bottom: 8 } }} uiBackground={{ color: DIVIDER }} />

        {/* ── Post-Bloom Effects ────────────────────────────────── */}
        <Label value="POST-BLOOM EFFECTS" fontSize={10} color={MUTED} uiTransform={{ margin: { bottom: 6 } }} />

        <UiEntity uiTransform={{ width: '100%', height: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', margin: { bottom: 6 } }}>
          <Label value="Sparkle Trail" fontSize={12} color={WHITE} uiTransform={{ flexGrow: 1 }} />
          <ToggleButton
            value={trailActive}
            onChange={v => {
              trailActive = v
              if (v) forceStartPlayerTrail(); else forceStopPlayerTrail()
            }}
          />
        </UiEntity>

        <UiEntity uiTransform={{ width: '100%', height: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', margin: { bottom: 6 } }}>
          <Label value="Plant in Hand" fontSize={12} color={WHITE} uiTransform={{ flexGrow: 1 }} />
          <ToggleButton
            value={flowerActive}
            onChange={v => {
              flowerActive = v
              if (v) forceStartBloomFlower(); else forceStopBloomFlower()
            }}
          />
        </UiEntity>

        {/* Divider */}
        <UiEntity uiTransform={{ width: '100%', height: 1, margin: { bottom: 8 } }} uiBackground={{ color: DIVIDER }} />

        {/* ── Live Status ───────────────────────────────────────── */}
        <Label value="LIVE STATUS" fontSize={10} color={MUTED} uiTransform={{ margin: { bottom: 5 } }} />

        <Label
          value={`Watered:  ${s.wateredCount} / ${s.totalPlants} plants   ·   Your waters today:  ${s.playerWateredToday} / ${s.overrideDailyLimit ? 'unlimited' : s.dailyWaterLimit}`}
          fontSize={11}
          color={WHITE}
          uiTransform={{ margin: { bottom: 4 } }}
        />

        <Label
          value={`Daily limit hit:  ${s.dailyLimitReached ? 'YES' : 'No'}   ·   Bloom:  ${isBloomActive() ? 'ACTIVE' : 'Inactive'}`}
          fontSize={11}
          color={s.dailyLimitReached ? ERR_TEXT : OK_TEXT}
        />

      </UiEntity>
    </UiEntity>
  )
}
