// =============================================================
// Bloom Garden v2 — Seed menu (CLIENT ONLY)
//
// Opens from the seed chip. Two TABS (Fin playtest 2026-09-21 — he reached for the
// headings expecting them to switch and filter, and both sections sharing one panel left
// the flower grid two rows tall):
//   Seeds       what you hold, grouped by rarity tier — tap a tile to choose which
//               tier the next planting uses (replaced the old Normal/Rare two-button
//               toggle 2026-09-18, when rarity grew from 2 tiers to 8)
//   Flowers     your keepsakes (grouped, species thumbnail, the NAME carried on a
//               tier-coloured background rather than a small dot beside it), a row of
//               tappable rarity filters, species collection progress, Hold and Gift
// Phone: a centred sheet (both thumbs stay free). Desktop: docked under the
// ring on the right, so the garden stays visible.
// Reads playerInventory + the rarity/species tables — no gameplay imports.
// =============================================================

import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { PLANT_SPECIES, RARITY_TIERS, rarityTierById, plantSpeciesById, nextMilestone, milestoneTarget, milestoneTitle, growMsForTier, shortGrowTime, AVENUE_MIN_TIER, stampTotal, nextStampMilestone, stampMilestoneTarget } from './shared/config'
import { setPreferredTier, nextSeedTier, getPouch, getFlowers, getDiscovered, stampsFound, gardenersHere, giveFlower, getHeld, holdFlower, holdSeed, displayOnAvenue, armAvenuePlacement } from './playerInventory'
import { showToast } from './notifications'

/** 128 px thumbnails made from each species' asset-pack thumbnail.png (assets/images/plantThumbs). */
const thumbSrc = (flower: string) => `assets/images/plantThumbs/${flower}.png`
const speciesName = (flower: string) => plantSpeciesById(flower)?.name ?? flower

let open = false
let tab: 'seeds' | 'flowers' | 'almanac' = 'seeds'
let almanacFilter: 'all' | 'found' | 'missing' = 'all'
let almanacPage = 0
let almanacSel: string | null = null   // species id whose rarity breakdown is open
let tierFilter: number | null = null   // Flowers tab: show one rarity only; null = all
let selectedKey = ''      // `${flower}|${rarityTier}` of the tile picked in Flowers
let giftMode = false      // choosing who to give the selected flower to
let giftPage = 0          // week-2 playtest: "only get a choice of the same 5 people"
const GIFT_PAGE = 5
let page = 0              // Flowers page (pagination — scrolling isn't verified on both explorers)
let avenueSlot: string | null = null   // set when opened by tapping an empty Avenue planter: Display goes THERE

export function isSeedMenuOpen(): boolean { return open }
export function toggleSeedMenu(): void { open = !open; if (!open) { selectedKey = ''; giftMode = false; giftPage = 0; page = 0; almanacPage = 0; almanacSel = null; tierFilter = null; avenueSlot = null } }
export function openSeedMenu(): void { open = true }
/** Opened from the world seed rack's gift board: the Flowers tab, where a kept flower is picked and given. */
export function openSeedMenuFlowers(): void { open = true; tab = 'flowers'; selectedKey = ''; giftMode = false; page = 0 }
/** Tapped an empty Avenue planter with nothing in hand: open Flowers so they can pick one for it. */
export function openSeedMenuForAvenue(slotId: string): void { open = true; tab = 'flowers'; avenueSlot = slotId; selectedKey = ''; giftMode = false; page = 0; armAvenuePlacement(null) }

/** The keepsake index the menu currently has selected for gifting, or null if none —
 *  the world tap-a-player shortcut reuses this instead of guessing "the newest one". */
export function getSelectedGiftIndex(): number | null {
  if (!selectedKey) return null
  const g = groupFlowers().find(g => g.key === selectedKey)
  return g ? g.lastIndex : null
}

const DARK   = { r: 0.085, g: 0.078, b: 0.067, a: 0.95 }
const RAISED = { r: 1, g: 1, b: 1, a: 0.08 }
const CREAM  = { r: 0.957, g: 0.918, b: 0.824, a: 1 }
const DIM    = { r: 0.83,  g: 0.82,  b: 0.78,  a: 1 }
const MOSS   = { r: 0.18,  g: 0.49,  b: 0.34,  a: 1 }
/** Text that sits ON a rarity colour. Every tier colour is mid-to-bright, so ink reads. */
const INK    = { r: 0.07,  g: 0.065, b: 0.06,  a: 1 }
/** Rarity is carried by the WHOLE TILE, not by a plate behind the name. Two greys stacked
 *  inside each other read as an unfinished placeholder (KJ screenshots 2026-09-21), and a
 *  fixed-height plate cannot hold a name like "Large Yellow-Green Grass Mound" — the text
 *  spilled straight out of it. A tinted tile is still the coloured background Fin asked
 *  for instead of a dot, just at the scale that actually has room for the words.
 *  Common stays neutral: it is the ABSENCE of rarity, and that is what makes a rare land. */
const tileBg = (t: number) => (t > 0 ? { ...rarityTierById(t).seedColor, a: 0.22 } : RAISED)
/** Selection is a white outline, not a fill (KJ 2026-09-22) — the tile keeps its rarity tint. */
const OUTLINE = { r: 1, g: 1, b: 1, a: 0.9 }
const NO_LINE = { r: 0, g: 0, b: 0, a: 0 }

const TILE_COLS  = 4
/** Everything above the flower grid (tabs, stats, filter row, pager) in virtual px, used
 *  to work out how many grid rows fit this canvas. Far less than when both sections
 *  shared one panel — which is most of the point of splitting them into tabs. */
