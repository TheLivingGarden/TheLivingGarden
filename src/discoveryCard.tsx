// =============================================================
// Bloom Garden v2 — Discovery card (CLIENT ONLY)
//
// The payoff beat of the whole D1 loop. A seed you planted yesterday opens and
// the garden STOPS to tell you what it was:
//
//     You discovered
//     [thumbnail]
//     Bluebloom Cactus
//     [ Legendary ]        (+ NEW badge if you have never had this species)
//     23 of 76 discovered
//
// Fin 2026-09-21: "collecting a new one should scratch an itch". It could not,
// because the opening was a one-line toast that said a name against no context —
// no picture, no rarity weight, and no sense of a collection to be short of.
//
// Own state + own entry point, rendered by ui.tsx — the bloomFinale.tsx pattern.
// Fired by boxSystem when MY planter opens, and only on a LIVE boxState: the
// join/resync snapshot replays every already-open planter.
// =============================================================

import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { timers } from '@dcl/sdk/ecs'
import { PLANT_SPECIES, LEGEND_PLANTS, legendTier, stampTotal, rarityTierById, plantSpeciesById, withArticle, DISCOVERY_CARD_MS, MILESTONE_CARD_MS, nextMilestone, milestoneTarget, nextStampMilestone, stampMilestoneTarget } from './shared/config'
import { getDiscovered, stampsFound } from './playerInventory'
import { room } from './shared/messages'
import { playSfx } from './sounds'

interface Item { flower: string; tier: number; isNew: boolean; newTier: boolean; boxId: string }
/** One card = one BATCH of openings. tier = the best tier in it; flower / boxId = that best one (a single opening is a batch of one). */
interface Discovery { flower: string; tier: number; isNew: boolean; newTier: boolean; found: number; stamps: number; boxId: string; items: Item[]; newSpecies: number; newStamps: number }

let card: Discovery | null = null
let shownAt = 0
let cardDueAt = 0   // a delayed card is on its way — milestones wait for it

// Reveal beats (KJ 2026-09-30: "no build up tension, just an immediate random reveal — lacks dopamine").
//   0 OPEN   a black silhouette pulses under "Something is opening…"
//   1 ROLL   the rarity pill spins through the tier colours and DECELERATES onto the real one (a slot-machine settle: the
//            near-misses are part of the payoff). The higher the tier, the longer the spin.
//   2 LOCK   it lands: a flash in the rarity colour, the header names it, a stinger plays
//   3 REVEAL the species picture and name, the collection counters tick up, and two buttons ask what to do with it
// Common skips ROLL and LOCK. A tap during 0-2 skips to the reveal instead of closing the card.
const BEAT_OPEN_MS = 1_300
const BEAT_LOCK_MS = 550
const rollMs = (tier: number): number => tier > 0 ? 1_000 + 300 * tier : 0
let revealSkipped = false
let beatSounded   = 0   // 0 none, 1 roll started, 2 locked, 3 revealed
let lastRollTick  = -1
function beatEnds(tier: number): { open: number; roll: number; lock: number } {
  const open = BEAT_OPEN_MS, roll = open + rollMs(tier)
  return { open, roll, lock: roll + (tier > 0 ? BEAT_LOCK_MS : 0) }
}
function cardStage(now: number, tier: number): 0 | 1 | 2 | 3 {
  const e = beatEnds(tier)
  const age = revealSkipped ? e.lock : now - shownAt
  return age < e.open ? 0 : age < e.roll ? 1 : age < e.lock ? 2 : 3
}
/** Which tier the spinning pill shows `ageInRoll` ms into the roll: an ease-out walk over the tiers that ends ON `tier`. */
function rollTier(ageInRoll: number, tier: number): { shown: number; tick: number } {
  const u = Math.min(1, Math.max(0, ageInRoll / rollMs(tier)))
  const n = 12 + 2 * tier
  const tick = Math.floor(n * (1 - Math.pow(1 - u, 3)))
  const count = 8
  return { shown: (((tier - (n - tick)) % count) + count) % count, tick }
}
function onCardTap(): void {
  if (card && cardStage(Date.now(), card.tier) < 3) { revealSkipped = true; return }
  dismissDiscovery()
}
function harvestFromCard(): void {
  if (card) for (const it of card.items) if (it.boxId) room.send('harvestBox', { boxId: it.boxId })
  dismissDiscovery()
}

