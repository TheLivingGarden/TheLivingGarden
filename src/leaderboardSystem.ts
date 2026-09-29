// =============================================================
// The Living Garden — Leaderboard System
//
// Two boards: the panel behind the podium = ALL TIME (top-10 lifetime, never resets;
// the podium's avatars are its top 4), the mirrored panel at the far end = THIS WEEK
// (top-10, resets at a visible time) — GDD §4.3 hook 2. Names carry milestone flair
// (GDD §5). All layout, style, and position config lives in the block below.
//
// ⚠️ TextShape READS FROM ITS −Z SIDE (a viewer looking along +Z sees it the right way
// round). So a board read from the +Z side needs rotationY 180 — and then the text's
// local +Z depth offset points to world −Z, which is why each origin sits just off the
// panel face on the reader's side. Both boards rendered mirrored before this was pinned
// down (KJ 2026-09-22 screenshots).
// =============================================================

import {
  engine,
  Entity,
  Transform,
  TextShape,
  TextAlignMode,
  MeshRenderer,
  Material,
  MaterialTransparencyMode,
} from '@dcl/sdk/ecs'
import { Quaternion, Color4 } from '@dcl/sdk/math'
import { flairIcon, almanacTitleByRank } from './shared/config'

// ===============================================================
//  BOARD CONFIG — edit anything in this block; no other files need touching.
// ===============================================================

// RE-BAKED 2026-09-29 from scene.glb (KJ: "all time and weekly side by side"). The far wall mesh
// `Cube.043` is now TWO 7.41 x 4.97 m panels at z 55.55-55.66, y 1.99-6.96: x 6.72-14.13 (centre 10.43)
// and x 19.71-27.12 (centre 23.41). ALL TIME reads on the left, THIS WEEK on the right, each with the
// full layout the weekly board had (title, header, ten rows, your own standing). Before this the single
// weekly board sat at x 16, in the gap between the frames.
// The podium back panel (`Cube.001`, x 12.39-19.80, y 1.99-6.96, z -7.62..-7.51) no longer carries a
// list: the podium is the "TOP GARDENERS" display now (podium.ts: a title plus a rank/waters caption
// over each avatar). The stand and that panel are both 0.5 m higher than on 09-22.
// Found with the node-transformed bbox scan (thin vertical panels >= 3 m wide) - re-run it
// if the panels move again.

interface BoardTitle { x: number; y: number; z: number; rotationY: number; font: number }
/** One column's four local x positions: flair icon, rank (right-aligned), name (left-
 *  aligned), waters (right-aligned). A gold rank in its own column reads far better than
 *  "1.  Name" inside the white name string (KJ 2026-09-22: "needs some love"). */
interface BoardColumn { flairX: number; rankX: number; nameX: number; scoreX: number }
interface BoardLayout {
  kind:       'weekly' | 'allTime'
  /** Text-block origin (world) — on the reader's side of the panel face — and facing. */
  position:   { x: number; y: number; z: number }
  rotationY:  number
  /** Ranks fill column 1 top-to-bottom, then column 2. */
  columns:    BoardColumn[]
  rows:       number          // per column
  startY:     number          // local y of the first row
  rowStep:    number
  fontEntry:  number
  /** NAME / WATERS row — null for the podium board, whose title lives on the screen. */
  header:     { y: number; font: number } | null
  /** "YOU · #23" pinned under the last row — where the reader stands even when they are
   *  nowhere near the top ten. null = no such row on this board. */
  you:        { y: number; font: number } | null
  title:      BoardTitle
}

// Both read from the garden side (-Z), text 0.16 m in front of the panel face, one column using the whole
// panel: title, header, ten rows, then the YOU row above the bottom edge (panel bottom is world y 1.99).
const LB_BOARDS: ReadonlyArray<BoardLayout> = [
  {
    kind: 'allTime',
    position: { x: 10.43, y: 4.47, z: 55.39 }, rotationY: 0,
    columns: [{ flairX: -3.40, rankX: -2.95, nameX: -2.75, scoreX: 3.0 }],
    rows: 10, startY: 1.02, rowStep: 0.32, fontEntry: 1.5,
    header: { y: 1.5, font: 1.5 },
    you: { y: -2.28, font: 1.5 },
    title: { x: 10.43, y: 4.47 + 2.03, z: 55.47, rotationY: 0, font: 2.0 },
  },
  {
    kind: 'weekly',
    position: { x: 23.41, y: 4.47, z: 55.39 }, rotationY: 0,
    columns: [{ flairX: -3.40, rankX: -2.95, nameX: -2.75, scoreX: 3.0 }],
    rows: 10, startY: 1.02, rowStep: 0.32, fontEntry: 1.5,
    header: { y: 1.5, font: 1.5 },
    you: { y: -2.28, font: 1.5 },
    title: { x: 23.41, y: 4.47 + 2.03, z: 55.47, rotationY: 0, font: 2.0 },
  },
]

