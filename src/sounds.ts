// =============================================================
// Bloom Garden v2 — one-shot sound effects (CLIENT)
//
// playSfx('harvest') at the player, or playSfx('flowerOpen', planterPos) so nearby
// players hear it from the planter. The sfx/*.mp3 chimes were synthesized for Bloom
// Garden (2026-09-19, no third-party licence) — replace any file freely, same name.
//
// Replaying: see the voice-pool note below.
// =============================================================

import { engine, Entity, Transform, AudioSource } from '@dcl/sdk/ecs'

const SFX = {
  seedCatch:  { src: 'assets/scene/Sounds/sfx/seedCatch.mp3',  volume: 0.6 },
  // Catching a Bloom seed (KJ 2026-10-05: seedCatch was lacklustre for it). Generator: empty for claude/tools/seed_sfx.py.
  seedPickup: { src: 'assets/scene/Sounds/sfx/seedPickup.wav', volume: 0.75 },
  plant:      { src: 'assets/scene/Sounds/sfx/plant.mp3',      volume: 0.8 },
  harvest:    { src: 'assets/scene/Sounds/sfx/harvest.mp3',    volume: 0.8 },
  gift:       { src: 'assets/scene/Sounds/sfx/gift.mp3',       volume: 0.9 },
  flowerOpen: { src: 'assets/scene/Sounds/sfx/flowerOpen.mp3', volume: 0.9 },
  golden:     { src: 'assets/scene/Sounds/MagicFX.mp3',         volume: 1.0 },
  // Tutorial (2026-09-27): same synthesised C-major bell family, WAV — no mp3 encoder on the
  // build machine. Generator: empty for claude/tools/tutorial_sfx.py.
  tutorialTap:      { src: 'assets/scene/Sounds/sfx/tutorialTap.wav',      volume: 0.7 },
  tutorialWaypoint: { src: 'assets/scene/Sounds/sfx/tutorialWaypoint.wav', volume: 0.7 },
  tutorialStep:     { src: 'assets/scene/Sounds/sfx/tutorialStep.wav',     volume: 0.9 },
  tutorialDone:     { src: 'assets/scene/Sounds/sfx/tutorialDone.wav',     volume: 1.0 },
} as const   // TUNING — volumes
export type SfxName = keyof typeof SFX

// Voice pools. A single AudioSource entity retriggered by "playing=false then true next tick" DROPS sounds when repeats
// land inside one frame's worth of updates (the renderer only sees the final state) — on a phone, where several
// waters land in quick succession, that lost sounds (KJ 2026-09-30). So every clip gets a ring of VOICES entities,
// and each play REPLACES the component on the next voice with playing:true, which the renderer always sees as a new start.
const VOICES = 6
const pools = new Map<string, { ents: Entity[]; next: number }>()

/** Play any clip once from a free voice, at `at` (default: the player). */
export function playClip(src: string, volume: number, at?: { x: number; y: number; z: number }): void {
  const pos = at ?? Transform.getOrNull(engine.PlayerEntity)?.position
  if (!pos) return
  let pool = pools.get(src)
  if (!pool) {
    pool = { ents: [], next: 0 }
    for (let i = 0; i < VOICES; i++) {
      const e = engine.addEntity()
      Transform.create(e, { position: pos })
      pool.ents.push(e)
    }
    pools.set(src, pool)
  }
  const e = pool.ents[pool.next]
  pool.next = (pool.next + 1) % pool.ents.length
  Transform.getMutable(e).position = pos
  AudioSource.createOrReplace(e, { audioClipUrl: src, playing: true, loop: false, volume, pitch: 1 })
}

export function playSfx(name: SfxName, at?: { x: number; y: number; z: number }): void {
  playClip(SFX[name].src, SFX[name].volume, at)
}
