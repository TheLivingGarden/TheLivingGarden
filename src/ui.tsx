// =============================================================
// The Living Garden — Screen UI  (HUD pass 2026-09-17, KJ-approved design)
//
// At rest the HUD is two things at TOP RIGHT: a health ring and, once you hold
// seeds, a seed chip under it. A banner opens at TOP CENTRE only when something
// changes (threshold crossed, countdown, bloom, gardeners joining/leaving, or a
// tap on the ring) and fades away again. Toasts and pills stack UNDER the banner.
// Nothing lives in the bottom half: on phones the client owns both bottom corners
// and the top left; on desktop it owns the left edge — top right and top centre
// are the only zones free on both.
//
// Sizes are fractions of screen height (U = virtualHeight / 1080) so the look
// does not depend on how a client reports its canvas. Mobile adds M (chrome) and
// F (text). Motion is ALPHA ONLY — size/position tweens jitter on the phone.
// =============================================================

import ReactEcs, { ReactEcsRenderer, UiEntity, Label } from '@dcl/sdk/react-ecs'
import { TestPanelUi } from './testPanel'
import { readCanvasInfo, getSafeArea, getScreenInsets, pct } from './safeArea'
import { isMobile } from '@dcl/sdk/platform'
import { Color4 } from '@dcl/sdk/math'
import { engine, timers } from '@dcl/sdk/ecs'
import { getPouch } from './playerInventory'
import { startFpsMeter, getFps, getTestPotCount } from './potStressTest'
import { SeedMenuUi, toggleSeedMenu, isSeedMenuOpen } from './seedMenu'
import { BloomFinaleUi, isBloomFinaleShowing } from './bloomFinale'
import { DiscoveryCardUi, MilestoneCardUi, isDiscoveryShowing } from './discoveryCard'
import { HoldMeterUi } from './skillCheck'
import { InfoPanelUi, toggleInfo, isInfoOpen } from './infoPanel'
import { AvenueCardUi, isAvenueCardOpen } from './avenueCard'
import { DigitLabUi } from './digitLab'
import { HitchHudUi } from './hitchHud'
import { FlowerInspectorUi, isFlowerInspectorOpen } from './flowerInspector'
import { TOTAL_PLANTS, BLOOM_THRESHOLD, WATERED_EXPIRY_MS, BLOOM_RESET_DELAY_MS, decayFactor, SHOW_DEV_OVERLAY } from './shared/config'

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------

let toastVisible  = false
let toastText     = ''
let toastColor: { r: number; g: number; b: number } | null = null   // e.g. the rarity colour of a gathered seed
let toastGen      = 0

let dailyLimitVisible = false
let dailyLimitText    = ''

let persistVisible = false
let persistText    = ''

type BannerState = 'idle' | 'countdown' | 'bloom'
let bannerState:    BannerState = 'idle'
let bannerCountdown = ''   // e.g. "42s" — kept current by the watering system's ticker
let bannerBloomLabel = ''  // variant / scale-aware bloom headline
let bannerBloomSub   = ''  // optional second line (rare variants say what is special, instead of a separate toast)
let bannerHealth    = 0    // 0–1
let playerCount     = 0
let luckPercent     = 0    // 2026-09-28: how much rarer the next Bloom's seeds roll right now

let bloomRemainingLabel = ''   // ring text during a bloom
let bloomRemainingFrac  = 1    // ring sweep during a bloom (1 → 0)
let shownHealth   = 0          // eased toward bannerHealth so the ring sweeps instead of jumping
let lastRenderAt  = 0

// The banner is PULL-ONLY now (KJ 2026-09-29, "clear and concise"): tapping the health ring toggles it.
// It still opens by itself for the two moments that matter — the 80% countdown and the Bloom. A band
// crossing or a gardener joining/leaving used to pop it open; they now just nudge the ring (one soft
// gold pulse, alpha only) and the player chooses whether to read the detail.
const BANNER_OPEN_MS  = 6_000
const BANNER_BLOOM_MS = 12_000
const FADE_MS         = 180
let bannerOpenUntil = 0
let bannerWasOpen   = false
let bannerFlipAt    = 0
let healthBand      = -1

function openBanner(ms = BANNER_OPEN_MS): void {
  bannerOpenUntil = Math.max(bannerOpenUntil, Date.now() + ms)
}

// Ring nudge — "something changed, tap me". Alpha-only, no size tween (phone jitter).
const NUDGE_MS = 1_800
let ringNudgeAt = 0
function nudgeRing(): void { ringNudgeAt = Date.now() }
// "tap" cue under the ring until the first tap (or the first minute of the session).
const RING_HINT_MS = 60_000
const sessionStart = Date.now()
let ringTapped = false
let ringTaps = 0
/** The banner is open because the player tapped the ring — the one case it shows during the tutorial. */
let bannerTapped = false
/** How many times the health ring has been tapped this session — the tutorial's "tap the ring" step watches it rise. */
export function getRingTaps(): number { return ringTaps }
/** Make the ring breathe (its gold "something changed" outline) — the tutorial calls this while it is pointing at the ring. */
export function pulseRing(): void { nudgeRing() }
function onRingTap(): void {
  ringTapped = true
  ringTaps++
  // Countdown / bloom hold the banner open on their own; tapping only toggles the resting states.
  if (bannerState === 'idle' && bannerIsOpen(Date.now())) { bannerOpenUntil = 0; bannerTapped = false }
  else { openBanner(); bannerTapped = true }
}

// ---------------------------------------------------------------
// Public API — toasts and pills (stacked under the banner)
// ---------------------------------------------------------------

/** @param color optional text colour (e.g. a seed's rarity colour); default cream */
export function showToast(text: string, durationMs: number, _large = false, color?: { r: number; g: number; b: number }): void {
  toastText    = text.length > 120 ? `${text.slice(0, 119)}…` : text   // hard cap; the pill wraps up to 3 lines below
  toastColor   = color ?? null
  toastVisible = true
  const gen    = ++toastGen
  timers.setTimeout(() => { if (toastGen === gen) toastVisible = false }, durationMs)
}

