// =============================================================
// The Living Garden — Notifications
// Public API for all screen-space notification pills.
//   • Toast      — brief auto-dismiss pill (Plant Watered, daily limit)
//   • Persistent — stays until explicitly cleared (All plants watered)
// UI rendering is handled by ui.tsx; this file owns the API and
// message formatting so wateringSystem.ts stays focused on gameplay.
// =============================================================

export {
  showToast, showDailyLimit, hideDailyLimit, showPersistent, hidePersistent,
  showBannerIdle, showBannerCountdown, updateBannerCountdown, showBannerBloom, updateBannerHealth,
  updatePlayerCount, updateWaterCount, triggerCanErrorEffect,
} from './ui'
export { setupUi as setupNotifications } from './ui'
import { BLOOM_WINDOWS } from './shared/config'

// ---------------------------------------------------------------
// Server-synced bloom time
// ---------------------------------------------------------------

/** Local timestamp (ms) of the next bloom, converted from server time via clockSync.
 *  0 = not yet received from server — falls back to BLOOM_WINDOWS calculation. */
let nextBloomLocalTime = 0

/** Called by wateringSystem when a playerDailyState or notifyServerTime message
 *  carries a bloom timestamp that has been converted to local time via clockSync. */
export function setNextBloomLocalTime(localTime: number): void {
  nextBloomLocalTime = localTime
}

// ---------------------------------------------------------------
// Message formatters
// ---------------------------------------------------------------

/** Raw ms until the next bloom.
 *  Uses server-synced timestamp when available; falls back to BLOOM_WINDOWS
 *  calculation before the first server message arrives. */
export function getMsUntilBloom(): number {
  if (nextBloomLocalTime > 0) {
    return Math.max(0, nextBloomLocalTime - Date.now())
  }
  // Fallback — only used before the first playerDailyState arrives
  const now = Date.now()
  const d   = new Date(now)
  const y   = d.getUTCFullYear()
  const mo  = d.getUTCMonth()
  const day = d.getUTCDate()
  let nearest = Infinity
  for (const w of BLOOM_WINDOWS) {
    const today    = Date.UTC(y, mo, day,     w.hour, w.minute, 0, 0)
    const tomorrow = Date.UTC(y, mo, day + 1, w.hour, w.minute, 0, 0)
    const ms = (today > now ? today : tomorrow) - now
    if (ms < nearest) nearest = ms
  }
  return nearest
}

/** Bloom countdown — returns time remaining with seconds (e.g. "2h 14m 07s").
 *  Returns "0s" once the window has passed (server will fire bloomTriggered). */
export function formatBloomCountdown(testMode: boolean): string {
  if (testMode) return 'Soon...'
  const ms = getMsUntilBloom()
  if (ms <= 0) return '0s'
  const h  = Math.floor(ms / 3_600_000)
  const m  = Math.floor((ms % 3_600_000) / 60_000)
  const s  = Math.floor((ms % 60_000) / 1_000)
  const ss = String(s).padStart(2, '0')
  if (h > 0) return `${h}h ${m}m ${ss}s`
  if (m > 0) return `${m}m ${ss}s`
  return `${ss}s`
}

/** Toast copy — shown when the player hits their daily watering limit. */
export function formatDailyLimitMessage(testMode: boolean): string {
  if (testMode) return "You've reached your daily watering limit\n[TEST MODE — resets on new session]"
  const midnight = new Date(); midnight.setUTCHours(24, 0, 0, 0)
  const ms = midnight.getTime() - Date.now()
  const h  = Math.floor(ms / 3_600_000)
  const m  = Math.floor((ms % 3_600_000) / 60_000)
  return `You've reached your daily watering limit,\nplease try again in ${h}h ${m}min`
}
