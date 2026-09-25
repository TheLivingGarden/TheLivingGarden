// =============================================================
// Bloom Garden v2 — the local player's inventory (CLIENT ONLY)
//
// One small store for what the player holds: seed pouch, planting preference,
// keepsake flowers, planter cap. Gameplay systems WRITE it (boxSystem from
// pouchUpdate, giftSystem from collectionUpdate); UI READS it every render.
// It imports nothing from the game, so UI ↔ gameplay never form an import cycle.
// Rarity is the 8-tier system (RARITY_TIERS in shared/config) since 2026-09-18 —
// a pouch/keepsake only ever carries a tier NUMBER, never the tier's name/color,
// so this file still doesn't need to import the game/config to stay decoupled.
// =============================================================

export interface Keepsake {
  flower: string; rarityTier: number; at: number; from?: string
  // Provenance for the Avenue plaque (server, 2026-09-22) — absent on older keepsakes.
  grownBy?: string; plantedAt?: number; openedAt?: number; helpers?: string[]; avenue?: number
}
export interface Gardener { address: string; name: string }

let pouch: number[] = []      // counts per rarity tier, index = tier id
let preferredTier   = 0       // which tier to plant next, when the pouch holds more than one
let flowers: Keepsake[] = []
let boxCap     = 1

export function getPouch(): number[] { return pouch }
export function setPouch(counts: number[]): void {
  pouch = counts.map(n => Math.max(0, n))
}

/** Which tier the next planting uses when the pouch holds more than one. */
export function getPreferredTier(): number { return preferredTier }
export function setPreferredTier(tier: number): void { preferredTier = tier }
/** The tier the next planting will actually use, or null with an empty pouch —
 *  the preferred tier if it has stock, else the lowest-indexed tier that does. */
export function nextSeedTier(): number | null {
  if ((pouch[preferredTier] ?? 0) > 0) return preferredTier
  const firstAvailable = pouch.findIndex(n => n > 0)
  return firstAvailable === -1 ? null : firstAvailable
}

/** The keepsake kind in my hand (server-confirmed via heldFlower), or null. */
export interface HeldKind { flower: string; rarityTier: number }
let held: HeldKind | null = null
export function getHeld(): HeldKind | null { return held }
export function setHeld(h: HeldKind | null): void { held = h }
/** Collection index of a keepsake of the held kind (the newest), or null. */
export function heldFlowerIndex(): number | null {
  if (!held) return null
  for (let i = flowers.length - 1; i >= 0; i--) if (flowers[i].flower === held.flower && flowers[i].rarityTier === held.rarityTier) return i
  return null
}

/** Species this gardener has ever REVEALED, and at which rarities — server-owned (Storage
 *  key 'discovered'), pushed on join and whenever one is added. Deliberately not derived
 *  from `flowers`: a flower left on show in its planter is discovered but not kept, and
 *  the Almanac counts the former. Wire format is `${species}|${tier}` per entry, because
 *  species and rarity are rolled independently; a bare species id (written in the first
 *  hours of this key) still registers the species, just with no rarity against it. */
let discovered = new Map<string, Set<number>>()
export function getDiscovered(): ReadonlyMap<string, ReadonlySet<number>> { return discovered }
/** How many species × rarity stamps have been found (one per tier seen of each species). */
export function stampsFound(): number {
  let n = 0
  discovered.forEach(tiers => { n += tiers.size })
  return n
}
export function setDiscovered(entries: string[]): void {
  const next = new Map<string, Set<number>>()
  for (const e of entries) {
    const bar = e.lastIndexOf('|')
    const id  = bar === -1 ? e : e.slice(0, bar)
    const t   = bar === -1 ? NaN : Number(e.slice(bar + 1))
    if (!id) continue
    const set = next.get(id) ?? new Set<number>()
    if (Number.isInteger(t)) set.add(t)
    next.set(id, set)
  }
  discovered = next
}

export function getFlowers(): Keepsake[] { return flowers }
export function setFlowers(list: Keepsake[]): void { flowers = list }
export function getBoxCap(): number { return boxCap }
export function setBoxCap(n: number): void { boxCap = n }

/** How many MORE flowers this gardener could put on the Avenue right now — server-owned,
 *  refreshed alongside the collection (harvest/gift/display/recall/join). Onboarding uses
 *  it to know when a nudge toward the Avenue is actually actionable. */
let avenueSlotsFree = 0
export function getAvenueSlotsFree(): number { return avenueSlotsFree }
export function setAvenueSlotsFree(n: number): void { avenueSlotsFree = n }

// Onboarding stage 3 (pouch) crosses the same seam as gifting: the tutorial SETS the
// hint, the HUD reads it, and the HUD calls back the first time the pouch is opened.
// It lives here rather than the HUD importing onboarding directly, because that would
// close a ui -> onboarding -> notifications -> ui import cycle.
let pouchHint = false
let pouchOpenedCb: (() => void) | null = null
export function getPouchHint(): boolean { return pouchHint }
export function setPouchHint(on: boolean): void { pouchHint = on }
export function registerPouchOpened(fn: () => void): void { pouchOpenedCb = fn }
export function notePouchOpened(): void { pouchOpenedCb?.() }

// Gifting is owned by giftSystem; it registers itself here so the menu can use it.
let giftApi: { gardenersHere(): Gardener[]; give(toAddress: string, flowerIndex: number): void; hold(flowerIndex: number): void; holdSeed(rarityTier: number): void } | null = null
export function registerGiftApi(api: NonNullable<typeof giftApi>): void { giftApi = api }
export function gardenersHere(): Gardener[] { return giftApi ? giftApi.gardenersHere() : [] }
export function giveFlower(toAddress: string, flowerIndex: number): void { giftApi?.give(toAddress, flowerIndex) }
// The Avenue is owned by avenueSystem; same registration pattern as gifting.
let avenueApi: { display(slotId: string, flowerIndex: number): void; recall(slotId: string): void } | null = null
export function registerAvenueApi(api: NonNullable<typeof avenueApi>): void { avenueApi = api }
/** Put this keepsake on the Avenue — slotId '' lets the server pick the first free slot. */
export function displayOnAvenue(slotId: string, flowerIndex: number): void { avenueApi?.display(slotId, flowerIndex) }

/** A flower picked in the menu and waiting for the player to choose its spot on the wall
 *  (KJ 2026-09-22: "wasn't able to choose my slot"). Lives here rather than in either of
 *  the two systems that use it — avenueSystem already imports the seed menu, so the menu
 *  cannot import it back. null = nothing armed. */
let armedAvenueFlower: number | null = null
export function getArmedAvenueFlower(): number | null { return armedAvenueFlower }
export function armAvenuePlacement(flowerIndex: number | null): void { armedAvenueFlower = flowerIndex }
export function recallFromAvenue(slotId: string): void { avenueApi?.recall(slotId) }
/** Ask the server to put this keepsake in my hand (-1 = empty hand). One at a time. */
export function holdFlower(flowerIndex: number): void { giftApi?.hold(flowerIndex) }
/** Equip a seed of this tier into my hand, replacing whatever was there (-1 = default). */
export function holdSeed(rarityTier: number): void { giftApi?.holdSeed(rarityTier) }
