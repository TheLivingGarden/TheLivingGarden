// =============================================================
// Bloom Garden v2 — Info copy (SINGLE SOURCE)
//
// Everything the player can read about how the garden works. Both surfaces
// read from here — the UI panel now, the in-world board next — so the two can
// never drift apart.
//
// Numbers are DERIVED from the tuning constants, never typed out, so the text
// stays true when the tuning changes (BOX_GROW_MS is still at its 2-minute
// playtest value; the GDD wants overnight).
//
// KJ drafts over this — the wording is mine, the facts come from the GDD and
// the live config. Nothing here describes the unbuilt recipe system in
// design/rarity-notes.md: it only states what the build actually does.
// =============================================================

import {
  RARITY_TIERS, BOX_CAP_DEFAULT, growMsForTier, formatGrowTime,
  GUARANTEED_RARE_AT_CONTRIBUTORS, DECAY_FULL_GARDENERS,
  AVENUE_MIN_TIER, rarityTierById, WEEKLY_RESET_MS,
} from './config'

export const DISCORD_URL = 'https://discord.gg/gn8hTCYVPJ'

/** The ladder's two ends, so the copy states the RANGE rather than one number — and
 *  still never types a value (KJ's rule for this file). */
function growTime(): string {
  const lo = formatGrowTime(growMsForTier(0))
  const hi = formatGrowTime(growMsForTier(RARITY_TIERS.length - 1))
  return lo === hi ? lo : `${lo} for a ${RARITY_TIERS[0].name}, up to ${hi} for a ${RARITY_TIERS[RARITY_TIERS.length - 1].name}`
}

export interface InfoSection { title: string; lines: string[] }

export const INFO_SECTIONS: ReadonlyArray<InfoSection> = [
  {
    title: 'Watering',
    lines: [
      'Hold on a thirsty plant and let go in the green. Too much and it fails.',
      'Perfect pours build your streak and keep plants fresh longer.',
      `Plants dry out. Keep enough of them watered and the garden blooms - ${DECAY_FULL_GARDENERS} gardeners for a full bloom.`,
    ],
  },
  {
    title: 'Seeds and planting',
    lines: [
      'Seeds fall during a bloom. Walk through them to catch them.',
      `More gardeners means better odds. From ${GUARANTEED_RARE_AT_CONTRIBUTORS} you are guaranteed a Rare or better.`,
      `Plant one in a free planter. It opens in ${growTime()}. Water it to speed it up.`,
      `You get ${BOX_CAP_DEFAULT} planters. Harvest your flower, or leave it on show.`,
    ],
  },
  {
    title: 'Flowers and the Gallery',
    lines: [
      `${RARITY_TIERS.map(t => t.name).join(' → ')}. Mythic and Unique are extremely rare.`,
      'Almanac: find every plant at every rarity for stamps and titles.',
      `Gallery: put a ${rarityTierById(AVENUE_MIN_TIER).name}+ flower on show to make every bloom's seeds rarer.`,
    ],
  },
  {
    title: 'Boards',
    lines: [
      `All-time never resets. This week resets every ${Math.round(WEEKLY_RESET_MS / 86_400_000)} days.`,
      'Tap the health ring for details.',
    ],
  },
  {
    title: 'Community',
    lines: [
      'Join the Discord to share finds and tell us what to fix.',
    ],
  },
]