// A big centre-screen line for the one thing the player must not miss (e.g. seeds falling).
// Alpha fade only — size tweens jitter on the phone.
let momentTitle = '', momentSub = '', momentStart = 0, momentLife = 0
/** The centre line owns the screen while it is up: the top pill (idle guide / tutorial hint)
 *  and the banner sub-line would otherwise say the same thing a second time. */
const momentActive = () => momentLife > 0 && Date.now() - momentStart < momentLife
export function showMoment(title: string, sub: string, ms: number): void {
  momentTitle = title; momentSub = sub; momentStart = Date.now(); momentLife = ms
}

// Tutorial card — centre screen, like the bloom line (KJ 2026-09-27: nobody noticed the top
// pill). onboarding.ts owns the flow and the button handlers; this only draws what it is given.
/** `celebrate` = the short success beat after a step is done: green title, no buttons. */
export interface CoachCard { step: number; of: number; title: string; body: string; primary?: string; skip?: boolean; celebrate?: boolean }
export interface CoachActions { close: () => void; skip: () => void; end: () => void; primary: () => void; tutorial: () => void }
let coach: CoachCard | null = null
let coachActions: CoachActions | null = null
export function setCoach(card: CoachCard | null): void { coach = card }
export function registerCoachActions(actions: CoachActions): void { coachActions = actions }
/** While the tutorial runs the "This bloom" summary stays hidden (KJ 2026-09-27: distracting). */
let tutorialActive = false
export function setTutorialActive(on: boolean): void { tutorialActive = on }
export function isTutorialActive(): boolean { return tutorialActive }
/** The card gives way to the bloom line and the "This bloom" summary (they share its spot), and to
 *  any card or menu the player opened — the Avenue card sat on top of it (KJ 2026-09-27). */
// The finale card is never drawn while the tutorial runs (it is not mounted, see the render), so it must not hide the tutorial card either:
// it used to, and the card vanished when a bloom ended and came back when the finale's timer ran out (KJ 2026-09-30).
const coachUp = (): boolean => coach !== null && !momentActive() && (!isBloomFinaleShowing() || tutorialActive)
  && !isAvenueCardOpen() && !isFlowerInspectorOpen() && !isSeedMenuOpen() && !isInfoOpen() && !isDiscoveryShowing()

export function showDailyLimit(text: string): void {
  dailyLimitText    = text
  dailyLimitVisible = true
}
export function hideDailyLimit(): void { dailyLimitVisible = false }

export function showPersistent(text: string): void {
  persistText    = text
  persistVisible = true
}
export function hidePersistent(): void { persistVisible = false }

// ---------------------------------------------------------------
// Public API — banner, ring, seed chip
// ---------------------------------------------------------------

export function showBannerIdle(): void {
  if (bannerState !== 'idle') nudgeRing()
  bannerState = 'idle'
}
export function showBannerBloom(label = '', sub = ''): void {
  bannerBloomLabel = label
  bannerBloomSub   = sub
  bannerState = 'bloom'
  bloomRemainingFrac = 1
  bloomRemainingLabel = ''
  openBanner(BANNER_BLOOM_MS)
}
export function showBannerCountdown(countdown: string): void {
  bannerState     = 'countdown'   // stays open for the whole countdown (see bannerIsOpen)
  bannerCountdown = countdown
}
export function updateBannerCountdown(countdown: string): void {
  bannerCountdown = countdown
}

/** Garden health 0–1. Crossing the 50% / 80% lines opens the banner. */
export function updateBannerHealth(ratio: number): void {
  bannerHealth = Math.max(0, Math.min(1, ratio))
  const band = bannerHealth >= 0.8 ? 2 : bannerHealth >= 0.5 ? 1 : 0
  if (healthBand !== -1 && band !== healthBand) nudgeRing()
  healthBand = band
}

/** Gardeners present — a change matters now (it sets how fast plants dry), so say so. */
export function updatePlayerCount(n: number): void {
  if (n !== playerCount && playerCount !== 0) nudgeRing()
  playerCount = n
}

/** How much rarer the next Bloom's seeds roll right now (gardeners + Gallery), as a
 *  whole-number percent over solo-with-an-empty-Gallery. No banner-reopen on change (2026-09-28):
 *  unlike the gardener count, a Gallery-driven change isn't urgent enough to interrupt. */
export function updateLuckPercent(n: number): void { luckPercent = n }
/** The live Luck boost, for other surfaces that name it (the seed-drop moment). */
export function getLuckPercent(): number { return luckPercent }

/** During a bloom the ring shows time left (wateringSystem's reset ticker pushes it). */
export function updateBloomRemaining(label: string, remainingMs: number, totalMs = BLOOM_RESET_DELAY_MS): void {
  bloomRemainingLabel = label
  bloomRemainingFrac  = Math.max(0, Math.min(1, remainingMs / totalMs))   // blooms vary in length (contributors)
}

// ---------------------------------------------------------------
// Look
// ---------------------------------------------------------------

const UI_DIR = 'assets/scene/Images/ui/'
const DARK   = { r: 0.07, g: 0.063, b: 0.055, a: 0.86 }
const CREAM  = { r: 0.957, g: 0.918, b: 0.824 }
const DIM    = { r: 0.83,  g: 0.82,  b: 0.78 }
const GOLD   = { r: 0.98,  g: 0.78,  b: 0.46 }
const MOON   = { r: 0.81,  g: 0.88,  b: 1.0 }
const TRACK  = { r: 1, g: 1, b: 1, a: 0.18 }
const BAR_RED    = { r: 0.89, g: 0.29, b: 0.29 }
const BAR_ORANGE = { r: 0.94, g: 0.62, b: 0.15 }
const BAR_GREEN  = { r: 0.36, g: 0.79, b: 0.48 }
const TINT_WATER = { r: 0.52, g: 0.72, b: 0.92 }
const TINT_SEED  = { r: 0.62, g: 0.88, b: 0.80 }