const FLOWERS_CHROME_H = 250
const FLOWER_ROW_H     = 126
const FLOWER_MAX_ROWS  = 3

/** A keepsake written before the 8-tier migration can carry a missing or out-of-range
 *  tier. `rarityTierById` resolves any of those to Common, so they LOOK common but are
 *  distinct Set members — which is what put two "Common" chips in the filter row
 *  (KJ screenshot 2026-09-21). Normalise once, here, where flowers enter the UI. */
const safeTier = (t: number): number => (Number.isInteger(t) && t >= 0 && t < RARITY_TIERS.length ? t : 0)

export interface Group { key: string; flower: string; rarityTier: number; count: number; lastIndex: number }
export function groupFlowers(): Group[] {
  const map = new Map<string, Group>()
  getFlowers().forEach((raw, i) => {
    const f = { ...raw, rarityTier: safeTier(raw.rarityTier) }
    const key = `${f.flower}|${f.rarityTier}`
    const g = map.get(key)
    if (g) { g.count++; g.lastIndex = i } else map.set(key, { key, flower: f.flower, rarityTier: f.rarityTier, count: 1, lastIndex: i })
  })
  return [...map.values()].sort((a, b) => b.rarityTier - a.rarityTier || b.lastIndex - a.lastIndex)   // rarest first, then newest
}

interface TierGroup { tier: number; count: number }
function groupPouch(): TierGroup[] {
  const pouch = getPouch()
  const out: TierGroup[] = []
  for (let tier = 0; tier < pouch.length; tier++) if (pouch[tier] > 0) out.push({ tier, count: pouch[tier] })
  return out.sort((a, b) => b.tier - a.tier)   // rarest first
}

/** The whole catalogue, in a FIXED order (catalogue order, not found-first): a tile that
 *  never moves is what lets a collection be learned and what makes a gap read as a gap.
 *  `bestTier` is the rarest copy they hold of that species — the tile wears that colour. */
interface AlmanacEntry { id: string; name: string; found: boolean; bestTier: number; count: number; tiers: ReadonlySet<number> }
function almanac(): AlmanacEntry[] {
  const byId = new Map<string, { bestTier: number; count: number }>()
  for (const raw of getFlowers()) {
    const t = safeTier(raw.rarityTier)
    const cur = byId.get(raw.flower)
    if (cur) { cur.count++; if (t > cur.bestTier) cur.bestTier = t } else byId.set(raw.flower, { bestTier: t, count: 1 })
  }
  // `found` comes from the server's DISCOVERED set, not from what is kept: a flower left
  // on show in its planter counts. The count and colour still come from the collection,
  // so a discovered-but-not-kept species shows its art with no "x2" and a neutral tile.
  const seen = getDiscovered()
  return PLANT_SPECIES.map(sp => {
    const hit   = byId.get(sp.id)
    const tiers = new Set<number>(seen.get(sp.id) ?? [])
    if (hit) tiers.add(hit.bestTier)   // kept but predating the tier-keyed records
    return { id: sp.id, name: sp.name, found: seen.has(sp.id) || !!hit, bestTier: hit?.bestTier ?? 0, count: hit?.count ?? 0, tiers }
  })
}

