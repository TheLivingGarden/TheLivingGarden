// =============================================================
// TEMP — digit lab (KJ 2026-09-30). Some digits render small and grey in our UI on Explorer v0.182 while Clean The Club (same client,
// SDK 7.26.1) is fine. Each row prints the same digits with ONE thing changed, so the first row that breaks names the cause. Remove
// (SHOW_DIGIT_LAB = false, then delete this file) once the cause is known.
//
//   1 raw 17        plain Label, fixed fontSize, NO scaling helper, no other props
//   2 raw 24 / 3 raw 12   the same at two other sizes
//   4 fs(17)        the HUD's scaled size, otherwise plain
//   5 alpha .85     translucent colour (the HUD fades a lot of text)
//   6 textAlign     'middle-center'
//   7 nowrap        textWrap 'nowrap' + fixed-height parent (how most of our labels are built)
//   8 spaced        digits separated by spaces (does adjacency matter?)
//   9 real strings  the strings that broke: 84%, 1:49, 29, 31, 4 gardeners, opens in 4m
// =============================================================

import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'

export const SHOW_DIGIT_LAB = true

const WHITE = { r: 1, g: 1, b: 1, a: 1 }
const DIGITS = '0123456789'

export function DigitLabUi(props: { px: (n: number) => number; fs: (n: number) => number }) {
  if (!SHOW_DIGIT_LAB) return null
  const { px, fs } = props
  const row = (tag: string, label: ReactEcs.JSX.Element) => (
    <UiEntity key={tag} uiTransform={{ width: '100%', flexDirection: 'row', alignItems: 'center', margin: { bottom: px(2) } }}>
      <Label value={tag} fontSize={11} color={{ ...WHITE, a: 0.55 }} uiTransform={{ width: px(70), height: 16 }} />
      {label}
    </UiEntity>
  )
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { top: px(170), left: px(10) }, width: px(470), flexDirection: 'column', padding: px(8), borderRadius: px(10) }}
      uiBackground={{ color: { r: 0.04, g: 0.04, b: 0.05, a: 0.88 } }}
    >
      <Label value="DIGIT LAB — which rows show small grey digits?" fontSize={12} color={{ r: 1, g: 0.8, b: 0.4, a: 1 }} uiTransform={{ height: 18 }} />
      {row('1 raw 17', <Label value={DIGITS} fontSize={17} color={WHITE} />)}
      {row('2 raw 24', <Label value={DIGITS} fontSize={24} color={WHITE} />)}
      {row('3 raw 12', <Label value={DIGITS} fontSize={12} color={WHITE} />)}
      {row('4 fs(17)', <Label value={DIGITS} fontSize={fs(17)} color={WHITE} />)}
      {row('5 alpha', <Label value={DIGITS} fontSize={fs(17)} color={{ ...WHITE, a: 0.85 }} />)}
      {row('6 align', <Label value={DIGITS} fontSize={fs(17)} color={WHITE} textAlign="middle-center" />)}
      {row('7 nowrap', <UiEntity uiTransform={{ height: fs(22), width: px(200) }}><Label value={DIGITS} fontSize={fs(17)} color={WHITE} textAlign="middle-center" textWrap="nowrap" uiTransform={{ width: '100%', height: '100%' }} /></UiEntity>)}
      {row('8 spaced', <Label value="0 1 2 3 4 5 6 7 8 9" fontSize={fs(17)} color={WHITE} />)}
      {row('9 real', <Label value="84%  1:49  29  31  4 gardeners  opens in 4m" fontSize={fs(15)} color={WHITE} />)}
      {row('10 raw 17 x2', <Label value="0123456789 0123456789" fontSize={17} color={WHITE} />)}
    </UiEntity>
  )
}
