// =============================================================
// The Living Garden — Watering System
// Prototype following DCL SDK7 patterns
// =============================================================

import {
  engine,
  Entity,
  Schemas,
  Animator,
  GltfContainer,
  TextShape,
  Billboard,
  BillboardMode,
  MeshCollider,
  ColliderLayer,
  pointerEventsSystem,
  InputAction,
  Transform,
  executeTask,
  timers,
} from '@dcl/sdk/ecs'

// ---------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------

// Set to true to compress all timers for rapid prototyping:
//   - Watered expiry  : 6h   → 30s
//   - Bloom delay     : next 6am/6pm UTC → 10s
//   - Post-bloom reset: +60s → +5s
//   - Server calls    : skipped (console logged instead)
const TEST_MODE = true

// TODO: replace with your real server base URL
const SERVER_URL = 'https://YOUR_SERVER_URL/api'

const TOTAL_PLANTS = 16

// How long a "watered" state lasts before expiring (ms).
// Switching between 6h and 12h is easy here.
const WATERED_EXPIRY_MS = TEST_MODE
  ? 30_000               // 30 seconds in test mode
  : 6 * 60 * 60 * 1000  // 6 hours in production

// Animation clip names — must match the GLB exactly.
const ANIM_DROOPY_STATE   = 'DroopyState'    // looping droopy idle
const ANIM_TO_HEALTHY     = 'DroopyToHealthy' // one-shot transition
const ANIM_HEALTHY_STATE  = 'HealthyState'   // looping healthy idle
const ANIM_TO_DROOPY      = 'HealthToDroopy' // one-shot transition
const ANIM_BLOOM          = 'Bloom'          // bloom model animation

// How long the transition clips play before switching to the looping idle.
// TODO: set this to match the actual DroopyToHealthy / HealthToDroopy clip length.
const ANIM_TRANSITION_MS = 1500

// Toggle click method for UX prototyping:
//   false → click directly on the plant model (default)
//   true  → invisible oversized clickbox parented to each plant
const USE_CLICKBOX = false

// Plant entity names as placed in the scene editor.
const PLANT_NAMES = [
  'Plant_1',  'Plant_2',  'Plant_3',  'Plant_4',
  'Plant_5',  'Plant_6',  'Plant_7',  'Plant_8',
  'Plant_9',  'Plant_10', 'Plant_11', 'Plant_12',
  'Plant_13', 'Plant_14', 'Plant_15', 'Plant_16',
]

// ---------------------------------------------------------------
// Custom Component — tracks per-plant watered state
// ---------------------------------------------------------------

export const PlantData = engine.defineComponent('plant-data', {
  isWatered: Schemas.Boolean,
  wateredAt: Schemas.Number,  // Unix timestamp (ms); 0 when not watered
})

// ---------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------

let progressEntity: Entity
let bloomBillboard: Entity
let bloomModelEntity: Entity | null = null
let wateredCount = 0
// True between bloom trigger and the post-bloom reset — expiry timers skip
// during this window so plants stay healthy through the full bloom moment.
let bloomActive = false
// True while petals are raining down
let petalActive = false

// ---------------------------------------------------------------
// Petal particle system
// ---------------------------------------------------------------

const PETAL_COUNT         = 30
const PETAL_CENTER        = { x: 8, z: 8 }
const PETAL_SPAWN_RADIUS  = 5
const PETAL_HEIGHT_MAX    = 7   // max spawn height (m)
const PETAL_HEIGHT_MIN    = 1   // min spawn height (m)
const PETAL_FALL_MIN      = 0.4 // m/s min fall speed
const PETAL_FALL_MAX      = 1.0 // m/s max fall speed
const PETAL_DRIFT_MAX     = 0.3 // m/s max horizontal drift
const PETAL_LIFE_MIN_MS   = 3_000
const PETAL_LIFE_MAX_MS   = 7_000
const PETAL_SCALE         = 0.25

interface PetalState {
  entity:      Entity
  pos:         { x: number; y: number; z: number }
  vel:         { x: number; y: number; z: number }
  rotY:        number
  rotSpeed:    number
  lifetime:    number   // ms remaining
  maxLifetime: number   // ms total
}

const petalPool: PetalState[] = []

