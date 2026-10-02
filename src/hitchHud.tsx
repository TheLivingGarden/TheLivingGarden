// =============================================================
// Bloom Garden v2 — hitch HUD (CLIENT ONLY, admin, OFF by default)
//
// A switch in the test panel's Perf tab (KJ 2026-10-01: "a switchable one"). Answers what the Explorer's debug panel cannot: was the SCENE
// busy during a hitch?
//
//   gap     wall time between two scene ticks. A long gap is a hitch, whoever caused it.
//   script  time our own systems took inside that tick (first system to last). Gap high + script LOW = the cost is outside our code
//           (renderer, model loads, GPU). Gap high + script HIGH = a system of ours, and the events line says which burst.
//   events  messages that arrived in the second before (water states, seeds, box states, leaderboard, bloom), counted by kind.
//
// Bottom-left, so it does not sit on the test panel. Nothing runs until it is first switched on.
// =============================================================

import ReactEcs, { UiEntity, Label, ReactEcsRenderer } from '@dcl/sdk/react-ecs'
import { engine, Tween, TweenSequence, GltfContainer, AvatarShape, ParticleSystem, GltfNodeModifiers, Material, VisibilityComponent } from '@dcl/sdk/ecs'
import { getPlayer } from '@dcl/sdk/players'
import { room } from './shared/messages'
import { ADMIN_ADDRESSES } from './shared/config'
import { sysStats, setSystemTap } from './systemTap'

let on = false
let installed = false

interface Mark { name: string; at: number }
const marks: Mark[] = []
const HITCH_GAP_MS = 90
const HITCH_SCRIPT_MS = 25
const WINDOW = 120

let lastStart = 0, tickStart = 0, curGap = 0, maxGap = 0
const gaps: number[] = []
const scripts: number[] = []
const hitches: string[] = []

// Per-system cost (KJ 2026-10-02: deployed world 28/s, script 17 ms avg, one 421 ms script spike — but which system?). Called ONCE, first thing in
// main(): every later engine.addSystem is wrapped so its time is summed per name while the HUD is on. Date.now() is whole milliseconds, so one
// call reads 0 or 1; the SUM over many ticks is what means something (avg = total / ticks). Off = one boolean test per system per tick.
let sysTicks = 0
let sdkMs = 0
let uiMs = 0, uiCalls = 0
let tweenCount = 0, loopCount = 0, tweenCountAt = 0
let profilerInstalled = false
export function installSystemProfiler(): void {
  if (profilerInstalled) return
  profilerInstalled = true
  // What the SCENE did in the second before a stall (KJ 2026-10-02: 114-130 ms gaps with 5-8 ms of script = the renderer was busy, but with what?).
  // Each of these is a thing the renderer must load, build or re-bind; hitch lines list them by count, so a stall with 'glb:rose.glb x6' beside it
  // is a model load, 'addEnt x40' an entity burst, 'material x30' a material re-apply, and so on.
  const tap = <T extends object>(obj: T, method: string, label: (args: unknown[]) => string): void => {
    const o = (obj as Record<string, unknown>)[method] as (...a: unknown[]) => unknown
    ;(obj as Record<string, unknown>)[method] = function (this: unknown, ...a: unknown[]) {
      if (on) mark(label(a))
      return o.apply(this, a)
    }
  }
  const glbName = (a: unknown[]): string => `glb:${String((a[1] as { src?: string } | undefined)?.src ?? '?').split('/').pop()}`
  tap(GltfContainer, 'create', glbName)
  tap(GltfContainer, 'createOrReplace', glbName)
  tap(AvatarShape, 'create', () => 'avatar')
  tap(AvatarShape, 'createOrReplace', () => 'avatar')
  tap(ParticleSystem, 'create', () => 'particles')
  tap(GltfNodeModifiers, 'create', () => 'nodeMods')
  tap(GltfNodeModifiers, 'createOrReplace', () => 'nodeMods')
  tap(Material, 'setPbrMaterial', () => 'material')
  tap(Material, 'setBasicMaterial', () => 'material')
  tap(VisibilityComponent, 'createOrReplace', () => 'visibility')
  tap(engine, 'addEntity', () => 'addEnt')
  tap(engine, 'removeEntity', () => 'rmEnt')
  // The UI renderer: the SDK's '@dcl/react-ecs' system (priority 100e3) calls our root component EVERY tick, then reconciles what it returned
  // against the last tree. That is inside the SDK share of the tick, and the HUD cannot see it as a system of ours — so time the root component
  // itself here. (SDK share minus this = reconcile + everything else the SDK does.)
  const setUi = ReactEcsRenderer.setUiRenderer.bind(ReactEcsRenderer) as (ui: () => unknown, opts?: unknown) => void
  ;(ReactEcsRenderer as unknown as { setUiRenderer: typeof setUi }).setUiRenderer = (ui, opts) => setUi(() => {
    if (!on) return ui()
    const t0 = Date.now()
    const r = ui()
    uiMs += Date.now() - t0; uiCalls++
    return r
  }, opts)
  // First of the scene's own systems at the regular priority: first marker → here = what runs before them (the SDK's systems and any higher priority).
  engine.addSystem(function sdkEndProbe() { if (on && tickStart) sdkMs += Date.now() - tickStart }, undefined, 'sdkEndProbe')
}
function topSystems(n: number): string[] {
  return [...sysStats.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, n)
    .map(([k, v]) => `${k}  ${(sysTicks > 0 ? v.total / sysTicks : 0).toFixed(2)}ms avg  max ${v.max}ms`)
}

export function isHitchHudOn(): boolean { return on }