const FADE_MS = 400
const DARK  = { r: 0.07, g: 0.063, b: 0.055, a: 0.94 }
const CREAM = { r: 0.957, g: 0.918, b: 0.824 }
const DIM   = { r: 0.83,  g: 0.82,  b: 0.78 }
const INK   = { r: 0.07,  g: 0.065, b: 0.06 }
const PLATE = { r: 1, g: 1, b: 1, a: 0.12 }
const NEW   = { r: 0.98, g: 0.78, b: 0.46 }
const MOSS  = { r: 0.18, g: 0.49, b: 0.34 }

// Week-2 playtest: "new discovery UI needs an X". Both cards were fire-and-forget with
// no input at all. Dismissing skips the fade-out; a queued milestone pumps in as usual.
function dismissDiscovery(): void { card = null }
function dismissMilestone(): void { milestone = null }

function closeButton(px: (n: number) => number, fs: (n: number) => number, a: number, onTap: () => void) {
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { top: px(10), right: px(10) }, width: px(34), height: px(34), alignItems: 'center', justifyContent: 'center', borderRadius: px(17) }}
      uiBackground={{ color: { ...PLATE, a: PLATE.a * a } }}
      onMouseDown={onTap}
    >
      <Label value="x" fontSize={fs(16)} color={{ ...DIM, a }} textAlign="middle-center" textWrap="nowrap" uiTransform={{ width: '100%', height: '100%' }} />
    </UiEntity>
  )
}

/** Show the card for a flower that has just opened in one of my planters.
 *  Read BEFORE the server's discoveredUpdate lands, so `isNew` still sees the set as it
 *  was a moment ago — which is exactly the question being asked. If the push wins the
 *  race the card simply reads "You discovered" instead of "New species!"; the Almanac
 *  is right either way, because the server owns the set. */
export function showDiscovery(flower: string, tier: number, delayMs = 0, boxId = ''): void {
  const seen = getDiscovered()   // snapshotted NOW, even when the card is delayed for the reveal beat
  if (batchItems.length === 0) { batchFound = [...seen.keys()].filter(id => legendTier(id) < 0).length; batchStamps = stampsFound(); batchSeenSpecies.clear(); batchSeenStamps.clear() }
  // Two different "new": a species never seen at all, and a species seen but never at THIS rarity. The headline count is
  // species, so only the former says "New species!". Openings in the same batch count once each (two of one new species = one new).
  const key = `${flower}|${tier}`
  const item: Item = { flower, tier, isNew: !seen.has(flower) && !batchSeenSpecies.has(flower), newTier: !seen.get(flower)?.has(tier) && !batchSeenStamps.has(key), boxId }
  batchSeenSpecies.add(flower); batchSeenStamps.add(key)
  batchItems.push(item)
  if (!batchScheduled) {
    // Everything that opens within BATCH_WINDOW_MS of the first one joins ONE card (KJ plants six of a rarity together and they open together).
    batchScheduled = true
    cardDueAt = Date.now() + delayMs + BATCH_WINDOW_MS
    timers.setTimeout(flushBatch, delayMs + BATCH_WINDOW_MS)
  }
  console.log(`[Discovery] ${flower} tier=${tier} new=${item.isNew} newTier=${item.newTier} batch=${batchItems.length}`)
}

const BATCH_WINDOW_MS = 500
const ITEM_STAGGER_MS = 260   // reveal beat between the species of a batch
let batchItems: Item[] = []
let batchScheduled = false
let batchFound = 0
let batchStamps = 0
const batchSeenSpecies = new Set<string>()
const batchSeenStamps  = new Set<string>()

