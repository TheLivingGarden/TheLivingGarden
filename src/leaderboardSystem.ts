// =============================================================
// The Living Garden — Leaderboard System
//
// Two boards (south + north wall) display the top-10 all-time
// waterers.  All layout, style, and position config lives in the
// block below — no Creator Hub entities required.
// =============================================================

import {
  engine,
  Entity,
  Transform,
  TextShape,
  TextAlignMode,
} from '@dcl/sdk/ecs'
import { Quaternion } from '@dcl/sdk/math'

// ===============================================================
// ██████╗  ██████╗  █████╗ ██████╗ ██████╗     ██████╗ ██████╗ ███╗   ██╗███████╗██╗ ██████╗
// ██╔══██╗██╔═══██╗██╔══██╗██╔══██╗██╔══██╗   ██╔════╝██╔═══██╗████╗  ██║██╔════╝██║██╔════╝
// ██████╔╝██║   ██║███████║██████╔╝██║  ██║   ██║     ██║   ██║██╔██╗ ██║█████╗  ██║██║  ███╗
// ██╔══██╗██║   ██║██╔══██║██╔══██╗██║  ██║   ██║     ██║   ██║██║╚██╗██║██╔══╝  ██║██║   ██║
// ██████╔╝╚██████╔╝██║  ██║██║  ██║██████╔╝   ╚██████╗╚██████╔╝██║ ╚████║██║     ██║╚██████╔╝
// ╚═════╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝     ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝     ╚═╝ ╚═════╝
//
//  Edit anything in this block — no other files need touching.
// ===============================================================

// ── Board world positions ─────────────────────────────────────
// rotation: euler degrees  { x:0, y:0, z:0 } = faces +Z
//                          { x:0, y:180, z:0 } = faces -Z
const LB_WORLD_Y = 2.41    // raise / lower all boards together

const LB_BOARDS = [
  // Board 1 — south face (faces into the scene)
  { position: { x: 12.73, y: LB_WORLD_Y, z:  0.6 }, rotation: { x: 0, y: 180, z: 0 } },
  // Board 2 — north face
  { position: { x: 12.73, y: LB_WORLD_Y, z: 47.15 }, rotation: { x: 0, y: 0,   z: 0 } },
]

// ── Rows ─────────────────────────────────────────────────────
const LB_ENTRIES    = 10     // number of player rows per board
const LB_START_Y    = 0.30   // local Y of the first entry row
const LB_STEP_Y     = 0.175   // vertical gap between rows (decrease = tighter)
const LB_HEADER_GAP = 0.28   // extra gap above row 0 for the header

// ── Columns ──────────────────────────────────────────────────
const LB_NAME_X  = -1.25    // local X of the name column  (negative = left)
const LB_SCORE_X =  1    // local X of the score column (positive = right)
const LB_DEPTH   =  0.08    // local Z lift off the board face — increase if text clips into mesh

// ── Typography ───────────────────────────────────────────────
const LB_FONT_HEADER = 1.2   // header row font size
const LB_FONT_ENTRY  = 1.2   // entry row font size

// ── Column header labels ──────────────────────────────────────
const LB_HEADER_NAME  = 'NAME'
const LB_HEADER_SCORE = 'WATERS'

// ── Colours  (r/g/b/a each 0–1) ──────────────────────────────
const LB_COLOR_HEADER = { r: 1,   g: 0.84, b: 0.1, a: 1 }  // gold
const LB_COLOR_NAME   = { r: 1,   g: 1,    b: 1,   a: 1 }  // white
const LB_COLOR_SCORE  = { r: 0.6, g: 1,    b: 0.6, a: 1 }  // soft green

// ── Mock data ─────────────────────────────────────────────────
// Shown immediately on load until the server sends real data.
// Replace or reorder freely — only LB_ENTRIES rows are displayed.
const LB_MOCK_DATA: Array<{ displayName: string; count: number }> = [
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

// Each entry = two label entities [nameLabel, scoreLabel],
// interleaved per board: [name0, score0, name1, score1, …] × boards
const leaderboardLabels: Entity[] = []

/** Returns the name and score label entities for a given board and row. */
function getLabels(boardIdx: number, entryIdx: number): { name: Entity; score: Entity } {
  const base = boardIdx * (LB_ENTRIES * 2) + entryIdx * 2
  return { name: leaderboardLabels[base], score: leaderboardLabels[base + 1] }
}

export function setupLeaderboardBoards(): void {
  for (const boardDef of LB_BOARDS) {
    const quat = Quaternion.fromEulerDegrees(
      boardDef.rotation.x,
      boardDef.rotation.y,
      boardDef.rotation.z,
    )

    const board = engine.addEntity()
    Transform.create(board, { position: boardDef.position, rotation: quat })

    const headerY = LB_START_Y + LB_HEADER_GAP

    // Header row
    const hName = engine.addEntity()
    Transform.create(hName, { position: { x: LB_NAME_X,  y: headerY, z: LB_DEPTH }, parent: board })
    TextShape.create(hName,  { text: LB_HEADER_NAME,  fontSize: LB_FONT_HEADER, textColor: LB_COLOR_HEADER, textAlign: TextAlignMode.TAM_MIDDLE_LEFT })

    const hScore = engine.addEntity()
    Transform.create(hScore, { position: { x: LB_SCORE_X, y: headerY, z: LB_DEPTH }, parent: board })
    TextShape.create(hScore, { text: LB_HEADER_SCORE, fontSize: LB_FONT_HEADER, textColor: LB_COLOR_HEADER })

    // Entry rows
    for (let i = 0; i < LB_ENTRIES; i++) {
      const y = LB_START_Y - i * LB_STEP_Y

      const nameLabel = engine.addEntity()
      Transform.create(nameLabel,  { position: { x: LB_NAME_X,  y, z: LB_DEPTH }, parent: board })
      TextShape.create(nameLabel,  { text: '', fontSize: LB_FONT_ENTRY, textColor: LB_COLOR_NAME, textAlign: TextAlignMode.TAM_MIDDLE_LEFT })

      const scoreLabel = engine.addEntity()
      Transform.create(scoreLabel, { position: { x: LB_SCORE_X, y, z: LB_DEPTH }, parent: board })
      TextShape.create(scoreLabel, { text: '', fontSize: LB_FONT_ENTRY, textColor: LB_COLOR_SCORE })

      leaderboardLabels.push(nameLabel, scoreLabel)
    }
  }

  // Show mock data immediately so the board looks populated before
  // the server sends its first leaderboardUpdate message
  updateLeaderboardDisplay(LB_MOCK_DATA)
}

export function updateLeaderboardDisplay(entries: Array<{ displayName: string; count: number }>): void {
  for (let b = 0; b < LB_BOARDS.length; b++) {
    for (let i = 0; i < LB_ENTRIES; i++) {
      const entry          = entries[i]
      const { name, score } = getLabels(b, i)
      if (!name || !score) continue
      TextShape.getMutable(name).text  = entry ? `${i + 1}.  ${entry.displayName}` : ''
      TextShape.getMutable(score).text = entry ? `${entry.count}` : ''
    }
  }
}
