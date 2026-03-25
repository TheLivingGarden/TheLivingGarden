// =============================================================
// The Living Garden — Notifications
// Public API for all screen-space notification pills.
//   • Toast      — brief auto-dismiss pill (Plant Watered, daily limit)
//   • Persistent — stays until explicitly cleared (All plants watered)
// UI rendering is handled by ui.tsx; this file owns the API and
// message formatting so wateringSystem.ts stays focused on gameplay.
// =============================================================

export { showToast, showPersistent, hidePersistent } from './ui'
export { setupUi as setupNotifications } from './ui'

// ---------------------------------------------------------------
// Message formatters
// ---------------------------------------------------------------

/** Persistent pill copy — shown while player waits for next bloom window. */
export function formatBloomCountdown(testMode: boolean): string {
  if (testMode) return 'All plants watered!\nBloom starting soon...'
  const now   = new Date()
  const at6am = new Date(now); at6am.setUTCHours(6,  0, 0, 0)
  const at6pm = new Date(now); at6pm.setUTCHours(18, 0, 0, 0)
  let next: Date
  if      (now < at6am) next = at6am
  else if (now < at6pm) next = at6pm
  else { next = new Date(at6am); next.setUTCDate(next.getUTCDate() + 1) }
  const ms = next.getTime() - Date.now()
  const h  = Math.floor(ms / 3_600_000)
  const m  = Math.floor((ms % 3_600_000) / 60_000)
  return `All plants watered!\nBloom in ${h}h ${m}min`
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