export function SeedMenuUi(props: { px: (n: number) => number; fs: (n: number) => number; mobile: boolean; topPx: number; aboveChipPx: number; maxW: number; maxH: number }) {
  if (!open) return null
  const { px, fs, mobile } = props
  // Clamp to the canvas: a fixed virtual width overflowed its parent on a narrow window
  // and the 4-column row silently wrapped to 3 (KJ 2026-09-20).
  const W      = Math.max(px(300), Math.min(px(mobile ? 640 : 440), props.maxW - px(24)))
  const PAD    = px(18)
  const pouchGroups = groupPouch()
  const total  = pouchGroups.reduce((a, g) => a + g.count, 0)
  const next   = nextSeedTier()
  const allGroups = groupFlowers()
  // Which rarities they actually own, rarest first — the filter row only ever offers
  // tiers that would show something.
  const ownedTiers = [...new Set((avenueSlot !== null ? allGroups.filter(g => g.rarityTier >= AVENUE_MIN_TIER) : allGroups).map(g => g.rarityTier))].sort((a, b) => b - a)
  if (tierFilter !== null && !ownedTiers.includes(tierFilter)) tierFilter = null   // gifted the last one away
  // Avenue mode HIDES what can't go (KJ 2026-09-22): greying them out read as "everything
  // is grey" on a page of Commons — there was nothing eligible on screen to contrast with.
  const eligible = avenueSlot !== null ? allGroups.filter(g => g.rarityTier >= AVENUE_MIN_TIER) : allGroups
  const groups = tierFilter === null ? eligible : eligible.filter(g => g.rarityTier === tierFilter)
  // Rows that fit the height, so the pager never lands off the bottom edge.
  const rows       = Math.max(1, Math.min(FLOWER_MAX_ROWS, Math.floor((props.maxH - px(FLOWERS_CHROME_H)) / px(FLOWER_ROW_H))))
  const pageTiles  = rows * TILE_COLS
  const pages  = Math.max(1, Math.ceil(groups.length / pageTiles))
  page         = Math.min(page, pages - 1)   // collection shrank (gift / tidy / filter) — stay in range
  const shown  = groups.slice(page * pageTiles, (page + 1) * pageTiles)
  const almanacAll   = almanac()
  const speciesFound = almanacAll.filter(e => e.found).length
  const almanacList  = almanacFilter === 'all' ? almanacAll : almanacAll.filter(e => (almanacFilter === 'found' ? e.found : !e.found))
  const almanacPages = Math.max(1, Math.ceil(almanacList.length / pageTiles))
  almanacPage        = Math.min(almanacPage, almanacPages - 1)
  const almanacShown = almanacList.slice(almanacPage * pageTiles, (almanacPage + 1) * pageTiles)
  const selSpecies   = almanacSel ? almanacAll.find(e => e.id === almanacSel) ?? null : null
  const goal         = nextMilestone(speciesFound)
  const earnedTitle  = milestoneTitle(speciesFound)
  const sel    = groups.find(g => g.key === selectedKey) ?? null
  const here   = giftMode ? gardenersHere() : []
  const giftPages = Math.max(1, Math.ceil(here.length / GIFT_PAGE))
  if (giftPage > giftPages - 1) giftPage = giftPages - 1   // someone left mid-page
  const tileW  = Math.floor((W - PAD * 2 - px(8) * (TILE_COLS - 1)) / TILE_COLS)
  const held   = getHeld()
  const isHeld = (g: Group) => !!held && held.flower === g.flower && held.rarityTier === g.rarityTier

  /** One tile — reused for both the seed pouch (tap = choose what plants next) and
   *  the flower collection (tap = choose what to gift). Same visual language: a
   *  tier-colored swatch + label, so "this is rarity" reads consistently everywhere.
   *  `i` positions it in a 4-column wrapped row (no right-margin on every 4th). */
  const tile = (key: string, i: number, tier: number, count: number, active: boolean, onClick: () => void) => (
    <UiEntity
      key={key}
      uiTransform={{ width: tileW, height: px(112), margin: { right: (i % TILE_COLS) === TILE_COLS - 1 ? 0 : px(8), bottom: px(8) }, flexDirection: 'column', alignItems: 'center', justifyContent: 'center', borderRadius: px(14), borderWidth: px(3), borderColor: active ? OUTLINE : NO_LINE }}
      uiBackground={{ color: tileBg(tier) }}
      onMouseDown={onClick}
    >
      <UiEntity uiTransform={{ width: px(16), height: px(16), borderRadius: px(8), margin: { bottom: px(8) } }} uiBackground={{ color: { ...rarityTierById(tier).seedColor, a: 1 } }} />
      {/* Name and count on their own lines on purpose — "Uncommon 25" was wrapping into
          two ragged lines on a narrow tile, which looked like a bug rather than a layout. */}
      <Label value={rarityTierById(tier).name} fontSize={fs(13)} color={CREAM} textAlign="middle-center" textWrap="nowrap" uiTransform={{ width: '100%', height: fs(18) }} />
      <Label value={`${count}`} fontSize={fs(17)} color={{ ...CREAM, a: 0.75 }} textAlign="middle-center" textWrap="nowrap" uiTransform={{ width: '100%', height: fs(22) }} />
      {/* The wait is part of what a rare IS, so it belongs at the moment you choose. */}
      <Label value={`opens in ${shortGrowTime(growMsForTier(tier))}`} fontSize={fs(11)} color={{ ...DIM, a: 0.7 }} textAlign="middle-center" textWrap="nowrap" uiTransform={{ width: '100%', height: fs(16) }} />
    </UiEntity>
  )

  /** Flower tile: the species thumbnail, a rarity dot top-right, the name underneath
   *  (wraps to two lines), and "in hand" when it's the kind you're holding. */
  const flowerTile = (g: Group, i: number) => (
    <UiEntity
      key={g.key}
      uiTransform={{ width: tileW, height: px(126), margin: { right: (i % TILE_COLS) === TILE_COLS - 1 ? 0 : px(8), bottom: px(8) }, flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', padding: { top: px(8), left: px(4), right: px(4), bottom: px(4) }, borderRadius: px(14), borderWidth: px(3), borderColor: g.key === selectedKey ? OUTLINE : NO_LINE }}
      uiBackground={{ color: tileBg(g.rarityTier) }}
      onMouseDown={() => { selectedKey = selectedKey === g.key ? '' : g.key; giftMode = false }}
    >
      {plantSpeciesById(g.flower)
        ? <UiEntity uiTransform={{ width: px(68), height: px(68) }} uiBackground={{ textureMode: 'stretch', texture: { src: thumbSrc(g.flower) } }} />
        : /* pre-catalog keepsake (Tulip/Poppy/Daisy/Moonbloom/Sunflare, old two-tier list): no species → no thumbnail */
          <UiEntity uiTransform={{ width: px(68), height: px(68), alignItems: 'center', justifyContent: 'center' }}>
            <UiEntity uiTransform={{ width: px(36), height: px(36), borderRadius: px(18) }} uiBackground={{ color: { ...rarityTierById(g.rarityTier).seedColor, a: 1 } }} />
          </UiEntity>}
      {/* flexGrow, not a fixed plate: the name box takes whatever the thumbnail left, so
          there is never dead space under a short name nor spilled text under a long one. */}
      <UiEntity uiTransform={{ width: '100%', flexGrow: 1, alignItems: 'center', justifyContent: 'center', margin: { top: px(4) } }}>
        <Label value={g.count > 1 ? `${speciesName(g.flower)} x${g.count}` : speciesName(g.flower)} fontSize={fs(11)} color={CREAM} textAlign="middle-center" textWrap="wrap" uiTransform={{ width: '100%' }} />
      </UiEntity>
      <Label value="in hand" fontSize={fs(10)} color={{ ...MOSS, g: 0.8 }} textAlign="middle-center" textWrap="nowrap" uiTransform={{ display: isHeld(g) ? 'flex' : 'none', width: '100%', height: fs(13) }} />
    </UiEntity>
  )

  /** Tab head. Selected = moss fill; the count rides in the label so the tab itself
   *  tells you whether there is anything behind it. */
  const tabButton = (id: 'seeds' | 'flowers' | 'almanac', label: string) => (
    <UiEntity
      key={`tab-${id}`}
      uiTransform={{ height: px(40), padding: { left: px(18), right: px(18) }, margin: { right: px(8) }, alignItems: 'center', justifyContent: 'center', borderRadius: px(20) }}
      uiBackground={{ color: tab === id ? MOSS : RAISED }}
      onMouseDown={() => { if (tab !== id) { tab = id; selectedKey = ''; giftMode = false; page = 0 } }}
    >
      <Label value={label} fontSize={fs(17)} color={tab === id ? CREAM : DIM} textAlign="middle-center" textWrap="nowrap" uiTransform={{ height: '100%' }} />
    </UiEntity>
  )

  /** One rarity filter. Unselected chips carry their colour as a thin tint so the row
   *  reads as a legend even before you tap anything. */
  const filterChip = (key: string, label: string, t: number | null, color: { r: number; g: number; b: number; a: number }) => {
    const on = tierFilter === t
    return (
      <UiEntity
        key={`f-${key}`}
        uiTransform={{ height: px(32), padding: { left: px(12), right: px(12) }, margin: { right: px(6), bottom: px(6) }, alignItems: 'center', justifyContent: 'center', borderRadius: px(16) }}
        uiBackground={{ color: on ? color : { ...color, a: 0.22 } }}
        onMouseDown={() => { tierFilter = on ? null : t; page = 0; selectedKey = ''; giftMode = false }}
      >
        <Label value={label} fontSize={fs(13)} color={on ? INK : CREAM} textAlign="middle-center" textWrap="nowrap" uiTransform={{ height: '100%' }} />
      </UiEntity>
    )
  }

  /** One catalogue slot. Found = the real thumbnail and its rarity colour; missing = the
   *  same art multiplied to black, so the silhouette tells you what you are hunting
   *  without telling you what it is. */
  const almanacTile = (e: AlmanacEntry, i: number) => (
    <UiEntity
      key={`a-${e.id}`}
      uiTransform={{ width: tileW, height: px(136), margin: { right: (i % TILE_COLS) === TILE_COLS - 1 ? 0 : px(8), bottom: px(8) }, flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', padding: { top: px(8), left: px(4), right: px(4), bottom: px(6) }, borderRadius: px(14), borderWidth: px(3), borderColor: almanacSel === e.id ? OUTLINE : NO_LINE }}
      uiBackground={{ color: e.found ? tileBg(e.bestTier) : { r: 1, g: 1, b: 1, a: 0.03 } }}
      onMouseDown={() => { almanacSel = almanacSel === e.id ? null : e.id }}
    >
      <UiEntity uiTransform={{ width: px(68), height: px(68) }} uiBackground={{ textureMode: 'stretch', texture: { src: thumbSrc(e.id) }, color: e.found ? { r: 1, g: 1, b: 1, a: 1 } : { r: 0, g: 0, b: 0, a: 0.55 } }} />
      <UiEntity uiTransform={{ width: '100%', flexGrow: 1, alignItems: 'center', justifyContent: 'center', margin: { top: px(4) } }}>
        <Label value={e.found ? (e.count > 1 ? `${e.name} x${e.count}` : e.name) : '???'} fontSize={fs(11)} color={e.found ? CREAM : { ...DIM, a: 0.45 }} textAlign="middle-center" textWrap="wrap" uiTransform={{ width: '100%' }} />
      </UiEntity>
      {/* One pip per rarity, lit for the ones you have actually seen this species at.
          Species and tier roll independently, so this is the depth under the headline
          count — and it says at a glance what is still missing on a flower you "have". */}
      <UiEntity uiTransform={{ width: '100%', height: px(9), flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
        {RARITY_TIERS.map(t => (
          <UiEntity
            key={`p-${e.id}-${t.id}`}
            uiTransform={{ width: px(7), height: px(7), margin: { left: px(1), right: px(1) }, borderRadius: px(4) }}
            uiBackground={{ color: e.tiers.has(t.id) ? { ...t.seedColor, a: 1 } : { r: 1, g: 1, b: 1, a: 0.12 } }}
          />
        ))}
      </UiEntity>
    </UiEntity>
  )

  /** The breakdown for one species: every rarity it can come in, and which you have seen.
   *  Replaces the grid rather than floating over it — the panel is already a sheet. */
  const almanacDetail = (e: AlmanacEntry) => (
    <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', margin: { top: px(8) } }}>
      <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', alignItems: 'center' }}>
        <UiEntity uiTransform={{ width: px(72), height: px(72), margin: { right: px(12) } }} uiBackground={{ textureMode: 'stretch', texture: { src: thumbSrc(e.id) }, color: e.found ? { r: 1, g: 1, b: 1, a: 1 } : { r: 0, g: 0, b: 0, a: 0.55 } }} />
        {/* Explicit heights: a Label with no height collapses to zero and the next child
            draws straight over it — which is what stacked the name on the count. */}
        <UiEntity uiTransform={{ flexGrow: 1, flexDirection: 'column', justifyContent: 'center' }}>
          <Label value={e.found ? e.name : '???'} fontSize={fs(19)} color={CREAM} textAlign="middle-left" textWrap="wrap" uiTransform={{ width: '100%', height: fs(28) }} />
          <Label value={`${e.tiers.size} of ${RARITY_TIERS.length} rarities seen`} fontSize={fs(13)} color={DIM} textAlign="middle-left" textWrap="nowrap" uiTransform={{ width: '100%', height: fs(20), margin: { top: px(2) } }} />
        </UiEntity>
        <UiEntity uiTransform={{ width: px(40), height: px(40), alignItems: 'center', justifyContent: 'center', borderRadius: px(20) }} uiBackground={{ color: RAISED }} onMouseDown={() => { almanacSel = null }}>
          <Label value="x" fontSize={fs(18)} color={DIM} textAlign="middle-center" textWrap="nowrap" uiTransform={{ width: '100%', height: '100%' }} />
        </UiEntity>
      </UiEntity>

      <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', flexWrap: 'wrap', margin: { top: px(10) } }}>
        {RARITY_TIERS.map(t => {
          const has = e.tiers.has(t.id)
          return (
            <UiEntity
              key={`d-${e.id}-${t.id}`}
              uiTransform={{ width: Math.floor((W - px(36) - px(6) * 3) / 4), height: px(46), margin: { right: px(6), bottom: px(6) }, flexDirection: 'column', alignItems: 'center', justifyContent: 'center', borderRadius: px(10) }}
              uiBackground={{ color: has ? { ...t.seedColor, a: 1 } : { r: 1, g: 1, b: 1, a: 0.05 } }}
            >
              <Label value={t.name} fontSize={fs(12)} color={has ? INK : { ...DIM, a: 0.45 }} textAlign="middle-center" textWrap="nowrap" uiTransform={{ width: '100%', height: fs(18) }} />
              <Label value={has ? 'found' : '-'} fontSize={fs(10)} color={has ? { ...INK, a: 0.7 } : { ...DIM, a: 0.3 }} textAlign="middle-center" textWrap="nowrap" uiTransform={{ width: '100%', height: fs(14) }} />
            </UiEntity>
          )
        })}
      </UiEntity>
    </UiEntity>
  )

  /** All / Found / Missing. Its own control, not a rarity filter — the almanac is about
   *  which SPECIES you have, and rarity is a property of an individual flower, not a
   *  species, so the two never share an axis. */
  const almanacChip = (id: 'all' | 'found' | 'missing', label: string) => {
    const on = almanacFilter === id
    return (
      <UiEntity
        key={`am-${id}`}
        uiTransform={{ height: px(32), padding: { left: px(14), right: px(14) }, margin: { right: px(6), bottom: px(6) }, alignItems: 'center', justifyContent: 'center', borderRadius: px(16) }}
        uiBackground={{ color: on ? MOSS : RAISED }}
        onMouseDown={() => { almanacFilter = id; almanacPage = 0 }}
      >
        <Label value={label} fontSize={fs(13)} color={on ? CREAM : DIM} textAlign="middle-center" textWrap="nowrap" uiTransform={{ height: '100%' }} />
      </UiEntity>
    )
  }

  const panel = (
    <UiEntity uiTransform={{ width: W, flexDirection: 'column', padding: { top: PAD, bottom: PAD, left: PAD, right: PAD }, borderRadius: px(20) }} uiBackground={{ color: DARK }}>

      {/* tabs — Fin reached for these expecting them to switch sections */}
      <UiEntity uiTransform={{ width: '100%', height: px(46), flexDirection: 'row', alignItems: 'center', margin: { bottom: px(4) } }}>
        {tabButton('seeds',   `Seeds${total > 0 ? `  ${total}` : ''}`)}
        {tabButton('flowers', `Flowers${allGroups.length > 0 ? `  ${getFlowers().length}` : ''}`)}
        {tabButton('almanac', `Almanac  ${speciesFound}/${PLANT_SPECIES.length}`)}
        <UiEntity uiTransform={{ flexGrow: 1, height: '100%' }} />
        {/* Close: a bare floating "x" read as unfinished next to three pill tabs. */}
        <UiEntity uiTransform={{ width: px(40), height: px(40), alignItems: 'center', justifyContent: 'center', borderRadius: px(20) }} uiBackground={{ color: RAISED }} onMouseDown={() => toggleSeedMenu()}>
          <Label value="x" fontSize={fs(18)} color={DIM} textAlign="middle-center" textWrap="nowrap" uiTransform={{ width: '100%', height: '100%' }} />
        </UiEntity>
      </UiEntity>

      {/* ── SEEDS TAB — one tile per rarity tier you hold, tap to choose what plants next */}
      <UiEntity uiTransform={{ display: tab === 'seeds' ? 'flex' : 'none', width: '100%', flexDirection: 'column' }}>
        <Label value={total > 0 ? 'Planting next' : 'No seeds yet - catch some during a bloom'} fontSize={fs(15)} color={DIM} textAlign="middle-left" uiTransform={{ width: '100%', height: fs(26), margin: { top: px(4), bottom: px(6) } }} />
        <UiEntity uiTransform={{ display: total > 0 ? 'flex' : 'none', width: '100%', flexDirection: 'row', flexWrap: 'wrap' }}>
          {pouchGroups.map((g, i) => tile(
            `pouch-${g.tier}`, i, g.tier, g.count,
            next === g.tier, () => { setPreferredTier(g.tier); holdSeed(g.tier) },
          ))}
        </UiEntity>
      </UiEntity>

      {/* ── FLOWERS TAB */}
      <UiEntity uiTransform={{ display: tab === 'flowers' ? 'flex' : 'none', width: '100%', flexDirection: 'column' }}>
        <Label value={`${getFlowers().length} kept - ${speciesFound}/${PLANT_SPECIES.length} species discovered`} fontSize={fs(14)} color={DIM} textAlign="middle-left" textWrap="nowrap" uiTransform={{ width: '100%', height: fs(26), margin: { top: px(8), bottom: px(4) } }} />
        <Label value={avenueSlot === null ? '' : eligible.length > 0 ? `${eligible.length} of your flowers can go on the Avenue` : `None of your flowers qualify yet — ${rarityTierById(AVENUE_MIN_TIER).name} and up only`} fontSize={fs(14)} color={CREAM} textAlign="middle-left" textWrap="wrap" uiTransform={{ display: avenueSlot !== null ? 'flex' : 'none', width: '100%', height: fs(26), margin: { bottom: px(4) } }} />

        {/* rarity filters — each on its own colour, so the row doubles as the legend */}
        <UiEntity uiTransform={{ display: ownedTiers.length > 1 ? 'flex' : 'none', width: '100%', flexDirection: 'row', flexWrap: 'wrap', margin: { top: px(6) } }}>
          {filterChip('all', 'All', null, CREAM)}
          {ownedTiers.map(t => filterChip(`t${t}`, rarityTierById(t).name, t, { ...rarityTierById(t).seedColor, a: 1 }))}
        </UiEntity>

        <Label value="Harvest an opened planter, or receive a gift" fontSize={fs(14)} color={{ ...DIM, a: 0.7 }} textAlign="middle-left" uiTransform={{ display: allGroups.length === 0 ? 'flex' : 'none', width: '100%', height: fs(26), margin: { top: px(6) } }} />

        <UiEntity uiTransform={{ display: groups.length > 0 ? 'flex' : 'none', width: '100%', flexDirection: 'row', flexWrap: 'wrap', margin: { top: px(8) } }}>
          {shown.map((g, i) => flowerTile(g, i))}
        </UiEntity>
      {/* pages: Prev · 1 / 3 · Next — only when the collection needs more than one */}
      <UiEntity uiTransform={{ display: pages > 1 ? 'flex' : 'none', width: '100%', height: px(44), flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <UiEntity uiTransform={{ width: px(96), height: px(40), alignItems: 'center', justifyContent: 'center', borderRadius: px(20) }} uiBackground={{ color: page > 0 ? RAISED : { ...RAISED, a: 0.03 } }} onMouseDown={() => { if (page > 0) { page--; selectedKey = ''; giftMode = false } }}>
          <Label value="Prev" fontSize={fs(15)} color={page > 0 ? CREAM : { ...DIM, a: 0.4 }} textAlign="middle-center" uiTransform={{ width: '100%', height: '100%' }} />
        </UiEntity>
        <Label value={`${page + 1} / ${pages}`} fontSize={fs(15)} color={DIM} textAlign="middle-center" uiTransform={{ height: '100%' }} />
        <UiEntity uiTransform={{ width: px(96), height: px(40), alignItems: 'center', justifyContent: 'center', borderRadius: px(20) }} uiBackground={{ color: page < pages - 1 ? RAISED : { ...RAISED, a: 0.03 } }} onMouseDown={() => { if (page < pages - 1) { page++; selectedKey = ''; giftMode = false } }}>
          <Label value="Next" fontSize={fs(15)} color={page < pages - 1 ? CREAM : { ...DIM, a: 0.4 }} textAlign="middle-center" uiTransform={{ width: '100%', height: '100%' }} />
        </UiEntity>
      </UiEntity>

      {/* selection → gift */}
      {/* Name on its own line, then three equal buttons: with the name in the row, "Hold"
          and "Gift" broke mid-word on a narrow canvas (KJ 2026-09-22). */}
      <UiEntity uiTransform={{ display: sel && !giftMode ? 'flex' : 'none', width: '100%', flexDirection: 'column', margin: { top: px(6) } }}>
      <Label value={sel ? `${speciesName(sel.flower)}${sel.rarityTier > 0 ? ` (${rarityTierById(sel.rarityTier).name})` : ''}` : ''} fontSize={fs(16)} color={CREAM} textAlign="middle-left" textWrap="nowrap" uiTransform={{ width: '100%', height: fs(24) }} />
      <UiEntity uiTransform={{ width: '100%', height: px(48), flexDirection: 'row', alignItems: 'center' }}>
        <UiEntity uiTransform={{ flexGrow: 1, flexBasis: 0, height: px(44), margin: { right: px(8) }, alignItems: 'center', justifyContent: 'center', borderRadius: px(22) }} uiBackground={{ color: RAISED }} onMouseDown={() => { if (sel) holdFlower(isHeld(sel) ? -1 : sel.lastIndex) }}>
          <Label value={sel && isHeld(sel) ? 'Put away' : 'Hold'} fontSize={fs(17)} color={CREAM} textAlign="middle-center" textWrap="nowrap" uiTransform={{ height: '100%' }} />
        </UiEntity>
        <UiEntity uiTransform={{ flexGrow: 1, flexBasis: 0, height: px(44), margin: { right: px(8) }, alignItems: 'center', justifyContent: 'center', borderRadius: px(22) }} uiBackground={{ color: MOSS }} onMouseDown={() => { giftMode = true; giftPage = 0 }}>
          <Label value="Gift" fontSize={fs(17)} color={CREAM} textAlign="middle-center" textWrap="nowrap" uiTransform={{ height: '100%' }} />
        </UiEntity>
        {/* The Avenue (design/communal-planters.md): Rare+ only — the server re-checks. Goes to the
            tapped planter when the menu was opened from one, else the first free slot. */}
        <UiEntity uiTransform={{ flexGrow: 1, flexBasis: 0, height: px(44), alignItems: 'center', justifyContent: 'center', borderRadius: px(22) }} uiBackground={{ color: sel && sel.rarityTier >= AVENUE_MIN_TIER ? MOSS : RAISED }}
          onMouseDown={() => {
            if (!sel) return
            if (sel.rarityTier < AVENUE_MIN_TIER) { showToast(`The Avenue is for ${rarityTierById(AVENUE_MIN_TIER).name} flowers and up`, 4_000, false); return }
            // Opened FROM a slot: straight in, that slot was the choice. Opened from the
            // pouch: arm it and let them tap the spot they want (KJ 2026-09-22).
            if (avenueSlot !== null) { displayOnAvenue(avenueSlot, sel.lastIndex) }
            else {
              armAvenuePlacement(sel.lastIndex)
              showToast('Now tap the spot on the Avenue wall where you want it', 6_000, false)
            }
            selectedKey = ''; avenueSlot = null; open = false
          }}>
          <Label value={avenueSlot ? 'Display here' : 'Avenue…'} fontSize={fs(17)} color={sel && sel.rarityTier >= AVENUE_MIN_TIER ? CREAM : DIM} textAlign="middle-center" textWrap="nowrap" uiTransform={{ height: '100%' }} />
        </UiEntity>
      </UiEntity>
      </UiEntity>

      {/* who to give it to */}
      <UiEntity uiTransform={{ display: sel && giftMode ? 'flex' : 'none', width: '100%', flexDirection: 'column', margin: { top: px(6) } }}>
        <Label value={here.length > 0 ? `Give your ${sel ? speciesName(sel.flower) : ''} to` : 'No other gardeners here right now - you can also tap a gardener in the garden'} fontSize={fs(14)} color={DIM} textAlign="middle-left" uiTransform={{ width: '100%', height: fs(26) }} />
        {here.slice(giftPage * GIFT_PAGE, giftPage * GIFT_PAGE + GIFT_PAGE).map((g) => (
          <UiEntity
            key={g.address}
            uiTransform={{ width: '100%', height: px(44), margin: { top: px(6) }, alignItems: 'center', justifyContent: 'center', borderRadius: px(22) }}
            uiBackground={{ color: RAISED }}
            onMouseDown={() => { if (sel) giveFlower(g.address, sel.lastIndex); selectedKey = ''; giftMode = false; giftPage = 0 }}
          >
            <Label value={g.name} fontSize={fs(16)} color={CREAM} textAlign="middle-center" uiTransform={{ width: '100%', height: '100%' }} />
          </UiEntity>
        ))}
        {/* same Prev · n / N · Next as the flower grid — only when more than one page of gardeners */}
        <UiEntity uiTransform={{ display: giftPages > 1 ? 'flex' : 'none', width: '100%', height: px(44), flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', margin: { top: px(6) } }}>
          <UiEntity uiTransform={{ width: px(96), height: px(40), alignItems: 'center', justifyContent: 'center', borderRadius: px(20) }} uiBackground={{ color: giftPage > 0 ? RAISED : { ...RAISED, a: 0.03 } }} onMouseDown={() => { if (giftPage > 0) giftPage-- }}>
            <Label value="Prev" fontSize={fs(15)} color={giftPage > 0 ? CREAM : { ...DIM, a: 0.4 }} textAlign="middle-center" uiTransform={{ width: '100%', height: '100%' }} />
          </UiEntity>
          <Label value={`${giftPage + 1} / ${giftPages}`} fontSize={fs(15)} color={DIM} textAlign="middle-center" uiTransform={{ height: '100%' }} />
          <UiEntity uiTransform={{ width: px(96), height: px(40), alignItems: 'center', justifyContent: 'center', borderRadius: px(20) }} uiBackground={{ color: giftPage < giftPages - 1 ? RAISED : { ...RAISED, a: 0.03 } }} onMouseDown={() => { if (giftPage < giftPages - 1) giftPage++ }}>
            <Label value="Next" fontSize={fs(15)} color={giftPage < giftPages - 1 ? CREAM : { ...DIM, a: 0.4 }} textAlign="middle-center" uiTransform={{ width: '100%', height: '100%' }} />
          </UiEntity>
        </UiEntity>
      </UiEntity>
      </UiEntity>

      {/* ── ALMANAC TAB — every species in the garden, found or not. This is the goal the
          collection is FOR: Fin 2026-09-21 had no idea how many flowers existed, so a new
          one could not feel like progress against anything. */}
      <UiEntity uiTransform={{ display: tab === 'almanac' ? 'flex' : 'none', width: '100%', flexDirection: 'column' }}>
        <UiEntity uiTransform={{ width: '100%', height: fs(30), flexDirection: 'row', alignItems: 'center', margin: { top: px(8), bottom: px(4) } }}>
          <Label value={`${speciesFound} of ${PLANT_SPECIES.length} species discovered`} fontSize={fs(14)} color={DIM} textAlign="middle-left" textWrap="nowrap" uiTransform={{ flexGrow: 1, height: '100%' }} />
          {/* The earned title, if any — the trophy half of Fin's "trophy system". */}
          <UiEntity uiTransform={{ display: earnedTitle ? 'flex' : 'none', height: px(24), padding: { left: px(10), right: px(10) }, alignItems: 'center', justifyContent: 'center', borderRadius: px(12) }} uiBackground={{ color: { r: 0.98, g: 0.78, b: 0.46, a: 1 } }}>
            <Label value={earnedTitle} fontSize={fs(12)} color={INK} textAlign="middle-center" textWrap="nowrap" uiTransform={{ height: '100%' }} />
          </UiEntity>
        </UiEntity>
        {/* progress bar — the same number again, as a shape you can read without counting */}
        <UiEntity uiTransform={{ width: '100%', height: px(8), margin: { top: px(2), bottom: px(10) }, borderRadius: px(4) }} uiBackground={{ color: { r: 1, g: 1, b: 1, a: 0.1 } }}>
          <UiEntity uiTransform={{ width: `${Math.round((speciesFound / Math.max(1, PLANT_SPECIES.length)) * 100)}%`, height: '100%', borderRadius: px(3) }} uiBackground={{ color: MOSS }} />
        </UiEntity>

        {/* The long tail: every species in every rarity. Species alone runs out; this does not. */}
        <Label
          value={`${stampsFound()} of ${stampTotal()} rarity stamps - each species in each rarity`}
          fontSize={fs(13)} color={{ ...CREAM, a: 0.7 }} textAlign="middle-left" textWrap="nowrap"
          uiTransform={{ width: '100%', height: fs(20), margin: { bottom: px(2) } }}
        />
        <Label
          value={(() => { const n = nextStampMilestone(stampsFound()); return n ? `Next: ${n.title} at ${stampMilestoneTarget(n)} stamps - ${stampMilestoneTarget(n) - stampsFound()} to go` : 'Every rarity stamp collected.' })()}
          fontSize={fs(13)} color={{ ...CREAM, a: 0.85 }} textAlign="middle-left" textWrap="wrap"
          uiTransform={{ width: '100%', height: fs(22), margin: { bottom: px(6) } }}
        />

        {/* Name the next rung outright. The goal being invisible is the whole reason the
            collection did not scratch (Fin 2026-09-21) — so the Almanac states it. */}
        <Label
          value={goal ? `Next: ${goal.title} at ${milestoneTarget(goal)} species — ${milestoneTarget(goal) - speciesFound} to go` : 'Every flower in the garden found.'}
          fontSize={fs(13)} color={{ ...CREAM, a: 0.8 }} textAlign="middle-left" textWrap="wrap"
          uiTransform={{ width: '100%', height: fs(22), margin: { bottom: px(12) } }}
        />

        <UiEntity uiTransform={{ display: selSpecies ? 'none' : 'flex', width: '100%', flexDirection: 'row', flexWrap: 'wrap' }}>
          {almanacChip('all', `All  ${almanacAll.length}`)}
          {almanacChip('found', `Found  ${speciesFound}`)}
          {almanacChip('missing', `Missing  ${almanacAll.length - speciesFound}`)}
        </UiEntity>

        {selSpecies ? almanacDetail(selSpecies) : null}

        <UiEntity uiTransform={{ display: selSpecies ? 'none' : 'flex', width: '100%', flexDirection: 'row', flexWrap: 'wrap', margin: { top: px(8) } }}>
          {almanacShown.map((e, i) => almanacTile(e, i))}
        </UiEntity>

        <UiEntity uiTransform={{ display: !selSpecies && almanacPages > 1 ? 'flex' : 'none', width: '100%', height: px(44), flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <UiEntity uiTransform={{ width: px(96), height: px(40), alignItems: 'center', justifyContent: 'center', borderRadius: px(20) }} uiBackground={{ color: almanacPage > 0 ? RAISED : { ...RAISED, a: 0.03 } }} onMouseDown={() => { if (almanacPage > 0) almanacPage-- }}>
            <Label value="Prev" fontSize={fs(15)} color={almanacPage > 0 ? CREAM : { ...DIM, a: 0.4 }} textAlign="middle-center" uiTransform={{ width: '100%', height: '100%' }} />
          </UiEntity>
          <Label value={`${almanacPage + 1} / ${almanacPages}`} fontSize={fs(15)} color={DIM} textAlign="middle-center" uiTransform={{ height: '100%' }} />
          <UiEntity uiTransform={{ width: px(96), height: px(40), alignItems: 'center', justifyContent: 'center', borderRadius: px(20) }} uiBackground={{ color: almanacPage < almanacPages - 1 ? RAISED : { ...RAISED, a: 0.03 } }} onMouseDown={() => { if (almanacPage < almanacPages - 1) almanacPage++ }}>
            <Label value="Next" fontSize={fs(15)} color={almanacPage < almanacPages - 1 ? CREAM : { ...DIM, a: 0.4 }} textAlign="middle-center" uiTransform={{ width: '100%', height: '100%' }} />
          </UiEntity>
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )

  // Phone: a centred sheet from the top (both thumbs stay free). Desktop: rises from the
  // seed chip, which now sits bottom centre — a panel still docked top right would have
  // opened nowhere near the control that opens it.
  return mobile
    ? <UiEntity uiTransform={{ positionType: 'absolute', position: { top: props.topPx, left: 0 }, width: '100%', flexDirection: 'row', justifyContent: 'center' }}>{panel}</UiEntity>
    : <UiEntity uiTransform={{ positionType: 'absolute', position: { bottom: props.aboveChipPx, left: 0 }, width: '100%', flexDirection: 'row', justifyContent: 'center' }}>{panel}</UiEntity>
}