const LB_DEPTH = 0.08              // local Z lift off the board face — increase if text clips into the mesh
const LB_TITLE_WEEKLY   = 'THIS WEEK'
const LB_TITLE_ALL_TIME = 'ALL TIME'
const LB_HEADER_NAME    = 'NAME'
const LB_HEADER_SCORE   = 'WATERS'
const LB_COUNTDOWN_TICK_MS = 30_000
const LB_FLAIR_SIZE = 0.2

// ── Colours  (r/g/b/a each 0–1) ──────────────────────────────
const LB_COLOR_HEADER = { r: 1,   g: 0.84, b: 0.1,  a: 1 }  // gold
const LB_COLOR_NAME   = { r: 1,   g: 1,    b: 1,    a: 1 }  // white
const LB_COLOR_SCORE  = { r: 0.6, g: 1,    b: 0.6,  a: 1 }  // soft green
const LB_COLOR_RANK   = { r: 1,   g: 0.78, b: 0.36, a: 1 }  // warm gold, quieter than the header
const LB_COLOR_YOU    = { r: 0.75, g: 0.92, b: 1,   a: 1 }  // cool blue — "this row is you"

// ── Mock data ─────────────────────────────────────────────────
// Shown immediately on load until the server sends real data.
export interface BoardEntry { displayName: string; count: number; tier?: number; almanac?: number }
export interface BoardData  { weekly: BoardEntry[]; allTime: BoardEntry[]; weeklyResetAt: number }

const LB_MOCK_DATA: BoardEntry[] = [
  { displayName: 'GreenThumb99',  count: 42 },
  { displayName: 'FloraFairy',    count: 38 },
  { displayName: 'PlantDaddy',    count: 35 },
  { displayName: 'WaterWitch',    count: 31 },
  { displayName: 'BotanicBob',    count: 28 },
  { displayName: 'SeedQueen',     count: 24 },
  { displayName: 'LeafLover',     count: 19 },
  { displayName: 'BudWhisperer',  count: 15 },
  { displayName: 'SproutKing',    count: 11 },
  { displayName: 'DaisyChain',    count:  7 },
]

// =============================================================
//                  end of config
// =============================================================

interface Row { rank: Entity; name: Entity; score: Entity; flair: Entity }
const boardRows: Row[][] = []             // per board, rows in rank order
const youRows: (Row | null)[] = []        // per board, the pinned "YOU" row (null if none)
const titleLabels: Entity[] = []          // one per board, same order as LB_BOARDS
let   weeklyResetAt = 0                   // epoch ms; 0 = unknown (mock)
let   countdownAccum = 0

export interface YourStanding { weeklyRank: number; weeklyCount: number; allTimeRank: number; allTimeCount: number }
let standing: YourStanding | null = null

/** Server told us where this gardener stands (see yourStanding in shared/messages). */
export function setYourStanding(s: YourStanding): void {
  standing = s
  refreshYouRows()
}

function setRowFlair(icon: Entity, tier: number): void {
  const f = flairIcon(tier)
  const k = f ? LB_FLAIR_SIZE : 0
  Transform.getMutable(icon).scale = { x: k, y: k, z: k }
  if (!f) return
  Material.setPbrMaterial(icon, {
    texture: Material.Texture.Common({ src: f.src }), alphaTexture: Material.Texture.Common({ src: f.src }),
    albedoColor: Color4.create(f.tint.r, f.tint.g, f.tint.b, 1), emissiveColor: f.tint, emissiveIntensity: 0.9,
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND, castShadows: false,
  })
}

