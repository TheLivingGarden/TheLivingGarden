// =============================================================
// Bloom Garden v2 — Keepsake Collection & Gifting (CLIENT ONLY, greybox)
//
// GDD §3 step 5 / §5 social loop: a harvested flower is a keepsake you keep
// or give away. Gifting is a world tap on another player — no menu, no drag
// (GDD §6 "large target"). The server moves the flower; we only ask.
//
// Server communication:
//   send    →  giftFlower       { toAddress, flower, rarityTier, at }
//   receive ←  collectionUpdate { flowersJson, boxCap }   (mine, after harvest/gift/join)
//   receive ←  giftReceived     { from, flower, rarityTier }
//   receive ←  notice           { text }                  (server feedback toasts)
//   send    →  holdFlower       { flower, rarityTier, at, clear }   (clear:true = put away)
//   receive ←  heldFlower       { address, flower, rarityTier }   (anyone's hand, incl. mine)
//
// Held flower: one keepsake shown in a gardener's right hand, for everyone. Interlocks
// with gifting — a world tap on a player with nothing picked in the menu gives the flower
// you're holding; giving away the last one of that kind empties your hand (server).
//
// Tap target: an invisible pointer-only collider attached to each remote
// avatar (AvatarAttach by avatarId, like the bloom hand-flower). Pointer
// layer only, so it never blocks walking or plant clicks through a player.
// =============================================================

import {
  engine,
  Entity,
  Transform,
  MeshCollider,
  ColliderLayer,
  AvatarAttach,
  AvatarAnchorPointType,
  PlayerIdentityData,
  pointerEventsSystem,
  InputAction,
  GltfContainer,
} from '@dcl/sdk/ecs'
import { Quaternion } from '@dcl/sdk/math'
import { room } from './shared/messages'
import { showToast } from './notifications'
import { getPlayer } from '@dcl/sdk/players'
import { CollectionAssembler } from './shared/collection'
import { getFlowers, setFlowers, setBoxCap, setAvenueSlotsFree, registerGiftApi, Keepsake, setHeld, heldFlowerIndex, setDiscovered, keepsakeIdentity } from './playerInventory'
import { getSelectedGiftIndex, openSeedMenu } from './seedMenu'
import { rarityTierById, plantSpeciesById, withArticle, seedModelSrc, SEED_HAND_SCALE } from './shared/config'
import { isWateringEmoteActive } from './wateringSystem'
import { attachHeldFlowerVfx, detachPlantVfx } from './plantVfx'
import { playSfx } from './sounds'

// ---------------------------------------------------------------
// Config
// ---------------------------------------------------------------

const TAG_SIZE      = { x: 0.8, y: 1.8, z: 0.8 }   // roughly an avatar's body
const TAG_OFFSET_Y  = 0.9                           // AAPT_POSITION anchors at the feet
const GIFT_DISTANCE = 6     // m — mobile is third-person only
const SCAN_MS       = 1_000
const TOAST_MS      = 5_000
// Held flower in the RIGHT hand, facing forward — the left hand's bone is mirrored and the same
// rotation pointed the flower backwards (KJ 2026-09-18). Size is a fraction of the species'
// planter-box size.
const HAND_K        = 0.4
const HAND_OFFSET   = { x: 0, y: 0.06, z: 0 }
const HAND_ROTATION = Quaternion.fromEulerDegrees(90, 0, 0)
/** HAND_ROTATION tips a plant forward out of the fist, which is right for a flower held
 *  like a bouquet but lays a seed on its side. Undo it so the seed stands upright in the
 *  palm, and lift it clear of the hand mesh. */
const SEED_HAND_ROTATION = Quaternion.fromEulerDegrees(-90, 0, 0)
const SEED_HAND_LIFT     = 0.05

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------

let scanAccum = 0
const tags = new Map<string, Entity>()   // remote address → AvatarAttach parent
const hands = new Map<string, Entity>()  // address → held-flower AvatarAttach parent (mine included)



// ---------------------------------------------------------------
// Gifting (world tap on a player)
// ---------------------------------------------------------------

