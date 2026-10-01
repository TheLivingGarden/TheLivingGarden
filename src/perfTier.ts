// =============================================================
// Bloom Garden v2 — effect budget tiers (CLIENT ONLY)
//
// KJ 2026-10-01 ("radically improve performance"): fewer, bigger particles and ambient effects. Every count / size that scales with the device
// goes through fx(): the first number is desktop, the second a phone. Read lazily (call it inside functions) — the platform is not known at
// module load.
// =============================================================

import { isMobile } from '@dcl/sdk/platform'

export function fx(desktop: number, phone: number): number {
  return isMobile() ? phone : desktop
}