function randomizePetal(p: PetalState) {
  const angle  = Math.random() * Math.PI * 2
  const radius = Math.random() * PETAL_SPAWN_RADIUS
  p.pos = {
    x: PETAL_CENTER.x + Math.cos(angle) * radius,
    y: PETAL_HEIGHT_MIN + Math.random() * (PETAL_HEIGHT_MAX - PETAL_HEIGHT_MIN),
    z: PETAL_CENTER.z + Math.sin(angle) * radius,
  }
  p.vel = {
    x: (Math.random() - 0.5) * PETAL_DRIFT_MAX * 2,
    y: -(PETAL_FALL_MIN + Math.random() * (PETAL_FALL_MAX - PETAL_FALL_MIN)),
    z: (Math.random() - 0.5) * PETAL_DRIFT_MAX * 2,
  }
  p.rotY        = Math.random() * Math.PI * 2
  p.rotSpeed    = (Math.random() - 0.5) * 4
  p.maxLifetime = PETAL_LIFE_MIN_MS + Math.random() * (PETAL_LIFE_MAX_MS - PETAL_LIFE_MIN_MS)
  p.lifetime    = p.maxLifetime
}

function petalParticleSystem(dt: number) {
  if (!petalActive) return

  for (const p of petalPool) {
    p.pos.x   += p.vel.x * dt
    p.pos.y   += p.vel.y * dt
    p.pos.z   += p.vel.z * dt
    p.rotY    += p.rotSpeed * dt
    p.lifetime -= dt * 1000

    // Respawn when lifetime expires or petal hits the ground
    if (p.lifetime <= 0 || p.pos.y < 0) {
      randomizePetal(p)
    }

    // Apply to renderer — rotation as Y-axis quaternion
    const half = p.rotY * 0.5
    const t = Transform.getMutable(p.entity)
    t.position = { x: p.pos.x, y: p.pos.y, z: p.pos.z }
    t.rotation = { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }
  }
}

// Reset animation state machine — driven by an ECS system so Animator
// updates run in the main update loop (same execution context as pointer
// events) rather than nested timer callbacks which the renderer ignores.
let resetQueue:  Entity[] = []
let resetPhase:  'to_droopy' | 'wait' | 'to_droopy_state' | 'done' = 'done'
let resetTimerMs = 0

// ---------------------------------------------------------------
// Helper: work out the next 6am or 6pm UTC bloom time
// ---------------------------------------------------------------

function getNextBloomTime(): number {
  if (TEST_MODE) return Date.now() + 10_000  // bloom fires in 10s

  const now = new Date()

  const at6am = new Date(now)
  at6am.setUTCHours(6, 0, 0, 0)

  const at6pm = new Date(now)
  at6pm.setUTCHours(18, 0, 0, 0)

  if (now < at6am) return at6am.getTime()
  if (now < at6pm) return at6pm.getTime()

  // Past 6pm — next is 6am tomorrow
  const tomorrow6am = new Date(at6am)
  tomorrow6am.setUTCDate(tomorrow6am.getUTCDate() + 1)
  return tomorrow6am.getTime()
}

// ---------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------

function updateProgressText() {
  const suffix = TEST_MODE ? '\n[TEST MODE]' : ''
  TextShape.getMutable(progressEntity).text =
    `${wateredCount}/${TOTAL_PLANTS} Plants Watered${suffix}`
}

function showBloomText(text: string) {
  TextShape.getMutable(bloomBillboard).text = text
}

// ---------------------------------------------------------------
// Server calls
// ---------------------------------------------------------------

function fetchPlantStates() {
  if (TEST_MODE) {
    console.log('[TEST] fetchPlantStates skipped — all plants start droopy')
    return
  }
  executeTask(async () => {
    try {
      const response = await fetch(`${SERVER_URL}/plants`)
      const data: Array<{ plantId: string; isWatered: boolean; wateredAt: number }> =
        await response.json()

      const now = Date.now()

      for (const state of data) {
        const entity = engine.getEntityOrNullByName(state.plantId)
        if (!entity || !PlantData.has(entity)) continue

        const msElapsed = now - state.wateredAt

        if (state.isWatered && msElapsed < WATERED_EXPIRY_MS) {
          const pd = PlantData.getMutable(entity)
          pd.isWatered = true
          pd.wateredAt = state.wateredAt

          // Already mid-session — jump straight to healthy idle
          Animator.playSingleAnimation(entity, ANIM_HEALTHY_STATE)
          wateredCount++

          const msRemaining = WATERED_EXPIRY_MS - msElapsed
          scheduleExpiry(entity, state.wateredAt, msRemaining)
        }
      }

      updateProgressText()
      if (wateredCount >= TOTAL_PLANTS) triggerBloomEvent()
    } catch (e) {
      console.log('Could not fetch plant states from server:', e)
    }
  })
}

