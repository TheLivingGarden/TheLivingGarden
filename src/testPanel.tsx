// =============================================================
// The Living Garden — Prototype Test Panel
// Reviewer / tester use only — not shown in production.
// All settings are runtime-only and NOT persisted.
// =============================================================

import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { getPlayer } from '@dcl/sdk/players'
import { ADMIN_ADDRESSES } from './shared/config'
import {
  setOverrideDailyLimit,
  setUseClickbox,
  getUseClickbox,
  resetAllPlants,
  forceTriggerBloom,
  forceResetBloom,
  adminGrantWaters,
  forceWaterToThreshold,
  forceStartPlayerTrail,
  forceStopPlayerTrail,
  forceStartBloomFlower,
  forceStopBloomFlower,
  getWateringStatus,
} from './wateringSystem'
import { isBloomActive } from './bloomSystem'
import { getCanvasCalibration } from './ui'
import { spawnTestPots, removeTestPots, getTestPotCount, getFps } from './potStressTest'
import { demoSeedlings, demoRevealedFlowers, adminTidyPlanter, adminSetUnlimitedPlanters } from './boxSystem'
import { adminFillAvenue, adminClearAvenue } from './avenueSystem'
import { adminResetOnboarding } from './onboarding'
import { vfxFlags, setVfxFlag } from './plantVfx'
import { waterFxFlags } from './sparkleSystem'
import { isLayoutToolOn, setLayoutTool, layoutCount, layoutSelectedInfo, layoutIsCarrying, layoutSelectNearest, layoutPickUpOrDrop, layoutNudge, layoutRotateLeft, layoutRotateRight, layoutSnap90, layoutAddHere, layoutDelete, layoutExport } from './planterLayoutTool'
import { isPerfOff, setPerfOff, perfLabel, getFpsAvg, resetFpsAvg, PerfToggle } from './potStressTest'
import { isPropToolOn, setPropTool, propToolCount, propSelectedInfo, propIsCarrying, propSelectNearest, propPickUpOrDrop, propNudge, propRotateLeft, propRotateRight, propSnap90, propExport } from './propLayoutTool'
import { isPlantToolOn, setPlantTool, plantToolCount, plantSelectedInfo, plantIsCarrying, plantSelectNearest, plantPickUpOrDrop, plantNudge, plantRotateLeft, plantRotateRight, plantSnap90, plantExport } from './plantLayoutTool'
import { isTributeToolOn, setTributeTool, tributeCount, tributeSelectedInfo, tributeIsCarrying, tributeSelectNearest, tributePickUpOrDrop, tributeNudge, tributeRotateLeft, tributeRotateRight, tributeSnap90, tributeFaceMe, tributeExport } from './tributeLayoutTool'
import {
  adminSpawnLocalSeed,
  adminSpawnSeedLadder,
  adminSeedShower,
  adminRequestServerSeed,
  adminScaleSeeds,
  adminShiftSeedHeight,
  adminListSeeds,
  clearAllSeeds,
  getSeedCount,
} from './seedSystem'

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
// Dev panel lives on the LEFT edge, below the client's top-left chrome: the HUD ring and
// seed chip own the top right. (A fixed left:1510 was off-screen on narrower canvases.)
const PANEL_LEFT   = 24
const PANEL_TOP    = 20
const HEADER_H     = 46

// ── Panel state ──────────────────────────────────────────────────
let panelOpen     = false
let overrideLimit = false                  // mirrors overrideDailyLimit
let unlimitedPlanters = false              // server-side, in memory — off again after a server restart
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

/** Compact equal-width action button for the Seeds rows. */
function SeedBtn({ label, color, onClick, last = false }: { label: string; color: Color4; onClick: () => void; last?: boolean }) {
  return (
    <UiEntity
      uiTransform={{ flexGrow: 1, height: 32, alignItems: 'center', justifyContent: 'center', margin: { right: last ? 0 : 4 } }}
      uiBackground={{ color }}
      onMouseDown={onClick}
    >
      <Label value={label} fontSize={10} color={WHITE} textAlign="middle-center" />
    </UiEntity>
  )
}

// ── Component ────────────────────────────────────────────────────

