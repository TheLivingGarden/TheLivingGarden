// =============================================================
// Bloom Garden v2 — Water streak nametag badge (CLIENT ONLY)
//
// Ported from Clean The Club's rankBadgeSystem.ts (2026-09-28, KJ: "an avatar name tag
// extension with the streak number of waters a player has? we can use the same feature we
// did in CTC"). The SDK can't edit the explorer's own nametag, only hide it and let a scene
// draw its own — so this hides real nametags scene-wide and plates the name + current water
// streak for EVERY player present, not just the local one, the same way CTC put a career
// title under a cleaner's name.
//
// Streak = consecutive ACCEPTED waterPlant calls this connection (server.ts waterStreak),
// reset to 0 by any waterRejected. Server sends one delta (streakUpdate) per change, plus a
// per-gardener resend on join/full-sync — not a full roster, since this fires on every water.
// =============================================================

import {
  engine, Entity, Transform, MeshRenderer, Material, MaterialTransparencyMode,
  TextShape, AvatarAttach, AvatarAnchorPointType, Billboard, BillboardMode, PlayerIdentityData,
  AvatarModifierArea, AvatarModifierType,
} from '@dcl/sdk/ecs'
import { Color3, Color4, Vector3 } from '@dcl/sdk/math'
import { room } from './shared/messages'
import { flairIcon } from './shared/config'

// Sized to sit where the real nametag did. Authored at REF_DIST_M and scaled by
// camera distance so the plate keeps a near-constant screen size, then faded at
// range — both behaviours copied from the explorer's own tag (and from CTC).
const PLATE_Y      = 0.10
// Layer depths in the billboarded carrier's local space (-z = toward the camera): pill at 0, icon in front of it, text in front of both.
// They were 6 / 12 / 20 mm apart, which z-fights (and sorts wrongly among the transparent layers) at any real distance; 3 cm steps are
// invisible as parallax at nametag range but give the depth buffer and the transparency sort something to work with.
const Z_FLAIR      = -0.07
const Z_TEXT       = -0.14
const NAME_FONT    = 0.95
const STREAK_FONT  = 0.8
const PILL_H       = 0.32
// The pill texture is a white stadium drawn in the middle 25% band of a square
// PNG (the rest transparent), so the quad is scaled 4× the visible height and
// the shape supplies the rounded corners. White on purpose: albedoColor tints
// it, so one texture serves every colour. (Same texture file as CTC's plate.)
const PILL_TEX      = 'assets/scene/UI/plate_pill.png'
const PILL_BAND     = 0.25
const PILL_PER_CHAR = 0.052
const PILL_PAD      = 0.16
const REF_DIST_M    = 6
const SCALE_MIN     = 0.7
const SCALE_MAX     = 2.6
const FADE_START_M  = 14
const FADE_END_M    = 20

// One streak number, one colour: plain white like the name (KJ 2026-09-29: the green digits kept
// reading black — the leaf green had no contrast against the thick black outline).
const STREAK_COLOR = Color4.create(1, 1, 1, 1)

type StreakInfo = { name: string; streak: number; tier: number }
const streaks = new Map<string, StreakInfo>()   // lowercased address → info

type Plate = {
  root:    Entity   // AvatarAttach'd to the player
  carrier: Entity   // billboarded holder — animated (float + streak-up pop)
  pill:    Entity
  nameT:   Entity
  streakT: Entity
  flair:   Entity   // the flair icon (sprout / flower / golden flower) left of the name
  tier:    number   // last flair tier drawn, so the icon is only repainted on change
  avatar:  Entity   // the PlayerIdentityData entity, for distance/fade
  key:     string   // last rendered content, so we only rebuild on change
  fade:    number
  scale:   number   // last distance-derived scale, reused by the animator
  streak:  number   // to detect a streak going UP (pop) vs resetting (no pop)
  popMs:   number   // >=0 while a streak-up pop is playing
  bob:     number   // per-plate phase so plates don't float in lockstep
}