function sendWateredToServer(plantId: string, wateredAt: number) {
  if (TEST_MODE) {
    console.log(`[TEST] sendWateredToServer skipped — ${plantId} watered at ${wateredAt}`)
    return
  }
  executeTask(async () => {
    try {
      await fetch(`${SERVER_URL}/water`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plantId, wateredAt }),
      })
    } catch (e) {
      console.log('Could not send watered state to server:', e)
    }
  })
}

// ---------------------------------------------------------------
// Plant lifecycle
// ---------------------------------------------------------------

/** Schedule an expiry timer that reverts one plant to droopy. */
function scheduleExpiry(entity: Entity, sessionTimestamp: number, delayMs: number) {
  timers.setTimeout(() => {
    // During bloom the reset will handle all plants — skip individual expiry
    if (bloomActive) return
    const pd = PlantData.getMutable(entity)
    // Guard: only revert if this is still the same watered session
    if (!pd.isWatered || pd.wateredAt !== sessionTimestamp) return

    pd.isWatered = false
    pd.wateredAt = 0
    wateredCount = Math.max(0, wateredCount - 1)
    updateProgressText()

    // Play transition, then settle into droopy idle.
    // Guard: only land on DroopyState if the plant hasn't been re-watered.
    Animator.playSingleAnimation(entity, ANIM_TO_DROOPY)
    timers.setTimeout(() => {
      if (!PlantData.get(entity).isWatered) {
        Animator.playSingleAnimation(entity, ANIM_DROOPY_STATE)
      }
    }, ANIM_TRANSITION_MS)
  }, delayMs)
}

/** Water a single plant: animation, sound, state update, server sync. */
function waterPlant(entity: Entity, plantId: string) {
  const pd = PlantData.getMutable(entity)
  if (pd.isWatered) return  // already watered — ignore

  const now = Date.now()
  pd.isWatered = true
  pd.wateredAt = now

  // Play transition, then settle into healthy idle.
  // Guard: only switch to HealthyState if this session is still active.
  Animator.playSingleAnimation(entity, ANIM_TO_HEALTHY)
  timers.setTimeout(() => {
    const current = PlantData.get(entity)
    if (current.isWatered && current.wateredAt === now) {
      Animator.playSingleAnimation(entity, ANIM_HEALTHY_STATE)
    }
  }, ANIM_TRANSITION_MS)

  // TODO: AudioSource.getMutable(entity).playing = true  (re-enable when audio is ready)

  // Sync to server
  sendWateredToServer(plantId, now)

  // Update progress display
  wateredCount++
  updateProgressText()

  // Schedule expiry
  scheduleExpiry(entity, now, WATERED_EXPIRY_MS)

  // Check for full-garden bloom
  if (wateredCount >= TOTAL_PLANTS) triggerBloomEvent()
}

/** Reset every plant back to droopy (called after bloom). */
function resetAllPlants() {
  bloomActive = false
  wateredCount = 0
  updateProgressText()

  // Stop petal rain
  petalActive = false
  for (const p of petalPool) {
    Transform.getMutable(p.entity).scale = { x: 0, y: 0, z: 0 }
  }

  // Clear state and build the queue for the reset system
  resetQueue = []
  for (const [entity] of engine.getEntitiesWith(PlantData)) {
    const pd = PlantData.getMutable(entity)
    pd.isWatered = false
    pd.wateredAt = 0
    resetQueue.push(entity)
  }
  resetPhase  = 'to_droopy'
  resetTimerMs = 0
  console.log(`[RESET] resetAllPlants — ${resetQueue.length} plants queued`)

  // Stop the bloom model animation
  if (bloomModelEntity) {
    Animator.getMutable(bloomModelEntity).states[0].playing = false
  }
}