// 1080-units (× U × M at render)
const RING_SIZE  = 132
const RING_FONT  = 30
// Sized up ~1.6x on 2026-09-21: Fin did not notice the chip at the old 46, and it is the
// only way into the seeds and the whole flower collection. KJ kept it bottom centre.
const CHIP_H     = 72
const CHIP_FONT  = 30
const CHIP_GLYPH = 40
const BANNER_W   = 680
const BANNER_PAD = 18
const TITLE_FONT = 22
const SUB_FONT   = 16
const BAR_H      = 12
const PILL_H     = 52
const PILL_FONT  = 20
const PILL_PAD_X = 26
const GAP        = 10
const EDGE       = 16          // gap from the safe-area edge

function barColor(): { r: number; g: number; b: number } {
  return bannerHealth >= 0.8 ? BAR_GREEN : bannerHealth >= 0.5 ? BAR_ORANGE : BAR_RED
}
// Ring sprites: ONE sprite sheet (ring_sheet.png, 1024², 8×8 cells of 128 px — downsized from 2048² on 2026-09-29) holding all 41 health
// frames then all 21 bloom frames, packed from the original ring_NN / ringbloom_NN PNGs
// (2026-09-19, originals kept). The ring shows a frame by moving its UV window, so the texture
// never changes — changing an element's texture made the client rebuild its background (a
// blank-frame flash), which is why frames used to be STACKED and toggled by alpha. Stacking
// cost one scene texture per frame (17 after the every-4th-frame cut) against a 71-texture
// scene limit, and is the prime suspect for the desktop white-square ring. Now: 1 texture,
// every frame back (the stride cut is gone).
const RING_STEPS   = 40
const BLOOM_STEPS  = 20
const RING_FRAME_COUNT  = RING_STEPS  + 1   // 41 frames: 0…40
const BLOOM_FRAME_COUNT = BLOOM_STEPS + 1   // 21 frames: 0…20
const RING_SHEET      = `${UI_DIR}ring_sheet.png`
const RING_SHEET_COLS = 8                    // 8×8 grid, frames in reading order from the top-left
const RING_TEXEL      = 0.5 / 1024           // half-texel inset so neighbouring cells never bleed in (sheet is 1024², 128 px cells — was 2048², KJ 2026-09-29: far bigger than the ~132 px ring needs)
/** UVs of one sheet cell, bottom-left vertex clockwise (PBUiBackground.uvs order). */
function ringUvs(i: number): number[] {
  const col = i % RING_SHEET_COLS, row = Math.floor(i / RING_SHEET_COLS), k = 1 / RING_SHEET_COLS
  const u0 = col * k + RING_TEXEL, u1 = (col + 1) * k - RING_TEXEL
  const v1 = 1 - row * k - RING_TEXEL, v0 = 1 - (row + 1) * k + RING_TEXEL
  return [u0, v0, u0, v1, u1, v1, u1, v0]
}
/** Sheet index of the frame to show. */
function ringIndex(): number {
  const clamp = (v: number) => Math.max(0, Math.min(1, v))
  return bannerState === 'bloom'
    ? RING_FRAME_COUNT + Math.round(clamp(bloomRemainingFrac) * (BLOOM_FRAME_COUNT - 1))
    : Math.round(clamp(shownHealth) * (RING_FRAME_COUNT - 1))
}
function toastGlyph(text: string): { src: string; tint: { r: number; g: number; b: number } } {
  const t = text.toLowerCase()
  if (t.includes('gave') || t.includes('gift')) return { src: `${UI_DIR}glyph_gift.png`, tint: GOLD }
  if (t.includes('seed') || t.includes('plant') && !t.includes('watered')) return { src: `${UI_DIR}glyph_seed.png`, tint: TINT_SEED }
  if (t.includes('water')) return { src: `${UI_DIR}glyph_drop.png`, tint: TINT_WATER }
  return { src: `${UI_DIR}glyph_leaf.png`, tint: TINT_SEED }
}
function bannerIsOpen(now: number): boolean {
  return bannerState === 'countdown' || now < bannerOpenUntil
}
function dryMinutes(): string {
  const mins = (WATERED_EXPIRY_MS * decayFactor(Math.max(1, playerCount))) / 60_000
  return Number.isInteger(mins) ? `${mins}` : mins.toFixed(1)
}

// ── Virtual canvas (ported from Clean The Club) ─────────────────────────────
// SDK 7.26 (upgraded 2026-09-17 to the Clean The Club pin — scene UI did not
// render at all on the mobile app under 7.21): the renderer scales by
// min(canvasW / virtualW, canvasH / virtualH) with NO pixel-ratio term, and the
// canvas is reported in physical px. So px values map to screenH / virtualH:
// 2160 keeps the garden's 1080-tuned desktop look on KJ's retina iMac (dpr 2);
// 1440 is CTC's tuned mobile value ("720 × dpr", 720 was 2–3× too big).
// Width is flexed to the real screen aspect so a fit-to-height letterbox
// never left-anchors "centred" content. screenInset is 'none' (as in Clean The
// Club): 'interactable' centres the HUD inside the joystick-free rectangle, i.e.
// well RIGHT of the physical centre on phones — we inset ourselves instead, with
// a horizontally balanced device-inset container (see the root below).
// Calibrate with the top-left canvas line (the phone has a console under >_).
const DESKTOP_VIRTUAL_H = 1080    // HUD sizes are fractions of screen height (U), so this only sets the scale of
                                  // legacy fixed-px UI (the dev test panel, designed at 1080). 2160 made it microscopic.
const MOBILE_VIRTUAL_H  = 1080    // TUNING — lower = bigger HUD on phones (1440 read too small)
let currentVirtualH = DESKTOP_VIRTUAL_H
let currentVirtualW = Math.round(DESKTOP_VIRTUAL_H * 16 / 9)
let loggedCanvasCalib = false

