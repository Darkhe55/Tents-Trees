import { cellIndex, cellValue, neighbors4, treePositions } from './state'
import type { GameState, Puzzle, ValidationResult } from './types'
import { CellState as CS } from './types'

/** 某格相邻的帐篷数 */
function tentsAround(state: GameState, cx: number, cy: number): number {
  let n = 0
  for (const nb of neighbors4(state.width, state.height, cx, cy)) {
    if (cellValue(state, cellIndex(state.width, nb.cx, nb.cy)) === CS.Tent) n++
  }
  return n
}

/** 某格相邻的树数 */
function treesAround(puzzle: Puzzle, cx: number, cy: number): number {
  let n = 0
  for (const nb of neighbors4(puzzle.width, puzzle.height, cx, cy)) {
    if (puzzle.trees[cellIndex(puzzle.width, nb.cx, nb.cy)]) n++
  }
  return n
}

export function validate(state: GameState, puzzle: Puzzle): ValidationResult {
  const w = puzzle.width
  const h = puzzle.height

  const badTrees: number[] = []
  const badTents: number[] = []
  const adjacentTents: number[] = []
  const tentCountByRow = new Array<number>(h).fill(0)
  const tentCountByCol = new Array<number>(w).fill(0)
  let filled = 0

  const tents: Array<{ cx: number; cy: number; index: number }> = []

  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const index = cellIndex(w, cx, cy)
      if (puzzle.trees[index]) continue // 树格子无状态
      const v = cellValue(state, index)
      if (v === CS.Unknown) continue
      filled++
      if (v !== CS.Tent) continue
      tents.push({ cx, cy, index })
      tentCountByRow[cy]!++
      tentCountByCol[cx]!++
    }
  }

  // 规则 2：每个帐篷恰好只挨一棵树
  for (const t of tents) {
    if (treesAround(puzzle, t.cx, t.cy) !== 1) badTents.push(t.index)
  }

  // 规则 3：帐篷互不相邻
  const tentSet = new Set(tents.map((t) => t.index))
  for (const t of tents) {
    for (const nb of neighbors4(w, h, t.cx, t.cy)) {
      if (tentSet.has(cellIndex(w, nb.cx, nb.cy))) {
        adjacentTents.push(t.index)
        break
      }
    }
  }

  // 规则 1：每棵树恰好一个相邻帐篷
  for (const t of treePositions(puzzle)) {
    if (tentsAround(state, t.cx, t.cy) !== 1) badTrees.push(t.index)
  }

  // 规则 4：行/列数字
  const badRows: number[] = []
  for (let cy = 0; cy < h; cy++) {
    const clue = puzzle.rowClues[cy]
    if (clue === null || clue === undefined) continue
    if (tentCountByRow[cy] !== clue) badRows.push(cy)
  }
  const badCols: number[] = []
  for (let cx = 0; cx < w; cx++) {
    const clue = puzzle.colClues[cx]
    if (clue === null || clue === undefined) continue
    if (tentCountByCol[cx] !== clue) badCols.push(cx)
  }

  const unknown = w * h - puzzle.trees.filter(Boolean).length - filled
  const solved =
    unknown === 0 &&
    badTrees.length === 0 &&
    badTents.length === 0 &&
    adjacentTents.length === 0 &&
    badRows.length === 0 &&
    badCols.length === 0

  return {
    badTrees,
    badTents,
    adjacentTents,
    badRows,
    badCols,
    filled,
    unknown,
    solved,
  }
}