function flushBatch(): void {
  batchScheduled = false
  const items = batchItems
  batchItems = []
  if (items.length === 0) return
  const best = items.reduce((m, it) => it.tier > m.tier ? it : m, items[0])
  card = {
    flower: best.flower, tier: best.tier, boxId: items.length === 1 ? best.boxId : '',
    isNew: items.some(i => i.isNew), newTier: items.some(i => i.newTier),
    found: batchFound, stamps: batchStamps,
    items, newSpecies: items.filter(i => i.isNew).length, newStamps: items.filter(i => i.newTier).length,
  }
  shownAt = Date.now(); cardDueAt = 0; revealSkipped = false; beatSounded = 0; lastRollTick = -1
}

// ── Almanac milestone — the bigger, rarer beat that sits on top of a discovery.
interface Milestone { title: string; species: number; stamps: number; seedTier: number; planters: number }
let milestone: Milestone | null = null
let milestoneAt = 0   // when its clock starts — later than now while another card is up
// A real QUEUE, not one slot: an established gardener's first join backfills a whole
// collection and crosses several rungs at once (KJ 2026-09-21 crossed three and saw a
// pile-up). One slot meant the last message clobbered the others and two of the three
// rewards were never announced at all.
const milestoneQueue: Milestone[] = []

/** ⚠️ Registered from index.ts AFTER setupWateringSystem(), which calls room.clear(). */
export function setupDiscoveryCard(): void {
  room.onMessage('milestoneReached', (data) => {
    milestoneQueue.push({ title: data.title, species: data.species, stamps: data.stamps ?? 0, seedTier: data.seedTier, planters: data.planters })
    console.log(`[Milestone] queued ${data.title} at ${data.stamps > 0 ? `${data.stamps} stamps` : `${data.species} species`} (tier-${data.seedTier} seed, +${data.planters} planter) — ${milestoneQueue.length} waiting`)
  })
}

/** Start the next milestone once the current card (and any discovery card) has finished. */
function pumpMilestones(now: number): void {
  if (now < cardDueAt) return
  if (milestone && now < milestoneAt + MILESTONE_CARD_MS) return
  const next = milestoneQueue.shift()
  if (!next) return
  milestone = next
  const discoveryLeft = card ? Math.max(0, DISCOVERY_CARD_MS - (now - shownAt)) : 0
  milestoneAt = now + discoveryLeft
}

/** Alpha-only fade in and out — size/position tweens jitter on the phone. */
function fade(now: number, start: number, life: number): number {
  const age = now - start
  if (age < 0) return 0                 // still queued behind another card
  const left = life - age
  if (left <= 0) return 0
  return Math.min(1, age / FADE_MS, left / FADE_MS)
}
const alpha = (now: number) => fade(now, shownAt, DISCOVERY_CARD_MS)

/** True while the discovery or milestone card is on screen — the tutorial card gives way (ui.tsx). */
export function isDiscoveryShowing(): boolean {
  const now = Date.now()
  return (card !== null && alpha(now) > 0.02) || (milestone !== null && fade(now, milestoneAt, MILESTONE_CARD_MS) > 0.02)
}

