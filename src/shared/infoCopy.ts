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
  AVENUE_MIN_TIER, PLANTER_TIDY_MIN_AWAY_MS, SEED_LIFETIME_MS,
  SEED_DODGES_BY_TIER, TOTAL_PLANTS, BLOOM_THRESHOLD, rarityTierById,
} from './config'

const BLOOM_PERCENT   = Math.round((BLOOM_THRESHOLD / TOTAL_PLANTS) * 100)
const SEED_MINUTES    = Math.round(SEED_LIFETIME_MS / 60_000)
const HOPPING_TIER    = rarityTierById(SEED_DODGES_BY_TIER.findIndex(n => n > 0)).name
const TIDY_AWAY_HOURS = Math.round(PLANTER_TIDY_MIN_AWAY_MS / 3_600_000)

export const DISCORD_URL = 'https://discord.gg/gn8hTCYVPJ'

export interface InfoSection { title: string; lines: string[] }

export const INFO_SECTIONS: ReadonlyArray<InfoSection> = [
  {
    title: 'Watering',
    lines: [
      'Hold on a plant with a water drop and let go in the green. Too much and it fails.',
      'Perfect pours build your streak and keep plants fresh longer. The streak is saved between visits and only a missed pour resets it.',
      `Plants dry out. Hold the garden at ${BLOOM_PERCENT}% and it blooms, whether you are solo or with other gardeners.`,
    ],
  },
  {
    title: 'The health ring',
    lines: [
      'The ring in the top corner is the garden\'s health. Tap it to see how many plants the next bloom needs and who is gardening with you.',
      'It also shows your Luck boost: how much likelier a rare seed is right now. More gardeners and rarer flowers in the Gallery raise it for everyone.',
    ],
  },
  {
    title: 'Seeds and planting',
    lines: [
      `Seeds fall during a bloom. Walk through them to catch them. They fade after ${SEED_MINUTES} minutes, and ${HOPPING_TIER} and rarer ones hop away first.`,
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
      'Harvested flowers stand on your shelf in the shed. Hold one, gift it to another gardener, or set it on the table to inspect it.',
      `Gallery: put a ${rarityTierById(AVENUE_MIN_TIER).name}+ flower on show to make every bloom's seeds rarer.`,
      `Tap your own stand to take a flower back or swap it. When the Gallery is full, a new flower replaces one whose gardener has been away ${TIDY_AWAY_HOURS}+ hours, whatever its rarity. The flower goes back to its owner.`,
    ],
  },
  {
    title: 'Leaderboards',
    lines: [
      'All-time never resets. This week starts fresh every week.',
      'The time left this week is on your own row of the weekly board.',
    ],
  },
  {
    title: 'Community',
    lines: [
      'Join the Discord to share finds and tell us what to fix.',
    ],
  },
]
