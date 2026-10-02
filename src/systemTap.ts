// =============================================================
// System timing tap (CLIENT, diagnostics — idle unless the PERF panel is on)
//
// installSystemTap() (called first in main) wraps engine.addSystem so the PERF panel can list every system registered after it, SDK ones included — the part of a tick the scene's own systems never show
// (KJ 2026-10-02: our systems were ~0.1 ms of a 7-25 ms script tick). Systems registered before this module runs stay unwrapped.
// Off = one boolean test per system per tick. Date.now() is whole ms, so only the SUM over many ticks means anything (hitchHud divides).
// =============================================================

import { engine } from '@dcl/sdk/ecs'

export interface SysStat { total: number; max: number }
export const sysStats = new Map<string, SysStat>()
let tapOn = false
export function setSystemTap(on: boolean): void { tapOn = on }

let installed = false
/** CLIENT ONLY, called first thing in main(). (As a bare first import it made the preview server run main() twice — "Component garden:PlantSync
 *  for 535 already exists" in a restart loop, 2026-10-02 — so it is an explicit call, never a side effect of importing, and never on the server.) */
export function installSystemTap(): void {
  if (installed) return
  installed = true
  const orig = engine.addSystem.bind(engine)
  let anon = 0
  engine.addSystem = ((fn: (dt: number) => void, priority?: number, name?: string) => {
    const label = name ?? (fn.name || `anon${++anon}`)
    return orig((dt: number) => {
      if (!tapOn) { fn(dt); return }
      const t0 = Date.now()
      fn(dt)
      const d = Date.now() - t0
      const st = sysStats.get(label) ?? { total: 0, max: 0 }
      st.total += d
      if (d > st.max) st.max = d
      sysStats.set(label, st)
    }, priority, name)
  }) as typeof engine.addSystem
}