export function MilestoneCardUi(props: { px: (n: number) => number; fs: (n: number) => number; mobile: boolean }) {
  const now = Date.now()
  pumpMilestones(now)
  if (!milestone) return null
  const a = fade(now, milestoneAt, MILESTONE_CARD_MS)
  if (a <= 0.02) return null
  const { px, fs } = props
  const m = milestone
  const tier = rarityTierById(m.seedTier)
  const isStamp = m.stamps > 0
  const next = isStamp ? null : nextMilestone(m.species)
  const nextStamp = isStamp ? nextStampMilestone(m.stamps) : null
  const reward = `${withArticle(tier.name, true)} seed${m.planters > 0 ? ` and ${m.planters === 1 ? 'an extra planter' : `${m.planters} extra planters`}` : ''}`

  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: '34%', left: 0 }, width: '100%', flexDirection: 'row', justifyContent: 'center' }}>
      <UiEntity
        uiTransform={{ width: px(props.mobile ? 440 : 380), flexDirection: 'column', alignItems: 'center', padding: { left: px(24), right: px(24), top: px(20), bottom: px(20) }, borderRadius: px(22) }}
        uiBackground={{ color: { ...DARK, a: DARK.a * a } }}
        onMouseDown={dismissMilestone}
      >
        {closeButton(px, fs, a, dismissMilestone)}
        <Label value={isStamp ? `${m.stamps} rarity stamps collected` : `${m.species} species discovered`} fontSize={fs(15)} color={{ ...DIM, a }} textAlign="middle-center" textWrap="nowrap" uiTransform={{ height: fs(22) }} />
        <Label value={m.title} fontSize={fs(30)} color={{ ...NEW, a }} textAlign="middle-center" textWrap="wrap" uiTransform={{ width: '100%', height: fs(40), margin: { top: px(2) } }} />
        <UiEntity uiTransform={{ height: px(34), padding: { left: px(18), right: px(18) }, margin: { top: px(10) }, alignItems: 'center', justifyContent: 'center', borderRadius: px(17) }} uiBackground={{ color: { ...tier.seedColor, a } }}>
          <Label value={reward} fontSize={fs(14)} color={{ ...INK, a }} textAlign="middle-center" textWrap="nowrap" uiTransform={{ height: '100%' }} />
        </UiEntity>
        <Label
          value={isStamp ? (nextStamp ? `Next: ${nextStamp.title} at ${stampMilestoneTarget(nextStamp)} stamps` : 'You have every rarity stamp in the garden.') : (next ? `Next: ${next.title} at ${milestoneTarget(next)} species` : 'You have found every flower in the garden.')}
          fontSize={fs(13)} color={{ ...DIM, a: a * 0.85 }} textAlign="middle-center" textWrap="wrap"
          uiTransform={{ width: '100%', height: fs(20), margin: { top: px(10) } }}
        />
      </UiEntity>
    </UiEntity>
  )
}