function formatCountdown(ms: number): string {
  const d = Math.floor(ms / 86_400_000), h = Math.floor((ms % 86_400_000) / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000)
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${Math.max(1, m)}m`
}

function titleFor(kind: 'weekly' | 'allTime'): string {
  if (kind === 'allTime') return LB_TITLE_ALL_TIME
  if (!weeklyResetAt) return LB_TITLE_WEEKLY
  const left = weeklyResetAt - Date.now()
  return left > 0 ? `${LB_TITLE_WEEKLY}  -  resets in ${formatCountdown(left)}` : `${LB_TITLE_WEEKLY}  -  resetting`
}

function refreshTitles(): void {
  for (let b = 0; b < LB_BOARDS.length; b++) {
    const t = titleLabels[b]
    if (t) TextShape.getMutable(t).text = titleFor(LB_BOARDS[b].kind)
  }
}

function countdownSystem(dt: number): void {
  countdownAccum += dt * 1_000
  if (countdownAccum < LB_COUNTDOWN_TICK_MS) return
  countdownAccum = 0
  refreshTitles()
}

/** Build one flair/rank/name/score row at a local y in a column. */
function makeRow(board: Entity, col: BoardColumn, y: number, font: number, nameColor: typeof LB_COLOR_NAME): Row {
  const flair = engine.addEntity()
  Transform.create(flair, { position: { x: col.flairX, y, z: LB_DEPTH }, scale: { x: 0, y: 0, z: 0 }, parent: board })
  MeshRenderer.setPlane(flair)
  const rank = engine.addEntity()
  Transform.create(rank, { position: { x: col.rankX, y, z: LB_DEPTH }, parent: board })
  TextShape.create(rank, { text: '', fontSize: font, textColor: LB_COLOR_RANK, textAlign: TextAlignMode.TAM_MIDDLE_RIGHT })
  const name = engine.addEntity()
  Transform.create(name, { position: { x: col.nameX, y, z: LB_DEPTH }, parent: board })
  TextShape.create(name, { text: '', fontSize: font, textColor: nameColor, textAlign: TextAlignMode.TAM_MIDDLE_LEFT })
  const score = engine.addEntity()
  Transform.create(score, { position: { x: col.scoreX, y, z: LB_DEPTH }, parent: board })
  TextShape.create(score, { text: '', fontSize: font, textColor: LB_COLOR_SCORE, textAlign: TextAlignMode.TAM_MIDDLE_RIGHT })
  return { rank, name, score, flair }
}

export function setupLeaderboardBoards(): void {
  for (const def of LB_BOARDS) {
    const board = engine.addEntity()
    Transform.create(board, { position: def.position, rotation: Quaternion.fromEulerDegrees(0, def.rotationY, 0) })

    // Title — its own world placement (the podium's is on the screen above the stand)
    const title = engine.addEntity()
    Transform.create(title, { position: { x: def.title.x, y: def.title.y, z: def.title.z }, rotation: Quaternion.fromEulerDegrees(0, def.title.rotationY, 0) })
    TextShape.create(title, { text: titleFor(def.kind), fontSize: def.title.font, textColor: LB_COLOR_HEADER, textAlign: TextAlignMode.TAM_MIDDLE_CENTER })
    titleLabels.push(title)

    if (def.header) {
      for (const col of def.columns) {
        const hName = engine.addEntity()
        Transform.create(hName, { position: { x: col.nameX, y: def.header.y, z: LB_DEPTH }, parent: board })
        TextShape.create(hName, { text: LB_HEADER_NAME, fontSize: def.header.font, textColor: LB_COLOR_HEADER, textAlign: TextAlignMode.TAM_MIDDLE_LEFT })
        const hScore = engine.addEntity()
        Transform.create(hScore, { position: { x: col.scoreX, y: def.header.y, z: LB_DEPTH }, parent: board })
        TextShape.create(hScore, { text: LB_HEADER_SCORE, fontSize: def.header.font, textColor: LB_COLOR_HEADER, textAlign: TextAlignMode.TAM_MIDDLE_RIGHT })
      }
    }

    const rows: Row[] = []
    for (const col of def.columns) {
      for (let i = 0; i < def.rows; i++) {
        rows.push(makeRow(board, col, def.startY - i * def.rowStep, def.fontEntry, LB_COLOR_NAME))
      }
    }
    boardRows.push(rows)
    youRows.push(def.you ? makeRow(board, def.columns[0], def.you.y, def.you.font, LB_COLOR_YOU) : null)
  }

  // Mock data so the boards look populated before the first leaderboardUpdate lands
  updateLeaderboardDisplay({ weekly: LB_MOCK_DATA, allTime: LB_MOCK_DATA, weeklyResetAt: 0 })
  refreshYouRows()
  engine.addSystem(countdownSystem)
}

/** The pinned YOU row — shown on whichever boards declare one. Reads "not ranked yet"
 *  until this gardener has watered something, so the row never disappears on them. */
function refreshYouRows(): void {
  for (let b = 0; b < LB_BOARDS.length; b++) {
    const row = youRows[b]
    if (!row) continue
    const weekly = LB_BOARDS[b].kind === 'weekly'
    const rank  = standing ? (weekly ? standing.weeklyRank  : standing.allTimeRank)  : 0
    const count = standing ? (weekly ? standing.weeklyCount : standing.allTimeCount) : 0
    TextShape.getMutable(row.rank).text  = rank > 0 ? `${rank}.` : ''
    TextShape.getMutable(row.name).text  = rank > 0 ? 'YOU' : 'YOU  -  water a plant to join the board'
    TextShape.getMutable(row.score).text = rank > 0 ? `${count}` : ''
  }
}

export function updateLeaderboardDisplay(data: BoardData): void {
  weeklyResetAt = data.weeklyResetAt
  for (let b = 0; b < LB_BOARDS.length; b++) {
    const entries = LB_BOARDS[b].kind === 'weekly' ? data.weekly : data.allTime
    const rows = boardRows[b] ?? []
    for (let i = 0; i < rows.length; i++) {
      const entry = entries[i]
      const row = rows[i]
      // The Almanac title rides beside the name (GDD §4.2). INLINE, never a second line:
      // rows are one step apart and middle-aligned, so a wrapped name grows into its
      // neighbours. First word only, so "Keeper of the Garden" cannot reach the score.
      const title = almanacTitleByRank(entry?.almanac ?? 0).split(' ')[0]
      TextShape.getMutable(row.rank).text  = entry ? `${i + 1}.` : ''
      TextShape.getMutable(row.name).text  = entry ? `${entry.displayName}${title ? `  ·  ${title}` : ''}` : ''
      TextShape.getMutable(row.score).text = entry ? `${entry.count}` : ''
      setRowFlair(row.flair, entry?.tier ?? 0)
    }
  }
  refreshTitles()
  refreshYouRows()
}