export function TestPanelUi() {
  // Reviewer/tester tools only (file header) — never rendered for a regular player.
  // Every action behind it is ALSO admin-gated server-side, so this is a visibility/
  // clutter fix, not a security one (KJ 2026-09-22: "make it invisible except to admin").
  if (!ADMIN_ADDRESSES.includes((getPlayer()?.userId ?? '').toLowerCase())) return null
  const s   = getWateringStatus()

  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position:     { left: PANEL_LEFT, top: PANEL_TOP },
        width:        PANEL_W,
        // Open = auto height. A fixed 1020 px box clipped the lower rows on the phone
        // (Godot clips children to the parent box; Unity desktop lets them spill out).
        height:       panelOpen ? undefined : HEADER_H,
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

      {/* Canvas calibration — the phone has no console; read the numbers here */}
      {panelOpen && (
        <Label value={getCanvasCalibration()} fontSize={9} color={MUTED} uiTransform={{ width: '100%', height: 16, margin: { left: 14 } }} />
      )}

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

        {/* Unlimited planters (admin) */}
        <UiEntity uiTransform={{ width: '100%', height: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', margin: { bottom: 6 } }}>
          <Label value="Unlimited planters (admin, random tier, no seeds used)" fontSize={12} color={WHITE} uiTransform={{ flexGrow: 1 }} />
          <ToggleButton
            value={unlimitedPlanters}
            onChange={v => { unlimitedPlanters = v; adminSetUnlimitedPlanters(v) }}
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
          onMouseDown={() => forceTriggerBloom()}
        >
          <Label value="Force Bloom Now" fontSize={12} color={WHITE} textAlign="middle-center" />
        </UiEntity>

        {/* Stop bloom / reset — cancels a stuck sustain hold too, not just an active bloom */}
        <UiEntity
          uiTransform={{ width: '100%', height: 34, alignItems: 'center', justifyContent: 'center', margin: { bottom: 8 } }}
          uiBackground={{ color: BTN_DANGER }}
          onMouseDown={forceResetBloom}
        >
          <Label value="Stop Bloom / Reset Sustain" fontSize={12} color={WHITE} textAlign="middle-center" />
        </UiEntity>

        <UiEntity
          uiTransform={{ width: '100%', height: 34, alignItems: 'center', justifyContent: 'center', margin: { bottom: 8 } }}
          uiBackground={{ color: BTN_BLOOM }}
          onMouseDown={() => forceTriggerBloom('moonlit')}
        >
          <Label value="Force MOONLIT Bloom (scales with players)" fontSize={12} color={WHITE} textAlign="middle-center" />
        </UiEntity>

        <UiEntity
          uiTransform={{ width: '100%', height: 34, alignItems: 'center', justifyContent: 'center', margin: { bottom: 8 } }}
          uiBackground={{ color: BTN_BLOOM }}
          onMouseDown={() => adminGrantWaters(100)}
        >
          <Label value="Grant +100 lifetime waters (flair / tribute)" fontSize={12} color={WHITE} textAlign="middle-center" />
        </UiEntity>

        {/* Replays the whole tutorial — without this, whoever builds it can never see it
            again after doing it once (KJ 2026-09-20). */}
        <UiEntity
          uiTransform={{ width: '100%', height: 34, alignItems: 'center', justifyContent: 'center', margin: { bottom: 8 } }}
          uiBackground={{ color: BTN_WATER }}
          onMouseDown={adminResetOnboarding}
        >
          <Label value="Reset MY onboarding (replay the tutorial)" fontSize={12} color={WHITE} textAlign="middle-center" />
        </UiEntity>

        {/* 100-planter performance test — local only */}
        <UiEntity
          uiTransform={{ width: '100%', height: 34, alignItems: 'center', justifyContent: 'center', margin: { bottom: 8 } }}
          uiBackground={{ color: BTN_BLOOM }}
          onMouseDown={() => (getTestPotCount() > 0 ? removeTestPots() : spawnTestPots())}
        >
          <Label value={getTestPotCount() > 0 ? `Remove ${getTestPotCount()} test planters  (${getFps()} fps)` : `Spawn 100 test planters  (${getFps()} fps)`} fontSize={12} color={WHITE} textAlign="middle-center" />
        </UiEntity>

        {/* Rarity VFX A/B — flip one family off, watch the fps above (one row: the phone clips overflow) */}
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', margin: { bottom: 8 } }}>
          <UiEntity uiTransform={{ flexGrow: 1, height: 32, alignItems: 'center', justifyContent: 'center', margin: { right: 4 } }} uiBackground={{ color: vfxFlags.pulse ? BTN_ON : BTN_OFF }} onMouseDown={() => setVfxFlag('pulse', !vfxFlags.pulse)}>
            <Label value={`Pulse ${vfxFlags.pulse ? 'ON' : 'OFF'}`} fontSize={10} color={WHITE} textAlign="middle-center" />
          </UiEntity>
          <UiEntity uiTransform={{ flexGrow: 1, height: 32, alignItems: 'center', justifyContent: 'center', margin: { right: 4 } }} uiBackground={{ color: vfxFlags.particles ? BTN_ON : BTN_OFF }} onMouseDown={() => setVfxFlag('particles', !vfxFlags.particles)}>
            <Label value={`Particles ${vfxFlags.particles ? 'ON' : 'OFF'}`} fontSize={10} color={WHITE} textAlign="middle-center" />
          </UiEntity>
          <UiEntity uiTransform={{ flexGrow: 1, height: 32, alignItems: 'center', justifyContent: 'center', margin: { right: 0 } }} uiBackground={{ color: vfxFlags.lights ? BTN_ON : BTN_OFF }} onMouseDown={() => setVfxFlag('lights', !vfxFlags.lights)}>
            <Label value={`Lights ${vfxFlags.lights ? 'ON' : 'OFF'}`} fontSize={10} color={WHITE} textAlign="middle-center" />
          </UiEntity>
        </UiEntity>

        {/* Watering FX A/B — same idea for the per-watering effects */}
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', margin: { bottom: 8 } }}>
          {(['ripple', 'burst', 'tribute'] as const).map((k, i) => (
            <UiEntity key={k} uiTransform={{ flexGrow: 1, height: 32, alignItems: 'center', justifyContent: 'center', margin: { right: i < 2 ? 4 : 0 } }} uiBackground={{ color: waterFxFlags[k] ? BTN_ON : BTN_OFF }} onMouseDown={() => { waterFxFlags[k] = !waterFxFlags[k] }}>
              <Label value={`${k[0].toUpperCase()}${k.slice(1)} ${waterFxFlags[k] ? 'ON' : 'OFF'}`} fontSize={10} color={WHITE} textAlign="middle-center" />
            </UiEntity>
          ))}
        </UiEntity>

        {/* Planter layout editor — move/rotate the real planters, then bake (GDD §3.1) */}
        <UiEntity uiTransform={{ width: '100%', height: 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', margin: { bottom: 4 } }}>
          <Label value={isLayoutToolOn() ? `Planter editor  (${layoutCount()})` : 'Planter editor'} fontSize={12} color={WHITE} uiTransform={{ flexGrow: 1 }} />
          <ToggleButton value={isLayoutToolOn()} onChange={setLayoutTool} />
        </UiEntity>
        <Label value={layoutSelectedInfo()} fontSize={11} color={MUTED} uiTransform={{ display: isLayoutToolOn() ? 'flex' : 'none', width: '100%', height: 18, margin: { bottom: 4 } }} />
        <UiEntity uiTransform={{ display: isLayoutToolOn() ? 'flex' : 'none', width: '100%', flexDirection: 'row', margin: { bottom: 4 } }}>
          <SeedBtn label="Select nearest" color={BTN_OFF} onClick={layoutSelectNearest} />
          <SeedBtn label={layoutIsCarrying() ? "Drop" : "Pick up"} color={BTN_ON} onClick={layoutPickUpOrDrop} />
          <SeedBtn label="Add here" color={BTN_OFF} onClick={layoutAddHere} last />
        </UiEntity>
        <UiEntity uiTransform={{ display: isLayoutToolOn() ? 'flex' : 'none', width: '100%', flexDirection: 'row', margin: { bottom: 4 } }}>
          <SeedBtn label="Nudge fwd" color={BTN_OFF} onClick={() => layoutNudge('fwd')} />
          <SeedBtn label="Nudge back" color={BTN_OFF} onClick={() => layoutNudge('back')} />
          <SeedBtn label="Nudge left" color={BTN_OFF} onClick={() => layoutNudge('left')} />
          <SeedBtn label="Nudge right" color={BTN_OFF} onClick={() => layoutNudge('right')} last />
        </UiEntity>
        <UiEntity uiTransform={{ display: isLayoutToolOn() ? 'flex' : 'none', width: '100%', flexDirection: 'row', margin: { bottom: 4 } }}>
          <SeedBtn label="Turn -15" color={BTN_OFF} onClick={layoutRotateLeft} />
          <SeedBtn label="Turn +15" color={BTN_OFF} onClick={layoutRotateRight} />
          <SeedBtn label="Snap 90" color={BTN_OFF} onClick={layoutSnap90} />
          <SeedBtn label="Delete" color={BTN_OFF} onClick={layoutDelete} last />
        </UiEntity>
        <UiEntity uiTransform={{ display: isLayoutToolOn() ? 'flex' : 'none', width: '100%', flexDirection: 'row', margin: { bottom: 8 } }}>
          <SeedBtn label="Save / export" color={BTN_BLOOM} onClick={layoutExport} last />
        </UiEntity>

        {/* PERF — turn one suspect off at a time and read the 5 s average. The asset
            audit ranks by size; this ranks by what the frame rate actually does. */}
        <UiEntity uiTransform={{ width: '100%', height: 30, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', margin: { bottom: 2 } }}>
          <Label value="PERF - isolate a cost" fontSize={12} color={WHITE} uiTransform={{ flexGrow: 1 }} />
          <Label value={`${getFpsAvg()} fps avg`} fontSize={12} color={MUTED} />
        </UiEntity>
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', margin: { bottom: 4 } }}>
          <SeedBtn label="Reset average" color={BTN_OFF} onClick={resetFpsAvg} last />
        </UiEntity>
        {(['env', 'envShadows', 'envColliders', 'plants', 'planters', 'drops'] as PerfToggle[]).map(t => (
          <UiEntity key={`perf-${t}`} uiTransform={{ width: '100%', height: 30, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', margin: { bottom: 2 } }}>
            <Label value={perfLabel(t)} fontSize={11} color={isPerfOff(t) ? MUTED : WHITE} uiTransform={{ flexGrow: 1 }} />
            <ToggleButton value={!isPerfOff(t)} onChange={(on: boolean) => { setPerfOff(t, !on); resetFpsAvg() }} />
          </UiEntity>
        ))}

        {/* Plant layout editor — the 38 plants players WATER. Moves each plant AND its
            anchor (which owns the water drop, labels and click box), then bakes into
            shared/layout.ts PLANT_LAYOUT. */}
        <UiEntity uiTransform={{ width: '100%', height: 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', margin: { bottom: 4 } }}>
          <Label value={isPlantToolOn() ? `Plant editor  (${plantToolCount()})` : 'Plant editor'} fontSize={12} color={WHITE} uiTransform={{ flexGrow: 1 }} />
          <ToggleButton value={isPlantToolOn()} onChange={setPlantTool} />
        </UiEntity>
        <Label value={plantSelectedInfo()} fontSize={11} color={MUTED} uiTransform={{ display: isPlantToolOn() ? 'flex' : 'none', width: '100%', height: 18, margin: { bottom: 4 } }} />
        <UiEntity uiTransform={{ display: isPlantToolOn() ? 'flex' : 'none', width: '100%', flexDirection: 'row', margin: { bottom: 4 } }}>
          <SeedBtn label="Select nearest" color={BTN_OFF} onClick={plantSelectNearest} />
          <SeedBtn label={plantIsCarrying() ? "Drop" : "Pick up"} color={BTN_ON} onClick={plantPickUpOrDrop} last />
        </UiEntity>
        <UiEntity uiTransform={{ display: isPlantToolOn() ? 'flex' : 'none', width: '100%', flexDirection: 'row', margin: { bottom: 4 } }}>
          <SeedBtn label="Nudge fwd" color={BTN_OFF} onClick={() => plantNudge('fwd')} />
          <SeedBtn label="Nudge back" color={BTN_OFF} onClick={() => plantNudge('back')} />
          <SeedBtn label="Nudge left" color={BTN_OFF} onClick={() => plantNudge('left')} />
          <SeedBtn label="Nudge right" color={BTN_OFF} onClick={() => plantNudge('right')} last />
        </UiEntity>
        <UiEntity uiTransform={{ display: isPlantToolOn() ? 'flex' : 'none', width: '100%', flexDirection: 'row', margin: { bottom: 4 } }}>
          <SeedBtn label="Up" color={BTN_OFF} onClick={() => plantNudge('up')} />
          <SeedBtn label="Down" color={BTN_OFF} onClick={() => plantNudge('down')} />
          <SeedBtn label="Turn -15" color={BTN_OFF} onClick={plantRotateLeft} />
          <SeedBtn label="Turn +15" color={BTN_OFF} onClick={plantRotateRight} last />
        </UiEntity>
        <UiEntity uiTransform={{ display: isPlantToolOn() ? 'flex' : 'none', width: '100%', flexDirection: 'row', margin: { bottom: 8 } }}>
          <SeedBtn label="Snap 90" color={BTN_OFF} onClick={plantSnap90} />
          <SeedBtn label="Save / export" color={BTN_BLOOM} onClick={plantExport} last />
        </UiEntity>

        {/* Prop editor — lampposts (post + its 3 light overlays move as one), sit spots and the Discord
            buttons. Client-only: Save / export prints a PROP_LAYOUT block to the console. */}
        <UiEntity uiTransform={{ width: '100%', height: 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', margin: { bottom: 4 } }}>
          <Label value={isPropToolOn() ? `Prop editor  (${propToolCount()})` : 'Prop editor (lamps, sit spots)'} fontSize={12} color={WHITE} uiTransform={{ flexGrow: 1 }} />
          <ToggleButton value={isPropToolOn()} onChange={setPropTool} />
        </UiEntity>
        <Label value={propSelectedInfo()} fontSize={11} color={MUTED} uiTransform={{ display: isPropToolOn() ? 'flex' : 'none', width: '100%', height: 18, margin: { bottom: 4 } }} />
        <UiEntity uiTransform={{ display: isPropToolOn() ? 'flex' : 'none', width: '100%', flexDirection: 'row', margin: { bottom: 4 } }}>
          <SeedBtn label="Select nearest" color={BTN_OFF} onClick={propSelectNearest} />
          <SeedBtn label={propIsCarrying() ? 'Drop' : 'Pick up'} color={BTN_ON} onClick={propPickUpOrDrop} last />
        </UiEntity>
        <UiEntity uiTransform={{ display: isPropToolOn() ? 'flex' : 'none', width: '100%', flexDirection: 'row', margin: { bottom: 4 } }}>
          <SeedBtn label="Nudge fwd" color={BTN_OFF} onClick={() => propNudge('fwd')} />
          <SeedBtn label="Nudge back" color={BTN_OFF} onClick={() => propNudge('back')} />
          <SeedBtn label="Nudge left" color={BTN_OFF} onClick={() => propNudge('left')} />
          <SeedBtn label="Nudge right" color={BTN_OFF} onClick={() => propNudge('right')} last />
        </UiEntity>
        <UiEntity uiTransform={{ display: isPropToolOn() ? 'flex' : 'none', width: '100%', flexDirection: 'row', margin: { bottom: 4 } }}>
          <SeedBtn label="Up" color={BTN_OFF} onClick={() => propNudge('up')} />
          <SeedBtn label="Down" color={BTN_OFF} onClick={() => propNudge('down')} />
          <SeedBtn label="Turn -15" color={BTN_OFF} onClick={propRotateLeft} />
          <SeedBtn label="Turn +15" color={BTN_OFF} onClick={propRotateRight} last />
        </UiEntity>
        <UiEntity uiTransform={{ display: isPropToolOn() ? 'flex' : 'none', width: '100%', flexDirection: 'row', margin: { bottom: 8 } }}>
          <SeedBtn label="Snap 90" color={BTN_OFF} onClick={propSnap90} />
          <SeedBtn label="Export to console" color={BTN_BLOOM} onClick={propExport} last />
        </UiEntity>

        {/* Tribute plot editor — same verbs as the planter editor. Edits the PLOTS, not
            the planted roses: only the founding rose exists in-world, so ghost roses stand
            at every plot while this is on (KJ 2026-09-21). */}
        <UiEntity uiTransform={{ width: '100%', height: 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', margin: { bottom: 4 } }}>
          <Label value={isTributeToolOn() ? `Tribute editor  (${tributeCount()})` : 'Tribute editor'} fontSize={12} color={WHITE} uiTransform={{ flexGrow: 1 }} />
          <ToggleButton value={isTributeToolOn()} onChange={setTributeTool} />
        </UiEntity>
        <Label value={tributeSelectedInfo()} fontSize={11} color={MUTED} uiTransform={{ display: isTributeToolOn() ? 'flex' : 'none', width: '100%', height: 18, margin: { bottom: 4 } }} />
        <UiEntity uiTransform={{ display: isTributeToolOn() ? 'flex' : 'none', width: '100%', flexDirection: 'row', margin: { bottom: 4 } }}>
          <SeedBtn label="Select nearest" color={BTN_OFF} onClick={tributeSelectNearest} />
          <SeedBtn label={tributeIsCarrying() ? "Drop" : "Pick up"} color={BTN_ON} onClick={tributePickUpOrDrop} last />
        </UiEntity>
        <UiEntity uiTransform={{ display: isTributeToolOn() ? 'flex' : 'none', width: '100%', flexDirection: 'row', margin: { bottom: 4 } }}>
          <SeedBtn label="Nudge fwd" color={BTN_OFF} onClick={() => tributeNudge('fwd')} />
          <SeedBtn label="Nudge back" color={BTN_OFF} onClick={() => tributeNudge('back')} />
          <SeedBtn label="Nudge left" color={BTN_OFF} onClick={() => tributeNudge('left')} />
          <SeedBtn label="Nudge right" color={BTN_OFF} onClick={() => tributeNudge('right')} last />
        </UiEntity>
        <UiEntity uiTransform={{ display: isTributeToolOn() ? 'flex' : 'none', width: '100%', flexDirection: 'row', margin: { bottom: 4 } }}>
          <SeedBtn label="Turn -15" color={BTN_OFF} onClick={tributeRotateLeft} />
          <SeedBtn label="Turn +15" color={BTN_OFF} onClick={tributeRotateRight} />
          <SeedBtn label="Snap 90" color={BTN_OFF} onClick={tributeSnap90} />
          <SeedBtn label="Face me" color={BTN_OFF} onClick={tributeFaceMe} last />
        </UiEntity>
        <UiEntity uiTransform={{ display: isTributeToolOn() ? 'flex' : 'none', width: '100%', flexDirection: 'row', margin: { bottom: 8 } }}>
          <SeedBtn label="Save / export" color={BTN_BLOOM} onClick={tributeExport} last />
        </UiEntity>

        {/* Crowding rule (GDD §3.1) — tidy the longest-away owner's planter now */}
        <UiEntity
          uiTransform={{ width: '100%', height: 34, alignItems: 'center', justifyContent: 'center', margin: { bottom: 8 } }}
          uiBackground={{ color: BTN_OFF }}
          onMouseDown={adminTidyPlanter}
        >
          <Label value="Tidy longest-away planter (crowding rule)" fontSize={12} color={WHITE} textAlign="middle-center" />
        </UiEntity>

        {/* The Avenue (design/communal-planters.md) — fill/clear real, persisted Rare+
            flowers without a genuine harvest chain per flower */}
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', margin: { bottom: 8 } }}>
          <UiEntity
            uiTransform={{ flexGrow: 1, height: 34, alignItems: 'center', justifyContent: 'center', margin: { right: 4 } }}
            uiBackground={{ color: BTN_BLOOM }}
            onMouseDown={() => adminFillAvenue(8)}
          >
            <Label value="Fill 8 Avenue slots" fontSize={12} color={WHITE} textAlign="middle-center" />
          </UiEntity>
          <UiEntity
            uiTransform={{ flexGrow: 1, height: 34, alignItems: 'center', justifyContent: 'center', margin: { left: 4 } }}
            uiBackground={{ color: BTN_DANGER }}
            onMouseDown={adminClearAvenue}
          >
            <Label value="Clear my Avenue slots" fontSize={12} color={WHITE} textAlign="middle-center" />
          </UiEntity>
        </UiEntity>

        {/* Seedling rarity tint demo — box_1 = Common, box_2 = Epic, clears on the next real update */}
        <UiEntity
          uiTransform={{ width: '100%', height: 34, alignItems: 'center', justifyContent: 'center', margin: { bottom: 8 } }}
          uiBackground={{ color: BTN_OFF }}
          onMouseDown={demoSeedlings}
        >
          <Label value="Demo seedlings (box_1-6: Common, Rare, Epic, Legendary, Exotic, Unique)" fontSize={12} color={WHITE} textAlign="middle-center" />
        </UiEntity>

        {/* Revealed-flower demo — one box per rarity effect tier, box_5..8 */}
        <UiEntity
          uiTransform={{ width: '100%', height: 34, alignItems: 'center', justifyContent: 'center', margin: { bottom: 8 } }}
          uiBackground={{ color: BTN_OFF }}
          onMouseDown={demoRevealedFlowers}
        >
          <Label value="Demo rarity VFX (Rare / Epic / Legendary / Exotic)" fontSize={12} color={WHITE} textAlign="middle-center" />
        </UiEntity>

        {/* Divider */}
        <UiEntity uiTransform={{ width: '100%', height: 1, margin: { bottom: 8 } }} uiBackground={{ color: DIVIDER }} />

        {/* ── Seeds (v2 dev) ────────────────────────────────────── */}
        <Label value={`SEEDS  ·  live: ${getSeedCount()}`} fontSize={10} color={MUTED} uiTransform={{ margin: { bottom: 6 } }} />

        <UiEntity uiTransform={{ width: '100%', height: 32, flexDirection: 'row', margin: { bottom: 5 } }}>
          <SeedBtn label="Seed SHOWER" color={BTN_BLOOM} onClick={() => adminSeedShower()} />
          <SeedBtn label="LOCAL ladder" color={BTN_WATER} onClick={() => adminSpawnSeedLadder()} />
          <SeedBtn label="Spawn SERVER" color={BTN_BLOOM} onClick={() => adminRequestServerSeed(0)} last />
        </UiEntity>
        <UiEntity uiTransform={{ width: '100%', height: 32, flexDirection: 'row', margin: { bottom: 5 } }}>
          <SeedBtn label="Size ×2"  color={BTN_OFF} onClick={() => adminScaleSeeds(2)} />
          <SeedBtn label="Size ÷2"  color={BTN_OFF} onClick={() => adminScaleSeeds(0.5)} />
          <SeedBtn label="Up +0.5"  color={BTN_OFF} onClick={() => adminShiftSeedHeight(0.5)} />
          <SeedBtn label="Down −0.5" color={BTN_OFF} onClick={() => adminShiftSeedHeight(-0.5)} last />
        </UiEntity>
        <UiEntity uiTransform={{ width: '100%', height: 32, flexDirection: 'row', margin: { bottom: 8 } }}>
          <SeedBtn label="List seeds → log" color={BTN_OFF} onClick={adminListSeeds} />
          <SeedBtn label="Clear seeds" color={BTN_DANGER} onClick={clearAllSeeds} last />
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
          value={`Watered:  ${s.wateredCount} / ${s.totalPlants} plants   ·   Your waters today:  ${s.waterRemaining} / ${s.overrideDailyLimit ? 'unlimited' : s.dailyWaterLimit}`}
          fontSize={11}
          color={WHITE}
          uiTransform={{ margin: { bottom: 4 } }}
        />

        <Label
          value={`Bloom:  ${isBloomActive() ? 'ACTIVE' : 'Inactive'}`}
          fontSize={11}
          color={OK_TEXT}
        />

      </UiEntity>
    </UiEntity>
  )
}