export function getCanvasCalibration(): string {
  const c  = readCanvasInfo()
  const sa = getSafeArea()
  return `${isMobile() ? 'mobile' : 'desktop'} canvas ${c ? `${c.width}x${c.height} dpr=${c.devicePixelRatio}` : '?'} -> virtual ${currentVirtualW}x${currentVirtualH} | safe ${sa.known ? 'live' : 'fallback'} t${pct(sa.top)} b${pct(sa.bottom)} l${pct(sa.left)} r${pct(sa.right)}`
}

/** Engine system (NOT called from the render — re-entering setUiRenderer mid-render
 *  can unmount the whole tree): re-fits the virtual canvas when platform / aspect /
 *  dpr change. isMobile() flips from false once the platform round-trip lands. */
let fitAccum = 0
function fitVirtualCanvasSystem(dt: number): void {
  fitAccum += dt
  if (fitAccum < 0.25) return
  fitAccum = 0
  const c = readCanvasInfo()
  if (!c) return
  const vh     = isMobile() ? MOBILE_VIRTUAL_H : DESKTOP_VIRTUAL_H
  const aspect = c.width / c.height
  const vw     = Math.round(vh * Math.max(1, Math.min(10 / 3, aspect)))
  if (!loggedCanvasCalib) { loggedCanvasCalib = true; console.log(`[UI] ${getCanvasCalibration()}`) }
  if (vh !== currentVirtualH || Math.abs(vw - currentVirtualW) >= 8) {
    currentVirtualH = vh
    currentVirtualW = vw
    ReactEcsRenderer.setUiRenderer(uiComponent, { virtualWidth: currentVirtualW, virtualHeight: currentVirtualH, screenInset: 'none' })
    console.log(`[UI] virtual canvas -> ${currentVirtualW}x${currentVirtualH}`)
  }
}

export function setupUi(): void {
  ReactEcsRenderer.setUiRenderer(uiComponent, { virtualWidth: currentVirtualW, virtualHeight: currentVirtualH, screenInset: 'none' })
  engine.addSystem(fitVirtualCanvasSystem)
  startFpsMeter()   // dev: frame rate in the bottom calibration line (remove with the test panel)
}

// ---------------------------------------------------------------
// Render
// ---------------------------------------------------------------

