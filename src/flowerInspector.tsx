// =============================================================
// Bloom Garden v2 — Flower inspector (CLIENT ONLY)
//
// KJ 2026-09-30: click a flower on the shelf to put it in your hand and on the examination table; click the TABLE to open
// this — the flower and everything the game knows about it. Same look and the same explicit-height rows as the Avenue card
// (avenueCard.tsx): everything this keepsake has a value for, nothing for what it lacks.
//
// Own state + own entry point (examTable.ts opens it), rendered by ui.tsx.
// =============================================================

import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import {
  rarityTierById, plantSpeciesById, PLANT_SPECIES, RARITY_TIERS, stampTotal, galleryBoostOf, AVENUE_MIN_TIER,
  growMsForTier, formatGrowTime, legendTier,
} from './shared/config'
import { Keepsake, getDiscovered, getFlowers, stampsFound } from './playerInventory'

let inspected: Keepsake | null = null

export function openFlowerInspector(k: Keepsake): void { inspected = k }
export function closeFlowerInspector(): void { inspected = null }
export function isFlowerInspectorOpen(): boolean { return inspected !== null }

const DARK   = { r: 0.085, g: 0.078, b: 0.067, a: 0.95 }
const RAISED = { r: 1, g: 1, b: 1, a: 0.08 }
const CREAM  = { r: 0.957, g: 0.918, b: 0.824, a: 1 }
const DIM    = { r: 0.83,  g: 0.82,  b: 0.78,  a: 1 }
const INK    = { r: 0.07,  g: 0.065, b: 0.06,  a: 1 }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function fmtDate(ms: number): string {
  const d = new Date(ms)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
}
function span(ms: number): string {
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `${Math.max(1, mins)} min`
  const hrs = Math.round(mins / 60)
  return hrs < 48 ? `${hrs} h` : `${Math.round(hrs / 24)} days`
}