const BOB_AMPLITUDE_M = 0.012
const BOB_SPEED       = 1.6
const POP_MS          = 700
const POP_SCALE       = 0.45   // extra scale at the peak of a streak-up pop
const plates = new Map<string, Plate>()   // lowercased address → plate

function buildPlate(address: string, avatar: Entity): Plate {
  const root = engine.addEntity()
  // avatarId targets a specific player; without it AvatarAttach binds to the local player.
  AvatarAttach.create(root, {
    avatarId:      address,
    anchorPointId: AvatarAnchorPointType.AAPT_NAME_TAG,
  })

  const carrier = engine.addEntity()
  Transform.create(carrier, { parent: root, position: { x: 0, y: PLATE_Y, z: 0 } })
  // Y-AXIS ONLY (BM_Y), not BM_ALL — the default tilts with camera pitch, so the plate would
  // hang at an angle whenever the mobile camera looks down. Real nametags stay upright.
  Billboard.create(carrier, { billboardMode: BillboardMode.BM_Y })

  const pill = engine.addEntity()
  Transform.create(pill, { parent: carrier })
  MeshRenderer.setPlane(pill)

  const nameT = engine.addEntity()
  Transform.create(nameT, { parent: carrier, position: { x: 0, y: 0.062, z: Z_TEXT } })
  TextShape.create(nameT, {
    text: '', fontSize: NAME_FONT, textColor: Color4.White(),
    outlineColor: Color4.Black(), outlineWidth: 0.12,
  })

  const streakT = engine.addEntity()
  Transform.create(streakT, { parent: carrier, position: { x: 0, y: -0.075, z: Z_TEXT } })
  TextShape.create(streakT, {
    text: '', fontSize: STREAK_FONT, textColor: Color4.White(),
    outlineColor: Color4.Black(), outlineWidth: 0.12,
  })

  // Flair icon: same glyph set + tints as the boards and the "Watered by" labels (config flairIcon). A plane just in front of the pill.
  const flair = engine.addEntity()
  Transform.create(flair, { parent: carrier, position: { x: 0, y: 0, z: Z_FLAIR }, scale: { x: 0, y: 0, z: 0 } })
  MeshRenderer.setPlane(flair)

  return {
    root, carrier, pill, nameT, streakT, avatar, flair, tier: 0,
    key: '', fade: -1, scale: 1, streak: -1, popMs: -1,
    bob: Math.random() * Math.PI * 2,
  }
}

function destroyPlate(p: Plate): void {
  for (const e of [p.pill, p.nameT, p.streakT, p.flair, p.carrier, p.root]) engine.removeEntity(e)
}

/** Pill paint — rounded shape from the texture's alpha over a flat dark base. No emissive:
 *  a coloured glow washed the text out on CTC's version too. `alphaTexture` is set
 *  explicitly — without it the quad's transparent region still shades and reads as a
 *  rectangle. */
function paintPill(p: Plate, fade: number): void {
  const tex = Material.Texture.Common({ src: PILL_TEX })
  Material.setPbrMaterial(p.pill, {
    texture:           tex,
    alphaTexture:      tex,
    albedoColor:       Color4.create(0, 0, 0, fade),
    emissiveColor:     Color3.Black(),
    emissiveIntensity: 0,
    // ALPHA TEST, not blend (KJ 2026-10-02: the flair icon flickered against the pill, worst from above and when the camera turns). Blended
    // quads are drawn back-to-front by distance to their CENTRES, and the icon sits off-centre, so which of the two drew last flipped with the
    // camera angle — and from the top no z offset helps. A cut-out pill writes depth and is drawn first; the icon and text, 7 and 14 cm in
    // front of it, are then depth-tested against it every time. The pill drops out once `fade` falls under the cutoff (about 17 m).
    transparencyMode:  MaterialTransparencyMode.MTM_ALPHA_TEST,
    alphaTest:         0.5,
    specularIntensity: 0,
    metallic:  0,
    roughness: 1,
  })
}

