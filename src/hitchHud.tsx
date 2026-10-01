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

import ReactEcs, { UiEntity, Label } from '@dcl/sdk/react-ecs'
import { engine } from '@dcl/sdk/ecs'
import { getPlayer } from '@dcl/sdk/players'
import { room } from './shared/messages'
import { ADMIN_ADDRESSES } from './shared/config'

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

export function isHitchHudOn(): boolean { return on }

export function setHitchHud(enabled: boolean): void {
  on = enabled
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
  if (!on) { lastStart = 0; return }
  const now = Date.now()
  curGap = lastStart ? now - lastStart : 0
  lastStart = now
  tickStart = now
}

function lastSystem(): void {
  if (!on) return
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
export function resetHitchHud(): void { gaps.length = 0; scripts.length = 0; hitches.length = 0; maxGap = 0 }

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
      {hitches.map((h, i) => <UiEntity key={`h${i}`} uiTransform={{ height: 15 }}>{line(h, i === 0 ? 1 : 0.65)}</UiEntity>)}
    </UiEntity>
  )
}