export function setHitchHud(enabled: boolean): void {
  on = enabled
  setSystemTap(on)
  if (on) resetHitchHud()   // the averages are session totals: a fresh switch-on starts them from now, not from the load
  if (!on || installed) return
  installed = true
  engine.addSystem(firstSystem, 1_000_000_000, 'hitchFirst')
  engine.addSystem(lastSystem, 1, 'hitchLast')
  // Registered late (the first time the HUD is switched on), after the scene's own handlers — adding listeners never disturbs them.
  for (const name of ['plantStateUpdate', 'seedSpawned', 'boxState', 'leaderboardUpdate', 'bloomTriggered', 'streakUpdate', 'seedGathered', 'pouchUpdate'] as const) {
    room.onMessage(name, () => { if (on) mark(name === 'plantStateUpdate' ? 'plantState' : name) })
  }
}

function mark(name: string): void {
  marks.push({ name, at: Date.now() })
  if (marks.length > 600) marks.splice(0, 300)
}

function recentEvents(now: number, spanMs: number): string {
  const counts = new Map<string, number>()
  for (let i = marks.length - 1; i >= 0 && now - marks[i].at <= spanMs; i--) counts.set(marks[i].name, (counts.get(marks[i].name) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}x${c}`).join(' ') || '-'
}

function firstSystem(): void {
  if (!on) { lastStart = 0; tickStart = 0; return }
  const now = Date.now()
  sysTicks++
  if (now - tweenCountAt > 1000) {
    tweenCountAt = now
    tweenCount = 0; loopCount = 0
    for (const [e] of engine.getEntitiesWith(Tween)) { tweenCount++; if (TweenSequence.has(e)) loopCount++ }
  }
  curGap = lastStart ? now - lastStart : 0
  lastStart = now
  tickStart = now
}

function lastSystem(): void {
  if (!on || !tickStart) return   // switched on mid-tick: no start mark yet
  const now = Date.now()
  const script = now - tickStart
  gaps.push(curGap); scripts.push(script)
  if (gaps.length > WINDOW) { gaps.shift(); scripts.shift() }
  if (curGap > maxGap) maxGap = curGap
  if (curGap > HITCH_GAP_MS || script > HITCH_SCRIPT_MS) {
    const line = `${curGap}ms gap, ${script}ms script | ${recentEvents(now, 1200)}`
    hitches.unshift(line)
    if (hitches.length > 7) hitches.pop()
  }
}

const avg = (a: number[]): number => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0
export function resetHitchHud(): void { gaps.length = 0; scripts.length = 0; hitches.length = 0; maxGap = 0; sysStats.clear(); sysTicks = 0; sdkMs = 0; uiMs = 0; uiCalls = 0 }

export function HitchHudUi(props: { px: (n: number) => number }) {
  if (!ADMIN_ADDRESSES.includes((getPlayer()?.userId ?? '').toLowerCase())) return null
  const { px } = props
  // Off: just a small "PERF" pill (admin only), bottom-left, that switches it on — so it does not depend on finding the test panel (KJ 2026-10-01).
  if (!on) {
    return (
      <UiEntity
        uiTransform={{ positionType: 'absolute', position: { bottom: px(150), left: px(70) }, width: px(70), height: px(30), alignItems: 'center', justifyContent: 'center', borderRadius: px(15) }}
        uiBackground={{ color: { r: 0.03, g: 0.03, b: 0.04, a: 0.7 } }}
        onMouseDown={() => setHitchHud(true)}
      >
        <Label value="PERF" fontSize={12} color={{ r: 1, g: 1, b: 1, a: 0.75 }} textAlign="middle-center" textWrap="nowrap" uiTransform={{ width: '100%', height: '100%' }} />
      </UiEntity>
    )
  }
  const g = avg(gaps), s = avg(scripts), now = Date.now()
  const line = (v: string, a = 1) => <Label value={v} fontSize={12} color={{ r: 1, g: 1, b: 1, a }} textAlign="top-left" textWrap="nowrap" uiTransform={{ height: 15 }} />
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { bottom: px(150), left: px(70) }, width: px(560), flexDirection: 'column', padding: px(6), borderRadius: px(8) }}
      uiBackground={{ color: { r: 0.03, g: 0.03, b: 0.04, a: 0.82 } }}
    >
      <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 2, right: 4 }, width: 40, height: 18, alignItems: 'center', justifyContent: 'center' }} onMouseDown={() => setHitchHud(false)}>
        <Label value="hide" fontSize={11} color={{ r: 1, g: 1, b: 1, a: 0.6 }} textAlign="middle-center" textWrap="nowrap" uiTransform={{ width: '100%', height: '100%' }} />
      </UiEntity>
      {line(`HITCH  tick ${g.toFixed(1)}ms (${g > 0 ? Math.round(1000 / g) : 0}/s)  max gap ${maxGap}ms  script ${s.toFixed(1)}ms avg`)}
      {line(`last 1.5s: ${recentEvents(now, 1500)}`, 0.85)}
      {line(`SDK systems ${(sysTicks > 0 ? sdkMs / sysTicks : 0).toFixed(1)}ms avg   tweens ${tweenCount} (${loopCount} looping)`, 0.95)}
      {line(`UI component ${(uiCalls > 0 ? uiMs / uiCalls : 0).toFixed(2)}ms avg (${uiCalls} renders)`, 0.95)}
      {topSystems(8).map((t, i) => <UiEntity key={`s${i}`} uiTransform={{ height: 15 }}>{line(`SYS ${t}`, 0.9)}</UiEntity>)}
      {hitches.map((h, i) => <UiEntity key={`h${i}`} uiTransform={{ height: 15 }}>{line(h, i === 0 ? 1 : 0.65)}</UiEntity>)}
    </UiEntity>
  )
}