const FLAIR_SIZE = 0.26   // plate units: a little taller than the pill so the glyph reads
/** Paint the flair icon at `fade` alpha (the same fade the pill and text follow). */
function paintFlair(p: Plate, fade: number): void {
  const f = flairIcon(p.tier)
  if (!f) return
  const tex = Material.Texture.Common({ src: f.src })
  Material.setPbrMaterial(p.flair, {
    texture: tex, alphaTexture: tex,
    albedoColor: Color4.create(f.tint.r, f.tint.g, f.tint.b, fade), emissiveColor: Color3.create(f.tint.r, f.tint.g, f.tint.b), emissiveIntensity: 0.9,
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND, castShadows: false,
  })
}

/** Applies name/streak text + pill width. Only called when the content changes. */
function renderPlate(p: Plate, info: StreakInfo): void {
  p.fade = -1   // force a repaint so the pill's size/alpha catch up
  const nt = TextShape.getMutable(p.nameT)
  nt.text = info.name
  const label = info.streak > 0 ? `${info.streak} STREAK` : ''
  // KJ 2026-09-30: the name sat too high and poked out of its pill. Name-only: dead centre. With a streak: name a little
  // lower than before and the streak line tucked under it, inside the taller pill.
  // A flair icon gets its own slot INSIDE the plate (KJ 2026-09-30: it hung off the left edge): the pill grows by the slot's width and the
  // text centres in what is left, so name and icon sit together in one plate.
  const hasFlair = flairIcon(info.tier) !== null
  const fsz = label ? FLAIR_SIZE : FLAIR_SIZE * 0.68   // a name-only pill is shorter, so its icon is too — it has to fit INSIDE the plate
  const slot = hasFlair ? fsz + 0.05 : 0
  Transform.getMutable(p.nameT).position   = { x: slot / 2, y: label ? 0.05 : -0.004, z: Z_TEXT }
  Transform.getMutable(p.streakT).position = { x: slot / 2, y: -0.085, z: Z_TEXT }
  const st = TextShape.getMutable(p.streakT)
  st.text = label
  st.textColor = STREAK_COLOR

  // Y is divided by the band fraction because the stadium only occupies the middle
  // quarter of the texture; the rest is transparent padding. No streak → a shorter,
  // name-only pill, same as CTC's title-less case.
  const chars = Math.max(info.name.length, Math.round(label.length * 1.15))
  const pillW = PILL_PER_CHAR * chars + PILL_PAD + slot
  p.tier = info.tier
  // The icon sits in the slot at the pill's left end, vertically on the name line.
  Transform.getMutable(p.flair).position = { x: -pillW / 2 + slot / 2 + 0.025, y: label ? 0.05 : -0.004, z: Z_FLAIR }
  Transform.getMutable(p.flair).scale = hasFlair ? { x: fsz, y: fsz, z: 1 } : { x: 0, y: 0, z: 0 }
  Transform.getMutable(p.pill).scale = {
    x: pillW,
    y: (label ? PILL_H : PILL_H * 0.6) / PILL_BAND,
    z: 1,
  }
}

/** Distance-compensated scale + range fade, per plate (each has its own owner). */
function applyDistance(p: Plate): void {
  const cam = Transform.getOrNull(engine.CameraEntity)?.position
  const pos = Transform.getOrNull(p.avatar)?.position
  if (!cam || !pos) return
  const dx = cam.x - pos.x, dy = cam.y - (pos.y + 2), dz = cam.z - pos.z
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)

  // Stored, not applied: the per-frame animator combines it with the float and any
  // streak-up pop so the two can't fight over the transform.
  p.scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, dist / REF_DIST_M))

  const fade = dist <= FADE_START_M
    ? 1
    : Math.max(0, 1 - (dist - FADE_START_M) / (FADE_END_M - FADE_START_M))
  if (Math.abs(fade - p.fade) <= 0.03) return
  p.fade = fade

  paintPill(p, fade)
  paintFlair(p, fade)
  const nt = TextShape.getMutable(p.nameT)
  nt.textColor    = Color4.create(1, 1, 1, fade)
  nt.outlineColor = Color4.create(0, 0, 0, fade)
  // The outline must fade with the text. It used to stay opaque, so at range the streak line
  // faded to nothing but its black outline — "black like emoji" text (KJ 2026-09-29).
  const c = STREAK_COLOR
  const stt = TextShape.getMutable(p.streakT)
  stt.textColor    = Color4.create(c.r, c.g, c.b, fade)
  stt.outlineColor = Color4.create(0, 0, 0, fade)
}

