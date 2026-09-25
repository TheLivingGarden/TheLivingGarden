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
import { PLANT_SPECIES, stampTotal, rarityTierById, plantSpeciesById, DISCOVERY_CARD_MS, MILESTONE_CARD_MS, nextMilestone, milestoneTarget, nextStampMilestone, stampMilestoneTarget } from './shared/config'
import { getDiscovered, stampsFound } from './playerInventory'
import { room } from './shared/messages'

interface Discovery { flower: string; tier: number; isNew: boolean; newTier: boolean; found: number; stamps: number }

let card: Discovery | null = null
let shownAt = 0
let cardDueAt = 0   // a delayed card is on its way — milestones wait for it

const FADE_MS = 400
const DARK  = { r: 0.07, g: 0.063, b: 0.055, a: 0.94 }
const CREAM = { r: 0.957, g: 0.918, b: 0.824 }
const DIM   = { r: 0.83,  g: 0.82,  b: 0.78 }
const INK   = { r: 0.07,  g: 0.065, b: 0.06 }
const PLATE = { r: 1, g: 1, b: 1, a: 0.12 }
const NEW   = { r: 0.98, g: 0.78, b: 0.46 }

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
export function showDiscovery(flower: string, tier: number, delayMs = 0): void {
  const seen = getDiscovered()   // snapshotted NOW, even when the card is delayed for the reveal beat
  // Two different "new": a species never seen at all, and a species seen but never at
  // THIS rarity. The headline count is species, so only the former says "New species!".
  const c = { flower, tier, isNew: !seen.has(flower), newTier: !seen.get(flower)?.has(tier), found: seen.size, stamps: stampsFound() }
  const show = () => { card = c; shownAt = Date.now(); cardDueAt = 0 }
  if (delayMs > 0) { cardDueAt = Date.now() + delayMs; timers.setTimeout(show, delayMs) } else show()
  console.log(`[Discovery] ${flower} tier=${tier} new=${c.isNew} newTier=${c.newTier} found=${c.found}/${PLANT_SPECIES.length}`)
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
  const reward = `A ${tier.name} seed${m.planters > 0 ? ` and ${m.planters === 1 ? 'an extra planter' : `${m.planters} extra planters`}` : ''}`

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
  // Same colour language as the menu tiles: rarity colours itself, Common stays neutral,
  // so the pill only shouts when there is something to shout about.
  const pillBg = c.tier > 0 ? { ...tier.seedColor, a } : { ...PLATE, a: PLATE.a * a }
  const pillInk = c.tier > 0 ? INK : CREAM

  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: '34%', left: 0 }, width: '100%', flexDirection: 'row', justifyContent: 'center' }}>
      <UiEntity
        uiTransform={{ width: px(props.mobile ? 420 : 340), flexDirection: 'column', alignItems: 'center', padding: { left: px(24), right: px(24), top: px(18), bottom: px(20) }, borderRadius: px(22) }}
        uiBackground={{ color: { ...DARK, a: DARK.a * a } }}
        onMouseDown={dismissDiscovery}
      >
        {closeButton(px, fs, a, dismissDiscovery)}
        <Label value={c.isNew ? 'New species!' : c.newTier ? 'A rarity you have never seen!' : 'You discovered'} fontSize={fs(17)} color={{ ...(c.isNew || c.newTier ? NEW : DIM), a }} textAlign="middle-center" textWrap="nowrap" uiTransform={{ height: fs(24) }} />

        {plantSpeciesById(c.flower)
          ? <UiEntity uiTransform={{ width: px(132), height: px(132), margin: { top: px(6) } }} uiBackground={{ textureMode: 'stretch', texture: { src: `assets/images/plantThumbs/${c.flower}.png` }, color: { r: 1, g: 1, b: 1, a } }} />
          : /* pre-catalog flower (the old Tulip/Poppy/Daisy list): no species, so no thumbnail */
            <UiEntity uiTransform={{ width: px(132), height: px(132), margin: { top: px(6) }, alignItems: 'center', justifyContent: 'center' }}>
              <UiEntity uiTransform={{ width: px(64), height: px(64), borderRadius: px(32) }} uiBackground={{ color: { ...tier.seedColor, a } }} />
            </UiEntity>}

        <Label value={name} fontSize={fs(26)} color={{ ...CREAM, a }} textAlign="middle-center" textWrap="wrap" uiTransform={{ width: '100%', height: fs(36), margin: { top: px(4) } }} />

        <UiEntity uiTransform={{ height: px(32), padding: { left: px(16), right: px(16) }, margin: { top: px(8) }, alignItems: 'center', justifyContent: 'center', borderRadius: px(16) }} uiBackground={{ color: pillBg }}>
          <Label value={tier.name} fontSize={fs(15)} color={{ ...pillInk, a }} textAlign="middle-center" textWrap="nowrap" uiTransform={{ height: '100%' }} />
        </UiEntity>

        {/* Discovery is recorded server-side the moment the planter opens, so this counts
            the new one immediately — whether they harvest it or leave it on show. */}
        <Label
          value={`${c.found + (c.isNew ? 1 : 0)} of ${PLANT_SPECIES.length} species discovered`}
          fontSize={fs(14)}
          color={{ ...DIM, a: a * 0.85 }}
          textAlign="middle-center"
          textWrap="wrap"
          uiTransform={{ width: '100%', height: fs(20), margin: { top: px(10) } }}
        />
        <Label
          value={`${c.stamps + (c.newTier ? 1 : 0)} of ${stampTotal()} rarity stamps${c.newTier ? '  (+1 new)' : ''}`}
          fontSize={fs(13)}
          color={{ ...(c.newTier ? NEW : DIM), a: a * 0.85 }}
          textAlign="middle-center"
          textWrap="wrap"
          uiTransform={{ width: '100%', height: fs(20), margin: { top: px(2) } }}
        />
      </UiEntity>
    </UiEntity>
  )
}
