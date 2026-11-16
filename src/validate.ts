import { cellIndex, cellValue, neighbors4, neighbors8, treePositions } from './state'
import { adjacentTrees, maximumMatching, tentCellsOf } from './matching'
import type { GameState, Puzzle, ValidationResult } from './types'
import { CellState as CS } from './types'

/**
 * 校验分两层，都用「树–帐篷二分图存在完整配对」的语义：
 *
 *  - 部分盘面：只报「已经不可能补救」的问题——
 *      · 帐篷配不上不同的树（帐篷侧最大匹配盖不住所有已放帐篷）；
 *      · 某棵树已经没有任何可放帐篷的相邻格（树侧最大匹配盖不住这棵树）；
 *      · 帐篷互相邻（含斜角）。
 *    树/帐篷旁边有多个对方**不再**算冲突：只要未来能一一配对就合法。
 *  - 完整盘面：树和帐篷必须能被一一配对（两侧都饱和），
 *    再加上行列数字、帐篷互不邻，才算解出。
 */
export function validate(state: GameState, puzzle: Puzzle): ValidationResult {
  const w = puzzle.width
  const h = puzzle.height

  const tentCountByRow = new Array<number>(h).fill(0)
  const tentCountByCol = new Array<number>(w).fill(0)
  let filled = 0

  const tentCells = tentCellsOf(state, puzzle)
  const tentIndexSet = new Set(tentCells)
  for (const index of tentCells) {
    const cy = Math.floor(index / w)
    const cx = index % w
    tentCountByRow[cy]!++
    tentCountByCol[cx]!++
  }
  for (let i = 0; i < state.cells.length; i++) {
    if (puzzle.trees[i]) continue
    if (cellValue(state, i) !== CS.Unknown) filled++
  }

  // 规则 1：帐篷互不相邻（正交或斜角都不行）
  const adjacentTents: number[] = []
  for (const index of tentCells) {
    const cx = index % w
    const cy = Math.floor(index / w)
    for (const nb of neighbors8(w, h, cx, cy)) {
      if (tentIndexSet.has(cellIndex(w, nb.cx, nb.cy))) {
        adjacentTents.push(index)
        break
      }
    }
  }

  // 规则 2：帐篷侧配对——每顶已放帐篷都得能配到一棵不同的树
  const tentAdj = tentCells.map((index) => adjacentTrees(puzzle, index))
  const tentMatch = maximumMatching(tentAdj, w * h)
  const badTents: number[] = []
  for (let k = 0; k < tentCells.length; k++) {
    if (tentMatch.leftMatch[k]! === -1) badTents.push(tentCells[k]!)
  }

  // 规则 3：树侧配对——每棵树都得还有机会分到一顶不同的帐篷
  //   候选 = 相邻的已放帐篷 + 相邻的未定空地（未来可能变成帐篷）
  const treeCells = treePositions(puzzle).map((t) => t.index)
  const treeAdj = treeCells.map((index) => {
    const out: number[] = []
    const cx = index % w
    const cy = Math.floor(index / w)
    for (const nb of neighbors4(w, h, cx, cy)) {
      const j = cellIndex(w, nb.cx, nb.cy)
      if (puzzle.trees[j]) continue
      const v = cellValue(state, j)
      if (v === CS.Tent || v === CS.Unknown) out.push(j)
    }
    return out
  })
  const treeMatch = maximumMatching(treeAdj, w * h)
  const badTrees: number[] = []
  for (let k = 0; k < treeCells.length; k++) {
    if (treeMatch.leftMatch[k]! === -1) badTrees.push(treeCells[k]!)
  }

  // 规则 4：行/列数字（完整盘面时必须全部吻合）
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

  const unknown = w * h - treeCells.length - filled
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