export function FlowerInspectorUi(props: { px: (n: number) => number; fs: (n: number) => number; mobile: boolean; maxH: number }) {
  if (!inspected) return null
  const { px, fs } = props
  const k = inspected
  const tier = rarityTierById(k.rarityTier)
  const sp = plantSpeciesById(k.flower)
  const name = sp?.name ?? k.flower

  // What the game knows about this one flower, then about the species it belongs to.
  const rows: Array<{ k: string; v: string }> = []
  if (k.grownBy) rows.push({ k: 'Grown by', v: k.grownBy })
  if (k.from) rows.push({ k: 'A gift from', v: k.from })
  if (k.plantedAt) rows.push({ k: 'Planted', v: fmtDate(k.plantedAt) })
  const opened = k.openedAt ?? k.at
  if (opened) rows.push({ k: 'Opened', v: fmtDate(opened) })
  if (k.plantedAt && opened && opened > k.plantedAt) rows.push({ k: 'Took to grow', v: `${span(opened - k.plantedAt)} (a ${tier.name} seed takes ${formatGrowTime(growMsForTier(k.rarityTier))} unaided)` })
  if (k.helpers && k.helpers.length > 0) rows.push({ k: k.helpers.length === 1 ? 'Watered by' : `Watered by ${k.helpers.length}`, v: k.helpers.join(', ') })
  const copies = getFlowers().filter(f => f.flower === k.flower && f.rarityTier === k.rarityTier).length
  if (copies > 0) rows.push({ k: 'You keep', v: `${copies} of this ${tier.name} flower` })
  const seen = getDiscovered().get(k.flower)
  if (seen && seen.size > 0) {
    const found = RARITY_TIERS.filter(t => seen.has(t.id)).map(t => t.name)
    rows.push({ k: 'Found as', v: `${found.join(', ')}  (${seen.size} of ${RARITY_TIERS.length})` })
  }
  const species = [...getDiscovered().keys()].filter(id => legendTier(id) < 0).length
  rows.push({ k: 'Your Collection', v: `${species} of ${PLANT_SPECIES.length} species, ${stampsFound()} of ${stampTotal()} rarity stamps` })
  // The Gallery feeds the Bloom: a flower on show makes every Bloom's seeds rarer — say what THIS one would add.
  if (k.rarityTier >= AVENUE_MIN_TIER && galleryBoostOf(k.rarityTier) > 0) {
    rows.push({ k: 'On show', v: `would make every Bloom's rare seeds +${Math.round(galleryBoostOf(k.rarityTier) * 100)}% for everyone` })
  }

  const cardW = px(props.mobile ? 560 : 400)
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', flexDirection: 'row', justifyContent: 'center', alignItems: 'center' }}>
      <UiEntity
        uiTransform={{ width: cardW, maxHeight: props.maxH, flexDirection: 'column', alignItems: 'center', padding: { left: px(22), right: px(22), top: px(16), bottom: px(18) }, borderRadius: px(22) }}
        uiBackground={{ color: DARK }}
      >
        <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', justifyContent: 'flex-end', height: px(30) }}>
          <UiEntity uiTransform={{ width: px(34), height: px(30), alignItems: 'center', justifyContent: 'center', borderRadius: px(15) }} uiBackground={{ color: RAISED }} onMouseDown={closeFlowerInspector}>
            <Label value="x" fontSize={fs(16)} color={DIM} textAlign="middle-center" textWrap="nowrap" uiTransform={{ width: '100%', height: '100%' }} />
          </UiEntity>
        </UiEntity>

        {sp
          ? <UiEntity uiTransform={{ width: px(124), height: px(124) }} uiBackground={{ textureMode: 'stretch', texture: { src: `assets/images/plantThumbs/${k.flower}.png` } }} />
          : <UiEntity uiTransform={{ width: px(124), height: px(124), alignItems: 'center', justifyContent: 'center' }}>
              <UiEntity uiTransform={{ width: px(60), height: px(60), borderRadius: px(30) }} uiBackground={{ color: { ...tier.seedColor, a: 1 } }} />
            </UiEntity>}

        <Label value={name} fontSize={fs(24)} color={CREAM} textAlign="middle-center" textWrap="wrap" uiTransform={{ width: '100%', height: fs(34), margin: { top: px(4) } }} />
        <UiEntity uiTransform={{ width: px(140), height: px(30), margin: { top: px(6), bottom: px(10) }, alignItems: 'center', justifyContent: 'center', borderRadius: px(15) }} uiBackground={{ color: k.rarityTier > 0 ? { ...tier.seedColor, a: 1 } : { r: 1, g: 1, b: 1, a: 0.12 } }}>
          <Label value={tier.name} fontSize={fs(15)} color={k.rarityTier > 0 ? INK : CREAM} textAlign="middle-center" textWrap="nowrap" uiTransform={{ height: '100%' }} />
        </UiEntity>

        {rows.map(r => {
          // Explicit heights (the phone collapses a heightless wrapped Label) — line count estimated at ~0.55 em per character.
          const valueW = (cardW - px(22) * 2) * 0.62
          const font = fs(13)
          const lines = Math.max(1, Math.ceil((r.v.length * font * 0.55) / valueW))
          const h = Math.max(fs(20), Math.round(lines * font * 1.3))
          return (
            <UiEntity key={r.k} uiTransform={{ width: '100%', height: h, flexDirection: 'row', alignItems: 'flex-start', margin: { bottom: px(6) }, flexShrink: 0 }}>
              <Label value={r.k} fontSize={font} color={DIM} textAlign="top-left" textWrap="nowrap" uiTransform={{ width: '38%', height: fs(20) }} />
              <Label value={r.v} fontSize={font} color={CREAM} textAlign="top-left" textWrap="wrap" uiTransform={{ width: '62%', height: h }} />
            </UiEntity>
          )
        })}
      </UiEntity>
    </UiEntity>
  )
}
