// =============================================================
// Bloom Garden v2 — Info panel (CLIENT ONLY)
//
// "One place players can read everything" (todo.md). Opens from the ? chip
// beside the seed pouch. All text comes from shared/infoCopy so the in-world
// board can render exactly the same words.
//
// One section per page rather than a scroll: scrolling is not verified on both
// explorers, and the seed menu already pages for the same reason.
// Sized from the canvas like the seed menu, after that panel overflowed on a
// narrow window.
// =============================================================

import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { openExternalUrl } from '~system/RestrictedActions'
import { INFO_SECTIONS, DISCORD_URL } from './shared/infoCopy'

let open = false
let page = 0

export function isInfoOpen(): boolean { return open }
export function toggleInfo(): void { open = !open; if (!open) page = 0 }

const DARK   = { r: 0.085, g: 0.078, b: 0.067, a: 0.95 }
const RAISED = { r: 1, g: 1, b: 1, a: 0.08 }
const CREAM  = { r: 0.957, g: 0.918, b: 0.824, a: 1 }
const DIM    = { r: 0.83,  g: 0.82,  b: 0.78,  a: 1 }
const MOSS   = { r: 0.18,  g: 0.49,  b: 0.34,  a: 1 }

export function InfoPanelUi(props: {
  px: (n: number) => number; fs: (n: number) => number
  mobile: boolean; topPx: number; aboveChipPx: number; maxW: number; maxH: number
  /** Replay / Resume tutorial — replaces the old standalone Tutorial pill (2026-09-29). */
  tutorialLabel: string; onTutorial: () => void
}) {
  if (!open) return null
  const { px, fs, mobile } = props
  const W = Math.max(px(300), Math.min(px(mobile ? 640 : 520), props.maxW - px(24)))
  const PAD = px(18)
  const pages = INFO_SECTIONS.length
  page = Math.min(page, pages - 1)
  const s = INFO_SECTIONS[page]
  const last = page === pages - 1

  const panel = (
    <UiEntity
      uiTransform={{ width: W, flexDirection: 'column', padding: { left: PAD, right: PAD, top: PAD, bottom: PAD }, borderRadius: px(18) }}
      uiBackground={{ color: DARK }}
    >
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', alignItems: 'center', margin: { bottom: px(10) } }}>
        <Label value="How the garden works" fontSize={fs(24)} color={CREAM} textAlign="middle-left" uiTransform={{ flexGrow: 1, height: fs(34) }} />
        <UiEntity uiTransform={{ width: px(34), height: px(34), alignItems: 'center', justifyContent: 'center' }} onMouseDown={toggleInfo}>
          <Label value="x" fontSize={fs(22)} color={DIM} textAlign="middle-center" uiTransform={{ width: '100%', height: '100%' }} />
        </UiEntity>
      </UiEntity>

      <UiEntity
        uiTransform={{ width: '100%', height: px(40), alignItems: 'center', justifyContent: 'center', margin: { bottom: px(8) }, borderRadius: px(20) }}
        uiBackground={{ color: MOSS }}
        onMouseDown={() => { toggleInfo(); props.onTutorial() }}
      >
        <Label value={props.tutorialLabel} fontSize={fs(16)} color={CREAM} textAlign="middle-center" textWrap="nowrap" uiTransform={{ height: '100%' }} />
      </UiEntity>

      <Label value={s.title} fontSize={fs(19)} color={{ ...MOSS, r: 0.45, g: 0.82, b: 0.6 }} textAlign="middle-left" uiTransform={{ width: '100%', height: fs(28) }} />

      {s.lines.map((line, i) => (
        <Label
          key={`l${page}_${i}`}
          value={line}
          fontSize={fs(15)}
          color={DIM}
          textAlign="top-left"
          textWrap="wrap"
          uiTransform={{ width: '100%', height: fs(21) * Math.max(2, Math.ceil(line.length / Math.max(28, W / px(9)))), margin: { bottom: px(6) } }}
        />
      ))}

      {/* Discord lives on the last page — the only Discord link now that the scene buttons are hidden again. */}
      <UiEntity
        uiTransform={{ display: last ? 'flex' : 'none', width: '100%', height: px(40), alignItems: 'center', justifyContent: 'center', margin: { top: px(6), bottom: px(6) }, borderRadius: px(20) }}
        uiBackground={{ color: MOSS }}
        onMouseDown={() => { void openExternalUrl({ url: DISCORD_URL }) }}
      >
        <Label value="Join the Discord" fontSize={fs(16)} color={CREAM} textAlign="middle-center" textWrap="nowrap" uiTransform={{ height: '100%' }} />
      </UiEntity>

      <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', alignItems: 'center', margin: { top: px(6) } }}>
        <UiEntity
          uiTransform={{ width: px(96), height: px(38), alignItems: 'center', justifyContent: 'center', borderRadius: px(10) }}
          uiBackground={{ color: RAISED }}
          onMouseDown={() => { if (page > 0) page-- }}
        >
          <Label value="Prev" fontSize={fs(15)} color={page > 0 ? CREAM : DIM} textAlign="middle-center" textWrap="nowrap" uiTransform={{ height: '100%' }} />
        </UiEntity>
        <Label value={`${page + 1} / ${pages}`} fontSize={fs(15)} color={DIM} textAlign="middle-center" uiTransform={{ flexGrow: 1, height: px(38) }} />
        <UiEntity
          uiTransform={{ width: px(96), height: px(38), alignItems: 'center', justifyContent: 'center', borderRadius: px(10) }}
          uiBackground={{ color: RAISED }}
          onMouseDown={() => { if (page < pages - 1) page++ }}
        >
          <Label value="Next" fontSize={fs(15)} color={!last ? CREAM : DIM} textAlign="middle-center" textWrap="nowrap" uiTransform={{ height: '100%' }} />
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )

  return props.mobile
    ? <UiEntity uiTransform={{ positionType: 'absolute', position: { top: props.topPx, left: 0 }, width: '100%', flexDirection: 'row', justifyContent: 'center' }}>{panel}</UiEntity>
    : <UiEntity uiTransform={{ positionType: 'absolute', position: { bottom: props.aboveChipPx, left: 0 }, width: '100%', flexDirection: 'row', justifyContent: 'center' }}>{panel}</UiEntity>
}
