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
  RARITY_TIERS, BOX_CAP_DEFAULT, GUARANTEED_RARE_AT_CONTRIBUTORS,
  AVENUE_MIN_TIER, rarityTierById,
} from './config'

export const DISCORD_URL = 'https://discord.gg/gn8hTCYVPJ'

export interface InfoSection { title: string; lines: string[] }

export const INFO_SECTIONS: ReadonlyArray<InfoSection> = [
  {
    title: 'Watering',
    lines: [
      'Hold on a plant with a water drop and let go in the green. Too much and it fails.',
      'Perfect pours build your streak and keep plants fresh longer.',
      'Plants dry out. Keep enough of them watered and the garden blooms, whether you are solo or with other gardeners.',
    ],
  },
  {
    title: 'Seeds and planting',
    lines: [
      'Seeds fall during a bloom. Walk through them to catch them.',
      `More gardeners means better odds. From ${GUARANTEED_RARE_AT_CONTRIBUTORS} you are guaranteed a Rare or better.`,
      'Plant one in a free planter. Rarer seeds take longer to open. Water it to speed it up.',
      `You start with ${BOX_CAP_DEFAULT} planters, and collecting more species unlocks extra ones. Harvest your flower, or leave it on show.`,
    ],
  },
  {
    title: 'Flowers and the Gallery',
    lines: [
      `${RARITY_TIERS.map(t => t.name).join(' → ')}`,
      'Collection: find every plant at every rarity for stamps and titles.',
      `Gallery: put a ${rarityTierById(AVENUE_MIN_TIER).name}+ flower on show to make every bloom's seeds rarer.`,
    ],
  },
  {
    title: 'Leaderboards',
    lines: [
      'All-time never resets. This week starts fresh every week.',
    ],
  },
  {
    title: 'Community',
    lines: [
      'Join the Discord to share finds and tell us what to fix.',
    ],
  },
]