export function DiscoveryCardUi(props: { px: (n: number) => number; fs: (n: number) => number; mobile: boolean }) {
  if (!card) return null
  const a = alpha(Date.now())
  if (a <= 0.02) return null
  const { px, fs } = props
  const c = card
  const tier = rarityTierById(c.tier)
  const name = plantSpeciesById(c.flower)?.name ?? c.flower
  const now = Date.now()
  const stage = cardStage(now, c.tier)
  const ends = beatEnds(c.tier)
  const age = revealSkipped ? ends.lock : now - shownAt
  // Sounds ride the stages: a tick per rolled tier, a stinger on the lock-on, the chime on the reveal.
  if (stage === 1) {
    const { tick } = rollTier(age - ends.open, c.tier)
    if (tick !== lastRollTick) { lastRollTick = tick; playSfx('tutorialTap') }
  }
  if (stage >= 2 && beatSounded < 2 && c.tier > 0) { beatSounded = 2; playSfx(c.tier >= 4 ? 'golden' : 'seedCatch') }
  if (stage === 3 && beatSounded < 3) { beatSounded = 3; playSfx('flowerOpen') }
  const rolling  = stage === 1
  const shownTierId = rolling ? rollTier(age - ends.open, c.tier).shown : c.tier
  const shownTier = rarityTierById(shownTierId)
  const pillOn = c.tier > 0 ? stage >= 1 : stage === 3
  const pa = pillOn ? a : 0                                  // rarity pill + its label
  const ra = stage === 3 ? a : 0                             // everything the reveal unlocks
  const sinceReveal = stage === 3 ? age - ends.lock : 0
  const batch = c.items.length > 1
  const lastItemAt = (c.items.length - 1) * ITEM_STAGGER_MS   // when the last species of a batch is revealed
  const pulse = stage === 3 ? 1 : 0.55 + 0.35 * Math.sin(now / 170)
  const dots = '.'.repeat(1 + Math.floor(now / 350) % 3)
  const pillBg = shownTierId > 0 ? { ...shownTier.seedColor, a: pa } : { ...PLATE, a: PLATE.a * pa }
  const pillInk = shownTierId > 0 ? INK : CREAM
  const header = stage === 0 ? `Something is opening${dots}`
    : stage === 1 ? 'Its rarity is…'
    : stage === 2 ? `${withArticle(tier.name, true)} one!`
    : batch ? `${c.items.length} flowers opened!`
    : c.isNew ? 'New species!' : c.newTier ? 'A rarity you have never seen!' : 'You discovered'
  const headerColor = stage === 2 && c.tier > 0 ? tier.seedColor : stage === 3 && (c.isNew || c.newTier) ? NEW : DIM
  const thumbTint = stage === 3 ? { r: 1, g: 1, b: 1, a } : { r: 0, g: 0, b: 0, a: a * pulse }   // black silhouette until the reveal
  // Lock-on flash: the card washes in the rarity colour and fades over the lock beat.
  const flashA = stage === 2 && c.tier > 0 ? 0.42 * (1 - (age - ends.roll) / BEAT_LOCK_MS) * a : 0
  // Counters tick: the old number, then (a beat after the reveal) the new one in gold.
  const ticked = sinceReveal > 450 + lastItemAt
  const speciesShown = c.found + (ticked ? c.newSpecies : 0)
  const stampsShown  = c.stamps + (ticked ? c.newStamps : 0)
  const btnA = stage === 3 && c.items.some(i => i.boxId) ? a * Math.min(1, Math.max(0, (sinceReveal - 700 - lastItemAt) / 300)) : 0   // the choice arrives last

  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: batch ? '18%' : '34%', left: 0 }, width: '100%', flexDirection: 'row', justifyContent: 'center' }}>
      <UiEntity
        uiTransform={{ width: px(props.mobile ? 420 : 340), flexDirection: 'column', alignItems: 'center', padding: { left: px(24), right: px(24), top: px(18), bottom: px(20) }, borderRadius: px(22) }}
        uiBackground={{ color: { ...DARK, a: DARK.a * a } }}
        onMouseDown={onCardTap}
      >
        <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%', borderRadius: px(22) }} uiBackground={{ color: { ...tier.seedColor, a: flashA } }} />
        {closeButton(px, fs, a, dismissDiscovery)}
        <Label value={header} fontSize={fs(17)} color={{ ...headerColor, a }} textAlign="middle-center" textWrap="nowrap" uiTransform={{ height: fs(24) }} />

        {batch ? null : plantSpeciesById(c.flower)
          ? <UiEntity uiTransform={{ width: px(132), height: px(132), margin: { top: px(6) } }} uiBackground={{ textureMode: 'stretch', texture: { src: `assets/images/plantThumbs/${c.flower}.png` }, color: thumbTint }} />
          : /* pre-catalog flower (the old Tulip/Poppy/Daisy list): no species, so no thumbnail */
            <UiEntity uiTransform={{ width: px(132), height: px(132), margin: { top: px(6) }, alignItems: 'center', justifyContent: 'center' }}>
              <UiEntity uiTransform={{ width: px(64), height: px(64), borderRadius: px(32) }} uiBackground={{ color: { ...tier.seedColor, a } }} />
            </UiEntity>}

        <Label value={stage === 3 ? name : '???'} fontSize={fs(26)} color={{ ...CREAM, a: stage === 3 ? a : a * 0.5 }} textAlign="middle-center" textWrap="wrap" uiTransform={{ display: batch ? 'none' : 'flex', width: '100%', height: fs(36), margin: { top: px(4) } }} />

        {/* A batch: one tile per opening, revealed left to right — silhouette first, then colour, name and a NEW badge. */}
        {batch ? (
          <UiEntity uiTransform={{ width: '100%', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', margin: { top: px(6) } }}>
            {c.items.map((it, i) => {
              const shown = stage === 3 && sinceReveal >= i * ITEM_STAGGER_MS
              const sp = plantSpeciesById(it.flower)
              return (
                <UiEntity key={`${it.boxId}_${i}`} uiTransform={{ width: px(88), margin: px(4), flexDirection: 'column', alignItems: 'center' }}>
                  <UiEntity
                    uiTransform={{ width: px(72), height: px(72), borderRadius: sp ? 0 : px(36) }}
                    uiBackground={sp
                      ? { textureMode: 'stretch', texture: { src: `assets/images/plantThumbs/${it.flower}.png` }, color: shown ? { r: 1, g: 1, b: 1, a } : { r: 0, g: 0, b: 0, a: a * pulse } }
                      : { color: shown ? { ...rarityTierById(it.tier).seedColor, a } : { r: 0, g: 0, b: 0, a: a * pulse } }}
                  />
                  <Label value={shown ? (sp?.name ?? it.flower) : '???'} fontSize={fs(11)} color={{ ...CREAM, a: shown ? a : a * 0.5 }} textAlign="top-center" textWrap="wrap" uiTransform={{ width: '100%', height: fs(30) }} />
                  <Label value={shown && it.isNew ? 'NEW' : ''} fontSize={fs(11)} color={{ ...NEW, a }} textAlign="middle-center" textWrap="nowrap" uiTransform={{ height: fs(14) }} />
                </UiEntity>
              )
            })}
          </UiEntity>
        ) : null}

        <UiEntity uiTransform={{ width: px(140), height: px(32), margin: { top: px(8) }, alignItems: 'center', justifyContent: 'center', borderRadius: px(16) }} uiBackground={{ color: pillBg }}>
          <Label value={shownTier.name} fontSize={fs(15)} color={{ ...pillInk, a: pa }} textAlign="middle-center" textWrap="nowrap" uiTransform={{ height: '100%' }} />
        </UiEntity>

        {/* Discovery is recorded server-side the moment the planter opens, so this counts
            the new one immediately — whether they harvest it or leave it on show. */}
        <Label
          value={legendTier(c.flower) >= 0
            ? `${LEGEND_PLANTS.filter(s => getDiscovered().has(s.id)).length} of ${LEGEND_PLANTS.length} legends discovered`
            : `${speciesShown} of ${PLANT_SPECIES.length} species discovered`}
          fontSize={fs(14)}
          color={{ ...(c.newSpecies > 0 && ticked ? NEW : DIM), a: ra * 0.85 }}
          textAlign="middle-center"
          textWrap="wrap"
          uiTransform={{ width: '100%', height: fs(20), margin: { top: px(10) } }}
        />
        <Label
          value={`${stampsShown} of ${stampTotal()} rarity stamps${c.newStamps > 0 && ticked ? `  (+${c.newStamps} new)` : ''}`}
          fontSize={fs(13)}
          color={{ ...(c.newStamps > 0 && ticked ? NEW : DIM), a: ra * 0.85 }}
          textAlign="middle-center"
          textWrap="wrap"
          uiTransform={{ width: '100%', height: fs(20), margin: { top: px(2) } }}
        />
        {/* What now? The reveal ends on a decision (GDD 3.1: harvest it, or leave it standing on show). */}
        <UiEntity uiTransform={{ display: btnA > 0.02 ? 'flex' : 'none', width: '100%', flexDirection: 'row', justifyContent: 'center', margin: { top: px(14) } }}>
          <UiEntity uiTransform={{ height: px(38), padding: { left: px(20), right: px(20) }, margin: { right: px(10) }, alignItems: 'center', justifyContent: 'center', borderRadius: px(19) }} uiBackground={{ color: { ...MOSS, a: btnA } }} onMouseDown={harvestFromCard}>
            <Label value={batch ? 'Harvest all' : 'Harvest'} fontSize={fs(15)} color={{ ...CREAM, a: btnA }} textAlign="middle-center" textWrap="nowrap" uiTransform={{ height: '100%' }} />
          </UiEntity>
          <UiEntity uiTransform={{ height: px(38), padding: { left: px(20), right: px(20) }, alignItems: 'center', justifyContent: 'center', borderRadius: px(19) }} uiBackground={{ color: { ...PLATE, a: PLATE.a * btnA * 1.6 } }} onMouseDown={dismissDiscovery}>
            <Label value="Leave on show" fontSize={fs(15)} color={{ ...CREAM, a: btnA }} textAlign="middle-center" textWrap="nowrap" uiTransform={{ height: '100%' }} />
          </UiEntity>
        </UiEntity>
      </UiEntity>
    </UiEntity>
  )
}