function tryGift(toAddress: string): void {
  const flowers = getFlowers()
  if (flowers.length === 0) {
    showToast('No flower to give yet — harvest one first', TOAST_MS, false)
    return
  }
  // World-tap is a shortcut for "who" — "which flower" comes from the seed menu's own
  // picker (My flowers → tap a kind → Gift), so tapping a player sends THAT selection
  // instead of silently guessing the newest keepsake.
  const flowerIndex = getSelectedGiftIndex() ?? heldFlowerIndex()
  const id = flowerIndex === null ? null : keepsakeIdentity(flowerIndex)
  if (!id) {
    showToast('Hold a flower, or pick one in your seed pouch, to gift it', TOAST_MS, false)
    openSeedMenu()
    return
  }
  console.log(`[Gift] offering ${id.flower} to ${toAddress}`)
  room.send('giftFlower', { toAddress, ...id })
  playSfx('gift')
}

function localAddress(): string { return (getPlayer()?.userId ?? '').toLowerCase() }

/** Show what a gardener holds in their right hand: their keepsake if they hold one,
 *  otherwise the rarest seed in their pouch (seedTier -1 = nothing to show). The server
 *  decides which, so the two can never collide and only one entity is ever attached.
 *
 *  MY hand additionally obeys the one-item-per-hand rule (KJ 2026-09-24: "a rose, a seed and
 *  the watering can"). Hiding by scale left the item showing on the client, so it is now
 *  STRUCTURAL: while the can or the Bloom rose owns the hand, my item's entity does not
 *  exist at all, and it is rebuilt from `myHandArgs` when the hand frees up. */
interface HandArgs { flower: string; rarityTier: number; seedTier: number }
let myHandArgs: HandArgs | null = null   // what the server says my hand holds (whether or not it is shown right now)

function setHand(address: string, flower: string, rarityTier: number, seedTier: number): void {
  if (address === localAddress()) {
    setHeld(flower ? { flower, rarityTier } : null)
    myHandArgs = { flower, rarityTier, seedTier }
    removeHand(address)   // args changed — rebuild from scratch
    applyMyHand()
    return
  }
  buildHand(address, flower, rarityTier, seedTier, false)
}

/** `removeEntityWithChildren` walks the Transform tree starting AT the root, so it removes NOTHING
 *  when the root has no Transform — and an AvatarAttach anchor doesn't have one. Every replaced hand item stayed
 *  on the hand (KJ 2026-09-27: the seed from load-in and a shelf flower at once), and a departed
 *  player's tag stayed in the scene.
 *  Remove the Transform children (and their subtrees), then the anchor itself. */
function removeAnchor(root: Entity): void {
  const kids: Entity[] = []
  for (const [e, t] of engine.getEntitiesWith(Transform)) if (t.parent === root) kids.push(e)
  for (const k of kids) engine.removeEntityWithChildren(k)
  engine.removeEntity(root)
}

function handVfxKey(address: string): string { return `hand:${address.toLowerCase()}` }

function removeHand(address: string): void {
  const old = hands.get(address)
  if (old !== undefined) { detachPlantVfx(handVfxKey(address)); removeAnchor(old); hands.delete(address) }
}