/** Hides the explorer's own nametags across the whole scene, so our plates replace them
 *  rather than stacking under them. Sized to the full parcel footprint (scene.json: x
 *  [-5,5], z [-5,7], 16 m/parcel) with margin — generous on purpose, since a gap would
 *  leave a corner of the garden with double or missing nametags, and the docs warn the
 *  real tag reappears if a player's head leaves the area even briefly. */
function initNametagHideArea(): void {
  const area = engine.addEntity()
  Transform.create(area, { position: Vector3.create(8, 20, 24) })
  AvatarModifierArea.create(area, {
    area:       Vector3.create(200, 60, 230),
    modifiers:  [AvatarModifierType.AMT_HIDE_NAMETAGS],
    excludeIds: [],
  })
}

/** Per-frame plate animation: a gentle float, plus a springy pop when a streak goes up.
 *  Kept separate from the 0.4 s reconcile loop so motion stays smooth. */
function animatePlates(dt: number): void {
  for (const [, p] of plates) {
    p.bob += dt * BOB_SPEED
    let scale = p.scale

    if (p.popMs >= 0) {
      p.popMs += dt * 1000
      const t = Math.min(1, p.popMs / POP_MS)
      scale += POP_SCALE * Math.sin(t * Math.PI) * (1 - t * 0.35)
      if (t >= 1) p.popMs = -1
    }

    const ct = Transform.getMutableOrNull(p.carrier)
    if (!ct) continue
    ct.scale    = { x: scale, y: scale, z: scale }
    ct.position = { x: 0, y: PLATE_Y + Math.sin(p.bob) * BOB_AMPLITUDE_M, z: 0 }
  }
}

export function setupWaterStreakBadges(): void {
  initNametagHideArea()
  engine.addSystem(animatePlates)

  room.onMessage('streakUpdate', (data) => {
    streaks.set(data.address.toLowerCase(), { name: data.name, streak: data.streak, tier: data.tier ?? 0 })
  })

  let acc = 0
  engine.addSystem((dt: number) => {
    acc += dt
    if (acc < 0.4) return   // streak changes are per-water, not per-frame
    acc = 0

    // Reconcile plates against who is actually in the scene.
    const present = new Set<string>()
    for (const [avatar, data] of engine.getEntitiesWith(PlayerIdentityData)) {
      const key = data.address.toLowerCase()
      present.add(key)

      let plate = plates.get(key)
      if (!plate) {
        plate = buildPlate(data.address, avatar)
        plates.set(key, plate)
      }

      // No streak entry yet (broadcast in flight, or they haven't watered this
      // connection) → show the name alone rather than leaving a player anonymous
      // behind a hidden nametag. PlayerIdentityData carries no display name, so the
      // stand-in is a short address, replaced the moment a streakUpdate lands.
      const info = streaks.get(key) ?? { name: `${data.address.slice(0, 6)}…`, streak: 0, tier: 0 }
      const contentKey = `${info.name}|${info.streak}|${info.tier}`
      if (contentKey !== plate.key) {
        // A streak that went UP is worth celebrating on the plate; a reset to 0 isn't.
        if (plate.streak >= 0 && info.streak > plate.streak) plate.popMs = 0
        plate.streak = info.streak
        plate.key    = contentKey
        renderPlate(plate, info)
      }
      applyDistance(plate)
    }

    for (const [key, plate] of plates) {
      if (present.has(key)) continue
      destroyPlate(plate)
      plates.delete(key)
    }
  })
}
