// =============================================================
// Bloom Garden v2 — collection wire format (shared by the server and the client)
//
// 2026-09-25 bug: a player with 136+ flowers could only plant in ONE planter. The server sent the whole
// collection (with per-flower provenance the client never reads) as a single ~14 KB JSON string in the same
// message as the planter cap; past a size limit the message was silently dropped, the client never learned
// its cap, and its default of 1 applied. Collections grow without bound (cap 500), so:
//   - each keepsake is SLIMMED to the four fields the client uses,
//   - the list is sent in CHUNKS, each carrying the planter cap, so the cap never depends on collection size,
//   - the client reassembles the chunks.
// =============================================================

export interface SlimKeepsake { flower: string; rarityTier: number; at: number; from?: string }

/** Flowers per message. 80 slim keepsakes are ~5 KB, far from any message size limit. */
export const COLLECTION_CHUNK = 80
/** A comfortable ceiling for one message's payload: the failure above appeared around 14 KB. */
export const MAX_SAFE_MESSAGE_BYTES = 10_000

/** What the client actually reads of a keepsake. Provenance (grownBy, helpers, ...) stays on the server. */
export function slimKeepsake(k: { flower: string; rarityTier?: number; at: number; from?: string }): SlimKeepsake {
  const s: SlimKeepsake = { flower: k.flower, rarityTier: k.rarityTier ?? 0, at: k.at }
  if (k.from) s.from = k.from
  return s
}

/** Ordered slices of `list`. Always at least one (possibly empty), so an empty collection still delivers the planter cap. */
export function chunkCollection<T>(list: ReadonlyArray<T>, size = COLLECTION_CHUNK): Array<{ start: number; items: T[] }> {
  if (list.length === 0) return [{ start: 0, items: [] }]
  const out: Array<{ start: number; items: T[] }> = []
  for (let i = 0; i < list.length; i += size) out.push({ start: i, items: list.slice(i, i + size) })
  return out
}

/** Client side: feed chunks in as they arrive; returns the full list once complete, else null. A chunk with start 0 begins a
 *  fresh assembly, so a resync replaces a half-received list rather than mixing with it. */
export class CollectionAssembler {
  private buf: SlimKeepsake[] = []
  add(start: number, total: number, items: SlimKeepsake[]): SlimKeepsake[] | null {
    if (start === 0) this.buf = []
    if (start !== this.buf.length) return null   // out of order or a lost chunk: wait for the next full resync
    this.buf.push(...items)
    return this.buf.length >= total ? this.buf.slice(0, total) : null
  }
}