function buildHand(address: string, flower: string, rarityTier: number, seedTier: number, mine: boolean): void {
  removeHand(address)
  const species = flower ? plantSpeciesById(flower) : null
  if (!species && seedTier < 0) return
  const parent = engine.addEntity()
  AvatarAttach.create(parent, mine
    ? { anchorPointId: AvatarAnchorPointType.AAPT_RIGHT_HAND }
    : { avatarId: address, anchorPointId: AvatarAnchorPointType.AAPT_RIGHT_HAND })
  const holder = engine.addEntity()
  Transform.create(holder, { parent, position: HAND_OFFSET, rotation: HAND_ROTATION })
  const model = engine.addEntity()
  if (species) {
    const k = species.scale * HAND_K
    Transform.create(model, {
      parent: holder,
      position: { x: species.offsetX * HAND_K, y: species.baseYOffset * HAND_K, z: species.offsetZ * HAND_K },
      scale: { x: k, y: k, z: k },
    })
    GltfContainer.create(model, { src: species.modelSrc, visibleMeshesCollisionMask: ColliderLayer.CL_NONE, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE })
    // (2026-09-28: "held plant is missing its rarity vfx") — same tier tint/pulse a planted
    // or Avenue-displayed flower gets, minus particles/light (see attachHeldFlowerVfx).
    attachHeldFlowerVfx(handVfxKey(address), model, species.id, rarityTier)
  } else {
    // Seed: one shared 152-tri mesh per tier, centred near its own origin, so it needs
    // no per-species offsets — just the scale that brings it down to a hand.
    Transform.create(model, {
      parent: holder,
      position: { x: 0, y: SEED_HAND_LIFT, z: 0 },
      rotation: SEED_HAND_ROTATION,
      scale: { x: SEED_HAND_SCALE, y: SEED_HAND_SCALE, z: SEED_HAND_SCALE },
    })
    GltfContainer.create(model, { src: seedModelSrc(seedTier), visibleMeshesCollisionMask: ColliderLayer.CL_NONE, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE })
  }
  hands.set(address, parent)
}

/** Build or remove MY hand item to match who owns the hand right now: the watering can (its
 *  emote is playing) wins over my keepsake / seed. (The Bloom rose that also used to compete for
 *  the hand was removed 2026-09-27.) */
let lastHandLog = ''
function applyMyHand(): void {
  const me = localAddress()
  if (!me) return
  const taken = isWateringEmoteActive()
  const has = hands.has(me)
  // Change-only log, so a "seed in hand with the can" report can be read straight from the console
  const state = `${taken ? 'CAN' : '-'} item=${has ? 'shown' : 'none'} want=${myHandArgs ? (myHandArgs.flower || `seed${myHandArgs.seedTier}`) : 'none'}`
  if (state !== lastHandLog) { lastHandLog = state; console.log(`[Hand] ${state}`) }
  if (taken) { if (has) removeHand(me); return }
  if (!has && myHandArgs && (myHandArgs.flower ? plantSpeciesById(myHandArgs.flower) !== null : myHandArgs.seedTier >= 0)) buildHand(me, myHandArgs.flower, myHandArgs.rarityTier, myHandArgs.seedTier, true)
}

/** My item gives way to the watering can. */
export function syncMyHand(): void {
  applyMyHand()
}

/** Every frame, not just on the scan tick: an item must vanish the frame the hand is taken. */
function handArbiterSystem(): void { syncMyHand() }

/** TEMP diagnostic (KJ 2026-09-27: "the seed and the flower on my own avatar"). `attached` counts
 *  every right-hand attachment on MY avatar (mine, and any built for my address on the
 *  other-player path) — anything above 1 is the bug, and the rest says which path. */
export function handDiagnostics(): string {
  const me = localAddress()
  let attached = 0
  for (const [, a] of engine.getEntitiesWith(AvatarAttach)) {
    if (a.anchorPointId !== AvatarAnchorPointType.AAPT_RIGHT_HAND) continue
    if (!a.avatarId || a.avatarId.toLowerCase() === me) attached++
  }
  const want = myHandArgs ? (myHandArgs.flower || `seed${myHandArgs.seedTier}`) : 'none'
  return `hand: me ${me ? me.slice(0, 6) : 'NONE'} | attached ${attached} | mine ${hands.has(me) ? 1 : 0} | can ${isWateringEmoteActive() ? 1 : 0} | want ${want} | entries ${hands.size}`
}

function createTag(address: string): Entity {
  const parent = engine.addEntity()
  AvatarAttach.create(parent, { avatarId: address, anchorPointId: AvatarAnchorPointType.AAPT_POSITION })

  const body = engine.addEntity()
  Transform.create(body, { position: { x: 0, y: TAG_OFFSET_Y, z: 0 }, scale: TAG_SIZE, parent })
  MeshCollider.setBox(body, ColliderLayer.CL_POINTER)
  pointerEventsSystem.onPointerDown(
    { entity: body, opts: { button: InputAction.IA_POINTER, hoverText: 'Gift a flower', maxDistance: GIFT_DISTANCE } },
    () => tryGift(address),
  )
  return parent
}