// ECS system that drives the reset animation one plant per frame.
// Running inside the main update loop ensures Animator mutations reach
// the renderer in the same processing lane as pointer events.
function resetAnimSystem(dt: number) {
  if (resetPhase === 'done') return

  if (resetPhase === 'to_droopy') {
    // Stop all animations first, then start HealthToDroopy on one plant per frame.
    // stopAllAnimations sends a distinct renderer event that properly interrupts
    // looping clips — getMutable alone doesn't reliably interrupt a running loop.
    const entity = resetQueue.shift()
    if (entity) {
      Animator.stopAllAnimations(entity, true)
      Animator.playSingleAnimation(entity, ANIM_TO_DROOPY, true)
      console.log(`[RESET-SYS] to_droopy fired on entity ${entity}`)
    }
    if (resetQueue.length === 0) {
      resetPhase  = 'wait'
      resetTimerMs = 0
      for (const [e] of engine.getEntitiesWith(PlantData)) resetQueue.push(e)
    }
    return
  }

  if (resetPhase === 'wait') {
    resetTimerMs += dt * 1000
    if (resetTimerMs >= ANIM_TRANSITION_MS) resetPhase = 'to_droopy_state'
    return
  }

  if (resetPhase === 'to_droopy_state') {
    const entity = resetQueue.shift()
    if (entity && !PlantData.get(entity).isWatered) {
      Animator.stopAllAnimations(entity, true)
      Animator.playSingleAnimation(entity, ANIM_DROOPY_STATE, true)
      console.log(`[RESET-SYS] to_droopy_state fired on entity ${entity}`)
    }
    if (resetQueue.length === 0) {
      resetPhase = 'done'
      console.log('[RESET] system complete — all plants in DroopyState')
    }
  }
}

// ---------------------------------------------------------------
// Bloom event
// ---------------------------------------------------------------

function triggerBloomEvent() {
  bloomActive = true
  showBloomText('The Garden is in Full Bloom!')
  console.log('Bloom triggered!')

  // Start petal rain — stagger initial lifetimes so petals don't all spawn at once
  petalActive = true
  for (const p of petalPool) {
    randomizePetal(p)
    p.lifetime = Math.random() * p.maxLifetime  // stagger entry
    const t = Transform.getMutable(p.entity)
    t.scale = { x: PETAL_SCALE, y: PETAL_SCALE, z: PETAL_SCALE }
  }

  // Play bloom model animation
  if (bloomModelEntity) {
    Animator.playSingleAnimation(bloomModelEntity, ANIM_BLOOM)
  }

  const msUntilNextBloom = getNextBloomTime() - Date.now()
  const resetDelay = TEST_MODE ? 5_000 : 60_000

  if (TEST_MODE) {
    console.log(`[TEST] Bloom fires in ${msUntilNextBloom / 1000}s, reset in ${(msUntilNextBloom + resetDelay) / 1000}s`)
  } else {
    console.log(`Next bloom scheduled in ${Math.round(msUntilNextBloom / 1000 / 60)} minutes`)
  }

  timers.setTimeout(() => {
    resetAllPlants()
    showBloomText('')
  }, msUntilNextBloom + resetDelay)
}

// ---------------------------------------------------------------
// Per-plant setup
// ---------------------------------------------------------------

function setupPlant(plantName: string) {
  const entity = engine.getEntityOrNullByName(plantName)
  if (!entity) {
    console.log(`[WateringSystem] Entity not found: ${plantName}`)
    return
  }

  // Track watered state
  PlantData.create(entity, { isWatered: false, wateredAt: 0 })

  // TODO: add AudioSource once audio files are in place
  // AudioSource.createOrReplace(entity, { audioClipUrl: 'assets/sounds/water.mp3', ... })

  // Click target — swap via USE_CLICKBOX flag at the top of the file
  let clickTarget: Entity
  if (USE_CLICKBOX) {
    // Invisible oversized box parented to the plant — easy to hit.
    // Adjust scale/position to taste during UX feedback.
    const clickBox = engine.addEntity()
    Transform.create(clickBox, {
      position: { x: 0, y: 1, z: 0 },   // centred 1m above plant base
      scale:    { x: 1.5, y: 2, z: 1.5 },
      parent:   entity,
    })
    MeshCollider.setBox(clickBox, ColliderLayer.CL_POINTER)
    clickTarget = clickBox
  } else {
    clickTarget = entity
  }

  pointerEventsSystem.onPointerDown(
    {
      entity: clickTarget,
      opts: { button: InputAction.IA_POINTER, hoverText: 'Water' },
    },
    () => waterPlant(entity, plantName)
  )
}

// ---------------------------------------------------------------
// Public entry point — call from index.ts main()
// ---------------------------------------------------------------

