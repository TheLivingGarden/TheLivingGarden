// What a gardener holds in their hand, as a pure rule (no engine, no Storage) so it can be
// pinned by tests. server.ts owns the maps and the messages; this owns the decision.

/** The seed tier to show in the hand (-1 = no seed), and the equipped tier to KEEP afterwards
 *  (undefined when it must be forgotten — the last seed of that tier was planted).
 *    1. nothing, if a keepsake is in the hand — a flower ALWAYS wins the hand
 *    2. a seed they explicitly equipped, while they still have one of that tier
 *    3. otherwise the rarest seed they hold — the pouch made visible by default
 *  Everything is derived from the pouch, so a seed can never be shown that the pouch lacks. */
export function chooseHandSeed(
  pouch: ReadonlyArray<number> | undefined,
  hasKeepsake: boolean,
  equipped: number | undefined,
): { tier: number; equipped: number | undefined } {
  if (!pouch) return { tier: -1, equipped }
  if (hasKeepsake) return { tier: -1, equipped }
  if (equipped !== undefined) {
    if ((pouch[equipped] ?? 0) > 0) return { tier: equipped, equipped }
    equipped = undefined   // planted the last one of that tier — fall through
  }
  for (let tier = pouch.length - 1; tier >= 0; tier--) if ((pouch[tier] ?? 0) > 0) return { tier, equipped }
  return { tier: -1, equipped }
}