/** Keep one tap target per remote avatar; drop them when players leave. */
function tagScanSystem(dt: number): void {
  scanAccum += dt * 1_000
  if (scanAccum < SCAN_MS) return
  scanAccum = 0
  syncMyHand()

  const present = new Set<string>()
  for (const [entity, ident] of engine.getEntitiesWith(PlayerIdentityData)) {
    if (entity === engine.PlayerEntity) continue
    const address = ident.address.toLowerCase()
    present.add(address)
    if (!tags.has(address)) tags.set(address, createTag(address))
  }
  for (const [address, parent] of tags) {
    if (present.has(address)) continue
    removeAnchor(parent)
    tags.delete(address)
  }
}

// ---------------------------------------------------------------
// Setup
// ---------------------------------------------------------------

/** Register handlers — MUST be called after wateringSystem's room.clear(). */
export function setupGiftSystem(): void {
  room.onMessage('discoveredUpdate', (data) => {
    let ids: string[] = []
    try { ids = JSON.parse(data.listJson) } catch { ids = [] }
    setDiscovered(ids)
    console.log(`[Gift] discovered: ${ids.length} species`)
  })

  // The collection arrives in chunks (shared/collection.ts); every chunk carries the planter cap, so it is applied at once.
  const assembler = new CollectionAssembler()
  room.onMessage('collectionUpdate', (data) => {
    setBoxCap(data.boxCap)
    setAvenueSlotsFree(data.avenueSlotsFree)
    let items: Keepsake[] = []
    try { items = JSON.parse(data.flowersJson) } catch { items = [] }
    const done = assembler.add(data.start ?? 0, data.total ?? items.length, items)
    if (done) {
      setFlowers(done as Keepsake[])
      console.log(`[Gift] collection: ${done.length} flower(s), box cap ${data.boxCap}`)
    }
  })

  room.onMessage('giftReceived', (data) => {
    playSfx('gift')
    const tierName = rarityTierById(data.rarityTier).name
    showToast(`${data.from} gave you ${withArticle(plantSpeciesById(data.flower)?.name ?? data.flower)}${data.rarityTier > 0 ? ` — ${withArticle(tierName)} one!` : ''}`, TOAST_MS, false)
  })

  room.onMessage('heldFlower', (data) => {
    setHand(data.address.toLowerCase(), data.flower, data.rarityTier, data.seedTier ?? -1)
  })

  room.onMessage('notice', (data) => {
    showToast(data.text, TOAST_MS, false)
  })

  // The seed menu gifts through the store: who is here (same set the avatar tap targets
  // track) and the one call that sends a flower.
  registerGiftApi({
    gardenersHere: () => [...tags.keys()].map(address => ({ address, name: getPlayer({ userId: address })?.name || `${address.slice(0, 6)}...` })),
    give: (toAddress, flowerIndex) => {
      const id = keepsakeIdentity(flowerIndex)
      if (!id) return
      console.log(`[Gift] menu gift ${id.flower} to ${toAddress}`)
      room.send('giftFlower', { toAddress, ...id })
      playSfx('gift')
    },
    hold: (flowerIndex) => {
      if (flowerIndex < 0) { console.log('[Gift] hold cleared'); room.send('holdFlower', { flower: '', rarityTier: 0, at: 0, clear: true }); return }
      const id = keepsakeIdentity(flowerIndex)
      if (!id) return
      console.log(`[Gift] hold ${id.flower}`)
      room.send('holdFlower', { ...id, clear: false })
    },
    holdSeed: (rarityTier) => { console.log(`[Gift] equip seed tier ${rarityTier}`); room.send('holdSeed', { rarityTier }) },
  })
  engine.addSystem(tagScanSystem)
  engine.addSystem(handArbiterSystem)
  console.log(`[Gift] ready · notice listeners=${room.listenerCount('notice')}`)
}