function uiComponent() {
  const sa     = getSafeArea()
  const ins    = getScreenInsets()
  const hIns   = Math.max(ins.left, ins.right)   // balanced → centre stays the physical centre
  const mobile = isMobile()
  const U  = currentVirtualH / 1080              // size as a fraction of screen height
  const M  = mobile ? 1.3 : 1                    // touch targets + small screens want larger chrome
  const F  = mobile ? 1.5 : 1                    // …and larger text
  const px = (n: number): number => Math.round(n * U * M)
  const fs = (n: number): number => Math.round(n * U * F)
  const now = Date.now()

  // ease the ring toward the real health (frame-rate independent; snaps when close)
  const dt = lastRenderAt ? Math.min(0.1, (now - lastRenderAt) / 1000) : 0
  lastRenderAt = now
  shownHealth += (bannerHealth - shownHealth) * Math.min(1, dt * 5)
  if (Math.abs(bannerHealth - shownHealth) < 0.002) shownHealth = bannerHealth

  // banner fade (alpha only) — hidden while the tutorial card is up (2026-09-28: the two
  // competed for the top of the screen); reuses the same fade so it doesn't just pop.
  // A banner the player asked for (a ring tap) does show: the tutorial's ring step is exactly that.
  if (!bannerIsOpen(now)) bannerTapped = false
  const open = bannerIsOpen(now) && (!tutorialActive || bannerTapped)
  if (open !== bannerWasOpen) { bannerWasOpen = open; bannerFlipAt = now }
  const t = Math.min(1, (now - bannerFlipAt) / FADE_MS)
  const a = open ? t : 1 - t
  const bannerShown = a > 0.02

  // The container below is already inset by the device insets, so measure the client's
  // safe area RELATIVE to it (max, not sum) — summing pushed the phone's ring 14% in.
  const topPx      = Math.round(Math.max(0, sa.top - ins.top) * currentVirtualH) + px(EDGE)
  const rightPct   = Math.max(0, sa.right - hIns) + (mobile ? 0.012 : 0.035)   // desktop: clear the client's edge icons
  const frame      = ringIndex()
  const pouch      = getPouch()
  const seedCount  = pouch.reduce((a, b) => a + b, 0)
  const seedRare   = seedCount - (pouch[0] ?? 0)   // anything above Common
  const isBloom    = bannerState === 'bloom'
  const isCount    = bannerState === 'countdown'
  // 122 + ~24 (2026-09-28: the luck row added a 4th line, hidden only during a bloom).
  const bannerH    = px(isBloom ? 96 : 146)
  const ringSize   = px(RING_SIZE)
  const hintH      = fs(20)
  const showHint   = !ringTapped && now - sessionStart < RING_HINT_MS && !bannerShown
  const nudgeT     = Math.max(0, 1 - (now - ringNudgeAt) / NUDGE_MS)
  const nudgeA     = nudgeT * (0.5 + 0.5 * Math.cos((1 - nudgeT) * Math.PI * 4))   // two soft pulses, fading
  // Seed chip sits BOTTOM CENTRE (KJ 2026-09-20), like an inventory bar. Anchored on the
  // MEASURED bottom inset rather than a fixed offset, so it rides above whatever the
  // client owns down there — the phone's joystick and interaction cluster included.
  // Measured relative to the device-inset container, same as topPx: summing the two
  // pushed the phone's ring 14% in.
  const bottomPx   = Math.round(Math.max(0, sa.bottom - ins.bottom) * currentVirtualH) + px(EDGE)
  const gardeners  = Math.max(1, playerCount)
  const watered    = Math.round(bannerHealth * TOTAL_PLANTS)
  const need       = Math.max(0, BLOOM_THRESHOLD - watered)
  const pctLabel   = `${Math.round(bannerHealth * 100)}%`
  const ringLabel  = isBloom ? (bloomRemainingLabel || pctLabel) : pctLabel

  const title = isBloom ? (bannerBloomLabel || 'The Garden is in Full Bloom!')
              : isCount ? `Hold 80% for ${bannerCountdown} to wake the bloom`
              : 'Garden health'
  const sub   = isBloom ? (bannerBloomSub || 'The Bloom is open - seeds drift down over the next few minutes')
              : isCount ? `${pctLabel} - ${gardeners} gardener${gardeners === 1 ? '' : 's'} here, plants dry in ${dryMinutes()} min`
              : need > 0 ? `${pctLabel} - ${need} more plant${need === 1 ? '' : 's'} to wake the bloom`
              : `${pctLabel} - hold it to wake the bloom`
  const titleColor = isBloom ? MOON : isCount ? GOLD : CREAM

  // stack under the banner: toast → daily limit → persistent
  let stackY = topPx + (bannerShown ? bannerH + px(GAP) : 0)
  // A toast wraps onto up to 3 lines instead of running off (KJ 2026-09-29: "shorten the text and let it wrap"). A wrapped Label
  // needs an EXPLICIT height here (a heightless one collapses on the phone), so estimate the line count from the length
  // (~0.55 em per character, same as the tutorial card) and size the pill to match.
  const toastMaxW   = px(720)
  const toastCpl    = Math.max(12, Math.floor(toastMaxW / (fs(PILL_FONT) * 0.55)))
  const toastLines  = Math.min(3, Math.max(1, Math.ceil(toastText.length / toastCpl)))
  const toastLabelH = toastLines * Math.round(fs(PILL_FONT) * 1.3)
  const toastH      = toastLines > 1 ? Math.max(px(PILL_H), toastLabelH + px(16)) : px(PILL_H)
  const toastY = stackY;   if (toastVisible)      stackY += toastH + px(GAP)
  const dailyY = stackY;   if (dailyLimitVisible) stackY += px(PILL_H) + px(GAP)
  const persistY = stackY
  const glyph = toastGlyph(toastText)
  const dismiss = px(PILL_H)

  // Root MUST be full-screen: the mobile (Godot) client clips children to the
  // parent's box, so a size-less root hides every absolute child. Inside it, a
  // horizontally BALANCED device-inset container keeps "centre" the physical centre.
  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%' }}>
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: pct(ins.top), left: pct(hIns), right: pct(hIns), bottom: pct(ins.bottom) } }}>

      {/* ── Test Panel — MOUNTED for v2 dev; comment out before production deploys ── */}
      <TestPanelUi />
      <DigitLabUi px={px} fs={fs} />
      {/* Glyph warm-up (KJ 2026-10-01: digits are sometimes drawn small and black for a moment — "emoji numbers" — then resolve). A guess: the explorer
          builds a glyph the first time it is drawn, and the first frame shows a placeholder. Every digit and the HUD's symbols are drawn here
          from the start, invisible (alpha 0.01), so the real labels find them ready. */}
      <Label value="0123456789 %:+-xX. STREAK ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz" fontSize={10} color={{ r: 1, g: 1, b: 1, a: 0.01 }} uiTransform={{ positionType: 'absolute', position: { left: 0, bottom: 0 }, width: 600, height: 12 }} />
      <HitchHudUi px={px} />
      {/* Dev calibration line — SHOW_DEV_OVERLAY, off by default (KJ 2026-09-21) */}
      <Label
        value={`${getFps()} fps${getTestPotCount() > 0 ? ` with ${getTestPotCount()} test planters` : ''} | ${getCanvasCalibration()}`}
        fontSize={fs(11)}
        color={{ r: 1, g: 1, b: 1, a: 0.7 }}
        uiTransform={{ display: SHOW_DEV_OVERLAY ? 'flex' : 'none', positionType: 'absolute', position: { left: '30%', bottom: 4 }, width: '40%', height: fs(16) }}
      />

      {/* ═════ HEALTH RING — top right, the resting HUD. Tap to open the banner. ═════ */}
      <UiEntity uiTransform={{ positionType: 'absolute', position: { top: topPx, right: pct(rightPct) }, width: ringSize, height: ringSize + hintH }}>
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: ringSize, height: ringSize }}
          uiBackground={{ textureMode: 'stretch', texture: { src: RING_SHEET }, uvs: ringUvs(frame) }}
        />
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: ringSize, height: ringSize, alignItems: 'center', justifyContent: 'center' }}
          onMouseDown={onRingTap}
        >
          <Label value={ringLabel} fontSize={fs(isBloom && bloomRemainingLabel ? RING_FONT - 6 : RING_FONT)} color={{ ...CREAM, a: 1 }} textAlign="middle-center" uiTransform={{ width: '100%', height: '100%' }} />
        </UiEntity>
        {/* nudge: a gold outline that breathes twice and fades — the ring's "something changed" */}
        <UiEntity uiTransform={{ display: nudgeA > 0.02 ? 'flex' : 'none', positionType: 'absolute', position: { top: 0, left: 0 }, width: ringSize, height: ringSize, borderRadius: Math.round(ringSize / 2), borderWidth: px(4), borderColor: { ...GOLD, a: nudgeA } }} />
        <Label value="tap" fontSize={fs(13)} color={{ ...CREAM, a: 0.6 }} textAlign="middle-center" textWrap="nowrap" uiTransform={{ display: showHint ? 'flex' : 'none', positionType: 'absolute', position: { top: ringSize, left: 0 }, width: ringSize, height: hintH }} />
      </UiEntity>

      {/* ═════ SEED CHIP — bottom centre, always there (dim when empty) so the menu and
          your flower collection are always one tap away ═════ */}
      <UiEntity uiTransform={{ positionType: 'absolute', position: { bottom: bottomPx, left: 0 }, width: '100%', flexDirection: 'row', justifyContent: 'center' }}>
      <UiEntity
        uiTransform={{
          height: px(CHIP_H), flexDirection: 'row', alignItems: 'center',
          padding: { left: px(20), right: px(22) }, borderRadius: px(CHIP_H / 2),
        }}
        uiBackground={{ color: isSeedMenuOpen() ? { r: 0.18, g: 0.49, b: 0.34, a: 0.95 } : DARK }}
        onMouseDown={() => toggleSeedMenu()}
      >
        <UiEntity uiTransform={{ width: px(CHIP_GLYPH), height: px(CHIP_GLYPH), margin: { right: px(12) } }} uiBackground={{ textureMode: 'stretch', texture: { src: `${UI_DIR}glyph_seed.png` }, color: { ...TINT_SEED, a: seedCount > 0 ? 1 : 0.5 } }} />
        {/* The count in an explicitly sized box, the same shape as the "?" beside it (KJ 2026-10-06: on some phones the number sat low in
            the chip while the "?" was centred). The only difference between the two was that this label had no width and a % height. */}
        <UiEntity uiTransform={{ width: Math.ceil(`${seedCount}`.length * fs(CHIP_FONT) * 0.62), height: px(CHIP_H), alignItems: 'center', justifyContent: 'center' }}>
          <Label value={`${seedCount}`} fontSize={fs(CHIP_FONT)} color={{ ...CREAM, a: seedCount > 0 ? 1 : 0.55 }} textAlign="middle-center" textWrap="nowrap" uiTransform={{ width: '100%', height: '100%' }} />
        </UiEntity>
        <UiEntity uiTransform={{ display: seedRare > 0 ? 'flex' : 'none', width: px(18), height: px(18), margin: { left: px(14) }, borderRadius: px(9) }} uiBackground={{ color: { ...GOLD, a: 1 } }} />
      </UiEntity>
      {/* ? — "how the garden works", beside the pouch so both live in one place */}
      <UiEntity
        uiTransform={{ width: px(CHIP_H), height: px(CHIP_H), margin: { left: px(GAP) }, alignItems: 'center', justifyContent: 'center', borderRadius: px(CHIP_H / 2) }}
        uiBackground={{ color: isInfoOpen() ? { r: 0.18, g: 0.49, b: 0.34, a: 0.95 } : DARK }}
        onMouseDown={() => { if (!isInfoOpen() && isSeedMenuOpen()) toggleSeedMenu(); toggleInfo() }}   // …and opening "?" closes the pouch
      >
        <Label value="?" fontSize={fs(CHIP_FONT)} color={{ ...CREAM, a: 0.9 }} textAlign="middle-center" uiTransform={{ width: '100%', height: '100%' }} />
      </UiEntity>
      </UiEntity>

      {/* ═════ BANNER — top centre, opens on change, alpha fade only ═════ */}
      <UiEntity uiTransform={{ display: bannerShown ? 'flex' : 'none', positionType: 'absolute', position: { top: topPx, left: 0 }, width: '100%', flexDirection: 'row', justifyContent: 'center' }}>
        <UiEntity
          uiTransform={{ width: px(BANNER_W), height: bannerH, flexDirection: 'column', justifyContent: 'center', padding: { left: px(BANNER_PAD + 4), right: px(BANNER_PAD + 4), top: px(BANNER_PAD - 4), bottom: px(BANNER_PAD - 4) }, borderRadius: px(22) }}
          uiBackground={{ color: { ...DARK, a: DARK.a * a } }}
        >
          <UiEntity uiTransform={{ width: '100%', height: fs(TITLE_FONT + 8), flexDirection: 'row', alignItems: 'center' }}>
            <Label value={title} fontSize={fs(TITLE_FONT)} color={{ ...titleColor, a }} textAlign="middle-left" textWrap="nowrap" uiTransform={{ flexGrow: 1, height: '100%' }} />
            <UiEntity uiTransform={{ display: isBloom ? 'none' : 'flex', flexDirection: 'row', alignItems: 'center', height: '100%' }}>
              <UiEntity uiTransform={{ width: fs(20), height: fs(20), margin: { right: px(6) } }} uiBackground={{ textureMode: 'stretch', texture: { src: `${UI_DIR}glyph_users.png` }, color: { ...DIM, a } }} />
              <Label value={`${gardeners}`} fontSize={fs(SUB_FONT + 2)} color={{ ...DIM, a }} textAlign="middle-center" uiTransform={{ height: '100%' }} />
            </UiEntity>
          </UiEntity>

          {/* bar + 80% marker (hidden during a bloom) */}
          <UiEntity uiTransform={{ display: isBloom ? 'none' : 'flex', width: '100%', height: px(BAR_H), margin: { top: px(8), bottom: px(8) }, borderRadius: px(BAR_H / 2) }} uiBackground={{ color: { ...TRACK, a: TRACK.a * a } }}>
            <UiEntity uiTransform={{ width: `${Math.round(bannerHealth * 100)}%`, height: '100%', borderRadius: px(BAR_H / 2) }} uiBackground={{ color: { ...barColor(), a } }} />
            <UiEntity uiTransform={{ positionType: 'absolute', position: { left: '80%', top: -px(4) }, width: Math.max(2, px(3)), height: px(BAR_H + 8) }} uiBackground={{ color: { ...GOLD, a } }} />
          </UiEntity>

          <Label value={sub} fontSize={fs(SUB_FONT)} color={{ ...DIM, a }} textAlign="middle-left" textWrap="nowrap" uiTransform={{ width: '100%', height: fs(SUB_FONT + 8) }} />

          {/* Luck (2026-09-28: "display bloom luck on screen... under the garden health
              meter"): how much rarer the NEXT bloom's seeds roll right now, from gardeners
              present and the Gallery's current boost — see currentLuckPercent server-side.
              Hidden during a bloom, same as the bar above — the roll for THIS bloom is
              already locked in by then. KJ asked for a shamrock icon; there's no such
              asset yet, so this is a plain dot until one exists. */}
          <UiEntity uiTransform={{ display: isBloom ? 'none' : 'flex', width: '100%', height: fs(SUB_FONT + 6), margin: { top: px(2) }, flexDirection: 'row', alignItems: 'center' }}>
            <UiEntity uiTransform={{ width: fs(12), height: fs(12), borderRadius: fs(6), margin: { right: px(6) } }} uiBackground={{ color: { ...BAR_GREEN, a } }} />
            <Label value={`Luck boost +${luckPercent}%`} fontSize={fs(SUB_FONT)} color={{ ...BAR_GREEN, a }} textAlign="middle-left" uiTransform={{ height: '100%' }} />
          </UiEntity>
        </UiEntity>
      </UiEntity>

      {/* ═════ TOAST — under the banner, where the eyes already are ═════ */}
      {/* While the tutorial card holds that spot, toasts drop to just above the seed chip */}
      <UiEntity uiTransform={{ display: toastVisible ? 'flex' : 'none', positionType: 'absolute', position: coachUp() ? { bottom: bottomPx + px(CHIP_H) + px(GAP), left: 0 } : { top: toastY, left: 0 }, width: '100%', flexDirection: 'row', justifyContent: 'center' }}>
        <UiEntity uiTransform={{ height: toastH, flexDirection: 'row', alignItems: 'center', padding: { left: px(PILL_PAD_X - 6), right: px(PILL_PAD_X) }, borderRadius: Math.min(px(PILL_H / 2), Math.round(toastH / 2)) }} uiBackground={{ color: DARK }}>
          <UiEntity uiTransform={{ width: px(26), height: px(26), margin: { right: px(10) }, flexShrink: 0 }} uiBackground={{ textureMode: 'stretch', texture: { src: glyph.src }, color: { ...glyph.tint, a: 1 } }} />
          <Label value={toastText} fontSize={fs(PILL_FONT)} color={{ ...(toastColor ?? CREAM), a: 1 }} textAlign="middle-center" textWrap={toastLines > 1 ? 'wrap' : 'nowrap'} uiTransform={toastLines > 1 ? { width: toastMaxW, height: toastLabelH } : { height: '100%' }} />
        </UiEntity>
      </UiEntity>

      {/* ═════ DAILY LIMIT — dismissible ═════ */}
      <UiEntity uiTransform={{ display: dailyLimitVisible ? 'flex' : 'none', positionType: 'absolute', position: { top: dailyY, left: 0 }, width: '100%', flexDirection: 'row', justifyContent: 'center' }}>
        <UiEntity uiTransform={{ height: px(PILL_H), flexDirection: 'row', alignItems: 'center', padding: { left: px(PILL_PAD_X) }, borderRadius: px(PILL_H / 2) }} uiBackground={{ color: DARK }}>
          <Label value={dailyLimitText} fontSize={fs(PILL_FONT - 2)} color={{ ...CREAM, a: 1 }} textAlign="middle-center" uiTransform={{ height: '100%' }} />
          <UiEntity uiTransform={{ width: dismiss, height: dismiss, alignItems: 'center', justifyContent: 'center' }} onMouseDown={hideDailyLimit}>
            <Label value="x" fontSize={fs(PILL_FONT)} color={{ ...DIM, a: 1 }} textAlign="middle-center" uiTransform={{ width: '100%', height: '100%' }} />
          </UiEntity>
        </UiEntity>
      </UiEntity>

      {/* ═════ PERSISTENT ═════ */}
      <UiEntity uiTransform={{ display: persistVisible && !momentActive() ? 'flex' : 'none', positionType: 'absolute', position: { top: persistY, left: 0 }, width: '100%', flexDirection: 'row', justifyContent: 'center' }}>
        <UiEntity uiTransform={{ height: px(PILL_H), flexDirection: 'row', alignItems: 'center', padding: { left: px(PILL_PAD_X), right: px(PILL_PAD_X) }, borderRadius: px(PILL_H / 2) }} uiBackground={{ color: DARK }}>
          <Label value={persistText} fontSize={fs(PILL_FONT - 2)} color={{ ...DIM, a: 1 }} textAlign="middle-center" uiTransform={{ height: '100%' }} />
        </UiEntity>
      </UiEntity>

      {(() => {
        const age = Date.now() - momentStart
        if (momentLife === 0 || age >= momentLife) return null
        const a = Math.min(1, age / 300, (momentLife - age) / 500)
        return (
          <UiEntity uiTransform={{ positionType: 'absolute', position: { top: '24%', left: 0 }, width: '100%', flexDirection: 'row', justifyContent: 'center' }}>
            <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center', padding: { left: px(36), right: px(36), top: px(18), bottom: px(20) }, borderRadius: px(26) }} uiBackground={{ color: { r: 0.07, g: 0.063, b: 0.055, a: 0.82 * a } }}>
              <Label value={momentTitle} fontSize={fs(mobile ? 30 : 34)} color={{ ...GOLD, a }} textAlign="middle-center" textWrap="nowrap" uiTransform={{ height: fs(mobile ? 42 : 46) }} />
              <Label value={momentSub} fontSize={fs(mobile ? 19 : 21)} color={{ ...CREAM, a }} textAlign="middle-center" textWrap="nowrap" uiTransform={{ height: fs(30), margin: { top: px(4) } }} />
            </UiEntity>
          </UiEntity>
        )
      })()}

      {/* ═════ TUTORIAL CARD — centre screen; gives way to the bloom line while that is up ═════ */}
      {coachUp() && coach && (() => {
        const c = coach
        // The body needs an EXPLICIT height: a heightless wrapped Label collapses to zero here, and
        // its lines spill over the title and the buttons (KJ 2026-09-27 phone screenshot). Estimate
        // the wrapped line count from the text length (~0.55 em per character) — a spare line is
        // harmless, a missing one overlaps.
        const cardW    = px(mobile ? 600 : 560)
        const bodyFont = fs(mobile ? 18 : 20)
        const bodyW    = cardW - px(28) * 2
        const bodyLines = Math.max(1, Math.ceil((c.body.length * bodyFont * 0.55) / bodyW))
        const bodyH    = Math.round(bodyLines * bodyFont * 1.3)
        const btn = (label: string, onClick: () => void, strong = false) => (
          <UiEntity key={label} uiTransform={{ height: px(44), padding: { left: px(18), right: px(18) }, margin: { left: px(6), right: px(6) }, alignItems: 'center', justifyContent: 'center', borderRadius: px(22) }}
            uiBackground={{ color: strong ? { r: 0.18, g: 0.49, b: 0.34, a: 1 } : { r: 1, g: 1, b: 1, a: 0.1 } }}
            onMouseDown={onClick}>
            <Label value={label} fontSize={fs(16)} color={{ ...CREAM, a: strong ? 1 : 0.85 }} textAlign="middle-center" textWrap="nowrap" uiTransform={{ height: '100%' }} />
          </UiEntity>
        )
        return (
          // Right at the top edge (KJ 2026-09-29: even under the banner's tallest state it reached the
          // explorer's interaction prompt / the hold-to-water meter, which live at the screen centre). The
          // banner is hidden while the tutorial runs (see `open` above), so nothing needs the 122 px under it —
          // except when the player taps the ring open (the ring step): the card steps down under it until it closes.
          <UiEntity uiTransform={{ positionType: 'absolute', position: { top: topPx + px(GAP) + (bannerShown ? bannerH + px(GAP) : 0), left: 0 }, width: '100%', flexDirection: 'row', justifyContent: 'center' }}>
            <UiEntity uiTransform={{ width: cardW, flexDirection: 'column', alignItems: 'center', padding: { left: px(28), right: px(28), top: px(14), bottom: px(18) }, borderRadius: px(26) }} uiBackground={{ color: { r: 0.07, g: 0.063, b: 0.055, a: 0.9 } }}>
              <UiEntity uiTransform={{ width: '100%', height: px(30), flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
                {/* Progress dots: done gold, current cream, to come faint */}
                <UiEntity uiTransform={{ height: '100%', flexDirection: 'row', alignItems: 'center' }}>
                  <Label value="Tutorial" fontSize={fs(14)} color={{ ...DIM, a: 0.8 }} textAlign="middle-left" textWrap="nowrap" uiTransform={{ height: '100%', margin: { right: px(10) } }} />
                  {Array.from({ length: c.of }, (_, i) => {
                    const done = i < c.step - 1 || (c.celebrate && i === c.step - 1)
                    const now  = i === c.step - 1 && !done
                    return <UiEntity key={`pip${i}`} uiTransform={{ width: px(10), height: px(10), margin: { right: px(5) }, borderRadius: px(5) }} uiBackground={{ color: done ? { ...GOLD, a: 1 } : now ? { ...CREAM, a: 0.9 } : { r: 1, g: 1, b: 1, a: 0.18 } }} />
                  })}
                </UiEntity>
                <UiEntity uiTransform={{ width: px(34), height: px(30), alignItems: 'center', justifyContent: 'center', borderRadius: px(15) }} uiBackground={{ color: { r: 1, g: 1, b: 1, a: 0.08 } }} onMouseDown={() => coachActions?.close()}>
                  <Label value="x" fontSize={fs(16)} color={{ ...DIM, a: 1 }} textAlign="middle-center" textWrap="nowrap" uiTransform={{ width: '100%', height: '100%' }} />
                </UiEntity>
              </UiEntity>
              <Label value={c.title} fontSize={fs(mobile ? 28 : 32)} color={c.celebrate ? { ...BAR_GREEN, a: 1 } : { ...GOLD, a: 1 }} textAlign="middle-center" textWrap="nowrap" uiTransform={{ height: fs(mobile ? 40 : 44), flexShrink: 0 }} />
              <Label value={c.body} fontSize={bodyFont} color={{ ...CREAM, a: 1 }} textAlign="middle-center" textWrap="wrap" uiTransform={{ width: '100%', height: bodyH, margin: { top: px(4), bottom: px(12) }, flexShrink: 0 }} />
              <UiEntity uiTransform={{ display: c.celebrate ? 'none' : 'flex', height: px(44), flexDirection: 'row', justifyContent: 'center', flexShrink: 0 }}>
                {c.primary ? btn(c.primary, () => coachActions?.primary(), true) : null}
                {c.skip === false ? null : btn('Skip step', () => coachActions?.skip())}
                {btn('End tutorial', () => coachActions?.end())}
              </UiEntity>
            </UiEntity>
          </UiEntity>
        )
      })()}
      {tutorialActive ? null : <BloomFinaleUi px={px} fs={fs} />}
      <AvenueCardUi px={px} fs={fs} mobile={mobile} maxH={Math.round(currentVirtualH * (1 - ins.top - ins.bottom)) - topPx - bottomPx} />
      <FlowerInspectorUi px={px} fs={fs} mobile={mobile} maxH={Math.round(currentVirtualH * (1 - ins.top - ins.bottom)) - topPx - bottomPx} />
      <DiscoveryCardUi px={px} fs={fs} mobile={mobile} />
      <HoldMeterUi px={px} fs={fs} mobile={mobile} />
      <MilestoneCardUi px={px} fs={fs} mobile={mobile} />
      <InfoPanelUi px={px} fs={fs} mobile={mobile} tutorialLabel={tutorialActive ? 'Resume tutorial' : 'Replay tutorial'} onTutorial={() => coachActions?.tutorial()} topPx={topPx} aboveChipPx={bottomPx + px(CHIP_H) + px(GAP)} maxW={Math.round(currentVirtualW * (1 - hIns * 2))} maxH={Math.round(currentVirtualH * (1 - ins.top - ins.bottom)) - topPx - bottomPx} />
      <SeedMenuUi px={px} fs={fs} mobile={mobile} topPx={topPx} aboveChipPx={bottomPx + px(CHIP_H) + px(GAP)} maxW={Math.round(currentVirtualW * (1 - hIns * 2))} maxH={Math.round(currentVirtualH * (1 - ins.top - ins.bottom)) - topPx - bottomPx} />

    </UiEntity>
    </UiEntity>
  )
}
