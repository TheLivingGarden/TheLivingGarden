/** The last-seen times worth storing. Tidying reads them only for owners of a planter or an Avenue slot, so
 *  storing every visitor would grow the value without bound, past the service's 512 KB cap after a few
 *  thousand visitors. Keyed by lowercase address. */
export function lastSeenToStore(seen: ReadonlyMap<string, number>, owners: Iterable<string>): Record<string, number> {
  const stored: Record<string, number> = {}
  for (const owner of owners) {
    const address = owner.toLowerCase()
    const at = seen.get(address)
    if (at !== undefined) stored[address] = at
  }
  return stored
}
