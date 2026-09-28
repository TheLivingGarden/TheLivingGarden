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
  RARITY_TIERS, BOX_GROW_MS, BOX_CAP_DEFAULT, BOX_WATER_MAX, growMsForTier, formatGrowTime,
  GUARANTEED_RARE_AT_CONTRIBUTORS, DECAY_FULL_GARDENERS,
  AVENUE_MIN_TIER, AVENUE_SLOT_CAP, PLANTER_TIDY_MIN_AWAY_MS, rarityTierById,
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
    title: 'The garden',
    lines: [
      'Plants droop and carry a floating water drop. Tap one and your gardener waters it — the plant revives and your name appears above it.',
      'Watered plants dry out again after a few minutes — even during a bloom — so the garden is always slipping back. Keeping it healthy is the whole job.',
      'A drop returning to a green plant means it is about to dry. Water it again and it starts fresh.',
      `When the garden is healthy enough for long enough, it blooms. It blooms faster and bigger with more gardeners — it takes ${DECAY_FULL_GARDENERS} to reach a full-garden bloom, but one gardener alone can still earn a quiet one.`,
    ],
  },
  {
    title: 'Seeds',
    lines: [
      'Seeds fall during a bloom — and only then. You gather them by walking through them, no tapping, no aiming.',
      'Everyone sees the same seeds and everyone can collect each one, so nobody is racing you.',
      `The best seeds come from the busiest blooms: more gardeners means more seeds and better odds, and from ${GUARANTEED_RARE_AT_CONTRIBUTORS} contributors you are guaranteed at least one Rare or better.`,
      'Watch for the rainbow seed — it appears once per bloom, drifts along its own path, and carries the best odds in the game.',
      'The "Luck boost" under the garden health meter is this in one number — how much rarer the next bloom rolls right now, from gardeners present and the Rare Plant Gallery.',
    ],
  },
  {
    title: 'Rarity',
    lines: [
      RARITY_TIERS.map(t => t.name).join(' → '),
      'A seed shows its rarity, never what it will become — the species stays a mystery until the flower opens.',
      'Rarer seeds glow and pulse harder, as seeds, as seedlings, and as the flower they open into.',
    ],
  },
  {
    title: 'Planting',
    lines: [
      `Tap an empty planter to plant. It takes your name, and it opens about ${growTime()} later.`,
      'You choose which seed goes in from the seed pouch — the one you pick is the one you carry in your hand.',
      `Other gardeners can water your growing seed to bring it forward a little, up to ${BOX_WATER_MAX} times. You cannot water your own — a seedling you CAN help carries a water drop.`,
    ],
  },
  {
    title: 'Keeping your flowers visible',
    lines: [
      `You hold ${BOX_CAP_DEFAULT} planters at a time, and that covers both growing and displaying.`,
      'When a flower opens you choose: harvest it into My Flowers and free the planter, or leave it standing on show with your name on it.',
      'If every planter is taken when a new gardener arrives, the planter whose owner has been away longest is tidied up. That flower is never lost — it goes to its owner\'s My Flowers and waits for them.',
      'So: keep visiting and your display stays up.',
    ],
  },
  {
    title: 'Gifting',
    lines: [
      'Anything in My Flowers can be given away. Hold one, walk up to another gardener and tap them.',
      'A gifted flower is theirs to keep, display or pass on.',
    ],
  },
  {
    title: 'The Rare Plant Gallery',
    lines: [
      `${rarityTierById(AVENUE_MIN_TIER).name} flowers and up can stand on show in the Rare Plant Gallery, for every visitor to see.`,
      'Every flower on show makes every Bloom\'s seeds rarer, for everyone - the rarer the flower, the bigger the boost.',
      AVENUE_SLOT_CAP > 0 ? `You can have up to ${AVENUE_SLOT_CAP} on show at once.` : 'No limit on how many you show — a spare stand is all it takes.',
      'Tap an empty stand to put one of your flowers there, or an occupied one to see who grew it, who watered it, and how long it has stood.',
      `If the Gallery is full and you're away ${Math.round(PLANTER_TIDY_MIN_AWAY_MS / 3_600_000)}h+, the longest-away flower moves home to make room for someone new — never lost.`,
    ],
  },
]