export function setupWateringSystem() {
  // Progress indicator — always faces the player (Y-billboard)
  progressEntity = engine.addEntity()
  Transform.create(progressEntity, {
    position: { x: 8, y: 3.5, z: 8 },
  })
  TextShape.create(progressEntity, {
    text: `0/${TOTAL_PLANTS} Plants Watered${TEST_MODE ? '\n[TEST MODE]' : ''}`,
    fontSize: 3,
  })
  Billboard.create(progressEntity, { billboardMode: BillboardMode.BM_Y })

  // Bloom billboard — shown when all plants are watered
  bloomBillboard = engine.addEntity()
  Transform.create(bloomBillboard, {
    position: { x: 8, y: 5, z: 8 },
  })
  TextShape.create(bloomBillboard, {
    text: '',
    fontSize: 4,
  })
  Billboard.create(bloomBillboard, { billboardMode: BillboardMode.BM_Y })

  // Bloom model — separate entity with its own Bloom animation
  const bloomEnt = engine.getEntityOrNullByName('Bloom')
  if (bloomEnt) {
    bloomModelEntity = bloomEnt
    Animator.createOrReplace(bloomEnt, {
      states: [{ clip: ANIM_BLOOM, playing: false, loop: true }],
    })
  } else {
    console.log('[WateringSystem] Bloom.glb entity not found')
  }

  // Wire up each plant (pointer events, state component, audio)
  for (const name of PLANT_NAMES) {
    setupPlant(name)
  }

  // Animator setup is deferred 1s to ensure GltfContainers have fully loaded.
  timers.setTimeout(() => {
    for (const name of PLANT_NAMES) {
      const entity = engine.getEntityOrNullByName(name)
      if (!entity) {
        console.log(`[WateringSystem] entity not found — ${name}`)
        continue
      }

      Animator.createOrReplace(entity, {
        states: [
          { clip: ANIM_DROOPY_STATE,  playing: false, loop: true  },
          { clip: ANIM_TO_HEALTHY,    playing: false, loop: false },
          { clip: ANIM_HEALTHY_STATE, playing: false, loop: true  },
          { clip: ANIM_TO_DROOPY,     playing: false, loop: false },
        ],
      })
      Animator.playSingleAnimation(entity, ANIM_DROOPY_STATE, true)
    }
  }, 1000)

  // Petal particle system — hide source entity, create pooled instances
  const petalSource = engine.getEntityOrNullByName('Petal')
  if (petalSource) {
    const gltf = GltfContainer.getOrNull(petalSource)
    const src  = gltf?.src ?? ''
    // Hide the original scene entity
    Transform.getMutable(petalSource).scale = { x: 0, y: 0, z: 0 }

    for (let i = 0; i < PETAL_COUNT; i++) {
      const ent = engine.addEntity()
      GltfContainer.create(ent, { src })
      Transform.create(ent, {
        position: { x: 0, y: -10, z: 0 },
        scale:    { x: 0, y: 0, z: 0 },     // hidden until bloom
      })
      petalPool.push({
        entity:      ent,
        pos:         { x: 0, y: -10, z: 0 },
        vel:         { x: 0, y: -1, z: 0 },
        rotY:        0,
        rotSpeed:    1,
        lifetime:    0,
        maxLifetime: PETAL_LIFE_MAX_MS,
      })
    }
    console.log(`[WateringSystem] Petal pool ready — ${PETAL_COUNT} instances from "${src}"`)
  } else {
    console.log('[WateringSystem] Petal entity not found — particle system disabled')
  }

  // Reset animation system — runs every frame, idles when resetPhase === 'done'
  engine.addSystem(resetAnimSystem)

  // Petal particle system — runs every frame, idles when petalActive === false
  engine.addSystem(petalParticleSystem)

  // Pull any existing watered states from the server
  fetchPlantStates()
}



/// TODO
//**

// - in live mode check server for plant state
// -------------------
// Implement daily watering limit - try 8 per player
// Implement override feature for testing or test with multiple clients
// ---------------------
// Water droplet on top of droopy plants (wait for feedback before implementation)
// ----------------------
// Tighten bloom moment build up and pacing
// -----------------------
// Find and add audio files (watering, click covered by foundation defaults) 
// -----------------------
// Petal particle system for bloom
// -----------------------
// Lights sway and flicker for bloom
// -----------------------
// Sounds for plant animations + bloom moment 
// */